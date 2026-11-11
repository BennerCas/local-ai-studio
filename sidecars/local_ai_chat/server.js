const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const envLoader = require("../../env-loader.js");
envLoader.loadAllEnv();

const bridge = require("../../context-bridge.js");
const memoryStore = require("../../memory-store.js");
const contextAnalyzer = require("../../context-analyzer.js");
const skillsBridge = require("../../skills-bridge.js");
const freeai = require("../../freeai-bridge.js");
const integrations = require("../../integrations-bridge.js");
const hardwareAdvisor = require("../../hardware-advisor.js");
const ttsBridge = require("../../tts-bridge.js");

const DEFAULT_PORT = 63719;
const BIND_HOST = process.env.LOCAL_AI_HOST || "127.0.0.1";
const DEFAULT_OLLAMA_HOST = "127.0.0.1";
const DEFAULT_OLLAMA_PORT = 11434;
const DEFAULT_DIRECTML_HOST = "127.0.0.1";
const DEFAULT_DIRECTML_PORT = 8002;
const DIRECTML_SCRIPT = "C:\\antigravityAS\\Modelos -ai-brains\\api_openai.py";
const PRELOAD_PATH = "C:\\Users\\Benner\\.gemini\\antigravity\\lib\\node_modules\\sidecar_sdk\\preload.js";
const HTML_FILE_PATH = path.join(__dirname, "ui.html");
const HTML_V2_FILE_PATH = path.join(__dirname, "ui-v2.html");
const ASSETS_DIR = path.join(__dirname, "assets");
const TRAY_ICO_PATH = path.resolve(__dirname, "..", "..", "tray_icon.ico");
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

function buildProjectCompatibilitySummary(opts = {}) {
  const ctx = bridge.buildProjectContext(opts.projectName || null, opts.convId || null, opts.token || null, {
    writeToDisk: false,
    skillId: opts.skillId || null,
    skillIds: opts.skillIds || opts.skillId || null,
    profileId: opts.profileId || null,
    customSystemPrompt: opts.customSystemPrompt || null,
    modelOverridesPrompt: opts.modelOverridesPrompt || null,
    selectedFiles: Array.isArray(opts.selectedFiles) ? opts.selectedFiles : undefined
  });
  if (!ctx) return { ctx: null, directmlCompatibility: null };
  const extraChars = Math.max(0, Math.round(Number(opts.extraChars) || 0));
  if (extraChars > 0) {
    const compat = bridge.evaluateDirectmlPromptCompatibility({
      totalChars: ctx.metrics ? ctx.metrics.totalChars : 0,
      extraChars,
      bySection: ctx.metrics ? ctx.metrics.bySection : {},
      projectName: ctx.project ? ctx.project.name : "General",
      isGeneral: Boolean(ctx.project && ctx.project.isGeneral)
    });
    return { ctx, directmlCompatibility: compat };
  }
  return { ctx, directmlCompatibility: ctx.directmlCompatibility || null };
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

function resolveRequestProjectTarget(projectName = null, projectPath = null, customPath = null) {
  const cleanProj = (typeof projectName === "string" && projectName.trim()) ? projectName.trim() : null;
  if (cleanProj && cleanProj.startsWith("conv:")) {
    return cleanProj;
  }
  const rawPath = (typeof projectPath === "string" && projectPath.trim())
    ? projectPath.trim()
    : ((typeof customPath === "string" && customPath.trim()) ? customPath.trim() : "");
  if (rawPath) {
    try {
      const resolved = path.resolve(rawPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch (_e) {}
  }
  return cleanProj;
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
    color: p.color || "",
    isBundle: Boolean(p.isBundle),
    skillsCount: p.skillsCount || 0
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
  const cleanSrc = String(payload.source || "").trim().toLowerCase();
  const explicitOllama = cleanSrc === "local" || cleanSrc === "ollama";
  const explicitFreeAi = cleanSrc === "freeai" || cleanSrc === "free.ai" || cleanSrc === "free-ai" || cleanSrc === "cloud";

  const isDirectML = !explicitOllama && !explicitFreeAi && (
    payload.isDirectML === true ||
    cleanSrc === "directml" ||
    cleanSrc === "dml" ||
    rawModel.startsWith("directml:") ||
    (!cleanSrc && (lowerModel.includes("directml") || lowerModel.includes("onnx")))
  );

  const isFreeAi = !isDirectML && !explicitOllama && (
    payload.isFreeAi === true ||
    explicitFreeAi ||
    rawModel.startsWith("freeai:")
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
    model: rawModel.replace(/^ollama:/i, "")
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

function pickDefaultModelForSource(catalog, source) {
  const norm = hardwareAdvisor.normalizeEngineSource(source);
  if (norm === "directml") {
    const first = (catalog.directmlModels && catalog.directmlModels[0]) || null;
    return (first && (first.name || first.id)) || "Phi-3.5-mini-instruct-ONNX";
  }
  if (norm === "freeai") {
    const first = (catalog.freeAiModels && catalog.freeAiModels[0]) || null;
    return (first && (first.name || first.id)) || "freeai:qwen7b";
  }
  const firstLocal = (catalog.localModels && catalog.localModels[0]) || null;
  return (firstLocal && (firstLocal.name || firstLocal.model)) || "";
}

function formatMessageAttachmentsForEngine(rawMsg, targetEngine = "any") {
  if (!rawMsg || typeof rawMsg !== "object") return { content: "", images: [] };
  const attachments = Array.isArray(rawMsg.attachments) ? rawMsg.attachments : [];
  const rawContent = rawMsg.content;

  if (Array.isArray(rawContent)) {
    const textParts = [];
    const imageUrls = [];
    const ollamaB64 = [];
    for (const part of rawContent) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" && part.text) {
        textParts.push(String(part.text));
      } else if (part.type === "image_url" && part.image_url && part.image_url.url) {
        const u = String(part.image_url.url);
        imageUrls.push(u);
        const m = u.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
        if (m && m[1]) ollamaB64.push(m[1]);
      }
    }
    if (targetEngine === "freeai" && imageUrls.length > 0) {
      return { content: rawContent, images: [] };
    }
    if (targetEngine === "ollama" && ollamaB64.length > 0) {
      return { content: textParts.join("\n").trim() || "[Imagen adjunta]", images: ollamaB64 };
    }
    const fallbackNote = imageUrls.length > 0 ? `\n[Adjunto multimodal: ${imageUrls.length} imagen(es) incluida(s)]` : "";
    return { content: (textParts.join("\n") + fallbackNote).trim(), images: ollamaB64 };
  }

  let baseText = String(rawContent ?? "");
  const extraTextBlocks = [];
  const imageUrls = [];
  const ollamaB64 = [];

  for (const att of attachments) {
    if (!att || typeof att !== "object") continue;
    const name = String(att.name || "adjunto").slice(0, 120);
    const kind = String(att.kind || att.type || "").toLowerCase();
    if (kind.startsWith("image") || (typeof att.dataUrl === "string" && att.dataUrl.startsWith("data:image/"))) {
      const dataUrl = String(att.dataUrl || att.url || "");
      if (dataUrl) {
        imageUrls.push(dataUrl);
        const m = dataUrl.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
        if (m && m[1]) ollamaB64.push(m[1]);
      }
      extraTextBlocks.push(`[Imagen adjunta: ${name}]`);
    } else {
      const textAtt = typeof att.content === "string"
        ? att.content
        : (typeof att.textContent === "string" ? att.textContent : "");
      if (textAtt.trim()) {
        extraTextBlocks.push(`<archivo_adjunto nombre="${name}">\n${textAtt.slice(0, 16000)}\n</archivo_adjunto>`);
      }
    }
  }

  const combinedText = [baseText, ...extraTextBlocks].filter(Boolean).join("\n\n");
  if (targetEngine === "freeai" && imageUrls.length > 0) {
    const contentArr = [{ type: "text", text: combinedText || "Analiza la imagen adjunta." }];
    for (const url of imageUrls) {
      contentArr.push({ type: "image_url", image_url: { url } });
    }
    return { content: contentArr, images: [] };
  }

  return {
    content: combinedText,
    images: ollamaB64
  };
}

function attachTopLevelAttachmentsToMessages(rawMessages, topAttachments) {
  const list = Array.isArray(rawMessages)
    ? rawMessages.map((m) => (m && typeof m === "object" ? { ...m } : m))
    : [];
  if (!Array.isArray(topAttachments) || topAttachments.length === 0) {
    return list;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (!msg || typeof msg !== "object") continue;
    if (String(msg.role || "").trim() === "user") {
      if (!Array.isArray(msg.attachments) || msg.attachments.length === 0) {
        msg.attachments = topAttachments;
      }
      break;
    }
  }
  return list;
}

function flattenHistoryMessagesForDual(rawMessages, options = {}) {
  const preserveSystem = Boolean(options && options.preserveSystem);
  const targetEngine = (options && options.targetEngine) || "any";
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  const out = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const role = String(raw.role || "user").trim();
    if (role === "system") {
      if (preserveSystem) {
        out.push({ role: "system", content: String(raw.content ?? "") });
      }
      continue;
    }
    if (role === "assistant_dual") {
      const parts = [];
      const aData = raw.dual && raw.dual.agentA;
      const bData = raw.dual && raw.dual.agentB;
      if (aData && String(aData.text || "").trim()) {
        const labelA = aData.roleLabel || aData.model || aData.source || "Agente A";
        parts.push(`[Agente A (${labelA}):\n${String(aData.text).trim()}]`);
      }
      if (bData && String(bData.text || "").trim()) {
        const labelB = bData.roleLabel || bData.model || bData.source || "Agente B";
        parts.push(`[Agente B (${labelB}):\n${String(bData.text).trim()}]`);
      }
      const combined = parts.join("\n\n") || String(raw.content || "");
      if (combined.trim()) {
        out.push({ role: "assistant", content: combined });
      }
      continue;
    }
    const cleanRole = role === "assistant" || role === "user" ? role : "assistant";
    const formatted = formatMessageAttachmentsForEngine(raw, targetEngine);
    const msgEntry = { role: cleanRole, content: formatted.content };
    if (formatted.images && formatted.images.length > 0 && targetEngine === "ollama") {
      msgEntry.images = formatted.images;
    }
    out.push(msgEntry);
  }
  return out;
}

function extractMentionedFilesFromMessages(rawMessages = [], explicitMentions = []) {
  const found = new Set();
  if (Array.isArray(explicitMentions)) {
    for (const m of explicitMentions) {
      if (typeof m === "string" && m.trim()) found.add(m.trim().replace(/^@+/, ""));
    }
  }
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  for (let i = list.length - 1; i >= Math.max(0, list.length - 3); i--) {
    const msg = list[i];
    if (!msg || msg.role !== "user") continue;
    const rawText = typeof msg.content === "string"
      ? msg.content
      : (Array.isArray(msg.content) ? msg.content.map((p) => (p && p.text) || "").join(" ") : "");
    const regex = /@([a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]{1,10})/g;
    let match;
    while ((match = regex.exec(rawText)) !== null) {
      if (match[1]) found.add(match[1].replace(/\\/g, "/"));
    }
  }
  return Array.from(found);
}

function extractLastUserQuery(rawMessages) {
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i];
    if (!msg || msg.role !== "user") continue;
    const rawText = typeof msg.content === "string"
      ? msg.content
      : (Array.isArray(msg.content) ? msg.content.map((p) => (p && p.text) || "").join(" ") : "");
    const text = String(rawText ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 220);
  }
  return "";
}

function buildCompactWebSearchMeta(searchRes = {}) {
  const rawResults = Array.isArray(searchRes.results) ? searchRes.results : [];
  return {
    ok: Boolean(searchRes.ok),
    configured: Boolean(searchRes.configured),
    query: String(searchRes.query || "").slice(0, 160),
    mode: String(searchRes.mode || "web"),
    engine: String(searchRes.engine || "google"),
    poolUsed: searchRes.poolUsed || null,
    totalResults: Number(searchRes.totalResults || rawResults.length || 0),
    results: rawResults.slice(0, 5).map((r) => ({
      title: String((r && r.title) || "").slice(0, 140),
      link: String((r && r.link) || ""),
      snippet: String((r && r.snippet) || "").slice(0, 180),
      source: String((r && r.source) || "").slice(0, 60),
      date: String((r && r.date) || "").slice(0, 40)
    })),
    usage: searchRes.usage || null,
    ...(searchRes.error ? { error: safeErrMsg(searchRes.error).slice(0, 200) } : {})
  };
}

function encodeWebSearchMetaHeader(meta) {
  const clone = {
    ...meta,
    results: Array.isArray(meta.results) ? meta.results.map((r) => ({ ...r })) : []
  };
  let encoded = Buffer.from(JSON.stringify(clone), "utf8").toString("base64");
  if (encoded.length <= 7168) return encoded;
  clone.results = clone.results.map((r) => ({ ...r, snippet: String(r.snippet || "").slice(0, 60) }));
  encoded = Buffer.from(JSON.stringify(clone), "utf8").toString("base64");
  while (encoded.length > 7168 && clone.results.length > 0) {
    clone.results.pop();
    encoded = Buffer.from(JSON.stringify(clone), "utf8").toString("base64");
  }
  return encoded;
}

async function runWebSearchForChat(payload, messagesList) {
  if (!payload || payload.webSearchEnabled !== true) {
    return null;
  }
  const explicitQuery = typeof payload.webSearchQuery === "string" ? payload.webSearchQuery.trim() : "";
  const queryText = (explicitQuery || extractLastUserQuery(messagesList)).slice(0, 220);
  const mode = String(payload.webSearchMode || "web").trim().toLowerCase() || "web";
  if (!queryText) {
    const meta = buildCompactWebSearchMeta({
      ok: false,
      configured: Boolean(envLoader.getEnvStatus().serpApiConfigured),
      query: "",
      mode,
      totalResults: 0,
      results: [],
      error: "No se detectó consulta de usuario para búsqueda web."
    });
    return {
      meta,
      headerValue: encodeWebSearchMetaHeader(meta),
      contextSuffix: ""
    };
  }

  try {
    const searchRes = await integrations.searchWebSerpApi({
      query: queryText,
      mode,
      pool: payload.webSearchPool || "auto",
      num: payload.webSearchNum || 5
    });
    const meta = buildCompactWebSearchMeta(searchRes);
    const contextSuffix = (searchRes.ok && searchRes.contextBlock)
      ? `\n\n${searchRes.contextBlock}\n[Instrucción: Utiliza la información anterior si es relevante y cita explícitamente las fuentes con su título y URL exacta.]`
      : "";
    return {
      meta,
      headerValue: encodeWebSearchMetaHeader(meta),
      contextSuffix
    };
  } catch (err) {
    const meta = buildCompactWebSearchMeta({
      ok: false,
      configured: Boolean(envLoader.getEnvStatus().serpApiConfigured),
      query: queryText,
      mode,
      totalResults: 0,
      results: [],
      error: safeErrMsg(err)
    });
    return {
      meta,
      headerValue: encodeWebSearchMetaHeader(meta),
      contextSuffix: ""
    };
  }
}

