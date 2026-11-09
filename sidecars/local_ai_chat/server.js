const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const envLoader = require("../../env-loader.js");
envLoader.loadAllEnv();

const bridge = require("../../context-bridge.js");
const memoryStore = require("../../memory-store.js");
const contextAnalyzer = require("../../context-analyzer.js");
const skillsBridge = require("../../skills-bridge.js");
const freeai = require("../../freeai-bridge.js");
const integrations = require("../../integrations-bridge.js");

const DEFAULT_PORT = 63719;
const DEFAULT_OLLAMA_HOST = "127.0.0.1";
const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_DIRECTML_HOST = "127.0.0.1";
const DEFAULT_DIRECTML_PORT = 8002;
const DIRECTML_SCRIPT = "C:\\antigravityAS\\Modelos -ai-brains\\api_openai.py";
const PRELOAD_PATH = "C:\\Users\\Benner\\.gemini\\antigravity\\lib\\node_modules\\sidecar_sdk\\preload.js";
const HTML_FILE_PATH = path.join(__dirname, "ui.html");
const ASSETS_DIR = path.join(__dirname, "assets");
const ASSET_MIME_TYPES = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

let directMlProcess = null;

function safeErrMsg(errOrMsg, extraSecrets = []) {
  return integrations.sanitizeSecrets(errOrMsg || "Error interno", extraSecrets);
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  }
  res.end(JSON.stringify(payload));
}

function sendJsonError(res, statusCode, errOrMsg, extra = {}) {
  sendJson(res, statusCode, {
    ok: false,
    ...extra,
    error: safeErrMsg(errOrMsg)
  });
}

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    function fail(statusCode, message) {
      if (settled) return;
      settled = true;
      const err = new Error(safeErrMsg(message));
      err.statusCode = statusCode;
      reject(err);
    }

    req.on("data", (chunk) => {
      if (settled) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        fail(413, `El cuerpo de la petición excede el límite permitido (${maxBytes} bytes).`);
        return;
      }
      chunks.push(buf);
    });

    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        settled = true;
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        settled = true;
        resolve(parsed);
      } catch (_err) {
        fail(400, "JSON malformado en el cuerpo de la petición.");
      }
    });

    req.on("error", (err) => {
      fail(400, `Error leyendo el cuerpo de la petición: ${err.message}`);
    });
  });
}

function ensurePlainObject(value, label = "El cuerpo JSON") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const err = new Error(`${label} debe ser un objeto JSON válido.`);
    err.statusCode = 400;
    throw err;
  }
  return value;
}

function resolveProjectInfo(projectName = null, projectPath = null, convId = null, token = null) {
  const cleanPathInput = (typeof projectPath === "string" && projectPath.trim())
    ? path.resolve(projectPath.trim())
    : "";

  let cleanNameInput = (typeof projectName === "string" && projectName.trim())
    ? projectName.trim()
    : null;

  if (cleanPathInput && fs.existsSync(cleanPathInput)) {
    try {
      if (fs.statSync(cleanPathInput).isDirectory()) {
        const activeByPath = bridge.getActiveProject(cleanPathInput, convId || null, token || null);
        let strippedName = cleanNameInput || "";
        if (strippedName.startsWith("proj:")) strippedName = strippedName.slice(5).trim();
        const name = (strippedName && strippedName.toLowerCase() !== "general" && strippedName !== "explicit")
          ? strippedName
          : (activeByPath && activeByPath.name) || path.basename(cleanPathInput) || "Proyecto";
        return {
          project: activeByPath || { name, path: cleanPathInput, isGeneral: false },
          name,
          path: cleanPathInput,
          isGeneral: false,
          stateKey: cleanPathInput,
          convId: convId || (activeByPath && activeByPath.convId) || null
        };
      }
    } catch (_e) {}
  }

  const active = bridge.getActiveProject(cleanNameInput, convId || null, token || null);
  const isGeneral = Boolean(!active || active.isGeneral || String(active.name || "").toLowerCase() === "general");
  const resolvedName = active ? active.name : "General";
  const resolvedPath = cleanPathInput || (active && active.path ? active.path : "");
  const stateKey = isGeneral ? "General" : (resolvedPath || resolvedName);

  return {
    project: active || { name: resolvedName, path: resolvedPath, isGeneral },
    name: resolvedName,
    path: resolvedPath,
    isGeneral,
    stateKey,
    convId: convId || (active && active.convId) || null
  };
}

function getBaseProjectsDir() {
  const override = process.env.LOCAL_AI_PROJECTS_DIR;
  return (override && String(override).trim())
    ? path.resolve(String(override).trim())
    : "C:\\antigravityAS";
}

function sanitizeProfilesList(rawProfiles) {
  return (Array.isArray(rawProfiles) ? rawProfiles : []).map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category || "general",
    description: p.description || "",
    vibe: p.vibe || "",
    emoji: p.emoji || "",
    color: p.color || ""
  }));
}

function injectSystemMessage(rawMessages, systemPrompt) {
  const messages = Array.isArray(rawMessages)
    ? rawMessages.map((m) => (m && typeof m === "object" ? { ...m } : { role: "user", content: String(m ?? "") }))
    : [];
  if (systemPrompt && String(systemPrompt).trim()) {
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { ...messages[0], content: systemPrompt };
    } else {
      messages.unshift({ role: "system", content: systemPrompt });
    }
  }
  return messages;
}

function detectEngineTarget(payload = {}) {
  const rawModel = typeof payload.model === "string" ? payload.model : "";
  const lowerModel = rawModel.toLowerCase();
  const isDirectML = payload.isDirectML === true ||
    lowerModel.includes("directml") ||
    lowerModel.includes("onnx") ||
    rawModel.startsWith("directml:") ||
    payload.source === "directml";

  const isFreeAi = !isDirectML && (
    payload.isFreeAi === true ||
    rawModel.startsWith("freeai:") ||
    payload.source === "freeai"
  );

  if (isDirectML) {
    return {
      engine: "directml",
      model: rawModel.replace(/^directml:/, "")
    };
  }
  if (isFreeAi) {
    return {
      engine: "freeai",
      model: rawModel.replace(/^freeai:/, "")
    };
  }
  return {
    engine: "ollama",
    model: rawModel
  };
}

function getMutationErrorStatus(errorMessage = "") {
  const msg = String(errorMessage);
  if (/ruta protegida|fuera del proyecto/i.test(msg)) return 403;
  if (/no encontrado|no existe|vacío|no se encontró el bloque|obligatorio/i.test(msg)) return 400;
  return 500;
}

function getReadFileErrorStatus(errorMessage = "") {
  const msg = String(errorMessage);
  if (/ruta protegida|fuera del proyecto/i.test(msg)) return 403;
  if (/no existe|no encontrado/i.test(msg)) return 404;
  return 400;
}

function getIntegrationMutatorStatus(errorMessage = "") {
  const msg = String(errorMessage);
  if (/inválido|obligatorio|requiere|no existe|no se detectó|debe estar dentro|zero-trust|bloqueada/i.test(msg)) {
    return 400;
  }
  return 502;
}

