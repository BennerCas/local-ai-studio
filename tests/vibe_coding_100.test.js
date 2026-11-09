const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

function requestJson(baseUrl, reqPath, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(reqPath, baseUrl);
    const method = options.method || "GET";
    const bodyStr = options.body !== undefined
      ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body))
      : null;

    const req = http.request(target, {
      method,
      headers: {
        ...(bodyStr !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) } : {}),
        ...(options.headers || {})
      }
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_e) {}
        resolve({ status: res.statusCode, headers: res.headers, text: data, json });
      });
    });
    req.on("error", reject);
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

test("Suite Integral 100% Vibe Coding (Fases 1 a 7 End-to-End)", async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibe100-test-"));
  const projectsDir = path.join(tmpRoot, "projects");
  const memoryDir = path.join(tmpRoot, "memory");
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  const prevProjectsDir = process.env.LOCAL_AI_PROJECTS_DIR;
  const prevMemoryDir = process.env.LOCAL_AI_MEMORY_DIR;
  process.env.LOCAL_AI_PROJECTS_DIR = projectsDir;
  process.env.LOCAL_AI_MEMORY_DIR = memoryDir;

  const { createStudioServer } = require("../sidecars/local_ai_chat/server.js");
  const server = createStudioServer({
    autoStartDirectML: false,
    allowHostProcessControl: false,
    skipWindowsApply: true
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (prevProjectsDir === undefined) delete process.env.LOCAL_AI_PROJECTS_DIR;
    else process.env.LOCAL_AI_PROJECTS_DIR = prevProjectsDir;
    if (prevMemoryDir === undefined) delete process.env.LOCAL_AI_MEMORY_DIR;
    else process.env.LOCAL_AI_MEMORY_DIR = prevMemoryDir;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_e) {}
  });

  await t.test("Fase 3: POST /api/project/create genera estructura ESTRUCTURA.md + firma DISENO.md + git init", async () => {
    const res = await requestJson(baseUrl, "/api/project/create", {
      method: "POST",
      body: {
        name: "DemoVibeApp",
        template: "web-vanilla",
        description: "Proyecto E2E Vibe Coding",
        initGit: true
      }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.project.name, "DemoVibeApp");

    const projPath = path.join(projectsDir, "DemoVibeApp");
    assert.equal(fs.existsSync(path.join(projPath, "src", "ui", "index.html")), true);
    assert.equal(fs.existsSync(path.join(projPath, "biblioteca")), true);
    assert.equal(fs.existsSync(path.join(projPath, "tests", "smoke.test.js")), true);
    assert.equal(fs.existsSync(path.join(projPath, ".gitignore")), true);

    const uiHtml = fs.readFileSync(path.join(projPath, "src", "ui", "index.html"), "utf-8");
    assert.match(uiHtml, /HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®/);
  });

  await t.test("Fase 1: Diff Preview, Lote Transaccional Atómico y Rollback en 1 Clic", async () => {
    // 1. Diff Preview sin tocar disco
    const diffRes = await requestJson(baseUrl, "/api/project/diff-preview", {
      method: "POST",
      body: {
        project: "DemoVibeApp",
        kind: "patch",
        filePath: "README.md",
        search: "Proyecto E2E Vibe Coding",
        replace: "Proyecto E2E Vibe Coding (Verificado con Diff)"
      }
    });
    assert.equal(diffRes.status, 200);
    assert.equal(diffRes.json.ok, true);
    assert.match(diffRes.json.unifiedDiff, /\+> Proyecto E2E Vibe Coding \(Verificado con Diff\)/);

    // 2. Lote fallido debe abortar en preflight sin modificar archivos previos
    const badBatch = await requestJson(baseUrl, "/api/project/apply-batch", {
      method: "POST",
      body: {
        project: "DemoVibeApp",
        actions: [
          { kind: "write", filePath: "src/core/temp.js", content: "module.exports = 1;\n" },
          { kind: "patch", filePath: "README.md", search: "TEXTO_INEXISTENTE_XYZ", replace: "nuevo" }
        ]
      }
    });
    assert.equal(badBatch.status, 400);
    assert.equal(badBatch.json.ok, false);
    assert.equal(fs.existsSync(path.join(projectsDir, "DemoVibeApp", "src", "core", "temp.js")), false);

    // 3. Lote válido atómico
    const goodBatch = await requestJson(baseUrl, "/api/project/apply-batch", {
      method: "POST",
      body: {
        project: "DemoVibeApp",
        model: "qwen2.5-coder:14b",
        source: "ollama",
        actions: [
          {
            kind: "patch",
            filePath: "README.md",
            search: "Proyecto E2E Vibe Coding",
            replace: "Proyecto E2E Vibe Coding (Verificado con Diff)"
          }
        ]
      }
    });
    assert.equal(goodBatch.status, 200);
    assert.equal(goodBatch.json.ok, true);
    assert.equal(goodBatch.json.appliedCount, 1);
    const changeId = goodBatch.json.results[0].changeId;
    assert.ok(changeId);

    // 4. Listar backups y revertir cambio en 1 clic
    const backupsRes = await requestJson(baseUrl, "/api/project/backups?project=DemoVibeApp");
    assert.equal(backupsRes.status, 200);
    assert.ok(backupsRes.json.backups.length >= 1);

    const rbRes = await requestJson(baseUrl, "/api/project/rollback", {
      method: "POST",
      body: { project: "DemoVibeApp", changeId }
    });
    assert.equal(rbRes.status, 200);
    assert.equal(rbRes.json.ok, true);

    const restoredReadme = fs.readFileSync(path.join(projectsDir, "DemoVibeApp", "README.md"), "utf-8");
    assert.doesNotMatch(restoredReadme, /Verificado con Diff/);
  });

  await t.test("Fase 2: GET /api/project/scripts y POST /api/project/run (Runner Seguro)", async () => {
    const scriptsRes = await requestJson(baseUrl, "/api/project/scripts?project=DemoVibeApp");
    assert.equal(scriptsRes.status, 200);
    assert.equal(scriptsRes.json.ok, true);
    assert.ok(scriptsRes.json.builtInCommands.includes("node_test"));

    const runRes = await requestJson(baseUrl, "/api/project/run", {
      method: "POST",
      body: {
        project: "DemoVibeApp",
        commandKey: "node_test",
        timeoutMs: 15000
      }
    });
    assert.equal(runRes.status, 200);
    assert.equal(runRes.json.ok, true);
    assert.equal(runRes.json.exitCode, 0);
    assert.equal(runRes.json.passed, true);
  });

  await t.test("Fase 4: Live Preview Status y Static Server con inyección de puente de errores", async () => {
    const stRes = await requestJson(baseUrl, "/api/project/preview/status?project=DemoVibeApp");
    assert.equal(stRes.status, 200);
    assert.equal(stRes.json.ok, true);
    assert.ok(stRes.json.previewUrl);

    const htmlRes = await requestJson(baseUrl, stRes.json.previewUrl);
    assert.equal(htmlRes.status, 200);
    assert.match(htmlRes.text, /data-local-ai-preview-bridge/);
    assert.match(htmlRes.text, /HUMAN AI SYNERGY BY BENNER CASTILLO - 2026®/);
  });

  await t.test("Fase 5 y Fase 7: Buscador Grep, Pinned Files y Fusión Infinita de Skills", async () => {
    const searchRes = await requestJson(baseUrl, "/api/project/search", {
      method: "POST",
      body: { project: "DemoVibeApp", query: "HUMAN AI SYNERGY" }
    });
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.json.ok, true);
    assert.ok(searchRes.json.matches.length >= 1);

    const pinRes = await requestJson(baseUrl, "/api/project/pin-files", {
      method: "POST",
      body: { project: "DemoVibeApp", pinnedFiles: ["src/main/index.js"] }
    });
    assert.equal(pinRes.status, 200);
    assert.deepEqual(pinRes.json.pinnedFiles, ["src/main/index.js"]);

    const fuseRes = await requestJson(baseUrl, "/api/skills/fuse", {
      method: "POST",
      body: {
        name: "Fusion_Vibe_Test",
        description: "Fusión de prueba E2E",
        skillIds: ["react-patterns", "tdd-workflow"]
      }
    });
    assert.equal(fuseRes.status, 200);
    assert.equal(fuseRes.json.ok, true);
    assert.ok(fuseRes.json.backupPath);
  });
});
