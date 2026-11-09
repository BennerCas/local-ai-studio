const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const envLoader = require("./env-loader.js");

const execFileAsync = promisify(execFile);

const DEFAULT_MODELS_DIR = "C:\\antigravityAS\\Modelos -ai-brains";
const HF_DOWNLOADER_PY = path.join(__dirname, "hf_downloader.py");
const MEMORY_STORE_PATH = path.join(__dirname, "memory-store.js");
const CACHE_TTL_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 15000;

const SAFE_GITIGNORE_ENTRIES = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "*.log",
  "node_modules/",
  ".venv/",
  "__pycache__/"
];

// ---------------------------------------------------------------------------
// Tolerant memory-store loader (works both standalone and with memory-store.js)
// ---------------------------------------------------------------------------
let cachedMemoryStore = null;
let usingFallbackStore = false;

const fallbackMemoryState = {
  downloads: new Map(),
  changes: [],
  projectStates: new Map()
};

function createFallbackMemoryStore() {
  return {
    listDownloads(filter = {}) {
      let rows = Array.from(fallbackMemoryState.downloads.values());
      if (filter && filter.status) {
        rows = rows.filter(r => r.status === filter.status);
      }
      return rows.sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    },
    getDownload(jobId) {
      return fallbackMemoryState.downloads.get(jobId) || null;
    },
    upsertDownload(record) {
      if (!record || !record.id) return null;
      const existing = fallbackMemoryState.downloads.get(record.id) || {};
      const merged = { ...existing, ...record, updatedAt: record.updatedAt || new Date().toISOString() };
      fallbackMemoryState.downloads.set(record.id, merged);
      return merged;
    },
    recordChange(entry) {
      const item = { id: `chg_${Date.now()}`, timestamp: new Date().toISOString(), ...entry };
      fallbackMemoryState.changes.unshift(item);
      if (fallbackMemoryState.changes.length > 500) fallbackMemoryState.changes.length = 500;
      return item;
    },
    getProjectState(projectKey) {
      return fallbackMemoryState.projectStates.get(projectKey) || null;
    },
    updateProjectState(projectKey, patch) {
      if (!projectKey) return null;
      const existing = fallbackMemoryState.projectStates.get(projectKey) || {};
      const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      fallbackMemoryState.projectStates.set(projectKey, merged);
      return merged;
    }
  };
}

function getMemoryStore() {
  if (cachedMemoryStore && !usingFallbackStore) {
    return cachedMemoryStore;
  }
  if (fs.existsSync(MEMORY_STORE_PATH)) {
    try {
      const mod = require(MEMORY_STORE_PATH);
      if (mod && typeof mod === "object") {
        cachedMemoryStore = mod;
        usingFallbackStore = false;
        return cachedMemoryStore;
      }
    } catch (_err) {
      // If memory-store.js is currently being written/edited, fall back safely.
    }
  }
  if (!cachedMemoryStore) {
    cachedMemoryStore = createFallbackMemoryStore();
    usingFallbackStore = true;
  }
  return cachedMemoryStore;
}

function safeCallStore(methodName, ...args) {
  try {
    const store = getMemoryStore();
    const fn = store && store[methodName];
    if (typeof fn === "function") {
      return fn.apply(store, args);
    }
  } catch (_err) {
    // Non-fatal telemetry guard
  }
  return null;
}

// ---------------------------------------------------------------------------
// Zero-Trust secret sanitization & validation helpers
// ---------------------------------------------------------------------------
function collectKnownSecrets(extraSecrets = []) {
  const list = [];
  for (const s of extraSecrets) {
    if (typeof s === "string" && s.trim().length >= 4) {
      list.push(s.trim());
    }
  }
  try {
    const gh = envLoader.getGithubToken();
    const nf = envLoader.getNetlifyToken();
    const hf = envLoader.getHfToken();
    for (const t of [gh, nf, hf]) {
      if (t && t.trim().length >= 4) {
        list.push(t.trim());
        list.push(Buffer.from(`x-access-token:${t.trim()}`, "utf8").toString("base64"));
      }
    }
  } catch (_e) {}
  return Array.from(new Set(list)).sort((a, b) => b.length - a.length);
}

function sanitizeSecrets(input, extraSecrets = []) {
  let text = "";
  if (input instanceof Error) {
    text = input.message || String(input);
  } else if (typeof input === "string") {
    text = input;
  } else if (input != null) {
    text = String(input);
  }
  if (!text) return "";

  const secrets = collectKnownSecrets(extraSecrets);
  for (const secret of secrets) {
    if (secret && text.includes(secret)) {
      text = text.split(secret).join("[REDACTED]");
    }
  }

  // Scrub common token prefixes and auth header encodings
  text = text.replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{6,}\b/g, "[REDACTED]");
  text = text.replace(/\bhf_[A-Za-z0-9]{8,}\b/g, "[REDACTED]");
  text = text.replace(/\bnfp_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]");
  text = text.replace(/(authorization\s*[:=]\s*(?:basic|bearer|token)\s+)[A-Za-z0-9+/=._-]+/gi, "$1[REDACTED]");
  text = text.replace(/(http\.https:\/\/[^=]+=\s*AUTHORIZATION:\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1[REDACTED]");
  text = text.replace(/(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, "$1[REDACTED]@");
  return text;
}

function sanitizeGitRemoteUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      return sanitizeSecrets(parsed.toString());
    } catch (_err) {
      return sanitizeSecrets(trimmed.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1"));
    }
  }

  return sanitizeSecrets(trimmed);
}

function parseGitHubRepoFromRemote(remoteUrl) {
  const clean = sanitizeGitRemoteUrl(remoteUrl);
  if (!clean) return null;

  const httpsMatch = clean.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (httpsMatch) {
    return {
      owner: httpsMatch[1],
      repo: httpsMatch[2],
      fullName: `${httpsMatch[1]}/${httpsMatch[2]}`
    };
  }

  const sshMatch = clean.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
      fullName: `${sshMatch[1]}/${sshMatch[2]}`
    };
  }

  return null;
}

async function fetchJson(url, options = {}) {
  const { headers = {}, method = "GET", body = undefined, timeoutMs = HTTP_TIMEOUT_MS, secrets = [] } = options;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "User-Agent": "Local-AI-Studio-Antigravity/1.0",
        ...headers
      },
      body,
      signal: AbortSignal.timeout(timeoutMs)
    });

    const rawText = await res.text();
    let data = null;
    if (rawText) {
      try {
        data = JSON.parse(rawText);
      } catch (_e) {
        data = rawText;
      }
    }

    if (!res.ok) {
      const detail =
        (data && typeof data === "object" && (data.message || data.error || data.error_description)) ||
        (typeof data === "string" ? data : `HTTP ${res.status}`);
      const err = new Error(sanitizeSecrets(`HTTP ${res.status}: ${detail}`, secrets));
      err.status = res.status;
      err.data = data;
      throw err;
    }

    return data;
  } catch (err) {
    if (err && err.status) throw err;
    throw new Error(sanitizeSecrets(err, secrets));
  }
}

