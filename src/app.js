/**
 * Master Live Server with Built-in Telemetry & Live Monitor Web Dashboard
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const StreamProcessor = require('./processor');
const TerminalMonitor = require('./midiosc_monitor');

const HTTP_PORT = 3000;
const WS_PORT = 8081;

function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const LOCAL_IP = getLocalIP();

class LiveSentinelApp {
    constructor(options = {}) {
        this.options = {
            host: options.host || (options.localOnly ? '127.0.0.1' : '0.0.0.0'),
            autoReconnect: options.autoReconnect !== false,
            pollIntervalMs: options.pollIntervalMs || 2500,
            ...options
        };
        this.processor = new StreamProcessor();
        this.terminalMonitor = new TerminalMonitor();
        this.terminalMonitor.setSessionRegistry(this.processor.sessionRegistry);
        this.httpServer = null;
        this.wss = null;
        this.webClients = new Set();
        this.selectedChannel = 0; // Canal 1 por defecto
        this.isBypass = false; // Modo Rendimiento / Zero-Overhead (desacopla telemetría de UI)
        this.watchdogTimer = null;
        this.targetMidiIn = null;
        this.targetMidiOut = null;
    }

    setBypass(enable) {
        this.isBypass = !!enable;
        this.terminalMonitor.setBypass(this.isBypass);
        this.broadcastBypassStatus();
        console.log(`[RENDIMIENTO] Modo Bypass / Zero-Overhead: ${this.isBypass ? 'ACTIVADO (UI silenciada)' : 'DESACTIVADO (Telemetría activa)'}`);
        return this.isBypass;
    }

    broadcastBypassStatus() {
        const payload = JSON.stringify({ type: 'bypass_status', enabled: this.isBypass });
        for (const ws of this.webClients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        }
    }

    broadcastRoutingMatrix() {
        const payload = JSON.stringify({
            type: 'routing_matrix',
            matrix: this.processor.midiRouter.getRoutingMatrix()
        });
        for (const ws of this.webClients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        }
    }

    broadcastSessionsList() {
        const payload = JSON.stringify({
            type: 'sessions_list',
            sessions: this.processor.sessionRegistry.listSessions()
        });
        for (const ws of this.webClients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        }
    }

    async start(targetMidi = null, targetOscPort = 57120, targetMidiIn = null) {
        await this.processor.init();
        await this.processor.enableVirtualProxy();
        this.processor.addOscTarget('127.0.0.1', targetOscPort);

        this.targetMidiOut = targetMidi;
        this.targetMidiIn = targetMidiIn;

        const outputs = this.processor.midiRouter.listOutputs();
        let portToOpen = targetMidi;
        if (!portToOpen && targetMidi !== 'none') {
            const usbPort = outputs.find(o => o.name.toLowerCase().includes('usb'));
            portToOpen = usbPort ? usbPort.name : null;
        }

        if (portToOpen && portToOpen !== 'none') {
            try {
                await this.processor.midiRouter.openOutput(portToOpen);
                this.targetMidiOut = portToOpen;
            } catch (err) {
                console.warn(`[MIDI] No se pudo abrir salida por defecto "${portToOpen}": ${err.message}. Podrás seleccionarla manualmente desde la consola.`);
            }
        } else {
            this.targetMidiOut = targetMidi === 'none' ? 'none' : null;
        }

        // Si se especifica targetMidiIn o en producción se auto-conecta si se pide
        let inToOpen = targetMidiIn;
        if (!inToOpen && targetMidiIn !== 'none') {
            const inputs = this.processor.midiRouter.listInputs();
            const usbIn = inputs.find(i => i.name.toLowerCase().includes('usb'));
            inToOpen = usbIn ? usbIn.name : null;
        }

        if (inToOpen && inToOpen !== 'none') {
            try {
                await this.processor.midiRouter.openInput(inToOpen);
                this.targetMidiIn = inToOpen;
            } catch (err) {
                console.warn(`[MIDI] No se pudo abrir entrada "${inToOpen}": ${err.message}.`);
            }
        } else {
            this.targetMidiIn = targetMidiIn === 'none' ? 'none' : null;
        }

        if (this.options.autoReconnect) {
            this._startWatchdog();
        }

        // Suscribir el monitor de consola
        this.processor.subscribe((event) => {
            // Si el modo Bypass está activo, no alimentar terminal ni serializar hacia WebSockets
            if (this.isBypass) return;

            this.terminalMonitor.logEvent(event);
            
            // Reenviar a clientes web que tengan el monitor abierto
            const payload = JSON.stringify({ type: 'telemetry', data: event });
            for (const ws of this.webClients) {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(payload);
                }
            }
        });

        // 1. Servidor HTTP
        this.httpServer = http.createServer((req, res) => {
            const urlPath = req.url.split('?')[0];

            // Endpoint REST de inventario inmediato de dispositivos
            if (urlPath === '/api/devices') {
                (async () => {
                    try {
                        await this.processor.midiRouter.refresh();
                    } catch (_) {}
                    const outputs = this.processor.midiRouter.listOutputs();
                    const inputs = this.processor.midiRouter.listInputs();
                    const payload = JSON.stringify({
                        type: 'device_inventory',
                        outputs,
                        inputs,
                        activeOutput: this.processor.midiRouter.activeOutputName,
                        activeInput: this.processor.midiRouter.activeInputName,
                        virtualProxy: this.processor.virtualProxy ? this.processor.virtualProxy.getStatus() : null
                    });
                    res.writeHead(200, {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(payload);
                })();
                return;
            }

            // Protección contra Path Traversal: Sanitizar ruta y restringir a archivos públicos permitidos
            const safePath = path.normalize(req.url.split('?')[0]).replace(/^(\.\.[\/\\])+/, '');
            let fileName = safePath === '/' || safePath === '\\' ? 'midiosc_monitor.html' : safePath.replace(/^[\/\\]+/, '');
            
            // Lista blanca de archivos públicos permitidos (con soporte retrocompatible para midi_monitor.html)
            const allowedFiles = ['midiosc_monitor.html', 'midi_monitor.html', 'midi_shortcut_studio.html', 'favicon.ico'];
            if (!allowedFiles.includes(fileName)) {
                res.writeHead(403, { 'Content-Type': 'text/plain' });
                return res.end('Acceso denegado: solo archivos públicos autorizados.');
            }

            // Si piden midi_monitor.html, redirigir internamente a midiosc_monitor.html
            const actualFileName = fileName === 'midi_monitor.html' ? 'midiosc_monitor.html' : fileName;
            const filePath = path.join(__dirname, '..', actualFileName);
            const extname = String(path.extname(filePath)).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html',
                '.js': 'text/javascript',
                '.css': 'text/css',
                '.json': 'application/json',
                '.ico': 'image/x-icon'
            };

            const contentType = mimeTypes[extname] || 'application/octet-stream';

            fs.readFile(filePath, (err, content) => {
                if (err) {
                    res.writeHead(err.code === 'ENOENT' ? 404 : 500);
                    res.end(`Error: ${err.code}`);
                } else {
                    res.writeHead(200, { 
                        'Content-Type': contentType,
                        'X-Content-Type-Options': 'nosniff',
                        'X-Frame-Options': 'DENY'
                    });
                    res.end(content, 'utf-8');
                }
            });
        });

        const bindHost = this.options.host;
        const displayHost = (bindHost === '0.0.0.0') ? LOCAL_IP : bindHost;

        this.httpServer.listen(HTTP_PORT, bindHost, () => {
            console.log(`[HTTP] Monitor Web disponible: http://${displayHost}:${HTTP_PORT}`);
        });

        // 2. Servidor WebSocket
        this.wss = new WebSocket.Server({ port: WS_PORT, host: bindHost });
        console.log(`[WS]   Ingesta y Telemetría: ws://${displayHost}:${WS_PORT}`);

        this.wss.on('connection', (ws) => {
            this.webClients.add(ws);

            // Enviar inventario de dispositivos conectados al recién conectado
            this.sendDeviceInventory(ws);

            ws.on('message', async (data) => {
                try {
                    // Limitar tamaño de mensaje para prevenir DoS por memoria
                    if (data.length > 4096) return;

                    const msg = JSON.parse(data);

                    if (msg.type === 'set_midi_learn') {
                        // msg: { enabled: true/false, target: 'mapping_field' | 'shift' }
                        const active = this.processor.shiftEngine.setMidiLearn(!!msg.enabled, msg.target || null);
                        const reply = JSON.stringify({
                            type: 'midi_learn_status',
                            active,
                            target: this.processor.shiftEngine.learnTarget
                        });
                        for (const client of this.webClients) {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(reply);
                            }
                        }
                        return;
                    }

                    if (msg.type === 'get_devices') {
                        (async () => {
                            try {
                                await this.processor.midiRouter.refresh();
                            } catch (_) {}
                            this.sendDeviceInventory(ws);
                            ws.send(JSON.stringify({ type: 'bypass_status', enabled: this.isBypass }));
                            ws.send(JSON.stringify({ type: 'routing_matrix', matrix: this.processor.midiRouter.getRoutingMatrix() }));
                            ws.send(JSON.stringify({ type: 'virtual_proxy_status', status: this.processor.virtualProxy.getStatus() }));
                        })();
                        return;
                    }

                    if (msg.type === 'get_virtual_proxy') {
                        ws.send(JSON.stringify({ type: 'virtual_proxy_status', status: this.processor.virtualProxy.getStatus() }));
                        return;
                    }

                    if (msg.type === 'set_routing') {
                        // msg: { target: 'hardware' | 'osc' | 'app_b', direction: 'out', allowed: false }
                        if (msg.target && msg.direction !== undefined && msg.allowed !== undefined) {
                            this.processor.midiRouter.setRoutePermission(msg.target, msg.direction, msg.allowed);
                            if (msg.target === 'hardware' && msg.direction === 'out' && !msg.allowed) {
                                // Si se desactiva el dispatch MIDI, desenganchar salida física activa
                                if (this.processor.midiRouter.activeOutput) {
                                    try { this.processor.midiRouter.activeOutput.close(); } catch (_) {}
                                    this.processor.midiRouter.activeOutput = null;
                                    this.processor.midiRouter.activeOutputName = null;
                                }
                                this.targetMidiOut = 'none';
                                this.broadcastDeviceInventory();
                            }
                            this.broadcastRoutingMatrix();
                        }
                        return;
                    }

                    if (msg.type === 'register_client') {
                        try {
                            const result = this.processor.sessionRegistry.registerClient(msg.clientId, {
                                label: msg.label,
                                midiChannel: msg.midiChannel,
                                oscPort: msg.oscPort,
                                oscHost: msg.oscHost,
                                oscPrefix: msg.oscPrefix
                            });
                            ws.send(JSON.stringify({
                                type: 'client_registered',
                                session: result.session,
                                conflicts: result.conflicts
                            }));
                            this.broadcastSessionsList();
                        } catch (err) {
                            ws.send(JSON.stringify({ type: 'error', message: err.message }));
                        }
                        return;
                    }

                    if (msg.type === 'unregister_client') {
                        if (msg.clientId) {
                            this.processor.panicClient(msg.clientId);
                            this.processor.sessionRegistry.unregisterClient(msg.clientId);
                            this.broadcastSessionsList();
                        }
                        return;
                    }

                    if (msg.type === 'get_sessions') {
                        ws.send(JSON.stringify({
                            type: 'sessions_list',
                            sessions: this.processor.sessionRegistry.listSessions()
                        }));
                        return;
                    }

                    if (msg.type === 'set_bypass') {
                        this.setBypass(!!msg.enabled);
                        return;
                    }

                    if (msg.type === 'set_midi_output') {
                        try {
                            if (!msg.device || msg.device === 'none') {
                                this.targetMidiOut = 'none';
                                if (this.processor.midiRouter.activeOutput) {
                                    this.processor.midiRouter.activeOutput.close();
                                    this.processor.midiRouter.activeOutput = null;
                                    this.processor.midiRouter.activeOutputName = null;
                                }
                            } else {
                                this.targetMidiOut = msg.device;
                                await this.processor.midiRouter.openOutput(msg.device);
                            }
                            this.broadcastDeviceInventory();
                        } catch (e) {
                            ws.send(JSON.stringify({ type: 'error', message: e.message }));
                        }
                        return;
                    }

                    if (msg.type === 'set_midi_input') {
                        try {
                            if (!msg.device || msg.device === 'none') {
                                this.targetMidiIn = 'none';
                                if (this.processor.midiRouter.activeInput) {
                                    this.processor.midiRouter.activeInput.close();
                                    this.processor.midiRouter.activeInput = null;
                                    this.processor.midiRouter.activeInputName = null;
                                }
                            } else {
                                this.targetMidiIn = msg.device;
                                await this.processor.midiRouter.openInput(msg.device);
                            }
                            this.broadcastDeviceInventory();
                        } catch (e) {
                            ws.send(JSON.stringify({ type: 'error', message: e.message }));
                        }
                        return;
                    }

                    if (msg.type === 'midi') {
                        const rawCh = parseInt(msg.channel, 10);
                        const ch = (!isNaN(rawCh) && rawCh >= 1 && rawCh <= 16) ? (rawCh - 1) : this.selectedChannel;

                        const rawNote = parseInt(msg.note, 10);
                        const rawVel = msg.velocity !== undefined ? parseInt(msg.velocity, 10) : 127;

                        // Validar rango MIDI 1.0 (0-127)
                        if (isNaN(rawNote) || rawNote < 0 || rawNote > 127) return;
                        const vel = isNaN(rawVel) ? 127 : Math.max(0, Math.min(127, rawVel));

                        if (msg.event === 'noteon') {
                            this.processor.dispatchNoteOn(ch, rawNote, vel, msg);
                        } else if (msg.event === 'noteoff') {
                            this.processor.dispatchNoteOff(ch, rawNote, msg);
                        } else if (msg.event === 'panic') {
                            if (msg.clientId) {
                                this.processor.panicClient(msg.clientId);
                            } else {
                                this.processor.panic();
                            }
                        }
                    } else if (msg.type === 'panic') {
                        if (msg.clientId) {
                            this.processor.panicClient(msg.clientId);
                        } else {
                            this.processor.panic();
                        }
                    } else if (msg.type === 'osc') {
                        // Enrutamiento seguro y encapsulado de paquetes OSC crudos
                        if (msg.message) {
                            try {
                                const oscBuf = Buffer.isBuffer(msg.message) 
                                    ? msg.message 
                                    : Buffer.from(Array.isArray(msg.message) || typeof msg.message === 'string' ? msg.message : []);
                                const targetIp = typeof msg.ip === 'string' ? msg.ip : null;
                                const targetPort = !isNaN(parseInt(msg.port, 10)) ? parseInt(msg.port, 10) : null;
                                this.processor.dispatchRawOsc(oscBuf, targetIp, targetPort, msg.appId || 'app_a');
                            } catch (err) {
                                // Ignorar silenciosamente paquetes corruptos sin tumbar el WebSocket
                            }
                        }
                    }
                } catch (e) {
                    // Ignorar silenciosamente mensajes malformados sin tumbar el WebSocket
                }
            });

            ws.on('close', () => {
                this.webClients.delete(ws);
            });
        });

        return { localIP: displayHost, httpPort: HTTP_PORT, wsPort: WS_PORT, bindHost };
    }

    _startWatchdog() {
        if (this.watchdogTimer) return;
        this.watchdogTimer = setInterval(async () => {
            try {
                // Sincronizar estado físico real de puertos en el sistema operativo
                await this.processor.midiRouter.refresh();

                const outputs = this.processor.midiRouter.listOutputs();
                const inputs = this.processor.midiRouter.listInputs();

                const outActive = this.processor.midiRouter.activeOutputName;
                const inActive = this.processor.midiRouter.activeInputName;

                let stateChanged = false;

                // 1. Verificar salida física: solo reconectar si el usuario tiene un puerto asignado explícito
                // y NO ha elegido desconectar ('none') ni desactivar el dispatch hardware
                const isHardwareOutAllowed = this.processor.midiRouter.isRouteAllowed('hardware', 'hardware');
                if (this.targetMidiOut && this.targetMidiOut !== 'none' && isHardwareOutAllowed) {
                    const outExists = outActive && outputs.some(o => o.name === outActive);
                    if (!outExists) {
                        let portToOpen = this.targetMidiOut;
                        // Solo buscar puerto alternativo si targetMidiOut coincide o si se conectó un dispositivo físico USB
                        const matchedOutput = outputs.find(o => o.name === portToOpen || o.name.toLowerCase().includes('usb'));
                        portToOpen = matchedOutput ? matchedOutput.name : null;

                        if (portToOpen && portToOpen !== outActive) {
                            try {
                                await this.processor.midiRouter.openOutput(portToOpen);
                                console.log(`[WATCHDOG::HW] Salida MIDI reconectada: "${portToOpen}"`);
                                stateChanged = true;
                            } catch (_) {}
                        }
                    }
                } else if ((this.targetMidiOut === 'none' || !isHardwareOutAllowed) && outActive) {
                    // Si el usuario eligió 'none' o apagó el dispatch MIDI, asegurar que la salida quede cerrada
                    if (this.processor.midiRouter.activeOutput) {
                        try { this.processor.midiRouter.activeOutput.close(); } catch (_) {}
                        this.processor.midiRouter.activeOutput = null;
                        this.processor.midiRouter.activeOutputName = null;
                        stateChanged = true;
                    }
                }

                // 2. Verificar entrada física: solo reconectar si el usuario tiene un puerto asignado explícito
                // y NO ha elegido desconectar ('none')
                if (this.targetMidiIn && this.targetMidiIn !== 'none') {
                    const inExists = inActive && inputs.some(i => i.name === inActive);
                    if (!inExists) {
                        let inToOpen = this.targetMidiIn;
                        const matchedInput = inputs.find(i => i.name === inToOpen || i.name.toLowerCase().includes('usb'));
                        inToOpen = matchedInput ? matchedInput.name : null;

                        if (inToOpen && inToOpen !== inActive) {
                            try {
                                await this.processor.midiRouter.openInput(inToOpen);
                                console.log(`[WATCHDOG::HW] Entrada MIDI reconectada: "${inToOpen}"`);
                                stateChanged = true;
                            } catch (_) {}
                        }
                    }
                } else if (this.targetMidiIn === 'none' && inActive) {
                    // Si el usuario eligió 'none', asegurar que la entrada quede cerrada
                    if (this.processor.midiRouter.activeInput) {
                        try { this.processor.midiRouter.activeInput.close(); } catch (_) {}
                        this.processor.midiRouter.activeInput = null;
                        this.processor.midiRouter.activeInputName = null;
                        stateChanged = true;
                    }
                }

                if (stateChanged) {
                    this.broadcastDeviceInventory();
                }
            } catch (_) {
                // Silenciar errores durante cambio de bus USB
            }
        }, this.options.pollIntervalMs);
    }

    sendDeviceInventory(ws) {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
            const outputs = this.processor.midiRouter.listOutputs();
            const inputs = this.processor.midiRouter.listInputs();
            const payload = JSON.stringify({
                type: 'device_inventory',
                outputs,
                inputs,
                activeOutput: this.processor.midiRouter.activeOutputName,
                activeInput: this.processor.midiRouter.activeInputName,
                virtualProxy: this.processor.virtualProxy ? this.processor.virtualProxy.getStatus() : null
            });
            ws.send(payload);
        } catch (e) {}
    }

    broadcastDeviceInventory() {
        for (const ws of this.webClients) {
            this.sendDeviceInventory(ws);
        }
    }

    panic() {
        this.processor.panic();
    }

    close() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        this.processor.close();
        if (this.httpServer) this.httpServer.close();
        if (this.wss) this.wss.close();
    }
}

module.exports = LiveSentinelApp;
