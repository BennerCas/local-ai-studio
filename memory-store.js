const fs = require("node:fs");
const path = require("node:path");
require("./env-loader.js");

const DEFAULT_MEMORY_DIR = path.join(__dirname, "memory");

const DEFAULT_MASTER_PROMPT = [
  "Eres un Principal Systems Architect, Security Engineer y Senior Fullstack Developer operando en Local AI Studio.",
  "",
  "DIRECTRICES INMUTABLES DE INGENIERÍA:",
  "1. Precisión Basada en Evidencia: Fundamenta cada respuesta exclusivamente en archivos, símbolos, rutas y telemetría verificada del proyecto activo. Nunca inventes rutas, dependencias ni APIs inexistentes.",
  "2. Arquitectura Limpia y Modular (SOLID/DRY): Propón código cohesivo, desacoplado, tipado/validado de forma defensiva y libre de código muerto o dependencias innecesarias.",
  "3. Seguridad Zero-Trust: Valida rutas contra path traversal, evita interpolación de shell en subprocesos y jamás expongas secretos, tokens, claves API o archivos .env/.git.",
  "4. Verificación y Estabilidad: Acompaña cada cambio lógico con manejo explícito de errores, compatibilidad retroactiva y casos de prueba verificables.",
  "5. Comunicación Técnica Concisa: Responde en español técnico directo, explicando el porqué de las decisiones críticas y usando bloques write: o patch: válidos cuando debas mutar código.",
  "6. Estética y Diseño UI (DISENO.md): Usar paletas oscuras armoniosas/Glassmorphism, tipografías modernas (Outfit, Inter, JetBrains Mono), micro-animaciones, HTML5 semántico, diseño fluido sin scroll horizontal y Firma Oficial obligatoria en el footer de toda UI generada: HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®.",
  "7. Estructura Estándar y Biblioteca (ESTRUCTURA.md): Respetar src/, biblioteca/, tests/, docs/, models_link/ y nomenclatura YYYYMMDD_HHMMSS_[Tipo]_[Nombre].[ext] con archivo .json de metadatos.",
  "8. Meta-Prompting Estructurado (GEMINI.md Regla 24): Razonar en <thinking>...</thinking> antes de emitir bloques complejos o mutaciones críticas."
].join("\n");

const DEFAULT_CONTEXT_ANALYZER_PROMPT = [
  "<role>",
  "Eres un Principal Cognitive Systems Architect & Forensic Continuity Auditor especializado en auditoría técnica de repositorios de software y reconstrucción precisa de estado para modelos locales de IA.",
  "</role>",
  "",
  "<context>",
  "El usuario ha activado el análisis profundo de continuidad de un proyecto (Enter Context). Recibirás telemetría verificada de Git, manifiestos de dependencias, avances históricos (AVANCES_LOCAL_AI.md), artefactos de Antigravity (task.md, implementation_plan.md, walkthrough.md, transcript.jsonl), estado persistido y marcadores TODO/FIXME.",
  "</context>",
  "",
  "<instructions>",
  "1. Antes de redactar el informe final, razona paso a paso dentro de un bloque obligatorio <thinking>...</thinking> cruzando la telemetría de Git, archivos modificados, checklists inconclusos, errores o riesgos y cambios recientes.",
  "2. CERO ALUCINACIONES: Cita únicamente archivos, ramas, commits, símbolos y tareas presentes en la telemetría recibida. Si un dato no aparece, escribe literalmente [No verificado en telemetría].",
  "3. Después de cerrar </thinking>, genera OBLIGATORIAMENTE y en español exactamente las 4 secciones con sus encabezados exactos (sin texto conversacional previo ni posterior):",
  "   ## 1. Estado Actual Verificado",
  "   ## 2. Procesos Inconclusos y Riesgos",
  "   ## 3. Lista de Tareas Pendientes",
  "   ## 4. Plan de Acción Recomendado",
  "4. Cada sección debe contener al menos 3 puntos concretos y accionables basados en la evidencia (o indicar explícitamente qué evidencia falta si el proyecto está vacío).",
  "</instructions>",
  "",
  "<output_schema>",
  "<thinking>",
  "- Análisis de rama, working tree, commits y cambios recientes.",
  "- Cruce de checklists pendientes, TODO/FIXME y avances previos.",
  "- Detección de bloqueos, deudas técnicas o riesgos de seguridad.",
  "</thinking>",
  "## 1. Estado Actual Verificado",
  "- ...",
  "",
  "## 2. Procesos Inconclusos y Riesgos",
  "- ...",
  "",
  "## 3. Lista de Tareas Pendientes",
  "- [ ] ...",
  "",
  "## 4. Plan de Acción Recomendado",
  "1. ...",
  "</output_schema>"
].join("\n");

