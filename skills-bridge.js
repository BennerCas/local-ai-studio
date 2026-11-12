const fs = require("node:fs");
const path = require("node:path");

const SKILLS_ROOT = "C:\\antigravityAS\\antigravity-awesome-skills";
const SKILLS_REPO_URL = "https://github.com/sickn33/agentic-awesome-skills";
const DEFAULT_SKILLS_DIRS = [
  path.join(__dirname, "skills-repo"),
  path.join(__dirname, "vendor", "antigravity-awesome-skills"),
  "C:\\antigravityAS\\Modelos -ai-brains\\antigravity-awesome-skills",
  "C:\\antigravityAS\\Modelos-ai-brains\\antigravity-awesome-skills",
  "C:\\antigravityAS\\antigravity-awesome-skills"
];
const DEFAULT_SKILLS_BACKUP_DIR = "C:\\antigravityAS\\Skills_Backup";
const DEFAULT_PROFILES_DIRS = [
  path.join(__dirname, "perfiles"),
  "C:\\antigravityAS\\Modelos-ai-brains\\agencia ai\\perfiles",
  "C:\\antigravityAS\\Modelos -ai-brains\\agencia ai\\perfiles"
];

let skillsCache = null;
let skillsCacheRoot = null;
let lastLoadTime = 0;

let profilesCache = null;
let profilesCacheKey = null;
let lastProfilesLoadTime = 0;

function getSkillsRoot() {
  const override = process.env.LOCAL_AI_SKILLS_ROOT;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  for (const dir of DEFAULT_SKILLS_DIRS) {
    try {
      if (fs.existsSync(path.join(dir, "skills_index.json"))) {
        return dir;
      }
    } catch (_) {}
  }
  return SKILLS_ROOT;
}

function getSkillsBackupDir() {
  const override = process.env.LOCAL_AI_SKILLS_BACKUP_DIR;
  if (override && String(override).trim()) {
    return path.resolve(String(override).trim());
  }
  return DEFAULT_SKILLS_BACKUP_DIR;
}

function getFusionsFallbackDir() {
  const memOverride = process.env.LOCAL_AI_MEMORY_DIR;
  const baseMem = (memOverride && String(memOverride).trim())
    ? path.resolve(String(memOverride).trim())
    : path.join(__dirname, "memory");
  return path.join(baseMem, "fusions");
}

function getProfilesDirs() {
  const override = process.env.LOCAL_AI_PROFILES_DIRS;
  const fallbackFusions = getFusionsFallbackDir();
  if (override && String(override).trim()) {
    const custom = String(override)
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => path.resolve(s));
    if (!custom.includes(fallbackFusions)) custom.push(fallbackFusions);
    return custom;
  }
  return [...DEFAULT_PROFILES_DIRS, fallbackFusions];
}

function isPathInside(rootDir, targetPath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  const cmpRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const cmpTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  const rel = path.relative(cmpRoot, cmpTarget);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function loadSkillsIndex(forceRefresh = false) {
  const root = getSkillsRoot();
  const now = Date.now();
  if (!forceRefresh && skillsCache && skillsCacheRoot === root && (now - lastLoadTime < 60000)) {
    return skillsCache;
  }

  const indexPath = path.join(root, "skills_index.json");
  try {
    if (!fs.existsSync(indexPath)) {
      console.warn("[Skills Bridge] Index file not found:", indexPath);
      return [];
    }
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    // Sin duplicados: el índice upstream repite algunos id
    const seenIds = new Set();
    skillsCache = (Array.isArray(parsed) ? parsed : []).filter((s) => {
      const key = s && s.id ? String(s.id).toLowerCase() : null;
      if (!key) return true;
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });
    skillsCacheRoot = root;
    lastLoadTime = now;
    return skillsCache;
  } catch (err) {
    console.error("[Skills Bridge] Error reading skills_index.json:", err.message);
    return (skillsCacheRoot === root && skillsCache) ? skillsCache : [];
  }
}

function getCategories() {
  const all = loadSkillsIndex();
  const cats = new Set();
  for (const s of all) {
    if (s && s.category) cats.add(s.category);
  }
  return Array.from(cats).sort();
}

function searchSkills(query = "", category = "", limit = 2000) {
  const all = loadSkillsIndex();
  let filtered = all;

  if (category && category !== "all") {
    filtered = filtered.filter((s) => s && s.category === category);
  }

  if (query && String(query).trim()) {
    const q = String(query).toLowerCase().trim();
    filtered = filtered.filter((s) =>
      s && (
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.id && s.id.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q)) ||
        (s.category && s.category.toLowerCase().includes(q))
      )
    );
  }

  const totalCount = filtered.length;
  const numericLimit = (limit === 0 || limit === null || limit === Infinity || limit < 0)
    ? totalCount
    : (Number.isFinite(Number(limit)) ? Math.max(0, Number(limit)) : 2000);

  const sliced = filtered.slice(0, numericLimit).map((s) => ({
    id: s.id,
    name: s.name || s.id,
    category: s.category || "general",
    description: s.description || "",
    path: s.path || "",
    risk: s.risk || "safe"
  }));

  Object.defineProperty(sliced, "totalCount", {
    value: totalCount,
    enumerable: false,
    configurable: true
  });

  return sliced;
}

