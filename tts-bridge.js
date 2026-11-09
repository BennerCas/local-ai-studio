const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");

const DEFAULT_MINICONDA_PYTHON = "C:\\Users\\Benner\\miniconda3\\python.exe";
const TTS_SCRIPT_PATH = path.join(__dirname, "local_tts_bridge.py");
const MAX_TTS_TEXT_CHARS = 3000;
const MAX_TTS_HARD_CHARS = 10000;
const TTS_TIMEOUT_MS = 20000;
const MAX_SCALED_TTS_TIMEOUT_MS = 150000;
const TTS_SCALE_THRESHOLD_CHARS = 600;
const TTS_MS_PER_CHAR_OVER_THRESHOLD = 65;
const TTS_COLD_WORKER_PAD_MS = 8000;
const STATUS_TIMEOUT_MS = 8000;
const STATUS_CACHE_TTL_MS = 10000;
const MAX_PENDING_QUEUE = 16;
const MAX_STDERR_TAIL = 2048;
const MAX_STDOUT_BUF = 1024 * 1024;

let cachedStatus = null;
let cachedStatusAt = 0;
let cachedStatusKey = "";
let cachedStatusExecRef = undefined;
let inFlightStatusPromise = null;

let synthesisQueue = Promise.resolve();
let pendingQueueCount = 0;
let shuttingDown = false;

const workerState = {
  proc: null,
  pythonBin: null,
  scriptPath: null,
  spawnRef: null,
  stdoutBuf: "",
  activeJob: null
};

function createBridgeError(message, statusCode = 500) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function resolvePythonBin(overrideBin = "") {
  const explicit = String(overrideBin || process.env.LOCAL_AI_TTS_PYTHON || "").trim();
  if (explicit) return explicit;
  if (process.platform === "win32" && fs.existsSync(DEFAULT_MINICONDA_PYTHON)) {
    return DEFAULT_MINICONDA_PYTHON;
  }
  return "python";
}

function buildPythonEnv() {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8"
  };
}

function inferEngineFromVoice(voice = "") {
  const lower = String(voice || "").trim().toLowerCase();
  if (lower.startsWith("es_blend_") || lower.startsWith("ef_") || lower.startsWith("em_")) {
    return "kokoro";
  }
  if (
    lower.includes("piper") ||
    lower.includes("es_es") ||
    lower.includes("es_mx") ||
    lower.includes("es_ar") ||
    lower.includes("sharvard") ||
    lower.includes("davefx") ||
    lower.includes("carlfm") ||
    lower.includes("miro")
  ) {
    return "piper";
  }
  return "kokoro";
}

function resolveSynthesisTimeoutMs(textLength, explicitTimeoutMs, { coldWorker = false } = {}) {
  if (explicitTimeoutMs !== undefined && explicitTimeoutMs !== null && String(explicitTimeoutMs).trim() !== "") {
    const parsed = Number(explicitTimeoutMs);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const len = Math.max(0, Number(textLength) || 0);
  if (len <= TTS_SCALE_THRESHOLD_CHARS) {
    return TTS_TIMEOUT_MS;
  }
  // Empirically calibrated for CPU INT8 multi-chunk Spanish expansion + optional cold worker warmup
  const coldPad = coldWorker ? TTS_COLD_WORKER_PAD_MS : 0;
  return Math.min(
    MAX_SCALED_TTS_TIMEOUT_MS,
    Math.max(TTS_TIMEOUT_MS, Math.round(len * TTS_MS_PER_CHAR_OVER_THRESHOLD) + coldPad)
  );
}

function parseJsonFromStdout(stdout) {
  const raw = String(stdout || "").trim();
  if (!raw) return null;
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === "object") return direct;
  } catch (_err) {
    // Fall back to scanning lines in reverse in case dependencies emitted logs before JSON
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i].trim();
    if (!candidate || !candidate.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_err) {
      // keep scanning
    }
  }
  return null;
}

function parseWavSampleRate(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  const rate = buf.readUInt32LE(24);
  if (!Number.isFinite(rate) || rate < 8000 || rate > 192000) return null;
  return rate;
}