function getMemoryDir() {
  const override = process.env.LOCAL_AI_MEMORY_DIR;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return DEFAULT_MEMORY_DIR;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

function sanitizeSafeId(rawId, fallbackPrefix = "item") {
  const cleaned = String(rawId || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  if (!cleaned || /^_+$/.test(cleaned)) {
    return `${fallbackPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  }
  return cleaned;
}

function normalizeSkillIdsArray(rawSkillIds, fallbackSkillId = "") {
  const items = Array.isArray(rawSkillIds)
    ? rawSkillIds
    : (typeof rawSkillIds === "string" ? rawSkillIds.split(",") : []);
  const fb = typeof fallbackSkillId === "string" ? fallbackSkillId.trim() : "";
  const combined = items.length > 0 ? items : (fb ? fb.split(",") : []);
  const seen = new Set();
  const out = [];
  for (const entry of combined) {
    const clean = String(entry || "").trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(clean);
  }
  return out;
}

function sanitizeBackupFileName(relPath) {
  const normalized = String(relPath || "file")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\//g, "__");
  const safe = normalized.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140);
  return safe && safe !== "." && safe !== ".." ? safe : "backup_file";
}

function isContainedInDir(baseDir, targetPath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const cmpBase = process.platform === "win32" ? resolvedBase.toLowerCase() : resolvedBase;
  const cmpTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  const rel = path.relative(cmpBase, cmpTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw || !raw.trim()) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[MemoryStore] Error leyendo ${path.basename(filePath || "json")}:`, err.message);
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const targetPath = path.resolve(filePath);
  ensureDir(path.dirname(targetPath));
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(tmpPath, serialized, "utf-8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch (_) {}
    throw err;
  }
}

// ==========================================
// 1. CHATS (chats_index.json + chats/<safeId>.json)
// ==========================================

function getChatsIndexPath() {
  return path.join(getMemoryDir(), "chats_index.json");
}

function getChatsDir() {
  return path.join(getMemoryDir(), "chats");
}

function getChatFilePath(safeId) {
  const chatsDir = getChatsDir();
  const target = path.join(chatsDir, `${safeId}.json`);
  if (!isContainedInDir(chatsDir, target)) {
    throw new Error("Ruta de chat fuera del directorio permitido");
  }
  return target;
}

function readChatsIndex() {
  const raw = readJsonSafe(getChatsIndexPath(), { version: 1, chats: [] });
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.chats)) return raw.chats;
  return [];
}

function writeChatsIndex(entries) {
  const sorted = [...entries].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });
  writeJsonAtomic(getChatsIndexPath(), {
    version: 1,
    updatedAt: new Date().toISOString(),
    chats: sorted
  });
  return sorted;
}

function normalizeChatSession(sessionObj, existing = null) {
  const nowIso = new Date().toISOString();
  const rawId = sessionObj && (sessionObj.id || sessionObj.sessionId);
  const safeId = sanitizeSafeId(rawId, "chat");

  const messages = Array.isArray(sessionObj?.messages)
    ? sessionObj.messages
    : (Array.isArray(sessionObj?.history) ? sessionObj.history : (existing?.messages || []));

  const appliedFiles = Array.isArray(sessionObj?.appliedFiles)
    ? sessionObj.appliedFiles
    : (existing?.appliedFiles || []);

  const createdAt = existing?.createdAt || sessionObj?.createdAt || nowIso;

  let updatedAt = nowIso;
  if (sessionObj?.updatedAt) {
    if (!existing || sessionObj.updatedAt !== existing.updatedAt || sessionObj._preserveTimestamp) {
      updatedAt = sessionObj.updatedAt;
    }
  } else if (sessionObj?.timestamp && !existing) {
    updatedAt = sessionObj.timestamp;
  }

  const rawDual = (sessionObj?.dualConfig && typeof sessionObj.dualConfig === "object" && !Array.isArray(sessionObj.dualConfig))
    ? sessionObj.dualConfig
    : (existing?.dualConfig && typeof existing.dualConfig === "object" && !Array.isArray(existing.dualConfig)
      ? existing.dualConfig
      : null);
  const dualConfig = rawDual ? normalizeDualConfig(rawDual) : null;

  const hasExplicitSkillIds = sessionObj?.skillIds !== undefined;
  const hasExplicitSkillId = sessionObj?.skillId !== undefined;
  const skillIdStr = String(hasExplicitSkillId ? (sessionObj.skillId || "") : (existing?.skillId || ""));
  let skillIds;
  if (hasExplicitSkillIds) {
    skillIds = normalizeSkillIdsArray(sessionObj.skillIds, hasExplicitSkillId ? skillIdStr : "");
  } else if (hasExplicitSkillId) {
    skillIds = normalizeSkillIdsArray(skillIdStr);
  } else {
    skillIds = normalizeSkillIdsArray(existing?.skillIds, skillIdStr);
  }
  const resolvedSkillId = skillIdStr || (skillIds[0] || "");

  return {
    id: safeId,
    title: String(sessionObj?.title || sessionObj?.name || existing?.title || "Nuevo Chat"),
    project: String(sessionObj?.project || existing?.project || "General"),
    projectPath: String(sessionObj?.projectPath ?? existing?.projectPath ?? ""),
    convId: String(sessionObj?.convId ?? existing?.convId ?? ""),
    mode: sessionObj?.mode === "dual" || (!sessionObj?.mode && existing?.mode === "dual") ? "dual" : "single",
    source: String(sessionObj?.source ?? existing?.source ?? "ollama"),
    model: String(sessionObj?.model ?? existing?.model ?? ""),
    skillId: resolvedSkillId,
    skillIds,
    profileId: String(sessionObj?.profileId ?? existing?.profileId ?? ""),
    customSystemPrompt: String(sessionObj?.customSystemPrompt ?? existing?.customSystemPrompt ?? ""),
    dualConfig,
    dualConfigSummary: sessionObj?.dualConfigSummary ?? existing?.dualConfigSummary ?? null,
    appliedFiles,
    messages,
    createdAt,
    updatedAt
  };
}

function toChatSummary(chat) {
  return {
    id: chat.id,
    title: chat.title,
    project: chat.project,
    projectPath: chat.projectPath,
    convId: chat.convId,
    mode: chat.mode || "single",
    source: chat.source,
    model: chat.model,
    skillId: chat.skillId,
    skillIds: normalizeSkillIdsArray(chat.skillIds, chat.skillId || ""),
    profileId: chat.profileId || "",
    dualConfigSummary: chat.dualConfigSummary || null,
    messageCount: Array.isArray(chat.messages) ? chat.messages.length : (chat.messageCount || 0),
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt
  };
}