function getSkillContent(skillId) {
  if (!skillId || typeof skillId !== "string") return null;
  const trimmedId = skillId.trim();
  if (!trimmedId) return null;

  const root = getSkillsRoot();
  const skillsDir = path.join(root, "skills");
  const all = loadSkillsIndex();
  const entry = all.find((s) =>
    s && (s.id === trimmedId || (s.id && s.id.toLowerCase() === trimmedId.toLowerCase()))
  );

  const candidates = [];

  // 1. Resolver ruta declarada en skills_index.json (soporta rutas anidadas como skills/security/...)
  if (entry && entry.path && typeof entry.path === "string") {
    const relEntryPath = entry.path.replace(/^[\/\\]+/, "");
    const candidateFromIndex = path.resolve(root, relEntryPath, "SKILL.md");
    if (isPathInside(root, candidateFromIndex)) {
      candidates.push(candidateFromIndex);
    }
    if (entry.path.toLowerCase().endsWith(".md")) {
      const directMd = path.resolve(root, relEntryPath);
      if (isPathInside(root, directMd)) {
        candidates.push(directMd);
      }
    }
  }

  // 2. Fallback a skills/<safeId>/SKILL.md validando containment en SKILLS_ROOT
  const safeId = path.basename(trimmedId);
  if (safeId && safeId !== "." && safeId !== ".." && !safeId.includes("..")) {
    const candidateFallback = path.resolve(skillsDir, safeId, "SKILL.md");
    if (isPathInside(root, candidateFallback)) {
      candidates.push(candidateFallback);
    }
  }

  for (const skillFile of candidates) {
    try {
      if (fs.existsSync(skillFile) && fs.statSync(skillFile).isFile()) {
        return fs.readFileSync(skillFile, "utf8");
      }
    } catch (err) {
      console.warn(`[Skills Bridge] Error reading skill ${skillId}:`, err.message);
    }
  }

  return null;
}

function parseProfileFrontmatter(rawContent, fallbackName) {
  const result = {
    name: fallbackName,
    description: "",
    vibe: "",
    emoji: "",
    color: ""
  };

  if (!rawContent) return result;
  const normalized = rawContent.replace(/\r\n/g, "\n");

  if (normalized.startsWith("---\n")) {
    const endIdx = normalized.indexOf("\n---", 4);
    if (endIdx !== -1) {
      const fmBlock = normalized.slice(4, endIdx);
      for (const line of fmBlock.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx <= 0) continue;
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        let val = line.slice(colonIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key === "name" && val) result.name = val;
        else if (key === "description") result.description = val;
        else if (key === "vibe") result.vibe = val;
        else if (key === "emoji") result.emoji = val;
        else if (key === "color") result.color = val;
      }
      return result;
    }
  }

  const h1Match = normalized.match(/^#\s+(.+)$/m);
  if (h1Match && h1Match[1]) {
    result.name = h1Match[1].trim();
  }
  const bodyLines = normalized
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (bodyLines.length > 0 && !result.description) {
    result.description = bodyLines[0].slice(0, 220);
  }

  return result;
}

function walkProfileMarkdownFiles(rootDir, currentDir, depth = 0, maxDepth = 4) {
  const results = [];
  if (depth > maxDepth || !fs.existsSync(currentDir)) return results;

  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "scripts" || entry.name === "node_modules") {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkProfileMarkdownFiles(rootDir, fullPath, depth + 1, maxDepth));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        const upper = entry.name.toUpperCase();
        if (upper === "README.MD" || upper === "CONTRIBUTING.MD") continue;
        const relPath = path.relative(rootDir, fullPath).replace(/\\/g, "/");
        results.push({ fullPath, relPath, fileName: entry.name });
      }
    }
  } catch (err) {
    console.warn(`[Skills Bridge] Error escaneando perfiles en ${currentDir}:`, err.message);
  }

  return results;
}


let bundlesCache = null;
let bundlesCacheTime = 0;

