// Control por voz para NOPAL — plugin solo de frontend.
// Corre en tu navegador con TU sesión de NOPAL: no guarda contraseñas ni crea usuarios aparte.
// Tres piezas: oídos (palabra «Nopal» + reconocimiento del navegador), cerebro (reglas + IA de NOPAL) y boca (voz del navegador).
(() => {
  'use strict';
  const PLUGIN_ID = 'control-por-voz';
  const VERSION = '0.1.0';
  const HAS_DOM = typeof document !== 'undefined';
  if (typeof window !== 'undefined' && window.NopalPluginRegistry?.[PLUGIN_ID]) return;

  // ====================================================================
  // Utilidades
  // ====================================================================
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const compact = (s) => norm(s).replace(/ /g, '');
  const FEMININE = /^(cotizaci|alerta|maquina|máquina|impresi|advertencia)/i;
  const plural = (n, one, many) => (n === 1 ? `${FEMININE.test(one) ? 'una' : 'un'} ${one}` : `${n} ${many}`); // «un trabajo», «una alerta»
  const YES = /^(si|sii|claro|dale|confirmo|confirma|hazlo|adelante|ok)\b/;
  const NO = /^(no|nel|nada|cancela|cancelar|olvidalo)\b/;

  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  // El reconocedor escribe mal los nombres propios («Drau» por «Draw»): se tolera 1 letra (2 en claves largas).
  function fuzzyHas(ct, key) {
    if (ct.includes(key)) return true;
    if (key.length < 4) return false;
    const maxd = key.length >= 8 ? 2 : 1;
    for (const len of [key.length - 1, key.length, key.length + 1]) for (let i = 0; i + len <= ct.length; i++) if (lev(ct.slice(i, i + len), key) <= maxd) return true;
    return false;
  }
  const ORD = [/\b(primer[oa]?|uno)\b/, /\b(segund[oa]|dos)\b/, /\b(tercer[oa]?|tres)\b/, /\b(cuart[oa]|cuatro)\b/, /\b(quint[oa]|cinco)\b/];
  function ordinalPick(list, t) {
    if (!list || !list.length) return null;
    if (/\bultim[oa]\b/.test(t)) return list[list.length - 1];
    for (let i = 0; i < ORD.length; i++) if (ORD[i].test(t) && list[i]) return list[i];
    return null;
  }
  const store = {
    get: (k) => { try { return localStorage.getItem('cpv.' + k); } catch (_) { return null; } },
    set: (k, v) => { try { localStorage.setItem('cpv.' + k, v); } catch (_) { /* modo privado */ } },
  };

  // ====================================================================
  // Ajustes (por navegador). Los apodos viven aquí: «el grande = SC MX30 Pro»
  // ====================================================================
  const DEFAULTS = { aliases: {}, defaultLight: '', defaultFan: '', pitch: 1.15, rate: 1.05, voice: '', autoStart: false, reminders: [], nudge: { lastActive: {}, lastNudge: {}, mutedUntil: 0, lastAny: 0 }, umbrales: { tallerMaxC: 35, humedadMax: 85 } };
  let cfg = { ...DEFAULTS };
  try { cfg = { ...DEFAULTS, ...JSON.parse(store.get('cfg') || '{}') }; } catch (_) { /* ajustes dañados: se usan los de fábrica */ }
  const saveCfg = () => store.set('cfg', JSON.stringify(cfg));
  const aliasesFor = (name) => { const k = Object.keys(cfg.aliases).find((x) => norm(x) === norm(name)); return k ? cfg.aliases[k] : []; };

  // ====================================================================
  // Cliente de NOPAL: mismo origen, con la cookie de la sesión actual
  // ====================================================================
  async function api(method, path, form, opts = {}) {
    const init = { method, credentials: 'same-origin', headers: {} };
    if (form) {
      if (opts.json) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(form); }
      else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(form).toString(); }
    }
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), opts.timeout || 15000); init.signal = ctrl.signal;
    let r;
    try { r = await fetch(path, init); }
    catch (e) { throw new Error(e && e.name === 'AbortError' ? 'NOPAL no responde' : 'No pude hablar con NOPAL'); }
    finally { clearTimeout(to); }
    let j = null; try { j = await r.json(); } catch (_) { /* sin cuerpo JSON */ }
    if (r.status === 401) throw new Error('Tu sesión de NOPAL expiró. Vuelve a iniciar sesión');
    if (r.status >= 400) throw new Error(j && typeof j.detail === 'string' ? j.detail : 'NOPAL respondió ' + r.status);
    return j;
  }

  // ====================================================================
  // Cerebro
  // ====================================================================
  const SECTIONS = [
    ['gcode-editor', /\b(editor)\b/, 'el editor de G-code'], ['dashboard', /\b(inicio|panel|tablero|dashboard|pantalla principal)\b/, 'inicio'],
    ['console', /\bconsolas?\b/, 'la consola'], ['settings', /\b(configuracion|ajustes|opciones)\b/, 'configuración'],
    ['plugins', /\b(plugins|complementos|extensiones)\b/, 'los plugins'], ['models', /\b(modelos|biblioteca)\b/, 'los modelos'],
    ['gcode', /\b(gcode|g code|archivos gcode)\b/, 'los archivos G-code'], ['laser', /\blaser(es)?\b/, 'láser'], ['cnc', /\bcnc\b/, 'CNC'],
    ['queue', /\b(cola|fila)\b/, 'la cola'], ['ai', /\b(inteligencia artificial|asistente)\b/, 'la inteligencia artificial'],
  ];
  const SETTINGS_TABS = [
    ['users', /\b(usuarios?|cuentas?|permisos)\b/, 'usuarios'], ['appearance', /\b(apariencia|temas|fondos?|aspecto)\b/, 'apariencia'],
    ['ai', /\b(ia|inteligencia artificial)\b/, 'inteligencia artificial'], ['devices', /\b(dispositivos|accesorios|equipos)\b/, 'dispositivos'],
    ['system', /\b(sistema|respaldos?|backup|registros|logs|actualizaciones|acerca)\b/, 'sistema'], ['general', /\b(general|generales|idioma)\b/, 'general'],
  ];
  const THEMES = [['dark', /\b(oscuro|negro|dark|noche)\b/, 'oscuro'], ['light', /\b(claro|blanco|light)\b/, 'claro'], ['green', /\bverde\b/, 'verde'], ['red', /\b(rojo|roja)\b/, 'rojo']];
  const NAV_VERB = /\b(abre|abrir|abreme|ve|vete|ir|llevame|lleva|regresa|regresate|vuelve|volver|muestra|muestrame|ensename|navega|entra|entrar|pasa|cambiate|salta|dame|quiero ver)\b/;
  const GENERIC_PLUGIN_WORDS = new Set(['taller', 'herramientas', 'biblioteca', 'texto']);
  const END_REPLY = 'Está bien, aquí estaré';
  const MORE_Q = '¿Quieres hacer otra cosa?';
  const AI_HINT = 'Responde en español, breve y hablado, sin listas ni formato. ';

  function createBrain(deps) {
    const { onAction = async () => undefined } = deps;
    const call = deps.api || api;
    let pending = null, lastDev = null, lastScene = null, lastNavAt = 0, aiConv = null, aiConvAt = 0, aiTurns = 0, aiAwaitUntil = 0;
    let ctx = { followUp: false };
    const setPending = (p) => { pending = p ? { ...p, exp: Date.now() + 45000 } : null; };

    // ---- escenas (luces, aire…) ----
    const withArticle = (name) => {
      const n = name.toLowerCase(), fem = /^(luz|luces)/.test(n);
      return { text: fem ? `la ${n}` : /^(aire|ventilador|extractor)/.test(n) ? `el ${n}` : n, fem };
    };
    async function runScene(scene, wantOn) {
      lastScene = { id: scene.id, at: Date.now() };
      const want = wantOn ? 'encendido' : 'apagado', a = withArticle(scene.name), adj = a.fem ? want.replace(/o$/, 'a') : want;
      if (norm(scene.current_state_name) === want) return `${a.text[0].toUpperCase() + a.text.slice(1)} ya estaba ${adj}`;
      await call('POST', `/api/accessories/scenes/${scene.id}/run`);
      const after = ((await call('GET', '/api/accessories/scenes')).scenes || []).find((s) => s.id === scene.id);
      if (after && norm(after.current_state_name) !== want) return `Lo intenté pero ${a.text} sigue ${norm(after.current_state_name)}`;
      return `Ya ${wantOn ? 'encendí' : 'apagué'} ${a.text}`;
    }
    // Sin nombres fijos: por nombre exacto o apodo; por palabra («luz», «aire») solo si hay una candidata clara o el usuario eligió una por defecto.
    function findScenes(scenes, t) {
      const keys = (s) => [norm(s.name), ...aliasesFor(s.name).map(norm)];
      const direct = scenes.filter((s) => keys(s).some((k) => k && t.includes(k)));
      if (direct.length) return { list: direct.sort((a, b) => norm(b.name).length - norm(a.name).length).slice(0, 1) };
      const kinds = [[/\b(ventiladores?|extractor(es)?|aire|aires)\b/, /(aire|ventilador|extractor)/, cfg.defaultFan], [/\b(luz|luces|lampara|iluminacion)\b/, /(luz|luces|lampara|ilumin)/, cfg.defaultLight]];
      for (const [ask, match, def] of kinds) {
        if (!ask.test(t)) continue;
        const cands = scenes.filter((s) => match.test(norm(s.name)));
        if (/\b(todos|todo|todas)\b/.test(t)) return { list: cands };
        const word = t.split(' ').filter((w) => w.length >= 3 && !ask.test(w) && cands.some((s) => norm(s.name).includes(w)));
        const byWord = word.length ? cands.filter((s) => word.every((w) => norm(s.name).includes(w))) : [];
        if (byWord.length === 1) return { list: byWord };
        const d = scenes.find((s) => def && norm(s.name) === norm(def));
        if (d) return { list: [d] };
        if (cands.length === 1) return { list: cands };
        if (cands.length > 1) return { ask: cands };
      }
      return { list: [] };
    }

    // ---- máquinas ----
    async function devices(onlyOnlineLasers = true) {
      const out = [];
      const pr = await call('GET', '/api/printers/status').catch(() => ({}));
      for (const p of pr.printers || []) out.push({ type: 'printer', name: p.name, port: p.port, raw: p });
      const lr = await call('GET', '/api/laser/registry/status').catch(() => ({}));
      for (const m of lr.lasers || []) if (!onlyOnlineLasers || m.online) out.push({ type: 'laser', name: m.name, host: m.host, raw: m });
      return out;
    }
    const extraKeys = (name) => { const j = norm(name).split(' ').filter((w) => w !== 'pro' && !/^\d+$/.test(w)).join(''); return [j, j.replace(/\d+$/, '')].filter((k) => k.length >= 4); };
    const devKeys = (d) => {
      const toks = norm(d.name).split(' ').filter((w) => w !== 'pro' && !/^\d+$/.test(w) && (w.length >= 3 || /\d/.test(w)));
      return [...toks, norm(d.name), ...extraKeys(d.name), ...aliasesFor(d.name)].map(compact).filter((k) => k.length >= 2);
    };
    function pickDevice(devs, t, types) {
      const pool = devs.filter((d) => !types || types.includes(d.type)), ct = compact(t);
      const hit = pool.filter((d) => devKeys(d).some((k) => fuzzyHas(ct, k)));
      if (hit.length === 1) return hit[0];
      if (!hit.length && /\bimpresora\b/.test(t)) { const ps = pool.filter((d) => d.type === 'printer'); if (ps.length === 1) return ps[0]; }
      return null;
    }
    const askWhich = (devs) => `¿En cuál? ${devs.map((d) => d.name).join(', o ')}`;
    const jobState = (p) => String(p && p.job && p.job.state || '').toLowerCase();

    async function homeDialog(t, st) {
      st = st || { kind: 'home' };
      const devs = await devices();
      if (!devs.length) return 'No hay máquinas en línea';
      if (!st.dev) {
        st.dev = devs.length === 1 ? devs[0] : (pickDevice(devs, t) || ordinalPick(st.asked, t) || (/\b(esa|ese|la misma|el mismo)\b/.test(t) ? lastDev : null));
        if (!st.dev) { st.asked = devs; setPending(st); return askWhich(devs); }
      }
      const d = st.dev; pending = null; lastDev = d;
      if (d.type === 'printer') {
        const s = ((await call('GET', '/api/printers/status')).printers || []).find((p) => p.port === d.port);
        if (['printing', 'paused'].includes(jobState(s))) return `No hago home: ${d.name} está imprimiendo`;
        await call('POST', '/api/console/command', { port: String(d.port), command: 'G28' });
        return `Haciendo home en ${d.name}`;
      }
      const status = await call('GET', '/api/laser/status?host=' + encodeURIComponent(d.host));
      if (String(status.state).toLowerCase() !== 'idle') return `No hago home: ${d.name} está en estado ${status.state}`;
      await call('POST', '/api/laser/home', { host: d.host });
      return `Haciendo home en ${d.name}`;
    }
    async function printerAction(kind, t, st) {
      const devs = (await devices()).filter((d) => d.type === 'printer');
      if (!devs.length) return 'No hay impresoras registradas';
      const d = (st && st.dev) || (devs.length === 1 ? devs[0] : (pickDevice(devs, t) || ordinalPick(devs, t)));
      if (!d) { setPending({ kind: 'printer-' + kind }); return askWhich(devs); }
      if (kind === 'cancel' && !(st && st.confirm)) { setPending({ kind: 'printer-cancel', dev: d, confirm: true }); return `¿Cancelo la impresión en ${d.name}? Se pierde el avance. Di sí o no`; }
      pending = null;
      const cur = ((await call('GET', '/api/printers/status')).printers || []).find((p) => p.port === d.port), js = jobState(cur);
      if (kind === 'pause' && js !== 'printing') return `${d.name} no está imprimiendo`;
      if (kind === 'resume' && js !== 'paused') return `${d.name} no está en pausa`;
      if (kind === 'cancel' && !['printing', 'paused'].includes(js)) return `${d.name} no tiene una impresión en curso`;
      await call('POST', `/api/printers/${d.port}/${kind}`);
      return { pause: 'Impresión en pausa', resume: 'Reanudando la impresión', cancel: 'Impresión cancelada' }[kind] + ` en ${d.name}`;
    }
    async function statusReport() {
      const parts = [];
      const pr = await call('GET', '/api/printers/status').catch(() => ({}));
      for (const p of pr.printers || []) {
        const j = p.job || {}, dd = p.data || {};
        const ext = dd.extruder && dd.extruder.temperature, bed = dd.heater_bed && dd.heater_bed.temperature;
        const temps = [ext != null ? `extrusor ${Math.round(ext)} grados` : '', bed != null ? `cama ${Math.round(bed)}` : ''].filter(Boolean).join(', ');
        parts.push(jobState(p) === 'printing' ? `${p.name} imprimiendo, ${Math.round(j.progress)} por ciento${temps ? ', ' + temps : ''}` : `${p.name} ${p.state === 'ready' ? 'lista' : p.state}${temps ? ', ' + temps : ''}`);
      }
      const lr = (await call('GET', '/api/laser/registry/status').catch(() => ({}))).lasers || [];
      for (const m of lr.filter((x) => x.online)) {
        const s = await call('GET', '/api/laser/status?host=' + encodeURIComponent(m.host)).catch(() => null);
        if (s) parts.push(`${m.name} ${String(s.state).toLowerCase() === 'idle' ? 'en reposo' : s.state}`);
      }
      return parts.join('. ') || 'No hay máquinas en línea';
    }
    async function activityReport() {
      const out = [];
      for (const p of (await call('GET', '/api/printers/status').catch(() => ({}))).printers || []) {
        const js = jobState(p);
        if (js === 'printing' || js === 'paused') out.push(`${p.name} ${js === 'paused' ? 'en pausa' : 'imprimiendo'}${p.job.filename ? ' ' + p.job.filename.replace(/\.(gcode|gc)$/i, '') : ''}, ${Math.round(p.job.progress)} por ciento`);
      }
      for (const m of ((await call('GET', '/api/laser/registry/status').catch(() => ({}))).lasers || []).filter((x) => x.online)) {
        const js = await call('GET', '/api/laser/job/status?host=' + encodeURIComponent(m.host)).catch(() => null);
        if (js && /running|run|active|paused|streaming/i.test(String(js.state))) out.push(`${m.name} trabajando${js.filename ? ' ' + js.filename.replace(/\.(gcode|gc|nc)$/i, '') : ''}${js.total ? ', ' + Math.round(100 * js.current / js.total) + ' por ciento' : ''}`);
      }
      return out.length ? `${plural(out.length, 'máquina trabajando', 'máquinas trabajando')}: ${out.join('. ')}` : 'Ninguna máquina está trabajando en este momento';
    }

    // ---- navegar la pantalla de NOPAL ----
    async function navDo(action, reply) {
      if (action.type === 'goto' || action.type === 'settings') lastNavAt = Date.now();
      const err = await onAction(action);
      return err || reply;
    }
    async function navCommand(t) {
      const implied = (ctx.followUp && t.split(' ').length <= 3) || (/^(no|nel)\b/.test(t) && Date.now() - lastNavAt < 90000);
      const verb = NAV_VERB.test(t) || implied;
      if (/\b(tema|modo)\b/.test(t) && (/\b(cambia|cambiar|pon|ponme|ponle|activa|usa|quiero|siguiente|otro)\b/.test(t) || (/\bmodo\b/.test(t) && THEMES.some(([, re]) => re.test(t))))) {
        const th = THEMES.find(([, re]) => re.test(t));
        if (th) return navDo({ type: 'theme', theme: th[0] }, `Listo, tema ${th[2]}`);
        if (/\btema\b/.test(t)) return navDo({ type: 'theme', theme: 'next' }, 'Listo, cambié el tema');
      }
      if (/\b(cierra|cerrar)\b/.test(t) && (/\b(ventana|ficha|ventanita|modal|esto|eso|tarjeta)\b/.test(t) || t.split(' ').length <= 2)) return navDo({ type: 'close' }, 'Listo, cerré la ventana');
      if ((/\b(desliza\w*|desplaza\w*|scroll)\b/.test(t) && /\b(abajo|arriba|pantalla|pagina)\b/.test(t))
        || (/\b(baja|sube)\b/.test(t) && /\b(pantalla|pagina|hacia abajo|hacia arriba|mas abajo|mas arriba)\b/.test(t) && !/\d/.test(t) && !/\b(cabezal|eje|z)\b/.test(t))) return navDo({ type: 'scroll', dir: /\b(sube|arriba)\b/.test(t) ? -1 : 1 }, 'Listo');
      if (/\b(que|cuales|dime|lee|leeme)\b.*\bplugins\b/.test(t)) {
        const pl = ((await call('GET', '/api/plugins')).plugins || []).filter((p) => p.installed && p.enabled);
        return pl.length ? `Tienes ${plural(pl.length, 'plugin activo', 'plugins activos')}: ${pl.map((p) => p.name).join(', ')}` : 'No tienes plugins activos';
      }
      if (!verb && !/\bficha\b/.test(t)) return null;
      if (/\b(regresate|regresa|atras|vuelve|volver)\b/.test(t) && !/\b(home|impresora|laser|cnc|cabezal|eje|archivo)\b/.test(t) && !SECTIONS.some(([, re]) => re.test(t))) return navDo({ type: 'back' }, 'Listo, regresé');
      if (/\b(ficha|tarjeta|detalles?|informacion|impresora|klipper|clipper)\b/.test(t) && !/\b(plugins?|configuracion|ajustes|cotizador)\b/.test(t)) {
        const printers = (await devices()).filter((d) => d.type === 'printer');
        if (printers.length) {
          let pr = printers.length === 1 ? printers[0] : pickDevice(printers, t, ['printer']);
          if (!pr) pr = ordinalPick(printers, t);
          if (!pr) { setPending({ kind: 'nav' }); return `¿La ficha de cuál impresora? ${printers.map((d, i) => `${i + 1}, ${d.name}`).join('; ')}`; }
          return navDo({ type: 'printer', port: pr.port, name: pr.name, index: printers.indexOf(pr) }, `Listo, abriendo la ficha de ${pr.name}`);
        }
      }
      // plugins por nombre (cotizador, cámaras…): sus secciones reales
      const plugins = ((await call('GET', '/api/plugins').catch(() => ({}))).plugins || []).filter((p) => p.installed && p.enabled && p.frontend && p.frontend.section);
      const ct = compact(t);
      const pl = plugins.find((p) => [p.id, norm(p.name), ...norm(p.name).split(' ').filter((w) => w.length >= 5 && !GENERIC_PLUGIN_WORDS.has(w))].some((k) => ct.includes(compact(k))) && !/^(dashboard|settings)$/.test(p.frontend.section) && p.frontend.section !== PLUGIN_ID);
      if (pl) return navDo({ type: 'goto', name: pl.frontend.section, label: pl.name }, `Listo, abriendo ${pl.name}`);
      const dv = pickDevice(await devices(false), t, ['laser']);
      if (dv) return navDo({ type: 'goto', name: dv.raw && dv.raw.kind === 'cnc' ? 'cnc' : 'laser', label: dv.name }, `Listo, te llevo a ${dv.name}`);
      const sec = SECTIONS.find(([, re]) => re.test(t)), tab = SETTINGS_TABS.find(([, re]) => re.test(t));
      if ((sec && sec[0] === 'settings') || (!sec && tab)) return navDo({ type: 'settings', tab: tab ? tab[0] : null, label: tab ? tab[2] : 'configuración' }, `Listo, abriendo configuración${tab ? ', ' + tab[2] : ''}`);
      if (sec) return navDo({ type: 'goto', name: sec[0], label: sec[2] }, `Listo, te llevo a ${sec[2]}`);
      if (/^(abre|abrir|navega|ve a|vete a|llevame a|entra a)\b/.test(t)) return 'No encontré eso en NOPAL. Pídeme una sección, un plugin, configuración, un láser o la ficha de una impresora';
      return null;
    }

    // ---- recordatorios (solo mientras NOPAL esté abierto en este navegador) ----
    function reminderCommand(t) {
      let ms = null, rest = t;
      const rel = /\ben\s+(\d+|una|un|media)\s*(hora|horas|minuto|minutos|min)\b/.exec(t);
      const abs = /\ba las?\s+(\d{1,2})(?:[: ](\d{2}))?\s*(de la manana|de la tarde|de la noche|am|pm)?/.exec(t);
      if (rel) {
        const n = rel[1] === 'media' ? 0.5 : (rel[1] === 'una' || rel[1] === 'un' ? 1 : Number(rel[1]));
        ms = Date.now() + n * (/hora/.test(rel[2]) ? 3600000 : 60000); rest = t.replace(rel[0], ' ');
      } else if (abs) {
        let h = Number(abs[1]); const m = Number(abs[2] || 0), part = abs[3] || '';
        if (/tarde|noche|pm/.test(part) && h < 12) h += 12;
        if (h > 23 || m > 59) return 'No entendí la hora del recordatorio';
        const d = new Date(); d.setHours(h, m, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
        ms = d.getTime(); rest = t.replace(abs[0], ' ');
      }
      if (ms == null) return 'Dime cuándo: por ejemplo «recuérdame en 20 minutos revisar el láser» o «a las 5 de la tarde»';
      const FILL = new Set(['recuerdame', 'recordarme', 'recordatorio', 'acuerdame', 'avisame', 'me', 'que', 'de', 'el', 'la', 'un', 'una', 'por', 'favor', 'nopal', 'para', 'a', 'en', 'hoy']);
      const words = rest.split(' ').filter(Boolean);
      while (words.length && FILL.has(words[0])) words.shift();
      while (words.length && FILL.has(words[words.length - 1])) words.pop();
      const what = words.join(' ') || 'lo que me pediste';
      cfg.reminders.push({ at: ms, what }); saveCfg();
      return `Listo, te lo recuerdo a las ${new Date(ms).toLocaleTimeString('es-MX', { hour: 'numeric', minute: '2-digit' })}: ${what}`;
    }
    function dueReminders(now = Date.now()) {
      const due = cfg.reminders.filter((r) => r.at <= now);
      if (due.length) { cfg.reminders = cfg.reminders.filter((r) => r.at > now); saveCfg(); }
      return due.filter((r) => now - r.at < 3600000); // si NOPAL estuvo cerrado más de una hora, ya no tiene sentido avisarlo
    }

    // ---- IA de NOPAL (respaldo) ----
    const forVoice = (text) => {
      let s = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\s+/g, ' ').trim();
      if (s.length > 330) { const cut = s.slice(0, 330), k = cut.lastIndexOf('. '); s = k > 100 ? cut.slice(0, k + 1) : cut + '…'; }
      return s;
    };
    async function askAI(text) {
      const st = await call('GET', '/api/ai/status').catch(() => null);
      if (!st || !st.enabled || !st.configured) return null;
      if (Date.now() - aiConvAt > 8 * 60000 || aiTurns >= 4) { aiConv = null; aiTurns = 0; }
      const q = (aiConv ? '' : AI_HINT) + text;
      let r;
      for (let intento = 1; ; intento++) {
        try { r = await call('POST', '/api/ai/ask', { question: q, conversation_id: aiConv }, { json: true, timeout: 75000 }); break; }
        catch (e) {
          if (intento >= 2 || !/respondió 5\d\d|responde/i.test(e.message)) throw e;
          await new Promise((ok) => setTimeout(ok, 1500));
        }
      }
      aiConv = r.conversation_id || aiConv; aiConvAt = Date.now(); aiTurns++;
      if (r.pending_action) {
        const pa = r.pending_action; setPending({ kind: 'ai-action', id: pa.id });
        const args = Object.entries(pa.arguments || {}).map(([k, v]) => `${k} ${v}`).join(', ');
        return `${forVoice(r.answer)} Quiero hacer ${pa.action}${args ? ' con ' + args : ''}. ¿Confirmas? Di sí o no`;
      }
      const out = forVoice(r.answer) || null;
      aiAwaitUntil = out && /[?¿]/.test(out) ? Date.now() + 120000 : 0;
      return out;
    }

    // ---- reportes de solo lectura: filamento, sistema, alertas, archivos, sensores ----
    const dec = (n, d = 1) => Number(n).toFixed(d).replace(/\.0+$/, '').replace('.', ','); // «21,7» se lee mejor en español
    const grams = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2).replace(/\.?0+$/, '')} kilos` : `${Math.round(g)} gramos`);
    const spoolLabel = (sp) => String(sp.filament && sp.filament.name || 'sin nombre').replace(/\s*1\.75m.*$/i, '').trim().toLowerCase();
    const FIL_STOP = new Set(['cuanto', 'cuanta', 'cuantos', 'cuantas', 'filamento', 'filamentos', 'carrete', 'carretes', 'rollo', 'rollos', 'queda', 'quedan', 'me', 'tengo', 'tenemos', 'hay', 'de', 'del', 'el', 'la', 'los', 'las', 'que', 'color', 'un', 'una', 'en', 'total', 'tiene', 'le', 'y', 'es', 'esta', 'estan', 'por', 'favor', 'dime', 'dame', 'a', 'cual', 'cuales']);
    async function filamentCommand(t) {
      const asks = /\b(filamento|filamentos|carrete|carretes|rollo|rollos|spoolman)\b/.test(t) || (/\bcuant\w*\b/.test(t) && /\b(queda|quedan)\b/.test(t));
      if (!asks || /\b(carga|cargar|descarga|descargar|cambia|cambiar|extruye|extruir|retrae)\b/.test(t)) return null;
      const sc = await call('GET', '/api/spoolman/config').catch(() => null);
      if (!sc || !sc.connected) return 'Spoolman no está conectado';
      const spools = ((await call('GET', '/api/spoolman/spools')).spools || []).filter((x) => !x.archived);
      if (/\b(puesto|cargado|montado|usando|activo|tiene la impresora|tiene puesto)\b/.test(t)) {
        const links = (await call('GET', '/api/spoolman/printers/active-spools')).links || {};
        const names = Object.fromEntries((await devices()).filter((d) => d.type === 'printer').map((d) => [String(d.port), d.name]));
        const out = [];
        for (const [port, l] of Object.entries(links)) { const sp = spools.find((x) => x.id === l.spool_id); if (sp) out.push(`${names[port] || 'La impresora ' + port} tiene ${spoolLabel(sp)}, quedan ${grams(sp.remaining_weight)}`); }
        return out.length ? out.join('. ') : 'No hay ningún carrete asignado a una impresora';
      }
      if (/\b(acabando|acaba|acabe|poco|bajo|agotando|agota|escaso)\b/.test(t)) {
        const th = sc.low_stock_threshold_g || 250;
        const low = spools.filter((x) => x.remaining_weight < th).sort((a, b) => a.remaining_weight - b.remaining_weight);
        return low.length ? 'Se están acabando: ' + low.slice(0, 4).map((x) => `${spoolLabel(x)}, ${grams(x.remaining_weight)}`).join('; ') : `Ningún carrete está por debajo de ${th} gramos`;
      }
      const words = t.split(' ').filter((w) => w.length >= 2 && !FIL_STOP.has(w));
      if (!words.length) { const sm = await call('GET', '/api/spoolman/summary'); return `Tienes ${sm.active_spools} carretes con ${sm.available_kg} kilos disponibles en total` + (sm.low_stock_count ? `. ${sm.low_stock_count} está por acabarse` : ''); }
      const hit = spools.filter((x) => { const hay = norm([x.filament && x.filament.name, x.filament && x.filament.material, x.filament && x.filament.vendor && x.filament.vendor.name, x.location].join(' ')); return words.every((w) => hay.includes(w)); });
      if (!hit.length) return `No encontré carretes de ${words.join(' ')}`;
      const total = hit.reduce((a, x) => a + x.remaining_weight, 0);
      if (hit.length === 1) return `De ${spoolLabel(hit[0])} queda ${grams(hit[0].remaining_weight)}${hit[0].location ? ', en ' + String(hit[0].location).toLowerCase() : ''}`;
      return `Tienes ${hit.length} carretes de ${words.join(' ')}, en total ${grams(total)}: ` + hit.slice(0, 4).map((x) => grams(x.remaining_weight)).join(', ');
    }
    async function systemReport() {
      const d = await call('GET', '/api/dashboard/summary');
      const sys = d.system || {}, h = d.host || {}, dv = d.devices || {}, al = d.alerts || {};
      const health = { ok: 'bien', healthy: 'bien', warning: 'con advertencias', error: 'con errores' }[sys.health] || String(sys.health);
      const dev = (k, n) => dv[k] ? `${dv[k].online} de ${dv[k].total} ${n}` : null;
      const up = Math.floor((sys.uptime_seconds || 0) / 86400);
      return [
        `El sistema está ${health}, ${sys.services_online} de ${sys.services_total} servicios en línea${up ? `, encendido hace ${plural(up, 'día', 'días')}` : ''}`,
        `Servidor: procesador al ${Math.round(h.cpu_percent)} por ciento, memoria al ${Math.round(h.mem_percent)}, a ${Math.round(h.temp)} grados`,
        'En línea: ' + [dev('printer', 'impresoras'), dev('laser', 'láseres'), dev('cnc', 'CNC'), dev('camera', 'cámaras')].filter(Boolean).join(', '),
        al.total ? `Hay ${plural(al.error, 'error', 'errores')} y ${plural(al.warning, 'advertencia', 'advertencias')}. Pregúntame qué alertas hay` : 'Sin alertas',
        (d.jobs && d.jobs.total_active) ? `${plural(d.jobs.total_active, 'trabajo activo', 'trabajos activos')}` : 'Sin trabajos activos',
      ].join('. ');
    }
    async function alertsList() {
      const items = (await call('GET', '/api/notifications')).items || [];
      if (!items.length) return 'No hay alertas';
      return `Hay ${plural(items.length, 'alerta', 'alertas')}: ` + items.slice(0, 5).map((i) => `${i.severity === 'error' ? 'error' : 'aviso'}, ${i.message}`).join('. ');
    }
    async function filesReport(t) {
      const models = await call('GET', '/api/models');
      const ext = (m) => String(m.extension || '').toLowerCase();
      const laser = models.filter((m) => ['.gc', '.nc'].includes(ext(m))).length, gcode3d = models.filter((m) => ext(m) === '.gcode').length;
      const mesh = models.filter((m) => ['.stl', '.obj', '.3mf'].includes(ext(m))).length, svg = models.filter((m) => ext(m) === '.svg').length;
      const wantLaser = /\b(laser|lasers)\b/.test(t), want3d = /\b(3d|impresion|impresora|modelos)\b/.test(t);
      if (wantLaser && !want3d) return `Hay ${laser} archivos láser`;
      if (want3d && !wantLaser) return `Hay ${gcode3d + mesh} archivos 3D: ${gcode3d} listos para imprimir y ${plural(mesh, 'modelo', 'modelos')}`;
      return `Hay ${laser} archivos láser, ${gcode3d + mesh} archivos 3D y ${plural(svg, 'vector SVG', 'vectores SVG')}. En total ${models.length}`;
    }
    const FILE_STOP = new Set(['encuadra', 'encuadre', 'encuadrar', 'enmarca', 'en', 'el', 'la', 'los', 'las', 'archivo', 'de', 'del', 'por', 'favor', 'laser', 'maquina', 'trabajo', 'proyecto', 'pro', 'con']);
    async function fileSearch(t) {
      const term = t.replace(/^.*\b(?:con el nombre de|con el nombre|nombre de|nombre|llamados|llamado|busca|buscar|buscame|encuentra)\b/, ' ').split(' ').filter((w) => w.length >= 2 && !FILE_STOP.has(w) && !/^(que|tenemos|tienes|tengo|hay|los|las|un|una|archivos?|con|por|sobre)$/.test(w));
      if (!term.length) return null;
      const hit = (await call('GET', '/api/models')).filter((m) => term.every((w) => norm(m.name).includes(w)));
      if (!hit.length) return `No encontré archivos con ${term.join(' ')}`;
      return `Encontré ${plural(hit.length, 'archivo', 'archivos')} con ${term.join(' ')}: ` + hit.slice(0, 3).map((m) => m.name.replace(/\.(gcode|gc|nc|stl|svg)$/i, '')).join(', ') + (hit.length > 3 ? ' y más' : '');
    }
    async function sensorReport(t) {
      const tel = ((await call('GET', '/api/accessories/arduino/telemetry')).boards || []);
      const dht = tel.filter((b) => b.online && b.telemetry && b.telemetry.dht_valid);
      const out = [];
      if (dht.length) out.push(`El taller está a ${dec(dht[0].telemetry.dht_temp_c)} grados con ${Math.round(dht[0].telemetry.dht_humidity_pct)} por ciento de humedad`);
      else out.push('No tengo lectura del sensor del taller, la placa no responde o no tiene sensor');
      if (/\b(sensores|todos los sensores|lee los sensores|lectura)\b/.test(t)) {
        const st = await call('GET', '/api/system/stats').catch(() => null);
        if (st && st.host) out.push(`Servidor a ${Math.round(st.host.temp)} grados${st.mcu ? `, controlador de la impresora a ${Math.round(st.mcu.temp)}` : ''}`);
        const pr = ((await call('GET', '/api/printers/status').catch(() => ({}))).printers || [])[0];
        if (pr && pr.data && pr.data.extruder) out.push(`${pr.name}: extrusor ${Math.round(pr.data.extruder.temperature)} grados, cama ${Math.round(pr.data.heater_bed.temperature)}`);
        const down = tel.filter((b) => !b.online).map((b) => b.name);
        if (down.length) out.push(`Placas sin respuesta: ${down.join(', ')}`);
      }
      return out.join('. ');
    }

    // ---- calentar, eje Z, encuadre (siempre con topes y confirmación) ----
    const MAX_EXTRUDER = 280, MAX_BED = 110; // topes de seguridad
    const setHeater = (port, heater, target) => call('POST', '/api/system/temperature-target', { port: String(port), heater, target: String(target) });
    async function pickPrinter(t) { const ps = (await devices()).filter((d) => d.type === 'printer'); return ps.length === 1 ? ps[0] : pickDevice(ps, t, ['printer']); }
    async function heatCommand(t) {
      const cool = /\b(enfria|enfriar|enfriala)\b/.test(t), mat = /\b(pla|petg|abs|tpu)\b/.exec(t), n = /\b(\d{2,3})\b/.exec(t);
      const verb = /\b(precalienta|precalentar|precalientala|calienta|calentar|calientala|pon|ponle|ajusta|ajustar)\b/.test(t);
      const heaterNoun = /\b(cama|base|bed|extrusor|boquilla|hotend)\b/.test(t) && /\ba\s+\d{2,3}\b/.test(t);
      if (!cool && !(verb && (mat || n)) && !heaterNoun) return null;
      const pr = await pickPrinter(t);
      if (!pr) return 'Dime en cuál impresora: usa su nombre';
      if (cool) { await setHeater(pr.port, 'extruder', 0); await setHeater(pr.port, 'heater_bed', 0); return `Ya apagué los calentadores de ${pr.name}`; }
      if (mat) {
        const pre = ((await call('GET', '/api/system/temperature-presets')).materials || []).find((m) => norm(m.id) === mat[1]);
        if (!pre) return `No tengo el preset ${mat[1]}`;
        await setHeater(pr.port, 'extruder', pre.extruder); await setHeater(pr.port, 'heater_bed', pre.heater_bed);
        return `Ya precalenté ${pr.name} para ${pre.name}: extrusor ${pre.extruder} y cama ${pre.heater_bed}`;
      }
      const sets = {};
      for (const c of t.split(' y ')) { const m = /\b(\d{2,3})\b/.exec(c); if (m) sets[/\b(cama|base|bed)\b/.test(c) ? 'heater_bed' : 'extruder'] = Number(m[1]); }
      const keys = Object.keys(sets);
      if (!keys.length) return null;
      const nm = (h) => (h === 'heater_bed' ? 'la cama' : 'el extrusor');
      for (const h of keys) { const max = h === 'heater_bed' ? MAX_BED : MAX_EXTRUDER; if (sets[h] > max) return `No pongo ${sets[h]} grados: mi tope para ${nm(h)} es ${max}`; }
      for (const h of keys) await setHeater(pr.port, h, sets[h]);
      return `Ya puse ${keys.map((h) => `${nm(h)} a ${sets[h]} grados`).join(' y ')} en ${pr.name}`;
    }
    const Z_WORDS = '(z|vz|ve z|zeta|ceta|seta|set|cabezal|cabeza|eje|eje z|eje zeta)'; // el reconocedor escucha «Z» como «vz», «zeta», «set»…
    const Z_VERB = /\b(sube|subir|baja|bajar|mueve|mover|lleva|llevar|pon|ve|levanta|levantar)\b/;
    const zIntent = (t) => (Z_VERB.test(t) && new RegExp('\\b' + Z_WORDS + '\\b').test(t) && /\b\d{1,3}\b/.test(t)) || new RegExp('^' + Z_WORDS + ' (a )?\\d{1,3}( mm| milimetros)?$').test(t);
    async function zMoveStart(t) {
      const n = /\b(\d{1,3})\b/.exec(t);
      const relative = /\b(sube|subir|baja|bajar|levanta|levantar)\b/.test(t) && !/\b(a|hasta)\s+\d/.test(t) && /\b(mm|milimetros?)\b/.test(t);
      const dir = /\b(baja|bajar)\b/.test(t) ? -1 : 1;
      if (!n) return 'Dime a cuántos milímetros quieres el eje Z';
      const pr = await pickPrinter(t);
      if (!pr) return 'Dime en cuál impresora: usa su nombre';
      const cur = ((await call('GET', '/api/printers/status')).printers || []).find((x) => x.port === pr.port);
      if (['printing', 'paused'].includes(jobState(cur))) return `No muevo Z: ${pr.name} está imprimiendo`;
      const tool = await call('GET', '/api/system/toolhead?port=' + pr.port);
      if (!String(tool.homed_axes || '').includes('z')) return `Primero haz home en ${pr.name}, el eje Z no está referenciado`;
      const zNow = tool.position && tool.position.z, val = Number(n[1]);
      setPending({ kind: 'zmove', dev: pr, z: relative ? dir * val : val, relative, confirm: true });
      if (relative) return `¿${dir > 0 ? 'Subo' : 'Bajo'} el cabezal ${val} milímetros en ${pr.name}${zNow != null ? `, de ${Math.round(zNow)} a ${Math.round(zNow + dir * val)}` : ''}? Di sí o no`;
      return `¿Llevo el eje Z de ${pr.name} a ${val} milímetros? Di sí o no`;
    }
    async function zMoveDo(st) {
      pending = null;
      const port = String(st.dev.port), cmd = (command) => call('POST', '/api/console/command', { port, command });
      if (st.relative) {
        await cmd('G91');
        try { await cmd(`G1 Z${st.z} F600`); } finally { await cmd('G90'); } // siempre volver a coordenadas absolutas
        return `Moviendo el cabezal ${Math.abs(st.z)} milímetros ${st.z > 0 ? 'hacia arriba' : 'hacia abajo'}`;
      }
      await cmd('G90'); await cmd(`G1 Z${st.z} F600`);
      return `Moviendo Z a ${st.z} milímetros en ${st.dev.name}`;
    }
    async function frameDialog(t, st) {
      st = st || { kind: 'frame' };
      const machines = ((await call('GET', '/api/laser/registry/status')).lasers || []).filter((m) => m.kind === 'laser' && m.online);
      if (!machines.length) { setPending(null); return 'No hay ningún láser en línea'; }
      let justPicked = false;
      if (!st.machine) {
        st.machine = machines.length === 1 ? machines[0] : (pickDevice(machines.map((m) => ({ ...m, type: 'laser' })), t) || ordinalPick(st.askedM, t));
        if (!st.machine) { st.askedM = machines; setPending(st); return `¿En cuál láser? ${machines.map((m) => m.name).join(' o ')}`; }
        justPicked = machines.length > 1;
      }
      const mk = new Set(devKeys(st.machine));
      const words = justPicked ? [] : t.split(' ').filter((w) => w.length >= 2 && !FILE_STOP.has(w) && !/^(si|no|nopal)$/.test(w) && !mk.has(compact(w)));
      if (!st.file) {
        const models = ((await call('GET', '/api/models')) || []).filter((m) => String(m.id).startsWith('gcode/'));
        let cands = [];
        if (words.length) cands = models.filter((m) => words.every((w) => norm(m.name).includes(w)));
        else {
          const hist = (await call('GET', '/api/laser/history?host=' + encodeURIComponent(st.machine.host))).jobs || [];
          const last = hist.find((j) => j.host === st.machine.host && models.some((m) => m.name === j.filename));
          if (last) cands = models.filter((m) => m.name === last.filename);
        }
        if (cands.length === 1) st.file = cands[0];
        else if (cands.length > 1 && cands.length <= 3) { setPending(st); return `¿Cuál archivo? ${cands.map((m) => m.name.replace(/\.(gc|gcode|nc)$/i, '')).join(', o ')}`; }
        else { setPending(st); return cands.length ? 'Hay muchos archivos con ese nombre, dime más del nombre' : 'Dime parte del nombre del archivo a encuadrar'; }
      }
      st.confirm = true; setPending(st);
      return `¿Encuadro ${st.file.name.replace(/\.(gc|gcode|nc)$/i, '')} en ${st.machine.name}? Di sí o no`;
    }
    async function doFrame(st) {
      pending = null;
      const status = await call('GET', '/api/laser/status?host=' + encodeURIComponent(st.machine.host));
      if (String(status.state).toLowerCase() !== 'idle') return `No encuadro: ${st.machine.name} está en estado ${status.state}`;
      const r = await call('POST', '/api/laser/job/frame', { path: st.file.id.replace(/^gcode\//, ''), host: st.machine.host });
      return r && r.warning ? `Encuadrando. Aviso: ${r.warning}` : `Encuadrando en ${st.machine.name}`;
    }

    // ---- vigilancia: avisos que el asistente dice solo (impresión terminada, temperatura alcanzada) ----
    const watchers = [], lastJob = {};
    async function watchCommand(t) {
      if (!(/\bavis\w*\b/.test(t) && /\b(llegue|llegar|alcance|alcanzar|este|esta|termine|terminar|acabe)\b/.test(t))) return null;
      const pr = await pickPrinter(t);
      if (!pr) return 'Dime en cuál impresora: usa su nombre';
      const st = ((await call('GET', '/api/printers/status')).printers || []).find((x) => x.port === pr.port);
      const bed = /\b(cama|base|bed)\b/.test(t), heater = bed ? 'heater_bed' : 'extruder', n = /\b(\d{2,3})\b/.exec(t);
      if (/\b(impresion|imprimir|trabajo)\b/.test(t) && !n) return 'Listo, te aviso cuando termine la impresión. Ya lo hago siempre sin que me lo pidas';
      const cur = (st && st.data && st.data[heater]) || {}, target = n ? Number(n[1]) : cur.target;
      if (!target) return 'No tengo una temperatura objetivo. Dime a cuántos grados te aviso';
      watchers.push({ port: pr.port, name: pr.name, heater, target, up: target >= cur.temperature, exp: Date.now() + 40 * 60 * 1000 });
      return `Listo, te aviso cuando ${bed ? 'la cama' : 'el extrusor'} de ${pr.name} llegue a ${target} grados`;
    }
    async function pollEvents() { // devuelve los avisos nuevos; la interfaz los dice en voz alta
      const out = [];
      let ps; try { ps = (await call('GET', '/api/printers/status')).printers || []; } catch (_) { return out; }
      for (const p of ps) {
        const js = jobState(p), prev = lastJob[p.port];
        if (prev === 'printing' && js === 'complete') out.push(`Terminó la impresión en ${p.name}${p.job && p.job.filename ? ': ' + p.job.filename.replace(/\.(gcode|gc)$/i, '') : ''}`);
        else if (prev === 'printing' && (js === 'error' || js === 'cancelled')) out.push(`La impresión en ${p.name} ${js === 'error' ? 'falló' : 'se canceló'}`);
        lastJob[p.port] = js;
      }
      for (let i = watchers.length - 1; i >= 0; i--) {
        const w = watchers[i], p = ps.find((x) => x.port === w.port);
        if (Date.now() > w.exp) { watchers.splice(i, 1); continue; }
        const cur = p && p.data && p.data[w.heater]; if (!cur) continue;
        if (w.up ? cur.temperature >= w.target - 1 : cur.temperature <= w.target + 1) { out.push(`${w.heater === 'heater_bed' ? 'La cama' : 'El extrusor'} de ${w.name} ya llegó a ${Math.round(cur.temperature)} grados`); watchers.splice(i, 1); }
      }
      await checkSafety(out).catch(() => {}); await checkIdle(out).catch(() => {});
      return out;
    }

    // ---- tiras LED: colores y alertas ----
    const COLORS = { rojo: [255, 0, 0], roja: [255, 0, 0], amarillo: [255, 200, 0], amarilla: [255, 200, 0], verde: [0, 255, 0], azul: [0, 0, 255], blanco: [255, 255, 255], blanca: [255, 255, 255], naranja: [255, 120, 0], morado: [160, 0, 255], morada: [160, 0, 255], violeta: [160, 0, 255], rosa: [255, 0, 160], cian: [0, 255, 255], celeste: [0, 180, 255] };
    const colorWord = (t) => { const m = /\b(rojo|roja|amarillo|amarilla|verde|azul|blanco|blanca|naranja|morado|morada|violeta|rosa|cian|celeste)\b/.exec(t); return m ? m[1] : null; };
    const ledStrips = async () => ((await call('GET', '/api/accessories/status')).accessories || []).filter((a) => a.kind === 'led_strip' && a.on !== null && a.on !== undefined); // solo las que responden
    function pickStrips(strips, t) {
      const named = strips.filter((a) => { const n = norm(a.name); return (/\baro\b/.test(t) && /\baro\b/.test(n)) || (/\b(barra|tira)\b/.test(t) && /\bbarra\b/.test(n)) || aliasesFor(a.name).some((al) => t.includes(norm(al))); });
      return named.length && !/\b(tiras|leds|todas|todos)\b/.test(t) ? named : strips;
    }
    const setLed = (id, [r, g, b]) => call('POST', '/api/accessories/led', { id, r: String(r), g: String(g), b: String(b) });
    const savedLed = {}; // id → color previo a la alerta, para poder quitarla
    async function alertCommand(t) {
      const strips = await ledStrips();
      if (!strips.length) return 'Ninguna tira LED responde';
      if (/\b(cancela|cancelar|quita|quitar|apaga|apagar|desactiva|desactivar|termina|terminar|fin)\b/.test(t)) {
        if (!Object.keys(savedLed).length) return 'No hay ninguna alerta activa';
        for (const a of strips) if (savedLed[a.id]) await setLed(a.id, savedLed[a.id]);
        for (const k of Object.keys(savedLed)) delete savedLed[k];
        return 'Alerta cancelada, dejé las luces como estaban';
      }
      const cw = colorWord(t);
      if (!cw || !['roja', 'rojo', 'amarilla', 'amarillo', 'verde', 'azul'].includes(cw)) { setPending({ kind: 'alert' }); return '¿Qué alerta? Roja, amarilla, verde o azul'; }
      for (const a of strips) if (!savedLed[a.id]) savedLed[a.id] = (a.config && a.config.led_color) || [0, 0, 0];
      for (const a of strips) await setLed(a.id, COLORS[cw]);
      return `Alerta ${cw === 'verde' || cw === 'azul' ? cw : cw.replace(/o$/, 'a')} activada en ${strips.length === 1 ? 'la tira' : `las ${strips.length} tiras`} LED. Di cancela la alerta para quitarla`;
    }
    async function colorCommand(t) {
      const cw = colorWord(t);
      if (!cw || /\b(escuch\w+|animacion)\b/.test(t)) return null;
      if (!/\b(aro|barra|tira|tiras|led|leds)\b/.test(t) || !/\b(pon|ponle|ponla|ponlas|ponlo|cambia|cambiar|pinta|enciende|prende|activa|color)\b/.test(t)) return null;
      const strips = await ledStrips();
      if (!strips.length) return 'Ninguna tira LED responde';
      const targets = pickStrips(strips, t);
      for (const a of targets) await setLed(a.id, COLORS[cw]);
      for (const a of targets) delete savedLed[a.id]; // un color elegido a mano reemplaza la alerta
      return `Ya puse ${targets.length === 1 ? (/aro/.test(norm(targets[0].name)) ? 'el aro' : 'la tira') : 'las tiras'} en ${cw}`;
    }

    // ---- cotizaciones por voz (material por m², guardadas como borrador en el Cotizador) ----
    const QUOTE = { waste: 0.25, minPerPiece: 3, validDays: 15 };
    const UNIT_WORDS = new Set(['mm', 'cm', 'milimetros', 'milimetro', 'centimetros', 'centimetro', 'minutos', 'minuto', 'min', 'horas', 'hora', 'pesos', 'dias', 'dia', 'de', 'a', 'por', 'x', 'grados', 'porciento', 'veces']);
    const money = (n) => (n >= 10 ? `${Math.round(n)} pesos` : `${dec(n, 2)} pesos`);
    function quoteSize(raw) {
      const m = /(\d+(?:[.,]\d+)?)\s*(?:x|×|por)\s*(\d+(?:[.,]\d+)?)\s*(cm|centimetros?|mm|milimetros?)?/i.exec(norm(raw));
      if (!m) return null;
      const k = /^mm|^mil/.test(m[3] || '') ? 0.1 : 1; // sin unidad se entiende centímetros
      return { w: Number(m[1].replace(',', '.')) * k, h: Number(m[2].replace(',', '.')) * k, span: m[0] };
    }
    function quoteQty(raw, span) {
      let r = norm(raw); if (span) r = r.replace(span, ' ');
      const cand = [...r.matchAll(/\b(\d{1,5})\s+([a-zñ]+)/g)].find((x) => !UNIT_WORDS.has(x[2]));
      return cand ? { qty: Number(cand[1]), item: cand[2] } : null;
    }
    function quoteClient(raw) {
      const m = /\b(?:cliente|a nombre de|de parte de)\s+([A-Za-zÁÉÍÓÚáéíóúñÑ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúñÑ]+){0,2})/.exec(raw);
      if (!m) return null;
      const STOPW = new Set(['para', 'el', 'la', 'a', 'en', 'con', 'de', 'por', 'que', 'y', 'del', 'al']), words = [];
      for (const w of m[1].split(/\s+/)) { if (STOPW.has(norm(w))) break; words.push(w); }
      return words.join(' ') || null;
    }
    async function quoteMaterial(t) {
      const mats = ((await call('GET', '/api/pricing/materials')).materials || []).filter((m) => m.kind === 'sheet');
      const words = (m) => norm(m.name).split(/\s+/).map((w) => w.replace(/mm$/, '')).filter(Boolean);
      const has = (w) => new RegExp(`\\b${w}(?:\\s*(?:mm|milimetros?))?(?![a-z0-9])`).test(t); // «3mm», «3 mm» y «3 milímetros»
      let hits = mats.filter((m) => words(m).every(has));
      if (!hits.length) { const part = mats.filter((m) => words(m).filter((w) => !/^\d+$/.test(w)).every(has) && words(m).some((w) => !/^\d+$/.test(w))); if (part.length === 1) hits = part; } // «acrílico» a secas, si solo hay uno
      hits.sort((a, b) => b.name.length - a.name.length);
      return { chosen: hits[0] || null, mats };
    }
    async function quoteCompute(st) {
      const [settings, machines] = await Promise.all([call('GET', '/api/pricing/settings'), call('GET', '/api/pricing/machines')]);
      const mach = (machines.machines || []).find((m) => m.kind === (st.job === 'cnc' ? 'cnc' : 'laser'));
      if (!mach) throw new Error('No hay un perfil de máquina láser en el Cotizador');
      const mat = st.material;
      if (mat.unit !== 'm2') throw new Error(`El material ${mat.name} se cobra por ${mat.unit}, solo sé cotizar láminas por metro cuadrado`);
      const areaPiece = (st.w * st.h) / 10000, areaTotal = areaPiece * st.qty * (1 + QUOTE.waste);
      const runMin = st.qty * QUOTE.minPerPiece, prepMin = settings.default_prep_minutes || 0, hours = runMin / 60, r2 = (n) => Math.round(n * 100) / 100;
      const material = r2(areaTotal * mat.unit_cost), electricity = r2((mach.watts / 1000) * hours * settings.price_per_kwh), usage = r2(mach.rate_per_hour * hours), labor = r2(settings.labor_rate_per_hour * (prepMin / 60));
      const subtotal = r2(material + electricity + usage + labor), mg = settings.margin || {};
      const margin = r2(mg.mode === 'percentage' ? subtotal * (mg.percentage / 100) : (mg.flat_amount || 0)), total = r2(subtotal + margin);
      return {
        file: { path: null, section: null, name: `${st.qty} ${st.item} ${dec(st.w)}x${dec(st.h)} cm` },
        material: { id: mat.id, name: mat.name, kind: mat.kind }, machine: { id: mach.id, name: mach.name },
        extracted: { filament_g: null, cut_length_mm: null, travel_length_mm: null, bounding_box_area_m2: areaPiece * st.qty, width_mm: st.w * 10, height_mm: st.h * 10, estimated_time_minutes: runMin, time_source: 'estimación por voz', slicer_settings: null },
        cost_lines: [
          { key: 'material', label: 'Material', amount: material, missing: false, detail: `${mat.name} (${areaTotal.toFixed(3)} m², con ${Math.round(QUOTE.waste * 100)}% de merma)` },
          { key: 'electricity', label: 'Energía', amount: electricity, missing: false, detail: `${(mach.watts / 1000 * hours).toFixed(3)} kWh` },
          { key: 'machine_usage', label: 'Uso de máquina', amount: usage, missing: false, detail: `${runMin} min a $${mach.rate_per_hour.toFixed(2)}/h` },
          { key: 'labor', label: 'Mano de obra', amount: labor, missing: false, detail: `Preparación y supervisión (${prepMin} min)` },
          { key: 'consumables', label: 'Consumibles', amount: 0, missing: false, detail: null }, { key: 'additional', label: 'Costos adicionales', amount: 0, missing: false, detail: null }],
        costs: { material_cost: material, material_cost_missing: false, electricity_cost: electricity, electricity_cost_missing: false, machine_usage_cost: usage, labor_cost: labor, consumables_cost: 0, additional_cost: 0, margin_cost: margin, subtotal, total, currency: settings.currency, total_is_partial: false, margin_percentage: mg.percentage || 0 },
        total_time_minutes: runMin + prepMin, warnings: [`Estimado por voz: ${QUOTE.minPerPiece} min por pieza y ${Math.round(QUOTE.waste * 100)}% de merma de material`], _per_piece: total / st.qty,
      };
    }
    async function quoteStep(t, text, st) {
      st = st || { kind: 'quote' };
      const raw = text || t;
      if (!st.w) { const sz = quoteSize(raw); if (sz) { st.w = sz.w; st.h = sz.h; st.sizeSpan = sz.span; } }
      if (!st.qty) { const q = quoteQty(raw, st.w ? st.sizeSpan : (quoteSize(raw) || {}).span); if (q) { st.qty = q.qty; st.item = st.item || q.item; } }
      if (!st.item) { const m = [...norm(raw).matchAll(/\b(?:unos|unas|una|un)\s+([a-zñ]+)/g)].find((x) => !UNIT_WORDS.has(x[1]) && !/^(cotizacion|nueva|nuevo|presupuesto)$/.test(x[1])); if (m) st.item = m[1]; }
      if (!st.material) { const { chosen } = await quoteMaterial(norm(raw)); if (chosen) st.material = chosen; }
      if (!st.client) st.client = quoteClient(raw);
      if (/\bcnc\b/.test(t)) st.job = 'cnc';
      st.item = st.item || 'piezas';
      if (!st.qty) { setPending({ ...st }); return '¿Cuántas piezas?'; }
      if (!st.w) { setPending({ ...st }); return '¿De qué medida es cada pieza? Por ejemplo cinco por cinco centímetros'; }
      if (!st.material) {
        const { mats } = await quoteMaterial('');
        const pidio = /\ben\s+(?!\d)[a-zñ]+/.test(norm(raw)) && !st.askedMat;
        st.askedMat = true; setPending({ ...st });
        return `${pidio ? 'No encontré ese material en el Cotizador. ' : ''}¿En qué material? ${mats.map((m) => m.name).join(', o ')}`;
      }
      const q = await quoteCompute(st);
      setPending({ kind: 'quote-confirm', st, q }); pending.exp = Date.now() + 90000;
      return `Cotización de ${st.qty} ${st.item} de ${dec(st.w)} por ${dec(st.h)} centímetros en ${st.material.name}: total ${money(q.costs.total)}, ${money(q._per_piece)} cada una. Supuse ${QUOTE.minPerPiece} minutos por pieza y ${Math.round(QUOTE.waste * 100)} por ciento de merma.${st.client ? ` Cliente ${st.client}.` : ''} ¿La guardo? Di sí o no`;
    }
    async function quoteSave(p) {
      const { st, q } = p, valid = new Date(Date.now() + QUOTE.validDays * 86400000).toISOString().slice(0, 10);
      const { _per_piece, ...rest } = q;
      const payload = { ...rest, job_type: st.job === 'cnc' ? 'cnc' : 'laser', quantity: st.qty, color: null, detail_level: 'standard', valid_until: valid, notes: `Cotización creada por voz. ${q.warnings[0]}.`, client_name: st.client || null, client_phone: null };
      const saved = await call('POST', '/api/pricing/quotes', { quote: JSON.stringify(payload) });
      const id = saved && (saved.id || saved.quote_id || (saved.quote && saved.quote.id));
      return `Guardé la cotización por ${money(q.costs.total)}${id ? ', folio ' + String(id).split('-').pop() : ''}`;
    }
    async function quotesList() {
      const r = await call('GET', '/api/pricing/quotes'), q = Array.isArray(r) ? r : (r.quotes || r.items || []);
      if (!q.length) return 'No tienes cotizaciones guardadas';
      const sum = q.reduce((a, x) => a + Number((x.costs && x.costs.total) || x.total || 0), 0);
      return `Tienes ${plural(q.length, 'cotización', 'cotizaciones')}, en total ${money(sum)}. Las últimas: ` + q.slice(0, 3).map((x) => `${(x.client_name || (x.file && x.file.name) || 'sin nombre')}, ${money(Number((x.costs && x.costs.total) || 0))}`).join('; ');
    }

    // ---- vigilancia de seguridad y avisos de máquinas paradas (mientras NOPAL esté abierto en este navegador) ----
    const safety = { alarm: {}, klipper: {}, svc: {}, hot: 0, humid: 0, last: 0 };
    async function checkSafety(out) {
      if (Date.now() - safety.last < 15000) return;
      safety.last = Date.now();
      const now = Date.now(), th = cfg.umbrales || {};
      for (const m of ((await call('GET', '/api/laser/registry/status').catch(() => ({}))).lasers || []).filter((x) => x.online)) {
        const st = await call('GET', '/api/laser/status?host=' + encodeURIComponent(m.host)).catch(() => null), alarm = !!st && /alarm/i.test(String(st.state));
        if (alarm && !safety.alarm[m.host]) out.push(`Alarma en ${m.name}`);
        safety.alarm[m.host] = alarm;
      }
      for (const pr of (await call('GET', '/api/printers/status').catch(() => ({}))).printers || []) {
        const state = String(pr.state || '').toLowerCase(), bad = pr.status === 'online' && !!state && !['ready', 'startup'].includes(state);
        if (bad && !safety.klipper[pr.port]) out.push(`${pr.name} está en estado ${state}`);
        safety.klipper[pr.port] = bad;
      }
      for (const x of ((await call('GET', '/api/system/services').catch(() => ({}))).services || [])) {
        const down = x.active !== 'active';
        if (down && !safety.svc[x.unit]) out.push(`El servicio ${x.unit} se detuvo`);
        safety.svc[x.unit] = down;
      }
      try {
        const b = ((await call('GET', '/api/accessories/arduino/telemetry')).boards || []).find((x) => x.online && x.telemetry && x.telemetry.dht_valid);
        if (b) {
          const T = b.telemetry.dht_temp_c, H = b.telemetry.dht_humidity_pct;
          if (th.tallerMaxC && T >= th.tallerMaxC && now - safety.hot > 30 * 60000) { safety.hot = now; out.push(`La temperatura del taller es de ${dec(T)} grados, está muy alta`); }
          if (th.humedadMax && H >= th.humedadMax && now - safety.humid > 60 * 60000) { safety.humid = now; out.push(`La humedad del taller es de ${Math.round(H)} por ciento`); }
        }
      } catch (_) { /* sin sensor */ }
    }
    const NUDGE = { idleMin: 90, everyMin: 120, longIdleMin: 240, longEveryMin: 240, fromH: 8, toH: 20 };
    const fmtDur = (ms) => { const min = Math.round(ms / 60000); if (min < 60) return `${min} minutos`; if (min >= 48 * 60) return `${Math.round(min / 1440)} días`; const h = Math.floor(min / 60), r = min % 60; return `${h === 1 ? 'una hora' : h + ' horas'}${r >= 45 ? ' tres cuartos' : r >= 25 ? ' y media' : ''}`; };
    async function collectMachines() {
      const list = [];
      for (const pr of (await call('GET', '/api/printers/status').catch(() => ({}))).printers || []) {
        if (pr.status !== 'online') continue;
        list.push({ key: 'printer:' + pr.port, name: pr.name, type: 'printer', port: pr.port, idle: pr.state === 'ready' && !['printing', 'paused'].includes(jobState(pr)) });
      }
      for (const m of ((await call('GET', '/api/laser/registry/status').catch(() => ({}))).lasers || []).filter((x) => x.online)) {
        const s2 = await call('GET', '/api/laser/status?host=' + encodeURIComponent(m.host)).catch(() => null);
        if (s2) list.push({ key: 'laser:' + m.host, name: m.name, type: 'laser', host: m.host, idle: String(s2.state).toLowerCase() === 'idle' });
      }
      return list;
    }
    async function queuedWork(m) {
      try {
        if (m.type === 'printer') return ((await call('GET', `/api/printers/${m.port}/queue`)).queued_jobs || []).map((j) => ({ id: j.id || j.job_id, name: j.filename || j.name || 'un trabajo' }));
        return ((await call('GET', '/api/laser/queue?host=' + encodeURIComponent(m.host))).queue || []).map((j) => ({ id: j.id, name: j.filename || j.name || 'un trabajo' }));
      } catch (_) { return []; }
    }
    async function pendingQuotes() {
      try {
        const r = await call('GET', '/api/pricing/quotes'), q = Array.isArray(r) ? r : (r.quotes || r.items || []);
        return q.filter((x) => !/^(done|completed|completad|entregad|cancel|rechaz|rejected|cerrad|pagad|lost|perdid)/i.test(String(x.status || ''))).map((x) => x.customer || x.client_name || x.client || x.name || x.title || 'un pedido');
      } catch (_) { return []; }
    }
    let lastIdleCheck = 0;
    async function checkIdle(out) {
      if (Date.now() - lastIdleCheck < 60000) return;
      lastIdleCheck = Date.now();
      const now = Date.now(), st = cfg.nudge = { lastActive: {}, lastNudge: {}, mutedUntil: 0, lastAny: 0, ...(cfg.nudge || {}) };
      const machines = await collectMachines();
      for (const m of machines) { if (!m.idle || !st.lastActive[m.key]) st.lastActive[m.key] = now; } // sin historial: se cuenta desde que este navegador la vio parada
      saveCfg();
      if (pending && Date.now() > pending.exp) pending = null;
      const hour = new Date().getHours();
      if (now < st.mutedUntil || hour < NUDGE.fromH || hour >= NUDGE.toH || pending || now - (st.lastAny || 0) < 20 * 60000) return;
      const idle = machines.filter((m) => m.idle).map((m) => ({ m, ms: now - st.lastActive[m.key] })).sort((a, b) => b.ms - a.ms);
      const quotes = idle.length ? await pendingQuotes() : [];
      for (const { m, ms } of idle) {
        const since = now - (st.lastNudge[m.key] || 0), queue = await queuedWork(m), work = queue.length || quotes.length;
        if (work && ms >= NUDGE.idleMin * 60000 && since >= NUDGE.everyMin * 60000) {
          const parts = [];
          if (queue.length) parts.push(`${plural(queue.length, 'trabajo', 'trabajos')} en su cola${queue.length === 1 ? ': ' + queue[0].name.replace(/\.(gcode|gc|nc)$/i, '') : ''}`);
          if (quotes.length) parts.push(`${plural(quotes.length, 'pedido pendiente', 'pedidos pendientes')}${quotes.length === 1 ? ': ' + quotes[0] : ''}`);
          st.lastNudge[m.key] = now; st.lastAny = now; saveCfg();
          if (queue.length) { out.push(`${m.name} lleva ${fmtDur(ms)} parada y hay ${parts.join(' y ')}. ¿La arranco?`); setPending({ kind: 'startqueue', machine: m, job: queue[0] }); pending.exp = now + 5 * 60000; }
          else out.push(`${m.name} lleva ${fmtDur(ms)} parada y hay ${parts.join(' y ')}. ¿Lo vemos?`);
          return; // un aviso por vuelta
        }
        if (!work && ms >= NUDGE.longIdleMin * 60000 && since >= NUDGE.longEveryMin * 60000) { st.lastNudge[m.key] = now; st.lastAny = now; saveCfg(); out.push(`${m.name} lleva ${fmtDur(ms)} sin trabajar. Si quieres aprovecharla, dime qué hacemos.`); return; }
      }
    }
    async function startQueue(p) {
      const cur = (await collectMachines()).find((x) => x.key === p.machine.key);
      if (!cur || !cur.idle) return `${p.machine.name} ya no está libre, no la arranco`;
      if (p.machine.type === 'printer') await call('POST', `/api/printers/${p.machine.port}/queue/start`);
      else await call('POST', '/api/laser/queue/start', { id: String(p.job.id), host: p.machine.host });
      return `Arrancando la cola en ${p.machine.name}`;
    }
    function muteCommand(t) {
      const st = cfg.nudge = { lastActive: {}, lastNudge: {}, mutedUntil: 0, lastAny: 0, ...(cfg.nudge || {}) };
      if (/\b(ya puedes|puedes volver|activa|activar|reactiva|vuelve a)\b.*\b(avis\w*|hablar|molestar)\b/.test(t)) { st.mutedUntil = 0; saveCfg(); return 'Listo, vuelvo a avisarte'; }
      if (!/\b(no me molestes|no molestes|silencio|callate|no me avises|no avises|deja de avisar|sin avisos)\b/.test(t)) return null;
      const n = /\b(\d+)\s*(horas?|minutos?|min)\b/.exec(t);
      let ms = 2 * 3600000;
      if (n) ms = Number(n[1]) * (/hora/.test(n[2]) ? 3600000 : 60000);
      else if (/\buna hora\b/.test(t)) ms = 3600000;
      else if (/\b(hoy|todo el dia|el resto del dia)\b/.test(t)) { const e = new Date(); e.setHours(23, 59, 0, 0); ms = e - Date.now(); }
      st.mutedUntil = Date.now() + ms; saveCfg();
      return `Está bien, no te molesto por ${fmtDur(ms)}. Los recordatorios sí te los sigo dando`;
    }

    const withMoreQuestion = (reply) => (!reply || reply === END_REPLY || /[¿?]|di sí o no/i.test(reply) || /^(dime|error|no entend|hay muchos|eso todav|no encuentro|no encontr|no puedo|no pude|esta pantalla|todavia no|tu sesi|la inteligencia|el servicio)/i.test(reply)) ? reply : `${reply}. ${MORE_Q}`;

    // ---- intérprete ----
    async function handleCore(text, followUp) {
      const t = norm(text).replace(/^(nopal|no pal|nopar)\b ?/, '');
      if (!t) return 'Dime';
      if (pending && Date.now() > pending.exp) pending = null;

      if (pending && pending.kind === 'nav') { pending = null; const r = await navCommand('abre la ficha de ' + t); if (r) return r; }
      if (pending && pending.kind === 'startqueue') {
        const p = pending; pending = null;
        if (YES.test(t)) { try { return await startQueue(p); } catch (e) { return 'No pude arrancarla: ' + e.message; } }
        if (/^(no|nel|nada|luego|despues|mas tarde)\b/.test(t)) return 'Está bien, la dejo parada';
      }
      if (pending && pending.kind === 'quote') { const st = pending; pending = null; if (NO.test(t)) return 'Cotización cancelada'; try { return await quoteStep(t, text, st); } catch (e) { return 'No pude cotizar: ' + e.message; } }
      if (pending && pending.kind === 'quote-confirm') { const p = pending; pending = null; if (YES.test(t)) { try { return await quoteSave(p); } catch (e) { return 'No pude guardarla: ' + e.message; } } return 'Está bien, no la guardé'; }
      if (pending && pending.kind === 'alert') { pending = null; return alertCommand(t.includes('alerta') ? t : 'alerta ' + t); }
      if (pending && pending.kind === 'scene') {
        const p = pending; pending = null;
        const pick = p.cands.find((s) => norm(t).includes(norm(s.name))) || ordinalPick(p.cands, t) || p.cands.find((s) => norm(s.name).split(' ').some((w) => w.length >= 3 && t.includes(w)));
        if (pick) return runScene(pick, p.wantOn);
        return 'No supe cuál. Intenta decir el nombre completo';
      }
      if (pending && pending.kind === 'ai-action') {
        const id = pending.id;
        if (YES.test(t)) { pending = null; try { await call('POST', `/api/ai/actions/${id}/confirm`); return 'Listo, lo hice'; } catch (e) { return 'No se pudo: ' + e.message; } }
        if (NO.test(t)) { pending = null; await call('POST', `/api/ai/actions/${id}/cancel`).catch(() => {}); return 'Cancelado, no hice nada'; }
        return 'No entendí, di sí o no';
      }
      if (pending) {
        if (NO.test(t)) { pending = null; return 'Cancelado'; }
        if (pending.kind === 'home') return homeDialog(t, pending);
        if (pending.kind === 'frame') {
          if (pending.confirm) { if (YES.test(t)) { const st = pending; pending = null; return doFrame(st); } return 'No entendí, di sí o no'; }
          return frameDialog(t, pending);
        }
        if (pending.kind === 'zmove') { if (YES.test(t)) return zMoveDo(pending); return 'No entendí, di sí o no'; }
        if (pending.kind.startsWith('printer-')) {
          const kind = pending.kind.slice(8);
          if (pending.confirm) { if (YES.test(t)) return printerAction(kind, t, pending); return 'No entendí, di sí o no'; }
          return printerAction(kind, t, null);
        }
      }
      if (Date.now() < aiAwaitUntil && !pending && /^(si|sii|claro|dale|ok|confirmo|adelante|hazlo|no|nel|nada|ese|esa|el primero|la primera|el segundo|la segunda|el otro|la otra|ambos|todos|cancela)\b/.test(t)) {
        aiAwaitUntil = 0;
        try { const a = await askAI(text); if (a) return a; } catch (e) { return 'No pude consultar la inteligencia artificial'; }
      }

      if (/\balerta\b/.test(t) && (colorWord(t) || /\b(cancela|cancelar|quita|quitar|apaga|apagar|desactiva|desactivar|termina|terminar|fin)\b/.test(t) || /\b(active|activa|activar|pon|prende|enciende|haz|manda|lanza)\b/.test(t))) return alertCommand(t);
      const col = await colorCommand(t);
      if (col) return col;
      if (/\b(cotizacion|cotizaciones|cotiza|cotizar|presupuesto)\b/.test(t)) {
        if (/\b(que|cuales|cuantas|dime|lee|leeme|tengo|hay)\b/.test(t) && !/\b(crea|crear|nueva|nuevo|haz|hazme|genera|prepara)\b/.test(t)) return quotesList();
        try { return await quoteStep(t, text, null); } catch (e) { return 'No pude cotizar: ' + e.message; }
      }
      if (/\b(alertas|avisos|notificaciones|problemas|errores)\b/.test(t) && /\b(que|cuales|cuantas|hay|tengo|dime|lee|leeme)\b/.test(t)) return alertsList();
      if (/\b(archivos?)\b/.test(t) && /\b(cuantos|cuantas|hay|tengo|total)\b/.test(t)) return filesReport(t);
      if (/\b(estado|salud|como esta|como va|resumen|reporte)\b/.test(t) && /\b(sistema|servidor|nopal|general)\b/.test(t)) return systemReport();
      if ((/\b(taller|ambiente|cuarto|habitacion|humedad|sensor|sensores)\b/.test(t) && /\b(temperatura|grados|humedad|calor|frio|hace|sensor|sensores|lee|leeme|lectura)\b/.test(t)) || /\b(lee|leeme|lectura de)\b.*\bsensores\b/.test(t)) return sensorReport(t);
      if (/\b(archivos?)\b/.test(t) && /\b(nombre|llamad\w*|busca\w*|encuentra|buscame)\b/.test(t)) { const r = await fileSearch(t); if (r) return r; }
      if (/\b(ayuda|que puedes hacer|que sabes hacer|que comandos|que entiendes|que se puede)\b/.test(t)) return 'Puedo encender o apagar luces y aire, decirte cómo van las máquinas, hacer home, pausar, reanudar, navegar la pantalla de NOPAL, ponerte recordatorios, y lo que no sé se lo pregunto a la inteligencia artificial';
      const timeWords = /\b(manana|hoy|a las?|en \d+ (min|hor)|en (media|una) hora)\b/.test(t);
      if (/\b(recuerdame|recordarme|recordatorios?|acuerdame)\b/.test(t) || (/\bavisame\b/.test(t) && timeWords && !/\b(llegue|alcance|termine|acabe)\b/.test(t))) return reminderCommand(t);
      if (/\b(que|cuales|cuantos)\b.*\b(recordatorios?)\b/.test(t)) return cfg.reminders.length ? `Tienes ${plural(cfg.reminders.length, 'recordatorio', 'recordatorios')}: ` + cfg.reminders.map((r) => r.what).join(', ') : 'No tienes recordatorios pendientes';
      if ((/\b(trabajos?|maquinas?|impresoras?|lasers?|equipos?)\b/.test(t) && /\b(activ[oa]s?|trabajando|imprimiendo|funcionando|corriendo|ocupad[oa]s?|en marcha)\b/.test(t)) || /\bque (esta|estan) (trabajando|imprimiendo|corriendo|funcionando)\b/.test(t)) return activityReport();
      const nav = await navCommand(t);
      if (nav) return nav;
      const mute = muteCommand(t);
      if (mute) return mute;
      const watch = await watchCommand(t);
      if (watch) return watch;
      const fil = await filamentCommand(t);
      if (fil) return fil;
      if (zIntent(t)) return zMoveStart(t);
      const heat = await heatCommand(t);
      if (heat) return heat;
      if (/\b(home|hom|jom|homing|origen)\b/.test(t)) return homeDialog(t, null);
      if (/\b(pausa|pausar|deten|detener)\b/.test(t) && /\b(impresion|impresora|imprimir|print)\b/.test(t)) return printerAction('pause', t, null);
      if (/\b(reanuda|reanudar|continua|continuar|sigue|seguir)\b/.test(t) && /\b(impresion|impresora|imprimir|print)\b/.test(t)) return printerAction('resume', t, null);
      if (/\b(cancela|cancelar)\b/.test(t) && /\b(impresion|impresora|imprimir|print)\b/.test(t)) return printerAction('cancel', t, null);
      if (/\b(como va|como esta|estado|temperatura|temperaturas|progreso|status)\b/.test(t)) return statusReport();
      if (/\b(encuadra|encuadre|encuadrar|enmarca)\b/.test(t)) return frameDialog(t, null);

      if (lastScene && Date.now() - lastScene.at < 10 * 60000) { // «préndela», «apágala»
        const onP = /\b(prendela|prendelo|enciendela|enciendelo|activala|activalo)\b/.test(t), offP = /\b(apagala|apagalo|desactivala|desactivalo)\b/.test(t);
        if (onP !== offP) { const sc = ((await call('GET', '/api/accessories/scenes')).scenes || []).find((x) => x.id === lastScene.id); if (sc) return runScene(sc, onP); }
      }
      const askingActive = /\b(hay|alguna|algun|que|cuales|cual|esta|estan)\b/.test(t) && /\bactiv[oa]s?\b/.test(t);
      const wantOn = !askingActive && /\b(enciende|encender|prende|prender|activa|activar|pon|ponle)\b/.test(t), wantOff = /\b(apaga|apagar|desactiva|desactivar|quita|corta)\b/.test(t);
      if (wantOn !== wantOff) {
        const scenes = (await call('GET', '/api/accessories/scenes')).scenes || [];
        const f = findScenes(scenes, t);
        if (f.ask) { setPending({ kind: 'scene', cands: f.ask, wantOn }); return `Hay varias. ¿Cuál? ${f.ask.map((s) => s.name).join(', o ')}`; }
        if (!f.list.length) return 'No sé cuál es, dime luz, aire o el nombre de la escena';
        const out = []; for (const s of f.list) out.push(await runScene(s, wantOn));
        return out.join('. ');
      }
      if (YES.test(t) && t.split(' ').length <= 3) return 'No tengo nada pendiente por confirmar. Repíteme la orden';
      if (/\b(hola|estas ahi|me escuchas)\b/.test(t)) return 'Aquí estoy';
      if (/\b(otra cosa|algo mas|una cosa mas|tengo otra)\b/.test(t)) return 'Dime';
      if (followUp && /^(no|nada|nada mas|ninguna|ya|ya es todo|es todo|eso es todo|eso es todo gracias|gracias|no gracias|no nada mas)\b/.test(t) && t.split(' ').length <= 5) return END_REPLY;

      const nwords = t.split(' ').length;
      const looksRequest = /[¿?]/.test(text) || /\b(que|cuanto|cuantos|cuantas|donde|hay|puedes|dime|muestrame|cual|cuales|como|cuando)\b/.test(t);
      if (nwords < (followUp && !looksRequest ? 4 : 2)) return followUp ? '' : 'Dime qué necesitas';
      try { const a = await askAI(text); if (a) return a; }
      catch (e) {
        if (/429|quota|rate/i.test(e.message)) return 'La inteligencia artificial llegó a su límite de uso. Intenta de nuevo en un minuto';
        if (/respondió 5\d\d/.test(e.message)) return 'El servicio de inteligencia artificial falló un momento. Intenta de nuevo';
        return 'No pude consultar la inteligencia artificial';
      }
      return followUp ? 'Eso todavía no sé hacerlo. Puedes decirme otra cosa o «eso es todo»' : 'No entendí. Puedo encender o apagar luces y aire, hacer home y decirte cómo va todo';
    }
    async function handle(text, followUp = false, context = {}) {
      ctx = { followUp: !!followUp, ...context };
      try { return withMoreQuestion(await handleCore(text, !!followUp)); }
      catch (e) { return 'Error: ' + e.message; }
    }
    return { handle, norm, dueReminders, pollEvents, findScenes, pickDevice, parseReminder: reminderCommand, _state: () => ({ pending }) };
  }

  // ====================================================================
  // Acciones sobre la pantalla de NOPAL (sus funciones globales)
  // ====================================================================
  const navStack = [];
  const sectionEl = (n) => document.getElementById(n + '-section');
  const currentSection = () => { const el = document.querySelector('.view-section.active'); return el ? el.id.replace(/-section$/, '') : null; };
  function closeModals() {
    let n = 0;
    document.querySelectorAll('.modal.active').forEach((m) => { const b = m.querySelector('.modal-close'); if (b) b.click(); else m.classList.remove('active'); n++; });
    return n;
  }
  function gotoSection(name) {
    if (typeof window.switchSection !== 'function') return 'Esta pantalla no tiene navegación que yo conozca';
    if (!sectionEl(name)) return null;
    const cur = currentSection(); if (cur && cur !== name) navStack.push(cur);
    closeModals(); window.switchSection(name); return 'ok';
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function onAction(a) {
    switch (a.type) {
      case 'goto': { const r = gotoSection(a.name); if (r === null) return `No encuentro ${a.label || a.name} en esta pantalla. Puede que el plugin no esté activo`; return r === 'ok' ? undefined : r; }
      case 'settings': {
        if (gotoSection('settings') === null) return 'No encuentro la configuración';
        await wait(200);
        if (typeof window.activateSettingsTab === 'function' && a.tab && !window.activateSettingsTab(a.tab)) return `No puedo abrir ${a.label || a.tab}: tu usuario no tiene permiso o no existe esa pestaña`;
        return undefined;
      }
      case 'theme': {
        if (typeof window.applyTheme !== 'function') return 'No encuentro el selector de temas';
        let t = a.theme;
        if (t === 'next') { const cycle = ['light', 'dark', 'green', 'red'], cur = document.body.getAttribute('data-theme') || 'light'; t = cycle[(cycle.indexOf(cur) + 1) % cycle.length]; }
        window.applyTheme(t);
        try { localStorage.setItem('theme', t); } catch (_) { /* modo privado */ }
        window.setActiveThemeCard?.(t);
        return undefined;
      }
      case 'printer': {
        const list = (typeof allPrinters !== 'undefined' && Array.isArray(allPrinters)) ? allPrinters : [];
        if (!list.length) return 'Todavía no cargan las impresoras en la pantalla. Intenta de nuevo en un momento';
        const p = list.find((x) => a.port != null && Number(x.port) === Number(a.port)) || list.find((x) => a.name && x.name === a.name) || list[a.index];
        if (!p) return `No encuentro la impresora ${a.name || a.index + 1} en la pantalla`;
        if (currentSection() !== 'dashboard' && sectionEl('dashboard')) gotoSection('dashboard');
        await wait(150);
        if (typeof window.openPrinterModal !== 'function') return 'No encuentro la ficha de impresora';
        window.openPrinterModal(p); return undefined;
      }
      case 'back': { closeModals(); const prev = navStack.pop() || 'dashboard'; if (window.switchSection && sectionEl(prev)) window.switchSection(prev); return undefined; }
      case 'close': return closeModals() ? undefined : 'No hay ninguna ventana abierta';
      case 'scroll': {
        const el = document.querySelector('.view-section.active') || document.scrollingElement;
        const sc = [el, el && el.parentElement, document.scrollingElement].find((e) => e && e.scrollHeight > e.clientHeight + 5) || document.scrollingElement;
        sc.scrollBy({ top: (a.dir || 1) * window.innerHeight * 0.8, behavior: 'smooth' }); return undefined;
      }
      default: return 'No sé hacer esa acción en la pantalla';
    }
  }

  // ====================================================================
  // Oídos y boca (navegador)
  // ====================================================================
  function createVoice(brain, ui) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const WAKE = /\b(nopal|no pal|nopar|nopales|nopalito)\b/i;
    const ARM_MS = 8000, FOLLOW_MS = 7000;
    let rec, running = false, armedUntil = 0, speaking = false, dinged = false, lock = null, ac, recActive = false, busy = false;
    let lastReplyNorm = '', lastReplyAt = 0;
    const secure = window.isSecureContext !== false;
    const supported = !!SR && secure;
    const esEco = (txt) => { // el micrófono oye la voz del propio Nopal por las bocinas: no es una orden
      const t = norm(txt), kt = t.split(' ').filter(Boolean);
      if (!lastReplyNorm || Date.now() - lastReplyAt > 20000 || kt.length < 3) return false;
      const rt = new Set(lastReplyNorm.split(' '));
      return lastReplyNorm.includes(t) || (kt.length >= 4 && kt.filter((w) => rt.has(w)).length / kt.length >= 0.9);
    };
    function ding(freqs = [880, 1320]) {
      try {
        ac = ac || new (window.AudioContext || window.webkitAudioContext)();
        const t0 = ac.currentTime;
        freqs.forEach((f, i) => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ac.destination);
          g.gain.setValueAtTime(0.0001, t0 + i * .12); g.gain.exponentialRampToValueAtTime(0.4, t0 + i * .12 + .02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * .12 + .25);
          o.start(t0 + i * .12); o.stop(t0 + i * .12 + .3);
        });
      } catch (_) { /* sin audio */ }
    }
    const FEMALE = /(dalia|sabina|paloma|elena|helena|laura|lucia|sofia|camila|valentina|monica|female|femenin|mujer)/i;
    const esVoices = () => (window.speechSynthesis ? speechSynthesis.getVoices() : []).filter((v) => /^es/i.test(v.lang));
    function pickVoice() {
      const vs = esVoices();
      return vs.find((v) => v.name === cfg.voice) || vs.find((v) => FEMALE.test(v.name) && /MX|US/i.test(v.lang)) || vs.find((v) => FEMALE.test(v.name)) || vs.find((v) => /google/i.test(v.name)) || vs[0];
    }
    function speak(text) {
      return new Promise((resolve) => {
        if (!('speechSynthesis' in window) || !text) return resolve();
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'es-MX'; u.rate = cfg.rate; u.pitch = cfg.pitch;
        const v = pickVoice(); if (v) { u.voice = v; u.lang = v.lang; }
        let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { try { speechSynthesis.cancel(); } catch (_) { /* nada */ } finish(); }, Math.min(70000, 3000 + text.length * 110)); // Edge/Chrome a veces nunca disparan onend
        u.onend = u.onerror = finish;
        speechSynthesis.speak(u);
        const t0 = Date.now();
        const poll = setInterval(() => { if (done) return clearInterval(poll); if (Date.now() - t0 > 1200 && !speechSynthesis.speaking && !speechSynthesis.pending) { clearInterval(poll); finish(); } }, 250);
      });
    }
    async function sendCommand(text, follow) {
      const prev = armedUntil; armedUntil = 0; busy = true;
      ui.setUi('busy', 'Procesando…'); ui.log('me', text);
      const reply = await brain.handle(text, !!follow, { section: currentSection() });
      if (!reply) { armedUntil = prev; busy = false; start(); return; } // ruido en la ventana de seguimiento
      ui.log('bot', reply); lastReplyNorm = norm(reply); lastReplyAt = Date.now();
      speaking = true; try { rec.stop(); } catch (_) { /* ya parado */ }
      try { await speak(reply); } finally { speaking = false; busy = false; lastReplyAt = Date.now(); }
      await wait(700); // deja morir el eco de la sala antes de volver a escuchar
      if (/aquí estaré/i.test(reply)) { armedUntil = 0; ding([660, 440]); ui.setUi('listen', 'Esperando «Nopal»'); start(); return; }
      ding([660]);
      armedUntil = Date.now() + (/[¿?]|di sí o no|dime/i.test(reply) ? ARM_MS + 2000 : FOLLOW_MS);
      start();
    }
    function onResult(ev) {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i], txt = res[0].transcript.trim(), armed = Date.now() < armedUntil;
        if (!res.isFinal && (armed || WAKE.test(txt))) ui.status('Oigo: ' + txt);
        if (!armed && WAKE.test(txt) && !dinged) { dinged = true; ding(); armedUntil = Date.now() + ARM_MS; ui.setUi('armed', 'Te escucho…'); }
        if (res.isFinal && esEco(txt)) { dinged = false; continue; }
        if (res.isFinal) {
          dinged = false;
          const m = WAKE.exec(txt);
          const cmd = m ? txt.slice(m.index + m[0].length).replace(/^[\s,.:;]+/, '') : (armed ? txt : '');
          if (cmd) sendCommand(cmd, !m);
          else if (m) { armedUntil = Date.now() + ARM_MS; ui.setUi('armed', 'Te escucho…'); }
        }
      }
    }
    function start() {
      if (!running) return;
      if (rec) { rec.onresult = rec.onend = rec.onerror = rec.onstart = null; try { rec.abort(); } catch (_) { /* nada */ } }
      const me = rec = new SR(); rec.lang = 'es-MX'; rec.continuous = true; rec.interimResults = true;
      rec.onstart = () => { recActive = true; };
      rec.onresult = onResult;
      rec.onend = () => { if (rec === me) recActive = false; if (running && !speaking && rec === me) setTimeout(start, 250); };
      rec.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { running = false; ui.setUi('', 'Permite el micrófono en el navegador'); } };
      dinged = false;
      try { rec.start(); ui.setUi(Date.now() < armedUntil ? 'armed' : 'listen', Date.now() < armedUntil ? 'Te escucho…' : 'Esperando «Nopal»'); } catch (_) { /* ya iniciado */ }
    }
    async function announce(text) { // recordatorios: si no hay conversación, los dice en voz alta
      ui.log('bot', text);
      if (!running || speaking || busy || Date.now() < armedUntil) { ui.toast?.(text); return; }
      speaking = true; try { rec.stop(); } catch (_) { /* nada */ }
      ding([880, 1175]);
      try { await speak(text); } finally { speaking = false; }
      start();
    }
    const timers = [
      setInterval(() => { // vigilante: si debería estar escuchando y no lo está, se reactiva solo
        if (!running || speaking || recActive) { timers.idle = 0; return; }
        timers.idle = timers.idle || Date.now();
        if (Date.now() - timers.idle > 2500) { timers.idle = 0; start(); }
      }, 1000),
      setInterval(() => { for (const r of brain.dueReminders()) announce(`Recordatorio: ${r.what}`); }, 15000),
      setInterval(async () => { if (document.visibilityState === 'visible') for (const e of await brain.pollEvents()) announce(e); }, 8000), // impresión terminada, temperatura alcanzada
    ];
    async function toggle() {
      if (!supported) { ui.status(secure ? 'Este navegador no tiene reconocimiento de voz. Usa Edge o Chrome.' : 'El micrófono exige HTTPS. Abre NOPAL por https:// o desde localhost.'); return; }
      if (running) { running = false; store.set('on', '0'); try { rec.stop(); } catch (_) { /* nada */ } ui.setUi('', 'Pausado'); return; }
      running = true; store.set('on', '1'); ding([880]);
      try { lock = await navigator.wakeLock?.request('screen'); } catch (_) { /* sin wake lock */ }
      start();
    }
    const onVis = async () => { if (document.visibilityState === 'visible' && running) { try { lock = await navigator.wakeLock?.request('screen'); } catch (_) { /* nada */ } } };
    document.addEventListener('visibilitychange', onVis);
    function destroy() { running = false; timers.forEach(clearInterval); document.removeEventListener('visibilitychange', onVis); try { rec && rec.abort(); } catch (_) { /* nada */ } }
    return { supported, secure, toggle, isRunning: () => running, wasOn: () => store.get('on') === '1', speak, destroy, esVoices };
  }

  // ====================================================================
  // Interfaz: botón flotante + sección en el menú de plugins
  // ====================================================================
  let fab, section, navBtn, voice, brain, bubbleTimer;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MIC_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';

  function sectionHtml() {
    return `<section id="${PLUGIN_ID}-section" class="view-section cpv-section" style="display:none">
      <h1>Control por voz</h1><div class="cpv-sub">v${VERSION} · Di «Nopal» y pide lo que necesites</div>
      <div class="cpv-card"><h2>Estado</h2>
        <div class="cpv-row"><span id="cpv-st-mic"></span></div>
        <div class="cpv-row"><button type="button" id="cpv-toggle" class="btn btn-primary">Activar micrófono</button><button type="button" id="cpv-test" class="btn">Probar voz</button></div>
        <div class="cpv-row"><label><input type="checkbox" id="cpv-auto"> Activar solo al abrir NOPAL</label></div>
      </div>
      <div class="cpv-card"><h2>Voz</h2>
        <div class="cpv-row"><label for="cpv-voice">Voz</label><select id="cpv-voice"></select></div>
        <div class="cpv-row"><label for="cpv-pitch">Tono</label><input type="range" id="cpv-pitch" min="0.6" max="1.8" step="0.05"><span id="cpv-pitch-v"></span></div>
        <div class="cpv-row"><label for="cpv-rate">Velocidad</label><input type="range" id="cpv-rate" min="0.7" max="1.6" step="0.05"><span id="cpv-rate-v"></span></div>
      </div>
      <div class="cpv-card"><h2>Escenas por defecto</h2>
        <div class="cpv-sub">Qué enciende «la luz» o «el aire» cuando no dices cuál.</div>
        <div class="cpv-row"><label for="cpv-def-light">«La luz»</label><select id="cpv-def-light"></select></div>
        <div class="cpv-row"><label for="cpv-def-fan">«El aire»</label><select id="cpv-def-fan"></select></div>
      </div>
      <div class="cpv-card"><h2>Apodos</h2>
        <div class="cpv-sub">Una por línea: <code>apodo = nombre real</code>. Ej.: <code>el grande = SC MX30 Pro</code>. Sirven para máquinas y escenas.</div>
        <textarea id="cpv-alias" spellcheck="false"></textarea>
        <div class="cpv-row"><button type="button" id="cpv-alias-save" class="btn">Guardar apodos</button><span id="cpv-alias-msg"></span></div>
      </div>
      <div class="cpv-card"><h2>Prueba en texto</h2>
        <div class="cpv-row"><input type="text" id="cpv-text" placeholder="Escribe una orden, p. ej. enciende la luz" style="flex:1"><button type="button" id="cpv-send" class="btn">Enviar</button></div>
        <div class="cpv-log" id="cpv-log"></div>
      </div>
      <div class="cpv-card"><h2>Qué puedes pedir</h2><ul>
        <li>«Nopal, enciende la luz» · «apaga el aire»</li><li>«Nopal, ¿cómo va todo?» · «¿qué máquinas están trabajando?»</li>
        <li>«Nopal, haz home» · «pausa la impresión» · «reanuda» (cancelar pide confirmación)</li>
        <li>«Nopal, abre configuración» · «ve al cotizador» · «cambia el tema» · «abre la ficha de la impresora»</li>
        <li>«Nopal, recuérdame en 20 minutos revisar el láser» (solo con NOPAL abierto)</li>
        <li>Cualquier otra pregunta se la hace a la inteligencia artificial de NOPAL, si la tienes configurada.</li></ul></div>
    </section>`;
  }

  function logLine(cls, text) {
    const el = section && section.querySelector('#cpv-log'); if (!el) return;
    const d = document.createElement('div'); d.className = cls; d.textContent = text; el.prepend(d);
    while (el.children.length > 40) el.lastChild.remove();
  }
  function bubble(html, ms = 9000) {
    const b = fab && fab.querySelector('#cpv-bubble'); if (!b) return;
    b.innerHTML = html; b.style.display = 'block'; clearTimeout(bubbleTimer); bubbleTimer = setTimeout(() => { b.style.display = 'none'; }, ms);
  }
  function refreshStatus() {
    if (!section) return;
    const el = section.querySelector('#cpv-st-mic'), btn = section.querySelector('#cpv-toggle');
    if (!voice.secure) el.innerHTML = '<span class="cpv-bad">✗ El micrófono exige HTTPS.</span> Abre NOPAL por <b>https://</b> (con un proxy inverso como Caddy o Nginx) o desde <b>localhost</b>.';
    else if (!voice.supported) el.innerHTML = '<span class="cpv-bad">✗ Este navegador no trae reconocimiento de voz.</span> Usa Microsoft Edge o Google Chrome (Brave no sirve).';
    else el.innerHTML = voice.isRunning() ? '<span class="cpv-ok">● Escuchando «Nopal»</span>' : '○ Micrófono apagado';
    btn.textContent = voice.isRunning() ? 'Pausar micrófono' : 'Activar micrófono';
    btn.disabled = !voice.supported;
  }
  async function fillScenes() {
    try {
      const scenes = ((await api('GET', '/api/accessories/scenes')).scenes || []).map((s) => s.name);
      for (const [id, key] of [['cpv-def-light', 'defaultLight'], ['cpv-def-fan', 'defaultFan']]) {
        const sel = section.querySelector('#' + id); if (!sel) continue;
        sel.innerHTML = '<option value="">(preguntar si hay varias)</option>' + scenes.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
        sel.value = cfg[key] || '';
      }
    } catch (_) { /* sin escenas: se dejan vacíos */ }
  }
  const aliasText = () => Object.entries(cfg.aliases).flatMap(([name, list]) => list.map((a) => `${a} = ${name}`)).join('\n');
  function parseAliases(txt) {
    const out = {};
    for (const line of txt.split('\n')) { const m = /^(.+?)\s*=\s*(.+)$/.exec(line.trim()); if (m) (out[m[2].trim()] = out[m[2].trim()] || []).push(m[1].trim()); }
    return out;
  }

  function bindSection() {
    const $ = (s) => section.querySelector(s);
    $('#cpv-toggle').addEventListener('click', async () => { await voice.toggle(); refreshStatus(); });
    $('#cpv-test').addEventListener('click', () => voice.speak('Hola, así sueno ahora'));
    const auto = $('#cpv-auto'); auto.checked = !!cfg.autoStart;
    auto.addEventListener('change', () => { cfg.autoStart = auto.checked; saveCfg(); });
    const vs = $('#cpv-voice'), fillVoices = () => { const list = voice.esVoices(); vs.innerHTML = '<option value="">(automática)</option>' + list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join(''); vs.value = cfg.voice || ''; };
    if (window.speechSynthesis) { speechSynthesis.addEventListener('voiceschanged', fillVoices); fillVoices(); }
    vs.addEventListener('change', () => { cfg.voice = vs.value; saveCfg(); voice.speak('Hola, así sueno ahora'); });
    for (const [id, key] of [['cpv-pitch', 'pitch'], ['cpv-rate', 'rate']]) {
      const r = $('#' + id), v = $('#' + id + '-v'); r.value = cfg[key]; v.textContent = cfg[key];
      r.addEventListener('input', () => { cfg[key] = Number(r.value); v.textContent = r.value; saveCfg(); });
    }
    for (const [id, key] of [['cpv-def-light', 'defaultLight'], ['cpv-def-fan', 'defaultFan']]) $('#' + id).addEventListener('change', (e) => { cfg[key] = e.target.value; saveCfg(); });
    $('#cpv-alias').value = aliasText();
    $('#cpv-alias-save').addEventListener('click', () => { cfg.aliases = parseAliases($('#cpv-alias').value); saveCfg(); $('#cpv-alias-msg').textContent = 'Guardado ✓'; setTimeout(() => { $('#cpv-alias-msg').textContent = ''; }, 2000); });
    const send = async () => {
      const inp = $('#cpv-text'), txt = inp.value.trim(); if (!txt) return; inp.value = '';
      logLine('me', txt); logLine('bot', await brain.handle(txt, false, { section: currentSection() }));
    };
    $('#cpv-send').addEventListener('click', send);
    $('#cpv-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  }

  function mount() {
    if (!HAS_DOM || document.getElementById(PLUGIN_ID + '-section')) return;
    brain = createBrain({ onAction });
    const ui = {
      setUi: (cls, msg) => { const o = fab && fab.querySelector('#cpv-orb'); if (o) o.className = cls || ''; if (msg) bubble(esc(msg), 4000); refreshStatus(); },
      status: (t) => bubble(esc(t), 5000),
      log: (cls, text) => { logLine(cls, text); if (cls === 'me') bubble(`<span class="me">${esc(text)}</span>`, 30000); else bubble(esc(text), 12000); },
      toast: (t) => window.showToast?.(t, 'info'),
    };
    voice = createVoice(brain, ui);

    fab = document.createElement('div'); fab.id = 'cpv-fab';
    fab.innerHTML = '<div id="cpv-bubble" role="status" aria-live="polite"></div><button id="cpv-orb" type="button" title="Control por voz: toca para activar o pausar">🎙</button>';
    document.body.appendChild(fab);
    fab.querySelector('#cpv-orb').addEventListener('click', async () => { await voice.toggle(); refreshStatus(); });

    const menu = document.querySelector('.nav-category[data-group="plugins"] .nav-category-items');
    navBtn = document.createElement('button'); navBtn.type = 'button'; navBtn.className = 'nav-item';
    navBtn.dataset.section = PLUGIN_ID; navBtn.dataset.pluginNav = PLUGIN_ID; navBtn.title = 'Control por voz';
    navBtn.innerHTML = `${MIC_ICON}<span>Control por voz</span>`;
    navBtn.addEventListener('click', () => window.switchSection?.(PLUGIN_ID));
    menu?.appendChild(navBtn);

    const wrap = document.createElement('div'); wrap.innerHTML = sectionHtml(); section = wrap.firstElementChild;
    document.querySelector('.content')?.insertBefore(section, document.getElementById('gcode-editor-section'));
    bindSection(); refreshStatus(); fillScenes();
    window.applySidebarOrder?.();
    if (cfg.autoStart && voice.supported) setTimeout(() => { if (!voice.isRunning()) voice.toggle().then(refreshStatus); }, 800);
    else if (voice.supported && voice.wasOn()) setTimeout(() => { if (!voice.isRunning()) voice.toggle().then(refreshStatus); }, 800);
  }
  function unmount() {
    voice && voice.destroy();
    document.querySelector(`[data-plugin-nav="${PLUGIN_ID}"]`)?.remove();
    section && section.remove(); fab && fab.remove();
    fab = section = navBtn = null;
  }

  if (typeof window !== 'undefined') {
    window.NopalPluginRegistry = window.NopalPluginRegistry || {};
    window.NopalPluginRegistry[PLUGIN_ID] = { mount, unmount, version: VERSION };
  }
  if (HAS_DOM) mount();
  if (typeof module !== 'undefined' && module.exports) module.exports = { createBrain, norm, lev, fuzzyHas, ordinalPick, _cfg: () => cfg };
})();