function listChats(filter = {}) {
  const index = readChatsIndex();
  let items = index;

  if (filter && typeof filter === "object") {
    if (filter.project && String(filter.project).trim() && String(filter.project).toLowerCase() !== "all") {
      const targetProj = String(filter.project).trim().toLowerCase();
      items = items.filter((c) => String(c.project || "").trim().toLowerCase() === targetProj);
    }
    if (filter.convId) {
      const targetConv = String(filter.convId).trim();
      items = items.filter((c) => String(c.convId || "") === targetConv);
    }
    if (filter.query && String(filter.query).trim()) {
      const q = String(filter.query).trim().toLowerCase();
      items = items.filter((c) =>
        String(c.title || "").toLowerCase().includes(q) ||
        String(c.project || "").toLowerCase().includes(q) ||
        String(c.model || "").toLowerCase().includes(q)
      );
    }
  }

  return [...items].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });
}

function getChat(id) {
  if (!id || typeof id !== "string") return null;
  const cleaned = id.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  if (!cleaned || /^_+$/.test(cleaned)) return null;
  try {
    const filePath = getChatFilePath(cleaned);
    const data = readJsonSafe(filePath, null);
    if (!data || typeof data !== "object") return null;
    const dualConfig = (data.dualConfig && typeof data.dualConfig === "object" && !Array.isArray(data.dualConfig))
      ? normalizeDualConfig(data.dualConfig)
      : null;

    return {
      id: data.id || cleaned,
      title: data.title || "Chat",
      project: data.project || "General",
      projectPath: data.projectPath || "",
      convId: data.convId || "",
      mode: data.mode === "dual" ? "dual" : "single",
      source: data.source || "ollama",
      model: data.model || "",
      skillId: data.skillId || (normalizeSkillIdsArray(data.skillIds, "")[0] || ""),
      skillIds: normalizeSkillIdsArray(data.skillIds, data.skillId || ""),
      profileId: data.profileId || "",
      customSystemPrompt: data.customSystemPrompt || "",
      dualConfig,
      dualConfigSummary: data.dualConfigSummary || null,
      appliedFiles: Array.isArray(data.appliedFiles) ? data.appliedFiles : [],
      messages: Array.isArray(data.messages) ? data.messages : [],
      createdAt: data.createdAt || data.updatedAt || null,
      updatedAt: data.updatedAt || data.createdAt || null
    };
  } catch (err) {
    return null;
  }
}

function saveChat(sessionObj) {
  if (!sessionObj || typeof sessionObj !== "object") {
    throw new Error("sessionObj inválido");
  }
  const candidateId = sessionObj.id || sessionObj.sessionId;
  const safeId = sanitizeSafeId(candidateId, "chat");
  const filePath = getChatFilePath(safeId);
  const existing = readJsonSafe(filePath, null);
  const normalized = normalizeChatSession({ ...sessionObj, id: safeId }, existing);

  writeJsonAtomic(filePath, normalized);

  const index = readChatsIndex().filter((c) => c && c.id !== safeId);
  index.push(toChatSummary(normalized));
  writeChatsIndex(index);

  return normalized;
}

function deleteChat(id) {
  if (!id || typeof id !== "string") {
    return { ok: false, deleted: false, error: "ID inválido" };
  }
  const safeId = id.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  if (!safeId || /^_+$/.test(safeId)) {
    return { ok: false, deleted: false, error: "ID inválido" };
  }

  let existed = false;
  try {
    const filePath = getChatFilePath(safeId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      existed = true;
    }
  } catch (err) {
    return { ok: false, deleted: false, error: err.message };
  }

  const prevIndex = readChatsIndex();
  const nextIndex = prevIndex.filter((c) => c && c.id !== safeId);
  if (nextIndex.length !== prevIndex.length) {
    existed = true;
    writeChatsIndex(nextIndex);
  }

  return { ok: true, deleted: existed, id: safeId };
}

function migrateLegacySessions(sessionsArray) {
  if (!Array.isArray(sessionsArray)) {
    return { imported: 0, total: listChats().length };
  }

  const existingIds = new Set(readChatsIndex().map((c) => c.id));
  let imported = 0;

  for (const raw of sessionsArray) {
    if (!raw || typeof raw !== "object") continue;
    const rawId = raw.id || raw.sessionId;
    if (!rawId) continue;
    const safeId = sanitizeSafeId(rawId, "legacy");
    const filePath = getChatFilePath(safeId);
    if (existingIds.has(safeId) || fs.existsSync(filePath)) {
      continue;
    }
    const ts = raw.updatedAt || raw.timestamp || raw.createdAt || raw.time || new Date().toISOString();
    saveChat({
      ...raw,
      id: safeId,
      createdAt: raw.createdAt || ts,
      updatedAt: ts,
      _preserveTimestamp: true
    });
    existingIds.add(safeId);
    imported++;
  }

  return {
    imported,
    total: readChatsIndex().length
  };
}

// ==========================================
// 2. DESCARGAS HF (downloads.json)
// ==========================================

function getDownloadsPath() {
  return path.join(getMemoryDir(), "downloads.json");
}

function readDownloadsRaw() {
  const raw = readJsonSafe(getDownloadsPath(), { version: 1, downloads: [] });
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.downloads)) return raw.downloads;
  return [];
}

function listDownloads() {
  const items = readDownloadsRaw();
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });
}

function getDownload(jobId) {
  if (!jobId) return null;
  const target = String(jobId).trim();
  const list = readDownloadsRaw();
  return list.find((d) => d && String(d.jobId || d.id) === target) || null;
}

function upsertDownload(job) {
  if (!job || typeof job !== "object") {
    throw new Error("job inválido");
  }
  const jobId = String(job.jobId || job.id || "").trim() || sanitizeSafeId(null, "dl");
  const nowIso = new Date().toISOString();
  const list = readDownloadsRaw();
  const idx = list.findIndex((d) => d && String(d.jobId || d.id) === jobId);
  const existing = idx >= 0 ? list[idx] : null;

  const merged = {
    ...(existing || {}),
    ...job,
    jobId,
    createdAt: existing?.createdAt || job.createdAt || nowIso,
    updatedAt: job.updatedAt || nowIso
  };

  if (idx >= 0) {
    list[idx] = merged;
  } else {
    list.push(merged);
  }

  const sorted = [...list].sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || 0;
    return tb - ta;
  });

  writeJsonAtomic(getDownloadsPath(), {
    version: 1,
    updatedAt: nowIso,
    downloads: sorted
  });

  return merged;
}

