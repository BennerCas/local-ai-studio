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

test('el constructor explica cada estrategia y compilador y actualiza la indicación al cambiar', () => {
  for (const value of ['auto', 'hybrid', 'cloud', 'manual']) {
    if (!html.includes(`value="${value}"`)) throw new Error(`falta estrategia ${value}`);
  }
  for (const value of ['openrouter', 'freeai']) {
    if (!html.includes(`value="${value}"`)) throw new Error(`falta compilador ${value}`);
  }
  for (const id of ['contextStrategyHint', 'contextProviderHint']) {
    if (!html.includes(`id="${id}"`)) throw new Error(`falta indicación ${id}`);
  }
  if (!html.includes('id="contextScopeSelect"') || !html.includes('id="contextScopeHint"')) throw new Error('falta alcance del contexto');
  for (const phrase of ['Tarea enfocada', 'Mapa global del proyecto', 'Proyecto completo', '¿Cómo utilizar el constructor?', 'máximo de 6k tokens']) {
    if (!html.includes(phrase)) throw new Error(`falta guía del constructor: ${phrase}`);
  }
  if (!html.includes('function updateContextEngineHints()')) throw new Error('falta actualización dinámica de indicaciones');
});
