const http = require("node:http");
const net = require("node:net");
const url = require("node:url");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("../../context-bridge.js");
const freeai = require("../../freeai-bridge.js");

const PORT = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT 
  ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10) 
  : 0;

let currentBackendPort = 8080;
let isBackendReady = false;
let processStarting = false;

const EXE_PATH = "C:\\antigravityAS\\OpenWebUI\\.venv\\Scripts\\open-webui.exe";
const DATA_DIR = "C:\\antigravityAS\\OpenWebUI\\data";

process.on("uncaughtException", (err) => {
  console.error("[Open WebUI Sidecar Uncaught]", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Open WebUI Sidecar Rejection]", reason);
});

function checkOpenWebUIApi(port) {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: "127.0.0.1",
      port: port,
      path: "/api/version",
      timeout: 1200
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json && json.version) return resolve(true);
        } catch (e) {}
        resolve(res.statusCode === 200);
      });
    });

    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function findFreePort(preferred = 0) {
  return new Promise((resolve) => {
    if (!preferred || preferred === 0) {
      const s = net.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
      return;
    }
    const s = net.createServer();
    s.once("error", () => {
      const s2 = net.createServer();
      s2.listen(0, "127.0.0.1", () => {
        const p2 = s2.address().port;
        s2.close(() => resolve(p2));
      });
    });
    s.listen(preferred, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startOpenWebUIProcess(port) {
  if (processStarting) return;
  processStarting = true;

  console.log(`[Open WebUI Sidecar] Iniciando proceso backend en puerto ${port}...`);

  const env = {
    ...process.env,
    DATA_DIR: DATA_DIR,
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OPENAI_API_BASE_URL: freeai.getBaseUrl(),
    OPENAI_API_KEY: freeai.getKey(),
    OPENAI_API_BASE_URLS: freeai.getBaseUrl(),
    OPENAI_API_KEYS: freeai.getKey(),
    PORT: String(port),
    WEBUI_AUTH: "False"
  };

  const child = spawn(EXE_PATH, ["serve", "--host", "127.0.0.1", "--port", String(port)], {
    env: env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });

  child.unref();

  setTimeout(() => {
    processStarting = false;
  }, 10000);
}

async function ensureBackendRunning() {
  if (await checkOpenWebUIApi(currentBackendPort)) {
    isBackendReady = true;
    return currentBackendPort;
  }

  for (let p = 8080; p <= 8085; p++) {
    if (await checkOpenWebUIApi(p)) {
      currentBackendPort = p;
      isBackendReady = true;
      return p;
    }
  }

  const freePort = await findFreePort(8080);
  currentBackendPort = freePort;
  isBackendReady = false;
  startOpenWebUIProcess(freePort);
  return freePort;
}

// HTML con Toolbar Superior de Puente de Contexto de Antigravity + iframe
function getBridgeHtml(port) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open WebUI - Antigravity Bridge</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #12141d;
      font-family: 'Outfit', sans-serif;
      color: #c0caf5;
      display: flex;
      flex-direction: column;
    }

    /* Barra Superior de Sincronización */
    #bridge-toolbar {
      height: 38px;
      background: rgba(22, 25, 38, 0.96);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid rgba(122, 162, 247, 0.2);
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0 14px;
      font-size: 11.5px;
      z-index: 100;
    }

    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .bridge-logo {
      font-weight: 700;
      color: #7aa2f7;
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: 0.3px;
    }

    .project-selector {
      background: #181b2a;
      color: #7dcfff;
      border: 1px solid rgba(125, 207, 255, 0.3);
      border-radius: 6px;
      padding: 3px 8px;
      font-size: 11.5px;
      font-weight: 600;
      outline: none;
      cursor: pointer;
    }

    .btn-tool {
      background: #1b1e2e;
      border: 1px solid rgba(122, 162, 247, 0.25);
      color: #c0caf5;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.2s;
    }

    .btn-tool:hover {
      background: rgba(122, 162, 247, 0.2);
      border-color: #7aa2f7;
      color: #fff;
    }

    .btn-tool.btn-highlight {
      background: rgba(122, 162, 247, 0.18);
      border-color: #7aa2f7;
      color: #7dcfff;
    }

    /* Modal Flotante de Contexto */
    #ctx-modal {
      display: none;
      position: fixed;
      top: 44px;
      left: 14px;
      right: 14px;
      background: #161824;
      border: 1px solid rgba(122, 162, 247, 0.3);
      border-radius: 10px;
      padding: 14px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      z-index: 1000;
      max-height: 80vh;
      overflow-y: auto;
    }

    #ctx-modal.active { display: block; }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }

    .modal-title { font-size: 13.5px; font-weight: 600; color: #fff; }
    .close-modal { background: none; border: none; color: #7982a9; font-size: 16px; cursor: pointer; }

    .ctx-pre {
      background: #0e1017;
      border-radius: 6px;
      padding: 10px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: #c0caf5;
      white-space: pre-wrap;
      max-height: 250px;
      overflow-y: auto;
    }

    /* Toast */
    #toast {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: #1a1e32;
      border: 1px solid #7aa2f7;
      color: #fff;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      display: none;
      z-index: 2000;
    }

    iframe {
      flex: 1;
      width: 100%;
      height: calc(100vh - 38px - 26px);
      border: none;
      display: block;
    }

    /* Margen Inferior / Footer con Firma Clara */
    #bridge-footer {
      height: 26px;
      min-height: 26px;
      background: rgba(18, 20, 29, 0.98);
      backdrop-filter: blur(8px);
      border-top: 1px solid rgba(122, 162, 247, 0.18);
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 10px;
      z-index: 100;
      user-select: none;
    }

    .footer-signature {
      font-size: 11px;
      font-weight: 600;
      color: #7aa2f7;
      letter-spacing: 0.8px;
    }

    .footer-dot {
      width: 4px;
      height: 4px;
      background: #7dcfff;
      border-radius: 50%;
      opacity: 0.6;
    }
  </style>
</head>
<body>

  <!-- Barra Superior -->
  <div id="bridge-toolbar">
    <div class="toolbar-left">
      <div class="bridge-logo">⚡ Antigravity Bridge</div>
      <span>📁</span>
      <select id="project-select" class="project-selector" onchange="onProjectSelectChanged()">
        <option value="">Cargando proyectos...</option>
      </select>
      <span id="active-badge" style="background:rgba(125,207,255,0.12); border:1px solid rgba(125,207,255,0.3); color:#7dcfff; padding:2px 8px; border-radius:12px; font-size:11px; font-weight:600;">General</span>
    </div>
    <div class="toolbar-right">
      <button class="btn-tool btn-highlight" onclick="copyContextToClipboard()" title="Copiar contexto para pegar en Open WebUI">📋 Copiar Contexto del Proyecto</button>
      <button class="btn-tool" onclick="toggleModal()" title="Ver resumen del proyecto">👁️ Ver Resumen</button>
      <button class="btn-tool" onclick="openExternal()" title="Abrir en navegador externo">🌐 Abrir Navegador</button>
    </div>
  </div>

  <!-- Modal de Contexto -->
  <div id="ctx-modal">
    <div class="modal-header">
      <div class="modal-title">🧠 Contexto Sincronizado de Antigravity</div>
      <button class="close-modal" onclick="toggleModal()">✕</button>
    </div>
    <div class="ctx-pre" id="ctx-display">Cargando contexto del proyecto...</div>
  </div>

  <div id="toast"></div>

  <!-- Iframe con soporte nativo completo para WebSockets -->
  <iframe 
    src="http://127.0.0.1:${port}/" 
    allow="clipboard-read; clipboard-write; microphone; camera; geolocation"
    title="Open WebUI">
  </iframe>

  <!-- Margen Inferior / Footer con la Firma -->
  <footer id="bridge-footer">
    <span class="footer-dot"></span>
    <span class="footer-signature">HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®</span>
    <span class="footer-dot"></span>
  </footer>

  <script>
    let currentProject = null;
    let contextMarkdown = '';
    const convId = new URLSearchParams(window.location.search).get('conversationId') || '';

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 2800);
    }

    function toggleModal() {
      const m = document.getElementById('ctx-modal');
      m.classList.toggle('active');
    }

    function extractCleanBadge(opt, activeData) {
      if (opt) {
        const val = opt.value || '';
        if (val.startsWith('proj:')) {
          return val.slice(5).trim();
        }
        const text = opt.textContent || '';
        const match = text.match(/\(([^)]+)\)$/);
        if (match && match[1]) {
          return match[1].trim();
        }
        return text.replace(/^[📌📁💬\s↳]+/, '').trim();
      }
      if (activeData) {
        return activeData.isGeneral ? 'General' : activeData.name;
      }
      return 'General';
    }

    async function loadProjects() {
      try {
        const queryParams = new URLSearchParams(window.location.search);
        const url = '/api/projects?' + queryParams.toString();
        const res = await fetch(url);
        const data = await res.json();
        const sel = document.getElementById('project-select');
        sel.innerHTML = '';

        let matchedSelected = false;

        if (data.hierarchy) {
          // 1. Pinned Conversations
          if (data.hierarchy.pinned && data.hierarchy.pinned.length) {
            const grpPinned = document.createElement('optgroup');
            grpPinned.label = '📌 Pinned Conversations';
            data.hierarchy.pinned.forEach(c => {
              const opt = document.createElement('option');
              opt.value = 'conv:' + c.id;
              opt.textContent = '📌 ' + c.title + ' (' + (c.project || 'General') + ')';
              if (convId && c.id === convId) {
                opt.selected = true;
                matchedSelected = true;
              }
              grpPinned.appendChild(opt);
            });
            sel.appendChild(grpPinned);
          }

          // 2. Projects (con sub-conversaciones)
          if (data.hierarchy.projects && data.hierarchy.projects.length) {
            const grpProjects = document.createElement('optgroup');
            grpProjects.label = '📁 Projects';
            data.hierarchy.projects.forEach(p => {
              const optRoot = document.createElement('option');
              optRoot.value = 'proj:' + p.name;
              optRoot.textContent = '📁 ' + p.name;
              if (!matchedSelected && data.active && !data.active.isGeneral && p.name.toLowerCase() === data.active.name.toLowerCase()) {
                optRoot.selected = true;
                matchedSelected = true;
              }
              grpProjects.appendChild(optRoot);

              if (p.conversations && p.conversations.length) {
                p.conversations.forEach(sc => {
                  const optSub = document.createElement('option');
                  optSub.value = 'conv:' + sc.id;
                  optSub.textContent = '  ↳ 💬 ' + sc.title;
                  if (convId && sc.id === convId) {
                    optSub.selected = true;
                    matchedSelected = true;
                  }
                  grpProjects.appendChild(optSub);
                });
              }
            });
            sel.appendChild(grpProjects);
          }

          // 3. Recent Conversations
          if (data.hierarchy.conversations && data.hierarchy.conversations.length) {
            const grpConvs = document.createElement('optgroup');
            grpConvs.label = '💬 Conversations';
            data.hierarchy.conversations.forEach(c => {
              const opt = document.createElement('option');
              opt.value = 'conv:' + c.id;
              opt.textContent = '💬 ' + c.title + ' (' + (c.project || 'General') + ')';
              if (!matchedSelected && convId && c.id === convId) {
                opt.selected = true;
                matchedSelected = true;
              }
              grpConvs.appendChild(opt);
            });
            sel.appendChild(grpConvs);
          }
        } else if (data.projects && data.projects.length) {
          data.projects.forEach(p => {
            const opt = document.createElement('option');
            opt.value = 'proj:' + p.name;
            opt.textContent = p.name;
            if (data.active && p.name === data.active.name) {
              opt.selected = true;
              matchedSelected = true;
            }
            sel.appendChild(opt);
          });
        }

        // Fallback si nada coincidió explícitamente:
        if (!matchedSelected && data.active) {
          for (let i = 0; i < sel.options.length; i++) {
            const o = sel.options[i];
            if (data.active.convId && o.value === 'conv:' + data.active.convId) {
              o.selected = true;
              matchedSelected = true;
              break;
            }
            if (!data.active.isGeneral && o.value === 'proj:' + data.active.name) {
              o.selected = true;
              matchedSelected = true;
              break;
            }
          }
        }

        const currentVal = sel.value;
        const selectedOpt = sel.selectedOptions[0];
        const initialBadge = extractCleanBadge(selectedOpt, data.active);
        const badgeEl = document.getElementById('active-badge');
        if (badgeEl) badgeEl.textContent = initialBadge;

        await loadContext(currentVal);
      } catch (e) {
        console.error('Error cargando proyectos en Open WebUI:', e);
      }
    }

    async function loadContext(selectedIdentifier) {
      try {
        const q = new URLSearchParams(window.location.search);
        if (selectedIdentifier) {
          if (selectedIdentifier.startsWith('conv:')) {
            q.set('conversationId', selectedIdentifier.slice(5));
            q.delete('project');
          } else if (selectedIdentifier.startsWith('proj:')) {
            q.set('project', selectedIdentifier.slice(5));
            q.delete('conversationId');
          } else {
            q.set('project', selectedIdentifier);
          }
        }

        const res = await fetch('/api/context?' + q.toString());
        const data = await res.json();
        if (data && data.summaryMarkdown) {
          contextMarkdown = data.summaryMarkdown;
          document.getElementById('ctx-display').textContent = data.summaryMarkdown;
        }
      } catch (e) {
        console.error('Error cargando contexto en Open WebUI:', e);
      }
    }

    async function onProjectSelectChanged() {
      const sel = document.getElementById('project-select');
      const val = sel.value;
      if (!val) return;

      const selectedOpt = sel.selectedOptions[0];
      const badgeName = extractCleanBadge(selectedOpt, null);
      const badgeEl = document.getElementById('active-badge');
      if (badgeEl) badgeEl.textContent = badgeName;

      try {
        let payload = { selection: val };
        if (val.startsWith('conv:')) {
          payload.conversationId = val.slice(5);
        } else if (val.startsWith('proj:')) {
          payload.projectName = val.slice(5);
        } else {
          payload.projectName = val;
        }

        await fetch('/api/context/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        currentProject = val;
        await loadContext(val);
        showToast('📁 Contexto sincronizado: ' + badgeName);
      } catch (e) {
        console.error(e);
      }
    }

    function copyContextToClipboard() {
      if (!contextMarkdown) {
        showToast('Cargando contexto...');
        return;
      }
      navigator.clipboard.writeText(contextMarkdown).then(() => {
        showToast('✅ ¡Contexto copiado! Puedes pegarlo en tu chat de Open WebUI.');
        fetch('/api/project/log-progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: currentProject,
            task: 'Contexto copiado a Open WebUI',
            summary: 'Contexto del proyecto activo copiado al portapapeles para interacción con modelos locales.'
          })
        }).catch(() => {});
      }).catch(() => {
        showToast('Selecciona el texto en "Ver Resumen" para copiar.');
      });
    }

    function openExternal() {
      fetch('/api/open-browser', { method: 'POST' });
      showToast('🌐 Abriendo Open WebUI en tu navegador predeterminado...');
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', loadProjects);
    } else {
      loadProjects();
    }
    window.addEventListener('load', loadProjects);

    window.addEventListener('message', async (event) => {
      if (event.data?.type === 'workspace-change') {
        await loadProjects();
      }
    });
  </script>
