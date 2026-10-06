// M3c review round C — STORAGE ADAPTER PACKAGED-BUILD browser e2e.
// (Round 2, F2: the negative self-proof is now classified by a structured
// judge — an infrastructure failure can never count as the expected
// broken-artifact rejection again.)
//
// The source-ESM counterpart (tests/e2e-m3c-storage-adapters.cjs) serves
// /src and the installed packages raw through an import map — it never
// touches the Vite build, so counting it as a packaged-artifact gate was
// wrong (docs/M3C-REVIEW-C.md). THIS suite is the real artifact gate:
//   - the host page (tests/m3c-storage-host.html) is a REAL vite build
//     input; the driver talks to vite preview's dist ONLY — it serves no
//     /src, no /vendor, no node_modules file, and uses no import map;
//   - the loaded resource set is audited: only the dist host page, hashed
//     dist chunks/assets and the browser-automatic favicon may load —
//     /src, /vendor, /@vite, /@fs and node_modules paths are
//     violations; the storageHost entry chunk parsed out of the built
//     host HTML must be the loaded entry, and the product main entry
//     chunk parsed out of dist/index.html must NEVER load;
//   - the 23 storage behavior checks are the SHARED table
//     (tests/helpers/m3c-storage-checks.cjs) — identical to the source
//     gate, never weakened;
//   - its own throwaway Chrome profile (fresh IndexedDB/OPFS — a dirty
//     profile could make the REAL-storage checks pass vacuously);
//   - a built-in NEGATIVE SELF-PROOF with a STRUCTURED judge
//     (tests/helpers/m3c-storage-built-verdict.cjs — one implementation
//     shared with the unit tests): a temporary COPY of dist/ with the
//     host page (case A) or its entry chunk (case B) removed must show
//     REQUEST-LEVEL evidence of the expected breakage (the exact URL
//     requested, the explicit 404, the host never booting, no fallback
//     page) — a browser/CDP infrastructure failure, an unrelated
//     readiness timeout, or a full-dist misfeed FAILS the self-proof
//     instead of passing it. The self-proof works on temp copies only;
//     the real dist/ (other agents' build artifact) is never modified.
// Run: npm run build, serve dist with `vite preview` (the browser-gates
// orchestrator does), then:
//   node tests/e2e-m3c-storage-built.cjs
// (Registration into tests/run-browser-gates.cjs is integration D's
// change; default URL matches the orchestrator's preview.)

'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, isProcessAlive, launchChrome,
  waitForCdp, waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { runStorageChecks } = require('./helpers/m3c-storage-checks.cjs');
const { classifySelfProof } = require('./helpers/m3c-storage-built-verdict.cjs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const HOST_PAGE_PATH = 'tests/m3c-storage-host.html';
const DEFAULT_URL = process.env.E2E_M3C_STORAGE_BUILT_URL
  || 'http://127.0.0.1:4173/' + HOST_PAGE_PATH;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.whl': 'application/zip',
};

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 30000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function evaluateSafe(cdp, expression, timeoutMs) {
  try { return await evaluate(cdp, expression, timeoutMs); } catch (e) { return null; }
}

function makeChecker() {
  let passed = 0, failed = 0;
  const failures = [];
  return {
    check(name, condition, detail) {
      if (condition) { passed++; console.log('PASS ' + name); }
      else {
        failed++; failures.push(name);
        console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 600) : ''));
      }
    },
    get passed() { return passed; },
    get failed() { return failed; },
    failures,
  };
}

function normalizeResource(name) {
  return name.replace(/^https?:\/\/[^/]+\//, '');
}

// The ONLY resources a packaged host page may load: the dist host page
// itself, the browser-automatic favicon, and hashed dist assets (Vite's
// emitted chunk/asset names — `name-<8-char hash>.<ext>`). Everything
// else is a violation: dev-server paths (@vite, @fs), source trees
// (/src, /vendor), node_modules files posing as a bundle, unhashed
// files, other HTML pages.
function auditResources(names) {
  const violations = [];
  const allowed = [];
  for (const full of names) {
    if (/\/src\/|\/vendor\/|\/@vite|\/@fs\/|node_modules/.test(full)) { violations.push(full); continue; }
    const name = normalizeResource(full);
    if (name === HOST_PAGE_PATH || name === 'favicon.ico') { allowed.push(name); continue; }
    if (/^assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(js|css|json|md|whl|svg|png|jpg|woff2?)$/.test(name)) {
      allowed.push(name);
      continue;
    }
    violations.push(name);
  }
  return { allowed, violations };
}

// The module entry chunk a built HTML page loads (dist-root-relative),
// parsed from the built HTML itself — not guessed.
function entryChunkFromHtml(distDir, htmlRelPath) {
  let html;
  try { html = fsSync.readFileSync(path.join(distDir, htmlRelPath), 'utf8'); }
  catch (e) { return null; }
  const m = html.match(/<script type="module"[^>]*\ssrc="([^"]+)"/);
  if (!m) return null;
  const dir = path.posix.dirname(htmlRelPath.split(path.sep).join('/'));
  const joined = dir === '.' ? m[1] : dir + '/' + m[1];
  return path.posix.normalize(joined);
}

