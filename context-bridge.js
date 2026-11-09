const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const memoryStore = require("./memory-store.js");
const skillsBridge = require("./skills-bridge.js");

const BASE_PROJECTS_DIR = "C:\\antigravityAS";
const BRAIN_DIR = "C:\\Users\\Benner\\.gemini\\antigravity\\brain";
const RESOLVER_PY = path.join(__dirname, "resolver.py");
const CONFIG_FILE = path.join(__dirname, "active_project.json");

// Constantes exactas del backend ONNX DirectML (api_openai.py):
// DIRECTML_MAX_CONTEXT_TOKENS = 8192, DIRECTML_MAX_PROMPT_TOKENS = 6144,
// safe_prompt_limit = min(DIRECTML_MAX_PROMPT_TOKENS, max(256, ctx - 512)) => HTTP 400 si prompt_len > 6144.
const DIRECTML_KV_CONTEXT_TOKENS = 8192;
const DIRECTML_SAFE_PROMPT_TOKENS = 6144;
const DIRECTML_OUTPUT_RESERVE_TOKENS = 512;
const DIRECTML_CHARS_PER_TOKEN = 4;
const DIRECTML_TIGHT_WARN_RATIO = 0.85;

const SECTION_HUMAN_LABELS = {
  masterPrompt: "Prompt Maestro",
  skillPrompt: "Perfil / Skill",
  stateSummary: "Estado persistido",
  projectContextXml: "Contexto de proyecto",
  codeContextXml: "Código fuente inyectado",
  mutationDirectives: "Directivas de edición",
  systemPrompt: "System Prompt",
  userPrompt: "Telemetría / User Prompt"
};

function estimateApproxTokens(chars = 0) {
  const numeric = Number(chars);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.ceil(numeric / DIRECTML_CHARS_PER_TOKEN);
}

function evaluateDirectmlPromptCompatibility(input = {}) {
  const opts = (input && typeof input === "object") ? input : {};
  const baseChars = Math.max(0, Math.round(Number(opts.totalChars) || 0));
  const extraChars = Math.max(0, Math.round(Number(opts.extraChars) || 0));
  const totalChars = baseChars + extraChars;

  const safePromptLimit = (Number.isFinite(Number(opts.safePromptLimit)) && Number(opts.safePromptLimit) > 0)
    ? Math.round(Number(opts.safePromptLimit))
    : DIRECTML_SAFE_PROMPT_TOKENS;
  const kvContextLimit = (Number.isFinite(Number(opts.kvContextLimit)) && Number(opts.kvContextLimit) > 0)
    ? Math.round(Number(opts.kvContextLimit))
    : DIRECTML_KV_CONTEXT_TOKENS;
  const outputReserveTokens = (Number.isFinite(Number(opts.outputReserveTokens)) && Number(opts.outputReserveTokens) > 0)
    ? Math.round(Number(opts.outputReserveTokens))
    : DIRECTML_OUTPUT_RESERVE_TOKENS;

  const approxPromptTokens = (extraChars === 0 && opts.approxTokens !== undefined && Number.isFinite(Number(opts.approxTokens)) && Number(opts.approxTokens) >= 0)
    ? Math.round(Number(opts.approxTokens))
    : estimateApproxTokens(totalChars);

  const compatible = approxPromptTokens <= safePromptLimit;
  const tightThreshold = Math.floor(safePromptLimit * DIRECTML_TIGHT_WARN_RATIO);
  const status = !compatible ? "incompatible" : (approxPromptTokens >= tightThreshold ? "tight" : "compatible");
  const excessTokens = Math.max(0, approxPromptTokens - safePromptLimit);
  const remainingPromptTokens = Math.max(0, safePromptLimit - approxPromptTokens);
  const utilizationPct = safePromptLimit > 0 ? Math.round((approxPromptTokens / safePromptLimit) * 100) : 0;
  const kvUtilizationPct = kvContextLimit > 0 ? Math.round((approxPromptTokens / kvContextLimit) * 100) : 0;
  const recommendedMaxChars = safePromptLimit * DIRECTML_CHARS_PER_TOKEN;

  const bySection = (opts.bySection && typeof opts.bySection === "object") ? opts.bySection : {};
  let largestSection = null;
  for (const [key, rawLen] of Object.entries(bySection)) {
    const chars = Math.max(0, Math.round(Number(rawLen) || 0));
    if (chars <= 0) continue;
    if (!largestSection || chars > largestSection.chars) {
      largestSection = {
        key,
        label: SECTION_HUMAN_LABELS[key] || key,
        chars,
        approxTokens: estimateApproxTokens(chars)
      };
    }
  }

  const projectName = String(opts.projectName || "General").trim() || "General";
  const isGeneral = Boolean(opts.isGeneral || projectName.toLowerCase() === "general");
  const driverNote = largestSection
    ? ` Mayor peso: ${largestSection.label} (~${largestSection.approxTokens.toLocaleString("en-US")} tokens).`
    : "";

  let reason = `Compatible con DirectML (~${approxPromptTokens.toLocaleString("en-US")} / ${safePromptLimit.toLocaleString("en-US")} tokens seguros; caché KV ${kvContextLimit.toLocaleString("en-US")}).`;
  let recommendation = "";

  if (!compatible) {
    reason = `El proyecto "${projectName}" estima ~${approxPromptTokens.toLocaleString("en-US")} tokens (${totalChars.toLocaleString("en-US")} chars) y supera el límite seguro DirectML de ${safePromptLimit.toLocaleString("en-US")} tokens (caché KV ${kvContextLimit.toLocaleString("en-US")}, +${excessTokens.toLocaleString("en-US")} de exceso -> provoca HTTP 400).${driverNote}`;
    recommendation = isGeneral
      ? "Cambia el motor a Ollama o Free.ai, o recorta el Prompt Maestro / Skill / historial debajo de 6,144 tokens."
      : "Cambia el motor a Ollama o Free.ai para este proyecto, o reduce archivos seleccionados / Prompt Maestro debajo de 6,144 tokens.";
  } else if (status === "tight") {
    reason = `Margen ajustado para DirectML (~${approxPromptTokens.toLocaleString("en-US")} / ${safePromptLimit.toLocaleString("en-US")} tokens; caché KV ${kvContextLimit.toLocaleString("en-US")}).${driverNote}`;
    recommendation = "Queda poco margen antes de HTTP 400; evita chats largos o inyectar más archivos en DirectML.";
  }

  return {
    compatible,
    status,
    projectName,
    isGeneral,
    totalChars,
    baseChars,
    extraChars,
    approxPromptTokens,
    safePromptLimit,
    kvContextLimit,
    outputReserveTokens,
    charsPerToken: DIRECTML_CHARS_PER_TOKEN,
    recommendedMaxChars,
    excessTokens,
    remainingPromptTokens,
    utilizationPct,
    kvUtilizationPct,
    largestSection,
    reason,
    recommendation
  };
}

