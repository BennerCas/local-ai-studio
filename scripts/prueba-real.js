#!/usr/bin/env node
/* =====================================================================
   PRUEBA REAL de Local AI Studio contra TUS motores locales.
   Nada simulado: llama a la API de verdad (Ollama, DirectML/Hermes,
   Free.ai), mide tiempos y deja un informe en datos/pruebas/ para
   compartirlo y reparar sobre fallos reales, no supuestos.

   Uso (en tu PC, con el servidor arrancado o deja que lo arranque él):
     node scripts/prueba-real.js              · prueba completa
     node scripts/prueba-real.js --rapido     · sin imagen ni chats largos
     node scripts/prueba-real.js --sin-arranque · no arranca el servidor

   Variables: LOCAL_AI_PORT (8021), LOCAL_AI_DIR_MODEL (id del modelo
   DirectML director; por defecto Hermes-3-8B-UNLOCKED-ONNX-DirectML)
   ===================================================================== */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.LOCAL_AI_PORT || 8021);
const BASE = `http://127.0.0.1:${PORT}`;
const RAPIDO = process.argv.includes('--rapido');
const SIN_ARRANQUE = process.argv.includes('--sin-arranque');
const DIRECTOR = process.env.LOCAL_AI_DIR_MODEL || 'Hermes-3-8B-UNLOCKED-ONNX-DirectML';
const ROOT = path.join(__dirname, '..');

const results = [];
function log(icon, name, ok, detail, ms) {
  results.push({ name, ok: !!ok, detail: String(detail || ''), ms: ms || 0 });
  console.log(`${ok ? '✔' : '✘'} ${name}${ms ? ` · ${ms} ms` : ''} — ${detail}`);
}
async function fetchT(url, opts = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}
async function getJson(p, timeoutMs = 30000) {
  const r = await fetchT(BASE + p, {}, timeoutMs);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
async function postJson(p, body, timeoutMs = 60000) {
  const r = await fetchT(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}
/* Chat en streaming (SSE/NDJSON) tal como lo consume la interfaz */
async function chatOnce({ source, model, prompt, profileId, timeoutMs = 240000 }) {
  const t0 = Date.now();
  const r = await fetchT(BASE + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, stream: true, source,
      isDirectML: source === 'directml', isFreeAi: source === 'freeai',
      profileId: profileId || undefined,
      messages: [{ role: 'user', content: prompt }]
    })
  }, timeoutMs);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
  const dec = new TextDecoder(); let buf = '', full = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim(); if (!t) continue;
      if (t.startsWith('data:')) {
        const js = t.slice(5).trim(); if (js === '[DONE]') continue;
        try { const p = JSON.parse(js); full += (p.choices && p.choices[0] && p.choices[0].delta && p.choices[0].delta.content) || ''; } catch (_e) {}
        continue;
      }
      try { const p = JSON.parse(t); if (p.error) throw new Error(p.error); full += (p.message && p.message.content) || p.response || ''; } catch (e) { if (!/JSON/.test(e.message)) throw e; }
    }
  }
  return { text: full.trim(), ms: Date.now() - t0 };
}
async function getJson8002(p) {
  const r = await fetchT('http://127.0.0.1:8002' + p, {}, 30000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || j.error?.message || ('HTTP ' + r.status));
  return j;
}
async function serverAlive() {
  try { await getJson('/api/version', 4000); return true; } catch (_e) { return false; }
}

