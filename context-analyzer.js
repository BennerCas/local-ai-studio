const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const contextBridge = require("./context-bridge.js");
const memoryStore = require("./memory-store.js");
const skillsBridge = require("./skills-bridge.js");

const DEFAULT_BRAIN_DIR = "C:\\Users\\Benner\\.gemini\\antigravity\\brain";

function getBrainDir() {
  const override = process.env.LOCAL_AI_BRAIN_DIR;
  return (override && String(override).trim()) ? path.resolve(String(override).trim()) : DEFAULT_BRAIN_DIR;
}

function runGitArgs(projectPath, args, timeout = 3000) {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      encoding: "utf8",
      timeout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (err) {
    return null;
  }
}

function sanitizeGitRemoteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let cleaned = rawUrl.trim();
  if (!cleaned) return "";

  try {
    if (/^(https?|ssh|git):\/\//i.test(cleaned)) {
      const parsed = new URL(cleaned);
      if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
      }
      cleaned = parsed.toString();
    }
  } catch (e) {
    cleaned = cleaned.replace(/:\/\/[^/@\s]+@/g, "://");
  }

  // Defensa adicional contra tokens embebidos en URLs no estándar
  cleaned = cleaned
    .replace(/x-access-token:[^@\s]+@/gi, "")
    .replace(/oauth2:[^@\s]+@/gi, "")
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, "[REDACTED]")
    .replace(/\bhf_[A-Za-z0-9]+\b/g, "[REDACTED]");

  return cleaned;
}

function collectGitTelemetry(projectPath) {
  const empty = {
    isGitRepo: false,
    branch: "",
    remoteOrigin: "",
    statusLines: [],
    recentCommits: [],
    diffStat: ""
  };

  if (!projectPath || !fs.existsSync(projectPath)) return empty;

  const inside = runGitArgs(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") return empty;

  const branch = runGitArgs(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"]) || "";
  const rawRemote = runGitArgs(projectPath, ["remote", "get-url", "origin"]) || "";
  const remoteOrigin = sanitizeGitRemoteUrl(rawRemote);

  const rawStatus = runGitArgs(projectPath, ["status", "--porcelain"]);
  const statusLines = rawStatus
    ? rawStatus.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(0, 50)
    : [];

  const rawLog = runGitArgs(projectPath, ["log", "-n", "6", "--pretty=format:%h|%an|%ad|%s", "--date=short"]);
  const recentCommits = rawLog
    ? rawLog.split(/\r?\n/).filter(Boolean).map((line) => {
        const parts = line.split("|");
        return {
          hash: parts[0] || "",
          author: parts[1] || "",
          date: parts[2] || "",
          message: parts.slice(3).join("|") || ""
        };
      })
    : [];

  const unstagedStat = runGitArgs(projectPath, ["diff", "--stat"]) || "";
  const stagedStat = runGitArgs(projectPath, ["diff", "--cached", "--stat"]) || "";
  const diffStat = [unstagedStat, stagedStat ? `[staged]\n${stagedStat}` : ""]
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    isGitRepo: true,
    branch,
    remoteOrigin,
    statusLines,
    recentCommits,
    diffStat
  };
}

function detectManifests(projectPath) {
  const detected = [];
  const details = {};
  if (!projectPath || !fs.existsSync(projectPath)) {
    return { detected, details };
  }

  // 1. package.json (Node.js)
  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    detected.push("package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      details["package.json"] = {
        name: pkg.name || "",
        version: pkg.version || "",
        scripts: pkg.scripts ? Object.keys(pkg.scripts) : [],
        dependencies: pkg.dependencies ? Object.keys(pkg.dependencies) : [],
        devDependencies: pkg.devDependencies ? Object.keys(pkg.devDependencies) : []
      };
    } catch (e) {
      details["package.json"] = { parseError: e.message };
    }
  }

  // 2. requirements.txt (Python)
  const reqPath = path.join(projectPath, "requirements.txt");
  if (fs.existsSync(reqPath)) {
    detected.push("requirements.txt");
    try {
      const lines = fs.readFileSync(reqPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      details["requirements.txt"] = {
        count: lines.length,
        packages: lines.slice(0, 25)
      };
    } catch (e) {}
  }

  // 3. pyproject.toml (Python)
  const pyprojPath = path.join(projectPath, "pyproject.toml");
  if (fs.existsSync(pyprojPath)) {
    detected.push("pyproject.toml");
    try {
      const raw = fs.readFileSync(pyprojPath, "utf8");
      const nameMatch = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      const verMatch = raw.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      details["pyproject.toml"] = {
        name: nameMatch ? nameMatch[1] : "",
        version: verMatch ? verMatch[1] : "",
        excerpt: raw.slice(0, 500)
      };
    } catch (e) {}
  }

  // 4. Cargo.toml (Rust)
  const cargoPath = path.join(projectPath, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    detected.push("Cargo.toml");
    try {
      const raw = fs.readFileSync(cargoPath, "utf8");
      const nameMatch = raw.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      const verMatch = raw.match(/^\s*version\s*=\s*["']([^"']+)["']/m);
      details["Cargo.toml"] = {
        name: nameMatch ? nameMatch[1] : "",
        version: verMatch ? verMatch[1] : "",
        excerpt: raw.slice(0, 500)
      };
    } catch (e) {}
  }

  // 5. go.mod (Go)
  const goModPath = path.join(projectPath, "go.mod");
  if (fs.existsSync(goModPath)) {
    detected.push("go.mod");
    try {
      const raw = fs.readFileSync(goModPath, "utf8");
      const modMatch = raw.match(/^\s*module\s+(\S+)/m);
      const goMatch = raw.match(/^\s*go\s+(\S+)/m);
      details["go.mod"] = {
        module: modMatch ? modMatch[1] : "",
        goVersion: goMatch ? goMatch[1] : "",
        excerpt: raw.slice(0, 500)
      };
    } catch (e) {}
  }

  return { detected, details };
}