const IGNORED_DIRS = new Set([
  "Modelos -ai-brains",
  "Modelos-ai-brains",
  "OpenWebUI",
  "Instalaciones",
  "restore-points",
  ".vibecheck",
  "ComfyUI",
  "llama.cpp_backup",
  "node_modules",
  ".git"
]);

const PRIORITY_CODE_DIRS = new Set([
  "src",
  "server",
  "app",
  "api",
  "sidecars",
  "core",
  "lib",
  "services",
  "routes",
  "components",
  "models",
  "tests",
  "scripts"
]);

const LOW_PRIORITY_DIRS = new Set([
  "docs",
  "public",
  "assets",
  "static",
  "media",
  "uploads",
  "logs"
]);

const LOWEST_PRIORITY_DIRS = new Set([
  "biblioteca",
  "backups"
]);

const PRIORITY_ROOT_FILES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "readme.md",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.ts",
  "server.js",
  "index.js",
  "index.ts",
  "main.py",
  "app.py"
]);

function getBaseProjectsDir() {
  const override = process.env.LOCAL_AI_PROJECTS_DIR;
  return (override && String(override).trim()) ? path.resolve(String(override).trim()) : BASE_PROJECTS_DIR;
}

function getBrainDir() {
  const override = process.env.LOCAL_AI_BRAIN_DIR;
  return (override && String(override).trim()) ? path.resolve(String(override).trim()) : BRAIN_DIR;
}

function getConfigFile() {
  const override = process.env.LOCAL_AI_CONFIG_FILE;
  return (override && String(override).trim()) ? path.resolve(String(override).trim()) : CONFIG_FILE;
}

function resolveSafeProjectPath(projectRoot, relPath) {
  if (!projectRoot || typeof projectRoot !== "string" || !relPath || typeof relPath !== "string") {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }
  if (relPath.includes("\0") || projectRoot.includes("\0")) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  const trimmedRel = relPath.trim();
  if (!trimmedRel) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  const rootResolved = path.resolve(projectRoot);
  const candidateResolved = path.resolve(rootResolved, trimmedRel);

  const cmpRoot = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const cmpCandidate = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  const relativePath = path.relative(cmpRoot, cmpCandidate);

  if (!relativePath || relativePath === "." || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  // Verificar symlinks/junctions reales en el ancestro existente más cercano
  try {
    if (fs.existsSync(rootResolved)) {
      const rootReal = fs.realpathSync(rootResolved);
      let probe = candidateResolved;
      while (probe && !fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      if (probe && fs.existsSync(probe)) {
        const probeReal = fs.realpathSync(probe);
        const cmpRootReal = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
        const cmpProbeReal = process.platform === "win32" ? probeReal.toLowerCase() : probeReal;
        const realRel = path.relative(cmpRootReal, cmpProbeReal);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
          return { ok: false, error: "Ruta protegida o fuera del proyecto" };
        }
      }
    }
  } catch (e) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  const cleanRelPath = path.relative(rootResolved, candidateResolved).replace(/\\/g, "/");
  const segments = cleanRelPath.toLowerCase().split("/").filter(Boolean);
  if (segments.length === 0) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  // Bloquear mutación o lectura dentro de .git/
  if (segments.includes(".git")) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  // Bloquear acceso directo a .env y secretos .env.* (permitiendo plantillas .env.example / .sample / .template)
  const baseName = segments[segments.length - 1];
  const isEnvSecret =
    segments[0] === ".env" ||
    baseName === ".env" ||
    (baseName.startsWith(".env.") &&
      !baseName.endsWith(".example") &&
      !baseName.endsWith(".sample") &&
      !baseName.endsWith(".template"));

  if (isEnvSecret) {
    return { ok: false, error: "Ruta protegida o fuera del proyecto" };
  }

  return {
    ok: true,
    fullPath: candidateResolved,
    cleanRelPath
  };
}

function getSidebarHierarchy() {
  try {
    const res = spawnSync("python", [RESOLVER_PY, "--hierarchy"], {
      encoding: "utf-8",
      timeout: 3500
    });
    if (res.stdout) {
      return JSON.parse(res.stdout.trim());
    }
  } catch (e) {
    console.error("[ContextBridge] Error obteniendo jerarquía:", e.message);
  }
  return { pinned: [], projects: [], conversations: [] };
}

function resolveConversationProject(convId = null, token = null) {
  try {
    const args = [RESOLVER_PY];
    if (convId) {
      args.push(convId);
      if (token) args.push(token);
    } else if (token) {
      args.push("--token", token);
    } else {
      args.push("");
    }

    const res = spawnSync("python", args, {
      encoding: "utf-8",
      timeout: 2500
    });
    if (res.stdout) {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && (parsed.projectName || parsed.convId)) {
        return parsed;
      }
    }
  } catch (e) {
    console.error("[ContextBridge] Error resolviendo conversación:", e.message);
  }
  return null;
}

