const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { FREE_SELF_HOSTED_IMAGE_MODELS } = require('../freeai-bridge.js');

function loadMasters() {
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'sidecars/local_ai_chat/ui-v2.html'), 'utf8');
  const start = html.indexOf('function _mp(o){');
  const end = html.indexOf('const MASTER_FIELDS=');
  assert.ok(start > -1 && end > start, 'bloque de masters profesionales no encontrado');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(html.slice(start, end) + '\nthis.G=MASTER_GEN_DEFAULTS; this.E=MASTER_EDIT_DEFAULTS; this.SG=MASTER_SPECS_GEN; this.SE=MASTER_SPECS_EDIT;', ctx);
  return { html, ...ctx };
}

test('los 11 modelos del catálogo tienen master +, −, Sorpréndeme y Atomizar', () => {
  const { G } = loadMasters();
  const ids = FREE_SELF_HOSTED_IMAGE_MODELS.map(m => m.id);
  assert.strictEqual(ids.length, 11);
  assert.deepStrictEqual(Object.keys(G).sort(), [...ids].sort());
  for (const id of ids) for (const f of ['pos', 'neg', 'surprise', 'atomize'])
    assert.ok(G[id][f] && G[id][f].length > 100, `${id}.${f} vacío o demasiado corto`);
});

test('los masters son profesionales: framework, reglas duras y control de calidad por modelo', () => {
  const { G, E } = loadMasters();
  for (const [id, m] of Object.entries(G)) {
    assert.match(m.pos, /FRAMEWORK:/, id + ' sin framework');
    assert.match(m.pos, /HARD RULES/, id + ' sin reglas');
    assert.match(m.pos, /QUALITY GATE/, id + ' sin QC');
    assert.ok(m.pos.length > 900, id + ' pos demasiado básico (' + m.pos.length + ' chars)');
    assert.match(m.surprise, /NOVELTY|novedad|original/i, id + ' surprise sin framework de novedad');
    assert.match(m.atomize, /ATOMIZATION|ATOMIZ/i, id + ' atomize sin framework');
    assert.match(m.atomize, /RECOMBINACIÓN SUGERIDA/, id + ' atomize sin recombinación');
  }
  for (const op of ['qwen-image-edit', 'sdxl-edit', 'step1x-edit', 'deoldify', 'realesrgan', 'sam', 'controlnet'])
    assert.ok(E[op] && E[op].pos.length > 500, 'edición sin masters profesionales: ' + op);
});

test('frameworks específicos y distintos por arquitectura (no genéricos)', () => {
  const { SG } = loadMasters();
  assert.match(SG['flux2-klein'].framework, /CINEMATOGRAPHIC SCENE-GRAPH/);
  assert.match(SG['qwen-image-2512'].framework, /TYPOGRAPHY PROTOCOL/);
  assert.match(SG['sdxl'].framework, /TOKEN HIERARCHY/);
  assert.match(SG['controlnet-union-sdxl-promax'].framework, /STRUCTURE-LOCK/);
  assert.match(SG['sam'].framework, /REFERRING EXPRESSION/);
  assert.match(SG['realesrgan'].framework, /FIDELITY-FIRST/);
  const frameworks = Object.values(SG).map(s => s.framework);
  assert.strictEqual(new Set(frameworks).size, frameworks.length, 'frameworks repetidos');
});

test('el cambio de modelo sincroniza los masters automáticamente (cableado UI)', () => {
  const { html } = loadMasters();
  assert.match(html, /id="imgModel" onchange="onGenModelChanged\(\)"/);
  assert.match(html, /function syncMasterStatus\(\)/);
  assert.match(html, /getMaster\('gen', model, 'surprise'\)/);
  assert.match(html, /getMaster\('gen', model, 'atomize'\)/);
  assert.match(html, /las-master-gen-v2/);
  assert.match(html, /id="masterSurprise"/);
  assert.match(html, /id="masterAtomize"/);
});

