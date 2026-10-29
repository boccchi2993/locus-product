// C3 credentials BROWSER e2e (self-contained: own build, own servers, own
// Chrome) — the §3.2/§6 UI flows end to end over the REAL built app, REAL
// import service, REAL settings panel, REAL ApprovalCard, REAL relay
// handlers and REAL runtime credential resolution:
//
//   E-C1 a .locus package with a credentials declaration installs through
//        the REAL import service, lands enabled, card shows Not connected
//   E-C2 Connect, Remember explicitly UNCHECKED (D12: it defaults to
//        checked): dialog → Connected ····<last 4>
//   E-C3 curl POST with $NAME in a REAL task: approval card carries
//        "Uses credential: NAME", Always allow resolves persistent scope,
//        the upstream sees `Bearer <key>`, and the reflected key comes
//        back to the model as [credential redacted] (+ stderr notice)
//   E-C4 same origin again: NO card (the durable grant answers)
//   E-C5 reload: credential back to Not connected (was not remembered),
//        the durable grant SURVIVED (Always allowed lists it), and a curl
//        refuses as not connected BEFORE any approval card
//   E-C6 Connect with Remember (D12: checked by default) + reload: still
//        Connected ····<last 4>
//   E-C6b version replacement with a changed pathPrefix → Needs
//        reconfirmation (old + new binding lines); Confirm → connected
//   E-C7 Remove in "Always allowed" → the next curl asks again
//   E-C8 Disconnect → curl refuses as not connected
//   E-C9 Uninstall → binding record and `capcred:` secrets rows are gone
//        (read straight from IndexedDB)
//   E-C10 leak sweep: every IndexedDB store, every VFS file under
//        /home/locus/history (including tool-outputs/*.txt) and the page
//        DOM never contain the full test key
//   E-C11 phone width: the approval card's FOUR buttons all visible
//        inside the viewport (wrap, never overflow)
//   E-C12 D12: the UI import dialog moves to the connect-credentials step
//        (remember checked by default, shared-computer note); key +
//        Connect → Connected ····<last 4>, reload → STILL Connected
//   E-C13 D12: a fresh import's Skip for now keeps the credential Not
//        connected and the typed key never surfaces (leak sweep as E-C10)
//
// Upstream interception (the e2e-network.cjs mechanism, applied to the
// credential's host): the runtime's cross-origin POSTs travel the relay
// envelope to the REAL handlers in THIS process, whose upstream fetch is
// patched `https://api.deepseek.com/* → http://127.0.0.1:<target>`; the
// browser additionally maps the hostname to 127.0.0.1 (--host-resolver-
// rules) so NO request can ever reach the real api.deepseek.com. The
// upstream deliberately ECHOES the received Authorization header back in
// the body — the runtime must mask it before the model sees it.
//
// Screenshots (§5, docs/screenshots/c3-*.png) are captured along the way;
// set C3_SHOTS_DIR to redirect them.
const { spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, listenWithRetry,
  waitForCdp, waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const ROOT = path.join(__dirname, '..');
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SHOT_DIR = process.env.C3_SHOTS_DIR || path.join(ROOT, 'docs', 'screenshots');

const CAP_ID = 'cred-web';
const CRED_NAME = 'CRED_TEST_KEY';
const TEST_KEY = 'sk-e2e-cred-abcd99a7';
const KEY_LAST4 = TEST_KEY.slice(-4); // 99a7
const ORIGIN = 'https://api.deepseek.com';
const CRED_DECL = {
  name: CRED_NAME,
  label: 'E2E test credential',
  description: 'TEST ONLY C3 browser e2e credential.',
  origin: ORIGIN,
  pathPrefix: '/v1/tools/',
  header: 'Authorization',
  scheme: 'Bearer',
};
const CURL_V1 = 'curl -X POST ' + ORIGIN + '/v1/tools/search '
  + '-H "Authorization: Bearer $' + CRED_NAME + '" '
  + '-H "Content-Type: application/json" -d \'{"q":"locus"}\'';
const CURL_V2 = 'curl -X POST ' + ORIGIN + '/v2/tools/search '
  + '-H "Authorization: Bearer $' + CRED_NAME + '" '
  + '-H "Content-Type: application/json" -d \'{"q":"locus"}\'';
// E-C4 pads the response past the agent's 6000-char tool-result cap so the
// FULL output is externalized to /home/locus/history/**/tool-outputs/*.txt
// and E-C10's sweep covers a real externalized file.
const LARGE_PAD = 'x'.repeat(9000);

// ---------- upstream server (stands in for the credential's origin) ----------
// Factories only — the bind goes through listenWithRetry (chrome.cjs):
// allocateFreePort has a release/rebind race (EADDRINUSE 127.0.0.1:33221
// crashed this suite at startup on run 40851648265), so a busy port is
// retried on a freshly allocated one, up to 3 times, before any check runs.
const upstreamSeen = { auths: [], hits: 0 };
function makeTargetServer() {
  return (port) => http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/upstream/counts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ hits: upstreamSeen.hits, auths: upstreamSeen.auths }));
    }
    if (p.startsWith('/v1/tools/') || p.startsWith('/v2/tools/')) {
      upstreamSeen.hits++;
      const auth = req.headers.authorization || null;
      upstreamSeen.auths.push(auth);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        // Deliberate reflection: the response body carries the received
        // credential back — the runtime must redact it (E-C3/E-C10).
        const body = JSON.stringify({
          ok: true,
          authorization: auth,
          note: 'reflecting credential: ' + auth,
          pad: req.url.includes('/v1/tools/search') && upstreamSeen.hits > 1 ? LARGE_PAD : '',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      });
      return;
    }
    res.writeHead(404);
    res.end('no such upstream path');
  });
}

