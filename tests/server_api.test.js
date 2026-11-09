const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const envLoader = require("../env-loader.js");
const memoryStore = require("../memory-store.js");
const hardwareAdvisor = require("../hardware-advisor.js");
const ttsBridge = require("../tts-bridge.js");
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
  "LOCAL_AI_DISABLE_EXTERNAL_ENV",
  "LOCAL_AI_EXTERNAL_ENV_PATH",
  "FREEAI_BASE_URL",
  "FREEAI_API_KEY_1",
  "FREEAI_API_KEY_2",
  "FREE_AI_API_KEY",
  ...hardwareAdvisor.SAFE_AI_ENV_KEYS
];
let savedEnvValues = {};
let savedSerpEnvValues = {};

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

function assertNoSecretsInPayload(payload, extraSecrets = []) {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  const pools = typeof envLoader.getSerpApiKeyPools === "function"
    ? envLoader.getSerpApiKeyPools()
    : { allKeys: [] };
  const tokens = [
    envLoader.getGithubToken(),
    envLoader.getNetlifyToken(),
    envLoader.getHfToken(),
    process.env.FREEAI_API_KEY_1,
    process.env.FREEAI_API_KEY_2,
    process.env.FREE_AI_API_KEY,
    ...(Array.isArray(pools.allKeys) ? pools.allKeys : []),
    ...(Array.isArray(extraSecrets) ? extraSecrets : [])
  ].filter((t) => t && String(t).trim().length >= 6);

  for (const tok of tokens) {
    assert.equal(serialized.includes(String(tok)), false, "La respuesta JSON nunca debe exponer tokens reales");
  }
  assert.equal(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}\b/.test(serialized), false);
  assert.equal(/\bhf_[A-Za-z0-9]{10,}\b/.test(serialized), false);
  assert.equal(/\bnfp_[A-Za-z0-9_]{10,}\b/.test(serialized), false);
  assert.equal(/[?&]api_key=[^&\s"'\[\]]+/i.test(serialized), false, "La respuesta nunca debe exponer api_key en URL");
}

async function withIsolatedSerpEnv(overrides, fn) {
  const backup = {
    LOCAL_AI_DISABLE_EXTERNAL_ENV: process.env.LOCAL_AI_DISABLE_EXTERNAL_ENV,
    LOCAL_AI_EXTERNAL_ENV_PATH: process.env.LOCAL_AI_EXTERNAL_ENV_PATH
  };
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("SERPAPI_")) {
      backup[k] = process.env[k];
      delete process.env[k];
    }
  }
  process.env.LOCAL_AI_DISABLE_EXTERNAL_ENV = "1";
  delete process.env.LOCAL_AI_EXTERNAL_ENV_PATH;

  for (const [k, v] of Object.entries(overrides || {})) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }
  envLoader.getSerpApiKeyPools();

  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SERPAPI_")) delete process.env[k];
    }
    for (const [k, v] of Object.entries(backup)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envLoader.getSerpApiKeyPools();
  }
}

async function withMockedSerpFetch(serpHandler, fn) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url || "");
    if (urlStr.includes("serpapi.com")) {
      return serpHandler(urlStr, init);
    }
    return origFetch(url, init);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = origFetch;
  }
}