// One full pass of the packaged gate against `pageUrl` (a preview of
// `distDir`). Returns a STRUCTURED result — never throws for classified
// outcomes:
//   { kind: 'completed', observations }              — booted, checks ran, passed
//   { kind: 'assertion', observations }              — booted, checks ran, failed
//   { kind: 'boot-error', observations, error }      — booted, reported its own failure
//   { kind: 'no-boot', observations, error }         — navigated, never became ready
//   { kind: 'infrastructure', phase, error, observations } — browser/CDP/navigation
// observations carry request-level evidence: CDP Network events wired
// BEFORE navigation (about:blank attach first — the target page's FIRST
// request is observed, not inferred from a readiness timeout), the boot
// flag, and any fallback loads outside the allowed set. The verdict is
// ONE shared judge (tests/helpers/m3c-storage-built-verdict.cjs).
async function runBuiltGate(pageUrl, distDir, checker, opts = {}) {
  const noBootWaitMs = opts.noBootWaitMs || 15000;
  const observations = { requests: [], pageBooted: false, fallbackLoads: [], pageErrors: null };
  let chrome = null;
  let profileDir = null;
  let cdp = null;
  const infra = (phase, e) => ({ kind: 'infrastructure', phase, error: e, observations });
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3c-storage-built-profile-'));
    try {
      chrome = await launchChrome('about:blank', {
        chromePath: process.env.CHROME,
        label: 'M3c storage built-gate Chrome',
        profileDir,
        extraArgs: ['--window-size=1280,800'],
      });
    } catch (e) {
      return infra('browser-launch', e);
    }
    try {
      await waitForCdp(chrome, { timeoutMs: 15000 });
      const target = await waitForPageTarget(chrome, 'about:blank', { timeoutMs: 15000 });
      cdp = await connectToTarget(target);
      await cdp.send('Page.enable');
      await cdp.send('Network.enable');
    } catch (e) {
      return infra('cdp', e);
    }

    // Request-level observation, installed BEFORE navigating to the target.
    const byRequestId = new Map();
    cdp.on('Network.requestWillBeSent', (p) => {
      const entry = { url: p.request.url, status: null, failed: false, errorText: null };
      observations.requests.push(entry);
      byRequestId.set(p.requestId, entry);
    });
    cdp.on('Network.responseReceived', (p) => {
      const entry = byRequestId.get(p.requestId)
        || observations.requests.find((x) => x.url === p.response.url && x.status === null);
      if (entry) entry.status = p.response.status;
    });
    cdp.on('Network.loadingFailed', (p) => {
      const entry = byRequestId.get(p.requestId);
      if (entry) { entry.failed = true; entry.errorText = p.errorText || 'loading failed'; }
    });

    let hostOrigin = null;
    try { hostOrigin = new URL(pageUrl).origin; } catch (e) { return infra('navigation', e); }
    try {
      const nav = await cdp.send('Page.navigate', { url: pageUrl });
      if (nav && nav.errorText) return infra('navigation', new Error('Page.navigate: ' + nav.errorText));
    } catch (e) {
      return infra('navigation', e);
    }

    // Successful loads outside {the host page, hashed dist assets} — a
    // fallback page starting instead of the broken target.
    const assetPathRe = /^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8}\.(js|css|json|md|whl|svg|png|jpg|woff2?)$/;
    const computeFallbacks = () => {
      observations.fallbackLoads = observations.requests.filter((r) => {
        if (r.status !== 200) return false;
        if (r.url === pageUrl) return false;
        try { return !(new URL(r.url).origin === hostOrigin && assetPathRe.test(new URL(r.url).pathname)); } catch (e) { return true; }
      }).map((r) => r.url);
    };

    let booted = false;
    try {
      await waitForRuntimeCondition(cdp, '!!(window.__m3c && window.__m3c.ready)',
        { process: chrome, phase: 'm3c-storage-built-boot', timeoutMs: noBootWaitMs });
      booted = true;
    } catch (e) {
      computeFallbacks();
      // A browser that died mid-wait is infrastructure, not "no-boot".
      if (!isProcessAlive(chrome)) return infra('cdp', e);
      return { kind: 'no-boot', observations, error: e };
    }
    observations.pageBooted = true;

    const bootData = await evaluateSafe(cdp, 'window.__m3c.bootData');
    if (!bootData) {
      computeFallbacks();
      return {
        kind: 'boot-error',
        observations,
        error: new Error('packaged host boot failed: ' + JSON.stringify(await evaluateSafe(cdp, 'window.__m3c.error'))),
      };
    }

    let r = null;
    try { r = await evaluate(cdp, 'window.__m3c.runAll()', 60000); } catch (e) { r = null; }
    // The 23 shared checks (B0–S4) — identical table to the source gate.
    runStorageChecks(checker.check, bootData, r);

    // ---- built-artifact audit (this gate's reason to exist) ----
    const names = await evaluate(cdp, 'window.__m3c.resources()');
    const audit = auditResources(names || []);
    checker.check('GA every loaded resource is the dist host page, a hashed dist chunk/asset, or the browser favicon (no /src, /vendor, /@vite, /@fs, node_modules)',
      audit.violations.length === 0,
      JSON.stringify({ violations: audit.violations, allowed: audit.allowed }));
    const hostEntry = entryChunkFromHtml(distDir, HOST_PAGE_PATH);
    checker.check('GB the storageHost entry chunk parsed from the built host page IS the loaded entry',
      !!hostEntry && audit.allowed.includes(hostEntry),
      'expected=' + hostEntry + ' | loaded=' + JSON.stringify(audit.allowed));
    const mainEntry = entryChunkFromHtml(distDir, 'index.html');
    checker.check('GC the product main entry chunk parsed from dist/index.html NEVER loads',
      !!mainEntry && !(names || []).some((n) => normalizeResource(n) === mainEntry),
      'mainEntry=' + mainEntry);
    const errors = await evaluateSafe(cdp, 'window.__m3c.errors');
    observations.pageErrors = errors || [];
    checker.check('GD zero page errors / unhandled rejections (packaged page)',
      (errors || []).length === 0, JSON.stringify(errors));
    computeFallbacks();
    return { kind: checker.failed > 0 ? 'assertion' : 'completed', observations };
  } finally {
    if (cdp) { try { cdp.close(); } catch (e) { /* best effort */ } }
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

// A static server over a THROWAWAY dist copy — for the negative
// self-proof only (the positive path must run the real vite preview).
// Every request+status is logged: the server's own record the judge
// cross-checks against the browser-side CDP observation.
async function serveDistCopy(rootDir) {
  const port = await allocateFreePort();
  const log = [];
  const record = (req, status) => {
    try { log.push({ path: new URL(req.url, 'http://127.0.0.1').pathname, status }); } catch (e) { /* ignore */ }
  };
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (e) { res.statusCode = 400; record(req, 400); return res.end(); }
    const abs = path.join(rootDir, rel.replace(/^\/+/, ''));
    if (!abs.startsWith(rootDir)) { res.statusCode = 403; record(req, 403); return res.end(); }
    fsSync.readFile(abs, (err, data) => {
      if (err) { res.statusCode = 404; record(req, 404); return res.end('not found'); }
      res.setHeader('content-type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
      record(req, 200);
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + port + '/', log };
}

let selfProofFailures = 0;

// One negative case: break a COPY of dist, run the SAME driver, and
// require the SHARED judge to see the expected broken-artifact evidence.
// An infrastructure failure, an unrelated readiness timeout, a fallback
// page, or a full-dist misfeed is a JUDGED FAILURE (the old code treated
// any driver exception as a pass — "PASS SELFPROOF" while Chrome never
// launched).
async function selfProofCase(tag, label, caseKind, breakIt) {
  const tmpDist = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3c-storage-built-selfproof-'));
  let service = null;
  try {
    await fs.cp(DIST, tmpDist, { recursive: true });
    await breakIt(tmpDist);
    service = await serveDistCopy(tmpDist);
    const pageUrl = service.url + HOST_PAGE_PATH;
    const entryChunk = entryChunkFromHtml(DIST, HOST_PAGE_PATH);
    const checker = makeChecker();
    const result = await runBuiltGate(pageUrl, tmpDist, checker, { noBootWaitMs: 10000 });
    result.observations.serverLog = service.log;
    const expected = {
      hostUrl: pageUrl,
      entryChunkUrl: entryChunk ? service.url + entryChunk : null,
    };
    const verdict = classifySelfProof(caseKind, expected, result);
    console.log((verdict.pass ? 'PASS ' : 'FAIL ') + 'SELFPROOF-' + tag + ' ' + label
      + ' → the packaged gate must fail with request-level evidence');
    console.log('  judge: ' + verdict.reason);
    console.log('  evidence: ' + JSON.stringify(verdict.evidence));
    console.log('  driver kind: ' + result.kind + (result.error ? ' | driver error: ' + String(result.error.message || result.error).slice(0, 200) : ''));
    console.log('  server log: ' + JSON.stringify(service.log));
    if (!verdict.pass) selfProofFailures++;
  } finally {
    if (service) { try { await new Promise((r) => service.server.close(r)); } catch (e) {} }
    try { await fs.rm(tmpDist, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch (e) {}
  }
}

async function runSelfProof() {
  if (!fsSync.existsSync(path.join(DIST, HOST_PAGE_PATH))) {
    throw new Error('self-proof needs a real build first: dist/' + HOST_PAGE_PATH
      + ' is missing — run `npm run build` (the real dist/ is never modified)');
  }
  console.log('\n=== negative self-proof (temporary dist copies; the real dist/ is untouched) ===');
  // Case A: the host page is absent from the packaged artifacts — the
  // browser must be PROVEN to have requested the exact missing URL and
  // received the explicit 404, the host must never boot, and nothing may
  // fall back to another page (the copy still contains index.html).
  await selfProofCase('A', 'the dist host page is missing', 'host-html-missing', async (tmpDist) => {
    await fs.rm(path.join(tmpDist, HOST_PAGE_PATH), { force: true });
  });
  // Case B: the page serves but its entry chunk is gone — the host HTML
  // must be PROVEN served (200), the exact entry chunk request PROVEN
  // failed/404, and the host must never boot with no source fallback.
  await selfProofCase('B', 'the storageHost entry chunk is missing', 'entry-chunk-missing', async (tmpDist) => {
    const entry = entryChunkFromHtml(tmpDist, HOST_PAGE_PATH);
    if (!entry) throw new Error('self-proof B could not parse the host entry chunk from the built page');
    await fs.rm(path.join(tmpDist, entry), { force: true });
  });
}

async function main() {
  console.log('=== packaged-build storage gate: ' + DEFAULT_URL);
  const checker = makeChecker();
  let positiveOk = false;
  let positiveResult = null;
  try {
    positiveResult = await runBuiltGate(DEFAULT_URL, DIST, checker);
    if (positiveResult.kind === 'infrastructure') {
      console.error('SUITE ERROR (positive pass) [' + positiveResult.phase + ']: '
        + (positiveResult.error && positiveResult.error.message || positiveResult.error));
    } else if (positiveResult.kind !== 'completed') {
      console.error('positive pass did not complete cleanly: ' + positiveResult.kind
        + (positiveResult.error ? ' — ' + String(positiveResult.error.message || positiveResult.error).slice(0, 300) : ''));
    }
    positiveOk = positiveResult.kind === 'completed' && checker.failed === 0;
  } catch (e) {
    console.error('SUITE ERROR (positive pass): ' + (e && e.message || e));
  }
  console.log('---');
  console.log(positiveOk
    ? 'positive pass: all ' + checker.passed + ' checks passed'
    : 'positive pass FAILED (' + (checker.failures.length || 1) + ' failure(s)'
      + (positiveResult && positiveResult.kind ? ', driver kind=' + positiveResult.kind : '') + ')');

  await runSelfProof();

  console.log('---');
  const ok = positiveOk && selfProofFailures === 0;
  if (!ok) {
    const parts = [];
    if (!positiveOk) parts.push('positive pass (' + (checker.failures.length || 1) + ' failure(s))');
    if (selfProofFailures) parts.push('self-proof: ' + selfProofFailures + ' case(s) failed the judge (infra failure, missing evidence, or unexpected pass)');
    console.log('GATE FAILED — ' + parts.join('; '));
    process.exit(1);
  }
  console.log('all ' + checker.passed + ' behavior/audit checks + 2 negative self-proof cases passed');
}

main().catch((e) => { console.error('SUITE ERROR: ' + (e && e.message || e)); process.exit(1); });
