const { describe, it, beforeEach, afterEach, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { chromium } = require("C:/Users/Benner/node_modules/playwright");
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
let browser = null;

const ENV_BACKUP_KEYS = [
  "LOCAL_AI_PROJECTS_DIR",
  "LOCAL_AI_MEMORY_DIR",
  "LOCAL_AI_CONFIG_FILE",
  "LOCAL_AI_BRAIN_DIR",
  "LOCAL_AI_DISABLE_EXTERNAL_ENV",
  "LOCAL_AI_EXTERNAL_ENV_PATH",
  "FREEAI_BASE_URL",
  "FREEAI_API_KEY_1",
  "FREE_AI_API_KEY",
  ...hardwareAdvisor.SAFE_AI_ENV_KEYS
];
let savedEnvValues = {};
let savedSerpEnvValues = {};
const activeSlowTimers = new Set();

function buildSilentWavBuffer(durationSec = 2, sampleRate = 24000) {
  const numSamples = Math.max(1, Math.round(durationSec * sampleRate));
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
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, 4, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function listenServer(srv) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });
}

function closeServer(srv) {
  return new Promise((resolve) => {
    if (!srv || !srv.listening) return resolve();
    srv.close(() => resolve());
  });
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
          {
            name: "qwen2.5-coder:latest",
            size: 4200000000,
            details: { family: "qwen2", parameter_size: "7B" }
          },
          {
            name: "claude:latest",
            size: 8600000000,
            details: { family: "llama", parameter_size: "8B" }
          }
        ]
      }));
      return;
    }

    if (req.url === "/api/ps" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }

    if (req.url === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          {
            id: "Phi-3.5-mini-instruct-ONNX",
            displayName: "Phi-3.5-mini-instruct (DirectML E2E)",
            size: "2.3 GB",
            active: true,
            status: "ready"
          }
        ]
      }));
      return;
    }

    if (req.url === "/freeai/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          {
            id: "qwen-2.5-coder",
            name: "Qwen 2.5 Coder (Free.ai Mock)",
            license: "Apache-2.0",
            type: "chat"
          },
          {
            id: "flux-schnell",
            name: "Flux Schnell Image",
            license: "Apache-2.0",
            type: "image"
          },
          {
            id: "whisper-large-v3",
            name: "Whisper Large v3",
            license: "MIT",
            type: "audio"
          },
          {
            id: "bge-m3-embed",
            name: "BGE-M3 Embedding",
            license: "MIT",
            type: "embedding"
          },
          {
            id: "kokoro-tts",
            name: "Kokoro TTS Audio",
            license: "Apache-2.0",
            type: "tts"
          }
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

      if (req.url === "/api/generate" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: parsed?.model || "", done: true }));
        return;
      }

      if (req.url === "/api/chat" && req.method === "POST") {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const sysContent = messages.find((m) => m.role === "system")?.content || "";
        const lastUser = messages.filter((m) => m.role === "user").pop()?.content || "";
        const fullPromptText = messages.map((m) => String(m.content || "")).join("\n");

        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });

        if (lastUser.includes("SLOW_STREAM_TEST")) {
          res.write(JSON.stringify({
            model: parsed?.model || "qwen2.5-coder:latest",
            message: { role: "assistant", content: "Fragmento parcial antes de detener. " },
            done: false
          }) + "\n");
          const slowTimer = setTimeout(() => {
            activeSlowTimers.delete(slowTimer);
            if (!res.writableEnded) {
              res.write(JSON.stringify({
                model: parsed?.model || "qwen2.5-coder:latest",
                message: { role: "assistant", content: " texto tardio que debe abortarse." },
                done: false
              }) + "\n");
              res.write(JSON.stringify({
                model: parsed?.model || "qwen2.5-coder:latest",
                message: { role: "assistant", content: "" },
                done: true
              }) + "\n");
              res.end();
            }
          }, 2500);
          activeSlowTimers.add(slowTimer);
          req.on("close", () => {
            clearTimeout(slowTimer);
            activeSlowTimers.delete(slowTimer);
          });
          return;
        }

        if (fullPromptText.includes("DUAL_WRITE_TEST")) {
          const isStage2 = lastUser.includes("<salida_agente_a>");
          const dualOllamaMd = isStage2
            ? [
                "Auditoría y refinamiento completados por Agente B (Ollama):",
                "",
                "```write:src/dual_shared.js",
                "export const owner = 'agent-b-winner';",
                "```",
                "",
                "```write:src/dual_only_b.js",
                "export const fromB = true;",
                "```"
              ].join("\n")
            : [
                "Propuesta inicial de Ollama (Agente):",
                "",
                "```write:src/dual_shared.js",
                "export const owner = 'ollama-draft';",
                "```"
              ].join("\n");

          res.write(JSON.stringify({
            model: parsed?.model || "qwen2.5-coder:latest",
            message: { role: "assistant", content: dualOllamaMd },
            done: false
          }) + "\n");
          res.write(JSON.stringify({
            model: parsed?.model || "qwen2.5-coder:latest",
            message: { role: "assistant", content: "" },
            done: true
          }) + "\n");
          res.end();
          return;
        }

        if (
          sysContent.includes("Forensic Continuity Auditor") ||
          sysContent.includes("Enter Context") ||
          lastUser.includes("<telemetria_verificada>") ||
          lastUser.includes("Plan de Acción Recomendado")
        ) {
          const chunksOut = [
            "<thinking>\nVerificando rama Git, package.json y src/index.js en AlphaApp.\n</thinking>\n",
            "## 1. Estado Actual Verificado\n- Proyecto AlphaApp activo con `package.json` y `src/index.js`.\n\n",
            "## 2. Procesos Inconclusos y Riesgos\n- Pendiente validar payload en `src/index.js`.\n\n",
            "## 3. Lista de Tareas Pendientes\n- [ ] Implementar validación en `src/index.js`.\n- [ ] Añadir pruebas de regresión.\n\n",
            "## 4. Plan de Acción Recomendado\n1. Ejecutar suite `node --test` antes del próximo commit.\n"
          ];
          for (const part of chunksOut) {
            res.write(JSON.stringify({ model: parsed?.model || "qwen2.5-coder:latest", message: { role: "assistant", content: part }, done: false }) + "\n");
          }
          res.write(JSON.stringify({ model: parsed?.model || "qwen2.5-coder:latest", message: { role: "assistant", content: "" }, done: true }) + "\n");
          res.end();
          return;
        }

        const aiMarkdown = [
          "Cambios aplicados con seguridad (XSS sanitizado: <script>window.__xssFired = true;</script>):",
          "",
          "```write:src/e2e_created.js",
          "export function saludarE2E() {",
          "  return 'ok-e2e';",
          "}",
          "```",
          "",
          "```patch:src/index.js",
          "<<< SEARCH",
          "// TODO: validar payload",
          "console.log('AlphaApp');",
          "===",
          "// Payload validado en E2E",
          "console.log('AlphaAppReady');",
          ">>> REPLACE",
          "```"
        ].join("\n");

        res.write(JSON.stringify({
          model: parsed?.model || "qwen2.5-coder:latest",
          message: { role: "assistant", content: aiMarkdown },
          done: false
        }) + "\n");
        res.write(JSON.stringify({
          model: parsed?.model || "qwen2.5-coder:latest",
          message: { role: "assistant", content: "" },
          done: true
        }) + "\n");
        res.end();
        return;
      }

      if (req.url === "/v1/chat/completions" || req.url === "/freeai/v1/chat/completions") {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const fullText = messages.map((m) => String(m.content || "")).join("\n");
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        if (fullText.includes("DUAL_WRITE_TEST")) {
          const isFree = req.url === "/freeai/v1/chat/completions";
          const outMd = isFree
            ? [
                "Propuesta inicial de Free.ai (Agente A):",
                "",
                "```write:src/dual_shared.js",
                "export const owner = 'agent-a-draft';",
                "```",
                "",
                "```write:src/dual_only_a.js",
                "export const fromA = true;",
                "```"
              ].join("\n")
            : [
                "Revisión DirectML:",
                "",
                "```write:src/dual_dml.js",
                "export const dml = true;",
                "```"
              ].join("\n");
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: outMd } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK stream." } }] })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not mocked" }));
    });
  });
}

