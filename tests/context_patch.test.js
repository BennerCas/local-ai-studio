const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const memoryStore = require("../memory-store.js");
const contextBridge = require("../context-bridge.js");
const skillsBridge = require("../skills-bridge.js");
const contextAnalyzer = require("../context-analyzer.js");
const freeaiBridge = require("../freeai-bridge.js");

let tempRoot = "";
let tempProjectsDir = "";
let tempMemoryDir = "";
let tempConfigFile = "";
let tempBrainDir = "";
let projAlphaDir = "";
let projBetaDir = "";

function setupEnv() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-ctx-test-"));
  tempProjectsDir = path.join(tempRoot, "projects");
  tempMemoryDir = path.join(tempRoot, "memory");
  tempConfigFile = path.join(tempRoot, "active_project.json");
  tempBrainDir = path.join(tempRoot, "brain");
  projAlphaDir = path.join(tempProjectsDir, "AlphaApp");
  projBetaDir = path.join(tempProjectsDir, "BetaApp");

  fs.mkdirSync(projAlphaDir, { recursive: true });
  fs.mkdirSync(projBetaDir, { recursive: true });
  fs.mkdirSync(tempMemoryDir, { recursive: true });
  fs.mkdirSync(tempBrainDir, { recursive: true });

  process.env.LOCAL_AI_PROJECTS_DIR = tempProjectsDir;
  process.env.LOCAL_AI_MEMORY_DIR = tempMemoryDir;
  process.env.LOCAL_AI_CONFIG_FILE = tempConfigFile;
  process.env.LOCAL_AI_BRAIN_DIR = tempBrainDir;
}

