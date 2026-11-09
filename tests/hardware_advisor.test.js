const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");

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
});
