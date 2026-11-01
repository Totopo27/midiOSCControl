/**
 * Compuerta de Auditoría de Red y Seguridad (Fase 1 - Hub & Spoke)
 * Valida protección contra Path Traversal, DoS en WebSocket,
 * robustez en codificación binaria OSC y encapsulamiento de dispatchRawOsc.
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const dgram = require('dgram');
const LiveSentinelApp = require('./src/app');
const { encodeOSCMessage } = require('./src/osc');

async function testNetworkAudit() {
    console.log('================================================================');
    console.log('   TEST AUDITORÍA FASE 1: RED, WEBSOCKET Y SEGURIDAD OSC        ');
    console.log('================================================================\n');

    const app = new LiveSentinelApp({
        httpPort: 3099,
        wsPort: 8099,
        localOnly: true
    });
    const info = await app.start();

    // --- PRUEBA 1: Protección contra Path Traversal y Allowlist HTTP ---
    console.log('[TEST 1] Verificando protección contra Path Traversal en HTTP...');
    await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${info.httpPort}/../../package.json`, (res) => {
            assert.strictEqual(res.statusCode, 403, 'Path traversal debe ser rechazado con 403');
            console.log('  -> Intento ../../package.json bloqueado con 403 Forbidden.');
            resolve();
        }).on('error', reject);
    });

    await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${info.httpPort}/archivo_inexistente.txt`, (res) => {
            assert.strictEqual(res.statusCode, 403, 'Archivos no permitidos deben ser rechazados con 403');
            console.log('  -> Archivo no autorizado bloqueado con 403 Forbidden.');
            resolve();
        }).on('error', reject);
    });

    // --- PRUEBA 2: Resistencia de WebSocket a Payloads Malformados y Grandes ---
    console.log('[TEST 2] Verificando resistencia WebSocket a inputs malformados...');
    const ws = new WebSocket(`ws://127.0.0.1:${info.wsPort}`);
    await new Promise((resolve) => ws.on('open', resolve));

    // A. Enviar JSON inválido
    ws.send('{este-no-es-un-json-valido}');
    // B. Enviar payload que excede 4096 bytes
    ws.send('x'.repeat(5000));
    // C. Enviar mensaje de tipo noteon con valores corrompidos
    ws.send(JSON.stringify({ type: 'midi', event: 'noteon', channel: 'invalido', note: 'NaN', velocity: {} }));
    
    // Esperar 200 ms y verificar que el socket sigue vivo
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(ws.readyState, WebSocket.OPEN, 'El WebSocket debe mantenerse abierto y tolerar errores sin crashear');
    console.log('  -> WebSocket absorbió ráfaga de datos corruptos sin colapsar el servidor.');

    // --- PRUEBA 3: Robustez de Codificación OSC (encodeOSCMessage) ---
    console.log('[TEST 3] Verificando robustez matemática y tipos en encodeOSCMessage...');
    
    // Validar dirección inválida (debe fallar limpiamente con error)
    assert.throws(() => {
        encodeOSCMessage('direccion-sin-barra', 'f', [1.0]);
    }, /Dirección OSC inválida/, 'Debe validar que la ruta empiece con "/"');

    // Validar argumentos nulos, NaN o undefined sin corromper el buffer
    const bufSafe = encodeOSCMessage('/test', 'fis', [NaN, undefined, null]);
    assert.ok(Buffer.isBuffer(bufSafe), 'Debe generar buffer binario válido');
    assert.strictEqual(bufSafe.length % 4, 0, 'El buffer binario OSC debe mantener alineación de 4 bytes');
    console.log('  -> Codificador OSC tolerante a NaN, null y alineación de 4 bytes garantizada.');

    // --- PRUEBA 4: Despacho de Paquetes OSC Crudos (dispatchRawOsc) ---
    console.log('[TEST 4] Verificando dispatchRawOsc con Matriz de Ruteo y Telemetría...');
    
    let oscTelemetriaCapturada = false;
    app.processor.subscribe((evt) => {
        if (evt.protocol === 'osc' && evt.path === '/custom_osc') {
            oscTelemetriaCapturada = true;
        }
    });

    // Escuchar UDP en un puerto temporal
    const testOscServer = dgram.createSocket('udp4');
    let udpPaqueteRecibido = false;
    await new Promise((r) => testOscServer.bind(57129, '127.0.0.1', r));
    testOscServer.on('message', (msg) => {
        if (msg.includes(Buffer.from('/custom_osc'))) {
            udpPaqueteRecibido = true;
        }
    });

    // Enviar a través de WebSocket
    const customOscBuf = encodeOSCMessage('/custom_osc', 'f', [440.0]);
    ws.send(JSON.stringify({
        type: 'osc',
        message: Array.from(customOscBuf),
        port: 57129,
        ip: '127.0.0.1'
    }));

    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(udpPaqueteRecibido, true, 'El paquete OSC crudo debió llegar al servidor UDP');
    assert.strictEqual(oscTelemetriaCapturada, true, 'La telemetría debió registrar el paquete OSC');
    console.log('  -> dispatchRawOsc despachó correctamente a UDP y reportó telemetría.');

    // Probar aislamiento por matriz de ruteo
    app.processor.midiRouter.setRoutePermission('app_b', 'osc', false);
    const blockedRes = app.processor.dispatchRawOsc(customOscBuf, '127.0.0.1', 57129, 'app_b');
    assert.strictEqual(blockedRes.status, 'blocked_by_routing_matrix', 'Debe respetar el aislamiento de la matriz');
    console.log('  -> Matriz de ruteo bloqueó exitosamente paquetes OSC desde fuentes no autorizadas.');

    // Cerrar recursos
    ws.close();
    testOscServer.close();
    await app.processor.close();
    if (app.httpServer) app.httpServer.close();
    if (app.wss) app.wss.close();

    console.log('\n================================================================');
    console.log('>> AUDITORÍA FASE 1: 100% PASS (APROBADO)');
    console.log('================================================================');
    process.exit(0);
}

testNetworkAudit().catch((err) => {
    console.error('Fallo en auditoría de red:', err);
    process.exit(1);
});
