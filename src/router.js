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
        this.activeInputs = new Map(); // key: deviceName -> JZZ port instance
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

    get activeInput() {
        if (this.activeInputs.size === 0) return null;
        return this.activeInputs.values().next().value;
    }

    get activeInputName() {
        if (this.activeInputs.size === 0) return null;
        if (this.activeInputs.size === 1) return this.activeInputs.keys().next().value;
        return Array.from(this.activeInputs.keys()).join(', ');
    }

    getActiveInputNames() {
        return Array.from(this.activeInputs.keys());
    }

    isInputActive(name) {
        if (!name) return false;
        return this.activeInputs.has(name);
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

    async openInput(target, options = { replace: true }) {
        if (!this.midi) await this.init();

        if (target === undefined || target === null || target === '' || target === 'none' || target === 'off' || target === false) {
            return this.closeInput();
        }

        let resolvedTarget = target;
        const inputs = this.listInputs();
        if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(String(target).trim()))) {
            const idx = parseInt(target, 10);
            if (idx >= 0 && idx < inputs.length) {
                resolvedTarget = inputs[idx].name;
            } else {
                throw new Error(`Índice MIDI IN fuera de rango: ${idx} (disponibles: 0 a ${Math.max(0, inputs.length - 1)})`);
            }
        }

        // Si ya está abierto exactamente este puerto
        if (this.activeInputs.has(resolvedTarget)) {
            if (options.replace && this.activeInputs.size > 1) {
                for (const [name, p] of this.activeInputs.entries()) {
                    if (name !== resolvedTarget) {
                        try { p.close(); } catch (_) {}
                        this.activeInputs.delete(name);
                    }
                }
            }
            return {
                status: 'connected',
                name: resolvedTarget,
                activeInputs: this.getActiveInputNames()
            };
        }

        // Si se solicita reemplazar (modo legacy de puerto único exclusivo)
        if (options.replace) {
            this.closeInput();
        }

        return new Promise((resolve, reject) => {
            const port = this.midi.openMidiIn(resolvedTarget);
            port.and(() => {
                const portName = port.name();
                this.activeInputs.set(portName, port);

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
                        source: portName,
                        timestamp: Date.now()
                    };

                    for (const cb of this.inputListeners) {
                        try { cb(parsed); } catch (e) {}
                    }
                });

                resolve({
                    status: 'connected',
                    name: portName,
                    activeInputs: this.getActiveInputNames()
                });
            });

            port.or(() => {
                reject(new Error(`No se pudo abrir puerto MIDI IN "${target}" (posiblemente ocupado por otra app)`));
            });
        });
    }

    async enableInput(target) {
        return this.openInput(target, { replace: false });
    }

    disableInput(target) {
        if (!target || target === 'all' || target === 'none') {
            return this.closeInput();
        }
        let resolvedTarget = target;
        const inputs = this.listInputs();
        if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(String(target).trim()))) {
            const idx = parseInt(target, 10);
            if (idx >= 0 && idx < inputs.length) {
                resolvedTarget = inputs[idx].name;
            }
        }
        if (this.activeInputs.has(resolvedTarget)) {
            const port = this.activeInputs.get(resolvedTarget);
            try { port.close(); } catch (_) {}
            this.activeInputs.delete(resolvedTarget);
        }
        return {
            status: this.activeInputs.size > 0 ? 'connected' : 'disconnected',
            name: this.activeInputName,
            activeInputs: this.getActiveInputNames()
        };
    }

    closeInput(target = null) {
        if (target && target !== 'all' && target !== 'none') {
            return this.disableInput(target);
        }
        for (const [name, port] of this.activeInputs.entries()) {
            try { port.close(); } catch (_) {}
        }
        this.activeInputs.clear();
        return { status: 'disconnected', name: null, activeInputs: [] };
    }

    async setActiveInputs(targets) {
        if (!this.midi) await this.init();
        if (!Array.isArray(targets) || targets.length === 0) {
            return this.closeInput();
        }

        const targetSet = new Set();
        const available = this.listInputs();
        for (const t of targets) {
            if (typeof t === 'number' || (typeof t === 'string' && /^\d+$/.test(String(t).trim()))) {
                const idx = parseInt(t, 10);
                if (idx >= 0 && idx < available.length) targetSet.add(available[idx].name);
            } else if (typeof t === 'string' && t !== 'none' && t !== '') {
                targetSet.add(t);
            }
        }

        // Cerrar los que no están en targetSet
        for (const [name, port] of this.activeInputs.entries()) {
            if (!targetSet.has(name)) {
                try { port.close(); } catch (_) {}
                this.activeInputs.delete(name);
            }
        }

        // Habilitar los que faltan
        for (const name of targetSet) {
            if (!this.activeInputs.has(name)) {
                try {
                    await this.enableInput(name);
                } catch (e) {
                    console.warn(`[ROUTER] Error al habilitar entrada "${name}": ${e.message}`);
                }
            }
        }

        return {
            status: this.activeInputs.size > 0 ? 'connected' : 'disconnected',
            name: this.activeInputName,
            activeInputs: this.getActiveInputNames()
        };
    }

    async openOutput(target) {
        if (!this.midi) await this.init();

        if (this.activeOutput) {
            await this.panic();
            try { this.activeOutput.close(); } catch (_) {}
            this.activeOutput = null;
            this.activeOutputName = null;
        }

        if (target === undefined || target === null || target === '' || target === 'none' || target === 'off' || target === false) {
            return { status: 'disconnected', name: null };
        }

        let resolvedTarget = target;
        const outputs = this.listOutputs();
        if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(String(target).trim()))) {
            const idx = parseInt(target, 10);
            if (idx >= 0 && idx < outputs.length) {
                resolvedTarget = outputs[idx].name;
            } else {
                throw new Error(`Índice MIDI OUT fuera de rango: ${idx} (disponibles: 0 a ${Math.max(0, outputs.length - 1)})`);
            }
        }

        return new Promise((resolve, reject) => {
            const port = this.midi.openMidiOut(resolvedTarget);
            port.and(() => {
                this.activeOutput = port;
                this.activeOutputName = port.name();
                resolve({
                    status: 'connected',
                    name: this.activeOutputName
                });
            });

            port.or(() => {
                reject(new Error(`No se pudo abrir puerto MIDI OUT "${resolvedTarget}" (posiblemente ocupado por otra app)`));
            });
        });
    }

    closeOutput() {
        if (this.activeOutput) {
            try { this.panic(); } catch (_) {}
            try { this.activeOutput.close(); } catch (_) {}
            this.activeOutput = null;
            this.activeOutputName = null;
        }
        return { status: 'disconnected', name: null };
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
