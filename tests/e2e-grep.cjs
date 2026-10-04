// Grep regex worker isolation browser e2e (F03). Real Chrome, real build,
// REAL Web Workers. Proves that a catastrophic-backtracking grep pattern:
//   - runs ONLY inside a dedicated worker (main-thread heartbeat keeps
//     firing while the regex burns the worker),
//   - is killed at the hard timeout and reports a bounded failure,
//   - can be cancelled through the task AbortSignal faster than the
//     timeout, without stale results,
//   - leaves no poisoned state (the next ordinary grep succeeds), and
//   - fails CLOSED with no main-thread fallback when workers are unavailable.
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';

// Adversarial input for ^(a+)+$: ~30 a's then a non-matching tail. Would
// backtrack exponentially (far beyond the 1s grep regex timeout); the
// worker is terminated long before it could finish, so CI CPU stays bounded.
const ADVERSARIAL = 'a'.repeat(30) + 'X';
const TIMEOUT_MS = 1000; // keep in sync with GREP_REGEX_TIMEOUT_MS in src/shell.js

const PAGE_HELPERS = `
(() => {
  if (window.__gwE2e) return 'ready';
  const L = window.__locus;
  const exec = (cmd, opts) => window.executeTool('bash', cmd, L.vfs,
    Object.assign({ runtimeSession: L.runtime() }, opts || {}));
  window.__gwE2e = {
    beats: null,
    exec,
    // Heartbeat runs on the MAIN thread: if the pattern ever executes there,
    // the interval freezes and count stays 0 while grep runs.
    withHeartbeat: async (promise) => {
      const beats = { count: 0, ms: null };
      window.__gwE2e.beats = beats;
      const hb = setInterval(() => beats.count++, 50);
      const t0 = Date.now();
      try {
        const r = await promise;
        beats.ms = Date.now() - t0;
        return { output: r.output, success: r.success, beats: beats.count, elapsed: beats.ms };
      } finally {
        clearInterval(hb);
      }
    },
    dangerous: () => window.__gwE2e.withHeartbeat(
      exec("grep '^(a+)+$' adversarial.txt")),
    // M3c integration: the grep regex runtime is INTERNAL to the installed
    // runtime package now (no page-global GrepRegexRuntime to instrument).
    // The worker create/terminate lifecycle + worker-unavailable fail-closed
    // checks (old G-E5 counts / G-E6 / G-E7) are covered by locus-runtime's
    // own e2e-grep over its host page, which reaches the module internals
    // legitimately. This product-page gate keeps the behavior checks.
  };
  return 'installed';
})()
`;

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: 110000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result?.result?.value;
}