// ==========================================
// 3. CAMBIOS Y BACKUPS POR PROYECTO
// ==========================================

function getChangesPath() {
  return path.join(getMemoryDir(), "project_changes.json");
}

function formatBackupTimestamp(date = new Date()) {
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}_${pad(date.getMilliseconds(), 3)}`
  );
}

function backupFileBeforeWrite(projectName, cleanRelPath, fullPath) {
  if (!fullPath || !fs.existsSync(fullPath)) {
    return null;
  }
  try {
    const st = fs.statSync(fullPath);
    if (!st.isFile()) return null;

    const safeProj = sanitizeSafeId(projectName || "General", "General");
    const safeName = sanitizeBackupFileName(cleanRelPath || path.basename(fullPath));
    const ts = formatBackupTimestamp();
    const backupsRoot = path.join(getMemoryDir(), "backups", safeProj);
    ensureDir(backupsRoot);

    let backupPath = path.join(backupsRoot, `${ts}_${safeName}`);
    if (fs.existsSync(backupPath)) {
      backupPath = path.join(backupsRoot, `${ts}_${Math.random().toString(36).slice(2, 6)}_${safeName}`);
    }

    if (!isContainedInDir(path.join(getMemoryDir(), "backups"), backupPath)) {
      throw new Error("Ruta de backup fuera de memory/backups");
    }

    fs.copyFileSync(fullPath, backupPath);
    return backupPath;
  } catch (err) {
    console.warn("[MemoryStore] Error generando backup:", err.message);
    return null;
  }
}

function readChangesRaw() {
  const raw = readJsonSafe(getChangesPath(), { version: 1, changes: [] });
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.changes)) return raw.changes;
  return [];
}

function recordChange(entry) {
  if (!entry || typeof entry !== "object") {
    throw new Error("entry inválido");
  }
  const nowIso = new Date().toISOString();
  const record = {
    id: String(entry.id || `chg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
    timestamp: String(entry.timestamp || nowIso),
    project: String(entry.project || "General"),
    projectPath: String(entry.projectPath || ""),
    relPath: String(entry.relPath || ""),
    action: String(entry.action || "write"),
    sizeBytes: Number.isFinite(Number(entry.sizeBytes)) ? Number(entry.sizeBytes) : 0,
    model: String(entry.model || "Local"),
    source: String(entry.source || "local-ai-studio"),
    backupPath: entry.backupPath || null,
    batchId: entry.batchId ? String(entry.batchId) : null,
    existedBefore: entry.existedBefore !== undefined ? Boolean(entry.existedBefore) : Boolean(entry.backupPath),
    reverted: Boolean(entry.reverted),
    revertedAt: entry.revertedAt || null,
    revertedByChangeId: entry.revertedByChangeId || null,
    remoteRef: entry.remoteRef || null,
    deployUrl: entry.deployUrl || null,
    summary: String(entry.summary || "")
  };

  const current = readChangesRaw();
  current.unshift(record);
  const trimmed = current.slice(0, 500);

  writeJsonAtomic(getChangesPath(), {
    version: 1,
    updatedAt: nowIso,
    changes: trimmed
  });

  return record;
}

function getChangeById(changeId) {
  if (!changeId || typeof changeId !== "string") return null;
  const target = changeId.trim();
  if (!target) return null;
  const items = readChangesRaw();
  return items.find((c) => c && String(c.id) === target) || null;
}

function markChangeReverted(changeId, revertRecordId = null) {
  if (!changeId || typeof changeId !== "string") return null;
  const target = changeId.trim();
  if (!target) return null;

  const current = readChangesRaw();
  const idx = current.findIndex((c) => c && String(c.id) === target);
  if (idx === -1) return null;

  const nowIso = new Date().toISOString();
  current[idx] = {
    ...current[idx],
    reverted: true,
    revertedAt: nowIso,
    revertedByChangeId: revertRecordId ? String(revertRecordId) : null
  };

  writeJsonAtomic(getChangesPath(), {
    version: 1,
    updatedAt: nowIso,
    changes: current
  });

  return current[idx];
}

function listChanges(project = null, limit = 100) {
  let items = readChangesRaw();
  if (project && String(project).trim()) {
    const target = String(project).trim().toLowerCase();
    const resolvedTarget = (target.includes("\\") || target.includes("/") || target.includes(":"))
      ? path.resolve(String(project).trim()).toLowerCase()
      : null;

    items = items.filter((c) => {
      if (!c) return false;
      if (String(c.project || "").trim().toLowerCase() === target) return true;
      if (resolvedTarget && c.projectPath && path.resolve(c.projectPath).toLowerCase() === resolvedTarget) return true;
      return false;
    });
  }
  if (typeof limit === "number" && limit > 0) {
    return items.slice(0, limit);
  }
  return items;
}

function listProjectBackups(projectName, relPath = null, limit = 50) {
  const backupsBase = path.join(getMemoryDir(), "backups");
  const normRel = relPath ? String(relPath).trim().replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase() : null;
  const changes = listChanges(projectName, 500);

  const valid = changes.filter((c) => {
    if (!c) return false;
    if (normRel && String(c.relPath || "").replace(/\\/g, "/").toLowerCase() !== normRel) {
      return false;
    }
    if (c.backupPath && typeof c.backupPath === "string") {
      try {
        if (isContainedInDir(backupsBase, c.backupPath) && fs.existsSync(c.backupPath)) {
          return true;
        }
      } catch (_) {}
    }
    if (c.action === "create") {
      return true;
    }
    return false;
  });

  const numericLimit = (typeof limit === "number" && limit > 0) ? limit : 50;
  return valid.slice(0, numericLimit);
}