function readCleanAvancesEntries(projectPath, maxChars = 3500) {
  if (!projectPath) return "";
  const filePath = path.join(projectPath, "AVANCES_LOCAL_AI.md");
  if (!fs.existsSync(filePath)) return "";

  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    if (raw.length <= maxChars) return raw.trim();

    const startOffset = raw.length - maxChars;
    const tail = raw.slice(startOffset);

    if (tail.startsWith("## [")) {
      return tail.trim();
    }

    const entryBoundary = tail.indexOf("\n## [");
    if (entryBoundary !== -1) {
      return tail.slice(entryBoundary + 1).trim();
    }

    const nlIdx = tail.indexOf("\n");
    return (nlIdx !== -1 ? tail.slice(nlIdx + 1) : tail).trim();
  } catch (e) {
    return "";
  }
}

function parseMarkdownChecklist(content) {
  const pending = [];
  const inProgress = [];
  const completed = [];

  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+\.)\s*\[( |\/|x|X)\]\s*(.+)$/);
    if (!m) continue;
    const mark = m[1];
    const text = m[2].trim();
    if (mark === " ") {
      pending.push(text);
    } else if (mark === "/") {
      inProgress.push(text);
    } else {
      completed.push(text);
    }
  }

  return {
    counts: {
      pending: pending.length,
      inProgress: inProgress.length,
      completed: completed.length
    },
    pending: pending.slice(0, 25),
    inProgress: inProgress.slice(0, 15),
    completed: completed.slice(0, 15)
  };
}

function readTranscriptTurns(transcriptPath, maxTurns = 6) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
    const tailLines = lines.slice(-60);
    const turns = [];

    for (const line of tailLines) {
      try {
        const item = JSON.parse(line);
        if (!item || !item.content) continue;
        if (item.type === "USER_INPUT" || item.type === "PLANNER_RESPONSE") {
          const clean = String(item.content)
            .replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (clean.length > 3) {
            turns.push({
              role: item.type === "USER_INPUT" ? "user" : "assistant",
              timestamp: item.created_at || "",
              excerpt: clean.slice(0, 260)
            });
          }
        }
      } catch (_) {}
    }

    return turns.slice(-maxTurns);
  } catch (e) {
    return [];
  }
}

