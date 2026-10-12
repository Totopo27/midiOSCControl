/**
 * Punto de entrada principal para producción y directos
 * Inicia el servidor centinela, conecta hardware y levanta monitor web.
 */
const readline = require('readline');
const LiveSentinelApp = require('./src/app');

async function main() {
    const args = process.argv.slice(2);
    const localOnly = args.includes('--local-only') || args.includes('-l');
    const bindHost = localOnly ? '127.0.0.1' : (args.find(a => a.startsWith('--host='))?.split('=')[1] || '0.0.0.0');

    let initialOut = null;
    let initialIn = 'USB2.0-MIDI';
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--in' && args[i + 1]) initialIn = args[++i];
        else if (args[i].startsWith('--in=')) initialIn = args[i].split('=')[1];
        if (args[i] === '--out' && args[i + 1]) initialOut = args[++i];
        else if (args[i].startsWith('--out=')) initialOut = args[i].split('=')[1];
    }

    console.log('================================================================');
    console.log('      INICIANDO ESTACIÓN UNIVERSAL MIDI & OSC LIVE SENTINEL     ');
    console.log('================================================================\n');

    const app = new LiveSentinelApp({
        host: bindHost,
        localOnly: localOnly,
        autoReconnect: true,
        pollIntervalMs: 2000
    });
    const info = await app.start(initialOut, 57120, initialIn);

    console.log('\n>> ESTACIÓN ACTIVA Y LISTA PARA CONCIERTO EN VIVO:');
    console.log(`   - Modo de Red:            ${localOnly ? 'Aislado Local (127.0.0.1)' : 'Abierto a LAN / iPad (0.0.0.0)'}`);
    console.log(`   - Dashboard de Monitoreo: http://${info.localIP}:${info.httpPort}`);
    console.log(`   - Socket de Ingesta:      ws://${info.localIP}:${info.wsPort}`);
    console.log('   - Destino OSC por defecto: 127.0.0.1:57120 (SuperCollider)');
    console.log('   - Hot-Plug Watchdog:      ACTIVO (Reconexión automática USB en segundo plano)');
    console.log('\n[Comandos interactivos de consola]:');
    console.log('   - [Alt + T / T]  Ver tabla TUI de mensajes MIDI');
    console.log('   - [Alt + O / O]  Ver tabla TUI de datagramas OSC');
    console.log('   - [D / Alt + D]  Gestor de Dispositivos MIDI (SuperCollider Style: in/out por índice)');
    console.log('   - [Alt + P]      Pánico Global (All Notes Off multicanal)');
    console.log('   - [Alt + B]      Conmutar Modo Bypass / Zero-Overhead');
    console.log('   - [Ctrl + C]     Detener estación de forma segura\n');

    let inDevicePrompt = false;

    function openDevicePrompt() {
        if (inDevicePrompt) return;
        inDevicePrompt = true;
        process.stdin.setRawMode(false);
        app.printDeviceInventory();

        console.log('Comandos: in <idx|nombre|off> | out <idx|nombre|off> | osc | midi | osc-target <ip> <puerto> | ls | enter para volver');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.on('SIGINT', () => {
            console.log('\n[CERRANDO] Deteniendo estación...');
            app.close();
            process.exit(0);
        });

        const promptUser = () => {
            rl.question('midi-dispositivos> ', async (input) => {
                const trimmed = input.trim();
                if (!trimmed || trimmed === 'q' || trimmed === 'exit') {
                    rl.close();
                    inDevicePrompt = false;
                    if (process.stdin.isTTY) {
                        process.stdin.setRawMode(true);
                        process.stdin.resume();
                    }
                    console.log('\n[Modo centinela en vivo reanudado. Presiona D para gestionar dispositivos]\n');
                    return;
                }

                const parts = trimmed.split(/\s+/);
                const cmd = parts[0].toLowerCase();
                const arg = parts.slice(1).join(' ');

                try {
                    if (cmd === 'ls' || cmd === 'list') {
                        app.printDeviceInventory();
                    } else if (cmd === 'osc') {
                        app.terminalMonitor.renderOscTable();
                    } else if (cmd === 'midi') {
                        app.terminalMonitor.renderTable();
                    } else if (cmd === 'osc-target') {
                        const [targetHost, targetPortStr] = parts.slice(1);
                        if (!targetHost || !targetPortStr) {
                            console.log('Uso: osc-target <host> <puerto> (ej. osc-target 127.0.0.1 57120)');
                        } else {
                            const p = parseInt(targetPortStr, 10);
                            app.processor.addOscTarget(targetHost, p);
                            console.log(`>> [OSC TARGET] Añadido destino UDP OSC: ${targetHost}:${p}`);
                        }
                    } else if (cmd === 'in') {
                        if (!arg) {
                            console.log('Uso: in <índice|nombre|off>');
                        } else {
                            const res = await app.setMidiInput(arg);
                            if (res.status === 'disconnected') {
                                console.log('>> [MIDI IN] Desactivado exitosamente.');
                            } else {
                                console.log(`>> [MIDI IN] Conectado exitosamente a: "${res.name}"`);
                            }
                        }
                    } else if (cmd === 'out') {
                        if (!arg) {
                            console.log('Uso: out <índice|nombre|off>');
                        } else {
                            const res = await app.setMidiOutput(arg);
                            if (res.status === 'disconnected') {
                                console.log('>> [MIDI OUT] Desactivado exitosamente.');
                            } else {
                                console.log(`>> [MIDI OUT] Conectado exitosamente a: "${res.name}"`);
                            }
                        }
                    } else {
                        console.log(`Comando no reconocido "${cmd}". Usa: in <idx|off>, out <idx|off>, osc, midi, osc-target, ls, o Enter para volver.`);
                    }
                } catch (err) {
                    console.error(`[ERROR] ${err.message}`);
                }

                promptUser();
            });
        };

        promptUser();
    }

    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (key) => {
            if (inDevicePrompt) return;

            if (key === '\u0003') { // Ctrl+C
                console.log('\n[CERRANDO] Deteniendo estación...');
                app.close();
                process.exit(0);
            }

            // Detección de combinaciones Alt / Option (secuencias ESC + char y símbolos de Option en macOS)
            // Alt+P: '\u001bp', '\u001bP', o 'π' / '∏' (según layout de macOS)
            const isAltP = key === '\u001bp' || key === '\u001bP' || key === 'π' || key === '∏';
            // Alt+T: '\u001bt', '\u001bT', o '†' / 'ˇ'
            const isAltT = key === 't' || key === 'T' || key === '\u001bt' || key === '\u001bT' || key === '†' || key === 'ˇ';
            // Alt+O: '\u001bo', '\u001bO', o 'ø' / 'Ø'
            const isAltO = key === 'o' || key === 'O' || key === '\u001bo' || key === '\u001bO' || key === 'ø' || key === 'Ø';
            // Alt+B: '\u001bb', '\u001bB', o '∫' / 'ı'
            const isAltB = key === '\u001bb' || key === '\u001bB' || key === '∫' || key === 'ı';
            // D / Alt+D: 'd', 'D', '\u001bd', '\u001bD', o '∂'
            const isDeviceCmd = key === 'd' || key === 'D' || key === '\u001bd' || key === '\u001bD' || key === '∂';

            if (isDeviceCmd) {
                openDevicePrompt();
            } else if (isAltP) {
                console.log('\n[PÁNICO INTERACTIVO: Alt+P] Disparando All Notes Off multicanal...');
                app.panic();
            } else if (isAltT) {
                app.terminalMonitor.renderTable();
            } else if (isAltO) {
                app.terminalMonitor.renderOscTable();
            } else if (isAltB) {
                const newState = !app.isBypass;
                app.setBypass(newState);
            }
        });
    }
}

main().catch(err => {
    console.error('Error al iniciar la estación:', err);
    process.exit(1);
});