function buildFallbackEnterContextReport(enterPayload, offlineReason = null) {
  const telemetry = (enterPayload && enterPayload.telemetry) || {};
  const proj = telemetry.project || { name: "General", path: "" };
  const git = telemetry.git || {};
  const manifests = telemetry.manifests || { detected: [], details: {} };
  const brain = telemetry.brain || { available: false, artifacts: {}, checklistSummary: {}, recentTurns: [] };
  const todoMarkers = Array.isArray(telemetry.todoMarkers) ? telemetry.todoMarkers : [];
  const recentChanges = Array.isArray(telemetry.recentChanges) ? telemetry.recentChanges : [];
  const recentChats = Array.isArray(telemetry.recentChats) ? telemetry.recentChats : [];
  const projectState = telemetry.projectState || {};

  const lines = [];
  if (offlineReason) {
    lines.push(
      `> **Modo Contingencia (Motor IA offline):** ${safeErrMsg(offlineReason)}. ` +
      `Diagnóstico reconstruido directamente desde telemetría verificada en disco.`
    );
    lines.push("");
  }

  // 1. Estado Actual Verificado
  lines.push("## 1. Estado Actual Verificado");
  lines.push(`- **Proyecto activo:** \`${proj.name}\` (${proj.path || "[No verificado en telemetría]"})`);
  if (git.isGitRepo) {
    const lastCommit = Array.isArray(git.recentCommits) && git.recentCommits.length > 0
      ? `\`${git.recentCommits[0].hash}\` (${git.recentCommits[0].date}): ${git.recentCommits[0].message}`
      : "[Sin commits registrados]";
    lines.push(`- **Repositorio Git:** Rama \`${git.branch || "HEAD"}\`, cambios pendientes=${(git.statusLines || []).length}, último commit=${lastCommit}`);
  } else {
    lines.push("- **Repositorio Git:** No inicializado o sin directorio `.git` en la raíz.");
  }
  lines.push(`- **Stack / Manifiestos:** ${manifests.detected && manifests.detected.length > 0 ? manifests.detected.join(", ") : "[No detectados en raíz]"}`);
  lines.push(
    `- **Continuidad Persistida:** GitHub=${projectState.githubToggle ? "ON" : "OFF"} (${projectState.githubRepo || "sin repo"}) | ` +
    `Netlify=${projectState.netlifyToggle ? "ON" : "OFF"} (${projectState.netlifySite || "sin sitio"}) | ` +
    `Cambios registrados=${recentChanges.length} | Chats=${recentChats.length}`
  );
  lines.push("");

  // 2. Procesos Inconclusos y Riesgos
  lines.push("## 2. Procesos Inconclusos y Riesgos");
  const riskItems = [];
  if (git.isGitRepo && Array.isArray(git.statusLines) && git.statusLines.length > 0) {
    const sample = git.statusLines.slice(0, 5).map((s) => `\`${s}\``).join(", ");
    riskItems.push(`- **Working tree con modificaciones sin commit (${git.statusLines.length}):** ${sample}`);
  }
  const inProgressTasks = [];
  const pendingTasks = [];
  if (brain.available && brain.artifacts) {
    for (const [artName, art] of Object.entries(brain.artifacts)) {
      const cl = art && art.checklist;
      if (!cl) continue;
      (cl.inProgress || []).forEach((t) => inProgressTasks.push({ source: artName, text: t }));
      (cl.pending || []).forEach((t) => pendingTasks.push({ source: artName, text: t }));
    }
  }
  if (inProgressTasks.length > 0) {
    riskItems.push(`- **Tareas en progreso interrumpidas (${inProgressTasks.length}):** ${inProgressTasks.slice(0, 4).map((t) => `${t.text} (${t.source})`).join(" | ")}`);
  }
  const fixmes = todoMarkers.filter((m) => m.tag === "FIXME");
  const todos = todoMarkers.filter((m) => m.tag === "TODO");
  if (fixmes.length > 0 || todos.length > 0) {
    riskItems.push(`- **Marcadores en código fuente:** ${fixmes.length} FIXME y ${todos.length} TODO detectados.`);
  }
  if (!telemetry.avancesTail) {
    riskItems.push("- **Bitácora local:** No existen entradas previas en `AVANCES_LOCAL_AI.md`.");
  }
  if (riskItems.length === 0) {
    riskItems.push("- No se detectaron archivos sucios ni marcadores FIXME/TODO pendientes en los archivos escaneados.");
  }
  lines.push(...riskItems);
  lines.push("");

  // 3. Lista de Tareas Pendientes
  lines.push("## 3. Lista de Tareas Pendientes");
  const taskLines = [];
  for (const t of inProgressTasks.slice(0, 6)) {
    taskLines.push(`- [ ] [En curso • ${t.source}] ${t.text}`);
  }
  for (const t of pendingTasks.slice(0, 8)) {
    taskLines.push(`- [ ] [${t.source}] ${t.text}`);
  }
  for (const m of todoMarkers.slice(0, 6)) {
    taskLines.push(`- [ ] [${m.tag}] \`${m.file}:${m.line}\` — ${m.text}`);
  }
  if (taskLines.length === 0 && git.isGitRepo && Array.isArray(git.statusLines) && git.statusLines.length > 0) {
    taskLines.push(`- [ ] Revisar y consolidar los ${git.statusLines.length} cambio(s) local(es) en \`${git.branch || "HEAD"}\`.`);
  }
  if (taskLines.length === 0) {
    taskLines.push(`- [ ] Verificar estado funcional y pruebas automatizadas de \`${proj.name}\`.`);
    taskLines.push("- [ ] Seleccionar archivos clave de código para profundizar en el chat de trabajo.");
  }
  lines.push(...taskLines);
  lines.push("");

  // 4. Plan de Acción Recomendado
  lines.push("## 4. Plan de Acción Recomendado");
  const planLines = [];
  if (inProgressTasks.length > 0 || pendingTasks.length > 0) {
    planLines.push("1. Retomar inmediatamente las tareas en progreso/pendientes detectadas en los artefactos de Antigravity.");
  } else {
    planLines.push(`1. Inspeccionar la estructura prioritaria de \`${proj.name}\` y seleccionar archivos clave en el panel de contexto.`);
  }
  if (fixmes.length > 0 || todos.length > 0) {
    planLines.push(`2. Resolver los ${fixmes.length + todos.length} marcadores FIXME/TODO priorizando \`${(fixmes[0] || todos[0]).file}\`.`);
  } else if (manifests.detected && manifests.detected.length > 0) {
    planLines.push(`2. Ejecutar validaciones/tests definidos en ${manifests.detected.join(", ")} antes de aplicar nuevos parches.`);
  } else {
    planLines.push("2. Verificar dependencias y punto de entrada del proyecto antes de introducir cambios.");
  }
  if (git.isGitRepo && Array.isArray(git.statusLines) && git.statusLines.length > 0) {
    planLines.push("3. Auditar el `git diff` pendiente y guardar checkpoint/sync cuando los cambios estén validados.");
  } else {
    planLines.push("3. Registrar los próximos avances en `AVANCES_LOCAL_AI.md` y sincronizar repositorio cuando corresponda.");
  }
  lines.push(...planLines);

  return lines.join("\n");
}

