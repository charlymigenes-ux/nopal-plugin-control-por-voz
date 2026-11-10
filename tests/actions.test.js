'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBrain } = require('../frontend/voice-control.js');

function nopal(over = {}) {
  const posts = [];
  const st = { printers: [{ name: 'Klipper ET4', port: 7125, state: 'ready', job: { state: 'standby' }, data: { extruder: { temperature: 20, target: 0 }, heater_bed: { temperature: 20, target: 0 } } }],
    lasers: [{ name: 'TTS 55 PRO', host: 'h1', online: true, kind: 'laser' }, { name: 'SC MX30 Pro', host: 'h2', online: true, kind: 'laser' }],
    homed: 'xyz', ...over };
  const api = async (m, p, f) => {
    if (m === 'POST') { posts.push([p, f]); return {}; }
    if (p === '/api/printers/status') return { printers: st.printers };
    if (p === '/api/laser/registry/status') return { lasers: st.lasers };
    if (p.startsWith('/api/laser/status')) return { state: 'Idle' };
    if (p === '/api/system/temperature-presets') return { materials: [{ id: 'pla', name: 'PLA', extruder: 200, heater_bed: 60 }] };
    if (p.startsWith('/api/system/toolhead')) return { homed_axes: st.homed, position: { z: 10 } };
    if (p === '/api/models') return [{ id: 'gcode/llavero.gc', name: 'llavero.gc' }, { id: 'gcode/logo.gc', name: 'logo.gc' }];
    if (p.startsWith('/api/laser/history')) return { jobs: [] };
    throw new Error('NOPAL respondió 404');
  };
  return { api, posts, st };
}

test('precalentar con preset, con topes y enfriar', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('precalienta para pla'), /Ya precalenté Klipper ET4 para PLA: extrusor 200 y cama 60/);
  assert.deepEqual(n.posts.map(([p, f]) => f.heater + f.target), ['extruder200', 'heater_bed60']);
  n.posts.length = 0;
  assert.match(await b.handle('calienta el extrusor a 400'), /No pongo 400 grados: mi tope para el extrusor es 280/);
  assert.equal(n.posts.length, 0);
  assert.match(await b.handle('calienta el extrusor a 220 y la cama a 70'), /extrusor a 220 grados y la cama a 70/);
  assert.match(await b.handle('enfría la impresora'), /apagué los calentadores/);
});
test('eje Z: pide confirmación, no mueve sin «sí», y siempre vuelve a G90', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('sube el cabezal 10 mm'), /¿Subo el cabezal 10 milímetros .*de 10 a 20\? Di sí o no/);
  assert.equal(n.posts.length, 0);
  assert.match(await b.handle('no', true), /Cancelado/); assert.equal(n.posts.length, 0);
  await b.handle('sube el cabezal 10 mm'); assert.match(await b.handle('sí', true), /Moviendo el cabezal 10 milímetros hacia arriba/);
  assert.deepEqual(n.posts.map(([, f]) => f.command), ['G91', 'G1 Z10 F600', 'G90']);
});
test('eje Z: no se mueve sin home ni imprimiendo', async () => {
  assert.match(await createBrain({ api: nopal({ homed: '' }).api }).handle('baja el cabezal 5 mm'), /Primero haz home/);
  const n = nopal({ printers: [{ name: 'Klipper ET4', port: 7125, job: { state: 'printing' }, data: {} }] });
  assert.match(await createBrain({ api: n.api }).handle('sube el eje 5 mm'), /No muevo Z: Klipper ET4 está imprimiendo/);
});
test('encuadre: pregunta láser, archivo y confirma antes de mandar', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('encuadra'), /¿En cuál láser\?/);
  assert.match(await b.handle('el tts', true), /Dime parte del nombre del archivo/);
  assert.match(await b.handle('llavero', true), /¿Encuadro llavero en TTS 55 PRO\? Di sí o no/);
  assert.equal(n.posts.length, 0);
  assert.match(await b.handle('sí', true), /Encuadrando en TTS 55 PRO/);
  assert.equal(n.posts[0][0], '/api/laser/job/frame'); assert.equal(n.posts[0][1].path, 'llavero.gc');
});
test('avisos: impresión terminada y temperatura alcanzada, una sola vez', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.deepEqual(await b.pollEvents(), []);
  n.st.printers[0].job = { state: 'printing', progress: 90 }; await b.pollEvents();
  n.st.printers[0].job = { state: 'complete', filename: 'soporte.gcode' };
  assert.deepEqual(await b.pollEvents(), ['Terminó la impresión en Klipper ET4: soporte']);
  assert.deepEqual(await b.pollEvents(), []);
  assert.match(await b.handle('avísame cuando el extrusor llegue a 200'), /te aviso cuando el extrusor de Klipper ET4 llegue a 200/);
  n.st.printers[0].data.extruder.temperature = 199.5;
  assert.match((await b.pollEvents())[0], /ya llegó a 200 grados/); assert.deepEqual(await b.pollEvents(), []);
});