function inspectBrainArtifacts(convId) {
  const result = {
    convId: convId || "",
    available: false,
    artifacts: {},
    checklistSummary: { pending: 0, inProgress: 0, completed: 0 },
    recentTurns: []
  };

  if (!convId || typeof convId !== "string") return result;
  const safeConvId = path.basename(convId.trim());
  if (!safeConvId || safeConvId === "." || safeConvId === "..") return result;

  const brainDir = getBrainDir();
  const convDir = path.join(brainDir, safeConvId);
  if (!fs.existsSync(convDir)) return result;

  result.available = true;
  const artifactNames = ["task.md", "implementation_plan.md", "walkthrough.md"];

  for (const name of artifactNames) {
    const filePath = path.join(convDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const checklist = parseMarkdownChecklist(content);
      result.checklistSummary.pending += checklist.counts.pending;
      result.checklistSummary.inProgress += checklist.counts.inProgress;
      result.checklistSummary.completed += checklist.counts.completed;
      result.artifacts[name] = {
        exists: true,
        sizeBytes: Buffer.byteLength(content, "utf8"),
        checklist,
        excerpt: content.slice(0, 800)
      };
    } catch (_) {}
  }

  const transcriptPath = path.join(convDir, ".system_generated", "logs", "transcript.jsonl");
  result.recentTurns = readTranscriptTurns(transcriptPath, 6);

  return result;
}