</body>
</html>`;
}

// Pantalla de carga mientras se conecta el backend
function getLoadingHtml(port) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Open WebUI - Conectando</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600&display=swap" rel="stylesheet">
  <style>
    body {
      background: #12141d;
      color: #c0caf5;
      font-family: 'Outfit', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
      padding: 20px;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(122, 162, 247, 0.2);
      border-top-color: #7aa2f7;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 24px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { font-size: 18px; margin-bottom: 8px; color: #fff; font-weight: 600; }
    p { font-size: 13.5px; color: #7982a9; max-width: 380px; line-height: 1.5; margin-bottom: 16px; }
    .badge {
      display: inline-block;
      padding: 4px 12px;
      background: rgba(122, 162, 247, 0.12);
      border: 1px solid rgba(122, 162, 247, 0.3);
      border-radius: 20px;
      font-size: 12px;
      color: #7aa2f7;
    }
    .footer { position: absolute; bottom: 16px; font-size: 10px; color: #565f89; }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h2>Iniciando Open WebUI Hub</h2>
  <p>Conectando con el servidor en el puerto <strong>${port}</strong>. El panel cargará automáticamente en unos segundos...</p>
  <div class="badge">Sincronizado con Antigravity | Cero Cuota</div>
  <div class="footer">HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®</div>

  <script>
    async function poll() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.ready) {
          window.location.reload();
          return;
        }
      } catch (e) {}
      setTimeout(poll, 1500);
    }
    poll();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/preload.js") {
    const preloadPath = "C:\\Users\\Benner\\.gemini\\antigravity\\lib\\node_modules\\sidecar_sdk\\preload.js";
    try {
      const content = fs.readFileSync(preloadPath, "utf-8");
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(content);
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end("// preload stub");
    }
    return;
  }

  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end();
    return;
  }

  // Endpoints de Sincronización de Contexto de Proyecto
  if (pathname === "/api/projects" && req.method === "GET") {
    const hierarchy = bridge.getSidebarHierarchy();
    const list = bridge.listProjects();
    const convId = query.conversationId || null;
    const token = query.token || null;
    const active = bridge.getActiveProject(null, convId, token);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ hierarchy, projects: list, active: active }));
    return;
  }

  if (pathname === "/api/context" && req.method === "GET") {
    const projName = query.project || null;
    const convId = query.conversationId || null;
    const token = query.token || null;
    const ctx = bridge.buildProjectContext(projName, convId, token);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(ctx || { error: "No project found" }));
    return;
  }

  if (pathname === "/api/context/select" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const target = payload.projectName || payload.selection || null;
        if (target) {
          bridge.setActiveProjectName(target);
        }
        const ctx = bridge.buildProjectContext(target, payload.conversationId);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, active: ctx ? ctx.project : null }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === "/api/project/log-progress" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        bridge.recordProjectProgress(payload.project, {
          tool: "Open WebUI Hub",
          model: "Local / Ollama",
          task: payload.task || "Sincronización de contexto",
          summary: payload.summary || "Contexto del proyecto activo copiado para Open WebUI."
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === "/api/open-browser" && req.method === "POST") {
    const targetUrl = `http://127.0.0.1:${currentBackendPort}/`;
    spawn("cmd.exe", ["/c", "start", targetUrl], { detached: true, stdio: "ignore" }).unref();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: targetUrl }));
    return;
  }

  if (pathname === "/api/freeai/models" && req.method === "GET") {
    freeai.fetchModels()
      .then((models) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ count: models.length, models: models }));
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }

  if (pathname === "/api/status") {
    const ready = await checkOpenWebUIApi(currentBackendPort);
    isBackendReady = ready;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ready: isBackendReady, port: currentBackendPort }));
    return;
  }

  // Cualquier ruta GET sirve la interfaz de Open WebUI con la barra de puente
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    const port = await ensureBackendRunning();
    const ready = await checkOpenWebUIApi(port);
    isBackendReady = ready;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (ready) {
      res.end(getBridgeHtml(port));
    } else {
      res.end(getLoadingHtml(port));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[Open WebUI Sidecar] Puerto ${PORT} en uso, asignando dinámico...`);
    server.listen(0, "127.0.0.1");
  } else {
    console.error("[Open WebUI Sidecar Error]", err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const actualPort = server.address().port;
  console.log(`[Open WebUI Sidecar] Escuchando en http://127.0.0.1:${actualPort}`);
  ensureBackendRunning();
});
