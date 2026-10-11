/**
 * Test de Regresión Automatizado: Prevención de Reconexión Fantasma y Control de Salida MIDI
 * 
 * Verifica:
 * 1. Que desconectar la salida a 'none' mantenga el puerto cerrado y el watchdog no reconecte sintetizadores por defecto del SO.
 * 2. Que deshabilitar el dispatch de hardware cierre la salida física inmediatamente.
 * 3. Que el inventario persista el estado desconectado a través de ciclos de refresh del watchdog.
 */

const assert = require('assert');
const LiveSentinelApp = require('./src/app');
const WebSocket = require('ws');

async function testWatchdogGhostReconnectionPrevention() {
    console.log('================================================================');
    console.log('   TEST REGRESIÓN: PREVENCIÓN DE RECONEXIÓN FANTASMA (WATCHDOG) ');
    console.log('================================================================\n');

    const app = new LiveSentinelApp({
        host: '127.0.0.1',
        localOnly: true,
        autoReconnect: true,
        pollIntervalMs: 250 // Encuesta rápida para forzar estrés de watchdog
    });

    await app.start(null, 57120, 'none');

    const ws = new WebSocket('ws://127.0.0.1:8081');
    await new Promise((resolve) => ws.on('open', resolve));

    // [TEST 1] Desconectar salida explícitamente a 'none'
    console.log('[TEST 1] Solicitando desconexión de salida MIDI (device: none)...');
    ws.send(JSON.stringify({ type: 'set_midi_output', device: 'none' }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.strictEqual(
        app.processor.midiRouter.activeOutputName,
        null,
        'La salida activa en el router debe ser null tras solicitar desconexión'
    );
    console.log('  -> Salida desconectada correctamente (activeOutput: null).');

    // [TEST 2] Dejar que el watchdog ejecute al menos 4 ciclos de sondeo
    console.log('[TEST 2] Esperando 4 ciclos de sondeo del watchdog (1000 ms)...');
    await new Promise((resolve) => setTimeout(resolve, 1000));

    assert.strictEqual(
        app.processor.midiRouter.activeOutputName,
        null,
        'El watchdog NO debe reconectar sintes del SO (Apple DLS / Microsoft GS Wavetable) si el usuario eligió none'
    );
    console.log('  -> Reconexión fantasma bloqueada con éxito por el watchdog.');

    // [TEST 3] Desactivar el dispatch de hardware (toggle MIDI en UI)
    console.log('[TEST 3] Desactivando dispatch de hardware (set_routing hardware out=false)...');
    ws.send(JSON.stringify({
        type: 'set_routing',
        target: 'hardware',
        direction: 'out',
        allowed: false
    }));
    await new Promise((resolve) => setTimeout(resolve, 300));

    const matrix = app.processor.midiRouter.getRoutingMatrix();
    assert.strictEqual(matrix.hardware.allowOut, false, 'La matriz debe reflejar allowOut: false para hardware');
    assert.strictEqual(app.targetMidiOut, 'none', 'targetMidiOut debe sincronizarse a none');
    console.log('  -> Dispatch hardware desactivado y sincronizado con el watchdog.');

    // [TEST 4] Cerrar sockets y terminar
    ws.close();
    app.close();

    console.log('\n================================================================');
    console.log('>> TEST DE REGRESIÓN: APROBADO (PASS)');
    console.log('================================================================\n');
}

testWatchdogGhostReconnectionPrevention().catch((err) => {
    console.error('Error en test de regresión:', err);
    process.exit(1);
});