// ==========================================
// 4. ESTADO DE CONTINUACIÓN POR PROYECTO
// ==========================================

function getProjectStatesPath() {
  return path.join(getMemoryDir(), "project_states.json");
}

function baseNameAnyPlatform(p) {
  // path.basename solo entiende el separador del SO anfitrión; normalizamos \ y /
  const clean = String(p || "").replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function normalizeProjectKeyAndMeta(projectKeyOrPath) {
  if (projectKeyOrPath && typeof projectKeyOrPath === "object") {
    const pPath = projectKeyOrPath.projectPath ? path.resolve(String(projectKeyOrPath.projectPath)) : "";
    const pName = String(projectKeyOrPath.project || projectKeyOrPath.name || (pPath ? baseNameAnyPlatform(pPath) : "General"));
    return { project: pName, projectPath: pPath };
  }
  const raw = String(projectKeyOrPath || "General").trim();
  if (!raw) return { project: "General", projectPath: "" };
  const looksLikePath = raw.includes("\\") || raw.includes("/") || /^[a-zA-Z]:/.test(raw);
  if (looksLikePath) {
    const resolved = path.resolve(raw);
    return { project: baseNameAnyPlatform(raw) || "General", projectPath: resolved };
  }
  return { project: raw, projectPath: "" };
}

function normalizeDualAgentConfig(raw = {}, fallback = {}) {
  const srcRaw = String(raw?.source || fallback.source || "ollama").trim().toLowerCase();
  const source = srcRaw === "directml"
    ? "directml"
    : (srcRaw === "freeai" || srcRaw === "free.ai" ? "freeai" : "ollama");

  const tempRaw = Number(raw?.temperature ?? fallback.temperature ?? 0.3);
  const temperature = Number.isFinite(tempRaw)
    ? Math.min(2, Math.max(0, Math.round(tempRaw * 100) / 100))
    : 0.3;

  const maxTokRaw = parseInt(raw?.maxTokens ?? fallback.maxTokens ?? 2048, 10);
  const maxTokens = Number.isFinite(maxTokRaw)
    ? Math.min(16384, Math.max(128, maxTokRaw))
    : 2048;

  const numCtxRaw = parseInt(raw?.numCtx ?? fallback.numCtx ?? 4096, 10);
  const numCtx = Number.isFinite(numCtxRaw)
    ? Math.min(65536, Math.max(1024, numCtxRaw))
    : 4096;

  const agentSkillIdRaw = String(raw?.skillId ?? fallback.skillId ?? "");
  const agentSkillIds = normalizeSkillIdsArray(
    raw?.skillIds !== undefined ? raw.skillIds : fallback.skillIds,
    agentSkillIdRaw
  );

  return {
    source,
    model: String(raw?.model ?? fallback.model ?? ""),
    roleLabel: String(raw?.roleLabel ?? fallback.roleLabel ?? "Agente Especialista").slice(0, 80),
    profileId: String(raw?.profileId ?? fallback.profileId ?? ""),
    skillId: agentSkillIdRaw || (agentSkillIds[0] || ""),
    skillIds: agentSkillIds,
    customSystemPrompt: String(raw?.customSystemPrompt ?? fallback.customSystemPrompt ?? ""),
    temperature,
    maxTokens,
    numCtx
  };
}

function buildDefaultDualConfig() {
  return {
    enabled: false,
    pair: "freeai+directml",
    workflow: "parallel",
    unloadBetweenTurns: true,
    agentA: {
      source: "freeai",
      model: "",
      roleLabel: "Arquitecto / Planificador",
      profileId: "",
      skillId: "",
      skillIds: [],
      customSystemPrompt: "",
      temperature: 0.35,
      maxTokens: 2048,
      numCtx: 8192
    },
    agentB: {
      source: "directml",
      model: "Phi-3.5-mini-instruct-ONNX",
      roleLabel: "Implementador / Auditor",
      profileId: "",
      skillId: "",
      skillIds: [],
      customSystemPrompt: "",
      temperature: 0.25,
      maxTokens: 2048,
      numCtx: 4096
    }
  };
}

function normalizeDualConfig(raw = null) {
  const def = buildDefaultDualConfig();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return def;
  }
  const rawPair = String(raw.pair || def.pair).trim().toLowerCase();
  const validPairs = ["freeai+directml", "freeai+ollama", "ollama+directml"];
  const pair = validPairs.includes(rawPair) ? rawPair : def.pair;

  const rawWf = String(raw.workflow || def.workflow).trim().toLowerCase();
  const validWfs = ["pipeline", "parallel", "debate"];
  const workflow = validWfs.includes(rawWf) ? rawWf : def.workflow;

  let fallbackA = def.agentA;
  let fallbackB = def.agentB;
  if (pair === "freeai+ollama") {
    fallbackB = { ...def.agentB, source: "ollama", model: "qwen2.5-coder:latest", numCtx: 8192 };
  } else if (pair === "ollama+directml") {
    fallbackA = { ...def.agentA, source: "ollama", model: "qwen2.5-coder:latest", numCtx: 4096 };
  }

  return {
    enabled: Boolean(raw.enabled),
    pair,
    workflow,
    unloadBetweenTurns: raw.unloadBetweenTurns !== undefined ? Boolean(raw.unloadBetweenTurns) : true,
    agentA: normalizeDualAgentConfig(raw.agentA, fallbackA),
    agentB: normalizeDualAgentConfig(raw.agentB, fallbackB)
  };
}

function buildDefaultProjectState(meta) {
  return {
    project: meta.project || "General",
    projectPath: meta.projectPath || "",
    githubToggle: false,
    githubRepo: "",
    netlifyToggle: false,
    netlifySite: "",
    netlifyPublishDir: "",
    lastSessionId: "",
    selectedFiles: [],
    pinnedFiles: [],
    lastContextAnalysis: null,
    dualConfig: buildDefaultDualConfig(),
    updatedAt: null
  };
}

