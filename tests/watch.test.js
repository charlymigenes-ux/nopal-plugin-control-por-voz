'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBrain, _cfg } = require('../frontend/voice-control.js');

function nopal(over = {}) {
  const posts = [];
  const st = { printers: [{ name: 'Klipper ET4', port: 7125, status: 'online', state: 'ready', job: { state: 'standby' }, data: {} }], lasers: [{ name: 'TTS 55 PRO', host: 'h1', online: true, kind: 'laser' }], laserState: 'Idle', services: [{ unit: 'nopal', active: 'active' }], temp: { dht_valid: true, dht_temp_c: 25, dht_humidity_pct: 50 }, queue: [], quotes: [], ...over };
  const api = async (m, p, f) => {
    if (m === 'POST') { posts.push([p, f]); return {}; }
    if (p === '/api/printers/status') return { printers: st.printers };
    if (p === '/api/laser/registry/status') return { lasers: st.lasers };
    if (p.startsWith('/api/laser/status')) return { state: st.laserState };
    if (p === '/api/system/services') return { services: st.services };
    if (p === '/api/accessories/arduino/telemetry') return { boards: [{ online: true, telemetry: st.temp }] };
    if (p.endsWith('/queue')) return { queued_jobs: st.queue };
    if (p === '/api/pricing/quotes') return st.quotes;
    throw new Error('NOPAL respondió 404');
  };
  return { api, posts, st };
}

test('seguridad: avisa cada condición una vez y no repite dentro de la ventana', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.deepEqual(await b.pollEvents(), []);
  n.st.laserState = 'Alarm'; n.st.services = [{ unit: 'nopal', active: 'failed' }]; n.st.temp.dht_temp_c = 38;
  const b2 = createBrain({ api: n.api }); // revisión nueva (la anterior se limita a una cada 15 s)
  const ev = (await b2.pollEvents()).join(' | ');
  assert.match(ev, /Alarma en TTS 55 PRO/); assert.match(ev, /El servicio nopal se detuvo/); assert.match(ev, /38 grados, está muy alta/);
  assert.deepEqual(await b2.pollEvents(), []);
});
test('«no me molestes» silencia los avisos y se puede revertir', async () => {
  const b = createBrain({ api: nopal().api });
  assert.match(await b.handle('no me molestes por 3 horas'), /no te molesto por 3 horas/);
  assert.ok(_cfg().nudge.mutedUntil > Date.now() + 2.9 * 3600000);
  assert.match(await b.handle('ya puedes avisarme'), /vuelvo a avisarte/); assert.equal(_cfg().nudge.mutedUntil, 0);
});
test('máquina parada con cola: ofrece arrancarla y solo arranca con «sí»', async (t) => {
  const realHours = Date.prototype.getHours; Date.prototype.getHours = () => 12; t.after(() => { Date.prototype.getHours = realHours; }); // dentro del horario de avisos
  const n = nopal({ queue: [{ id: 'j1', filename: 'soporte.gcode' }] }); const b = createBrain({ api: n.api });
  _cfg().nudge = { lastActive: { 'printer:7125': Date.now() - 100 * 60000, 'laser:h1': Date.now() }, lastNudge: {}, mutedUntil: 0, lastAny: 0 };
  const ev = await b.pollEvents();
  assert.match(ev[0], /Klipper ET4 lleva .* parada y hay un trabajo en su cola: soporte\. ¿La arranco\?/);
  assert.equal(n.posts.length, 0);
  assert.match(await b.handle('sí', true), /Arrancando la cola en Klipper ET4/);
  assert.equal(n.posts[0][0], '/api/printers/7125/queue/start');
});