describe("Local AI Studio UI E2E (Playwright Chromium)", () => {
  beforeEach(async () => {
    savedEnvValues = {};
    for (const k of ENV_BACKUP_KEYS) savedEnvValues[k] = process.env[k];
    savedSerpEnvValues = {};
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SERPAPI_")) {
        savedSerpEnvValues[k] = process.env[k];
        delete process.env[k];
      }
    }
    for (const k of hardwareAdvisor.SAFE_AI_ENV_KEYS) delete process.env[k];
    process.env.LOCAL_AI_DISABLE_EXTERNAL_ENV = "1";
    delete process.env.LOCAL_AI_EXTERNAL_ENV_PATH;
    envLoader.getSerpApiKeyPools();

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-e2e-"));
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
    }, null, 2), "utf8");
    fs.writeFileSync(
      path.join(projAlphaDir, "src", "index.js"),
      "// TODO: validar payload\nconsole.log('AlphaApp');\n",
      "utf8"
    );

    process.env.LOCAL_AI_PROJECTS_DIR = tempProjectsDir;
    process.env.LOCAL_AI_MEMORY_DIR = tempMemoryDir;
    process.env.LOCAL_AI_CONFIG_FILE = tempConfigFile;
    process.env.LOCAL_AI_BRAIN_DIR = tempBrainDir;

    // Seed a persistent HF download so the 3rd History Drawer tab shows persisted records
    memoryStore.upsertDownload({
      jobId: "hf_e2e_seed_1",
      repoId: "onnx-community/Qwen2.5-0.5B-Instruct-ONNX",
      repoType: "model",
      targetDir: path.join(tempRoot, "models", "Qwen2.5-0.5B-Instruct-ONNX"),
      status: "completed",
      progress: 100,
      hasOnnx: true,
      filesCount: 6,
      message: "Seed E2E completado"
    });

    mockEngineServer = createMockAiEngineServer();
    mockEnginePort = await listenServer(mockEngineServer);
    process.env.FREEAI_BASE_URL = `http://127.0.0.1:${mockEnginePort}/freeai/v1`;
    process.env.FREEAI_API_KEY_1 = "mock_freeai_key_e2e";

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

    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    for (const t of activeSlowTimers) {
      clearTimeout(t);
    }
    activeSlowTimers.clear();

    if (browser) {
      await browser.close();
      browser = null;
    }
    await ttsBridge.shutdownTtsWorker();
    await closeServer(studioServer);
    await closeServer(mockEngineServer);
    studioServer = null;
    mockEngineServer = null;

    for (const k of Object.keys(process.env)) {
      if (k.startsWith("SERPAPI_")) delete process.env[k];
    }
    for (const k of ENV_BACKUP_KEYS) {
      if (savedEnvValues[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnvValues[k];
    }
    for (const [k, v] of Object.entries(savedSerpEnvValues)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    envLoader.getSerpApiKeyPools();

    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  after(async () => {
    await ttsBridge.shutdownTtsWorker();
  });

  it("valida layout, SEO, Autoguardado ON, toggles cloud/HF Zero-Silent-Download, Entrar en Contexto, Prompt Maestro, Preview sin escritura y Memoria Persistente", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    let dialogTriggered = false;
    let hfDownloadCalls = 0;

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("dialog", async (dialog) => {
      dialogTriggered = true;
      await dialog.dismiss();
    });

    // Seed legacy localStorage sessions to verify one-time automatic migration
    await page.addInitScript(() => {
      if (!localStorage.getItem("local_ai_legacy_migrated_v1")) {
        localStorage.setItem("local_ai_sessions_v1", JSON.stringify([
          {
            id: "legacy_sess_e2e",
            title: "Sesión Legacy Migrada",
            project: "AlphaApp",
            model: "qwen2.5-coder:latest",
            messages: [
              { role: "user", content: "Hola legacy" },
              { role: "assistant", content: "Respuesta legacy restaurada." }
            ]
          }
        ]));
      }
    });

    // Safe route mocks for external cloud APIs (never touch real GitHub/Netlify/HF in automated tests)
    await page.route("**/api/integrations/github/repos**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          configured: true,
          user: { login: "benner-e2e" },
          repos: [
            { full_name: "benner-e2e/alpha-app", private: true, default_branch: "main" }
          ],
          detectedRemote: { isGitRepo: false },
          activeRepoMatch: null
        })
      });
    });

    await page.route("**/api/integrations/netlify/sites**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          configured: true,
          user: { full_name: "Benner E2E" },
          sites: [
            { id: "site_e2e_1", name: "alpha-studio-e2e", ssl_url: "https://alpha-studio-e2e.netlify.app" }
          ],
          linkedSiteId: "",
          detectedPublishDir: ""
        })
      });
    });

    await page.route("**/api/integrations/hf/search**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          defaultModelsDir: "C:\\antigravityAS\\Modelos -ai-brains",
          items: [
            {
              id: "onnx-community/Qwen2.5-0.5B-Instruct-ONNX",
              type: "model",
              author: "onnx-community",
              downloads: 12450,
              likes: 95,
              tags: ["onnx", "directml"]
            }
          ]
        })
      });
    });

    await page.route("**/api/integrations/hf/download", async (route) => {
      hfDownloadCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, jobId: "should_not_be_called" })
      });
    });

    await page.goto(studioBaseUrl, { waitUntil: "networkidle" });

    // Wait for skills and models async init
    await page.waitForFunction(() => {
      const pSel = document.getElementById("profile-select");
      const sSel = document.getElementById("skill-select");
      const mSel = document.getElementById("model-select");
      return pSel && pSel.options.length > 5 && sSel && sSel.options.length > 100 && mSel && mSel.value !== "";
    });

    // 1. SEO, Semántica, Firma DISENO.md, Desborde y Toaster Top-Right
    const seoMetrics = await page.evaluate(() => {
      const h1s = document.querySelectorAll("h1");
      const footerSig = document.querySelector(".legal-signature")?.textContent?.trim();
      const autoBtn = document.getElementById("btn-auto-apply");
      const autoLabel = document.getElementById("auto-apply-label")?.textContent?.trim();
      const brandIcons = Array.from(document.querySelectorAll("img.brand-img-icon")).map((img) => ({
        src: img.getAttribute("src"),
        alt: img.getAttribute("alt") || "",
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight
      }));
      return {
        h1Count: h1s.length,
        h1Text: h1s[0]?.textContent?.trim(),
        hasVibeLockup: Boolean(document.querySelector("h1.vibe-logo-lockup")),
        hasVibePill: Boolean(document.querySelector(".vibe-pill-nav")),
        hasVibeDot: Boolean(document.querySelector(".vibe-status-dot")),
        hasVibeCursor: Boolean(document.querySelector(".vibe-cursor-blink")),
        freeaiLockup: (() => {
          const el = document.querySelector("#src-freeai-btn .freeai-logo-lockup");
          if (!el) return null;
          const green = el.querySelector(".freeai-text-green");
          const white = el.querySelector(".freeai-text-white");
          return {
            text: el.textContent.replace(/\s+/g, ""),
            bg: getComputedStyle(el).backgroundColor,
            greenColor: green ? getComputedStyle(green).color : "",
            whiteColor: white ? getComputedStyle(white).color : ""
          };
        })(),
        dualFreeaiCount: document.querySelectorAll("#dual-bar-strip .freeai-logo-lockup").length,
        faviconHref: document.querySelector('link[rel="icon"]')?.getAttribute("href") || "",
        hasMain: Boolean(document.querySelector("main#chat-container")),
        hasMetaDesc: Boolean(document.querySelector('meta[name="description"]')?.getAttribute("content")),
        footerSig,
        htmlBg: getComputedStyle(document.documentElement).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        brandIcons,
        autoActive: autoBtn?.classList.contains("active"),
        autoPressed: autoBtn?.getAttribute("aria-pressed"),
        autoLabel,
        profileCount: document.getElementById("profile-select").options.length,
        skillCount: document.getElementById("skill-select").options.length,
        overflowDesktop: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });

    assert.equal(seoMetrics.h1Count, 1);
    assert.equal(seoMetrics.h1Text, "Local AI Studio");
    assert.equal(seoMetrics.hasVibeLockup, true, "Logo header debe usar Vibe Pill lockup");
    assert.equal(seoMetrics.hasVibePill, true);
    assert.equal(seoMetrics.hasVibeDot, true);
    assert.equal(seoMetrics.hasVibeCursor, true);
    assert.match(seoMetrics.faviconHref, /local-ai-studio-icon\.png/);
    assert.equal(seoMetrics.hasMain, true);
    assert.equal(seoMetrics.hasMetaDesc, true);
    assert.equal(seoMetrics.footerSig, "HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®");
    assert.equal(seoMetrics.htmlBg, "rgb(0, 0, 0)", "El tema debe ser Negro AMOLED (#000000) en html");
    assert.equal(seoMetrics.bodyBg, "rgb(0, 0, 0)", "El tema debe ser Negro AMOLED (#000000) en body");
    assert.ok(seoMetrics.brandIcons.length >= 6, "Deben existir los iconos de marca PNG en botones y modales");
    for (const ic of seoMetrics.brandIcons) {
      assert.ok(ic.alt.length > 0, `Icono ${ic.src} debe tener alt`);
      assert.equal(ic.complete, true, `Icono ${ic.src} debe cargar completo`);
      assert.equal(ic.naturalWidth, 128, `Icono ${ic.src} debe tener naturalWidth=128`);
      assert.equal(ic.naturalHeight, 128, `Icono ${ic.src} debe tener naturalHeight=128`);
    }
    assert.ok(seoMetrics.brandIcons.some((i) => i.src.includes("ollama-icon.png")));
    assert.ok(seoMetrics.brandIcons.some((i) => i.src.includes("github-icon.png")));
    assert.ok(seoMetrics.brandIcons.some((i) => i.src.includes("netlify-icon.png")));
    assert.ok(seoMetrics.freeaiLockup, "#src-freeai-btn debe usar .freeai-logo-lockup");
    assert.equal(seoMetrics.freeaiLockup.text, "Free.ai");
    assert.equal(seoMetrics.freeaiLockup.bg, "rgba(0, 0, 0, 0)", "Logo Free.ai debe tener fondo transparente");
    assert.equal(seoMetrics.freeaiLockup.greenColor, "rgb(30, 128, 60)");
    assert.equal(seoMetrics.freeaiLockup.whiteColor, "rgb(239, 239, 239)");
    assert.equal(seoMetrics.dualFreeaiCount, 2, "Botones Dual Free.ai deben usar .freeai-logo-lockup");
    await page.screenshot({ path: path.join(process.env.LOCAL_AI_E2E_SCREENSHOT_DIR || tempRoot, "desktop_single.png") });
    assert.equal(seoMetrics.autoActive, true, "Autoguardado debe iniciar activo (ON)");
    assert.equal(seoMetrics.autoPressed, "true");
    assert.equal(seoMetrics.autoLabel, "Autoguardado: ON");
    assert.ok(seoMetrics.profileCount > 50, `Perfiles insuficientes: ${seoMetrics.profileCount}`);
    assert.ok(seoMetrics.skillCount > 500, `Skills insuficientes: ${seoMetrics.skillCount}`);
    assert.ok(seoMetrics.overflowDesktop <= 1, `Desborde horizontal en desktop: ${seoMetrics.overflowDesktop}`);

    // Toast position check (must be top-right and non-overlapping with footer)
    const toastLayout = await page.evaluate(() => {
      showToast("Verificación de toast top-right", "info");
      const toastRect = document.getElementById("toast").getBoundingClientRect();
      const footerRect = document.querySelector("footer").getBoundingClientRect();
      return {
        top: toastRect.top,
        bottom: toastRect.bottom,
        footerTop: footerRect.top
      };
    });
    assert.ok(toastLayout.top < 120, `Toast debe estar arriba (top=${toastLayout.top})`);
    assert.ok(toastLayout.bottom < toastLayout.footerTop, "Toast no debe cubrir footer ni barra enviar");

    // 2. Narrow sidecar viewport (420x800) zero-overflow check
    await page.setViewportSize({ width: 420, height: 800 });
    const narrowOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    assert.ok(narrowOverflow <= 1, `Desborde horizontal en sidecar 420px: ${narrowOverflow}`);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 3. Toggle Autoguardado OFF -> Reload -> Verifica persistencia -> volver a ON
    await page.click("#btn-auto-apply");
    assert.equal(await page.textContent("#auto-apply-label"), "Autoguardado: OFF");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("skill-select")?.options.length > 100);
    assert.equal(await page.textContent("#auto-apply-label"), "Autoguardado: OFF");
    await page.click("#btn-auto-apply");
    assert.equal(await page.textContent("#auto-apply-label"), "Autoguardado: ON");

    // 4. Seleccionar Perfil + Skill y verificar persistencia
    const chosenProfile = await page.evaluate(() => {
      const sel = document.getElementById("profile-select");
      const val = sel.options[1]?.value || "";
      sel.value = val;
      sel.dispatchEvent(new Event("change"));
      return val;
    });
    assert.ok(chosenProfile, "Debe haber al menos 1 perfil seleccionable");
    assert.equal(await page.isVisible("#active-profile-container"), true);

    // 5. Seleccionar proyecto AlphaApp -> Probar toggles GitHub, Netlify y Hugging Face
    await page.selectOption("#project-select", "AlphaApp");
    await page.waitForTimeout(150);

    // GitHub toggle reveals dropdown & enables dual sync badge
    await page.click("#btn-gh-toggle-pill");
    await page.waitForSelector("#integrations-drawer.active #int-pane-github.active");
    await page.waitForSelector('#gh-repo-select option[value="benner-e2e/alpha-app"]', { state: "attached" });
    await page.selectOption("#gh-repo-select", "benner-e2e/alpha-app");
    assert.equal(await page.isVisible("#dual-sync-badge"), true, "Badge Sync Dual debe aparecer");
    assert.equal(await page.textContent("#gh-pill-state"), "GitHub: ON");

    // Turn GitHub OFF so subsequent auto-apply test doesn't push remotely
    await page.click("#btn-gh-toggle-pill");
    assert.equal(await page.textContent("#gh-pill-state"), "GitHub: OFF");

    // Netlify toggle reveals site dropdown and persists publishDir without leaking across project switch
    await page.click("#btn-nf-toggle-pill");
    await page.waitForSelector("#integrations-drawer.active #int-pane-netlify.active");
    await page.waitForSelector('#nf-site-select option[value="site_e2e_1"]', { state: "attached" });
    await page.selectOption("#nf-site-select", "site_e2e_1");
    await page.fill("#nf-publish-dir", "dist");
    await page.dispatchEvent("#nf-publish-dir", "change");
    await page.waitForTimeout(120);

    // Switch to General -> nf-publish-dir should NOT leak "dist" -> switch back to AlphaApp -> restores "dist"
    await page.selectOption("#project-select", "General");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#nf-publish-dir"), "", "publishDir no debe fugarse al cambiar de proyecto");
    await page.selectOption("#project-select", "AlphaApp");
    await page.waitForTimeout(150);
    assert.equal(await page.inputValue("#nf-publish-dir"), "dist");

    // Turn Netlify OFF before testing local chat file write
    await page.click("#btn-nf-toggle-pill");
    assert.equal(await page.textContent("#nf-pill-state"), "Netlify: OFF");

    // Hugging Face toggle -> búsqueda -> Descargar abre Modal (Zero-Silent-Download)
    await page.click("#btn-hf-open-panel");
    await page.waitForSelector("#integrations-drawer.active #int-pane-hf.active");
    await page.fill("#hf-search-input", "qwen onnx");
    await page.click("#btn-hf-search");
    await page.waitForSelector('[data-hf-open-modal-idx="0"]');
    await page.click('[data-hf-open-modal-idx="0"]');
    await page.waitForSelector("#hf-download-modal.active");
    const suggestedDir = await page.inputValue("#hf-dl-target-dir");
    assert.match(suggestedDir, /Modelos -ai-brains/i);
    assert.equal(hfDownloadCalls, 0, "Regla Zero-Silent-Download violada: nunca debe descargar directo sin confirmar modal");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("hf-download-modal").classList.contains("active"));
    assert.equal(hfDownloadCalls, 0);
    await page.keyboard.press("Escape");

    // 6. Botón compuesto [Entrar en Contexto] [⚙️] -> Prompt Maestro -> Código Inyectado (read-only)
    await page.click("#btn-master-prompt-gear");
    await page.waitForSelector("#master-prompt-modal.active");
    await page.waitForSelector("#mp-project-editor:not([disabled])");
    await page.fill("#mp-project-editor", "REGLA DE PRUEBA MAESTRA E2E");
    await page.click("#btn-mp-save");
    await page.waitForFunction(() => document.getElementById("mp-status").textContent.includes("Prompt Maestro guardado"));
    await page.click("#btn-mp-preview");
    await page.waitForSelector("#preview-modal.active");
    const previewText = await page.textContent("#preview-content");
    assert.match(previewText, /REGLA DE PRUEBA MAESTRA E2E/);
    assert.equal(
      fs.existsSync(path.join(projAlphaDir, "PROJECT_CONTEXT.md")),
      false,
      "Código Inyectado / Preview nunca debe escribir PROJECT_CONTEXT.md en disco"
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("preview-modal").classList.contains("active"));

    // 7. Click "Entrar en Contexto" -> Stream telemetría + <thinking> + 4 secciones + state checkpoint
    await page.click("#btn-enter-context");
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll("#chat-container .message.ai");
      const last = msgs[msgs.length - 1];
      return last && last.textContent.includes("Plan de Acción Recomendado");
    });

    const enterUiCheck = await page.evaluate(() => {
      const msgs = document.querySelectorAll("#chat-container .message.ai");
      const last = msgs[msgs.length - 1];
      return {
        hasTelemetryCard: Boolean(last.querySelector(".telemetry-summary-card")),
        hasThinking: Boolean(last.querySelector("details.thinking-block")),
        contextHeadings: last.querySelectorAll(".md-h-context").length,
        hasChecklist: Boolean(last.querySelector(".md-check-item"))
      };
    });
    assert.equal(enterUiCheck.hasTelemetryCard, true);
    assert.equal(enterUiCheck.hasThinking, true);
    assert.equal(enterUiCheck.contextHeadings, 4, "Deben resaltarse las 4 secciones obligatorias");
    assert.equal(enterUiCheck.hasChecklist, true);

    // Verify lastContextAnalysis persisted in project_states.json
    const stateCheck = await page.evaluate(async () => {
      const r = await fetch("/api/memory/project-state?project=AlphaApp");
      return r.json();
    });
    assert.ok(stateCheck.state?.lastContextAnalysis?.timestamp, "lastContextAnalysis debe persistirse");

    // 8. Enviar mensaje normal -> recibir tarjetas write: + patch: + intento XSS -> Autoguardado ON aplica en disco
    await page.fill("#prompt-input", "Crea src/e2e_created.js y parchea src/index.js");
    await page.click("#send-btn");

    await page.waitForFunction(() => {
      const appliedBtns = document.querySelectorAll("#chat-container .btn-apply-action.applied");
      return appliedBtns.length >= 2;
    });

    // Assert real disk writes & patches happened!
    const createdFilePath = path.join(projAlphaDir, "src", "e2e_created.js");
    const patchedFilePath = path.join(projAlphaDir, "src", "index.js");
    assert.equal(fs.existsSync(createdFilePath), true, "src/e2e_created.js debe haberse escrito automáticamente");
    assert.match(fs.readFileSync(createdFilePath, "utf8"), /saludarE2E/);
    assert.match(fs.readFileSync(patchedFilePath, "utf8"), /AlphaAppReady/);

    // Assert Zero-XSS in DOM
    const xssEval = await page.evaluate(() => ({
      xssVar: window.__xssFired || false,
      scriptTagsInChat: document.querySelectorAll("#chat-container script").length
    }));
    assert.equal(dialogTriggered, false);
    assert.equal(xssEval.xssVar, false);
    assert.equal(xssEval.scriptTagsInChat, 0);

    // 9. Recargar navegador y verificar restauración automática + tarjetas marcadas "Aplicado en Disco"
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelectorAll("#chat-container .btn-apply-action.applied").length >= 2);
    const restoredChatText = await page.textContent("#chat-container");
    assert.match(restoredChatText, /Plan de Acción Recomendado/);
    assert.match(restoredChatText, /src\/e2e_created\.js/);

    // 10. Pulsar "+ Nuevo Chat" -> Recargar -> Debe mantenerse limpio sin restaurar la sesión anterior
    await page.click("#btn-new-chat");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("skill-select")?.options.length > 100);
    const cleanCount = await page.evaluate(() => document.querySelectorAll("#chat-container .message.user").length);
    assert.equal(cleanCount, 0, "+ Nuevo Chat debe permanecer limpio tras recarga");

    // 11. Drawer Memoria Persistente: 3 pestañas (Chats incl. migrado legacy, Cambios en Disco, Descargas HF)
    await page.click("#btn-history");
    await page.waitForSelector("#history-drawer.active");
    await page.waitForSelector("#history-list .history-item");

    const chatsDrawerText = await page.textContent("#history-list");
    assert.match(chatsDrawerText, /Sesión Legacy Migrada/);

    // Cambios en disco
    await page.click("#history-tab-changes");
    await page.waitForSelector("#changes-list .change-item");
    const changesText = await page.textContent("#changes-list");
    assert.match(changesText, /src\/e2e_created\.js/);
    assert.match(changesText, /src\/index\.js/);

    // Descargas HF
    await page.click("#history-tab-downloads");
    await page.waitForSelector("#downloads-history-list .change-item");
    const dlHistText = await page.textContent("#downloads-history-list");
    assert.match(dlHistText, /Qwen2\.5-0\.5B-Instruct-ONNX/);
    assert.match(dlHistText, /DirectML ONNX/);

    // Cargar sesión anterior desde Chats
    await page.click("#history-tab-chats");
    const targetBtn = page.locator("#history-list .history-item-load", { hasText: "Entrar en Contexto" }).first();
    await targetBtn.click();
    await page.waitForFunction(() => !document.getElementById("history-drawer").classList.contains("active"));
    await page.waitForFunction(() => document.querySelectorAll("#chat-container .btn-apply-action.applied").length >= 2);

    assert.deepEqual(consoleErrors, [], `Errores de consola detectados: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(pageErrors, [], `Errores de página no capturados: ${pageErrors.join(" | ")}`);

    await context.close();
  });

  it("valida Modo Dual (3 pares, panel independiente A/B, Invertir A<->B, Hardware Advisor, Streaming Dual, Autoguardado deduplicado, recarga, aislamiento y 0 overflow)", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.route("**/api/integrations/github/repos**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, configured: true, user: { login: "benner-e2e" }, repos: [], detectedRemote: { isGitRepo: false } })
      });
    });
    await page.route("**/api/integrations/netlify/sites**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, configured: true, user: { full_name: "Benner E2E" }, sites: [] })
      });
    });

    await page.goto(studioBaseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const pSel = document.getElementById("profile-select");
      const sSel = document.getElementById("skill-select");
      const mSel = document.getElementById("model-select");
      return pSel && pSel.options.length > 5 && sSel && sSel.options.length > 100 && mSel && mSel.value !== "";
    });

    // Seleccionar AlphaApp
    await page.selectOption("#project-select", "AlphaApp");
    await page.waitForTimeout(150);

    // Activar Modo Dual -> debe abrir panel de configuración y evaluar hardware
    await page.click("#btn-dual-mode");
    await page.waitForSelector("#dual-config-panel.active");
    await page.waitForSelector("#dual-bar-strip");
    await page.waitForFunction(() => {
      const sum = document.getElementById("dual-hw-summary")?.textContent || "";
      return sum.includes("860M") && sum.includes("Pico Dual");
    });

    // Verificar los 3 modos de emparejamiento (1, 2, 3) y que A/B se actualizan sin colisión
    await page.click("#dual-pair-freeai-directml");
    assert.equal(await page.inputValue("#dual-a-source"), "freeai");
    assert.equal(await page.inputValue("#dual-b-source"), "directml");

    await page.click("#dual-pair-ollama-directml");
    await page.waitForFunction(() => {
      const txt = document.getElementById("dual-hw-warnings")?.textContent || "";
      return txt.includes("OLIVE_GPU_MEMORY_LIMIT") || txt.includes("OLLAMA_IGPU_ENABLE");
    });
    assert.equal(await page.inputValue("#dual-a-source"), "ollama");
    assert.equal(await page.inputValue("#dual-b-source"), "directml");

    // Aplicar tuning de sesión sugerido desde Hardware Advisor
    await page.click("#btn-dual-apply-recommended");
    await page.waitForFunction(() => {
      const sum = document.getElementById("dual-hw-summary")?.textContent || "";
      return sum.includes("iGPU=ON") && sum.includes("DML=12");
    });

    // Cambiar a Modo 2: freeai + ollama y configurar A/B independientes
    await page.click("#dual-pair-freeai-ollama");
    await page.waitForTimeout(100);
    assert.equal(await page.inputValue("#dual-a-source"), "freeai");
    assert.equal(await page.inputValue("#dual-b-source"), "ollama");

    // Invertir A <-> B y luego volver a Free.ai -> Ollama
    await page.click("#btn-dual-swap");
    await page.waitForTimeout(100);
    assert.equal(await page.inputValue("#dual-a-source"), "ollama");
    assert.equal(await page.inputValue("#dual-b-source"), "freeai");
    await page.click("#btn-dual-swap");
    await page.waitForTimeout(100);
    assert.equal(await page.inputValue("#dual-a-source"), "freeai");
    assert.equal(await page.inputValue("#dual-b-source"), "ollama");

    // Configurar parámetros independientes en A y B + flujo Pipeline
    await page.selectOption("#dual-workflow-select", "pipeline");
    await page.fill("#dual-a-role", "Arquitecto Free.ai");
    await page.fill("#dual-b-role", "Auditor Ollama");
    await page.selectOption("#dual-a-profile", "engineering/engineering-backend-architect");
    await page.selectOption("#dual-a-skill", "backend-architect");
    await page.selectOption("#dual-b-profile", "Pirata");
    await page.selectOption("#dual-b-skill", "code-reviewer");
    await page.fill("#dual-a-directive", "DIRECTIVA_UNICA_A");
    await page.fill("#dual-b-directive", "DIRECTIVA_UNICA_B");
    await page.dispatchEvent("#dual-a-directive", "input");
    await page.dispatchEvent("#dual-b-directive", "input");
    await page.waitForTimeout(450);

    // Capturar captura desktop con #dual-config-panel abierto si env solicita screenshots (con scrollTop = 0 visible)
    const shotDir = process.env.LOCAL_AI_E2E_SCREENSHOT_DIR || tempRoot;
    await page.evaluate(() => {
      const panel = document.getElementById("dual-config-panel");
      if (panel) panel.scrollTop = 0;
    });
    await page.screenshot({ path: path.join(shotDir, "desktop_dual_panel.png") });

    // Cero overflow con #dual-config-panel abierto en desktop (1280x800) y sidecar (420x800)
    const openDesktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(openDesktopOverflow <= 1, `Overflow desktop con panel dual: ${openDesktopOverflow}`);

    await page.setViewportSize({ width: 420, height: 800 });
    await page.evaluate(() => {
      const panel = document.getElementById("dual-config-panel");
      if (panel) panel.scrollTop = 0;
    });
    const openSidecarOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(openSidecarOverflow <= 1, `Overflow sidecar 420px con panel dual: ${openSidecarOverflow}`);
    await page.screenshot({ path: path.join(shotDir, "sidecar_dual_panel.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Cerrar panel antes de enviar mensaje para capturar vista chat Dual amplia
    await page.click("#btn-dual-close-panel");
    await page.waitForFunction(() => !document.getElementById("dual-config-panel").classList.contains("active"));

    // Enviar prompt DUAL_WRITE_TEST en flujo Pipeline -> B sobrescribe/gana en src/dual_shared.js, A aporta src/dual_only_a.js
    await page.fill("#prompt-input", "DUAL_WRITE_TEST ejecuta cambios coordinados");
    await page.click("#send-btn");

    await page.waitForFunction(() => {
      const turn = document.querySelector(".dual-turn-wrap");
      if (!turn) return false;
      const aDone = turn.querySelector('.dual-agent-pane[data-agent-slot="A"] .dual-pane-stage')?.textContent?.includes("✓");
      const bDone = turn.querySelector('.dual-agent-pane[data-agent-slot="B"] .dual-pane-stage')?.textContent?.includes("✓");
      const appliedBtns = turn.querySelectorAll(".btn-apply-action.applied");
      const sendBtn = document.getElementById("send-btn");
      return aDone && bDone && appliedBtns.length >= 4 && sendBtn && !sendBtn.disabled;
    });

    await page.screenshot({ path: path.join(shotDir, "desktop_dual.png") });
    const paneFreeaiCount = await page.locator('.dual-agent-pane[data-agent-slot="A"] .freeai-logo-lockup').count();
    assert.equal(paneFreeaiCount, 1, "Pane dual de Free.ai debe renderizar .freeai-logo-lockup");

    // Verificar en sidecar 420x800 también con tarjetas duales renderizadas
    await page.setViewportSize({ width: 420, height: 800 });
    const chatSidecarOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(chatSidecarOverflow <= 1, `Overflow sidecar 420px con .dual-turn-grid: ${chatSidecarOverflow}`);
    await page.screenshot({ path: path.join(shotDir, "sidecar_dual.png") });
    await page.setViewportSize({ width: 1280, height: 800 });

    // Verificar deduplicación en disco: ganó Stage B en src/dual_shared.js + archivos únicos de A y B escritos
    const sharedFile = path.join(projAlphaDir, "src", "dual_shared.js");
    const onlyAFile = path.join(projAlphaDir, "src", "dual_only_a.js");
    const onlyBFile = path.join(projAlphaDir, "src", "dual_only_b.js");
    assert.equal(fs.existsSync(sharedFile), true);
    assert.equal(fs.existsSync(onlyAFile), true);
    assert.equal(fs.existsSync(onlyBFile), true);
    assert.match(fs.readFileSync(sharedFile, "utf8"), /agent-b-winner/, "Stage B debe prevalecer sobre Stage A en Pipeline");
    assert.match(fs.readFileSync(onlyAFile, "utf8"), /fromA = true/);
    assert.match(fs.readFileSync(onlyBFile, "utf8"), /fromB = true/);

    const dualButtonTexts = await page.evaluate(() => ({
      aBtns: Array.from(document.querySelectorAll('.dual-agent-pane[data-agent-slot="A"] .btn-apply-action')).map((b) => b.textContent.trim()),
      bBtns: Array.from(document.querySelectorAll('.dual-agent-pane[data-agent-slot="B"] .btn-apply-action')).map((b) => b.textContent.trim())
    }));
    assert.ok(dualButtonTexts.aBtns.some((t) => t.includes("Superado")), `Botón duplicado de A debe marcarse Superado: ${dualButtonTexts.aBtns}`);
    assert.ok(dualButtonTexts.aBtns.some((t) => t.includes("Aplicado en Disco")));
    assert.ok(dualButtonTexts.bBtns.every((t) => t.includes("Aplicado en Disco")));

    // Verificar recarga limpia: restaura asistente dual (.dual-turn-grid), estado dual OFF/ON del proyecto y badge DUAL en Historial
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".dual-turn-wrap .dual-turn-grid");
    await page.waitForFunction(() => document.querySelector("#btn-dual-mode")?.classList.contains("active"));
    assert.equal(await page.inputValue("#dual-a-role"), "Arquitecto Free.ai");
    assert.equal(await page.inputValue("#dual-b-role"), "Auditor Ollama");
    assert.equal(await page.inputValue("#dual-a-profile"), "engineering/engineering-backend-architect");
    assert.equal(await page.inputValue("#dual-b-skill"), "code-reviewer");

    // Verificar aislamiento por proyecto: cambiar a General -> dualConfig vuelve a OFF; regresar a AlphaApp -> dualConfig vuelve a ON
    await page.selectOption("#project-select", "General");
    await page.waitForFunction(() => !document.getElementById("btn-dual-mode")?.classList.contains("active"));
    await page.selectOption("#project-select", "AlphaApp");
    await page.waitForFunction(() => document.getElementById("btn-dual-mode")?.classList.contains("active"));

    // Verificar badge DUAL en drawer Historial
    await page.click("#btn-history");
    await page.waitForSelector("#history-drawer.active .history-mode-badge");
    const histBadge = await page.textContent("#history-drawer .history-mode-badge");
    assert.match(histBadge, /DUAL \(freeai\+ollama\)/);

    assert.deepEqual(consoleErrors, [], `Errores de consola detectados: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(pageErrors, [], `Errores de página no capturados: ${pageErrors.join(" | ")}`);

    await context.close();
  });

  it("valida Búsqueda Web SerpApi UI, citas Single/Dual, Kokoro/Piper 13 voces + speaking, #btn-stop-stream, #btn-dml-restart, runtime warnings HW y filtro isChatCapableModel", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    const speakRequests = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.route("**/api/integrations/github/repos**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, configured: true, user: { login: "benner-e2e" }, repos: [], detectedRemote: { isGitRepo: false } })
      });
    });
    await page.route("**/api/integrations/netlify/sites**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, configured: true, user: { full_name: "Benner E2E" }, sites: [] })
      });
    });
    await page.route("**/api/integrations/status", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          status: {
            githubConfigured: true,
            netlifyConfigured: true,
            hfConfigured: true,
            freeaiConfigured: true,
            serpApiConfigured: true,
            serpApiWebKeysCount: 1,
            serpApiJobsKeysCount: 1
          },
          defaultModelsDir: "C:\\antigravityAS\\Modelos -ai-brains"
        })
      });
    });
    let mockSerpWebUses = 12;
    await page.route("**/api/integrations/serpapi/usage", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          configured: true,
          webKeysCount: 1,
          jobsKeysCount: 1,
          totalKeysCount: 2,
          usage: {
            month: "2026-11",
            webUses: mockSerpWebUses,
            webLimit: 250,
            jobsUses: 3,
            jobsLimit: 250
          }
        })
      });
    });

    const silentWav = buildSilentWavBuffer(2.5, 24000);
    await page.route("**/api/tts/speak", async (route) => {
      const postRaw = route.request().postData() || "{}";
      try {
        speakRequests.push(JSON.parse(postRaw));
      } catch (_e) {
        speakRequests.push({ raw: postRaw });
      }
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "X-TTS-Engine": "kokoro",
          "X-TTS-Voice": "es_blend_editorial",
          "X-TTS-Sample-Rate": "24000"
        },
        body: silentWav
      });
    });

    await page.goto(studioBaseUrl, { waitUntil: "networkidle" });
    await page.waitForFunction(() => {
      const sSel = document.getElementById("skill-select");
      const mSel = document.getElementById("model-select");
      const tSel = document.getElementById("tts-voice-select");
      return sSel && sSel.options.length > 100 && mSel && mSel.value !== "" && tSel && tSel.options.length === 13;
    });

    // 1. Verificar controles Web Search (#toggle-web-search, #web-search-pill-state, #web-search-mode, #serpapi-usage-badge, #dot-serp)
    const serpInitial = await page.evaluate(() => ({
      pillText: document.getElementById("web-search-pill-state")?.textContent?.trim(),
      pressed: document.getElementById("toggle-web-search")?.getAttribute("aria-pressed"),
      badgeText: document.getElementById("serpapi-usage-badge")?.textContent?.trim(),
      dotReady: document.getElementById("dot-serp")?.classList.contains("ready"),
      modes: Array.from(document.getElementById("web-search-mode")?.options || []).map((o) => o.value)
    }));
    assert.equal(serpInitial.pillText, "Web: OFF");
    assert.equal(serpInitial.pressed, "false");
    assert.equal(serpInitial.badgeText, "W:12/250 J:3/250");
    assert.equal(serpInitial.dotReady, true);
    assert.deepEqual(serpInitial.modes, ["web", "news", "jobs"]);

    await page.click("#toggle-web-search");
    assert.equal(await page.textContent("#web-search-pill-state"), "Web: ON");
    assert.equal(await page.getAttribute("#toggle-web-search", "aria-pressed"), "true");

    await page.selectOption("#web-search-mode", "news");
    assert.equal(await page.inputValue("#web-search-mode"), "news");
    await page.selectOption("#web-search-mode", "jobs");
    assert.equal(await page.inputValue("#web-search-mode"), "jobs");
    await page.selectOption("#web-search-mode", "web");

    // 2. Verificar TTS (#tts-status-badge, #tts-voice-select 13 opciones y persistencia tras recarga)
    const ttsInfo = await page.evaluate(() => {
      const badgeText = document.getElementById("tts-status-badge")?.textContent?.trim();
      const opts = Array.from(document.getElementById("tts-voice-select")?.options || []).map((o) => o.value);
      return { badgeText, opts };
    });
    assert.match(ttsInfo.badgeText, /Kokoro|Piper/);
    assert.equal(ttsInfo.opts.length, 13, `Esperadas 13 voces TTS, encontradas ${ttsInfo.opts.length}`);
    for (const expectedVoice of [
      "ef_dora",
      "es_blend_editorial",
      "es_blend_documental",
      "vits-piper-es_ES-miro-high",
      "vits-piper-es_ES-carlfm-x_low",
      "vits-piper-es_ES-sharvard-m",
      "vits-piper-es_ES-sharvard-f"
    ]) {
      assert.ok(ttsInfo.opts.includes(expectedVoice), `Falta voz TTS ${expectedVoice}`);
    }

    await page.selectOption("#tts-voice-select", "es_blend_editorial");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("local_ai_tts_voice_v1")),
      "es_blend_editorial"
    );

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() => document.getElementById("tts-voice-select")?.options.length === 13);
    assert.equal(await page.inputValue("#tts-voice-select"), "es_blend_editorial");

    // 3. Filtrado isChatCapableModel excluyendo flux / whisper / embedding / tts en Free.ai
    await page.click("#src-freeai-btn");
    await page.waitForTimeout(80);
    const freeAiModelOptions = await page.evaluate(() =>
      Array.from(document.getElementById("model-select")?.options || []).map((o) => `${o.value} ${o.textContent}`.toLowerCase())
    );
    assert.ok(freeAiModelOptions.some((x) => x.includes("qwen-2.5-coder")), "Debe mantener modelo chat qwen-2.5-coder");
    assert.equal(
      freeAiModelOptions.some((x) => /\b(flux|whisper|embed|kokoro-tts)\b/.test(x)),
      false,
      `No debe mostrar modelos no-chat de Free.ai: ${freeAiModelOptions.join(" | ")}`
    );

    // 4. Botón #btn-dml-restart visible al seleccionar DirectML online (#src-directml-btn)
    await page.click("#src-directml-btn");
    await page.waitForSelector("#btn-dml-restart", { state: "visible" });
    assert.equal(await page.isVisible("#btn-dml-restart"), true);

    // Volver a Ollama local para flujo single chat
    await page.click("#src-local-btn");
    await page.waitForTimeout(80);

    // 5. Chat single con Búsqueda Web ON -> X-Web-Search-Meta -> details.web-citations-box + click [data-msg-act="tts"] .speaking
    await page.click("#toggle-web-search");
    assert.equal(await page.textContent("#web-search-pill-state"), "Web: ON");

    let capturedSingleChatPayload = null;
    await page.route("**/api/chat", async (route) => {
      capturedSingleChatPayload = JSON.parse(route.request().postData() || "{}");
      mockSerpWebUses = 13;
      const metaObj = {
        ok: true,
        configured: true,
        query: "Radeon 860M ROCm",
        mode: "web",
        engine: "google",
        poolUsed: "web",
        totalResults: 1,
        results: [
          {
            title: "Guía AMD Radeon 860M ROCm",
            link: "https://rocm.example.com/ryzen-860m",
            snippet: "Variables OLLAMA_IGPU_ENABLE=1 y HSA_OVERRIDE_GFX_VERSION=11.0.0.",
            source: "AMD Docs",
            date: "2026-11-09"
          }
        ],
        usage: { month: "2026-11", webUses: 13, webLimit: 250, jobsUses: 3, jobsLimit: 250 }
      };
      const metaB64 = Buffer.from(JSON.stringify(metaObj), "utf8").toString("base64");
      const ndjsonBody = [
        JSON.stringify({ model: "qwen2.5-coder:latest", message: { role: "assistant", content: "La Radeon 860M usa RDNA 3.5 con ROCm y DirectML." }, done: false }),
        JSON.stringify({ model: "qwen2.5-coder:latest", message: { role: "assistant", content: "" }, done: true })
      ].join("\n") + "\n";
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "X-Web-Search-Meta": metaB64
        },
        body: ndjsonBody
      });
    });

    await page.fill("#prompt-input", "Explica Radeon 860M ROCm");
    await page.click("#send-btn");
    await page.waitForSelector(".message.ai details.web-citations-box");
    await page.waitForSelector('.message.ai [data-msg-act="tts"]');
    await page.unroute("**/api/chat");

    assert.equal(capturedSingleChatPayload.webSearchEnabled, true);
    assert.equal(capturedSingleChatPayload.webSearchMode, "web");
    const singleCitationText = await page.textContent(".message.ai details.web-citations-box");
    assert.match(singleCitationText, /1 fuente\(s\)/);
    assert.match(singleCitationText, /Guía AMD Radeon 860M ROCm/);
    assert.equal(await page.textContent("#serpapi-usage-badge"), "W:13/250 J:3/250");

    // Click TTS en respuesta AI -> adquiere .speaking -> click para detener -> remueve .speaking
    await page.click('.message.ai [data-msg-act="tts"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('.message.ai [data-msg-act="tts"]');
      return btn && btn.classList.contains("speaking") && btn.textContent.includes("Detener");
    });
    assert.equal(speakRequests.at(-1)?.voice, "es_blend_editorial");
    await page.click('.message.ai [data-msg-act="tts"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('.message.ai [data-msg-act="tts"]');
      return btn && !btn.classList.contains("speaking") && btn.textContent.includes("Leer");
    });

    const shotDir = process.env.LOCAL_AI_E2E_SCREENSHOT_DIR || tempRoot;
    await page.screenshot({ path: path.join(shotDir, "desktop_web_tts.png") });

    // 6. Botón #btn-stop-stream durante stream lento (SLOW_STREAM_TEST) conserva respuesta parcial
    await page.click("#toggle-web-search");
    assert.equal(await page.textContent("#web-search-pill-state"), "Web: OFF");

    await page.fill("#prompt-input", "SLOW_STREAM_TEST abortar flujo largo");
    await page.click("#send-btn");
    await page.waitForSelector("#btn-stop-stream", { state: "visible" });
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll("#chat-container .message.ai");
      const last = msgs[msgs.length - 1];
      return last && last.textContent.includes("Fragmento parcial antes de detener.");
    });

    await page.click("#btn-stop-stream");
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll("#chat-container .message.ai");
      const last = msgs[msgs.length - 1];
      const stopBtn = document.getElementById("btn-stop-stream");
      const sendEl = document.getElementById("send-btn");
      return last
        && last.textContent.includes("⏹️ Respuesta detenida por el usuario")
        && stopBtn
        && getComputedStyle(stopBtn).display === "none"
        && sendEl
        && !sendEl.disabled;
    });
    const abortedText = await page.evaluate(() => {
      const msgs = document.querySelectorAll("#chat-container .message.ai");
      return msgs[msgs.length - 1]?.textContent || "";
    });
    assert.match(abortedText, /Fragmento parcial antes de detener\./);
    assert.equal(abortedText.includes("texto tardio"), false);

    // 7. Hardware Advisor runtime note + auto-checks + Dual web_search citations + [data-dual-pane-act="tts"] .speaking
    await page.route("**/api/system/hardware-evaluate", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          telemetry: {
            cpu: { name: "AMD Ryzen AI 7 350", cores: 8, logicalThreads: 16 },
            gpu: { name: "AMD Radeon(TM) 860M Graphics" },
            ram: { totalGb: 29.66, freeGb: 8.5 },
            env: {
              effective: {
                OLLAMA_IGPU_ENABLE: "1",
                OLIVE_GPU_MEMORY_LIMIT: "12"
              }
            }
          },
          evaluation: {
            riskLevel: "caution",
            freeRamGb: 8.5,
            estimatedPeakLocalGb: 6.2,
            psGpuRatio: 0,
            ollamaRunningOnCpu: true,
            requiresOllamaRestart: true,
            requiresDirectmlRestart: true,
            warnings: ["Ollama corriendo en CPU"],
            recommendations: ["Reinicia Ollama y DirectML tras aplicar tuning."],
            agentA: { isCloud: true, totalGb: 0, weightGb: 0 },
            agentB: { isCloud: false, totalGb: 4.5, weightGb: 4.0 }
          }
        })
      });
    });

    await page.click("#btn-dual-mode");
    await page.waitForSelector("#dual-config-panel.active");
    await page.waitForSelector("#dual-hw-runtime-note", { state: "visible" });
    const runtimeNoteText = await page.textContent("#dual-hw-runtime-note");
    assert.match(runtimeNoteText, /Ollama detectado corriendo en CPU \(0% en GPU\)/);
    assert.match(runtimeNoteText, /Límite\/hilos DirectML actualizados/);
    assert.match(await page.textContent("#dual-hw-summary"), /GPUps=0%/);
    assert.equal(await page.isChecked("#dual-restart-ollama-check"), true);
    assert.equal(await page.isChecked("#dual-restart-directml-check"), true);

    await page.click("#btn-dual-close-panel");
    await page.waitForFunction(() => !document.getElementById("dual-config-panel").classList.contains("active"));

    // Reactivar Web: ON y enviar Dual turn mockeando /api/chat/dual con evento web_search
    await page.click("#toggle-web-search");
    assert.equal(await page.textContent("#web-search-pill-state"), "Web: ON");

    await page.route("**/api/chat/dual", async (route) => {
      mockSerpWebUses = 14;
      const dualEvents = [
        {
          type: "dual_preflight",
          pair: "freeai+ollama",
          workflow: "pipeline",
          requestedWorkflow: "pipeline",
          downgradedFromParallel: false
        },
        {
          type: "web_search",
          ok: true,
          configured: true,
          query: "DirectML vs ROCm",
          mode: "web",
          engine: "google",
          poolUsed: "web",
          totalResults: 1,
          results: [
            {
              title: "Comparativa DirectML vs ROCm",
              link: "https://bench.example.com/dml-rocm",
              snippet: "Resultados verificados en Radeon 860M.",
              source: "BenchHub"
            }
          ],
          usage: { month: "2026-11", webUses: 14, webLimit: 250, jobsUses: 3, jobsLimit: 250 }
        },
        { type: "agent_start", agent: "A", stage: 1, stageLabel: "Propuesta Inicial", source: "freeai", model: "qwen-2.5-coder", roleLabel: "Arquitecto" },
        { type: "agent_chunk", agent: "A", stage: 1, delta: "Propuesta inicial de Agente A basada en búsqueda web." },
        { type: "agent_done", agent: "A", stage: 1, source: "freeai", model: "qwen-2.5-coder", elapsedMs: 120, text: "Propuesta inicial de Agente A basada en búsqueda web." },
        { type: "agent_start", agent: "B", stage: 2, stageLabel: "Auditoría", source: "ollama", model: "qwen2.5-coder:latest", roleLabel: "Auditor" },
        { type: "agent_chunk", agent: "B", stage: 2, delta: "Auditoría verificada de Agente B." },
        { type: "agent_done", agent: "B", stage: 2, source: "ollama", model: "qwen2.5-coder:latest", elapsedMs: 140, text: "Auditoría verificada de Agente B." },
        { type: "dual_done", pair: "freeai+ollama", workflow: "pipeline", requestedWorkflow: "pipeline", elapsedMs: 260, partialFailure: false }
      ].map((e) => JSON.stringify(e)).join("\n") + "\n";

      await route.fulfill({
        status: 200,
        headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
        body: dualEvents
      });
    });

    await page.fill("#prompt-input", "Analiza Dual con búsqueda web");
    await page.click("#send-btn");
    await page.waitForSelector(".dual-turn-wrap .dual-turn-notices details.web-citations-box");
    await page.waitForSelector('.dual-agent-pane[data-agent-slot="A"] [data-dual-pane-act="tts"]');
    await page.waitForFunction(() => document.getElementById("serpapi-usage-badge")?.textContent?.trim() === "W:14/250 J:3/250");
    await page.unroute("**/api/chat/dual");

    const dualCitationText = await page.textContent(".dual-turn-wrap .dual-turn-notices details.web-citations-box");
    assert.match(dualCitationText, /Comparativa DirectML vs ROCm/);
    assert.equal(await page.textContent("#serpapi-usage-badge"), "W:14/250 J:3/250");

    await page.click('.dual-agent-pane[data-agent-slot="A"] [data-dual-pane-act="tts"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('.dual-agent-pane[data-agent-slot="A"] [data-dual-pane-act="tts"]');
      return btn && btn.classList.contains("speaking") && btn.textContent.includes("Detener");
    });
    await page.click('.dual-agent-pane[data-agent-slot="A"] [data-dual-pane-act="tts"]');
    await page.waitForFunction(() => {
      const btn = document.querySelector('.dual-agent-pane[data-agent-slot="A"] [data-dual-pane-act="tts"]');
      return btn && !btn.classList.contains("speaking");
    });

    const finalOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(finalOverflow <= 1, `Desborde horizontal en desktop Web+TTS: ${finalOverflow}`);

    assert.deepEqual(consoleErrors, [], `Errores de consola detectados: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(pageErrors, [], `Errores de página no capturados: ${pageErrors.join(" | ")}`);

    await context.close();
  });

  it("muestra advertencia clara DirectML en Single y Modo Dual cuando el proyecto supera 6,144 tokens, con WCAG AA, acciones rápidas y 0 overflow en 1280x800 y 420x800", async () => {
    const projLargeDir = path.join(tempProjectsDir, "LargeDmlApp");
    fs.mkdirSync(path.join(projLargeDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(projLargeDir, "package.json"), JSON.stringify({
      name: "large-dml-app",
      version: "1.0.0"
    }), "utf8");
    fs.writeFileSync(
      path.join(projLargeDir, "src", "big_a.js"),
      "// Big Module A\n" + "export const tokenPadA = 'directml_kv_overflow_segment_alpha';\n".repeat(260),
      "utf8"
    );
    fs.writeFileSync(
      path.join(projLargeDir, "src", "big_b.js"),
      "// Big Module B\n" + "export const tokenPadB = 'directml_kv_overflow_segment_beta';\n".repeat(260),
      "utf8"
    );

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    const consoleErrors = [];
    const pageErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.route("**/api/integrations/github/repos**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, configured: false, repos: [] })
      });
    });
    await page.route("**/api/integrations/netlify/sites**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, configured: false, sites: [] })
      });
    });

    await page.goto(studioBaseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('#project-select option[value="LargeDmlApp"]', { state: "attached" });
    await page.waitForSelector("#project-dml-compat-badge.compat-ok", { state: "visible" });
    assert.match(await page.textContent("#project-dml-compat-badge"), /⚡ DML OK/);

    // 1. Cambiar a LargeDmlApp con Ollama activo: badge visible ⛔ No DirectML, banner oculto
    await page.selectOption("#project-select", "LargeDmlApp");
    await page.waitForSelector("#project-dml-compat-badge.compat-bad", { state: "visible" });
    assert.match(await page.textContent("#project-dml-compat-badge"), /⛔ No DirectML/);

    const bannerHiddenOnOllama = await page.evaluate(() => {
      const b = document.getElementById("dml-project-compat-warn");
      return !b || getComputedStyle(b).display === "none";
    });
    assert.equal(bannerHiddenOnOllama, true, "Banner DirectML no debe mostrarse mientras Ollama está seleccionado");

    // 2. Cambiar a DirectML en modo Single -> banner de advertencia claro aparece con métricas reales
    await page.click("#src-directml-btn");
    await page.waitForSelector("#dml-project-compat-warn", { state: "visible" });

    const singleBannerInfo = await page.evaluate(() => {
      const banner = document.getElementById("dml-project-compat-warn");
      const title = document.getElementById("dml-compat-title");
      const detail = document.getElementById("dml-compat-detail");
      const btnOllama = document.getElementById("btn-dml-switch-ollama");
      const btnFree = document.getElementById("btn-dml-switch-freeai");
      const btnDualSafe = document.getElementById("btn-dml-switch-dual-safe");

      const parseRgb = (cssColor) => {
        const m = String(cssColor || "").match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
      };
      const relLum = ([r, g, b]) => {
        const chan = [r, g, b].map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
      };
      const contrastRatio = (fgRgb, bgRgb) => {
        const l1 = relLum(fgRgb);
        const l2 = relLum(bgRgb);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };

      // Fondo real base #070204 y peor caso con gradiente rgba(247,118,142,0.14) -> rgb(41, 18, 23)
      const bgBase = parseRgb(getComputedStyle(banner).backgroundColor);
      const bgWorstCase = [41, 18, 23];
      const titleFg = parseRgb(getComputedStyle(title).color);
      const detailFg = parseRgb(getComputedStyle(detail).color);

      return {
        display: getComputedStyle(banner).display,
        titleText: title.textContent.trim(),
        detailText: detail.textContent.trim(),
        btnOllamaVisible: getComputedStyle(btnOllama).display !== "none",
        btnFreeVisible: getComputedStyle(btnFree).display !== "none",
        btnDualSafeHidden: getComputedStyle(btnDualSafe).display === "none",
        titleContrastBase: contrastRatio(titleFg, bgBase),
        titleContrastWorst: contrastRatio(titleFg, bgWorstCase),
        detailContrastBase: contrastRatio(detailFg, bgBase),
        detailContrastWorst: contrastRatio(detailFg, bgWorstCase),
        overflowDesktop: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        footerText: document.querySelector(".legal-signature")?.textContent?.trim() || ""
      };
    });

    assert.equal(singleBannerInfo.display, "flex");
    assert.match(singleBannerInfo.titleText, /LargeDmlApp/);
    assert.match(singleBannerInfo.titleText, /incompatible con DirectML/i);
    assert.match(singleBannerInfo.detailText, /6,144/);
    assert.match(singleBannerInfo.detailText, /8,192/);
    assert.match(singleBannerInfo.detailText, /HTTP 400/);
    assert.match(singleBannerInfo.detailText, /Mayor peso:/);
    assert.equal(singleBannerInfo.btnOllamaVisible, true);
    assert.equal(singleBannerInfo.btnFreeVisible, true);
    assert.equal(singleBannerInfo.btnDualSafeHidden, true);
    assert.ok(singleBannerInfo.titleContrastWorst >= 4.5, `Contraste WCAG AA título insuficiente: ${singleBannerInfo.titleContrastWorst}`);
    assert.ok(singleBannerInfo.detailContrastWorst >= 4.5, `Contraste WCAG AA detalle insuficiente: ${singleBannerInfo.detailContrastWorst}`);
    assert.ok(singleBannerInfo.overflowDesktop <= 1, `Desborde horizontal en 1280x800 con banner DirectML: ${singleBannerInfo.overflowDesktop}`);
    assert.equal(singleBannerInfo.footerText, "HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®");

    // Verificar Drawer de contexto y Preview modal muestran estado Incompatible
    await page.click("#btn-toggle-context-drawer");
    await page.waitForSelector("#context-drawer.active");
    assert.match(await page.textContent("#ctx-dml-compat"), /Incompatible.*6,144.*8,192/);
    await page.click("#btn-toggle-context-drawer");

    await page.click("#btn-preview-context");
    await page.waitForSelector("#preview-modal.active");
    await page.waitForFunction(() => (document.getElementById("preview-metrics")?.textContent || "").includes("No DirectML"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("preview-modal").classList.contains("active"));

    // 3. Verificar layout móvil 420x800 sin overflow con el banner visible
    await page.setViewportSize({ width: 420, height: 800 });
    await page.waitForTimeout(120);
    const mobileBannerCheck = await page.evaluate(() => {
      const b = document.getElementById("dml-project-compat-warn");
      const rect = b.getBoundingClientRect();
      return {
        overflowMobile: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rightEdge: rect.right,
        clientW: document.documentElement.clientWidth
      };
    });
    assert.ok(mobileBannerCheck.overflowMobile <= 1, `Desborde horizontal 420x800 en Single DirectML: ${mobileBannerCheck.overflowMobile}`);
    assert.ok(mobileBannerCheck.rightEdge <= mobileBannerCheck.clientW + 1);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 4. Acción rápida en Single: cambiar a Ollama -> banner desaparece limpiamente
    await page.click("#btn-dml-switch-ollama");
    await page.waitForSelector("#src-local-btn.active");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("dml-project-compat-warn")).display === "none");

    // Reactivar DirectML y probar acción rápida Free.ai -> desaparece limpiamente
    await page.click("#src-directml-btn");
    await page.waitForSelector("#dml-project-compat-warn", { state: "visible" });
    await page.click("#btn-dml-switch-freeai");
    await page.waitForSelector("#src-freeai-btn.active");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("dml-project-compat-warn")).display === "none");

    // 5. Reactivar DirectML y cambiar a proyecto compatible (AlphaApp y luego General) -> banner desaparece
    await page.click("#src-directml-btn");
    await page.waitForSelector("#dml-project-compat-warn", { state: "visible" });
    await page.selectOption("#project-select", "AlphaApp");
    await page.waitForSelector("#project-dml-compat-badge.compat-ok", { state: "visible" });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("dml-project-compat-warn")).display === "none");

    await page.selectOption("#project-select", "General");
    await page.waitForSelector("#project-dml-compat-badge.compat-ok", { state: "visible" });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("dml-project-compat-warn")).display === "none");

    // 6. Volver a LargeDmlApp y activar Modo Dual (freeai+directml por defecto):
    //    Deben mostrarse ambos avisos (#dml-project-compat-warn y #dual-dml-project-warn) y pill ⚠️ >DML KV
    await page.selectOption("#project-select", "LargeDmlApp");
    await page.waitForSelector("#project-dml-compat-badge.compat-bad", { state: "visible" });
    await page.click("#btn-dual-mode");
    await page.waitForSelector("#dual-config-panel.active");
    await page.waitForSelector("#dml-project-compat-warn", { state: "visible" });
    await page.waitForSelector("#dual-dml-project-warn", { state: "visible" });
    await page.waitForFunction(() => (document.getElementById("dual-hw-risk-pill")?.textContent || "").includes(">DML KV"));

    const dualWarnDetails = await page.evaluate(() => ({
      mainTitle: document.getElementById("dml-compat-title")?.textContent || "",
      dualWarnText: document.getElementById("dual-dml-project-warn-text")?.textContent || "",
      overflowDualDesktop: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    assert.match(dualWarnDetails.mainTitle, /Modo Dual/i);
    assert.match(dualWarnDetails.dualWarnText, /LargeDmlApp/);
    assert.match(dualWarnDetails.dualWarnText, /6,144/);
    assert.match(dualWarnDetails.dualWarnText, /8,192/);
    assert.match(dualWarnDetails.dualWarnText, /HTTP 400/);
    assert.ok(dualWarnDetails.overflowDualDesktop <= 1, `Desborde 1280x800 en Dual con advertencias: ${dualWarnDetails.overflowDualDesktop}`);

    // Verificar también 420x800 con panel Dual + ambos avisos activos
    await page.setViewportSize({ width: 420, height: 800 });
    await page.waitForTimeout(120);
    const dualMobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(dualMobileOverflow <= 1, `Desborde 420x800 en Dual con advertencias: ${dualMobileOverflow}`);
    await page.setViewportSize({ width: 1280, height: 800 });

    // 7. Acción rápida dentro del panel Dual: cambiar par a Free.ai + Ollama -> ambos avisos se ocultan limpiamente
    await page.click("#btn-dual-dml-switch-safe");
    await page.waitForSelector("#dual-pair-freeai-ollama.active");
    await page.waitForFunction(() => {
      const mainW = document.getElementById("dml-project-compat-warn");
      const dualW = document.getElementById("dual-dml-project-warn");
      return mainW && getComputedStyle(mainW).display === "none" &&
        dualW && getComputedStyle(dualW).display === "none";
    });

    assert.deepEqual(consoleErrors, [], `Errores de consola detectados: ${consoleErrors.join(" | ")}`);
    assert.deepEqual(pageErrors, [], `Errores de página no capturados: ${pageErrors.join(" | ")}`);

    await context.close();
  });
});
