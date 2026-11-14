const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INDEX_VERSION = 1;
const DEFAULT_MAX_FILES = 2500;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_CHARS_PER_TOKEN = 4;
// Margen operativo del constructor: DirectML admite 6.144 como máximo técnico,
// pero el contexto preparado debe quedarse por debajo de ese límite.
const CONTEXT_BUILDER_MAX_TOKENS = 6000;
const INDEX_DIR = path.join(__dirname, "datos", "context-index");

const IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "target",
  "bin", "obj", "vendor", "packages", "restore-points", "backups", "logs",
  "media", "uploads", "tempmediaStorage", "datos", "memory", "perfiles", "skills-repo", "skills"
]);

const TEXT_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".pyw", ".java",
  ".go", ".rs", ".c", ".cpp", ".h", ".hpp", ".cs", ".php", ".rb",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".xml", ".sql",
  ".md", ".mdx", ".txt", ".sh", ".bash", ".ps1", ".bat", ".cmd", ".env"
]);

const PRIORITY_NAMES = new Set([
  "package.json", "readme.md", "requirements.txt", "pyproject.toml", "go.mod",
  "cargo.toml", "tsconfig.json", "vite.config.js", "vite.config.ts", "server.js",
  "index.js", "index.ts", "main.py", "app.py", "dockerfile"
]);

