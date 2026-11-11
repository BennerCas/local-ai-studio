/* Guardado real del Master Prompt de un perfil (Editar/Guardar de la columna 3) */
const test = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'las-profiles-'));
const catDir = path.join(tmp, 'testing');
fs.mkdirSync(catDir, { recursive: true });
const file = path.join(catDir, 'perfil-prueba.md');
fs.writeFileSync(file, '---\nname: Perfil Prueba\n---\n# Master Prompt original\n', 'utf8');
process.env.LOCAL_AI_PROFILES_DIRS = tmp;
process.env.LOCAL_AI_MEMORY_DIR = path.join(tmp, 'mem');
const bridge = require('../skills-bridge.js');

test('guardar escribe el nuevo Master Prompt en la ficha del perfil', () => {
  const r = bridge.saveProfileContent('testing/perfil-prueba', '# Master Prompt editado\n');
  if (!r.ok) throw new Error('no guardo: ' + (r.error || ''));
  const now = fs.readFileSync(file, 'utf8');
  if (!now.includes('Master Prompt editado')) throw new Error('el archivo no cambio');
});

test('guardar rechaza vacio y perfiles inexistentes', () => {
  if (bridge.saveProfileContent('testing/perfil-prueba', '   ').ok) throw new Error('acepto vacio');
  if (bridge.saveProfileContent('testing/no-existe', 'x').ok) throw new Error('acepto inexistente');
});

test('el servidor expone POST /api/profiles/content', () => {
  const server = fs.readFileSync('sidecars/local_ai_chat/server.js', 'utf8');
  if (!server.includes('"/api/profiles/content" && req.method === "POST"')) throw new Error('sin endpoint POST');
  if (!server.includes('saveProfileContent')) throw new Error('sin puente de guardado');
});

test('crear perfil nuevo escribe el .md y rechaza duplicados y slugs malos', () => {
  const r = bridge.createProfileFile({ category: 'fusions', slug: 'fusion-prueba', content: '# Fusión de prueba\n' });
  if (!r.ok) throw new Error('no creo: ' + (r.error || ''));
  if (!fs.existsSync(path.join(tmp, 'fusions', 'fusion-prueba.md'))) throw new Error('no existe el archivo');
  if (bridge.createProfileFile({ category: 'fusions', slug: 'fusion-prueba', content: 'x' }).ok) throw new Error('acepto duplicado');
  if (bridge.createProfileFile({ category: 'fusions', slug: 'Slug Malo!', content: 'x' }).ok) throw new Error('acepto slug invalido');
});

test('el servidor expone POST /api/profiles/create', () => {
  const server = fs.readFileSync('sidecars/local_ai_chat/server.js', 'utf8');
  if (!server.includes('"/api/profiles/create" && req.method === "POST"')) throw new Error('sin endpoint create');
});
