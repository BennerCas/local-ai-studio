/* Registro de agentes (APIs) del enjambre: la vista permite anadir APIs
   compatibles con OpenAI, el servidor las prueba y les habla por proxy,
   y la tarjeta del Director refleja el enjambre activo. */
const test = require('node:test');
const fs = require('fs');
const html = fs.readFileSync('sidecars/local_ai_chat/ui-v2.html', 'utf8');
const srv = fs.readFileSync('sidecars/local_ai_chat/server.js', 'utf8');

test('vista Agentes: formulario de registro de APIs', () => {
  for (const id of ['agName', 'agUrl', 'agKey', 'agModel', 'agCaps', 'agList']) {
    if (!html.includes(`id="${id}"`)) throw new Error('falta #' + id);
  }
  if (!html.includes('saveAgentApi')) throw new Error('falta saveAgentApi');
});

test('registro persistente y enjambre activo en la tarjeta del Director', () => {
  if (!html.includes("localStorage.getItem('las-agents-v1')")) throw new Error('sin persistencia');
  for (const id of ['swAgents', 'swAgOllama', 'swAgFreeai', 'swAgentsMode']) {
    if (!html.includes(`id="${id}"`)) throw new Error('falta #' + id);
  }
  if (!html.includes('swarmModeLabel')) throw new Error('falta swarmModeLabel');
});

test('servidor: proxy /api/agents/test y /api/agents/chat', () => {
  if (!srv.includes('"/api/agents/test"')) throw new Error('falta test');
  if (!srv.includes('"/api/agents/chat"')) throw new Error('falta chat');
  if (!srv.includes('/chat/completions')) throw new Error('sin destino OpenAI');
});

test('ejecutor del enjambre: paralelo + integracion del Director', () => {
  for (const s of ['async function runSwarmPhase', 'Promise.all(f.subtareas.map', 'async function swarmAgentOnce', "api:", 'swarmChatOnce']) {
    if (!html.includes(s)) throw new Error('falta ' + s);
  }
  if (!html.includes('Ejecutar fase en enjambre')) throw new Error('falta boton de enjambre');
  if (!html.includes('INDEPENDIENTES')) throw new Error('el prompt no pide subtareas independientes');
});