function sanitizeTtsInput({ text, voice = "ef_dora", speed = 1.0, maxChars = MAX_TTS_TEXT_CHARS } = {}) {
  if (typeof text !== "string") {
    throw createBridgeError("El texto para síntesis de voz es obligatorio y debe ser una cadena.", 400);
  }
  const cleaned = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .trim();
  if (!cleaned) {
    throw createBridgeError("El texto para síntesis de voz no puede estar vacío.", 400);
  }

  const limit = Math.min(MAX_TTS_HARD_CHARS, Math.max(100, Number(maxChars) || MAX_TTS_TEXT_CHARS));
  let finalText = cleaned;
  let truncated = false;
  if (cleaned.length > limit) {
    truncated = true;
    const slice = cleaned.slice(0, limit);
    const lastBreak = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf(" "));
    finalText = (lastBreak > limit - 160 ? slice.slice(0, lastBreak + 1) : slice).trim();
  }

  const rawVoice = voice === undefined || voice === null ? "" : String(voice).trim();
  const cleanVoice = rawVoice || "ef_dora";
  if (cleanVoice.includes("..") || !/^[a-zA-Z0-9._:-]{1,64}$/.test(cleanVoice)) {
    throw createBridgeError(`Identificador de voz TTS inválido: ${cleanVoice}`, 400);
  }

  let cleanSpeed = 1.0;
  if (speed !== undefined && speed !== null && String(speed).trim() !== "") {
    const parsedSpeed = Number(speed);
    if (!Number.isFinite(parsedSpeed)) {
      throw createBridgeError("La velocidad TTS debe ser un número válido.", 400);
    }
    cleanSpeed = Math.round(Math.min(2.0, Math.max(0.5, parsedSpeed)) * 100) / 100;
  }

  return {
    text: finalText,
    voice: cleanVoice,
    speed: cleanSpeed,
    truncated
  };
}

function runExecFileSafe(file, args, options, execOverride) {
  if (typeof execOverride === "function") {
    if (execOverride.length >= 4) {
      return new Promise((resolve, reject) => {
        execOverride(file, args, options, (err, stdout, stderr) => {
          if (err) reject(err);
          else resolve({ stdout: stdout || "", stderr: stderr || "" });
        });
      });
    }
    return Promise.resolve(execOverride(file, args, options)).then((res) => {
      if (typeof res === "string") return { stdout: res, stderr: "" };
      return res || { stdout: "", stderr: "" };
    });
  }

  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, shell: false }, (err, stdout, stderr) => {
      if (err) {
        if (stderr && !err.stderr) err.stderr = stderr;
        if (stdout && !err.stdout) err.stdout = stdout;
        reject(err);
        return;
      }
      resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function clearTtsStatusCache() {
  cachedStatus = null;
  cachedStatusAt = 0;
  cachedStatusKey = "";
  cachedStatusExecRef = undefined;
}

async function getTtsStatus(options = {}) {
  const pythonBin = resolvePythonBin(options.pythonBin);
  const scriptPath = String(options.scriptPath || TTS_SCRIPT_PATH);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || STATUS_TIMEOUT_MS));
  const execOverride = options.execOverride;
  const cacheKey = `${pythonBin}::${scriptPath}`;
  const now = Date.now();

  if (
    !options.forceRefresh &&
    cachedStatus &&
    cachedStatusKey === cacheKey &&
    cachedStatusExecRef === execOverride &&
    (now - cachedStatusAt) < STATUS_CACHE_TTL_MS
  ) {
    return cachedStatus;
  }

  if (!execOverride && inFlightStatusPromise && cachedStatusKey === cacheKey) {
    return inFlightStatusPromise;
  }

  const runCheck = async () => {
    if (!execOverride && !fs.existsSync(scriptPath)) {
      const missingResult = {
        ok: false,
        kokoroReady: false,
        piperReady: false,
        voices: [],
        pythonBin,
        scriptPath,
        error: "local_tts_bridge.py no encontrado en el directorio del plugin."
      };
      cachedStatus = missingResult;
      cachedStatusAt = Date.now();
      cachedStatusKey = cacheKey;
      cachedStatusExecRef = execOverride;
      return missingResult;
    }

    try {
      const { stdout } = await runExecFileSafe(
        pythonBin,
        [scriptPath, "--status"],
        {
          shell: false,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 512 * 1024,
          env: buildPythonEnv()
        },
        execOverride
      );

      const parsed = parseJsonFromStdout(stdout);
      if (!parsed) {
        return {
          ok: false,
          kokoroReady: false,
          piperReady: false,
          voices: [],
          pythonBin,
          scriptPath,
          error: "Respuesta inválida de local_tts_bridge.py --status."
        };
      }

      const normalized = {
        ok: Boolean(parsed.ok),
        kokoroReady: Boolean(parsed.kokoroReady),
        piperReady: Boolean(parsed.piperReady),
        voices: Array.isArray(parsed.voices) ? parsed.voices : [],
        pythonBin,
        scriptPath,
        error: parsed.error ? String(parsed.error) : null
      };
      cachedStatus = normalized;
      cachedStatusAt = Date.now();
      cachedStatusKey = cacheKey;
      cachedStatusExecRef = execOverride;
      return normalized;
    } catch (err) {
      const failResult = {
        ok: false,
        kokoroReady: false,
        piperReady: false,
        voices: [],
        pythonBin,
        scriptPath,
        error: String(err && (err.stderr || err.message) ? (err.stderr || err.message) : "Error consultando estado TTS.").trim()
      };
      cachedStatus = failResult;
      cachedStatusAt = Date.now();
      cachedStatusKey = cacheKey;
      cachedStatusExecRef = execOverride;
      return failResult;
    }
  };

  if (!execOverride) {
    cachedStatusKey = cacheKey;
    inFlightStatusPromise = runCheck().finally(() => {
      inFlightStatusPromise = null;
    });
    return inFlightStatusPromise;
  }

  return runCheck();
}

