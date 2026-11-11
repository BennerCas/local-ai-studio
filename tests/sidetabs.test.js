/* Pestanas de la columna lateral: el cambio nunca puede quedar congelado. */
const test = require('node:test');
const fs = require('fs');
const html = fs.readFileSync('sidecars/local_ai_chat/ui-v2.html', 'utf8');

test('sideTab base maneja los 6 paneles con cargadores protegidos', () => {
  if (!html.includes("['setup','project','staff','history','gallery','code']")) throw new Error('no maneja los 6');
  if (!html.includes("console.warn('sideTab:'")) throw new Error('cargadores sin proteger');
});

test('ultimo eslabon: red de seguridad de visibilidad', () => {
  if (!html.includes("console.warn('sideTab staff:'")) throw new Error('sin try/catch');
  if (!html.includes('Nunca mas una columna')) throw new Error('sin red de seguridad');
});
