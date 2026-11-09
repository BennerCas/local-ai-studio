const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const envLoader = require("../env-loader.js");
const memoryStore = require("../memory-store.js");
const { createStudioServer } = require("../sidecars/local_ai_chat/server.js");

let tempRoot = "";
let tempProjectsDir = "";
let tempMemoryDir = "";
let tempConfigFile = "";
let tempBrainDir = "";
let projAlphaDir = "";

let studioServer = null;
let studioBaseUrl = "";
let mockEngineServer = null;
let mockEnginePort = 0;
let closedPort = 0;
let capturedMockRequests = [];

const ENV_BACKUP_KEYS = [
  "LOCAL_AI_PROJECTS_DIR",
  "LOCAL_AI_MEMORY_DIR",
  "LOCAL_AI_CONFIG_FILE",
  "LOCAL_AI_BRAIN_DIR",
  "FREEAI_BASE_URL",
  "FREEAI_API_KEY_1",
  "FREE_AI_API_KEY"
];
let savedEnvValues = {};

function listenServer(srv) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      resolve(srv.address().port);
    });
  });
}

function closeServer(srv) {
  return new Promise((resolve) => {
    if (!srv || !srv.listening) return resolve();
    srv.close(() => resolve());
  });
}

async function getUnusedPort() {
  const probe = http.createServer();
  const port = await listenServer(probe);
  await closeServer(probe);
  return port;
}

async function httpReq(endpointPath, options = {}) {
  const method = options.method || "GET";
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body !== undefined && typeof body !== "string") {
    body = JSON.stringify(body);
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(`${studioBaseUrl}${endpointPath}`, {
    method,
    headers,
    body
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_e) {}

  return {
    status: res.status,
    headers: res.headers,
    text,
    json
  };
}

function assertNoSecretsInPayload(payload) {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  const tokens = [
    envLoader.getGithubToken(),
    envLoader.getNetlifyToken(),
    envLoader.getHfToken(),
    process.env.FREEAI_API_KEY_1,
    process.env.FREEAI_API_KEY_2,
    process.env.FREE_AI_API_KEY
  ].filter((t) => t && t.trim().length >= 6);

  for (const tok of tokens) {
    assert.equal(serialized.includes(tok), false, "La respuesta JSON nunca debe exponer tokens reales");
  }
  assert.equal(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}\b/.test(serialized), false);
  assert.equal(/\bhf_[A-Za-z0-9]{10,}\b/.test(serialized), false);
  assert.equal(/\bnfp_[A-Za-z0-9_]{10,}\b/.test(serialized), false);
}

function createMockAiEngineServer() {
  return http.createServer((req, res) => {
    if (req.url === "/ping" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch (_e) {}

      capturedMockRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
        raw
      });

      if (req.url === "/freeai/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Respuesta Free.ai " } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "verificada." } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (req.url === "/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Respuesta DirectML verificada." } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      if (req.url === "/api/chat") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
        res.write(JSON.stringify({ model: parsed?.model || "llama3", message: { role: "assistant", content: "Respuesta Ollama " }, done: false }) + "\n");
        res.write(JSON.stringify({ model: parsed?.model || "llama3", message: { role: "assistant", content: "verificada." }, done: false }) + "\n");
        res.write(JSON.stringify({ model: parsed?.model || "llama3", message: { role: "assistant", content: "" }, done: true }) + "\n");
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not mocked" }));
    });
  });
}