// ---------------------------------------------------------------------------
// A. GitHub Integration
// ---------------------------------------------------------------------------
let githubCache = { data: null, expiresAt: 0 };

function invalidateGitHubCache() {
  githubCache = { data: null, expiresAt: 0 };
}

function buildEphemGitEnv(token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("GitHub token requerido para construir entorno git efímero.");
  }
  const cleanToken = token.trim();
  const basic = Buffer.from(`x-access-token:${cleanToken}`, "utf8").toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`
  };
}

function runGitSync(projectPath, args, extraEnv = null, secrets = []) {
  try {
    return execFileSync("git", ["-C", projectPath, ...args], {
      shell: false,
      encoding: "utf-8",
      env: extraEnv || { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000
    }).trim();
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    const stdout = err.stdout ? String(err.stdout) : "";
    const combined = [err.message, stderr, stdout].filter(Boolean).join(" | ");
    throw new Error(sanitizeSecrets(combined, secrets));
  }
}

async function runGitAsync(projectPath, args, extraEnv = null, secrets = []) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, ...args], {
      shell: false,
      encoding: "utf-8",
      env: extraEnv || { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      timeout: 120000
    });
    return String(stdout || "").trim();
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr) : "";
    const stdout = err.stdout ? String(err.stdout) : "";
    const combined = [err.message, stderr, stdout].filter(Boolean).join(" | ");
    throw new Error(sanitizeSecrets(combined, secrets));
  }
}

function detectGitProjectMeta(projectPath) {
  const empty = { isGitRepo: false, originUrl: null, repoFullName: null, branch: null, topLevel: null };
  if (!projectPath || typeof projectPath !== "string") return empty;
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) return empty;

  try {
    const inside = runGitSync(resolved, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return empty;

    let topLevel = null;
    try {
      topLevel = runGitSync(resolved, ["rev-parse", "--show-toplevel"]);
    } catch (_e) {}

    let originUrl = null;
    try {
      const rawOrigin = runGitSync(resolved, ["remote", "get-url", "origin"]);
      originUrl = sanitizeGitRemoteUrl(rawOrigin) || null;
    } catch (_e) {}

    let branch = null;
    try {
      branch = runGitSync(resolved, ["symbolic-ref", "--short", "HEAD"]);
    } catch (_e) {
      try {
        branch = runGitSync(resolved, ["rev-parse", "--abbrev-ref", "HEAD"]);
      } catch (_e2) {}
    }

    const parsed = originUrl ? parseGitHubRepoFromRemote(originUrl) : null;
    return {
      isGitRepo: true,
      originUrl,
      repoFullName: parsed ? parsed.fullName : null,
      branch,
      topLevel
    };
  } catch (_err) {
    return empty;
  }
}

function ensureSafeGitignore(projectPath) {
  const gitignorePath = path.join(projectPath, ".gitignore");
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf-8");
  }
  const existingLines = new Set(existing.split(/\r?\n/).map(l => l.trim()));
  const missing = SAFE_GITIGNORE_ENTRIES.filter(entry => !existingLines.has(entry));
  if (missing.length > 0) {
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    const addition = `${prefix}# Local AI Studio Zero-Trust defaults\n${missing.join("\n")}\n`;
    fs.writeFileSync(gitignorePath, existing + addition, "utf-8");
  }
  return gitignorePath;
}

function isProtectedEnvRelPath(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const base = path.posix.basename(normalized).toLowerCase();
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") {
    return false;
  }
  return base === ".env" || base.startsWith(".env.");
}

function unstageProtectedEnvFiles(projectPath) {
  try {
    const tracked = runGitSync(projectPath, ["ls-files"]);
    for (const file of tracked.split(/\r?\n/).filter(Boolean)) {
      if (isProtectedEnvRelPath(file)) {
        runGitSync(projectPath, ["rm", "--cached", "--ignore-unmatch", "--", file]);
      }
    }
  } catch (_e) {}

  try {
    const staged = runGitSync(projectPath, ["diff", "--cached", "--name-only"]);
    for (const file of staged.split(/\r?\n/).filter(Boolean)) {
      if (isProtectedEnvRelPath(file)) {
        try {
          runGitSync(projectPath, ["reset", "HEAD", "--", file]);
        } catch (_e) {
          runGitSync(projectPath, ["rm", "--cached", "--ignore-unmatch", "--", file]);
        }
      }
    }
  } catch (_e) {}
}

function ensureGitAuthorIdentity(projectPath, githubUser = null) {
  let name = "";
  let email = "";
  try {
    name = runGitSync(projectPath, ["config", "user.name"]);
  } catch (_e) {}
  try {
    email = runGitSync(projectPath, ["config", "user.email"]);
  } catch (_e) {}

  if (!name) {
    const fallbackName = (githubUser && (githubUser.name || githubUser.login)) || "Local AI Studio";
    runGitSync(projectPath, ["config", "user.name", fallbackName]);
  }
  if (!email) {
    const login = (githubUser && githubUser.login) || "local-ai-studio";
    runGitSync(projectPath, ["config", "user.email", `${login}@users.noreply.github.com`]);
  }
}

async function getGitHubStatusAndRepos(projectPath = null, forceRefresh = false) {
  const token = envLoader.getGithubToken();
  const detectedRemote = detectGitProjectMeta(projectPath);

  if (!token) {
    return {
      ok: false,
      configured: false,
      user: null,
      repos: [],
      detectedRemote,
      activeRepoMatch: null,
      error: "GITHUB_TOKEN no configurado en .env"
    };
  }

  const now = Date.now();
  let cachedPayload = !forceRefresh && githubCache.data && githubCache.expiresAt > now ? githubCache.data : null;
  let usedCache = Boolean(cachedPayload);

  try {
    if (!cachedPayload) {
      const ghHeaders = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      const [rawUser, rawRepos] = await Promise.all([
        fetchJson("https://api.github.com/user", { headers: ghHeaders, secrets: [token] }),
        fetchJson(
          "https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
          { headers: ghHeaders, secrets: [token] }
        )
      ]);

      const user = {
        login: rawUser.login,
        name: rawUser.name || rawUser.login,
        avatar_url: rawUser.avatar_url || null,
        html_url: rawUser.html_url || null
      };

      const repos = (Array.isArray(rawRepos) ? rawRepos : []).map(r => ({
        id: r.id,
        name: r.name,
        full_name: r.full_name,
        private: Boolean(r.private),
        default_branch: r.default_branch || "main",
        clone_url: sanitizeGitRemoteUrl(r.clone_url || ""),
        html_url: r.html_url || null,
        description: r.description || "",
        updated_at: r.updated_at || null,
        owner: r.owner ? r.owner.login : null
      }));

      cachedPayload = { user, repos };
      githubCache = { data: cachedPayload, expiresAt: now + CACHE_TTL_MS };
    }

    let activeRepoMatch = null;
    if (detectedRemote && detectedRemote.repoFullName) {
      const targetLower = detectedRemote.repoFullName.toLowerCase();
      activeRepoMatch = cachedPayload.repos.find(r => r.full_name.toLowerCase() === targetLower) || null;
    }

    return {
      ok: true,
      configured: true,
      user: cachedPayload.user,
      repos: cachedPayload.repos,
      detectedRemote,
      activeRepoMatch,
      cached: usedCache
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      user: null,
      repos: [],
      detectedRemote,
      activeRepoMatch: null,
      error: sanitizeSecrets(err, [token])
    };
  }
}