// ---------- app server (dist + REAL relay handlers) ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};
function makeAppServer(distDir, relay) {
  return (port) => http.createServer(async (req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/fetch') {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((r, j) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => r(Buffer.concat(chunks)));
        req.on('error', j);
      });
      const headers = Object.assign({}, req.headers);
      delete headers.host;
      delete headers['content-length'];
      delete headers.connection;
      let request;
      try {
        request = new Request('http://127.0.0.1:' + port + req.url, { method: req.method, headers, body });
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end('{"error":{"code":"network_invalid_url","message":"bad relay request"}}');
      }
      let resp;
      try {
        resp = await relay.onRequestPost({ request, env: {} });
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'network_relay_failed', message: String(e && e.message || e) } }));
      }
      const outHeaders = {};
      resp.headers.forEach((v, k) => { outHeaders[k] = v; });
      res.writeHead(resp.status, outHeaders);
      if (resp.status === 204 || resp.status === 205 || resp.status === 304) return res.end();
      return res.end(Buffer.from(await resp.arrayBuffer()));
    }
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(distDir, rel);
    if (!file.startsWith(distDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- CDP helpers ----------
// cdp lives at module scope: the wait/click helpers close over it.
let cdp = null;

async function evaluate(cdp2, expression, timeoutMs) {
  const result = await cdp2.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result && result.exceptionDetails) {
    throw new Error('page threw: ' + JSON.stringify(result.exceptionDetails).slice(0, 600));
  }
  return result && result.result && result.result.value;
}

const waitExpr = (js, ms) => '(async () => { const t0 = Date.now(); while (Date.now() - t0 < ' + (ms || 5000)
  + ') { if (' + js + ') return true; await new Promise((r) => setTimeout(r, 50)); } return false; })()';
const waitCard = (ms) => evaluate(cdp, waitExpr('!!document.querySelector(".approval-card")', ms));
const cardGone = (ms) => evaluate(cdp, waitExpr('!document.querySelector(".approval-card")', ms));
const clickBtn = async (label) => evaluate(cdp,
  '(function () { const b = [...document.querySelectorAll(".approval-btn")].find((x) => x.textContent.trim() === '
  + JSON.stringify(label) + '); if (!b) return false; b.click(); return true; })()');
const clickTestid = (testid) => evaluate(cdp,
  '(function () { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); if (!el) return "missing"; el.click(); return "clicked"; })()');
// Pure string builder (usable inside waitForRuntimeCondition expressions)
// and its one-shot evaluated twin. testidText is ASYNC — never concatenate
// it into another expression; concatenate testidExpr instead.
const testidExpr = (testid) => '(() => { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); return el ? el.textContent.trim() : null; })()';
const testidText = (testid) => evaluate(cdp, testidExpr(testid));

function setInputValue(testid, value) {
  return evaluate(cdp,
    '(function () { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); if (!el) return "missing";'
    + ' el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event("input", { bubbles: true })); return "set"; })()');
}

let shotCount = 0;
async function screenshot(cdp2, name, scrollTestid) {
  if (scrollTestid) {
    await evaluate(cdp2, '(function () { const el = document.querySelector(\'[data-testid="' + scrollTestid + '"]\');'
      + ' if (el && el.scrollIntoView) el.scrollIntoView({ block: "center" }); return "scrolled"; })()');
    await new Promise((r) => setTimeout(r, 150));
  }
  const shot = await cdp2.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOT_DIR, name), Buffer.from(shot.data, 'base64'));
  shotCount++;
}

// One REAL task: arm the BUILT-IN ?e2e=1 reply queue (normalizeEnvelope —
// the same replay-proven fake e2e-persistence drives across reloads; the
// queue is re-created by every boot, so no reinstall is needed), fire the
// REAL submit path and return when the task settles.
async function runTask(replies, prompt, timeoutMs) {
  // The default dialect is anthropic-compatible and the durable raw-replay
  // classifier inspects the assistant frames after a reload — a bare
  // string content replays as malformed. Shape every reply the way the
  // anthropic adapter would deliver it (text blocks in rawMessage).
  const shaped = replies.map((r) => typeof r === 'string'
    ? { content: r, rawMessage: { role: 'assistant', content: [{ type: 'text', text: r }] } }
    : r);
  await evaluate(cdp, 'window.__e2eReplies.length = 0; window.__e2eReplies.push('
    + shaped.map((r) => JSON.stringify(r)).join(',') + '); "armed"');
  await evaluate(cdp, 'window.__credTask = window.__locus.actions.submit(' + JSON.stringify(prompt) + '); "fired"');
  const settled = await evaluate(cdp,
    'window.__credTask.then(function () { return "task-done"; }, function (e) { return "task-error: " + (e && e.message || e); })',
    timeoutMs || 180000);
  return settled;
}

// The last tool result of the live conversation (kind/tool items).
const lastToolResultExpr = '(function () { const conv = window.__locus.store.conversations.find('
  + 'function (c) { return c.id === window.__locus.store.liveConversationId; });'
  + ' if (!conv) return null; const t = conv.items.filter(function (i) { return i.kind === "tool"; });'
  + ' const last = t[t.length - 1]; return last && last.result ? { output: String(last.result.output || ""), success: last.result.success } : null; })()';

async function reloadAndBoot(cdp2, chrome, appUrl) {
  await evaluate(cdp2, 'location.reload(); "reloading"');
  await waitForPageTarget(chrome, appUrl, { timeoutMs: 20000 });
  await waitForRuntimeCondition(cdp2,
    '!!(window.__locus && window.__locus.vfs && window.__locus.approvals && window.__locus.capabilityComposition && document.querySelector(".app-shell"))',
    { process: chrome, phase: 'cred-app-boot', timeoutMs: 30000 });
  await waitForRuntimeCondition(cdp2,
    'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
    { process: chrome, phase: 'cred-durable-home', timeoutMs: 30000 });
  await installHooks(cdp2);
}