function killWorkerProcess() {
  const proc = workerState.proc;
  workerState.proc = null;
  workerState.stdoutBuf = "";
  if (proc) {
    try {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end();
    } catch (_err) {}
    try {
      proc.kill("SIGTERM");
    } catch (_err) {}
    setTimeout(() => {
      try {
        if (proc.exitCode === null && !proc.killed) proc.kill("SIGKILL");
      } catch (_err) {}
    }, 300).unref();
  }
}

function ensureWorkerProcess(pythonBin, scriptPath, spawnOverride) {
  const spawnFn = typeof spawnOverride === "function" ? spawnOverride : spawn;
  const activeProc = workerState.proc;
  const canReuse = Boolean(
    activeProc &&
    !activeProc.killed &&
    activeProc.exitCode === null &&
    workerState.pythonBin === pythonBin &&
    workerState.scriptPath === scriptPath &&
    workerState.spawnRef === spawnFn
  );
  if (canReuse) {
    return activeProc;
  }

  if (activeProc) {
    killWorkerProcess();
  }

  const proc = spawnFn(pythonBin, [scriptPath, "--worker"], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: buildPythonEnv()
  });

  workerState.proc = proc;
  workerState.pythonBin = pythonBin;
  workerState.scriptPath = scriptPath;
  workerState.spawnRef = spawnFn;
  workerState.stdoutBuf = "";
  let localStderrTail = "";

  if (proc.stdout) {
    proc.stdout.on("data", (chunk) => {
      if (workerState.proc !== proc) return;
      workerState.stdoutBuf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (workerState.stdoutBuf.length > MAX_STDOUT_BUF) {
        workerState.stdoutBuf = workerState.stdoutBuf.slice(-MAX_STDOUT_BUF);
      }

      let newlineIdx = workerState.stdoutBuf.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = workerState.stdoutBuf.slice(0, newlineIdx).trim();
        workerState.stdoutBuf = workerState.stdoutBuf.slice(newlineIdx + 1);
        newlineIdx = workerState.stdoutBuf.indexOf("\n");

        if (!line) continue;
        let parsed = null;
        try {
          parsed = JSON.parse(line);
        } catch (_err) {
          continue;
        }
        const job = workerState.activeJob;
        if (job && job.proc === proc && parsed && typeof parsed === "object") {
          if (!parsed.id || parsed.id === job.id) {
            clearTimeout(job.timer);
            workerState.activeJob = null;
            job.resolve(parsed);
          }
        }
      }
    });
  }

  if (proc.stderr) {
    proc.stderr.on("data", (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      localStderrTail = (localStderrTail + text).slice(-MAX_STDERR_TAIL);
    });
  }

  const handleWorkerTermination = (reasonMessage) => {
    if (workerState.proc === proc) {
      workerState.proc = null;
    }
    const job = workerState.activeJob;
    if (job && job.proc === proc) {
      clearTimeout(job.timer);
      workerState.activeJob = null;
      const err = createBridgeError(reasonMessage, 502);
      err.workerCrashed = true;
      err.stderrTail = localStderrTail;
      job.reject(err);
    }
  };

  proc.on("error", (err) => {
    handleWorkerTermination(`Error en proceso worker TTS: ${err.message}`);
  });

  proc.on("close", (code, signal) => {
    const detail = localStderrTail.trim();
    const suffix = detail ? `: ${detail.slice(-300)}` : "";
    handleWorkerTermination(`Worker TTS finalizado inesperadamente (code=${code}, signal=${signal || "none"})${suffix}`);
  });

  return proc;
}

