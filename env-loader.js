const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ENV_PATH = path.join(__dirname, ".env");
const GLOBAL_ENV_PATH = "C:\\Users\\Benner\\.gemini\\.env";

let loaded = false;

function parseEnvFile(filePath, overrideExisting = false) {
  if (!filePath || !fs.existsSync(filePath)) return 0;
  let count = 0;
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
      if (overrideExisting || !process.env[key]) {
        process.env[key] = val;
        count++;
      }
    }
  } catch (err) {
    console.error(`[EnvLoader] Error reading ${path.basename(filePath)}:`, err.message);
  }
  return count;
}

function loadAllEnv(force = false) {
  if (loaded && !force) return getEnvStatus();
  parseEnvFile(PLUGIN_ENV_PATH, false);
  parseEnvFile(GLOBAL_ENV_PATH, false);
  loaded = true;
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

function getSerpApiKey() {
  loadAllEnv();
  return process.env.SERPAPI_API_KEY || "";
}

function getEnvStatus() {
  return {
    githubConfigured: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
    netlifyConfigured: Boolean(process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_PERSONAL_ACCESS_TOKEN || process.env.NETLIFY_TOKEN),
    hfConfigured: Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_HUB_TOKEN || process.env.HUGGINGFACE_API_KEY),
    freeaiConfigured: Boolean(process.env.FREEAI_API_KEY_1 || process.env.FREEAI_API_KEY_2 || process.env.FREE_AI_API_KEY),
    serpApiConfigured: Boolean(process.env.SERPAPI_API_KEY)
  };
}

loadAllEnv();

module.exports = {
  loadAllEnv,
  getGithubToken,
  getNetlifyToken,
  getHfToken,
  getSerpApiKey,
  getEnvStatus
};
