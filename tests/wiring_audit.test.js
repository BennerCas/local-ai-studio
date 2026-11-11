const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'sidecars/local_ai_chat/ui-v2.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'sidecars/local_ai_chat/server.js'), 'utf8');

test('ningún texto en modo demo/simulado queda en la interfaz v2', () => {
  assert.ok(!/\(demo\)|DemoVibe|REPLIES=|simulado con streaming/.test(html), 'queda contenido demo en ui-v2.html');
});

test('todos los onclick llaman a funciones definidas', () => {
  const handlers = new Set();
  for (const m of html.matchAll(/onclick="([a-zA-Z_$][\w$]*)\s*\(/g)) handlers.add(m[1]);
  const defined = new Set();
  for (const m of html.matchAll(/function\s+([a-zA-Z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
  for (const m of html.matchAll(/(?:^|\n)\s*([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?function/g)) defined.add(m[1]);
  for (const m of html.matchAll(/(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g)) defined.add(m[1]);
  const allowed = new Set(['document', 'window', 'navigator', 'localStorage']);
  const missing = [...handlers].filter(f => !defined.has(f) && !allowed.has(f));
  assert.deepStrictEqual(missing, []);
});

test('todas las rutas /api usadas por la UI existen en el servidor', () => {
  const calls = new Set();
  for (const m of html.matchAll(/API\.(?:get|post)\('([^']+)'/g)) calls.add(m[1].split('?')[0]);
  for (const m of html.matchAll(/fetch\('(\/api\/[^']+)'/g)) calls.add(m[1].split('?')[0]);
  const missing = [...calls].filter(r => !server.includes('"' + r + '"') && !server.includes("'" + r + "'"));
  assert.deepStrictEqual(missing, []);
});

test('los controles antes demo están cableados a funciones reales', () => {
  for (const fn of ['restoreLatestBackup', 'diagDirectML', 'showFreeAiModels', 'applyTuningVar', 'copySafeReport', 'applyChatFontSize', 'savePref', 'tabPreviewReal', 'openChatReal'])
    assert.match(html, new RegExp('function ' + fn + '\\b|' + fn + '=async function'), fn + ' no definida');
  for (const route of ['/api/project/backups', '/api/directml/status', '/api/freeai/models', '/api/system/apply-tuning', '/api/memory/chat?id='])
    assert.ok(html.includes(route), 'ruta no usada: ' + route);
});