async function createGitHubRepo({
  name,
  description = "",
  isPrivate = true,
  localProjectPath = null,
  linkAndPush = true
}) {
  const token = envLoader.getGithubToken();
  if (!token) {
    return { ok: false, error: "GITHUB_TOKEN no configurado en .env" };
  }
  const cleanName = String(name || "").trim();
  if (!cleanName || !/^[A-Za-z0-9._-]+$/.test(cleanName)) {
    return { ok: false, error: "Nombre de repositorio GitHub inválido." };
  }

  try {
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const willPushLocal = Boolean(linkAndPush && localProjectPath && fs.existsSync(localProjectPath));
    const created = await fetchJson("https://api.github.com/user/repos", {
      method: "POST",
      headers: ghHeaders,
      body: JSON.stringify({
        name: cleanName,
        description: String(description || ""),
        private: Boolean(isPrivate),
        auto_init: !willPushLocal
      }),
      secrets: [token]
    });

    invalidateGitHubCache();

    const cleanCloneUrl = sanitizeGitRemoteUrl(created.clone_url || `https://github.com/${created.full_name}.git`);
    const mappedRepo = {
      id: created.id,
      name: created.name,
      full_name: created.full_name,
      private: Boolean(created.private),
      default_branch: created.default_branch || "main",
      clone_url: cleanCloneUrl,
      html_url: created.html_url || null,
      description: created.description || ""
    };

    let linked = false;
    let pushed = false;
    let branch = mappedRepo.default_branch;
    let commitSha = null;

    if (willPushLocal) {
      const resolvedPath = path.resolve(localProjectPath);
      if (!fs.existsSync(path.join(resolvedPath, ".git"))) {
        try {
          runGitSync(resolvedPath, ["init", "-b", "main"]);
        } catch (_e) {
          runGitSync(resolvedPath, ["init"]);
          runGitSync(resolvedPath, ["checkout", "-B", "main"]);
        }
      }

      ensureSafeGitignore(resolvedPath);

      try {
        runGitSync(resolvedPath, ["remote", "get-url", "origin"]);
        runGitSync(resolvedPath, ["remote", "set-url", "origin", cleanCloneUrl]);
      } catch (_e) {
        runGitSync(resolvedPath, ["remote", "add", "origin", cleanCloneUrl]);
      }
      linked = true;

      unstageProtectedEnvFiles(resolvedPath);
      runGitSync(resolvedPath, ["add", "-A"]);
      unstageProtectedEnvFiles(resolvedPath);

      const staged = runGitSync(resolvedPath, ["diff", "--cached", "--name-only"]);
      if (staged) {
        ensureGitAuthorIdentity(resolvedPath, created.owner ? { login: created.owner.login } : null);
        runGitSync(resolvedPath, ["commit", "-m", "Initial commit via Local AI Studio"]);
      }

      try {
        commitSha = runGitSync(resolvedPath, ["rev-parse", "HEAD"]);
      } catch (_e) {
        commitSha = null;
      }

      try {
        branch = runGitSync(resolvedPath, ["symbolic-ref", "--short", "HEAD"]) || "main";
      } catch (_e) {
        branch = "main";
      }

      if (commitSha) {
        const ephemEnv = buildEphemGitEnv(token);
        await runGitAsync(resolvedPath, ["push", "-u", "origin", branch], ephemEnv, [token]);
        pushed = true;
      }

      const projectKey = path.basename(resolvedPath);
      safeCallStore("recordChange", {
        project: projectKey,
        projectPath: resolvedPath,
        action: "github_create_repo",
        source: "github",
        remoteRef: mappedRepo.full_name,
        summary: `Repositorio GitHub creado${pushed ? " y sincronizado" : ""}: ${mappedRepo.full_name}`
      });
      safeCallStore(
        "updateProjectState",
        { project: projectKey, projectPath: resolvedPath },
        {
          githubToggle: true,
          githubRepo: mappedRepo.full_name,
          github: {
            repoFullName: mappedRepo.full_name,
            htmlUrl: mappedRepo.html_url,
            branch,
            lastCommitSha: commitSha,
            lastSyncAt: new Date().toISOString()
          }
        }
      );
    }

    return {
      ok: true,
      repo: mappedRepo,
      linked,
      pushed,
      branch,
      commitSha
    };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeSecrets(err, [token])
    };
  }
}

