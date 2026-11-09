const http = require("node:http");
const url = require("node:url");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const bridge = require("../../context-bridge.js");
const freeai = require("../../freeai-bridge.js");
const skillsBridge = require("../../skills-bridge.js");

const PORT = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT 
  ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10) 
  : 63719;

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const DIRECTML_HOST = "127.0.0.1";
const DIRECTML_PORT = 8002;
const DIRECTML_SCRIPT = "C:\\antigravityAS\\Modelos -ai-brains\\api_openai.py";
const HTML_FILE_PATH = path.join(__dirname, "ui.html");

let directMlProcess = null;

function checkDirectMLAlive() {
  return new Promise((resolve) => {
    const req = http.get({
      hostname: DIRECTML_HOST,
      port: DIRECTML_PORT,
      path: "/ping",
      timeout: 1200
    }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function startDirectMLServer() {
  const isAlive = await checkDirectMLAlive();
  if (isAlive) return { ok: true, message: "DirectML ya está activo en http://127.0.0.1:8002" };

  try {
    const child = spawn("python", [DIRECTML_SCRIPT], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        OLIVE_GPU_MEMORY_LIMIT: "25",
        OLIVE_CPU_THREADS: "12",
        ORT_DML_DEVICE_ID: "0"
      }
    });
    child.unref();
    directMlProcess = child;

    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await checkDirectMLAlive()) {
        return { ok: true, message: "DirectML iniciado exitosamente en puerto 8002" };
      }
    }
    return { ok: true, message: "DirectML iniciando en segundo plano..." };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

process.on("uncaughtException", (err) => {
  console.error("[Local AI Chat Sidecar Uncaught]", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Local AI Chat Sidecar Rejection]", reason);
});

function proxyToDirectML(reqPath, method, postData, res) {
  const postBuffer = Buffer.from(postData || "", "utf8");
  const options = {
    hostname: DIRECTML_HOST,
    port: DIRECTML_PORT,
    path: reqPath,
    method: method,
    headers: { 
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Content-Length": postBuffer.length
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      "Content-Type": proxyRes.headers["content-type"] || "text/event-stream; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    if (typeof res.flushHeaders === "function") {
      res.flushHeaders();
    }
    proxyRes.on("data", (chunk) => {
      res.write(chunk);
    });
    proxyRes.on("end", () => {
      res.end();
    });
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      try { proxyReq.destroy(); } catch (e) {}
    }
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({ 
        error: "DirectML no está disponible en http://localhost:8002. Ejecuta api_openai.py.",
        details: err.message
      }));
    }
  });

  if (postData) {
    proxyReq.write(postBuffer);
  }
  proxyReq.end();
}

function proxyToOllama(reqPath, method, postData, res) {
  const postBuffer = Buffer.from(postData || "", "utf8");
  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: reqPath,
    method: method,
    headers: { 
      "Content-Type": "application/json",
      "Content-Length": postBuffer.length
    }
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      "Content-Type": proxyRes.headers["content-type"] || "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    proxyRes.pipe(res);
  });

  res.on("close", () => {
    if (!res.writableEnded) {
      try { proxyReq.destroy(); } catch (e) {}
    }
  });

  proxyReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      });
      res.end(JSON.stringify({ 
        error: "Ollama no está disponible en http://localhost:11434.",
        details: err.message
      }));
    }
  });

  if (postData) {
    proxyReq.write(postBuffer);
  }
  proxyReq.end();
}

