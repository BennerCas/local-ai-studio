const fs = require("node:fs");
const path = require("node:path");

const STATE_PATH = path.join(__dirname, "datos", "api-usage.json");
const DEFAULTS = Object.freeze({
  groq: { label: "Groq", timeoutMs: 120000 },
  mistral: { label: "Mistral", timeoutMs: 120000 },
  openrouter: { label: "OpenRouter", timeoutMs: 120000 },
  freeai: { label: "Free.ai", timeoutMs: 45000 },
  github: { label: "GitHub", timeoutMs: 30000 },
  netlify: { label: "Netlify", timeoutMs: 30000 },
  huggingface: { label: "Hugging Face", timeoutMs: 30000 },
  serpapi: { label: "SerpApi", timeoutMs: 60000 }
});

function now() { return Date.now(); }

function emptyUsage() {
  return {
    calls: 0,
    success: 0,
    errors: 0,
    rateLimited: 0,
    timeouts: 0,
    lastStatus: 0,
    lastLatencyMs: 0,
    totalLatencyMs: 0,
    lastRequestAt: 0,
    windowStartedAt: now()
  };
}

function defaultProvider(id) {
  const def = DEFAULTS[id] || { label: id };
  return {
    id,
    label: def.label,
    enabled: true,
    maxCalls: 0,
    windowMs: 60 * 60 * 1000,
    timeoutMs: def.timeoutMs || 120000,
    minIntervalMs: 0,
    usage: emptyUsage()
  };
}

function ensureStateShape(raw = {}) {
  const providers = {};
  const source = raw && raw.providers && typeof raw.providers === "object" ? raw.providers : {};
  for (const id of new Set([...Object.keys(DEFAULTS), ...Object.keys(source)])) {
    const base = defaultProvider(id);
    const input = source[id] && typeof source[id] === "object" ? source[id] : {};
    providers[id] = {
      ...base,
      label: String(input.label || base.label),
      enabled: input.enabled !== false,
      maxCalls: clampInt(input.maxCalls === undefined ? base.maxCalls : input.maxCalls, 0, 100000),
      windowMs: clampInt(input.windowMs === undefined ? base.windowMs : input.windowMs, 60 * 1000, 24 * 60 * 60 * 1000),
      timeoutMs: clampInt(input.timeoutMs === undefined ? base.timeoutMs : input.timeoutMs, 1000, 10 * 60 * 1000),
      minIntervalMs: clampInt(input.minIntervalMs === undefined ? base.minIntervalMs : input.minIntervalMs, 0, 60 * 60 * 1000),
      usage: { ...emptyUsage(), ...(input.usage || {}) }
    };
  }
  return { version: 1, providers };
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readState() {
  try {
    return ensureStateShape(JSON.parse(fs.readFileSync(STATE_PATH, "utf8")));
  } catch (_err) {
    return ensureStateShape();
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function getProvider(state, id) {
  const clean = String(id || "").trim().toLowerCase();
  return clean && state.providers[clean] ? state.providers[clean] : null;
}

function rollover(provider, timestamp = now()) {
  const usage = provider.usage;
  if (!usage.windowStartedAt || timestamp - usage.windowStartedAt >= provider.windowMs) {
    provider.usage = { ...emptyUsage(), windowStartedAt: timestamp };
  }
}

function begin(providerId, kind = "request") {
  const state = readState();
  const provider = getProvider(state, providerId);
  if (!provider || provider.enabled === false) return { allowed: true, tracked: false, kind };
  const timestamp = now();
  rollover(provider, timestamp);
  const elapsed = provider.usage.lastRequestAt ? timestamp - provider.usage.lastRequestAt : Infinity;
  if (provider.maxCalls > 0 && provider.usage.calls >= provider.maxCalls) {
    writeState(state);
    return { allowed: false, tracked: true, reason: "max_calls", retryAfterMs: Math.max(1000, provider.windowMs - (timestamp - provider.usage.windowStartedAt)), kind };
  }
  if (provider.minIntervalMs > 0 && elapsed < provider.minIntervalMs) {
    writeState(state);
    return { allowed: false, tracked: true, reason: "min_interval", retryAfterMs: provider.minIntervalMs - elapsed, kind };
  }
  provider.usage.calls += 1;
  provider.usage.lastRequestAt = timestamp;
  writeState(state);
  return { allowed: true, tracked: true, providerId: provider.id, startedAt: timestamp, kind };
}

function finish(providerId, reservation, result = {}) {
  if (!reservation || !reservation.tracked || !reservation.startedAt) return;
  const state = readState();
  const provider = getProvider(state, providerId);
  if (!provider) return;
  const status = Number(result.status || 0);
  const latency = Math.max(0, now() - reservation.startedAt);
  const usage = provider.usage;
  usage.lastStatus = status;
  usage.lastLatencyMs = latency;
  usage.totalLatencyMs += latency;
  if (result.timeout || result.errorKind === "timeout") usage.timeouts += 1;
  if (status === 429 || result.errorKind === "rate_limited") usage.rateLimited += 1;
  if (status >= 200 && status < 300) usage.success += 1;
  else usage.errors += 1;
  writeState(state);
}

function getTimeout(providerId, fallbackMs = 120000) {
  const provider = getProvider(readState(), providerId);
  return provider ? provider.timeoutMs : fallbackMs;
}

function getState() {
  const state = readState();
  const timestamp = now();
  for (const provider of Object.values(state.providers)) rollover(provider, timestamp);
  writeState(state);
  return state;
}

function updateSettings(input = {}) {
  const state = readState();
  const changes = input.providers && typeof input.providers === "object" ? input.providers : { [input.providerId]: input };
  for (const [id, raw] of Object.entries(changes)) {
    const provider = getProvider(state, id);
    if (!provider || !raw || typeof raw !== "object") continue;
    if (raw.maxCalls !== undefined) provider.maxCalls = clampInt(raw.maxCalls, 0, 100000);
    if (raw.windowMs !== undefined) provider.windowMs = clampInt(raw.windowMs, 60 * 1000, 24 * 60 * 60 * 1000);
    if (raw.windowMinutes !== undefined) provider.windowMs = clampInt(Number(raw.windowMinutes) * 60 * 1000, 60 * 1000, 24 * 60 * 60 * 1000);
    if (raw.timeoutMs !== undefined) provider.timeoutMs = clampInt(raw.timeoutMs, 1000, 10 * 60 * 1000);
    if (raw.timeoutSeconds !== undefined) provider.timeoutMs = clampInt(Number(raw.timeoutSeconds) * 1000, 1000, 10 * 60 * 1000);
    if (raw.minIntervalMs !== undefined) provider.minIntervalMs = clampInt(raw.minIntervalMs, 0, 60 * 60 * 1000);
    if (raw.minIntervalSeconds !== undefined) provider.minIntervalMs = clampInt(Number(raw.minIntervalSeconds) * 1000, 0, 60 * 60 * 1000);
  }
  writeState(state);
  return getState();
}

function reset(providerId = null) {
  const state = readState();
  const ids = providerId ? [String(providerId).toLowerCase()] : Object.keys(state.providers);
  for (const id of ids) {
    const provider = getProvider(state, id);
    if (provider) provider.usage = emptyUsage();
  }
  writeState(state);
  return getState();
}

module.exports = { begin, finish, getTimeout, getState, updateSettings, reset, STATE_PATH };