function readProjectStatesMap() {
  const raw = readJsonSafe(getProjectStatesPath(), { version: 1, states: {} });
  if (raw && typeof raw === "object" && raw.states && typeof raw.states === "object" && !Array.isArray(raw.states)) {
    return raw.states;
  }
  return {};
}

function findMatchingStateKey(statesMap, meta) {
  const keys = Object.keys(statesMap);
  if (meta.projectPath) {
    const pathKey = meta.projectPath.toLowerCase();
    if (statesMap[pathKey]) return pathKey;
    const byPath = keys.find((k) => {
      const s = statesMap[k];
      return s && s.projectPath && path.resolve(s.projectPath).toLowerCase() === pathKey;
    });
    if (byPath) return byPath;
  }
  const nameKey = meta.project.toLowerCase();
  if (statesMap[nameKey]) return nameKey;
  const byName = keys.find((k) => {
    const s = statesMap[k];
    return s && s.project && s.project.toLowerCase() === nameKey;
  });
  return byName || null;
}

function getProjectState(projectKeyOrPath) {
  const meta = normalizeProjectKeyAndMeta(projectKeyOrPath);
  const statesMap = readProjectStatesMap();
  const matchedKey = findMatchingStateKey(statesMap, meta);
  const stored = matchedKey ? statesMap[matchedKey] : null;
  const defaults = buildDefaultProjectState(meta);

  if (!stored) return defaults;
  return {
    ...defaults,
    ...stored,
    project: stored.project || defaults.project,
    projectPath: stored.projectPath || defaults.projectPath,
    selectedFiles: Array.isArray(stored.selectedFiles) ? stored.selectedFiles : [],
    pinnedFiles: Array.isArray(stored.pinnedFiles)
      ? Array.from(new Set(stored.pinnedFiles.map((f) => String(f || "").trim()).filter(Boolean)))
      : [],
    dualConfig: normalizeDualConfig(stored.dualConfig)
  };
}

function updateProjectState(projectKeyOrPath, patch = {}) {
  const meta = normalizeProjectKeyAndMeta(projectKeyOrPath);
  const statesMap = readProjectStatesMap();
  const matchedKey = findMatchingStateKey(statesMap, meta);
  const existing = getProjectState(projectKeyOrPath);
  const nowIso = new Date().toISOString();

  const patchObj = (patch && typeof patch === "object") ? { ...patch } : {};
  let mergedDualConfig = existing.dualConfig || buildDefaultDualConfig();
  if (patchObj.dualConfig && typeof patchObj.dualConfig === "object" && !Array.isArray(patchObj.dualConfig)) {
    mergedDualConfig = normalizeDualConfig({
      ...mergedDualConfig,
      ...patchObj.dualConfig,
      agentA: {
        ...(mergedDualConfig.agentA || {}),
        ...(patchObj.dualConfig.agentA || {})
      },
      agentB: {
        ...(mergedDualConfig.agentB || {}),
        ...(patchObj.dualConfig.agentB || {})
      }
    });
  } else {
    mergedDualConfig = normalizeDualConfig(mergedDualConfig);
  }
  delete patchObj.dualConfig;

  const nextState = {
    ...existing,
    ...patchObj,
    dualConfig: mergedDualConfig,
    project: (patchObj.project) ? String(patchObj.project) : (existing.project || meta.project),
    projectPath: (patchObj.projectPath !== undefined)
      ? String(patchObj.projectPath)
      : (existing.projectPath || meta.projectPath),
    updatedAt: nowIso
  };

  if (!Array.isArray(nextState.selectedFiles)) {
    nextState.selectedFiles = [];
  }
  if (Array.isArray(nextState.pinnedFiles)) {
    nextState.pinnedFiles = Array.from(
      new Set(nextState.pinnedFiles.map((f) => String(f || "").trim()).filter(Boolean))
    );
  } else {
    nextState.pinnedFiles = [];
  }

  const canonicalKey = (nextState.projectPath ? nextState.projectPath : nextState.project).toLowerCase();
  if (matchedKey && matchedKey !== canonicalKey) {
    delete statesMap[matchedKey];
  }
  statesMap[canonicalKey] = nextState;

  writeJsonAtomic(getProjectStatesPath(), {
    version: 1,
    updatedAt: nowIso,
    states: statesMap
  });

  return nextState;
}

function getAllProjectStates() {
  const statesMap = readProjectStatesMap();
  return Object.values(statesMap)
    .filter((s) => s && typeof s === "object")
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || 0) || 0;
      const tb = Date.parse(b.updatedAt || 0) || 0;
      return tb - ta;
    });
}

// ==========================================
// 5. PROMPT MAESTRO (master_prompt.json)
// ==========================================

function getMasterPromptPath() {
  return path.join(getMemoryDir(), "master_prompt.json");
}

function readMasterPromptStored() {
  const raw = readJsonSafe(getMasterPromptPath(), {});
  return (raw && typeof raw === "object") ? raw : {};
}