function normalizeRel(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function tokenize(value) {
  return [...new Set(String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9_:#.-]+/i)
    .map((part) => part.replace(/^[:.#]+|[.:#]+$/g, ""))
    .filter((part) => part.length >= 2))];
}

function estimateTokens(value, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const chars = typeof value === "number" ? value : String(value || "").length;
  return chars > 0 ? Math.ceil(chars / Math.max(1, Number(charsPerToken) || DEFAULT_CHARS_PER_TOKEN)) : 0;
}

function indexFilePath(projectPath) {
  const key = crypto.createHash("sha1").update(path.resolve(projectPath).toLowerCase()).digest("hex");
  return path.join(INDEX_DIR, `${key}.json`);
}

function isTextFile(name) {
  const lower = String(name || "").toLowerCase();
  if (lower === "dockerfile" || lower === "makefile" || lower === ".gitignore") return true;
  return TEXT_EXTENSIONS.has(path.extname(lower));
}

function priorityFor(relPath, size) {
  const lower = normalizeRel(relPath).toLowerCase();
  const base = path.posix.basename(lower);
  const depth = lower.split("/").length - 1;
  let score = Math.max(0, 18 - depth * 2);
  if (PRIORITY_NAMES.has(base)) score += 30;
  if (/^(src|app|server|api|core|lib|services|routes|components|models|scripts|tests)\//i.test(lower)) score += 12;
  if (/^(docs|public|assets|static|biblioteca)\//i.test(lower)) score -= 8;
  if (size > 200000) score -= 12;
  return score;
}

function scanDirectory(projectPath, options = {}) {
  const maxFiles = Math.max(1, Number(options.maxFiles) || DEFAULT_MAX_FILES);
  const maxDepth = Math.max(0, Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 20);
  const maxFileBytes = Math.max(1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES);
  const files = [];
  const root = path.resolve(projectPath);

  function walk(dir, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    entries.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = normalizeRel(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        walk(fullPath, depth + 1);
        continue;
      }
      if (!isTextFile(entry.name)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
        files.push({
          relPath,
          name: entry.name,
          ext: path.extname(entry.name).toLowerCase() || entry.name.toLowerCase(),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          priority: priorityFor(relPath, stat.size),
          tooLarge: stat.size > maxFileBytes
        });
      } catch (_e) {}
    }
  }

  walk(root, 0);
  files.sort((a, b) => b.priority - a.priority || a.relPath.localeCompare(b.relPath));
  return files;
}

function buildIndex(projectPath, options = {}) {
  const root = path.resolve(String(projectPath || ""));
  if (!root || !fs.existsSync(root)) return { version: INDEX_VERSION, projectPath: root, files: [], generatedAt: new Date().toISOString() };
  const files = scanDirectory(root, options);
  const index = {
    version: INDEX_VERSION,
    projectPath: root,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    files
  };
  if (options.persist !== false) {
    try {
      fs.mkdirSync(INDEX_DIR, { recursive: true });
      fs.writeFileSync(indexFilePath(root), JSON.stringify(index), "utf8");
    } catch (_e) {}
  }
  return index;
}

function readFileSample(projectPath, relPath, maxChars = 12000) {
  try {
    const fullPath = path.resolve(projectPath, relPath);
    const root = path.resolve(projectPath);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (fullPath !== root && !fullPath.startsWith(prefix)) return "";
    const content = fs.readFileSync(fullPath, "utf8");
    return content.length > maxChars ? content.slice(0, maxChars) : content;
  } catch (_e) {
    return "";
  }
}

function scoreFile(projectPath, file, queryTokens, options = {}) {
  const rel = normalizeRel(file.relPath);
  const lower = rel.toLowerCase();
  const mentioned = new Set((options.mentionedFiles || []).map(normalizeRel).map((v) => v.toLowerCase()));
  const pinned = new Set((options.pinnedFiles || []).map(normalizeRel).map((v) => v.toLowerCase()));
  const selected = new Set((options.selectedFiles || []).map(normalizeRel).map((v) => v.toLowerCase()));
  let score = Number(file.priority) || 0;
  if (mentioned.has(lower)) score += 160;
  if (pinned.has(lower)) score += 130;
  if (selected.has(lower)) score += 100;
  const pathTokens = tokenize(lower.replace(/[\/_-]+/g, " "));
  for (const token of queryTokens) {
    if (pathTokens.includes(token)) score += 34;
    else if (lower.includes(token)) score += 12;
  }
  if (queryTokens.length && !file.tooLarge) {
    const sample = readFileSample(projectPath, rel, Number(options.sampleChars) || 10000).toLowerCase();
    const contentTokens = new Set(tokenize(sample));
    for (const token of queryTokens) {
      if (contentTokens.has(token)) score += 8;
    }
  }
  return score;
}

function rankFiles(projectPath, index, query = "", options = {}) {
  const queryTokens = tokenize(query);
  return (index.files || [])
    .map((file) => ({ ...file, score: scoreFile(projectPath, file, queryTokens, options) }))
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath));
}

function readFileForPack(projectPath, file, maxChars) {
  if (file.tooLarge) return "[Archivo grande: se conserva su ruta y metadatos; usar búsqueda o una tanda dedicada.]";
  const text = readFileSample(projectPath, file.relPath, maxChars);
  return text || "[No se pudo leer el archivo en este momento.]";
}

function packFiles(projectPath, rankedFiles, options = {}) {
  const maxChars = Math.max(1200, Number(options.maxChars) || 12000);
  const maxFiles = Math.max(1, Number(options.maxFiles) || 24);
  const selectedFiles = [];
  const files = [];
  let totalChars = 0;
  for (const file of rankedFiles || []) {
    if (selectedFiles.length >= maxFiles) break;
    const header = `\n=== Archivo: ${normalizeRel(file.relPath)} ===\n`;
    const blockPrefix = `${header}\`\`\`\n`;
    const blockSuffix = "\n\`\`\`\n";
    const remaining = maxChars - totalChars - blockPrefix.length - blockSuffix.length;
    if (remaining < 180) continue;
    const content = readFileForPack(projectPath, file, Math.min(remaining, Number(options.perFileChars) || 16000));
    const truncationMarker = "\n[... archivo recortado para esta tanda ...]";
    const clipped = content.length > remaining
      ? content.slice(0, Math.max(0, remaining - truncationMarker.length)) + truncationMarker
      : content;
    const block = `${blockPrefix}${clipped}${blockSuffix}`;
    files.push({ relPath: file.relPath, size: file.size, score: file.score, chars: clipped.length, approxTokens: estimateTokens(block) });
    selectedFiles.push(file.relPath);
    totalChars += block.length;
  }
  return { selectedFiles, files, codeContext: files.length ? files.map((f, i) => {
    const file = rankedFiles.find((candidate) => candidate.relPath === f.relPath);
    const content = readFileForPack(projectPath, file, f.chars);
    return `\n=== Archivo: ${f.relPath} ===\n\`\`\`\n${content}\n\`\`\`\n`;
  }).join("") : "", totalChars, approxTokens: estimateTokens(totalChars) };
}

function createBatches(projectPath, rankedFiles, options = {}) {
  const batchChars = Math.max(1200, Number(options.batchChars) || 12000);
  const maxFiles = Math.max(1, Number(options.maxFilesPerBatch) || 12);
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const file of rankedFiles || []) {
    const content = readFileForPack(projectPath, file, Math.min(batchChars, Number(options.perFileChars) || 16000));
    const block = `\n=== Archivo: ${file.relPath} ===\n\`\`\`\n${content}\n\`\`\`\n`;
    if (current.length && (currentChars + block.length > batchChars || current.length >= maxFiles)) {
      batches.push({ index: batches.length + 1, files: current.map((item) => item.relPath), text: current.map((item) => item.block).join(""), approxTokens: estimateTokens(currentChars) });
      current = [];
      currentChars = 0;
    }
    if (block.length > batchChars) {
      const clipped = block.slice(0, batchChars) + "\n[... archivo recortado ...]\n";
      batches.push({ index: batches.length + 1, files: [file.relPath], text: clipped, approxTokens: estimateTokens(clipped) });
      continue;
    }
    current.push({ relPath: file.relPath, block });
    currentChars += block.length;
  }
  if (current.length) batches.push({ index: batches.length + 1, files: current.map((item) => item.relPath), text: current.map((item) => item.block).join(""), approxTokens: estimateTokens(currentChars) });
  return batches;
}

function plan(projectPath, query = "", options = {}) {
  const requestedBudgetTokens = Number(options.budgetTokens) || 3000;
  const budgetTokens = Math.min(
    CONTEXT_BUILDER_MAX_TOKENS,
    Math.max(320, requestedBudgetTokens)
  );
  // estimateTokens() y el margen de DirectML usan 4 caracteres por token.
  // Nunca aumentamos este valor mediante charsPerToken porque rompería el tope
  // visible del constructor aunque budgetTokens ya estuviera limitado.
  const charsPerToken = Math.min(
    DEFAULT_CHARS_PER_TOKEN,
    Math.max(1, Number(options.charsPerToken) || DEFAULT_CHARS_PER_TOKEN)
  );
  const budgetChars = Math.max(1200, budgetTokens * charsPerToken);
  const index = options.index || buildIndex(projectPath, options);
  const rankedFiles = rankFiles(projectPath, index, query, options);
  const packed = packFiles(projectPath, rankedFiles, { ...options, maxChars: budgetChars });
  const batches = createBatches(projectPath, rankedFiles, { ...options, batchChars: budgetChars });
  return {
    projectPath: path.resolve(projectPath),
    query: String(query || "").slice(0, 1000),
    index: { version: index.version, generatedAt: index.generatedAt, fileCount: index.fileCount },
    budgetTokens,
    budgetChars,
    selectedFiles: packed.selectedFiles,
    files: packed.files,
    codeContext: packed.codeContext,
    totalChars: packed.totalChars,
    approxTokens: packed.approxTokens,
    batches,
    batchCount: batches.length,
    ranked: rankedFiles.slice(0, 60).map((file) => ({ relPath: file.relPath, size: file.size, score: file.score, ext: file.ext }))
  };
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|ghp|gsk|nfp|hf)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)[^\r\n]+/gi, "$1[REDACTED]");
}

function buildCompilerPrompt(planResult, goal = "") {
  const files = (planResult && planResult.codeContext) || "";
  return `Objetivo del usuario:\n${String(goal || "Analiza el proyecto y prepara el contexto de trabajo.").slice(0, 2000)}\n\n` +
    `Proyecto: ${path.basename(String(planResult && planResult.projectPath || "proyecto"))}\n` +
    `Archivos priorizados: ${(planResult && planResult.selectedFiles || []).join(", ")}\n\n` +
    `Código y configuración disponibles:\n${redactSecrets(files).slice(0, 30000)}\n\n` +
    `Devuelve un resumen técnico accionable, sin inventar archivos ni cambios. Incluye: arquitectura relevante, archivos que deben tocarse, dependencias entre ellos, riesgos o incompatibilidades, y un plan de ejecución por pasos. Mantén el resumen por debajo de 1.500 tokens.`;
}

module.exports = {
  INDEX_VERSION,
  DEFAULT_MAX_FILES,
  CONTEXT_BUILDER_MAX_TOKENS,
  estimateTokens,
  normalizeRel,
  buildIndex,
  rankFiles,
  packFiles,
  createBatches,
  plan,
  redactSecrets,
  buildCompilerPrompt
};
