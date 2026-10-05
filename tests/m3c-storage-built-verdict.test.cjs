// F2 unit gate (m3c review round 2): the negative self-proof judge.
// The judge in tests/helpers/m3c-storage-built-verdict.cjs is THE one
// implementation shared with the real browser driver — these tests feed
// it the review's injected failures and the real observation shapes, so
// an infrastructure failure can never be re-classified as the expected
// broken-artifact rejection without this suite going red.
// Run: node tests/m3c-storage-built-verdict.test.cjs (registered in
// tests/run-unit.cjs — no browser needed; the driver-side judgment is
// exercised end-to-end by the packaged storage gate's own two cases).
'use strict';

const fs = require('fs');
const path = require('path');
const { classifySelfProof } = require('./helpers/m3c-storage-built-verdict.cjs');

let failed = 0;
let checks = 0;

function check(name, cond, detail) {
  checks++;
  if (cond) return;
  failed++;
  console.error('  CHECK FAIL: ' + name + (detail ? ' — ' + detail : ''));
}

const HOST = 'http://127.0.0.1:4599/tests/m3c-storage-host.html';
const CHUNK = 'http://127.0.0.1:4599/assets/storageHost-V6KPtMcm.js';
const CASE_A = 'host-html-missing';
const CASE_B = 'entry-chunk-missing';
const EXPECTED = { hostUrl: HOST, entryChunkUrl: CHUNK };

function obs(over) {
  return Object.assign({ requests: [], pageBooted: false, fallbackLoads: [], serverLog: [] }, over);
}

// --- injections: infrastructure can NEVER be the expected rejection ---

{
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'infrastructure', phase: 'cdp',
    error: new Error('CDP browser endpoint unavailable: readiness timeout (phase=cdp)'),
    observations: obs(),
  });
  check('injected CDP readiness failure is NOT a pass', r.pass === false, JSON.stringify(r));
  check('the failure names the infrastructure phase', /infrastructure.*cdp/.test(r.reason), r.reason);
}
{
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'infrastructure', phase: 'browser-launch',
    error: new Error('Chrome executable not found: C:/nonexistent/chrome.exe'),
    observations: obs(),
  });
  check('injected browser-launch failure is NOT a pass', r.pass === false, JSON.stringify(r));
}
{
  const r = classifySelfProof(CASE_B, EXPECTED, {
    kind: 'infrastructure', phase: 'navigation', error: new Error('Page.navigate: ERR_CONNECTION_REFUSED'),
    observations: obs(),
  });
  check('injected navigation failure is NOT a pass', r.pass === false, JSON.stringify(r));
}
{
  // An unrelated ready timeout with NO missing-resource evidence: every
  // request answered 200 — the old "booted=false ⇒ PASS" would accept it.
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'no-boot',
    error: new Error('runtime condition unavailable: timeout'),
    observations: obs({ requests: [{ url: HOST, status: 200, failed: false }] }),
  });
  check('unrelated ready timeout with all-200 requests is NOT a pass', r.pass === false, JSON.stringify(r));
}
{
  // Case B flavour: HTML fine, chunk fine, page just never signalled ready.
  const r = classifySelfProof(CASE_B, EXPECTED, {
    kind: 'no-boot',
    error: new Error('runtime condition unavailable: timeout'),
    observations: obs({ requests: [{ url: HOST, status: 200, failed: false }, { url: CHUNK, status: 200, failed: false }] }),
  });
  check('unrelated ready timeout with a fully-served dist is NOT a pass (B)', r.pass === false, JSON.stringify(r));
}
{
  // The full artifact misfed as a broken scenario: the page booted.
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'completed',
    observations: obs({ requests: [{ url: HOST, status: 200, failed: false }, { url: CHUNK, status: 200, failed: false }], pageBooted: true }),
  });
  check('a booting dist misfed as case A FAILS the self-proof', r.pass === false, /BOOTED/.test(r.reason), r.reason);
}
{
  // A fallback page took over (index.html answered 200).
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'no-boot', error: new Error('timeout'),
    observations: obs({
      requests: [{ url: HOST, status: 404, failed: false }, { url: 'http://127.0.0.1:4599/index.html', status: 200, failed: false }],
      fallbackLoads: ['http://127.0.0.1:4599/index.html'],
    }),
  });
  check('a fallback page load FAILS the self-proof', r.pass === false, JSON.stringify(r));
}

