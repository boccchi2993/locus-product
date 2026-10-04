// The browser-gate run loop (m3c review A). Fixes over the previous
// inline orchestrator:
//  - requested suites are validated FIRST: unknown names are a hard
//    usage error (exit 2) and nothing is started — never a silent
//    filter-to-empty "all 0 browser gates passed";
//  - every suite runs EXACTLY ONCE. The CDP-flake auto-retry is gone:
//    a first failure is the final verdict for this run and is folded
//    into the aggregate exit code;
//  - this function RETURNS an exit code. process.exit is never called
//    inside the try/finally-protected run — the CLI sets process.exitCode
//    only after cleanup has finished;
//  - spawn errors, non-zero exits, signal exits and hung suites (bounded
//    wall clock per suite, default well above every suite's internal
//    Python/CDP budgets) are all captured and classified;
//  - the preview port is bind-probed before start (busy port = explicit
//    refusal, no takeover of a foreign/stale service) and readiness
//    requires OUR process alive + HTTP + OUR build token;
//  - cleanup touches only the preview tree this run started, and a
//    cleanup failure fails the run — it can never be reported as a
//    clean pass.
// Every collaborator is injectable for tests; defaults are the real ones.
const path = require('path');
const { spawn } = require('child_process');
const { SUITES, resolveSuites } = require('./browser-gate-suites.cjs');
const preview = require('./browser-gate-preview.cjs');

// Per-suite wall clock. Generous on purpose: the suites own their internal
// budgets (CDP readiness windows, Python bootstrap cold/ready phases) and
// this bound must never shorten them — it only catches a hung process.
const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60 * 1000;

// Runs one suite as a direct child process (node <suite>, stdio inherited).
// Resolves a classified result; never throws:
//   { ok: true }
//   { ok: false, kind: 'exit', code }        — non-zero exit
//   { ok: false, kind: 'signal', signal }    — killed by a signal
//   { ok: false, kind: 'timeout', timeoutMs } — wall clock exceeded (tree-killed)
//   { ok: false, kind: 'spawn-error', error } — could not even start
function runSuiteProcess(suitePath, timeoutMs = DEFAULT_SUITE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    try {
      // POSIX: own process group, so a timeout killTree(-pid) reaches the
      // suite's own children (e.g. headless Chrome), not just the suite.
      child = spawn(process.execPath, [suitePath], { stdio: 'inherit', windowsHide: true, detached: process.platform !== 'win32' });
    } catch (e) {
      resolve({ ok: false, kind: 'spawn-error', error: e });
      return;
    }
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      preview.killTree(child.pid);
    }, timeoutMs);
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, kind: 'spawn-error', error: err });
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) return resolve({ ok: false, kind: 'timeout', timeoutMs });
      if (signal) return resolve({ ok: false, kind: 'signal', signal });
      resolve({ ok: code === 0, kind: 'exit', code });
    });
  });
}

function describeResult(r) {
  if (r.kind === 'exit') return ' (exit ' + r.code + ')';
  if (r.kind === 'signal') return ' (killed by signal ' + r.signal + ')';
  if (r.kind === 'timeout') return ' (timed out after ' + r.timeoutMs + 'ms)';
  if (r.kind === 'spawn-error') return ' (spawn failed: ' + (r.error && r.error.code || r.error) + ')';
  return '';
}

async function runBrowserGates(opts = {}) {
  const {
    requested = [],
    registry = SUITES,
    rootDir = path.join(__dirname, '..', '..'),
    suiteDir = path.join(__dirname, '..'),
    build = (o) => preview.buildDist(o),
    readBuildToken = (o) => preview.readDistAssetToken(o),
    startPreview = preview.startPreview,
    runSuite = runSuiteProcess,
    port = Number(process.env.BROWSER_GATE_PORT || 4173),
    suiteTimeoutMs = Number(process.env.BROWSER_GATE_SUITE_TIMEOUT_MS || DEFAULT_SUITE_TIMEOUT_MS),
    log = console.log,
    error = console.error,
  } = opts;

  // 1) Validate BEFORE anything starts.
  const { suites, unknown } = resolveSuites(requested, registry);
  if (unknown.length) {
    error('UNKNOWN SUITES: ' + unknown.join(', '));
    error('known suites: ' + registry.join(', '));
    return 2;
  }

  // 2) Refuse a busy port BEFORE spending a build. A stale service left
  // by an earlier run or another worktree is the operator's to stop; this
  // orchestrator never kills processes it did not start.
  if (!(await preview.portIsFree(port))) {
    error('PORT ' + port + ' ALREADY IN USE before start — refusing to run. ' +
      'A foreign/stale service is holding the port; stop it yourself. ' +
      'This orchestrator never takes over or kills a process it did not start.');
    return 1;
  }

  // 3) Build. A failed build never reaches a preview.
  log('=== browser gates: vite build ===');
  const buildResult = await build({ cwd: rootDir });
  if (!buildResult.ok) {
    error('BUILD FAILED\n' + (buildResult.output || '(no output)'));
    return 1;
  }
  let buildToken = null;
  try {
    buildToken = readBuildToken({ cwd: rootDir });
  } catch (e) {
    buildToken = null;
  }
  if (!buildToken) {
    error('warning: no built asset token found in dist/index.html — readiness content-identity check is degraded');
  }

  // 4) Start and OWN one preview server for the whole run.
  log('=== browser gates: vite preview (port ' + port + ') ===');
  const server = await startPreview({ cwd: rootDir, port, buildToken });

  let gateFailed = false;
  const failures = [];
  try {
    try {
      await server.waitReady(30000, buildToken);
    } catch (e) {
      error('PREVIEW NOT READY: ' + (e && e.message || e));
      return 1; // finally below still shuts down our tree
    }

    for (const s of suites) {
      if (!server.isAlive()) {
        gateFailed = true;
        const remaining = suites.slice(suites.indexOf(s));
        for (const x of remaining) failures.push(x + ' (not run: preview died)');
        error('PREVIEW DIED — aborting remaining suites (infrastructure failure, not a gate verdict): ' + remaining.join(', '));
        break;
      }
      log('\n=== e2e: ' + s + ' ===');
      const r = await runSuite(path.join(suiteDir, s), suiteTimeoutMs);
      if (r.ok) {
        log('>>> SUITE PASS: ' + s);
        continue;
      }
      // No retry. First failure = final verdict for this run.
      gateFailed = true;
      failures.push(s + describeResult(r));
      log('>>> SUITE FAIL: ' + s);
    }

    log('\n=== browser gates summary ===');
    if (failures.length) log('FAILED (' + failures.length + '): ' + failures.join(', '));
    else log('all ' + suites.length + ' browser gates passed');
  } finally {
    // Only ever touches the tree this run started.
    let cleanup = { ok: true };
    try {
      cleanup = await server.kill();
    } catch (e) {
      cleanup = { ok: false, error: e };
    }
    if (!cleanup.ok) {
      error('CLEANUP FAILED: ' + (cleanup.error && cleanup.error.message || cleanup.error) +
        ' — the run is NOT a clean pass even if every gate passed');
      gateFailed = true;
    }
  }

  return gateFailed ? 1 : 0;
}

module.exports = { DEFAULT_SUITE_TIMEOUT_MS, runSuiteProcess, runBrowserGates };
