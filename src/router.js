/**
 * Core Router & Physical MIDI Output Module
 * Implementa la interfaz agnóstica de hardware para emisión MIDI 1.0 estándar.
 */
const JZZ = require('jzz');

class MidiRouter {
    constructor() {
        this.midi = null;
        this.activeOutput = null;
        this.activeOutputName = null;
        this.activeInput = null;
        this.activeInputName = null;
        this.activeNotes = new Map(); // key: `${channel}_${note}` -> timestamp
        this.inputListeners = [];

        // Matriz de Ruteo Asimétrico y Prevención de Bucles (Inspirado en MIDI Split)
        // Permite configurar rutas con permisos direccionales independientes:
        // 'hardware': { allowIn: true, allowOut: true }
        // 'app_a':    { allowIn: true, allowOut: true } (DAW con envío y retorno permitido)
        // 'app_b':    { allowIn: true, allowOut: false } (App que recibe de HW pero no puede enviar retorno al HW)
        this.routingMatrix = {
            hardware:          { allowIn: true, allowOut: true },
            app_a:             { allowIn: true, allowOut: true },
            app_b:             { allowIn: true, allowOut: false },
            daw_virtual_proxy: { allowIn: true, allowOut: true },
            osc:               { allowIn: true, allowOut: true }
        };
    }

    setRoutePermission(target, direction, allowed) {
        if (!this.routingMatrix[target]) {
            this.routingMatrix[target] = { allowIn: true, allowOut: true };
        }
        if (direction === 'in' || direction === 'out') {
            const key = direction === 'in' ? 'allowIn' : 'allowOut';
            this.routingMatrix[target][key] = !!allowed;
        }
        return this.routingMatrix[target];
    }

    getRoutingMatrix() {
        return { ...this.routingMatrix };
    }

    isRouteAllowed(source, destination) {
        // 1. Si source es una aplicación (ej. app_a, app_b):
        // allowOut de la app determina si tiene permiso de enviar datos hacia el destino
        if (this.routingMatrix[source]) {
            if (this.routingMatrix[source].allowOut === false) {
                return false;
            }
        }

        // 2. Si destination es un receptor (ej. hardware u osc):
        // allowOut del hardware/osc determina si la salida física o red está habilitada
        if (this.routingMatrix[destination]) {
            if (this.routingMatrix[destination].allowOut === false) {
                return false;
            }
        }

        return true;
    }

    async init() {
        if (!this.midi) {
            this.midi = await JZZ();
        }
        return this.midi.info();
    }

    async refresh() {
        if (!this.midi) {
            await this.init();
            return this.midi.info();
        }
        if (typeof this.midi.refresh === 'function') {
            await this.midi.refresh();
        }
        return this.midi.info();
    }

    listOutputs() {
        if (!this.midi) throw new Error('MidiRouter no inicializado. Llama a init() primero.');
        const info = this.midi.info();
        return (info.outputs || []).map((out, idx) => ({
            index: idx,
            name: out.name,
            manufacturer: out.manufacturer || 'Desconocido'
        }));
    }

    listInputs() {
        if (!this.midi) throw new Error('MidiRouter no inicializado. Llama a init() primero.');
        const info = this.midi.info();
        return (info.inputs || []).map((inp, idx) => ({
            index: idx,
            name: inp.name,
            manufacturer: inp.manufacturer || 'Desconocido'
        }));
    }

    onMidiInput(callback) {
        if (typeof callback === 'function') {
            this.inputListeners.push(callback);
        }
    }

    async openInput(target) {
        if (!this.midi) await this.init();

        if (this.activeInput) {
            try { this.activeInput.close(); } catch (_) {}
            this.activeInput = null;
            this.activeInputName = null;
        }

        if (!target || target === 'none') {
            return { status: 'disconnected', name: null };
        }

        return new Promise((resolve, reject) => {
            const port = this.midi.openMidiIn(target);
            port.and(() => {
                this.activeInput = port;
                this.activeInputName = port.name();

                port.connect((msg) => {
                    const statusByte = msg[0];
                    const channel = (statusByte & 0x0F) + 1;
                    const command = statusByte >> 4;
                    const data1 = msg[1];
                    const data2 = msg[2] !== undefined ? msg[2] : 0;

                    let eventName = 'raw';
                    let description = `Raw 0x${statusByte.toString(16).toUpperCase()}`;

                    if (command === 0x9) {
                        eventName = data2 > 0 ? 'noteon' : 'noteoff';
                        description = `${eventName.toUpperCase()} ${data1}`;
                    } else if (command === 0x8) {
                        eventName = 'noteoff';
                        description = `NOTEOFF ${data1}`;
                    } else if (command === 0xB) {
                        eventName = 'cc';
                        description = `Control Change ${data1}`;
                    } else if (command === 0xC) {
                        eventName = 'program_change';
                        description = `Program change ${data1}`;
                    } else if (command === 0xE) {
                        eventName = 'pitchbend';
                        description = `Pitchbend ${data1 | (data2 << 7)}`;
                    }

                    const hexBytes = Array.from(msg)
                        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
                        .join(' ');

                    const parsed = {
                        type: 'midi_hardware_in',
                        source_route: 'hardware',
                        dir: 'in',
                        event: eventName,
                        description: description,
                        channel: channel,
                        note: data1,
                        velocity: data2,
                        hex: hexBytes,
                        rawBytes: Array.from(msg),
                        source: this.activeInputName,
                        timestamp: Date.now()
                    };

                    for (const cb of this.inputListeners) {
                        try { cb(parsed); } catch (e) {}
                    }
                });

                resolve({
                    status: 'connected',
                    name: this.activeInputName
                });
            });

            port.or(() => {
                reject(new Error(`No se pudo abrir puerto MIDI IN "${target}" (posiblemente ocupado por otra app)`));
            });
        });
    }

