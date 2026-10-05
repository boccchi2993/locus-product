// Preview/build lifecycle primitives for the browser-gate orchestrator
// (m3c review A). Design constraints:
//  - the installed vite entry is spawned DIRECTLY via node (no npx, no
//    shell:true) so the pid this module owns is the real server process;
//  - readiness requires OUR process to still be alive AND the port to
//    answer HTTP with OUR freshly built asset token — a stale foreign
//    service that happens to sit on the port can never be adopted;
//  - the port is bind-probed BEFORE the preview starts: a busy port is a
//    hard refusal, never a takeover, and nothing is ever killed by port;
//  - cleanup only ever touches process trees this module started.
const { spawn, spawnSync } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cleanup = require('./browser-gate-cleanup.cjs');

const KILL_GRACE_MS = 10000;

// Direct node entry for the locally installed vite — the same binary
// `npx vite` would run, minus the shell wrapper that made process
// ownership unclear on Windows. Resolved via the package root because
// vite's "exports" map does not expose ./bin/vite.js as a subpath.
function viteEntry(cwd) {
  const pkgRoot = path.dirname(require.resolve('vite/package.json', { paths: [cwd] }));
  const entry = path.join(pkgRoot, 'bin', 'vite.js');
  if (!fs.existsSync(entry)) {
    throw new Error('vite entry not found at ' + entry + ' — install dependencies first');
  }
  return entry;
}

// vite build as a bounded synchronous step. Returns { ok, output }; never
// throws. A build failure means no preview is ever started.
function buildDist({ cwd, timeoutMs = 300000 } = {}) {
  const r = spawnSync(process.execPath, [viteEntry(cwd), 'build'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  const output = String(r.stdout || '') + String(r.stderr || '');
  if (r.error) return { ok: false, output: output + '\n' + String(r.error && r.error.stack || r.error) };
  if (r.status !== 0) return { ok: false, output: output.trim() };
  return { ok: true, output: output.trim() };
}

// The freshly built index.html references a hashed asset; a server that
// answers with that exact name is provably serving THIS build.
// Returns null (never throws) when dist/ is absent or unparseable — the
// caller then warns that the identity check is degraded.
function readDistAssetToken({ cwd } = {}) {
  try {
    const text = fs.readFileSync(path.join(cwd, 'dist', 'index.html'), 'utf8');
    const m = text.match(/assets\/[^"']+\.js/);
    return m ? m[0] : null;
  } catch (e) {
    return null;
  }
}

// True when NOTHING is listening on 127.0.0.1:port (probed by briefly
// binding, then releasing — no process is touched either way).
function portIsFree(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    srv.once('error', () => done(false));
    srv.listen({ port, host: '127.0.0.1' }, () => {
      done(true);
      try { srv.close(() => {}); } catch (e) { /* already closing */ }
    });
    setTimeout(() => done(false), timeoutMs);
  });
}

// One bounded GET. Resolves { status, body } on any HTTP answer, or null
// when the connection fails/refuses/times out (i.e. port released).
function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => done({ status: res.statusCode, body }));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

// LOW-LEVEL termination REQUEST for a tree we own (the pid and everything
// it spawned) — no waiting and no verdict; callers own the bounded
// confirmation (see browser-gate-cleanup.cjs terminateTree for the shared
// verified algorithm used by the suite timeout and preview shutdown).
// On Windows spawn() without a shell gives us the real root pid, so
// taskkill /T is exact — and it is per-tree, never per-port; the call
// itself is bounded so a wedged taskkill cannot hang cleanup.
// On POSIX the whole tree shares the group of the spawned root (every
// spawn in this module sets detached, making the root its own group
// leader), so a negative pid reaches the tree; the single-process
// fallback covers a pid that is not a group leader (e.g. a fixture that
// never opted into a group) — a bare root kill is then the honest best
// effort and the caller's verified-exit check still reports the truth.
function killTree(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: cleanup.TASKKILL_TIMEOUT_MS });
    return !r.error && r.status === 0;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch (groupErr) {
    try { process.kill(pid, 'SIGTERM'); } catch (singleErr) { return false; }
  }
  return true;
}

