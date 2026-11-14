const { spawnSync } = require('node:child_process');

const testFiles = [
  'tests/context_engine.test.js',
  'tests/context_patch.test.js',
  'tests/freeai_image.test.js',
  'tests/hardware_advisor.test.js',
  'tests/integrations_bridge.test.js',
  'tests/memory_store.test.js',
  'tests/master_prompts.test.js',
  'tests/wiring_audit.test.js',
  'tests/image_studio_wiring.test.js',
  'tests/staff_director.test.js',
  'tests/profiles_tree.test.js',
  'tests/profiles_save.test.js',
  'tests/sidetabs.test.js',
  'tests/agents_registry.test.js',
  'tests/server_api.test.js',
  'tests/tts_bridge.test.js',
  'tests/vibe_coding_100.test.js',
];

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  env: { ...process.env, LOCAL_AI_OFFLINE_TESTS: '1' },
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