async function runViaOneShotCli({ pythonBin, scriptPath, text, voice, speed, outPath, timeoutMs, execOverride }) {
  const args = [
    scriptPath,
    "--text",
    text,
    "--voice",
    voice,
    "--speed",
    String(speed),
    "--out",
    outPath
  ];

  let stdout = "";
  try {
    const res = await runExecFileSafe(
      pythonBin,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: buildPythonEnv()
      },
      execOverride
    );
    stdout = res.stdout || "";
  } catch (err) {
    if (err && (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT")) {
      throw createBridgeError(`Tiempo de espera agotado en síntesis TTS (${Math.round(timeoutMs / 1000)}s).`, 504);
    }
    const detail = String(err && (err.stderr || err.message) ? (err.stderr || err.message) : "Fallo ejecutando TTS local.").trim();
    throw createBridgeError(`Error en puente TTS local: ${detail.slice(-400)}`, 502);
  }

  const parsed = parseJsonFromStdout(stdout);
  if (parsed && parsed.ok === false) {
    throw createBridgeError(parsed.error || "El motor TTS devolvió ok=false.", 502);
  }
  return parsed || { ok: true };
}

function runWorkerOnce({ pythonBin, scriptPath, text, voice, speed, outPath, timeoutMs, spawnOverride }) {
  return new Promise((resolve, reject) => {
    const proc = ensureWorkerProcess(pythonBin, scriptPath, spawnOverride);
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      if (workerState.activeJob && workerState.activeJob.id === id) {
        workerState.activeJob = null;
        killWorkerProcess();
        reject(createBridgeError(`Tiempo de espera agotado en worker TTS (${Math.round(timeoutMs / 1000)}s).`, 504));
      }
    }, timeoutMs);
    timer.unref();

    workerState.activeJob = {
      id,
      proc,
      timer,
      resolve,
      reject
    };

    const line = `${JSON.stringify({ id, text, voice, speed, outPath })}\n`;
    try {
      proc.stdin.write(line, "utf8", (writeErr) => {
        if (writeErr && workerState.activeJob && workerState.activeJob.id === id) {
          clearTimeout(timer);
          workerState.activeJob = null;
          const err = createBridgeError(`Error escribiendo a stdin del worker TTS: ${writeErr.message}`, 502);
          err.workerCrashed = true;
          reject(err);
        }
      });
    } catch (syncErr) {
      clearTimeout(timer);
      workerState.activeJob = null;
      const err = createBridgeError(`Error enviando petición al worker TTS: ${syncErr.message}`, 502);
      err.workerCrashed = true;
      reject(err);
    }
  });
}

async function runViaPersistentWorkerWithRespawn(params) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (shuttingDown) {
      throw createBridgeError("Servicio TTS detenido.", 503);
    }
    try {
      const parsed = await runWorkerOnce(params);
      if (parsed && parsed.ok === false) {
        const jsonErr = createBridgeError(parsed.error || "El worker TTS devolvió error.", 502);
        jsonErr.explicitJsonError = true;
        throw jsonErr;
      }
      return parsed || { ok: true };
    } catch (err) {
      lastErr = err;
      const stderrLower = String(err && err.stderrTail || "").toLowerCase();
      if (stderrLower.includes("unrecognized arguments") && stderrLower.includes("--worker")) {
        return runViaOneShotCli(params);
      }
      if (err && err.workerCrashed && !err.explicitJsonError && !shuttingDown && attempt === 0) {
        killWorkerProcess();
        continue;
      }
      throw err;
    }
  }
  throw lastErr || createBridgeError("Fallo desconocido en worker TTS.", 502);
}

