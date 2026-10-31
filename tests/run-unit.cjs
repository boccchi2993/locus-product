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
  // .locus archive container: pack/read/parse/verify round trip, the
  // hostile-zip diagnostic matrix (hand-built byte arrays), bounded
  // zip-bomb abort, truncation safety, Python-zipfile cross-check.
  'locus-archive.test.mjs',
  // Capability package install service (C1-P2, D10): inspect/commit
  // over the real archive + package core + manager, boot-time
  // verification, mismatch accept/skip, replacement rollback, uninstall,
  // the model-unreachable storage boundary (CI14), schema 4.
  'capability-install.test.mjs',
  // C4 §2.4: the import reports — pure service (format, filename/slug
  // rules, collision suffixes, newest-20 retention, write failures noted
  // and swallowed) plus the store-level inspect/commit/cancel/refusal
  // reports with the credential-key + commit-token redaction sweep.
  'capability-import-reports.test.mjs',
  // C3: the credential service (bindings, remembered values, restore /
  // afterReplace / uninstall cleanup) and the runtime credential port.
  'credentials.test.mjs',
  // C3: the FULL product credential chain — tool port → tools.js → real
  // runtime session → curl → the credential port (relay stub).
  'credential-wiring.test.mjs',
  // C3: persistent approvals ("Always allow") — persistence round trip,
  // controller restart, revoke, fail-closed, store-level list/revoke/reset.
  'approval-grants.test.mjs',
  'skill-instances.test.cjs',
  'presentation.test.cjs',
  'store-defaults.test.cjs',
  // Max output tokens setting (DECISIONS.md D5): defaults, string↔int
  // persistence round trip, session.setMaxTokens wiring and its guard.
  'max-tokens-settings.test.cjs',
  // Context-management wiring (P-2, DECISIONS.md D9): the three optional
  // harness capabilities and their degrade rules, the contextWindow
  // setting round trip + session wiring, the toolOutputs environment
  // note, the run-option toolOutputPath and the minimumRequestBytes
  // submit-time image pre-check.
  'context-management-wiring.test.mjs',
  // Token-calibration persistence (CONTEXT-MANAGEMENT.md §3.2, D5/D9):
  // the bytes-per-token samples survive a reload, tagged with the model
  // identity they were measured on and restored only for the SAME one.
  'token-calibration-persistence.test.mjs',
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
  // Virtual tool-output files in the /home/locus/history view: full
  // tool-result text served straight from the normalized rows, no copy.
  'history-tool-outputs.test.mjs',
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
  // Composer "+" menu (Capabilities cascade) + the global import dialog:
  // source-level structure gate pinning the menu surface the browser gate
  // drives (no Open terminal, cascade parent ARIA, global dialog, store
  // surface, independent scroll areas, <640px stepped boundary).
  'composer-menu-structure.test.cjs',
  // @-mentions (owner task 2026-10-29): the pure recognizer (boundaries,
  // terminator, backtrack, dedupe, fragments, popup trigger) and the
  // environment-notes line (ready/needs-connection ids, verbatim format,
  // set-determinism, ordering).
  'mentions.test.mjs',
  'product-prompt-mentions.test.mjs',
  // Markdown-lite extended rendering (owner task 2026-10-31): fenced code
  // blocks, ordered lists, GFM tables, protocol-allowlisted links,
  // sandbox: file-card slots, the injection sweep and the environment
  // note's file-delivery line.
  'markdown-render.test.mjs',
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