function loadBundles(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && bundlesCache && (now - bundlesCacheTime < 60000)) return bundlesCache;
  const bundlesPath = path.join(getSkillsRoot(), "data", "bundles.json");
  const out = [];
  try {
    if (fs.existsSync(bundlesPath)) {
      const parsed = JSON.parse(fs.readFileSync(bundlesPath, "utf8"));
      const map = (parsed && parsed.bundles && typeof parsed.bundles === "object") ? parsed.bundles : {};
      for (const [key, b] of Object.entries(map)) {
        const skillIds = Array.isArray(b.skills) ? b.skills.map(String) : [];
        out.push({
          id: `bundle:${key}`,
          slug: key,
          name: key.split(/[-_]/).map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(" "),
          category: "bundles",
          description: b.description || "",
          vibe: `Bundle de ${skillIds.length} skills`,
          emoji: "🧩",
          color: "violet",
          isBundle: true,
          skillsCount: skillIds.length,
          skillIds,
          fullPath: null
        });
      }
    }
  } catch (err) {
    console.warn("[Skills Bridge] Error leyendo bundles:", err.message);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  bundlesCache = out;
  bundlesCacheTime = now;
  return out;
}

function buildBundleProfileContent(entry) {
  if (!entry || !entry.isBundle) return null;
  const ids = Array.isArray(entry.skillIds) ? entry.skillIds : [];
  const shown = ids.slice(0, 60);
  return [
    `# Perfil Cognitivo (Bundle): ${entry.name}`,
    "",
    entry.description || "",
    "",
    `Este perfil agrupa ${ids.length} skills de Antigravity OS v2. Actúa como un especialista integral de esta área:`,
    "prioriza los enfoques, patrones y herramientas de las skills listadas cuando sean relevantes para la tarea,",
    "y combina varias si el problema lo cruza (no fuerces las que no apliquen).",
    "",
    "## Kit de habilidades prioritarias",
    ...shown.map((id) => `- ${id}`),
    ids.length > shown.length ? `- … y ${ids.length - shown.length} más en el bundle "${entry.slug}"` : ""
  ].join("\n");
}

function loadProfiles(forceRefresh = false) {
  const dirs = getProfilesDirs();
  const cacheKey = dirs.join("|");
  const now = Date.now();

  if (!forceRefresh && profilesCache && profilesCacheKey === cacheKey && (now - lastProfilesLoadTime < 60000)) {
    return profilesCache;
  }

  const seenIds = new Set();
  const profiles = [];

  for (const baseDir of dirs) {
    if (!fs.existsSync(baseDir)) continue;
    const files = walkProfileMarkdownFiles(baseDir, baseDir);
    for (const f of files) {
      const id = f.relPath.replace(/\.md$/i, "");
      const normKey = id.toLowerCase();
      if (seenIds.has(normKey)) continue;
      seenIds.add(normKey);

      const parts = id.split("/");
      const category = parts.length > 1 ? parts[0] : "general";
      const slug = parts[parts.length - 1];

      let raw = "";
      try {
        raw = fs.readFileSync(f.fullPath, "utf8");
      } catch (e) {
        continue;
      }

      const meta = parseProfileFrontmatter(raw, slug);
      const skillsSugeridas = suggestSkillsForProfile(slug, category, meta.name || slug);
      profiles.push({
        id,
        slug,
        name: meta.name || slug,
        category,
        description: meta.description || "",
        vibe: meta.vibe || "",
        emoji: meta.emoji || "",
        skillsSugeridas,
        color: meta.color || "",
        relPath: f.relPath,
        fullPath: f.fullPath
      });
    }
  }

  for (const bundle of loadBundles(forceRefresh)) {
    const key = bundle.id.toLowerCase();
    if (!seenIds.has(key)) {
      seenIds.add(key);
      profiles.push(bundle);
    }
  }

  profiles.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    if (catCmp !== 0) return catCmp;
    return a.name.localeCompare(b.name);
  });

  profilesCache = profiles;
  profilesCacheKey = cacheKey;
  lastProfilesLoadTime = now;
  return profiles;
}

