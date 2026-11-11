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
  if (!html.includes('Sus 8 skills')) throw new Error('falta columna de 8 skills');
});
