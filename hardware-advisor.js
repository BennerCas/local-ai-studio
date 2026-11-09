const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const CANONICAL_PAIRS = Object.freeze([
  "freeai+directml",
  "freeai+ollama",
  "ollama+directml"
]);

const CANONICAL_WORKFLOWS = Object.freeze(["pipeline", "parallel", "debate"]);

/**
 * Lista blanca estricta de variables de entorno de rendimiento AI permitidas.
 * Regla Zero-Trust (GEMINI.md 14 / AUDITORIA.md): jamás leer ni mutar secretos o claves API.
 */
const SAFE_AI_ENV_SCHEMA = Object.freeze({
  OLLAMA_IGPU_ENABLE: { type: "enum", values: ["0", "1"], recommended: "1" },
  HSA_OVERRIDE_GFX_VERSION: { type: "regex", pattern: /^\d+\.\d+\.\d+$/, maxLen: 16, recommended: "11.0.0" },
  OLLAMA_FLASH_ATTENTION: { type: "enum", values: ["0", "1"], recommended: "1" },
  OLLAMA_KV_CACHE_TYPE: { type: "enum", values: ["f16", "q8_0", "q4_0"], recommended: "q8_0" },
  OLLAMA_MAX_LOADED_MODELS: { type: "int", min: 1, max: 4, recommended: "1" },
  OLLAMA_NUM_PARALLEL: { type: "int", min: 1, max: 4, recommended: "1" },
  OLLAMA_CONTEXT_LENGTH: { type: "int", min: 1024, max: 65536, recommended: "8192" },
  OLLAMA_KEEP_ALIVE: { type: "regex", pattern: /^(\d+[smh]?|-1|0)$/i, maxLen: 12, recommended: "90s" },
  OLIVE_GPU_MEMORY_LIMIT: { type: "int", min: 4, max: 32, recommended: "20" },
  OLIVE_CPU_THREADS: { type: "int", min: 2, max: 32, recommended: "12" },
  OLIVE_USE_DIRECTML: { type: "enum", values: ["0", "1"], recommended: "1" },
  ORT_DML_DEVICE_ID: { type: "int", min: 0, max: 4, recommended: "0" }
});

const SAFE_AI_ENV_KEYS = Object.freeze(Object.keys(SAFE_AI_ENV_SCHEMA));

const HARDWARE_CACHE_TTL_MS = 15000;
const OLLAMA_LOG_MAX_READ_BYTES = 2 * 1024 * 1024;
const OLLAMA_LOG_HEAD_BYTES = 128 * 1024;
const OLLAMA_LOG_TAIL_BYTES = 1024 * 1024;

let cachedCimSnapshot = null;
let cachedCimTimestamp = 0;
let lastSessionTuningAppliedAt = 0;
let lastSessionAppliedEnv = {};

function roundGb(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

function normalizeEngineSource(rawSource = "") {
  const clean = String(rawSource || "").trim().toLowerCase();
  if (clean === "directml" || clean === "dml" || clean === "onnx") return "directml";
  if (clean === "freeai" || clean === "free.ai" || clean === "free-ai" || clean === "cloud") return "freeai";
  return "ollama";
}

function getDefaultAgentsForPair(rawPair) {
  const pair = normalizeDualPair(rawPair);
  if (pair === "freeai+ollama") {
    return {
      sourceA: "freeai",
      sourceB: "ollama",
      defaultWorkflow: "pipeline",
      unloadBetweenTurns: false
    };
  }
  if (pair === "ollama+directml") {
    return {
      sourceA: "ollama",
      sourceB: "directml",
      defaultWorkflow: "pipeline",
      unloadBetweenTurns: true
    };
  }
  return {
    sourceA: "freeai",
    sourceB: "directml",
    defaultWorkflow: "parallel",
    unloadBetweenTurns: false
  };
}

function normalizeDualPair(rawPair = "", agentA = null, agentB = null) {
  const cleaned = String(rawPair || "")
    .trim()
    .toLowerCase()
    .replace(/free\.ai/g, "freeai")
    .replace(/local/g, "ollama")
    .replace(/\s+/g, "");

  if (cleaned === "freeai+directml" || cleaned === "directml+freeai") return "freeai+directml";
  if (cleaned === "freeai+ollama" || cleaned === "ollama+freeai") return "freeai+ollama";
  if (cleaned === "ollama+directml" || cleaned === "directml+ollama") return "ollama+directml";

  if (agentA && agentB) {
    const sA = normalizeEngineSource(agentA.source);
    const sB = normalizeEngineSource(agentB.source);
    const sorted = [sA, sB].sort().join("+");
    if (sorted === "directml+freeai") return "freeai+directml";
    if (sorted === "freeai+ollama") return "freeai+ollama";
    if (sorted === "directml+ollama") return "ollama+directml";
  }

  return "freeai+directml";
}

function isPairCompatibleWithAgents(pair, agentA, agentB) {
  const sA = normalizeEngineSource(agentA && agentA.source);
  const sB = normalizeEngineSource(agentB && agentB.source);
  if (sA === sB) return false;
  return normalizeDualPair(`${sA}+${sB}`) === normalizeDualPair(pair);
}

function normalizeWorkflow(rawWorkflow = "", fallback = "pipeline") {
  const clean = String(rawWorkflow || "").trim().toLowerCase();
  if (CANONICAL_WORKFLOWS.includes(clean)) return clean;
  return CANONICAL_WORKFLOWS.includes(fallback) ? fallback : "pipeline";
}

function parseModelSizeGb(sizeInput) {
  if (typeof sizeInput === "number" && Number.isFinite(sizeInput)) {
    if (sizeInput <= 0) return 0;
    // Heuristic: values > 10000 are raw bytes (from Ollama /api/tags)
    if (sizeInput > 10000) return roundGb(sizeInput / (1024 * 1024 * 1024));
    return roundGb(sizeInput);
  }
  const raw = String(sizeInput || "").trim();
  if (!raw) return null;
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*(tib|tb|gib|gb|mib|mb|b)?/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!Number.isFinite(num)) return null;
  const unit = (m[2] || "gb").toLowerCase();
  if (unit === "tib" || unit === "tb") return roundGb(num * 1024);
  if (unit === "gib" || unit === "gb") return roundGb(num);
  if (unit === "mib" || unit === "mb") return roundGb(num / 1024);
  if (unit === "b") return roundGb(num / (1024 * 1024 * 1024));
  return roundGb(num);
}

function isCloudModelName(source, modelName, catalogEntry = null) {
  const normSource = normalizeEngineSource(source);
  if (normSource === "freeai") return true;
  if (normSource !== "ollama") return false;
  const lower = String(modelName || "").trim().toLowerCase();
  if (/:cloud\b|-cloud\b/.test(lower)) return true;
  if (catalogEntry && catalogEntry.size !== undefined) {
    const parsedGb = parseModelSizeGb(catalogEntry.size);
    if (parsedGb !== null && parsedGb <= 0.005) return true;
  }
  return false;
}

function estimateModelMemoryGb(source, modelName = "", catalogEntry = null) {
  const normSource = normalizeEngineSource(source);
  const cleanName = String(modelName || "").trim();
  const lower = cleanName.toLowerCase();

  if (isCloudModelName(normSource, cleanName, catalogEntry)) {
    return {
      weightGb: 0,
      isCloud: true,
      tier: "cloud"
    };
  }

  let weightGb = catalogEntry && catalogEntry.size !== undefined
    ? parseModelSizeGb(catalogEntry.size)
    : null;

  if (weightGb === null) {
    if (normSource === "directml") {
      if (lower.includes("phi-3.5-mini") || lower.includes("int4") || lower.includes("awq")) {
        weightGb = 2.3;
      } else if (lower.includes("hermes-3-8b") || lower.includes("q8") || lower.includes("unlocked")) {
        weightGb = 8.5;
      } else if (lower.includes("llama-3.2-3b") && lower.includes("fp16")) {
        weightGb = 7.2;
      } else if (lower.includes("llama-3.2-3b")) {
        weightGb = 2.3;
      } else if (lower.includes("3b")) {
        weightGb = 2.6;
      } else {
        weightGb = 4.5;
      }
    } else {
      // Ollama local heuristics when catalog size is unavailable
      if (lower.includes("0.5b")) weightGb = 0.45;
      else if (lower.includes("1b") || lower.includes("1.5b")) weightGb = 1.2;
      else if (lower.includes("3b")) weightGb = 1.95;
      else if (lower.includes("20b")) weightGb = 13.8;
      else if (lower.includes("13b") || lower.includes("14b")) weightGb = 7.5;
      else if (lower.includes("12b")) weightGb = 8.05;
      else if (lower.includes("9b")) weightGb = 6.55;
      else if (lower.includes("q8") || lower.includes("tools") || lower.includes("claude:latest") || lower.includes("mistral-nemo")) weightGb = 8.6;
      else if (lower.includes("7b") || lower.includes("8b") || lower.includes("coder") || lower.includes("r1")) weightGb = 4.75;
      else weightGb = 4.5;
    }
  }

  const rounded = roundGb(weightGb);
  let tier = "medium";
  if (rounded <= 2.5) tier = "light";
  else if (rounded >= 6.0) tier = "heavy";

  return {
    weightGb: rounded,
    isCloud: false,
    tier
  };
}