const PROFILE_SKILL_STOPWORDS = new Set(["the", "and", "for", "with", "engineer", "engineering", "specialist", "expert", "agent", "ai", "pro", "senior", "lead", "master", "chief", "head", "de", "la", "el", "en", "y", "staff", "directory", "people", "event", "events", "manager", "management", "director", "general", "global", "digital", "online", "content"]);
const PROFILE_CAT_AFFINITY = {
  engineering: ["development", "web-development", "frontend", "devops", "cloud", "data"],
  specialized: ["ai-ml", "workflow", "automation", "development"],
  security: ["security"],
  marketing: ["marketing", "content", "business"],
  design: ["design", "frontend", "content"],
  testing: ["development", "devops", "workflow"],
  "game-development": ["development", "design", "ai-ml"],
  sales: ["business", "marketing", "productivity"],
  finance: ["business", "data"],
  product: ["business", "productivity", "workflow"],
  "project-management": ["productivity", "workflow", "business"],
  support: ["productivity", "workflow", "business"],
  academic: ["content", "data", "productivity"],
  "paid-media": ["marketing", "business"],
  "spatial-computing": ["design", "development", "ai-ml"]
};
const PROFILE_SKILL_OVERRIDES = {
  "director-staff-vibecoding": ["ai-agents-architect", "agent-orchestration-improve-agent", "autonomous-agent-patterns", "parallel-agents"],
  "orquestador-enjambre": ["ai-agents-architect", "agent-orchestration-improve-agent", "autonomous-agent-patterns", "parallel-agents"]
};
function suggestSkillsForProfile(slug, category, name) {
  try {
    const override = PROFILE_SKILL_OVERRIDES[String(slug || "").toLowerCase()];
    if (override) {
      const byId = new Map(loadSkillsIndex().filter(Boolean).map((s) => [s.id, s]));
      const picked = override.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).name || id, category: byId.get(id).category || "general", description: String(byId.get(id).description || "").slice(0, 280) }));
      if (picked.length) return picked;
    }
    const tokens = new Set();
    const addWords = (txt) => String(txt || "").toLowerCase().split(/[^a-z0-9]+/).forEach((w) => { if (w.length >= 3 && !PROFILE_SKILL_STOPWORDS.has(w)) tokens.add(w); });
    addWords(slug); addWords(name); addWords(String(category || "").replace(/-/g, " "));
    if (!tokens.size) return [];
    const scored = [];
    for (const s of loadSkillsIndex()) {
      if (!s) continue;
      const nm = String(s.name || s.id || "").toLowerCase(), idl = String(s.id || "").toLowerCase(),
        cat = String(s.category || "").toLowerCase(), desc = String(s.description || "").toLowerCase();
      let score = 0;
      if ((PROFILE_CAT_AFFINITY[String(category || "").toLowerCase()] || []).includes(cat)) score += 2;
      for (const t of tokens) {
        if (nm.includes(t) || idl.includes(t)) score += 3;
        else if (cat.includes(t)) score += 2;
        else if (desc.includes(t)) score += 1;
      }
      if (score > 0) scored.push({ id: s.id, name: s.name || s.id, category: s.category || "general", description: String(s.description || "").slice(0, 280), score });
    }
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return scored.slice(0, 8).map(({ id, name, category: c, description }) => ({ id, name, category: c, description: description || "" }));
  } catch (_e) { return []; }
}

function findProfileEntry(profileId) {
  if (!profileId || typeof profileId !== "string") return null;
  const clean = profileId.trim().replace(/\\/g, "/").replace(/\.md$/i, "");
  if (!clean) return null;
  const cleanLower = clean.toLowerCase();

  const profiles = loadProfiles();
  return (
    profiles.find((p) => p.id.toLowerCase() === cleanLower) ||
    profiles.find((p) => p.slug.toLowerCase() === cleanLower) ||
    profiles.find((p) => p.name.toLowerCase() === cleanLower) ||
    null
  );
}

function getProfileContent(profileId) {
  const entry = findProfileEntry(profileId);
  if (!entry) return null;
  if (entry.isBundle) return buildBundleProfileContent(entry);
  if (!entry.fullPath) return null;

  const dirs = getProfilesDirs();
  const isContained = dirs.some((dir) => isPathInside(dir, entry.fullPath));
  if (!isContained) return null;

  try {
    if (fs.existsSync(entry.fullPath) && fs.statSync(entry.fullPath).isFile()) {
      return fs.readFileSync(entry.fullPath, "utf8");
    }
  } catch (err) {
    console.warn(`[Skills Bridge] Error reading profile ${profileId}:`, err.message);
  }
  return null;
}

function saveProfileContent(profileId, content) {
  const entry = findProfileEntry(profileId);
  if (!entry) return { ok: false, error: 'Perfil no encontrado: ' + profileId };
  if (entry.isBundle) return { ok: false, error: 'Los bundles no tienen un Master Prompt editable.' };
  if (!entry.fullPath) return { ok: false, error: 'El perfil no tiene archivo asociado.' };
  const text = String(content == null ? '' : content);
  if (!text.trim()) return { ok: false, error: 'El contenido no puede quedar vacio.' };
  if (text.length > 200000) return { ok: false, error: 'Contenido demasiado grande (max. 200000 caracteres).' };
  const dirs = getProfilesDirs();
  if (!dirs.some((dir) => isPathInside(dir, entry.fullPath))) return { ok: false, error: 'Ruta fuera de los directorios de perfiles.' };
  try {
    fs.writeFileSync(entry.fullPath, text, 'utf8');
  } catch (err) {
    return { ok: false, error: 'No se pudo guardar: ' + err.message };
  }
  return { ok: true, id: entry.id, bytes: Buffer.byteLength(text, 'utf8') };
}