function createStudioServer(options = {}) {
  const config = {
    ollamaHost: options.ollamaHost || process.env.LOCAL_AI_OLLAMA_HOST || DEFAULT_OLLAMA_HOST,
    ollamaPort: Number(options.ollamaPort || process.env.LOCAL_AI_OLLAMA_PORT || DEFAULT_OLLAMA_PORT),
    directmlHost: options.directmlHost || process.env.LOCAL_AI_DIRECTML_HOST || DEFAULT_DIRECTML_HOST,
    directmlPort: Number(options.directmlPort || process.env.LOCAL_AI_DIRECTML_PORT || DEFAULT_DIRECTML_PORT),
    autoStartDirectML: options.autoStartDirectML !== false,
    telemetryOverride: options.telemetryOverride || null,
    skipWindowsApply: options.skipWindowsApply === true,
    allowHostProcessControl: options.allowHostProcessControl !== false
  };
  let activeDirectmlEnv = {};
  const projectPreviewProcesses = new Map();
  const PREVIEW_ENTRY_CANDIDATES = ["src/ui/index.html", "index.html", "public/index.html", "dist/index.html"];
  const PREVIEW_ALLOWED_SCRIPTS = ["dev", "preview", "start"];

  function buildPreviewBridgeScript() {
    return `<script data-local-ai-preview-bridge="1">
(function(){
  window.addEventListener("error", function(ev){
    try {
      window.parent.postMessage({
        type: "local-ai-preview-error",
        message: ev.message || "Error de ejecución en UI",
        source: ev.filename || "",
        lineno: ev.lineno || 0,
        colno: ev.colno || 0,
        stack: (ev.error && ev.error.stack) ? String(ev.error.stack) : ""
      }, "*");
    } catch(_e){}
  });
  window.addEventListener("unhandledrejection", function(ev){
    try {
      var reason = ev.reason ? (ev.reason.stack || ev.reason.message || String(ev.reason)) : "Unhandled Promise Rejection";
      window.parent.postMessage({
        type: "local-ai-preview-error",
        message: String(reason),
        source: "Promise",
        lineno: 0,
        colno: 0,
        stack: String(reason)
      }, "*");
    } catch(_e){}
  });
})();
</script>`;
  }

  function injectPreviewBridgeHtml(htmlText) {
    const bridgeScript = buildPreviewBridgeScript();
    if (/<\/body>/i.test(htmlText)) {
      return htmlText.replace(/<\/body>/i, `${bridgeScript}\n</body>`);
    }
    return `${htmlText}\n${bridgeScript}`;
  }

  function findFreeLoopbackPort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = addr && typeof addr === "object" ? addr.port : 0;
        srv.close((closeErr) => {
          if (closeErr) return reject(closeErr);
          resolve(port);
        });
      });
    });
  }

  function tryTcpConnect(host, port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host, port });
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch (_e) {}
        resolve(ok);
      };
      socket.setTimeout(600);
      socket.on("connect", () => finish(true));
      socket.on("timeout", () => finish(false));
      socket.on("error", () => finish(false));
    });
  }

  async function waitForTcpPort(port, timeoutMs = 10000, proc = null) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (proc && (proc.exitCode !== null || proc.signalCode !== null)) {
        return null;
      }
      if (await tryTcpConnect("127.0.0.1", port)) return "127.0.0.1";
      if (await tryTcpConnect("::1", port)) return "::1";
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  function terminatePreviewProcessEntry(entry) {
    return new Promise((resolve) => {
      if (!entry || !entry.proc) {
        resolve(false);
        return;
      }
      const proc = entry.proc;
      const pid = proc.pid;
      if (proc.exitCode !== null) {
        resolve(true);
        return;
      }
      if (process.platform === "win32" && pid) {
        execFile(
          "taskkill",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, timeout: 4000 },
          () => {
            try { proc.kill("SIGKILL"); } catch (_e) {}
            resolve(true);
          }
        );
        return;
      }
      try { proc.kill("SIGTERM"); } catch (_e) {}
      setTimeout(() => {
        try {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        } catch (_e) {}
        resolve(true);
      }, 300);
    });
  }

  async function stopManagedPreview(targetStateKey = null) {
    if (targetStateKey) {
      const entry = projectPreviewProcesses.get(targetStateKey);
      if (!entry) return 0;
      projectPreviewProcesses.delete(targetStateKey);
      await terminatePreviewProcessEntry(entry);
      return 1;
    }
    const entries = Array.from(projectPreviewProcesses.entries());
    projectPreviewProcesses.clear();
    await Promise.all(entries.map(([, entry]) => terminatePreviewProcessEntry(entry)));
    return entries.length;
  }

  function readProjectPackageScripts(projPath) {
    if (!projPath) return {};
    try {
      const pkgPath = path.join(projPath, "package.json");
      if (!fs.existsSync(pkgPath)) return {};
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      return (parsed && parsed.scripts && typeof parsed.scripts === "object") ? parsed.scripts : {};
    } catch (_e) {
      return {};
    }
  }

  function getAvailablePreviewScripts(pkgScripts) {
    return PREVIEW_ALLOWED_SCRIPTS.filter((k) => typeof pkgScripts[k] === "string" && pkgScripts[k].trim());
  }

  function resolvePreviewNpmSpawn(scriptName, port, scriptBody = "") {
    const extraViteArgs = /\bvite\b/i.test(scriptBody) && !/--port\b/i.test(scriptBody)
      ? ["--", "--port", String(port), "--host", "127.0.0.1"]
      : [];
    const npmCliCandidates = [
      path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
    ];
    for (const cliPath of npmCliCandidates) {
      try {
        if (fs.existsSync(cliPath)) {
          return { bin: process.execPath, args: [cliPath, "run", scriptName, ...extraViteArgs] };
        }
      } catch (_e) {}
    }
    if (process.platform === "win32") {
      return { bin: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", "run", scriptName, ...extraViteArgs] };
    }
    return { bin: "npm", args: ["run", scriptName, ...extraViteArgs] };
  }

  function getActiveManagedPreview(stateKey, projectName = null) {
    if (stateKey && projectPreviewProcesses.has(stateKey)) {
      const entry = projectPreviewProcesses.get(stateKey);
      if (entry && entry.proc && entry.proc.exitCode === null) {
        return entry;
      }
      projectPreviewProcesses.delete(stateKey);
    }
    if (projectName) {
      const lowerName = String(projectName).trim().toLowerCase();
      for (const [k, entry] of projectPreviewProcesses.entries()) {
        if (!entry || !entry.proc || entry.proc.exitCode !== null) {
          projectPreviewProcesses.delete(k);
          continue;
        }
        if (String(entry.projName || "").trim().toLowerCase() === lowerName) {
          return entry;
        }
      }
    }
    return null;
  }

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

  async function getDirectmlHealth() {
    const isAlive = await checkDirectMLAlive();
    if (!isAlive) {
      return { status: "offline", isAlive: false };
    }
    return new Promise((resolve) => {
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
              resolve({ status: "online", isAlive: true, ...h });
              return;
            } catch (_e) {}
          }
          resolve({ status: "online", isAlive: true });
        });
      });
      hReq.on("error", () => resolve({ status: "offline", isAlive: false }));
      hReq.on("timeout", () => {
        hReq.destroy();
        resolve({ status: "offline", isAlive: false });
      });
    });
  }

  async function startDirectMLServer(envOverrides = null) {
    if (envOverrides && typeof envOverrides === "object") {
      activeDirectmlEnv = { ...activeDirectmlEnv, ...envOverrides };
    }
    const isAlive = await checkDirectMLAlive();
    if (isAlive) {
      return { ok: true, message: `DirectML ya está activo en http://${config.directmlHost}:${config.directmlPort}` };
    }
    if (!config.autoStartDirectML) {
      return { ok: false, error: "DirectML no está disponible y autoStart está desactivado." };
    }

    try {
      // El backend DirectML deja su salida (incluidas las trazas de error 500)
      // en datos/pruebas/directml-backend.log: sin esto, sus fallos son invisibles.
      let dmlStdio = "ignore";
      try {
        const logDir = path.resolve(__dirname, "../../datos/pruebas");
        fs.mkdirSync(logDir, { recursive: true });
        const logFd = fs.openSync(path.join(logDir, "directml-backend.log"), "a");
        fs.writeSync(logFd, `\n===== arranque DirectML ${new Date().toISOString()} =====\n`);
        dmlStdio = ["ignore", logFd, logFd];
      } catch (_e) {}
      const child = spawn("python", [DIRECTML_SCRIPT], {
        detached: true,
        stdio: dmlStdio,
        windowsHide: true,
        env: {
          ...process.env,
          // Sin esto, un print() con caracteres no-cp1252 revienta DENTRO del
          // manejador de errores del backend y oculta la causa real (visto en vivo).
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          OLIVE_GPU_MEMORY_LIMIT: process.env.OLIVE_GPU_MEMORY_LIMIT || "25",
          OLIVE_CPU_THREADS: process.env.OLIVE_CPU_THREADS || "12",
          ORT_DML_DEVICE_ID: process.env.ORT_DML_DEVICE_ID || "0",
          ...activeDirectmlEnv
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

  async function stopDirectMLServer() {
    if (!config.allowHostProcessControl) {
      const alive = await checkDirectMLAlive();
      return {
        ok: true,
        skippedHostControl: true,
        stopped: false,
        isAlive: alive,
        message: "Control de procesos del host deshabilitado en modo aislado."
      };
    }

    if (directMlProcess) {
      try {
        directMlProcess.kill("SIGTERM");
      } catch (_e) {}
      directMlProcess = null;
    }

    if (process.platform === "win32") {
      await new Promise((resolve) => {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'api_openai\\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
          ],
          { windowsHide: true, timeout: 5000 },
          () => resolve()
        );
      });
    }

    let alive = await checkDirectMLAlive();
    for (let i = 0; i < 6 && alive; i++) {
      await new Promise((r) => setTimeout(r, 250));
      alive = await checkDirectMLAlive();
    }

    return {
      ok: true,
      stopped: !alive,
      isAlive: alive,
      message: alive
        ? "DirectML sigue respondiendo tras el intento de detención."
        : "Servidor DirectML detenido y memoria GPU/RAM liberada."
    };
  }

  async function restartDirectMLServer(envOverrides = null) {
    if (envOverrides && typeof envOverrides === "object") {
      activeDirectmlEnv = { ...activeDirectmlEnv, ...envOverrides };
    }
    if (!config.allowHostProcessControl) {
      return { ok: true, skippedHostControl: true };
    }
    const wasAlive = await checkDirectMLAlive();
    await stopDirectMLServer();
    if (wasAlive || config.autoStartDirectML) {
      return startDirectMLServer(activeDirectmlEnv);
    }
    return { ok: true, stopped: true, isAlive: false };
  }

  function getOllamaPs() {
    return new Promise((resolve) => {
      const req = http.get({
        hostname: config.ollamaHost,
        port: config.ollamaPort,
        path: "/api/ps",
        timeout: 2000
      }, (oRes) => {
        let data = "";
        oRes.on("data", (c) => { data += c; });
        oRes.on("end", () => {
          if (oRes.statusCode !== 200) {
            resolve([]);
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve(Array.isArray(parsed.models) ? parsed.models : []);
          } catch (_e) {
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
  }

  function unloadOllamaModel(modelName) {
    const cleanModel = String(modelName || "").replace(/^ollama:/i, "").trim();
    if (!cleanModel) {
      return Promise.resolve({ ok: false, model: "", skipped: true });
    }
    return new Promise((resolve) => {
      const bodyBuf = Buffer.from(JSON.stringify({
        model: cleanModel,
        keep_alive: 0,
        stream: false
      }), "utf8");
      const req = http.request({
        hostname: config.ollamaHost,
        port: config.ollamaPort,
        path: "/api/generate",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": bodyBuf.length
        },
        timeout: 4000
      }, (uRes) => {
        uRes.resume();
        uRes.on("end", () => {
          resolve({ ok: uRes.statusCode === 200, model: cleanModel, statusCode: uRes.statusCode });
        });
      });
      req.on("error", () => resolve({ ok: false, model: cleanModel, statusCode: 0 }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ ok: false, model: cleanModel, statusCode: 0, timeout: true });
      });
      req.write(bodyBuf);
      req.end();
    });
  }

  async function unloadAllLoadedOllamaModels() {
    const loaded = await getOllamaPs();
    const names = Array.from(new Set(
      loaded.map((m) => String(m && (m.name || m.model) || "").trim()).filter(Boolean)
    ));
    const results = [];
    for (const name of names) {
      results.push(await unloadOllamaModel(name));
    }
    return results;
  }

  function checkOllamaAlive() {
    return new Promise((resolve) => {
      const req = http.get({
        hostname: config.ollamaHost,
        port: config.ollamaPort,
        path: "/api/tags",
        timeout: 1800
      }, (res) => {
        let data = "";
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ isAlive: false, models: [] });
            return;
          }
          try {
            const parsed = JSON.parse(data);
            resolve({
              isAlive: true,
              models: Array.isArray(parsed.models) ? parsed.models : []
            });
          } catch (_e) {
            resolve({ isAlive: true, models: [] });
          }
        });
      });
      req.on("error", () => resolve({ isAlive: false, models: [] }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ isAlive: false, models: [] });
      });
    });
  }

  async function getOllamaStatus() {
    const [aliveInfo, loadedModels, dmlHealth] = await Promise.all([
      checkOllamaAlive(),
      getOllamaPs(),
      getDirectmlHealth()
    ]);
    const models = Array.isArray(aliveInfo.models) ? aliveInfo.models : [];
    const loaded = Array.isArray(loadedModels) ? loadedModels : [];
    return {
      ok: true,
      isAlive: Boolean(aliveInfo.isAlive),
      modelsCount: models.length,
      models: models.map((m) => ({
        name: m.name || m.model || "",
        size: m.size || 0,
        modified_at: m.modified_at || null
      })),
      loadedCount: loaded.length,
      loadedModels: loaded.map((m) => ({
        name: m.name || m.model || "",
        size: m.size || 0,
        size_vram: m.size_vram || 0
      })),
      directmlRunning: Boolean(dmlHealth && dmlHealth.isAlive),
      directmlActiveModel: (dmlHealth && dmlHealth.active_model) || null
    };
  }

  function buildOllamaSpawnEnv(envOverrides = {}) {
    const freshWinEnv = (typeof hardwareAdvisor.readFreshWindowsUserEnv === "function" && !config.skipWindowsApply)
      ? hardwareAdvisor.readFreshWindowsUserEnv()
      : { ...process.env };
    const spawnEnv = {
      ...process.env,
      ...freshWinEnv,
      ...(envOverrides && typeof envOverrides === "object" ? envOverrides : {})
    };
    const rec = hardwareAdvisor.RECOMMENDED_ENV_VARS || {};
    const ollamaKeys = [
      "OLLAMA_IGPU_ENABLE",
      "HSA_OVERRIDE_GFX_VERSION",
      "OLLAMA_FLASH_ATTENTION",
      "OLLAMA_KV_CACHE_TYPE",
      "OLLAMA_MAX_LOADED_MODELS",
      "OLLAMA_NUM_PARALLEL"
    ];
    for (const k of ollamaKeys) {
      if (!spawnEnv[k] || String(spawnEnv[k]).trim() === "") {
        spawnEnv[k] = rec[k] || (k === "HSA_OVERRIDE_GFX_VERSION" ? "11.0.0" : (k === "OLLAMA_KV_CACHE_TYPE" ? "q8_0" : "1"));
      }
      process.env[k] = String(spawnEnv[k]);
    }
    return spawnEnv;
  }

  function getOllamaServerLogPath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "C:\\Users\\Benner", "AppData", "Local");
    return path.join(localAppData, "Ollama", "server.log");
  }

  async function spawnOllamaServeWithLog(envOverrides = {}) {
    const spawnEnv = buildOllamaSpawnEnv(envOverrides);
    const logPath = getOllamaServerLogPath();
    let logFd = null;
    try {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        logFd = fs.openSync(logPath, "a");
      } catch (_logErr) {
        logFd = null;
      }
      const child = spawn("ollama", ["serve"], {
        detached: true,
        stdio: logFd !== null ? ["ignore", logFd, logFd] : "ignore",
        windowsHide: true,
        env: spawnEnv
      });
      child.unref();
    } finally {
      if (logFd !== null) {
        try { fs.closeSync(logFd); } catch (_e) {}
      }
    }

    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const check = await checkOllamaAlive();
      if (check.isAlive) {
        return {
          ok: true,
          alive: true,
          modelsCount: check.models.length,
          logPath
        };
      }
    }
    return {
      ok: true,
      alive: false,
      modelsCount: 0,
      logPath,
      message: "Ollama iniciando en segundo plano..."
    };
  }

  async function startOllamaDaemon(envOverrides = {}) {
    const preCheck = await checkOllamaAlive();
    if (preCheck.isAlive) {
      return {
        ok: true,
        alive: true,
        alreadyRunning: true,
        modelsCount: preCheck.models.length
      };
    }
    if (!config.allowHostProcessControl) {
      return { ok: true, alive: false, skippedHostControl: true };
    }
    try {
      return await spawnOllamaServeWithLog(envOverrides);
    } catch (err) {
      return { ok: false, alive: false, error: safeErrMsg(err) };
    }
  }

  async function restartOllamaDaemon(envOverrides = {}) {
    if (!config.allowHostProcessControl) {
      return { ok: true, skippedHostControl: true };
    }
    if (process.platform === "win32") {
      await new Promise((resolve) => {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Process ollama, 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
          ],
          { windowsHide: true, timeout: 5000 },
          () => resolve()
        );
      });
      await new Promise((r) => setTimeout(r, 700));
    }
    try {
      return await spawnOllamaServeWithLog(envOverrides);
    } catch (err) {
      return { ok: false, error: safeErrMsg(err) };
    }
  }

  async function ensureOllamaRunning() {
    const check = await checkOllamaAlive();
    if (check.isAlive) return { ok: true, alive: true, alreadyRunning: true };
    if (!config.allowHostProcessControl) return { ok: false, alive: false, skippedHostControl: true };
    return startOllamaDaemon();
  }

  async function fetchCombinedModelsCatalog() {
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
          id: "Llama-3.2-3B-ONNX-DirectML",
          displayName: "Llama-3.2-3B-Instruct (INT4 DirectML)",
          size: "2.3 GB",
          active: false,
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

      return {
        models: [...formattedDirectML, ...formattedFreeAi, ...formattedLocal],
        directmlModels: formattedDirectML,
        freeAiModels: formattedFreeAi,
        localModels: formattedLocal
      };
    } catch (_err) {
      return { models: [], directmlModels: [], freeAiModels: [], localModels: [] };
    }
  }

  function proxyToDirectML(reqPath, method, postData, res, options = {}) {
    const postBuffer = Buffer.from(postData || "", "utf8");
    const extraHeaders = (options && options.extraHeaders && typeof options.extraHeaders === "object")
      ? options.extraHeaders
      : {};
    const reqOptions = {
      hostname: config.directmlHost,
      port: config.directmlPort,
      path: reqPath,
      method,
      headers: {
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
        "Content-Length": postBuffer.length
      },
      timeout: 180000
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, {
          ...extraHeaders,
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

    proxyReq.on("timeout", () => {
      try { proxyReq.destroy(); } catch (_e) {}
      if (!res.headersSent) {
        sendJson(res, 504, {
          ok: false,
          error: `Timeout conectando con DirectML en http://${config.directmlHost}:${config.directmlPort}.`
        });
      } else if (!res.writableEnded) {
        res.end();
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

  function proxyToOllama(reqPath, method, postData, res, options = {}) {
    const postBuffer = Buffer.from(postData || "", "utf8");
    const extraHeaders = (options && options.extraHeaders && typeof options.extraHeaders === "object")
      ? options.extraHeaders
      : {};
    const reqOptions = {
      hostname: config.ollamaHost,
      port: config.ollamaPort,
      path: reqPath,
      method,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": postBuffer.length
      },
      timeout: 180000
    };

    const proxyReq = http.request(reqOptions, (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode, {
          ...extraHeaders,
          "Content-Type": proxyRes.headers["content-type"] || "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*"
        });
      }
      proxyRes.on("error", () => {
        if (!res.writableEnded) res.end();
      });
      proxyRes.pipe(res);
    });

    res.on("close", () => {
      if (!res.writableEnded) {
        try { proxyReq.destroy(); } catch (_e) {}
      }
    });

    proxyReq.on("timeout", () => {
      try { proxyReq.destroy(); } catch (_e) {}
      if (!res.headersSent) {
        sendJson(res, 504, {
          ok: false,
          error: `Timeout conectando con Ollama en http://${config.ollamaHost}:${config.ollamaPort}.`
        });
      } else if (!res.writableEnded) {
        res.end();
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

  async function streamEngineCompletion({ engine, model, messages: providedMessages, systemPrompt, userPrompt, payload = {}, signal = null }, onToken) {
    if (signal && signal.aborted) {
      const abortErr = new Error("Conexión cerrada por el cliente");
      abortErr.aborted = true;
      throw abortErr;
    }

    if (engine === "directml") {
      const alive = await checkDirectMLAlive();
      if (!alive && config.autoStartDirectML) {
        await startDirectMLServer();
      }
      if (signal && signal.aborted) {
        const abortErr = new Error("Conexión cerrada por el cliente");
        abortErr.aborted = true;
        throw abortErr;
      }
    } else if (engine === "ollama") {
      await ensureOllamaRunning();
      if (signal && signal.aborted) {
        const abortErr = new Error("Conexión cerrada por el cliente");
        abortErr.aborted = true;
        throw abortErr;
      }
    }

    return new Promise((resolve, reject) => {
      const messages = Array.isArray(providedMessages) && providedMessages.length > 0
        ? providedMessages.map((m) => {
            const role = String((m && m.role) || "user");
            if (role === "system") {
              return { role: "system", content: String((m && m.content) ?? "") };
            }
            const formatted = formatMessageAttachmentsForEngine(m, engine);
            const item = { role, content: formatted.content };
            if (engine === "ollama" && formatted.images && formatted.images.length > 0) {
              item.images = formatted.images;
            }
            return item;
          })
        : [
            { role: "system", content: String(systemPrompt || "") },
            { role: "user", content: String(userPrompt || "") }
          ];

      let settled = false;
      let accumulated = "";
      let buffer = "";
      let activeReq = null;
      let activeUpstreamRes = null;

      function onAbort() {
        try { if (activeUpstreamRes) activeUpstreamRes.destroy(); } catch (_e) {}
        try { if (activeReq) activeReq.destroy(); } catch (_e) {}
        doneReject("Conexión cerrada por el cliente", true);
      }

      function cleanup() {
        if (signal && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onAbort);
        }
      }

      if (signal && typeof signal.addEventListener === "function") {
        if (signal.aborted) {
          const abortErr = new Error("Conexión cerrada por el cliente");
          abortErr.aborted = true;
          abortErr.partialText = accumulated;
          reject(abortErr);
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      function doneResolve() {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ text: accumulated, model });
      }

      function doneReject(reason, isAborted = false) {
        if (settled) return;
        settled = true;
        cleanup();
        const err = new Error(safeErrMsg(reason));
        err.partialText = accumulated;
        if (isAborted) err.aborted = true;
        reject(err);
      }

      function processSseLine(line) {
        if (settled) return;
        const trimmed = String(line || "").trim();
        if (!trimmed || trimmed.startsWith(":") || trimmed === "data: [DONE]") return;
        const rawJson = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
        try {
          const parsed = JSON.parse(rawJson);
          if (parsed && parsed.error) {
            doneReject(parsed.error.message || parsed.error);
            return;
          }
          let content = (parsed.choices && parsed.choices[0] && (parsed.choices[0].delta?.content ?? parsed.choices[0].message?.content ?? parsed.choices[0].text ?? parsed.choices[0].delta?.text))
            ?? (parsed.message && parsed.message.content)
            ?? parsed.text
            ?? "";
          if (Array.isArray(content)) {
            content = content.map(part => (typeof part === "string" ? part : (part && (part.text || part.content)) || "")).join("");
          }
          if (typeof content !== "string") content = "";
          if (content) {
            accumulated += content;
            onToken(content);
          }
        } catch (_e) {}
      }

      if (engine === "freeai") {
        const cleanFreeModel = String(model || "qwen7b").replace(/^freeai:/i, "").trim() || "qwen7b";
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
          model: cleanFreeModel,
          messages,
          stream: true,
          temperature: payload.temperature !== undefined ? Number(payload.temperature) : 0.3,
          max_tokens: Number(payload.max_tokens) || 2048
        });

        const req = client.request(targetUrl, {
          method: "POST",
          headers: {
            ...(key ? { Authorization: `Bearer ${key}` } : {}),
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(bodyData, "utf8"),
            "User-Agent": "Antigravity/1.0"
          },
          timeout: 90000
        }, (upstreamRes) => {
          activeUpstreamRes = upstreamRes;
          if (settled) {
            try { upstreamRes.destroy(); } catch (_e) {}
            return;
          }
          if (upstreamRes.statusCode !== 200) {
            let errBody = "";
            upstreamRes.on("data", (c) => { errBody += c; });
            upstreamRes.on("error", (err) => doneReject(err.message));
            upstreamRes.on("end", () => {
              if (typeof freeai.rotateKey === "function") freeai.rotateKey();
              doneReject(`Free.ai HTTP ${upstreamRes.statusCode}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
            });
            return;
          }

          upstreamRes.setEncoding("utf8");
          upstreamRes.on("data", (chunk) => {
            if (settled) return;
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              processSseLine(line);
            }
          });
          upstreamRes.on("end", () => {
            if (buffer.trim()) {
              processSseLine(buffer);
              buffer = "";
            }
            doneResolve();
          });
          upstreamRes.on("error", (err) => doneReject(err.message));
        });
        activeReq = req;

        req.on("error", (err) => {
          if (settled) return;
          if (typeof freeai.rotateKey === "function") freeai.rotateKey();
          doneReject(`Free.ai offline (${err.message})`);
        });
        req.on("timeout", () => {
          try { req.destroy(); } catch (_e) {}
          doneReject("Timeout conectando con Free.ai");
        });
        req.write(bodyData);
        req.end();
        return;
      }

      if (engine === "directml") {
        const cleanDmlModel = String(model || "Phi-3.5-mini-instruct-ONNX").replace(/^directml:/i, "").trim() || "Phi-3.5-mini-instruct-ONNX";
        let dmlRetried = false;
        const fireDml = (useStream) => {
        const bodyData = JSON.stringify({
          model: cleanDmlModel,
          messages,
          stream: useStream,
          max_tokens: Number(payload.max_tokens) || 2048,
          temperature: payload.temperature !== undefined ? Number(payload.temperature) : 0.3
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
          timeout: 180000
        }, (upstreamRes) => {
          activeUpstreamRes = upstreamRes;
          if (settled) {
            try { upstreamRes.destroy(); } catch (_e) {}
            return;
          }
          if (upstreamRes.statusCode !== 200) {
            let errBody = "";
            upstreamRes.on("data", (c) => { errBody += c; });
            upstreamRes.on("error", (err) => doneReject(err.message));
            upstreamRes.on("end", () => {
              let cleanErr = errBody;
              try {
                const parsedErr = JSON.parse(errBody);
                cleanErr = parsedErr.detail || parsedErr.error?.message || parsedErr.error || errBody;
              } catch (_e) {}
              doneReject(`DirectML HTTP ${upstreamRes.statusCode}${cleanErr ? `: ${String(cleanErr).slice(0, 320)}` : ""}`);
            });
            return;
          }

          upstreamRes.setEncoding("utf8");
          let rawAll = "";
          upstreamRes.on("data", (chunk) => {
            if (settled) return;
            rawAll += chunk;
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";
            for (const line of lines) {
              processSseLine(line);
            }
          });
          upstreamRes.on("end", () => {
            if (buffer.trim()) {
              processSseLine(buffer);
              buffer = "";
            }
            if (!accumulated && rawAll.trim()) {
              // Rescate: el backend respondió sin SSE estándar (JSON completo u otro sobre)
              try {
                const whole = JSON.parse(rawAll);
                const rescued = (whole.choices && whole.choices[0] && (whole.choices[0].message?.content || whole.choices[0].text)) || whole.response || whole.text || "";
                if (rescued) { accumulated += rescued; onToken(rescued); }
              } catch (_e) {
                const frags = [...rawAll.matchAll(/"content"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map(m => { try { return JSON.parse('"' + m[1] + '"'); } catch (_e2) { return ""; } }).join("");
                if (frags) { accumulated += frags; onToken(frags); }
              }
            }
            if (!accumulated && useStream && !dmlRetried) {
              // Algunos backends ONNX devuelven 200 vacío en streaming: reintento sin stream
              dmlRetried = true;
              fireDml(false);
              return;
            }
            doneResolve();
          });
          upstreamRes.on("error", (err) => doneReject(err.message));
        });
        activeReq = req;

        req.on("error", (err) => {
          if (!settled) doneReject(`DirectML offline (${err.message})`);
        });
        req.on("timeout", () => {
          try { req.destroy(); } catch (_e) {}
          doneReject("Timeout conectando con DirectML");
        });
        req.write(bodyData);
        req.end();
        };
        fireDml(true);
        return;
      }

      // Default: Ollama (/api/chat con stream: true)
      const cleanOllamaModel = String(model || "").replace(/^ollama:/i, "").trim();
      const mergedOptions = {};
      if (payload.modelfileOptions && typeof payload.modelfileOptions === "object") {
        Object.assign(mergedOptions, payload.modelfileOptions);
      }
      if (payload.temperature !== undefined && Number.isFinite(Number(payload.temperature))) {
        mergedOptions.temperature = Number(payload.temperature);
      }
      if (payload.max_tokens !== undefined && Number.isFinite(Number(payload.max_tokens))) {
        mergedOptions.num_predict = Number(payload.max_tokens);
      }
      if (payload.num_ctx !== undefined && Number.isFinite(Number(payload.num_ctx))) {
        mergedOptions.num_ctx = Number(payload.num_ctx);
      }
      if (payload.num_thread !== undefined && Number.isFinite(Number(payload.num_thread))) {
        mergedOptions.num_thread = Number(payload.num_thread);
      }

      const ollamaBody = {
        model: cleanOllamaModel,
        messages,
        stream: true
      };
      if (Object.keys(mergedOptions).length > 0) {
        ollamaBody.options = mergedOptions;
      }
      if (payload.keep_alive !== undefined) {
        ollamaBody.keep_alive = payload.keep_alive;
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
        timeout: 90000
      }, (upstreamRes) => {
        activeUpstreamRes = upstreamRes;
        if (settled) {
          try { upstreamRes.destroy(); } catch (_e) {}
          return;
        }
        if (upstreamRes.statusCode !== 200) {
          let errBody = "";
          upstreamRes.on("data", (c) => { errBody += c; });
          upstreamRes.on("error", (err) => doneReject(err.message));
          upstreamRes.on("end", () => {
            doneReject(`Ollama HTTP ${upstreamRes.statusCode}${errBody ? `: ${errBody.slice(0, 200)}` : ""}`);
          });
          return;
        }

        const processOllamaLine = (line) => {
          if (settled) return;
          const trimmed = String(line || "").trim();
          if (!trimmed) return;
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
        };

        upstreamRes.setEncoding("utf8");
        upstreamRes.on("data", (chunk) => {
          if (settled) return;
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";
          for (const line of lines) {
            processOllamaLine(line);
          }
        });
        upstreamRes.on("end", () => {
          if (buffer.trim()) {
            processOllamaLine(buffer);
            buffer = "";
          }
          doneResolve();
        });
        upstreamRes.on("error", (err) => doneReject(err.message));
      });
      activeReq = req;

      req.on("error", (err) => {
        if (!settled) doneReject(`Ollama offline (${err.message})`);
      });
      req.on("timeout", () => {
        try { req.destroy(); } catch (_e) {}
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
    res.setHeader("Access-Control-Expose-Headers", "X-Web-Search-Meta, X-TTS-Engine, X-TTS-Voice, X-TTS-Sample-Rate");

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
        const st = fs.statSync(fs.existsSync(HTML_V2_FILE_PATH) ? HTML_V2_FILE_PATH : HTML_FILE_PATH);
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

    if (pathname === "/favicon.ico" && (req.method === "GET" || req.method === "HEAD")) {
      try {
        if (fs.existsSync(TRAY_ICO_PATH) && fs.statSync(TRAY_ICO_PATH).isFile()) {
          const stat = fs.statSync(TRAY_ICO_PATH);
          res.writeHead(200, {
            "Content-Type": "image/x-icon",
            "Content-Length": stat.size,
            "Cache-Control": "no-cache, must-revalidate"
          });
          if (req.method === "HEAD") {
            res.end();
          } else {
            fs.createReadStream(TRAY_ICO_PATH).pipe(res);
          }
          return;
        }
      } catch (_e) {}
      res.writeHead(204);
      res.end();
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
    if (pathname === "/api/skills/source" && req.method === "GET") {
      const root = skillsBridge.getSkillsRoot();
      const fsExists = fs.existsSync(path.join(root, "skills_index.json"));
      sendJson(res, 200, {
        ok: true,
        repo: skillsBridge.SKILLS_REPO_URL,
        installed: fsExists,
        root,
        count: fsExists ? skillsBridge.searchSkills("", "", 0).length : 0,
        categories: fsExists ? skillsBridge.getCategories().length : 0
      });
      return;
    }

    if (pathname === "/api/skills/update" && req.method === "POST") {
      // Clona o actualiza el repo oficial de skills SOLO dentro de <proyecto>/skills-repo
      const target = path.join(__dirname, "..", "..", "skills-repo");
      const isRepo = fs.existsSync(path.join(target, ".git"));
      const args = isRepo ? ["-C", target, "pull", "--ff-only"] : ["clone", "--depth", "1", "--filter=blob:none", "--sparse", skillsBridge.SKILLS_REPO_URL, target];
      execFile("git", args, { timeout: 300000 }, (err, _stdout, stderr) => {
        if (!err && !isRepo) {
          // Sparse: traer solo la librería de skills del repo OS, no sus 500 MB completos
          try { require("node:child_process").execFileSync("git", ["-C", target, "sparse-checkout", "set", "skills", "skills_index.json", "data", "CATALOG.md"], { timeout: 300000 }); } catch (_e) {}
        }
        if (err) {
          sendJsonError(res, 502, `No se pudo ${isRepo ? "actualizar" : "clonar"} el repo de skills: ${safeErrMsg(stderr || err)}`);
          return;
        }
        try { skillsBridge.loadSkillsIndex(true); } catch (_e) {}
        sendJson(res, 200, {
          ok: true,
          action: isRepo ? "pull" : "clone",
          root: target,
          count: skillsBridge.searchSkills("", "", 0).length
        });
      });
      return;
    }

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

    if (pathname === "/api/skills/fuse" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const result = skillsBridge.saveSkillFusion({
        name: payload.name || payload.fusionName || "",
        description: payload.description || "",
        profileId: payload.profileId || null,
        skillIds: payload.skillIds || payload.skills || payload.skillId || [],
        rules: payload.rules || ""
      });
      if (!result.ok) {
        sendJsonError(res, 400, result.error || "Error guardando fusión de skills.");
        return;
      }
      sendJson(res, 200, result);
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
      const projTarget = resolveRequestProjectTarget(query.project || null, query.projectPath || null, query.customPath || null);
      const { ctx, directmlCompatibility } = buildProjectCompatibilitySummary({
        projectName: projTarget,
        convId,
        token,
        skillId: query.skillId || null,
        skillIds: query.skillIds || query.skillId || null,
        profileId: query.profileId || null,
        customSystemPrompt: query.customSystemPrompt || null
      });
      const active = (ctx && ctx.project) || bridge.getActiveProject(projTarget, convId, token);
      const stateKey = (!active || active.isGeneral || String(active.name || "").toLowerCase() === "general")
        ? "General"
        : (active.path || active.name);
      const projectState = memoryStore.getProjectState(stateKey);
      sendJson(res, 200, {
        ok: true,
        hierarchy,
        projects,
        active,
        projectState,
        metrics: ctx ? ctx.metrics : null,
        directmlCompatibility
      });
      return;
    }

    if (pathname === "/api/context" && req.method === "GET") {
      const projName = resolveRequestProjectTarget(query.project || null, query.projectPath || null, query.customPath || null);
      const convId = query.conversationId || null;
      const token = query.token || null;
      const ctx = bridge.buildProjectContext(projName, convId, token, {
        writeToDisk: false,
        skillId: query.skillId || null,
        skillIds: query.skillIds || query.skillId || null,
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
      const proj = resolveRequestProjectTarget(query.project || null, query.projectPath || null, query.customPath || null);
      const convId = query.conversationId || null;
      const token = query.token || null;
      const ctx = bridge.buildProjectContext(proj, convId, token, {
        writeToDisk: false,
        skillId: query.skillId || null,
        skillIds: query.skillIds || query.skillId || null,
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
      const rawTarget = payload.projectName || payload.project || payload.selection || null;
      const target = resolveRequestProjectTarget(rawTarget, payload.projectPath || null, payload.customPath || null);
      const ctx = bridge.buildProjectContext(target, payload.conversationId || null, payload.token || null, {
        writeToDisk: false,
        skillId: payload.skillId || null,
        skillIds: payload.skillIds || payload.skillId || null,
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
      if (Array.isArray(payload.pinnedFiles)) {
        statePatch.pinnedFiles = payload.pinnedFiles;
      }
      if (typeof payload.githubToggle === "boolean") statePatch.githubToggle = payload.githubToggle;
      if (typeof payload.githubRepo === "string") statePatch.githubRepo = payload.githubRepo;
      if (typeof payload.netlifyToggle === "boolean") statePatch.netlifyToggle = payload.netlifyToggle;
      if (typeof payload.netlifySite === "string") statePatch.netlifySite = payload.netlifySite;
      if (typeof payload.netlifyPublishDir === "string") statePatch.netlifyPublishDir = payload.netlifyPublishDir;

      const projectState = (Object.keys(statePatch).length > 0 || (activeProj && !isGen))
        ? memoryStore.updateProjectState(stateKey, statePatch)
        : memoryStore.getProjectState(stateKey);

      sendJson(res, 200, {
        ok: true,
        active: activeProj,
        projectState,
        metrics: ctx ? ctx.metrics : null,
        directmlCompatibility: ctx ? ctx.directmlCompatibility : null
      });
      return;
    }

    if (pathname === "/api/project/create" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const result = bridge.createNewStandardProject({
        name: payload.name || payload.projectName || "",
        template: payload.template || "web-vanilla",
        description: payload.description || "",
        initGit: payload.initGit !== false
      });
      if (!result.ok) {
        sendJsonError(res, 400, result.error || "Error creando proyecto estándar.");
        return;
      }
      sendJson(res, 200, result);
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
      const rawFolder = payload.folderPath || payload.path || payload.customPath || "";
      const folderPath = typeof rawFolder === "string"
        ? rawFolder.trim()
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
      const { ctx, directmlCompatibility } = buildProjectCompatibilitySummary({
        projectName: resolvedFolder,
        selectedFiles: selected
      });

      sendJson(res, 200, {
        ok: true,
        folderPath: resolvedFolder,
        name: path.basename(resolvedFolder),
        files,
        selectedFiles: selected,
        metrics: ctx ? ctx.metrics : null,
        directmlCompatibility
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
      const { ctx, directmlCompatibility } = buildProjectCompatibilitySummary({
        projectName: path.resolve(folderPath),
        selectedFiles: files
      });
      sendJson(res, 200, {
        ok: true,
        count: files.length,
        metrics: ctx ? ctx.metrics : null,
        directmlCompatibility
      });
      return;
    }

    if (pathname === "/api/project/read-file" && req.method === "GET") {
      const projName = resolveRequestProjectTarget(query.project || null, query.projectPath || null, query.customPath || null);
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
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
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

      const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || payload.customPath || null);
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
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
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

      const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || payload.customPath || null);
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
      const projTarget = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const ok = bridge.recordProjectProgress(projTarget, {
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
    // Fase 1: Diff Visual Real, Lote Transaccional y Rollback 1-Clic
    // ---------------------------------------------------------
    if (pathname === "/api/project/diff-preview" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const result = bridge.computeProjectDiffPreview(projectName, {
        kind: payload.kind || "write",
        filePath: payload.filePath || payload.relPath || "",
        content: payload.content,
        search: payload.search,
        replace: payload.replace
      });
      if (!result.ok) {
        sendJsonError(res, getMutationErrorStatus(result.error), result.error);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/project/apply-batch" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const actions = Array.isArray(payload.actions) ? payload.actions : [];
      if (actions.length === 0) {
        sendJsonError(res, 400, "Se requiere un arreglo 'actions' con al menos una operación.");
        return;
      }

      const batchRes = bridge.applyProjectBatchTransactional(projectName, actions, {
        model: payload.model,
        source: payload.source,
        summary: payload.summary,
        tool: payload.tool || "Lote Transaccional"
      });

      if (!batchRes.ok) {
        sendJson(res, getMutationErrorStatus(batchRes.error), batchRes);
        return;
      }

      const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || payload.customPath || null);
      let githubSync = null;
      if (payload.syncGithub && payload.githubRepo) {
        try {
          const filesModified = (batchRes.results || []).map((r) => {
            const fullP = r.path || (projInfo.path ? path.join(projInfo.path, r.relPath) : "");
            const content = fullP && fs.existsSync(fullP) ? fs.readFileSync(fullP, "utf-8") : undefined;
            return { relPath: r.relPath, ...(content !== undefined ? { content } : {}) };
          });
          githubSync = await integrations.syncProjectToGitHub({
            projectName: projInfo.name,
            projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
            repoFullName: payload.githubRepo,
            commitMessage: payload.commitMessage || `Batch update (${filesModified.length} files) via Local AI Studio`,
            filesModified,
            initRemoteOnLocal: Boolean(payload.initRemoteOnLocal)
          });
        } catch (syncErr) {
          githubSync = { ok: false, error: safeErrMsg(syncErr) };
        }
      }

      let netlifyDeploy = null;
      if (payload.deployNetlify && payload.netlifySite) {
        try {
          netlifyDeploy = await integrations.deployToNetlify({
            projectName: projInfo.name,
            projectPath: projInfo.isGeneral ? null : (projInfo.path || null),
            siteId: payload.netlifySite,
            publishDir: payload.netlifyPublishDir || null,
            prod: payload.prod !== false,
            message: payload.commitMessage || `Deploy batch (${batchRes.appliedCount} files) via Local AI Studio`
          });
        } catch (depErr) {
          netlifyDeploy = { ok: false, error: safeErrMsg(depErr) };
        }
      }

      sendJson(res, 200, {
        ...batchRes,
        githubSync,
        netlifyDeploy
      });
      return;
    }

    if (pathname === "/api/project/backups" && req.method === "GET") {
      const projName = resolveRequestProjectTarget(query.project || null, query.projectPath || null, query.customPath || null);
      const relPath = query.relPath || query.filePath || null;
      const limit = query.limit ? Number(query.limit) : 50;
      const backups = memoryStore.listProjectBackups(projName, relPath, limit);
      sendJson(res, 200, { ok: true, backups });
      return;
    }

    if (pathname === "/api/project/rollback" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const result = bridge.rollbackProjectChange(projectName, {
        changeId: payload.changeId || payload.id || null,
        backupPath: payload.backupPath || null,
        relPath: payload.relPath || payload.filePath || null
      });
      if (!result.ok) {
        sendJsonError(res, getMutationErrorStatus(result.error), result.error);
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    // ---------------------------------------------------------
    // Fase 2: Runner Seguro (POST /api/project/run & GET /api/project/scripts)
    // ---------------------------------------------------------
    if (pathname === "/api/project/scripts" && req.method === "GET") {
      const projName = resolveRequestProjectTarget(query.project || null, query.projectPath || null, query.customPath || null);
      const result = bridge.getProjectRunnableScripts(projName);
      if (!result.ok) {
        sendJsonError(res, 404, result.error || "Proyecto no encontrado");
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/project/run" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const result = await bridge.runProjectCommand(projectName, {
        commandKey: payload.commandKey || payload.command || "node_test",
        scriptName: payload.scriptName || payload.script || "",
        targetFile: payload.targetFile || payload.filePath || "",
        timeoutMs: payload.timeoutMs
      });
      if (!result.ok) {
        sendJsonError(res, 400, result.error || "Error ejecutando comando del proyecto.");
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    // ---------------------------------------------------------
    // Fase 5: Buscador Grep en Código y Pinned Files
    // ---------------------------------------------------------
    if (pathname === "/api/project/search" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projectName = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const result = bridge.searchProjectCode(projectName, {
        query: payload.query || payload.q || "",
        caseSensitive: Boolean(payload.caseSensitive),
        filePattern: payload.filePattern || "",
        maxResults: payload.maxResults || 60
      });
      if (!result.ok) {
        sendJsonError(res, 400, result.error || "Error buscando en el proyecto.");
        return;
      }
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/project/pin-files" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || payload.customPath || null);
      const rawList = Array.isArray(payload.files)
        ? payload.files
        : (Array.isArray(payload.pinnedFiles) ? payload.pinnedFiles : []);
      const rawMode = String(payload.mode || (Array.isArray(payload.pinnedFiles) ? "set" : "add")).trim().toLowerCase();
      const mode = (rawMode === "add" || rawMode === "remove" || rawMode === "set") ? rawMode : "set";
      const cleanIncoming = rawList.map((f) => String(f || "").trim()).filter(Boolean);

      if ((projInfo.isGeneral || !projInfo.path) && cleanIncoming.length > 0) {
        sendJsonError(res, 400, "Selecciona un proyecto activo válido para fijar archivos.");
        return;
      }

      const validatedRelPaths = [];
      for (const rawItem of cleanIncoming) {
        if (!projInfo.isGeneral && projInfo.path) {
          const safe = bridge.resolveSafeProjectPath(projInfo.path, rawItem);
          if (!safe.ok) {
            sendJsonError(res, 403, safe.error || "Ruta protegida o fuera del proyecto");
            return;
          }
          validatedRelPaths.push(safe.cleanRelPath);
        } else {
          validatedRelPaths.push(rawItem.replace(/\\/g, "/"));
        }
      }

      const currentState = memoryStore.getProjectState(projInfo.stateKey);
      const currentPinned = Array.isArray(currentState.pinnedFiles) ? currentState.pinnedFiles : [];
      const dedupePins = (list) => {
        const seen = new Set();
        const out = [];
        for (const item of list) {
          const norm = String(item || "").trim().replace(/\\/g, "/");
          if (!norm) continue;
          const key = norm.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(norm);
        }
        return out;
      };

      let nextPinned = [];
      if (mode === "set") {
        nextPinned = dedupePins(validatedRelPaths);
      } else if (mode === "add") {
        nextPinned = dedupePins([...currentPinned, ...validatedRelPaths]);
      } else {
        const removeSet = new Set(validatedRelPaths.map((p) => p.toLowerCase()));
        nextPinned = dedupePins(currentPinned.filter((p) => !removeSet.has(String(p || "").trim().replace(/\\/g, "/").toLowerCase())));
      }

      const projectState = memoryStore.updateProjectState(projInfo.stateKey, { pinnedFiles: nextPinned });
      const { ctx, directmlCompatibility } = buildProjectCompatibilitySummary({
        projectName: projInfo.isGeneral ? "General" : (projInfo.path || projInfo.name)
      });
      sendJson(res, 200, {
        ok: true,
        project: projInfo.name,
        pinnedFiles: projectState.pinnedFiles || [],
        projectState,
        metrics: ctx ? ctx.metrics : null,
        directmlCompatibility
      });
      return;
    }

    // ---------------------------------------------------------
    // Fase 4: Live Preview (Estático + Dev-Server Gestionado + Proxy)
    // ---------------------------------------------------------
    if (pathname === "/api/project/preview/status" && req.method === "GET") {
      const projInfo = resolveProjectInfo(query.project || null, query.projectPath || query.customPath || null);
      if (projInfo.isGeneral || !projInfo.path || !fs.existsSync(projInfo.path)) {
        sendJson(res, 200, {
          ok: true,
          mode: "none",
          running: false,
          devServerRunning: false,
          devPort: null,
          scriptName: null,
          supportsDevServer: false,
          availablePreviewScripts: [],
          previewUrl: null,
          entryFile: null
        });
        return;
      }

      const pkgScripts = readProjectPackageScripts(projInfo.path);
      const availablePreviewScripts = getAvailablePreviewScripts(pkgScripts);
      const supportsDevServer = availablePreviewScripts.length > 0;
      const activeManaged = getActiveManagedPreview(projInfo.stateKey, projInfo.name);

      let entryFile = null;
      const requestedEntry = typeof query.entry === "string" ? query.entry.trim() : "";
      if (requestedEntry) {
        const safeReq = bridge.resolveSafeProjectPath(projInfo.path, requestedEntry);
        if (!safeReq.ok) {
          sendJsonError(res, 403, safeReq.error || "Ruta protegida o fuera del proyecto");
          return;
        }
        if (fs.existsSync(safeReq.fullPath) && fs.statSync(safeReq.fullPath).isFile()) {
          entryFile = safeReq.cleanRelPath;
        }
      }
      if (!entryFile) {
        for (const cand of PREVIEW_ENTRY_CANDIDATES) {
          const safe = bridge.resolveSafeProjectPath(projInfo.path, cand);
          if (safe.ok && fs.existsSync(safe.fullPath) && fs.statSync(safe.fullPath).isFile()) {
            entryFile = safe.cleanRelPath;
            break;
          }
        }
      }

      const encodedProj = encodeURIComponent(projInfo.name);
      if (activeManaged) {
        sendJson(res, 200, {
          ok: true,
          project: projInfo.name,
          mode: "dev-server",
          running: true,
          devServerRunning: true,
          devPort: activeManaged.port,
          scriptName: activeManaged.scriptName,
          supportsDevServer,
          availablePreviewScripts,
          previewUrl: `/api/project/preview-proxy/${encodedProj}/`,
          entryFile
        });
        return;
      }

      const previewUrl = entryFile
        ? `/api/project/static/${encodedProj}/${entryFile}`
        : `/api/project/static/${encodedProj}/index.html`;
      sendJson(res, 200, {
        ok: true,
        project: projInfo.name,
        mode: "static",
        running: Boolean(entryFile),
        devServerRunning: false,
        devPort: null,
        scriptName: null,
        supportsDevServer,
        availablePreviewScripts,
        previewUrl,
        entryFile
      });
      return;
    }

    if (pathname === "/api/project/preview/start" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || payload.customPath || null);
      if (projInfo.isGeneral || !projInfo.path || !fs.existsSync(projInfo.path)) {
        sendJsonError(res, 400, "Selecciona un proyecto activo válido para iniciar Live Preview.");
        return;
      }

      const pkgScripts = readProjectPackageScripts(projInfo.path);
      const availablePreviewScripts = getAvailablePreviewScripts(pkgScripts);
      const supportsDevServer = availablePreviewScripts.length > 0;
      const encodedProj = encodeURIComponent(projInfo.name);
      const wantsDevServer = payload.mode === "dev-server" || payload.devServer === true;

      if (wantsDevServer) {
        const reqScript = typeof payload.scriptName === "string" ? payload.scriptName.trim() : "";
        if (reqScript && !PREVIEW_ALLOWED_SCRIPTS.includes(reqScript)) {
          sendJsonError(res, 400, `Script de dev-server no permitido: '${reqScript}'. Solo se permiten: ${PREVIEW_ALLOWED_SCRIPTS.join(", ")}.`);
          return;
        }
        const scriptName = reqScript
          ? (availablePreviewScripts.includes(reqScript) ? reqScript : null)
          : (availablePreviewScripts[0] || null);
        if (!scriptName) {
          sendJsonError(res, 400, "El proyecto no tiene un script 'dev', 'preview' o 'start' en package.json.");
          return;
        }

        const existing = getActiveManagedPreview(projInfo.stateKey, projInfo.name);
        if (existing && existing.scriptName === scriptName) {
          sendJson(res, 200, {
            ok: true,
            project: projInfo.name,
            mode: "dev-server",
            running: true,
            devServerRunning: true,
            devPort: existing.port,
            scriptName: existing.scriptName,
            supportsDevServer,
            availablePreviewScripts,
            previewUrl: `/api/project/preview-proxy/${encodedProj}/`
          });
          return;
        }
        if (existing) {
          await stopManagedPreview(projInfo.stateKey);
        }

        const port = await findFreeLoopbackPort();
        const spawnSpec = resolvePreviewNpmSpawn(scriptName, port, pkgScripts[scriptName] || "");
        const proc = spawn(spawnSpec.bin, spawnSpec.args, {
          cwd: projInfo.path,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            PORT: String(port),
            VITE_PORT: String(port),
            HOST: "127.0.0.1",
            BROWSER: "none",
            CI: "true"
          }
        });

        let recentLogs = "";
        const appendLog = (chunk) => {
          recentLogs = (recentLogs + String(chunk || "")).slice(-4096);
        };
        if (proc.stdout) proc.stdout.on("data", appendLog);
        if (proc.stderr) proc.stderr.on("data", appendLog);
        proc.on("exit", () => {
          const cur = projectPreviewProcesses.get(projInfo.stateKey);
          if (cur && cur.proc === proc) {
            projectPreviewProcesses.delete(projInfo.stateKey);
          }
        });

        const connectedHost = await waitForTcpPort(port, Number(payload.timeoutMs) || 10000, proc);
        if (!connectedHost) {
          await terminatePreviewProcessEntry({ proc });
          sendJsonError(
            res,
            502,
            `El dev-server (${scriptName}) no respondió a tiempo en 127.0.0.1:${port}.${recentLogs.trim() ? ` Log: ${recentLogs.trim().slice(-240)}` : ""}`
          );
          return;
        }

        projectPreviewProcesses.set(projInfo.stateKey, {
          proc,
          port,
          host: connectedHost,
          scriptName,
          projName: projInfo.name,
          projPath: projInfo.path,
          stateKey: projInfo.stateKey,
          startedAt: new Date().toISOString()
        });

        sendJson(res, 200, {
          ok: true,
          project: projInfo.name,
          mode: "dev-server",
          running: true,
          devServerRunning: true,
          devPort: port,
          scriptName,
          supportsDevServer,
          availablePreviewScripts,
          previewUrl: `/api/project/preview-proxy/${encodedProj}/`
        });
        return;
      }

      if (payload.stopDevServer === true) {
        await stopManagedPreview(projInfo.stateKey);
      }

      let entryFile = null;
      const requestedEntry = typeof payload.entry === "string" ? payload.entry.trim() : "";
      if (requestedEntry) {
        const safeReq = bridge.resolveSafeProjectPath(projInfo.path, requestedEntry);
        if (!safeReq.ok) {
          sendJsonError(res, 403, safeReq.error || "Ruta protegida o fuera del proyecto");
          return;
        }
        if (fs.existsSync(safeReq.fullPath) && fs.statSync(safeReq.fullPath).isFile()) {
          entryFile = safeReq.cleanRelPath;
        }
      }
      if (!entryFile) {
        for (const cand of PREVIEW_ENTRY_CANDIDATES) {
          const safe = bridge.resolveSafeProjectPath(projInfo.path, cand);
          if (safe.ok && fs.existsSync(safe.fullPath) && fs.statSync(safe.fullPath).isFile()) {
            entryFile = safe.cleanRelPath;
            break;
          }
        }
      }
      if (!entryFile) entryFile = "index.html";

      sendJson(res, 200, {
        ok: true,
        project: projInfo.name,
        mode: "static",
        running: true,
        devServerRunning: false,
        devPort: null,
        scriptName: null,
        supportsDevServer,
        availablePreviewScripts,
        entryFile,
        previewUrl: `/api/project/static/${encodedProj}/${entryFile}`
      });
      return;
    }

    if (pathname === "/api/project/preview/stop" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      let stoppedCount = 0;
      if (payload.project || payload.projectPath || payload.customPath) {
        const projInfo = resolveProjectInfo(payload.project || null, payload.projectPath || payload.customPath || null);
        const activeByKey = getActiveManagedPreview(projInfo.stateKey, projInfo.name);
        if (activeByKey) {
          stoppedCount = await stopManagedPreview(activeByKey.stateKey);
        }
      } else {
        stoppedCount = await stopManagedPreview(null);
      }
      sendJson(res, 200, { ok: true, stopped: true, running: false, stoppedCount });
      return;
    }

    if (pathname.startsWith("/api/project/preview-proxy/") && (req.method === "GET" || req.method === "HEAD")) {
      const rest = pathname.slice("/api/project/preview-proxy/".length);
      const slashIdx = rest.indexOf("/");
      const rawProjSeg = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      const subPath = slashIdx === -1 ? "/" : `/${rest.slice(slashIdx + 1)}`;
      let projSeg = "";
      try {
        projSeg = decodeURIComponent(rawProjSeg).trim();
      } catch (_e) {
        sendJsonError(res, 400, "Ruta de preview proxy malformada.");
        return;
      }

      const projInfo = resolveProjectInfo(projSeg, query.projectPath || query.customPath || null);
      const entry = getActiveManagedPreview(projInfo.stateKey, projInfo.name || projSeg);
      if (!entry) {
        sendJsonError(res, 503, `El dev-server de preview no está activo para ${projSeg}.`);
        return;
      }

      const forwardParams = new URLSearchParams(parsedUrl.searchParams);
      forwardParams.delete("projectPath");
      forwardParams.delete("customPath");
      const forwardQs = forwardParams.toString();
      const targetPath = `${subPath}${forwardQs ? `?${forwardQs}` : ""}`;
      const encodedProj = encodeURIComponent(projInfo.name || projSeg);
      const proxyPrefix = `/api/project/preview-proxy/${encodedProj}`;

      await new Promise((resolve) => {
        const upHeaders = {
          "accept": req.headers.accept || "*/*",
          "accept-encoding": "identity"
        };
        if (req.headers["user-agent"]) upHeaders["user-agent"] = req.headers["user-agent"];

        const upReq = http.request({
          hostname: entry.host || "127.0.0.1",
          port: entry.port,
          path: targetPath,
          method: req.method,
          headers: upHeaders,
          timeout: 15000
        }, (upRes) => {
          const headersOut = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            const lk = k.toLowerCase();
            if (lk === "transfer-encoding" || lk === "content-length" || lk === "content-security-policy" || lk === "x-frame-options") {
              continue;
            }
            if (lk === "location" && typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith(proxyPrefix)) {
              headersOut[k] = `${proxyPrefix}${v}`;
              continue;
            }
            headersOut[k] = v;
          }
          headersOut["Cache-Control"] = "no-store";

          const contentType = String(upRes.headers["content-type"] || "").toLowerCase();
          if (contentType.includes("text/html") && req.method !== "HEAD") {
            const chunks = [];
            upRes.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
            upRes.on("end", () => {
              const htmlWithBridge = injectPreviewBridgeHtml(Buffer.concat(chunks).toString("utf-8"));
              const outBuf = Buffer.from(htmlWithBridge, "utf-8");
              headersOut["Content-Length"] = outBuf.length;
              if (!res.headersSent) res.writeHead(upRes.statusCode || 200, headersOut);
              res.end(outBuf);
              resolve();
            });
            upRes.on("error", () => {
              if (!res.headersSent) sendJsonError(res, 502, "Error leyendo HTML del dev-server de preview.");
              else if (!res.writableEnded) res.end();
              resolve();
            });
            return;
          }

          if (upRes.headers["content-length"] !== undefined) {
            headersOut["Content-Length"] = upRes.headers["content-length"];
          }
          if (!res.headersSent) res.writeHead(upRes.statusCode || 200, headersOut);
          if (req.method === "HEAD") {
            upRes.resume();
            res.end();
            resolve();
            return;
          }
          upRes.pipe(res);
          upRes.on("end", () => resolve());
          upRes.on("error", () => {
            if (!res.writableEnded) res.end();
            resolve();
          });
        });

        upReq.on("error", (err) => {
          sendJsonError(res, 502, `Error conectando con dev-server de preview: ${safeErrMsg(err)}`);
          resolve();
        });
        upReq.on("timeout", () => {
          try { upReq.destroy(); } catch (_e) {}
          sendJsonError(res, 504, "Timeout conectando con dev-server de preview.");
          resolve();
        });
        upReq.end();
      });
      return;
    }

    if (pathname === "/api/gallery" && req.method === "GET") {
      const projInfo = resolveProjectInfo(query.project || null, query.projectPath || query.customPath || null);
      if (!projInfo || projInfo.isGeneral || !projInfo.path || !fs.existsSync(projInfo.path)) {
        sendJson(res, 200, { ok: true, project: projInfo ? projInfo.name : null, images: [] });
        return;
      }
      const bibDir = path.join(projInfo.path, "biblioteca");
      const images = [];
      if (fs.existsSync(bibDir)) {
        for (const name of fs.readdirSync(bibDir)) {
          if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
          const full = path.join(bibDir, name);
          try {
            const st = fs.statSync(full);
            if (!st.isFile()) continue;
            images.push({
              name,
              size: st.size,
              mtime: st.mtime.toISOString(),
              url: `/api/project/static/${encodeURIComponent(projInfo.name)}/biblioteca/${encodeURIComponent(name)}`
            });
          } catch (_e) {}
        }
      }
      images.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
      sendJson(res, 200, { ok: true, project: projInfo.name, images });
      return;
    }

    if (pathname.startsWith("/api/project/static/") && (req.method === "GET" || req.method === "HEAD")) {
      const rest = pathname.slice("/api/project/static/".length);
      const slashIdx = rest.indexOf("/");
      const rawProjSeg = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      const rawRelFile = slashIdx === -1 ? "index.html" : (rest.slice(slashIdx + 1) || "index.html");
      let projSeg = "";
      let relFile = "";
      try {
        projSeg = decodeURIComponent(rawProjSeg).trim();
        relFile = decodeURIComponent(rawRelFile).trim() || "index.html";
      } catch (_e) {
        sendJsonError(res, 400, "Ruta de preview malformada.");
        return;
      }

      const projInfo = resolveProjectInfo(projSeg, query.projectPath || query.customPath || null);
      if (!projInfo || projInfo.isGeneral || !projInfo.path || !fs.existsSync(projInfo.path)) {
        sendJsonError(res, 404, `Proyecto no encontrado para preview: ${projSeg}`);
        return;
      }

      let safe = bridge.resolveSafeProjectPath(projInfo.path, relFile);
      if ((!safe.ok || !fs.existsSync(safe.fullPath)) && relFile === "index.html") {
        for (const alt of ["src/ui/index.html", "public/index.html", "dist/index.html"]) {
          const trySafe = bridge.resolveSafeProjectPath(projInfo.path, alt);
          if (trySafe.ok && fs.existsSync(trySafe.fullPath)) {
            safe = trySafe;
            break;
          }
        }
      }

      if (!safe.ok) {
        sendJsonError(res, 403, safe.error || "Ruta protegida o fuera del proyecto");
        return;
      }
      if (!fs.existsSync(safe.fullPath) || !fs.statSync(safe.fullPath).isFile()) {
        sendJsonError(res, 404, `Archivo de preview no encontrado: ${safe.cleanRelPath}`);
        return;
      }

      const STATIC_MIMES = {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".ico": "image/x-icon",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8"
      };
      const ext = path.extname(safe.fullPath).toLowerCase();
      const mimeType = STATIC_MIMES[ext] || "application/octet-stream";

      if (ext === ".html" || ext === ".htm") {
        const htmlText = injectPreviewBridgeHtml(fs.readFileSync(safe.fullPath, "utf-8"));
        const buf = Buffer.from(htmlText, "utf-8");
        res.writeHead(200, {
          "Content-Type": mimeType,
          "Content-Length": buf.length,
          "Cache-Control": "no-store"
        });
        if (req.method === "HEAD") res.end();
        else res.end(buf);
        return;
      }

      const st = fs.statSync(safe.fullPath);
      res.writeHead(200, {
        "Content-Type": mimeType,
        "Content-Length": st.size,
        "Cache-Control": "no-store"
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(safe.fullPath).pipe(res);
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
      const projTarget = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const enterPayload = contextAnalyzer.buildEnterContextPayload({
        projectName: projTarget,
        convId: payload.conversationId || null,
        token: payload.token || null,
        skillId: payload.skillId || null,
        skillIds: payload.skillIds || payload.skillId || null,
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
          directmlCompatibility: enterPayload.promptPackage.directmlCompatibility,
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
        directmlCompatibility: enterPayload.promptPackage.directmlCompatibility,
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

      const enterAbort = new AbortController();
      let clientClosed = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          clientClosed = true;
          enterAbort.abort();
        }
      });

      let streamedText = "";
      try {
        await streamEngineCompletion(
          {
            engine: target.engine,
            model: target.model,
            systemPrompt: enterPayload.promptPackage.systemPrompt,
            userPrompt: enterPayload.promptPackage.userPrompt,
            payload,
            signal: enterAbort.signal
          },
          (tokenChunk) => {
            streamedText += tokenChunk;
            if (!clientClosed && !res.writableEnded) {
              res.write(JSON.stringify({
                model: target.model,
                message: { role: "assistant", content: tokenChunk },
                done: false
              }) + "\n");
            }
          }
        );

        if (clientClosed) {
          if (!res.writableEnded) res.end();
          return;
        }

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
        if (clientClosed || (engineErr && engineErr.aborted) || enterAbort.signal.aborted) {
          if (!res.writableEnded) res.end();
          return;
        }
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
      const health = await getDirectmlHealth();
      sendJson(res, 200, health);
      return;
    }

    if (pathname === "/api/directml/start" && req.method === "POST") {
      const result = await startDirectMLServer();
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (pathname === "/api/directml/stop" && req.method === "POST") {
      const result = await stopDirectMLServer();
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (pathname === "/api/directml/restart" && req.method === "POST") {
      const payload = await readJsonBody(req);
      const envOverrides = (payload && payload.envOverrides && typeof payload.envOverrides === "object")
        ? hardwareAdvisor.validateSafeEnvOverrides(payload.envOverrides)
        : null;
      const result = await restartDirectMLServer(envOverrides);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }

    if (pathname === "/api/ollama/status" && req.method === "GET") {
      const status = await getOllamaStatus();
      sendJson(res, 200, status);
      return;
    }

    if (pathname === "/api/ollama/start" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      let stoppedDirectML = null;
      if (payload.stopDirectML === true) {
        stoppedDirectML = await stopDirectMLServer();
      }
      const envOverrides = (payload.envOverrides && typeof payload.envOverrides === "object")
        ? hardwareAdvisor.validateSafeEnvOverrides(payload.envOverrides)
        : {};
      const startRes = await startOllamaDaemon(envOverrides);
      const status = await getOllamaStatus();
      sendJson(res, startRes.ok !== false ? 200 : 500, {
        ...startRes,
        stoppedDirectML,
        status
      });
      return;
    }

    if (pathname === "/api/ollama/restart" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      let stoppedDirectML = null;
      if (payload.stopDirectML === true) {
        stoppedDirectML = await stopDirectMLServer();
      }
      const envOverrides = (payload.envOverrides && typeof payload.envOverrides === "object")
        ? hardwareAdvisor.validateSafeEnvOverrides(payload.envOverrides)
        : {};
      const restartRes = await restartOllamaDaemon(envOverrides);
      const status = await getOllamaStatus();
      sendJson(res, restartRes.ok !== false ? 200 : 500, {
        ...restartRes,
        stoppedDirectML,
        status
      });
      return;
    }

    if (pathname === "/api/ollama/unload" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      if (typeof payload.model === "string" && payload.model.trim()) {
        const resUnload = await unloadOllamaModel(payload.model);
        sendJson(res, 200, { ok: true, unloaded: [resUnload] });
      } else {
        const unloaded = await unloadAllLoadedOllamaModels();
        sendJson(res, 200, { ok: true, unloaded });
      }
      return;
    }

    // ---------------------------------------------------------
    // Hardware Advisor & Safe Tuning (/api/system/*)
    // ---------------------------------------------------------
    if (pathname === "/api/system/hardware-profile" && req.method === "GET") {
      const forceRefresh = query.refresh === "1" || query.refresh === "true";
      const [telemetry, ollamaPs, directmlStatus] = await Promise.all([
        hardwareAdvisor.getHostHardwareTelemetry({
          forceRefresh,
          telemetryOverride: config.telemetryOverride
        }),
        getOllamaPs(),
        getDirectmlHealth()
      ]);
      sendJson(res, 200, {
        ok: true,
        telemetry,
        profiles: hardwareAdvisor.getRecommendedProfiles(telemetry),
        ollamaPs,
        directmlStatus
      });
      return;
    }

    if (pathname === "/api/system/hardware-evaluate" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const forceRefresh = payload.forceRefresh === true;
      const [telemetry, catalog, ollamaPs, directmlStatus] = await Promise.all([
        hardwareAdvisor.getHostHardwareTelemetry({
          forceRefresh,
          telemetryOverride: config.telemetryOverride
        }),
        fetchCombinedModelsCatalog(),
        getOllamaPs(),
        getDirectmlHealth()
      ]);

      const rawAgentA = (payload.agentA && typeof payload.agentA === "object") ? payload.agentA : {};
      const rawAgentB = (payload.agentB && typeof payload.agentB === "object") ? payload.agentB : {};
      const pair = hardwareAdvisor.normalizeDualPair(payload.pair || "", rawAgentA, rawAgentB);
      const defaults = hardwareAdvisor.getDefaultAgentsForPair(pair);
      const normSrcA = hardwareAdvisor.normalizeEngineSource(rawAgentA.source || defaults.sourceA);
      const normSrcB = hardwareAdvisor.normalizeEngineSource(rawAgentB.source || defaults.sourceB);
      const dmlAgent = normSrcA === "directml" ? rawAgentA : (normSrcB === "directml" ? rawAgentB : null);
      const combinedDirective = [
        typeof payload.customSystemPrompt === "string" ? payload.customSystemPrompt.trim() : "",
        (dmlAgent && typeof dmlAgent.customSystemPrompt === "string") ? dmlAgent.customSystemPrompt.trim() : ""
      ].filter(Boolean).join("\n\n");

      const evalProjTarget = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const { directmlCompatibility: computedProjectCompat } = buildProjectCompatibilitySummary({
        projectName: evalProjTarget,
        convId: payload.conversationId || null,
        token: payload.token || null,
        skillId: (dmlAgent && dmlAgent.skillId) || payload.skillId || null,
        skillIds: (dmlAgent && (dmlAgent.skillIds || dmlAgent.skillId)) || payload.skillIds || payload.skillId || null,
        profileId: (dmlAgent && dmlAgent.profileId) || payload.profileId || null,
        customSystemPrompt: combinedDirective || null,
        modelOverridesPrompt: (dmlAgent && dmlAgent.modelSystemPrompt) || null,
        extraChars: Number(payload.extraChars || payload.chatHistoryChars || 0)
      });
      const projectCompatibility = (payload.directmlCompatibility && typeof payload.directmlCompatibility === "object")
        ? payload.directmlCompatibility
        : computedProjectCompat;

      const evaluation = hardwareAdvisor.evaluateDualConfiguration({
        pair,
        agentA: rawAgentA,
        agentB: rawAgentB,
        workflow: payload.workflow || "pipeline",
        unloadBetweenTurns: payload.unloadBetweenTurns !== false,
        modelsCatalog: catalog.models,
        telemetry,
        ollamaPs,
        directmlStatus,
        projectCompatibility
      });

      sendJson(res, 200, {
        ok: true,
        telemetry,
        evaluation,
        projectCompatibility,
        profiles: hardwareAdvisor.getRecommendedProfiles(telemetry)
      });
      return;
    }

    if (pathname === "/api/system/apply-tuning" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const scope = payload.scope === "windows_user" ? "windows_user" : "session";
      const telemetry = await hardwareAdvisor.getHostHardwareTelemetry({
        forceRefresh: false,
        telemetryOverride: config.telemetryOverride
      });

      const result = await hardwareAdvisor.applySystemTuning({
        scope,
        pair: payload.pair || null,
        envOverrides: payload.envOverrides || null,
        telemetry,
        skipWindowsApply: config.skipWindowsApply
      });

      const restarts = {
        unloadedOllama: [],
        directml: null,
        ollama: null
      };

      if (payload.unloadOllama) {
        restarts.unloadedOllama = await unloadAllLoadedOllamaModels();
      }
      if (payload.restartDirectML) {
        restarts.directml = await restartDirectMLServer(result.applied);
      } else if (result.applied && Object.keys(result.applied).length > 0) {
        const dmlSubset = {};
        for (const k of ["OLIVE_GPU_MEMORY_LIMIT", "OLIVE_CPU_THREADS", "OLIVE_USE_DIRECTML", "ORT_DML_DEVICE_ID"]) {
          if (result.applied[k] !== undefined) dmlSubset[k] = result.applied[k];
        }
        if (Object.keys(dmlSubset).length > 0) {
          activeDirectmlEnv = { ...activeDirectmlEnv, ...dmlSubset };
        }
      }
      if (payload.restartOllama) {
        restarts.ollama = await restartOllamaDaemon();
      }

      const updatedTelemetry = await hardwareAdvisor.getHostHardwareTelemetry({
        forceRefresh: true,
        telemetryOverride: config.telemetryOverride
      });

      sendJson(res, 200, {
        ...result,
        telemetry: updatedTelemetry,
        restarts
      });
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
      try {
        const catalog = await fetchCombinedModelsCatalog();
        sendJson(res, 200, catalog);
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
    // Estudio de Imagen Free.ai 100% Sin Costo (Self-Hosted)
    // ---------------------------------------------------------
    if (pathname === "/api/freeai/image-models" && req.method === "GET") {
      try {
        const catalog = await freeai.fetchImageCatalog();
        const models = Array.isArray(catalog.models)
          ? catalog.models.map((m) => ({
              ...m,
              cost: 0,
              costUsd: 0
            }))
          : [];
        sendJson(res, 200, {
          ...catalog,
          policy: "ZERO_COST_SELF_HOSTED_ONLY",
          models
        });
      } catch (err) {
        const statusCode = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 502;
        sendJsonError(res, statusCode, err, { code: (err && err.code) || "IMAGE_CATALOG_ERROR" });
      }
      return;
    }

    if (pathname === "/api/freeai/image/generate" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req, 25 * 1024 * 1024));
      try {
        const result = await freeai.generateImage(payload);
        let savedToBiblioteca = null;
        if (payload.autoSaveToProject === true) {
          const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
          if (!projInfo.isGeneral && projInfo.path && fs.existsSync(projInfo.path)) {
            const rawSaved = await freeai.saveImageToBiblioteca({
              projectPath: projInfo.path,
              imageDataUrl: result.imageDataUrl,
              imageUrl: result.imageUrl,
              prompt: payload.prompt,
              negativePrompt: payload.negativePrompt || payload.negative_prompt || "",
              model: result.model,
              params: {
                steps: payload.steps || payload.num_inference_steps,
                cfg_scale: payload.guidance_scale || payload.cfg_scale,
                seed: result.seed,
                width: result.width,
                height: result.height,
                control_type: payload.controlType || payload.control_type || null,
                control_strength: payload.controlStrength || payload.control_strength || null,
                operation: payload.controlImage || payload.control_image ? "sketch-to-render" : "text-to-image"
              },
              metrics: {
                inference_time_ms: result.elapsedMs,
                cost_usd: 0,
                vram_local_mb: 0
              },
              sessionId: payload.sessionId || null,
              allowedRoot: getBaseProjectsDir()
            });
            savedToBiblioteca = {
              ...rawSaved,
              fileName: rawSaved.fileName || rawSaved.imageFileName,
              filePath: rawSaved.imagePath || rawSaved.imageFilePath || rawSaved.filePath,
              metaPath: rawSaved.metadataPath || rawSaved.jsonFilePath || rawSaved.metaPath
            };
          }
        }
        sendJson(res, 200, {
          ...result,
          dataUrl: result.imageDataUrl || result.dataUrl,
          costUsd: 0,
          mode: (payload.controlImage || payload.control_image || result.model === "controlnet-union-sdxl-promax")
            ? "controlnet"
            : "generate",
          savedToBiblioteca
        });
      } catch (err) {
        const statusCode = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 502;
        sendJsonError(res, statusCode, err, { code: (err && err.code) || "IMAGE_GENERATE_ERROR" });
      }
      return;
    }

    if (pathname === "/api/freeai/image/edit" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req, 25 * 1024 * 1024));
      try {
        const result = await freeai.editImage(payload);
        let savedToBiblioteca = null;
        if (payload.autoSaveToProject === true) {
          const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
          if (!projInfo.isGeneral && projInfo.path && fs.existsSync(projInfo.path)) {
            const rawSaved = await freeai.saveImageToBiblioteca({
              projectPath: projInfo.path,
              imageDataUrl: result.imageDataUrl,
              imageUrl: result.imageUrl,
              prompt: payload.prompt || `[${result.model}] Edición / mejora de imagen`,
              negativePrompt: payload.negativePrompt || payload.negative_prompt || "",
              model: result.model,
              params: {
                scale: payload.scale || null,
                strength: payload.strength || null,
                seed: result.seed,
                width: result.width,
                height: result.height,
                operation: result.model === "realesrgan" ? "enhance" : (result.model === "sam" ? "segment" : "img2img")
              },
              metrics: {
                inference_time_ms: result.elapsedMs,
                cost_usd: 0,
                vram_local_mb: 0
              },
              sessionId: payload.sessionId || null,
              allowedRoot: getBaseProjectsDir()
            });
            savedToBiblioteca = {
              ...rawSaved,
              fileName: rawSaved.fileName || rawSaved.imageFileName,
              filePath: rawSaved.imagePath || rawSaved.imageFilePath || rawSaved.filePath,
              metaPath: rawSaved.metadataPath || rawSaved.jsonFilePath || rawSaved.metaPath
            };
          }
        }
        sendJson(res, 200, {
          ...result,
          dataUrl: result.imageDataUrl || result.dataUrl,
          costUsd: 0,
          mode: "edit",
          savedToBiblioteca
        });
      } catch (err) {
        const statusCode = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 502;
        sendJsonError(res, statusCode, err, { code: (err && err.code) || "IMAGE_EDIT_ERROR" });
      }
      return;
    }

    if (pathname === "/api/freeai/image/save" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req, 25 * 1024 * 1024));
      const projInfo = resolveProjectInfo(payload.project || payload.projectName || null, payload.projectPath || null);
      const targetProjectPath = payload.projectPath || (!projInfo.isGeneral ? projInfo.path : "");
      if (!targetProjectPath) {
        sendJsonError(res, 400, "Selecciona un proyecto local activo (no General) o indica projectPath para guardar en biblioteca/.");
        return;
      }
      try {
        const rawSaved = await freeai.saveImageToBiblioteca({
          ...payload,
          imageDataUrl: payload.imageDataUrl || payload.dataUrl || payload.image,
          projectPath: targetProjectPath,
          allowedRoot: getBaseProjectsDir()
        });
        const saved = {
          ...rawSaved,
          fileName: rawSaved.fileName || rawSaved.imageFileName,
          filePath: rawSaved.imagePath || rawSaved.imageFilePath || rawSaved.filePath,
          metaPath: rawSaved.metadataPath || rawSaved.jsonFilePath || rawSaved.metaPath
        };
        try {
          memoryStore.recordFileChange({
            project: projInfo.name || path.basename(targetProjectPath),
            projectPath: targetProjectPath,
            filePath: saved.relativeImagePath || `biblioteca/${saved.imageFileName}`,
            action: "image_save",
            model: payload.model || "freeai-image",
            source: "freeai",
            summary: `Imagen gratuita guardada en biblioteca/ (${saved.imageFileName} + ${saved.jsonFileName})`
          });
          bridge.appendProgressToProject(targetProjectPath, {
            tool: "Free.ai Image Studio (Zero-Cost)",
            model: payload.model || "flux2-klein",
            task: "Generación de activo visual en biblioteca/",
            summary: `Guardado ${saved.imageFileName} y su metadata ${saved.jsonFileName} conforme a ESTRUCTURA.md.`,
            filesModified: [
              saved.relativeImagePath || `biblioteca/${saved.imageFileName}`,
              saved.relativeJsonPath || `biblioteca/${saved.jsonFileName}`
            ]
          });
        } catch (_logErr) {}
        sendJson(res, 200, saved);
      } catch (err) {
        const statusCode = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 400;
        sendJsonError(res, statusCode, err, { code: (err && err.code) || "IMAGE_SAVE_ERROR" });
      }
      return;
    }

    // ---------------------------------------------------------
    // Voz Local Kokoro TTS / Piper ES (/api/tts/*)
    // ---------------------------------------------------------
    if (pathname === "/api/tts/status" && req.method === "GET") {
      const forceRefresh = query.refresh === "1" || query.refresh === "true";
      const status = await ttsBridge.getTtsStatus({ forceRefresh });
      sendJson(res, 200, status);
      return;
    }

    if (pathname === "/api/tts/speak" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      try {
        const result = await ttsBridge.synthesizeSpeech({
          text: payload.text,
          voice: payload.voice,
          speed: payload.speed,
          maxChars: payload.maxChars
        });
        if (!res.writableEnded) {
          res.writeHead(200, {
            "Content-Type": "audio/wav",
            "Content-Length": result.audioBuffer.length,
            "Cache-Control": "no-store",
            "X-TTS-Engine": String(result.engine || "kokoro"),
            "X-TTS-Voice": String(result.voice || "ef_dora"),
            "X-TTS-Sample-Rate": String(result.sampleRate || 24000)
          });
          res.end(result.audioBuffer);
        }
      } catch (ttsErr) {
        const statusCode = (ttsErr && Number.isInteger(ttsErr.statusCode)) ? ttsErr.statusCode : 500;
        sendJsonError(res, statusCode, ttsErr);
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

      const target = detectEngineTarget(payload);
      const messagesWithAttachments = payload.messages !== undefined
        ? attachTopLevelAttachmentsToMessages(payload.messages, payload.attachments)
        : undefined;
      const flattenedMessages = messagesWithAttachments !== undefined
        ? flattenHistoryMessagesForDual(messagesWithAttachments, { preserveSystem: true, targetEngine: target.engine })
        : undefined;
      const mentionedFiles = extractMentionedFilesFromMessages(messagesWithAttachments || [], payload.mentionedFiles);

      const rawProjIdentifier = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const convId = payload.conversationId || null;
      const ctx = bridge.buildProjectContext(rawProjIdentifier, convId, payload.token || null, {
        writeToDisk: false,
        skillId: payload.skillId || null,
        skillIds: payload.skillIds || payload.skillId || null,
        profileId: payload.profileId || null,
        mentionedFiles,
        customSystemPrompt: payload.customSystemPrompt || null,
        modelOverridesPrompt: payload.modelSystemPrompt || null
      });

      const webSearch = await runWebSearchForChat(payload, flattenedMessages || messagesWithAttachments || []);
      let combinedSysPrompt = ctx && ctx.systemPrompt ? ctx.systemPrompt : "";
      if (webSearch && webSearch.contextSuffix) {
        combinedSysPrompt = combinedSysPrompt
          ? `${combinedSysPrompt}${webSearch.contextSuffix}`
          : webSearch.contextSuffix.trim();
      }
      const extraHeaders = webSearch ? { "X-Web-Search-Meta": webSearch.headerValue } : {};
      if (webSearch && !res.headersSent) {
        res.setHeader("X-Web-Search-Meta", webSearch.headerValue);
      }

      const unifiedMessages = injectSystemMessage(flattenedMessages, combinedSysPrompt);

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
          proxyToDirectML("/v1/chat/completions", "POST", dmlPayload, res, { extraHeaders });
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
            combinedSysPrompt,
            { extraHeaders }
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

      await ensureOllamaRunning();

      const ollamaPayload = {
        ...payload,
        model: target.model || payload.model,
        messages: unifiedMessages
      };
      if (payload.modelfileOptions && typeof payload.modelfileOptions === "object") {
        ollamaPayload.options = { ...(payload.options || {}), ...payload.modelfileOptions };
      }

      proxyToOllama("/api/chat", "POST", JSON.stringify(ollamaPayload), res, { extraHeaders });
      return;
    }

    // ---------------------------------------------------------
    // Modo Dual Orquestado (2 Agentes Independientes)
    // ---------------------------------------------------------
    if (pathname === "/api/chat/dual" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
        sendJsonError(res, 400, "El campo 'messages' es obligatorio y debe contener al menos un mensaje.");
        return;
      }

      const RECOGNIZED_PAIRS = new Set([
        "freeai+directml",
        "directml+freeai",
        "freeai+ollama",
        "ollama+freeai",
        "ollama+directml",
        "directml+ollama"
      ]);
      const RECOGNIZED_ENGINES = new Set([
        "ollama",
        "local",
        "directml",
        "dml",
        "onnx",
        "freeai",
        "free.ai",
        "free-ai",
        "cloud"
      ]);

      const rawPairInput = typeof payload.pair === "string" ? payload.pair.trim() : "";
      if (rawPairInput) {
        const cleanedPairToken = rawPairInput
          .toLowerCase()
          .replace(/free\.ai/g, "freeai")
          .replace(/local/g, "ollama")
          .replace(/\s+/g, "");
        if (!RECOGNIZED_PAIRS.has(cleanedPairToken)) {
          sendJsonError(res, 400, `Par dual no reconocido: '${rawPairInput}'. Usa freeai+directml, freeai+ollama o ollama+directml.`);
          return;
        }
      }

      const rawA = ensurePlainObject(payload.agentA || {}, "agentA");
      const rawB = ensurePlainObject(payload.agentB || {}, "agentB");

      if (rawA.source !== undefined && String(rawA.source).trim() !== "") {
        const tokA = String(rawA.source).trim().toLowerCase();
        if (!RECOGNIZED_ENGINES.has(tokA)) {
          sendJsonError(res, 400, `Motor no reconocido para Agente A: '${rawA.source}'.`);
          return;
        }
      }
      if (rawB.source !== undefined && String(rawB.source).trim() !== "") {
        const tokB = String(rawB.source).trim().toLowerCase();
        if (!RECOGNIZED_ENGINES.has(tokB)) {
          sendJsonError(res, 400, `Motor no reconocido para Agente B: '${rawB.source}'.`);
          return;
        }
      }

      let pair;
      let defaults;
      let srcA;
      let srcB;

      if (rawPairInput) {
        pair = hardwareAdvisor.normalizeDualPair(rawPairInput);
        defaults = hardwareAdvisor.getDefaultAgentsForPair(pair);
        srcA = (rawA.source && String(rawA.source).trim())
          ? hardwareAdvisor.normalizeEngineSource(rawA.source)
          : defaults.sourceA;
        srcB = (rawB.source && String(rawB.source).trim())
          ? hardwareAdvisor.normalizeEngineSource(rawB.source)
          : defaults.sourceB;
      } else {
        defaults = hardwareAdvisor.getDefaultAgentsForPair("freeai+directml");
        srcA = (rawA.source && String(rawA.source).trim())
          ? hardwareAdvisor.normalizeEngineSource(rawA.source)
          : defaults.sourceA;
        srcB = (rawB.source && String(rawB.source).trim())
          ? hardwareAdvisor.normalizeEngineSource(rawB.source)
          : defaults.sourceB;
        if (srcA === srcB) {
          sendJsonError(res, 400, `Modo Dual requiere dos motores distintos (A y B no pueden ser ambos '${srcA}').`);
          return;
        }
        pair = hardwareAdvisor.normalizeDualPair("", { source: srcA }, { source: srcB });
        defaults = hardwareAdvisor.getDefaultAgentsForPair(pair);
      }

      if (!hardwareAdvisor.isPairCompatibleWithAgents(pair, { source: srcA }, { source: srcB })) {
        sendJsonError(res, 400, `Los agentes configurados (${srcA} + ${srcB}) no son compatibles con el par '${pair}'.`);
        return;
      }

      const dualMessagesWithAttachments = attachTopLevelAttachmentsToMessages(payload.messages, payload.attachments);
      const baseHistory = flattenHistoryMessagesForDual(dualMessagesWithAttachments);
      if (baseHistory.length === 0) {
        sendJsonError(res, 400, "No hay mensajes válidos de usuario/asistente para procesar en Modo Dual.");
        return;
      }

      if (srcA === "ollama" || srcB === "ollama") {
        await ensureOllamaRunning();
      }

      const [telemetry, catalog, ollamaPs, directmlStatus] = await Promise.all([
        hardwareAdvisor.getHostHardwareTelemetry({
          forceRefresh: false,
          telemetryOverride: config.telemetryOverride
        }),
        fetchCombinedModelsCatalog(),
        getOllamaPs(),
        getDirectmlHealth()
      ]);

      const modelA = (typeof rawA.model === "string" && rawA.model.trim())
        ? rawA.model.trim()
        : pickDefaultModelForSource(catalog, srcA);
      const modelB = (typeof rawB.model === "string" && rawB.model.trim())
        ? rawB.model.trim()
        : pickDefaultModelForSource(catalog, srcB);

      if (!modelA || !modelB) {
        sendJsonError(
          res,
          400,
          `No se pudo resolver un modelo válido para ${!modelA ? `Agente A (${srcA})` : `Agente B (${srcB})`}. Verifica que haya modelos disponibles.`
        );
        return;
      }

      const requestedWorkflow = hardwareAdvisor.normalizeWorkflow(payload.workflow || "", defaults.defaultWorkflow);
      const requestedUnload = payload.unloadBetweenTurns !== undefined
        ? Boolean(payload.unloadBetweenTurns)
        : defaults.unloadBetweenTurns;

      const evalNumCtxA = Number(rawA.numCtx || rawA.num_ctx);
      const evalNumCtxB = Number(rawB.numCtx || rawB.num_ctx);
      const rawProjIdentifier = resolveRequestProjectTarget(payload.project || null, payload.projectPath || null, payload.customPath || null);
      const convId = payload.conversationId || null;
      const globalDirective = typeof payload.customSystemPrompt === "string" ? payload.customSystemPrompt.trim() : "";

      let dualProjectCompatibility = null;
      if (srcA === "directml" || srcB === "directml") {
        const dmlRawSlot = srcA === "directml" ? rawA : rawB;
        const dmlOwnPrompt = typeof dmlRawSlot.customSystemPrompt === "string" ? dmlRawSlot.customSystemPrompt.trim() : "";
        const dmlCombinedDirective = [globalDirective, dmlOwnPrompt].filter(Boolean).join("\n\n");
        const baseHistoryChars = baseHistory.reduce((acc, m) => acc + String((m && m.content) || "").length, 0) + 220;
        dualProjectCompatibility = buildProjectCompatibilitySummary({
          projectName: rawProjIdentifier,
          convId,
          token: payload.token || null,
          skillId: dmlRawSlot.skillId || null,
          skillIds: dmlRawSlot.skillIds || dmlRawSlot.skillId || payload.skillIds || payload.skillId || null,
          profileId: dmlRawSlot.profileId || null,
          customSystemPrompt: dmlCombinedDirective || null,
          modelOverridesPrompt: dmlRawSlot.modelSystemPrompt || null,
          extraChars: baseHistoryChars
        }).directmlCompatibility;
      }

      const evaluation = hardwareAdvisor.evaluateDualConfiguration({
        pair,
        agentA: {
          source: srcA,
          model: modelA,
          numCtx: Number.isFinite(evalNumCtxA) && evalNumCtxA > 0 ? evalNumCtxA : undefined
        },
        agentB: {
          source: srcB,
          model: modelB,
          numCtx: Number.isFinite(evalNumCtxB) && evalNumCtxB > 0 ? evalNumCtxB : undefined
        },
        workflow: requestedWorkflow,
        unloadBetweenTurns: requestedUnload,
        modelsCatalog: catalog.models,
        telemetry,
        ollamaPs,
        directmlStatus,
        projectCompatibility: dualProjectCompatibility
      });

      let effectiveWorkflow = requestedWorkflow;
      let downgradedFromParallel = false;
      if (requestedWorkflow === "parallel" && evaluation.bothLocalModels && !evaluation.allowParallelLocal && !payload.forceParallel) {
        effectiveWorkflow = "pipeline";
        downgradedFromParallel = true;
      }
      const effectiveUnloadBetweenTurns = evaluation.bothLocalModels ? Boolean(requestedUnload) : false;

      const roleLabelA = String(rawA.roleLabel || rawA.role || "Arquitecto / Generador").trim();
      const roleLabelB = String(rawB.roleLabel || rawB.role || "Auditor / Crítico").trim();

      const webSearch = await runWebSearchForChat(payload, baseHistory);
      const dualWebSearchSuffix = (webSearch && webSearch.contextSuffix) ? webSearch.contextSuffix.trim() : "";

      function composeAgentDirective(slot, roleLabel, ownPrompt) {
        let stageRule = "";
        if (effectiveWorkflow === "pipeline") {
          stageRule = slot === "A"
            ? "ETAPA 1 (Pipeline): Propón la arquitectura, análisis y código inicial completo y verificado."
            : "ETAPA 2 (Pipeline): Audita rigurosamente la salida del Agente A, corrige fallos/omisiones y entrega la versión final refinada.";
        } else if (effectiveWorkflow === "debate") {
          stageRule = slot === "A"
            ? "MODO DEBATE: Presenta primero tu solución sólida y, tras recibir la auditoría de B en la ronda final, consolida la versión definitiva superior."
            : "MODO DEBATE (Crítica): Evalúa la propuesta de A con rigor técnico, señala vulnerabilidades, bugs o contradicciones y aporta correcciones concretas.";
        } else {
          stageRule = "MODO PARALELO: Responde de forma autónoma y completa a la solicitud del usuario aplicando tu rol y especialidad.";
        }

        const sections = [
          `Eres el Agente ${slot} (${roleLabel}) en Local AI Studio (Modo Dual: ${pair} | Flujo: ${effectiveWorkflow}).`,
          stageRule
        ];
        if (globalDirective) sections.push(`Directiva compartida de sesión:\n${globalDirective}`);
        if (ownPrompt && String(ownPrompt).trim()) {
          sections.push(`Directiva específica del Agente ${slot}:\n${String(ownPrompt).trim()}`);
        }
        if (dualWebSearchSuffix) {
          sections.push(dualWebSearchSuffix);
        }
        return sections.join("\n\n");
      }

      const dualMentionedFiles = extractMentionedFilesFromMessages(dualMessagesWithAttachments || [], payload.mentionedFiles);

      const ctxA = bridge.buildProjectContext(rawProjIdentifier, convId, payload.token || null, {
        writeToDisk: false,
        skillId: rawA.skillId || null,
        skillIds: rawA.skillIds || rawA.skillId || payload.skillIds || payload.skillId || null,
        profileId: rawA.profileId || null,
        mentionedFiles: dualMentionedFiles,
        customSystemPrompt: composeAgentDirective("A", roleLabelA, rawA.customSystemPrompt),
        modelOverridesPrompt: rawA.modelSystemPrompt || null
      });

      const ctxB = bridge.buildProjectContext(rawProjIdentifier, convId, payload.token || null, {
        writeToDisk: false,
        skillId: rawB.skillId || null,
        skillIds: rawB.skillIds || rawB.skillId || payload.skillIds || payload.skillId || null,
        profileId: rawB.profileId || null,
        mentionedFiles: dualMentionedFiles,
        customSystemPrompt: composeAgentDirective("B", roleLabelB, rawB.customSystemPrompt),
        modelOverridesPrompt: rawB.modelSystemPrompt || null
      });

      const historyForA = injectSystemMessage(baseHistory, (ctxA && ctxA.systemPrompt) || "");
      const historyForB = injectSystemMessage(baseHistory, (ctxB && ctxB.systemPrompt) || "");

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      const dualAbort = new AbortController();
      let clientClosed = false;
      res.on("close", () => {
        if (!res.writableEnded) {
          clientClosed = true;
          dualAbort.abort();
        }
      });

      const writeEvent = (ev) => {
        if (clientClosed || res.writableEnded) return false;
        try {
          res.write(`${JSON.stringify(ev)}\n`);
          return true;
        } catch (_e) {
          clientClosed = true;
          dualAbort.abort();
          return false;
        }
      };

      const dualStartMs = Date.now();
      let partialFailure = false;

      const buildEngineOptions = (rawAgent, engine) => {
        const opts = {};
        if (rawAgent.temperature !== undefined && Number.isFinite(Number(rawAgent.temperature))) {
          opts.temperature = Number(rawAgent.temperature);
        }
        const maxTok = Number(rawAgent.maxTokens || rawAgent.max_tokens);
        if (Number.isFinite(maxTok) && maxTok > 0) {
          opts.max_tokens = maxTok;
        }
        const numCtx = Number(rawAgent.numCtx || rawAgent.num_ctx);
        if (Number.isFinite(numCtx) && numCtx > 0) {
          opts.num_ctx = numCtx;
        }
        if (rawAgent.numThread !== undefined && Number.isFinite(Number(rawAgent.numThread))) {
          opts.num_thread = Number(rawAgent.numThread);
        }
        if (engine === "ollama") {
          if (rawAgent.keepAlive !== undefined) {
            opts.keep_alive = rawAgent.keepAlive;
          } else if (effectiveUnloadBetweenTurns && evaluation.bothLocalModels) {
            opts.keep_alive = 0;
          }
        }
        return opts;
      };

      async function executeAgentStage(slot, stageNum, stageLabel, engine, model, roleLabel, rawAgent, messagesForStage) {
        if (clientClosed || dualAbort.signal.aborted) {
          return { ok: false, error: "Conexión cerrada por el cliente", partialText: "", elapsedMs: 0 };
        }
        const stageStart = Date.now();
        writeEvent({
          type: "agent_start",
          agent: slot,
          stage: stageNum,
          stageLabel,
          source: engine,
          model,
          roleLabel
        });

        try {
          const result = await streamEngineCompletion(
            {
              engine,
              model,
              messages: messagesForStage,
              payload: buildEngineOptions(rawAgent, engine),
              signal: dualAbort.signal
            },
            (delta) => {
              if (!clientClosed && delta) {
                writeEvent({
                  type: "agent_chunk",
                  agent: slot,
                  stage: stageNum,
                  delta
                });
              }
            }
          );
          const elapsedMs = Date.now() - stageStart;
          const finalText = (result && result.text) || "";
          writeEvent({
            type: "agent_done",
            agent: slot,
            stage: stageNum,
            source: engine,
            model,
            roleLabel,
            elapsedMs,
            text: finalText
          });
          return { ok: true, text: finalText, elapsedMs };
        } catch (stageErr) {
          partialFailure = true;
          const elapsedMs = Date.now() - stageStart;
          const partialText = stageErr && typeof stageErr.partialText === "string" ? stageErr.partialText : "";
          const errMessage = safeErrMsg(stageErr);
          if (!clientClosed) {
            writeEvent({
              type: "agent_error",
              agent: slot,
              stage: stageNum,
              source: engine,
              model,
              roleLabel,
              elapsedMs,
              error: errMessage,
              partialText
            });
          }
          return { ok: false, error: errMessage, partialText, elapsedMs };
        }
      }

      try {
        writeEvent({
          type: "dual_preflight",
          pair,
          workflow: effectiveWorkflow,
          requestedWorkflow,
          downgradedFromParallel,
          unloadBetweenTurns: effectiveUnloadBetweenTurns,
          agentA: {
            source: srcA,
            model: modelA,
            roleLabel: roleLabelA,
            skillId: rawA.skillId || null,
            profileId: rawA.profileId || null
          },
          agentB: {
            source: srcB,
            model: modelB,
            roleLabel: roleLabelB,
            skillId: rawB.skillId || null,
            profileId: rawB.profileId || null
          },
          evaluation
        });

        if (webSearch && webSearch.meta) {
          writeEvent({
            type: "web_search",
            ...webSearch.meta
          });
        }

        if (downgradedFromParallel) {
          writeEvent({
            type: "system_notice",
            level: "warn",
            code: "AUTO_SEQUENTIAL_VRAM_GUARD",
            message: "Modo Paralelo degradado automáticamente a Pipeline Secuencial (A → B) para evitar contención VRAM/DXGI con ambos motores locales activos."
          });
        }

        if (effectiveWorkflow === "parallel") {
          await Promise.all([
            executeAgentStage("A", 1, "Paralelo A", srcA, modelA, roleLabelA, rawA, historyForA),
            executeAgentStage("B", 1, "Paralelo B", srcB, modelB, roleLabelB, rawB, historyForB)
          ]);
        } else if (effectiveWorkflow === "debate") {
          const resA1 = await executeAgentStage("A", 1, "Propuesta", srcA, modelA, roleLabelA, rawA, historyForA);

          if (!clientClosed && effectiveUnloadBetweenTurns && evaluation.bothLocalModels && srcA === "ollama") {
            await unloadOllamaModel(modelA).catch(() => {});
          }

          const stage2UserPrompt = (resA1.ok && resA1.text.trim())
            ? [
                "Audita y critica técnicamente la propuesta inicial del Agente A para la solicitud del usuario.",
                "Señala errores, riesgos, inconsistencias o mejoras clave, y aporta correcciones o bloques de código mejorados:",
                "",
                "<salida_agente_a>",
                resA1.text.trim(),
                "</salida_agente_a>"
              ].join("\n")
            : [
                `El Agente A (${modelA}) falló al generar su propuesta (${safeErrMsg(resA1.error || "error de ejecución")}).`,
                "Genera de forma independiente la propuesta técnica y el análisis crítico para la solicitud original del usuario."
              ].join("\n");

          const messagesForB2 = [...historyForB, { role: "user", content: stage2UserPrompt }];
          const resB2 = await executeAgentStage("B", 2, "Crítica y Auditoría", srcB, modelB, roleLabelB, rawB, messagesForB2);

          if (!clientClosed && effectiveUnloadBetweenTurns && evaluation.bothLocalModels && srcB === "ollama") {
            await unloadOllamaModel(modelB).catch(() => {});
          }

          // Etapa 3 (Consolidación final por A) SOLO si tanto Etapa 1 como Etapa 2 concluyeron con éxito
          if (!clientClosed && resA1.ok && resB2.ok) {
            const consolidationPrompt = [
              "Revisa la auditoría del Agente B sobre tu propuesta inicial y produce una versión definitiva consolidada, limpia y lista para aplicar.",
              "",
              "<critica_agente_b>",
              resB2.text.trim() || "[Sin observaciones adicionales]",
              "</critica_agente_b>"
            ].join("\n");

            const messagesForA3 = [
              ...historyForA,
              { role: "assistant", content: resA1.text },
              { role: "user", content: consolidationPrompt }
            ];
            await executeAgentStage("A", 3, "Consolida", srcA, modelA, roleLabelA, rawA, messagesForA3);
          }
        } else {
          // Default canonical workflow: pipeline (A -> B)
          const resA1 = await executeAgentStage("A", 1, "Propuesta Inicial", srcA, modelA, roleLabelA, rawA, historyForA);

          if (!clientClosed && effectiveUnloadBetweenTurns && evaluation.bothLocalModels && srcA === "ollama") {
            await unloadOllamaModel(modelA).catch(() => {});
          }

          const stage2UserPrompt = (resA1.ok && resA1.text.trim())
            ? [
                "Revisa, audita y refina la propuesta del Agente A para la solicitud anterior del usuario.",
                "Corrige cualquier bug, hueco de seguridad o código incompleto, y entrega la respuesta/código final optimizado:",
                "",
                "<salida_agente_a>",
                resA1.text.trim(),
                "</salida_agente_a>"
              ].join("\n")
            : [
                `El Agente A (${modelA}) no pudo completar la Etapa 1 (${safeErrMsg(resA1.error || "motor no disponible")}).`,
                "Asume la ejecución completa de contingencia y resuelve directamente la solicitud del usuario."
              ].join("\n");

          const messagesForB2 = [...historyForB, { role: "user", content: stage2UserPrompt }];
          await executeAgentStage("B", 2, "Auditoría y Refinamiento", srcB, modelB, roleLabelB, rawB, messagesForB2);
        }
      } finally {
        if (!clientClosed && !res.writableEnded) {
          writeEvent({
            type: "dual_done",
            pair,
            workflow: effectiveWorkflow,
            requestedWorkflow,
            elapsedMs: Date.now() - dualStartMs,
            partialFailure
          });
          res.end();
        }
      }
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
    // Búsqueda Web Real & Uso SerpApi (/api/integrations/serpapi/*, /api/search/web)
    // ---------------------------------------------------------
    if (pathname === "/api/integrations/serpapi/usage" && req.method === "GET") {
      sendJson(res, 200, integrations.getSerpApiStatus());
      return;
    }

    if (pathname === "/api/integrations/serpapi/reset" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const result = integrations.resetSerpApiUsage(payload.pool || "all");
      sendJson(res, 200, result);
      return;
    }

    if (pathname === "/api/search/web" && req.method === "POST") {
      const payload = ensurePlainObject(await readJsonBody(req));
      const q = typeof payload.query === "string" ? payload.query.trim() : "";
      if (!q) {
        sendJsonError(res, 400, "El campo 'query' es obligatorio.");
        return;
      }
      const result = await integrations.searchWebSerpApi({
        query: q,
        mode: payload.mode || "web",
        pool: payload.pool || "auto",
        num: payload.num,
        gl: payload.gl,
        hl: payload.hl
      });
      const status = result.ok ? 200 : (result.configured ? 502 : 400);
      sendJson(res, status, result);
      return;
    }

    // ---------------------------------------------------------
    // Fallback UI HTML (solo rutas GET no-API, sin caché WebView)
    // ---------------------------------------------------------
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      try {
        // Interfaz v2 por defecto · clásica siempre disponible en /classic
        const useClassic = pathname === "/classic";
        const fileToServe = (!useClassic && fs.existsSync(HTML_V2_FILE_PATH)) ? HTML_V2_FILE_PATH : HTML_FILE_PATH;
        const html = fs.readFileSync(fileToServe, "utf-8");
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

  const serverInstance = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const status = (err && Number.isInteger(err.statusCode)) ? err.statusCode : 500;
      if (!res.headersSent) {
        sendJsonError(res, status, err);
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  serverInstance.on("close", () => {
    stopManagedPreview().catch(() => {});
    ttsBridge.shutdownTtsWorker().catch(() => {});
  });

  return serverInstance;
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

  const gracefulShutdown = () => {
    ttsBridge.shutdownTtsWorker().catch(() => {}).finally(() => {
      try {
        server.close(() => process.exit(0));
      } catch (_e) {
        process.exit(0);
      }
      setTimeout(() => process.exit(0), 2000).unref();
    });
  };
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[Local AI Chat Sidecar] Puerto ${PORT} en uso, asignando dinámico...`);
      server.listen(0, BIND_HOST);
    } else {
      console.error("[Local AI Chat Sidecar Error]", safeErrMsg(err));
    }
  });

  server.listen(PORT, BIND_HOST, () => {
    const actualPort = server.address().port;
    console.log(`[Local AI Studio] Sidecar running on http://${BIND_HOST}:${actualPort}`);
  });
}

module.exports = {
  createStudioServer,
  readJsonBody,
  resolveProjectInfo,
  detectEngineTarget,
  buildFallbackEnterContextReport
};
