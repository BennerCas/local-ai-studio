const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { chromium } = require("C:/Users/Benner/node_modules/playwright");
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
let browser = null;

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
          }
        ]
      }));
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

      if (req.url === "/api/chat" && req.method === "POST") {
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        const sysContent = messages.find((m) => m.role === "system")?.content || "";
        const lastUser = messages.filter((m) => m.role === "user").pop()?.content || "";

        res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });

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
        res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
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
      autoStartDirectML: false
    });
    const studioPort = await listenServer(studioServer);
    studioBaseUrl = `http://127.0.0.1:${studioPort}`;

    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
    await closeServer(studioServer);
    await closeServer(mockEngineServer);
    studioServer = null;
    mockEngineServer = null;

    for (const k of ENV_BACKUP_KEYS) {
      if (savedEnvValues[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnvValues[k];
    }

    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
});
