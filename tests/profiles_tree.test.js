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
  if (!html.includes('Sección 2 · Skills')) throw new Error('falta seccion de skills');
});

test('skills del perfil: fallback en navegador si el servidor no las manda', () => {
  if (!html.includes('enrichProfilesSkillsIfNeeded')) throw new Error('sin fallback');
  if (!html.includes('profileMasterCol')) throw new Error('master prompt sin columna');
});

test('reparto 3 columnas estilo estudio: perfiles | descripcion+skills | master prompt', () => {
  if (!html.includes('profileMasterCol')) throw new Error('falta columna master prompt');
  if (!html.includes('Sección 1 · Descripción') || !html.includes('Sección 2 · Skills')) throw new Error('faltan secciones en columna 2');
  if (!html.includes('ps-col')) throw new Error('sin estilo de columna del estudio');
});
