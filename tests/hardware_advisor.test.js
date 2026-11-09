const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const hardwareAdvisor = require("../hardware-advisor.js");

const BACKUP_ENV_KEYS = [...hardwareAdvisor.SAFE_AI_ENV_KEYS];
const savedEnv = {};
for (const k of BACKUP_ENV_KEYS) {
  savedEnv[k] = process.env[k];
}

function makeMockTelemetry({ freeGb = 8.5, totalGb = 29.66, envEffective = {} } = {}) {
  return {
    platform: "win32",
    cpu: {
      name: "AMD Ryzen AI 7 350 w/ Radeon 860M",
      cores: 8,
      logicalThreads: 16,
      maxClockMHz: 2000
    },
    gpu: {
      name: "AMD Radeon(TM) 860M Graphics",
      driverVersion: "32.0.32015.12012",
      dedicatedVramGb: 2.0,
      isRadeon860M: true
    },
    npu: { present: true, name: "NPU Compute Accelerator Device", status: "OK" },
    ram: { totalGb, freeGb, usedGb: Math.max(0, totalGb - freeGb) },
    env: {
      process: { ...envEffective },
      user: { ...envEffective },
      effective: { ...envEffective }
    }
  };
}

describe("hardware-advisor.js", () => {
  afterEach(() => {
    for (const k of BACKUP_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it("normaliza motores, pares canónicos y verifica compatibilidad sin colisión", () => {
    assert.deepEqual(hardwareAdvisor.CANONICAL_PAIRS, [
      "freeai+directml",
      "freeai+ollama",
      "ollama+directml"
    ]);
    assert.equal(hardwareAdvisor.normalizeEngineSource("DML"), "directml");
    assert.equal(hardwareAdvisor.normalizeEngineSource("free.ai"), "freeai");
    assert.equal(hardwareAdvisor.normalizeEngineSource("local"), "ollama");

    assert.equal(hardwareAdvisor.normalizeDualPair("Free.ai + local"), "freeai+ollama");
    assert.equal(hardwareAdvisor.normalizeDualPair("directml + ollama"), "ollama+directml");
    assert.equal(
      hardwareAdvisor.normalizeDualPair("", { source: "directml" }, { source: "freeai" }),
      "freeai+directml"
    );

    assert.equal(
      hardwareAdvisor.isPairCompatibleWithAgents("freeai+directml", { source: "directml" }, { source: "freeai" }),
      true
    );
    assert.equal(
      hardwareAdvisor.isPairCompatibleWithAgents("freeai+ollama", { source: "ollama" }, { source: "ollama" }),
      false
    );
    assert.equal(
      hardwareAdvisor.isPairCompatibleWithAgents("freeai+ollama", { source: "freeai" }, { source: "directml" }),
      false
    );
  });

  it("estima pesos locales, etiquetas :cloud (0 GB) y reducción KV q8_0", () => {
    assert.equal(hardwareAdvisor.parseModelSizeGb(4200000000), 3.91);
    assert.equal(hardwareAdvisor.parseModelSizeGb("2.3 GB"), 2.3);
    assert.equal(hardwareAdvisor.parseModelSizeGb("512 MiB"), 0.5);

    const cloudMem = hardwareAdvisor.estimateModelMemoryGb("ollama", "glm-5:cloud");
    assert.deepEqual(cloudMem, { weightGb: 0, isCloud: true, tier: "cloud" });

    const freeMem = hardwareAdvisor.estimateModelMemoryGb("freeai", "qwen-2.5-coder");
    assert.equal(freeMem.weightGb, 0);
    assert.equal(freeMem.isCloud, true);

    const phiMem = hardwareAdvisor.estimateModelMemoryGb("directml", "Phi-3.5-mini-instruct-ONNX");
    assert.equal(phiMem.weightGb, 2.3);
    assert.equal(phiMem.tier, "light");

    const hermesMem = hardwareAdvisor.estimateModelMemoryGb("directml", "Hermes-3-8B-UNLOCKED-ONNX-DirectML");
    assert.equal(hermesMem.weightGb, 8.5);
    assert.equal(hermesMem.tier, "heavy");

    const kvDefault = hardwareAdvisor.estimateKvOverheadGb("ollama", 4.75, false, 8192, {});
    const kvQuantized = hardwareAdvisor.estimateKvOverheadGb("ollama", 4.75, false, 8192, {
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0"
    });
    assert.ok(kvQuantized < kvDefault, `KV q8_0+FA (${kvQuantized}) debe ser menor que default (${kvDefault})`);
  });

  it("evalúa los 3 modos duales según telemetría, variables Radeon 860M y modelos activos", () => {
    // Modo 1: Free.ai + DirectML con margen holgado
    const evalMode1 = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+directml",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "parallel",
      telemetry: makeMockTelemetry({ freeGb: 9.5, envEffective: { OLIVE_GPU_MEMORY_LIMIT: "20" } })
    });
    assert.equal(evalMode1.riskLevel, "optimal");
    assert.equal(evalMode1.bothLocalModels, false);
    assert.equal(evalMode1.agentA.weightGb, 0);
    assert.equal(evalMode1.suggestedRuntime.workflow, "parallel");

    // Modo 2: Free.ai + Ollama sin OLLAMA_IGPU_ENABLE
    const evalMode2 = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+ollama",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "ollama", model: "qwen2.5-coder:latest" },
      workflow: "pipeline",
      telemetry: makeMockTelemetry({ freeGb: 8.5, envEffective: {} })
    });
    assert.equal(evalMode2.riskLevel, "caution");
    assert.equal(evalMode2.envFlags.igpuMissing, true);
    assert.ok(evalMode2.warnings.some((w) => w.includes("OLLAMA_IGPU_ENABLE=1")));

    // Modo 3: Ollama + DirectML pesados con 7.2 GB libres + paralelo -> Critical & auto-protect
    const evalMode3Heavy = hardwareAdvisor.evaluateDualConfiguration({
      pair: "ollama+directml",
      agentA: { source: "ollama", model: "claude:latest", numCtx: 8192 },
      agentB: { source: "directml", model: "Hermes-3-8B-UNLOCKED-ONNX-DirectML" },
      workflow: "parallel",
      unloadBetweenTurns: true,
      telemetry: makeMockTelemetry({
        freeGb: 7.2,
        envEffective: {
          OLLAMA_IGPU_ENABLE: "1",
          HSA_OVERRIDE_GFX_VERSION: "11.0.0",
          OLIVE_GPU_MEMORY_LIMIT: "20"
        }
      })
    });
    assert.equal(evalMode3Heavy.riskLevel, "critical");
    assert.equal(evalMode3Heavy.bothLocalModels, true);
    assert.equal(evalMode3Heavy.allowParallelLocal, false);
    assert.ok(evalMode3Heavy.warnings.some((w) => w.includes("OLIVE_GPU_MEMORY_LIMIT")));
    assert.ok(evalMode3Heavy.warnings.some((w) => w.includes("DXGI/WDDM")));

    // Modo 3 incluso con modelos medianos ya calientes en memoria: pesos combinados >= 5.5 GB bloquean paralelo DXGI
    const evalMode3Warm = hardwareAdvisor.evaluateDualConfiguration({
      pair: "ollama+directml",
      agentA: { source: "ollama", model: "qwen2.5-coder:latest" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "parallel",
      ollamaPs: [{ name: "qwen2.5-coder:latest", model: "qwen2.5-coder:latest" }],
      directmlStatus: { ok: true, active_model: "Phi-3.5-mini-instruct-ONNX" },
      telemetry: makeMockTelemetry({ freeGb: 7.2, envEffective: {} })
    });
    assert.equal(evalMode3Warm.bothLocalModels, true);
    assert.equal(evalMode3Warm.riskLevel, "critical");
    assert.equal(evalMode3Warm.allowParallelLocal, false);

    // Modo 3 cuando Ollama usa :cloud -> libera contención física y permite paralelo
    const evalMode3Cloud = hardwareAdvisor.evaluateDualConfiguration({
      pair: "ollama+directml",
      agentA: { source: "ollama", model: "deepseek-r1:cloud" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "parallel",
      telemetry: makeMockTelemetry({ freeGb: 9.0, envEffective: { OLLAMA_IGPU_ENABLE: "1", HSA_OVERRIDE_GFX_VERSION: "11.0.0" } })
    });
    assert.equal(evalMode3Cloud.bothLocalModels, false);
    assert.equal(evalMode3Cloud.allowParallelLocal, true);
    assert.equal(evalMode3Cloud.riskLevel, "optimal");
    assert.ok(evalMode3Cloud.recommendations.some((r) => r.includes(":cloud")));
  });

  it("aplica lista blanca Zero-Trust estricta y ejecuta tuning en sesión", async () => {
    assert.throws(
      () => hardwareAdvisor.validateSafeEnvOverrides({ GITHUB_TOKEN: "ghp_secret" }),
      /Zero-Trust/
    );
    assert.throws(
      () => hardwareAdvisor.validateSafeEnvOverrides({ HF_TOKEN: "hf_secret" }),
      /Zero-Trust/
    );
    assert.throws(
      () => hardwareAdvisor.validateSafeEnvOverrides({ PATH: "C:\\evil" }),
      /Zero-Trust/
    );
    assert.throws(
      () => hardwareAdvisor.validateSafeEnvOverrides({ OLIVE_GPU_MEMORY_LIMIT: "128" }),
      /rango seguro/
    );
    assert.throws(
      () => hardwareAdvisor.validateSafeEnvOverrides({ HSA_OVERRIDE_GFX_VERSION: "11.0.0; calc" }),
      /Formato inválido/
    );
    assert.throws(
      () => hardwareAdvisor.validateSafeEnvOverrides({ OLLAMA_KV_CACHE_TYPE: "int2" }),
      /inválido/
    );

    const validated = hardwareAdvisor.validateSafeEnvOverrides({
      OLLAMA_IGPU_ENABLE: "1",
      HSA_OVERRIDE_GFX_VERSION: "11.0.0",
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
      OLIVE_GPU_MEMORY_LIMIT: 12,
      OLIVE_CPU_THREADS: 6
    });
    assert.deepEqual(validated, {
      OLLAMA_IGPU_ENABLE: "1",
      HSA_OVERRIDE_GFX_VERSION: "11.0.0",
      OLLAMA_FLASH_ATTENTION: "1",
      OLLAMA_KV_CACHE_TYPE: "q8_0",
      OLIVE_GPU_MEMORY_LIMIT: "12",
      OLIVE_CPU_THREADS: "6"
    });

    const applied = await hardwareAdvisor.applySystemTuning({
      scope: "session",
      pair: "ollama+directml",
      telemetry: makeMockTelemetry({ freeGb: 8.0 }),
      skipWindowsApply: true
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.scope, "session");
    assert.equal(applied.persistedToWindows, false);
    assert.equal(process.env.OLIVE_GPU_MEMORY_LIMIT, "12");
    assert.equal(process.env.OLIVE_CPU_THREADS, "6");
    assert.equal(process.env.OLLAMA_IGPU_ENABLE, "1");
    assert.equal(process.env.HSA_OVERRIDE_GFX_VERSION, "11.0.0");
  });

  it("parseOllamaServerLog y readOllamaServerLogBounded leen logs pequeños y acotan archivos >2MB conservando inicio y cola", () => {
    const droppingLog = [
      'time=2026-11-09T10:00:00.000Z level=INFO source=routes.go:1100 msg="server config" env="map[OLLAMA_IGPU_ENABLE:0 OLLAMA_FLASH_ATTENTION:true OLLAMA_KV_CACHE_TYPE:q8_0]"',
      'time=2026-11-09T10:00:01.000Z level=WARN source=gpu.go:450 msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1"',
      'time=2026-11-09T10:00:02.000Z level=INFO source=gpu.go:500 msg="inference compute" id=cpu library=cpu compute=""'
    ].join("\n");

    const parsedDrop = hardwareAdvisor.parseOllamaServerLog(droppingLog);
    assert.equal(parsedDrop.envKnown, true);
    assert.equal(parsedDrop.env.OLLAMA_IGPU_ENABLE, "0");
    assert.equal(parsedDrop.env.OLLAMA_FLASH_ATTENTION, "1");
    assert.equal(parsedDrop.env.OLLAMA_KV_CACHE_TYPE, "q8_0");
    assert.equal(parsedDrop.droppingIgpuInLog, true);
    assert.equal(parsedDrop.cpuOnlyInLog, true);
    assert.equal(parsedDrop.gpuDetectedInLog, false);
    assert.equal(parsedDrop.computeBackend, "cpu");

    const rocmRebootLog = [
      droppingLog,
      'time=2026-11-09T11:00:00.000Z level=INFO source=routes.go:1100 msg="server config" env="map[OLLAMA_IGPU_ENABLE:1 HSA_OVERRIDE_GFX_VERSION:11.0.0 OLLAMA_FLASH_ATTENTION:1 OLLAMA_KV_CACHE_TYPE:q8_0]"',
      'time=2026-11-09T11:00:01.000Z level=INFO source=gpu.go:510 msg="inference compute" id=GPU-0 library=rocm compute=gfx1100',
      'time=2026-11-09T11:00:02.000Z level=INFO source=sched.go:220 msg="vram-based default context" total_vram="2.0 GiB"'
    ].join("\n");

    const parsedRocm = hardwareAdvisor.parseOllamaServerLog(rocmRebootLog);
    assert.equal(parsedRocm.droppingIgpuInLog, false);
    assert.equal(parsedRocm.gpuDetectedInLog, true);
    assert.equal(parsedRocm.cpuOnlyInLog, false);
    assert.equal(parsedRocm.computeBackend, "rocm");
    assert.equal(parsedRocm.totalVramText, "2.0 GiB");
    assert.equal(parsedRocm.env.OLLAMA_IGPU_ENABLE, "1");

    const missing = hardwareAdvisor.readOllamaServerLogBounded(path.join(os.tmpdir(), `nonexistent-${Date.now()}.log`));
    assert.deepEqual(missing, { found: false, text: "", mtimeMs: 0 });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-log-bounded-"));
    try {
      const smallPath = path.join(tmpDir, "small.log");
      fs.writeFileSync(smallPath, droppingLog, "utf8");
      const smallRes = hardwareAdvisor.readOllamaServerLogBounded(smallPath);
      assert.equal(smallRes.found, true);
      assert.equal(smallRes.text, droppingLog);

      const largePath = path.join(tmpDir, "huge.log");
      const headMarker = "HEAD_MARKER_OLLAMA_START\n";
      const tailMarker = "\nTAIL_MARKER_OLLAMA_END";
      const middleChunk = "M".repeat(hardwareAdvisor.OLLAMA_LOG_MAX_READ_BYTES + 262144);
      fs.writeFileSync(largePath, `${headMarker}${middleChunk}${tailMarker}`, "utf8");

      const largeRes = hardwareAdvisor.readOllamaServerLogBounded(largePath);
      assert.equal(largeRes.found, true);
      assert.equal(largeRes.text.includes("HEAD_MARKER_OLLAMA_START"), true);
      assert.equal(largeRes.text.includes("TAIL_MARKER_OLLAMA_END"), true);
      assert.ok(largeRes.text.length < fs.statSync(largePath).size, "Lectura acotada debe omitir la parte intermedia");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("detectLiveOllamaAcceleration detecta droppingIgpu, rocm, cpuOnly, logMatchesLiveProcess y dmlStaleEnvForSession", async () => {
    const nowMs = Date.now();
    const procStartedIso = new Date(nowMs).toISOString();
    const freshLogIso = new Date(nowMs + 500).toISOString();
    const staleLogIso = new Date(nowMs - 120000).toISOString();

    const dropLive = await hardwareAdvisor.detectLiveOllamaAcceleration({
      processes: [{ name: "ollama.exe", pid: 4100, ppid: 99, startedAt: procStartedIso }],
      logContent: [
        `time=${freshLogIso} level=INFO msg="server config" env="map[OLLAMA_IGPU_ENABLE:0]"`,
        `time=${freshLogIso} level=WARN msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1"`,
        `time=${freshLogIso} level=INFO msg="inference compute" library=cpu`
      ].join("\n"),
      logMtimeMs: nowMs + 500
    });
    assert.equal(dropLive.ollamaRuntime.alive, true);
    assert.equal(dropLive.ollamaRuntime.logMatchesLiveProcess, true);
    assert.equal(dropLive.ollamaRuntime.droppingIgpu, true);
    assert.equal(dropLive.ollamaRuntime.cpuOnly, true);
    assert.equal(dropLive.ollamaRuntime.gpuDetected, false);
    assert.equal(dropLive.ollamaRuntime.computeBackend, "cpu");

    const rocmLive = await hardwareAdvisor.detectLiveOllamaAcceleration({
      processes: [{ name: "ollama.exe", pid: 4101, ppid: 99, startedAt: procStartedIso }],
      logContent: [
        `time=${freshLogIso} level=INFO msg="server config" env="map[OLLAMA_IGPU_ENABLE:1 HSA_OVERRIDE_GFX_VERSION:11.0.0]"`,
        `time=${freshLogIso} level=INFO msg="inference compute" library=rocm`,
        `time=${freshLogIso} level=INFO msg="vram-based default context" total_vram="2.0 GiB"`
      ].join("\n"),
      logMtimeMs: nowMs + 500
    });
    assert.equal(rocmLive.ollamaRuntime.alive, true);
    assert.equal(rocmLive.ollamaRuntime.logMatchesLiveProcess, true);
    assert.equal(rocmLive.ollamaRuntime.droppingIgpu, false);
    assert.equal(rocmLive.ollamaRuntime.cpuOnly, false);
    assert.equal(rocmLive.ollamaRuntime.gpuDetected, true);
    assert.equal(rocmLive.ollamaRuntime.computeBackend, "rocm");

    const staleAndDml = await hardwareAdvisor.detectLiveOllamaAcceleration({
      processes: [
        { name: "ollama.exe", pid: 4102, ppid: 99, startedAt: procStartedIso },
        {
          name: "python.exe",
          kind: "directml",
          pid: 4200,
          ppid: process.pid,
          startedAt: new Date(nowMs - 5000).toISOString()
        }
      ],
      logContent: `time=${staleLogIso} level=INFO msg="inference compute" library=cpu`,
      logMtimeMs: nowMs - 120000,
      sessionAppliedAtMs: nowMs,
      sessionAppliedEnv: { OLIVE_GPU_MEMORY_LIMIT: "12", OLIVE_CPU_THREADS: "6" }
    });
    assert.equal(staleAndDml.ollamaRuntime.alive, true);
    assert.equal(staleAndDml.ollamaRuntime.logMatchesLiveProcess, false);
    assert.equal(staleAndDml.directmlRuntime.alive, true);
    assert.equal(staleAndDml.directmlRuntime.staleEnvForSession, true);
  });

  it("evaluateDualConfiguration expone ollamaRunningOnCpu, requiresOllamaRestart, requiresDirectmlRestart y psGpuRatio", () => {
    const baseTel = makeMockTelemetry({
      freeGb: 9.0,
      envEffective: {
        OLLAMA_IGPU_ENABLE: "1",
        HSA_OVERRIDE_GFX_VERSION: "11.0.0",
        OLLAMA_FLASH_ATTENTION: "1",
        OLLAMA_KV_CACHE_TYPE: "q8_0",
        OLIVE_GPU_MEMORY_LIMIT: "12",
        OLIVE_CPU_THREADS: "6"
      }
    });

    const evalCpuPs = hardwareAdvisor.evaluateDualConfiguration({
      pair: "ollama+directml",
      agentA: { source: "ollama", model: "qwen2.5-coder:latest" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "pipeline",
      ollamaPs: [{ name: "qwen2.5-coder:latest", size: 4000000000, size_vram: 0 }],
      directmlStatus: { isAlive: true, oliveGpuMemoryLimit: 20, oliveCpuThreads: 12 },
      telemetry: {
        ...baseTel,
        ollamaRuntime: { alive: true, droppingIgpu: true, gpuDetected: false, cpuOnly: true, envKnown: true, env: { OLLAMA_IGPU_ENABLE: "0" } }
      }
    });
    assert.equal(evalCpuPs.psGpuRatio, 0);
    assert.equal(evalCpuPs.ollamaRunningOnCpu, true);
    assert.equal(evalCpuPs.requiresOllamaRestart, true);
    assert.equal(evalCpuPs.requiresDirectmlRestart, true);

    const evalSplitLowPs = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+ollama",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "ollama", model: "qwen2.5-coder:latest" },
      ollamaPs: [{ name: "qwen2.5-coder:latest", size: 4000000000, size_vram: 1000000000 }],
      telemetry: baseTel
    });
    assert.equal(evalSplitLowPs.psGpuRatio, 0.25);
    assert.equal(evalSplitLowPs.ollamaRunningOnCpu, true);

    const evalHybridHalfPs = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+ollama",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "ollama", model: "qwen2.5-coder:latest" },
      ollamaPs: [{ name: "qwen2.5-coder:latest", size: 4000000000, size_vram: 2000000000 }],
      telemetry: baseTel
    });
    assert.equal(evalHybridHalfPs.psGpuRatio, 0.5);
    assert.equal(evalHybridHalfPs.ollamaRunningOnCpu, false);

    const evalOptimalGpu = hardwareAdvisor.evaluateDualConfiguration({
      pair: "ollama+directml",
      agentA: { source: "ollama", model: "qwen2.5-coder:latest" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "pipeline",
      ollamaPs: [{ name: "qwen2.5-coder:latest", size: 4000000000, size_vram: 4000000000 }],
      directmlStatus: { isAlive: true, oliveGpuMemoryLimit: 12, oliveCpuThreads: 6 },
      telemetry: {
        ...baseTel,
        ollamaRuntime: {
          alive: true,
          droppingIgpu: false,
          gpuDetected: true,
          cpuOnly: false,
          envKnown: true,
          env: {
            OLLAMA_IGPU_ENABLE: "1",
            HSA_OVERRIDE_GFX_VERSION: "11.0.0",
            OLLAMA_FLASH_ATTENTION: "1",
            OLLAMA_KV_CACHE_TYPE: "q8_0"
          }
        },
        directmlRuntime: { alive: true, staleEnvForSession: false, envKnown: true, env: { OLIVE_GPU_MEMORY_LIMIT: "12", OLIVE_CPU_THREADS: "6" } }
      }
    });
    assert.equal(evalOptimalGpu.psGpuRatio, 1);
    assert.equal(evalOptimalGpu.ollamaRunningOnCpu, false);
    assert.equal(evalOptimalGpu.requiresOllamaRestart, false);
    assert.equal(evalOptimalGpu.requiresDirectmlRestart, false);
  });

  it("evaluateDualConfiguration eleva riesgo y advierte incompatibilidad DirectML del proyecto activo", () => {
    const baseTel = makeMockTelemetry({
      freeGb: 10.5,
      envEffective: {
        OLLAMA_IGPU_ENABLE: "1",
        HSA_OVERRIDE_GFX_VERSION: "11.0.0",
        OLLAMA_FLASH_ATTENTION: "1",
        OLLAMA_KV_CACHE_TYPE: "q8_0",
        OLIVE_GPU_MEMORY_LIMIT: "20",
        OLIVE_CPU_THREADS: "12"
      }
    });

    const badProjectCompat = {
      compatible: false,
      status: "incompatible",
      projectName: "LargeDmlApp",
      approxPromptTokens: 7420,
      safePromptLimit: 6144,
      kvContextLimit: 8192,
      excessTokens: 1276,
      largestSection: { key: "codeContextXml", label: "Código fuente inyectado", approxTokens: 5800 }
    };

    const evalWithDmlBad = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+directml",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "pipeline",
      telemetry: baseTel,
      projectCompatibility: badProjectCompat
    });
    assert.equal(evalWithDmlBad.directmlIncompatibleWithProject, true);
    assert.equal(evalWithDmlBad.directmlTightWithProject, false);
    assert.equal(evalWithDmlBad.riskLevel, "caution");
    assert.ok(evalWithDmlBad.warnings.some((w) => w.includes("7,420") && w.includes("6,144") && w.includes("8,192") && w.includes("HTTP 400")));
    assert.ok(evalWithDmlBad.recommendations.some((r) => r.includes("Free.ai + Ollama")));
    assert.equal(evalWithDmlBad.directmlProjectCompatibility.projectName, "LargeDmlApp");

    const evalNoDml = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+ollama",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "ollama", model: "qwen2.5-coder:latest" },
      workflow: "pipeline",
      ollamaPs: [{ name: "qwen2.5-coder:latest", size: 4000000000, size_vram: 4000000000 }],
      telemetry: baseTel,
      projectCompatibility: badProjectCompat
    });
    assert.equal(evalNoDml.directmlIncompatibleWithProject, false);
    assert.equal(evalNoDml.riskLevel, "optimal");
    assert.equal(evalNoDml.warnings.some((w) => w.includes("HTTP 400")), false);

    const tightCompat = {
      compatible: true,
      status: "tight",
      projectName: "TightDmlApp",
      approxPromptTokens: 5600,
      safePromptLimit: 6144,
      kvContextLimit: 8192
    };
    const evalTight = hardwareAdvisor.evaluateDualConfiguration({
      pair: "freeai+directml",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
      workflow: "pipeline",
      telemetry: baseTel,
      projectCompatibility: tightCompat
    });
    assert.equal(evalTight.directmlIncompatibleWithProject, false);
    assert.equal(evalTight.directmlTightWithProject, true);
    assert.equal(evalTight.riskLevel, "optimal");
    assert.ok(evalTight.recommendations.some((r) => r.includes("5,600") && r.includes("6,144")));
  });

  it("readFreshWindowsUserEnv garantiza las variables recomendadas de ROCm iGPU y DirectML", () => {
    const freshEnv = hardwareAdvisor.readFreshWindowsUserEnv();
    assert.equal(typeof freshEnv, "object");
    assert.equal(freshEnv.OLLAMA_IGPU_ENABLE, "1");
    assert.equal(freshEnv.OLLAMA_FLASH_ATTENTION, "1");
    assert.equal(freshEnv.OLLAMA_KV_CACHE_TYPE, "q8_0");
    assert.equal(freshEnv.OLLAMA_MAX_LOADED_MODELS, "1");
    assert.equal(freshEnv.OLLAMA_NUM_PARALLEL, "1");
    assert.equal(freshEnv.HSA_OVERRIDE_GFX_VERSION, "11.0.0");
    assert.ok(Boolean(freshEnv.OLIVE_GPU_MEMORY_LIMIT));
    assert.ok(Boolean(freshEnv.OLIVE_CPU_THREADS));
  });

  it("evaluateSystemForStudio y applySystemTuning exponen envAudit.machineShadowKeys, envAudit.isAdmin y machineCleanupCommand sin bypass UAC", async () => {
    const mockSnap = {
      isAdmin: false,
      cpu: { Name: "AMD Ryzen AI 7 350 w/ Radeon 860M", NumberOfCores: 8, NumberOfLogicalProcessors: 16, MaxClockSpeed: 2000 },
      gpu: { Name: "AMD Radeon(TM) 860M Graphics", DriverVersion: "32.0.32015.12012", AdapterRAM: 2147483648 },
      npu: { Name: "NPU Compute Accelerator Device", Status: "OK" },
      userEnv: {
        OLLAMA_IGPU_ENABLE: "1",
        HSA_OVERRIDE_GFX_VERSION: "11.0.0",
        OLLAMA_FLASH_ATTENTION: "1",
        OLLAMA_KV_CACHE_TYPE: "q8_0",
        OLLAMA_MAX_LOADED_MODELS: "1",
        OLLAMA_NUM_PARALLEL: "1"
      },
      machineEnv: {
        OLLAMA_IGPU_ENABLE: ""
      },
      machineEnvHasProp: {
        OLLAMA_IGPU_ENABLE: true,
        HSA_OVERRIDE_GFX_VERSION: false
      },
      processes: []
    };

    const sysEval = await hardwareAdvisor.evaluateSystemForStudio({
      snap: mockSnap,
      pair: "freeai+ollama",
      agentA: { source: "freeai", model: "qwen-2.5-coder" },
      agentB: { source: "ollama", model: "qwen2.5-coder:latest" }
    });

    assert.equal(typeof sysEval.envAudit, "object");
    assert.equal(typeof sysEval.envAudit.isAdmin, "boolean");
    assert.equal(sysEval.envAudit.isAdmin, false);
    assert.equal(Array.isArray(sysEval.envAudit.machineShadowKeys), true);
    assert.deepEqual(sysEval.envAudit.machineShadowKeys, ["OLLAMA_IGPU_ENABLE"]);
    assert.equal(
      sysEval.envAudit.machineCleanupCommand,
      'Remove-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" -Name "OLLAMA_IGPU_ENABLE" -ErrorAction SilentlyContinue'
    );

    const tuningRes = await hardwareAdvisor.applySystemTuning({
      scope: "session",
      pair: "freeai+ollama",
      snap: mockSnap,
      skipWindowsApply: true
    });
    assert.equal(tuningRes.ok, true);
    assert.equal(tuningRes.isAdmin, false);
    assert.deepEqual(tuningRes.machineShadowKeys, ["OLLAMA_IGPU_ENABLE"]);
    assert.equal(
      tuningRes.machineCleanupCommand,
      'Remove-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" -Name "OLLAMA_IGPU_ENABLE" -ErrorAction SilentlyContinue'
    );

    const liveSysEval = await hardwareAdvisor.evaluateSystemForStudio();
    assert.equal(typeof liveSysEval.envAudit, "object");
    assert.equal(typeof liveSysEval.envAudit.isAdmin, "boolean");
    assert.equal(Array.isArray(liveSysEval.envAudit.machineShadowKeys), true);
  });

  it("detectLiveOllamaAcceleration filtra subprocesos 'ollama runner' para preservar startedAt del daemon y logMatchesLiveProcess", async () => {
    const daemonStartMs = Date.now() - 60000;
    const logBootMs = daemonStartMs + 1000;
    const runnerStartMs = Date.now(); // El runner se lanza mucho después del inicio del daemon y del server.log

    const daemonIso = new Date(daemonStartMs).toISOString();
    const logIso = new Date(logBootMs).toISOString();
    const runnerIso = new Date(runnerStartMs).toISOString();

    const liveRes = await hardwareAdvisor.detectLiveOllamaAcceleration({
      processes: [
        {
          name: "ollama.exe",
          pid: 5100,
          ppid: 100,
          CommandLine: '"C:\\Users\\Benner\\AppData\\Local\\Programs\\Ollama\\ollama.exe" serve',
          startedAt: daemonIso
        },
        {
          name: "ollama.exe",
          pid: 5250,
          ppid: 5100,
          CommandLine: '"C:\\Users\\Benner\\AppData\\Local\\Programs\\Ollama\\ollama.exe" runner --model C:\\models\\blob --port 59812',
          startedAt: runnerIso
        }
      ],
      logContent: [
        `time=${logIso} level=INFO msg="server config" env="map[OLLAMA_IGPU_ENABLE:1 HSA_OVERRIDE_GFX_VERSION:11.0.0 OLLAMA_FLASH_ATTENTION:1 OLLAMA_KV_CACHE_TYPE:q8_0]"`,
        `time=${logIso} level=INFO msg="inference compute" id=GPU-0 library=rocm compute=gfx1100`,
        `time=${logIso} level=INFO msg="vram-based default context" total_vram="2.0 GiB"`
      ].join("\n"),
      logMtimeMs: logBootMs
    });

    assert.equal(liveRes.ollamaRuntime.alive, true);
    assert.deepEqual(liveRes.ollamaRuntime.pids, [5100]);
    assert.deepEqual(liveRes.ollamaRuntime.runnerPids, [5250]);
    assert.equal(liveRes.ollamaRuntime.startedAt, daemonIso);
    assert.equal(liveRes.ollamaRuntime.logMatchesLiveProcess, true);
    assert.equal(liveRes.ollamaRuntime.gpuDetected, true);
    assert.equal(liveRes.ollamaRuntime.computeBackend, "rocm");
  });
});
