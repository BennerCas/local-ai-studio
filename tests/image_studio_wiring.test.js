const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'sidecars/local_ai_chat/ui-v2.html'), 'utf8');
const bridge = fs.readFileSync(path.join(__dirname, '..', 'freeai-bridge.js'), 'utf8');

function bodyOf(name) {
  const i = html.indexOf(name);
  assert.ok(i > -1, name + ' no encontrada');
  return html.slice(i, i + 2600);
}

test('Estudio de Imagen: un solo dueño para el botón Editar (sin doble cableado)', () => {
  assert.ok(!html.includes('function wireImageEdit'), 'wireImageEdit competidor sigue presente');
  assert.match(html, /function wireEditById\(\)/);
  assert.match(html, /getElementById\('editLoadBtn'\)/);
});

test('Generar con un modelo de edición redirige a la pestaña Editar (el bridge rechaza ese modo en /generate)', () => {
  const b = bodyOf('async function genImg');
  assert.match(b, /IMG_MODEL_MODES/);
  assert.match(b, /mode!=='generate'/);
  assert.match(b, /imgTab\('editar'\)/);
  assert.match(b, /editOpChange\(opMap\[model\]\)/);
  assert.match(html, /let IMG_MODEL_MODES=\{\}/);
});

test('Editar desde el lightbox carga la imagen en la pestaña Editar (no llama a /edit con el modelo de generación)', () => {
  const b = bodyOf('async function editFromLightbox');
  assert.match(b, /imgTab\('editar'\)/);
  assert.match(b, /EDIT_STATE=\{dataUrl/);
  assert.ok(!b.includes("/api/freeai/image/edit"), 'editFromLightbox vuelve a llamar al endpoint con modelo incorrecto');
});

test('applyEdit valida la instrucción y envía solo campos que el bridge acepta', () => {
  const b = bodyOf('async function applyEdit');
  assert.match(b, /necesitaPrompt/);
  for (const f of ['imageDataUrl', 'negativePrompt', 'strength', 'scale', 'controlImage', 'controlStrength', 'autoSaveToProject'])
    assert.ok(b.includes(f), 'applyEdit no envía ' + f);
  for (const f of ['guidance_scale', 'negativePrompt', 'controlStrength', 'imageDataUrl'])
    assert.ok(bridge.includes(f), 'el bridge no reconoce ' + f);
});

test('todos los controles del Estudio tienen función definida y endpoint real', () => {
  const view = html.slice(html.indexOf('id="view-imagen"'), html.indexOf('id="view-voz"'));
  const handlers = new Set();
  for (const m of view.matchAll(/onclick="([a-zA-Z_$][\w$]*)\s*\(/g)) handlers.add(m[1]);
  const defined = new Set();
  for (const m of html.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of html.matchAll(/(?:^|\n)\s*([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function/g)) defined.add(m[1]);
  const allowed = new Set(['document', 'window', 'navigator']);
  assert.deepStrictEqual([...handlers].filter(f => !defined.has(f) && !allowed.has(f)), []);
  for (const r of ['/api/freeai/image/generate', '/api/freeai/image/edit', '/api/freeai/image-models', '/api/gallery'])
    assert.ok(view.includes(r) || html.includes(r), 'sin uso de ' + r);
});
