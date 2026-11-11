const { describe, it, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ttsBridge = require("../tts-bridge.js");

// Guards de entorno: worker falso (Windows) y NLP python (numpy) pueden no existir aquí
const { execFileSync: _execPy } = require("node:child_process");
const PY_DEPS_OK = (() => { try { _execPy("python", ["-c", "import numpy"], { stdio: "ignore" }); return true; } catch (_e) { try { _execPy("python3", ["-c", "import numpy"], { stdio: "ignore" }); return true; } catch (_e2) { return false; } } })();


const PLUGIN_ROOT = path.resolve(__dirname, "..");
const PYTHON_BIN = fs.existsSync(ttsBridge.DEFAULT_MINICONDA_PYTHON)
  ? ttsBridge.DEFAULT_MINICONDA_PYTHON
  : "python";

function buildMinimalPcmWavBuffer(sampleRate = 24000, numSamples = 240) {
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0, 4, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, 4, "ascii");
  buf.write("fmt ", 12, 4, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, 4, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i += 1) {
    buf.writeInt16LE(Math.round(Math.sin(i * 0.1) * 1200), 44 + i * 2);
  }
  return buf;
}

function createFakeWorkerProcess({ onLine, emitCloseOnKill = true } = {}) {
  const proc = new EventEmitter();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.exitCode = null;
  proc.killCalls = [];

  let lineBuf = "";
  proc.stdin.on("data", (chunk) => {
    lineBuf += chunk.toString("utf8");
    let nl = lineBuf.indexOf("\n");
    while (nl !== -1) {
      const rawLine = lineBuf.slice(0, nl).trim();
      lineBuf = lineBuf.slice(nl + 1);
      if (rawLine && typeof onLine === "function") {
        try {
          onLine(JSON.parse(rawLine), proc);
        } catch (_err) {}
      }
      nl = lineBuf.indexOf("\n");
    }
  });

  proc.kill = (signal = "SIGTERM") => {
    proc.killCalls.push(signal);
    proc.killed = true;
    if (proc.exitCode === null) proc.exitCode = 0;
    if (emitCloseOnKill) {
      queueMicrotask(() => {
        proc.emit("close", 0, signal);
      });
    }
    return true;
  };

  return proc;
}

function runPythonSnippet(code, args = []) {
  const stdout = execFileSync(
    PYTHON_BIN,
    ["-c", code, PLUGIN_ROOT, ...args],
    {
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8"
      }
    }
  );
  return JSON.parse(stdout.trim());
}