    async openOutput(target) {
        if (!this.midi) await this.init();

        if (this.activeOutput) {
            await this.panic();
            try { this.activeOutput.close(); } catch (_) {}
            this.activeOutput = null;
            this.activeOutputName = null;
        }

        if (!target || target === 'none') {
            return { status: 'disconnected', name: null };
        }

        return new Promise((resolve, reject) => {
            const port = this.midi.openMidiOut(target);
            port.and(() => {
                this.activeOutput = port;
                this.activeOutputName = port.name();
                resolve({
                    status: 'connected',
                    name: this.activeOutputName
                });
            });

            port.or(() => {
                reject(new Error(`No se pudo abrir puerto MIDI OUT "${target}" (posiblemente ocupado por otra app)`));
            });
        });
    }

    sendNoteOn(channel, note, velocity = 127) {
        if (!this.activeOutput) throw new Error('No hay puerto MIDI OUT abierto.');
        
        const ch = Math.max(0, Math.min(15, parseInt(channel, 10)));
        const n = Math.max(0, Math.min(127, parseInt(note, 10)));
        const vel = Math.max(0, Math.min(127, parseInt(velocity, 10)));

        const noteKey = `${ch}_${n}`;
        this.activeNotes.set(noteKey, Date.now());

        // JZZ noteOn: channel (0-15), note (0-127), velocity (0-127)
        this.activeOutput.noteOn(ch, n, vel);

        return {
            event: 'noteon',
            channel: ch + 1, // Exponer a usuario 1-16
            note: n,
            velocity: vel,
            timestamp: Date.now()
        };
    }

    sendNoteOff(channel, note) {
        if (!this.activeOutput) throw new Error('No hay puerto MIDI OUT abierto.');

        const ch = Math.max(0, Math.min(15, parseInt(channel, 10)));
        const n = Math.max(0, Math.min(127, parseInt(note, 10)));

        const noteKey = `${ch}_${n}`;
        this.activeNotes.delete(noteKey);

        // JZZ noteOff: channel (0-15), note (0-127)
        this.activeOutput.noteOff(ch, n);

        return {
            event: 'noteoff',
            channel: ch + 1, // Exponer a usuario 1-16
            note: n,
            velocity: 0,
            timestamp: Date.now()
        };
    }

    sendCC(channel, control, value) {
        if (!this.activeOutput) throw new Error('No hay puerto MIDI OUT abierto.');

        const ch = Math.max(0, Math.min(15, parseInt(channel, 10)));
        const ctrl = Math.max(0, Math.min(127, parseInt(control, 10)));
        const val = Math.max(0, Math.min(127, parseInt(value, 10)));

        this.activeOutput.control(ch, ctrl, val);

        return {
            event: 'cc',
            channel: ch + 1,
            note: ctrl,
            velocity: val,
            timestamp: Date.now()
        };
    }

    sendProgramChange(channel, program) {
        if (!this.activeOutput) throw new Error('No hay puerto MIDI OUT abierto.');

        const ch = Math.max(0, Math.min(15, parseInt(channel, 10)));
        const prg = Math.max(0, Math.min(127, parseInt(program, 10)));

        this.activeOutput.program(ch, prg);

        return {
            event: 'program_change',
            channel: ch + 1,
            note: prg,
            velocity: 0,
            timestamp: Date.now()
        };
    }

    sendPitchBend(channel, value) {
        if (!this.activeOutput) throw new Error('No hay puerto MIDI OUT abierto.');

        const ch = Math.max(0, Math.min(15, parseInt(channel, 10)));
        const pb = Math.max(0, Math.min(16383, parseInt(value, 10)));

        this.activeOutput.pitchBend(ch, pb);

        return {
            event: 'pitchbend',
            channel: ch + 1,
            note: pb,
            velocity: 0,
            timestamp: Date.now()
        };
    }

    sendRaw(msgBytes) {
        if (!this.activeOutput) throw new Error('No hay puerto MIDI OUT abierto.');
        this.activeOutput.send(msgBytes);
        return {
            event: 'raw',
            bytes: msgBytes,
            timestamp: Date.now()
        };
    }

    async panic() {
        if (!this.activeOutput) return;

        // 1. Apagar todas las notas registradas en memoria con salvaguarda Note-Off
        for (const [key] of this.activeNotes) {
            const [ch, n] = key.split('_').map(Number);
            try {
                this.activeOutput.noteOff(ch, n);
            } catch (_) {}
        }
        this.activeNotes.clear();

        // 2. Enviar comandos MIDI CC 123 (All Notes Off) y CC 120 (All Sound Off) en los 16 canales
        for (let ch = 0; ch < 16; ch++) {
            try {
                this.activeOutput.allNotesOff(ch);
                this.activeOutput.allSoundOff(ch);
                this.activeOutput.resetAllControllers(ch);
            } catch (_) {}
        }
    }

    close() {
        if (this.activeOutput) {
            this.panic();
            this.activeOutput.close();
            this.activeOutput = null;
            this.activeOutputName = null;
        }
    }
}

module.exports = MidiRouter;
