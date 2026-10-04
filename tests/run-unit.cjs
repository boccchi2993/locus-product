// Runs every Node unit suite sequentially. No internet required.
// Usage: node tests/run-unit.cjs   (npm test)
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'persistence.test.cjs',
  'persistence-audit.test.cjs',
  'provider-replay-persistence.test.cjs',
  'proxy.test.mjs',
  'fetch.test.mjs',
  'runtime-visibility.test.cjs',
  'capability-composition.test.cjs',
  'capability-package.test.cjs',
  'skill-instances.test.cjs',
  'presentation.test.cjs',
  'store-defaults.test.cjs',
  'conversation-routing.test.mjs',
  'submit-presentation.test.mjs',
  'store-python-lifecycle.test.mjs',
  'harness-prompt-parity.test.mjs',
  'core-compatibility.test.mjs',
  'product-integration.test.mjs',
  'mutation-policy.test.cjs',
  'attachments.test.cjs',
  'capabilities.test.cjs',
  'chrome-helper.test.cjs',
  // M3c review A: browser-gate orchestrator fault-path suite (real-preview
  // test stays gated behind BROWSER_GATE_ORCH_REAL_PREVIEW=1).
  'browser-gate-orchestrator.test.cjs',
  // M3c integration: the three parallel agents' dedicated gates (D wiring).
  'm3c-runtime-adapter.test.mjs',
  'm3c-storage-adapters.test.mjs',
  'm3c-product-wiring.test.mjs',
];

let failed = 0;
for (const s of SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error('SUITE FAIL: ' + s);
  }
}
console.log('---');
console.log(failed ? failed + ' suite(s) FAILED' : 'all ' + SUITES.length + ' suites passed');
process.exit(failed ? 1 : 0);