function estimateKvOverheadGb(source, weightGb, isCloud, numCtx, envSnapshot = {}) {
  if (isCloud || weightGb <= 0) return 0;
  const ctx = Math.max(1024, Number(numCtx || 4096));
  const normSource = normalizeEngineSource(source);

  if (normSource === "directml") {
    // Calibración realista DirectML / WDDM: workspace DXGI + buffers DML + KV cache proporcional a peso y ctx
    const baseWorkspace = 0.55 + (weightGb * 0.22);
    const ctxRatio = ctx / 4096;
    const ctxScale = ctx >= 16384 ? Math.pow(ctxRatio, 1.15) : ctxRatio;
    const kvPer4k = 0.38 + (weightGb * 0.045);
    return roundGb(Math.max(0.95, baseWorkspace + (ctxScale * kvPer4k)));
  }

  const fa = String(envSnapshot.OLLAMA_FLASH_ATTENTION || "").trim() === "1";
  const kvType = String(envSnapshot.OLLAMA_KV_CACHE_TYPE || "").trim().toLowerCase();
  const kvFactor = (fa && kvType === "q8_0") ? 0.55 : (fa || kvType === "q8_0" ? 0.78 : 1.15);
  return roundGb(Math.max(0.35, (ctx / 4096) * 0.55 * kvFactor));
}

function runPowerShellJson(script, extraEnv = {}, timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      return resolve(null);
    }
    execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 512 * 1024,
        env: { ...process.env, ...extraEnv }
      },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const parsed = JSON.parse(String(stdout).trim());
          resolve(parsed);
        } catch (_parseErr) {
          resolve(null);
        }
      }
    );
  });
}

async function queryWindowsCimSnapshot(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedCimSnapshot && (now - cachedCimTimestamp) < HARDWARE_CACHE_TTL_MS) {
    return cachedCimSnapshot;
  }

  if (process.platform !== "win32") {
    return null;
  }

  const keysLiteral = SAFE_AI_ENV_KEYS.map((k) => `'${k}'`).join(",");
  const psScript = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed",
    "$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'Radeon|AMD|NVIDIA|Intel|Arc' } | Select-Object -First 1 Name,DriverVersion,AdapterRAM",
    "$npu = Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match 'NPU Compute' } | Select-Object -First 1 Name,Status",
    `$keys = @(${keysLiteral})`,
    "$userEnv = @{}",
    "foreach ($k in $keys) { $val = [Environment]::GetEnvironmentVariable($k, 'User'); $userEnv[$k] = if ($null -eq $val) { '' } else { [string]$val } }",
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'ollama.exe' OR Name = 'ollama app.exe' OR Name LIKE 'python%'\" | ForEach-Object { $n = [string]$_.Name; $isDml = ($n -like 'python*') -and ([string]$_.CommandLine -match 'api_openai\\.py'); if ($n -eq 'ollama.exe' -or $n -eq 'ollama app.exe' -or $isDml) { $cDate = ''; try { if ($_.CreationDate) { $cDate = ([DateTime]$_.CreationDate).ToUniversalTime().ToString('o') } } catch {}; @{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $n; startedAt = $cDate; kind = $(if ($isDml) { 'directml' } else { 'ollama' }) } } })",
    "@{ cpu = $cpu; gpu = $gpu; npu = $npu; userEnv = $userEnv; processes = $procs } | ConvertTo-Json -Depth 4 -Compress"
  ].join("; ");

  const data = await runPowerShellJson(psScript, {}, 5000);
  if (data) {
    cachedCimSnapshot = data;
    cachedCimTimestamp = now;
  }
  return data;
}

function sanitizeEnvSubset(rawMap = {}) {
  const out = {};
  for (const key of SAFE_AI_ENV_KEYS) {
    const raw = rawMap && rawMap[key] !== undefined && rawMap[key] !== null
      ? String(rawMap[key]).trim()
      : "";
    out[key] = raw;
  }
  return out;
}

function normalizeRuntimeEnvValue(key, rawVal) {
  const str = String(rawVal ?? "").trim();
  if (!str) return "";
  if (key === "OLLAMA_IGPU_ENABLE" || key === "OLLAMA_FLASH_ATTENTION" || key === "OLIVE_USE_DIRECTML") {
    const lower = str.toLowerCase();
    if (lower === "true") return "1";
    if (lower === "false") return "0";
    return str;
  }
  if (key === "OLLAMA_KV_CACHE_TYPE") {
    return str.toLowerCase();
  }
  if (key === "OLLAMA_KEEP_ALIVE") {
    return str
      .toLowerCase()
      .replace(/^(\d+)m0s$/, "$1m")
      .replace(/^(\d+)h0m0s$/, "$1h")
      .replace(/^0s$/, "0");
  }
  return str;
}

function extractSafeEnvFromOllamaServerConfigLine(line) {
  const marker = 'env="map[';
  const startIdx = line.indexOf(marker);
  if (startIdx < 0) return null;
  const tail = line.slice(startIdx + marker.length);
  const endIdx = tail.lastIndexOf(']"');
  const mapBody = endIdx >= 0 ? tail.slice(0, endIdx) : tail;

  const parsed = {};
  for (const key of SAFE_AI_ENV_KEYS) {
    const match = mapBody.match(new RegExp(`(?:^|\\s)${key}:([^\\s\\]]*)`));
    if (match) {
      parsed[key] = normalizeRuntimeEnvValue(key, match[1]);
    }
  }
  return sanitizeEnvSubset(parsed);
}