function createProfileFile(input) {
  const { category, slug, content } = input || {};
  const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const cat = String(category || "").trim().toLowerCase();
  const cleanSlug = String(slug || "").trim().toLowerCase();
  if (!SLUG_RE.test(cat)) return { ok: false, error: "Clasificación inválida: " + cat };
  if (!SLUG_RE.test(cleanSlug)) return { ok: false, error: "Slug inválido: " + cleanSlug };
  const text = String(content == null ? "" : content);
  if (!text.trim()) return { ok: false, error: "El contenido no puede quedar vacío." };
  if (text.length > 200000) return { ok: false, error: "Contenido demasiado grande (máx. 200000 caracteres)." };
  const dirs = getProfilesDirs();
  const base = dirs[0];
  const fullPath = path.join(base, cat, cleanSlug + ".md");
  if (!isPathInside(base, fullPath)) return { ok: false, error: "Ruta fuera del directorio de perfiles." };
  if (fs.existsSync(fullPath)) return { ok: false, error: "Ya existe un perfil con ese nombre: " + cat + "/" + cleanSlug };
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, text, "utf8");
  } catch (err) {
    return { ok: false, error: "No se pudo crear: " + err.message };
  }
  profilesCache = null;
  return { ok: true, id: cat + "/" + cleanSlug };
}

function parseSkillIdsList(skillIdOrList) {
  if (!skillIdOrList) return [];
  const rawItems = Array.isArray(skillIdOrList)
    ? skillIdOrList
    : String(skillIdOrList).split(",");
  const seen = new Set();
  const result = [];
  for (const item of rawItems) {
    const clean = String(item || "").trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(clean);
  }
  return result;
}

function buildSkillSystemPrompt(skillIdOrList, profileId = null) {
  const blocks = [];

  const profileEntry = profileId ? findProfileEntry(profileId) : null;
  const profileContent = profileId ? getProfileContent(profileId) : null;
  const skillIds = parseSkillIdsList(skillIdOrList);

  const loadedSkills = [];
  for (const sid of skillIds) {
    const content = getSkillContent(sid);
    if (content) {
      loadedSkills.push({ id: sid, content });
    }
  }

  if (profileContent || loadedSkills.length > 0) {
    const contextLabels = [];
    if (profileContent) {
      contextLabels.push(`Perfil: ${profileEntry ? profileEntry.name : String(profileId)}`);
    }
    if (loadedSkills.length > 0) {
      contextLabels.push(`Skills: ${loadedSkills.map((s) => s.id).join(" + ")}`);
    }
    blocks.push(
      `TRANSPARENCIA DE CONTEXTO (SKILLS.md Regla 9): Al inicio de tu respuesta incluye la etiqueta: [Contexto Cargado: ${contextLabels.join(" | ")}]`
    );
  }

  if (profileContent) {
    const profileLabel = profileEntry ? `${profileEntry.name} (${profileEntry.id})` : String(profileId);
    blocks.push(
      `--- [PERFIL COGNITIVO ACTIVO (JERARQUÍA SUPERIOR): ${profileLabel.toUpperCase()}] ---\n` +
      `JERARQUÍA DE MANDO (Perfil > Skill): Debes adoptar la mentalidad, arquitectura y criterio estratégico de este Perfil Cognitivo.\n` +
      `En caso de discrepancia estructural entre la visión del Perfil y la táctica de cualquier Skill, prevalece el Perfil.\n\n` +
      `${profileContent}\n` +
      `--- [FIN DE PERFIL COGNITIVO] ---`
    );
  }

  if (loadedSkills.length === 1) {
    const single = loadedSkills[0];
    const subordinationNote = profileContent
      ? " (subordinada a las directrices estratégicas del Perfil Cognitivo activo)"
      : "";
    blocks.push(
      `--- [HABILIDAD TÉCNICA ACTIVA: ${String(single.id).toUpperCase()}] ---\n` +
      `Debes aplicar de forma estricta los estándares, directrices y mejores prácticas definidos en esta habilidad${subordinationNote}:\n\n` +
      `${single.content}\n` +
      `--- [FIN DE HABILIDAD] ---`
    );
  } else if (loadedSkills.length > 1) {
    const fusionHeaderIds = loadedSkills.map((s) => String(s.id).toUpperCase()).join(" + ");
    const subordinationNote = profileContent
      ? " (subordinadas a las directrices estratégicas del Perfil Cognitivo activo)"
      : "";
    const subBlocks = loadedSkills.map(
      (s, idx) =>
        `### [SKILL FUSIONADA ${idx + 1}/${loadedSkills.length}: ${String(s.id).toUpperCase()}]\n` +
        `--- [HABILIDAD TÉCNICA ACTIVA: ${String(s.id).toUpperCase()}] ---\n` +
        `${s.content}\n` +
        `--- [FIN DE HABILIDAD: ${String(s.id).toUpperCase()}] ---`
    );
    blocks.push(
      `--- [FUSIÓN INFINITA DE HABILIDADES ACTIVAS (${loadedSkills.length}): ${fusionHeaderIds}] ---\n` +
      `Combina sinérgicamente las capacidades, patrones y restricciones de todas las habilidades listadas a continuación${subordinationNote}:\n\n` +
      `${subBlocks.join("\n\n")}\n` +
      `--- [FIN DE FUSIÓN DE HABILIDADES] ---`
    );
  }

  if (blocks.length === 0) return "";
  return "\n\n" + blocks.join("\n\n") + "\n";
}

