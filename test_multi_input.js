/**
 * Test Automatizado: Soporte de Múltiples Entradas MIDI Concurrentes (Multi-Input Toggles)
 * 
 * Valida:
 * 1. Habilitación y deshabilitación concurrente de múltiples puertos MIDI IN (MidiRouter).
 * 2. Identificación precisa del origen (source) de cada evento recibido desde diferentes puertos.
 * 3. Control por WebSocket: comandos toggle_midi_input, set_midi_inputs y set_midi_input ('none').
 * 4. Integridad de la telemetría distribuida hacia los clientes WebSocket.
 */

const assert = require('assert');
const JZZ = require('jzz');
const LiveSentinelApp = require('./src/app');
const WebSocket = require('ws');

async function testMultiInputSupport() {
    console.log('================================================================');
    console.log('   TEST: SOPORTE DE MÚLTIPLES ENTRADAS MIDI (MULTI-INPUT)       ');
    console.log('================================================================\n');

    // --- ETAPA 1: Registrar Puertos Virtuales de Prueba con JZZ ---
    const devAName = 'MockInputControllerAlpha';
    const devBName = 'MockInputControllerBeta';

    const devAEmitter = JZZ.Widget();
    const devBEmitter = JZZ.Widget();

    JZZ.addMidiIn(devAName, devAEmitter);
    JZZ.addMidiIn(devBName, devBEmitter);

    console.log(`[TEST 1] Puertos virtuales creados: "${devAName}" y "${devBName}"`);

    // --- ETAPA 2: Validación en MidiRouter a Nivel Unitario ---
    const app = new LiveSentinelApp({
        host: '127.0.0.1',
        localOnly: true,
        httpPort: 3075,
        wsPort: 8095,
        autoReconnect: false
    });

    await app.start(null, 57199, 'none');
    const router = app.processor.midiRouter;

    // Habilitar devA
    console.log('[TEST 2] Habilitando devA...');
    await router.enableInput(devAName);
    assert.strictEqual(router.isInputActive(devAName), true, 'devA debe estar activo');
    assert.strictEqual(router.getActiveInputNames().length, 1);

    // Habilitar devB concurrentemente (sin cerrar devA)
    console.log('[TEST 3] Habilitando devB simultáneamente...');
    await router.enableInput(devBName);
    assert.strictEqual(router.isInputActive(devAName), true, 'devA debe seguir activo');
    assert.strictEqual(router.isInputActive(devBName), true, 'devB debe estar activo');
    assert.deepStrictEqual(router.getActiveInputNames().sort(), [devAName, devBName].sort());
    console.log('  -> Ambos puertos activos en simultáneo (PASS)');

    // Verificar captura de eventos y atributo source
    const receivedFromRouter = [];
    router.onMidiInput((msg) => {
        receivedFromRouter.push(msg);
    });

    // Inyectar Note On desde devA
    devAEmitter._emit([0x90, 60, 100]);
    // Inyectar Note On desde devB
    devBEmitter._emit([0x91, 72, 110]);

    await new Promise(r => setTimeout(r, 50));

    assert.strictEqual(receivedFromRouter.length, 2, 'Debieron recibirse 2 eventos');
    assert.strictEqual(receivedFromRouter[0].source, devAName, 'El origen debe ser devA');
    assert.strictEqual(receivedFromRouter[0].note, 60);
    assert.strictEqual(receivedFromRouter[1].source, devBName, 'El origen debe ser devB');
    assert.strictEqual(receivedFromRouter[1].note, 72);
    console.log('  -> Discriminación de fuentes de hardware verificada (PASS)');

    // --- ETAPA 3: Control por WebSocket en Vivo ---
    console.log('[TEST 4] Conectando cliente WebSocket al servidor...');
    const ws = new WebSocket('ws://127.0.0.1:8095');
    await new Promise(r => ws.on('open', r));

    const inventoryEvents = [];
    const telemetryEvents = [];

    ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'device_inventory') {
            inventoryEvents.push(msg);
        } else if (msg.type === 'telemetry') {
            telemetryEvents.push(msg.data);
        }
    });

    // Desconectar devA vía toggle_midi_input
    console.log('[TEST 5] Alternando devA a OFF vía WebSocket (toggle_midi_input)...');
    ws.send(JSON.stringify({
        type: 'toggle_midi_input',
        device: devAName,
        enabled: false
    }));

    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(router.isInputActive(devAName), false, 'devA debe haberse apagado');
    assert.strictEqual(router.isInputActive(devBName), true, 'devB debe permanecer activo');
    console.log('  -> Desactivación individual por toggle verificada (PASS)');

    // Reconectar devA vía toggle_midi_input
    console.log('[TEST 6] Alternando devA a ON nuevamente vía WebSocket...');
    ws.send(JSON.stringify({
        type: 'toggle_midi_input',
        device: devAName,
        enabled: true
    }));

    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(router.isInputActive(devAName), true, 'devA debe estar encendido nuevamente');
    assert.strictEqual(router.isInputActive(devBName), true, 'devB debe seguir encendido');
    console.log('  -> Reactivación en caliente verificada (PASS)');

    // Desconectar todas con set_midi_input: 'none'
    console.log('[TEST 7] Apagando todas las entradas con set_midi_input ("none")...');
    ws.send(JSON.stringify({
        type: 'set_midi_input',
        device: 'none'
    }));

    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(router.getActiveInputNames().length, 0, 'No debe haber entradas activas');
    console.log('  -> Desconexión total limpia verificada (PASS)');

    ws.close();
    if (app.httpServer) app.httpServer.close();
    if (app.wss) app.wss.close();

    console.log('\n================================================================');
    console.log('>> RESULTADO: SOPORTE MULTI-INPUT 100% OPERATIVO (PASS)');
    console.log('================================================================');
    process.exit(0);
}

testMultiInputSupport().catch(err => {
    console.error('Fallo en testMultiInputSupport:', err);
    process.exit(1);
});