function parseOllamaServerLog(logText = "") {
  const lines = String(logText || "").split(/\r?\n/);
  let bootTimestampIso = null;
  let bootTimestampMs = 0;
  let lastEventMs = 0;
  let envKnown = false;
  let env = sanitizeEnvSubset({});
  let lastDroppingIndex = -1;
  let lastGpuIndex = -1;
  let cpuOnlyInLog = false;
  let gpuDetectedInLog = false;
  let computeBackend = "unknown";
  let totalVramText = "";

  const resetBootSegment = (tsIso, tsMs) => {
    bootTimestampIso = tsIso || bootTimestampIso;
    bootTimestampMs = tsMs || bootTimestampMs;
    lastDroppingIndex = -1;
    lastGpuIndex = -1;
    cpuOnlyInLog = false;
    gpuDetectedInLog = false;
    computeBackend = "unknown";
    totalVramText = "";
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (!line) continue;

    const timeMatch = line.match(/^time=([^\s]+)/);
    const tsIso = timeMatch ? timeMatch[1] : null;
    const tsMs = tsIso ? Date.parse(tsIso) : NaN;
    if (Number.isFinite(tsMs)) {
      lastEventMs = tsMs;
    }

    if (line.includes('msg="server config"')) {
      resetBootSegment(tsIso, Number.isFinite(tsMs) ? tsMs : 0);
      const extracted = extractSafeEnvFromOllamaServerConfigLine(line);
      if (extracted) {
        env = extracted;
        envKnown = true;
      }
      continue;
    }

    if (line.includes('msg="Listening on')) {
      if (!bootTimestampMs || (Number.isFinite(tsMs) && Math.abs(tsMs - bootTimestampMs) > 30000)) {
        resetBootSegment(tsIso, Number.isFinite(tsMs) ? tsMs : 0);
        envKnown = false;
        env = sanitizeEnvSubset({});
      }
      continue;
    }

    if (line.includes("dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1")) {
      lastDroppingIndex = idx;
      if (!bootTimestampMs && Number.isFinite(tsMs)) {
        bootTimestampIso = tsIso;
        bootTimestampMs = tsMs;
      }
      continue;
    }

    if (line.includes('msg="inference compute"')) {
      const libMatch = line.match(/\blibrary=([^\s"]+)/);
      const lib = libMatch ? libMatch[1].toLowerCase() : "";
      if (lib === "cpu") {
        cpuOnlyInLog = !gpuDetectedInLog;
        if (!gpuDetectedInLog) computeBackend = "cpu";
      } else if (/^(rocm|vulkan|cuda|metal|oneapi|sycl)$/.test(lib)) {
        gpuDetectedInLog = true;
        cpuOnlyInLog = false;
        computeBackend = lib;
        lastGpuIndex = idx;
      }
      continue;
    }

    if (line.includes('msg="vram-based default context"')) {
      const vramMatch = line.match(/total_vram="([^"]+)"/);
      if (vramMatch) {
        totalVramText = vramMatch[1];
        const parsedVramGb = parseModelSizeGb(totalVramText);
        if (parsedVramGb !== null && parsedVramGb > 0.05) {
          gpuDetectedInLog = true;
          cpuOnlyInLog = false;
          lastGpuIndex = idx;
        }
      }
    }
  }

  const droppingIgpuInLog = lastDroppingIndex >= 0 && lastDroppingIndex > lastGpuIndex;
  return {
    bootTimestampIso,
    bootTimestampMs,
    lastEventMs,
    envKnown,
    env,
    droppingIgpuInLog,
    gpuDetectedInLog: gpuDetectedInLog && !droppingIgpuInLog,
    cpuOnlyInLog: cpuOnlyInLog || droppingIgpuInLog,
    computeBackend,
    totalVramText
  };
}

function readOllamaServerLogBounded(logPath) {
  if (!logPath || !fs.existsSync(logPath)) {
    return { found: false, text: "", mtimeMs: 0 };
  }
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= OLLAMA_LOG_MAX_READ_BYTES) {
      return {
        found: true,
        text: fs.readFileSync(logPath, "utf8"),
        mtimeMs: stat.mtimeMs
      };
    }
    const fd = fs.openSync(logPath, "r");
    try {
      const headBuf = Buffer.alloc(OLLAMA_LOG_HEAD_BYTES);
      const headRead = fs.readSync(fd, headBuf, 0, OLLAMA_LOG_HEAD_BYTES, 0);
      const tailOffset = Math.max(0, stat.size - OLLAMA_LOG_TAIL_BYTES);
      const tailBuf = Buffer.alloc(stat.size - tailOffset);
      const tailRead = fs.readSync(fd, tailBuf, 0, tailBuf.length, tailOffset);
      return {
        found: true,
        text: `${headBuf.subarray(0, headRead).toString("utf8")}\n${tailBuf.subarray(0, tailRead).toString("utf8")}`,
        mtimeMs: stat.mtimeMs
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch (_err) {
    return { found: false, text: "", mtimeMs: 0 };
  }
}

async function detectLiveOllamaAcceleration(options = {}) {
  const cim = options.cim !== undefined
    ? options.cim
    : (options.processes !== undefined ? null : await queryWindowsCimSnapshot(Boolean(options.forceRefresh)));

  const rawProcesses = Array.isArray(options.processes)
    ? options.processes
    : (Array.isArray(cim?.processes) ? cim.processes : (cim?.processes ? [cim.processes] : []));

  const ollamaProcs = rawProcesses.filter((p) => p && String(p.name || "").toLowerCase() === "ollama.exe");
  const ollamaAppProcs = rawProcesses.filter((p) => p && String(p.name || "").toLowerCase() === "ollama app.exe");
  const directmlProcs = rawProcesses.filter((p) => p && String(p.kind || "").toLowerCase() === "directml");

  const pids = ollamaProcs.map((p) => Number(p.pid)).filter((n) => Number.isFinite(n) && n > 0);
  const appPids = ollamaAppProcs.map((p) => Number(p.pid)).filter((n) => Number.isFinite(n) && n > 0);
  const alive = pids.length > 0 || appPids.length > 0;

  let startedAtMs = 0;
  let startedAt = null;
  for (const proc of [...ollamaProcs, ...ollamaAppProcs]) {
    if (!proc.startedAt) continue;
    const ms = Date.parse(proc.startedAt);
    if (Number.isFinite(ms) && ms > startedAtMs) {
      startedAtMs = ms;
      startedAt = new Date(ms).toISOString();
    }
  }

  const studioPid = Number(options.studioPid ?? process.pid);
  const spawnedByStudio = ollamaProcs.some((p) => Number(p.ppid) === studioPid);

  const defaultLogPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Ollama", "server.log")
    : "";
  const logPath = options.logPath !== undefined ? options.logPath : defaultLogPath;

  let logFound = false;
  let logMtimeMs = 0;
  let parsedLog = parseOllamaServerLog("");
  if (typeof options.logContent === "string") {
    logFound = true;
    logMtimeMs = Number(options.logMtimeMs || Date.now());
    parsedLog = parseOllamaServerLog(options.logContent);
  } else if (logPath) {
    const readRes = readOllamaServerLogBounded(logPath);
    logFound = readRes.found;
    logMtimeMs = readRes.mtimeMs;
    if (readRes.found) {
      parsedLog = parseOllamaServerLog(readRes.text);
    }
  }

  const referenceLogMs = parsedLog.bootTimestampMs || parsedLog.lastEventMs || logMtimeMs;
  const logMatchesLiveProcess = Boolean(
    alive &&
    logFound &&
    (startedAtMs === 0 || (referenceLogMs > 0 && referenceLogMs >= (startedAtMs - 10000)))
  );

  const sessionAtMs = Number(options.sessionAppliedAtMs ?? lastSessionTuningAppliedAt);
  const sessionEnv = options.sessionAppliedEnv ?? lastSessionAppliedEnv;
  const baseProcEnv = options.processEnv ?? process.env;
  const restartedFromStudioTuning = Boolean(
    alive &&
    (spawnedByStudio || (sessionAtMs > 0 && startedAtMs > 0 && startedAtMs >= (sessionAtMs - 2000)))
  );

  let droppingIgpu = false;
  let gpuDetected = false;
  let cpuOnly = false;
  let computeBackend = "unknown";
  let totalVramText = "";
  let envKnown = false;
  let env = sanitizeEnvSubset({});

  if (alive && logMatchesLiveProcess) {
    droppingIgpu = parsedLog.droppingIgpuInLog;
    gpuDetected = parsedLog.gpuDetectedInLog;
    cpuOnly = parsedLog.cpuOnlyInLog;
    computeBackend = parsedLog.computeBackend;
    totalVramText = parsedLog.totalVramText;
    envKnown = parsedLog.envKnown;
    env = parsedLog.env;
  } else if (restartedFromStudioTuning) {
    const mergedLive = sanitizeEnvSubset({ ...baseProcEnv, ...sessionEnv });
    const igpuEnabled = normalizeRuntimeEnvValue("OLLAMA_IGPU_ENABLE", mergedLive.OLLAMA_IGPU_ENABLE) === "1";
    droppingIgpu = !igpuEnabled;
    gpuDetected = igpuEnabled;
    cpuOnly = !igpuEnabled;
    computeBackend = igpuEnabled ? "rocm" : "cpu";
    envKnown = true;
    env = mergedLive;
  }

  const dmlPids = directmlProcs.map((p) => Number(p.pid)).filter((n) => Number.isFinite(n) && n > 0);
  let dmlStartedAtMs = 0;
  let dmlStartedAt = null;
  for (const proc of directmlProcs) {
    if (!proc.startedAt) continue;
    const ms = Date.parse(proc.startedAt);
    if (Number.isFinite(ms) && ms > dmlStartedAtMs) {
      dmlStartedAtMs = ms;
      dmlStartedAt = new Date(ms).toISOString();
    }
  }
  const dmlSpawnedByStudio = directmlProcs.some((p) => Number(p.ppid) === studioPid);
  const dmlStaleEnvForSession = Boolean(
    directmlProcs.length > 0 &&
    sessionAtMs > 0 &&
    dmlStartedAtMs > 0 &&
    dmlStartedAtMs < (sessionAtMs - 500) &&
    (sessionEnv.OLIVE_GPU_MEMORY_LIMIT !== undefined || sessionEnv.OLIVE_CPU_THREADS !== undefined)
  );

  return {
    ollamaRuntime: {
      alive,
      pids,
      appPids,
      startedAt,
      spawnedByStudio,
      logPath,
      logFound,
      logMatchesLiveProcess,
      droppingIgpu,
      gpuDetected,
      cpuOnly,
      computeBackend,
      totalVramText,
      envKnown,
      env
    },
    directmlRuntime: {
      alive: dmlPids.length > 0,
      pids: dmlPids,
      startedAt: dmlStartedAt,
      spawnedByStudio: dmlSpawnedByStudio,
      staleEnvForSession: dmlStaleEnvForSession,
      envKnown: dmlSpawnedByStudio && !dmlStaleEnvForSession,
      env: (dmlSpawnedByStudio && !dmlStaleEnvForSession)
        ? sanitizeEnvSubset({ ...baseProcEnv, ...sessionEnv })
        : sanitizeEnvSubset({})
    }
  };
}

async function getHostHardwareTelemetry(options = {}) {
  if (options && options.telemetryOverride && typeof options.telemetryOverride === "object") {
    const ov = options.telemetryOverride;
    const processEnv = sanitizeEnvSubset({ ...process.env, ...(ov.env?.process || {}) });
    const userEnv = sanitizeEnvSubset(ov.env?.user || ov.env?.effective || processEnv);
    const effective = {};
    for (const key of SAFE_AI_ENV_KEYS) {
      effective[key] = processEnv[key] || userEnv[key] || "";
    }
    const ovOllama = ov.ollamaRuntime && typeof ov.ollamaRuntime === "object" ? ov.ollamaRuntime : null;
    const ovDml = ov.directmlRuntime && typeof ov.directmlRuntime === "object" ? ov.directmlRuntime : null;
    return {
      platform: ov.platform || process.platform,
      collectedAt: new Date().toISOString(),
      cpu: {
        name: ov.cpu?.name || "AMD Ryzen AI 7 350 w/ Radeon 860M",
        cores: Number(ov.cpu?.cores || 8),
        logicalThreads: Number(ov.cpu?.logicalThreads || 16),
        maxClockMHz: Number(ov.cpu?.maxClockMHz || 2000)
      },
      gpu: {
        name: ov.gpu?.name || "AMD Radeon(TM) 860M Graphics",
        driverVersion: ov.gpu?.driverVersion || "32.0.32015.12012",
        dedicatedVramGb: roundGb(ov.gpu?.dedicatedVramGb ?? 2.0),
        isRadeon860M: ov.gpu?.isRadeon860M !== false
      },
      npu: {
        present: ov.npu?.present !== false,
        name: ov.npu?.name || "NPU Compute Accelerator Device",
        status: ov.npu?.status || "OK"
      },
      ram: {
        totalGb: roundGb(ov.ram?.totalGb ?? 29.66),
        freeGb: roundGb(ov.ram?.freeGb ?? 7.2),
        usedGb: roundGb((ov.ram?.totalGb ?? 29.66) - (ov.ram?.freeGb ?? 7.2))
      },
      env: {
        process: processEnv,
        user: userEnv,
        effective
      },
      ollamaRuntime: ovOllama ? {
        alive: ovOllama.alive !== false,
        pids: Array.isArray(ovOllama.pids) ? ovOllama.pids : [],
        appPids: Array.isArray(ovOllama.appPids) ? ovOllama.appPids : [],
        startedAt: ovOllama.startedAt || null,
        spawnedByStudio: Boolean(ovOllama.spawnedByStudio),
        logPath: ovOllama.logPath || "",
        logFound: Boolean(ovOllama.logFound),
        logMatchesLiveProcess: Boolean(ovOllama.logMatchesLiveProcess),
        droppingIgpu: Boolean(ovOllama.droppingIgpu),
        gpuDetected: Boolean(ovOllama.gpuDetected),
        cpuOnly: Boolean(ovOllama.cpuOnly),
        computeBackend: ovOllama.computeBackend || "unknown",
        totalVramText: ovOllama.totalVramText || "",
        envKnown: Boolean(ovOllama.envKnown || (ovOllama.env && Object.keys(ovOllama.env).length > 0)),
        env: sanitizeEnvSubset(ovOllama.env || {})
      } : {
        alive: false,
        pids: [],
        appPids: [],
        startedAt: null,
        spawnedByStudio: false,
        logPath: "",
        logFound: false,
        logMatchesLiveProcess: false,
        droppingIgpu: false,
        gpuDetected: false,
        cpuOnly: false,
        computeBackend: "unknown",
        totalVramText: "",
        envKnown: false,
        env: sanitizeEnvSubset({})
      },
      directmlRuntime: ovDml ? {
        alive: ovDml.alive !== false,
        pids: Array.isArray(ovDml.pids) ? ovDml.pids : [],
        startedAt: ovDml.startedAt || null,
        spawnedByStudio: Boolean(ovDml.spawnedByStudio),
        staleEnvForSession: Boolean(ovDml.staleEnvForSession),
        envKnown: Boolean(ovDml.envKnown || (ovDml.env && Object.keys(ovDml.env).length > 0)),
        env: sanitizeEnvSubset(ovDml.env || {})
      } : {
        alive: false,
        pids: [],
        startedAt: null,
        spawnedByStudio: false,
        staleEnvForSession: false,
        envKnown: false,
        env: sanitizeEnvSubset({})
      }
    };
  }

  const totalGb = roundGb(os.totalmem() / (1024 * 1024 * 1024));
  const freeGb = roundGb(os.freemem() / (1024 * 1024 * 1024));
  const cpus = os.cpus() || [];
  const cim = await queryWindowsCimSnapshot(Boolean(options.forceRefresh));

  const cpuName = (cim && cim.cpu && cim.cpu.Name) || (cpus[0] && cpus[0].model) || "CPU Host";
  const logicalThreads = Number((cim && cim.cpu && cim.cpu.NumberOfLogicalProcessors) || cpus.length || 8);
  const physicalCores = Number((cim && cim.cpu && cim.cpu.NumberOfCores) || Math.max(1, Math.floor(logicalThreads / 2)));

  const gpuName = (cim && cim.gpu && cim.gpu.Name) || "GPU Integrada / Sistema";
  const adapterRamBytes = Number((cim && cim.gpu && cim.gpu.AdapterRAM) || 0);
  const dedicatedVramGb = adapterRamBytes > 0 ? roundGb(adapterRamBytes / (1024 * 1024 * 1024)) : 2.0;

  const processEnv = sanitizeEnvSubset(process.env);
  const userEnv = sanitizeEnvSubset((cim && cim.userEnv) || {});
  const effective = {};
  for (const key of SAFE_AI_ENV_KEYS) {
    effective[key] = processEnv[key] || userEnv[key] || "";
  }

  const { ollamaRuntime, directmlRuntime } = await detectLiveOllamaAcceleration({
    cim,
    forceRefresh: Boolean(options.forceRefresh)
  });

  return {
    platform: process.platform,
    collectedAt: new Date().toISOString(),
    cpu: {
      name: String(cpuName).trim(),
      cores: physicalCores,
      logicalThreads,
      maxClockMHz: Number((cim && cim.cpu && cim.cpu.MaxClockSpeed) || (cpus[0] && cpus[0].speed) || 0)
    },
    gpu: {
      name: String(gpuName).trim(),
      driverVersion: String((cim && cim.gpu && cim.gpu.DriverVersion) || ""),
      dedicatedVramGb,
      isRadeon860M: /860m|radeon/i.test(`${gpuName} ${cpuName}`)
    },
    npu: {
      present: Boolean(cim && cim.npu && cim.npu.Name),
      name: String((cim && cim.npu && cim.npu.Name) || ""),
      status: String((cim && cim.npu && cim.npu.Status) || "")
    },
    ram: {
      totalGb,
      freeGb,
      usedGb: roundGb(Math.max(0, totalGb - freeGb))
    },
    env: {
      process: processEnv,
      user: userEnv,
      effective
    },
    ollamaRuntime,
    directmlRuntime
  };
}

function getRecommendedProfiles(telemetry = null) {
  const freeGb = Number(telemetry?.ram?.freeGb ?? 8.0);
  const totalThreads = Number(telemetry?.cpu?.logicalThreads ?? 16);
  const dmlThreadsSolo = Math.min(12, Math.max(4, totalThreads - 4));
  const dmlThreadsShared = Math.min(8, Math.max(4, Math.floor(totalThreads * 0.4)));
  const dmlLimitSolo = freeGb >= 12 ? "24" : "20";
  const dmlLimitShared = "12";

  return {
    "freeai+directml": {
      pair: "freeai+directml",
      title: "Free.ai Cloud + DirectML Nativo (Cero Contención GPU)",
      badge: "Recomendado Velocidad",
      recommendedWorkflow: "parallel",
      unloadBetweenTurns: false,
      suggestedEnv: {
        OLIVE_GPU_MEMORY_LIMIT: dmlLimitSolo,
        OLIVE_CPU_THREADS: String(dmlThreadsSolo),
        OLIVE_USE_DIRECTML: "1",
        ORT_DML_DEVICE_ID: "0",
        OLLAMA_IGPU_ENABLE: "1"
      },
      suggestedRuntime: {
        directmlMaxTokens: 2048,
        ollamaNumCtx: 8192
      },
      rationale: "Free.ai ejecuta en la nube (0 GB de RAM/VRAM local). Toda la Radeon 860M y los hilos de CPU quedan libres para ONNX DirectML.",
      actionsHint: [
        "Permite ejecución Paralela (A ‖ B) o Pipeline (A → B) sin contención DXGI.",
        "Descargar modelos inactivos de Ollama (/api/ps) devuelve RAM adicional para DirectML."
      ]
    },
    "freeai+ollama": {
      pair: "freeai+ollama",
      title: "Free.ai Cloud + Ollama GGUF (iGPU Acelerada)",
      badge: "Recomendado Potencia GGUF",
      recommendedWorkflow: "pipeline",
      unloadBetweenTurns: false,
      suggestedEnv: {
        OLLAMA_IGPU_ENABLE: "1",
        HSA_OVERRIDE_GFX_VERSION: "11.0.0",
        OLLAMA_FLASH_ATTENTION: "1",
        OLLAMA_KV_CACHE_TYPE: "q8_0",
        OLLAMA_MAX_LOADED_MODELS: "1",
        OLLAMA_NUM_PARALLEL: "1",
        OLLAMA_CONTEXT_LENGTH: freeGb >= 10 ? "8192" : "4096",
        OLLAMA_KEEP_ALIVE: "5m"
      },
      suggestedRuntime: {
        directmlMaxTokens: 2048,
        ollamaNumCtx: freeGb >= 10 ? 8192 : 4096
      },
      rationale: "Free.ai asume el análisis/contexto extenso en nube y Ollama ejecuta GGUF local acelerado por iGPU RDNA 3.5 con caché KV cuantizada q8_0.",
      actionsHint: [
        "Activar OLLAMA_IGPU_ENABLE=1 + OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0 ahorra ~45-50% de VRAM compartida.",
        "Si el servidor DirectML (puerto 8002) estuviera residente, detenerlo libera 2.3–8.5 GB para GGUF grandes."
      ]
    },
    "ollama+directml": {
      pair: "ollama+directml",
      title: "Ollama Local + DirectML Nativo (Doble Motor en APU)",
      badge: "Modo Sensible a VRAM",
      recommendedWorkflow: "pipeline",
      unloadBetweenTurns: true,
      suggestedEnv: {
        OLIVE_GPU_MEMORY_LIMIT: dmlLimitShared,
        OLIVE_CPU_THREADS: String(dmlThreadsShared),
        OLIVE_USE_DIRECTML: "1",
        ORT_DML_DEVICE_ID: "0",
        OLLAMA_IGPU_ENABLE: "1",
        HSA_OVERRIDE_GFX_VERSION: "11.0.0",
        OLLAMA_FLASH_ATTENTION: "1",
        OLLAMA_KV_CACHE_TYPE: "q8_0",
        OLLAMA_MAX_LOADED_MODELS: "1",
        OLLAMA_NUM_PARALLEL: "1",
        OLLAMA_CONTEXT_LENGTH: "4096",
        OLLAMA_KEEP_ALIVE: "90s"
      },
      suggestedRuntime: {
        directmlMaxTokens: 1536,
        ollamaNumCtx: 4096
      },
      rationale: "Ambos motores locales comparten los mismos 32 GB unificados y la iGPU Radeon 860M. Tope dinámico de DirectML a 12 GB + 6 hilos y ejecución secuencial A → B protegen contra DXGI_ERROR_DEVICE_RESET.",
      actionsHint: [
        "Por defecto opera en Pipeline Secuencial (A → B) con descarga rápida keep_alive=0 entre turnos.",
        "Si Ollama usa un modelo ':cloud' (0 GB local), se desbloquea el modo Paralelo sin riesgo de VRAM."
      ]
    }
  };
}

function findCatalogEntry(modelsCatalog = [], source, modelName) {
  if (!Array.isArray(modelsCatalog) || !modelName) return null;
  const normSource = normalizeEngineSource(source);
  const cleanTarget = String(modelName).trim().replace(/^(freeai:|directml:)/, "");
  return modelsCatalog.find((m) => {
    if (!m) return false;
    const mSource = m.isDirectML ? "directml" : (m.isFreeAi ? "freeai" : "ollama");
    if (mSource !== normSource) return false;
    const candidate = String(m.name || m.id || "").trim().replace(/^(freeai:|directml:)/, "");
    return candidate === cleanTarget || m.rawId === cleanTarget;
  }) || null;
}

function evaluateDualConfiguration({
  pair: rawPair,
  agentA = {},
  agentB = {},
  workflow: rawWorkflow = "pipeline",
  unloadBetweenTurns = true,
  modelsCatalog = [],
  telemetry = null,
  ollamaPs = [],
  directmlStatus = {}
} = {}) {
  const effectiveTelemetry = telemetry || {
    ram: { totalGb: 29.66, freeGb: 7.2, usedGb: 22.46 },
    cpu: { name: "AMD Ryzen AI 7 350", cores: 8, logicalThreads: 16 },
    gpu: { name: "AMD Radeon(TM) 860M Graphics", dedicatedVramGb: 2.0, isRadeon860M: true },
    env: { effective: sanitizeEnvSubset(process.env) }
  };

  const normA = { ...agentA, source: normalizeEngineSource(agentA.source || getDefaultAgentsForPair(rawPair).sourceA) };
  const normB = { ...agentB, source: normalizeEngineSource(agentB.source || getDefaultAgentsForPair(rawPair).sourceB) };
  const pair = normalizeDualPair(rawPair, normA, normB);
  const workflow = normalizeWorkflow(rawWorkflow, pair === "freeai+directml" ? "parallel" : "pipeline");

  const envEff = (effectiveTelemetry.env && effectiveTelemetry.env.effective) || {};
  const freeRamGb = Number(effectiveTelemetry.ram?.freeGb ?? 7.2);
  const profiles = getRecommendedProfiles(effectiveTelemetry);
  const profile = profiles[pair];

  const catA = findCatalogEntry(modelsCatalog, normA.source, normA.model);
  const catB = findCatalogEntry(modelsCatalog, normB.source, normB.model);
  const memA = estimateModelMemoryGb(normA.source, normA.model, catA);
  const memB = estimateModelMemoryGb(normB.source, normB.model, catB);

  const kvA = estimateKvOverheadGb(normA.source, memA.weightGb, memA.isCloud, normA.numCtx || profile.suggestedRuntime.ollamaNumCtx, envEff);
  const kvB = estimateKvOverheadGb(normB.source, memB.weightGb, memB.isCloud, normB.numCtx || profile.suggestedRuntime.ollamaNumCtx, envEff);

  const totalA = roundGb(memA.weightGb + kvA);
  const totalB = roundGb(memB.weightGb + kvB);

  const bothLocalModels = (normA.source !== "freeai" && !memA.isCloud) && (normB.source !== "freeai" && !memB.isCloud);
  const hasLocalOllama = (normA.source === "ollama" && !memA.isCloud) || (normB.source === "ollama" && !memB.isCloud);
  const hasDirectml = normA.source === "directml" || normB.source === "directml";

  // Calcular RAM ya ocupada por instancias calientes del mismo modelo para no sobre-contabilizar
  const loadedOllamaNames = new Set((Array.isArray(ollamaPs) ? ollamaPs : []).map((p) => String(p.name || p.model || "").trim()));
  let alreadyWarmGb = 0;
  if (normA.source === "ollama" && loadedOllamaNames.has(String(normA.model || "").trim())) {
    alreadyWarmGb += memA.weightGb * 0.7;
  }
  if (normB.source === "ollama" && loadedOllamaNames.has(String(normB.model || "").trim())) {
    alreadyWarmGb += memB.weightGb * 0.7;
  }
  const activeDmlModel = String(directmlStatus?.active_model || "").trim();
  if (activeDmlModel) {
    if (normA.source === "directml" && activeDmlModel === String(normA.model || "").replace(/^directml:/, "")) {
      alreadyWarmGb += memA.weightGb * 0.7;
    }
    if (normB.source === "directml" && activeDmlModel === String(normB.model || "").replace(/^directml:/, "")) {
      alreadyWarmGb += memB.weightGb * 0.7;
    }
  }

  let estimatedPeakLocalGb = 0;
  if (bothLocalModels) {
    if (workflow === "parallel" || !unloadBetweenTurns) {
      estimatedPeakLocalGb = roundGb(totalA + totalB);
    } else {
      estimatedPeakLocalGb = roundGb(Math.max(totalA, totalB) + 0.65);
    }
  } else {
    estimatedPeakLocalGb = roundGb(Math.max(totalA, totalB));
  }

  const additionalNeededGb = roundGb(Math.max(0, estimatedPeakLocalGb - alreadyWarmGb));
  const projectedHeadroomGb = roundGb(freeRamGb - additionalNeededGb);

  const warnings = [];
  const recommendations = [];
  let riskLevel = "optimal";
  const elevateRisk = (next) => {
    if (next === "critical") riskLevel = "critical";
    else if (next === "caution" && riskLevel === "optimal") riskLevel = "caution";
  };

  if (!isPairCompatibleWithAgents(pair, normA, normB)) {
    elevateRisk("caution");
    warnings.push("Los motores asignados a Agente A y B se ajustarán para coincidir con el par dual elegido.");
  }

  // Inspección viva de /api/ps + runtime real de ollama.exe
  const psList = Array.isArray(ollamaPs) ? ollamaPs : [];
  let psShowsCpuOnly = false;
  let psTotalBytes = 0;
  let psVramBytes = 0;
  let psZeroVramCount = 0;

  for (const p of psList) {
    if (!p || typeof p !== "object") continue;
    const pName = String(p.name || p.model || "").trim();
    if (isCloudModelName("ollama", pName, p)) continue;

    const hasVramField = p.size_vram !== undefined && p.size_vram !== null && Number.isFinite(Number(p.size_vram));
    const hasSizeField = p.size !== undefined && p.size !== null && Number.isFinite(Number(p.size));
    if (!hasVramField && !hasSizeField) continue;

    const vramVal = hasVramField ? Math.max(0, Number(p.size_vram)) : 0;
    const sizeVal = hasSizeField ? Math.max(0, Number(p.size)) : 0;

    if (hasVramField) {
      if (vramVal === 0) {
        psShowsCpuOnly = true;
        psZeroVramCount += 1;
      } else if (sizeVal > 0 && (vramVal / sizeVal) < 0.5) {
        psShowsCpuOnly = true;
      }
    }

    if (sizeVal > 0 && hasVramField) {
      psTotalBytes += sizeVal;
      psVramBytes += Math.min(sizeVal, vramVal);
    }
  }

  const psGpuRatio = psTotalBytes > 0
    ? Math.min(1, Math.max(0, Math.round((psVramBytes / psTotalBytes) * 1000) / 1000))
    : (psZeroVramCount > 0 ? 0 : null);

  // Verificar entorno Windows Radeon 860M / Ollama y estado del proceso vivo
  const igpuMissing = hasLocalOllama && String(envEff.OLLAMA_IGPU_ENABLE || "").trim() !== "1";
  const hsaMissing = hasLocalOllama && String(envEff.HSA_OVERRIDE_GFX_VERSION || "").trim() !== "11.0.0";
  const faMissing = hasLocalOllama && String(envEff.OLLAMA_FLASH_ATTENTION || "").trim() !== "1";
  const kvNotQuantized = hasLocalOllama && String(envEff.OLLAMA_KV_CACHE_TYPE || "").trim().toLowerCase() !== "q8_0";

  const ollamaRuntime = effectiveTelemetry.ollamaRuntime && typeof effectiveTelemetry.ollamaRuntime === "object"
    ? effectiveTelemetry.ollamaRuntime
    : null;
  const liveOllamaAlive = Boolean(ollamaRuntime && ollamaRuntime.alive);
  const runtimeDroppingIgpu = Boolean(ollamaRuntime && ollamaRuntime.droppingIgpu === true);
  const liveOllamaEnv = (ollamaRuntime && ollamaRuntime.env && typeof ollamaRuntime.env === "object")
    ? ollamaRuntime.env
    : {};
  const liveOllamaEnvKnown = Boolean(ollamaRuntime && (ollamaRuntime.envKnown || Object.values(liveOllamaEnv).some((v) => String(v || "").trim() !== "")));

  const ollamaCompareKeys = [
    "OLLAMA_IGPU_ENABLE",
    "HSA_OVERRIDE_GFX_VERSION",
    "OLLAMA_FLASH_ATTENTION",
    "OLLAMA_KV_CACHE_TYPE",
    "OLLAMA_MAX_LOADED_MODELS",
    "OLLAMA_NUM_PARALLEL",
    "OLLAMA_CONTEXT_LENGTH",
    "OLLAMA_KEEP_ALIVE"
  ];
  let liveOllamaEnvDiffers = false;
  if (liveOllamaAlive && liveOllamaEnvKnown) {
    for (const k of ollamaCompareKeys) {
      const targetVal = normalizeRuntimeEnvValue(k, envEff[k]);
      if (!targetVal) continue;
      const liveVal = normalizeRuntimeEnvValue(k, liveOllamaEnv[k]);
      if (liveVal !== targetVal) {
        liveOllamaEnvDiffers = true;
        break;
      }
    }
  }
  const liveOllamaMissingIgpu = Boolean(
    liveOllamaAlive &&
    liveOllamaEnvKnown &&
    normalizeRuntimeEnvValue("OLLAMA_IGPU_ENABLE", liveOllamaEnv.OLLAMA_IGPU_ENABLE) !== "1"
  );

  const ollamaRunningOnCpu = Boolean(
    psShowsCpuOnly ||
    runtimeDroppingIgpu ||
    igpuMissing ||
    (hasLocalOllama && liveOllamaMissingIgpu)
  );
  const requiresOllamaRestart = Boolean(
    (hasLocalOllama && (igpuMissing || ollamaRunningOnCpu)) ||
    (liveOllamaAlive && (runtimeDroppingIgpu || psShowsCpuOnly || liveOllamaMissingIgpu || liveOllamaEnvDiffers))
  );

  if (igpuMissing) {
    elevateRisk("caution");
    warnings.push("Falta OLLAMA_IGPU_ENABLE=1 en Windows: Ollama puede caer parcial o totalmente a CPU sin aprovechar la iGPU Radeon 860M.");
    recommendations.push("Aplicar optimización Windows: OLLAMA_IGPU_ENABLE=1 y HSA_OVERRIDE_GFX_VERSION=11.0.0.");
  } else if (hsaMissing) {
    elevateRisk("caution");
    warnings.push("Falta HSA_OVERRIDE_GFX_VERSION=11.0.0 para RDNA 3 / Radeon 860M.");
  }

  if (hasLocalOllama && (ollamaRunningOnCpu || igpuMissing)) {
    elevateRisk("caution");
    warnings.push("Ollama vivo ejecutándose en CPU (iGPU Radeon 860M inactiva en proceso actual). Reinicia Ollama tras aplicar tuning.");
    recommendations.push("Aplica el tuning y ejecuta restartOllama para reiniciar ollama.exe con OLLAMA_IGPU_ENABLE=1 en la iGPU Radeon 860M.");
  } else if (liveOllamaAlive && liveOllamaEnvDiffers && hasLocalOllama) {
    recommendations.push("El proceso vivo de Ollama usa variables previas; ejecuta restartOllama tras aplicar tuning para activar Flash Attention / KV q8_0.");
  }

  if (faMissing || kvNotQuantized) {
    recommendations.push("Activar OLLAMA_FLASH_ATTENTION=1 y OLLAMA_KV_CACHE_TYPE=q8_0 reduce ~45-50% el consumo KV en VRAM compartida.");
  }

  const currentDmlLimit = Number(envEff.OLIVE_GPU_MEMORY_LIMIT || 20);
  const currentDmlThreads = Number(envEff.OLIVE_CPU_THREADS || 12);
  const directmlIsAlive = Boolean(
    directmlStatus &&
    (directmlStatus.isAlive === true || directmlStatus.status === "online" || directmlStatus.ok === true)
  );
  const liveDmlEnv = (directmlStatus && directmlStatus.env && typeof directmlStatus.env === "object")
    ? directmlStatus.env
    : ((effectiveTelemetry.directmlRuntime && effectiveTelemetry.directmlRuntime.env) || {});
  const liveDmlLimit = Number(
    directmlStatus?.oliveGpuMemoryLimit ??
    liveDmlEnv.OLIVE_GPU_MEMORY_LIMIT ??
    currentDmlLimit
  );
  const liveDmlThreads = Number(
    directmlStatus?.oliveCpuThreads ??
    liveDmlEnv.OLIVE_CPU_THREADS ??
    currentDmlThreads
  );
  const recommendedDmlLimit = bothLocalModels
    ? Number(profiles["ollama+directml"].suggestedEnv.OLIVE_GPU_MEMORY_LIMIT || 12)
    : Number(profiles["freeai+directml"].suggestedEnv.OLIVE_GPU_MEMORY_LIMIT || 20);
  const recommendedDmlThreads = bothLocalModels
    ? Number(profiles["ollama+directml"].suggestedEnv.OLIVE_CPU_THREADS || 6)
    : Number(profiles["freeai+directml"].suggestedEnv.OLIVE_CPU_THREADS || 12);
  const dmlEnvKnownDiffers = Boolean(
    effectiveTelemetry.directmlRuntime?.staleEnvForSession ||
    (liveDmlEnv.OLIVE_GPU_MEMORY_LIMIT && envEff.OLIVE_GPU_MEMORY_LIMIT && Number(liveDmlEnv.OLIVE_GPU_MEMORY_LIMIT) !== Number(envEff.OLIVE_GPU_MEMORY_LIMIT)) ||
    (liveDmlEnv.OLIVE_CPU_THREADS && envEff.OLIVE_CPU_THREADS && Number(liveDmlEnv.OLIVE_CPU_THREADS) !== Number(envEff.OLIVE_CPU_THREADS))
  );
  const requiresDirectmlRestart = Boolean(
    hasDirectml &&
    directmlIsAlive &&
    (
      (bothLocalModels && (liveDmlLimit >= 14 || liveDmlLimit !== recommendedDmlLimit || liveDmlThreads !== recommendedDmlThreads)) ||
      (!bothLocalModels && (liveDmlLimit !== recommendedDmlLimit || liveDmlThreads !== recommendedDmlThreads)) ||
      dmlEnvKnownDiffers
    )
  );

  if (bothLocalModels && (currentDmlLimit >= 14 || liveDmlLimit >= 14)) {
    elevateRisk("caution");
    const effectiveShownLimit = Math.max(currentDmlLimit, liveDmlLimit);
    warnings.push(`OLIVE_GPU_MEMORY_LIMIT está en ${effectiveShownLimit} GB; en Modo 3 (Ollama+DirectML local) se recomienda limitar DirectML a 12 GB y ${recommendedDmlThreads} hilos.`);
    recommendations.push("Usar 'Tunear Sesión' con restartDirectML para reiniciar y limitar DirectML a OLIVE_GPU_MEMORY_LIMIT=12 y OLIVE_CPU_THREADS=6.");
  } else if (requiresDirectmlRestart) {
    recommendations.push(`Reinicia DirectML (restartDirectML) para aplicar OLIVE_GPU_MEMORY_LIMIT=${recommendedDmlLimit} y OLIVE_CPU_THREADS=${recommendedDmlThreads} en el proceso vivo.`);
  } else if (!bothLocalModels && hasDirectml && currentDmlLimit < 16) {
    recommendations.push("En este modo Free.ai no usa VRAM local: puedes elevar OLIVE_GPU_MEMORY_LIMIT a 22-25 GB y 12 hilos.");
  }

  const maxDmlCtx = Math.max(
    normA.source === "directml" ? Number(normA.numCtx || 0) : 0,
    normB.source === "directml" ? Number(normB.numCtx || 0) : 0
  );
  if (hasDirectml && maxDmlCtx >= 16384) {
    elevateRisk("caution");
    const peakDmlKv = Math.max(
      normA.source === "directml" ? kvA : 0,
      normB.source === "directml" ? kvB : 0
    );
    warnings.push(`Contexto DirectML elevado (${maxDmlCtx} tokens) incrementa riesgo de contención WDDM/DXGI (~${peakDmlKv} GB de workspace/KV).`);
    recommendations.push("Reduce numCtx de DirectML a 4096-8192 si observas latencia o presión WDDM.");
  }

  const combinedWeights = roundGb(memA.weightGb + memB.weightGb);

  // Contención específica en Modo 3 (Ollama + DirectML locales)
  if (bothLocalModels) {
    if (workflow === "parallel") {
      elevateRisk(combinedWeights >= 6.0 || projectedHeadroomGb < 2.0 ? "critical" : "caution");
      warnings.push("Ejecución paralela de dos motores locales en la misma APU Radeon 860M puede saturar colas DXGI/WDDM.");
      recommendations.push("Usa flujo Pipeline (A → B) con descarga entre turnos, o selecciona una etiqueta ':cloud' en Ollama.");
    }

    if (combinedWeights >= 12.0 || projectedHeadroomGb < 0.75) {
      elevateRisk("critical");
      warnings.push(
        `Riesgo Alto de VRAM/RAM: ${normA.model || normA.source} (${memA.weightGb} GB) + ${normB.model || normB.source} (${memB.weightGb} GB) superan los ${freeRamGb} GB físicos libres.`
      );
      recommendations.push("Cambia DirectML a 'Phi-3.5-mini-instruct-ONNX' (2.3 GB INT4) y usa Ollama <= 4.7 GB (o modelo ':cloud') en Pipeline con unloadBetweenTurns.");
    } else if (projectedHeadroomGb < 2.2) {
      elevateRisk("caution");
      warnings.push(
        `Margen ajustado (${projectedHeadroomGb} GB libres estimados tras carga). Recomendado Pipeline secuencial con keep_alive=90s y num_ctx=4096.`
      );
    }
  } else if (projectedHeadroomGb < 0.5) {
    elevateRisk("critical");
    warnings.push(`RAM libre insuficiente (${freeRamGb} GB libres) frente a ~${additionalNeededGb} GB estimados del modelo local elegido.`);
    recommendations.push("Cierra aplicaciones pesadas o elige un modelo cuantizado más ligero (< 5 GB) / etiqueta ':cloud'.");
  } else if (projectedHeadroomGb < 1.8) {
    elevateRisk("caution");
    warnings.push(`Margen de RAM ajustado (${projectedHeadroomGb} GB tras carga); conviene num_ctx=4096.`);
  }

  // Nota positiva si Ollama usa :cloud en Modo 3
  const ollamaCloudInMode3 = pair === "ollama+directml" && !bothLocalModels;
  if (ollamaCloudInMode3) {
    recommendations.push("Ollama utiliza modelo :cloud (0 GB VRAM local): puedes usar Paralelo o Pipeline sin contención física.");
  }

  return {
    pair,
    workflow,
    riskLevel,
    bothLocalModels,
    allowParallelLocal: !bothLocalModels || (projectedHeadroomGb >= 4.5 && combinedWeights < 5.5),
    unloadBetweenTurns: bothLocalModels ? Boolean(unloadBetweenTurns) : false,
    freeRamGb,
    estimatedPeakLocalGb,
    additionalNeededGb,
    projectedHeadroomGb,
    ollamaRunningOnCpu,
    requiresOllamaRestart,
    requiresDirectmlRestart,
    psGpuRatio,
    agentA: {
      source: normA.source,
      model: normA.model || "",
      weightGb: memA.weightGb,
      kvGb: kvA,
      totalGb: totalA,
      isCloud: memA.isCloud,
      tier: memA.tier
    },
    agentB: {
      source: normB.source,
      model: normB.model || "",
      weightGb: memB.weightGb,
      kvGb: kvB,
      totalGb: totalB,
      isCloud: memB.isCloud,
      tier: memB.tier
    },
    envFlags: {
      igpuMissing,
      hsaMissing,
      faMissing,
      kvNotQuantized,
      currentDmlLimit,
      currentDmlThreads,
      psShowsCpuOnly,
      psGpuRatio,
      ollamaRunningOnCpu,
      requiresOllamaRestart,
      requiresDirectmlRestart
    },
    suggestedEnv: profile.suggestedEnv,
    suggestedRuntime: {
      workflow: ollamaCloudInMode3 ? "parallel" : profile.recommendedWorkflow,
      unloadBetweenTurns: ollamaCloudInMode3 ? false : profile.unloadBetweenTurns,
      agentANumCtx: (normA.source === "ollama" && !memA.isCloud && (bothLocalModels || freeRamGb < 9 || memA.weightGb > 5.5)) ? 4096 : 8192,
      agentBNumCtx: (normB.source === "ollama" && !memB.isCloud && (bothLocalModels || freeRamGb < 9 || memB.weightGb > 5.5)) ? 4096 : 8192,
      directmlMaxTokens: bothLocalModels ? 1536 : 2048
    },
    warnings,
    recommendations
  };
}

function validateSafeEnvOverrides(envOverrides = {}) {
  if (!envOverrides || typeof envOverrides !== "object" || Array.isArray(envOverrides)) {
    throw new Error("envOverrides debe ser un objeto clave/valor válido.");
  }
  const validated = {};
  for (const [rawKey, rawVal] of Object.entries(envOverrides)) {
    const key = String(rawKey || "").trim();
    const spec = SAFE_AI_ENV_SCHEMA[key];
    if (!spec) {
      const err = new Error(`Variable de entorno no permitida por seguridad Zero-Trust: ${key}`);
      err.statusCode = 400;
      throw err;
    }
    const strVal = String(rawVal ?? "").trim();
    if (!strVal) {
      const err = new Error(`Valor vacío inválido para ${key}`);
      err.statusCode = 400;
      throw err;
    }
    if (spec.type === "enum") {
      if (!spec.values.includes(strVal)) {
        const err = new Error(`Valor '${strVal}' inválido para ${key}. Permitidos: ${spec.values.join(", ")}`);
        err.statusCode = 400;
        throw err;
      }
      validated[key] = strVal;
    } else if (spec.type === "int") {
      if (!/^\d+$/.test(strVal)) {
        const err = new Error(`Valor entero inválido para ${key}: ${strVal}`);
        err.statusCode = 400;
        throw err;
      }
      const num = parseInt(strVal, 10);
      if (num < spec.min || num > spec.max) {
        const err = new Error(`Valor de ${key} (${num}) fuera de rango seguro [${spec.min}..${spec.max}]`);
        err.statusCode = 400;
        throw err;
      }
      validated[key] = String(num);
    } else if (spec.type === "regex") {
      if (strVal.length > (spec.maxLen || 32) || !spec.pattern.test(strVal)) {
        const err = new Error(`Formato inválido para ${key}: ${strVal}`);
        err.statusCode = 400;
        throw err;
      }
      validated[key] = strVal;
    }
  }
  return validated;
}

async function applySystemTuning({
  scope = "session",
  pair = null,
  envOverrides = null,
  telemetry = null,
  skipWindowsApply = false
} = {}) {
  const cleanScope = scope === "windows_user" ? "windows_user" : "session";
  const resolvedTelemetry = telemetry || await getHostHardwareTelemetry();

  let targetOverrides = envOverrides && Object.keys(envOverrides).length > 0
    ? { ...envOverrides }
    : {};

  if (Object.keys(targetOverrides).length === 0 && pair) {
    const profiles = getRecommendedProfiles(resolvedTelemetry);
    const matched = profiles[normalizeDualPair(pair)];
    if (matched && matched.suggestedEnv) {
      targetOverrides = { ...matched.suggestedEnv };
    }
  }

  const validated = validateSafeEnvOverrides(targetOverrides);
  const appliedKeys = Object.keys(validated);

  // Siempre aplicar en proceso actual (sesión del sidecar)
  for (const [k, v] of Object.entries(validated)) {
    process.env[k] = v;
  }
  if (appliedKeys.length > 0) {
    lastSessionTuningAppliedAt = Date.now();
    lastSessionAppliedEnv = { ...lastSessionAppliedEnv, ...validated };
    cachedCimSnapshot = null;
  }

  let persistedToWindows = false;
  if (cleanScope === "windows_user" && appliedKeys.length > 0 && !skipWindowsApply) {
    if (process.platform !== "win32") {
      throw new Error("La persistencia User Env de Windows solo está soportada en Windows.");
    }
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "$map = $env:LOCAL_AI_TUNING_JSON | ConvertFrom-Json",
      "$regPath = 'HKCU:\\Environment'",
      "if (-not (Test-Path $regPath)) { New-Item -Path $regPath -Force | Out-Null }",
      "foreach ($prop in $map.PSObject.Properties) { Set-ItemProperty -Path $regPath -Name ([string]$prop.Name) -Value ([string]$prop.Value) -Type String }",
      "try { Add-Type -Namespace LocalAiEnv -Name Win32 -MemberDefinition '[System.Runtime.InteropServices.DllImport(\"user32.dll\", CharSet = System.Runtime.InteropServices.CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'; $r = [UIntPtr]::Zero; [LocalAiEnv.Win32]::SendMessageTimeout([IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment', 2, 250, [ref]$r) | Out-Null } catch {}",
      "'OK'"
    ].join("; ");

    await new Promise((resolve, reject) => {
      execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", psScript],
        {
          windowsHide: true,
          timeout: 15000,
          env: {
            ...process.env,
            LOCAL_AI_TUNING_JSON: JSON.stringify(validated)
          }
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        }
      );
    });
    persistedToWindows = true;
    cachedCimSnapshot = null;
  }

  return {
    ok: true,
    scope: cleanScope,
    persistedToWindows,
    applied: validated,
    appliedKeys
  };
}

module.exports = {
  CANONICAL_PAIRS,
  CANONICAL_WORKFLOWS,
  SAFE_AI_ENV_KEYS,
  SAFE_AI_ENV_SCHEMA,
  normalizeEngineSource,
  getDefaultAgentsForPair,
  normalizeDualPair,
  isPairCompatibleWithAgents,
  normalizeWorkflow,
  parseModelSizeGb,
  isCloudModelName,
  estimateModelMemoryGb,
  estimateKvOverheadGb,
  OLLAMA_LOG_MAX_READ_BYTES,
  parseOllamaServerLog,
  readOllamaServerLogBounded,
  detectLiveOllamaAcceleration,
  getHostHardwareTelemetry,
  getRecommendedProfiles,
  evaluateDualConfiguration,
  validateSafeEnvOverrides,
  applySystemTuning
};