(async () => {
  console.log(`\n🧪 PRUEBA REAL · ${BASE} · ${RAPIDO ? 'modo rápido' : 'completa'}\n`);
  let child = null;
  if (!(await serverAlive())) {
    if (SIN_ARRANQUE) { console.log('✘ El servidor no responde y --sin-arranque está activo. Arranca la app y repite.'); process.exit(2); }
    console.log('… El servidor no responde: lo arranco yo (sidecars/local_ai_chat/server.js)');
    child = spawn(process.execPath, [path.join(ROOT, 'sidecars/local_ai_chat/server.js')], {
      env: { ...process.env, ANTIGRAVITY_SIDECAR_WEB_PORT: String(PORT) }, stdio: 'ignore', detached: false
    });
    for (let i = 0; i < 40 && !(await serverAlive()); i++) await new Promise(r => setTimeout(r, 500));
  }
  log('🖥', 'Servidor Studio', await serverAlive(), BASE);

  /* ---------- Catálogo y motores ---------- */
  let tags = {};
  try { tags = await getJson('/api/tags'); log('📚', 'Catálogo /api/tags', true, `${(tags.localModels || []).length} Ollama · ${(tags.directmlModels || []).length} DirectML · ${(tags.freeAiModels || []).length} Free.ai`); }
  catch (e) { log('📚', 'Catálogo /api/tags', false, e.message); }
  const dmlModels = (tags.directmlModels || []).map(m => m.id || m.name);
  log('🎮', 'Hermes director en catálogo', dmlModels.includes(DIRECTOR), dmlModels.includes(DIRECTOR) ? DIRECTOR : 'no aparece; DirectML: ' + (dmlModels.join(', ') || 'ninguno'));

  try { const s = await getJson('/api/ollama/status'); log('🦙', 'Ollama', s.isAlive, s.isAlive ? `${s.modelsCount || 0} modelos` : 'detenido'); }
  catch (e) { log('🦙', 'Ollama', false, e.message); }

  let dml = {};
  try { dml = await getJson('/api/directml/status'); log('🎮', 'DirectML estado', true, dml.isAlive ? 'activo' : 'detenido'); }
  catch (e) { log('🎮', 'DirectML estado', false, e.message); }
  if (!dml.isAlive) {
    try { await postJson('/api/directml/start', {}, 120000); log('🎮', 'DirectML arranque', true, 'start aceptado'); }
    catch (e) { log('🎮', 'DirectML arranque', false, e.message); }
  }
  try { await postJson('/api/directml/load', { model: DIRECTOR }, 300000); log('🎮', 'Carga del Director (Hermes)', true, DIRECTOR); }
  catch (e) { log('🎮', 'Carga del Director (Hermes)', false, e.message + ' · (si tu Hermes se carga solo al chatear, la siguiente prueba es la que manda)'); }

  /* ---------- Chats reales, un motor cada uno ---------- */
  const promptCorto = 'Responde en una sola frase: ¿qué modelo eres y estás listo para dirigir un staff de vibe coding?';
  try {
    const r = await chatOnce({ source: 'directml', model: DIRECTOR, prompt: promptCorto });
    log('🐝', 'CHAT Director · Hermes DirectML', r.text.length > 3, r.text.slice(0, 160) || 'sin texto', r.ms);
  } catch (e) { log('🐝', 'CHAT Director · Hermes DirectML', false, e.message); }

  const candidatos = (tags.localModels || [])
    .map(m => m.id || m.name)
    .filter(n => n && !/cloud/i.test(n))
    .slice(0, 4);
  if (candidatos.length) {
    let hecho = false;
    for (const name of candidatos) {
      try {
        const r = await chatOnce({ source: 'ollama', model: name, prompt: promptCorto, timeoutMs: 120000 });
        log('🦙', 'CHAT Ollama · ' + name, r.text.length > 3, r.text.slice(0, 160) || 'sin texto', r.ms);
        hecho = r.text.length > 3;
        if (hecho) break;
      } catch (e) { log('🦙', 'CHAT Ollama · ' + name, false, e.message); }
    }
    if (!hecho) log('🦙', 'CHAT Ollama (resumen)', false, 'ningún candidato local respondió. Si el error menciona ROCm/kernel image: tu RX 7600 (gfx1102) necesita HSA_OVERRIDE_GFX_VERSION=11.0.0 y reiniciar Ollama. Si menciona créditos: eran modelos cloud. Detalle en las líneas anteriores.');
  } else log('🦙', 'CHAT Ollama', false, 'sin modelos locales en el catálogo (solo cloud o ninguno; omitido, no es fallo de la app)');

  /* Sonda DirectML: qué modelos anuncia y qué variante de llamada produce texto */
  try {
    const r = await getJson8002('/v1/models');
    const ids = (r.data || r.models || []).map(m => m.id || m.name || m);
    log('🔬', 'DirectML /v1/models', ids.length > 0, ids.join(', ') || JSON.stringify(r).slice(0, 200));
  } catch (e) { log('🔬', 'DirectML /v1/models', false, e.message); }
  async function probeDml(label, body) {
    const t0 = Date.now();
    try {
      const r = await fetchT('http://127.0.0.1:8002/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(body)
      }, 180000);
      const raw = await r.text();
      let text = '';
      try { const j = JSON.parse(raw); text = (j.choices && j.choices[0] && (j.choices[0].message?.content || j.choices[0].text)) || ''; } catch (_e) {}
      if (!text) { const m = [...raw.matchAll(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/g)]; text = m.map(x => x[1]).join('').slice(0, 120); }
      log('🔬', 'Sonda ' + label, raw.length > 0 && !!text, `HTTP ${r.status} · ${raw.length} bytes · texto: ${text || '(vacío)'} · crudo: ${raw.slice(0, 220).replace(/\n/g, ' ')}`, Date.now() - t0);
      return !!text;
    } catch (e) { log('🔬', 'Sonda ' + label, false, e.message); return false; }
  }
  const sondaMsg = [{ role: 'user', content: 'Di solo: HERMES OK' }];
  await probeDml('stream con id exacto', { model: DIRECTOR, messages: sondaMsg, stream: true, max_tokens: 64, temperature: 0.3 });
  await probeDml('SIN stream con id exacto', { model: DIRECTOR, messages: sondaMsg, stream: false, max_tokens: 64, temperature: 0.3 });
  await probeDml('SIN stream sin campo model', { messages: sondaMsg, stream: false, max_tokens: 64, temperature: 0.3 });

  try {
    const r = await chatOnce({ source: 'freeai', model: undefined, prompt: promptCorto, timeoutMs: 120000 });
    log('☁️', 'CHAT Free.ai', r.text.length > 3, r.text.slice(0, 160) || 'sin texto', r.ms);
  } catch (e) { log('☁️', 'CHAT Free.ai', false, e.message + ' · (si estás offline, el Staff degrada a Hermes: es lo esperado)'); }

  /* ---------- El Director planifica (staff-json de verdad) ---------- */
  if (!RAPIDO) {
    try {
      const r = await chatOnce({
        source: 'directml', model: DIRECTOR, profileId: 'specialized/director-staff-vibecoding', timeoutMs: 300000,
        prompt: 'Idea del usuario: quiero una landing page sencilla para mi estudio de grabación, con modo oscuro y un botón de contacto. Diseña el plan y el staff siguiendo tu formato obligatorio (resumen breve + bloque ```staff-json).'
      });
      const okJson = /```(?:staff-json|json)?\s*\{[\s\S]*?"fases"[\s\S]*?\}\s*```/.test(r.text) || /\{\s*"objetivo"[\s\S]*"fases"/.test(r.text);
      log('🐝', 'Director planifica (staff-json)', okJson, okJson ? 'bloque staff-json recibido' : 'respondió sin staff-json: ' + r.text.slice(0, 200), r.ms);
    } catch (e) { log('🐝', 'Director planifica (staff-json)', false, e.message); }
  }

  /* ---------- Imagen real (la parte más lenta) ---------- */
  if (!RAPIDO) {
    const t0 = Date.now();
    try {
      const r = await postJson('/api/freeai/image/generate', {
        prompt: 'A small red house on a green hill, blue sky, flat illustration', model: 'flux2-klein',
        width: 512, height: 512, steps: 8, guidance_scale: 7.5
      }, 600000);
      const src = r.imageDataUrl || r.imageUrl || r.url || '';
      log('🎨', 'Imagen · FLUX.2 Klein 512px', !!src, src ? `imagen recibida (${src.slice(0, 24)}…) · modelo ${r.model || '?'}` : 'respuesta sin imagen', Date.now() - t0);
    } catch (e) { log('🎨', 'Imagen · FLUX.2 Klein 512px', false, e.message, Date.now() - t0); }
  }

  /* ---------- Voz ---------- */
  try { const t = await getJson('/api/tts/status'); log('🔊', 'TTS local', t.ok !== false, `${(t.voices || []).length} voces`); }
  catch (e) { log('🔊', 'TTS local', false, e.message); }

  /* Cola del log del backend DirectML (la traza del error vive ahí) */
  try {
    const logPath = path.join(ROOT, 'datos', 'pruebas', 'directml-backend.log');
    if (fs.existsSync(logPath)) {
      const tail = fs.readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n').trim();
      log('📜', 'Log backend DirectML', tail.length > 0, tail.slice(-500) || '(vacío)');
    } else log('📜', 'Log backend DirectML', false, 'aún no existe: se crea cuando el Studio arranca el backend (reinicia el Studio tras git pull)');
  } catch (e) { log('📜', 'Log backend DirectML', false, e.message); }

  /* ---------- Informe ---------- */
  const dir = path.join(ROOT, 'datos', 'pruebas');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const okN = results.filter(r => r.ok).length;
  const md = [
    `# 🧪 Informe de prueba REAL · ${new Date().toLocaleString('es')}`,
    '',
    `Servidor: ${BASE} · Modo: ${RAPIDO ? 'rápido' : 'completa'} · Director: ${DIRECTOR}`,
    '',
    '| Prueba | Resultado | Tiempo | Detalle |',
    '|---|---|---|---|',
    ...results.map(r => `| ${r.name} | ${r.ok ? '✔' : '✘'} | ${r.ms || 0} ms | ${String(r.detail).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300)} |`),
    '',
    `**Resumen: ${okN}/${results.length} en verde.**`,
    'Comparte este archivo (o el .json hermano) en el chat de Arena para reparar sobre fallos reales.',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(dir, `informe-${stamp}.md`), md);
  fs.writeFileSync(path.join(dir, `informe-${stamp}.json`), JSON.stringify({ fecha: new Date().toISOString(), base: BASE, director: DIRECTOR, results }, null, 2));
  console.log(`\n📄 Informe guardado en datos/pruebas/informe-${stamp}.md · ${okN}/${results.length} en verde`);
  if (child) { child.kill(); }
  process.exit(okN === results.length ? 0 : 1);
})().catch(e => { console.error('Error fatal del probador:', e); process.exit(2); });