function saveSkillFusion(options = {}) {
  const opts = (options && typeof options === "object") ? options : {};
  const rawName = String(opts.name || "").trim();
  if (!rawName) {
    return { ok: false, error: "El nombre de la fusión es obligatorio" };
  }

  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `fusion-${Date.now()}`;

  const description = String(opts.description || `Fusión cognitiva ${rawName}`).trim();
  const profileId = opts.profileId ? String(opts.profileId).trim() : "";
  const skillIds = parseSkillIdsList(opts.skillIds || []);
  const rules = String(opts.rules || "").trim();

  const profileContent = profileId ? getProfileContent(profileId) : null;
  const skillSections = [];
  for (const sid of skillIds) {
    const content = getSkillContent(sid);
    if (content) {
      skillSections.push(`## Habilidad Fusionada: ${sid}\n\n${content.trim()}`);
    } else {
      skillSections.push(`## Habilidad Fusionada: ${sid}\n\n*(Referencia a skill: ${sid})*`);
    }
  }

  const markdownLines = [
    "---",
    `name: "${rawName.replace(/"/g, '\\"')}"`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    `vibe: "Fusión Infinita (${[profileId, ...skillIds].filter(Boolean).join(" + ") || "Custom"})"`,
    `emoji: "🧬"`,
    `color: "cyan"`,
    "---",
    "",
    `# ${rawName}`,
    "",
    `> **Fusión de Roles y Habilidades (SKILLS.md)** — Generado el ${new Date().toISOString()}`,
    `> **Jerarquía:** Perfil Base (${profileId || "Ninguno"}) > Habilidades Técnicas (${skillIds.join(", ") || "Ninguna"})`,
    ""
  ];

  if (rules) {
    markdownLines.push("## Reglas Específicas de la Fusión", "", rules, "");
  }
  if (profileContent) {
    markdownLines.push(`## Perfil Cognitivo Base: ${profileId}`, "", profileContent.trim(), "");
  }
  if (skillSections.length > 0) {
    markdownLines.push(...skillSections, "");
  }

  const fullMarkdown = markdownLines.join("\n");

  const pad = (n) => String(n).padStart(2, "0");
  const now = new Date();
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  // 1. Guardar en C:\antigravityAS\Skills_Backup (con versionado previo si ya existía, Regla 7 de SKILLS.md)
  let backupPath = null;
  try {
    const backupDir = getSkillsBackupDir();
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const primaryBackupFile = path.join(backupDir, `${slug}.md`);
    if (fs.existsSync(primaryBackupFile)) {
      const versionedBackupFile = path.join(backupDir, `${ts}_${slug}.md`);
      fs.copyFileSync(primaryBackupFile, versionedBackupFile);
    }
    fs.writeFileSync(primaryBackupFile, fullMarkdown, "utf8");
    backupPath = primaryBackupFile;
  } catch (err) {
    console.warn("[Skills Bridge] No se pudo escribir en Skills_Backup:", err.message);
  }

  // 2. Guardar también en directorio de perfiles para que sea seleccionable inmediatamente
  let profilePath = null;
  let savedId = `fusions/${slug}`;
  const dirs = getProfilesDirs();
  const preferredDir = dirs[0] ? path.join(dirs[0], "fusions") : null;
  const fallbackDir = getFusionsFallbackDir();

  for (const targetDir of [preferredDir, fallbackDir].filter(Boolean)) {
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const targetFile = path.join(targetDir, `${slug}.md`);
      if (fs.existsSync(targetFile) && backupPath === null) {
        const versioned = path.join(targetDir, `${ts}_${slug}.bak`);
        fs.copyFileSync(targetFile, versioned);
      }
      fs.writeFileSync(targetFile, fullMarkdown, "utf8");
      profilePath = targetFile;
      if (targetDir === fallbackDir) {
        savedId = slug;
      }
      break;
    } catch (_) {}
  }

  profilesCache = null;
  lastProfilesLoadTime = 0;

  return {
    ok: true,
    id: savedId,
    slug,
    name: rawName,
    backupPath: backupPath || profilePath,
    profilePath,
    skillIds,
    profileId
  };
}

// ---------------------------------------------------------------------------
// Agentes creados por el usuario
// ---------------------------------------------------------------------------
// Un perfil/fusion describe como piensa un agente; este manifiesto añade la
// parte operativa: modelo preferido, herramientas autorizadas, permisos y
// limite de pasos. Se guarda separado del registro de APIs externas.
const AGENT_TOOL_IDS = new Set([
  "read_file", "search_code", "write_file", "patch_file", "preview_web",
  "run_tests", "rollback", "delegate"
]);
const AGENT_PERMISSION_KEYS = ["read", "write", "preview", "test", "execute", "network"];

