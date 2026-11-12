/* Pestanas de la columna lateral: el cambio nunca puede quedar congelado. */
const test = require('node:test');
const fs = require('fs');
const html = fs.readFileSync('sidecars/local_ai_chat/ui-v2.html', 'utf8');

test('Setup contiene las herramientas de workspace y abre una vista principal', () => {
  for (const tool of ['history', 'gallery', 'code']) {
    if (!html.includes(`class="setup-tool-tab" data-setup-tool="${tool}"`)) throw new Error(`falta Setup/${tool}`);
    if (!html.includes(`id="library-pane-${tool}"`)) throw new Error(`falta vista ${tool}`);
  }
  if (!html.includes('id="view-library"')) throw new Error('falta la vista principal del workspace');
  if (!html.includes('function setupToolTab(name)')) throw new Error('falta el selector anidado de Setup');
});

test('cada herramienta vacía tiene placeholders visuales y manejo de error', () => {
  if (!html.includes('function renderLibraryPlaceholders(kind)')) throw new Error('sin placeholders');
  if (!html.includes('library-placeholder-grid')) throw new Error('sin grid de placeholders');
  if (!html.includes('function renderLibraryError(kind,message)')) throw new Error('sin estado de error');
});