function loadIO() {
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'sidecars/local_ai_chat/ui-v2.html'), 'utf8');
  const s1 = html.indexOf('function _mp(o){');
  const e1 = html.indexOf('const MASTER_FIELDS=', s1) + 'const MASTER_FIELDS='.length + "['pos','neg','surprise','atomize'];".length;
  const s2 = html.indexOf('const MASTER_FIELD_TITLES=');
  const e2 = html.indexOf("window.addEventListener('DOMContentLoaded', ()=>{\n  const inp=document.getElementById('masterImportFile');", s2);
  assert.ok(s1 > -1 && s2 > s1 && e2 > s2, 'segmentos de masters/IO no encontrados');
  const store = {};
  const ctx = {
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    toast: () => {}, console,
  };
  ctx.masterStore = scope => { try { return JSON.parse(ctx.localStorage.getItem(scope === 'gen' ? 'las-master-gen-v2' : 'las-master-edit-v2') || '{}'); } catch (e) { return {}; } };
  vm.createContext(ctx);
  vm.runInContext(html.slice(s1, e1) + `
    this.getMaster = function(scope, model, field){ const defs = scope==='gen'?MASTER_GEN_DEFAULTS:MASTER_EDIT_DEFAULTS; const over = masterStore(scope); let m = (over&&over[model])||defs[model]; if(!m){ const f=Object.keys(defs)[0]; m=(over&&over[f])||defs[f]; } return m?(m[field]||''):''; };
  ` + html.slice(s2, e2) + '\nthis.audit=auditMasterPrompts; this.build=buildMasterPromptsMarkdown; this.parse=parseMasterPromptsMarkdown; this.G=MASTER_GEN_DEFAULTS; this.E=MASTER_EDIT_DEFAULTS;', ctx);
  return ctx;
}

test('auditoría: TODOS los masters (gen + edit) cumplen la misma exigencia', () => {
  const ctx = loadIO();
  assert.strictEqual(ctx.audit().length, 0, 'avisos: '+ctx.audit().join(' | '));
  for (const [id, m] of Object.entries(ctx.E))
    for (const f of ['pos', 'neg', 'surprise', 'atomize'])
      assert.ok(m[f].length >= 1000, `EDIT ${id}.${f} bajo mínimos: ${m[f].length}`);
});

test('exportar masterprompts.md incluye contexto, cohesión y TODOS los masters del Estudio', () => {
  const ctx = loadIO();
  const md = ctx.build();
  assert.match(md, /## 0 · Contexto/);
  assert.match(md, /Lógica de activación \(cohesión del sistema\)/);
  assert.match(md, /Instrucciones para el agente IA/);
  assert.strictEqual((md.match(/^## GEN · /gm) || []).length, 11);
  assert.strictEqual((md.match(/^## EDIT · /gm) || []).length, 7);
  assert.strictEqual((md.match(/^### (POS|NEG|SURPRISE|ATOMIZE)$/gm) || []).length, 72);
});

test('importar masterprompts.md: ida y vuelta parsea y actualiza los 72 masters', () => {
  const ctx = loadIO();
  const found = ctx.parse(ctx.build());
  assert.strictEqual(Object.keys(found.gen).length, 11);
  assert.strictEqual(Object.keys(found.edit).length, 7);
  const total = [...Object.values(found.gen), ...Object.values(found.edit)]
    .reduce((n, e) => n + Object.keys(e).length, 0);
  assert.strictEqual(total, 72);
  assert.strictEqual(found.gen['sdxl'].pos, ctx.G['sdxl'].pos);
  assert.strictEqual(found.edit['sam'].atomize, ctx.E['sam'].atomize);
});

test('la tuerca ⚙ con importar/exportar está bajo el visor de la biblioteca', () => {
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'sidecars/local_ai_chat/ui-v2.html'), 'utf8');
  assert.match(html, /id="masterGearBtn"[^>]*onclick="[^"]*masterGearMenu/);
  assert.match(html, /onclick="exportMasterPrompts\(\)">⬇️ Exportar masterprompts\.md/);
  assert.match(html, /⬆️ Importar masterprompts\.md/);
  assert.match(html, /file\.name\.toLowerCase\(\)!=='masterprompts\.md'/);
  assert.match(html, /las-master-gen-v2/);
});