async function installHooks(cdp2) {
  await evaluate(cdp2, 'window.__e2eReplies.length = 0; "queue reset"');
}

const openSettings = () => evaluate(cdp, 'window.__locus.store.settingsOpen = true; "open"');
const closeSettings = () => evaluate(cdp, 'window.__locus.store.settingsOpen = false; "closed"');

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '')); }
  };

  // ---- build (always fresh, same policy as e2e-network) ----
  console.log('# building dist (vite build)');
  const build = spawnSync(process.execPath, [VITE_CLI, 'build'], { stdio: 'inherit', cwd: ROOT });
  if (build.status !== 0) { console.error('build failed'); process.exit(1); }

  // ---- the .locus packages (v1: /v1/tools/, v1.0.2: /v2/tools/) ----
  const { buildFixturePackage } = await import('./helpers/locus-fixtures.mjs');
  const PKG_V1 = await buildFixturePackage({
    id: CAP_ID, version: '1.0.0',
    displayName: 'Cred Web', description: 'TEST ONLY C3 credentials e2e capability.',
    credentials: [CRED_DECL],
  });
  const PKG_V2 = await buildFixturePackage({
    id: CAP_ID, version: '1.0.2',
    displayName: 'Cred Web', description: 'TEST ONLY C3 credentials e2e capability.',
    credentials: [Object.assign({}, CRED_DECL, { pathPrefix: '/v2/tools/' })],
  });
  const PKG_B64 = {
    v1: Buffer.from(PKG_V1).toString('base64'),
    v2: Buffer.from(PKG_V2).toString('base64'),
  };

  // ---- servers (bind retried on a fresh port when EADDRINUSE) ----
  const { server: targetServer, port: targetPort } = await listenWithRetry(makeTargetServer(), await allocateFreePort());
  const relay = await import('file://' + path.join(ROOT, 'functions', 'fetch.js').replace(/\\/g, '/'));
  // The e2e-network interception mechanism: the REAL relay handlers run in
  // THIS process; their upstream fetch maps the credential's origin onto
  // the local target server. The browser never talks to the real host.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (u === ORIGIN || u.startsWith(ORIGIN + '/')) {
      return realFetch(u.replace(ORIGIN, 'http://127.0.0.1:' + targetPort), init);
    }
    return realFetch(input, init);
  };
  const { server: appServer, port: appPort } = await listenWithRetry(
    makeAppServer(path.join(ROOT, 'dist'), relay), await allocateFreePort());
  const appUrl = 'http://127.0.0.1:' + appPort + '/?e2e=1';

  let chrome = null;
  let profileDir = null;
  try {
    profileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'locus-cred-profile-'));
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'credentials Chrome',
      profileDir,
      extraArgs: [
        '--window-size=1440,900',
        // Belt and braces: even a browser-direct attempt can never leave
        // the machine — the mapped name resolves to loopback (and fails to
        // connect; POSTs travel the relay leg anyway).
        '--host-resolver-rules=MAP api.deepseek.com 127.0.0.1',
      ],
    });
    await waitForCdp(chrome);
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp,
      '!!(window.__locus && window.__locus.vfs && window.__locus.approvals && window.__locus.capabilityComposition && document.querySelector(".app-shell"))',
      { process: chrome, phase: 'cred-app-boot', description: 'credentials e2e unavailable: app did not boot', timeoutMs: 30000 });
    await waitForRuntimeCondition(cdp,
      'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
      { process: chrome, phase: 'cred-durable-home', timeoutMs: 30000 });
    await installHooks(cdp);
    check('C0 the pinned harness supports credentials + persistent grants',
      await evaluate(cdp, 'window.__locus.store.persistentApprovalsSupported === true && !!window.__locus.persistence()'));

    // ---------- E-C1: install → enabled, Not connected ----------
    const commit = await evaluate(cdp,
      '(async function () { var bin = atob(' + JSON.stringify(PKG_B64.v1) + ');'
      + ' var bytes = new Uint8Array(bin.length);'
      + ' for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
      + ' return await window.__locus.capabilityComposition.installPackage(bytes); })()');
    check('E-C1 the package installed through the REAL import service, auto-enabled',
      commit && commit.unchanged === false && commit.enabled === true && commit.state === 'ready',
      JSON.stringify(commit));
    await openSettings();
