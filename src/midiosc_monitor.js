/**
 * Terminal Live Monitor (Zero-Overhead Console Dashboard)
 * Renderiza tabla de eventos en tiempo real con estadísticas y botón/atajo de pánico.
 */

class TerminalMonitor {
    constructor(maxHistory = 15) {
        this.maxHistory = maxHistory;
        this.history = [];
        this.oscHistory = [];
        this.totalCount = 0;
        this.oscTotalCount = 0;
        this.noteOnCount = 0;
        this.noteOffCount = 0;
        this.activeChannels = new Set();
        this.sessionRegistry = null;
        this.isPaused = false;
        this.isBypass = false; // Modo Bypass (Zero-Overhead Live Sentinel)
    }

    setSessionRegistry(registry) {
        this.sessionRegistry = registry;
    }

    setBypass(enable) {
        this.isBypass = !!enable;
        return this.isBypass;
    }

    logEvent(event) {
        if (this.isBypass) return; // Zero-Overhead: En bypass no procesa ni acumula nada

        // Registro de telemetría de red OSC
        if (event.protocol === 'osc') {
            this.oscTotalCount++;
            if (this.isPaused) return;

            const timeStr = new Date(event.timestamp || Date.now()).toISOString().split('T')[1].replace('Z', '');
            const dir = (event.dir || 'out').toUpperCase();
            const addr = event.path || event.address || '/osc';
            const types = event.types || '-';
            let argsStr = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || []);
            const target = event.target || '127.0.0.1:57120';

            const row = {
                id: this.oscTotalCount,
                time: timeStr,
                dir,
                addr,
                types,
                args: argsStr,
                target
            };

            this.oscHistory.push(row);
            if (this.oscHistory.length > this.maxHistory) {
                this.oscHistory.shift();
            }
            return;
        }

        if (event.protocol === 'system') return;

        this.totalCount++;
        if (event.event === 'noteon') {
            this.noteOnCount++;
            this.activeChannels.add(event.channel);
        } else if (event.event === 'noteoff') {
            this.noteOffCount++;
        }

        if (this.isPaused) return;

        const row = {
            id: this.totalCount,
            time: new Date(event.timestamp || Date.now()).toISOString().split('T')[1].replace('Z', ''),
            type: event.event.toUpperCase(),
            client: event.clientId || 'default',
            ch: event.channel,
            note: event.note,
            vel: event.velocity,
            latencyUs: event.durationUs ? event.durationUs.toFixed(1) + ' µs' : 'N/A',
            target: event.midiStatus && event.midiStatus.name ? event.midiStatus.name : 'Physical OUT'
        };

