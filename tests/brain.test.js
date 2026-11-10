// Pruebas del cerebro con un NOPAL simulado (sin red, sin hardware). Ejecutar: node --test tests/
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBrain, norm, ordinalPick } = require('../frontend/voice-control.js');

function fakeNopal(over = {}) {
  const calls = [];
  const state = {
    scenes: [
      { id: 1, name: 'LUZ PRINCIPAL', current_state_name: 'Apagado' },
      { id: 2, name: 'LUZ ARO', current_state_name: 'Apagado' },
      { id: 3, name: 'AIRE GENERAL', current_state_name: 'Apagado' },
    ],
    printers: [{ name: 'Klipper ET4', port: 7125, state: 'ready', job: { state: 'standby' }, data: { extruder: { temperature: 21.7 }, heater_bed: { temperature: 22 } } }],
    lasers: [{ name: 'TTS 55 PRO', host: '10.0.0.5', online: true, kind: 'laser' }, { name: 'SC MX30 Pro', host: '10.0.0.6', online: true, kind: 'laser' }],
    ...over,
  };
  const api = async (method, path, form) => {
    calls.push([method, path, form]);
    if (path === '/api/accessories/scenes') return { scenes: state.scenes };
    let m = /^\/api\/accessories\/scenes\/(\d+)\/run$/.exec(path);
    if (m) { const s = state.scenes.find((x) => x.id === Number(m[1])); s.current_state_name = s.current_state_name === 'Encendido' ? 'Apagado' : 'Encendido'; return {}; }
    if (path === '/api/printers/status') return { printers: state.printers };
    if (path === '/api/laser/registry/status') return { lasers: state.lasers };
    if (path.startsWith('/api/laser/status')) return { state: 'Idle' };
    if (path === '/api/plugins') return { plugins: [{ id: 'pricing', name: 'Cotizador', installed: true, enabled: true, frontend: { section: 'pricing' } }] };
    if (path === '/api/ai/status') return { enabled: false };
    return {};
  };
  return { api, calls, state };
}

test('enciende la luz: con dos escenas de luz pregunta cuál; luego ejecuta', async () => {
  const n = fakeNopal(); const actions = [];
  const b = createBrain({ api: n.api, onAction: async (a) => { actions.push(a); } });
  const q = await b.handle('enciende la luz');
  assert.match(q, /¿Cuál\?/); assert.match(q, /LUZ PRINCIPAL/);
  const r = await b.handle('la principal', true);
  assert.match(r, /Ya encendí la luz principal/);
  assert.equal(n.state.scenes[0].current_state_name, 'Encendido');
});

test('una sola escena de aire: la usa sin preguntar y no repite si ya estaba', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('enciende el aire'), /Ya encendí el aire general/);
  assert.match(await b.handle('prende el aire'), /ya estaba encendido/);
  assert.match(await b.handle('apágalo'), /Ya apagué el aire general/);
});

test('nada se ejecuta si no entiende cuál escena', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('enciende el microondas'), /No sé cuál es/);
  assert.equal(n.calls.filter(([m]) => m === 'POST').length, 0);
});

test('estado de las máquinas', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  const r = await b.handle('¿cómo va todo?');
  assert.match(r, /Klipper ET4 lista, extrusor 22 grados/); assert.match(r, /TTS 55 PRO en reposo/);
});

test('pausar sin impresión en curso no manda nada a la máquina', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('pausa la impresión'), /no está imprimiendo/);
  assert.equal(n.calls.filter(([m]) => m === 'POST').length, 0);
});

test('cancelar impresión exige confirmación y respeta el «no»', async () => {
  const n = fakeNopal({ printers: [{ name: 'Klipper ET4', port: 7125, state: 'printing', job: { state: 'printing', progress: 40 }, data: {} }] });
  const b = createBrain({ api: n.api });
  assert.match(await b.handle('cancela la impresión'), /¿Cancelo la impresión/);
  assert.match(await b.handle('no', true), /Cancelado/);
  assert.equal(n.calls.filter(([m, p]) => m === 'POST' && /cancel/.test(p)).length, 0);
  await b.handle('cancela la impresión'); await b.handle('sí', true);
  assert.equal(n.calls.filter(([m, p]) => m === 'POST' && /cancel/.test(p)).length, 1);
});

test('home no se hace mientras imprime', async () => {
  const n = fakeNopal({ printers: [{ name: 'Klipper ET4', port: 7125, state: 'printing', job: { state: 'printing' }, data: {} }], lasers: [] });
  const b = createBrain({ api: n.api });
  assert.match(await b.handle('haz home'), /No hago home: Klipper ET4 está imprimiendo/);
});

test('home con varias máquinas pregunta y entiende nombres mal escritos', async () => {
  const n = fakeNopal({ printers: [] }); const b = createBrain({ api: n.api });
  assert.match(await b.handle('haz home'), /¿En cuál\?/);
  assert.match(await b.handle('el scmx treinta pro', true), /Haciendo home en SC MX30 Pro|¿En cuál\?/);
});

test('navegación: ajustes, tema, plugin por nombre', async () => {
  const n = fakeNopal(); const acts = []; const b = createBrain({ api: n.api, onAction: async (a) => { acts.push(a); } });
  await b.handle('abre configuración de apariencia'); await b.handle('cambia el tema a oscuro'); await b.handle('ve al cotizador');
  assert.deepEqual(acts.map((a) => a.type + ':' + (a.tab || a.theme || a.name)), ['settings:appearance', 'theme:dark', 'goto:pricing']);
});

test('si la pantalla no puede ejecutar la acción, dice el motivo en lugar de «listo»', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api, onAction: async () => 'No encuentro la configuración' });
  assert.equal(await b.handle('abre configuración'), 'No encuentro la configuración');
});

test('recordatorio relativo y vencimiento', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  const r = await b.handle('recuérdame en 20 minutos revisar el láser');
  assert.match(r, /revisar el laser|revisar el láser/i);
  assert.equal(b.dueReminders(Date.now()).length, 0);
  assert.equal(b.dueReminders(Date.now() + 21 * 60000).length, 1);
});

test('sin IA configurada, lo desconocido no inventa nada', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  assert.match(await b.handle('cuéntame un chiste de ingenieros'), /No entendí/);
});

test('sesión expirada se reporta, no se traga el error', async () => {
  const b = createBrain({ api: async () => { throw new Error('Tu sesión de NOPAL expiró. Vuelve a iniciar sesión'); } });
  assert.match(await b.handle('enciende la luz'), /sesión de NOPAL expiró/);
});

test('apodos del usuario resuelven escenas', async () => {
  const n = fakeNopal(); const b = createBrain({ api: n.api });
  const cfg = require('../frontend/voice-control.js')._cfg(); cfg.aliases = { 'LUZ ARO': ['el aro'] };
  assert.match(await b.handle('enciende el aro'), /Ya encendí la luz aro/);
});
