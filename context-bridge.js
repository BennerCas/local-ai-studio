const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const BASE_PROJECTS_DIR = "C:\\antigravityAS";
const BRAIN_DIR = "C:\\Users\\Benner\\.gemini\\antigravity\\brain";
const RESOLVER_PY = path.join(__dirname, "resolver.py");
const CONFIG_FILE = path.join(__dirname, "active_project.json");

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
  try {
    if (!fs.existsSync(BASE_PROJECTS_DIR)) return [];
    const entries = fs.readdirSync(BASE_PROJECTS_DIR, { withFileTypes: true });
    return entries
      .filter(d => d.isDirectory() && !d.name.startsWith(".") && !IGNORED_DIRS.has(d.name))
      .map(d => {
        const fullPath = path.join(BASE_PROJECTS_DIR, d.name);
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
            desc: desc
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
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) || {};
    }
  } catch (e) {}
  return {};
}

function saveStoredConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2), "utf-8");
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
  const cfg = getStoredConfig();
  const key = folderPath ? path.resolve(folderPath).toLowerCase() : "";
  if (cfg.selectedFilesMap && cfg.selectedFilesMap[key]) {
    return cfg.selectedFilesMap[key];
  }
  return cfg.selectedFiles || [];
}

function setSelectedFiles(folderPath, files) {
  const cfg = getStoredConfig();
  if (!cfg.selectedFilesMap) cfg.selectedFilesMap = {};
  const key = folderPath ? path.resolve(folderPath).toLowerCase() : "";
  cfg.selectedFilesMap[key] = Array.isArray(files) ? files : [];
  cfg.selectedFiles = cfg.selectedFilesMap[key];
  return saveStoredConfig(cfg);
}

const CODE_EXTENSIONS = new Set([
  ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".json", 
  ".md", ".yaml", ".yml", ".sql", ".rs", ".go", ".c", ".cpp", ".h", 
  ".sh", ".ps1", ".env.example", ".toml"
]);

