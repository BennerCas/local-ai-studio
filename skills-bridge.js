const fs = require("node:fs");
const path = require("node:path");

const SKILLS_ROOT = "C:\\antigravityAS\\antigravity-awesome-skills";
const DEFAULT_SKILLS_DIRS = [
  "C:\\antigravityAS\\Modelos -ai-brains\\antigravity-awesome-skills",
  "C:\\antigravityAS\\Modelos-ai-brains\\antigravity-awesome-skills",
  "C:\\antigravityAS\\antigravity-awesome-skills"
];
const DEFAULT_SKILLS_BACKUP_DIR = "C:\\antigravityAS\\Skills_Backup";
const DEFAULT_PROFILES_DIRS = [
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
    skillsCache = Array.isArray(parsed) ? parsed : [];
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
      profiles.push({
        id,
        slug,
        name: meta.name || slug,
        category,
        description: meta.description || "",
        vibe: meta.vibe || "",
        emoji: meta.emoji || "",
        color: meta.color || "",
        relPath: f.relPath,
        fullPath: f.fullPath
      });
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
  if (!entry || !entry.fullPath) return null;

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

module.exports = {
  loadSkillsIndex,
  getCategories,
  searchSkills,
  getSkillContent,
  loadProfiles,
  getProfileContent,
  parseSkillIdsList,
  buildSkillSystemPrompt,
  saveSkillFusion,
  SKILLS_ROOT,
  DEFAULT_SKILLS_DIRS
};