function createStudioServer(options = {}) {
  const config = {
    ollamaHost: options.ollamaHost || process.env.LOCAL_AI_OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
    ollamaPort: Number(options.ollamaPort || process.env.LOCAL_AI_OLLAMA_PORT || DEFAULT_OLLAMA_PORT),
    directmlHost: options.directmlHost || process.env.LOCAL_AI_DIRECTML_HOST || DEFAULT_DIRECTML_HOST,
    directmlPort: Number(options.directmlPort || process.env.LOCAL_AI_DIRECTML_PORT || DEFAULT_DIRECTML_PORT),
    autoStartDirectML: options.autoStartDirectML !== false
  };

  function checkDirectMLAlive() {
    return new Promise((resolve) => {
      const req = http.get({
        hostname: config.directmlHost,
        port: config.directmlPort,
        path: "/ping",
        timeout: 1200
      }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  async function startDirectMLServer() {
    const isAlive = await checkDirectMLAlive();
    if (isAlive) {
      return { ok: true, message: `DirectML ya está activo en http://${config.directmlHost}:${config.directmlPort}` };
    }
    if (!config.autoStartDirectML) {
      return { ok: false, error: "DirectML no está disponible y autoStart está desactivado." };
    }

    try {
      const child = spawn("python", [DIRECTML_SCRIPT], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          OLIVE_GPU_MEMORY_LIMIT: process.env.OLIVE_GPU_MEMORY_LIMIT || "25",
          OLIVE_CPU_THREADS: process.env.OLIVE_CPU_THREADS || "12",
          ORT_DML_DEVICE_ID: process.env.ORT_DML_DEVICE_ID || "0"
        }
      });
      child.unref();
      directMlProcess = child;

      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await checkDirectMLAlive()) {
          return { ok: true, message: `DirectML iniciado exitosamente en puerto ${config.directmlPort}` };
        }
      }
      return { ok: true, message: "DirectML iniciando en segundo plano..." };
    } catch (err) {
      return { ok: false, error: safeErrMsg(err) };
    }
  }

  function proxyToDirectML(reqPath, method, postData, res) {
    const postBuffer = Buffer.from(postData || "", "utf8");
    const reqOptions = {
      hostname: config.directmlHost,
      port: config.directmlPort,
      path: reqPath,
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Content-Length": postBuffer.length
      }
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, {
          "Content-Type": proxyRes.headers["content-type"] || "text/event-stream; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });
      }
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }
      proxyRes.on("data", (chunk) => {
        if (!res.writableEnded) res.write(chunk);
      });
      proxyRes.on("end", () => {
        if (!res.writableEnded) res.end();
      });
      proxyRes.on("error", () => {
        if (!res.writableEnded) res.end();
      });
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        try { proxyReq.destroy(); } catch (_e) {}
      }
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, {
          ok: false,
          error: `DirectML no está disponible en http://${config.directmlHost}:${config.directmlPort}. Ejecuta api_openai.py.`,
          details: safeErrMsg(err)
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    if (postData) {
      proxyReq.write(postBuffer);
    }
    proxyReq.end();
  }

  function proxyToOllama(reqPath, method, postData, res) {
    const postBuffer = Buffer.from(postData || "", "utf8");
    const reqOptions = {
      hostname: config.ollamaHost,
      port: config.ollamaPort,
      path: reqPath,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": postBuffer.length
      }
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, {
          "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
      }
      proxyRes.pipe(res);
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        try { proxyReq.destroy(); } catch (_e) {}
      }
    });

    proxyReq.on("error", (err) => {
      if (!res.headersSent) {
        sendJson(res, 502, {
          ok: false,
          error: `Ollama no está disponible en http://${config.ollamaHost}:${config.ollamaPort}.`,
          details: safeErrMsg(err)
        });
      } else if (!res.writableEnded) {
        res.end();
      }
    });

    if (postData) {
      proxyReq.write(postBuffer);
    }
    proxyReq.end();
  }

  function streamAnalysisFromEngine({ engine, model, systemPrompt, userPrompt, payload }, onToken) {
    return new Promise((resolve, reject) => {
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ];

      let settled = false;
      let accumulated = "";
      let buffer = "";

      function doneResolve() {
        if (settled) return;
        settled = true;
        resolve({ text: accumulated, model });
      }

      function doneReject(reason) {
        if (settled) return;
        settled = true;
        const err = new Error(safeErrMsg(reason));
        err.partialText = accumulated;
        reject(err);
      }

      if (engine === "freeai") {
        const baseUrl = freeai.getBaseUrl();
        const key = freeai.getKey();
        const isDefaultCloud = baseUrl === "https://api.free.ai/v1";
        if (isDefaultCloud && !key) {
          return doneReject("Free.ai API key no configurada");
        }

        const targetUrl = `${baseUrl}/chat/completions`;
        let parsedTarget;
        try {
          parsedTarget = new URL(targetUrl);
        } catch (_e) {
          return doneReject("FREEAI_BASE_URL inválida");
        }

        const client = parsedTarget.protocol === "http:" ? http : https;
        const bodyData = JSON.stringify({
          model: model || "qwen7b",
          messages,
          stream: true,
          temperature: payload.temperature !== undefined ? payload.temperature : 0.3,
          max_tokens: payload.max_tokens || 2048
        });

        const req = client.request(targetUrl, {
          method: "POST",
          headers: {
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyData, "utf8"),
            "User-Agent": "Antigravity/1.0"
          },
          timeout: 30000
        }, (upstreamRes) => {
          if (upstreamRes.statusCode !== 200) {
            let errBody = "";
            upstreamRes.on("data", (c) => { errBody += c; });
            upstreamRes.on("end", () => {
              if (typeof freeai.rotateKey === "function") freeai.rotateKey();
              doneReject(`Free.ai HTTP ${upstreamRes.statusCode}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
            });
            return;
          }

          upstreamRes.setEncoding("utf8");
          upstreamRes.on("data", (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
              const rawJson = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
              try {
                const parsed = JSON.parse(rawJson);
                const content = (parsed.choices && parsed.choices[0] && (parsed.choices[0].delta?.content || parsed.choices[0].message?.content))
                  || (parsed.message && parsed.message.content)
                  || "";
                if (content) {
                  accumulated += content;
                  onToken(content);
                }
              } catch (_e) {}
            }
          });
          upstreamRes.on("end", () => doneResolve());
          upstreamRes.on("error", (err) => doneReject(err.message));
        });

        req.on("error", (err) => {
          if (typeof freeai.rotateKey === "function") freeai.rotateKey();
          doneReject(`Free.ai offline (${err.message})`);
        });
        req.on("timeout", () => {
          req.destroy();
          doneReject("Timeout conectando con Free.ai");
        });
        req.write(bodyData);
        req.end();
        return;
      }

      if (engine === "directml") {
        const bodyData = JSON.stringify({
          model: model || "Phi-3.5-mini-instruct-ONNX",
          messages,
          stream: true,
          max_tokens: payload.max_tokens || 2048,
          temperature: payload.temperature !== undefined ? payload.temperature : 0.3
        });

        const req = http.request({
          hostname: config.directmlHost,
          port: config.directmlPort,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Content-Length": Buffer.byteLength(bodyData, "utf8")
          },
          timeout: 30000
        }, (upstreamRes) => {
          if (upstreamRes.statusCode !== 200) {
            let errBody = "";
            upstreamRes.on("data", (c) => { errBody += c; });
            upstreamRes.on("end", () => {
              doneReject(`DirectML HTTP ${upstreamRes.statusCode}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
            });
            return;
          }

          upstreamRes.setEncoding("utf8");
          upstreamRes.on("data", (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") continue;
              const rawJson = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
              try {
                const parsed = JSON.parse(rawJson);
                const content = (parsed.choices && parsed.choices[0] && (parsed.choices[0].delta?.content || parsed.choices[0].message?.content))
                  || (parsed.message && parsed.message.content)
                  || "";
                if (content) {
                  accumulated += content;
                  onToken(content);
                }
              } catch (_e) {}
            }
          });
          upstreamRes.on("end", () => doneResolve());
          upstreamRes.on("error", (err) => doneReject(err.message));
        });

        req.on("error", (err) => doneReject(`DirectML offline (${err.message})`));
        req.on("timeout", () => {
          req.destroy();
          doneReject("Timeout conectando con DirectML");
        });
        req.write(bodyData);
        req.end();
        return;
      }

      // Default: Ollama (/api/chat con stream: true)
      const ollamaBody = {
        model,
        messages,
        stream: true
      };
      if (payload.modelfileOptions && typeof payload.modelfileOptions === "object") {
        ollamaBody.options = payload.modelfileOptions;
      }
      const bodyData = JSON.stringify(ollamaBody);

      const req = http.request({
        hostname: config.ollamaHost,
        port: config.ollamaPort,
        path: "/api/chat",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyData, "utf8")
        },
        timeout: 30000
      }, (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
          let errBody = "";
          upstreamRes.on("data", (c) => { errBody += c; });
          upstreamRes.on("end", () => {
            doneReject(`Ollama HTTP ${upstreamRes.statusCode}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
          });
          return;
        }

        upstreamRes.setEncoding("utf8");
        upstreamRes.on("data", (chunk) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              if (parsed.error) {
                doneReject(parsed.error);
                return;
              }
              const content = (parsed.message && parsed.message.content) || parsed.response || "";
              if (content) {
                accumulated += content;
                onToken(content);
              }
            } catch (_e) {}
          }
        });
        upstreamRes.on("end", () => {
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim());
              const content = (parsed.message && parsed.message.content) || parsed.response || "";
              if (content) {
                accumulated += content;
                onToken(content);
              }
            } catch (_e) {}
          }
          doneResolve();
        });
        upstreamRes.on("error", (err) => doneReject(err.message));
      });

      req.on("error", (err) => doneReject(`Ollama offline (${err.message})`));
      req.on("timeout", () => {
        req.destroy();
        doneReject("Timeout conectando con Ollama");
      });
      req.write(bodyData);
      req.end();
    });
  }

  async function handleRequest(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || "/", "http://127.0.0.1");
    } catch (_e) {
      sendJsonError(res, 400, "URL de petición inválida.");
      return;
    }

    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    // ---------------------------------------------------------
    // Versión, Preload, Assets Estáticos & UI
    // ---------------------------------------------------------
    if (pathname === "/api/version" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      try {
        const st = fs.statSync(HTML_FILE_PATH);
        sendJson(res, 200, { build: st.mtimeMs, v: "2.1.0" });
      } catch (_e) {
        sendJson(res, 200, { build: 1, v: "2.1.0" });
      }
      return;
    }

    if (pathname.startsWith("/assets/") && (req.method === "GET" || req.method === "HEAD")) {
      const relAsset = pathname.slice("/assets/".length);
      if (!/^[a-zA-Z0-9._-]+$/.test(relAsset) || relAsset.includes("..")) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Asset not found");
        return;
      }
      const ext = path.extname(relAsset).toLowerCase();
      const mime = ASSET_MIME_TYPES[ext];
      const fullAssetPath = path.resolve(ASSETS_DIR, relAsset);
      const resolvedAssetsBase = path.resolve(ASSETS_DIR) + path.sep;
      if (!mime || !fullAssetPath.startsWith(resolvedAssetsBase) || !fs.existsSync(fullAssetPath)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Asset not found");
        return;
      }
      const stat = fs.statSync(fullAssetPath);
      if (!stat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Asset not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": mime,
        "Content-Length": stat.size,
        "Cache-Control": "no-cache, must-revalidate"
      });
      if (req.method === "HEAD") {
        res.end();
      } else {
        fs.createReadStream(fullAssetPath).pipe(res);
      }
      return;
    }

    if (pathname === "/preload.js" && req.method === "GET") {
      try {
        const content = fs.readFileSync(PRELOAD_PATH, "utf-8");
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(content);
      } catch (_e) {
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

    // ---------------------------------------------------------
    // Skills & Perfiles Cognitivos
    // ---------------------------------------------------------
    if (pathname === "/api/skills" && req.method === "GET") {
      const q = query.q || "";
      const cat = query.cat || "";
      let limit = 2000;
      if (query.limit !== undefined && query.limit !== "") {
        const parsedLimit = Number(query.limit);
        if (Number.isFinite(parsedLimit) && parsedLimit >= 0) {
          limit = parsedLimit;
        }
      }
      const skills = skillsBridge.searchSkills(q, cat, limit);
      const categories = skillsBridge.getCategories();
      const profiles = sanitizeProfilesList(skillsBridge.loadProfiles());
      sendJson(res, 200, {
        ok: true,
        skills,
        categories,
        profiles,
        count: skills.length,
        totalCount: skills.totalCount ?? skills.length
      });
      return;
    }

    if (pathname === "/api/skills/content" && req.method === "GET") {
      const skillId = (query.id || "").trim();
      if (!skillId) {
        sendJsonError(res, 400, "Parámetro 'id' requerido.");
        return;
      }
      const content = skillsBridge.getSkillContent(skillId);
      if (content === null) {
        sendJsonError(res, 404, `Skill no encontrado: ${skillId}`, { id: skillId });
        return;
      }
      sendJson(res, 200, { ok: true, id: skillId, content });
      return;
    }

    if (pathname === "/api/profiles/content" && req.method === "GET") {
      const profileId = (query.id || "").trim();
      if (!profileId) {
        sendJsonError(res, 400, "Parámetro 'id' requerido.");
        return;
      }
      const content = skillsBridge.getProfileContent(profileId);
      if (content === null) {
        sendJsonError(res, 404, `Perfil no encontrado: ${profileId}`, { id: profileId });
        return;
      }
      sendJson(res, 200, { ok: true, id: profileId, content });
      return;
    }

    // ---------------------------------------------------------
    // Proyectos y Preview Puro (Sin Escribir en Disco)
    // ---------------------------------------------------------
    if (pathname === "/api/projects" && req.method === "GET") {
      const hierarchy = bridge.getSidebarHierarchy();
      const projects = bridge.listProjects();
      const convId = query.conversationId || null;
      const token = query.token || null;
      const active = bridge.getActiveProject(query.project || null, convId, token);
      const stateKey = (!active || active.isGeneral || String(active.name || "").toLowerCase() === "general")
        ? "General"
        : (active.path || active.name);
      const projectState = memoryStore.getProjectState(stateKey);
      sendJson(res, 200, { ok: true, hierarchy, projects, active, projectState });
      return;
    }

    if (pathname === "/api/context" && req.method === "GET") {
      const projName = query.project || query.projectPath || null;
      const convId = query.conversationId || null;
      const token = query.token || null;
      const ctx = bridge.buildProjectContext(projName, convId, token, {
        writeToDisk: false,
        skillId: query.skillId || null,
        profileId: query.profileId || null,
        customSystemPrompt: query.customSystemPrompt || null
      });
      if (!ctx) {
        sendJsonError(res, 404, "No project found");
        return;
      }
      sendJson(res, 200, { ok: true, ...ctx });
      return;
    }

    if (pathname === "/api/project/preview-context" && req.method === "GET") {
      const proj = query.project || query.projectPath || null;
      const convId = query.conversationId || null;
      const token = query.token || null;
      const ctx = bridge.buildProjectContext(proj, convId, token, {
        writeToDisk: false,
        skillId: query.skillId || null,
        profileId: query.profileId || null,
        customSystemPrompt: query.customSystemPrompt || null
      });
      if (!ctx) {
        sendJsonError(res, 404, "No project found");
        return;
      }
      sendJson(res, 200, { ok: true, ...ctx });
      return;
    }

    if (pathname === "/api/context/select" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const target = payload.projectName || payload.project || payload.selection || null;
      const ctx = bridge.buildProjectContext(target, payload.conversationId || null, payload.token || null, {
        writeToDisk: false,
        skillId: payload.skillId || null,
        profileId: payload.profileId || null,
        customSystemPrompt: payload.customSystemPrompt || null
      });
      const activeProj = ctx ? ctx.project : null;
      const isGen = !activeProj || activeProj.isGeneral || String(activeProj.name || "").toLowerCase() === "general";
      if (activeProj) {
        bridge.setActiveProjectName(isGen ? "General" : activeProj.name);
      } else if (target) {
        bridge.setActiveProjectName(target);
      }
      const stateKey = isGen ? "General" : (activeProj.path || activeProj.name);

      const statePatch = {};
      if (typeof payload.lastSessionId === "string" && payload.lastSessionId.trim()) {
        statePatch.lastSessionId = payload.lastSessionId.trim();
      }
      if (Array.isArray(payload.selectedFiles)) {
        statePatch.selectedFiles = payload.selectedFiles;
      }
      if (typeof payload.githubToggle === "boolean") statePatch.githubToggle = payload.githubToggle;
      if (typeof payload.githubRepo === "string") statePatch.githubRepo = payload.githubRepo;
      if (typeof payload.netlifyToggle === "boolean") statePatch.netlifyToggle = payload.netlifyToggle;
      if (typeof payload.netlifySite === "string") statePatch.netlifySite = payload.netlifySite;
      if (typeof payload.netlifyPublishDir === "string") statePatch.netlifyPublishDir = payload.netlifyPublishDir;

      const projectState = (Object.keys(statePatch).length > 0 || (activeProj && !isGen))
        ? memoryStore.updateProjectState(stateKey, statePatch)
        : memoryStore.getProjectState(stateKey);

      sendJson(res, 200, { ok: true, active: activeProj, projectState });
      return;
    }

    // ---------------------------------------------------------
    // Carpetas, Selección de Archivos, Lectura, Guardado y Patch
    // ---------------------------------------------------------
    if (pathname === "/api/project/folders" && req.method === "GET") {
      const baseDir = getBaseProjectsDir();
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
      sendJson(res, 200, { ok: true, folders: dirs, base: baseDir });
      return;
    }

    if (pathname === "/api/project/load-folder" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const folderPath = typeof (payload.folderPath || payload.path) === "string"
        ? (payload.folderPath || payload.path).trim()
        : "";
      if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
        sendJsonError(res, 400, `La carpeta no existe: ${folderPath}`);
        return;
      }

      bridge.setExplicitFolder(folderPath);
      const resolvedFolder = path.resolve(folderPath);
      const files = bridge.scanProjectFolderDeep(resolvedFolder, "", 0, 4, 100);
      const selected = bridge.getSelectedFiles(resolvedFolder);
      memoryStore.updateProjectState(resolvedFolder, { selectedFiles: selected });

      sendJson(res, 200, {
        ok: true,
        folderPath: resolvedFolder,
        name: path.basename(resolvedFolder),
        files,
        selectedFiles: selected
      });
      return;
    }

    if (pathname === "/api/project/select-files" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const folderPath = typeof payload.folderPath === "string" ? payload.folderPath.trim() : "";
      if (!folderPath) {
        sendJsonError(res, 400, "folderPath requerido");
        return;
      }
      const files = Array.isArray(payload.selectedFiles)
        ? payload.selectedFiles
        : (Array.isArray(payload.files) ? payload.files : []);
      bridge.setSelectedFiles(folderPath, files);
      memoryStore.updateProjectState(path.resolve(folderPath), { selectedFiles: files });
      sendJson(res, 200, { ok: true, count: files.length });
      return;
    }

    if (pathname === "/api/project/read-file" && req.method === "GET") {
      const projName = query.project || query.projectPath || null;
      const filePath = (query.filePath || query.file || "").trim();
      if (!filePath) {
        sendJsonError(res, 400, "filePath requerido");
        return;
      }
      const result = bridge.readProjectFile(projName, filePath);
      if (!result.ok) {
        sendJsonError(res, getReadFileErrorStatus(result.error), result.error);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/project/save-file" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = payload.project || payload.projectPath || null;
      const filePath = typeof payload.filePath === "string" ? payload.filePath.trim() : "";
      const content = typeof payload.content === "string" ? payload.content : String(payload.content ?? "");

      if (!filePath) {
        sendJsonError(res, 400, "filePath requerido");
        return;
      }

      const result = bridge.saveProjectFile(projectName, filePath, content, {
        model: payload.model,
        source: payload.source,
        summary: payload.summary,
        tool: payload.tool
      });

      if (!result.ok) {
        sendJsonError(res, getMutationErrorStatus(result.error), result.error);
        return;
      }

      const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || null);
      let githubSync;
      if (payload.syncGithub && payload.githubRepo) {
        try {
          githubSync = await integrations.syncProjectToGitHub({
            projectName: projInfo.name,
            projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
            repoFullName: payload.githubRepo,
            commitMessage: payload.commitMessage || `Update ${result.relPath} via Local AI Studio`,
            filesModified: [{ relPath: result.relPath, content }],
            initRemoteOnLocal: Boolean(payload.initRemoteOnLocal)
          });
        } catch (syncErr) {
          githubSync = { ok: false, error: safeErrMsg(syncErr) };
        }
      }

      let netlifyDeploy;
      if (payload.deployNetlify && payload.netlifySite) {
        try {
          netlifyDeploy = await integrations.deployToNetlify({
            projectName: projInfo.name,
            projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
            siteId: payload.netlifySite,
            publishDir: payload.netlifyPublishDir || null,
            prod: payload.prod !== false,
            message: payload.commitMessage || `Deploy ${result.relPath} via Local AI Studio`
          });
        } catch (depErr) {
          netlifyDeploy = { ok: false, error: safeErrMsg(depErr) };
        }
      }

      sendJson(res, 200, {
        ...result,
        ...(githubSync ? { githubSync } : {}),
        ...(netlifyDeploy ? { netlifyDeploy } : {})
      });
      return;
    }

    if (pathname === "/api/project/apply-patch" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = payload.project || payload.projectPath || null;
      const filePath = typeof payload.filePath === "string" ? payload.filePath.trim() : "";
      const search = typeof payload.search === "string" ? payload.search : "";
      const replace = typeof payload.replace === "string" ? payload.replace : String(payload.replace ?? "");

      if (!filePath || !search) {
        sendJsonError(res, 400, "filePath y search son obligatorios");
        return;
      }

      const result = bridge.applyProjectPatch(projectName, filePath, search, replace, {
        model: payload.model,
        source: payload.source,
        summary: payload.summary,
        tool: payload.tool
      });

      if (!result.ok) {
        sendJsonError(res, getMutationErrorStatus(result.error), result.error);
        return;
      }

      const projInfo = resolveProjectInfo(projectName, payload.projectPath || null);
      let githubSync;
      if (payload.syncGithub && payload.githubRepo) {
        try {
          const patchedContent = fs.existsSync(result.path) ? fs.readFileSync(result.path, "utf-8") : undefined;
          githubSync = await integrations.syncProjectToGitHub({
            projectName: projInfo.name,
            projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
            repoFullName: payload.githubRepo,
            commitMessage: payload.commitMessage || `Patch ${result.relPath} via Local AI Studio`,
            filesModified: [{ relPath: result.relPath, ...(patchedContent !== undefined ? { content: patchedContent } : {}) }],
            initRemoteOnLocal: Boolean(payload.initRemoteOnLocal)
          });
        } catch (syncErr) {
          githubSync = { ok: false, error: safeErrMsg(syncErr) };
        }
      }

      let netlifyDeploy;
      if (payload.deployNetlify && payload.netlifySite) {
        try {
          netlifyDeploy = await integrations.deployToNetlify({
            projectName: projInfo.name,
            projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
            siteId: payload.netlifySite,
            publishDir: payload.netlifyPublishDir || null,
            prod: payload.prod !== false,
            message: payload.commitMessage || `Deploy patched ${result.relPath} via Local AI Studio`
          });
        } catch (depErr) {
          netlifyDeploy = { ok: false, error: safeErrMsg(depErr) };
        }
      }

      sendJson(res, 200, {
        ...result,
        ...(githubSync ? { githubSync } : {}),
        ...(netlifyDeploy ? { netlifyDeploy } : {})
      });
      return;
    }

    if (pathname === "/api/project/log-progress" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const ok = bridge.recordProjectProgress(payload.project || null, {
        tool: payload.tool || "Local AI Studio",
        model: payload.model || "Ollama",
        task: payload.task || "",
        summary: payload.summary || "",
        filesModified: Array.isArray(payload.filesModified) ? payload.filesModified : []
      });
      sendJson(res, 200, { ok: Boolean(ok) });
      return;
    }

    // ---------------------------------------------------------
    // Memoria Persistente (/api/memory/*)
    // ---------------------------------------------------------
    if (pathname === "/api/memory/chats/migrate" && req.method === "POST") {
      const payload = await readJsonBody(req);
      const sessions = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.sessions) ? payload.sessions : (payload && Array.isArray(payload.chats) ? payload.chats : null));
      if (!Array.isArray(sessions)) {
        sendJsonError(res, 400, "Se requiere un arreglo de sesiones ('sessions') para migrar.");
        return;
      }
      const migrated = memoryStore.migrateLegacySessions(sessions);
      sendJson(res, 200, { ok: true, ...migrated });
      return;
    }

    if (pathname === "/api/memory/chats" && req.method === "GET") {
      const chats = memoryStore.listChats({
        project: query.project || undefined,
        convId: query.convId || undefined,
        query: query.q || query.query || undefined
      });
      sendJson(res, 200, { ok: true, chats });
      return;
    }

    if (pathname === "/api/memory/chats" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const chat = memoryStore.saveChat(payload);
      if (chat && chat.id && chat.project && chat.project.trim()) {
        const stateTarget = (chat.projectPath && chat.projectPath.trim())
          ? { project: chat.project, projectPath: chat.projectPath }
          : chat.project;
        memoryStore.updateProjectState(stateTarget, { lastSessionId: chat.id });
      }
      sendJson(res, 200, { ok: true, chat });
      return;
    }

    if (pathname === "/api/memory/chats" && req.method === "DELETE") {
      const id = (query.id || "").trim();
      if (!id) {
        sendJsonError(res, 400, "Parámetro 'id' requerido para eliminar chat.");
        return;
      }
      const del = memoryStore.deleteChat(id);
      if (!del.ok) {
        sendJsonError(res, 400, del.error || "ID inválido");
        return;
      }
      sendJson(res, 200, { ok: true, ...del });
      return;
    }

    if (pathname === "/api/memory/chat" && req.method === "GET") {
      const id = (query.id || "").trim();
      if (!id) {
        sendJsonError(res, 400, "Parámetro 'id' requerido.");
        return;
      }
      const chat = memoryStore.getChat(id);
      if (!chat) {
        sendJsonError(res, 404, "Chat no encontrado");
        return;
      }
      sendJson(res, 200, { ok: true, chat });
      return;
    }

    if (pathname.startsWith("/api/memory/chats/")) {
      const rawId = pathname.slice("/api/memory/chats/".length);
      let chatId = "";
      try {
        chatId = decodeURIComponent(rawId).trim();
      } catch (_e) {
        sendJsonError(res, 400, "ID de chat malformado en la URL.");
        return;
      }
      if (!chatId) {
        sendJsonError(res, 400, "ID de chat requerido.");
        return;
      }

      if (req.method === "GET") {
        const chat = memoryStore.getChat(chatId);
        if (!chat) {
          sendJsonError(res, 404, "Chat no encontrado");
          return;
        }
        sendJson(res, 200, { ok: true, chat });
        return;
      }

      if (req.method === "DELETE") {
        const del = memoryStore.deleteChat(chatId);
        if (!del.ok) {
          sendJsonError(res, 400, del.error || "ID inválido");
          return;
        }
        sendJson(res, 200, { ok: true, ...del });
        return;
      }
    }

    if (pathname === "/api/memory/downloads" && req.method === "GET") {
      let downloads = memoryStore.listDownloads();
      if (query.status && query.status.trim()) {
        const targetStatus = query.status.trim();
        downloads = downloads.filter((d) => d && d.status === targetStatus);
      }
      sendJson(res, 200, { ok: true, downloads });
      return;
    }

    if (pathname === "/api/memory/changes" && req.method === "GET") {
      let limit = 100;
      if (query.limit !== undefined && query.limit !== "") {
        const parsedLimit = Number(query.limit);
        if (Number.isFinite(parsedLimit) && parsedLimit >= 0) {
          limit = parsedLimit;
        }
      }
      const changes = memoryStore.listChanges(query.project || null, limit);
      sendJson(res, 200, { ok: true, changes });
      return;
    }

    if (pathname === "/api/memory/project-state" && req.method === "GET") {
      let keyInput;
      if (query.projectPath && query.projectPath.trim()) {
        keyInput = { project: query.project || undefined, projectPath: query.projectPath.trim() };
      } else if (query.project && query.project.trim()) {
        keyInput = query.project.trim();
      } else {
        keyInput = resolveProjectInfo().stateKey;
      }
      const state = memoryStore.getProjectState(keyInput);
      sendJson(res, 200, { ok: true, state });
      return;
    }

    if (pathname === "/api/memory/project-state" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      let keyInput;
      if (payload.projectPath && String(payload.projectPath).trim()) {
        keyInput = { project: payload.project || undefined, projectPath: String(payload.projectPath).trim() };
      } else if (payload.project && String(payload.project).trim()) {
        keyInput = String(payload.project).trim();
      } else {
        keyInput = resolveProjectInfo().stateKey;
      }
      const nestedPatch = (payload.patch && typeof payload.patch === "object" && !Array.isArray(payload.patch))
        ? payload.patch
        : {};
      const patch = { ...payload, ...nestedPatch };
      delete patch.patch;

      const state = memoryStore.updateProjectState(keyInput, patch);
      sendJson(res, 200, { ok: true, state });
      return;
    }

    // ---------------------------------------------------------
    // Prompt Maestro Editable (/api/prompt/master)
    // ---------------------------------------------------------
    if (pathname === "/api/prompt/master" && req.method === "GET") {
      const cfg = memoryStore.getMasterPromptConfig(query.project || null);
      sendJson(res, 200, { ok: true, ...cfg });
      return;
    }

    if (pathname === "/api/prompt/master" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const cfg = memoryStore.saveMasterPromptConfig(payload);
      sendJson(res, 200, { ok: true, ...cfg });
      return;
    }

    // ---------------------------------------------------------
    // Entrar en Contexto (Telemetría Forense + Streaming + Fallback)
    // ---------------------------------------------------------
    if (pathname === "/api/project/enter-context" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const enterPayload = contextAnalyzer.buildEnterContextPayload({
        projectName: payload.project || payload.projectPath || null,
        convId: payload.conversationId || null,
        token: payload.token || null,
        skillId: payload.skillId || null,
        profileId: payload.profileId || null,
        customSystemPrompt: payload.customSystemPrompt || null
      });

      const fallbackReport = buildFallbackEnterContextReport(enterPayload);

      const persistCheckpoint = (mode, summaryText, modelName) => {
        const proj = enterPayload.telemetry && enterPayload.telemetry.project;
        const isGen = !proj || proj.isGeneral || String(proj.name || "").toLowerCase() === "general";
        const stateKey = isGen ? "General" : (proj.path || proj.name);
        return memoryStore.updateProjectState(stateKey, {
          lastContextAnalysis: {
            timestamp: new Date().toISOString(),
            summary: String(summaryText || "").slice(0, 1200),
            model: String(modelName || "telemetry-fallback"),
            mode
          }
        });
      };

      if (payload.telemetryOnly === true || payload.stream === false) {
        const projectState = persistCheckpoint("telemetry_only", fallbackReport, payload.model || "telemetry-only");
        sendJson(res, 200, {
          ok: true,
          telemetry: enterPayload.telemetry,
          digestMarkdown: enterPayload.digestMarkdown,
          promptPackage: enterPayload.promptPackage,
          fallbackReport,
          projectState
        });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const checklistSummary = (enterPayload.telemetry && enterPayload.telemetry.brain && enterPayload.telemetry.brain.checklistSummary)
        || { pending: 0, inProgress: 0, completed: 0 };

      res.write(JSON.stringify({
        type: "telemetry",
        project: enterPayload.telemetry.project,
        digestMarkdown: enterPayload.digestMarkdown,
        metrics: enterPayload.promptPackage.metrics,
        checklistSummary
      }) + "\n");

      const target = detectEngineTarget(payload);
      if (!target.model || !target.model.trim()) {
        const offlineText = buildFallbackEnterContextReport(enterPayload, "No se especificó un modelo activo");
        res.write(JSON.stringify({
          model: "telemetry-fallback",
          message: { role: "assistant", content: offlineText },
          done: false
        }) + "\n");
        persistCheckpoint("stream_fallback", offlineText, "telemetry-fallback");
        res.write(JSON.stringify({
          model: "telemetry-fallback",
          message: { role: "assistant", content: "" },
          done: true,
          fallback: true
        }) + "\n");
        res.end();
        return;
      }

      let streamedText = "";
      try {
        await streamAnalysisFromEngine(
          {
            engine: target.engine,
            model: target.model,
            systemPrompt: enterPayload.promptPackage.systemPrompt,
            userPrompt: enterPayload.promptPackage.userPrompt,
            payload
          },
          (tokenChunk) => {
            streamedText += tokenChunk;
            if (!res.writableEnded) {
              res.write(JSON.stringify({
                model: target.model,
                message: { role: "assistant", content: tokenChunk },
                done: false
              }) + "\n");
            }
          }
        );

        if (!streamedText.trim()) {
          throw new Error("El motor de IA devolvió una respuesta vacía");
        }

        persistCheckpoint("stream_ai", streamedText, target.model);
        if (!res.writableEnded) {
          res.write(JSON.stringify({
            model: target.model,
            message: { role: "assistant", content: "" },
            done: true,
            fallback: false
          }) + "\n");
          res.end();
        }
      } catch (engineErr) {
        const reason = safeErrMsg(engineErr.message || "Motor de IA offline");
        const offlineReport = buildFallbackEnterContextReport(enterPayload, reason);
        const contentToEmit = streamedText.trim()
          ? `\n\n${offlineReport}`
          : offlineReport;

        if (!res.writableEnded) {
          res.write(JSON.stringify({
            model: target.model,
            message: { role: "assistant", content: contentToEmit },
            done: false,
            fallback: true
          }) + "\n");
        }
        persistCheckpoint("stream_fallback", `${streamedText}${contentToEmit}`, target.model);
        if (!res.writableEnded) {
          res.write(JSON.stringify({
            model: target.model,
            message: { role: "assistant", content: "" },
            done: true,
            fallback: true
          }) + "\n");
          res.end();
        }
      }
      return;
    }

    // ---------------------------------------------------------
    // Modelos e Inferencia DirectML / Ollama / Free.ai
    // ---------------------------------------------------------
    if (pathname === "/api/ollama/modelfile" && req.method === "GET") {
      const model = (query.model || "").trim();
      if (!model) {
        sendJsonError(res, 400, "Parámetro 'model' requerido.");
        return;
      }

      const postData = JSON.stringify({ name: model });
      const reqOptions = {
        hostname: config.ollamaHost,
        port: config.ollamaPort,
        path: "/api/show",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData)
        }
      };

      const sReq = http.request(reqOptions, (sRes) => {
        let data = "";
        sRes.on("data", (c) => { data += c; });
        sRes.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (sRes.statusCode !== 200) {
              sendJsonError(res, sRes.statusCode === 404 ? 404 : 502, parsed.error || "Error consultando modelfile en Ollama");
              return;
            }
            sendJson(res, 200, {
              ok: true,
              model,
              modelfile: parsed.modelfile || "",
              parameters: parsed.parameters || "",
              template: parsed.template || "",
              system: parsed.system || "",
              details: parsed.details || {}
            });
          } catch (_e) {
            sendJsonError(res, 502, "Respuesta inválida de Ollama.");
          }
        });
      });

      sReq.on("error", (err) => {
        sendJsonError(res, 502, `Ollama no responde: ${err.message}`);
      });

      sReq.write(postData);
      sReq.end();
      return;
    }

    if (pathname === "/api/ollama/create-model" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      if (!payload.name || !payload.modelfile) {
        sendJsonError(res, 400, "Nombre y modelfile son obligatorios.");
        return;
      }

      const postBuffer = Buffer.from(JSON.stringify({
        name: payload.name,
        modelfile: payload.modelfile,
        stream: true
      }), "utf8");

      const createReq = http.request({
        hostname: config.ollamaHost,
        port: config.ollamaPort,
        path: "/api/create",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": postBuffer.length
        }
      }, (createRes) => {
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
          sendJsonError(res, 502, `Ollama no disponible: ${err.message}`);
        }
      });

      createReq.write(postBuffer);
      createReq.end();
      return;
    }

    if (pathname === "/api/directml/status" && req.method === "GET") {
      const isAlive = await checkDirectMLAlive();
      if (!isAlive) {
        sendJson(res, 200, { status: "offline", isAlive: false });
        return;
      }

      await new Promise((resolve) => {
        const hReq = http.get({
          hostname: config.directmlHost,
          port: config.directmlPort,
          path: "/health",
          timeout: 2000
        }, (hRes) => {
          let data = "";
          hRes.on("data", (c) => { data += c; });
          hRes.on("end", () => {
            if (hRes.statusCode === 200) {
              try {
                const h = JSON.parse(data);
                sendJson(res, 200, { status: "online", isAlive: true, ...h });
                resolve();
                return;
              } catch (_e) {}
            }
            sendJson(res, 200, { status: "online", isAlive: true });
            resolve();
          });
        });
        hReq.on("error", () => {
          sendJson(res, 200, { status: "offline", isAlive: false });
          resolve();
        });
        hReq.on("timeout", () => {
          hReq.destroy();
          sendJson(res, 200, { status: "offline", isAlive: false });
          resolve();
        });
      });
      return;
    }

    if (pathname === "/api/directml/start" && req.method === "POST") {
      const result = await startDirectMLServer();
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (pathname === "/api/directml/load" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const modelName = payload.model || "";
      if (!modelName) {
        sendJsonError(res, 400, "model es obligatorio para cargar en DirectML.");
        return;
      }

      const isAlive = await checkDirectMLAlive();
      if (!isAlive) {
        await startDirectMLServer();
      }

      const postBuf = Buffer.from(JSON.stringify({ model: modelName }), "utf8");
      await new Promise((resolve) => {
        const lReq = http.request({
          hostname: config.directmlHost,
          port: config.directmlPort,
          path: "/v1/models/load",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": postBuf.length
          }
        }, (lRes) => {
          let data = "";
          lRes.on("data", (c) => { data += c; });
          lRes.on("end", () => {
            if (!res.headersSent) {
              res.writeHead(lRes.statusCode, { "Content-Type": "application/json; charset=utf-8" });
            }
            res.end(data);
            resolve();
          });
        });

        lReq.on("error", (err) => {
          sendJsonError(res, 502, `DirectML no disponible: ${err.message}`);
          resolve();
        });

        lReq.write(postBuf);
        lReq.end();
      });
      return;
    }

    if (pathname === "/api/tags" && req.method === "GET") {
      const fetchOllama = new Promise((resolve) => {
        const oReq = http.get({
          hostname: config.ollamaHost,
          port: config.ollamaPort,
          path: "/api/tags",
          timeout: 4000
        }, (oRes) => {
          let data = "";
          oRes.on("data", (c) => { data += c; });
          oRes.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.models || []);
            } catch (_e) {
              resolve([]);
            }
          });
        });
        oReq.on("error", () => resolve([]));
        oReq.on("timeout", () => { oReq.destroy(); resolve([]); });
      });

      const fetchDirectML = new Promise((resolve) => {
        const dReq = http.get({
          hostname: config.directmlHost,
          port: config.directmlPort,
          path: "/v1/models",
          timeout: 4000
        }, (dRes) => {
          let data = "";
          dRes.on("data", (c) => { data += c; });
          dRes.on("end", () => {
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.data || []);
            } catch (_e) {
              resolve([]);
            }
          });
        });
        dReq.on("error", () => resolve([]));
        dReq.on("timeout", () => { dReq.destroy(); resolve([]); });
      });

      const fetchFreeAi = freeai.fetchModels().catch((e) => {
        console.warn("[Local AI Chat] Free.ai fetch error:", safeErrMsg(e));
        return [];
      });

      try {
        const [ollamaModels, directmlModels, freeAiModels] = await Promise.all([fetchOllama, fetchDirectML, fetchFreeAi]);
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

        const formattedLocal = (ollamaModels || []).map((m) => ({
          ...m,
          displayName: `${m.name} (Local)`,
          isLocal: true,
          provider: "Ollama Local"
        }));

        const formattedDirectML = actualDML.map((m) => ({
          name: m.id || m.name,
          id: m.id || m.name,
          displayName: m.displayName || `${m.id || m.name} (DirectML GPU)`,
          size: m.size || "DirectML",
          isDirectML: true,
          active: m.active || false,
          provider: "DirectML Nativo",
          status: m.status || "ready"
        }));

        const formattedFreeAi = (freeAiModels || []).map((m) => ({
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
        sendJson(res, 200, {
          models: combined,
          directmlModels: formattedDirectML,
          freeAiModels: formattedFreeAi,
          localModels: formattedLocal
        });
      } catch (_err) {
        sendJson(res, 200, { models: [], directmlModels: [], freeAiModels: [], localModels: [] });
      }
      return;
    }

    if (pathname === "/api/freeai/models" && req.method === "GET") {
      try {
        const models = await freeai.fetchModels();
        sendJson(res, 200, { ok: true, count: models.length, models });
      } catch (err) {
        sendJsonError(res, 502, err);
      }
      return;
    }

    // ---------------------------------------------------------
    // Chat Unificado (DirectML / Free.ai / Ollama)
    // ---------------------------------------------------------
    if (pathname === "/api/chat" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      if (payload.messages !== undefined && !Array.isArray(payload.messages)) {
        sendJsonError(res, 400, "El campo 'messages' debe ser un arreglo.");
        return;
      }

      const rawProjIdentifier = payload.project || payload.projectPath || null;
      const convId = payload.conversationId || null;
      const ctx = bridge.buildProjectContext(rawProjIdentifier, convId, payload.token || null, {
        writeToDisk: false,
        skillId: payload.skillId || null,
        profileId: payload.profileId || null,
        customSystemPrompt: payload.customSystemPrompt || null,
        modelOverridesPrompt: payload.modelSystemPrompt || null
      });

      const combinedSysPrompt = ctx && ctx.systemPrompt ? ctx.systemPrompt : "";
      const unifiedMessages = injectSystemMessage(payload.messages, combinedSysPrompt);
      const target = detectEngineTarget(payload);

      if (target.engine === "directml") {
        try {
          const isAlive = await checkDirectMLAlive();
          if (!isAlive) {
            await startDirectMLServer();
          }

          const dmlPayload = JSON.stringify({
            model: target.model,
            messages: unifiedMessages,
            stream: payload.stream !== false,
            max_tokens: payload.max_tokens || 2048,
            temperature: payload.temperature !== undefined ? payload.temperature : 0.7
          });
          proxyToDirectML("/v1/chat/completions", "POST", dmlPayload, res);
        } catch (dmlErr) {
          sendJsonError(res, 502, `Error en DirectML: ${safeErrMsg(dmlErr)}`);
        }
        return;
      }

      if (target.engine === "freeai") {
        try {
          await freeai.streamChat(
            {
              ...payload,
              messages: unifiedMessages
            },
            res,
            combinedSysPrompt
          );
        } catch (freeErr) {
          if (!res.headersSent) {
            sendJsonError(res, 502, `Error en Free.ai: ${safeErrMsg(freeErr)}`);
          } else if (!res.writableEnded) {
            res.end();
          }
        }
        return;
      }

      const ollamaPayload = {
        ...payload,
        messages: unifiedMessages
      };
      if (payload.modelfileOptions && typeof payload.modelfileOptions === "object") {
        ollamaPayload.options = { ...(payload.options || {}), ...payload.modelfileOptions };
      }

      proxyToOllama("/api/chat", "POST", JSON.stringify(ollamaPayload), res);
      return;
    }

    // ---------------------------------------------------------
    // Integraciones Cloud & Hugging Face (/api/integrations/*)
    // ---------------------------------------------------------
    if (pathname === "/api/integrations/status" && req.method === "GET") {
      sendJson(res, 200, {
        ok: true,
        status: envLoader.getEnvStatus(),
        defaultModelsDir: integrations.DEFAULT_MODELS_DIR
      });
      return;
    }

    if (pathname === "/api/integrations/github/repos" && req.method === "GET") {
      const projInfo = resolveProjectInfo(query.project || null, query.projectPath || null);
      const forceRefresh = query.refresh === "1" || query.refresh === "true";
      const targetPath = projInfo.isGeneral ? null : (projInfo.path || null);
      const result = await integrations.getGitHubStatusAndRepos(targetPath, forceRefresh);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/integrations/github/create-repo" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const repoName = typeof payload.name === "string" ? payload.name.trim() : "";
      if (!repoName) {
        sendJsonError(res, 400, "name es obligatorio para crear el repositorio en GitHub.");
        return;
      }
      const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || payload.localProjectPath || null);
      const localProjectPath = payload.localProjectPath || payload.projectPath || (projInfo.isGeneral ? null : projInfo.path);
      const isPrivate = payload.private !== undefined
        ? Boolean(payload.private)
        : (payload.isPrivate !== undefined ? Boolean(payload.isPrivate) : true);
      const linkAndPush = payload.linkAndPush !== undefined ? Boolean(payload.linkAndPush) : true;

      const result = await integrations.createGitHubRepo({
        name: repoName,
        description: payload.description || "",
        isPrivate,
        localProjectPath,
        linkAndPush
      });
      sendJson(res, result.ok ? 200 : getIntegrationMutatorStatus(result.error), result);
      return;
    }

    if (pathname === "/api/integrations/github/sync" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
      const result = await integrations.syncProjectToGitHub({
        projectName: projInfo.name,
        projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
        repoFullName: payload.repoFullName || payload.githubRepo || "",
        commitMessage: payload.commitMessage || "",
        filesModified: Array.isArray(payload.filesModified) ? payload.filesModified : [],
        initRemoteOnLocal: Boolean(payload.initRemoteOnLocal)
      });
      sendJson(res, result.ok ? 200 : getIntegrationMutatorStatus(result.error), result);
      return;
    }

    if (pathname === "/api/integrations/netlify/sites" && req.method === "GET") {
      const projInfo = resolveProjectInfo(query.project || null, query.projectPath || null);
      const forceRefresh = query.refresh === "1" || query.refresh === "true";
      const targetPath = projInfo.isGeneral ? null : (projInfo.path || null);
      const result = await integrations.getNetlifyStatusAndSites(targetPath, forceRefresh);
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/integrations/netlify/create-site" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
      const targetPath = payload.projectPath || (projInfo.isGeneral ? null : projInfo.path);
      const result = await integrations.createNetlifySite({
        name: payload.name || "",
        projectPath: targetPath,
        linkLocal: payload.linkLocal !== false
      });
      sendJson(res, result.ok ? 200 : getIntegrationMutatorStatus(result.error), result);
      return;
    }

    if (pathname === "/api/integrations/netlify/deploy" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
      const targetPath = payload.projectPath || (projInfo.isGeneral ? null : projInfo.path);
      const siteId = payload.siteId || payload.netlifySite || "";
      if (!siteId) {
        sendJsonError(res, 400, "siteId es obligatorio para desplegar en Netlify.");
        return;
      }
      if (!targetPath) {
        sendJsonError(res, 400, "projectPath o proyecto activo es obligatorio para desplegar en Netlify.");
        return;
      }
      const result = await integrations.deployToNetlify({
        projectName: projInfo.name,
        projectPath: targetPath,
        siteId,
        publishDir: payload.publishDir || payload.netlifyPublishDir || null,
        prod: payload.prod !== false,
        message: payload.message || ""
      });
      sendJson(res, result.ok ? 200 : getIntegrationMutatorStatus(result.error), result);
      return;
    }

    if (pathname === "/api/integrations/hf/search" && req.method === "GET") {
      const result = await integrations.searchHuggingFace({
        query: query.q || "",
        type: query.type || "model",
        limit: query.limit ? Number(query.limit) : 15
      });
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/integrations/hf/pick-folder" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const result = await integrations.pickDestinationFolderWindows(
        payload.initialDir || integrations.DEFAULT_MODELS_DIR
      );
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/integrations/hf/download" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
      const targetProjPath = payload.projectPath || (projInfo.isGeneral ? null : projInfo.path);
      try {
        const result = await integrations.startHfDownload({
          repoId: payload.repoId,
          repoType: payload.repoType || "model",
          revision: payload.revision || null,
          targetDir: payload.targetDir,
          projectPath: targetProjPath,
          linkToProject: Boolean(payload.linkToProject)
        });
        sendJson(res, 200, result);
      } catch (err) {
        if (err && err.statusCode === 400) {
          sendJson(res, 400, {
            ok: false,
            code: err.code || "BAD_REQUEST",
            error: safeErrMsg(err.message)
          });
          return;
        }
        sendJsonError(res, err.statusCode || 500, err, { code: err && err.code ? err.code : "HF_DOWNLOAD_ERROR" });
      }
      return;
    }

    if (pathname === "/api/integrations/hf/downloads" && req.method === "GET") {
      if (query.jobId && query.jobId.trim()) {
        const job = integrations.getHfDownload(query.jobId.trim());
        if (!job) {
          sendJsonError(res, 404, "Descarga HF no encontrada");
          return;
        }
        sendJson(res, 200, { ok: true, job });
        return;
      }
      const downloads = integrations.listHfDownloads(
        query.status && query.status.trim() ? { status: query.status.trim() } : {}
      );
      sendJson(res, 200, { ok: true, downloads });
      return;
    }

    if (pathname === "/api/integrations/hf/cancel" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const jobId = typeof payload.jobId === "string" ? payload.jobId.trim() : "";
      if (!jobId) {
        sendJsonError(res, 400, "jobId requerido");
        return;
      }
      const result = integrations.cancelHfDownload(jobId);
      sendJson(res, 200, result);
      return;
    }

    // ---------------------------------------------------------
    // Fallback UI HTML (solo rutas GET no-API, sin caché WebView)
    // ---------------------------------------------------------
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      try {
        const html = fs.readFileSync(HTML_FILE_PATH, "utf-8");
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0"
        });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Error loading ui.html: " + safeErrMsg(e));
      }
      return;
    }

    if (pathname.startsWith("/api/")) {
      sendJsonError(res, 404, `Endpoint no encontrado: ${req.method} ${pathname}`);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const status = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 500;
      if (!res.headersSent) {
        sendJsonError(res, status, err);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

if (require.main === module) {
  process.on("uncaughtException", (err) => {
    console.error("[Local AI Chat Sidecar Uncaught]", safeErrMsg(err));
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[Local AI Chat Sidecar Rejection]", safeErrMsg(reason));
  });

  const PORT = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT
    ? parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT, 10)
    : DEFAULT_PORT;

  const server = createStudioServer();

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[Local AI Chat Sidecar] Puerto ${PORT} en uso, asignando dinámico...`);
      server.listen(0, "127.0.0.1");
    } else {
      console.error("[Local AI Chat Sidecar Error]", safeErrMsg(err));
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    const actualPort = server.address().port;
    console.log(`[Local AI Studio] Sidecar running on http://127.0.0.1:${actualPort}`);
  });
}

module.exports = {
  createStudioServer,
  readJsonBody,
  resolveProjectInfo,
  buildFallbackEnterContextReport
};