async function syncProjectToGitHub({
  projectName = null,
  projectPath = null,
  repoFullName = "",
  commitMessage = "",
  filesModified = [],
  initRemoteOnLocal = false
}) {
  const token = envLoader.getGithubToken();
  if (!token) {
    return { ok: false, error: "GITHUB_TOKEN no configurado en .env" };
  }

  const targetRepo = String(repoFullName || "").trim();
  const message = String(commitMessage || "").trim() || `Sync from Local AI Studio (${new Date().toISOString()})`;
  const resolvedPath = projectPath ? path.resolve(projectPath) : null;
  const resolvedProjectName = projectName || (resolvedPath ? path.basename(resolvedPath) : targetRepo || "project");
  const meta = resolvedPath ? detectGitProjectMeta(resolvedPath) : { isGitRepo: false };

  const originMatchesTarget = Boolean(
    meta.isGitRepo &&
      meta.originUrl &&
      (!targetRepo || (meta.repoFullName && meta.repoFullName.toLowerCase() === targetRepo.toLowerCase()))
  );

  try {
    // Mode 1: Local Git Push
    if (resolvedPath && fs.existsSync(resolvedPath) && (originMatchesTarget || (initRemoteOnLocal && targetRepo))) {
      if (initRemoteOnLocal && targetRepo) {
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(targetRepo)) {
          return { ok: false, error: `Nombre de repositorio inválido: ${targetRepo}` };
        }
        if (!fs.existsSync(path.join(resolvedPath, ".git"))) {
          try {
            runGitSync(resolvedPath, ["init", "-b", "main"]);
          } catch (_e) {
            runGitSync(resolvedPath, ["init"]);
            runGitSync(resolvedPath, ["checkout", "-B", "main"]);
          }
        }
        const cleanUrl = `https://github.com/${targetRepo}.git`;
        try {
          runGitSync(resolvedPath, ["remote", "get-url", "origin"]);
          runGitSync(resolvedPath, ["remote", "set-url", "origin", cleanUrl]);
        } catch (_e) {
          runGitSync(resolvedPath, ["remote", "add", "origin", cleanUrl]);
        }
      }

      ensureSafeGitignore(resolvedPath);
      unstageProtectedEnvFiles(resolvedPath);

      const porcelainBefore = runGitSync(resolvedPath, ["status", "--porcelain"]);
      runGitSync(resolvedPath, ["add", "-A"]);
      unstageProtectedEnvFiles(resolvedPath);

      const stagedFiles = runGitSync(resolvedPath, ["diff", "--cached", "--name-only"]);
      let committed = false;
      if (stagedFiles) {
        ensureGitAuthorIdentity(resolvedPath);
        runGitSync(resolvedPath, ["commit", "-m", message]);
        committed = true;
      }

      let commitSha = null;
      try {
        commitSha = runGitSync(resolvedPath, ["rev-parse", "HEAD"]);
      } catch (_e) {
        return {
          ok: false,
          mode: "git_push",
          error: "No hay commits en el repositorio local para sincronizar."
        };
      }

      let branch = "main";
      try {
        branch = runGitSync(resolvedPath, ["symbolic-ref", "--short", "HEAD"]) || "main";
      } catch (_e) {
        try {
          branch = runGitSync(resolvedPath, ["rev-parse", "--abbrev-ref", "HEAD"]) || "main";
        } catch (_e2) {}
      }

      const ephemEnv = buildEphemGitEnv(token);
      await runGitAsync(resolvedPath, ["push", "-u", "origin", branch], ephemEnv, [token]);

      const finalRepoName = targetRepo || meta.repoFullName || "";
      safeCallStore("recordChange", {
        project: resolvedProjectName,
        projectPath: resolvedPath,
        action: "github_push",
        source: "github",
        remoteRef: `${finalRepoName || meta.originUrl}#${branch}@${commitSha.slice(0, 7)}`,
        summary: `Push a ${finalRepoName || "origin"} (${branch})${committed ? "" : " [sin nuevos cambios locales]"}`
      });
      safeCallStore(
        "updateProjectState",
        { project: resolvedProjectName, projectPath: resolvedPath },
        {
          githubToggle: true,
          githubRepo: finalRepoName,
          github: {
            repoFullName: finalRepoName,
            branch,
            lastCommitSha: commitSha,
            lastSyncAt: new Date().toISOString()
          }
        }
      );

      return {
        ok: true,
        mode: "git_push",
        repoFullName: finalRepoName,
        branch,
        commitSha,
        pushed: true,
        committed,
        message
      };
    }

    // Mode 2: GitHub Contents API (different repo or non-git project with filesModified)
    if (!targetRepo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(targetRepo)) {
      return {
        ok: false,
        error: "Se requiere repoFullName (owner/repo) cuando el proyecto local no apunta a un origin válido."
      };
    }

    if (!Array.isArray(filesModified) || filesModified.length === 0) {
      return {
        ok: false,
        error:
          "El repositorio seleccionado no coincide con el origin local y no se enviaron archivos en filesModified (puedes activar initRemoteOnLocal=true para enlazarlo)."
      };
    }

    const [owner, repo] = targetRepo.split("/");
    const ghHeaders = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28"
    };

    const repoInfo = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
      headers: ghHeaders,
      secrets: [token]
    });
    const defaultBranch = repoInfo.default_branch || "main";

    const uploadedFiles = [];
    let lastCommitSha = null;

    for (const item of filesModified) {
      const rawRel = typeof item === "string" ? item : (item && (item.relPath || item.path));
      if (!rawRel || typeof rawRel !== "string") {
        throw new Error("Entrada inválida en filesModified: falta relPath.");
      }
      const cleanRel = rawRel.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");
      if (!cleanRel || cleanRel.includes("..") || cleanRel.startsWith(".git/")) {
        throw new Error(`Ruta relativa no permitida: ${cleanRel}`);
      }
      if (isProtectedEnvRelPath(cleanRel)) {
        throw new Error(`Zero-Trust: bloqueada subida de archivo sensible (${cleanRel}).`);
      }

      let base64Content = "";
      if (item && typeof item === "object" && typeof item.content === "string") {
        base64Content = Buffer.from(item.content, "utf8").toString("base64");
      } else if (resolvedPath) {
        const absFile = path.resolve(resolvedPath, cleanRel);
        if (!absFile.startsWith(resolvedPath + path.sep) || !fs.existsSync(absFile)) {
          throw new Error(`Archivo no encontrado dentro del proyecto: ${cleanRel}`);
        }
        base64Content = fs.readFileSync(absFile).toString("base64");
      } else {
        throw new Error(`Falta contenido o projectPath legible para ${cleanRel}`);
      }

      const encodedPath = cleanRel.split("/").map(encodeURIComponent).join("/");
      const contentsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;

      let existingSha = null;
      try {
        const existing = await fetchJson(`${contentsUrl}?ref=${encodeURIComponent(defaultBranch)}`, {
          headers: ghHeaders,
          secrets: [token]
        });
        if (existing && existing.sha) {
          existingSha = existing.sha;
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }

      const putRes = await fetchJson(contentsUrl, {
        method: "PUT",
        headers: ghHeaders,
        body: JSON.stringify({
          message,
          content: base64Content,
          branch: defaultBranch,
          ...(existingSha ? { sha: existingSha } : {})
        }),
        secrets: [token]
      });

      uploadedFiles.push(cleanRel);
      lastCommitSha = (putRes && putRes.commit && putRes.commit.sha) || lastCommitSha;
    }

    safeCallStore("recordChange", {
      project: resolvedProjectName,
      projectPath: resolvedPath || "",
      relPath: uploadedFiles.join(", "),
      action: "github_contents_api",
      source: "github",
      remoteRef: `${targetRepo}#${defaultBranch}`,
      summary: `Subidos ${uploadedFiles.length} archivo(s) a ${targetRepo} (${defaultBranch})`
    });
    safeCallStore(
      "updateProjectState",
      { project: resolvedProjectName, projectPath: resolvedPath || "" },
      {
        githubToggle: true,
        githubRepo: targetRepo,
        github: {
          repoFullName: targetRepo,
          branch: defaultBranch,
          lastCommitSha,
          lastSyncAt: new Date().toISOString()
        }
      }
    );

    return {
      ok: true,
      mode: "contents_api",
      repoFullName: targetRepo,
      branch: defaultBranch,
      commitSha: lastCommitSha,
      uploadedCount: uploadedFiles.length,
      files: uploadedFiles,
      pushed: true,
      message
    };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeSecrets(err, [token])
    };
  }
}

// ---------------------------------------------------------------------------
// B. Netlify Integration
// ---------------------------------------------------------------------------
let netlifyCache = { data: null, expiresAt: 0 };

function invalidateNetlifyCache() {
  netlifyCache = { data: null, expiresAt: 0 };
}

