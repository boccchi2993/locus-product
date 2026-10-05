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
  // M3c review round 2 F2: the negative self-proof judge (one
  // implementation shared with the packaged storage gate's driver).
  'm3c-storage-built-verdict.test.cjs',
  // M3c review A: browser-gate orchestrator fault-path suite (real-preview
  // test stays gated behind BROWSER_GATE_ORCH_REAL_PREVIEW=1).
  'browser-gate-orchestrator.test.cjs',
  // M3c review round 3: the cleanup helper's platform branches under
  // scripted OS calls (isolated VM — the Windows branch executes on any
  // platform, the POSIX algorithm is pinned unchanged).
  'browser-gate-cleanup-branch.test.cjs',
  // M3c integration: the three parallel agents' dedicated gates (D wiring).
  'm3c-runtime-adapter.test.mjs',
  'm3c-storage-adapters.test.mjs',
  'm3c-product-wiring.test.mjs',
  // M4a-A: core-main candidate capture/apply/verify battery — faked npm/git
  // transports, so the real candidate tool is exercised only in rehearsals.
  'core-main-candidate.test.mjs',
  // M4a review A (F1): the candidate workflow's static shape — every run
  // block scanned for `${{`/eval/bash -c, inputs.* only in env value
  // positions, capture step carries no mode flags. Registered by D.
  'core-main-candidate-workflow.test.mjs',
  // M4a-B: production-graph ownership gate — closure from the real entry;
  // fault-injection self-proofs run in OS-temp trees, never this worktree.
  'm4a-product-ownership.test.cjs',
  // M4a-C: mainline preflight classification matrix over a faked GitHub API
  // (M4a-C shipped it standalone; registered here so the matrix regresses
  // with the rest — the real tool stays GET-only and is not run by this).
  'm4a-mainline-preflight.test.cjs',
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
