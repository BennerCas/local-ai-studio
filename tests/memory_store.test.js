const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const memoryStore = require("../memory-store.js");

let tempMemoryDir = "";

function setupTempEnv() {
  tempMemoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-mem-test-"));
  process.env.LOCAL_AI_MEMORY_DIR = tempMemoryDir;
}

function teardownTempEnv() {
  delete process.env.LOCAL_AI_MEMORY_DIR;
  if (tempMemoryDir && fs.existsSync(tempMemoryDir)) {
    fs.rmSync(tempMemoryDir, { recursive: true, force: true });
  }
  tempMemoryDir = "";
}

describe("memory-store.js", () => {
  beforeEach(setupTempEnv);
  afterEach(teardownTempEnv);

  it("usa LOCAL_AI_MEMORY_DIR y ejecuta escritura atómica y lectura defensiva", () => {
    assert.equal(memoryStore.getMemoryDir(), path.resolve(tempMemoryDir));

    const target = path.join(tempMemoryDir, "nested", "sample.json");
    assert.deepEqual(memoryStore.readJsonSafe(target, { ok: false }), { ok: false });

    memoryStore.writeJsonAtomic(target, { hello: "world", count: 42 });
    assert.deepEqual(memoryStore.readJsonSafe(target, null), { hello: "world", count: 42 });

    const dirEntries = fs.readdirSync(path.dirname(target));
    assert.equal(dirEntries.some((name) => name.endsWith(".tmp")), false);

    fs.writeFileSync(target, "{ corrupt json !!!", "utf8");
    assert.deepEqual(memoryStore.readJsonSafe(target, { fallback: true }), { fallback: true });
  });

  it("gestiona chats sin límite de 25, ordenados desc, sin duplicados y con id sanitizado", () => {
    const evilChat = memoryStore.saveChat({
      id: "../../evil/chat?1",
      title: "Chat traversal",
      project: "Alpha",
      messages: [{ role: "user", content: "hola" }],
      updatedAt: "2026-01-01T00:00:00.000Z"
    });

    assert.match(evilChat.id, /^[a-zA-Z0-9_-]+$/);
    assert.equal(fs.existsSync(path.join(tempMemoryDir, "chats", `${evilChat.id}.json`)), true);

    // Crear 32 chats adicionales para comprobar que no hay límite de 25
    for (let i = 1; i <= 32; i++) {
      const ts = new Date(Date.UTC(2026, 1, i, 12, 0, 0)).toISOString();
      memoryStore.saveChat({
        id: `ses-${i}`,
        title: `Sesión ${i}`,
        project: i % 2 === 0 ? "Beta" : "Alpha",
        projectPath: `C:\\antigravityAS\\${i % 2 === 0 ? "Beta" : "Alpha"}`,
        convId: `conv-${i}`,
        source: "ollama",
        model: "qwen2.5-coder",
        skillId: "backend-architect",
        customSystemPrompt: "Sé conciso",
        appliedFiles: ["src/index.js"],
        messages: [{ role: "user", content: `msg ${i}` }],
        updatedAt: ts
      });
    }

    // Re-guardar ses-10 debe actualizar sin duplicar
    memoryStore.saveChat({
      id: "ses-10",
      title: "Sesión 10 Actualizada",
      project: "Beta",
      messages: [{ role: "user", content: "edit" }],
      updatedAt: "2099-03-01T00:00:00.000Z"
    });

    const all = memoryStore.listChats();
    assert.equal(all.length, 33);
    assert.equal(all[0].id, "ses-10");
    assert.equal(all.filter((c) => c.id === "ses-10").length, 1);

    const betaOnly = memoryStore.listChats({ project: "beta" });
    assert.equal(betaOnly.length, 16);

    const full = memoryStore.getChat("ses-10");
    assert.equal(full.title, "Sesión 10 Actualizada");
    assert.equal(full.project, "Beta");
    assert.equal(full.convId, "conv-10");
    assert.equal(full.skillId, "backend-architect");
    assert.equal(full.customSystemPrompt, "Sé conciso");
    assert.deepEqual(full.appliedFiles, ["src/index.js"]);

    const del = memoryStore.deleteChat("ses-10");
    assert.equal(del.deleted, true);
    assert.equal(memoryStore.getChat("ses-10"), null);
    assert.equal(memoryStore.listChats().length, 32);
  });

  it("migra sesiones legacy de localStorage de forma idempotente", () => {
    const legacy = [
      {
        id: "leg-1",
        title: "Legacy 1",
        project: "SynthIA",
        messages: [{ role: "user", content: "hi" }],
        updatedAt: "2026-01-10T10:00:00.000Z"
      },
      {
        sessionId: "leg-2",
        name: "Legacy 2",
        project: "General",
        history: [{ role: "user", content: "yo" }],
        time: "2026-01-11T10:00:00.000Z"
      }
    ];

    const firstRun = memoryStore.migrateLegacySessions(legacy);
    assert.equal(firstRun.imported, 2);
    assert.equal(firstRun.total, 2);

    const secondRun = memoryStore.migrateLegacySessions(legacy);
    assert.equal(secondRun.imported, 0);
    assert.equal(secondRun.total, 2);

    const loaded = memoryStore.getChat("leg-2");
    assert.equal(loaded.title, "Legacy 2");
    assert.equal(loaded.updatedAt, "2026-01-11T10:00:00.000Z");
    assert.equal(loaded.messages.length, 1);
  });

  it("mantiene histórico completo de descargas HF ordenado descendente", () => {
    memoryStore.upsertDownload({
      jobId: "dl-1",
      repoId: "Qwen/Qwen2.5-7B",
      status: "downloading",
      progress: 40,
      updatedAt: "2026-01-01T10:00:00.000Z"
    });
    memoryStore.upsertDownload({
      jobId: "dl-2",
      repoId: "NousResearch/Hermes-3",
      status: "completed",
      progress: 100,
      updatedAt: "2026-01-02T10:00:00.000Z"
    });
    memoryStore.upsertDownload({
      jobId: "dl-1",
      status: "completed",
      progress: 100,
      updatedAt: "2026-01-03T10:00:00.000Z"
    });

    const list = memoryStore.listDownloads();
    assert.equal(list.length, 2);
    assert.equal(list[0].jobId, "dl-1");
    assert.equal(list[0].status, "completed");
    assert.equal(memoryStore.getDownload("dl-2").repoId, "NousResearch/Hermes-3");
  });

  it("respalda archivos existentes antes de escribir y conserva últimos 500 cambios", () => {
    const projDir = path.join(tempMemoryDir, "proj-sample");
    fs.mkdirSync(projDir, { recursive: true });
    const missingPath = path.join(projDir, "nuevo.js");
    assert.equal(memoryStore.backupFileBeforeWrite("MiProyecto", "nuevo.js", missingPath), null);

    const existingPath = path.join(projDir, "app.js");
    fs.writeFileSync(existingPath, "const old = true;\n", "utf8");
    const backupPath = memoryStore.backupFileBeforeWrite("MiProyecto", "src/app.js", existingPath);
    assert.ok(backupPath);
    assert.equal(fs.existsSync(backupPath), true);
    assert.equal(fs.readFileSync(backupPath, "utf8"), "const old = true;\n");

    for (let i = 1; i <= 505; i++) {
      memoryStore.recordChange({
        project: i % 2 === 0 ? "MiProyecto" : "OtroProyecto",
        relPath: `file_${i}.js`,
        action: "write",
        sizeBytes: i * 10,
        summary: `Cambio ${i}`
      });
    }

    const all500 = memoryStore.listChanges(null, 600);
    assert.equal(all500.length, 500);
    assert.equal(all500[0].relPath, "file_505.js");

    const filtered = memoryStore.listChanges("MiProyecto", 10);
    assert.equal(filtered.length, 10);
    assert.ok(filtered.every((c) => c.project === "MiProyecto"));
  });

  it("persiste y recupera el estado de continuación por proyecto", () => {
    const def = memoryStore.getProjectState("C:\\antigravityAS\\DemoProj");
    assert.equal(def.project, "DemoProj");
    assert.equal(def.githubToggle, false);
    assert.deepEqual(def.selectedFiles, []);

    const updated = memoryStore.updateProjectState("C:\\antigravityAS\\DemoProj", {
      githubToggle: true,
      githubRepo: "benner/demoproj",
      netlifyToggle: true,
      netlifySite: "demoproj-site",
      netlifyPublishDir: "dist",
      lastSessionId: "ses-99",
      selectedFiles: ["src/main.js"]
    });

    assert.equal(updated.githubToggle, true);
    assert.equal(updated.githubRepo, "benner/demoproj");
    assert.ok(updated.updatedAt);

    // Búsqueda tanto por nombre como por ruta
    assert.equal(memoryStore.getProjectState("DemoProj").netlifySite, "demoproj-site");
    assert.equal(memoryStore.getAllProjectStates().length, 1);
  });

  it("gestiona Prompt Maestro con Meta-Prompting XML/CO-STAR, overrides por proyecto y reset", () => {
    assert.ok(memoryStore.DEFAULT_MASTER_PROMPT.length > 50);
    assert.match(memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT, /<thinking>/);
    assert.match(memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT, /<\/thinking>/);
    assert.match(memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT, /Estado Actual Verificado/);
    assert.match(memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT, /Procesos Inconclusos y Riesgos/);
    assert.match(memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT, /Lista de Tareas Pendientes/);
    assert.match(memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT, /Plan de Acción Recomendado/);

    const saved = memoryStore.saveMasterPromptConfig({
      globalPrompt: "Directriz Global Custom",
      project: "SynthIA",
      projectOverride: "Usar arquitectura modular TS."
    });

    assert.equal(saved.globalPrompt, "Directriz Global Custom");
    assert.equal(saved.projectOverride, "Usar arquitectura modular TS.");
    assert.match(saved.effectivePrompt, /Directriz Global Custom/);
    assert.match(saved.effectivePrompt, /Usar arquitectura modular TS\./);

    const otherProj = memoryStore.getMasterPromptConfig("Otro");
    assert.equal(otherProj.projectOverride, "");
    assert.equal(otherProj.effectivePrompt, "Directriz Global Custom");

    const reset = memoryStore.saveMasterPromptConfig({
      project: "SynthIA",
      resetToDefault: true
    });
    assert.equal(reset.globalPrompt, memoryStore.DEFAULT_MASTER_PROMPT);
    assert.equal(reset.contextAnalyzerPrompt, memoryStore.DEFAULT_CONTEXT_ANALYZER_PROMPT);
    assert.equal(reset.projectOverride, "");
  });

  it("persiste dualConfig con deep-merge aislado por proyecto y sesiones assistant_dual", () => {
    const defA = memoryStore.getProjectState("AlphaDual").dualConfig;
    assert.equal(defA.enabled, false);
    assert.equal(defA.pair, "freeai+directml");
    assert.equal(defA.agentA.source, "freeai");
    assert.equal(defA.agentB.source, "directml");

    // Guardar configuración Dual en AlphaDual con campos personalizados
    const upAlpha = memoryStore.updateProjectState("AlphaDual", {
      dualConfig: {
        enabled: true,
        pair: "freeai+ollama",
        workflow: "debate",
        unloadBetweenTurns: false,
        agentA: {
          source: "freeai",
          model: "qwen-2.5-coder",
          roleLabel: "Planificador",
          profileId: "SteveJobs",
          skillId: "backend-architect",
          customSystemPrompt: "Diseña módulos desacoplados",
          temperature: 0.4,
          maxTokens: 3072,
          numCtx: 8192
        },
        agentB: {
          source: "ollama",
          model: "qwen2.5-coder:latest",
          roleLabel: "Auditor",
          profileId: "ElonMusk",
          skillId: "code-reviewer",
          temperature: 0.1,
          maxTokens: 2048,
          numCtx: 4096
        }
      }
    });

    assert.equal(upAlpha.dualConfig.enabled, true);
    assert.equal(upAlpha.dualConfig.pair, "freeai+ollama");
    assert.equal(upAlpha.dualConfig.workflow, "debate");
    assert.equal(upAlpha.dualConfig.agentA.profileId, "SteveJobs");
    assert.equal(upAlpha.dualConfig.agentB.skillId, "code-reviewer");

    // Deep-merge parcial NO debe sobrescribir los campos existentes de agentA ni agentB
    const mergedAlpha = memoryStore.updateProjectState("AlphaDual", {
      dualConfig: {
        agentB: { roleLabel: "Auditor Refinado" }
      }
    });
    assert.equal(mergedAlpha.dualConfig.enabled, true);
    assert.equal(mergedAlpha.dualConfig.workflow, "debate");
    assert.equal(mergedAlpha.dualConfig.agentA.profileId, "SteveJobs");
    assert.equal(mergedAlpha.dualConfig.agentB.skillId, "code-reviewer");
    assert.equal(mergedAlpha.dualConfig.agentB.roleLabel, "Auditor Refinado");

    // Aislamiento estricto: BetaDual sigue con dual OFF
    const betaState = memoryStore.getProjectState("BetaDual");
    assert.equal(betaState.dualConfig.enabled, false);
    assert.equal(betaState.dualConfig.pair, "freeai+directml");

    // Persistencia completa de chats Dual (mode='dual', dualConfigSummary, role='assistant_dual')
    const savedDual = memoryStore.saveChat({
      id: "dual_chat_1",
      title: "Diseño módulo auth dual",
      project: "AlphaDual",
      mode: "dual",
      dualConfigSummary: {
        pair: "freeai+ollama",
        workflow: "debate",
        agentA: { source: "freeai", model: "qwen-2.5-coder", roleLabel: "Planificador" },
        agentB: { source: "ollama", model: "qwen2.5-coder:latest", roleLabel: "Auditor Refinado" }
      },
      messages: [
        { role: "user", content: "Implementa src/auth.js" },
        {
          role: "assistant_dual",
          content: "[Agente A ...]\n[Agente B ...]",
          dual: {
            pair: "freeai+ollama",
            workflow: "debate",
            notices: ["Aviso de prueba"],
            agentA: { source: "freeai", model: "qwen-2.5-coder", roleLabel: "Planificador", stage: 3, stageLabel: "Consolida", text: "Código final" },
            agentB: { source: "ollama", model: "qwen2.5-coder:latest", roleLabel: "Auditor", stage: 2, stageLabel: "Crítica", text: "Observaciones" }
          }
        }
      ]
    });

    assert.equal(savedDual.mode, "dual");
    assert.equal(savedDual.dualConfigSummary.pair, "freeai+ollama");
    const listed = memoryStore.listChats({ project: "AlphaDual" });
    assert.equal(listed[0].mode, "dual");
    assert.equal(listed[0].dualConfigSummary.workflow, "debate");
    const loaded = memoryStore.getChat("dual_chat_1");
    assert.equal(loaded.messages[1].role, "assistant_dual");
    assert.equal(loaded.messages[1].dual.agentA.stage, 3);
    assert.equal(loaded.messages[1].dual.notices[0], "Aviso de prueba");
  });
});