        this.history.push(row);
        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }
    }

    renderTable() {
        if (this.isBypass) {
            console.clear();
            console.log('========================================================================================');
            console.log('                                    midiOSCControl                                      ');
            console.log('========================================================================================');
            console.log(' Estado: [BYPASS / ZERO-OVERHEAD ACTIVO] (Telemetría y renderizado suspendidos)');
            console.log(' Tráfico MIDI/OSC en tiempo real activo al 100% con latencia mínima sin interrupción.');
            console.log('========================================================================================\n');
            return;
        }

        console.clear();
        console.log('========================================================================================');
        console.log('                                    midiOSCControl                                      ');
        console.log('========================================================================================');

        if (this.sessionRegistry) {
            const sessions = this.sessionRegistry.listSessions();
            if (sessions.length > 0) {
                console.log(' PROYECTOS / CLIENTES CONECTADOS:');
                sessions.forEach((s, idx) => {
                    const idxStr = `[${idx + 1}]`;
                    const labelStr = (s.label || s.clientId).padEnd(20);
                    const chStr = `MIDI Ch: ${String(s.midiChannel).padStart(2)}`;
                    const oscStr = `OSC: ${s.oscHost}:${s.oscPort}${s.oscPrefix || ''}`;
                    const notesStr = `Notas activas: ${s.activeNotesCount}`;
                    console.log(`   ${idxStr} ${labelStr} | ${chStr} | ${oscStr.padEnd(28)} | ${notesStr}`);
                });
                console.log('----------------------------------------------------------------------------------------');
            }
        }

        console.log(` Estado: [ACTIVO]  |  Total Eventos: ${this.totalCount}  |  Note-On: ${this.noteOnCount}  |  Note-Off: ${this.noteOffCount}  |  Canales: [${Array.from(this.activeChannels).sort((a,b)=>a-b).join(', ')}]`);
        console.log('----------------------------------------------------------------------------------------');
        console.log(' #ID  | HORA UTC    | ORIGEN/CLIENTE     | CH | NOTA | VEL | LATENCIA   | DESTINO');
        console.log('----------------------------------------------------------------------------------------');

        for (const r of this.history) {
            const idStr = String(r.id).padEnd(4);
            const timeStr = r.time.padEnd(11);
            const origStr = String(r.client || 'default').padEnd(18).slice(0, 18);
            const typeStr = r.type.padEnd(7);
            const chStr = String(r.ch).padStart(2);
            const noteStr = String(r.note).padStart(4);
            const velStr = String(r.vel).padStart(3);
            const latStr = r.latencyUs.padStart(10);
            const targetStr = r.target;

            console.log(` ${idStr} | ${timeStr} | ${origStr} | ${chStr} | ${noteStr} | ${velStr} | ${latStr} | ${targetStr}`);
        }

        console.log('========================================================================================');
        console.log(' Atajos: [Alt+T / T] Ver MIDI  |  [Alt+O / O] Ver OSC  |  [D] Dispositivos  |  [Alt+P] Pánico');
        console.log('========================================================================================\n');
    }

    renderOscTable() {
        if (this.isBypass) {
            console.clear();
            console.log('========================================================================================');
            console.log('                                    midiOSCControl                                      ');
            console.log('========================================================================================');
            console.log(' Estado: [BYPASS / ZERO-OVERHEAD ACTIVO] (Telemetría y renderizado suspendidos)');
            console.log(' Tráfico MIDI/OSC en tiempo real activo al 100% con latencia mínima sin interrupción.');
            console.log('========================================================================================\n');
            return;
        }

        console.clear();
        console.log('========================================================================================');
        console.log('                                    midiOSCControl                                      ');
        console.log('========================================================================================');

        if (this.sessionRegistry) {
            const sessions = this.sessionRegistry.listSessions();
            if (sessions.length > 0) {
                console.log(' DESTINOS OSC / CLIENTES ACTIVOS:');
                sessions.forEach((s, idx) => {
                    const idxStr = `[${idx + 1}]`;
                    const labelStr = (s.label || s.clientId).padEnd(20);
                    const oscStr = `OSC: ${s.oscHost}:${s.oscPort}${s.oscPrefix || ''}`;
                    console.log(`   ${idxStr} ${labelStr} | ${oscStr}`);
                });
                console.log('----------------------------------------------------------------------------------------');
            }
        }

        console.log(` Estado: [ACTIVO]  |  Total Paquetes OSC: ${this.oscTotalCount}  |  En buffer: ${this.oscHistory.length}`);
        console.log('----------------------------------------------------------------------------------------');
        console.log(' #ID  | HORA UTC    | DIR | ADDRESS PATH            | TIPO | VALORES/PAYLOAD   | DESTINO UDP');
        console.log('----------------------------------------------------------------------------------------');

        if (this.oscHistory.length === 0) {
            console.log('  (Aún no se han registrado paquetes OSC en la sesión)');
        } else {
            for (const r of this.oscHistory) {
                const idStr = String(r.id).padEnd(4);
                const timeStr = r.time.padEnd(11);
                const dirStr = r.dir.padEnd(3);
                const addrStr = r.addr.padEnd(23).slice(0, 23);
                const typeStr = r.types.padEnd(4).slice(0, 4);
                const argsStr = r.args.padEnd(17).slice(0, 17);
                const targetStr = r.target;

                console.log(` ${idStr} | ${timeStr} | ${dirStr} | ${addrStr} | ${typeStr} | ${argsStr} | ${targetStr}`);
            }
        }

        console.log('========================================================================================');
        console.log(' Atajos: [Alt+T / T] Ver MIDI  |  [Alt+O / O] Ver OSC  |  [D] Dispositivos  |  [Alt+P] Pánico');
        console.log('========================================================================================\n');
    }

    clear() {
        this.history = [];
        this.oscHistory = [];
    }

    togglePause() {
        this.isPaused = !this.isPaused;
        return this.isPaused;
    }
}

module.exports = TerminalMonitor;
