// Browser-gate orchestrator unit gate (m3c review A).
// Covers the test-infrastructure fixes in tests/run-browser-gates.cjs via
// the narrow seams of tests/helpers/browser-gate-*.cjs: suite validation,
// exactly-once no-retry execution, exit-code plumbing (no process.exit
// inside the protected run), preview ownership (refuse a busy port, never
// kill foreign processes), bounded readiness with build identity, and REAL
// subprocess cleanup — tree-kill must actually terminate processes and
// release ports, never just "kill was called".
// All subprocesses are tiny node fixtures (no model/relay/Chrome); every
// process this file spawns is tracked and force-cleaned in finally; all
// waits are bounded and labeled.
//
// Run: node tests/browser-gate-orchestrator.test.cjs
// (Registration in tests/run-unit.cjs is m3c-D's handoff — docs/M3C-REVIEW-A.md.)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const runner = require('./helpers/browser-gate-runner.cjs');
const preview = require('./helpers/browser-gate-preview.cjs');
const cleanup = require('./helpers/browser-gate-cleanup.cjs');
const { SUITES } = require('./helpers/browser-gate-suites.cjs');

const ROOT_DIR = path.join(__dirname, '..');
const TEST_TIMEOUT_MS = 30000;
const WATCHDOG_MS = 120000;

// ---------------------------------------------------------------------------
// harness

let failed = 0;
let skipped = 0;
const trackedChildren = []; // { pid, label }

function track(child, label) {
  trackedChildren.push({ pid: child.pid, label });
  return child;
}

// Emergency backstop: SIGKILL the OWNED groups/pids this file spawned (test
// fixtures only — never strangers). TERM alone cannot be trusted: F1's
// fixtures deliberately ignore it.
function sweepTracked() {
  for (const t of trackedChildren) {
    try { cleanup.forceKillIdentity(cleanup.ownTreeIdentity(t.pid)); } catch (e) { /* gone */ }
  }
}

const watchdog = setTimeout(() => {
  console.error('WATCHDOG: test run exceeded ' + WATCHDOG_MS + 'ms — killing tracked children, failing hard');
  sweepTracked();
  setTimeout(() => process.exit(9), 500);
}, WATCHDOG_MS);

function check(name, cond, detail) {
  if (cond) return;
  failed++;
  console.error('  CHECK FAIL: ' + name + (detail ? ' — ' + detail : ''));
}

async function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT(' + ms + 'ms): ' + label)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    clearTimeout(timer);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ port: 0, host: '127.0.0.1' }, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// ---------------------------------------------------------------------------
// fixtures (tiny real node processes; no vite, no Chrome)

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-orch-fixtures-'));
const invFile = path.join(fixtureDir, 'invocations.log');
const pidFile = path.join(fixtureDir, 'pids.json');
const termLog = path.join(fixtureDir, 'terms.log');
process.env.INV_LOG = invFile;
process.env.PID_FILE = pidFile;
process.env.TERM_LOG = termLog;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function resetTermLog() {
  try { fs.rmSync(termLog, { force: true }); } catch (e) { /* fresh anyway */ }
}

function termReceipts() {
  if (!fs.existsSync(termLog)) return [];
  return fs.readFileSync(termLog, 'utf8').split(/\r?\n/).filter(Boolean);
}

// Wait for an explicit readiness barrier (a ready FILE the fixture writes
// at its own ready point) — never "sleep a bit and assume it started".
async function waitForReadyFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(file)) return;
    if (Date.now() > deadline) throw new Error('ready barrier not reached: ' + label);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// On Windows the child 'exit' event can lag a completed taskkill by a few