function readLinkedNetlifySiteId(projectPath) {
  if (!projectPath || typeof projectPath !== "string") return null;
  const statePath = path.join(path.resolve(projectPath), ".netlify", "state.json");
  if (!fs.existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return parsed && parsed.siteId ? String(parsed.siteId) : null;
  } catch (_e) {
    return null;
  }
}

function detectPublishDir(projectPath) {
  if (!projectPath || typeof projectPath !== "string") return null;
  const resolved = path.resolve(projectPath);
  if (!fs.existsSync(resolved)) return null;
  try {
    if (!fs.statSync(resolved).isDirectory()) return null;
  } catch (_e) {
    return null;
  }

  const candidates = ["dist", "build", "out", "public", "www"];
  for (const dirName of candidates) {
    const full = path.join(resolved, dirName);
    try {
      if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
        return dirName;
      }
    } catch (_e) {}
  }

  if (fs.existsSync(path.join(resolved, "index.html"))) {
    return ".";
  }

  return null;
}

function resolveNetlifyRunner() {
  const candidates = [];
  try {
    const whereOut = execFileSync("where.exe", ["netlify"], {
      shell: false,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000
    });
    for (const line of whereOut.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) candidates.push(trimmed);
    }
  } catch (_e) {}

  if (process.env.APPDATA) {
    const appDataCmd = path.join(process.env.APPDATA, "npm", "netlify.cmd");
    if (fs.existsSync(appDataCmd)) candidates.push(appDataCmd);
  }

  for (const cand of candidates) {
    const lower = cand.toLowerCase();
    if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      const runJs = path.join(path.dirname(cand), "node_modules", "netlify-cli", "bin", "run.js");
      if (fs.existsSync(runJs)) {
        return { command: process.execPath, prefixArgs: [runJs], useShell: false };
      }
    } else if (lower.endsWith(".exe") && fs.existsSync(cand)) {
      return { command: cand, prefixArgs: [], useShell: false };
    }
  }

  const fallbackCmd = candidates.find(c => fs.existsSync(c));
  if (fallbackCmd) {
    return { command: fallbackCmd, prefixArgs: [], useShell: process.platform === "win32" };
  }

  throw new Error("Netlify CLI no encontrado en el sistema. Instala netlify-cli globalmente.");
}

async function getNetlifyStatusAndSites(projectPath = null, forceRefresh = false) {
  const token = envLoader.getNetlifyToken();
  const linkedSiteId = readLinkedNetlifySiteId(projectPath);
  const detectedPublishDir = detectPublishDir(projectPath);

  if (!token) {
    return {
      ok: false,
      configured: false,
      user: null,
      sites: [],
      linkedSiteId,
      detectedPublishDir,
      error: "NETLIFY_AUTH_TOKEN no configurado en .env"
    };
  }

  const now = Date.now();
  let cachedPayload = !forceRefresh && netlifyCache.data && netlifyCache.expiresAt > now ? netlifyCache.data : null;
  const usedCache = Boolean(cachedPayload);

  try {
    if (!cachedPayload) {
      const nfHeaders = { Authorization: `Bearer ${token}` };
      const [rawUser, rawSites] = await Promise.all([
        fetchJson("https://api.netlify.com/api/v1/user", { headers: nfHeaders, secrets: [token] }),
        fetchJson("https://api.netlify.com/api/v1/sites?per_page=100", { headers: nfHeaders, secrets: [token] })
      ]);

      const user = {
        id: rawUser.id || null,
        full_name: rawUser.full_name || rawUser.email || "Netlify User",
        email: rawUser.email || null,
        avatar_url: rawUser.avatar_url || null
      };

      const sites = (Array.isArray(rawSites) ? rawSites : []).map(s => ({
        id: s.id,
        name: s.name,
        url: s.ssl_url || s.url || null,
        ssl_url: s.ssl_url || null,
        admin_url: s.admin_url || null,
        default_domain: s.default_domain || null,
        custom_domain: s.custom_domain || null,
        updated_at: s.updated_at || null
      }));

      cachedPayload = { user, sites };
      netlifyCache = { data: cachedPayload, expiresAt: now + CACHE_TTL_MS };
    }

    return {
      ok: true,
      configured: true,
      user: cachedPayload.user,
      sites: cachedPayload.sites,
      linkedSiteId,
      detectedPublishDir,
      cached: usedCache
    };
  } catch (err) {
    return {
      ok: false,
      configured: true,
      user: null,
      sites: [],
      linkedSiteId,
      detectedPublishDir,
      error: sanitizeSecrets(err, [token])
    };
  }
}

async function createNetlifySite({ name = "", projectPath = null, linkLocal = true }) {
  const token = envLoader.getNetlifyToken();
  if (!token) {
    return { ok: false, error: "NETLIFY_AUTH_TOKEN no configurado en .env" };
  }

  try {
    const cleanName = String(name || "").trim();
    const created = await fetchJson("https://api.netlify.com/api/v1/sites", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(cleanName ? { name: cleanName } : {}),
      secrets: [token]
    });

    invalidateNetlifyCache();

    const mappedSite = {
      id: created.id,
      name: created.name,
      url: created.ssl_url || created.url || null,
      ssl_url: created.ssl_url || null,
      admin_url: created.admin_url || null,
      default_domain: created.default_domain || null
    };

    let linked = false;
    if (linkLocal && projectPath && fs.existsSync(projectPath)) {
      const resolved = path.resolve(projectPath);
      const netlifyDir = path.join(resolved, ".netlify");
      fs.mkdirSync(netlifyDir, { recursive: true });
      fs.writeFileSync(path.join(netlifyDir, "state.json"), JSON.stringify({ siteId: created.id }, null, 2), "utf-8");
      linked = true;
    }

    const projectKey = projectPath ? path.basename(path.resolve(projectPath)) : mappedSite.name;
    const resolvedProjPath = projectPath ? path.resolve(projectPath) : "";
    safeCallStore("recordChange", {
      project: projectKey,
      projectPath: resolvedProjPath,
      action: "netlify_create_site",
      source: "netlify",
      remoteRef: mappedSite.id,
      deployUrl: mappedSite.url,
      summary: `Sitio Netlify creado: ${mappedSite.name}`
    });
    safeCallStore(
      "updateProjectState",
      { project: projectKey, projectPath: resolvedProjPath },
      {
        netlifyToggle: true,
        netlifySite: mappedSite.id,
        netlify: {
          siteId: mappedSite.id,
          siteName: mappedSite.name,
          url: mappedSite.url,
          linked
        }
      }
    );

    return {
      ok: true,
      site: mappedSite,
      linked
    };
  } catch (err) {
    return {
      ok: false,
      error: sanitizeSecrets(err, [token])
    };
  }
}

function parseJsonFromCliOutput(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_e) {
    const startIdx = trimmed.lastIndexOf("\n{");
    if (startIdx !== -1) {
      try {
        return JSON.parse(trimmed.slice(startIdx + 1));
      } catch (_e2) {}
    }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch (_e3) {}
    }
  }
  return null;
}

