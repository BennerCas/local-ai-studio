const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'sidecars/local_ai_chat/ui-v2.html'), 'utf8');

test('STAFF AI es la pestaña por defecto al iniciar', () => {
  assert.match(html, /sideTab\('staff'\); \/\* STAFF AI es la pestaña por defecto al iniciar \*\//);
});

test('el perfil del Director está forjado y completo en perfiles/', () => {
  const f = path.join(__dirname, '..', 'perfiles/specialized/director-staff-vibecoding.md');
  const txt = fs.readFileSync(f, 'utf8');
  assert.ok(txt.length > 3000, 'perfil demasiado corto: ' + txt.length);
  for (const s of ['Protocolo de traducción', 'Motor y censura', 'Reglas de oro', 'Formatos de salida', 'Arranque de sesión', 'staff-json'])
    assert.ok(txt.includes(s), 'falta sección: ' + s);
});

test('al activar STAFF AI entra el Director con sus skills y se muestra su panel en el chat', () => {
  assert.match(html, /id="staffWelcome"/);
  assert.match(html, /id="staffGreeting"/);
  assert.match(html, /function enterStaffMode\(\)/);
  assert.match(html, /REAL.profileId=DIRECTOR_PROFILE/);
  assert.match(html, /const DIRECTOR_SKILLS=\['ai-agents-architect'/);
});

test('motor del Staff: híbrido con degradación a solo local, y el Director siempre piensa en local', () => {
  assert.match(html, /id="staffMotorSel"/);
  assert.match(html, /las-staff-motor/);
  assert.match(html, /async function checkFreeAi\(\)/);
});

test('el Director es Hermes-3-8B-UNLOCKED (Q8 ONNX DirectML), fijo y sin censura', () => {
  assert.match(html, /const DIRECTOR_MODEL_ID='Hermes-3-8B-UNLOCKED-ONNX-DirectML'/);
  assert.match(html, /const source='directml'; \/\* 🐝 El Director es Hermes/);
  assert.match(html, /!staffComboHas\('freeai'\) && source==='freeai'\)\{ source='directml'/);
});

test('sin botones sueltos: tarjetas Modo Híbrido y Perfil con edición en el panel del Director', () => {
  assert.match(html, /id="staffGreeting"/);
  assert.match(html, /function openDirectorEditor\(\)/);
  assert.match(html, /id="directorModal"/);
  assert.match(html, /id="composerMotorBtns"/);
  assert.match(html, /function saveDirectorExtra\(\)/);
});

test('cada mensaje en STAFF AI se traduce a vibe coding antes de enviarse', () => {
  assert.match(html, /function staffTranslatePayload\(hist\)/);
  assert.match(html, /TRADUCCIÓN VIBE CODING/);
  assert.match(html, /staffTranslatePayload\(REAL\.hist\)/);
});

test('combo hibrido: los 4 combos con DirectML siempre de Director', () => {
  for (const v of ['dml-ollama-freeai', 'dml-ollama', 'dml-freeai', 'dml-ollama-freeai-apis']) {
    assert.match(html, new RegExp('value="' + v + '"'));
  }
  assert.match(html, /STAFF_COMBOS/);
  assert.match(html, /staffComboMotors/);
  assert.match(html, /las-staff-combo/);
});

test('barra superior: selector de Modo y Swarm activo sincronizados en tiempo real', () => {
  assert.match(html, /id="topSwarm"/);
  assert.match(html, /function syncComboUI\(\)/);
  assert.match(html, /function staffComboFromBuiltins\(\)/);
  if (html.includes('id="dotOllama"')) throw new Error('pildoras viejas presentes');
  assert.match(html, /id="staffWeather"/);
  assert.match(html, /api.open-meteo.com/);
});

test('saludo de Staff sin tarjetas: logo, pregunta y clima de Piura', () => {
  if (html.includes('mac-widget')) throw new Error('sigue el widget en tarjeta');
  assert.match(html, /latitude=-5\.1945&longitude=-80\.6328/);
  assert.match(html, /staff-on #chatEmpty/);
  assert.match(html, /¿En qué trabajamos hoy\?/);
});
