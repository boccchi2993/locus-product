// M3c review B helper: the local controllable servers + the in-page
// interception patch used by tests/e2e-m3c-python-integration.cjs.
//
// Everything here is TEST-SIDE infrastructure — no production file is
// touched. The gate runs the CURRENT vite build of the product page; this
// module only:
//   1. serves the pinned Pyodide asset set locally with switchable fault
//      modes ('good' | 'down' | 'corrupt:<name>'), so bootstrap-integrity
//      negatives are deterministic and never depend on CDN timing — the
//      same technique as the runtime package's F04c gate, applied at the
//      browser test layer (the product page's own asset fetches are
//      redirected by an addScriptToEvaluateOnNewDocument fetch patch; the
//      product's requested URLs are RECORDED before the redirect, which is
//      the URL-pinning oracle);
//   2. runs the probe/target "internet" stand-in whose REQUEST COUNTERS are
//      the sole oracle for every zero-dispatch claim (error text alone is
//      never accepted as proof that no request happened);
//   3. loads the pinned assets once (disk cache, then the real CDN — the
//      real download is recorded distinctly and a hard failure to obtain
//      the set BLOCKS the gate instead of silently faking it).
const fs = require('fs').promises;
const http = require('http');
const path = require('path');
const { allocateFreePort } = require('./chrome.cjs');

// Disk caches, most-specific first (same pattern as e2e-skill-instances):
// this repo's scratch dir, then the source-snapshot repo's warm cache.
function assetCacheDirs(root) {
  return [
    path.join(root, 'tmp-f04b-probe', 'pyodide'),
    path.join(root, '..', 'Locus-browser-agent-runtime', 'tmp-f04b-probe', 'pyodide'),
  ];
}

// Load every manifest asset into memory: disk caches first, then ONE real
// CDN download pass (recorded). Returns { bytes: Map, realCdnDownloads,
// cacheHits, cdnReachable } — cdnReachable=false with a cache miss means
// the caller must report the gate BLOCKED.
async function loadPinnedAssets(root, pyBase, manifest) {
  const dirs = assetCacheDirs(root);
  const bytes = new Map();
  let realCdnDownloads = 0;
  let cacheHits = 0;
  let cdnReachable = true;
  for (const entry of manifest) {
    let loaded = false;
    for (const dir of dirs) {
      try {
        bytes.set(entry.name, await fs.readFile(path.join(dir, entry.name)));
        cacheHits++;
        loaded = true;
        break;
      } catch (e) { /* next cache / CDN */ }
    }
    if (loaded) continue;
    const res = await fetch(pyBase + entry.name).catch(() => null);
    if (!res || !res.ok) { cdnReachable = false; continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    bytes.set(entry.name, buf);
    realCdnDownloads++;
    try {
      await fs.mkdir(dirs[0], { recursive: true });
      await fs.writeFile(path.join(dirs[0], entry.name), buf);
    } catch (e) { /* cache is best-effort */ }
  }
  return { bytes, realCdnDownloads, cacheHits, cdnReachable };
}

// The pinned-asset server. mode is switchable at any time through the
// returned controller: 'good' | 'down' | 'corrupt:<name>'. Every asset
// request is counted (name + timestamp); 'cache-control: no-store' keeps
// the counters able to observe every fetch. Corruption flips ONE byte
// mid-file and keeps the exact content-length — the wire delivers
// well-formed, wrong bytes (exactly the integrity-negative shape).
async function startM3cPythonAssetServer(manifest) {
  let mode = 'good';
  const hits = [];
  const bytes = new Map(); // name -> Buffer (populated by the caller)
  const port = await allocateFreePort();
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/assets\//, ''));
    hits.push({ name, t: Date.now() });
    const buf = bytes.get(name);
    if (!buf) { res.statusCode = 404; res.end('unknown asset'); return; }
    const entry = manifest.find((a) => a.name === name);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('cache-control', 'no-store');
    if (mode === 'down') { res.statusCode = 503; res.end('asset server down'); return; }
    if (mode === 'corrupt:' + name) {
      const bad = Buffer.from(buf);
      bad[Math.floor(bad.length / 2)] ^= 0xff;
      res.setHeader('content-type', entry ? entry.mime : 'application/octet-stream');
      res.setHeader('content-length', String(bad.length));
      res.end(bad);
      return;
    }
    res.setHeader('content-type', entry ? entry.mime : 'application/octet-stream');
    res.setHeader('content-length', String(buf.length));
    res.end(buf);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    origin: 'http://127.0.0.1:' + port + '/assets/',
    hits,
    hitCount: () => hits.length,
    hitsTo: (name, since) => hits.filter((h) => h.name === name && h.t >= since).length,
    names: (since) => hits.filter((h) => h.t >= since).map((h) => h.name),
    setMode: (m) => { mode = m; },
    get mode() { return mode; },
    bytes,
    close: () => new Promise((r) => server.close(r)),
  };
}