await waitForRuntimeCondition(cdp, testidExpr('credential-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-card', timeoutMs: 10000 });
    check('E-C1 the capability card lists the credential',
      (await testidText('credential-' + CRED_NAME)) !== null);
    check('E-C1 status reads Not connected',
      (await testidText('credential-state-' + CRED_NAME)) === 'Not connected',
      await testidText('credential-state-' + CRED_NAME));
    check('E-C1 the send rule names origin+prefix, header and scheme',
      (await testidText('credential-sendline-' + CRED_NAME))
        === 'Only sent to ' + ORIGIN + '/v1/tools/ as authorization: Bearer …',
      await testidText('credential-sendline-' + CRED_NAME));
    await screenshot(cdp, 'c3-credential-not-connected.png', 'credential-' + CRED_NAME);

    // ---------- E-C2: Connect without Remember ----------
    check('E-C2 Connect opens the dialog', (await clickTestid('credential-connect-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('credential-dialog-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-dialog', timeoutMs: 5000 });
    check('E-C2 the dialog restates the send rule',
      (await testidText('credential-dialog-' + CRED_NAME)).includes('Only sent to ' + ORIGIN + '/v1/tools/'),
      await testidText('credential-dialog-' + CRED_NAME));
    check('E-C2 Remember defaults to checked (D12)',
      await evaluate(cdp, 'document.querySelector(\'[data-testid="credential-remember-' + CRED_NAME + '"]\').checked'));
    check('E-C2 the dialog carries the shared-computer note',
      ((await testidText('credential-dialog-' + CRED_NAME)) || '')
        .includes('Saved in this browser on this device. Uncheck on a shared computer.'),
      await testidText('credential-dialog-' + CRED_NAME));
    await screenshot(cdp, 'c3-connect-dialog.png', 'credential-dialog-' + CRED_NAME);
    // E-C5 depends on the NOT-remembered premise, so the default is
    // explicitly undone here (D12 keeps the assertions below unchanged).
    check('E-C2 Remember unchecked explicitly',
      (await evaluate(cdp,
        '(function () { var el = document.querySelector(\'[data-testid="credential-remember-' + CRED_NAME + '"]\');'
        + ' el.click(); return el.checked; })()')) === false);
    check('E-C2 the key can be typed', (await setInputValue('credential-input-' + CRED_NAME, TEST_KEY)) === 'set');
    check('E-C2 Connect confirms', (await clickTestid('credential-confirm-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "").indexOf("Connected ····' + KEY_LAST4 + '") === 0',
      { process: chrome, phase: 'cred-connected', timeoutMs: 8000 });
    check('E-C2 status is Connected with ONLY the last 4 characters',
      (await testidText('credential-state-' + CRED_NAME)) === 'Connected ····' + KEY_LAST4,
      await testidText('credential-state-' + CRED_NAME));
    check('E-C2 the dialog closed (the value never survives it)',
      (await testidText('credential-dialog-' + CRED_NAME)) === null);
    check('E-C2 the full key appears nowhere in the page DOM',
      !(await evaluate(cdp, 'document.body.textContent.includes(' + JSON.stringify(TEST_KEY) + ')')));
    await screenshot(cdp, 'c3-credential-connected.png', 'credential-' + CRED_NAME);

    // ---------- E-C3: curl + approval card + Always allow ----------
    await closeSettings();
    const curlReply1 = '```json\n{"tool":"bash","input":' + JSON.stringify(CURL_V1) + '}\n```';
    const cardP3 = runTask([curlReply1, 'done.'], 'call the credentialed search API');
    check('E-C3 the approval card appears', await waitCard(15000));
    check('E-C3 the detail names the credential, never the value',
      (await evaluate(cdp, '(document.querySelector(".approval-detail")||{}).textContent || ""'))
        .includes('Uses credential: ' + CRED_NAME)
      && !(await evaluate(cdp, 'document.body.textContent.includes(' + JSON.stringify(TEST_KEY) + ')')),
      await evaluate(cdp, '(document.querySelector(".approval-detail")||{}).textContent || ""'));
    check('E-C3 four buttons with Always allow last',
      JSON.stringify(await evaluate(cdp,
        '[...document.querySelectorAll(".approval-btn")].map(function (b) { return b.textContent.trim(); })'))
      === JSON.stringify(['Deny', 'Allow once', 'Allow for this session', 'Always allow']),
      JSON.stringify(await evaluate(cdp,
        '[...document.querySelectorAll(".approval-btn")].map(function (b) { return b.textContent.trim(); })')));
    await screenshot(cdp, 'c3-approval-always-allow.png', null);
    check('E-C3 Always allow clicked', (await clickBtn('Always allow')) === true);
    check('E-C3 the task settled', (await cardP3) === 'task-done');
    const r3 = await evaluate(cdp, lastToolResultExpr);
    check('E-C3 the model-visible output carries the redaction placeholder, never the key',
      r3 && r3.success && r3.output.includes('[credential redacted]') && !r3.output.includes(TEST_KEY),
      JSON.stringify(r3 && r3.output.slice(0, 300)));
    check('E-C3 the stderr notice says the credential was redacted',
      r3 && r3.output.includes('[curl: credential value redacted from the response]'),
      JSON.stringify(r3 && r3.output.slice(-200)));
    check('E-C3 the upstream saw `Bearer <key>` exactly once',
      upstreamSeen.hits === 1 && upstreamSeen.auths[0] === 'Bearer ' + TEST_KEY,
      JSON.stringify(upstreamSeen));
    check('E-C3 the durable grant exists',
      (await evaluate(cdp, 'window.__locus.store.alwaysAllowed.map(function (g) { return g.policyKey; })'))
        .includes('network-write:' + ORIGIN),
      JSON.stringify(await evaluate(cdp, 'JSON.stringify(window.__locus.store.alwaysAllowed)')));

    // ---------- E-C4: same origin → no card (durable grant answers) ----------
    const hitsBefore4 = upstreamSeen.hits;
    const cardP4 = runTask([curlReply1, 'done.'], 'call the credentialed API again (large response)');
    check('E-C4 no approval card this time', await cardGone(4000) && (await waitCard(1500)) === false);
    check('E-C4 the task settled', (await cardP4) === 'task-done');
    check('E-C4 the request reached the upstream with the credential',
      upstreamSeen.hits === hitsBefore4 + 1 && upstreamSeen.auths[upstreamSeen.auths.length - 1] === 'Bearer ' + TEST_KEY,
      JSON.stringify({ hits: upstreamSeen.hits, last: upstreamSeen.auths[upstreamSeen.auths.length - 1] }));

    // ---------- E-C5: reload → Not connected, grant survives, no card ----------
    await reloadAndBoot(cdp, chrome, appUrl);
    await openSettings();
    await waitForRuntimeCondition(cdp, testidExpr('credential-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-card-2', timeoutMs: 10000 });
    check('E-C5 after reload (not remembered) the credential is Not connected',
      (await testidText('credential-state-' + CRED_NAME)) === 'Not connected',
      await testidText('credential-state-' + CRED_NAME));
    await waitForRuntimeCondition(cdp, testidExpr('always-allowed-section') + ' !== null',
      { process: chrome, phase: 'cred-always', timeoutMs: 5000 });
    check('E-C5 the durable grant survived the reload in Always allowed',
      (await testidText('always-allowed-item-0') || '').includes(ORIGIN)
      && (await testidText('always-allowed-item-0') || '').length > 0,
      await testidText('always-allowed-item-0'));
    await screenshot(cdp, 'c3-always-allowed.png', 'always-allowed-section');
    await closeSettings();
    const hitsBefore5 = upstreamSeen.hits;
    const cardP5 = runTask([curlReply1, 'done.'], 'call the API while disconnected');
    check('E-C5 no approval card although the grant exists',
      (await waitCard(4000)) === false);
    check('E-C5 the task settled', (await cardP5) === 'task-done');
    const r5 = await evaluate(cdp, lastToolResultExpr);
    check('E-C5 the disconnected credential refuses before any send',
      r5 && !r5.success && r5.output.includes('credential ' + CRED_NAME + ' is not connected')
      && r5.output.includes('Settings'),
      JSON.stringify(r5 && r5.output.slice(0, 300)));
    check('E-C5 nothing reached the upstream',
      upstreamSeen.hits === hitsBefore5, JSON.stringify(upstreamSeen.hits));

    // ---------- E-C6: Connect with Remember → reload keeps it ----------
    await openSettings();
    await waitForRuntimeCondition(cdp, testidExpr('credential-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-card-3', timeoutMs: 10000 });
    check('E-C6 Connect opens', (await clickTestid('credential-connect-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('credential-dialog-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-dialog-2', timeoutMs: 5000 });
    check('E-C6 Remember defaults to checked (D12)',
      await evaluate(cdp, 'document.querySelector(\'[data-testid="credential-remember-' + CRED_NAME + '"]\').checked'));
    check('E-C6 the key can be typed', (await setInputValue('credential-input-' + CRED_NAME, TEST_KEY)) === 'set');
    check('E-C6 Connect confirms', (await clickTestid('credential-confirm-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "").indexOf("Connected ····' + KEY_LAST4 + '") === 0',
      { process: chrome, phase: 'cred-connected-2', timeoutMs: 8000 });
    await reloadAndBoot(cdp, chrome, appUrl);
    await openSettings();
    await waitForRuntimeCondition(cdp, testidExpr('credential-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-card-4', timeoutMs: 10000 });
    check('E-C6 after reload (remembered) the credential is Connected ····<last4>',
      (await testidText('credential-state-' + CRED_NAME)) === 'Connected ····' + KEY_LAST4,
      await testidText('credential-state-' + CRED_NAME));

    // ---------- E-C6b: version replacement with a changed binding →
    // needs reconfirmation → Confirm ----------
    const commit2 = await evaluate(cdp,
      '(async function () { var bin = atob(' + JSON.stringify(PKG_B64.v2) + ');'
      + ' var bytes = new Uint8Array(bin.length);'
      + ' for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
      + ' return await window.__locus.capabilityComposition.installPackage(bytes); })()');
    check('E-C6b the replacement installed and re-enabled',
      commit2 && commit2.unchanged === false && commit2.state === 'ready', JSON.stringify(commit2));
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "") === "Needs reconfirmation"',
      { process: chrome, phase: 'cred-reconfirm', timeoutMs: 10000 });
    check('E-C6b the changed binding needs reconfirmation',
      (await testidText('credential-state-' + CRED_NAME)) === 'Needs reconfirmation');
    const oldLine = await testidText('credential-old-binding-' + CRED_NAME);
    check('E-C6b the OLD binding line comes from the durable record',
      typeof oldLine === 'string' && oldLine.includes(ORIGIN + '/v1/tools/'),
      JSON.stringify(oldLine));
    check('E-C6b the standing send line shows the NEW binding',
      (await testidText('credential-sendline-' + CRED_NAME)) === 'Only sent to ' + ORIGIN + '/v2/tools/ as authorization: Bearer …',
      await testidText('credential-sendline-' + CRED_NAME));
    await screenshot(cdp, 'c3-credential-needs-reconfirmation.png', 'credential-' + CRED_NAME);
    check('E-C6b Confirm reconfirms', (await clickTestid('credential-reconfirm-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "").indexOf("Connected ····' + KEY_LAST4 + '") === 0',
      { process: chrome, phase: 'cred-reconfirmed', timeoutMs: 8000 });
    check('E-C6b after Confirm the credential is connected again (value kept, no retype)',
      (await testidText('credential-state-' + CRED_NAME)) === 'Connected ····' + KEY_LAST4);
    await closeSettings();

    // ---------- E-C7: Remove the grant → the next curl asks again ----------
    await openSettings();
    await waitForRuntimeCondition(cdp, testidExpr('always-allowed-item-0') + ' !== null',
      { process: chrome, phase: 'cred-grant-list', timeoutMs: 5000 });
    check('E-C7 Remove is offered', (await clickTestid('always-allowed-remove-0')) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('always-allowed-empty') + ' !== null',
      { process: chrome, phase: 'cred-grant-empty', timeoutMs: 5000 });
    check('E-C7 the list reports Nothing is always allowed',
      (await testidText('always-allowed-empty')) === 'Nothing is always allowed.');
    await closeSettings();
    const hitsBefore7 = upstreamSeen.hits;
    const curlReply2 = '```json\n{"tool":"bash","input":' + JSON.stringify(CURL_V2) + '}\n```';
    const cardP7 = runTask([curlReply2, 'done.'], 'call the API after the grant was removed');
    check('E-C7 the approval card asks again', await waitCard(15000));
    check('E-C7 the request matched the reconfirmed binding (/v2/)',
      (await evaluate(cdp, '(window.__locus.store.pendingApproval||{}).policyKey')) === 'network-write:' + ORIGIN,
      JSON.stringify(await evaluate(cdp, '(window.__locus.store.pendingApproval||{}).policyKey')));
    check('E-C7 Allow once clicked', (await clickBtn('Allow once')) === true);
    check('E-C7 the task settled', (await cardP7) === 'task-done');
    check('E-C7 the request reached the upstream',
      upstreamSeen.hits === hitsBefore7 + 1
      && upstreamSeen.auths[upstreamSeen.auths.length - 1] === 'Bearer ' + TEST_KEY,
      JSON.stringify(upstreamSeen.hits));

    // ---------- E-C8: Disconnect → not connected ----------
    await openSettings();
    check('E-C8 Disconnect arms the confirmation',
      (await clickTestid('credential-disconnect-' + CRED_NAME)) === 'clicked');
    check('E-C8 Confirm disconnect clicked',
      (await clickTestid('credential-disconnect-confirm-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "") === "Not connected"',
      { process: chrome, phase: 'cred-disconnected', timeoutMs: 8000 });
    check('E-C8 the credential is Not connected', (await testidText('credential-state-' + CRED_NAME)) === 'Not connected');
    await closeSettings();
    const hitsBefore8 = upstreamSeen.hits;
    const cardP8 = runTask([curlReply2, 'done.'], 'call the API after disconnect');
    check('E-C8 no approval card for a disconnected credential',
      (await waitCard(4000)) === false);
    check('E-C8 the task settled', (await cardP8) === 'task-done');
    const r8 = await evaluate(cdp, lastToolResultExpr);
    check('E-C8 the disconnected credential refuses before any send',
      r8 && !r8.success && r8.output.includes('is not connected') && r8.output.includes('Settings'),
      JSON.stringify(r8 && r8.output.slice(0, 300)));
    check('E-C8 nothing reached the upstream',
      upstreamSeen.hits === hitsBefore8, JSON.stringify(upstreamSeen.hits));

    // ---------- E-C9: Uninstall → records and secrets rows gone ----------
    await openSettings();
    check('E-C9 uninstall is armed',
      (await clickTestid('capability-package-uninstall-' + CAP_ID)) === 'clicked');
    check('E-C9 the uninstall warning states the credential removal',
      ((await testidText('capability-uninstall-credentials-warning')) || '')
        .includes('Connected credentials of this capability will be removed.'),
      await testidText('capability-uninstall-credentials-warning'));
    check('E-C9 Confirm uninstall clicked',
      (await clickTestid('capability-package-uninstall-confirm-' + CAP_ID)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '!window.__locus.capabilityComposition.list().some(function (c) { return c.id === ' + JSON.stringify(CAP_ID) + '; })',
      { process: chrome, phase: 'cred-uninstalled', timeoutMs: 10000 });
    check('E-C9 the capability is unregistered', true);
    const idb9 = await evaluate(cdp,
      '(async function () {'
      + ' var db = await new Promise(function (res, rej) { var rq = indexedDB.open("locus", 4); rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); }; });'
      + ' function readAll(store) { return new Promise(function (res, rej) { var tx = db.transaction(store, "readonly");'
      + '   var g = tx.objectStore(store).getAll(); g.onsuccess = function () { res(g.result); }; g.onerror = function () { rej(g.error); }; }); }'
      + ' var secrets = await readAll("secrets");'
      + ' var meta = await readAll("meta");'
      + ' var bindingsRow = meta.filter(function (r) { return r.key === "credentialBindings"; })[0] || null;'
      + ' return { capcredRows: secrets.filter(function (r) { return String(r.key || "").indexOf("capcred:") === 0; }).length,'
      + '   bindings: bindingsRow ? (bindingsRow.bindings || []).length : 0 }; })()');
    check('E-C9 no `capcred:` secrets row survives',
      idb9 && idb9.capcredRows === 0, JSON.stringify(idb9));
    check('E-C9 no binding record survives',
      idb9 && idb9.bindings === 0, JSON.stringify(idb9));
    await closeSettings();

    // ---------- E-C10: leak sweep over every durable + rendered surface
    // (the SAME sweep closes E-C13's Skip-for-now step) ----------
    const leakSweep = () => evaluate(cdp,
      '(async function () {'
      + ' var KEY = ' + JSON.stringify(TEST_KEY) + ';'
      + ' var out = { stores: {}, storeCount: 0, vfsFiles: 0, vfsBytes: 0, toolOutputFiles: 0, domBytes: 0, leaked: false, where: "" };'
      + ' var db = await new Promise(function (res, rej) { var rq = indexedDB.open("locus", 4); rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); }; });'
      + ' function readAll(store) { return new Promise(function (res, rej) { var tx = db.transaction(store, "readonly");'
      + '   var g = tx.objectStore(store).getAll(); g.onsuccess = function () { res(g.result); }; g.onerror = function () { rej(g.error); }; }); }'
      + ' var STORES = ["conversations", "presentationEvents", "providerSessions", "providerFrames", "normalizedMessages",'
      + '   "settings", "secrets", "workspaceHandles", "meta", "attachments", "capabilities", "capabilityPackages"];'
      + ' for (var i = 0; i < STORES.length; i++) {'
      + '   var rows = await readAll(STORES[i]);'
      + '   var text = JSON.stringify(rows);'
      + '   out.stores[STORES[i]] = text.length; out.storeCount++;'
      + '   if (text.indexOf(KEY) !== -1) { out.leaked = true; out.where = "idb:" + STORES[i]; }'
      + ' }'
      + ' var vfs = window.__locus.vfs;'
      + ' async function walk(base, depth) {'
      + '   var entries = await vfs.list(base);'
      + '   for (var j = 0; j < entries.length; j++) {'
      + '     var p = base + "/" + entries[j].name;'
      + '     if (entries[j].kind === "directory") { if (depth > 0) await walk(p, depth - 1); }'
      + '     else {'
      + '       var text2 = "";'
      + '       try { text2 = await vfs.read(p); } catch (e) {'
      + '         try { text2 = String(await vfs.readBytes(p)); } catch (e2) { text2 = ""; } }'
      + '       out.vfsFiles++; out.vfsBytes += text2.length;'
      + '       if (p.indexOf("tool-outputs/") !== -1 && entries[j].name.slice(-4) === ".txt") out.toolOutputFiles++;'
      + '       if (text2.indexOf(KEY) !== -1) { out.leaked = true; out.where = "vfs:" + p; }'
      + '     }'
      + '   }'
      + ' }'
      + ' await walk("/home/locus/history", 3);'
      + ' var dom = document.body.textContent || "";'
      + ' out.domBytes = dom.length;'
     + ' if (dom.indexOf(KEY) !== -1) { out.leaked = true; out.where = "dom"; }'
     + ' return out; })()', 60000);
    const sweep = await leakSweep();
    check('E-C10 every IndexedDB store was swept and is key-free',
      sweep && !sweep.leaked && sweep.storeCount === 12, JSON.stringify(sweep && sweep.stores));
    check('E-C10 the history VFS was swept (real files read), key-free',
      sweep && !sweep.leaked && sweep.vfsFiles > 0 && sweep.vfsBytes > 0,
      JSON.stringify({ files: sweep && sweep.vfsFiles, bytes: sweep && sweep.vfsBytes, where: sweep && sweep.where }));
    check('E-C10 at least one externalized tool-outputs file existed and is key-free',
      sweep && sweep.toolOutputFiles > 0, JSON.stringify(sweep && sweep.toolOutputFiles));
    check('E-C10 the page DOM is key-free',
      sweep && !sweep.leaked && sweep.domBytes > 0, sweep && sweep.where);

    // ---------- E-C11: phone width — four approval buttons stay visible ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 360, height: 800, deviceScaleFactor: 1, mobile: true,
    });
    await new Promise((r) => setTimeout(r, 300));
    await evaluate(cdp,
      'window.__credP11 = window.__locus.approvals.requestTestPermission({'
      + ' policyKey: "e2e:cred:responsive", summary: "POST ' + ORIGIN + '/v2/tools/search" }); "requested"');
    check('E-C11 the approval card appears at phone width', await waitCard(8000));
    const viewport = await evaluate(cdp, '({ w: window.innerWidth, h: window.innerHeight })');
    const btns11 = await evaluate(cdp,
      '(function () { return [...document.querySelectorAll(".approval-btn")].map(function (b) {'
      + ' var r = b.getBoundingClientRect();'
      + ' return { label: b.textContent.trim(), w: r.width, h: r.height, left: r.left, right: r.right, bottom: r.bottom }; }); })()');
    check('E-C11 all four buttons render fully inside a 360px viewport',
      viewport.w === 360 && btns11.length === 4 && btns11.every((b) =>
        b.w > 0 && b.h > 0 && b.right <= viewport.w + 1 && b.left >= -1 && b.bottom <= viewport.h + 1),
      JSON.stringify({ viewport: viewport, buttons: btns11 }));
    check('E-C11 no horizontal page overflow',
      await evaluate(cdp, 'document.documentElement.scrollWidth <= window.innerWidth + 1'),
      await evaluate(cdp, 'document.documentElement.scrollWidth + " vs " + window.innerWidth'));
    check('E-C11 Deny resolves', (await clickBtn('Deny')) === true);
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    // ---------- E-C12: D12 — the UI import dialog moves to the
    // connect-credentials step. The capability was uninstalled in E-C9,
    // so this is a clean first install through the REAL import store
    // path (begin from bytes + the dialog's own Import button). ----------
    await openSettings(); // the import dialog renders inside the panel
    const import12 = await evaluate(cdp,
      '(async function () { var bin = atob(' + JSON.stringify(PKG_B64.v1) + ');'
      + ' var bytes = new Uint8Array(bin.length);'
      + ' for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
      + ' await window.__locus.actions.beginCapabilityImportFromBytes(bytes, "d12-import.locus");'
      + ' return !!window.__locus.store.capabilityImport; })()');
    check('E-C12 the import dialog opened', import12 === true);
    await waitForRuntimeCondition(cdp, testidExpr('capability-import-confirm') + ' !== null',
      { process: chrome, phase: 'cred-import-confirm', timeoutMs: 5000 });
    check('E-C12 Import confirms', (await clickTestid('capability-import-confirm')) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('import-credential-row-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-import-connect', timeoutMs: 10000 });
    check('E-C12 the connect-credentials step appeared with label and $NAME',
      ((await testidText('import-credential-row-' + CRED_NAME)) || '').includes('E2E test credential')
      && ((await testidText('import-credential-row-' + CRED_NAME)) || '').includes('$' + CRED_NAME),
      await testidText('import-credential-row-' + CRED_NAME));
    check('E-C12 the step restates the send rule',
      ((await testidText('import-credential-row-' + CRED_NAME)) || '')
        .includes('Only sent to ' + ORIGIN + '/v1/tools/'),
      await testidText('import-credential-row-' + CRED_NAME));
    check('E-C12 Remember defaults to checked in the import step',
      await evaluate(cdp, 'document.querySelector(\'[data-testid="import-credential-remember-' + CRED_NAME + '"]\').checked'));
    check('E-C12 the step carries the shared-computer note',
      ((await testidText('import-credential-row-' + CRED_NAME)) || '')
        .includes('Saved in this browser on this device. Uncheck on a shared computer.'),
      await testidText('import-credential-row-' + CRED_NAME));
    await screenshot(cdp, 'c3-import-connect-step.png', 'capability-import-dialog');
    check('E-C12 the key can be typed', (await setInputValue('import-credential-input-' + CRED_NAME, TEST_KEY)) === 'set');
    check('E-C12 Connect confirms', (await clickTestid('capability-import-connect')) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "").indexOf("Connected ····' + KEY_LAST4 + '") === 0',
      { process: chrome, phase: 'cred-import-connected', timeoutMs: 10000 });
    check('E-C12 the card reads Connected with ONLY the last 4 characters',
      (await testidText('credential-state-' + CRED_NAME)) === 'Connected ····' + KEY_LAST4,
      await testidText('credential-state-' + CRED_NAME));
    check('E-C12 the dialog closed after Connect',
      (await testidText('capability-import-dialog')) === null);
    check('E-C12 the full key appears nowhere in the page DOM',
      !(await evaluate(cdp, 'document.body.textContent.includes(' + JSON.stringify(TEST_KEY) + ')')));
    await reloadAndBoot(cdp, chrome, appUrl);
    await openSettings();
    await waitForRuntimeCondition(cdp, testidExpr('credential-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-import-card', timeoutMs: 10000 });
    check('E-C12 after reload the credential is STILL Connected (saved by default)',
      (await testidText('credential-state-' + CRED_NAME)) === 'Connected ····' + KEY_LAST4,
      await testidText('credential-state-' + CRED_NAME));

    // ---------- E-C13: D12 — Skip for now. Disconnect + uninstall give a
    // clean slate; the second import's step gets the key TYPED, then Skip
    // for now keeps the credential Not connected and the sweep (as E-C10)
    // proves the typed value never surfaced anywhere. ----------
    check('E-C13 Disconnect arms the confirmation',
      (await clickTestid('credential-disconnect-' + CRED_NAME)) === 'clicked');
    check('E-C13 Confirm disconnect clicked',
      (await clickTestid('credential-disconnect-confirm-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "") === "Not connected"',
      { process: chrome, phase: 'cred-import-disconnected', timeoutMs: 8000 });
    check('E-C13 uninstall is armed',
      (await clickTestid('capability-package-uninstall-' + CAP_ID)) === 'clicked');
    check('E-C13 Confirm uninstall clicked',
      (await clickTestid('capability-package-uninstall-confirm-' + CAP_ID)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '!window.__locus.capabilityComposition.list().some(function (c) { return c.id === ' + JSON.stringify(CAP_ID) + '; })',
      { process: chrome, phase: 'cred-import-uninstalled', timeoutMs: 10000 });
    // The durable record delete trails the manager unregister (async
    // storage mutation) — poll it with the AWAITING evaluate helper
    // (waitForRuntimeCondition does not await promises); otherwise the
    // re-import below would be judged 'same'.
    for (let i = 0; i < 200; i++) {
      const ids = await evaluate(cdp,
        'window.__locus.persistence().loadCapabilityPackages().then(function (r) {'
        + ' return r.map(function (x) { return x.id; }); })');
      if (Array.isArray(ids) && !ids.includes(CAP_ID)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const import13 = await evaluate(cdp,
      '(async function () { var bin = atob(' + JSON.stringify(PKG_B64.v1) + ');'
      + ' var bytes = new Uint8Array(bin.length);'
      + ' for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
      + ' await window.__locus.actions.beginCapabilityImportFromBytes(bytes, "d13-import.locus");'
      + ' return !!window.__locus.store.capabilityImport; })()');
    check('E-C13 the import dialog opened', import13 === true);
    await waitForRuntimeCondition(cdp, testidExpr('capability-import-confirm') + ' !== null',
      { process: chrome, phase: 'cred-import-confirm-2', timeoutMs: 5000 });
    check('E-C13 Import confirms', (await clickTestid('capability-import-confirm')) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('import-credential-row-' + CRED_NAME) + ' !== null',
      { process: chrome, phase: 'cred-import-connect-2', timeoutMs: 10000 });
    check('E-C13 the key can be typed', (await setInputValue('import-credential-input-' + CRED_NAME, TEST_KEY)) === 'set');
    check('E-C13 Skip for now closes the step', (await clickTestid('capability-import-skip')) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('capability-import-dialog') + ' === null',
      { process: chrome, phase: 'cred-import-skip-closed', timeoutMs: 5000 });
    check('E-C13 the dialog closed', (await testidText('capability-import-dialog')) === null);
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "") === "Not connected"',
      { process: chrome, phase: 'cred-import-skip-state', timeoutMs: 8000 });
    check('E-C13 the credential stays Not connected',
      (await testidText('credential-state-' + CRED_NAME)) === 'Not connected',
      await testidText('credential-state-' + CRED_NAME));
    const sweep13 = await leakSweep();
    check('E-C13 the leak sweep (as E-C10) found no trace of the typed key',
      sweep13 && !sweep13.leaked && sweep13.storeCount === 12 && sweep13.vfsFiles > 0 && sweep13.domBytes > 0,
      JSON.stringify({ where: sweep13 && sweep13.where, stores: sweep13 && sweep13.storeCount }));
  } catch (e) {
    console.error(e && e.stack || e);
    failed++;
  } finally {
    if (cdp) { try { cdp.close(); } catch (e2) { /* best effort */ } }
    if (chrome) {
      const cleanupChrome = await closeChrome(chrome);
      if (!cleanupChrome.exited) console.error('credentials Chrome did not exit after bounded cleanup');
      if (cleanupChrome.profileError) console.error('profile cleanup failed: ' + cleanupChrome.profileError);
    }
    globalThis.fetch = realFetch;
    for (const s of [targetServer, appServer]) {
      try { await new Promise((r) => s.close(r)); } catch (e2) { /* best effort */ }
    }
  }

  console.log('===');
  console.log('screenshots written to ' + SHOT_DIR + ' (' + shotCount + ')');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' credentials e2e checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