describe("sidecars/local_ai_chat/server.js HTTP Integration Tests", () => {
  beforeEach(async () => {
    savedEnvValues = {};
    for (const k of ENV_BACKUP_KEYS) {
      savedEnvValues[k] = process.env[k];
    }

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-srv-test-"));
    tempProjectsDir = path.join(tempRoot, "projects");
    tempMemoryDir = path.join(tempRoot, "memory");
    tempConfigFile = path.join(tempRoot, "active_project.json");
    tempBrainDir = path.join(tempRoot, "brain");
    projAlphaDir = path.join(tempProjectsDir, "AlphaApp");

    fs.mkdirSync(path.join(projAlphaDir, "src"), { recursive: true });
    fs.mkdirSync(tempMemoryDir, { recursive: true });
    fs.mkdirSync(tempBrainDir, { recursive: true });

    fs.writeFileSync(path.join(projAlphaDir, "package.json"), JSON.stringify({
      name: "alpha-app",
      version: "1.0.0",
      scripts: { test: "node --test" },
      dependencies: { hono: "^4.0.0" }
    }), "utf8");
    fs.writeFileSync(path.join(projAlphaDir, "src", "index.js"), "// TODO: validar payload\nconsole.log('AlphaApp');\n", "utf8");

    process.env.LOCAL_AI_PROJECTS_DIR = tempProjectsDir;
    process.env.LOCAL_AI_MEMORY_DIR = tempMemoryDir;
    process.env.LOCAL_AI_CONFIG_FILE = tempConfigFile;
    process.env.LOCAL_AI_BRAIN_DIR = tempBrainDir;

    capturedMockRequests = [];
    mockEngineServer = createMockAiEngineServer();
    mockEnginePort = await listenServer(mockEngineServer);
    closedPort = await getUnusedPort();

    studioServer = createStudioServer({
      ollamaPort: mockEnginePort,
      directmlPort: mockEnginePort,
      autoStartDirectML: false
    });
    const studioPort = await listenServer(studioServer);
    studioBaseUrl = `http://127.0.0.1:${studioPort}`;
  });

  afterEach(async () => {
    await closeServer(studioServer);
    await closeServer(mockEngineServer);
    studioServer = null;
    mockEngineServer = null;

    for (const k of ENV_BACKUP_KEYS) {
      if (savedEnvValues[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnvValues[k];
      }
    }

    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("responde /api/version 2.0.0, CORS OPTIONS y /api/projects con projectState", async () => {
    const optRes = await httpReq("/api/version", { method: "OPTIONS" });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get("access-control-allow-origin"), "*");
    assert.match(optRes.headers.get("access-control-allow-methods") || "", /DELETE/);

    const verRes = await httpReq("/api/version");
    assert.equal(verRes.status, 200);
    assert.equal(verRes.json.v, "2.0.0");
    assert.equal(typeof verRes.json.build, "number");

    const projRes = await httpReq("/api/projects");
    assert.equal(projRes.status, 200);
    assert.equal(projRes.json.ok, true);
    assert.ok(Array.isArray(projRes.json.projects));
    assert.ok(projRes.json.projects.some((p) => p.name === "AlphaApp"));
    assert.ok(projRes.json.projectState);
  });

  it("GET /api/skills devuelve >100 skills y perfiles sanitizados sin fullPath", async () => {
    const res = await httpReq("/api/skills?limit=0");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(Array.isArray(res.json.skills));
    assert.ok(res.json.skills.length > 100, `Esperados >100 skills, recibidos ${res.json.skills.length}`);
    assert.equal(res.json.count, res.json.skills.length);
    assert.equal(res.json.totalCount, res.json.skills.length);
    assert.ok(Array.isArray(res.json.categories) && res.json.categories.length > 0);
    assert.ok(Array.isArray(res.json.profiles) && res.json.profiles.length > 0);

    const sampleProfile = res.json.profiles[0];
    assert.ok(sampleProfile.id);
    assert.ok(sampleProfile.name);
    assert.equal("fullPath" in sampleProfile, false, "profiles no debe exponer fullPath");

    const skillContentRes = await httpReq("/api/skills/content?id=backend-architect");
    assert.equal(skillContentRes.status, 200);
    assert.equal(skillContentRes.json.ok, true);
    assert.ok(skillContentRes.json.content.length > 50);

    const profileContentRes = await httpReq("/api/profiles/content?id=Pirata");
    assert.equal(profileContentRes.status, 200);
    assert.equal(profileContentRes.json.ok, true);
    assert.ok(profileContentRes.json.content.toLowerCase().includes("pirata"));

    const missingIdRes = await httpReq("/api/skills/content");
    assert.equal(missingIdRes.status, 400);

    const notFoundSkill = await httpReq("/api/skills/content?id=no-existe-skill-xyz-999");
    assert.equal(notFoundSkill.status, 404);
  });

  it("GET /api/project/preview-context y /api/context son puros (sin crear PROJECT_CONTEXT.md) con metrics, skillPrompt y masterPrompt", async () => {
    const res = await httpReq(
      "/api/project/preview-context?project=AlphaApp&skillId=backend-architect&profileId=Pirata&customSystemPrompt=Foco%20en%20HTTP"
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.project.name, "AlphaApp");

    // Nunca debe escribir PROJECT_CONTEXT.md en disco
    assert.equal(fs.existsSync(path.join(projAlphaDir, "PROJECT_CONTEXT.md")), false);

    assert.ok(res.json.metrics && res.json.metrics.totalChars > 0);
    assert.ok(res.json.metrics.approxTokens > 0);
    assert.ok(res.json.sections.masterPrompt.includes("Foco en HTTP"));
    assert.ok(res.json.sections.skillPrompt.includes("PERFIL COGNITIVO ACTIVO"));
    assert.ok(res.json.sections.skillPrompt.includes("HABILIDAD TÉCNICA ACTIVA: BACKEND-ARCHITECT"));
    assert.ok(res.json.systemPrompt.includes("<contexto_del_proyecto>"));
    assert.ok(res.json.summaryMarkdown.includes("AlphaApp"));

    // /api/context tampoco ensucia disco
    const ctxRes = await httpReq("/api/context?project=AlphaApp");
    assert.equal(ctxRes.status, 200);
    assert.equal(ctxRes.json.ok, true);
    assert.equal(fs.existsSync(path.join(projAlphaDir, "PROJECT_CONTEXT.md")), false);

    // POST /api/context/select actualiza activo y projectState
    const selRes = await httpReq("/api/context/select", {
      method: "POST",
      body: { projectName: "AlphaApp", lastSessionId: "ses-sel-1" }
    });
    assert.equal(selRes.status, 200);
    assert.equal(selRes.json.ok, true);
    assert.equal(selRes.json.active.name, "AlphaApp");
    assert.equal(selRes.json.projectState.lastSessionId, "ses-sel-1");
  });

  it("CRUD completo de /api/memory/chats (>25 chats), migración idempotente y actualización de lastSessionId", async () => {
    for (let i = 1; i <= 28; i++) {
      const saveRes = await httpReq("/api/memory/chats", {
        method: "POST",
        body: {
          id: `chat-${i}`,
          title: `Sesión ${i}`,
          project: "AlphaApp",
          projectPath: projAlphaDir,
          model: "qwen2.5-coder",
          messages: [{ role: "user", content: `Mensaje ${i}` }],
          updatedAt: new Date(Date.UTC(2026, 3, i, 10, 0, 0)).toISOString()
        }
      });
      assert.equal(saveRes.status, 200);
      assert.equal(saveRes.json.ok, true);
      assert.equal(saveRes.json.chat.id, `chat-${i}`);
    }

    // Verificar que lastSessionId se actualizó en project_states.json
    const stateRes = await httpReq(`/api/memory/project-state?project=AlphaApp&projectPath=${encodeURIComponent(projAlphaDir)}`);
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.json.state.lastSessionId, "chat-28");

    // Listar >25 chats
    const listRes = await httpReq("/api/memory/chats?project=AlphaApp");
    assert.equal(listRes.status, 200);
    assert.equal(listRes.json.ok, true);
    assert.equal(listRes.json.chats.length, 28);
    assert.equal(listRes.json.chats[0].id, "chat-28");

    // GET por :id y por query alias ?id=
    const getByPath = await httpReq("/api/memory/chats/chat-15");
    assert.equal(getByPath.status, 200);
    assert.equal(getByPath.json.chat.title, "Sesión 15");

    const getByAlias = await httpReq("/api/memory/chat?id=chat-15");
    assert.equal(getByAlias.status, 200);
    assert.equal(getByAlias.json.chat.id, "chat-15");

    const getMissing = await httpReq("/api/memory/chats/no-existe-id");
    assert.equal(getMissing.status, 404);

    // DELETE por :id y por query ?id=
    const del1 = await httpReq("/api/memory/chats/chat-15", { method: "DELETE" });
    assert.equal(del1.status, 200);
    assert.equal(del1.json.ok, true);
    assert.equal(del1.json.deleted, true);

    const afterDel1 = await httpReq("/api/memory/chats/chat-15");
    assert.equal(afterDel1.status, 404);

    const del2 = await httpReq("/api/memory/chats?id=chat-14", { method: "DELETE" });
    assert.equal(del2.status, 200);
    assert.equal(del2.json.deleted, true);

    // Migración legacy idempotente
    const mig1 = await httpReq("/api/memory/chats/migrate", {
      method: "POST",
      body: {
        sessions: [
          { id: "legacy-a", title: "Legacy A", project: "AlphaApp", messages: [{ role: "user", content: "old" }] },
          { id: "legacy-b", title: "Legacy B", project: "AlphaApp", messages: [{ role: "user", content: "old 2" }] }
        ]
      }
    });
    assert.equal(mig1.status, 200);
    assert.equal(mig1.json.ok, true);
    assert.equal(mig1.json.imported, 2);

    const mig2 = await httpReq("/api/memory/chats/migrate", {
      method: "POST",
      body: {
        sessions: [
          { id: "legacy-a", title: "Legacy A", project: "AlphaApp", messages: [] },
          { id: "legacy-b", title: "Legacy B", project: "AlphaApp", messages: [] }
        ]
      }
    });
    assert.equal(mig2.status, 200);
    assert.equal(mig2.json.imported, 0);
  });

  it("GET/POST/reset en /api/prompt/master impacta inmediatamente preview-context", async () => {
    const initial = await httpReq("/api/prompt/master?project=AlphaApp");
    assert.equal(initial.status, 200);
    assert.equal(initial.json.ok, true);
    assert.ok(initial.json.globalPrompt.length > 20);
    assert.ok(initial.json.defaults && initial.json.defaults.globalPrompt);

    const saved = await httpReq("/api/prompt/master", {
      method: "POST",
      body: {
        globalPrompt: "MASTER_GLOBAL_CUSTOM_XYZ",
        project: "AlphaApp",
        projectOverride: "REGLA_ALPHA_STRICT"
      }
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.globalPrompt, "MASTER_GLOBAL_CUSTOM_XYZ");
    assert.equal(saved.json.projectOverride, "REGLA_ALPHA_STRICT");

    const preview = await httpReq("/api/project/preview-context?project=AlphaApp");
    assert.equal(preview.status, 200);
    assert.ok(preview.json.sections.masterPrompt.includes("MASTER_GLOBAL_CUSTOM_XYZ"));
    assert.ok(preview.json.sections.masterPrompt.includes("REGLA_ALPHA_STRICT"));

    const reset = await httpReq("/api/prompt/master", {
      method: "POST",
      body: {
        project: "AlphaApp",
        resetToDefault: true
      }
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.globalPrompt, reset.json.defaults.globalPrompt);
    assert.equal(reset.json.projectOverride, "");
  });

  it("save-file, apply-patch, bloqueo 400/403 ante ../outside.txt y .env, y verificación en /api/memory/changes", async () => {
    fs.writeFileSync(path.join(projAlphaDir, ".env"), "SUPER_SECRET=do_not_read\n", "utf8");

    const saveRes = await httpReq("/api/project/save-file", {
      method: "POST",
      body: {
        project: "AlphaApp",
        filePath: "src/app.js",
        content: "const version = 1;\nconsole.log(version);\n",
        model: "Hermes-3",
        source: "directml",
        summary: "Creación inicial de app.js"
      }
    });
    assert.equal(saveRes.status, 200);
    assert.equal(saveRes.json.ok, true);
    assert.equal(saveRes.json.relPath, "src/app.js");

    const patchRes = await httpReq("/api/project/apply-patch", {
      method: "POST",
      body: {
        project: "AlphaApp",
        filePath: "src/app.js",
        search: "const version = 1;",
        replace: "const version = 2;",
        model: "Qwen2.5-Coder",
        source: "ollama"
      }
    });
    assert.equal(patchRes.status, 200);
    assert.equal(patchRes.json.ok, true);
    assert.ok(patchRes.json.backupPath);
    assert.equal(fs.existsSync(patchRes.json.backupPath), true);
    assert.equal(
      fs.readFileSync(path.join(projAlphaDir, "src", "app.js"), "utf8"),
      "const version = 2;\nconsole.log(version);\n"
    );

    const readRes = await httpReq("/api/project/read-file?project=AlphaApp&filePath=src/app.js");
    assert.equal(readRes.status, 200);
    assert.ok(readRes.json.content.includes("const version = 2;"));

    // Bloqueo de seguridad en traversal y .env
    for (const evilPath of ["../outside.txt", ".env", ".env.production", ".git/config"]) {
      const badSave = await httpReq("/api/project/save-file", {
        method: "POST",
        body: { project: "AlphaApp", filePath: evilPath, content: "pwned" }
      });
      assert.ok(badSave.status === 400 || badSave.status === 403, `save-file debía bloquear ${evilPath}`);
      assert.equal(badSave.json.ok, false);

      const badPatch = await httpReq("/api/project/apply-patch", {
        method: "POST",
        body: { project: "AlphaApp", filePath: evilPath, search: "x", replace: "y" }
      });
      assert.ok(badPatch.status === 400 || badPatch.status === 403, `apply-patch debía bloquear ${evilPath}`);
      assert.equal(badPatch.json.ok, false);

      const badRead = await httpReq(`/api/project/read-file?project=AlphaApp&filePath=${encodeURIComponent(evilPath)}`);
      assert.ok(badRead.status === 400 || badRead.status === 403, `read-file debía bloquear ${evilPath}`);
      assert.equal(badRead.json.ok, false);
    }

    assert.equal(fs.existsSync(path.join(tempProjectsDir, "outside.txt")), false);

    // Verificar registro en /api/memory/changes
    const changesRes = await httpReq("/api/memory/changes?project=AlphaApp&limit=10");
    assert.equal(changesRes.status, 200);
    assert.equal(changesRes.json.ok, true);
    assert.ok(changesRes.json.changes.some((c) => c.action === "create" && c.relPath === "src/app.js" && c.model === "Hermes-3"));
    assert.ok(changesRes.json.changes.some((c) => c.action === "patch" && c.relPath === "src/app.js" && c.model === "Qwen2.5-Coder"));
  });

  it("POST /api/project/enter-context soporta telemetryOnly, streaming con motor online y streaming con fallback offline persistiendo project-state", async () => {
    // Preparar repo git + brain artifacts para telemetría rica
    execFileSync("git", ["-C", projAlphaDir, "init"], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "config", "user.email", "test@local.ai"], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "config", "user.name", "Tester"], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "add", "."], { stdio: "ignore" });
    execFileSync("git", ["-C", projAlphaDir, "commit", "-m", "init"], { stdio: "ignore" });

    const convId = "conv-enter-1";
    const convBrainDir = path.join(tempBrainDir, convId);
    fs.mkdirSync(convBrainDir, { recursive: true });
    fs.writeFileSync(path.join(convBrainDir, "task.md"), "- [x] Base\n- [/] Integrar server\n- [ ] Pruebas E2E\n", "utf8");

    // 1. telemetryOnly: true
    const telOnlyRes = await httpReq("/api/project/enter-context", {
      method: "POST",
      body: {
        project: "AlphaApp",
        conversationId: convId,
        telemetryOnly: true
      }
    });
    assert.equal(telOnlyRes.status, 200);
    assert.equal(telOnlyRes.json.ok, true);
    assert.ok(telOnlyRes.json.telemetry.git.isGitRepo);
    assert.ok(telOnlyRes.json.digestMarkdown.includes("Estado Git"));
    assert.ok(telOnlyRes.json.promptPackage.systemPrompt.includes("<thinking>"));
    assert.ok(telOnlyRes.json.fallbackReport.includes("## 1. Estado Actual Verificado"));
    assert.ok(telOnlyRes.json.fallbackReport.includes("## 2. Procesos Inconclusos y Riesgos"));
    assert.ok(telOnlyRes.json.fallbackReport.includes("## 3. Lista de Tareas Pendientes"));
    assert.ok(telOnlyRes.json.fallbackReport.includes("## 4. Plan de Acción Recomendado"));

    const st1 = await httpReq(`/api/memory/project-state?project=AlphaApp&projectPath=${encodeURIComponent(projAlphaDir)}`);
    assert.equal(st1.status, 200);
    assert.equal(st1.json.state.lastContextAnalysis.mode, "telemetry_only");

    // 2. Streaming con motor online (mock Ollama)
    const streamOnlineRes = await httpReq("/api/project/enter-context", {
      method: "POST",
      body: {
        project: "AlphaApp",
        conversationId: convId,
        model: "qwen2.5-coder",
        source: "ollama",
        stream: true
      }
    });
    assert.equal(streamOnlineRes.status, 200);
    assert.match(streamOnlineRes.headers.get("content-type") || "", /text\/event-stream/);
    const onlineEvents = streamOnlineRes.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(onlineEvents[0].type, "telemetry");
    assert.equal(onlineEvents[0].checklistSummary.pending, 1);
    assert.ok(onlineEvents.some((ev) => ev.message && ev.message.content.includes("Respuesta Ollama")));
    assert.equal(onlineEvents[onlineEvents.length - 1].done, true);
    assert.equal(onlineEvents[onlineEvents.length - 1].fallback, false);

    const st2 = await httpReq(`/api/memory/project-state?project=AlphaApp&projectPath=${encodeURIComponent(projAlphaDir)}`);
    assert.equal(st2.json.state.lastContextAnalysis.mode, "stream_ai");

    // 3. Streaming con fallback inteligente cuando el motor está offline
    const offlineStudio = createStudioServer({
      ollamaPort: closedPort,
      directmlPort: closedPort,
      autoStartDirectML: false
    });
    const offlinePort = await listenServer(offlineStudio);
    try {
      const offRes = await fetch(`http://127.0.0.1:${offlinePort}/api/project/enter-context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project: "AlphaApp",
          conversationId: convId,
          model: "qwen2.5-coder",
          source: "ollama",
          stream: true
        })
      });
      assert.equal(offRes.status, 200);
      assert.match(offRes.headers.get("content-type") || "", /text\/event-stream/);
      const offText = await offRes.text();
      const offEvents = offText.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(offEvents[0].type, "telemetry");
      const fullFallbackContent = offEvents
        .filter((ev) => ev.message && ev.message.content)
        .map((ev) => ev.message.content)
        .join("");
      assert.match(fullFallbackContent, /offline/i);
      assert.ok(fullFallbackContent.includes("## 3. Lista de Tareas Pendientes"));
      assert.ok(fullFallbackContent.includes("Pruebas E2E"));
      assert.ok(fullFallbackContent.includes("## 4. Plan de Acción Recomendado"));
      assert.equal(offEvents[offEvents.length - 1].done, true);
      assert.equal(offEvents[offEvents.length - 1].fallback, true);

      const st3 = await httpReq(`/api/memory/project-state?project=AlphaApp&projectPath=${encodeURIComponent(projAlphaDir)}`);
      assert.equal(st3.json.state.lastContextAnalysis.mode, "stream_fallback");
    } finally {
      await closeServer(offlineStudio);
    }
  });

  it("/api/integrations/status no expone secretos y /api/integrations/hf/download exige targetDir con HTTP 400", async () => {
    const statusRes = await httpReq("/api/integrations/status");
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.json.ok, true);
    assert.equal(typeof statusRes.json.status.githubConfigured, "boolean");
    assert.equal(typeof statusRes.json.status.netlifyConfigured, "boolean");
    assert.equal(typeof statusRes.json.status.hfConfigured, "boolean");
    assert.equal(statusRes.json.defaultModelsDir, "C:\\antigravityAS\\Modelos -ai-brains");
    assertNoSecretsInPayload(statusRes.json);

    // Rechaza ausencia de targetDir con HTTP 400
    const missingTarget = await httpReq("/api/integrations/hf/download", {
      method: "POST",
      body: { repoId: "Qwen/Qwen2.5-0.5B-Instruct" }
    });
    assert.equal(missingTarget.status, 400);
    assert.equal(missingTarget.json.ok, false);
    assert.equal(missingTarget.json.code, "TARGET_DIR_REQUIRED");

    const emptyTarget = await httpReq("/api/integrations/hf/download", {
      method: "POST",
      body: { repoId: "Qwen/Qwen2.5-0.5B-Instruct", targetDir: "   " }
    });
    assert.equal(emptyTarget.status, 400);
    assert.equal(emptyTarget.json.ok, false);
    assert.equal(emptyTarget.json.code, "TARGET_DIR_REQUIRED");

    const rootTarget = await httpReq("/api/integrations/hf/download", {
      method: "POST",
      body: { repoId: "Qwen/Qwen2.5-0.5B-Instruct", targetDir: "C:\\" }
    });
    assert.equal(rootTarget.status, 400);
    assert.equal(rootTarget.json.ok, false);
    assert.equal(rootTarget.json.code, "INVALID_TARGET_DIR");

    // Downloads list & cancel validation
    memoryStore.upsertDownload({ jobId: "hf_test_job", repoId: "test/model", status: "completed", progress: 100 });
    const listDl = await httpReq("/api/integrations/hf/downloads");
    assert.equal(listDl.status, 200);
    assert.ok(listDl.json.downloads.some((d) => d.jobId === "hf_test_job"));

    const singleDl = await httpReq("/api/integrations/hf/downloads?jobId=hf_test_job");
    assert.equal(singleDl.status, 200);
    assert.equal(singleDl.json.job.repoId, "test/model");

    const badCancel = await httpReq("/api/integrations/hf/cancel", { method: "POST", body: {} });
    assert.equal(badCancel.status, 400);
  });

  it("POST /api/chat rechaza JSON corrupto con HTTP 400 e inyecta el mismo System Prompt unificado en Free.ai, DirectML y Ollama", async () => {
    // 1. JSON malformado -> 400 explícito sin forwarding
    const malformed = await httpReq("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{corrupt_json_payload"
    });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.ok, false);
    assert.equal(capturedMockRequests.length, 0);

    // Configurar Master Prompt + Free.ai mock
    await httpReq("/api/prompt/master", {
      method: "POST",
      body: {
        globalPrompt: "UNIFIED_MASTER_PROMPT_ABC",
        project: "AlphaApp",
        projectOverride: "ALPHA_PROJECT_RULE_123"
      }
    });
    process.env.FREEAI_BASE_URL = `http://127.0.0.1:${mockEnginePort}/freeai/v1`;
    process.env.FREEAI_API_KEY_1 = "freeai_mock_key_test";

    const sharedChatBody = {
      project: "AlphaApp",
      skillId: "backend-architect",
      profileId: "Pirata",
      customSystemPrompt: "CUSTOM_SESSION_RULE_777",
      messages: [{ role: "user", content: "Analiza src/index.js" }],
      stream: true
    };

    // Free.ai
    const freeRes = await httpReq("/api/chat", {
      method: "POST",
      body: { ...sharedChatBody, model: "freeai:qwen7b", isFreeAi: true, source: "freeai" }
    });
    assert.equal(freeRes.status, 200);
    assert.ok(freeRes.text.includes("Respuesta Free.ai"));

    // DirectML
    const dmlRes = await httpReq("/api/chat", {
      method: "POST",
      body: { ...sharedChatBody, model: "Phi-3.5-mini-instruct-ONNX", isDirectML: true, source: "directml" }
    });
    assert.equal(dmlRes.status, 200);
    assert.ok(dmlRes.text.includes("Respuesta DirectML verificada."));

    // Ollama
    const ollamaRes = await httpReq("/api/chat", {
      method: "POST",
      body: { ...sharedChatBody, model: "qwen2.5-coder", source: "local" }
    });
    assert.equal(ollamaRes.status, 200);
    assert.ok(ollamaRes.text.includes("Respuesta Ollama"));

    const freeReq = capturedMockRequests.find((r) => r.url === "/freeai/v1/chat/completions");
    const dmlReq = capturedMockRequests.find((r) => r.url === "/v1/chat/completions");
    const ollamaReq = capturedMockRequests.find((r) => r.url === "/api/chat");

    assert.ok(freeReq && dmlReq && ollamaReq, "Los 3 motores debieron recibir sus peticiones");

    const sysFree = freeReq.body.messages[0];
    const sysDml = dmlReq.body.messages[0];
    const sysOllama = ollamaReq.body.messages[0];

    assert.equal(sysFree.role, "system");
    assert.equal(sysDml.role, "system");
    assert.equal(sysOllama.role, "system");

    // Idéntico System Prompt unificado en los 3 motores
    assert.equal(sysFree.content, sysDml.content);
    assert.equal(sysOllama.content, sysDml.content);

    // Verificar todas las capas sin duplicación
    assert.ok(sysOllama.content.includes("UNIFIED_MASTER_PROMPT_ABC"));
    assert.ok(sysOllama.content.includes("ALPHA_PROJECT_RULE_123"));
    assert.ok(sysOllama.content.includes("CUSTOM_SESSION_RULE_777"));
    assert.ok(sysOllama.content.includes("PERFIL COGNITIVO ACTIVO"));
    assert.ok(sysOllama.content.includes("HABILIDAD TÉCNICA ACTIVA: BACKEND-ARCHITECT"));
    assert.ok(sysOllama.content.includes("<contexto_del_proyecto>"));
    assert.ok(sysOllama.content.includes("write:ruta/relativa"));

    // Sin duplicación de Skill o Custom System Prompt
    const skillOccurrences = sysOllama.content.split("HABILIDAD TÉCNICA ACTIVA: BACKEND-ARCHITECT").length - 1;
    const customOccurrences = sysOllama.content.split("CUSTOM_SESSION_RULE_777").length - 1;
    assert.equal(skillOccurrences, 1);
    assert.equal(customOccurrences, 1);

    // DirectML max_tokens >= 2048 por defecto
    assert.equal(dmlReq.body.max_tokens, 2048);
  });

  it("save-file conserva ok: true local si syncGithub falla, y valida endpoints legacy y de integraciones", async () => {
    // 1. save-file con syncGithub inválido: guardado local ok: true, fallo remoto reportado en githubSync
    const saveWithSyncFail = await httpReq("/api/project/save-file", {
      method: "POST",
      body: {
        project: "AlphaApp",
        filePath: "src/synced.js",
        content: "export const synced = true;\n",
        syncGithub: true,
        githubRepo: "invalid-no-slash",
        model: "qwen2.5-coder"
      }
    });
    assert.equal(saveWithSyncFail.status, 200);
    assert.equal(saveWithSyncFail.json.ok, true);
    assert.equal(fs.existsSync(path.join(projAlphaDir, "src", "synced.js")), true);
    assert.equal(saveWithSyncFail.json.githubSync.ok, false);

    // 2. Legacy endpoints: folders, load-folder, select-files, log-progress, tags, directml/status, static UI
    const foldersRes = await httpReq("/api/project/folders");
    assert.equal(foldersRes.status, 200);
    assert.ok(foldersRes.json.folders.some((f) => f.name === "AlphaApp"));

    const loadRes = await httpReq("/api/project/load-folder", {
      method: "POST",
      body: { folderPath: projAlphaDir }
    });
    assert.equal(loadRes.status, 200);
    assert.equal(loadRes.json.ok, true);
    assert.ok(Array.isArray(loadRes.json.files) && loadRes.json.files.length > 0);

    const selFilesRes = await httpReq("/api/project/select-files", {
      method: "POST",
      body: { folderPath: projAlphaDir, selectedFiles: ["src/index.js"] }
    });
    assert.equal(selFilesRes.status, 200);
    assert.equal(selFilesRes.json.count, 1);

    const logProgRes = await httpReq("/api/project/log-progress", {
      method: "POST",
      body: { project: "AlphaApp", model: "qwen2.5-coder", task: "Test", summary: "OK", filesModified: ["src/index.js"] }
    });
    assert.equal(logProgRes.status, 200);
    assert.equal(logProgRes.json.ok, true);

    const dmlStatus = await httpReq("/api/directml/status");
    assert.equal(dmlStatus.status, 200);
    assert.equal(dmlStatus.json.status, "online");
    assert.equal(dmlStatus.json.isAlive, true);

    const tagsRes = await httpReq("/api/tags");
    assert.equal(tagsRes.status, 200);
    assert.ok(Array.isArray(tagsRes.json.models) && tagsRes.json.models.length > 0);

    const headRes = await fetch(`${studioBaseUrl}/`, { method: "HEAD" });
    assert.equal(headRes.status, 200);

    const uiRes = await httpReq("/");
    assert.equal(uiRes.status, 200);
    assert.match(uiRes.headers.get("content-type") || "", /text\/html/);

    const preloadRes = await httpReq("/preload.js");
    assert.equal(preloadRes.status, 200);
    assert.match(preloadRes.headers.get("content-type") || "", /javascript/);

    // 3. Validaciones HTTP 400/404 en integraciones y rutas API inexistentes
    const badRepo = await httpReq("/api/integrations/github/create-repo", {
      method: "POST",
      body: { name: "" }
    });
    assert.equal(badRepo.status, 400);

    const badSync = await httpReq("/api/integrations/github/sync", {
      method: "POST",
      body: { project: "AlphaApp", repoFullName: "invalid" }
    });
    assert.equal(badSync.status, 400);

    const badDeploy = await httpReq("/api/integrations/netlify/deploy", {
      method: "POST",
      body: { project: "AlphaApp" }
    });
    assert.equal(badDeploy.status, 400);

    const unknownApi = await httpReq("/api/non-existent-endpoint");
    assert.equal(unknownApi.status, 404);
    assert.equal(unknownApi.json.ok, false);
  });

  it("POST /api/project/enter-context transmite correctamente con DirectML y Free.ai mock", async () => {
    process.env.FREEAI_BASE_URL = `http://127.0.0.1:${mockEnginePort}/freeai/v1`;
    process.env.FREEAI_API_KEY_1 = "freeai_mock_key_enter_ctx";

    const dmlEnter = await httpReq("/api/project/enter-context", {
      method: "POST",
      body: {
        project: "AlphaApp",
        model: "Phi-3.5-mini-instruct-ONNX",
        isDirectML: true,
        source: "directml",
        stream: true
      }
    });
    assert.equal(dmlEnter.status, 200);
    const dmlEvents = dmlEnter.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(dmlEvents[0].type, "telemetry");
    assert.ok(dmlEvents.some((ev) => ev.message && ev.message.content.includes("Respuesta DirectML verificada.")));
    assert.equal(dmlEvents[dmlEvents.length - 1].done, true);
    assert.equal(dmlEvents[dmlEvents.length - 1].fallback, false);

    const freeEnter = await httpReq("/api/project/enter-context", {
      method: "POST",
      body: {
        project: "AlphaApp",
        model: "freeai:qwen7b",
        isFreeAi: true,
        source: "freeai",
        stream: true
      }
    });
    assert.equal(freeEnter.status, 200);
    const freeEvents = freeEnter.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(freeEvents[0].type, "telemetry");
    assert.ok(freeEvents.some((ev) => ev.message && ev.message.content.includes("Respuesta Free.ai")));
    assert.equal(freeEvents[freeEvents.length - 1].done, true);
    assert.equal(freeEvents[freeEvents.length - 1].fallback, false);
  });
});