describe("tts-bridge.js + Python Spanish NLP / Local TTS Bridge", () => {
  afterEach(async () => {
    ttsBridge.clearTtsStatusCache();
    await ttsBridge.shutdownTtsWorker();
  });

  after(async () => {
    ttsBridge.clearTtsStatusCache();
    await ttsBridge.shutdownTtsWorker();
  });

  it("resolveSynthesisTimeoutMs respeta timeoutMs explícito, escala >600 chars hasta 150000 ms y suma +8000 en coldWorker", () => {
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(50, 1234, { coldWorker: true }), 1234);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(4000, 9999, { coldWorker: false }), 9999);

    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(0, undefined, { coldWorker: false }), 20000);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(600, undefined, { coldWorker: false }), 20000);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(600, undefined, { coldWorker: true }), 20000);

    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(601, undefined, { coldWorker: false }), 39065);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(601, undefined, { coldWorker: true }), 47065);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(1000, undefined, { coldWorker: false }), 65000);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(1000, undefined, { coldWorker: true }), 73000);

    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(5000, undefined, { coldWorker: false }), 150000);
    assert.equal(ttsBridge.resolveSynthesisTimeoutMs(2500, undefined, { coldWorker: true }), 150000);
  });

  it("inferEngineFromVoice clasifica voces Kokoro (blends y base) vs Piper ES", () => {
    assert.equal(ttsBridge.inferEngineFromVoice("es_blend_editorial"), "kokoro");
    assert.equal(ttsBridge.inferEngineFromVoice("es_blend_documental"), "kokoro");
    assert.equal(ttsBridge.inferEngineFromVoice("ef_dora"), "kokoro");
    assert.equal(ttsBridge.inferEngineFromVoice("em_alex"), "kokoro");
    assert.equal(ttsBridge.inferEngineFromVoice("em_santa"), "kokoro");

    assert.equal(ttsBridge.inferEngineFromVoice("vits-piper-es_MX-claude-high"), "piper");
    assert.equal(ttsBridge.inferEngineFromVoice("vits-piper-es_ES-sharvard-m"), "piper");
    assert.equal(ttsBridge.inferEngineFromVoice("vits-piper-es_ES-sharvard-f"), "piper");
    assert.equal(ttsBridge.inferEngineFromVoice("es_ar"), "piper");
    assert.equal(ttsBridge.inferEngineFromVoice("carlfm"), "piper");
    assert.equal(ttsBridge.inferEngineFromVoice("miro"), "piper");
  });

  it("sanitizeTtsInput valida texto, path traversal en voz, velocidad numérica y clamps [0.5, 2.0]", () => {
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "" }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "   \u0007  " }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: 12345 }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: null }), (err) => err.statusCode === 400);

    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "Hola", voice: "../secret" }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "Hola", voice: "ef_dora;calc" }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "Hola", voice: "ef/dora" }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "Hola", voice: "a".repeat(65) }), (err) => err.statusCode === 400);

    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "Hola", speed: "rapido" }), (err) => err.statusCode === 400);
    assert.throws(() => ttsBridge.sanitizeTtsInput({ text: "Hola", speed: NaN }), (err) => err.statusCode === 400);

    const lowClamp = ttsBridge.sanitizeTtsInput({ text: "  Hola mundo  ", voice: "es_blend_editorial", speed: 0.15 });
    assert.equal(lowClamp.speed, 0.5);
    assert.equal(lowClamp.voice, "es_blend_editorial");
    assert.equal(lowClamp.text, "Hola mundo");

    const highClamp = ttsBridge.sanitizeTtsInput({ text: "Hola", speed: 4.5 });
    assert.equal(highClamp.speed, 2.0);
  });

  it("parseWavSampleRate valida cabecera RIFF/WAVE, tamaño mínimo y rango de frecuencias", () => {
    assert.equal(ttsBridge.parseWavSampleRate(null), null);
    assert.equal(ttsBridge.parseWavSampleRate(Buffer.alloc(27)), null);

    const badRiff = buildMinimalPcmWavBuffer(24000, 10);
    badRiff.write("JUNK", 0, 4, "ascii");
    assert.equal(ttsBridge.parseWavSampleRate(badRiff), null);

    const badWave = buildMinimalPcmWavBuffer(24000, 10);
    badWave.write("AVI ", 8, 4, "ascii");
    assert.equal(ttsBridge.parseWavSampleRate(badWave), null);

    const tooLowRate = buildMinimalPcmWavBuffer(24000, 10);
    tooLowRate.writeUInt32LE(4000, 24);
    assert.equal(ttsBridge.parseWavSampleRate(tooLowRate), null);

    const tooHighRate = buildMinimalPcmWavBuffer(24000, 10);
    tooHighRate.writeUInt32LE(384000, 24);
    assert.equal(ttsBridge.parseWavSampleRate(tooHighRate), null);

    assert.equal(ttsBridge.parseWavSampleRate(buildMinimalPcmWavBuffer(24000, 10)), 24000);
    assert.equal(ttsBridge.parseWavSampleRate(buildMinimalPcmWavBuffer(22050, 10)), 22050);
    assert.equal(ttsBridge.parseWavSampleRate(buildMinimalPcmWavBuffer(48000, 10)), 48000);
  });

  it("getTtsStatus cachea resultados y clearTtsStatusCache invalida correctamente", async () => {
    ttsBridge.clearTtsStatusCache();
    let execCalls = 0;
    const mockStatusPayload = {
      ok: true,
      kokoroReady: true,
      piperReady: true,
      voices: [{ id: "es_blend_editorial", engine: "kokoro" }]
    };
    const execOverride = async () => {
      execCalls += 1;
      return { stdout: JSON.stringify(mockStatusPayload), stderr: "" };
    };

    const st1 = await ttsBridge.getTtsStatus({ execOverride });
    const st2 = await ttsBridge.getTtsStatus({ execOverride });
    assert.equal(st1.ok, true);
    assert.equal(st2.voices[0].id, "es_blend_editorial");
    assert.equal(execCalls, 1, "La segunda llamada dentro de TTL debe usar caché");

    await ttsBridge.getTtsStatus({ execOverride, forceRefresh: true });
    assert.equal(execCalls, 2, "forceRefresh: true debe omitir caché");

    ttsBridge.clearTtsStatusCache();
    await ttsBridge.getTtsStatus({ execOverride });
    assert.equal(execCalls, 3, "clearTtsStatusCache debe invalidar el estado cacheado");
  });

  it("synthesizeSpeech reintenta/respawnea worker tras crash y devuelve HTTP 504 si el worker no responde", { skip: process.platform === "win32" ? false : "Worker falso TTS solo verificado en Windows" }, async () => {
    let spawnCount = 0;
    const spawnCrashThenOk = () => {
      spawnCount += 1;
      const attempt = spawnCount;
      return createFakeWorkerProcess({
        onLine: (req, proc) => {
          if (attempt === 1) {
            proc.stderr.write("Simulated worker crash");
            proc.exitCode = 1;
            proc.emit("close", 1, null);
            return;
          }
          const wav = buildMinimalPcmWavBuffer(24000, 300);
          fs.writeFileSync(req.outPath, wav);
          proc.stdout.write(`${JSON.stringify({
            id: req.id,
            ok: true,
            engine: "kokoro",
            voice: req.voice,
            sampleRate: 24000,
            outPath: req.outPath,
            error: null
          })}\n`);
        }
      });
    };

    const recovered = await ttsBridge.synthesizeSpeech({
      text: "Prueba de recuperación automática tras caída del worker.",
      voice: "es_blend_editorial",
      spawnOverride: spawnCrashThenOk
    });
    assert.equal(spawnCount, 2, "Debe respawnear una segunda instancia tras el crash del primer worker");
    assert.equal(recovered.ok, true);
    assert.equal(recovered.engine, "kokoro");
    assert.equal(recovered.sampleRate, 24000);
    assert.equal(ttsBridge.parseWavSampleRate(recovered.audioBuffer), 24000);

    await ttsBridge.shutdownTtsWorker();

    let hungKillCount = 0;
    const spawnHungWorker = () => {
      const p = createFakeWorkerProcess({
        onLine: () => {
          // Simula bloqueo completo del worker sin emitir respuesta por stdout
        }
      });
      const origKill = p.kill.bind(p);
      p.kill = (sig) => {
        hungKillCount += 1;
        return origKill(sig);
      };
      return p;
    };

    await assert.rejects(
      () => ttsBridge.synthesizeSpeech({
        text: "Worker bloqueado sin responder.",
        voice: "ef_dora",
        timeoutMs: 120,
        spawnOverride: spawnHungWorker
      }),
      (err) => err && err.statusCode === 504
    );
    assert.ok(hungKillCount >= 1, "El timeout debe matar el worker bloqueado");
  });

  it("tts_spanish_nlp normaliza números hasta 999_999_999_999, divisas, horas sin duplicar, unidades, abreviaturas, bloques sucios y chunks <= 240", { skip: PY_DEPS_OK ? false : "Faltan dependencias Python (numpy/kokoro) en este entorno" }, () => {
    const res = runPythonSnippet(`
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

import tts_spanish_nlp as nlp
import local_tts_bridge as bridge

max_num = nlp.number_to_spanish(999_999_999_999)
decimal_pct = nlp.normalize_spanish_text("Tasa de 3.14 y avance de 85.5% hoy.")
currencies = nlp.normalize_spanish_text("Costó $150, más 250 USD, 100 MXN, 45 EUR, €99 y £20.")
times = nlp.normalize_spanish_text("Cita a las 14:30 y cierre a las 14:30 horas exactas.")
units = nlp.normalize_spanish_text("Viaja a 120 km/h, acelera a 9.8 m/s, a 36 °C o 72 °F en 15 ms con 16 GB y 1 TB.")
abbr = nlp.normalize_spanish_text("El Dr. López, la Dra. Ruiz, el Sr. Díaz, el Ing. Vera viven en Av. Sol, p. ej. en EE. UU., etc.")

dirty = """<thinking>Esto no debe pronunciarse jamás 123456</thinking>
Aquí está el resumen en [la documentación](https://example.com/secret/path?token=123).
\`\`\`python
print("código oculto en markdown")
\`\`\`
Visita también https://openai.com/docs ahora mismo. Resultado: 42%."""
cleaned = bridge.clean_text_for_tts(dirty)

long_text = " ".join([
    f"El módulo número {i} procesa 25.5 MB a 120 km/h por $15 USD antes de las 14:30 horas según el Dr. Pérez."
    for i in range(1, 18)
])
chunks = nlp.prepare_spanish_chunks(long_text, max_chars=240)
seg_direct = nlp.split_spanish_segments("Primera oración larga, " + ", ".join(["palabra"] * 50) + ". Segunda oración corta.", max_chars=240)

out = {
    "max_num": max_num,
    "decimal_pct": decimal_pct,
    "currencies": currencies,
    "times": times,
    "units": units,
    "abbr": abbr,
    "cleaned": cleaned,
    "chunks": chunks,
    "seg_direct": seg_direct,
    "max_chunk_len": max((len(c) for c in chunks), default=0),
    "max_seg_len": max((len(c) for c in seg_direct), default=0)
}
print(json.dumps(out, ensure_ascii=False))
`);

    assert.equal(
      res.max_num,
      "novecientos noventa y nueve mil novecientos noventa y nueve millones novecientos noventa y nueve mil novecientos noventa y nueve"
    );
    assert.match(res.decimal_pct, /tres punto catorce/);
    assert.match(res.decimal_pct, /ochenta y cinco punto cinco por ciento/);

    assert.match(res.currencies, /ciento cincuenta dólares/);
    assert.match(res.currencies, /doscientos cincuenta dólares estadounidenses/);
    assert.match(res.currencies, /cien pesos mexicanos/);
    assert.match(res.currencies, /cuarenta y cinco euros/);
    assert.match(res.currencies, /noventa y nueve euros/);
    assert.match(res.currencies, /veinte libras esterlinas/);

    assert.match(res.times, /catorce horas con treinta minutos/);
    const horasMatches = res.times.match(/horas\s+horas/gi);
    assert.equal(horasMatches, null, `No debe duplicar 'horas': ${res.times}`);

    assert.match(res.units, /kilómetros por hora/);
    assert.match(res.units, /metros por segundo/);
    assert.match(res.units, /grados centígrados/);
    assert.match(res.units, /grados Fahrenheit/);
    assert.match(res.units, /milisegundos/);
    assert.match(res.units, /gigabytes/);
    assert.match(res.units, /un terabyte/);

    assert.match(res.abbr, /doctor/);
    assert.match(res.abbr, /doctora/);
    assert.match(res.abbr, /señor/);
    assert.match(res.abbr, /ingeniero/);
    assert.match(res.abbr, /avenida/);
    assert.match(res.abbr, /por ejemplo/);
    assert.match(res.abbr, /Estados Unidos/);
    assert.match(res.abbr, /etcétera/);

    assert.equal(res.cleaned.includes("no debe pronunciarse"), false);
    assert.equal(res.cleaned.includes("código oculto"), false);
    assert.equal(res.cleaned.includes("https://"), false);
    assert.equal(res.cleaned.includes("example.com"), false);
    assert.match(res.cleaned, /la documentación/);
    assert.match(res.cleaned, /cuarenta y dos por ciento/);

    assert.ok(res.chunks.length >= 2);
    assert.ok(res.max_chunk_len <= 240, `Chunk excedió 240 chars: ${res.max_chunk_len}`);
    assert.ok(res.max_seg_len <= 240, `Segmento excedió 240 chars: ${res.max_seg_len}`);
  });

  it("_phonemize_kokoro_safe jamás pasa >510 fonemas al tokenizer de Kokoro", { skip: PY_DEPS_OK ? false : "Faltan dependencias Python (numpy/kokoro) en este entorno" }, () => {
    const res = runPythonSnippet(`
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
if str(root) not in sys.path:
    sys.path.insert(0, str(root))

import local_tts_bridge as bridge

class MockTokenizer:
    def __init__(self):
        self.tokenize_lengths = []
        self.max_seen_tokenize = 0

    def phonemize(self, text, lang="es"):
        # Simula una expansión fonética muy densa (~4x caracteres)
        return "abˈcd " * max(1, len(text))

    def tokenize(self, phonemes):
        self.tokenize_lengths.append(len(phonemes))
        if len(phonemes) > self.max_seen_tokenize:
            self.max_seen_tokenize = len(phonemes)
        return [1] * len(phonemes)

class MockKokoro:
    def __init__(self):
        self.tokenizer = MockTokenizer()

k = MockKokoro()
multi_word = " ".join(["palabra"] * 220)
parts_multi = bridge.TTSRuntime._phonemize_kokoro_safe(k, multi_word)

single_token = "x" * 700
parts_single = bridge.TTSRuntime._phonemize_kokoro_safe(k, single_token)

out = {
    "multi_count": len(parts_multi),
    "multi_max_len": max((len(p) for p in parts_multi), default=0),
    "single_count": len(parts_single),
    "single_max_len": max((len(p) for p in parts_single), default=0),
    "max_seen_tokenize": k.tokenizer.max_seen_tokenize,
    "limit_constant": bridge.MAX_KOKORO_CHUNK_PHONEMES
}
print(json.dumps(out))
`);

    assert.ok(res.limit_constant <= 510);
    assert.ok(res.multi_count >= 2);
    assert.ok(res.multi_max_len > 0 && res.multi_max_len <= 510);
    assert.ok(res.single_count >= 2);
    assert.ok(res.single_max_len > 0 && res.single_max_len <= 510);
    assert.ok(res.max_seen_tokenize <= 510, `Se pasaron ${res.max_seen_tokenize} fonemas a tokenize (>510)`);
  });

  it("local_tts_bridge.py --status reporta las 13 voces reales y sintetiza diferenciando sharvard-m, sharvard-f y es_blend_editorial", { skip: (process.platform === "win32" || process.env.LOCAL_AI_TTS_PYTHON) ? false : "Voces TTS reales solo en el host del autor" }, async () => {
    const status = await ttsBridge.getTtsStatus({ forceRefresh: true });
    assert.equal(status.ok, true);
    assert.equal(status.kokoroReady, true);
    assert.equal(status.piperReady, true);
    assert.equal(status.voices.length, 13, `Esperadas 13 voces, recibidas ${status.voices.length}`);

    const voiceIds = new Set(status.voices.map((v) => v.id));
    for (const requiredId of [
      "ef_dora",
      "em_alex",
      "em_santa",
      "es_blend_editorial",
      "es_blend_documental",
      "vits-piper-es_MX-claude-high",
      "vits-piper-es_MX-ald-medium",
      "vits-piper-es_ES-davefx-medium",
      "vits-piper-es_AR-daniela-high",
      "vits-piper-es_ES-miro-high",
      "vits-piper-es_ES-carlfm-x_low",
      "vits-piper-es_ES-sharvard-m",
      "vits-piper-es_ES-sharvard-f"
    ]) {
      assert.equal(voiceIds.has(requiredId), true, `Falta voz obligatoria en --status: ${requiredId}`);
    }

    const sids = runPythonSnippet(`
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
if str(root) not in sys.path:
    sys.path.insert(0, str(root))
import local_tts_bridge as bridge
print(json.dumps({
    "sharvard_m_sid": bridge.VOICE_BY_ID["vits-piper-es_ES-sharvard-m"].sid,
    "sharvard_f_sid": bridge.VOICE_BY_ID["vits-piper-es_ES-sharvard-f"].sid
}))
`);
    assert.equal(sids.sharvard_m_sid, 0);
    assert.equal(sids.sharvard_f_sid, 1);

    const phrase = "Prueba de voz local.";
    const blendRes = await ttsBridge.synthesizeSpeech({
      text: phrase,
      voice: "es_blend_editorial",
      useWorker: false
    });
    assert.equal(blendRes.ok, true);
    assert.equal(blendRes.engine, "kokoro");
    assert.equal(blendRes.voice, "es_blend_editorial");
    assert.equal(blendRes.sampleRate, 24000);
    assert.equal(ttsBridge.parseWavSampleRate(blendRes.audioBuffer), 24000);

    const maleRes = await ttsBridge.synthesizeSpeech({
      text: phrase,
      voice: "vits-piper-es_ES-sharvard-m",
      useWorker: false
    });
    const femaleRes = await ttsBridge.synthesizeSpeech({
      text: phrase,
      voice: "vits-piper-es_ES-sharvard-f",
      useWorker: false
    });
    assert.equal(maleRes.engine, "piper");
    assert.equal(femaleRes.engine, "piper");
    assert.ok(maleRes.audioBuffer.length > 1000);
    assert.ok(femaleRes.audioBuffer.length > 1000);
    assert.notEqual(
      Buffer.compare(maleRes.audioBuffer, femaleRes.audioBuffer),
      0,
      "sharvard-m (sid=0) y sharvard-f (sid=1) deben generar formas de onda distintas"
    );
  });
});