function scanTodoMarkers(projectPath, maxFilesToScan = 15, maxMarkers = 30) {
  const markers = [];
  if (!projectPath || !fs.existsSync(projectPath)) return markers;

  const scanned = contextBridge.scanProjectFolderDeep(projectPath, "", 0, 3, 50);
  const codeFiles = scanned.filter((f) => {
    const relLower = f.relPath.toLowerCase();
    if (relLower.startsWith("biblioteca/") || relLower.startsWith("backups/")) return false;
    if (relLower === "avances_local_ai.md" || relLower === "project_context.md") return false;
    return f.size > 0 && f.size <= 100000;
  }).slice(0, maxFilesToScan);

  for (const file of codeFiles) {
    if (markers.length >= maxMarkers) break;
    try {
      const content = fs.readFileSync(file.fullPath, "utf8");
      const lines = content.split(/\r?\n/);
      for (let idx = 0; idx < lines.length; idx++) {
        if (markers.length >= maxMarkers) break;
        const lineText = lines[idx];
        const match = lineText.match(/(?:\/\/|#|\/\*|--|\*|\b)\s*(TODO|FIXME)\b[:\s-]*(.*)$/);
        if (match) {
          markers.push({
            file: file.relPath,
            line: idx + 1,
            tag: match[1].toUpperCase(),
            text: (match[2] || lineText).trim().slice(0, 180)
          });
        }
      }
    } catch (_) {}
  }

  return markers;
}

function collectDeepTelemetry(projectName = null, convId = null, token = null) {
  const proj = contextBridge.getActiveProject(projectName, convId, token);
  const effectiveConvId = convId || (proj && proj.convId) || null;
  const projectPath = proj ? proj.path : "";
  const isGeneral = Boolean(!proj || proj.isGeneral || proj.name.toLowerCase() === "general");

  const git = isGeneral ? collectGitTelemetry(null) : collectGitTelemetry(projectPath);
  const manifests = isGeneral ? { detected: [], details: {} } : detectManifests(projectPath);
  const avancesTail = readCleanAvancesEntries(projectPath, 3500);
  const brain = inspectBrainArtifacts(effectiveConvId);

  const stateKey = isGeneral ? "General" : (projectPath || proj.name);
  const projectState = memoryStore.getProjectState(stateKey);
  const recentChanges = memoryStore.listChanges(proj ? proj.name : null, 8);
  const recentChats = memoryStore.listChats({ project: proj ? proj.name : undefined }).slice(0, 5);
  const todoMarkers = isGeneral ? [] : scanTodoMarkers(projectPath, 15, 30);

  return {
    collectedAt: new Date().toISOString(),
    project: proj || { name: "General", path: "", isGeneral: true },
    git,
    manifests,
    avancesTail,
    brain,
    projectState,
    recentChanges,
    recentChats,
    todoMarkers
  };
}

function formatTelemetryDigestMarkdown(telemetry) {
  const p = telemetry.project || { name: "General", path: "" };
  const git = telemetry.git || {};
  const lines = [];

  lines.push(`# Diagnóstico Profundo de Contexto: ${p.name}`);
  lines.push(`- **Ruta:** \`${p.path || "N/A"}\``);
  lines.push(`- **Fecha de Telemetría:** ${telemetry.collectedAt}`);
  lines.push("");

  lines.push("## Estado Git");
  if (git.isGitRepo) {
    lines.push(`- **Rama activa:** \`${git.branch || "desconocida"}\``);
    if (git.remoteOrigin) lines.push(`- **Remote origin:** \`${git.remoteOrigin}\``);
    lines.push(`- **Archivos modificados/sin seguimiento (${git.statusLines.length}):**`);
    if (git.statusLines.length > 0) {
      git.statusLines.slice(0, 20).forEach((s) => lines.push(`  - \`${s}\``));
    } else {
      lines.push("  - Working tree limpio.");
    }
    if (git.recentCommits && git.recentCommits.length > 0) {
      lines.push("- **Commits recientes:**");
      git.recentCommits.forEach((c) => lines.push(`  - \`${c.hash}\` (${c.date}) ${c.author}: ${c.message}`));
    }
    if (git.diffStat) {
      lines.push("- **Diff stat:**");
      lines.push("```");
      lines.push(git.diffStat.slice(0, 1200));
      lines.push("```");
    }
  } else {
    lines.push("- No es un repositorio Git o no se detectó `.git`.");
  }
  lines.push("");

  lines.push("## Manifiestos y Stack Detectado");
  if (telemetry.manifests && telemetry.manifests.detected.length > 0) {
    lines.push(`- **Detectados:** ${telemetry.manifests.detected.join(", ")}`);
    for (const [name, info] of Object.entries(telemetry.manifests.details || {})) {
      lines.push(`- **${name}:** ${JSON.stringify(info).slice(0, 400)}`);
    }
  } else {
    lines.push("- Sin manifiestos de dependencias en la raíz.");
  }
  lines.push("");

  lines.push("## Artefactos Antigravity y Checklists");
  if (telemetry.brain && telemetry.brain.available) {
    const cs = telemetry.brain.checklistSummary;
    lines.push(`- **Conversación ID:** \`${telemetry.brain.convId}\``);
    lines.push(`- **Resumen Checklists:** Pendientes=${cs.pending}, En progreso=${cs.inProgress}, Completadas=${cs.completed}`);
    for (const [artName, art] of Object.entries(telemetry.brain.artifacts || {})) {
      lines.push(`- **${artName}:** pendientes=${art.checklist.counts.pending}, en_progreso=${art.checklist.counts.inProgress}, completadas=${art.checklist.counts.completed}`);
      art.checklist.inProgress.slice(0, 5).forEach((t) => lines.push(`  - [/] ${t}`));
      art.checklist.pending.slice(0, 8).forEach((t) => lines.push(`  - [ ] ${t}`));
    }
    if (telemetry.brain.recentTurns && telemetry.brain.recentTurns.length > 0) {
      lines.push("- **Últimos turnos en transcript:**");
      telemetry.brain.recentTurns.forEach((t) => lines.push(`  - [${t.role}] ${t.excerpt}`));
    }
  } else {
    lines.push("- No se detectaron artefactos de Antigravity para la conversación activa.");
  }
  lines.push("");

  lines.push("## Últimos Avances (`AVANCES_LOCAL_AI.md`)");
  if (telemetry.avancesTail) {
    lines.push(telemetry.avancesTail);
  } else {
    lines.push("- Sin registros previos en `AVANCES_LOCAL_AI.md`.");
  }
  lines.push("");

  lines.push("## Memoria Persistida (Estado, Cambios y Chats)");
  const st = telemetry.projectState || {};
  lines.push(`- **Integraciones:** GitHub=${st.githubToggle ? "ON" : "OFF"} (${st.githubRepo || "sin repo"}) | Netlify=${st.netlifyToggle ? "ON" : "OFF"} (${st.netlifySite || "sin sitio"})`);
  if (telemetry.recentChanges && telemetry.recentChanges.length > 0) {
    lines.push("- **Últimos cambios guardados:**");
    telemetry.recentChanges.forEach((c) => lines.push(`  - [${c.timestamp}] ${c.action} \`${c.relPath}\` (${c.model}) — ${c.summary}`));
  }
  if (telemetry.recentChats && telemetry.recentChats.length > 0) {
    lines.push("- **Sesiones de chat recientes:**");
    telemetry.recentChats.forEach((ch) => lines.push(`  - "${ch.title}" (${ch.model || "N/A"}, ${ch.messageCount || 0} msgs, ${ch.updatedAt})`));
  }
  lines.push("");

  lines.push("## Marcadores TODO / FIXME en Código");
  if (telemetry.todoMarkers && telemetry.todoMarkers.length > 0) {
    telemetry.todoMarkers.forEach((m) => lines.push(`- \`${m.file}:${m.line}\` **${m.tag}**: ${m.text}`));
  } else {
    lines.push("- Sin marcadores TODO/FIXME encontrados en los archivos escaneados.");
  }

  return lines.join("\n");
}

function buildEnterContextPayload({
  projectName = null,
  convId = null,
  token = null,
  skillId = null,
  profileId = null,
  customSystemPrompt = null
} = {}) {
  const telemetry = collectDeepTelemetry(projectName, convId, token);
  const digestMarkdown = formatTelemetryDigestMarkdown(telemetry);

  const projName = (telemetry.project && telemetry.project.name) || projectName || "General";
  const masterCfg = memoryStore.getMasterPromptConfig(projName);
  const analyzerBasePrompt = masterCfg.contextAnalyzerPrompt || memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT;

  const skillPrompt = (skillId || profileId)
    ? skillsBridge.buildSkillSystemPrompt(skillId, profileId).trim()
    : "";

  const sysParts = [analyzerBasePrompt];
  if (skillPrompt) sysParts.push(skillPrompt);
  if (customSystemPrompt && String(customSystemPrompt).trim()) {
    sysParts.push(`### Directivas Adicionales de Sesión:\n${String(customSystemPrompt).trim()}`);
  }
  const systemPrompt = sysParts.join("\n\n");

  const projectFilesSample = telemetry.project && telemetry.project.path
    ? contextBridge.scanProjectFiles(telemetry.project.path).slice(0, 35)
    : [];

  const userPrompt = [
    `Analiza el estado real y la continuidad del proyecto "${projName}" usando exclusivamente la telemetría verificada adjunta.`,
    "",
    "<telemetria_verificada>",
    digestMarkdown,
    projectFilesSample.length > 0 ? `\n## Estructura Prioritaria de Archivos\n${projectFilesSample.map((f) => `- ${f}`).join("\n")}` : "",
    "</telemetria_verificada>",
    "",
    "Ejecuta primero tu razonamiento en <thinking>...</thinking> y luego entrega exactamente las 4 secciones obligatorias: Estado Actual Verificado, Procesos Inconclusos y Riesgos, Lista de Tareas Pendientes, y Plan de Acción Recomendado."
  ].filter(Boolean).join("\n");

  const metrics = {
    digestChars: digestMarkdown.length,
    systemPromptChars: systemPrompt.length,
    userPromptChars: userPrompt.length,
    totalChars: systemPrompt.length + userPrompt.length,
    approxTokens: contextBridge.estimateApproxTokens(systemPrompt.length + userPrompt.length)
  };

  const directmlCompatibility = contextBridge.evaluateDirectmlPromptCompatibility({
    totalChars: metrics.totalChars,
    approxTokens: metrics.approxTokens,
    bySection: {
      systemPrompt: metrics.systemPromptChars,
      userPrompt: metrics.userPromptChars
    },
    projectName: projName,
    isGeneral: Boolean(telemetry.project && telemetry.project.isGeneral)
  });

  return {
    telemetry,
    digestMarkdown,
    promptPackage: {
      systemPrompt,
      userPrompt,
      metrics,
      directmlCompatibility
    }
  };
}

module.exports = {
  sanitizeGitRemoteUrl,
  collectDeepTelemetry,
  buildEnterContextPayload
};