async function main() {
  let profileDir;
  let chrome;
  let cdp;
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail ? ' | ' + detail : '')); }
  };

  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-grep-profile-'));
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'grep worker Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp,
      '!!(window.__locus && window.__locus.vfs && window.executeTool && document.querySelector(".app-shell"))',
      { process: chrome, phase: 'grep-app-boot', timeoutMs: 15000 });
    // bootPersistence re-mounts /home/locus onto OPFS asynchronously after
    // first paint; files written before that swap live only in the replaced
    // in-memory home. The durable history mount is the last one it installs,
    // so its presence means the workspace topology is final.
    await waitForRuntimeCondition(cdp,
      '!!(window.__locus.vfs.mounts && window.__locus.vfs.mounts.some(m => m.path === \'/home/locus/history\'))',
      { process: chrome, phase: 'grep-durable-home', timeoutMs: 15000 });
    await evaluate(cdp, PAGE_HELPERS);

    // ---- setup: fixture files through ordinary shell commands ----
    const setup = await evaluate(cdp, `(async () => {
      const e = window.__gwE2e.exec;
      const r1 = await e("echo '${ADVERSARIAL}' > adversarial.txt");
      const r2 = await e("echo 'foo bar' > normal.txt");
      await e("echo baz >> normal.txt");
      const ls = await e('ls');
      return { adv: r1.success, norm: r2.success, ls: ls.output };
    })()`);
    check('G-E1 fixtures written via ordinary shell commands',
      setup.adv && setup.norm && /adversarial\.txt/.test(setup.ls) && /normal\.txt/.test(setup.ls),
      JSON.stringify(setup));

    // ---- CASE D: catastrophic regex — worker isolation, heartbeat, timeout ----
    // Pure production path (no test instrumentation): the real Blob Worker.
    const redos = await evaluate(cdp, `window.__gwE2e.dangerous()`);
    check('G-E2 catastrophic regex reports the bounded timeout failure',
      !redos.success && redos.output === 'grep: regex evaluation timed out (the pattern may cause excessive backtracking; simplify it)',
      JSON.stringify(redos));
    check('G-E2 main-thread heartbeat kept firing while the regex burned',
      redos.beats >= 5, 'beats=' + redos.beats);
    check('G-E2 grep returns bounded after the hard timeout',
      redos.elapsed >= TIMEOUT_MS && redos.elapsed < 3 * TIMEOUT_MS + 2000,
      'elapsed=' + redos.elapsed + 'ms');

    // ---- CASE G: recovery after timeout ----
    const recovery = await evaluate(cdp, `window.__gwE2e.exec('grep foo normal.txt').then(r => ({ output: r.output, success: r.success }))`);
    check('G-E3 ordinary grep succeeds right after a regex timeout',
      recovery.success && recovery.output === 'foo bar', JSON.stringify(recovery));

    // ---- CASE C: invalid regex — bounded failure and recovery ----
    const invalid = await evaluate(cdp, `window.__gwE2e.exec("grep '(' normal.txt").then(r => ({ output: r.output, success: r.success }))`);
    check('G-E4 invalid pattern fails with the bounded message',
      !invalid.success && invalid.output === 'grep: invalid pattern (patterns use JavaScript regex syntax)',
      JSON.stringify(invalid));
    const afterInvalid = await evaluate(cdp, `window.__gwE2e.exec('grep foo normal.txt').then(r => ({ output: r.output, success: r.success }))`);
    check('G-E4 ordinary grep succeeds right after an invalid pattern',
      afterInvalid.success && afterInvalid.output === 'foo bar', JSON.stringify(afterInvalid));

    // ---- CASE E: cancellation beats the timeout ----
    const cancel = await evaluate(cdp, `(async () => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 150);
      return window.__gwE2e.withHeartbeat(
        window.__gwE2e.exec("grep '^(a+)+$' adversarial.txt", { signal: ac.signal }));
    })()`);
    check('G-E5 cancelled catastrophic grep reports bash: cancelled before the timeout',
      !cancel.success && cancel.output === 'bash: cancelled' && cancel.elapsed < TIMEOUT_MS,
      JSON.stringify(cancel));
    check('G-E5 heartbeat kept firing during the cancelled run', cancel.beats >= 1, 'beats=' + cancel.beats);
    // (G-E5's worker create/terminate counting, G-E6's instrumented timeout
    // and G-E7's worker-unavailable fail-closed moved with the runtime
    // package: locus-runtime tests/e2e-grep.cjs covers them over its host
    // page, where the internal GrepRegexRuntime seam is reachable.)

    // ---- ordinary searches keep their semantics in the real browser ----
    const semantics = await evaluate(cdp, `(async () => {
      const e = window.__gwE2e.exec;
      const cnt = await e('grep -c foo normal.txt');
      const num = await e('grep -n foo normal.txt');
      const pipe = await e('echo hello-foo | grep foo');
      return { cnt: { output: cnt.output, success: cnt.success },
               num: { output: num.output, success: num.success },
               pipe: { output: pipe.output, success: pipe.success } };
    })()`);
    check('G-E8 -c exact count in browser', semantics.cnt.success && semantics.cnt.output === '1', JSON.stringify(semantics.cnt));
    check('G-E8 -n line numbers in browser', semantics.num.success && semantics.num.output === '1:foo bar', JSON.stringify(semantics.num));
    check('G-E8 stdin grep through the worker in browser', semantics.pipe.success && semantics.pipe.output === 'hello-foo', JSON.stringify(semantics.pipe));

    check('G-E9 browser reported no unhandled errors', (await evaluate(cdp, '(window.__e2eErrors || []).length')) === 0);

    console.log('---');
    console.log('e2e-grep: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('GREP E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