function getMasterPromptConfig(projectName = null) {
  const stored = readMasterPromptStored();
  const globalPrompt = typeof stored.globalPrompt === "string" ? stored.globalPrompt : DEFAULT_MASTER_PROMPT;
  const contextAnalyzerPrompt = typeof stored.contextAnalyzerPrompt === "string"
    ? stored.contextAnalyzerPrompt
    : DEFAULT_CONTEXT_ANALYZER_PROMPT;

  const projectOverrides = (stored.projectOverrides && typeof stored.projectOverrides === "object")
    ? stored.projectOverrides
    : {};

  let projectOverride = "";
  if (projectName && String(projectName).trim()) {
    const cleanProj = String(projectName).trim();
    const matchedKey = Object.keys(projectOverrides).find((k) => k.toLowerCase() === cleanProj.toLowerCase());
    if (matchedKey && typeof projectOverrides[matchedKey] === "string") {
      projectOverride = projectOverrides[matchedKey];
    }
  }

  let effectivePrompt = globalPrompt;
  if (projectOverride && projectOverride.trim()) {
    effectivePrompt = globalPrompt && globalPrompt.trim()
      ? `${globalPrompt.trim()}\n\n### Directrices Específicas del Proyecto (${projectName}):\n${projectOverride.trim()}`
      : projectOverride.trim();
  }

  return {
    globalPrompt,
    contextAnalyzerPrompt,
    projectOverride,
    effectivePrompt,
    defaults: {
      globalPrompt: DEFAULT_MASTER_PROMPT,
      contextAnalyzerPrompt: DEFAULT_CONTEXT_ANALYZER_PROMPT
    },
    updatedAt: stored.updatedAt || null
  };
}

function saveMasterPromptConfig(input = {}) {
  const current = readMasterPromptStored();
  const nowIso = new Date().toISOString();

  let globalPrompt = typeof current.globalPrompt === "string" ? current.globalPrompt : DEFAULT_MASTER_PROMPT;
  let contextAnalyzerPrompt = typeof current.contextAnalyzerPrompt === "string"
    ? current.contextAnalyzerPrompt
    : DEFAULT_CONTEXT_ANALYZER_PROMPT;
  const projectOverrides = (current.projectOverrides && typeof current.projectOverrides === "object")
    ? { ...current.projectOverrides }
    : {};

  if (input && input.resetToDefault) {
    globalPrompt = DEFAULT_MASTER_PROMPT;
    contextAnalyzerPrompt = DEFAULT_CONTEXT_ANALYZER_PROMPT;
    if (input.project && String(input.project).trim()) {
      const targetKey = Object.keys(projectOverrides).find(
        (k) => k.toLowerCase() === String(input.project).trim().toLowerCase()
      );
      if (targetKey) delete projectOverrides[targetKey];
    }
  } else if (input && typeof input === "object") {
    if (typeof input.globalPrompt === "string") {
      globalPrompt = input.globalPrompt;
    }
    if (typeof input.contextAnalyzerPrompt === "string") {
      contextAnalyzerPrompt = input.contextAnalyzerPrompt;
    }
    if (input.project && String(input.project).trim() && typeof input.projectOverride === "string") {
      const cleanProj = String(input.project).trim();
      const existingKey = Object.keys(projectOverrides).find((k) => k.toLowerCase() === cleanProj.toLowerCase());
      if (existingKey && existingKey !== cleanProj) {
        delete projectOverrides[existingKey];
      }
      if (input.projectOverride.trim()) {
        projectOverrides[cleanProj] = input.projectOverride;
      } else {
        delete projectOverrides[cleanProj];
      }
    }
  }

  writeJsonAtomic(getMasterPromptPath(), {
    version: 1,
    globalPrompt,
    contextAnalyzerPrompt,
    projectOverrides,
    updatedAt: nowIso
  });

  return getMasterPromptConfig(input && input.project ? input.project : null);
}

// ==========================================
// 6. USO DE INTEGRACIONES (integrations_usage.json)
// ==========================================

const INTEGRATIONS_USAGE_FILE = "integrations_usage.json";
const DEFAULT_SERPAPI_MONTHLY_LIMIT = 100;
const MAX_SERPAPI_HISTORY = 30;

function getIntegrationsUsagePath() {
  return path.join(getMemoryDir(), INTEGRATIONS_USAGE_FILE);
}