function enqueueSynthesis(taskFn) {
  if (shuttingDown) {
    return Promise.reject(createBridgeError("Puente TTS en apagado.", 503));
  }
  if (pendingQueueCount >= MAX_PENDING_QUEUE) {
    return Promise.reject(createBridgeError("Cola TTS saturada; espera a que finalice la reproducción actual.", 429));
  }

  pendingQueueCount += 1;
  const runNext = () => {
    if (shuttingDown) {
      return Promise.reject(createBridgeError("Puente TTS en apagado.", 503));
    }
    return taskFn();
  };

  const next = synthesisQueue.then(runNext, runNext).finally(() => {
    pendingQueueCount = Math.max(0, pendingQueueCount - 1);
  });
  synthesisQueue = next.catch(() => {});
  return next;
}

async function synthesizeSpeech(options = {}) {
  const clean = sanitizeTtsInput(options);
  const pythonBin = resolvePythonBin(options.pythonBin);
  const scriptPath = String(options.scriptPath || TTS_SCRIPT_PATH);
  const execOverride = options.execOverride;
  const spawnOverride = options.spawnOverride;
  const useWorker = execOverride ? false : (options.useWorker !== false);
  const isColdWorker = useWorker && (
    !workerState.proc ||
    workerState.proc.killed ||
    workerState.proc.exitCode !== null
  );
  const timeoutMs = resolveSynthesisTimeoutMs(clean.text.length, options.timeoutMs, {
    coldWorker: isColdWorker
  });

  return enqueueSynthesis(async () => {
    if (!execOverride && !spawnOverride && !fs.existsSync(scriptPath)) {
      throw createBridgeError("local_tts_bridge.py no encontrado en el directorio del plugin.", 503);
    }

    const outPath = path.join(
      os.tmpdir(),
      `local_ai_tts_${process.pid}_${Date.now()}_${crypto.randomUUID()}.wav`
    );

    try {
      const bridgeResult = useWorker
        ? await runViaPersistentWorkerWithRespawn({
            pythonBin,
            scriptPath,
            text: clean.text,
            voice: clean.voice,
            speed: clean.speed,
            outPath,
            timeoutMs,
            spawnOverride
          })
        : await runViaOneShotCli({
            pythonBin,
            scriptPath,
            text: clean.text,
            voice: clean.voice,
            speed: clean.speed,
            outPath,
            timeoutMs,
            execOverride
          });

      if (!fs.existsSync(outPath)) {
        throw createBridgeError("El puente TTS completó sin generar el archivo WAV temporal.", 502);
      }

      const audioBuffer = await fs.promises.readFile(outPath);
      if (!audioBuffer || audioBuffer.length === 0) {
        throw createBridgeError("El archivo WAV generado por TTS está vacío o corrupto.", 502);
      }

      const headerRate = parseWavSampleRate(audioBuffer);
      const rawRate = Number(bridgeResult.sampleRate || bridgeResult.sample_rate || headerRate || 24000);
      const sampleRate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : 24000;

      return {
        ok: true,
        engine: String(bridgeResult.engine || inferEngineFromVoice(clean.voice)),
        voice: String(bridgeResult.voice || clean.voice),
        sampleRate,
        mimeType: "audio/wav",
        audioBuffer
      };
    } finally {
      await fs.promises.unlink(outPath).catch(() => {});
    }
  });
}

async function shutdownTtsWorker() {
  shuttingDown = true;
  if (workerState.activeJob) {
    const job = workerState.activeJob;
    workerState.activeJob = null;
    clearTimeout(job.timer);
    job.reject(createBridgeError("Worker TTS cerrado mediante shutdownTtsWorker.", 503));
  }
  killWorkerProcess();
  await synthesisQueue.catch(() => {});
  shuttingDown = false;
  pendingQueueCount = 0;
}

module.exports = {
  DEFAULT_MINICONDA_PYTHON,
  TTS_SCRIPT_PATH,
  MAX_TTS_TEXT_CHARS,
  TTS_TIMEOUT_MS,
  STATUS_CACHE_TTL_MS,
  resolvePythonBin,
  inferEngineFromVoice,
  resolveSynthesisTimeoutMs,
  sanitizeTtsInput,
  parseWavSampleRate,
  clearTtsStatusCache,
  getTtsStatus,
  synthesizeSpeech,
  shutdownTtsWorker
};