function getCreatedAgentsDirs() {
  return getProfilesDirs()
    .map((dir) => path.join(dir, "agentes"))
    .filter((dir, index, all) => dir && all.indexOf(dir) === index);
}

function normalizeAgentManifest(raw, fallbackPath = null) {
  const input = (raw && typeof raw === "object") ? raw : {};
  const tools = Array.isArray(input.tools)
    ? input.tools.map((tool) => String(tool || "").trim()).filter((tool, index, list) => AGENT_TOOL_IDS.has(tool) && list.indexOf(tool) === index)
    : [];
  const sourcePermissions = (input.permissions && typeof input.permissions === "object") ? input.permissions : {};
  const permissions = {};
  for (const key of AGENT_PERMISSION_KEYS) permissions[key] = sourcePermissions[key] === true;
  const modelPolicy = (input.modelPolicy && typeof input.modelPolicy === "object")
    ? { provider: String(input.modelPolicy.provider || "auto").trim() || "auto", model: String(input.modelPolicy.model || "").trim() }
    : { provider: String(input.modelProvider || "auto").trim() || "auto", model: String(input.model || "").trim() };
  return {
    id: String(input.id || "").trim(),
    slug: String(input.slug || "").trim(),
    name: String(input.name || input.slug || "Agente").trim(),
    description: String(input.description || "").trim(),
    profileId: String(input.profileId || "").trim(),
    skillIds: parseSkillIdsList(input.skillIds || input.skills || []),
    tools,
    modelPolicy,
    permissions,
    maxSteps: Math.max(1, Math.min(100, Number(input.maxSteps) || 12)),
    createdAt: String(input.createdAt || new Date().toISOString()),
    updatedAt: String(input.updatedAt || input.createdAt || new Date().toISOString()),
    manifestPath: fallbackPath || String(input.manifestPath || "")
  };
}

function loadCreatedAgents(forceRefresh = false) {
  const result = [];
  const seen = new Set();
  for (const dir of getCreatedAgentsDirs()) {
    if (!fs.existsSync(dir)) continue;
    let files = [];
    try { files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith(".json")); } catch (_) { continue; }
    for (const name of files) {
      const fullPath = path.join(dir, name);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const agent = normalizeAgentManifest(parsed, fullPath);
        if (!agent.id || seen.has(agent.id.toLowerCase())) continue;
        seen.add(agent.id.toLowerCase());
        result.push(agent);
      } catch (err) {
        console.warn("[Skills Bridge] Manifiesto de agente inválido:", fullPath, err.message);
      }
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

function getCreatedAgent(agentId) {
  const needle = String(agentId || "").trim().toLowerCase();
  if (!needle) return null;
  return loadCreatedAgents().find((agent) => agent.id.toLowerCase() === needle || agent.slug.toLowerCase() === needle) || null;
}

function createAgentManifest(options = {}) {
  const opts = (options && typeof options === "object") ? options : {};
  const name = String(opts.name || "").trim();
  if (!name) return { ok: false, error: "El nombre del agente es obligatorio" };
  const slug = String(opts.slug || name)
    .toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!slug) return { ok: false, error: "No se pudo generar un identificador para el agente" };
  const profileId = String(opts.profileId || "").trim();
  if (profileId && !findProfileEntry(profileId)) return { ok: false, error: "Perfil cognitivo no encontrado: " + profileId };
  const existing = getCreatedAgent(`agentes/${slug}`);
  if (existing) return { ok: false, error: "Ya existe un agente con ese identificador: " + slug };

  const skillIds = parseSkillIdsList(opts.skillIds || opts.skills || []).slice(0, 32);
  const tools = Array.isArray(opts.tools) ? opts.tools.map((tool) => String(tool || "").trim()).filter((tool, index, list) => AGENT_TOOL_IDS.has(tool) && list.indexOf(tool) === index) : [];
  const rawPermissions = (opts.permissions && typeof opts.permissions === "object") ? opts.permissions : {};
  const permissions = {};
  for (const key of AGENT_PERMISSION_KEYS) permissions[key] = rawPermissions[key] === true;
  const provider = String(opts.modelProvider || (opts.modelPolicy && opts.modelPolicy.provider) || "auto").trim() || "auto";
  const model = String(opts.model || (opts.modelPolicy && opts.modelPolicy.model) || "").trim();
  const now = new Date().toISOString();
  const id = `agentes/${slug}`;
  const manifest = normalizeAgentManifest({
    id, slug, name,
    description: String(opts.description || "").trim().slice(0, 1000),
    profileId, skillIds, tools,
    modelPolicy: { provider, model }, permissions,
    maxSteps: opts.maxSteps, createdAt: now, updatedAt: now
  });

  const dirs = getCreatedAgentsDirs();
  const baseDir = dirs[0];
  if (!baseDir) return { ok: false, error: "No hay un directorio de perfiles disponible" };
  const manifestPath = path.join(baseDir, `${slug}.json`);
  const profilePath = path.join(baseDir, `${slug}.md`);
  if (!isPathInside(baseDir, manifestPath) || !isPathInside(baseDir, profilePath)) return { ok: false, error: "Ruta de agente fuera del directorio permitido" };
  const toolText = tools.length ? tools.join(", ") : "ninguna seleccionada";
  const permissionText = AGENT_PERMISSION_KEYS.filter((key) => permissions[key]).join(", ") || "ninguno";
  const markdown = [
    "---",
    `name: "${name.replace(/"/g, '\\"')}"`,
    `description: "${(manifest.description || `Agente operativo ${name}`).replace(/"/g, '\\"')}"`,
    `vibe: "Agente ejecutor · ${provider}${model ? ` · ${model}` : ""}"`,
    'emoji: "🤖"',
    'color: "cyan"',
    "---", "",
    `# ${name}`, "",
    "## Contrato operativo", "",
    manifest.description || "Convierte la intención del usuario en cambios verificables y ejecuta el siguiente paso.", "",
    `- Perfil cognitivo: ${profileId || "sin perfil"}`,
    `- Skills activas: ${skillIds.join(", ") || "ninguna"}`,
    `- Modelo preferido: ${provider}${model ? ` / ${model}` : ""}`,
    `- Herramientas autorizadas: ${toolText}`,
    `- Permisos concedidos: ${permissionText}`,
    `- Máximo de pasos por tarea: ${manifest.maxSteps}`, "",
    "## Protocolo", "",
    "1. Entiende la intención y declara el objetivo ejecutable.",
    "2. Usa solo las herramientas y permisos concedidos.",
    "3. Ejecuta por pasos pequeños y verifica cada resultado.",
    "4. No declares un cambio terminado sin evidencia de la operación.", ""
  ].join("\n");

  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, manifestPath }, null, 2), "utf8");
    fs.writeFileSync(profilePath, markdown, "utf8");
  } catch (err) {
    try { if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath); } catch (_) {}
    return { ok: false, error: "No se pudo guardar el agente: " + err.message };
  }
  profilesCache = null;
  lastProfilesLoadTime = 0;
  return { ok: true, agent: normalizeAgentManifest({ ...manifest, manifestPath }, manifestPath), profilePath };
}