// hundred ms; aliveness assertions poll instead of checking once.
async function waitDead(handle, ms = 5000) {
  const deadline = Date.now() + ms;
  while (handle.isAlive() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return !handle.isAlive();
}

function invocations() {
  if (!fs.existsSync(invFile)) return [];
  return fs.readFileSync(invFile, 'utf8').split(/\r?\n/).filter(Boolean);
}

// The invocation log accumulates across tests by design; tests that assert
// on it reset it first so they only see their own fixtures' appends.
function resetInvocations() {
  try { fs.rmSync(invFile, { force: true }); } catch (e) { /* fresh anyway */ }
}

const SERVER_SRC = `
const http = require('http');
const fs = require('fs');
const port = Number(process.env.FIX_PORT);
const token = process.env.FIX_TOKEN_MODE === 'foreign' ? 'assets/index-foreignhash.js' : 'assets/index-fakehash.js';
// F1 fixtures: a server that IGNORES SIGTERM (recording the receipt), and
// an explicit ready-file barrier written at ITS OWN ready point.
if (process.env.FIX_IGNORE_TERM && process.env.TERM_LOG) {
  process.on('SIGTERM', () => {
    try { fs.appendFileSync(process.env.TERM_LOG, 'term:' + process.pid + '\\n'); } catch (e) { /* best effort */ }
  });
}
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<html><body><script type="module" src="/' + token + '"></script></body></html>');
});
srv.listen(port, '127.0.0.1', () => {
  console.log('fixture server up on ' + port);
  if (process.env.FIX_READY_FILE) {
    try { fs.writeFileSync(process.env.FIX_READY_FILE, String(process.pid)); } catch (e) { /* best effort */ }
  }
});
`;

function writeFixture(name, src) {
  fs.writeFileSync(path.join(fixtureDir, name), src);
}

writeFixture('fixture-server.cjs', SERVER_SRC);

// Suite fixtures: append to the invocation log so "ran exactly once" and
// ordering are provable from disk, not from spies.
function suiteSrc(name, exitCode) {
  return `
const fs = require('fs');
fs.appendFileSync(process.env.INV_LOG, ${JSON.stringify(name)} + '\\n');
process.exit(${exitCode});
`;
}
writeFixture('pass-a.cjs', suiteSrc('pass-a', 0));
writeFixture('pass-b.cjs', suiteSrc('pass-b', 0));
writeFixture('pass-c.cjs', suiteSrc('pass-c', 0));
writeFixture('fail-a.cjs', suiteSrc('fail-a', 3));
writeFixture('sigkill.cjs', `
const fs = require('fs');
fs.appendFileSync(process.env.INV_LOG, 'sigkill\\n');
process.kill(process.pid, 'SIGKILL');
`);
writeFixture('hang.cjs', `
const fs = require('fs');
fs.appendFileSync(process.env.INV_LOG, 'hang\\n');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
setInterval(() => {}, 1000);
`);
// F1 test B fixture: a REAL suite process that RECEIVES SIGTERM and keeps
// running (empty-ish handler records the receipt and stays alive) — the
// exact shape that hung the old timeout path forever on POSIX.
writeFixture('term-ignore-stubborn.cjs', `
const fs = require('fs');
fs.appendFileSync(process.env.INV_LOG, 'term-ignore-stubborn\\n');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
if (process.env.TERM_LOG) {
  process.on('SIGTERM', () => {
    try { fs.appendFileSync(process.env.TERM_LOG, 'term:' + process.pid + '\\n'); } catch (e) { /* keep running */ }
  });
}
setInterval(() => {}, 1000);
`);
// F1 test E fixture: natural exit after a bounded delay (timeout vs exit
// race).
writeFixture('exit-after-ms.cjs', `
const fs = require('fs');
fs.appendFileSync(process.env.INV_LOG, 'exit-after:' + String(process.env.EXIT_AFTER_MS) + '\\n');
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER_MS || 300));
`);
// Parent that spawns a listening child and stays alive: the REAL tree-kill
// target (proves cleanup reaches grandchildren, not just the root pid).
writeFixture('parent-with-child.cjs', `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const child = spawn(process.execPath, [path.join(__dirname, 'fixture-server.cjs')], {
  env: process.env, stdio: 'ignore',
});
fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ parent: process.pid, child: child.pid }));
setInterval(() => {}, 1000);
`);
// F1 test C fixture: the root EXITS ITSELF after its (SIGTERM-ignoring,
// port-holding) child is ready — the owned group outlives the root, which
// must NOT shortcut cleanup to ok.
writeFixture('group-orphan-parent.cjs', `
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const child = spawn(process.execPath, [path.join(__dirname, 'fixture-server.cjs')], {
  env: process.env, stdio: 'ignore',
});
const t0 = Date.now();
(function waitReadyThenExit() {
  const ready = process.env.FIX_READY_FILE && fs.existsSync(process.env.FIX_READY_FILE);
  if (ready || Date.now() - t0 > 10000) {
    try { fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ parent: process.pid, child: child.pid })); } catch (e) { /* best effort */ }
    process.exit(ready ? 0 : 7);
  }
  setTimeout(waitReadyThenExit, 50);
})();
`);

// A "preview" handle backed by a REAL child process (the fixture server),
// wired through the SAME verified cleanup the real startPreview uses now
// (waitHealthy readiness incl. build token; browser-gate-cleanup.cjs
// bounded terminate + confirm — never a bare signal).
function makeRealServerPreview(port, tokenMode) {
  const child = track(spawn(process.execPath, [path.join(fixtureDir, 'fixture-server.cjs')], {
    env: { ...process.env, FIX_PORT: String(port), FIX_TOKEN_MODE: tokenMode },
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  }), 'fixture-server(port ' + port + ')');
  const identity = cleanup.ownTreeIdentity(child.pid);
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve({ code, signal }); });
  });
  let killPromise = null;
  const handle = {
    pid: child.pid,
    isAlive: () => exitInfo === null,
    async waitReady(timeoutMs, expectToken) {
      await preview.waitHealthy({
        url: 'http://127.0.0.1:' + port + '/',
        expectToken,
        isAlive: handle.isAlive,
        timeoutMs,
        label: 'fixture preview (port ' + port + ')',
      });
    },
    async kill() {
      if (!killPromise) {
        killPromise = (async () => {
          const r = await cleanup.terminateTree(identity, { termGraceMs: 3000, killConfirmMs: 5000 });
          await Promise.race([exited, preview.waitForPidExit(child.pid, 5000)]);
          return r;
        })();
      }
      return killPromise;
    },
  };
  return handle;
}

