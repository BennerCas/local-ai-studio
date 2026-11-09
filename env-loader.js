const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ENV_PATH = path.join(__dirname, ".env");
const GLOBAL_ENV_PATH = "C:\\Users\\Benner\\.gemini\\.env";
const EXTERNAL_LINKEDIN_ENV_PATH = "C:\\antigravityAS\\LinkedInSuperApp\\.env";

let loaded = false;
let externalSerpLoaded = false;
let loadedExternalEnvPath = "";
let externalSerpEnv = Object.create(null);

function isExternalEnvDisabled() {
  const raw = String(process.env.LOCAL_AI_DISABLE_EXTERNAL_ENV || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function getExternalEnvPath() {
  const override = process.env.LOCAL_AI_EXTERNAL_ENV_PATH;
  return (override && String(override).trim())
    ? path.resolve(String(override).trim())
    : EXTERNAL_LINKEDIN_ENV_PATH;
}

function parseEnvEntries(filePath) {
  const entries = [];
  if (!filePath || !fs.existsSync(filePath)) return entries;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const cleaned = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
      const eqIdx = cleaned.indexOf("=");
      if (eqIdx <= 0) continue;
      const key = cleaned.slice(0, eqIdx).trim();
      let val = cleaned.slice(eqIdx + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!key) continue;
      entries.push([key, val]);
    }
  } catch (err) {
    console.error(`[EnvLoader] Error reading ${path.basename(filePath)}:`, err.message);
  }
  return entries;
}

function parseEnvFile(filePath, overrideExisting = false) {
  let count = 0;
  const entries = parseEnvEntries(filePath);
  for (const [key, val] of entries) {
    if (overrideExisting || !process.env[key]) {
      process.env[key] = val;
      count++;
    }
  }
  return count;
}

function loadExternalSerpEnvOnly(force = false) {
  if (isExternalEnvDisabled()) {
    externalSerpEnv = Object.create(null);
    externalSerpLoaded = false;
    loadedExternalEnvPath = "";
    return 0;
  }

  const extPath = getExternalEnvPath();
  if (externalSerpLoaded && !force && loadedExternalEnvPath === extPath) {
    return Object.keys(externalSerpEnv).length;
  }

  const nextMap = Object.create(null);
  const entries = parseEnvEntries(extPath);
  for (const [key, val] of entries) {
    if (!key.startsWith("SERPAPI_")) continue;
    const cleanVal = String(val || "").trim();
    if (!cleanVal) continue;
    if (!nextMap[key]) {
      nextMap[key] = cleanVal;
    }
  }

  externalSerpEnv = nextMap;
  externalSerpLoaded = true;
  loadedExternalEnvPath = extPath;
  return Object.keys(externalSerpEnv).length;
}

function getSerpVar(key) {
  const fromProcess = process.env[key];
  if (typeof fromProcess === "string" && fromProcess.trim()) {
    return fromProcess.trim();
  }
  if (isExternalEnvDisabled()) {
    return "";
  }
  loadExternalSerpEnvOnly(false);
  const fromExternal = externalSerpEnv[key];
  return (typeof fromExternal === "string" && fromExternal.trim()) ? fromExternal.trim() : "";
}

function loadAllEnv(force = false) {
  if (!loaded || force) {
    parseEnvFile(PLUGIN_ENV_PATH, false);
    parseEnvFile(GLOBAL_ENV_PATH, false);
    loadExternalSerpEnvOnly(true);
    loaded = true;
  } else {
    loadExternalSerpEnvOnly(false);
  }
  return getEnvStatus();
}

function getGithubToken() {
  loadAllEnv();
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
}

function getNetlifyToken() {
  loadAllEnv();
  return process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PERSONAL_ACCESS_TOKEN || process.env.NETLIFY_TOKEN || "";
}

function getHfToken() {
  loadAllEnv();
  return process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN || process.env.HUGGINGFACE_API_KEY || "";
}

function getSerpApiKeyPools() {
  if (!loaded) {
    loadAllEnv(false);
  } else {
    loadExternalSerpEnvOnly(false);
  }

  const webKeyNames = ["SERPAPI_API_KEY", "SERPAPI_NEWS_KEY"];
  for (let i = 2; i <= 20; i++) {
    webKeyNames.push(`SERPAPI_NEWS_KEY_${i}`);
  }
  webKeyNames.push("SERPAPI_KEY");

  const jobsKeyNames = ["SERPAPI_JOBS_KEY"];
  for (let i = 2; i <= 20; i++) {
    jobsKeyNames.push(`SERPAPI_JOBS_KEY_${i}`);
  }

  const webSet = new Set();
  for (const name of webKeyNames) {
    const val = getSerpVar(name);
    if (val) webSet.add(val);
  }

  const jobsSet = new Set();
  for (const name of jobsKeyNames) {
    const val = getSerpVar(name);
    if (val) jobsSet.add(val);
  }

  const webKeys = Array.from(webSet);
  const jobsKeys = Array.from(jobsSet);
  const allKeys = Array.from(new Set([...webKeys, ...jobsKeys]));

  return {
    webKeys,
    jobsKeys,
    allKeys
  };
}

function getSerpApiKey() {
  const { webKeys, jobsKeys } = getSerpApiKeyPools();
  return webKeys[0] || jobsKeys[0] || "";
}

function getEnvStatus() {
  const { webKeys, jobsKeys, allKeys } = getSerpApiKeyPools();
  return {
    githubConfigured: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
    netlifyConfigured: Boolean(process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PERSONAL_ACCESS_TOKEN || process.env.NETLIFY_TOKEN),
    hfConfigured: Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN || process.env.HUGGINGFACE_API_KEY),
    freeaiConfigured: Boolean(process.env.FREEAI_API_KEY_1 || process.env.FREEAI_API_KEY_2 || process.env.FREE_AI_API_KEY),
    serpApiConfigured: allKeys.length > 0,
    serpApiWebKeysCount: webKeys.length,
    serpApiJobsKeysCount: jobsKeys.length
  };
}

loadAllEnv();

module.exports = {
  loadAllEnv,
  getGithubToken,
  getNetlifyToken,
  getHfToken,
  getSerpApiKey,
  getSerpApiKeyPools,
  getEnvStatus
};