async function deployToNetlify({
  projectName = null,
  projectPath,
  siteId,
  publishDir = null,
  prod = true,
  message = ""
}) {
  const token = envLoader.getNetlifyToken();
  if (!token) {
    return { ok: false, error: "NETLIFY_AUTH_TOKEN no configurado en .env" };
  }

  const cleanSiteId = String(siteId || "").trim();
  if (!cleanSiteId) {
    return { ok: false, error: "siteId es obligatorio para desplegar en Netlify." };
  }

  if (!projectPath || typeof projectPath !== "string") {
    return { ok: false, error: "projectPath es obligatorio." };
  }
  const resolvedProjectPath = path.resolve(projectPath);
  if (!fs.existsSync(resolvedProjectPath) || !fs.statSync(resolvedProjectPath).isDirectory()) {
    return { ok: false, error: `La carpeta del proyecto no existe: ${resolvedProjectPath}` };
  }

  const candidateDir = publishDir ? String(publishDir).trim() : detectPublishDir(resolvedProjectPath);
  if (!candidateDir) {
    return {
      ok: false,
      error: "No se detectó directorio de publicación (dist, build, out, public, www o index.html en raíz)."
    };
  }

  const resolvedPublishDir = path.resolve(resolvedProjectPath, candidateDir);
  if (
    resolvedPublishDir !== resolvedProjectPath &&
    !resolvedPublishDir.startsWith(resolvedProjectPath + path.sep)
  ) {
    return { ok: false, error: "El directorio de publicación debe estar dentro de projectPath." };
  }
  if (!fs.existsSync(resolvedPublishDir) || !fs.statSync(resolvedPublishDir).isDirectory()) {
    return { ok: false, error: `El directorio de publicación no existe: ${resolvedPublishDir}` };
  }

  const resolvedProjectName = projectName || path.basename(resolvedProjectPath);

  try {
    const runner = resolveNetlifyRunner();
    const cliArgs = [
      ...runner.prefixArgs,
      "deploy",
      "--site",
      cleanSiteId,
      "--dir",
      resolvedPublishDir,
      "--json"
    ];
    if (prod) cliArgs.push("--prod");
    if (message && String(message).trim()) {
      cliArgs.push("--message", String(message).trim());
    }

    const { stdout, stderr } = await execFileAsync(runner.command, cliArgs, {
      cwd: resolvedProjectPath,
      shell: runner.useShell,
      encoding: "utf-8",
      env: {
        ...process.env,
        NETLIFY_AUTH_TOKEN: token
      },
      timeout: 300000,
      maxBuffer: 10 * 1024 * 1024
    });

    const parsed = parseJsonFromCliOutput(stdout) || parseJsonFromCliOutput(stderr);
    if (!parsed) {
      return {
        ok: false,
        error: sanitizeSecrets(`Netlify CLI no devolvió JSON válido: ${stdout || stderr}`, [token])
      };
    }

    const deployUrl = parsed.deploy_url || parsed.url || null;
    const sslUrl = parsed.ssl_url || parsed.deploy_url || parsed.url || null;
    const deployId = parsed.deploy_id || parsed.id || null;
    const siteName = parsed.site_name || null;

    const relPubDir = path.relative(resolvedProjectPath, resolvedPublishDir) || ".";
    safeCallStore("recordChange", {
      project: resolvedProjectName,
      projectPath: resolvedProjectPath,
      relPath: relPubDir,
      action: prod ? "netlify_deploy_prod" : "netlify_deploy_preview",
      source: "netlify",
      remoteRef: deployId || cleanSiteId,
      deployUrl: sslUrl || deployUrl,
      summary: `Despliegue Netlify (${prod ? "producción" : "preview"}): ${sslUrl || deployUrl || cleanSiteId}`
    });
    safeCallStore(
      "updateProjectState",
      { project: resolvedProjectName, projectPath: resolvedProjectPath },
      {
        netlifyToggle: true,
        netlifySite: cleanSiteId,
        netlifyPublishDir: relPubDir,
        netlify: {
          siteId: cleanSiteId,
          siteName,
          deployId,
          deployUrl,
          sslUrl,
          lastDeployAt: new Date().toISOString()
        }
      }
    );

    return {
      ok: true,
      siteId: cleanSiteId,
      siteName,
      publishDir: resolvedPublishDir,
      prod: Boolean(prod),
      deployId,
      deployUrl,
      sslUrl,
      logsUrl: parsed.logs || null
    };
  } catch (err) {
    const detail = [err.message, err.stderr, err.stdout].filter(Boolean).join(" | ");
    return {
      ok: false,
      error: sanitizeSecrets(detail, [token])
    };
  }
}

// ---------------------------------------------------------------------------
// C. Hugging Face Hub Integration
// ---------------------------------------------------------------------------
const activeHfJobs = new Map();

function sanitizeFolderSegment(name) {
  return String(name || "model")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/\.+$/g, "")
    .trim() || "model";
}

async function searchHuggingFace({ query = "", type = "model", limit = 15 } = {}) {
  const token = envLoader.getHfToken();
  const normalizedType = type === "dataset" ? "dataset" : "model";
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 15));
  const cleanQuery = String(query || "").trim();

  const endpoint =
    normalizedType === "dataset"
      ? "https://huggingface.co/api/datasets"
      : "https://huggingface.co/api/models";

  const params = new URLSearchParams({
    limit: String(safeLimit),
    full: "true"
  });
  if (cleanQuery) {
    params.set("search", cleanQuery);
  } else {
    params.set("sort", "downloads");
    params.set("direction", "-1");
  }

  try {
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const rawList = await fetchJson(`${endpoint}?${params.toString()}`, {
      headers,
      secrets: token ? [token] : []
    });

    const items = (Array.isArray(rawList) ? rawList : []).map(m => {
      const id = String(m.id || m.modelId || "");
      const slashIdx = id.indexOf("/");
      const author = m.author || (slashIdx > 0 ? id.slice(0, slashIdx) : "");
      const name = slashIdx > 0 ? id.slice(slashIdx + 1) : id;
      return {
        id,
        author,
        name,
        type: normalizedType,
        downloads: Number(m.downloads || 0),
        likes: Number(m.likes || 0),
        pipeline_tag: m.pipeline_tag || null,
        tags: Array.isArray(m.tags) ? m.tags.slice(0, 8) : [],
        gated: Boolean(m.gated),
        private: Boolean(m.private),
        lastModified: m.lastModified || null,
        suggestedDir: path.join(DEFAULT_MODELS_DIR, sanitizeFolderSegment(name || id))
      };
    });

    return {
      ok: true,
      type: normalizedType,
      query: cleanQuery,
      defaultModelsDir: DEFAULT_MODELS_DIR,
      items
    };
  } catch (err) {
    return {
      ok: false,
      type: normalizedType,
      query: cleanQuery,
      defaultModelsDir: DEFAULT_MODELS_DIR,
      items: [],
      error: sanitizeSecrets(err, token ? [token] : [])
    };
  }
}

