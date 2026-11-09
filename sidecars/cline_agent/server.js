const http = require("node:http");
const url = require("node:url");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("../../context-bridge.js");
const freeai = require("../../freeai-bridge.js");

const PORT = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT 
  ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10) 
  : 0;

const CLINE_CLI_PATH = "C:\\Users\\Benner\\AppData\\Local\\Cline\\cline-cli.exe";
const CLINE_APP_PATH = "C:\\Users\\Benner\\AppData\\Local\\Cline\\cline-app.exe";
const HTML_FILE_PATH = path.join(__dirname, "ui.html");
const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;

let currentProcess = null;

process.on("uncaughtException", (err) => {
  console.error("[Cline Sidecar Uncaught]", err.message);
});
process.on("unhandledRejection", (reason) => {
  console.error("[Cline Sidecar Rejection]", reason);
});

function fetchCombinedModels(res) {
  const fetchOllama = new Promise((resolve) => {
    const req = http.get({
      hostname: OLLAMA_HOST,
      port: OLLAMA_PORT,
      path: "/api/tags",
      timeout: 1500
    }, (proxyRes) => {
      let data = "";
      proxyRes.on("data", c => { data += c; });
      proxyRes.on("end", () => {
        try {
          resolve(JSON.parse(data).models || []);
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });

  Promise.all([fetchOllama, freeai.fetchModels().catch(() => [])])
    .then(([ollamaModels, freeAiModels]) => {
      const combined = [
        ...freeAiModels.map(m => ({
          name: m.id,
          rawId: m.rawId,
          displayName: m.name,
          type: m.type,
          isFreeAi: true,
          provider: "Free.ai Cloud"
        })),
        ...ollamaModels.map(m => ({
          ...m,
          displayName: `${m.name} (Local)`,
          isLocal: true,
          provider: "Ollama Local"
        }))
      ];
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        models: combined,
        freeAiModels: freeAiModels,
        localModels: ollamaModels
      }));
    })
    .catch((err) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [], error: err.message }));
    });
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

  if (pathname === "/api/models" && req.method === "GET") {
    fetchCombinedModels(res);
    return;
  }

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

  if (pathname === "/api/open-desktop" && req.method === "POST") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const activeProj = bridge.getActiveProject(payload.project, payload.conversationId);
        const projectPath = activeProj ? activeProj.path : "C:\\antigravityAS";

        const app = spawn(CLINE_APP_PATH, [projectPath], {
          detached: true,
          stdio: "ignore",
          cwd: projectPath
        });
        app.unref();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, status: "Desktop launched in " + projectPath }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (pathname === "/api/stop" && req.method === "POST") {
    if (currentProcess) {
      try {
        currentProcess.kill();
      } catch (e) {}
      currentProcess = null;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "Stopped" }));
    return;
  }

  if (pathname === "/api/run" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const prompt = payload.prompt || "";
        const mode = payload.mode || "act";
        const projName = payload.project || null;
        const convId = payload.conversationId || null;
        const model = payload.model || "";
        const isFreeAiModel = payload.isFreeAi === true || (model && model.startsWith("freeai:"));
        const isLocalModel = !isFreeAiModel && (payload.isLocal === true || (model && !model.startsWith("anthropic/")));

        const ctx = bridge.buildProjectContext(projName, convId);
        const targetCwd = ctx && ctx.project ? ctx.project.path : "C:\\antigravityAS";

        const args = [];
        if (mode === "plan") {
          args.push("--plan");
        }

        let modelLabel = "";
        if (isFreeAiModel) {
          const rawModel = model.replace("freeai:", "");
          args.push("-P", "openai-compatible");
          args.push("-m", rawModel);
          modelLabel = `Free.ai Cloud (${rawModel})`;
        } else if (isLocalModel && model) {
          args.push("-P", "ollama");
          args.push("-m", model);
          modelLabel = `Ollama Local (${model})`;
        } else if (model) {
          args.push("-P", "cline");
          args.push("-m", model);
          modelLabel = model;
        } else {
          modelLabel = "Cline Default";
        }

        args.push("-c", targetCwd);

        const contextPrefix = `[Proyecto: ${ctx ? ctx.project.name : "Local"}]`;
        args.push(`${contextPrefix} ${prompt}`);

        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Transfer-Encoding": "chunked",
          "Cache-Control": "no-cache"
        });

        res.write(`📁 Directorio de Trabajo: ${targetCwd}\n`);
        res.write(`🧠 Modelo AI: ${modelLabel}\n`);
        res.write(`⚡ Modo: ${mode.toUpperCase()} | Sincronizado con Antigravity\n`);
        res.write(`────────────────────────────────────────────────────────────\n\n`);

        const spawnEnv = {
          ...process.env,
          OLLAMA_BASE_URL: "http://127.0.0.1:11434",
          OLLAMA_HOST: "http://127.0.0.1:11434"
        };
        if (isFreeAiModel) {
          spawnEnv.OPENAI_API_KEY = freeai.getKey();
          spawnEnv.OPENAI_BASE_URL = "https://api.free.ai/v1";
          spawnEnv.OPENAI_API_BASE = "https://api.free.ai/v1";
        }

        currentProcess = spawn(CLINE_CLI_PATH, args, {
          cwd: targetCwd,
          shell: true,
          env: spawnEnv
        });

        let fullOutput = "";

        currentProcess.stdout.on("data", (data) => {
          fullOutput += data;
          res.write(data);
        });

        currentProcess.stderr.on("data", (data) => {
          fullOutput += data;
          res.write(data);
        });

        currentProcess.on("close", (code) => {
          res.write(`\n[Proceso terminado con código: ${code}]\n`);
          res.end();
          currentProcess = null;

          // Registrar en AVANCES_LOCAL_AI.md
          if (ctx && ctx.project) {
            bridge.recordProjectProgress(ctx.project.name, {
              tool: "Cline Autonomous Agent",
              model: modelLabel,
              task: prompt,
              summary: `Ejecución de tarea en ${targetCwd} (Código: ${code}). Resumen: ${fullOutput.slice(0, 200)}...`
            });
          }
        });

        currentProcess.on("error", (err) => {
          res.write(`\nError ejecutando Cline CLI: ${err.message}\n`);
          res.end();
          currentProcess = null;
        });

      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && !pathname.startsWith("/api/")) {
    try {
      const html = fs.readFileSync(HTML_FILE_PATH, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Error cargando ui.html de Cline: " + e.message);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.warn(`[Cline Sidecar] Puerto ${PORT} en uso, asignando dinámico...`);
    server.listen(0, "127.0.0.1");
  } else {
    console.error("[Cline Sidecar Error]", err);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const actualPort = server.address().port;
  console.log(`[Cline Sidecar] Escuchando en http://127.0.0.1:${actualPort}`);
});
