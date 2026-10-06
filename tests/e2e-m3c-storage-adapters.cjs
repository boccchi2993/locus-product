// M3c-B BROWSER e2e — SOURCE-ESM gate (review round C pins the name to
// the true nature). This suite does NOT exercise the Vite build: it
// starts its OWN HTTP server, serves the Product /src files and the
// installed locus-runtime / locus-harness package sources RAW, and maps
// bare specifiers with an import map. What it proves: the five converted
// Product modules behave on real browser storage as real ES modules over
// the two product API files (no deep core import anywhere):
//
//   P   REAL IndexedDB: schema v3 migration on open, settings round trip,
//       remembered credentials keyed through the REAL harness credential
//       identity, provider frames, atomic deleteConversation
//   O   REAL OPFS: home skeleton, privileged plugin write/read, attachment
//       bytes ingest/resolve through the REAL IDB+OPFS pair, corruption
//       refused, clear
//   C   capability package: the REAL fixture project validated/built
//       through the REAL harness descriptor validators; the lock hash is
//       sha256Hex and the page's crypto.subtle oracle agrees
//   R   replay validators: the persistence surface IS the harness entry
//       function; valid prefix accepted, corrupted prefix rejected
//   S   skill instance contract: harness-owned marker refused, path
//       identity, confirmation required
//
// The PACKAGED-BUILD counterpart is tests/e2e-m3c-storage-built.cjs: it
// drives dist/tests/m3c-storage-host.html (a REAL vite build input)
// through vite preview only — docs/M3C-REVIEW-C.md records why this
// suite must not be counted as a packaged-artifact gate. Both gates share
// the scenario engine (tests/helpers/m3c-storage-shared.js) and the
// 23-check table (tests/helpers/m3c-storage-checks.cjs), so the storage
// semantics exist exactly once and cannot drift.
//
// In-page doubles are storage/approval PORTS only. Run:
//   node tests/e2e-m3c-storage-adapters.cjs
// (e2e registry wiring is integration D's change — see docs/M3C-B-HANDOFF.md.)

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
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capability-package', 'minimal');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function serveFile(res, abs) {
  try {
    const data = fsSync.readFileSync(abs);
    res.setHeader('content-type', MIME[path.extname(abs)] || 'application/octet-stream');
    res.end(data);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found');
  }
}

function safeJoin(base, rel) {
  const abs = path.join(base, rel);
  if (!abs.startsWith(base)) return null;
  return abs;
}

// The fixture tree the page builds the capability project from (embedded as
// base64 — every file is tiny; the wheel is ~1.3 KB). Embedding raw source
// bytes is part of this gate's SOURCE-ESM nature; the packaged gate gets
// the same files through Vite's asset pipeline instead.
function fixtureTree() {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of fsSync.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? rel + '/' + name : name;
      if (fsSync.statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else out[childRel] = fsSync.readFileSync(childAbs).toString('base64');
    }
  };
  walk(FIXTURE_DIR, '');
  return out;
}

function buildPage(fixtureB64) {
  const importMap = {
    imports: {
      'locus-runtime': '/vendor/locus-runtime/src/index.js',
      'locus-runtime/workspace': '/vendor/locus-runtime/src/workspace-api.js',
      'locus-runtime/worker-assets': '/vendor/locus-runtime/src/worker-assets.js',
      'locus-harness': '/vendor/locus-harness/src/index.js',
    },
  };
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>M3c-B storage adapters</title>'
    + '<script type="importmap">' + JSON.stringify(importMap) + '<\/script>'
    + '</head><body>'
    + '<script type="module">'
    + `const FIXTURE_B64 = ${JSON.stringify(fixtureB64)};\n`
    + `
import { installM3cStoragePage } from '/tests/helpers/m3c-storage-shared.js';
import * as harnessApi from '/src/product/harness-api.js';
import * as runtimeApi from '/src/product/runtime-api.js';
import { ConversationHistoryWorkspace } from '/src/conversation-history-workspace.js';
import * as persistenceMod from '/src/persistence.js';
import * as attachmentsMod from '/src/attachments.js';
import * as extensionsMod from '/src/extensions.js';
import * as cpMod from '/src/capability-package.js';

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const files = {};
for (const [rel, b64] of Object.entries(FIXTURE_B64)) files[rel] = b64ToBytes(b64);

installM3cStoragePage(
  { harnessApi, runtimeApi, ConversationHistoryWorkspace, persistenceMod, attachmentsMod, extensionsMod, cpMod },
  files,
);
<\/script></body></html>`;
}

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 30000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function main() {
  let server;
  let chrome = null;
  let profileDir = null;
  let passed = 0, failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
  };

  const port = await allocateFreePort();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/' || p === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(buildPage(fixtureTree()));
      return;
    }
    if (p.startsWith('/src/')) {
      const abs = safeJoin(path.join(ROOT, 'src'), p.slice('/src/'.length));
      return serveFile(res, abs);
    }
    if (p.startsWith('/vendor/locus-runtime/')) {
      const abs = safeJoin(path.join(ROOT, 'node_modules', 'locus-runtime'), p.slice('/vendor/locus-runtime/'.length));
      return serveFile(res, abs);
    }
    if (p.startsWith('/vendor/locus-harness/')) {
      const abs = safeJoin(path.join(ROOT, 'node_modules', 'locus-harness'), p.slice('/vendor/locus-harness/'.length));
      return serveFile(res, abs);
    }
    // The shared scenario engine is source-served raw — this gate's whole
    // nature (the packaged gate bundles it instead).
    if (p.startsWith('/tests/helpers/')) {
      const abs = safeJoin(path.join(ROOT, 'tests', 'helpers'), p.slice('/tests/helpers/'.length));
      return serveFile(res, abs);
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const pageUrl = 'http://127.0.0.1:' + port + '/';
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3cb-profile-'));
    chrome = await launchChrome(pageUrl, {
      chromePath: process.env.CHROME,
      label: 'M3c-B storage adapters Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
    const cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__m3c && window.__m3c.ready)',
      { process: chrome, phase: 'm3cb-boot', timeoutMs: 15000 });
    const bootData = await evaluate(cdp, 'window.__m3c.bootData');
    if (!bootData) throw new Error('boot failed: ' + JSON.stringify(await evaluate(cdp, 'window.__m3c.error')));

    let r = null;
    try { r = await evaluate(cdp, 'window.__m3c.runAll()', 60000); } catch (e) { r = null; }
    // The 23 shared checks (B0–S4) — identical table to the packaged gate.
    runStorageChecks(check, bootData, r);
    check('E0 zero page errors / unhandled rejections (source-ESM page)',
      (await evaluate(cdp, 'window.__m3c.errors.length')) === 0,
      JSON.stringify(await evaluate(cdp, 'window.__m3c.errors')));
  } finally {
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
  }
  console.log('---');
  if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
  console.log('all ' + passed + ' checks passed');
}

main().catch((e) => { console.error('SUITE ERROR: ' + (e && e.message || e)); process.exit(1); });