function scanProjectFolderDeep(dir, base = "", depth = 0, maxDepth = 4, maxFiles = 80) {
  const results = [];
  if (depth > maxDepth || !fs.existsSync(dir)) return results;

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (results.length >= maxFiles) break;
      if (item.name.startsWith(".") || 
          item.name === "node_modules" || 
          item.name === "dist" || 
          item.name === ".venv" || 
          item.name === "__pycache__" ||
          item.name === "build") {
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
              relPath: relPath,
              fullPath: fullPath,
              size: st.size,
              ext: ext
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

  // Si no se pasaron archivos específicos, seleccionar automáticamente los más representativos
  if (targetFiles.length === 0) {
    const scanned = scanProjectFolderDeep(dirPath, "", 0, 3, 40);
    // Priorizar package.json, main.py, server.js, index.ts/js, README.md, etc.
    const priorityKeywords = ["main.py", "app.py", "server.js", "index.ts", "index.js", "package.json", "requirements.txt", "README.md", "vite.config", "tsconfig.json"];
    const prioritized = [];
    
    for (const kw of priorityKeywords) {
      const match = scanned.find(f => f.relPath.toLowerCase().endsWith(kw.toLowerCase()));
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

    const fullPath = path.isAbsolute(rel) ? rel : path.join(dirPath, rel);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 200000) {
        codeContext += `\n=== Archivo: ${rel} (${(stat.size / 1024).toFixed(1)} KB) ===\n[Archivo demasiado grande para inyectar completo]\n`;
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const budgetRemaining = maxChars - totalChars;
      const snippet = content.length > budgetRemaining ? content.slice(0, budgetRemaining) + "\n[... Contenido truncado por límite de contexto ...]" : content;

      codeContext += `\n=== Archivo: ${rel} ===\n\`\`\`\n${snippet}\n\`\`\`\n`;
      totalChars += snippet.length;
    } catch (e) {}
  }

  return codeContext;
}

function getActiveProject(preferredName = null, convId = null, token = null) {
  // 0. Si el usuario configuró o cargó explícitamente una carpeta de proyecto
  const explicit = getExplicitFolder();
  if (explicit && fs.existsSync(explicit) && (!preferredName || preferredName === "explicit" || preferredName === path.basename(explicit))) {
    const projName = path.basename(explicit);
    return {
      name: projName,
      path: explicit,
      isGeneral: false,
      isExplicit: true,
      mtime: fs.statSync(explicit).mtime
    };
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

  // 1. Si viene un ID de conversación específica o token
  if (targetConvId || token) {
    const resolved = resolveConversationProject(targetConvId, token);
    if (resolved && resolved.projectName) {
      if (resolved.isGeneral || resolved.projectName === "General") {
        return {
          name: resolved.title || "General",
          path: BASE_PROJECTS_DIR,
          convId: resolved.convId || targetConvId,
          isGeneral: true,
          mtime: new Date()
        };
      }
      const found = projects.find(p => p.name.toLowerCase() === resolved.projectName.toLowerCase());
      if (found) return { ...found, convId: resolved.convId, isGeneral: false };
      if (resolved.projectPath && fs.existsSync(resolved.projectPath)) {
        return { name: resolved.projectName, path: resolved.projectPath, convId: resolved.convId, isGeneral: false, mtime: new Date() };
      }
    }
  }

  // 2. Si se pasa un nombre de proyecto preferido
  if (targetProjName) {
    if (targetProjName.toLowerCase() === "general") {
      return { name: "General", path: BASE_PROJECTS_DIR, isGeneral: true, mtime: new Date() };
    }
    const found = projects.find(p => p.name.toLowerCase() === targetProjName.toLowerCase());
    if (found) return { ...found, isGeneral: false };
    const customPath = path.join(BASE_PROJECTS_DIR, targetProjName);
    if (fs.existsSync(customPath)) {
      return { name: targetProjName, path: customPath, isGeneral: false, mtime: new Date() };
    }
  }

  // 3. Revisar selección persistida previa
  const stored = getStoredActiveProjectName();
  if (stored) {
    if (stored.toLowerCase() === "general") {
      return { name: "General", path: BASE_PROJECTS_DIR, isGeneral: true, mtime: new Date() };
    }
    const found = projects.find(p => p.name.toLowerCase() === stored.toLowerCase());
    if (found) return { ...found, isGeneral: false };
  }

  // 4. Default: Entorno General (Cero hardcoding de SynthIA)
  return { name: "General", path: BASE_PROJECTS_DIR, isGeneral: true, mtime: new Date() };
}

function scanProjectFiles(dir, base = "", depth = 0, maxDepth = 2, maxFiles = 45) {
  const results = [];
  if (depth > maxDepth) return results;

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (results.length >= maxFiles) break;
      if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "dist" || item.name === ".venv") continue;
      
      const relPath = base ? `${base}/${item.name}` : item.name;
      if (item.isDirectory()) {
        results.push(relPath + "/");
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
  try {
    let transcriptFile = null;

    if (convId) {
      const p = path.join(BRAIN_DIR, convId, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(p)) transcriptFile = p;
    }

    if (!transcriptFile && fs.existsSync(BRAIN_DIR)) {
      const convs = fs.readdirSync(BRAIN_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "tempmediaStorage")
        .map(d => {
          const t = path.join(BRAIN_DIR, d.name, ".system_generated", "logs", "transcript.jsonl");
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
          let clean = item.content.replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "").trim();
          if (clean && clean.length > 5) userPrompts.push(clean);
        }
      } catch (e) {}
    }
    return userPrompts.slice(-4);
  } catch (e) {
    return [];
  }
}

function buildProjectContext(projectName = null, convId = null, token = null) {
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

  const projectPath = proj.path;
  const files = scanProjectFiles(projectPath);

  let packageInfo = null;
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

  let readmeSnippet = "";
  const readmeFile = path.join(projectPath, "README.md");
  if (fs.existsSync(readmeFile)) {
    try {
      readmeSnippet = fs.readFileSync(readmeFile, "utf-8").slice(0, 800);
    } catch (e) {}
  }

  let pastProgress = "";
  const progressFile = path.join(projectPath, "AVANCES_LOCAL_AI.md");
  if (fs.existsSync(progressFile)) {
    try {
      pastProgress = fs.readFileSync(progressFile, "utf-8").slice(-600);
    } catch (e) {}
  }

  const convInfo = resolveConversationProject(targetConvId, token);
  const recentPrompts = getConversationHistory(targetConvId);

  const selectedFiles = getSelectedFiles(projectPath);
  const codeSnippets = readCodeFilesContext(projectPath, selectedFiles, 24000);

  const isGen = proj.isGeneral || proj.name.toLowerCase() === "general";
  const systemPrompt = `Eres el asistente de IA local y extensión de Antigravity para ${isGen ? "el Entorno General de Trabajo" : `el proyecto "${proj.name}"`}.

<contexto_del_proyecto>
- Entorno: ${proj.name}
- Directorio de Trabajo: ${projectPath}
${convInfo && convInfo.title ? `- Sesión de Antigravity: "${convInfo.title}"` : ""}
${packageInfo ? `- Scripts disponibles: ${packageInfo.scripts.join(", ")}
- Dependencias clave: ${packageInfo.dependencies.slice(0, 10).join(", ")}` : ""}
- Archivos en el Espacio de Trabajo:
${files.slice(0, 35).map(f => `  • ${f}`).join("\n")}
${readmeSnippet ? `\n- Descripción / README:\n${readmeSnippet.slice(0, 300)}...` : ""}
${recentPrompts.length ? `\n- Tareas recientes abordadas en Antigravity:\n${recentPrompts.map(p => `  > "${p.slice(0, 120)}"`).join("\n")}` : ""}
${pastProgress ? `\n- Últimos avances registrados por IA local:\n${pastProgress}` : ""}
</contexto_del_proyecto>

<codigo_fuente_del_proyecto>
${codeSnippets || "No se han seleccionado archivos de código fuente específicos aún."}
</codigo_fuente_del_proyecto>

DIRECTIVAS Y CAPACIDADES DE MUTACIÓN DE CÓDIGO (CREAR Y EDITAR ARCHIVOS):
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
<<<<<<< SEARCH
def fetch_data():
    return {}
=======
def fetch_data():
    response = requests.get("https://api.example.com")
    return response.json()
>>>>>>>
\`\`\`

3. REGLAS DE EJECUCIÓN:
- Utiliza la arquitectura y código provisto en <codigo_fuente_del_proyecto> para adaptar tus cambios al avance exacto.
- La interfaz de Local AI Studio procesará estos bloques automáticamente para que el usuario pueda aplicarlos al disco con un clic o en modo auto-aplicación directa.
- Siempre responde con explicaciones técnicas concisas en español.`;

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

  try {
    const ctxOut = path.join(projectPath, "PROJECT_CONTEXT.md");
    fs.writeFileSync(ctxOut, summaryMarkdown, "utf-8");

    const owuDir = "C:\\antigravityAS\\OpenWebUI\\data";
    if (fs.existsSync(owuDir)) {
      fs.writeFileSync(path.join(owuDir, "PROJECT_CONTEXT_CURRENT.md"), summaryMarkdown, "utf-8");
    }
  } catch (e) {}

  return {
    project: proj,
    files: files,
    selectedFiles: selectedFiles,
    codeSnippets: codeSnippets,
    packageInfo: packageInfo,
    recentPrompts: recentPrompts,
    systemPrompt: systemPrompt,
    summaryMarkdown: summaryMarkdown,
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

function saveProjectFile(projectName, relPath, content) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const cleanRelPath = relPath.replace(/^[\/\\]+/, "");
    const fullPath = path.join(proj.path, cleanRelPath);
    const parentDir = path.dirname(fullPath);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content, "utf-8");

    recordProjectProgress(proj.name, {
      tool: "Guardado Directo de Archivo",
      task: `Actualización de ${cleanRelPath}`,
      summary: `Archivo ${cleanRelPath} guardado desde Local AI (${content.length} bytes)`,
      filesModified: [cleanRelPath]
    });

    return { ok: true, path: fullPath, size: content.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function readProjectFile(projectName, relPath) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };
    const cleanRelPath = relPath.replace(/^[\/\\]+/, "");
    const fullPath = path.join(proj.path, cleanRelPath);
    if (!fs.existsSync(fullPath)) return { ok: false, error: `El archivo ${cleanRelPath} no existe en el proyecto.` };
    const content = fs.readFileSync(fullPath, "utf-8");
    const st = fs.statSync(fullPath);
    return { ok: true, path: fullPath, content: content, size: st.size, mtime: st.mtime };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function applyProjectPatch(projectName, relPath, searchBlock, replaceBlock) {
  try {
    const proj = getActiveProject(projectName);
    if (!proj) return { ok: false, error: "Proyecto no encontrado" };

    const cleanRelPath = relPath.replace(/^[\/\\]+/, "");
    const fullPath = path.join(proj.path, cleanRelPath);

    if (!fs.existsSync(fullPath)) {
      return { ok: false, error: `El archivo ${cleanRelPath} no existe para aplicar parche. Considera usar write:${cleanRelPath} para crearlo.` };
    }

    let fileContent = fs.readFileSync(fullPath, "utf-8");
    const normFile = fileContent.replace(/\r\n/g, "\n");
    const normSearch = searchBlock.replace(/\r\n/g, "\n").trim();
    const normReplace = replaceBlock.replace(/\r\n/g, "\n");

    let matchIndex = normFile.indexOf(normSearch);

    if (matchIndex === -1) {
      // Búsqueda flexible por líneas ignorando espacios en blanco perimétricos
      const fileLines = normFile.split("\n");
      const searchLines = normSearch.split("\n").map(l => l.trim()).filter(Boolean);

      let foundStart = -1;
      for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        let allMatch = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (fileLines[i + j].trim() !== searchLines[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          foundStart = i;
          break;
        }
      }

      if (foundStart !== -1) {
        fileLines.splice(foundStart, searchLines.length, normReplace);
        fileContent = fileLines.join("\n");
      } else {
        return { ok: false, error: `No se encontró el bloque a reemplazar (SEARCH) en ${cleanRelPath}.` };
      }
    } else {
      fileContent = normFile.replace(normSearch, normReplace);
    }

    fs.writeFileSync(fullPath, fileContent, "utf-8");

    recordProjectProgress(proj.name, {
      tool: "Edición Quirúrgica (Patch)",
      task: `Modificación de ${cleanRelPath}`,
      summary: `Bloque de código modificado exitosamente en ${cleanRelPath} (${fileContent.length} bytes)`,
      filesModified: [cleanRelPath]
    });

    return { ok: true, path: fullPath, size: fileContent.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  getSidebarHierarchy,
  listProjects,
  getActiveProject,
  setActiveProjectName,
  getExplicitFolder,
  setExplicitFolder,
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