// --- the real observation shapes MUST pass ---

{
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'no-boot', error: new Error('runtime condition timeout'),
    observations: obs({
      requests: [{ url: HOST, status: 404, failed: false }],
      serverLog: [{ path: '/tests/m3c-storage-host.html', status: 404 }],
    }),
  });
  check('case A real shape (exact host URL requested, explicit 404, no boot) passes', r.pass === true, JSON.stringify(r));
  check('case A evidence carries the host request', r.evidence && r.evidence.hostRequest && r.evidence.hostRequest.status === 404, JSON.stringify(r.evidence));
}
{
  const r = classifySelfProof(CASE_B, EXPECTED, {
    kind: 'no-boot', error: new Error('runtime condition timeout'),
    observations: obs({
      requests: [{ url: HOST, status: 200, failed: false }, { url: CHUNK, status: 404, failed: false }],
      serverLog: [{ path: '/tests/m3c-storage-host.html', status: 200 }, { path: '/assets/storageHost-V6KPtMcm.js', status: 404 }],
    }),
  });
  check('case B real shape (HTML 200, exact chunk 404, no boot) passes', r.pass === true, JSON.stringify(r));
}

// --- near-miss evidence must NOT pass ---

{
  const r = classifySelfProof(CASE_B, EXPECTED, {
    kind: 'no-boot', error: new Error('timeout'),
    observations: obs({
      requests: [{ url: HOST, status: 200, failed: false }, { url: CHUNK, status: 200, failed: false }],
      serverLog: [{ path: '/tests/m3c-storage-host.html', status: 200 }, { path: '/assets/storageHost-V6KPtMcm.js', status: 200 }],
    }),
  });
  check('case B with the chunk actually served (200) FAILS', r.pass === false, JSON.stringify(r));
}
{
  const r = classifySelfProof(CASE_B, EXPECTED, {
    kind: 'no-boot', error: new Error('timeout'),
    observations: obs({ requests: [{ url: HOST, status: 200, failed: false }], serverLog: [{ path: '/tests/m3c-storage-host.html', status: 200 }] }),
  });
  check('case B with the entry chunk never requested FAILS', r.pass === false, JSON.stringify(r));
}
{
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'no-boot', error: new Error('timeout'),
    observations: obs({ requests: [], serverLog: [{ path: '/tests/m3c-storage-host.html', status: 404 }] }),
  });
  check('case A with the host URL never requested by the browser FAILS (server log alone is not enough)', r.pass === false, JSON.stringify(r));
}
{
  // Browser and server observations disagree — no pass.
  const r = classifySelfProof(CASE_A, EXPECTED, {
    kind: 'no-boot', error: new Error('timeout'),
    observations: obs({ requests: [{ url: HOST, status: 404, failed: false }], serverLog: [] }),
  });
  check('case A with no corroborating server log FAILS', r.pass === false, JSON.stringify(r));
}
{
  const r = classifySelfProof('bogus-case', EXPECTED, {
    kind: 'no-boot', error: new Error('timeout'),
    observations: obs({ requests: [{ url: HOST, status: 404, failed: false }], serverLog: [{ path: '/tests/m3c-storage-host.html', status: 404 }] }),
  });
  check('an unknown case kind FAILS', r.pass === false, JSON.stringify(r));
}
{
  const r = classifySelfProof(CASE_A, EXPECTED, null);
  check('a null driver result FAILS', r.pass === false, JSON.stringify(r));
}

// --- the driver must USE this judge (no second implementation) ---

{
  const src = fs.readFileSync(path.join(__dirname, 'e2e-m3c-storage-built.cjs'), 'utf8');
  check('the driver requires the shared judge module',
    src.includes("require('./helpers/m3c-storage-built-verdict.cjs')"));
  check('the driver calls classifySelfProof', src.includes('classifySelfProof('));
  check('a failed verdict increments selfProofFailures (nothing else may)',
    /if \(!verdict\.pass\) selfProofFailures\+\+;/.test(src));
  check('the old exception-string gate is gone (no !booted ⇒ pass path)',
    !/const gateFailed = !booted/.test(src));
}

console.log('---');
console.log(failed ? failed + ' check(s) FAILED (' + checks + ' total)' : 'all ' + checks + ' judge checks passed');
process.exitCode = failed ? 1 : 0;