async function pickDestinationFolderWindows(initialDir = DEFAULT_MODELS_DIR) {
  const safeInitial = typeof initialDir === "string" && initialDir.trim() ? initialDir.trim() : DEFAULT_MODELS_DIR;
  const psScript = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Selecciona la carpeta destino para descargar el modelo o dataset'",
    "$dialog.ShowNewFolderButton = $true",
    "$init = $env:ANTIGRAVITY_PICK_INITIAL_DIR",
    "if ($init -and (Test-Path -LiteralPath $init)) { $dialog.SelectedPath = $init }",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$result = $dialog.ShowDialog($owner)",
    "$owner.Dispose()",
    "if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {",
    "  @{ cancelled = $false; path = $dialog.SelectedPath } | ConvertTo-Json -Compress",
    "} else {",
    "  @{ cancelled = $true; path = $null } | ConvertTo-Json -Compress",
    "}"
  ].join("; ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", psScript],
      {
        shell: false,
        encoding: "utf-8",
        env: {
          ...process.env,
          ANTIGRAVITY_PICK_INITIAL_DIR: safeInitial
        },
        timeout: 180000
      }
    );

    const parsed = parseJsonFromCliOutput(stdout);
    if (!parsed) {
      return { ok: false, cancelled: true, path: null, error: "No se pudo leer la selección de carpeta." };
    }
    return {
      ok: true,
      cancelled: Boolean(parsed.cancelled),
      path: parsed.path || null
    };
  } catch (err) {
    return {
      ok: false,
      cancelled: true,
      path: null,
      error: sanitizeSecrets(err)
    };
  }
}

function validateTargetDirPath(rawTargetDir) {
  if (!rawTargetDir || typeof rawTargetDir !== "string" || !rawTargetDir.trim()) {
    const err = new Error(
      `targetDir es obligatorio: siempre debe confirmar dónde guardar el modelo (sugerido: ${DEFAULT_MODELS_DIR}\\<nombre>).`
    );
    err.code = "TARGET_DIR_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  const trimmed = rawTargetDir.trim();
  if (/[\x00-\x1f]/.test(trimmed)) {
    const err = new Error("targetDir contiene caracteres de control inválidos.");
    err.code = "INVALID_TARGET_DIR";
    err.statusCode = 400;
    throw err;
  }

  const tail = /^[A-Za-z]:/.test(trimmed) ? trimmed.slice(2) : trimmed;
  if (/[<>:"|?*]/.test(tail)) {
    const err = new Error("targetDir contiene caracteres inválidos para rutas de Windows.");
    err.code = "INVALID_TARGET_DIR";
    err.statusCode = 400;
    throw err;
  }

  const resolved = path.resolve(trimmed);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    const err = new Error("No se permite descargar directamente en la raíz del disco.");
    err.code = "INVALID_TARGET_DIR";
    err.statusCode = 400;
    throw err;
  }

  if (fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory()) {
    const err = new Error("La ruta targetDir existe y es un archivo, no una carpeta.");
    err.code = "INVALID_TARGET_DIR";
    err.statusCode = 400;
    throw err;
  }

  return resolved;
}

function createProjectJunction(projectPath, targetDir) {
  if (!projectPath || typeof projectPath !== "string") return null;
  const resolvedProject = path.resolve(projectPath);
  if (!fs.existsSync(resolvedProject) || !fs.statSync(resolvedProject).isDirectory()) return null;

  const modelsLinkDir = path.join(resolvedProject, "models_link");
  fs.mkdirSync(modelsLinkDir, { recursive: true });

  const baseName = sanitizeFolderSegment(path.basename(targetDir));
  const linkPath = path.join(modelsLinkDir, baseName);

  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(linkPath);
    } else if (stat.isDirectory()) {
      const altLinkPath = path.join(modelsLinkDir, `${baseName}_${Date.now()}`);
      fs.symlinkSync(targetDir, altLinkPath, "junction");
      return altLinkPath;
    }
  } catch (_notFound) {}

  fs.symlinkSync(targetDir, linkPath, "junction");
  return linkPath;
}

