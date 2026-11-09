const fs = require("node:fs");
const path = require("node:path");

const SKILLS_ROOT = "C:\\antigravityAS\\antigravity-awesome-skills";
const INDEX_PATH = path.join(SKILLS_ROOT, "skills_index.json");
const SKILLS_DIR = path.join(SKILLS_ROOT, "skills");

let skillsCache = null;
let lastLoadTime = 0;

function loadSkillsIndex() {
  const now = Date.now();
  if (skillsCache && (now - lastLoadTime < 60000)) {
    return skillsCache;
  }

  try {
    if (!fs.existsSync(INDEX_PATH)) {
      console.warn("[Skills Bridge] Index file not found:", INDEX_PATH);
      return [];
    }
    const raw = fs.readFileSync(INDEX_PATH, "utf8");
    skillsCache = JSON.parse(raw);
    lastLoadTime = now;
    return skillsCache;
  } catch (err) {
    console.error("[Skills Bridge] Error reading skills_index.json:", err.message);
    return skillsCache || [];
  }
}

function getCategories() {
  const all = loadSkillsIndex();
  const cats = new Set();
  all.forEach(s => {
    if (s.category) cats.add(s.category);
  });
  return Array.from(cats).sort();
}

function searchSkills(query = "", category = "", limit = 100) {
  const all = loadSkillsIndex();
  let filtered = all;

  if (category && category !== "all") {
    filtered = filtered.filter(s => s.category === category);
  }

  if (query && query.trim()) {
    const q = query.toLowerCase().trim();
    filtered = filtered.filter(s => 
      (s.name && s.name.toLowerCase().includes(q)) ||
      (s.id && s.id.toLowerCase().includes(q)) ||
      (s.description && s.description.toLowerCase().includes(q))
    );
  }

  return filtered.slice(0, limit).map(s => ({
    id: s.id,
    name: s.name || s.id,
    category: s.category || "general",
    description: s.description || "",
    risk: s.risk || "safe"
  }));
}

function getSkillContent(skillId) {
  if (!skillId) return null;
  const safeId = path.basename(skillId);
  const skillFile = path.join(SKILLS_DIR, safeId, "SKILL.md");

  try {
    if (fs.existsSync(skillFile)) {
      return fs.readFileSync(skillFile, "utf8");
    }
  } catch (err) {
    console.warn(`[Skills Bridge] Error reading skill ${skillId}:`, err.message);
  }
  return null;
}

function buildSkillSystemPrompt(skillId) {
  if (!skillId) return "";
  const content = getSkillContent(skillId);
  if (!content) return "";

  // Limitar longitud en un corte seguro de línea para no cortar pares de surrogados unicode
  let safeContent = content;
  if (safeContent.length > 6000) {
    const cutIdx = safeContent.lastIndexOf("\n", 6000);
    safeContent = safeContent.slice(0, cutIdx > 0 ? cutIdx : 6000);
  }

  return `\n\n--- [HABILIDAD ACTIVA: ${skillId.toUpperCase()}] ---\n` +
         `Debes asumir de forma estricta el rol, estándares, directrices y mejores prácticas definidos en esta habilidad:\n\n` +
         `${safeContent}\n` +
         `--- [FIN DE HABILIDAD] ---\n`;
}

module.exports = {
  loadSkillsIndex,
  getCategories,
  searchSkills,
  getSkillContent,
  buildSkillSystemPrompt,
  SKILLS_ROOT
};
