// M3c review round C — STORAGE ADAPTER PACKAGED-BUILD browser e2e.
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
//     /src, /vendor, /@vite/client, /@fs and node_modules paths are
//     violations; the storageHost entry chunk parsed out of the built
//     host HTML must be the loaded entry, and the product main entry
//     chunk parsed out of dist/index.html must NEVER load;
//   - the 23 storage behavior checks are the SHARED table
//     (tests/helpers/m3c-storage-checks.cjs) — identical to the source
//     gate, never weakened;
//   - its own throwaway Chrome profile (fresh IndexedDB/OPFS — a dirty
//     profile could make the REAL-storage checks pass vacuously);
//   - a built-in NEGATIVE SELF-PROOF: a temporary COPY of dist/ with the
//     host page (case A) or its entry chunk (case B) removed must FAIL
//     the driver — no fallback to any source page may pass. The self-
//     proof works on temp copies only; the real dist/ (other agents'
//     build artifact) is never modified.
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
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { runStorageChecks } = require('./helpers/m3c-storage-checks.cjs');

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
// `distDir`). Returns { booted }. Check results go through the injected
// checker (the self-proof injects its own and requires failure).
async function runBuiltGate(pageUrl, distDir, check) {
  let chrome = null;
  let profileDir = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3c-storage-built-profile-'));
    chrome = await launchChrome(pageUrl, {
      chromePath: process.env.CHROME,
      label: 'M3c storage built-gate Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
    const cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__m3c && window.__m3c.ready)',
      { process: chrome, phase: 'm3c-storage-built-boot', timeoutMs: 15000 });
    const bootData = await evaluate(cdp, 'window.__m3c.bootData');
    if (!bootData) {
      throw new Error('packaged host boot failed: '
        + JSON.stringify(await evaluate(cdp, 'window.__m3c.error')));
    }

    let r = null;
    try { r = await evaluate(cdp, 'window.__m3c.runAll()', 60000); } catch (e) { r = null; }
    // The 23 shared checks (B0–S4) — identical table to the source gate.
    runStorageChecks(check, bootData, r);

    // ---- built-artifact audit (this gate's reason to exist) ----
    const names = await evaluate(cdp, 'window.__m3c.resources()');
    const audit = auditResources(names || []);
    check('GA every loaded resource is the dist host page, a hashed dist chunk/asset, or the browser favicon (no /src, /vendor, /@vite, /@fs, node_modules)',
      audit.violations.length === 0,
      JSON.stringify({ violations: audit.violations, allowed: audit.allowed }));
    const hostEntry = entryChunkFromHtml(distDir, HOST_PAGE_PATH);
    check('GB the storageHost entry chunk parsed from the built host page IS the loaded entry',
      !!hostEntry && audit.allowed.includes(hostEntry),
      'expected=' + hostEntry + ' | loaded=' + JSON.stringify(audit.allowed));
    const mainEntry = entryChunkFromHtml(distDir, 'index.html');
    check('GC the product main entry chunk parsed from dist/index.html NEVER loads',
      !!mainEntry && !(names || []).some((n) => normalizeResource(n) === mainEntry),
      'mainEntry=' + mainEntry);
    const errors = await evaluate(cdp, 'window.__m3c.errors');
    check('GD zero page errors / unhandled rejections (packaged page)',
      (errors || []).length === 0, JSON.stringify(errors));
    return { booted: true };
  } finally {
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
  }
}

// A static server over a THROWAWAY dist copy — for the negative
// self-proof only (the positive path must run the real vite preview).
async function serveDistCopy(rootDir) {
  const port = await allocateFreePort();
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname); }
    catch (e) { res.statusCode = 400; return res.end(); }
    const abs = path.join(rootDir, rel.replace(/^\/+/, ''));
    if (!abs.startsWith(rootDir)) { res.statusCode = 403; return res.end(); }
    fsSync.readFile(abs, (err, data) => {
      if (err) { res.statusCode = 404; return res.end('not found'); }
      res.setHeader('content-type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
      res.end(data);
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + port + '/' };
}

let selfProofFailures = 0;

// One negative case: break a COPY of dist, run the same driver, require
// the gate to FAIL (booted=false or a check failed). A pass here means
// the driver can be fooled into accepting a broken/non-packaged page.
async function selfProofCase(tag, label, breakIt) {
  const tmpDist = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3c-storage-built-selfproof-'));
  let service = null;
  try {
    await fs.cp(DIST, tmpDist, { recursive: true });
    await breakIt(tmpDist);
    service = await serveDistCopy(tmpDist);
    const checker = makeChecker();
    let booted = false;
    let bootError = null;
    try {
      const r = await runBuiltGate(service.url + HOST_PAGE_PATH, tmpDist, checker.check);
      booted = r.booted;
    } catch (e) {
      bootError = String(e && e.message || e).split('\n')[0];
    }
    const gateFailed = !booted || checker.failed > 0;
    console.log((gateFailed ? 'PASS ' : 'FAIL ') + 'SELFPROOF-' + tag + ' ' + label
      + ' → the packaged gate must fail'
      + (gateFailed
        ? (bootError ? ' | driver error (as required): ' + bootError.slice(0, 300) : ' | check failures: ' + checker.failures.length)
        : ' | UNEXPECTED PASS — the driver accepted a broken dist (fallback risk)'));
    if (!gateFailed) selfProofFailures++;
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
  // Case A: the host page is absent from the packaged artifacts — a dev
  // server might fall back to some other page; the gate must still fail.
  await selfProofCase('A', 'the dist host page is missing', async (tmpDist) => {
    await fs.rm(path.join(tmpDist, HOST_PAGE_PATH), { force: true });
  });
  // Case B: the page serves but its entry chunk is gone — the bundle is
  // broken and nothing may paper over that.
  await selfProofCase('B', 'the storageHost entry chunk is missing', async (tmpDist) => {
    const entry = entryChunkFromHtml(tmpDist, HOST_PAGE_PATH);
    if (!entry) throw new Error('self-proof B could not parse the host entry chunk from the built page');
    await fs.rm(path.join(tmpDist, entry), { force: true });
  });
}

async function main() {
  console.log('=== packaged-build storage gate: ' + DEFAULT_URL);
  const checker = makeChecker();
  let booted = false;
  let suiteError = null;
  try {
    const r = await runBuiltGate(DEFAULT_URL, DIST, checker.check);
    booted = r.booted;
  } catch (e) {
    suiteError = e;
    console.error('SUITE ERROR (positive pass): ' + (e && e.message || e));
  }
  const positiveOk = booted && checker.failed === 0;
  console.log('---');
  console.log(positiveOk
    ? 'positive pass: all ' + checker.passed + ' checks passed'
    : 'positive pass FAILED (' + (checker.failures.length || 1) + ' failure(s)'
      + (suiteError ? ', suite error' : '') + ')');

  await runSelfProof();

  console.log('---');
  const ok = positiveOk && selfProofFailures === 0;
  if (!ok) {
    const parts = [];
    if (!positiveOk) parts.push('positive pass (' + (checker.failures.length || 1) + ' failure(s))');
    if (selfProofFailures) parts.push('self-proof: ' + selfProofFailures + ' case(s) unexpectedly passed');
    console.log('GATE FAILED — ' + parts.join('; '));
    process.exit(1);
  }
  console.log('all ' + checker.passed + ' behavior/audit checks + 2 negative self-proof cases passed');
}

main().catch((e) => { console.error('SUITE ERROR: ' + (e && e.message || e)); process.exit(1); });