function listProjects() {
  const baseDir = getBaseProjectsDir();
  try {
    if (!fs.existsSync(baseDir)) return [];
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !IGNORED_DIRS.has(d.name))
      .map((d) => {
        const fullPath = path.join(baseDir, d.name);
        try {
          const stat = fs.statSync(fullPath);
          let desc = "";
          const pkgPath = path.join(fullPath, "package.json");
          if (fs.existsSync(pkgPath)) {
            try {
              const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
              desc = pkg.description || (pkg.dependencies ? `Stack: ${Object.keys(pkg.dependencies).slice(0, 4).join(", ")}` : "");
            } catch (e) {}
          }
          return {
            name: d.name,
            path: fullPath,
            mtime: stat.mtime,
            desc
          };
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    console.error("[ContextBridge] Error listing projects:", err);
    return [];
  }
}

function getStoredConfig() {
  const configFile = getConfigFile();
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, "utf-8")) || {};
    }
  } catch (e) {}
  return {};
}

function saveStoredConfig(cfg) {
  const configFile = getConfigFile();
  try {
    const dir = path.dirname(configFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configFile, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
    return true;
  } catch (e) {
    console.error("[ContextBridge] Error guardando config:", e);
    return false;
  }
}

function getStoredActiveProjectName() {
  const cfg = getStoredConfig();
  return cfg.activeProject || null;
}

function setActiveProjectName(name) {
  const cfg = getStoredConfig();
  cfg.activeProject = name;

  let cleanName = typeof name === "string" ? name.trim() : "";
  if (cleanName.startsWith("proj:")) {
    cleanName = cleanName.slice(5).trim();
  }

  if (cfg.explicitFolder) {
    const explicitBase = path.basename(path.resolve(cfg.explicitFolder)).toLowerCase();
    if (!cleanName || cleanName.toLowerCase() !== explicitBase) {
      delete cfg.explicitFolder;
    }
  }

  return saveStoredConfig(cfg);
}

function getExplicitFolder() {
  const cfg = getStoredConfig();
  if (cfg.explicitFolder && fs.existsSync(cfg.explicitFolder)) {
    return cfg.explicitFolder;
  }
  return null;
}

function setExplicitFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return false;
  }
  const cleanPath = path.resolve(folderPath);
  const name = path.basename(cleanPath);
  const cfg = getStoredConfig();
  cfg.explicitFolder = cleanPath;
  cfg.activeProject = name;
  return saveStoredConfig(cfg);
}

function getSelectedFiles(folderPath) {
  if (!folderPath) return [];
  const cfg = getStoredConfig();
  const key = path.resolve(folderPath).toLowerCase();
  if (cfg.selectedFilesMap && Array.isArray(cfg.selectedFilesMap[key])) {
    return cfg.selectedFilesMap[key];
  }
  return [];
}

function setSelectedFiles(folderPath, files) {
  if (!folderPath) return false;
  const cfg = getStoredConfig();
  if (!cfg.selectedFilesMap) cfg.selectedFilesMap = {};
  const key = path.resolve(folderPath).toLowerCase();
  cfg.selectedFilesMap[key] = Array.isArray(files) ? files : [];
  cfg.selectedFiles = cfg.selectedFilesMap[key];
  return saveStoredConfig(cfg);
}

const CODE_EXTENSIONS = new Set([
  ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".json",
  ".md", ".yaml", ".yml", ".sql", ".rs", ".go", ".c", ".cpp", ".h",
  ".sh", ".ps1", ".env.example", ".toml"
]);

function getScanEntryPriority(entry, depth) {
  const lower = entry.name.toLowerCase();
  if (entry.isDirectory()) {
    if (LOWEST_PRIORITY_DIRS.has(lower)) return 4;
    if (PRIORITY_CODE_DIRS.has(lower)) return 0;
    if (LOW_PRIORITY_DIRS.has(lower)) return 3;
    return 1;
  }
  if (depth === 0 && PRIORITY_ROOT_FILES.has(lower)) return 0;
  const ext = path.extname(lower);
  if (CODE_EXTENSIONS.has(ext) || lower === "dockerfile" || lower === "makefile") return 1;
  return 2;
}