async function waitUntilResponding(port, timeoutMs, label) {
  await preview.waitHealthy({
    url: 'http://127.0.0.1:' + port + '/',
    expectToken: null,
    isAlive: () => true,
    timeoutMs,
    label,
  });
}

// Silence runner chatter per test; capture error lines for assertions.
function captureErrors(store) {
  return (line) => { store.push(String(line)); };
}

// ---------------------------------------------------------------------------
// tests

const tests = [];

tests.push(['registry: default suite list (14 original + review-round registrations)', async () => {
  const expected = [
    'e2e-ui.cjs', 'e2e-responsive.cjs', 'e2e-grep.cjs', 'e2e-approval.cjs',
    'e2e-network.cjs', 'e2e-capabilities.cjs', 'e2e-image.cjs',
    'e2e-skill-instances.cjs', 'e2e-persistence.cjs', 'e2e-wire.cjs',
    'e2e-product-joint.cjs', 'e2e-runtime-host.cjs', 'e2e-harness-host.cjs',
    'e2e-m3c-storage-adapters.cjs',
    'e2e-m3c-storage-built.cjs', 'e2e-m3c-python-integration.cjs',
  ];
  check('default list intact', JSON.stringify(SUITES) === JSON.stringify(expected), JSON.stringify(SUITES));
  check('empty request -> full list', JSON.stringify(require('./helpers/browser-gate-suites.cjs').resolveSuites([]).suites) === JSON.stringify(expected));
  const r = require('./helpers/browser-gate-suites.cjs').resolveSuites(['e2e-ui.cjs']);
  check('explicit request -> that suite only', JSON.stringify(r.suites) === JSON.stringify(['e2e-ui.cjs']) && r.unknown.length === 0);
  const mixed = require('./helpers/browser-gate-suites.cjs').resolveSuites(['e2e-ui.cjs', 'nope.cjs']);
  check('mixed request flags unknown', mixed.unknown.length === 1 && mixed.unknown[0] === 'nope.cjs' && mixed.suites.length === 1);
}]);

tests.push(['unknown suites: exit 2, nothing started (seam)', async () => {
  const calls = { build: 0, start: 0, suite: 0 };
  const errors = [];
  const code = await runner.runBrowserGates({
    requested: ['e2e-ui.cjs', 'not-a-suite.cjs', 'also-missing.cjs'],
    registry: SUITES,
    build: async () => { calls.build++; return { ok: true, output: '' }; },
    startPreview: async () => { calls.start++; throw new Error('preview must not be started'); },
    runSuite: async () => { calls.suite++; return { ok: true }; },
    log: () => {},
    error: captureErrors(errors),
  });
  check('exit code 2', code === 2, 'got ' + code);
  check('no build', calls.build === 0);
  check('no preview start', calls.start === 0);
  check('no suite spawned', calls.suite === 0);
  const joined = errors.join('\n');
  check('unknown names listed', joined.includes('not-a-suite.cjs') && joined.includes('also-missing.cjs'), joined);
}]);