function createMockAiEngineServer() {
  return http.createServer((req, res) => {
    if (req.url === "/ping" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/tags" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        models: [
          { name: "qwen2.5-coder:latest", size: 4200000000, details: { family: "qwen2", parameter_size: "7B" } },
          { name: "claude:latest", size: 8600000000, details: { family: "llama", parameter_size: "8B" } },
          { name: "deepseek-r1:cloud", size: 0, details: { family: "deepseek", parameter_size: "cloud" } }
        ]
      }));
      return;
    }

    if (req.url === "/api/ps" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:latest", model: "qwen2.5-coder:latest" }] }));
      return;
    }

    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "Phi-3.5-mini-instruct-ONNX", displayName: "Phi-3.5-mini-instruct (INT4)", size: "2.3 GB", active: true, status: "ready" },
          { id: "Hermes-3-8B-UNLOCKED-ONNX-DirectML", displayName: "Hermes-3-8B-UNLOCKED (Q8)", size: "8.5 GB", active: false, status: "ready" }
        ]
      }));
      return;
    }

    if (req.url === "/freeai/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { id: "qwen-2.5-coder", name: "Qwen 2.5 Coder (Free.ai)", license: "Apache-2.0", type: "chat" }
        ]
      }));
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, active_model: "Phi-3.5-mini-instruct-ONNX" }));
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

      if (parsed && String(parsed.model || "").includes("force-fail")) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Forced mock failure for ${parsed.model}` } }));
        return;
      }

      if (req.url === "/api/generate" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: parsed?.model || "", done: true }));
        return;
      }

      if (req.url === "/freeai/v1/chat/completions") {
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        const reply = parsed?.messages?.some((m) => String(m.content || "").includes("<critica_agente_b>"))
          ? "Consolidación final Free.ai verificada."
          : "Respuesta Free.ai verificada.";
        if (reply === "Respuesta Free.ai verificada.") {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Respuesta Free.ai " } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "verificada." } }] })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
        }
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
    savedSerpEnvValues = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SERPAPI_")) {
        savedSerpEnvValues[k] = process.env[k];
      }
    }
    for (const k of hardwareAdvisor.SAFE_AI_ENV_KEYS) {
      delete process.env[k];
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
      autoStartDirectML: false,
      skipWindowsApply: true,
      allowHostProcessControl: false,
      telemetryOverride: {
        cpu: { name: "AMD Ryzen AI 7 350 w/ Radeon 860M", cores: 8, logicalThreads: 16, maxClockMHz: 2000 },
        gpu: { name: "AMD Radeon(TM) 860M Graphics", driverVersion: "32.0.32015.12012", dedicatedVramGb: 2.0, isRadeon860M: true },
        npu: { present: true, name: "NPU Compute Accelerator Device", status: "OK" },
        ram: { totalGb: 29.66, freeGb: 7.2 },
        env: {
          user: {
            OLLAMA_IGPU_ENABLE: "",
            HSA_OVERRIDE_GFX_VERSION: "",
            OLLAMA_FLASH_ATTENTION: "",
            OLLAMA_KV_CACHE_TYPE: "",
            OLIVE_GPU_MEMORY_LIMIT: "20",
            OLIVE_CPU_THREADS: "12"
          }
        }
      }
    });
    const studioPort = await listenServer(studioServer);
    studioBaseUrl = `http://127.0.0.1:${studioPort}`;
  });

  afterEach(async () => {
    await ttsBridge.shutdownTtsWorker();
    await closeServer(studioServer);
    await closeServer(mockEngineServer);
    studioServer = null;
    mockEngineServer = null;

    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SERPAPI_")) delete process.env[k];
    }
    for (const k of ENV_BACKUP_KEYS) {
      if (savedEnvValues[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = savedEnvValues[k];
      }
    }
    for (const [k, v] of Object.entries(savedSerpEnvValues)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (typeof envLoader.getSerpApiKeyPools === "function") {
      envLoader.getSerpApiKeyPools();
    }

    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  after(async () => {
    await ttsBridge.shutdownTtsWorker();
  });

  it("responde /api/version 2.1.0 sin caché, CORS OPTIONS y /api/projects con projectState", async () => {
    const optRes = await httpReq("/api/version", { method: "OPTIONS" });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get("access-control-allow-origin"), "*");
    assert.match(optRes.headers.get("access-control-allow-methods") || "", /DELETE/);

    const verRes = await httpReq("/api/version");
    assert.equal(verRes.status, 200);
    assert.equal(verRes.json.v, "2.1.0");
    assert.equal(typeof verRes.json.build, "number");
    assert.match(verRes.headers.get("cache-control") || "", /no-store/);

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
    assert.match(uiRes.headers.get("cache-control") || "", /no-store/);

    // Assets de marca sin fondo + validación 404 segura
    for (const iconFile of ["github-icon.png", "netlify-icon.png", "ollama-icon.png", "freeai-icon.png"]) {
      const iconRes = await fetch(`${studioBaseUrl}/assets/${iconFile}`);
      assert.equal(iconRes.status, 200, `Asset ${iconFile} debe responder 200`);
      assert.equal(iconRes.headers.get("content-type"), "image/png");
      const buf = Buffer.from(await iconRes.arrayBuffer());
      assert.ok(buf.length > 500, `Asset ${iconFile} no debe estar vacío`);
      assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${iconFile} debe ser PNG válido`);

      const headIcon = await fetch(`${studioBaseUrl}/assets/${iconFile}`, { method: "HEAD" });
      assert.equal(headIcon.status, 200);
    }
    const missingAsset = await fetch(`${studioBaseUrl}/assets/no-existe.png`);
    assert.equal(missingAsset.status, 404);
    const traversalAsset = await fetch(`${studioBaseUrl}/assets/..%2Fserver.js`);
    assert.equal(traversalAsset.status, 404);

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

  it("sirve /favicon.ico y /assets/local-ai-studio-icon.png y expone /api/system/* + /api/ollama/unload + /api/directml/stop", async () => {
    const icoRes = await fetch(`${studioBaseUrl}/favicon.ico`);
    assert.equal(icoRes.status, 200);
    assert.equal(icoRes.headers.get("content-type"), "image/x-icon");
    const icoBuf = Buffer.from(await icoRes.arrayBuffer());
    assert.ok(icoBuf.length > 1000);
    assert.deepEqual([...icoBuf.subarray(0, 4)], [0x00, 0x00, 0x01, 0x00], "Debe ser cabecera ICO válida");

    const headIco = await fetch(`${studioBaseUrl}/favicon.ico`, { method: "HEAD" });
    assert.equal(headIco.status, 200);

    const pngRes = await fetch(`${studioBaseUrl}/assets/local-ai-studio-icon.png`);
    assert.equal(pngRes.status, 200);
    assert.equal(pngRes.headers.get("content-type"), "image/png");
    const pngBuf = Buffer.from(await pngRes.arrayBuffer());
    assert.deepEqual([...pngBuf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const hwProf = await httpReq("/api/system/hardware-profile");
    assert.equal(hwProf.status, 200);
    assert.equal(hwProf.json.ok, true);
    assert.ok(hwProf.json.telemetry.cpu.name.includes("860M"));
    assert.ok(hwProf.json.profiles["freeai+directml"]);
    assert.ok(hwProf.json.profiles["freeai+ollama"]);
    assert.ok(hwProf.json.profiles["ollama+directml"]);

    const evalHeavy = await httpReq("/api/system/hardware-evaluate", {
      method: "POST",
      body: {
        pair: "ollama+directml",
        workflow: "parallel",
        unloadBetweenTurns: true,
        agentA: { source: "ollama", model: "claude:latest", numCtx: 8192 },
        agentB: { source: "directml", model: "Hermes-3-8B-UNLOCKED-ONNX-DirectML" }
      }
    });
    assert.equal(evalHeavy.status, 200);
    assert.equal(evalHeavy.json.evaluation.riskLevel, "critical");
    assert.equal(evalHeavy.json.evaluation.allowParallelLocal, false);

    // Zero-Trust: debe rechazar mutación de secretos o variables fuera de lista blanca con HTTP 400
    const badTune = await httpReq("/api/system/apply-tuning", {
      method: "POST",
      body: { scope: "session", envOverrides: { GITHUB_TOKEN: "ghp_evil" } }
    });
    assert.equal(badTune.status, 400);

    const goodTune = await httpReq("/api/system/apply-tuning", {
      method: "POST",
      body: { scope: "session", pair: "ollama+directml", unloadOllama: true }
    });
    assert.equal(goodTune.status, 200);
    assert.equal(goodTune.json.ok, true);
    assert.equal(goodTune.json.applied.OLIVE_GPU_MEMORY_LIMIT, "12");
    assert.equal(goodTune.json.applied.OLLAMA_IGPU_ENABLE, "1");
    assert.equal(goodTune.json.telemetry.env.effective.OLLAMA_IGPU_ENABLE, "1");
    assert.ok(capturedMockRequests.some((r) => r.url === "/api/generate" && r.body && r.body.keep_alive === 0));

    capturedMockRequests = [];
    const unloadRes = await httpReq("/api/ollama/unload", { method: "POST", body: {} });
    assert.equal(unloadRes.status, 200);
    assert.equal(unloadRes.json.ok, true);
    assert.ok(capturedMockRequests.some((r) => r.url === "/api/generate" && r.body && r.body.keep_alive === 0));

    const stopDmlRes = await httpReq("/api/directml/stop", { method: "POST", body: {} });
    assert.equal(stopDmlRes.status, 200);
    assert.equal(typeof stopDmlRes.json.ok, "boolean");
  });

  it("POST /api/chat/dual valida HTTP 400 estricto y ejecuta Pipeline, Paralelo, Debate, Guard VRAM y Contingencia sin fallos", async () => {
    process.env.FREEAI_BASE_URL = `http://127.0.0.1:${mockEnginePort}/freeai/v1`;
    process.env.FREEAI_API_KEY_1 = "freeai_dual_mock_key";

    // 1. Validaciones HTTP 400
    const badMsgs = await httpReq("/api/chat/dual", { method: "POST", body: { pair: "freeai+directml", messages: [] } });
    assert.equal(badMsgs.status, 400);

    const badPair = await httpReq("/api/chat/dual", {
      method: "POST",
      body: { pair: "foo+bar", messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(badPair.status, 400);

    const badEngine = await httpReq("/api/chat/dual", {
      method: "POST",
      body: { agentA: { source: "openai" }, agentB: { source: "ollama" }, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(badEngine.status, 400);

    const sameEngine = await httpReq("/api/chat/dual", {
      method: "POST",
      body: { agentA: { source: "freeai" }, agentB: { source: "freeai" }, messages: [{ role: "user", content: "hi" }] }
    });
    assert.equal(sameEngine.status, 400);

    const mismatch = await httpReq("/api/chat/dual", {
      method: "POST",
      body: {
        pair: "freeai+ollama",
        agentA: { source: "freeai", model: "qwen-2.5-coder" },
        agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
        messages: [{ role: "user", content: "hi" }]
      }
    });
    assert.equal(mismatch.status, 400);

    // 2. Pipeline con prompts independientes por agente + aplanamiento assistant_dual
    capturedMockRequests = [];
    const pipeRes = await httpReq("/api/chat/dual", {
      method: "POST",
      body: {
        project: "AlphaApp",
        pair: "freeai+ollama",
        workflow: "pipeline",
        agentA: {
          source: "freeai",
          model: "qwen-2.5-coder",
          roleLabel: "Planificador",
          profileId: "SteveJobs",
          skillId: "backend-architect",
          customSystemPrompt: "SOLO_AGENTE_A_XYZ"
        },
        agentB: {
          source: "ollama",
          model: "qwen2.5-coder:latest",
          roleLabel: "Auditor",
          profileId: "Pirata",
          skillId: "code-reviewer",
          customSystemPrompt: "SOLO_AGENTE_B_XYZ"
        },
        messages: [
          { role: "user", content: "Turno 1" },
          {
            role: "assistant_dual",
            dual: {
              agentA: { model: "qwen-2.5-coder", text: "A previo" },
              agentB: { model: "qwen2.5-coder:latest", text: "B previo" }
            }
          },
          { role: "user", content: "Audita el modulo" }
        ]
      }
    });
    assert.equal(pipeRes.status, 200);
    const pipeEvents = pipeRes.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(pipeEvents[0].type, "dual_preflight");
    assert.ok(pipeEvents.some((e) => e.type === "agent_done" && e.agent === "A" && e.text.includes("Respuesta Free.ai")));
    assert.ok(pipeEvents.some((e) => e.type === "agent_done" && e.agent === "B" && e.text.includes("Respuesta Ollama")));
    assert.equal(pipeEvents[pipeEvents.length - 1].type, "dual_done");
    assert.equal(pipeEvents[pipeEvents.length - 1].partialFailure, false);

    const freePipeReq = capturedMockRequests.find((r) => r.url === "/freeai/v1/chat/completions");
    const ollamaPipeReq = capturedMockRequests.find((r) => r.url === "/api/chat");
    assert.ok(freePipeReq.body.messages[0].content.includes("SOLO_AGENTE_A_XYZ"));
    assert.equal(freePipeReq.body.messages[0].content.includes("SOLO_AGENTE_B_XYZ"), false);
    assert.ok(freePipeReq.body.messages[0].content.includes("BACKEND-ARCHITECT"));
    assert.ok(
      freePipeReq.body.messages.some(
        (m) => m.role === "assistant" && m.content.includes("[Agente A (") && m.content.includes("A previo") && m.content.includes("B previo")
      )
    );
    assert.ok(ollamaPipeReq.body.messages[0].content.includes("SOLO_AGENTE_B_XYZ"));
    assert.equal(ollamaPipeReq.body.messages[0].content.includes("SOLO_AGENTE_A_XYZ"), false);
    assert.ok(ollamaPipeReq.body.messages[0].content.includes("CODE-REVIEWER"));
    assert.ok(ollamaPipeReq.body.messages.some((m) => String(m.content || "").includes("<salida_agente_a>")));

    // 3. Debate (3 etapas: A1 -> B2 -> A3)
    capturedMockRequests = [];
    const debateRes = await httpReq("/api/chat/dual", {
      method: "POST",
      body: {
        project: "AlphaApp",
        pair: "freeai+directml",
        workflow: "debate",
        agentA: { source: "freeai", model: "qwen-2.5-coder" },
        agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
        messages: [{ role: "user", content: "Debate arquitectura" }]
      }
    });
    assert.equal(debateRes.status, 200);
    const debateEvents = debateRes.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(debateEvents.some((e) => e.type === "agent_done" && e.agent === "A" && e.stage === 1));
    assert.ok(debateEvents.some((e) => e.type === "agent_done" && e.agent === "B" && e.stage === 2));
    assert.ok(debateEvents.some((e) => e.type === "agent_done" && e.agent === "A" && e.stage === 3 && e.text.includes("Consolidación final")));

    // 4. Ollama + DirectML con parallel -> Auto-degradación a pipeline + descarga keep_alive=0
    capturedMockRequests = [];
    const guardRes = await httpReq("/api/chat/dual", {
      method: "POST",
      body: {
        project: "AlphaApp",
        pair: "ollama+directml",
        workflow: "parallel",
        unloadBetweenTurns: true,
        agentA: { source: "ollama", model: "qwen2.5-coder:latest" },
        agentB: { source: "directml", model: "Phi-3.5-mini-instruct-ONNX" },
        messages: [{ role: "user", content: "Refactoriza seguro" }]
      }
    });
    assert.equal(guardRes.status, 200);
    const guardEvents = guardRes.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(guardEvents[0].downgradedFromParallel, true);
    assert.equal(guardEvents[0].workflow, "pipeline");
    assert.ok(guardEvents.some((e) => e.type === "system_notice" && e.code === "AUTO_SEQUENTIAL_VRAM_GUARD"));
    assert.ok(capturedMockRequests.some((r) => r.url === "/api/chat" && r.body && r.body.keep_alive === 0));
    assert.ok(capturedMockRequests.some((r) => r.url === "/api/generate" && r.body && r.body.keep_alive === 0));

    // 5. Contingencia ante fallo de un motor (Agent A force-fail): emite agent_error, B sigue en Pipeline, Debate omite Stage 3
    capturedMockRequests = [];
    const failPipeRes = await httpReq("/api/chat/dual", {
      method: "POST",
      body: {
        project: "AlphaApp",
        pair: "freeai+ollama",
        workflow: "pipeline",
        agentA: { source: "freeai", model: "force-fail-model" },
        agentB: { source: "ollama", model: "qwen2.5-coder:latest" },
        messages: [{ role: "user", content: "Continua sin A" }]
      }
    });
    assert.equal(failPipeRes.status, 200);
    const failEvents = failPipeRes.text.trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(failEvents.some((e) => e.type === "agent_error" && e.agent === "A"));
    assert.ok(failEvents.some((e) => e.type === "agent_done" && e.agent === "B" && e.text.includes("Respuesta Ollama")));
    assert.equal(failEvents[failEvents.length - 1].partialFailure, true);
  });

  it("GET /api/tts/status y POST /api/tts/speak validan HTTP 400 y devuelven WAV PCM con cabeceras TTS", async () => {
    ttsBridge.clearTtsStatusCache();
    const stRes = await httpReq("/api/tts/status?refresh=1");
    assert.equal(stRes.status, 200);
    assert.equal(stRes.json.ok, true);
    assert.equal(stRes.json.kokoroReady, true);
    assert.equal(stRes.json.piperReady, true);
    assert.ok(Array.isArray(stRes.json.voices));
    assert.equal(stRes.json.voices.length, 13);
    assert.ok(stRes.json.voices.some((v) => v.id === "es_blend_editorial"));
    assert.ok(stRes.json.voices.some((v) => v.id === "vits-piper-es_ES-sharvard-f"));

    const emptyRes = await httpReq("/api/tts/speak", {
      method: "POST",
      body: { text: "   ", voice: "vits-piper-es_ES-sharvard-f" }
    });
    assert.equal(emptyRes.status, 400);
    assert.equal(emptyRes.json.ok, false);

    const badVoiceRes = await httpReq("/api/tts/speak", {
      method: "POST",
      body: { text: "Hola prueba", voice: "../evil/voice" }
    });
    assert.equal(badVoiceRes.status, 400);
    assert.equal(badVoiceRes.json.ok, false);

    const speakRes = await fetch(`${studioBaseUrl}/api/tts/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Hola, prueba de voz neuronal local.",
        voice: "vits-piper-es_ES-sharvard-f",
        speed: 1.0
      })
    });
    assert.equal(speakRes.status, 200);
    assert.equal(speakRes.headers.get("content-type"), "audio/wav");
    assert.equal(speakRes.headers.get("x-tts-engine"), "piper");
    assert.equal(speakRes.headers.get("x-tts-voice"), "vits-piper-es_ES-sharvard-f");
    assert.equal(speakRes.headers.get("x-tts-sample-rate"), "22050");

    const wavBuf = Buffer.from(await speakRes.arrayBuffer());
    assert.ok(wavBuf.length > 44, `WAV vacío o demasiado corto: ${wavBuf.length}`);
    assert.equal(wavBuf.toString("ascii", 0, 4), "RIFF");
    assert.equal(wavBuf.toString("ascii", 8, 12), "WAVE");
  });

  it("POST /api/directml/restart valida Zero-Trust y /api/system/apply-tuning reporta objeto restarts", async () => {
    const evilRestart = await httpReq("/api/directml/restart", {
      method: "POST",
      body: { envOverrides: { GITHUB_TOKEN: "ghp_forbidden_secret_value" } }
    });
    assert.equal(evilRestart.status, 400);
    assert.equal(evilRestart.json.ok, false);

    const safeRestart = await httpReq("/api/directml/restart", {
      method: "POST",
      body: { envOverrides: { OLIVE_GPU_MEMORY_LIMIT: "16", OLIVE_CPU_THREADS: "10" } }
    });
    assert.equal(safeRestart.status, 200);
    assert.equal(safeRestart.json.ok, true);
    assert.equal(safeRestart.json.skippedHostControl, true);

    capturedMockRequests = [];
    const tuneRes = await httpReq("/api/system/apply-tuning", {
      method: "POST",
      body: {
        scope: "session",
        pair: "ollama+directml",
        unloadOllama: true,
        restartDirectML: true,
        restartOllama: true
      }
    });
    assert.equal(tuneRes.status, 200);
    assert.equal(tuneRes.json.ok, true);
    assert.ok(tuneRes.json.restarts && typeof tuneRes.json.restarts === "object");
    assert.ok(Array.isArray(tuneRes.json.restarts.unloadedOllama) && tuneRes.json.restarts.unloadedOllama.length >= 1);
    assert.equal(tuneRes.json.restarts.directml.ok, true);
    assert.equal(tuneRes.json.restarts.directml.skippedHostControl, true);
    assert.equal(tuneRes.json.restarts.ollama.ok, true);
    assert.equal(tuneRes.json.restarts.ollama.skippedHostControl, true);
    assert.ok(capturedMockRequests.some((r) => r.url === "/api/generate" && r.body && r.body.keep_alive === 0));
  });

  it("GET /api/integrations/serpapi/usage, POST /api/integrations/serpapi/reset y POST /api/search/web sin consumir cuota real", async () => {
    // 1. Query faltante -> HTTP 400
    const missingQuery = await httpReq("/api/search/web", {
      method: "POST",
      body: { query: "   ", mode: "web" }
    });
    assert.equal(missingQuery.status, 400);
    assert.equal(missingQuery.json.ok, false);

    // 2. Sin llaves con LOCAL_AI_DISABLE_EXTERNAL_ENV=1 -> HTTP 400
    await withIsolatedSerpEnv({}, async () => {
      const noKeysRes = await httpReq("/api/search/web", {
        method: "POST",
        body: { query: "directml amd", mode: "web" }
      });
      assert.equal(noKeysRes.status, 400);
      assert.equal(noKeysRes.json.ok, false);
      assert.equal(noKeysRes.json.configured, false);

      const emptyUsage = await httpReq("/api/integrations/serpapi/usage");
      assert.equal(emptyUsage.status, 200);
      assert.equal(emptyUsage.json.configured, false);
      assertNoSecretsInPayload(emptyUsage.json);
    });

    // 3. Con llaves falsas y fetch stubbeado SOLO para serpapi.com -> HTTP 200 + conteo + reset
    const fakeWebKey = "serp_srv_mock_web_key_12345678";
    const fakeJobsKey = "serp_srv_mock_jobs_key_87654321";

    await withIsolatedSerpEnv(
      { SERPAPI_NEWS_KEY: fakeWebKey, SERPAPI_JOBS_KEY: fakeJobsKey },
      async () => {
        await httpReq("/api/integrations/serpapi/reset", { method: "POST", body: { pool: "all" } });

        await withMockedSerpFetch(
          async (rawUrl) => {
            const u = new URL(rawUrl);
            assert.equal(u.searchParams.get("q"), "ONNX DirectML AMD 860M");
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({
                organic_results: [
                  {
                    title: "DirectML Execution Provider",
                    link: "https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider.html",
                    snippet: "Ejecución acelerada en GPU AMD mediante DirectML.",
                    source: "ONNX Runtime"
                  }
                ]
              })
            };
          },
          async () => {
            const searchRes = await httpReq("/api/search/web", {
              method: "POST",
              body: { query: "ONNX DirectML AMD 860M", mode: "web" }
            });
            assert.equal(searchRes.status, 200);
            assert.equal(searchRes.json.ok, true);
            assert.equal(searchRes.json.poolUsed, "web");
            assert.equal(searchRes.json.totalResults, 1);
            assert.equal(searchRes.json.results[0].title, "DirectML Execution Provider");
            assertNoSecretsInPayload(searchRes.json, [fakeWebKey, fakeJobsKey]);

            const usageRes = await httpReq("/api/integrations/serpapi/usage");
            assert.equal(usageRes.status, 200);
            assert.equal(usageRes.json.configured, true);
            assert.equal(usageRes.json.usage.webUses, 1);
            assert.equal(usageRes.json.usage.jobsUses, 0);
            assertNoSecretsInPayload(usageRes.json, [fakeWebKey, fakeJobsKey]);

            const resetRes = await httpReq("/api/integrations/serpapi/reset", {
              method: "POST",
              body: { pool: "web" }
            });
            assert.equal(resetRes.status, 200);
            assert.equal(resetRes.json.ok, true);
            assert.equal(resetRes.json.usage.webUses, 0);
            assertNoSecretsInPayload(resetRes.json, [fakeWebKey, fakeJobsKey]);
          }
        );
      }
    );
  });

  it("POST /api/chat y POST /api/chat/dual con webSearchEnabled: true inyectan contexto web y emiten cabecera X-Web-Search-Meta / evento web_search", async () => {
    const fakeWebKey = "serp_chat_mock_web_key_99999999";
    process.env.FREEAI_BASE_URL = `http://127.0.0.1:${mockEnginePort}/freeai/v1`;
    process.env.FREEAI_API_KEY_1 = "freeai_web_chat_mock_key";

    await withIsolatedSerpEnv(
      { SERPAPI_NEWS_KEY: fakeWebKey },
      async () => {
        await httpReq("/api/integrations/serpapi/reset", { method: "POST", body: { pool: "all" } });

        await withMockedSerpFetch(
          async (rawUrl) => {
            const u = new URL(rawUrl);
            const isNews = u.searchParams.get("engine") === "google_news";
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(
                isNews
                  ? {
                      news_results: [
                        {
                          title: "Lanzamiento ROCm Windows Ryzen",
                          link: "https://news.example.com/rocm-win",
                          snippet: "Soporte mejorado para iGPU Radeon 860M en Español.",
                          source: { name: "TechEs" },
                          date: "2026-11-09"
                        }
                      ]
                    }
                  : {
                      organic_results: [
                        {
                          title: "Guía Kokoro TTS INT8 Español",
                          link: "https://docs.example.com/kokoro-es",
                          snippet: "Voces ef_dora y es_blend_editorial locales.",
                          source: "DocsES"
                        }
                      ]
                    }
              )
            };
          },
          async () => {
            // 1. Single /api/chat con webSearchEnabled: true -> X-Web-Search-Meta Base64 UTF-8 + inyección en prompt
            capturedMockRequests = [];
            const singleRes = await httpReq("/api/chat", {
              method: "POST",
              body: {
                project: "AlphaApp",
                model: "qwen2.5-coder:latest",
                source: "local",
                webSearchEnabled: true,
                webSearchMode: "web",
                stream: true,
                messages: [{ role: "user", content: "Explica Kokoro TTS en español" }]
              }
            });
            assert.equal(singleRes.status, 200);
            const rawHeader = singleRes.headers.get("x-web-search-meta");
            assert.ok(rawHeader, "Debe incluir cabecera X-Web-Search-Meta");
            const decodedMeta = JSON.parse(Buffer.from(rawHeader, "base64").toString("utf8"));
            assert.equal(decodedMeta.ok, true);
            assert.equal(decodedMeta.poolUsed, "web");
            assert.equal(decodedMeta.results[0].title, "Guía Kokoro TTS INT8 Español");
            assertNoSecretsInPayload(decodedMeta, [fakeWebKey]);

            const ollamaReq = capturedMockRequests.find((r) => r.url === "/api/chat");
            assert.ok(ollamaReq, "Ollama mock debió recibir la petición");
            assert.ok(ollamaReq.body.messages[0].content.includes("<busqueda_web_en_tiempo_real"));
            assert.ok(ollamaReq.body.messages[0].content.includes("Guía Kokoro TTS INT8 Español"));
            assert.equal(ollamaReq.body.messages[0].content.includes(fakeWebKey), false);

            // 2. Dual /api/chat/dual con webSearchEnabled: true -> evento NDJSON web_search + inyección en A y B
            capturedMockRequests = [];
            const dualRes = await httpReq("/api/chat/dual", {
              method: "POST",
              body: {
                project: "AlphaApp",
                pair: "freeai+ollama",
                workflow: "pipeline",
                webSearchEnabled: true,
                webSearchMode: "news",
                agentA: { source: "freeai", model: "qwen-2.5-coder" },
                agentB: { source: "ollama", model: "qwen2.5-coder:latest" },
                messages: [{ role: "user", content: "Resume novedades ROCm Windows" }]
              }
            });
            assert.equal(dualRes.status, 200);
            assertNoSecretsInPayload(dualRes.text, [fakeWebKey]);
            const dualEvents = dualRes.text.trim().split("\n").map((l) => JSON.parse(l));
            const webEvent = dualEvents.find((e) => e.type === "web_search");
            assert.ok(webEvent, "Dual stream debe emitir evento NDJSON web_search");
            assert.equal(webEvent.ok, true);
            assert.equal(webEvent.mode, "news");
            assert.equal(webEvent.poolUsed, "web");
            assert.equal(webEvent.totalResults, 1);
            assert.equal(webEvent.results[0].title, "Lanzamiento ROCm Windows Ryzen");

            const freeReq = capturedMockRequests.find((r) => r.url === "/freeai/v1/chat/completions");
            const dualOllamaReq = capturedMockRequests.find((r) => r.url === "/api/chat");
            assert.ok(freeReq.body.messages[0].content.includes("<busqueda_web_en_tiempo_real"));
            assert.ok(dualOllamaReq.body.messages[0].content.includes("<busqueda_web_en_tiempo_real"));
            assert.equal(freeReq.body.messages[0].content.includes(fakeWebKey), false);
            assert.equal(dualOllamaReq.body.messages[0].content.includes(fakeWebKey), false);
          }
        );
      }
    );
  });
});
