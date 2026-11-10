'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createBrain } = require('../frontend/voice-control.js');

const routes = {
  '/api/spoolman/config': { connected: true, low_stock_threshold_g: 250 },
  '/api/spoolman/spools': { spools: [
    { id: 1, archived: false, remaining_weight: 800, location: 'Estante A', filament: { name: 'Negro PLA 1.75mm', material: 'PLA', vendor: { name: 'Kingroom' } } },
    { id: 2, archived: false, remaining_weight: 120, filament: { name: 'Rojo PLA 1.75mm', material: 'PLA', vendor: { name: 'Kingroom' } } },
    { id: 3, archived: false, remaining_weight: 1500, filament: { name: 'Negro PETG', material: 'PETG', vendor: { name: 'X' } } } ] },
  '/api/spoolman/summary': { active_spools: 3, available_kg: 2.4, low_stock_count: 1 },
  '/api/spoolman/printers/active-spools': { links: { 7125: { spool_id: 1 } } },
  '/api/printers/status': { printers: [{ name: 'Klipper ET4', port: 7125, state: 'ready', job: {}, data: {} }] },
  '/api/laser/registry/status': { lasers: [] },
  '/api/dashboard/summary': { system: { health: 'ok', services_online: 5, services_total: 5, uptime_seconds: 3 * 86400 }, host: { cpu_percent: 12, mem_percent: 40, temp: 55 }, devices: { printer: { online: 1, total: 1 } }, alerts: { total: 0 }, jobs: { total_active: 0 } },
  '/api/notifications': { items: [{ severity: 'error', message: 'Servicio caído' }] },
  '/api/models': [{ name: 'llavero.gc', extension: '.gc' }, { name: 'soporte.gcode', extension: '.gcode' }, { name: 'logo.svg', extension: '.svg' }, { name: 'llavero_v2.gc', extension: '.gc' }],
  '/api/accessories/arduino/telemetry': { boards: [{ name: 'ESP32', online: true, telemetry: { dht_valid: true, dht_temp_c: 27.5, dht_humidity_pct: 48 } }] },
  '/api/system/stats': { host: { temp: 56 }, mcu: { temp: 40 } },
};
const mk = () => createBrain({ api: async (m, p) => { if (m !== 'GET') throw new Error('no debe escribir: ' + p); if (!(p in routes)) throw new Error('NOPAL respondió 404'); return routes[p]; } });

test('filamento: total, uno, varios, poco, puesto', async () => {
  const b = mk();
  assert.match(await b.handle('cuánto filamento tengo'), /Tienes 3 carretes con 2.4 kilos/);
  assert.match(await b.handle('cuánto queda de rojo'), /De rojo pla queda 120 gramos/);
  assert.match(await b.handle('cuánto filamento negro tengo'), /2 carretes de negro, en total 2.3 kilos/);
  assert.match(await b.handle('qué filamento se está acabando'), /rojo pla, 120 gramos/);
  assert.match(await b.handle('qué filamento tiene puesto la impresora'), /Klipper ET4 tiene negro pla, quedan 800 gramos/);
});
test('sistema, alertas, archivos, sensores', async () => {
  const b = mk();
  assert.match(await b.handle('estado del sistema'), /servicios en línea, encendido hace 3 días/);
  assert.match(await b.handle('qué alertas hay'), /error, Servicio caído/);
  assert.match(await b.handle('cuántos archivos láser tengo'), /Hay 2 archivos láser/);
  assert.match(await b.handle('temperatura del taller'), /27,5 grados con 48 por ciento/);
  assert.match(await b.handle('lee los sensores'), /Servidor a 56 grados/);
  assert.match(await b.handle('busca archivos con nombre llavero'), /Encontré 2 archivos con llavero/);
});
test('Spoolman desconectado se dice, no se inventa', async () => {
  routes['/api/spoolman/config'] = { connected: false };
  assert.equal((await mk().handle('cuánto filamento tengo')).split('.')[0], 'Spoolman no está conectado');
  routes['/api/spoolman/config'] = { connected: true, low_stock_threshold_g: 250 };
});