function deleteCreatedAgent(agentId) {
  const agent = getCreatedAgent(agentId);
  if (!agent || !agent.manifestPath) return { ok: false, error: "Agente no encontrado" };
  const baseDir = path.dirname(agent.manifestPath);
  const profilePath = path.join(baseDir, `${agent.slug}.md`);
  if (!isPathInside(baseDir, agent.manifestPath) || !isPathInside(baseDir, profilePath)) return { ok: false, error: "Ruta de agente no permitida" };
  try {
    if (fs.existsSync(agent.manifestPath)) fs.unlinkSync(agent.manifestPath);
    if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
    profilesCache = null;
    lastProfilesLoadTime = 0;
    return { ok: true, id: agent.id };
  } catch (err) { return { ok: false, error: "No se pudo eliminar: " + err.message }; }
}

function buildAgentSystemPrompt(agent) {
  const a = normalizeAgentManifest(agent);
  if (!a.id) return "";
  const tools = a.tools.length ? a.tools.join(", ") : "ninguna";
  const permissions = AGENT_PERMISSION_KEYS.filter((key) => a.permissions[key]).join(", ") || "ninguno";
  return [
    `--- [AGENTE OPERATIVO ACTIVO: ${a.name.toUpperCase()} · ${a.id}] ---`,
    "No eres solo un asesor: trabaja como agente dentro del alcance autorizado.",
    `Contrato: ${a.description || "convertir la petición en un resultado verificable"}.`,
    `Modelo preferido: ${a.modelPolicy.provider}${a.modelPolicy.model ? ` / ${a.modelPolicy.model}` : ""}.`,
    `Herramientas declaradas: ${tools}. Permisos: ${permissions}. Máximo ${a.maxSteps} pasos.`,
    "Protocolo: entiende, decide el siguiente paso, ejecuta mediante las capacidades disponibles de la aplicación, verifica y reporta evidencia. Si una herramienta no está disponible, dilo y no simules su ejecución.",
    "--- [FIN DE AGENTE OPERATIVO] ---"
  ].join("\n");
}

module.exports = {
  SKILLS_REPO_URL,
  loadBundles,
  getSkillsRoot,
  loadSkillsIndex,
  getCategories,
  searchSkills,
  getSkillContent,
  loadProfiles,
  getProfileContent,
  saveProfileContent,
  createProfileFile,
  parseSkillIdsList,
  buildSkillSystemPrompt,
  saveSkillFusion,
  loadCreatedAgents,
  getCreatedAgent,
  createAgentManifest,
  deleteCreatedAgent,
  buildAgentSystemPrompt,
  SKILLS_ROOT,
  DEFAULT_SKILLS_DIRS
};
