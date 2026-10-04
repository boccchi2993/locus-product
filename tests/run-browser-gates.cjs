// M3c review A: browser-gate orchestrator CLI (thin wrapper — all logic in
// tests/helpers/browser-gate-*.cjs). Builds the REAL dist/ bundle, serves it
// with `vite preview` (strict port 4173, started as a direct node child this
// run owns), then runs every browser gate exactly once against the packaged
// page/host pages:
//   - product-page gates (approval / capabilities / grep / image / network /
//     persistence / product-joint / python-authority /
//     python-browser-authority / python-plugin-runtime / responsive /
//     skill-instances / ui / wire) — the packaged app, ?e2e=1 seams;
//   - standalone packaged-entry host gates (runtime-host / harness-host /
//     python-bootstrap) — the cores' public entries as build inputs;
//   - the M3c storage-adapter browser suite (own host page, independent
//     Chrome lifecycle).
// No auto-retry: a first failure is the final verdict for this run and is
// folded into the aggregate exit code. Unknown suite names are a hard usage
// error (exit 2) — nothing is started. The run never calls process.exit
// inside the cleanup-protected section; the exit code below is applied only
// after the preview has been shut down (or its shutdown failure recorded and
// folded into a non-zero code). Usage: node tests/run-browser-gates.cjs [suite ...]
const { runBrowserGates } = require('./helpers/browser-gate-runner.cjs');

runBrowserGates({ requested: process.argv.slice(2) })
  .then((code) => { process.exit(code); })
  .catch((e) => {
    console.error('ORCHESTRATOR FAIL:', e && e.stack || e);
    process.exit(1);
  });
