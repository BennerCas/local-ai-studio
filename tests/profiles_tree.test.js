/* Modulo Skills y Perfiles: esquema jerarquico, detalle con skills y Master Prompt */
const test = require('node:test');
const fs = require('fs');
const html = fs.readFileSync('sidecars/local_ai_chat/ui-v2.html', 'utf8');
const bridge = fs.readFileSync('skills-bridge.js', 'utf8');

test('primera pantalla: stats, arbol y detalle', () => {
  for (const id of ['psStats', 'profileTree', 'profileDetail', 'profileSkillsCol']) {
    if (!html.includes(`id="${id}"`)) throw new Error('falta #' + id);
  }
  if (!html.includes('renderProfileTree')) throw new Error('sin arbol');
  if (!html.includes('selectProfileDetail')) throw new Error('sin detalle');
});

test('cada perfil trae sus skills asociadas desde el servidor', () => {
  if (!bridge.includes('suggestSkillsForProfile')) throw new Error('sin asociacion');
  if (!bridge.includes('skillsSugeridas')) throw new Error('sin skillsSugeridas');
});

test('layout pedido: sin fusion, sin buscador, 3 columnas', () => {
  if (html.includes('Fusionar skills')) throw new Error('fusion sigue presente');
  if (html.includes('Buscar skill')) throw new Error('buscador sigue presente');
  if (!html.includes('id="profileSkillsCol"')) throw new Error('falta seccion de skills');
});

test('skills del perfil: fallback en navegador si el servidor no las manda', () => {
  if (!html.includes('enrichProfilesSkillsIfNeeded')) throw new Error('sin fallback');
  if (!html.includes('profileMasterCol')) throw new Error('master prompt sin columna');
});

test('reparto 3 columnas estilo estudio: perfiles | descripcion+skills | master prompt', () => {
  if (!html.includes('profileMasterCol')) throw new Error('falta columna master prompt');
  if (!html.includes('id="profileSkillsCol"') || !html.includes('id="activateSkillsBtn"') || !html.includes('id="treeUseBtn"')) throw new Error('faltan piezas reubicadas');
  if (!html.includes('ps-col')) throw new Error('sin estilo de columna del estudio');
});

test('skills en lista de una columna con tooltip propio', () => {
  if (!html.includes('#profileSkillsCol{display:flex;flex-direction:column')) throw new Error('sin lista');
  if (html.includes('#profileSkillsCol{display:grid')) throw new Error('sigue en rejilla');
  if (!html.includes('data-tip=')) throw new Error('sin tooltip');
  if (!html.includes('sk-main')) throw new Error('sin estructura de lista');
});
test('margenes laterales uniformes en las columnas de perfiles', () => {
  if (html.includes('.cols-ps>div{overflow-y:auto;min-height:0;height:100%;scrollbar-width:none;-ms-overflow-style:none;padding-right:2px}')) throw new Error('regla que pegaba el margen derecho');
  if (!html.includes('padding:16px 20px')) throw new Error('sin margen lateral uniforme');
});

test('columna 3: botones fijos Editar y Guardar del Master Prompt', () => {
  if (!html.includes('id="masterEditBtn"') || !html.includes('id="masterSaveBtn"')) throw new Error('faltan botones');
  if (!html.includes('editMasterPrompt') || !html.includes('saveMasterPrompt')) throw new Error('faltan funciones');
  if (!html.includes("API.post('/api/profiles/content'")) throw new Error('guardar no llama al servidor');
});
test('tag de la columna 2 despues de la descripcion', () => {
  if (!html.includes("el.innerHTML='<h3 class=\"pf-name\">'+esc(pf.name)+'</h3>'")) throw new Error('el tag sigue junto al nombre');
});

test('prototipo temporal de crear perfil (navegable, sin guardar)', () => {
  for (const id of ['psCreate', 'npName', 'npPurpose', 'npPreview', 'npSlug']) {
    if (!html.includes(`id="${id}"`)) throw new Error('falta #' + id);
  }
  if (!html.includes('psShowCreate') || !html.includes('npCreatePrototype')) throw new Error('sin navegacion del prototipo');
  if (!html.includes('PROTOTIPO-CREAR-PERFIL')) throw new Error('prototipo sin marca de retirada');
});

test('prototipo: pestanas Potenciar y Fusionar ademas de Desde cero', () => {
  for (const id of ['npModePower', 'npModeFuse', 'npModeNew', 'npPowProfile', 'npPowPreview', 'npFuseList', 'npFusePreview']) {
    if (!html.includes(`id="${id}"`)) throw new Error('falta #' + id);
  }
  for (const fn of ['psMode', 'npPowDiagnose', 'npFusePreviewUpdate', 'npPowSavePrototype', 'npFuseSavePrototype']) {
    if (!html.includes(fn)) throw new Error('falta ' + fn);
  }
});

test('la seccion view-skills tiene los div balanceados', () => {
  const a = html.indexOf('id="view-skills"');
  const b = html.indexOf('======== MEMORIA');
  const frag = html.slice(a, b);
  const opens = (frag.match(/<div(\s|>)/g) || []).length;
  const closes = (frag.match(/<\/div>/g) || []).length;
  if (opens !== closes) throw new Error('div desbalanceados: ' + opens + ' aperturas vs ' + closes + ' cierres');
});

test('prototipo C/B/A: diff, mesa y asistente por pasos', () => {
  for (const id of ['npPowBefore', 'npPowBlocks', 'npFuseCanvas', 'npFuseChips', 'npStep1', 'npStep2', 'npStep3']) {
    if (!html.includes(`id="${id}"`)) throw new Error('falta #' + id);
  }
  if (!html.includes('npStep')) throw new Error('sin navegacion por pasos');
});
