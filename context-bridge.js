const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
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

  // Bloquear rutas absolutas de cualquier SO (C:\\..., \\UNC, /etc/...) aunque el host sea otro
  if (/^[a-zA-Z]:[\\/]/.test(trimmedRel) || trimmedRel.startsWith("/") || trimmedRel.startsWith("\\\\")) {
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

const SAFE_DOTFILES = new Set([
  ".gitignore",
  ".env.example",
  ".env.sample",
  ".env.template",
  ".eslintrc.json",
  ".prettierrc"
]);

function getScanEntryPriority(entry, depth) {
  const lower = entry.name.toLowerCase();
  if (entry.isDirectory()) {
    if (LOWEST_PRIORITY_DIRS.has(lower)) return 4;
    if (PRIORITY_CODE_DIRS.has(lower)) return 0;
    if (LOW_PRIORITY_DIRS.has(lower)) return 3;
    return 1;
  }
  if (depth === 0 && (PRIORITY_ROOT_FILES.has(lower) || SAFE_DOTFILES.has(lower))) return 0;
  const ext = path.extname(lower);
  if (CODE_EXTENSIONS.has(ext) || SAFE_DOTFILES.has(lower) || lower === "dockerfile" || lower === "makefile") return 1;
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
      const lowerName = item.name.toLowerCase();
      const isAllowedDotfile = !item.isDirectory() && SAFE_DOTFILES.has(lowerName);
      if (
        (item.name.startsWith(".") && !isAllowedDotfile) ||
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
        if (
          CODE_EXTENSIONS.has(ext) ||
          isAllowedDotfile ||
          lowerName === "dockerfile" ||
          lowerName === "makefile"
        ) {
          try {
            const st = fs.statSync(fullPath);
            results.push({
              name: item.name,
              relPath,
              fullPath,
              size: st.size,
              ext: ext || lowerName
            });
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  return results;
}

function readCodeFilesContext(dirPath, selectedFiles = [], maxChars = 24000, options = {}) {
  if (!dirPath || !fs.existsSync(dirPath)) return "";

  const opts = (options && typeof options === "object") ? options : {};
  const mentionedList = Array.isArray(opts.mentionedFiles) ? opts.mentionedFiles : [];
  const pinnedList = Array.isArray(opts.pinnedFiles) ? opts.pinnedFiles : [];
  const selectedList = Array.isArray(selectedFiles) ? selectedFiles : [];

  const mergedOrdered = [];
  const seenRel = new Set();
  for (const candidate of [...mentionedList, ...pinnedList, ...selectedList]) {
    const clean = String(candidate || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seenRel.has(key)) continue;
    seenRel.add(key);
    mergedOrdered.push(clean);
  }

  let targetFiles = mergedOrdered;

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
      const lowerName = item.name.toLowerCase();
      const isAllowedDotfile = !item.isDirectory() && SAFE_DOTFILES.has(lowerName);
      if (
        (item.name.startsWith(".") && !isAllowedDotfile) ||
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
  const skillId = opts.skillIds || opts.skillId || null;
  const profileId = opts.profileId || null;
  const customSystemPrompt = opts.customSystemPrompt || null;
  const includeMasterPrompt = opts.includeMasterPrompt !== false;
  const modelOverridesPrompt = opts.modelOverridesPrompt || null;
  const mentionedFiles = Array.isArray(opts.mentionedFiles) ? opts.mentionedFiles : [];

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

  const stateKey = isGen ? "General" : (projectPath || proj.name);
  const projectState = memoryStore.getProjectState(stateKey);
  const pinnedFiles = Array.isArray(opts.pinnedFiles)
    ? opts.pinnedFiles
    : (Array.isArray(projectState.pinnedFiles) ? projectState.pinnedFiles : []);

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
    codeSnippets = readCodeFilesContext(projectPath, selectedFiles, 24000, {
      pinnedFiles,
      mentionedFiles
    });
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

    const changeRec = memoryStore.recordChange({
      project: proj.name,
      projectPath: proj.path,
      relPath: safe.cleanRelPath,
      action: existed ? "write" : "create",
      sizeBytes,
      model: meta.model || "Local",
      source: meta.source || "local-ai-studio",
      backupPath,
      batchId: meta.batchId || null,
      existedBefore: existed,
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
      backupPath,
      changeId: changeRec.id
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

function computePatchedFileContent(rawFile, searchBlock, replaceBlock, cleanRelPath = "file") {
  const hadCRLF = /\r\n/.test(rawFile);
  const normFile = String(rawFile ?? "").replace(/\r\n/g, "\n");
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
        return { ok: false, error: `No se encontró el bloque a reemplazar (SEARCH) en ${cleanRelPath}.` };
      }
      const spanLength = span.end - span.start + 1;
      const replacementLines = normReplace.split("\n");
      fileLines.splice(span.start, spanLength, ...replacementLines);
      updatedNorm = fileLines.join("\n");
    }
  }

  const finalContent = hadCRLF ? updatedNorm.replace(/\n/g, "\r\n") : updatedNorm;
  return { ok: true, finalContent, hadCRLF };
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
    const patchCalc = computePatchedFileContent(rawFile, searchBlock, replaceBlock, safe.cleanRelPath);
    if (!patchCalc.ok) return patchCalc;

    const finalContent = patchCalc.finalContent;
    const backupPath = memoryStore.backupFileBeforeWrite(proj.name, safe.cleanRelPath, safe.fullPath);
    fs.writeFileSync(safe.fullPath, finalContent, "utf-8");
    const sizeBytes = Buffer.byteLength(finalContent, "utf-8");

    const changeRec = memoryStore.recordChange({
      project: proj.name,
      projectPath: proj.path,
      relPath: safe.cleanRelPath,
      action: "patch",
      sizeBytes,
      model: meta.model || "Local",
      source: meta.source || "local-ai-studio",
      backupPath,
      batchId: meta.batchId || null,
      existedBefore: true,
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
      backupPath,
      changeId: changeRec.id
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ==========================================
// FASE 1: DIFF PREVIEW, BATCH TRANSACCIONAL Y ROLLBACK
// ==========================================

function computeUnifiedDiff(oldText, newText, relPath = "file") {
  const normOld = String(oldText ?? "").replace(/\r\n/g, "\n");
  const normNew = String(newText ?? "").replace(/\r\n/g, "\n");

  const oldLines = normOld === "" ? [] : normOld.split("\n");
  const newLines = normNew === "" ? [] : normNew.split("\n");

  const ops = [];
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = oldLines.length - 1;
  let endNew = newLines.length - 1;
  while (endOld >= start && endNew >= start && oldLines[endOld] === newLines[endNew]) {
    endOld--;
    endNew--;
  }

  for (let i = 0; i < start; i++) {
    ops.push({ type: "equal", text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  const midOld = oldLines.slice(start, endOld + 1);
  const midNew = newLines.slice(start, endNew + 1);
  const M = midOld.length;
  const N = midNew.length;

  if (M === 0 && N === 0) {
    // Sin cambios en el bloque medio
  } else if (M * N <= 900000) {
    const dp = new Int32Array((M + 1) * (N + 1));
    const width = N + 1;
    for (let i = M - 1; i >= 0; i--) {
      for (let j = N - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * width + j] = dp[(i + 1) * width + (j + 1)] + 1;
        } else {
          const down = dp[(i + 1) * width + j];
          const right = dp[i * width + (j + 1)];
          dp[i * width + j] = down >= right ? down : right;
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < M && j < N) {
      if (midOld[i] === midNew[j]) {
        ops.push({ type: "equal", text: midOld[i], oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        ops.push({ type: "remove", text: midOld[i], oldLine: start + i + 1, newLine: null });
        i++;
      } else {
        ops.push({ type: "add", text: midNew[j], oldLine: null, newLine: start + j + 1 });
        j++;
      }
    }
    while (i < M) {
      ops.push({ type: "remove", text: midOld[i], oldLine: start + i + 1, newLine: null });
      i++;
    }
    while (j < N) {
      ops.push({ type: "add", text: midNew[j], oldLine: null, newLine: start + j + 1 });
      j++;
    }
  } else {
    for (let i = 0; i < M; i++) {
      ops.push({ type: "remove", text: midOld[i], oldLine: start + i + 1, newLine: null });
    }
    for (let j = 0; j < N; j++) {
      ops.push({ type: "add", text: midNew[j], oldLine: null, newLine: start + j + 1 });
    }
  }

  const suffixCount = oldLines.length - 1 - endOld;
  for (let k = 0; k < suffixCount; k++) {
    const oi = endOld + 1 + k;
    const ni = endNew + 1 + k;
    ops.push({ type: "equal", text: oldLines[oi], oldLine: oi + 1, newLine: ni + 1 });
  }

  let addedLines = 0;
  let removedLines = 0;
  let unchangedLines = 0;
  const changedIndices = [];

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    if (op.type === "add") {
      addedLines++;
      changedIndices.push(idx);
    } else if (op.type === "remove") {
      removedLines++;
      changedIndices.push(idx);
    } else {
      unchangedLines++;
    }
  }

  const CONTEXT = 3;
  const hunks = [];

  if (changedIndices.length > 0) {
    const ranges = [];
    for (const cIdx of changedIndices) {
      const rStart = Math.max(0, cIdx - CONTEXT);
      const rEnd = Math.min(ops.length - 1, cIdx + CONTEXT);
      if (ranges.length > 0 && rStart <= ranges[ranges.length - 1].end + 1) {
        ranges[ranges.length - 1].end = Math.max(ranges[ranges.length - 1].end, rEnd);
      } else {
        ranges.push({ start: rStart, end: rEnd });
      }
    }

    for (const r of ranges) {
      const slice = ops.slice(r.start, r.end + 1);
      let oldStart = 1;
      let newStart = 1;
      for (const item of slice) {
        if (item.oldLine !== null) {
          oldStart = item.oldLine;
          break;
        }
      }
      for (const item of slice) {
        if (item.newLine !== null) {
          newStart = item.newLine;
          break;
        }
      }
      const oldLen = slice.filter((x) => x.type !== "add").length;
      const newLen = slice.filter((x) => x.type !== "remove").length;
      const lines = slice.map((x) => {
        const prefix = x.type === "add" ? "+" : (x.type === "remove" ? "-" : " ");
        return `${prefix}${x.text}`;
      });
      const header = `@@ -${oldStart},${oldLen} +${newStart},${newLen} @@`;
      hunks.push({
        header,
        oldStart,
        oldLines: oldLen,
        newStart,
        newLines: newLen,
        lines
      });
    }
  }

  const cleanRel = String(relPath || "file").replace(/\\/g, "/");
  const unifiedDiff = hunks.length === 0
    ? `--- a/${cleanRel}\n+++ b/${cleanRel}\n(Sin diferencias)`
    : [
        `--- a/${cleanRel}`,
        `+++ b/${cleanRel}`,
        ...hunks.map((h) => `${h.header}\n${h.lines.join("\n")}`)
      ].join("\n");

  return {
    addedLines,
    removedLines,
    unchangedLines,
    hunks,
    unifiedDiff
  };
}

function computeProjectDiffPreview(projectName, actionItem = {}) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const act = (actionItem && typeof actionItem === "object") ? actionItem : {};
    const targetRel = act.filePath || act.relPath || act.path || "";
    const safe = resolveSafeProjectPath(proj.path, targetRel);
    if (!safe.ok) return safe;

    const searchVal = act.searchBlock !== undefined ? act.searchBlock : act.search;
    const replaceVal = act.replaceBlock !== undefined ? act.replaceBlock : act.replace;
    const kindRaw = String(act.kind || (searchVal !== undefined ? "patch" : "write")).toLowerCase().trim();
    const kind = kindRaw === "patch" ? "patch" : (kindRaw === "create" ? "create" : "write");

    const existed = fs.existsSync(safe.fullPath);
    const currentContent = existed ? fs.readFileSync(safe.fullPath, "utf-8") : "";
    let proposedContent = "";

    if (kind === "patch") {
      if (!existed) {
        return {
          ok: false,
          error: `El archivo ${safe.cleanRelPath} no existe para aplicar parche. Considera usar write:${safe.cleanRelPath} para crearlo.`
        };
      }
      const patchCalc = computePatchedFileContent(currentContent, searchVal, replaceVal, safe.cleanRelPath);
      if (!patchCalc.ok) return patchCalc;
      proposedContent = patchCalc.finalContent;
    } else {
      proposedContent = typeof act.content === "string" ? act.content : String(act.content ?? "");
    }

    const diff = computeUnifiedDiff(currentContent, proposedContent, safe.cleanRelPath);

    return {
      ok: true,
      project: proj.name,
      path: safe.fullPath,
      relPath: safe.cleanRelPath,
      kind,
      existed,
      stats: {
        added: diff.addedLines,
        removed: diff.removedLines,
        unchanged: diff.unchangedLines
      },
      hunks: diff.hunks,
      unifiedDiff: diff.unifiedDiff
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function rollbackProjectChange(projectName, options = {}) {
  try {
    const opts = (options && typeof options === "object") ? options : {};
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const changeRec = opts.changeId ? memoryStore.getChangeById(String(opts.changeId)) : null;
    if (opts.changeId && !changeRec && !opts.backupPath) {
      return { ok: false, error: `Cambio ${opts.changeId} no encontrado en el historial` };
    }

    const targetRelPath = (changeRec && changeRec.relPath) || opts.relPath || "";
    const targetBackupPath = (changeRec && changeRec.backupPath) || opts.backupPath || null;

    const safe = resolveSafeProjectPath(proj.path, targetRelPath);
    if (!safe.ok) return safe;

    // Caso 1: El cambio original fue creación de un archivo que no existía antes
    const wasCreatedNew = Boolean(
      changeRec &&
      changeRec.action === "create" &&
      !changeRec.existedBefore &&
      !targetBackupPath
    );

    if (wasCreatedNew) {
      let preDeleteBackup = null;
      if (fs.existsSync(safe.fullPath)) {
        preDeleteBackup = memoryStore.backupFileBeforeWrite(proj.name, safe.cleanRelPath, safe.fullPath);
        fs.unlinkSync(safe.fullPath);
      }
      const rbRec = memoryStore.recordChange({
        project: proj.name,
        projectPath: proj.path,
        relPath: safe.cleanRelPath,
        action: "rollback",
        sizeBytes: 0,
        model: "System",
        source: "rollback",
        backupPath: preDeleteBackup,
        existedBefore: true,
        summary: `Rollback de creación: archivo ${safe.cleanRelPath} eliminado`
      });
      if (changeRec) {
        memoryStore.markChangeReverted(changeRec.id, rbRec.id);
      }
      return {
        ok: true,
        project: proj.name,
        relPath: safe.cleanRelPath,
        restoredFrom: "deleted_created_file",
        rollbackChangeId: rbRec.id
      };
    }

    // Caso 2: Restaurar desde backupPath
    if (!targetBackupPath || typeof targetBackupPath !== "string") {
      return { ok: false, error: "No existe backup asociado para revertir este cambio" };
    }

    const backupsDir = path.resolve(path.join(memoryStore.getMemoryDir(), "backups"));
    const resolvedBackup = path.resolve(targetBackupPath);
    const cmpBase = process.platform === "win32" ? backupsDir.toLowerCase() : backupsDir;
    const cmpTarget = process.platform === "win32" ? resolvedBackup.toLowerCase() : resolvedBackup;
    const relToBackups = path.relative(cmpBase, cmpTarget);

    if (!relToBackups || relToBackups.startsWith("..") || path.isAbsolute(relToBackups) || !fs.existsSync(resolvedBackup)) {
      return { ok: false, error: "Ruta de backup inválida, fuera de memory/backups o inexistente" };
    }

    const preRestoreBackup = memoryStore.backupFileBeforeWrite(proj.name, safe.cleanRelPath, safe.fullPath);
    const parentDir = path.dirname(safe.fullPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.copyFileSync(resolvedBackup, safe.fullPath);
    const st = fs.statSync(safe.fullPath);

    const rbRec = memoryStore.recordChange({
      project: proj.name,
      projectPath: proj.path,
      relPath: safe.cleanRelPath,
      action: "rollback",
      sizeBytes: st.size,
      model: "System",
      source: "rollback",
      backupPath: preRestoreBackup || resolvedBackup,
      existedBefore: true,
      summary: `Rollback aplicado en ${safe.cleanRelPath} desde ${path.basename(resolvedBackup)}`
    });

    if (changeRec) {
      memoryStore.markChangeReverted(changeRec.id, rbRec.id);
    }

    recordProjectProgress(proj.name, {
      tool: "Rollback de Cambio",
      model: "System",
      task: `Reversión de ${safe.cleanRelPath}`,
      summary: `Archivo ${safe.cleanRelPath} restaurado desde backup (${st.size} bytes)`,
      filesModified: [safe.cleanRelPath]
    });

    return {
      ok: true,
      project: proj.name,
      relPath: safe.cleanRelPath,
      restoredFrom: resolvedBackup,
      rollbackChangeId: rbRec.id
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function applyProjectBatchTransactional(projectName, actions = [], meta = {}) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, rolledBack: false, failedIndex: -1, error: "Proyecto no encontrado" };

    if (!Array.isArray(actions) || actions.length === 0) {
      return { ok: false, rolledBack: false, failedIndex: -1, error: "La lista de acciones del lote está vacía" };
    }

    // Fase 1: Preflight completo en memoria sin tocar el disco
    const virtualFiles = new Map();
    const snapshots = new Map();

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i] || {};
      const targetRel = act.filePath || act.relPath || act.path || "";
      const safe = resolveSafeProjectPath(proj.path, targetRel);
      if (!safe.ok) {
        return { ok: false, rolledBack: false, failedIndex: i, error: safe.error };
      }

      const key = safe.cleanRelPath.toLowerCase();
      if (!virtualFiles.has(key)) {
        const existedOnDisk = fs.existsSync(safe.fullPath);
        const diskContent = existedOnDisk ? fs.readFileSync(safe.fullPath, "utf-8") : null;
        virtualFiles.set(key, {
          existed: existedOnDisk,
          content: diskContent ?? "",
          fullPath: safe.fullPath,
          cleanRelPath: safe.cleanRelPath
        });
        snapshots.set(key, {
          existed: existedOnDisk,
          content: diskContent,
          fullPath: safe.fullPath,
          cleanRelPath: safe.cleanRelPath
        });
      }

      const vState = virtualFiles.get(key);
      const searchVal = act.searchBlock !== undefined ? act.searchBlock : act.search;
      const replaceVal = act.replaceBlock !== undefined ? act.replaceBlock : act.replace;
      const kindRaw = String(act.kind || (searchVal !== undefined ? "patch" : "write")).toLowerCase().trim();
      const kind = kindRaw === "patch" ? "patch" : (kindRaw === "create" ? "create" : "write");

      if (kind === "patch") {
        if (!vState.existed) {
          return {
            ok: false,
            rolledBack: false,
            failedIndex: i,
            error: `El archivo ${safe.cleanRelPath} no existe para aplicar parche.`
          };
        }
        const patchCalc = computePatchedFileContent(vState.content, searchVal, replaceVal, safe.cleanRelPath);
        if (!patchCalc.ok) {
          return {
            ok: false,
            rolledBack: false,
            failedIndex: i,
            error: patchCalc.error
          };
        }
        vState.content = patchCalc.finalContent;
      } else {
        vState.existed = true;
        vState.content = typeof act.content === "string" ? act.content : String(act.content ?? "");
      }
    }

    // Fase 2: Commit real con rollback automático ante cualquier fallo
    const batchId = String(meta.batchId || `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
    const results = [];
    const emittedChangeIds = [];

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i] || {};
      const targetRel = act.filePath || act.relPath || act.path || "";
      const searchVal = act.searchBlock !== undefined ? act.searchBlock : act.search;
      const replaceVal = act.replaceBlock !== undefined ? act.replaceBlock : act.replace;
      const kindRaw = String(act.kind || (searchVal !== undefined ? "patch" : "write")).toLowerCase().trim();
      const kind = kindRaw === "patch" ? "patch" : (kindRaw === "create" ? "create" : "write");

      let stepRes;
      if (kind === "patch") {
        stepRes = applyProjectPatch(proj.name, targetRel, searchVal, replaceVal, {
          ...meta,
          batchId
        });
      } else {
        stepRes = saveProjectFile(proj.name, targetRel, act.content ?? "", {
          ...meta,
          batchId
        });
      }

      if (!stepRes || !stepRes.ok) {
        // Restaurar todos los snapshots previos
        for (const snap of snapshots.values()) {
          try {
            if (snap.existed) {
              const pDir = path.dirname(snap.fullPath);
              if (!fs.existsSync(pDir)) fs.mkdirSync(pDir, { recursive: true });
              fs.writeFileSync(snap.fullPath, snap.content ?? "", "utf-8");
            } else if (fs.existsSync(snap.fullPath)) {
              fs.unlinkSync(snap.fullPath);
            }
          } catch (_) {}
        }
        for (const cid of emittedChangeIds) {
          memoryStore.markChangeReverted(cid, `batch_abort_${batchId}`);
        }
        return {
          ok: false,
          rolledBack: true,
          batchId,
          failedIndex: i,
          error: (stepRes && stepRes.error) || "Error aplicando acción en lote"
        };
      }

      if (stepRes.changeId) emittedChangeIds.push(stepRes.changeId);
      results.push(stepRes);
    }

    return {
      ok: true,
      project: proj.name,
      batchId,
      appliedCount: results.length,
      results
    };
  } catch (e) {
    return { ok: false, rolledBack: false, failedIndex: -1, error: e.message };
  }
}

// ==========================================
// FASE 5: BÚSQUEDA DE CÓDIGO EN PROYECTO
// ==========================================

function searchProjectCode(projectName, options = {}) {
  try {
    const opts = (options && typeof options === "object") ? options : {};
    const rawQuery = String(opts.query ?? "");
    if (!rawQuery.trim()) {
      return { ok: false, error: "La consulta de búsqueda está vacía", matches: [] };
    }

    const proj = getActiveProject(projectName);
    if (!proj || proj.isGeneral) {
      return { ok: false, error: "Selecciona un proyecto específico para buscar en su código", matches: [] };
    }

    const caseSensitive = Boolean(opts.caseSensitive);
    const needle = caseSensitive ? rawQuery : rawQuery.toLowerCase();
    const maxResults = Number.isFinite(Number(opts.maxResults)) && Number(opts.maxResults) > 0
      ? Math.min(250, Math.floor(Number(opts.maxResults)))
      : 60;
    const filePatternRaw = String(opts.filePattern || "").trim().toLowerCase().replace(/\\/g, "/");

    const scanned = scanProjectFolderDeep(proj.path, "", 0, 5, 250);
    const matches = [];

    for (const fileInfo of scanned) {
      if (matches.length >= maxResults) break;
      if (!fileInfo || fileInfo.size > 300000) continue;

      const relLower = fileInfo.relPath.toLowerCase();
      if (filePatternRaw) {
        if (filePatternRaw.startsWith("*.")) {
          const extTarget = filePatternRaw.slice(1);
          if (!relLower.endsWith(extTarget)) continue;
        } else if (!relLower.includes(filePatternRaw)) {
          continue;
        }
      }

      const safe = resolveSafeProjectPath(proj.path, fileInfo.relPath);
      if (!safe.ok) continue;

      let rawContent = "";
      try {
        rawContent = fs.readFileSync(safe.fullPath, "utf-8");
      } catch (_) {
        continue;
      }

      const lines = rawContent.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= maxResults) break;
        const lineText = lines[i];
        const haystack = caseSensitive ? lineText : lineText.toLowerCase();
        const colIdx = haystack.indexOf(needle);
        if (colIdx !== -1) {
          matches.push({
            relPath: safe.cleanRelPath,
            line: i + 1,
            column: colIdx + 1,
            preview: lineText.trim().slice(0, 220)
          });
        }
      }
    }

    return {
      ok: true,
      project: proj.name,
      query: rawQuery,
      totalMatches: matches.length,
      matches
    };
  } catch (e) {
    return { ok: false, error: e.message, matches: [] };
  }
}

// ==========================================
// FASE 2: RUNNER SANDBOXED DE TESTS Y SCRIPTS
// ==========================================

function sanitizeCommandOutput(rawText) {
  let clean = String(rawText || "");
  clean = clean.replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|nvapi-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_TOKEN]");
  clean = clean.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s"'\r\n]{8,}/gi, "$1[REDACTED]");
  return clean;
}

function getProjectRunnableScripts(projectName) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj || proj.isGeneral) {
      return {
        ok: true,
        project: proj ? proj.name : "General",
        projectPath: proj ? proj.path : "",
        packageScripts: {},
        builtInCommands: ["git_status", "git_diff"],
        hasPython: false,
        hasTsConfig: false,
        defaultVerifyCommand: null
      };
    }

    const projectPath = proj.path;
    let packageScripts = {};
    const pkgPath = path.join(projectPath, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
          packageScripts = { ...pkg.scripts };
        }
      } catch (_) {}
    }

    const hasTsConfig = fs.existsSync(path.join(projectPath, "tsconfig.json"));
    const scanned = scanProjectFolderDeep(projectPath, "", 0, 3, 60);
    const hasPython =
      fs.existsSync(path.join(projectPath, "requirements.txt")) ||
      fs.existsSync(path.join(projectPath, "pyproject.toml")) ||
      scanned.some((f) => f.ext === ".py");
    const hasNodeTests = scanned.some((f) => f.relPath.endsWith(".test.js") || f.relPath.startsWith("tests/"));

    let defaultVerifyCommand = { commandKey: "git_status", label: "git status" };
    if (packageScripts.test) {
      defaultVerifyCommand = { commandKey: "npm_script", scriptName: "test", label: "npm test" };
    } else if (hasNodeTests) {
      defaultVerifyCommand = { commandKey: "node_test", label: "node --test" };
    } else if (hasPython) {
      defaultVerifyCommand = { commandKey: "pytest", label: "pytest" };
    }

    const builtInCommands = ["node_test", "node_check", "git_status", "git_diff"];
    if (hasTsConfig) builtInCommands.push("tsc_noemit");
    if (hasPython) builtInCommands.push("pytest", "py_compile");

    return {
      ok: true,
      project: proj.name,
      projectPath,
      packageScripts,
      builtInCommands,
      hasPython,
      hasTsConfig,
      defaultVerifyCommand
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function resolveNpmSpawnSpec(scriptName) {
  const npmCliCandidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  for (const cliPath of npmCliCandidates) {
    try {
      if (fs.existsSync(cliPath)) {
        return { bin: process.execPath, args: [cliPath, "run", scriptName] };
      }
    } catch (_) {}
  }
  if (process.platform === "win32") {
    return { bin: "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", "run", scriptName] };
  }
  return { bin: "npm", args: ["run", scriptName] };
}

function runProjectCommand(projectName, options = {}) {
  return new Promise((resolve) => {
    try {
      const opts = (options && typeof options === "object") ? options : {};
      const proj = getActiveProject(projectName);
      if (!proj || proj.isGeneral) {
        return resolve({ ok: false, error: "Selecciona un proyecto activo válido para ejecutar comandos" });
      }

      const commandKey = String(opts.commandKey || "").trim();
      const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
        ? Math.min(120000, Math.max(1000, Math.floor(Number(opts.timeoutMs))))
        : 30000;

      let bin = "";
      let args = [];
      let commandLabel = "";

      if (commandKey === "npm_script") {
        const scriptName = String(opts.scriptName || "").trim();
        if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(scriptName)) {
          return resolve({ ok: false, error: "Nombre de script npm inválido" });
        }
        const pkgPath = path.join(proj.path, "package.json");
        if (!fs.existsSync(pkgPath)) {
          return resolve({ ok: false, error: "El proyecto no contiene package.json" });
        }
        let pkg = null;
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        } catch (e) {
          return resolve({ ok: false, error: "package.json inválido" });
        }
        if (!pkg || !pkg.scripts || !Object.prototype.hasOwnProperty.call(pkg.scripts, scriptName)) {
          return resolve({ ok: false, error: `El script "${scriptName}" no existe en package.json` });
        }
        const spec = resolveNpmSpawnSpec(scriptName);
        bin = spec.bin;
        args = spec.args;
        commandLabel = `npm run ${scriptName}`;
      } else if (commandKey === "node_test") {
        bin = process.execPath;
        args = ["--test"];
        if (opts.targetFile) {
          const safeTarget = resolveSafeProjectPath(proj.path, String(opts.targetFile));
          if (!safeTarget.ok) return resolve(safeTarget);
          args.push(safeTarget.fullPath);
          commandLabel = `node --test ${safeTarget.cleanRelPath}`;
        } else {
          const testsDir = path.join(proj.path, "tests");
          if (fs.existsSync(testsDir) && fs.statSync(testsDir).isDirectory()) {
            const testFiles = fs.readdirSync(testsDir)
              .filter((f) => f.endsWith(".test.js"))
              .map((f) => path.join(testsDir, f));
            if (testFiles.length > 0) {
              args.push(...testFiles);
            }
          }
          commandLabel = "node --test";
        }
      } else if (commandKey === "node_check") {
        if (!opts.targetFile) {
          return resolve({ ok: false, error: "node_check requiere targetFile" });
        }
        const safeTarget = resolveSafeProjectPath(proj.path, String(opts.targetFile));
        if (!safeTarget.ok) return resolve(safeTarget);
        bin = process.execPath;
        args = ["--check", safeTarget.fullPath];
        commandLabel = `node --check ${safeTarget.cleanRelPath}`;
      } else if (commandKey === "tsc_noemit") {
        const localTsc = path.join(proj.path, "node_modules", "typescript", "bin", "tsc");
        if (!fs.existsSync(localTsc)) {
          return resolve({ ok: false, error: "TypeScript (node_modules/typescript/bin/tsc) no encontrado en el proyecto" });
        }
        bin = process.execPath;
        args = [localTsc, "--noEmit"];
        commandLabel = "tsc --noEmit";
      } else if (commandKey === "pytest") {
        bin = "python";
        args = ["-m", "pytest", "-q"];
        if (opts.targetFile) {
          const safeTarget = resolveSafeProjectPath(proj.path, String(opts.targetFile));
          if (!safeTarget.ok) return resolve(safeTarget);
          args.push(safeTarget.cleanRelPath);
        }
        commandLabel = "python -m pytest -q";
      } else if (commandKey === "py_compile") {
        if (!opts.targetFile) {
          return resolve({ ok: false, error: "py_compile requiere targetFile" });
        }
        const safeTarget = resolveSafeProjectPath(proj.path, String(opts.targetFile));
        if (!safeTarget.ok) return resolve(safeTarget);
        bin = "python";
        args = ["-m", "py_compile", safeTarget.fullPath];
        commandLabel = `python -m py_compile ${safeTarget.cleanRelPath}`;
      } else if (commandKey === "git_status") {
        bin = "git";
        args = ["status", "--short", "--branch"];
        commandLabel = "git status --short --branch";
      } else if (commandKey === "git_diff") {
        bin = "git";
        args = ["diff", "--stat"];
        commandLabel = "git diff --stat";
      } else {
        return resolve({ ok: false, error: `Comando no permitido: ${commandKey}` });
      }

      const startTime = Date.now();
      const MAX_BYTES = 65536;
      let stdoutBuf = "";
      let stderrBuf = "";
      let truncated = false;
      let timedOut = false;
      let settled = false;

      const child = spawn(bin, args, {
        cwd: proj.path,
        shell: false,
        windowsHide: true,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch (_) {}
      }, timeoutMs);

      if (child.stdout) {
        child.stdout.on("data", (chunk) => {
          const str = chunk.toString("utf-8");
          if (stdoutBuf.length < MAX_BYTES) {
            stdoutBuf += str.slice(0, MAX_BYTES - stdoutBuf.length);
            if (stdoutBuf.length >= MAX_BYTES) truncated = true;
          } else {
            truncated = true;
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          const str = chunk.toString("utf-8");
          if (stderrBuf.length < MAX_BYTES) {
            stderrBuf += str.slice(0, MAX_BYTES - stderrBuf.length);
            if (stderrBuf.length >= MAX_BYTES) truncated = true;
          } else {
            truncated = true;
          }
        });
      }

      const finish = (exitCode, spawnErr = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const durationMs = Date.now() - startTime;
        const cleanStdout = sanitizeCommandOutput(stdoutBuf);
        const cleanStderr = sanitizeCommandOutput(
          spawnErr ? `${stderrBuf}\n${spawnErr.message}`.trim() : stderrBuf
        );
        const code = typeof exitCode === "number" ? exitCode : (timedOut ? 124 : 1);

        resolve({
          ok: true,
          project: proj.name,
          commandKey,
          commandLabel,
          exitCode: code,
          passed: !timedOut && !spawnErr && code === 0,
          timedOut,
          durationMs,
          stdout: cleanStdout,
          stderr: cleanStderr,
          truncated
        });
      };

      child.on("error", (err) => finish(1, err));
      child.on("close", (code) => finish(code, null));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

// ==========================================
// FASE 3: SCAFFOLDING DE PROYECTO ESTÁNDAR (ESTRUCTURA.md + DISENO.md)
// ==========================================

function createNewStandardProject(options = {}) {
  try {
    const opts = (options && typeof options === "object") ? options : {};
    const cleanName = String(opts.name || "").trim();

    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(cleanName)) {
      return {
        ok: false,
        error: "Nombre de proyecto inválido. Usa entre 2 y 64 caracteres alfanuméricos, guiones o puntos."
      };
    }

    if (cleanName.toLowerCase() === "general" || IGNORED_DIRS.has(cleanName)) {
      return { ok: false, error: "Nombre de proyecto reservado por el sistema" };
    }

    const baseDir = getBaseProjectsDir();
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
    }

    const projectDir = path.resolve(baseDir, cleanName);
    if (fs.existsSync(projectDir)) {
      return { ok: false, error: `El proyecto "${cleanName}" ya existe en ${projectDir}` };
    }

    const template = String(opts.template || "web-vanilla").trim().toLowerCase();
    const description = String(opts.description || `Proyecto estándar ${cleanName} creado en Local AI Studio`).trim();
    const initGit = opts.initGit !== false;

    const standardDirs = [
      "src/main",
      "src/core",
      "src/api",
      "src/models",
      "src/ai",
      "src/ui",
      "biblioteca",
      "tests",
      "scripts",
      "docs",
      "models_link"
    ];

    fs.mkdirSync(projectDir, { recursive: true });
    for (const relDir of standardDirs) {
      fs.mkdirSync(path.join(projectDir, relDir), { recursive: true });
    }

    // 1. .gitignore (Regla 14 Zero-Trust)
    const gitignoreContent = [
      "node_modules/",
      "dist/",
      "build/",
      ".venv/",
      "__pycache__/",
      ".env",
      ".env.*",
      "!.env.example",
      "!.env.sample",
      "!.env.template",
      "models_link/*",
      "*.log",
      ".DS_Store"
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, ".gitignore"), gitignoreContent, "utf-8");

    // 2. .env.example
    const envExampleContent = [
      "# Configuración de entorno local (Nunca subir claves reales a Git)",
      "PORT=3000",
      "NODE_ENV=development",
      "AI_MODELS_PATH=C:\\antigravityAS\\Modelos -ai-brains",
      "OLIVE_GPU_MEMORY_LIMIT=25GB",
      "OLIVE_CPU_THREADS=12"
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, ".env.example"), envExampleContent, "utf-8");

    // 3. package.json
    const pkgJson = {
      name: cleanName.toLowerCase().replace(/[^a-z0-9._-]/g, "-"),
      version: "0.1.0",
      description,
      main: "src/main/index.js",
      scripts: {
        start: "node src/main/index.js",
        test: "node --test tests/smoke.test.js"
      },
      metadata: {
        template,
        standard: "ESTRUCTURA.md + DISENO.md",
        createdAt: new Date().toISOString()
      }
    };
    fs.writeFileSync(path.join(projectDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n", "utf-8");

    // 4. README.md y AVANCES_LOCAL_AI.md
    const readmeContent = [
      `# ${cleanName}`,
      "",
      `> ${description}`,
      "",
      "## Arquitectura Estándar (`ESTRUCTURA.md`)",
      "- `src/main/`: Punto de entrada principal",
      "- `src/core/`: Lógica de negocio y dominio",
      "- `src/api/`: Controladores y rutas",
      "- `src/models/`: Esquemas de datos",
      "- `src/ai/`: Puentes de inferencia local (`models_link/`)",
      "- `src/ui/`: Interfaz visual bajo estándares `DISENO.md`",
      "- `biblioteca/`: Activos generados con nomenclatura `YYYYMMDD_HHMMSS_[Tipo]_[Nombre].[ext]` + `.json`",
      "- `tests/`: Suite de pruebas automatizadas (`npm test`)"
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, "README.md"), readmeContent, "utf-8");

    const avancesContent = [
      `# Registro de Avances — ${cleanName}`,
      "",
      `## [${new Date().toISOString()}] - Inicialización Estándar (Local AI Studio)`,
      `- **Plantilla:** ${template}`,
      "- **Estructura:** Esqueleto oficial `ESTRUCTURA.md` y UI `DISENO.md` verificados."
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, "AVANCES_LOCAL_AI.md"), avancesContent, "utf-8");

    // 5. src/main/index.js y src/core/app.js
    const mainJsContent = [
      "const path = require('node:path');",
      "",
      "function getAppInfo() {",
      `  return { name: ${JSON.stringify(cleanName)}, status: 'ready', uiPath: path.join(__dirname, '..', 'ui', 'index.html') };`,
      "}",
      "",
      "if (require.main === module) {",
      "  console.log('[App]', getAppInfo());",
      "}",
      "",
      "module.exports = { getAppInfo };"
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, "src", "main", "index.js"), mainJsContent, "utf-8");

    // 6. src/ui/index.html (Cumplimiento estricto DISENO.md + Firma Oficial en Footer)
    const uiHtmlContent = [
      "<!DOCTYPE html>",
      "<html lang=\"es\">",
      "<head>",
      "  <meta charset=\"UTF-8\" />",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
      `  <title>${cleanName} — AI Studio</title>`,
      "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">",
      "  <link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Outfit:wght@600;700&display=swap\">",
      "  <style>",
      "    :root { --bg: #0b0f19; --card: rgba(17, 24, 39, 0.78); --border: rgba(56, 189, 248, 0.22); --accent: #38bdf8; --text: #f8fafc; --muted: #94a3b8; }",
      "    * { box-sizing: border-box; margin: 0; padding: 0; }",
      "    body { min-height: 100vh; display: flex; flex-direction: column; background: radial-gradient(circle at top right, #1e293b, var(--bg)); color: var(--text); font-family: 'Inter', sans-serif; overflow-x: hidden; }",
      "    main { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }",
      "    .glass-card { max-width: 640px; width: 100%; background: var(--card); backdrop-filter: blur(16px); border: 1px solid var(--border); border-radius: 16px; padding: 2.5rem; box-shadow: 0 20px 50px rgba(0,0,0,0.45); transition: transform 0.25s ease; }",
      "    .glass-card:hover { transform: translateY(-2px); }",
      "    h1 { font-family: 'Outfit', sans-serif; font-size: 2rem; margin-bottom: 0.75rem; color: var(--accent); }",
      "    p { color: var(--muted); line-height: 1.6; }",
      "    footer { text-align: center; padding: 1.25rem; font-family: 'JetBrains Mono', monospace; font-size: 0.78rem; letter-spacing: 0.08em; color: var(--muted); border-top: 1px solid rgba(255,255,255,0.06); }",
      "  </style>",
      "</head>",
      "<body>",
      "  <main>",
      "    <section class=\"glass-card\">",
      `      <h1>${cleanName}</h1>`,
      `      <p>${description}</p>`,
      "    </section>",
      "  </main>",
      "  <footer>HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®</footer>",
      "</body>",
      "</html>"
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, "src", "ui", "index.html"), uiHtmlContent, "utf-8");

    // 7. tests/smoke.test.js
    const smokeTestContent = [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { getAppInfo } = require('../src/main/index.js');",
      "",
      "test('estructura estándar y firma oficial UI presentes', () => {",
      "  const info = getAppInfo();",
      `  assert.equal(info.name, ${JSON.stringify(cleanName)});`,
      "  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf-8');",
      "  assert.ok(html.includes('HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®'));",
      "});"
    ].join("\n") + "\n";
    fs.writeFileSync(path.join(projectDir, "tests", "smoke.test.js"), smokeTestContent, "utf-8");

    // 8. Junction en models_link/ai-brains hacia C:\antigravityAS\Modelos -ai-brains
    let modelsBridgeLinked = false;
    const modelsTargetCandidates = [
      "C:\\antigravityAS\\Modelos -ai-brains",
      "C:\\antigravityAS\\Modelos-ai-brains"
    ];
    for (const target of modelsTargetCandidates) {
      try {
        if (fs.existsSync(target)) {
          const linkPath = path.join(projectDir, "models_link", "ai-brains");
          fs.symlinkSync(target, linkPath, "junction");
          modelsBridgeLinked = true;
          break;
        }
      } catch (_) {}
    }

    // 9. Inicialización Git y commit inicial (Regla 12 de GEMINI.md)
    let gitInitialized = false;
    let initialCommitSha = null;
    if (initGit) {
      try {
        const initRes = spawnSync("git", ["init"], { cwd: projectDir, encoding: "utf-8", windowsHide: true });
        if (initRes.status === 0) {
          gitInitialized = true;
          spawnSync("git", ["config", "user.email", "local-ai@antigravity.local"], { cwd: projectDir, windowsHide: true });
          spawnSync("git", ["config", "user.name", "Local AI Studio"], { cwd: projectDir, windowsHide: true });
          spawnSync("git", ["add", "."], { cwd: projectDir, windowsHide: true });
          const commitRes = spawnSync(
            "git",
            ["commit", "-m", "chore: initial standard project scaffold (ESTRUCTURA.md)"],
            { cwd: projectDir, encoding: "utf-8", windowsHide: true }
          );
          if (commitRes.status === 0) {
            const revRes = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
              cwd: projectDir,
              encoding: "utf-8",
              windowsHide: true
            });
            if (revRes.stdout) {
              initialCommitSha = revRes.stdout.trim();
            }
          }
        }
      } catch (_) {}
    }

    setActiveProjectName(cleanName);

    return {
      ok: true,
      project: {
        name: cleanName,
        path: projectDir,
        desc: description,
        isGeneral: false
      },
      createdDirs: standardDirs,
      gitInitialized,
      initialCommitSha,
      modelsBridgeLinked
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
  SAFE_DOTFILES,
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
  applyProjectPatch,
  computeUnifiedDiff,
  computeProjectDiffPreview,
  rollbackProjectChange,
  applyProjectBatchTransactional,
  searchProjectCode,
  getProjectRunnableScripts,
  runProjectCommand,
  createNewStandardProject
};
