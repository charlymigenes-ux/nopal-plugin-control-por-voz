'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBrain } = require('../frontend/voice-control.js');

function nopal() {
  const posts = [];
  const leds = [{ id: 'aro', name: 'Aro LED', kind: 'led_strip', on: true, config: { led_color: [0, 0, 255] } }, { id: 'barra', name: 'Iluminación del taller Barra', kind: 'led_strip', on: true, config: { led_color: [255, 255, 255] } }, { id: 'rel', name: 'Relevador', kind: 'relay', on: true }];
  const api = async (m, p, f) => {
    if (m === 'POST') { posts.push([p, f]); return p === '/api/pricing/quotes' ? { id: 'Q-2026-0007' } : {}; }
    if (p === '/api/accessories/status') return { accessories: leds };
    if (p === '/api/pricing/materials') return { materials: [{ id: 'm1', name: 'MDF 3mm', kind: 'sheet', unit: 'm2', unit_cost: 400 }, { id: 'm2', name: 'Acrílico 3mm', kind: 'sheet', unit: 'm2', unit_cost: 900 }, { id: 'm3', name: 'PLA', kind: 'filament', unit: 'kg', unit_cost: 300 }] };
    if (p === '/api/pricing/settings') return { default_prep_minutes: 10, labor_rate_per_hour: 120, price_per_kwh: 3, currency: 'MXN', margin: { mode: 'percentage', percentage: 30 } };
    if (p === '/api/pricing/machines') return { machines: [{ id: 'l1', name: 'Láser', kind: 'laser', watts: 100, rate_per_hour: 50 }] };
    if (p === '/api/pricing/quotes') return [];
    throw new Error('NOPAL respondió 404');
  };
  return { api, posts };
}

test('alerta roja pone todas las tiras en rojo y cancelar restaura el color previo', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('alerta roja'), /Alerta roja activada en las 2 tiras LED/);
  assert.deepEqual(n.posts.map(([, f]) => f.id + ':' + f.r + f.g + f.b), ['aro:25500', 'barra:25500']);
  n.posts.length = 0;
  assert.match(await b.handle('cancela la alerta'), /Alerta cancelada/);
  assert.deepEqual(n.posts.map(([, f]) => f.id + ':' + f.r + ',' + f.g + ',' + f.b), ['aro:0,0,255', 'barra:255,255,255']);
});
test('«pon el aro en verde» solo toca el aro; los relevadores nunca', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('pon el aro en verde'), /Ya puse el aro en verde/);
  assert.deepEqual(n.posts.map(([, f]) => f.id), ['aro']);
});
test('alerta sin color pregunta cuál', async () => {
  const b = createBrain({ api: nopal().api });
  assert.match(await b.handle('activa una alerta'), /¿Qué alerta\?/);
  assert.match(await b.handle('amarilla', true), /Alerta amarilla activada/);
});
test('cotización completa: calcula, confirma y solo entonces guarda', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  const r = await b.handle('crea una cotización para 20 llaveros de 5x5 en MDF 3mm para el cliente Juan Pérez');
  assert.match(r, /Cotización de 20 llaveros de 5 por 5 centímetros en MDF 3mm: total \d+ pesos/); assert.match(r, /Cliente Juan Pérez/);
  assert.equal(n.posts.length, 0);
  assert.match(await b.handle('sí', true), /Guardé la cotización por \d+ pesos, folio 0007/);
  const q = JSON.parse(n.posts[0][1].quote);
  assert.equal(q.quantity, 20); assert.equal(q.client_name, 'Juan Pérez'); assert.equal(q.material.name, 'MDF 3mm');
  assert.ok(Math.abs(q.costs.material_cost - 0.0025 * 20 * 1.25 * 400) < 0.01);
});
test('cotización: pregunta lo que falta y respeta el «no»', async () => {
  const n = nopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('haz una cotización de 10 posavasos'), /¿De qué medida/);
  assert.match(await b.handle('8 por 8', true), /¿En qué material\? MDF 3mm, o Acrílico 3mm/);
  assert.match(await b.handle('acrílico', true), /Cotización de 10 posavasos de 8 por 8 centímetros en Acrílico 3mm/);
  assert.match(await b.handle('no', true), /no la guardé/); assert.equal(n.posts.length, 0);
});