const server = http.createServer((req, res) => {
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

  if (pathname === "/api/version" && req.method === "GET") {
    try {
      const st = fs.statSync(HTML_FILE_PATH);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ build: st.mtimeMs, v: "1.2.0" }));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ build: 1 }));
    }
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

  // Endpoints de Sincronización de Contexto de Proyecto Dinámico
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

  // Guardar archivo directamente en el proyecto activo
  if (pathname === "/api/project/save-file" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const projectName = payload.project || null;
        const filePath = payload.filePath || "";
        const content = payload.content || "";

        if (!filePath) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "filePath requerido" }));
          return;
        }

        const result = bridge.saveProjectFile(projectName, filePath, content);
        res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Leer contenido de un archivo del proyecto
  if (pathname === "/api/project/read-file" && req.method === "GET") {
    const projName = query.project || null;
    const filePath = query.filePath || query.file || "";
    const result = bridge.readProjectFile(projName, filePath);
    res.writeHead(result.ok ? 200 : 404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }

  // Aplicar parche quirúrgico (SEARCH / REPLACE) a un archivo existente
  if (pathname === "/api/project/apply-patch" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const projectName = payload.project || null;
        const filePath = payload.filePath || "";
        const search = payload.search || "";
        const replace = payload.replace || "";

        if (!filePath || !search) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "filePath y search son obligatorios" }));
          return;
        }

        const result = bridge.applyProjectPatch(projectName, filePath, search, replace);
        res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Registrar avance en AVANCES_LOCAL_AI.md
  if (pathname === "/api/project/log-progress" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        bridge.recordProjectProgress(payload.project, {
          tool: "Local AI Studio",
          model: payload.model || "Ollama",
          task: payload.task || "",
          summary: payload.summary || "",
          filesModified: payload.filesModified || []
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

  // Endpoints de Habilidades (Antigravity Awesome Skills)
  if (pathname === "/api/skills" && req.method === "GET") {
    const q = query.q || "";
    const cat = query.cat || "";
    const skills = skillsBridge.searchSkills(q, cat, 100);
    const categories = skillsBridge.getCategories();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ skills, categories, count: skills.length }));
    return;
  }

  if (pathname === "/api/skills/content" && req.method === "GET") {
    const skillId = query.id || "";
    const content = skillsBridge.getSkillContent(skillId);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ id: skillId, content: content || "" }));
    return;
  }

  // Endpoints de Gestión de Carpetas de Proyecto y Contexto
  if (pathname === "/api/project/folders" && req.method === "GET") {
    try {
      const baseDir = "C:\\antigravityAS";
      const dirs = [];
      if (fs.existsSync(baseDir)) {
        const entries = fs.readdirSync(baseDir, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") {
            dirs.push({
              name: e.name,
              path: path.join(baseDir, e.name)
            });
          }
        }
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ folders: dirs, base: baseDir }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (pathname === "/api/project/load-folder" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const folderPath = payload.folderPath || payload.path || "";
        if (!folderPath || !fs.existsSync(folderPath)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "La carpeta no existe: " + folderPath }));
          return;
        }

        bridge.setExplicitFolder(folderPath);
        const files = bridge.scanProjectFolderDeep(folderPath, "", 0, 4, 100);
        const selected = bridge.getSelectedFiles(folderPath);

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          folderPath: path.resolve(folderPath),
          name: path.basename(path.resolve(folderPath)),
          files: files,
          selectedFiles: selected
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/project/select-files" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const folderPath = payload.folderPath || "";
        const files = payload.selectedFiles || payload.files || [];
        bridge.setSelectedFiles(folderPath, files);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, count: files.length }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (pathname === "/api/project/preview-context" && req.method === "GET") {
    try {
      const proj = query.project || null;
      const ctx = bridge.buildProjectContext(proj);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(ctx || {}));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Endpoints de Modelfile de Ollama
  if (pathname === "/api/ollama/modelfile" && req.method === "GET") {
    const model = query.model || "";
    if (!model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Parámetro 'model' requerido." }));
      return;
    }

    const postData = JSON.stringify({ name: model });
    const options = {
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: "/api/show",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const sReq = http.request(options, (sRes) => {
      let data = "";
      sRes.on("data", c => { data += c; });
      sRes.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            ok: true,
            model: model,
            modelfile: parsed.modelfile || "",
            parameters: parsed.parameters || "",
            template: parsed.template || "",
            system: parsed.system || "",
            details: parsed.details || {}
          }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Respuesta inválida de Ollama: " + data }));
        }
      });
    });

    sReq.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Ollama no responde: " + err.message }));
    });

    sReq.write(postData);
    sReq.end();
    return;
  }

  if (pathname === "/api/ollama/create-model" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        if (!payload.name || !payload.modelfile) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "Nombre y modelfile son obligatorios." }));
          return;
        }

        const postBuffer = Buffer.from(JSON.stringify({
          name: payload.name,
          modelfile: payload.modelfile,
          stream: true
        }), "utf8");

        const options = {
          hostname: OLLAMA_HOST,
          port: OLLAMA_PORT,
          path: "/api/create",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": postBuffer.length
          }
        };

        const createReq = http.request(options, (createRes) => {
          res.writeHead(createRes.statusCode, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          });
          createRes.pipe(res);
        });

        createReq.on("error", (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          }
        });

        createReq.write(postBuffer);
        createReq.end();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Endpoints de Gestión y Control de DirectML
  if (pathname === "/api/directml/status" && req.method === "GET") {
    checkDirectMLAlive().then(isAlive => {
      if (!isAlive) {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ status: "offline", isAlive: false }));
        return;
      }
      const hReq = http.get({
        hostname: DIRECTML_HOST,
        port: DIRECTML_PORT,
        path: "/health",
        timeout: 2000
      }, (hRes) => {
        let data = "";
        hRes.on("data", c => { data += c; });
        hRes.on("end", () => {
          try {
            const h = JSON.parse(data);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ status: "online", isAlive: true, ...h }));
          } catch (e) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "online", isAlive: true }));
          }
        });
      });
      hReq.on("error", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "offline", isAlive: false }));
      });
    });
    return;
  }

  if (pathname === "/api/directml/start" && req.method === "POST") {
    startDirectMLServer().then(result => {
      res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (pathname === "/api/directml/load" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const modelName = payload.model || "";

        // Asegurar que DirectML esté arriba
        const isAlive = await checkDirectMLAlive();
        if (!isAlive) {
          await startDirectMLServer();
        }

        const postBuf = Buffer.from(JSON.stringify({ model: modelName }), "utf8");
        const opt = {
          hostname: DIRECTML_HOST,
          port: DIRECTML_PORT,
          path: "/v1/models/load",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": postBuf.length
          }
        };

        const lReq = http.request(opt, (lRes) => {
          let data = "";
          lRes.on("data", c => { data += c; });
          lRes.on("end", () => {
            res.writeHead(lRes.statusCode, { "Content-Type": "application/json; charset=utf-8" });
            res.end(data);
          });
        });

        lReq.on("error", (err) => {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "DirectML no disponible: " + err.message }));
        });

        lReq.write(postBuf);
        lReq.end();
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Modelos combinados: DirectML Nativo + Free.ai Cloud + Ollama Local
  if (pathname === "/api/tags" && req.method === "GET") {
    const fetchOllama = new Promise((resolve) => {
      const oReq = http.get({
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: "/api/tags",
        timeout: 4000
      }, (oRes) => {
        let data = "";
        oRes.on("data", c => { data += c; });
        oRes.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.models || []);
          } catch (e) {
            resolve([]);
          }
        });
      });
      oReq.on("error", () => resolve([]));
      oReq.on("timeout", () => { oReq.destroy(); resolve([]); });
    });

    const fetchDirectML = new Promise((resolve) => {
      const dReq = http.get({
        hostname: DIRECTML_HOST,
        port: DIRECTML_PORT,
        path: "/v1/models",
        timeout: 4000
      }, (dRes) => {
        let data = "";
        dRes.on("data", c => { data += c; });
        dRes.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.data || []);
          } catch (e) {
            resolve([]);
          }
        });
      });
      dReq.on("error", () => resolve([]));
      dReq.on("timeout", () => { dReq.destroy(); resolve([]); });
    });

    const fetchFreeAi = freeai.fetchModels().catch((e) => {
      console.warn("[Local AI Chat] Free.ai fetch error:", e.message);
      return [];
    });

    Promise.all([fetchOllama, fetchDirectML, fetchFreeAi])
      .then(([ollamaModels, directmlModels, freeAiModels]) => {
        const fallbackDirectML = [
          {
            id: "Phi-3.5-mini-instruct-ONNX",
            displayName: "Phi-3.5-mini-instruct (INT4 AWQ DirectML)",
            size: "2.3 GB",
            active: true,
            status: "ready"
          },
          {
            id: "Hermes-3-8B-UNLOCKED-ONNX-DirectML",
            displayName: "Hermes-3-8B-UNLOCKED (Q8 ONNX DirectML)",
            size: "8.5 GB",
            active: false,
            status: "ready"
          }
        ];
        const actualDML = (directmlModels && directmlModels.length > 0) ? directmlModels : fallbackDirectML;

        const formattedLocal = (ollamaModels || []).map(m => ({
          ...m,
          displayName: `${m.name} (Local)`,
          isLocal: true,
          provider: "Ollama Local"
        }));

        const formattedDirectML = actualDML.map(m => ({
          name: m.id || m.name,
          id: m.id || m.name,
          displayName: m.displayName || `${m.id || m.name} (DirectML GPU)`,
          size: m.size || "DirectML",
          isDirectML: true,
          active: m.active || false,
          provider: "DirectML Nativo",
          status: m.status || "ready"
        }));

        const formattedFreeAi = (freeAiModels || []).map(m => ({
          name: m.id,
          rawId: m.rawId,
          displayName: m.name,
          size: m.license,
          type: m.type,
          isFreeAi: true,
          provider: "Free.ai Cloud",
          details: { family: m.type, parameter_size: m.provider }
        }));

        const combined = [...formattedDirectML, ...formattedFreeAi, ...formattedLocal];

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          models: combined,
          directmlModels: formattedDirectML,
          freeAiModels: formattedFreeAi,
          localModels: formattedLocal
        }));
      })
      .catch((err) => {
        console.error("[Local AI Chat] Error in /api/tags:", err);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ models: [], directmlModels: [], freeAiModels: [], localModels: [] }));
      });
    return;
  }

  // Modelos específicos de Free.ai
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

  // Chat con Inyección Automática de Contexto de Proyecto y Skills (DirectML, Free.ai, Ollama)
  if (pathname === "/api/chat" && req.method === "POST") {
    req.setEncoding("utf8");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const activeProjName = payload.project || null;
        const convId = payload.conversationId || null;
        const ctx = bridge.buildProjectContext(activeProjName, convId);
        const sysPrompt = ctx && ctx.systemPrompt ? ctx.systemPrompt : null;

        // Combinar contexto del proyecto con la habilidad seleccionada
        let combinedSysPrompt = sysPrompt || "";
        if (payload.skillId) {
          const skillPrompt = skillsBridge.buildSkillSystemPrompt(payload.skillId);
          if (skillPrompt) {
            combinedSysPrompt = (combinedSysPrompt ? combinedSysPrompt + "\n" : "") + skillPrompt;
          }
        }

        // 1. Agente DirectML Nativo
        const isDirectML = payload.isDirectML === true ||
          (typeof payload.model === "string" && (payload.model.toLowerCase().includes("directml") || payload.model.toLowerCase().includes("onnx") || payload.model.startsWith("directml:"))) ||
          payload.source === "directml";

        if (isDirectML) {
          try {
            const isAlive = await checkDirectMLAlive();
            if (!isAlive) {
              await startDirectMLServer();
            }

            let dmlMessages = Array.isArray(payload.messages) ? [...payload.messages] : [];
            if (combinedSysPrompt) {
              if (dmlMessages.length > 0 && dmlMessages[0].role === "system") {
                dmlMessages[0].content = combinedSysPrompt;
              } else {
                dmlMessages.unshift({ role: "system", content: combinedSysPrompt });
              }
            }
            const cleanModel = (payload.model || "").replace(/^directml:/, "");
            const dmlPayload = JSON.stringify({
              model: cleanModel,
              messages: dmlMessages,
              stream: true,
              max_tokens: payload.max_tokens || 512,
              temperature: payload.temperature || 0.7
            });
            proxyToDirectML("/v1/chat/completions", "POST", dmlPayload, res);
            return;
          } catch (dmlErr) {
            console.error("[Local AI Chat] DirectML Error:", dmlErr.message);
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Error en DirectML: " + dmlErr.message }));
            }
            return;
          }
        }

        // 2. Agente Free.ai Cloud
        const isFreeAiModel = payload.isFreeAi === true ||
          (typeof payload.model === "string" && payload.model.startsWith("freeai:")) ||
          payload.source === "freeai";

        if (isFreeAiModel) {
          try {
            await freeai.streamChat(payload, res, combinedSysPrompt);
            return;
          } catch (freeErr) {
            console.error("[Local AI Chat] Free.ai Error:", freeErr.message);
            if (!res.headersSent) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Error en Free.ai: " + freeErr.message }));
            }
            return;
          }
        }

        // 3. Agente Ollama Local
        if (combinedSysPrompt) {
          if (!Array.isArray(payload.messages)) {
            payload.messages = [];
          }
          if (payload.messages.length > 0 && payload.messages[0].role === "system") {
            payload.messages[0].content = combinedSysPrompt;
          } else {
            payload.messages.unshift({
              role: "system",
              content: combinedSysPrompt
            });
          }
        }

        if (payload.modelfileOptions) {
          payload.options = { ...(payload.options || {}), ...payload.modelfileOptions };
        }
        if (payload.customSystemPrompt && payload.messages && payload.messages.length > 0) {
          if (payload.messages[0].role === "system") {
            payload.messages[0].content = payload.customSystemPrompt + "\n\n" + payload.messages[0].content;
          }
        }

        const enrichedBody = JSON.stringify(payload);
        proxyToOllama("/api/chat", "POST", enrichedBody, res);
      } catch (err) {
        proxyToOllama("/api/chat", "POST", body, res);
      }
    });
    return;
  }

  // Cualquier ruta GET sirve la interfaz visual
  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    try {
      const html = fs.readFileSync(HTML_FILE_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Error loading ui.html: " + e.message);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[Local AI Chat Sidecar] Puerto ${PORT} en uso, asignando dinámico...`);
    server.listen(0, "127.0.0.1");
  } else {
    console.error("[Local AI Chat Sidecar Error]", err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const actualPort = server.address().port;
  console.log(`[Local AI Studio] Sidecar running on http://127.0.0.1:${actualPort}`);
});