function getCurrentYearMonth(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function sanitizeUsageQuery(rawQuery) {
  let clean = String(rawQuery || "");
  clean = clean.replace(/([?&]api_key=)[^&\s"']+/gi, "$1[REDACTED]");
  clean = clean.replace(/\s+/g, " ").trim().slice(0, 160);
  return clean;
}

function sanitizeUsageHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  return {
    timestamp: String(entry.timestamp || new Date().toISOString()),
    pool: entry.pool === "jobs" ? "jobs" : "web",
    mode: String(entry.mode || (entry.pool === "jobs" ? "jobs" : "web")).slice(0, 32),
    engine: String(entry.engine || "").slice(0, 40),
    query: sanitizeUsageQuery(entry.query || ""),
    count: Number.isFinite(Number(entry.count)) ? Math.max(0, Math.floor(Number(entry.count))) : 0,
    ...(Number.isFinite(Number(entry.keySlot)) && Number(entry.keySlot) >= 1
      ? { keySlot: Math.floor(Number(entry.keySlot)) }
      : {})
  };
}

function readAndNormalizeIntegrationsUsage() {
  const filePath = getIntegrationsUsagePath();
  const fileExists = fs.existsSync(filePath);
  const raw = readJsonSafe(filePath, null);
  const currentMonth = getCurrentYearMonth();
  const nowIso = new Date().toISOString();

  const baseRaw = (raw && typeof raw === "object" && !Array.isArray(raw)) ? { ...raw } : {};
  const rawSerp = (baseRaw.serpapi && typeof baseRaw.serpapi === "object" && !Array.isArray(baseRaw.serpapi))
    ? baseRaw.serpapi
    : (typeof baseRaw.month === "string" ? baseRaw : null);

  const storedMonth = rawSerp && typeof rawSerp.month === "string" ? rawSerp.month.trim() : "";
  const monthChanged = Boolean(storedMonth && storedMonth !== currentMonth);

  const webLimit = Number.isFinite(Number(rawSerp?.webLimit)) && Number(rawSerp.webLimit) > 0
    ? Math.floor(Number(rawSerp.webLimit))
    : DEFAULT_SERPAPI_MONTHLY_LIMIT;
  const jobsLimit = Number.isFinite(Number(rawSerp?.jobsLimit)) && Number(rawSerp.jobsLimit) > 0
    ? Math.floor(Number(rawSerp.jobsLimit))
    : DEFAULT_SERPAPI_MONTHLY_LIMIT;

  const webUses = monthChanged
    ? 0
    : (Number.isFinite(Number(rawSerp?.webUses)) && Number(rawSerp.webUses) >= 0 ? Math.floor(Number(rawSerp.webUses)) : 0);
  const jobsUses = monthChanged
    ? 0
    : (Number.isFinite(Number(rawSerp?.jobsUses)) && Number(rawSerp.jobsUses) >= 0 ? Math.floor(Number(rawSerp.jobsUses)) : 0);

  const history = Array.isArray(rawSerp?.history)
    ? rawSerp.history.map(sanitizeUsageHistoryEntry).filter(Boolean).slice(0, MAX_SERPAPI_HISTORY)
    : [];

  const serpapi = {
    month: currentMonth,
    webUses,
    webLimit,
    jobsUses,
    jobsLimit,
    lastUsedAt: rawSerp?.lastUsedAt || null,
    lastQuery: sanitizeUsageQuery(rawSerp?.lastQuery || ""),
    lastPool: rawSerp?.lastPool === "web" || rawSerp?.lastPool === "jobs" ? rawSerp.lastPool : null,
    lastMode: typeof rawSerp?.lastMode === "string" && rawSerp.lastMode ? String(rawSerp.lastMode).slice(0, 32) : null,
    history,
    updatedAt: monthChanged ? nowIso : (rawSerp?.updatedAt || null)
  };

  const container = {
    version: 1,
    updatedAt: monthChanged ? nowIso : (baseRaw.updatedAt || serpapi.updatedAt || null),
    serpapi
  };

  if (fileExists && monthChanged) {
    writeJsonAtomic(filePath, container);
  }

  return container;
}

function getIntegrationsUsage() {
  const container = readAndNormalizeIntegrationsUsage();
  return {
    ...container,
    serpapi: {
      ...container.serpapi,
      history: [...container.serpapi.history]
    }
  };
}

function getSerpApiUsage() {
  return getIntegrationsUsage().serpapi;
}

function incrementSerpApiUsage(pool = "web", meta = {}) {
  const container = readAndNormalizeIntegrationsUsage();
  const normPool = String(pool || "web").trim().toLowerCase() === "jobs" ? "jobs" : "web";
  const nowIso = new Date().toISOString();
  const safeMeta = (meta && typeof meta === "object") ? meta : {};

  const safeQuery = sanitizeUsageQuery(safeMeta.query || "");
  const cleanMode = safeMeta.mode
    ? String(safeMeta.mode).trim().toLowerCase().slice(0, 32)
    : (normPool === "jobs" ? "jobs" : "web");
  const cleanEngine = safeMeta.engine ? String(safeMeta.engine).trim().slice(0, 40) : "";
  const cleanCount = Number.isFinite(Number(safeMeta.count)) ? Math.max(0, Math.floor(Number(safeMeta.count))) : 0;

  const serpapi = container.serpapi;
  if (normPool === "jobs") {
    serpapi.jobsUses += 1;
  } else {
    serpapi.webUses += 1;
  }
  serpapi.lastUsedAt = nowIso;
  serpapi.lastQuery = safeQuery;
  serpapi.lastPool = normPool;
  serpapi.lastMode = cleanMode;
  serpapi.updatedAt = nowIso;

  const entry = sanitizeUsageHistoryEntry({
    timestamp: nowIso,
    pool: normPool,
    mode: cleanMode,
    engine: cleanEngine,
    query: safeQuery,
    count: cleanCount,
    keySlot: safeMeta.keySlot
  });
  if (entry) {
    serpapi.history = [entry, ...serpapi.history].slice(0, MAX_SERPAPI_HISTORY);
  }

  container.updatedAt = nowIso;
  writeJsonAtomic(getIntegrationsUsagePath(), container);

  return {
    ...serpapi,
    history: [...serpapi.history]
  };
}

function resetSerpApiUsage(pool = "all") {
  const container = readAndNormalizeIntegrationsUsage();
  const norm = String(pool || "all").trim().toLowerCase();
  const nowIso = new Date().toISOString();
  const serpapi = container.serpapi;

  if (norm === "web") {
    serpapi.webUses = 0;
  } else if (norm === "jobs") {
    serpapi.jobsUses = 0;
  } else {
    serpapi.webUses = 0;
    serpapi.jobsUses = 0;
    serpapi.lastUsedAt = null;
    serpapi.lastQuery = "";
    serpapi.lastPool = null;
    serpapi.lastMode = null;
    serpapi.history = [];
  }

  serpapi.updatedAt = nowIso;
  container.updatedAt = nowIso;
  writeJsonAtomic(getIntegrationsUsagePath(), container);

  return {
    ...serpapi,
    history: [...serpapi.history]
  };
}

module.exports = {
  getMemoryDir,
  readJsonSafe,
  writeJsonAtomic,
  sanitizeSafeId,
  listChats,
  getChat,
  saveChat,
  deleteChat,
  migrateLegacySessions,
  listDownloads,
  getDownload,
  upsertDownload,
  backupFileBeforeWrite,
  recordChange,
  getChangeById,
  markChangeReverted,
  listChanges,
  listProjectBackups,
  getProjectState,
  updateProjectState,
  getAllProjectStates,
  buildDefaultDualConfig,
  normalizeDualConfig,
  DEFAULT_MASTER_PROMPT,
  DEFAULT_CONTEXT_ANALYZER_PROMPT,
  getMasterPromptConfig,
  saveMasterPromptConfig,
  INTEGRATIONS_USAGE_FILE,
  getIntegrationsUsage,
  getSerpApiUsage,
  incrementSerpApiUsage,
  resetSerpApiUsage
};