tests.push(['all pass: exit 0, server exits, port released (real subprocess)', async () => {
  resetInvocations();
  const port = await freePort();
  const handle = makeRealServerPreview(port, 'match');
  const errors = [];
  const code = await withTimeout(runner.runBrowserGates({
    requested: ['pass-a.cjs', 'pass-b.cjs'],
    registry: ['pass-a.cjs', 'pass-b.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port,
    build: async () => ({ ok: true, output: 'fake build' }),
    readBuildToken: () => 'assets/index-fakehash.js',
    startPreview: async () => handle,
    log: () => {},
    error: captureErrors(errors),
  }), TEST_TIMEOUT_MS, 'all-pass run');
  check('exit 0', code === 0, 'code ' + code + '; errors: ' + errors.join(' | '));
  check('each suite ran exactly once, in order', JSON.stringify(invocations()) === JSON.stringify(['pass-a', 'pass-b']), JSON.stringify(invocations()));
  check('preview process dead after run', await waitDead(handle) === true);
  const still = await preview.httpGet('http://127.0.0.1:' + port + '/', 1500);
  check('port released (connection refused)', still === null, 'still answering: ' + JSON.stringify(still));
}]);

tests.push(['suite failure: runs exactly once, later suites still run, non-zero', async () => {
  resetInvocations();
  const port = await freePort();
  const handle = makeRealServerPreview(port, 'match');
  const logs = [];
  const code = await withTimeout(runner.runBrowserGates({
    requested: ['fail-a.cjs', 'pass-b.cjs'],
    registry: ['fail-a.cjs', 'pass-b.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port,
    build: async () => ({ ok: true, output: 'fake build' }),
    readBuildToken: () => 'assets/index-fakehash.js',
    startPreview: async () => handle,
    log: (l) => logs.push(String(l)),
    error: () => {},
  }), TEST_TIMEOUT_MS, 'one-failure run');
  check('non-zero exit', code !== 0, 'got ' + code);
  const inv = invocations();
  check('failing suite ran exactly once (no retry)', inv.filter((x) => x === 'fail-a').length === 1, JSON.stringify(inv));
  check('later suite still ran', inv.includes('pass-b'), JSON.stringify(inv));
  check('order preserved', JSON.stringify(inv) === JSON.stringify(['fail-a', 'pass-b']), JSON.stringify(inv));
  check('failure named in summary', logs.join('\n').includes('fail-a.cjs'));
  check('preview still cleaned up', await waitDead(handle) === true);
}]);

tests.push(['runSuiteProcess: exit/signal/timeout classified, hung suite tree-killed (real)', async () => {
  resetInvocations();
  const r1 = await withTimeout(runner.runSuiteProcess(path.join(fixtureDir, 'fail-a.cjs'), 10000), TEST_TIMEOUT_MS, 'exit3');
  check('non-zero exit classified', !r1.ok && r1.kind === 'exit' && r1.code === 3, JSON.stringify(r1));

  // A killed suite is always a failed suite. On POSIX the kill surfaces as
  // a signal exit; Windows TerminateProcess reports an ordinary exit code,
  // so only the failure invariant is cross-platform.
  const r2 = await withTimeout(runner.runSuiteProcess(path.join(fixtureDir, 'sigkill.cjs'), 10000), TEST_TIMEOUT_MS, 'sigkill');
  check('killed suite classified as failure', r2.ok === false, JSON.stringify(r2));
  if (process.platform !== 'win32') {
    check('signal exit classified', r2.kind === 'signal' && !!r2.signal, JSON.stringify(r2));
  }

  const r3 = await withTimeout(runner.runSuiteProcess(path.join(fixtureDir, 'hang.cjs'), 700), TEST_TIMEOUT_MS, 'hang');
  check('hung suite timed out (bounded wait)', !r3.ok && r3.kind === 'timeout' && r3.timeoutMs === 700, JSON.stringify(r3));
  // The bound must really have killed the hung child — read its pid from
  // disk and verify it is gone.
  const hungPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  check('hung child pid recorded', Number.isFinite(hungPid) && hungPid > 0);
  const gone = await preview.waitForPidExit(hungPid, 5000);
  check('hung child actually dead after timeout kill', gone.exited === true);

  const errors = [];
  const logs = [];
  const code = await runner.runBrowserGates({
    requested: ['pass-a.cjs'],
    registry: ['pass-a.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port: await freePort(),
    build: async () => ({ ok: true, output: '' }),
    readBuildToken: () => null,
    startPreview: async () => ({ pid: 0, isAlive: () => true, waitReady: async () => {}, kill: async () => ({ ok: true }) }),
    runSuite: async () => ({ ok: false, kind: 'spawn-error', error: Object.assign(new Error('enoent'), { code: 'ENOENT' }) }),
    log: (l) => logs.push(String(l)),
    error: captureErrors(errors),
  });
  check('spawn-error counts as failure', code !== 0, 'got ' + code);
  check('spawn-error described in output', (errors.join('\n') + logs.join('\n')).includes('spawn failed: ENOENT'));
}]);

tests.push(['busy port: refuse to run, foreign fixture untouched (real)', async () => {
  const port = await freePort();
  const foreign = track(spawn(process.execPath, [path.join(fixtureDir, 'fixture-server.cjs')], {
    env: { ...process.env, FIX_PORT: String(port), FIX_TOKEN_MODE: 'match' },
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  }), 'foreign-fixture(port ' + port + ')');
  let foreignExit = null;
  foreign.once('exit', (code) => { foreignExit = code; });
  await withTimeout(waitUntilResponding(port, 10000, 'foreign fixture startup'), TEST_TIMEOUT_MS, 'foreign fixture up');

  const errors = [];
  let startPreviewCalled = false;
  const code = await withTimeout(runner.runBrowserGates({
    requested: ['pass-a.cjs'],
    registry: ['pass-a.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port,
    build: async () => ({ ok: true, output: 'fake build' }),
    readBuildToken: () => null,
    startPreview: async (...args) => {
      startPreviewCalled = true;
      return preview.startPreview(...args);
    },
    log: () => {},
    error: captureErrors(errors),
  }), TEST_TIMEOUT_MS, 'busy-port run');
  check('non-zero exit', code !== 0, 'got ' + code);
  check('refusal explained', errors.join('\n').includes('ALREADY IN USE'), errors.join(' | '));
  check('own preview never spawned', startPreviewCalled === false);
  check('foreign fixture still alive', foreignExit === null && pidAlive(foreign.pid), 'exit=' + foreignExit);
  const still = await preview.httpGet('http://127.0.0.1:' + port + '/', 1500);
  check('foreign fixture still serving', still !== null && still.status === 200, JSON.stringify(still));
  // cleanup of OUR test fixture
  preview.killTree(foreign.pid);
  await preview.waitForPidExit(foreign.pid, 5000);
}]);

tests.push(['build failure: preview never started, non-zero', async () => {
  const errors = [];
  let startPreviewCalled = false;
  const code = await runner.runBrowserGates({
    requested: ['pass-a.cjs'],
    registry: ['pass-a.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port: await freePort(),
    build: async () => ({ ok: false, output: 'synthetic build boom' }),
    readBuildToken: () => null,
    startPreview: async () => { startPreviewCalled = true; return { pid: 0, isAlive: () => true, waitReady: async () => {}, kill: async () => ({ ok: true }) }; },
    runSuite: async () => ({ ok: true }),
    log: () => {},
    error: captureErrors(errors),
  });
  check('non-zero exit', code !== 0, 'got ' + code);
  check('preview never started', startPreviewCalled === false);
  check('build failure reported', errors.join('\n').includes('BUILD FAILED') && errors.join('\n').includes('synthetic build boom'), errors.join(' | '));
}]);

tests.push(['preview dies mid-run: remaining suites marked not-run, non-zero', async () => {
  resetInvocations();
  const logs = [];
  const errors = [];
  let alive = true;
  const code = await withTimeout(runner.runBrowserGates({
    requested: ['pass-a.cjs', 'pass-b.cjs'],
    registry: ['pass-a.cjs', 'pass-b.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port: await freePort(),
    build: async () => ({ ok: true, output: '' }),
    readBuildToken: () => null,
    startPreview: async () => ({
      pid: 0,
      isAlive: () => alive,
      waitReady: async () => {},
      kill: async () => { alive = false; return { ok: true }; },
    }),
    runSuite: async (suitePath) => {
      const r = await runner.runSuiteProcess(suitePath, 10000);
      alive = false; // the "server" dies after the first suite
      return r;
    },
    log: (l) => logs.push(String(l)),
    error: captureErrors(errors),
  }), TEST_TIMEOUT_MS, 'preview-dies run');
  check('non-zero exit', code !== 0, 'got ' + code);
  check('first suite ran, second did not', JSON.stringify(invocations()) === JSON.stringify(['pass-a']), JSON.stringify(invocations()));
  check('infra failure reported', errors.join('\n').includes('PREVIEW DIED'), errors.join(' | '));
  check('second suite marked not run', (errors.join('\n') + logs.join('\n')).includes('pass-b.cjs (not run: preview died)'));
}]);

tests.push(['cleanup failure: never reported as a clean success', async () => {
  const logs = [];
  const errors = [];
  const code = await runner.runBrowserGates({
    requested: ['pass-a.cjs'],
    registry: ['pass-a.cjs'],
    suiteDir: fixtureDir,
    rootDir: fixtureDir,
    port: await freePort(),
    build: async () => ({ ok: true, output: '' }),
    readBuildToken: () => null,
    startPreview: async () => ({
      pid: 0,
      isAlive: () => true,
      waitReady: async () => {},
      kill: async () => ({ ok: false, error: new Error('stub unkillable') }),
    }),
    runSuite: async () => ({ ok: true }),
    log: (l) => logs.push(String(l)),
    error: captureErrors(errors),
  });
  check('non-zero exit despite all gates passing', code !== 0, 'got ' + code);
  check('summary said gates passed', logs.join('\n').includes('all 1 browser gates passed'), logs.join(' | '));
  check('cleanup failure called out', errors.join('\n').includes('CLEANUP FAILED') && errors.join('\n').includes('stub unkillable'), errors.join(' | '));
}]);

tests.push(['real tree-kill: grandchild port released (real cleanup)', async () => {
  const port = await freePort();
  const parent = track(spawn(process.execPath, [path.join(fixtureDir, 'parent-with-child.cjs')], {
    env: { ...process.env, FIX_PORT: String(port), FIX_TOKEN_MODE: 'match' },
    stdio: 'ignore',
    windowsHide: true,
    detached: process.platform !== 'win32',
  }), 'parent-with-child(port ' + port + ')');
  await withTimeout(waitUntilResponding(port, 10000, 'parent/child fixture startup'), TEST_TIMEOUT_MS, 'tree fixture up');

  preview.killTree(parent.pid);
  const parentGone = await preview.waitForPidExit(parent.pid, 10000);
  check('parent dead', parentGone.exited === true);
  const { parent: pp, child: cp } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  const childGone = await preview.waitForPidExit(cp, 10000);
  check('grandchild dead', childGone.exited === true, 'child pid ' + cp);
  let released = null;
  for (let i = 0; i < 20 && released === null; i++) {
    const probe = await preview.httpGet('http://127.0.0.1:' + port + '/', 1000);
    if (probe === null) released = true;
    else await new Promise((r) => setTimeout(r, 250));
  }
  check('grandchild port released', released === true);
  check('parent pid consistent with fixture record', pp === parent.pid);
}]);

// ---------------------------------------------------------------------------
// F1 (m3c review round 2): bounded, verified owned-process cleanup.
// The POSIX-signal behaviors (SIGTERM receipt/ignoral, group survival past
// the root) can only EXECUTE where POSIX signals exist — those cases run
// for real on Linux CI and are skipped on Windows with that label; the
// Windows-specific taskkill behavior is executed by the other tests here.

tests.push(['F1 timeout: a SIGTERM-ignoring suite still settles as timeout, bounded (POSIX; real)', async () => {
  if (process.platform === 'win32') {
    skipped++;
    console.log('  SKIP (POSIX signals only — executes on Linux CI): SIGTERM-ignoring timeout settlement');
    return;
  }
  const myPidFile = path.join(fixtureDir, 'pid-stubborn.json');
  process.env.PID_FILE = myPidFile;
  resetTermLog();
  resetInvocations();
  try {
    const t0 = Date.now();
    const r = await withTimeout(
      runner.runSuiteProcess(path.join(fixtureDir, 'term-ignore-stubborn.cjs'), 700, { termGraceMs: 700, killConfirmMs: 3000 }),
      20000,
      'stubborn suite timeout settlement',
    );
    const elapsed = Date.now() - t0;
    check('settled as timeout (the old code hung here forever)', r && r.ok === false && r.kind === 'timeout' && r.timeoutMs === 700, JSON.stringify(r));
    check('no cleanup failure attached', r.cleanup === undefined, JSON.stringify(r.cleanup || null));
    check('SIGTERM was actually DELIVERED (receipt recorded by the fixture)', termReceipts().length >= 1, JSON.stringify(termReceipts()));
    check('the fixture SURVIVED the polite phase (alive through the whole TERM grace)', elapsed >= 700, 'elapsed ' + elapsed + 'ms');
    check('settlement stayed bounded', elapsed < 15000, 'elapsed ' + elapsed + 'ms');
    const pid = Number(fs.readFileSync(myPidFile, 'utf8').trim());
    check('stubborn pid recorded', Number.isFinite(pid) && pid > 0);
    const gone = await preview.waitForPidExit(pid, 5000);
    check('SIGKILL escalation finished it (pid gone, not just signaled)', gone.exited === true);
  } finally {
    process.env.PID_FILE = pidFile;
    // Fixture兜底: hard-kill the recorded pid (OUR fixture) so a failed
    // test never leaves a SIGTERM-ignoring orphan behind.
    if (fs.existsSync(myPidFile)) {
      const pid = Number(fs.readFileSync(myPidFile, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        try { cleanup.forceKillIdentity(cleanup.ownTreeIdentity(pid)); } catch (e) { /* gone */ }
      }
    }
  }
}]);

tests.push(['F1 cleanup: root exited, owned group still serving — cleaned, port rebindable (POSIX; real)', async () => {
  if (process.platform === 'win32') {
    skipped++;
    console.log('  SKIP (POSIX process groups only — executes on Linux CI): orphaned group cleanup');
    return;
  }
  const port = await freePort();
  const readyFile = path.join(fixtureDir, 'ready-orphan-' + Date.now() + '.txt');
  const myPidFile = path.join(fixtureDir, 'pid-orphan.json');
  process.env.PID_FILE = myPidFile;
  process.env.FIX_READY_FILE = readyFile;
  process.env.FIX_IGNORE_TERM = '1';
  resetTermLog();
  let parent = null;
  try {
    parent = track(spawn(process.execPath, [path.join(fixtureDir, 'group-orphan-parent.cjs')], {
      env: { ...process.env, FIX_PORT: String(port), FIX_TOKEN_MODE: 'match' },
      stdio: 'ignore',
      windowsHide: true,
      detached: true,
    }), 'group-orphan-parent(port ' + port + ')');
    await withTimeout(waitForReadyFile(readyFile, 10000, 'orphan fixture child ready'), TEST_TIMEOUT_MS, 'orphan child ready');
    const rootGone = await preview.waitForPidExit(parent.pid, 10000);
    check('root exited on its own (before any cleanup)', rootGone.exited === true);
    const { parent: pp, child: cp } = JSON.parse(fs.readFileSync(myPidFile, 'utf8'));
    check('fixture pid record consistent', pp === parent.pid && Number.isFinite(cp) && cp > 0);
    const pre = await preview.httpGet('http://127.0.0.1:' + port + '/', 2000);
    check('group child still SERVING after the root is gone', pre !== null && pre.status === 200, JSON.stringify(pre));

    const identity = cleanup.ownTreeIdentity(parent.pid);
    const t0 = Date.now();
    const r = await withTimeout(cleanup.terminateTree(identity, { termGraceMs: 700, killConfirmMs: 3000 }), 20000, 'orphaned group cleanup');
    const elapsed = Date.now() - t0;
    check('cleanup succeeded despite the dead root', r && r.ok === true, JSON.stringify(r));
    check('the child ignored SIGTERM (receipt) and had to be escalated', termReceipts().length >= 1 && elapsed >= 700,
      'receipts=' + JSON.stringify(termReceipts()) + ' elapsed=' + elapsed + 'ms');

    // Functional proof of death — not just kill(pid, 0): the child no
    // longer serves, and the port can be bound again.
    const post = await preview.httpGet('http://127.0.0.1:' + port + '/', 2000);
    check('orphaned child no longer serves', post === null, JSON.stringify(post));
    let rebound = false;
    try {
      await new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen({ port, host: '127.0.0.1' }, () => { srv.close(() => resolve()); });
      });
      rebound = true;
    } catch (e) { /* port still held */ }
    check('port is rebindable (the process is truly gone, not a zombie)', rebound === true);
  } finally {
    delete process.env.FIX_IGNORE_TERM;
    delete process.env.FIX_READY_FILE;
    process.env.PID_FILE = pidFile;
    // Fixture兜底: the recorded child (if somehow alive) is OUR fixture —
    // hard-kill it so a failed test never leaves an orphan behind.
    if (fs.existsSync(myPidFile)) {
      try { cleanup.forceKillIdentity(cleanup.ownTreeIdentity(JSON.parse(fs.readFileSync(myPidFile, 'utf8')).child)); } catch (e) { /* gone */ }
    }
    try { fs.rmSync(readyFile, { force: true }); } catch (e) { /* gone */ }
  }
}]);

tests.push(['F1 preview kill after root self-exit: verified, never unconditional ok (real vite preview)', async () => {
  if (!fs.existsSync(path.join(ROOT_DIR, 'dist', 'index.html'))) {
    skipped++;
    console.log('  SKIP (needs npm run build first): real preview root-exit verification');
    return;
  }
  const port = await freePort();
  const token = preview.readDistAssetToken({ cwd: ROOT_DIR });
  const handle = preview.startPreview({ cwd: ROOT_DIR, port, buildToken: token });
  try {
    await withTimeout(handle.waitReady(30000, token), 45000, 'preview up (root-exit test)');
  } catch (e) {
    await handle.kill().catch(() => {});
    throw e;
  }
  // Kill ONLY the root, bypassing the handle — the shape the old code
  // answered with an unconditional { ok: true } and zero verification.
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(handle.pid), '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(handle.pid, 'SIGKILL'); } catch (e) { /* gone */ }
  }
  const deadline = Date.now() + 10000;
  while (handle.isAlive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  check('root exited before kill() was called', handle.isAlive() === false);
  const k = await withTimeout(handle.kill(), 30000, 'kill after root self-exit');
  if (process.platform === 'win32') {
    check('win32: root-exited cleanup is an explicit FAILURE (tree unverifiable), not a silent ok',
      k.ok === false && /cannot verify/.test(String(k.error && k.error.message || '')), JSON.stringify({ ok: k.ok, error: String(k.error && k.error.message || '') }));
  } else {
    check('posix: root-exited cleanup VERIFIED the group is gone (not assumed)',
      k.ok === true && /gone/.test(String(k.how || '')), JSON.stringify(k));
  }
  check('repeated kill() is safe (memoized verdict)', (await handle.kill()).ok === k.ok);
  const still = await preview.httpGet('http://127.0.0.1:' + port + '/', 1500);
  check('port released after verified cleanup', still === null, JSON.stringify(still));
}]);

tests.push(['F1 race: timeout vs natural exit — exactly one verdict, no unhandled rejection (real)', async () => {
  const myPidFile = path.join(fixtureDir, 'pid-race.json');
  process.env.PID_FILE = myPidFile;
  process.env.EXIT_AFTER_MS = '300';
  resetInvocations();
  const unhandled = [];
  const warnings = [];
  const onUnhand = (reason) => unhandled.push(String(reason && reason.message || reason));
  const onWarning = (w) => warnings.push(String(w && w.message || w));
  process.on('unhandledRejection', onUnhand);
  process.on('warning', onWarning);
  try {
    for (const timeoutMs of [200, 260, 300, 340, 400]) {
      const r = await withTimeout(
        runner.runSuiteProcess(path.join(fixtureDir, 'exit-after-ms.cjs'), timeoutMs, { termGraceMs: 500, killConfirmMs: 2000 }),
        20000,
        'timeout/exit race at ' + timeoutMs,
      );
      check('settled to exactly one verdict (' + timeoutMs + ')', !!r && (r.kind === 'exit' || r.kind === 'timeout'), JSON.stringify(r));
      if (r.kind === 'exit') {
        check('natural exit kept its identity (' + timeoutMs + ')', r.code === 0, JSON.stringify(r));
      } else {
        check('timeout verdict kept, no cleanup failure (' + timeoutMs + ')', r.ok === false && r.timeoutMs === timeoutMs && r.cleanup === undefined, JSON.stringify(r));
        const pid = Number(fs.readFileSync(myPidFile, 'utf8').trim());
        const gone = await preview.waitForPidExit(pid, 5000);
        check('process dead after timeout settlement (' + timeoutMs + ')', gone.exited === true);
      }
    }
    check('no unhandled rejections across the race', unhandled.length === 0, unhandled.join(' | '));
    check('no process warnings (double settlement / listener leaks)', warnings.length === 0, warnings.join(' | '));
  } finally {
    process.off('unhandledRejection', onUnhand);
    process.off('warning', onWarning);
    delete process.env.EXIT_AFTER_MS;
    process.env.PID_FILE = pidFile;
  }
}]);

tests.push(['waitHealthy: build identity + aliveness, bounded (real HTTP)', async () => {
  const foreignPort = await freePort();
  const foreign = makeRealServerPreview(foreignPort, 'foreign');
  const t0 = Date.now();
  let foreignError = null;
  try {
    await withTimeout(preview.waitHealthy({
      url: 'http://127.0.0.1:' + foreignPort + '/',
      expectToken: 'assets/index-fakehash.js',
      isAlive: () => true,
      timeoutMs: 2000,
      label: 'identity probe',
    }), TEST_TIMEOUT_MS, 'identity timeout case');
  } catch (e) {
    foreignError = e;
  }
  check('foreign content rejected', foreignError !== null);
  check('mismatch explained as foreign/stale suspicion', foreignError && foreignError.message.includes('mismatch'), foreignError && foreignError.message);
  check('bounded (did not wait forever)', Date.now() - t0 < 15000, 'took ' + (Date.now() - t0) + 'ms');
  await handleCleanup(foreign);

  const matchPort = await freePort();
  const match = makeRealServerPreview(matchPort, 'match');
  await withTimeout(preview.waitHealthy({
    url: 'http://127.0.0.1:' + matchPort + '/',
    expectToken: 'assets/index-fakehash.js',
    isAlive: () => true,
    timeoutMs: 10000,
    label: 'identity probe (match)',
  }), TEST_TIMEOUT_MS, 'identity match case');
  await handleCleanup(match);

  let deadError = null;
  try {
    await preview.waitHealthy({
      url: 'http://127.0.0.1:' + (await freePort()) + '/',
      expectToken: null,
      isAlive: () => false,
      timeoutMs: 5000,
      label: 'dead probe',
    });
  } catch (e) {
    deadError = e;
  }
  check('dead process fails readiness immediately', deadError !== null && deadError.message.includes('exited before becoming ready'), deadError && deadError.message);
}]);

tests.push(['CLI: unknown suite exits 2 without starting anything (real CLI)', async () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run-browser-gates.cjs'), 'definitely-not-a-suite.cjs'], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  check('exit code 2', r.status === 2, 'status ' + r.status + ' stderr: ' + String(r.stderr).slice(0, 400));
  check('unknown name reported on stderr', String(r.stderr).includes('definitely-not-a-suite.cjs'));
  check('no gates ran (no build banner in stdout)', !String(r.stdout).includes('vite build'), String(r.stdout).slice(0, 200));
}]);

tests.push(['real vite preview: build, readiness identity, verified shutdown', async () => {
  if (!process.env.BROWSER_GATE_ORCH_REAL_PREVIEW) {
    skipped++;
    console.log('  SKIP (set BROWSER_GATE_ORCH_REAL_PREVIEW=1 to run): real vite preview lifecycle');
    return;
  }
  const port = await freePort();
  const buildResult = await withTimeout(preview.buildDist({ cwd: ROOT_DIR }), 300000, 'real vite build');
  check('real build ok', buildResult.ok, buildResult.output.slice(-300));
  const token = preview.readDistAssetToken({ cwd: ROOT_DIR });
  check('build token present', !!token);
  const handle = preview.startPreview({ cwd: ROOT_DIR, port, buildToken: token });
  try {
    await withTimeout(handle.waitReady(30000, token), 45000, 'real preview readiness');
    const asset = await preview.httpGet('http://127.0.0.1:' + port + '/' + token, 3000);
    check('serves OUR built asset', asset !== null && asset.status === 200, JSON.stringify(asset && asset.status));
  } finally {
    const k = await handle.kill();
    check('real preview kill verified', k.ok === true, k.error && k.error.message);
  }
  check('real preview dead', await waitDead(handle) === true);
  const still = await preview.httpGet('http://127.0.0.1:' + port + '/', 1500);
  check('real preview port released', still === null);
}]);

async function handleCleanup(handle) {
  const k = await handle.kill();
  check('fixture cleanup ok', k.ok === true, k.error && k.error.message);
}

// ---------------------------------------------------------------------------

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    process.stdout.write('TEST ' + name + '\n');
    try {
      await withTimeout(fn(), TEST_TIMEOUT_MS * 2, 'test: ' + name);
      passed++;
      console.log('  ok');
    } catch (e) {
      failed++;
      console.error('  FAIL: ' + (e && e.stack || e));
    }
  }
  console.log('---');
  console.log(passed + ' passed, ' + skipped + ' skipped, ' + (failed ? failed + ' FAILED' : 'no failures'));
  process.exitCode = failed ? 1 : 0;
})().finally(() => {
  // Kill anything this file spawned (SIGKILL-grade backstop — some F1
  // fixtures ignore SIGTERM by design), then remove the fixture dir.
  sweepTracked();
  setTimeout(() => {
    try { fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    clearTimeout(watchdog);
  }, 300);
});