// The probe/target stand-in for "the internet". CORS-open (the direct
// browser leg must be able to read responses); the hit counters are the
// zero-dispatch oracle. Endpoints:
//   /probe-hit              plain text (python escape probes)
//   /probe-script.js        JS module payload (importScripts probes)
//   /probe_wheel_fake-1.0-py3-none-any.whl   fake wheel (micropip probe)
//   /target/cors-ok         JSON, CORS-enabled (curl direct positive control)
//   /target/echo            POST/PUT echo (write-path probes)
//   /target/counts          { hits: {path: n}, total } — in-page delta reads
async function startM3cPythonProbeServer() {
  const hits = [];
  const port = await allocateFreePort();
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    };
    if (p === '/target/counts') {
      const byPath = {};
      for (const h of hits) byPath[h.path] = (byPath[h.path] || 0) + 1;
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors));
      res.end(JSON.stringify({ hits: byPath, total: hits.length }));
      return;
    }
    hits.push({ path: p, method: req.method, t: Date.now() });
    if (p === '/probe_wheel_fake-1.0-py3-none-any.whl') {
      res.writeHead(200, Object.assign({ 'content-type': 'application/zip' }, cors));
      res.end('not-a-real-wheel');
      return;
    }
    if (p === '/probe-script.js') {
      res.writeHead(200, Object.assign({ 'content-type': 'application/javascript' }, cors));
      res.end('self.__probeScriptLoaded = true;');
      return;
    }
    if (p === '/target/cors-ok') {
      res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors));
      res.end(JSON.stringify({ cors: 'ok', echoPath: p }));
      return;
    }
    if (p === '/target/echo' && (req.method === 'POST' || req.method === 'PUT')) {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors));
        res.end(JSON.stringify({ method: req.method, echoed: Buffer.concat(chunks).length }));
      });
      return;
    }
    res.writeHead(200, Object.assign({ 'content-type': 'text/plain' }, cors));
    res.end('probe-hit');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    port,
    origin: 'http://127.0.0.1:' + port,
    hits,
    hitCount: () => hits.length,
    hitsTo: (p, since) => hits.filter((h) => h.path === p && h.t >= since).length,
    close: () => new Promise((r) => server.close(r)),
  };
}

// The in-page interception patch, installed at document start (BEFORE the
// app bundle runs): every fetch of a pinned-CDN URL is RECORDED (the
// product's actual requested URL — the pinning oracle) and answered from
// the local asset server. Deterministic, offline; the real CDN download
// happens once in the NODE process (loadPinnedAssets) and is recorded
// separately. This is the e2e-skill-instances technique, plus recording.
function buildM3cAssetInterceptionScript(pyBase, localOrigin) {
  return '(function () {'
    + ' var native = window.fetch.bind(window);'
    + ' var prefix = ' + JSON.stringify(pyBase) + ';'
    + ' var local = ' + JSON.stringify(localOrigin) + ';'
    + ' window.__pyAssetFetches = [];'
    + ' window.fetch = function (input, init) {'
    + '   var url = typeof input === "string" ? input : (input && input.url) || String(input);'
    + '   if (url.indexOf(prefix) === 0) {'
    + '     window.__pyAssetFetches.push(url);'
    + '     url = local + url.slice(prefix.length);'
    + '   }'
    + '   return native(url, init); };})();';
}

module.exports = {
  loadPinnedAssets,
  startM3cPythonAssetServer,
  startM3cPythonProbeServer,
  buildM3cAssetInterceptionScript,
};
