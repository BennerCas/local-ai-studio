const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Isolate memory-store persistence to a temporary directory during tests
const TEST_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "studio-mem-"));
process.env.LOCAL_AI_MEMORY_DIR = TEST_MEMORY_DIR;

const envLoader = require("../env-loader.js");
const memoryStore = require("../memory-store.js");
const bridge = require("../integrations-bridge.js");

test.after(() => {
  fs.rmSync(TEST_MEMORY_DIR, { recursive: true, force: true });
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function assertNoSecretsInJson(payload, extraSecrets = []) {
  const serialized = typeof payload === "string" ? payload : JSON.stringify(payload);
  const pools = typeof envLoader.getSerpApiKeyPools === "function"
    ? envLoader.getSerpApiKeyPools()
    : { allKeys: [] };
  const tokens = [
    envLoader.getGithubToken(),
    envLoader.getNetlifyToken(),
    envLoader.getHfToken(),
    ...(Array.isArray(pools.allKeys) ? pools.allKeys : []),
    ...(Array.isArray(extraSecrets) ? extraSecrets : [])
  ].filter(t => t && String(t).trim().length >= 6);

  for (const tok of tokens) {
    assert.equal(serialized.includes(String(tok)), false, "Response JSON must NEVER contain raw secret tokens");
  }
  assert.equal(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}\b/.test(serialized), false);
  assert.equal(/\bhf_[A-Za-z0-9]{10,}\b/.test(serialized), false);
  assert.equal(/[?&]api_key=[^&\s"'\[\]]+/i.test(serialized), false, "Response JSON must NEVER leak api_key query param");
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

test("DEFAULT_MODELS_DIR matches central Antigravity models path", () => {
  assert.equal(bridge.DEFAULT_MODELS_DIR, "C:\\antigravityAS\\Modelos -ai-brains");
});

test("sanitizeGitRemoteUrl strips embedded credentials and preserves clean remote", () => {
  const withUserPass = "https://x-access-token:ghp_FAKE1234567890SECRET@github.com/octocat/hello-world.git";
  const cleaned1 = bridge.sanitizeGitRemoteUrl(withUserPass);
  assert.equal(cleaned1, "https://github.com/octocat/hello-world.git");
  assert.equal(cleaned1.includes("ghp_FAKE"), false);
  assert.equal(cleaned1.includes("x-access-token"), false);

  const withUserOnly = "https://ghp_FAKE1234567890SECRET@github.com/octocat/hello-world.git";
  const cleaned2 = bridge.sanitizeGitRemoteUrl(withUserOnly);
  assert.equal(cleaned2, "https://github.com/octocat/hello-world.git");

  const sshUrl = "git@github.com:octocat/hello-world.git";
  assert.equal(bridge.sanitizeGitRemoteUrl(sshUrl), sshUrl);

  const parsed = bridge.parseGitHubRepoFromRemote(withUserPass);
  assert.deepEqual(parsed, {
    owner: "octocat",
    repo: "hello-world",
    fullName: "octocat/hello-world"
  });
});

test("sanitizeSecrets scrubs tokens, basic auth base64, and bearer headers", () => {
  const fakePat = "ghp_MyFakeSecretToken987654321";
  const b64 = Buffer.from(`x-access-token:${fakePat}`, "utf8").toString("base64");
  const rawErr = `fatal: unable to access https://x-access-token:${fakePat}@github.com/a/b.git header AUTHORIZATION: basic ${b64} and hf_AbCdEfGhIjKlMnOpQr`;
  const scrubbed = bridge.sanitizeSecrets(new Error(rawErr), [fakePat, b64]);

  assert.equal(scrubbed.includes(fakePat), false);
  assert.equal(scrubbed.includes(b64), false);
  assert.equal(scrubbed.includes("hf_AbCdEfGhIjKlMnOpQr"), false);
  assert.equal(scrubbed.includes("[REDACTED]"), true);
});

test("buildEphemGitEnv configures GIT_CONFIG_COUNT without plaintext PAT or disk writes", () => {
  const fakePat = "ghp_UnitTestSecret000111222";
  const env = bridge.buildEphemGitEnv(fakePat);

  assert.equal(env.GIT_CONFIG_COUNT, "1");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GCM_INTERACTIVE, "never");
  assert.equal(env.GIT_CONFIG_VALUE_0.startsWith("AUTHORIZATION: basic "), true);
  assert.equal(env.GIT_CONFIG_VALUE_0.includes(fakePat), false);

  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""), "base64").toString("utf8");
  assert.equal(decoded, `x-access-token:${fakePat}`);

  const val = execFileSync("git", ["config", "--get-all", "http.https://github.com/.extraheader"], {
    env,
    shell: false,
    encoding: "utf-8"
  }).trim();
  assert.equal(val, env.GIT_CONFIG_VALUE_0);

  assert.throws(() => bridge.buildEphemGitEnv(""), /requerido/i);
});

test("detectPublishDir resolves dist, build, out, public, www, root index.html, or null", () => {
  const tmp = makeTempDir("studio-pub-");
  try {
    assert.equal(bridge.detectPublishDir(tmp), null);

    fs.writeFileSync(path.join(tmp, "index.html"), "<h1>Root</h1>", "utf-8");
    assert.equal(bridge.detectPublishDir(tmp), ".");

    fs.mkdirSync(path.join(tmp, "www"));
    assert.equal(bridge.detectPublishDir(tmp), "www");

    fs.mkdirSync(path.join(tmp, "public"));
    assert.equal(bridge.detectPublishDir(tmp), "public");

    fs.mkdirSync(path.join(tmp, "out"));
    assert.equal(bridge.detectPublishDir(tmp), "out");

    fs.mkdirSync(path.join(tmp, "build"));
    assert.equal(bridge.detectPublishDir(tmp), "build");

    fs.mkdirSync(path.join(tmp, "dist"));
    assert.equal(bridge.detectPublishDir(tmp), "dist");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("detectGitProjectMeta extracts sanitized origin and branch from temp git repo", () => {
  const tmp = makeTempDir("studio-git-");
  try {
    assert.equal(bridge.detectGitProjectMeta(tmp).isGitRepo, false);

    execFileSync("git", ["-C", tmp, "init", "-b", "main"], { shell: false });
    execFileSync("git", ["-C", tmp, "remote", "add", "origin", "https://user:ghp_LeakTest123456@github.com/acme/demo.git"], {
      shell: false
    });

    const meta = bridge.detectGitProjectMeta(tmp);
    assert.equal(meta.isGitRepo, true);
    assert.equal(meta.originUrl, "https://github.com/acme/demo.git");
    assert.equal(meta.repoFullName, "acme/demo");
    assert.equal(meta.branch, "main");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("syncProjectToGitHub pushes to local bare remote while protecting .env and persisting state", async () => {
  const bareDir = makeTempDir("studio-bare-");
  const workDir = makeTempDir("studio-work-");
  try {
    execFileSync("git", ["init", "--bare", bareDir], { shell: false });
    execFileSync("git", ["-C", workDir, "init", "-b", "main"], { shell: false });
    execFileSync("git", ["-C", workDir, "remote", "add", "origin", bareDir], { shell: false });
    fs.writeFileSync(path.join(workDir, ".env"), "SECRET=DO_NOT_COMMIT\n", "utf-8");
    fs.writeFileSync(path.join(workDir, "README.md"), "# Demo Project\n", "utf-8");

    const res = await bridge.syncProjectToGitHub({
      projectName: "demo-sync-test",
      projectPath: workDir,
      commitMessage: "Test commit without .env"
    });

    assert.equal(res.ok, true);
    assert.equal(res.mode, "git_push");
    assert.equal(res.pushed, true);
    assert.ok(res.commitSha);

    // Ensure .env was NEVER tracked or pushed
    const trackedFiles = execFileSync("git", ["-C", workDir, "ls-files"], { shell: false, encoding: "utf-8" });
    assert.equal(trackedFiles.split(/\r?\n/).includes(".env"), false);
    assert.equal(trackedFiles.split(/\r?\n/).includes("README.md"), true);

    // Ensure .gitignore was added with .env protection
    const gitignore = fs.readFileSync(path.join(workDir, ".gitignore"), "utf-8");
    assert.equal(gitignore.includes(".env"), true);

    // Ensure .git/config does not contain any PAT
    const gitConfig = fs.readFileSync(path.join(workDir, ".git", "config"), "utf-8");
    assert.equal(gitConfig.includes("extraheader"), false);
    assert.equal(gitConfig.includes("x-access-token"), false);

    // Ensure memory-store persisted change & project state
    const changes = memoryStore.listChanges("demo-sync-test", 10);
    assert.ok(changes.length >= 1);
    assert.equal(changes[0].action, "github_push");
    const state = memoryStore.getProjectState(workDir);
    assert.equal(state.githubToggle, true);
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("startHfDownload strictly rejects missing, empty, root, or invalid targetDir", async () => {
  await assert.rejects(
    () => bridge.startHfDownload({ repoId: "Qwen/Qwen2.5-0.5B-Instruct" }),
    err => err.code === "TARGET_DIR_REQUIRED"
  );
  await assert.rejects(
    () => bridge.startHfDownload({ repoId: "Qwen/Qwen2.5-0.5B-Instruct", targetDir: "" }),
    err => err.code === "TARGET_DIR_REQUIRED"
  );
  await assert.rejects(
    () => bridge.startHfDownload({ repoId: "Qwen/Qwen2.5-0.5B-Instruct", targetDir: "   " }),
    err => err.code === "TARGET_DIR_REQUIRED"
  );
  await assert.rejects(
    () => bridge.startHfDownload({ repoId: "Qwen/Qwen2.5-0.5B-Instruct", targetDir: "C:\\" }),
    err => err.code === "INVALID_TARGET_DIR"
  );
  await assert.rejects(
    () => bridge.startHfDownload({ repoId: "Qwen/Qwen2.5-0.5B-Instruct", targetDir: "C:\\models\\bad<name>" }),
    err => err.code === "INVALID_TARGET_DIR"
  );
  await assert.rejects(
    () => bridge.startHfDownload({ repoId: "", targetDir: "C:\\antigravityAS\\Modelos -ai-brains\\test" }),
    err => err.code === "REPO_ID_REQUIRED"
  );
});

test("hf_downloader.py rejects empty targetDir with NDJSON error and detects ONNX at depth <= 2", () => {
  const pyPath = path.join(__dirname, "..", "hf_downloader.py");

  let failed = false;
  try {
    execFileSync("python", [pyPath, "--repo-id", "test/model", "--target-dir", ""], {
      shell: false,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (err) {
    failed = true;
    assert.notEqual(err.status, 0);
    const parsed = JSON.parse(String(err.stdout || "").trim().split(/\r?\n/).pop());
    assert.equal(parsed.event, "error");
    assert.ok(parsed.error.length > 0);
  }
  assert.equal(failed, true);

  const tmp = makeTempDir("studio-onnx-");
  try {
    const depth2 = path.join(tmp, "directml", "int4");
    const depth3 = path.join(tmp, "a", "b", "c");
    fs.mkdirSync(depth2, { recursive: true });
    fs.mkdirSync(depth3, { recursive: true });
    fs.writeFileSync(path.join(depth2, "genai_config.json"), "{}");
    fs.writeFileSync(path.join(depth2, "model.onnx"), "dummy");
    fs.writeFileSync(path.join(depth3, "genai_config.json"), "{}");
    fs.writeFileSync(path.join(depth3, "model.onnx"), "dummy");

    const out = execFileSync(
      "python",
      [
        "-c",
        "import json, sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); import hf_downloader; print(json.dumps(hf_downloader.detect_onnx_dirs(Path(sys.argv[2]), 2)))",
        path.join(__dirname, ".."),
        tmp
      ],
      { shell: false, encoding: "utf-8" }
    ).trim();

    const dirs = JSON.parse(out);
    assert.equal(dirs.length, 1);
    assert.equal(path.resolve(dirs[0]), path.resolve(depth2));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("listHfDownloads, getHfDownload, and cancelHfDownload integrate cleanly with memory-store", () => {
  memoryStore.upsertDownload({
    jobId: "hf_dummy_1",
    repoId: "test/model",
    status: "completed",
    progress: 100
  });
  const list = bridge.listHfDownloads();
  assert.ok(list.some(d => (d.jobId || d.id) === "hf_dummy_1"));

  const item = bridge.getHfDownload("hf_dummy_1");
  assert.ok(item);
  assert.equal(item.status, "completed");

  const cancelRes = bridge.cancelHfDownload("hf_dummy_1");
  assert.equal(cancelRes.ok, false);
  assert.equal(cancelRes.cancelled, false);
});

test("Read-only smoke test: getGitHubStatusAndRepos returns ok: true without leaking tokens", async (t) => {
  if (process.env.LOCAL_AI_OFFLINE_TESTS === "1" || (!process.env.GITHUB_TOKEN && !process.env.GH_TOKEN)) return t.skip("Smoke test con red/credenciales deshabilitado en este entorno");
  const res1 = await bridge.getGitHubStatusAndRepos(path.join(__dirname, ".."), true);
  assert.equal(res1.ok, true);
  assert.equal(res1.configured, true);
  assert.ok(res1.user && res1.user.login);
  assert.ok(Array.isArray(res1.repos));
  assertNoSecretsInJson(res1);

  const res2 = await bridge.getGitHubStatusAndRepos(path.join(__dirname, ".."), false);
  assert.equal(res2.ok, true);
  assert.equal(res2.cached, true);
  assertNoSecretsInJson(res2);
});

test("Read-only smoke test: getNetlifyStatusAndSites returns ok: true without leaking tokens", async (t) => {
  if (process.env.LOCAL_AI_OFFLINE_TESTS === "1" || (!process.env.NETLIFY_AUTH_TOKEN && !process.env.NETLIFY_PERSONAL_ACCESS_TOKEN && !process.env.NETLIFY_TOKEN)) return t.skip("Smoke test con red/credenciales deshabilitado en este entorno");
  const res1 = await bridge.getNetlifyStatusAndSites(null, true);
  assert.equal(res1.ok, true);
  assert.equal(res1.configured, true);
  assert.ok(res1.user);
  assert.ok(Array.isArray(res1.sites));
  assertNoSecretsInJson(res1);

  const res2 = await bridge.getNetlifyStatusAndSites(null, false);
  assert.equal(res2.ok, true);
  assert.equal(res2.cached, true);
  assertNoSecretsInJson(res2);
});

test("Read-only smoke test: searchHuggingFace returns ok: true and valid mapped fields", async (t) => {
  if (process.env.LOCAL_AI_OFFLINE_TESTS === "1") return t.skip("Red deshabilitada en este entorno");
  const resModels = await bridge.searchHuggingFace({ query: "onnx", type: "model", limit: 3 });
  assert.equal(resModels.ok, true);
  assert.equal(resModels.type, "model");
  assert.ok(Array.isArray(resModels.items));
  assert.ok(resModels.items.length > 0);
  const first = resModels.items[0];
  assert.ok(first.id);
  assert.equal(typeof first.downloads, "number");
  assert.equal(typeof first.likes, "number");
  assert.equal(typeof first.gated, "boolean");
  assert.equal(typeof first.private, "boolean");
  assert.ok(Array.isArray(first.tags) && first.tags.length <= 8);
  assert.equal(first.suggestedDir.startsWith(bridge.DEFAULT_MODELS_DIR), true);
  assertNoSecretsInJson(resModels);

  const resDatasets = await bridge.searchHuggingFace({ query: "", type: "dataset", limit: 2 });
  assert.equal(resDatasets.ok, true);
  assert.equal(resDatasets.type, "dataset");
  assert.ok(resDatasets.items.length > 0);
  assertNoSecretsInJson(resDatasets);
});

test("SerpApi: valida query vacía y entorno sin llaves con aislamiento Zero-Trust", async () => {
  await withIsolatedSerpEnv({}, async () => {
    const emptyRes = await bridge.searchWebSerpApi({
      query: "   ",
      fetchImpl: () => {
        throw new Error("No debe invocar fetch con query vacía");
      }
    });
    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.attempts, 0);
    assert.match(emptyRes.error, /vacía/i);

    const statusEmpty = bridge.getSerpApiStatus();
    assert.equal(statusEmpty.ok, true);
    assert.equal(statusEmpty.configured, false);
    assert.equal(statusEmpty.totalKeysCount, 0);

    const unconfRes = await bridge.searchWebSerpApi({
      query: "directml onnx",
      fetchImpl: () => {
        throw new Error("No debe invocar fetch sin llaves configuradas");
      }
    });
    assert.equal(unconfRes.ok, false);
    assert.equal(unconfRes.configured, false);
    assert.equal(unconfRes.attempts, 0);
    assertNoSecretsInJson(unconfRes);
  });
});

test("SerpApi: enrutamiento por pools (web/news vs jobs), conteo de uso, status y reset sin red real", async () => {
  const fakeWebKey = "serp_fake_web_key_9876543210abcdef";
  const fakeJobsKey = "serp_fake_jobs_key_1234567890abcdef";

  await withIsolatedSerpEnv(
    {
      SERPAPI_NEWS_KEY: fakeWebKey,
      SERPAPI_JOBS_KEY: fakeJobsKey
    },
    async () => {
      bridge.resetSerpApiUsage("all");

      const calls = [];
      const mockFetch = async (rawUrl) => {
        const u = new URL(rawUrl);
        calls.push({
          engine: u.searchParams.get("engine"),
          q: u.searchParams.get("q"),
          apiKey: u.searchParams.get("api_key")
        });
        const engine = u.searchParams.get("engine");
        if (engine === "google_jobs") {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              jobs_results: [
                {
                  title: "AI Engineer",
                  company_name: "Acme Lab",
                  location: "Remoto",
                  description: "Trabajo con ONNX DirectML",
                  share_link: "https://jobs.example.com/1"
                }
              ]
            })
          };
        }
        if (engine === "google_news") {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              news_results: [
                {
                  title: "Noticia Ryzen AI",
                  link: "https://news.example.com/ryzen",
                  snippet: "Actualización ROCm e iGPU",
                  source: { name: "TechNews" },
                  date: "2026-11-09"
                }
              ]
            })
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            organic_results: [
              {
                title: "Documentación DirectML",
                link: "https://docs.example.com/dml",
                snippet: "Guía oficial DirectML",
                source: "Docs"
              }
            ]
          })
        };
      };

      const webRes = await bridge.searchWebSerpApi({ query: "directml docs", mode: "web", fetchImpl: mockFetch });
      assert.equal(webRes.ok, true);
      assert.equal(webRes.engine, "google");
      assert.equal(webRes.poolUsed, "web");
      assert.equal(webRes.totalResults, 1);
      assert.ok(webRes.contextBlock.includes("<busqueda_web_en_tiempo_real"));
      assertNoSecretsInJson(webRes, [fakeWebKey, fakeJobsKey]);

      const newsRes = await bridge.searchWebSerpApi({ query: "ryzen ai", mode: "news", fetchImpl: mockFetch });
      assert.equal(newsRes.ok, true);
      assert.equal(newsRes.engine, "google_news");
      assert.equal(newsRes.poolUsed, "web");
      assertNoSecretsInJson(newsRes, [fakeWebKey, fakeJobsKey]);

      const jobsRes = await bridge.searchWebSerpApi({ query: "ai engineer", mode: "jobs", fetchImpl: mockFetch });
      assert.equal(jobsRes.ok, true);
      assert.equal(jobsRes.engine, "google_jobs");
      assert.equal(jobsRes.poolUsed, "jobs");
      assert.equal(jobsRes.results[0].source, "Acme Lab");
      assertNoSecretsInJson(jobsRes, [fakeWebKey, fakeJobsKey]);

      assert.equal(calls.length, 3);
      assert.equal(calls[0].apiKey, fakeWebKey);
      assert.equal(calls[1].apiKey, fakeWebKey);
      assert.equal(calls[2].apiKey, fakeJobsKey);

      const statusMid = bridge.getSerpApiStatus();
      assert.equal(statusMid.configured, true);
      assert.equal(statusMid.webKeysCount, 1);
      assert.equal(statusMid.jobsKeysCount, 1);
      assert.equal(statusMid.totalKeysCount, 2);
      assert.equal(statusMid.usage.webUses, 2);
      assert.equal(statusMid.usage.jobsUses, 1);
      assertNoSecretsInJson(statusMid, [fakeWebKey, fakeJobsKey]);

      const resetJobs = bridge.resetSerpApiUsage("jobs");
      assert.equal(resetJobs.ok, true);
      assert.equal(resetJobs.pool, "jobs");
      assert.equal(resetJobs.usage.webUses, 2);
      assert.equal(resetJobs.usage.jobsUses, 0);

      const resetAll = bridge.resetSerpApiUsage("all");
      assert.equal(resetAll.ok, true);
      assert.equal(resetAll.usage.webUses, 0);
      assert.equal(resetAll.usage.jobsUses, 0);
    }
  );
});

test("SerpApi: rota llave ante HTTP 429 o error rotatorio, NO rota ante AbortError y redacta secretos en errores", async () => {
  const key1 = "serp_key_one_SECRET_1111111111";
  const key2 = "serp_key_two_SECRET_2222222222";

  await withIsolatedSerpEnv(
    {
      SERPAPI_NEWS_KEY: key1,
      SERPAPI_JOBS_KEY: key2
    },
    async () => {
      bridge.resetSerpApiUsage("all");

      // 1. Failover ante HTTP 429
      const seen429 = [];
      const res429Failover = await bridge.searchWebSerpApi({
        query: "failover 429",
        mode: "web",
        fetchImpl: async (rawUrl) => {
          const k = new URL(rawUrl).searchParams.get("api_key");
          seen429.push(k);
          if (seen429.length === 1) {
            return {
              ok: false,
              status: 429,
              text: async () => JSON.stringify({ error: `Rate limit exceeded for ${rawUrl}` })
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              organic_results: [{ title: "OK Backup Key", link: "https://ok.example.com", snippet: "Funciona", source: "OK" }]
            })
          };
        }
      });
      assert.equal(res429Failover.ok, true);
      assert.equal(res429Failover.attempts, 2);
      assert.equal(res429Failover.poolUsed, "jobs");
      assert.deepEqual(seen429, [key1, key2]);
      assertNoSecretsInJson(res429Failover, [key1, key2]);

      // 2. Failover ante error JSON HTTP 200 rotatorio ("run out of searches")
      const seenQuota = [];
      const resQuotaFailover = await bridge.searchWebSerpApi({
        query: "failover quota",
        mode: "web",
        fetchImpl: async (rawUrl) => {
          seenQuota.push(new URL(rawUrl).searchParams.get("api_key"));
          if (seenQuota.length === 1) {
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ error: `Your account has run out of searches (${key1})` })
            };
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
              organic_results: [{ title: "Second Key Success", link: "https://ok2.example.com", snippet: "Fallback OK", source: "OK2" }]
            })
          };
        }
      });
      assert.equal(resQuotaFailover.ok, true);
      assert.equal(resQuotaFailover.attempts, 2);
      assertNoSecretsInJson(resQuotaFailover, [key1, key2]);

      // 3. NO rotación ante AbortError / timeout (debe fallar rápido en intento 1) y redactar secreto si aparece en error
      let abortCalls = 0;
      const resAbort = await bridge.searchWebSerpApi({
        query: "timeout no rotation",
        mode: "web",
        fetchImpl: async (rawUrl) => {
          abortCalls += 1;
          const err = new Error(`Aborted request to ${rawUrl} using ${key1}`);
          err.name = "AbortError";
          throw err;
        }
      });
      assert.equal(abortCalls, 1, "AbortError/timeout NO debe rotar a llaves secundarias");
      assert.equal(resAbort.ok, false);
      assert.equal(resAbort.attempts, 1);
      assert.equal(resAbort.error.includes(key1), false, "El mensaje de error nunca debe exponer la llave API");
      assert.equal(resAbort.error.includes("[REDACTED]"), true);
      assertNoSecretsInJson(resAbort, [key1, key2]);
    }
  );
});