async function startHfDownload({
  repoId,
  repoType = "model",
  revision = null,
  targetDir,
  projectPath = null,
  linkToProject = false
} = {}) {
  const cleanRepoId = typeof repoId === "string" ? repoId.trim() : "";
  if (!cleanRepoId) {
    const err = new Error("repoId es obligatorio para iniciar la descarga.");
    err.code = "REPO_ID_REQUIRED";
    err.statusCode = 400;
    throw err;
  }

  if (repoType !== "model" && repoType !== "dataset") {
    const err = new Error("repoType inválido: debe ser 'model' o 'dataset'.");
    err.code = "INVALID_REPO_TYPE";
    err.statusCode = 400;
    throw err;
  }

  // Mandatory Zero-Silent-Download rule: targetDir MUST be explicitly provided and validated
  const resolvedTargetDir = validateTargetDirPath(targetDir);
  const hfToken = envLoader.getHfToken();
  const jobId = `hf_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  const nowIso = new Date().toISOString();

  const initialJob = safeCallStore("upsertDownload", {
    id: jobId,
    jobId,
    repoId: cleanRepoId,
    repoType,
    revision: revision ? String(revision).trim() : null,
    targetDir: resolvedTargetDir,
    status: "starting",
    progress: 0,
    message: "Preparando descarga desde Hugging Face...",
    filesTotal: 0,
    filesCount: 0,
    totalBytes: 0,
    hasOnnx: false,
    onnxDirs: [],
    projectPath: projectPath ? path.resolve(projectPath) : null,
    linkToProject: Boolean(linkToProject),
    linkedPath: null,
    error: null,
    createdAt: nowIso,
    updatedAt: nowIso
  }) || {
    id: jobId,
    jobId,
    repoId: cleanRepoId,
    repoType,
    targetDir: resolvedTargetDir,
    status: "starting",
    progress: 0
  };

  const args = [
    "-u",
    HF_DOWNLOADER_PY,
    "--repo-id",
    cleanRepoId,
    "--repo-type",
    repoType,
    "--target-dir",
    resolvedTargetDir
  ];
  if (revision && String(revision).trim()) {
    args.push("--revision", String(revision).trim());
  }

  const childEnv = {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1"
  };
  if (hfToken) {
    childEnv.HF_TOKEN = hfToken;
  }

  const child = spawn("python", args, {
    shell: false,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const jobEntry = {
    jobId,
    child,
    cancelled: false,
    finished: false,
    stderrBuf: "",
    lineBuf: ""
  };
  activeHfJobs.set(jobId, jobEntry);

  const secretList = hfToken ? [hfToken] : [];

  function handleEvent(ev) {
    if (!ev || typeof ev !== "object") return;
    const ts = new Date().toISOString();

    if (ev.event === "start") {
      safeCallStore("upsertDownload", {
        id: jobId,
        status: "downloading",
        progress: 0,
        filesTotal: Number(ev.filesTotal || 0),
        totalBytes: Number(ev.totalBytes || 0),
        message: `Iniciando descarga (${ev.filesTotal || 0} archivos)...`,
        updatedAt: ts
      });
    } else if (ev.event === "progress") {
      safeCallStore("upsertDownload", {
        id: jobId,
        status: "downloading",
        progress: Math.min(99, Math.max(0, Number(ev.progress || 0))),
        message: sanitizeSecrets(ev.message || "Descargando...", secretList),
        updatedAt: ts
      });
    } else if (ev.event === "complete") {
      jobEntry.finished = true;
      let linkedPath = null;
      if (linkToProject && projectPath) {
        try {
          linkedPath = createProjectJunction(projectPath, resolvedTargetDir);
        } catch (_linkErr) {}
      }

      safeCallStore("upsertDownload", {
        id: jobId,
        status: "completed",
        progress: 100,
        targetDir: ev.targetDir || resolvedTargetDir,
        filesCount: Number(ev.filesCount || 0),
        totalBytes: Number(ev.totalBytes || 0),
        hasOnnx: Boolean(ev.hasOnnx),
        onnxDirs: Array.isArray(ev.onnxDirs) ? ev.onnxDirs : [],
        linkedPath,
        message: "Descarga completada",
        completedAt: ts,
        updatedAt: ts
      });

      const projKey = projectPath ? path.basename(path.resolve(projectPath)) : cleanRepoId;
      const resolvedProjPath = projectPath ? path.resolve(projectPath) : "";
      safeCallStore("recordChange", {
        project: projKey,
        projectPath: resolvedProjPath,
        relPath: linkedPath && resolvedProjPath ? path.relative(resolvedProjPath, linkedPath) : "",
        action: "hf_download_complete",
        sizeBytes: Number(ev.totalBytes || 0),
        model: cleanRepoId,
        source: "huggingface",
        remoteRef: cleanRepoId,
        summary: `Descargado ${cleanRepoId} en ${resolvedTargetDir}`
      });
      if (projectPath) {
        safeCallStore(
          "updateProjectState",
          { project: projKey, projectPath: resolvedProjPath },
          {
            lastModelDownload: {
              repoId: cleanRepoId,
              targetDir: resolvedTargetDir,
              linkedPath,
              hasOnnx: Boolean(ev.hasOnnx),
              onnxDirs: Array.isArray(ev.onnxDirs) ? ev.onnxDirs : [],
              updatedAt: ts
            }
          }
        );
      }
    } else if (ev.event === "error") {
      jobEntry.finished = true;
      const safeErr = sanitizeSecrets(ev.error || "Error durante la descarga", secretList);
      safeCallStore("upsertDownload", {
        id: jobId,
        status: jobEntry.cancelled ? "cancelled" : "error",
        error: safeErr,
        message: safeErr,
        updatedAt: ts
      });
    }
  }

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", chunk => {
    jobEntry.lineBuf += chunk;
    const lines = jobEntry.lineBuf.split(/\r?\n/);
    jobEntry.lineBuf = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        handleEvent(JSON.parse(trimmed));
      } catch (_parseErr) {}
    }
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", chunk => {
    jobEntry.stderrBuf += chunk;
    if (jobEntry.stderrBuf.length > 8192) {
      jobEntry.stderrBuf = jobEntry.stderrBuf.slice(-8192);
    }
  });

  child.on("error", err => {
    jobEntry.finished = true;
    activeHfJobs.delete(jobId);
    const safeErr = sanitizeSecrets(err, secretList);
    safeCallStore("upsertDownload", {
      id: jobId,
      status: "error",
      error: safeErr,
      message: safeErr,
      updatedAt: new Date().toISOString()
    });
  });

  child.on("close", code => {
    if (jobEntry.lineBuf.trim()) {
      try {
        handleEvent(JSON.parse(jobEntry.lineBuf.trim()));
      } catch (_e) {}
      jobEntry.lineBuf = "";
    }
    activeHfJobs.delete(jobId);
    if (!jobEntry.finished) {
      if (jobEntry.cancelled) {
        safeCallStore("upsertDownload", {
          id: jobId,
          status: "cancelled",
          message: "Descarga cancelada por el usuario",
          updatedAt: new Date().toISOString()
        });
      } else if (code !== 0) {
        const safeErr = sanitizeSecrets(
          jobEntry.stderrBuf.trim() || `El proceso de descarga finalizó con código ${code}`,
          secretList
        );
        safeCallStore("upsertDownload", {
          id: jobId,
          status: "error",
          error: safeErr,
          message: safeErr,
          updatedAt: new Date().toISOString()
        });
      }
    }
  });

  return {
    ok: true,
    jobId,
    status: initialJob.status || "starting",
    repoId: cleanRepoId,
    repoType,
    targetDir: resolvedTargetDir,
    job: initialJob
  };
}

function listHfDownloads(filter = {}) {
  const rows = safeCallStore("listDownloads");
  if (!Array.isArray(rows)) return [];
  if (filter && filter.status) {
    return rows.filter(r => r && r.status === filter.status);
  }
  return rows;
}

function getHfDownload(jobId) {
  if (!jobId) return null;
  return safeCallStore("getDownload", jobId) || null;
}

function cancelHfDownload(jobId) {
  const entry = activeHfJobs.get(jobId);
  if (!entry) {
    const existing = getHfDownload(jobId);
    return {
      ok: false,
      jobId,
      cancelled: false,
      status: existing ? existing.status : null,
      error: "No hay una descarga activa con ese jobId."
    };
  }

  entry.cancelled = true;
  entry.finished = true;

  try {
    if (process.platform === "win32" && entry.child && entry.child.pid) {
      execFile("taskkill", ["/PID", String(entry.child.pid), "/T", "/F"], { shell: false }, () => {});
    } else if (entry.child) {
      entry.child.kill("SIGTERM");
    }
  } catch (_e) {
    try {
      entry.child.kill();
    } catch (_e2) {}
  }

  activeHfJobs.delete(jobId);
  const updated = safeCallStore("upsertDownload", {
    id: jobId,
    status: "cancelled",
    message: "Descarga cancelada por el usuario",
    updatedAt: new Date().toISOString()
  });

  return {
    ok: true,
    jobId,
    cancelled: true,
    job: updated
  };
}

module.exports = {
  DEFAULT_MODELS_DIR,
  // Security & helpers
  sanitizeSecrets,
  sanitizeGitRemoteUrl,
  parseGitHubRepoFromRemote,
  detectGitProjectMeta,
  buildEphemGitEnv,
  // A. GitHub
  getGitHubStatusAndRepos,
  createGitHubRepo,
  syncProjectToGitHub,
  // B. Netlify
  getNetlifyStatusAndSites,
  createNetlifySite,
  detectPublishDir,
  deployToNetlify,
  // C. Hugging Face
  searchHuggingFace,
  pickDestinationFolderWindows,
  startHfDownload,
  listHfDownloads,
  getHfDownload,
  cancelHfDownload
};