// Resolves { exited: true } once the pid is gone, or { exited: false }
// after graceMs — a bounded confirmation that a kill actually worked.
function waitForPidExit(pid, graceMs = KILL_GRACE_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = false; }
      if (!alive) return resolve({ exited: true });
      if (Date.now() - started >= graceMs) return resolve({ exited: false });
      setTimeout(tick, 100);
    };
    tick();
  });
}

// Readiness = our process is still alive AND the port answers HTTP with
// the expected build token, within timeoutMs. Bounded by construction;
// every failure mode (dead process, wrong content, silence) is a distinct
// error message naming the suspicion.
async function waitHealthy({ url, expectToken = null, isAlive = null, timeoutMs, label = 'preview server' }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no attempt yet';
  for (;;) {
    if (isAlive && !isAlive()) throw new Error(label + ' exited before becoming ready');
    const res = await httpGet(url, 2000);
    if (res && res.status === 200 && (!expectToken || String(res.body).includes(expectToken))) return;
    if (res) {
      last = 'HTTP ' + res.status +
        (expectToken && !String(res.body).includes(expectToken)
          ? ' (content mismatch — a foreign/stale service may be on this port)'
          : '');
    } else {
      last = 'no HTTP response (connection refused or timed out)';
    }
    if (Date.now() > deadline) {
      throw new Error(label + ' not ready after ' + timeoutMs + 'ms — last state: ' + last);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Starts `node <vite> preview --port <p> --strictPort --host 127.0.0.1`
// and returns a handle that owns exactly this process tree. Callers must
// run portIsFree() first — a busy port must be refused before spawn, not
// adopted after.
function startPreview({ cwd, port, buildToken = null } = {}) {
  const child = spawn(
    process.execPath,
    [viteEntry(cwd), 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    // POSIX: own process group, so the owned identity below reaches the
    // whole tree. Windows keeps the reviewed flags (taskkill /T is exact).
    { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' },
  );
  // The owned identity is captured NOW, at spawn time: on POSIX the group
  // id (= root pid) stays valid and cleanable even after the root exits.
  const identity = cleanup.ownTreeIdentity(child.pid);
  let output = '';
  const tail = (c) => {
    output = (output + String(c)).split(/\r?\n/).slice(-40).join('\n');
  };
  child.stdout.on('data', tail);
  child.stderr.on('data', tail);
  let exitInfo = null;
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => { exitInfo = { code, signal }; resolve({ code, signal }); });
  });

  // Idempotent: repeated kill() calls reuse the first verified result.
  let killPromise = null;
  async function killOnce() {
    // Verified bounded cleanup of OUR tree (shared algorithm with the
    // suite timeout — browser-gate-cleanup.cjs). A root that exited on
    // its own never short-circuits to ok: POSIX verifies the group is
    // gone (and cleans surviving members); Windows, which cannot verify
    // an orphaned tree after root exit, reports an explicit failure.
    const r = await cleanup.terminateTree(identity);
    // Settle the handle's aliveness from the child's own exit event (the
    // verified cleanup already confirmed the death; this only lets the
    // listener record exitInfo), with a bounded pid-poll guard.
    await Promise.race([exited, waitForPidExit(child.pid, KILL_GRACE_MS)]);
    return r;
  }

  const handle = {
    pid: child.pid,
    isAlive: () => exitInfo === null,
    output: () => output,
    // Bounded readiness: aliveness + HTTP + build identity (see waitHealthy).
    async waitReady(timeoutMs = 30000, expectToken = buildToken) {
      try {
        await waitHealthy({
          url: 'http://127.0.0.1:' + port + '/',
          expectToken,
          isAlive: handle.isAlive,
          timeoutMs,
          label: 'vite preview (port ' + port + ')',
        });
      } catch (e) {
        throw new Error(e.message + '\n--- preview output ---\n' + (output.trim() || '(none captured)'));
      }
    },
    // { ok: false } means the caller must NOT report a clean pass.
    async kill() {
      if (!killPromise) killPromise = killOnce();
      return killPromise;
    },
  };
  return handle;
}

module.exports = {
  KILL_GRACE_MS,
  viteEntry,
  buildDist,
  readDistAssetToken,
  portIsFree,
  httpGet,
  killTree,
  waitForPidExit,
  waitHealthy,
  startPreview,
};
