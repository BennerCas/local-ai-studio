const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const contextEngine = require("../context-engine.js");

test("context-engine indexa texto, prioriza el objetivo y divide tandas", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-context-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"demo"}\n');
    fs.writeFileSync(path.join(root, "src", "chat.js"), "function streamChat(){ return 'context compiler'; }\n".repeat(20));
    fs.writeFileSync(path.join(root, "notes.txt"), "unrelated note\n".repeat(20));
    const index = contextEngine.buildIndex(root, { persist: false });
    const plan = contextEngine.plan(root, "streamChat context compiler", { budgetTokens: 140, persist: false, maxFiles: 4 });
    assert.equal(index.fileCount, 3);
    assert.ok(plan.selectedFiles.includes("src/chat.js"));
    assert.ok(plan.batchCount >= 1);
    assert.ok(plan.batches.every((batch) => batch.approxTokens > 0));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context-engine nunca supera el tope operativo de 6k tokens aunque se solicite más", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "local-ai-context-limit-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    for (let i = 0; i < 30; i += 1) {
      fs.writeFileSync(
        path.join(root, "src", `module-${i}.js`),
        `export const module${i} = ${JSON.stringify("relevant context ".repeat(500))};\n`
      );
    }
    const plan = contextEngine.plan(root, "relevant context", {
      budgetTokens: 12000,
      persist: false,
      maxFiles: 30
    });
    assert.equal(contextEngine.CONTEXT_BUILDER_MAX_TOKENS, 6000);
    assert.equal(plan.budgetTokens, 6000);
    assert.ok(plan.approxTokens <= 6000);
    assert.ok(plan.totalChars <= 6000 * 4);
    assert.equal(plan.projectMap.fileCount, 30);
    assert.equal(plan.coverage.indexedFiles, 30);
    assert.equal(plan.coverage.confidence, "reliable");

    const manual = contextEngine.plan(root, "irrelevant", {
      budgetTokens: 6000,
      selectedFiles: ["src/module-0.js"],
      onlySelected: true,
      persist: false
    });
    assert.deepEqual(manual.selectedFiles, ["src/module-0.js"]);
    const manualLate = contextEngine.plan(root, "irrelevant", {
      budgetTokens: 6000,
      selectedFiles: ["src/module-29.js"],
      onlySelected: true,
      maxFiles: 1,
      persist: false
    });
    assert.deepEqual(manualLate.selectedFiles, ["src/module-29.js"]);
    assert.equal(manualLate.coverage.indexedFiles, 30);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context-engine redacta secretos antes de compilar en nube", () => {
  const clean = contextEngine.redactSecrets("Authorization: Bearer sk-secret-value\nGROQ_API_KEY=gsk_1234567890");
  assert.match(clean, /Bearer \[REDACTED\]/);
  assert.doesNotMatch(clean, /sk-secret-value|gsk_1234567890/);
});