function teardownEnv() {
  delete process.env.LOCAL_AI_PROJECTS_DIR;
  delete process.env.LOCAL_AI_MEMORY_DIR;
  delete process.env.LOCAL_AI_CONFIG_FILE;
  delete process.env.LOCAL_AI_BRAIN_DIR;
  delete process.env.FREEAI_BASE_URL;
  delete process.env.FREE_AI_API_KEY;
  if (tempRoot && fs.existsSync(tempRoot)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("context-bridge, skills-bridge, context-analyzer & freeai-bridge", () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  it("bloquea path traversal, rutas absolutas externas y mutación/lectura en .git o .env", () => {
    fs.mkdirSync(path.join(projAlphaDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(projAlphaDir, ".git", "config"), "[core]\n", "utf8");
    fs.writeFileSync(path.join(projAlphaDir, ".env"), "SECRET=123\n", "utf8");
    fs.writeFileSync(path.join(projAlphaDir, ".env.example"), "SECRET=\n", "utf8");

    const blockedCases = [
      "../outside.txt",
      "src/../../outside.txt",
      "C:\\Windows\\System32\\drivers\\etc\\hosts",
      "/etc/passwd",
      ".git/config",
      ".git/HEAD",
      "nested/.git/config",
      ".env",
      ".env.local",
      ".env.production"
    ];

    for (const rel of blockedCases) {
      const check = contextBridge.resolveSafeProjectPath(projAlphaDir, rel);
      assert.equal(check.ok, false, `Debió bloquear: ${rel}`);
      assert.equal(check.error, "Ruta protegida o fuera del proyecto");

      const saveRes = contextBridge.saveProjectFile("AlphaApp", rel, "hack");
      assert.equal(saveRes.ok, false);
      assert.equal(saveRes.error, "Ruta protegida o fuera del proyecto");

      const readRes = contextBridge.readProjectFile("AlphaApp", rel);
      assert.equal(readRes.ok, false);
      assert.equal(readRes.error, "Ruta protegida o fuera del proyecto");

      const patchRes = contextBridge.applyProjectPatch("AlphaApp", rel, "a", "b");
      assert.equal(patchRes.ok, false);
      assert.equal(patchRes.error, "Ruta protegida o fuera del proyecto");
    }

    const allowedExample = contextBridge.resolveSafeProjectPath(projAlphaDir, ".env.example");
    assert.equal(allowedExample.ok, true);

    const allowedNested = contextBridge.resolveSafeProjectPath(projAlphaDir, "src/core/service.js");
    assert.equal(allowedNested.ok, true);
    assert.equal(allowedNested.cleanRelPath, "src/core/service.js");
  });

  it("aplica parches quirúrgicos con líneas en blanco preservando CRLF/LF y creando backup + registro", () => {
    const crlfOriginal = [
      "function computeTotal(items) {",
      "  let sum = 0;",
      "",
      "  for (const x of items) {",
      "    sum += x;",
      "  }",
      "",
      "  return sum;",
      "}",
      "",
      "export default computeTotal;",
      ""
    ].join("\r\n");

    const saveRes = contextBridge.saveProjectFile("AlphaApp", "src/math.js", crlfOriginal, { model: "Hermes-3" });
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.backupPath, null);

    // SEARCH omite las líneas en blanco internas y tiene distinta indentación
    const searchBlock = [
      "function computeTotal(items) {",
      "let sum = 0;",
      "for (const x of items) {",
      "sum += x;",
      "}",
      "return sum;",
      "}"
    ].join("\n");

    const replaceBlock = [
      "function computeTotal(items) {",
      "  return items.reduce((acc, x) => acc + x, 0);",
      "}"
    ].join("\n");

    const patchRes = contextBridge.applyProjectPatch("AlphaApp", "src/math.js", searchBlock, replaceBlock, {
      model: "Qwen2.5-Coder"
    });
    assert.equal(patchRes.ok, true);
    assert.ok(patchRes.backupPath);
    assert.equal(fs.existsSync(patchRes.backupPath), true);

    const updated = fs.readFileSync(path.join(projAlphaDir, "src", "math.js"), "utf8");
    assert.equal(updated.includes("\r\n"), true, "Debe preservar CRLF original");
    assert.equal(
      updated,
      [
        "function computeTotal(items) {",
        "  return items.reduce((acc, x) => acc + x, 0);",
        "}",
        "",
        "export default computeTotal;",
        ""
      ].join("\r\n")
    );

    // También verifica preservación LF
    contextBridge.saveProjectFile("AlphaApp", "src/lf.js", "const a = 1;\n\nconst b = 2;\n");
    const lfPatch = contextBridge.applyProjectPatch("AlphaApp", "src/lf.js", "const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;");
    assert.equal(lfPatch.ok, true);
    const lfUpdated = fs.readFileSync(path.join(projAlphaDir, "src", "lf.js"), "utf8");
    assert.equal(lfUpdated.includes("\r\n"), false, "Debe preservar LF original");
    assert.equal(lfUpdated, "const a = 10;\nconst b = 20;\n");

    const changes = memoryStore.listChanges("AlphaApp", 10);
    assert.ok(changes.some((c) => c.action === "patch" && c.relPath === "src/math.js" && c.model === "Qwen2.5-Coder"));
  });

  it("limpia explicitFolder al cambiar de proyecto y evita fuga de selectedFiles entre proyectos", () => {
    contextBridge.setExplicitFolder(projAlphaDir);
    contextBridge.setSelectedFiles(projAlphaDir, ["src/alpha.js"]);
    assert.deepEqual(contextBridge.getSelectedFiles(projAlphaDir), ["src/alpha.js"]);
    assert.deepEqual(contextBridge.getSelectedFiles(projBetaDir), []);

    // Ruta explícita completa enviada por preview/context debe resolver el mismo proyecto
    const byFullPath = contextBridge.getActiveProject(projAlphaDir);
    assert.equal(byFullPath.name, "AlphaApp");
    assert.equal(path.resolve(byFullPath.path), path.resolve(projAlphaDir));

    // Cambiar a BetaApp limpia explicitFolder si no coincide el basename
    contextBridge.setActiveProjectName("BetaApp");
    assert.equal(contextBridge.getExplicitFolder(), null);
    const active = contextBridge.getActiveProject();
    assert.equal(active.name, "BetaApp");
  });

  it("prioriza código sobre biblioteca/ en scanProjectFiles y respeta writeToDisk=false en buildProjectContext", () => {
    const bibDir = path.join(projAlphaDir, "biblioteca");
    const srcDir = path.join(projAlphaDir, "src");
    const serverDir = path.join(projAlphaDir, "server");
    fs.mkdirSync(bibDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(serverDir, { recursive: true });

    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(bibDir, `asset_${String(i).padStart(2, "0")}.json`), "{}", "utf8");
    }
    fs.writeFileSync(path.join(projAlphaDir, "package.json"), JSON.stringify({ name: "alpha-app" }), "utf8");
    fs.writeFileSync(path.join(srcDir, "index.js"), "console.log('alpha');\n", "utf8");
    fs.writeFileSync(path.join(serverDir, "api.js"), "export const ok = true;\n", "utf8");

    const scanned = contextBridge.scanProjectFiles(projAlphaDir, "", 0, 2, 45);
    assert.ok(scanned.includes("package.json"));
    assert.ok(scanned.includes("src/index.js"));
    assert.ok(scanned.includes("server/api.js"));
    assert.ok(scanned.length <= 45);

    memoryStore.updateProjectState(projAlphaDir, {
      githubToggle: true,
      githubRepo: "benner/alpha-app",
      lastSessionId: "ses-1"
    });

    const ctxPreview = contextBridge.buildProjectContext("AlphaApp", null, null, {
      writeToDisk: false,
      skillId: "backend-architect",
      profileId: "Pirata",
      customSystemPrompt: "Foco en pruebas."
    });

    assert.equal(fs.existsSync(path.join(projAlphaDir, "PROJECT_CONTEXT.md")), false, "preview no debe escribir PROJECT_CONTEXT.md");
    assert.ok(ctxPreview.sections.masterPrompt.includes("Foco en pruebas."));
    assert.ok(ctxPreview.sections.skillPrompt.includes("PERFIL COGNITIVO ACTIVO"));
    assert.ok(ctxPreview.sections.stateSummary.includes("benner/alpha-app"));
    assert.ok(ctxPreview.sections.projectContextXml.includes("<contexto_del_proyecto>"));
    assert.ok(ctxPreview.sections.codeContextXml.includes("<codigo_fuente_del_proyecto>"));
    assert.ok(ctxPreview.sections.mutationDirectives.includes("write:ruta/relativa"));
    assert.ok(ctxPreview.metrics.totalChars > 0);
    assert.ok(ctxPreview.metrics.approxTokens > 0);

    // Verificar orden estricto de secciones en systemPrompt
    const posMaster = ctxPreview.systemPrompt.indexOf(ctxPreview.sections.masterPrompt);
    const posSkill = ctxPreview.systemPrompt.indexOf(ctxPreview.sections.skillPrompt);
    const posState = ctxPreview.systemPrompt.indexOf(ctxPreview.sections.stateSummary);
    const posCtx = ctxPreview.systemPrompt.indexOf(ctxPreview.sections.projectContextXml);
    const posCode = ctxPreview.systemPrompt.indexOf(ctxPreview.sections.codeContextXml);
    const posMut = ctxPreview.systemPrompt.indexOf(ctxPreview.sections.mutationDirectives);
    assert.ok(posMaster < posSkill && posSkill < posState && posState < posCtx && posCtx < posCode && posCode < posMut);

    // Ahora con writeToDisk: true sí escribe PROJECT_CONTEXT.md
    contextBridge.buildProjectContext("AlphaApp", null, null, { writeToDisk: true });
    assert.equal(fs.existsSync(path.join(projAlphaDir, "PROJECT_CONTEXT.md")), true);
  });

  it("skills-bridge carga >100 skills, resuelve rutas anidadas, carga perfiles recursivos y prioriza Perfil > Skill", () => {
    const allSkills = skillsBridge.searchSkills("", "", 2000);
    assert.ok(Array.isArray(allSkills));
    assert.ok(allSkills.length > 100, `Esperados >100 skills, encontrados ${allSkills.length}`);

    const unlimitedSkills = skillsBridge.searchSkills("", "", 0);
    assert.ok(unlimitedSkills.length >= allSkills.length);

    // Skill anidado en skills_index.json (skills/game-development/2d-games/SKILL.md)
    const nestedSkill = skillsBridge.getSkillContent("2d-games");
    assert.ok(nestedSkill && nestedSkill.length > 50, "Debe resolver ruta anidada 2d-games");

    // Perfiles recursivos en Modelos-ai-brains y Modelos -ai-brains
    const profiles = skillsBridge.loadProfiles();
    assert.ok(profiles.length >= 200, `Esperados >=200 perfiles, encontrados ${profiles.length}`);

    const byRelId = skillsBridge.getProfileContent("engineering/engineering-software-architect");
    const byBasename = skillsBridge.getProfileContent("engineering-software-architect");
    const pirata = skillsBridge.getProfileContent("Pirata");
    assert.ok(byRelId && byRelId.length > 50);
    assert.equal(byRelId, byBasename);
    assert.ok(pirata && pirata.includes("pirata"));

    const combined = skillsBridge.buildSkillSystemPrompt("2d-games", "engineering/engineering-software-architect");
    const posPerfil = combined.indexOf("PERFIL COGNITIVO ACTIVO (JERARQUÍA SUPERIOR)");
    const posSkill = combined.indexOf("HABILIDAD TÉCNICA ACTIVA: 2D-GAMES");
    assert.ok(posPerfil !== -1 && posSkill !== -1 && posPerfil < posSkill);
    assert.ok(combined.includes("JERARQUÍA DE MANDO (Perfil > Skill)"));

    // Verifica ausencia de truncado arbitrario a 6000 chars en skills grandes
    const hugeSkill = skillsBridge.getSkillContent("computer-use-agents");
    if (hugeSkill && hugeSkill.length > 6500) {
      const promptWithHuge = skillsBridge.buildSkillSystemPrompt("computer-use-agents", null);
      assert.ok(promptWithHuge.length > 6500);
    }
  });

  it("context-analyzer recolecta telemetría git sanitizada, manifiestos, avances, brain artifacts y TODO/FIXME", () => {
    // Inicializar repo git temporal real
    execFileSync("git", ["-C", projAlphaDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "config", "user.email", "test@local.ai"], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "config", "user.name", "Test User"], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "remote", "add", "origin", "https://benner:ghp_SuperSecretToken123@github.com/benner/alpha.git"], { stdio: "ignore" });

    fs.writeFileSync(path.join(projAlphaDir, "package.json"), JSON.stringify({
      name: "alpha-app",
      version: "1.2.3",
      dependencies: { express: "^4.0.0" }
    }), "utf8");
    fs.writeFileSync(path.join(projAlphaDir, "requirements.txt"), "# deps\nfastapi==0.110.0\nuvicorn\n", "utf8");
    fs.mkdirSync(path.join(projAlphaDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projAlphaDir, "src", "main.js"), "// TODO: validar JWT\n// FIXME: manejar timeout\nconsole.log(1);\n", "utf8");

    execFileSync("git", ["-C", projAlphaDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "commit", "-m", "feat: initial commit"], { stdio: "ignore" });

    // Modificación sin commit para ver statusLines y diffStat
    fs.writeFileSync(path.join(projAlphaDir, "src", "main.js"), "// TODO: validar JWT\n// FIXME: manejar timeout\nconsole.log(2);\n", "utf8");

    // AVANCES_LOCAL_AI.md > 3500 chars para validar corte limpio en "## ["
    const entry1 = "## [2026-11-01 10:00] - Sesión 1\n" + "Detalle largo ".repeat(220) + "\n";
    const entry2 = "## [2026-11-02 12:00] - Sesión 2\n- **Resumen:** Implementado router principal.\n";
    fs.writeFileSync(path.join(projAlphaDir, "AVANCES_LOCAL_AI.md"), entry1 + "\n" + entry2, "utf8");

    // Artefactos de Antigravity en BRAIN_DIR/<convId>
    const convId = "conv-test-001";
    const brainConvDir = path.join(tempBrainDir, convId);
    const logsDir = path.join(brainConvDir, ".system_generated", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(brainConvDir, "task.md"), "- [x] Paso 1\n- [/] Paso 2 en curso\n- [ ] Paso 3 pendiente\n", "utf8");
    fs.writeFileSync(path.join(logsDir, "transcript.jsonl"), [
      JSON.stringify({ type: "USER_INPUT", created_at: "2026-11-09T10:00:00Z", content: "<USER_REQUEST>Revisa el router</USER_REQUEST>" }),
      JSON.stringify({ type: "PLANNER_RESPONSE", created_at: "2026-11-09T10:01:00Z", content: "Router auditado correctamente." })
    ].join("\n"), "utf8");

    const payload = contextAnalyzer.buildEnterContextPayload({
      projectName: "AlphaApp",
      convId,
      skillId: "backend-architect",
      profileId: "Pirata"
    });

    const t = payload.telemetry;
    assert.equal(t.git.isGitRepo, true);
    assert.ok(t.git.branch.length > 0);
    assert.equal(t.git.remoteOrigin, "https://github.com/benner/alpha.git");
    assert.equal(t.git.remoteOrigin.includes("ghp_SuperSecretToken123"), false);
    assert.ok(t.git.statusLines.some((l) => l.includes("src/main.js")));
    assert.equal(t.git.recentCommits.length, 1);
    assert.ok(t.git.diffStat.includes("src/main.js"));

    assert.ok(t.manifests.detected.includes("package.json"));
    assert.ok(t.manifests.detected.includes("requirements.txt"));
    assert.ok(t.avancesTail.startsWith("## ["));
    assert.ok(t.avancesTail.includes("Sesión 2"));

    assert.equal(t.brain.available, true);
    assert.equal(t.brain.checklistSummary.completed, 1);
    assert.equal(t.brain.checklistSummary.inProgress, 1);
    assert.equal(t.brain.checklistSummary.pending, 1);
    assert.equal(t.brain.recentTurns.length, 2);

    assert.ok(t.todoMarkers.some((m) => m.tag === "TODO" && m.text.includes("validar JWT")));
    assert.ok(t.todoMarkers.some((m) => m.tag === "FIXME" && m.text.includes("manejar timeout")));

    assert.ok(payload.digestMarkdown.includes("Estado Git"));
    assert.ok(payload.promptPackage.systemPrompt.includes("<thinking>"));
    assert.ok(payload.promptPackage.systemPrompt.includes("Estado Actual Verificado"));
    assert.ok(payload.promptPackage.userPrompt.includes("<telemetria_verificada>"));
    assert.ok(payload.promptPackage.metrics.approxTokens > 0);
  });

  it("freeai-bridge normaliza FREEAI_BASE_URL y soporta FREE_AI_API_KEY", () => {
    process.env.FREEAI_BASE_URL = "https://custom.freeai.example/v1///";
    process.env.FREE_AI_API_KEY = "freeai_test_key_abc";

    assert.equal(freeaiBridge.getBaseUrl(), "https://custom.freeai.example/v1");
    assert.ok(freeaiBridge.getApiKeys().includes("freeai_test_key_abc"));

    delete process.env.FREEAI_BASE_URL;
    assert.equal(freeaiBridge.getBaseUrl(), "https://api.free.ai/v1");
  });
});