function sortDirEntriesByCodePriority(entries, depth) {
  return [...entries].sort((a, b) => {
    const pa = getScanEntryPriority(a, depth);
    const pb = getScanEntryPriority(b, depth);
    if (pa !== pb) return pa - pb;
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

function scanProjectFolderDeep(dir, base = "", depth = 0, maxDepth = 4, maxFiles = 80) {
  const results = [];
  if (depth > maxDepth || !dir || !fs.existsSync(dir)) return results;

  try {
    const rawItems = fs.readdirSync(dir, { withFileTypes: true });
    const items = sortDirEntriesByCodePriority(rawItems, depth);
    for (const item of items) {
      if (results.length >= maxFiles) break;
      if (
        item.name.startsWith(".") ||
        item.name === "node_modules" ||
        item.name === "dist" ||
        item.name === ".venv" ||
        item.name === "__pycache__" ||
        item.name === "build"
      ) {
        continue;
      }

      const relPath = base ? `${base}/${item.name}` : item.name;
      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        const sub = scanProjectFolderDeep(fullPath, relPath, depth + 1, maxDepth, maxFiles - results.length);
        results.push(...sub);
      } else {
        const ext = path.extname(item.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext) || item.name.toLowerCase() === "dockerfile" || item.name.toLowerCase() === "makefile") {
          try {
            const st = fs.statSync(fullPath);
            results.push({
              name: item.name,
              relPath,
              fullPath,
              size: st.size,
              ext
            });
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  return results;
}

function readCodeFilesContext(dirPath, selectedFiles = [], maxChars = 24000) {
  if (!dirPath || !fs.existsSync(dirPath)) return "";

  let targetFiles = Array.isArray(selectedFiles) && selectedFiles.length > 0 ? selectedFiles : [];

  if (targetFiles.length === 0) {
    const scanned = scanProjectFolderDeep(dirPath, "", 0, 3, 40);
    const priorityKeywords = [
      "main.py", "app.py", "server.js", "index.ts", "index.js",
      "package.json", "requirements.txt", "README.md", "vite.config", "tsconfig.json"
    ];
    const prioritized = [];

    for (const kw of priorityKeywords) {
      const match = scanned.find((f) => f.relPath.toLowerCase().endsWith(kw.toLowerCase()));
      if (match && !prioritized.includes(match.relPath)) {
        prioritized.push(match.relPath);
      }
    }

    for (const f of scanned) {
      if (prioritized.length >= 6) break;
      if (!prioritized.includes(f.relPath) && f.size < 50000) {
        prioritized.push(f.relPath);
      }
    }
    targetFiles = prioritized;
  }

  let codeContext = "";
  let totalChars = 0;

  for (const rel of targetFiles) {
    if (totalChars >= maxChars) {
      codeContext += `\n[... Límite de contexto alcanzado. Se omitieron archivos restantes ...]`;
      break;
    }

    const safe = resolveSafeProjectPath(dirPath, rel);
    if (!safe.ok) continue;
    const fullPath = safe.fullPath;
    if (!fs.existsSync(fullPath)) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      if (stat.size > 200000) {
        codeContext += `\n=== Archivo: ${safe.cleanRelPath} (${(stat.size / 1024).toFixed(1)} KB) ===\n[Archivo demasiado grande para inyectar completo]\n`;
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const budgetRemaining = maxChars - totalChars;
      const snippet = content.length > budgetRemaining
        ? content.slice(0, budgetRemaining) + "\n[... Contenido truncado por límite de contexto ...]"
        : content;

      codeContext += `\n=== Archivo: ${safe.cleanRelPath} ===\n\`\`\`\n${snippet}\n\`\`\`\n`;
      totalChars += snippet.length;
    } catch (e) {}
  }

  return codeContext;
}

function getActiveProject(preferredName = null, convId = null, token = null) {
  const baseDir = getBaseProjectsDir();

  const looksLikeExplicitPath =
    preferredName &&
    typeof preferredName === "string" &&
    (preferredName.includes("\\") || preferredName.includes("/") || /^[a-zA-Z]:/.test(preferredName));

  const explicit = getExplicitFolder();
  if (explicit && fs.existsSync(explicit)) {
    const matchesExplicitPath = looksLikeExplicitPath && path.resolve(preferredName).toLowerCase() === path.resolve(explicit).toLowerCase();
    if (!preferredName || preferredName === "explicit" || preferredName === path.basename(explicit) || matchesExplicitPath) {
      const projName = path.basename(explicit);
      return {
        name: projName,
        path: explicit,
        isGeneral: false,
        isExplicit: true,
        mtime: fs.statSync(explicit).mtime
      };
    }
  }

  if (looksLikeExplicitPath && preferredName.toLowerCase() !== "general") {
    try {
      const resolvedPref = path.resolve(preferredName);
      if (fs.existsSync(resolvedPref) && fs.statSync(resolvedPref).isDirectory()) {
        return {
          name: path.basename(resolvedPref),
          path: resolvedPref,
          isGeneral: false,
          isExplicit: true,
          mtime: fs.statSync(resolvedPref).mtime
        };
      }
    } catch (e) {}
  }

  const projects = listProjects();

  let targetConvId = convId;
  let targetProjName = preferredName;

  if (preferredName && typeof preferredName === "string") {
    if (preferredName.startsWith("conv:")) {
      targetConvId = preferredName.slice(5).trim();
      targetProjName = null;
    } else if (preferredName.startsWith("proj:")) {
      targetProjName = preferredName.slice(5).trim();
    }
  }

  // 1. Si se pasa un nombre de proyecto preferido explícito (prioridad sobre convId)
  if (targetProjName) {
    if (targetProjName.toLowerCase() === "general") {
      return { name: "General", path: baseDir, convId: targetConvId || undefined, isGeneral: true, mtime: new Date() };
    }
    const found = projects.find((p) => p.name.toLowerCase() === targetProjName.toLowerCase());
    if (found) return { ...found, convId: targetConvId || undefined, isGeneral: false };
    const customPath = path.join(baseDir, targetProjName);
    if (fs.existsSync(customPath)) {
      return { name: targetProjName, path: customPath, convId: targetConvId || undefined, isGeneral: false, mtime: new Date() };
    }
  }

  // 2. Si viene un ID de conversación específica o token (cuando no se forzó proyecto explícito)
  if (targetConvId || token) {
    const resolved = resolveConversationProject(targetConvId, token);
    if (resolved && resolved.projectName) {
      if (resolved.isGeneral || resolved.projectName === "General") {
        return {
          name: resolved.title || "General",
          path: baseDir,
          convId: resolved.convId || targetConvId,
          isGeneral: true,
          mtime: new Date()
        };
      }
      const found = projects.find((p) => p.name.toLowerCase() === resolved.projectName.toLowerCase());
      if (found) return { ...found, convId: resolved.convId, isGeneral: false };
      if (resolved.projectPath && fs.existsSync(resolved.projectPath)) {
        return { name: resolved.projectName, path: resolved.projectPath, convId: resolved.convId, isGeneral: false, mtime: new Date() };
      }
    }
  }

  const stored = getStoredActiveProjectName();
  if (stored) {
    if (stored.toLowerCase() === "general") {
      return { name: "General", path: baseDir, isGeneral: true, mtime: new Date() };
    }
    const found = projects.find((p) => p.name.toLowerCase() === stored.toLowerCase());
    if (found) return { ...found, isGeneral: false };
  }

  return { name: "General", path: baseDir, isGeneral: true, mtime: new Date() };
}

function scanProjectFiles(dir, base = "", depth = 0, maxDepth = 2, maxFiles = 45) {
  const results = [];
  if (depth > maxDepth || !dir || !fs.existsSync(dir)) return results;

  try {
    const rawItems = fs.readdirSync(dir, { withFileTypes: true });
    const items = sortDirEntriesByCodePriority(rawItems, depth);
    for (const item of items) {
      if (results.length >= maxFiles) break;
      if (
        item.name.startsWith(".") ||
        item.name === "node_modules" ||
        item.name === "dist" ||
        item.name === ".venv" ||
        item.name === "__pycache__"
      ) {
        continue;
      }

      const relPath = base ? `${base}/${item.name}` : item.name;
      if (item.isDirectory()) {
        results.push(relPath + "/");
        if (results.length >= maxFiles) break;
        const sub = scanProjectFiles(path.join(dir, item.name), relPath, depth + 1, maxDepth, maxFiles - results.length);
        results.push(...sub);
      } else {
        results.push(relPath);
      }
    }
  } catch (e) {}

  return results;
}

function getConversationHistory(convId = null) {
  const brainDir = getBrainDir();
  try {
    let transcriptFile = null;

    if (convId) {
      const p = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(p)) transcriptFile = p;
    }

    if (!transcriptFile && fs.existsSync(brainDir)) {
      const convs = fs.readdirSync(brainDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "tempmediaStorage")
        .map((d) => {
          const t = path.join(brainDir, d.name, ".system_generated", "logs", "transcript.jsonl");
          if (fs.existsSync(t)) {
            return { id: d.name, mtime: fs.statSync(t).mtime, path: t };
          }
          return null;
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);

      if (convs.length > 0) transcriptFile = convs[0].path;
    }

    if (!transcriptFile || !fs.existsSync(transcriptFile)) return [];

    const lines = fs.readFileSync(transcriptFile, "utf-8").trim().split("\n");
    const userPrompts = [];
    for (const l of lines) {
      try {
        const item = JSON.parse(l);
        if (item.type === "USER_INPUT" && item.content) {
          const clean = item.content.replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "").trim();
          if (clean && clean.length > 5) userPrompts.push(clean);
        }
      } catch (e) {}
    }
    return userPrompts.slice(-4);
  } catch (e) {
    return [];
  }
}

function readCleanProgressTail(progressFile, maxChars = 1200) {
  if (!fs.existsSync(progressFile)) return "";
  try {
    const raw = fs.readFileSync(progressFile, "utf-8");
    if (raw.length <= maxChars) return raw.trim();
    const tail = raw.slice(raw.length - maxChars);
    const marker = tail.indexOf("\n## [");
    if (marker !== -1) {
      return tail.slice(marker + 1).trim();
    }
    if (tail.startsWith("## [")) return tail.trim();
    const nextNl = tail.indexOf("\n");
    return (nextNl !== -1 ? tail.slice(nextNl + 1) : tail).trim();
  } catch (e) {
    return "";
  }
}

function buildStateSummarySection(proj, projectState, recentChanges) {
  const parts = [];
  if (projectState) {
    const syncParts = [];
    if (projectState.githubToggle || projectState.githubRepo) {
      syncParts.push(`GitHub=${projectState.githubToggle ? "ON" : "OFF"}${projectState.githubRepo ? ` (${projectState.githubRepo})` : ""}`);
    }
    if (projectState.netlifyToggle || projectState.netlifySite) {
      syncParts.push(`Netlify=${projectState.netlifyToggle ? "ON" : "OFF"}${projectState.netlifySite ? ` (${projectState.netlifySite})` : ""}`);
    }
    if (projectState.lastSessionId) {
      syncParts.push(`Última Sesión=${projectState.lastSessionId}`);
    }
    if (syncParts.length > 0) {
      parts.push(`- Integraciones y Sesión: ${syncParts.join(" | ")}`);
    }
    if (projectState.lastContextAnalysis && typeof projectState.lastContextAnalysis === "object") {
      const summary = projectState.lastContextAnalysis.summary || projectState.lastContextAnalysis.digest || "";
      if (summary) {
        parts.push(`- Último Análisis Profundo (${projectState.lastContextAnalysis.timestamp || "reciente"}):\n${String(summary).slice(0, 600)}`);
      }
    }
  }

  if (Array.isArray(recentChanges) && recentChanges.length > 0) {
    const changeLines = recentChanges.map((c) =>
      `  • [${c.action}] ${c.relPath || c.summary} (${c.model || "Local"}, ${c.timestamp || ""})`
    );
    parts.push(`- Últimos Cambios Persistidos:\n${changeLines.join("\n")}`);
  }

  if (parts.length === 0) return "";
  return `<estado_continuacion_proyecto proyecto="${proj.name}">\n${parts.join("\n")}\n</estado_continuacion_proyecto>`;
}

function buildMutationDirectivesSection() {
  return `DIRECTIVAS Y CAPACIDADES DE MUTACIÓN DE CÓDIGO (CREAR Y EDITAR ARCHIVOS):
Tienes permisos activos de lectura y escritura en el proyecto para crear nuevos archivos o modificar archivos existentes según la etapa o punto de avance actual.

1. CREAR NUEVO ARCHIVO O REESCRIBIR COMPLETO:
Usa estrictamente el formato de bloque con 'write:ruta/relativa' o 'create:ruta/relativa'.
Ejemplo:
\`\`\`write:src/services/api_client.py
# Código completo del archivo nuevo o actualizado
import requests

def fetch_data():
    return {}
\`\`\`

2. MODIFICAR/EDITAR QUIRÚRGICAMENTE UN ARCHIVO EXISTENTE (PATCH):
Para modificar únicamente una sección o función específica sin reescribir todo el archivo, usa 'patch:ruta/relativa' con bloques SEARCH y REPLACE:
\`\`\`patch:src/services/api_client.py
<<< SEARCH
def fetch_data():
    return {}
===
def fetch_data():
    response = requests.get("https://api.example.com")
    return response.json()
>>> REPLACE
\`\`\`

3. REGLAS DE EJECUCIÓN:
- Utiliza la arquitectura y código provisto en <codigo_fuente_del_proyecto> para adaptar tus cambios al avance exacto.
- La interfaz de Local AI Studio procesará estos bloques automáticamente para que el usuario pueda aplicarlos al disco con un clic o en modo auto-aplicación directa.
- Siempre responde con explicaciones técnicas concisas en español.`;
}

function buildProjectContext(projectName = null, convId = null, token = null, options = {}) {
  const opts = (options && typeof options === "object") ? options : {};
  const writeToDisk = opts.writeToDisk === true;
  const skillId = opts.skillId || null;
  const profileId = opts.profileId || null;
  const customSystemPrompt = opts.customSystemPrompt || null;
  const includeMasterPrompt = opts.includeMasterPrompt !== false;
  const modelOverridesPrompt = opts.modelOverridesPrompt || null;

  let targetConvId = convId;
  let targetProjName = projectName;

  if (projectName && typeof projectName === "string") {
    if (projectName.startsWith("conv:")) {
      targetConvId = projectName.slice(5).trim();
      targetProjName = null;
    } else if (projectName.startsWith("proj:")) {
      targetProjName = projectName.slice(5).trim();
    }
  }

  const proj = getActiveProject(targetProjName, targetConvId, token);
  if (!proj) return null;

  const isGen = Boolean(proj.isGeneral || String(proj.name || "").toLowerCase() === "general");
  const projectPath = proj.path;

  let files = [];
  let packageInfo = null;
  let readmeSnippet = "";
  let pastProgress = "";
  let selectedFiles = [];
  let codeSnippets = "";

  const convInfo = (targetConvId || token) ? resolveConversationProject(targetConvId, token) : null;
  const recentPrompts = getConversationHistory(targetConvId);

  if (isGen) {
    // Modo General ligero: no caminar los repositorios ni leer archivos de código
    files = listProjects()
      .filter((p) => p && !p.isGeneral && String(p.name || "").toLowerCase() !== "general")
      .slice(0, 15)
      .map((p) => `${p.name}/`);
  } else {
    files = scanProjectFiles(projectPath);

    const pkgFile = path.join(projectPath, "package.json");
    if (fs.existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf-8"));
        packageInfo = {
          name: pkg.name || proj.name,
          version: pkg.version || "1.0.0",
          scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
          dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
          devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : []
        };
      } catch (e) {}
    }

    const readmeFile = path.join(projectPath, "README.md");
    if (fs.existsSync(readmeFile)) {
      try {
        readmeSnippet = fs.readFileSync(readmeFile, "utf-8").slice(0, 800);
      } catch (e) {}
    }

    const progressFile = path.join(projectPath, "AVANCES_LOCAL_AI.md");
    pastProgress = readCleanProgressTail(progressFile, 1200);

    selectedFiles = Array.isArray(opts.selectedFiles) ? opts.selectedFiles : getSelectedFiles(projectPath);
    codeSnippets = readCodeFilesContext(projectPath, selectedFiles, 24000);
  }

  // 1. Master Prompt (+ overrides de modelo y sesión)
  const masterParts = [];
  if (includeMasterPrompt) {
    const masterCfg = memoryStore.getMasterPromptConfig(proj.name);
    if (masterCfg && masterCfg.effectivePrompt) {
      masterParts.push(masterCfg.effectivePrompt.trim());
    }
  }
  if (modelOverridesPrompt && String(modelOverridesPrompt).trim()) {
    masterParts.push(`### Directivas del Modelo Activo:\n${String(modelOverridesPrompt).trim()}`);
  }
  if (customSystemPrompt && String(customSystemPrompt).trim()) {
    masterParts.push(`### Override de Sesión:\n${String(customSystemPrompt).trim()}`);
  }
  const masterPromptSection = masterParts.join("\n\n");

  // 2. Perfil / Skill (Perfil > Skill)
  const skillPromptSection = (skillId || profileId)
    ? skillsBridge.buildSkillSystemPrompt(skillId, profileId).trim()
    : "";

  // 3. Estado persistido de continuación
  const stateKey = isGen ? "General" : (projectPath || proj.name);
  const projectState = memoryStore.getProjectState(stateKey);
  const recentChanges = memoryStore.listChanges(proj.name, 5);
  const stateSummarySection = buildStateSummarySection(proj, projectState, recentChanges);

  // 4. Contexto del Proyecto XML
  const promptsForContext = isGen ? recentPrompts.slice(-2) : recentPrompts;
  const projectContextXml = isGen
    ? `Eres el asistente de IA local y extensión de Antigravity para el Entorno General de Trabajo.

<contexto_del_proyecto>
- Entorno: General
- Directorio Base: ${projectPath}
${convInfo && convInfo.title ? `- Sesión de Antigravity: "${String(convInfo.title).slice(0, 80)}"` : ""}
- Proyectos Principales Disponibles (${files.length}):
${files.length ? files.map((f) => `  • ${f}`).join("\n") : "  • (Ninguno detectado)"}
${promptsForContext.length ? `\n- Tareas recientes en Antigravity:\n${promptsForContext.map((p) => `  > "${p.slice(0, 100)}"`).join("\n")}` : ""}
</contexto_del_proyecto>`
    : `Eres el asistente de IA local y extensión de Antigravity para el proyecto "${proj.name}".

<contexto_del_proyecto>
- Entorno: ${proj.name}
- Directorio de Trabajo: ${projectPath}
${convInfo && convInfo.title ? `- Sesión de Antigravity: "${convInfo.title}"` : ""}
${packageInfo ? `- Scripts disponibles: ${packageInfo.scripts.join(", ")}
- Dependencias clave: ${packageInfo.dependencies.slice(0, 10).join(", ")}` : ""}
- Archivos en el Espacio de Trabajo:
${files.slice(0, 35).map((f) => `  • ${f}`).join("\n")}
${readmeSnippet ? `\n- Descripción / README:\n${readmeSnippet.slice(0, 300)}...` : ""}
${recentPrompts.length ? `\n- Tareas recientes abordadas en Antigravity:\n${recentPrompts.map((p) => `  > "${p.slice(0, 120)}"`).join("\n")}` : ""}
${pastProgress ? `\n- Últimos avances registrados por IA local:\n${pastProgress}` : ""}
</contexto_del_proyecto>`;

  // 5. Código Fuente XML
  const codeContextXml = `<codigo_fuente_del_proyecto>
${isGen ? "Modo General activo: no se escanean repositorios ni código fuente. Selecciona un proyecto específico si necesitas editar archivos." : (codeSnippets || "No se han seleccionado archivos de código fuente específicos aún.")}
</codigo_fuente_del_proyecto>`;

  // 6. Directivas de Mutación
  const mutationDirectives = buildMutationDirectivesSection();

  const sections = {
    masterPrompt: masterPromptSection,
    skillPrompt: skillPromptSection,
    stateSummary: stateSummarySection,
    projectContextXml,
    codeContextXml,
    mutationDirectives
  };

  // Orden estricto: Master Prompt (+ override sesión) -> Perfil/Skill -> Estado persistido -> Contexto -> Código -> Directivas Mutación
  const orderedBlocks = [
    sections.masterPrompt,
    sections.skillPrompt,
    sections.stateSummary,
    sections.projectContextXml,
    sections.codeContextXml,
    sections.mutationDirectives
  ].filter((s) => typeof s === "string" && s.trim().length > 0);

  const systemPrompt = orderedBlocks.join("\n\n");

  const bySection = {
    masterPrompt: sections.masterPrompt.length,
    skillPrompt: sections.skillPrompt.length,
    stateSummary: sections.stateSummary.length,
    projectContextXml: sections.projectContextXml.length,
    codeContextXml: sections.codeContextXml.length,
    mutationDirectives: sections.mutationDirectives.length
  };
  const totalChars = systemPrompt.length;
  const metrics = {
    totalChars,
    approxTokens: estimateApproxTokens(totalChars),
    bySection
  };
  const directmlCompatibility = evaluateDirectmlPromptCompatibility({
    totalChars,
    approxTokens: metrics.approxTokens,
    bySection,
    projectName: proj.name,
    isGeneral: isGen
  });

  const summaryMarkdown = `# Contexto del Proyecto: ${proj.name}
> Sincronizado automáticamente desde Antigravity

- **Ruta de Trabajo:** \`${projectPath}\`
- **Última Modificación:** ${proj.mtime ? new Date(proj.mtime).toLocaleString() : new Date().toLocaleString()}
${convInfo && convInfo.title ? `- **Sesión Vinculada:** ${convInfo.title}` : ""}
${packageInfo ? `- **Dependencias:** ${packageInfo.dependencies.slice(0, 10).join(", ")}` : ""}
${selectedFiles && selectedFiles.length ? `- **Archivos de Código Inyectados:** ${selectedFiles.join(", ")}` : ""}

### Archivos Principales:
\`\`\`
${files.slice(0, 30).join("\n")}
\`\`\`

### Estado y Continuidad:
Este agente tiene visibilidad completa del código y la sesión activa en Antigravity para continuar el avance sin interrupciones.
`;

  if (writeToDisk) {
    try {
      const ctxOut = path.join(projectPath, "PROJECT_CONTEXT.md");
      fs.writeFileSync(ctxOut, summaryMarkdown, "utf-8");

      const owuDir = "C:\\antigravityAS\\OpenWebUI\\data";
      if (fs.existsSync(owuDir)) {
        fs.writeFileSync(path.join(owuDir, "PROJECT_CONTEXT_CURRENT.md"), summaryMarkdown, "utf-8");
      }
    } catch (e) {}
  }

  return {
    project: proj,
    files,
    selectedFiles,
    codeSnippets,
    packageInfo,
    recentPrompts,
    sections,
    metrics,
    directmlCompatibility,
    projectState,
    systemPrompt,
    summaryMarkdown,
    conversationTitle: convInfo ? convInfo.title : ""
  };
}

function recordProjectProgress(projectName, entry) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return false;

    const progressFile = path.join(proj.path, "AVANCES_LOCAL_AI.md");
    const timestamp = new Date().toLocaleString();
    const logEntry = `\n## [${timestamp}] - Sesión Local AI (${entry.tool || "Local AI Studio"})
- **Modelo:** ${entry.model || "Local"}
- **Tarea / Consulta:** ${entry.task || "Consulta de código"}
- **Resumen:** ${entry.summary ? entry.summary.slice(0, 300) : "Actualización de proyecto"}
${entry.filesModified && entry.filesModified.length ? `- **Archivos Modificados:** ${entry.filesModified.join(", ")}` : ""}
────────────────────────────────────────────────────────────\n`;

    fs.appendFileSync(progressFile, logEntry, "utf-8");
    return true;
  } catch (e) {
    console.error("[ContextBridge] Error guardando progreso:", e);
    return false;
  }
}

function saveProjectFile(projectName, relPath, content, meta = {}) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const safe = resolveSafeProjectPath(proj.path, relPath);
    if (!safe.ok) return safe;

    const existed = fs.existsSync(safe.fullPath);
    const backupPath = memoryStore.backupFileBeforeWrite(proj.name, safe.cleanRelPath, safe.fullPath);

    const parentDir = path.dirname(safe.fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const textContent = typeof content === "string" ? content : String(content ?? "");
    fs.writeFileSync(safe.fullPath, textContent, "utf-8");
    const sizeBytes = Buffer.byteLength(textContent, "utf-8");

    memoryStore.recordChange({
      project: proj.name,
      projectPath: proj.path,
      relPath: safe.cleanRelPath,
      action: existed ? "write" : "create",
      sizeBytes,
      model: meta.model || "Local",
      source: meta.source || "local-ai-studio",
      backupPath,
      summary: meta.summary || `Archivo ${safe.cleanRelPath} guardado desde Local AI (${sizeBytes} bytes)`
    });

    recordProjectProgress(proj.name, {
      tool: meta.tool || "Guardado Directo de Archivo",
      model: meta.model || "Local",
      task: `Actualización de ${safe.cleanRelPath}`,
      summary: `Archivo ${safe.cleanRelPath} guardado desde Local AI (${sizeBytes} bytes)`,
      filesModified: [safe.cleanRelPath]
    });

    return {
      ok: true,
      path: safe.fullPath,
      relPath: safe.cleanRelPath,
      size: sizeBytes,
      backupPath
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function readProjectFile(projectName, relPath) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const safe = resolveSafeProjectPath(proj.path, relPath);
    if (!safe.ok) return safe;

    if (!fs.existsSync(safe.fullPath)) {
      return { ok: false, error: `El archivo ${safe.cleanRelPath} no existe en el proyecto.` };
    }
    const content = fs.readFileSync(safe.fullPath, "utf-8");
    const st = fs.statSync(safe.fullPath);
    return {
      ok: true,
      path: safe.fullPath,
      relPath: safe.cleanRelPath,
      content,
      size: st.size,
      mtime: st.mtime
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function findLineSpanMatch(fileLines, normSearch) {
  const searchLinesRaw = normSearch.split("\n").map((l) => l.trim());
  while (searchLinesRaw.length > 0 && searchLinesRaw[0] === "") searchLinesRaw.shift();
  while (searchLinesRaw.length > 0 && searchLinesRaw[searchLinesRaw.length - 1] === "") searchLinesRaw.pop();
  if (searchLinesRaw.length === 0) return null;

  // Paso 1: coincidencia exacta línea-a-línea (conservando líneas en blanco internas del bloque SEARCH)
  for (let i = 0; i <= fileLines.length - searchLinesRaw.length; i++) {
    let allMatch = true;
    for (let j = 0; j < searchLinesRaw.length; j++) {
      if (fileLines[i + j].trim() !== searchLinesRaw[j]) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) {
      return { start: i, end: i + searchLinesRaw.length - 1 };
    }
  }

  // Paso 2: coincidencia tolerante a líneas en blanco, preservando exactamente el índice final real en fileLines
  const searchNonEmpty = searchLinesRaw.filter(Boolean);
  if (searchNonEmpty.length === 0) return null;

  for (let i = 0; i < fileLines.length; i++) {
    if (fileLines[i].trim() !== searchNonEmpty[0]) continue;
    let fi = i;
    let si = 0;
    let endIdx = i;

    while (fi < fileLines.length && si < searchNonEmpty.length) {
      const fTrim = fileLines[fi].trim();
      if (si > 0 && fTrim === "") {
        fi++;
        continue;
      }
      if (fTrim === searchNonEmpty[si]) {
        endIdx = fi;
        si++;
        fi++;
      } else {
        break;
      }
    }

    if (si === searchNonEmpty.length) {
      return { start: i, end: endIdx };
    }
  }

  return null;
}

function applyProjectPatch(projectName, relPath, searchBlock, replaceBlock, meta = {}) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const safe = resolveSafeProjectPath(proj.path, relPath);
    if (!safe.ok) return safe;

    if (!fs.existsSync(safe.fullPath)) {
      return {
        ok: false,
        error: `El archivo ${safe.cleanRelPath} no existe para aplicar parche. Considera usar write:${safe.cleanRelPath} para crearlo.`
      };
    }

    const rawFile = fs.readFileSync(safe.fullPath, "utf-8");
    const hadCRLF = /\r\n/.test(rawFile);
    const normFile = rawFile.replace(/\r\n/g, "\n");
    const normSearchRaw = String(searchBlock ?? "").replace(/\r\n/g, "\n");
    const normSearchTrimmed = normSearchRaw.trim();
    const normReplace = String(replaceBlock ?? "").replace(/\r\n/g, "\n");

    if (!normSearchTrimmed) {
      return { ok: false, error: "El bloque SEARCH está vacío." };
    }

    let updatedNorm = null;

    const exactRawIdx = normFile.indexOf(normSearchRaw);
    if (exactRawIdx !== -1) {
      updatedNorm = normFile.slice(0, exactRawIdx) + normReplace + normFile.slice(exactRawIdx + normSearchRaw.length);
    } else {
      const exactTrimIdx = normFile.indexOf(normSearchTrimmed);
      if (exactTrimIdx !== -1) {
        updatedNorm = normFile.slice(0, exactTrimIdx) + normReplace + normFile.slice(exactTrimIdx + normSearchTrimmed.length);
      } else {
        const fileLines = normFile.split("\n");
        const span = findLineSpanMatch(fileLines, normSearchTrimmed);
        if (!span) {
          return { ok: false, error: `No se encontró el bloque a reemplazar (SEARCH) en ${safe.cleanRelPath}.` };
        }
        const spanLength = span.end - span.start + 1;
        const replacementLines = normReplace.split("\n");
        fileLines.splice(span.start, spanLength, ...replacementLines);
        updatedNorm = fileLines.join("\n");
      }
    }

    const finalContent = hadCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;

    const backupPath = memoryStore.backupFileBeforeWrite(proj.name, safe.cleanRelPath, safe.fullPath);
    fs.writeFileSync(safe.fullPath, finalContent, "utf-8");
    const sizeBytes = Buffer.byteLength(finalContent, "utf-8");

    memoryStore.recordChange({
      project: proj.name,
      projectPath: proj.path,
      relPath: safe.cleanRelPath,
      action: "patch",
      sizeBytes,
      model: meta.model || "Local",
      source: meta.source || "local-ai-studio",
      backupPath,
      summary: meta.summary || `Parche quirúrgico aplicado en ${safe.cleanRelPath} (${sizeBytes} bytes)`
    });

    recordProjectProgress(proj.name, {
      tool: meta.tool || "Edición Quirúrgica (Patch)",
      model: meta.model || "Local",
      task: `Modificación de ${safe.cleanRelPath}`,
      summary: `Bloque de código modificado exitosamente en ${safe.cleanRelPath} (${sizeBytes} bytes)`,
      filesModified: [safe.cleanRelPath]
    });

    return {
      ok: true,
      path: safe.fullPath,
      relPath: safe.cleanRelPath,
      size: sizeBytes,
      backupPath
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  DIRECTML_KV_CONTEXT_TOKENS,
  DIRECTML_SAFE_PROMPT_TOKENS,
  DIRECTML_OUTPUT_RESERVE_TOKENS,
  DIRECTML_CHARS_PER_TOKEN,
  DIRECTML_TIGHT_WARN_RATIO,
  estimateApproxTokens,
  evaluateDirectmlPromptCompatibility,
  resolveSafeProjectPath,
  getSidebarHierarchy,
  listProjects,
  getActiveProject,
  setActiveProjectName,
  getExplicitFolder,
  setExplicitFolder,
  scanProjectFiles,
  scanProjectFolderDeep,
  getSelectedFiles,
  setSelectedFiles,
  readCodeFilesContext,
  buildProjectContext,
  recordProjectProgress,
  saveProjectFile,
  readProjectFile,
  applyProjectPatch
};
