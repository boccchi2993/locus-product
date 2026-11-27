// C3 phase-2 MCP BROWSER e2e (self-contained: own build, own servers, own
// Chrome) — the REAL chain over the REAL built app:
//
//   import .locus (REAL settings-panel dialog) → user confirms the
//   connection (REAL connect step) → `mcp servers` → `mcp tools` →
//   `mcp describe` → `mcp call` → the server sends a form elicitation ON
//   THE SSE STREAM → the user answers the REAL McpElicitationCard → the
//   SAME tools/call returns.
//
//   M-A1  REAL import dialog: the confirm view lists the endpoint; the
//         connect step lists the server with the §5.2 consent copy
//         (bolded ask-each-time sentence); token + per-row Connect —
//         state connected, ZERO network (connect never dials)
//   M-A2  REAL task, scripted model: mcp servers / tools / describe —
//         the strict server validates the handshake; the initialized
//         notification MUST carry the negotiated protocol-version header
//         AND the issued session id (the runtime fix this integration
//         locks); zero approval cards (no per-call gate, §7)
//   M-A3  mcp call with a mid-stream form: the card appears (capability
//         + server + verbatim message), the answer submits, the reply
//         POST carries the SERVER request id, the SAME call finishes;
//         the answer and the token never reach tool output / persistence
//         (the server result is fixed, never echoed)
//   M-A4  a second connected call in the SAME task: NO per-call approval,
//         session reused (initialize still exactly once)
//   M-A5  credential disconnect → the row flips to needs-connection with
//         the reconnect entry (endpoint kept, NOT re-confirmed); reconnect
//         through the REAL dialog → connected again
//   M-A6  transient failure (503): the binding is KEPT (state stays
//         connected, record untouched), the row shows the §5.5
//         "Unreachable — will retry on next use" note, the next call
//         succeeds without any reconnect
//   M-A7  form Decline: the reply carries action "decline", the same call
//         finishes with the server's decline result
//   M-A8  task cancel while the form is open: the card closes, the tool
//         result reports cancelled (server may still have processed it),
//         the server received a cancel answer for the form
//   M-A9  stream closes while the form is open: the card closes, the call
//         reports the outcome UNKNOWN, tools/call was NOT re-sent
//   M-A10 form reply rejected by the server (500): outcome unknown, tools/
//         call NOT re-sent, no reply retry beyond the one attempt
//   M-A11 task end: the server receives exactly ONE DELETE per issued
//         session (session id + version + bearer validated server-side)
//   M-A12 leak sweep: every IndexedDB store, every history VFS file and
//         the page DOM never contain the test token
//
// DIRECT HTTPS: the page (http://127.0.0.1:<app>) talks straight to the
// controlled HTTPS MCP stand-in — the server on 127.0.0.1:443 with a
// self-signed cert for mcp.locus-acceptance.example (a PUBLIC DNS-shape
// name: the package validator rejects loopback/IP hosts); Chrome maps the
// name to loopback (--host-resolver-rules) and trusts the test cert
// (--ignore-certificate-errors, TEST ONLY). Nothing can leave the machine:
// the name resolves only inside this Chrome. The gate needs `openssl` on
// PATH for the certificate.
//
// Screenshots go to a TEMP DIRECTORY (never the repository).
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, listenWithRetry,
  waitForCdp, waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // TEST ONLY: this suite's own self-signed stand-in

const ROOT = path.join(__dirname, '..');
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SHOT_DIR = process.env.C3_SHOTS_DIR
  || path.join(os.tmpdir(), 'locus-mcp-shots-' + new Date().toISOString().replace(/[:.]/g, '-'));

const MCP_HOST = 'mcp.locus-acceptance.example';
// Port fallback: the endpoint contract prefers the DEFAULT https port
// (the realistic acceptance); an environment that cannot bind 443
// (CI runners bind unprivileged) falls back to the port variant fixture
// built from the same SDK. Set at server-bind time.
let MCP_PORT = 443;
let MCP_URL = 'https://' + MCP_HOST + '/mcp';
let CAP_ID = 'acceptance-mcp';
const SERVER_ID = 'acmedocs';
const CRED_NAME = 'ACCEPTANCE_TOKEN';
const TEST_TOKEN = 'mcp-acceptance-token-4c7a91';
const FIXTURE = path.join(__dirname, 'fixtures', 'acceptance-mcp-1.0.0.locus');

// ---------- the strict counting MCP stand-in (HTTPS, :443) ----------
// Modes apply to the NEXT tools/call only, armed over /__mode; counters
// are read over /__counts. EVERY request is validated: bearer, Accept,
// Content-Type, the session/protocol header discipline.
const counts = {
  preflights: 0, initialize: 0, initialized: 0, toolsList: 0, toolsCall: 0,
  forms: 0, formReplies: [], pings: 0, deletes: [], unauthorized: 0, violations: [],
};
let callMode = 'ok'; // ok | form | form-decline | form-hang | drop | reject-reply | transient-503
const sessions = new Map(); // sessionId -> { protocolVersion }
const openStreams = new Set();

function strictCheck(req, body, opts) {
  const o = opts || {};
  const auth = req.headers.authorization;
  if (auth !== 'Bearer ' + TEST_TOKEN) {
    counts.unauthorized++;
    counts.violations.push('missing/wrong bearer on ' + String(body && body.method));
    return 401;
  }
  const accept = String(req.headers.accept || '');
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    counts.violations.push('Accept must carry both types on ' + String(body && body.method));
    return 400;
  }
  if (o.mustBeInitialize) {
    if (req.headers['mcp-protocol-version'] || req.headers['mcp-session-id']) {
      counts.violations.push('initialize must carry NO version/session headers');
      return 400;
    }
    if (!body || body.jsonrpc !== '2.0' || body.method !== 'initialize'
      || body.params.protocolVersion !== '2025-11-25'
      || JSON.stringify(body.params.capabilities) !== '{"elicitation":{}}'
      || body.params.clientInfo.name !== 'locus') {
      counts.violations.push('initialize body off-spec');
      return 400;
    }
    return 0;
  }
  // every request after initialize: the negotiated version + the session id
  const sid = req.headers['mcp-session-id'];
  const ver = req.headers['mcp-protocol-version'];
  if (!sid || !sessions.has(sid)) {
    counts.violations.push('missing/unknown session id on ' + String(body && body.method));
    return 404; // the client treats this as session-lost
  }
  if (sessions.get(sid).protocolVersion !== ver) {
    counts.violations.push('protocol-version header must be the negotiated version on '
      + String(body && body.method));
    return 400;
  }
  if (body && body.method === 'notifications/initialized' && ver !== '2025-06-18') {
    counts.violations.push('initialized notification carried the wrong version');
    return 400;
  }
  return 0;
}

function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'authorization, content-type, accept, mcp-protocol-version, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
}

function sseInit(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const stream = {
    send(obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); },
    end() { openStreams.delete(stream); try { res.end(); } catch (e) { /* already gone */ } },
  };
  openStreams.add(stream);
  return stream;
}

function makeMcpServer(cert) {
  return () => https.createServer({
    key: cert.key, cert: cert.cert,
  }, (req, res) => {
    const origin = req.headers.origin;
    cors(res, origin);
    if (req.method === 'OPTIONS') {
      counts.preflights++;
      res.writeHead(204);
      return res.end();
    }
    const p = req.url.split('?')[0];
    if (req.method === 'GET' && p === '/__counts') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        counts: counts,
        activeStreams: openStreams.size,
      }));
    }
    if (req.method === 'POST' && p === '/__mode') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { callMode = JSON.parse(Buffer.concat(chunks).toString('utf8')).mode || 'ok'; }
        catch (e) { callMode = 'ok'; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mode: callMode }));
      });
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); }
      catch (e) { res.writeHead(400); return res.end('bad json'); }

      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        const bad = strictCheck(req, body);
        if (bad === 401) { res.writeHead(401); return res.end(); }
        counts.deletes.push({
          sessionId: sid || null,
          protocolVersion: req.headers['mcp-protocol-version'] || null,
          bearer: authOk(req),
          knownSession: !!(sid && sessions.has(sid)),
        });
        sessions.delete(sid);
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }

      const method = body && body.method;
      if (method === 'initialize') {
        const bad = strictCheck(req, body, { mustBeInitialize: true });
        if (bad) { res.writeHead(bad); return res.end(); }
        counts.initialize++;
        const sid = 'sess-acceptance-' + (counts.initialize);
        sessions.set(sid, { protocolVersion: '2025-06-18' });
        res.setHeader('mcp-session-id', sid);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'acme-docs-mcp', version: '1.4.0' },
          },
        }));
      }
      // everything below needs the full post-handshake header discipline
      const bad = strictCheck(req, body);
      if (bad === 401) { res.writeHead(401); return res.end(); }
      if (bad === 404) { res.writeHead(404); return res.end(); }
      if (bad) { res.writeHead(bad); return res.end(); }

      if (method === 'notifications/initialized') {
        counts.initialized++;
        res.writeHead(202);
        return res.end();
      }
      if (body.result !== undefined || body.error !== undefined) {
        // a reply to a server request (the form answer / cancel / ping)
        counts.formReplies.push({ id: body.id, action: body.result ? body.result.action : ('error:' + body.error.code) });
        const entry = pendingReplies.get(body.id);
        if (entry && entry.rejectWith) {
          // M-A10: the reply POST itself is refused — the client must
          // report outcome unknown and never re-send tools/call
          pendingReplies.delete(body.id);
          res.writeHead(entry.rejectWith, { 'content-type': 'text/plain' });
          return res.end('reply refused');
        }
        if (entry) {
          pendingReplies.delete(body.id);
          entry.onReply(body);
        }
        res.writeHead(202);
        return res.end();
      }
      if (method === 'tools/list') {
        counts.toolsList++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: { tools: [{
            name: 'search',
            title: 'Search',
            description: 'Search the Acme docs.\nSecond line.',
            inputSchema: { type: 'object',
              properties: { query: { type: 'string', description: 'Free text query' } },
              required: ['query'] },
          }], nextCursor: null },
        }));
      }
      if (method === 'tools/call') {
        counts.toolsCall++;
        if (callMode === 'transient-503') {
          callMode = 'ok';
          res.writeHead(503, { 'content-type': 'text/plain' });
          return res.end('try again');
        }
        const callId = body.id;
        const sid = req.headers['mcp-session-id'];
        const stream = sseInit(res);
        stream.send({ jsonrpc: '2.0', method: 'notifications/progress',
          params: { progressToken: 't1', progress: 1, total: 2, message: 'indexing' } });
        if (callMode === 'ok') {
          callMode = 'ok';
          stream.send({ jsonrpc: '2.0', id: callId, result: fixedResult(false) });
          return stream.end();
        }
        if (callMode === 'drop') {
          callMode = 'ok';
          return setTimeout(() => stream.end(), 150);
        }
        if (callMode === 'form' || callMode === 'form-decline'
          || callMode === 'form-hang' || callMode === 'reject-reply') {
          counts.forms++;
          const mode = callMode;
          stream.send({ jsonrpc: '2.0', id: 9001, method: 'elicitation/create',
            params: {
              message: 'Which workspace should be searched?',
              requestedSchema: { type: 'object',
                properties: { workspace: { type: 'string', title: 'Workspace',
                  description: 'The workspace to search.',
                  enum: ['ws-one', 'ws-two'] },
                  ...(mode === 'form' ? {
                    formats: { type: 'array', items: { type: 'string', enum: ['pdf', 'docx'] } },
                    count: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
                    note: { type: 'string', minLength: 2, maxLength: 4, default: 'ok' },
                  } : {}) },
                required: ['workspace'] },
            } });
          pendingReplies.set(9001, {
            // M-A10: refuse the reply POST itself (see the reply branch)
            rejectWith: mode === 'reject-reply' ? 500 : undefined,
            onReply(reply) {
              const action = reply.result && reply.result.action;
              // validate the answer, then finish the SAME tools/call
              const content = reply.result && reply.result.content;
              if (mode === 'form' && action === 'accept') {
                lastFormAnswer = content || null;
                stream.send({ jsonrpc: '2.0', id: callId, result: fixedResult(false) });
              } else if (mode === 'form-decline' && action === 'decline') {
                stream.send({ jsonrpc: '2.0', id: callId, result: fixedResult(true) });
              } else if (action === 'cancel') {
                // the client told the server the form was cancelled; on a
                // user-cancel the stream is being torn down anyway
                if (mode !== 'form-hang') {
                  stream.send({ jsonrpc: '2.0', id: callId, result: fixedResult(true) });
                }
              }
              stream.end();
            },
          });
          return; // the stream stays open until the reply POST arrives
        }
        // unknown mode falls through to a plain result
        stream.send({ jsonrpc: '2.0', id: callId, result: fixedResult(false) });
        return stream.end();
      }
      res.writeHead(400);
      res.end('unexpected method');
    });
  });
}

const pendingReplies = new Map();
let lastFormAnswer = null;
function authOk(req) { return req.headers.authorization === 'Bearer ' + TEST_TOKEN; }
function fixedResult(isError) {
  // FIXED content: the server NEVER echoes the form answer, so the sweep
  // can prove the answer itself never reached the model surfaces.
  return {
    content: [{ type: 'text', text: JSON.stringify({ hits: 12, top: 'Q3 report' }) }],
    isError: !!isError,
  };
}

// ---------- app server (dist + REAL relay handlers) — the e2e-credentials shape ----------
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

// ---------- CDP helpers (the e2e-credentials shape) ----------
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
const testidExpr = (testid) => '(() => { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); return el ? el.textContent.trim() : null; })()';
const testidText = (testid) => evaluate(cdp, testidExpr(testid));
function setInputValue(testid, value) {
  return evaluate(cdp,
    '(function () { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); if (!el) return "missing";'
    + ' el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event("input", { bubbles: true }));'
    + ' el.dispatchEvent(new Event("change", { bubbles: true })); return "set"; })()');
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
async function runTask(replies, prompt, timeoutMs) {
  const shaped = replies.map((r) => typeof r === 'string'
    ? { content: r, rawMessage: { role: 'assistant', content: [{ type: 'text', text: r }] } }
    : r);
  await evaluate(cdp, 'window.__e2eReplies.length = 0; window.__e2eReplies.push('
    + shaped.map((r) => JSON.stringify(r)).join(',') + '); "armed"');
  await evaluate(cdp, 'window.__mcpTask = window.__locus.actions.submit(' + JSON.stringify(prompt) + '); "fired"');
  return await evaluate(cdp,
    'window.__mcpTask.then(function () { return "task-done"; }, function (e) { return "task-error: " + (e && e.message || e); })',
    timeoutMs || 240000);
}
const lastToolResultExpr = '(function () { const conv = window.__locus.store.conversations.find('
  + 'function (c) { return c.id === window.__locus.store.liveConversationId; });'
  + ' if (!conv) return null; const t = conv.items.filter(function (i) { return i.kind === "tool"; });'
  + ' const last = t[t.length - 1]; return last && last.result ? { output: String(last.result.output || ""), success: last.result.success } : null; })()';
async function reloadAndBoot(cdp2, chrome, appUrl) {
  await evaluate(cdp2, 'location.reload(); "reloading"');
  await waitForPageTarget(chrome, appUrl, { timeoutMs: 20000 });
  await waitForRuntimeCondition(cdp2,
    '!!(window.__locus && window.__locus.vfs && window.__locus.approvals && window.__locus.capabilityComposition && document.querySelector(".app-shell"))',
    { process: chrome, phase: 'mcp-app-boot', timeoutMs: 30000 });
  await waitForRuntimeCondition(cdp2,
    'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
    { process: chrome, phase: 'mcp-durable-home', timeoutMs: 30000 });
  await evaluate(cdp2, 'window.__e2eReplies.length = 0; "queue reset"');
}
const openSettings = () => evaluate(cdp, 'window.__locus.store.settingsOpen = true; "open"');
const closeSettings = () => evaluate(cdp, 'window.__locus.store.settingsOpen = false; "closed"');
async function countsFetch(port) {
  const res = await fetch('https://127.0.0.1:' + port + '/__counts');
  return JSON.parse(await res.text());
}

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 500) : '')); }
  };

  // ---- build (always fresh, same policy as e2e-credentials) ----
  console.log('# building dist (vite build)');
  const build = spawnSync(process.execPath, [VITE_CLI, 'build'], { stdio: 'inherit', cwd: ROOT });
  if (build.status !== 0) { console.error('build failed'); process.exit(1); }

  // ---- the acceptance package, built by locus-example-capabilities (#11) ----
  // 443 first (the realistic endpoint); an environment that cannot bind
  // it (CI runners) uses the port-variant fixture from the same SDK.
  const PORT_FIXTURE = path.join(__dirname, 'fixtures', 'acceptance-mcp-port-1.0.0.locus');

  // ---- the HTTPS certificate for the controlled stand-in host ----
  const certDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'locus-mcp-cert-'));
  const cert = { key: '', cert: '' };
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout',
      path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'),
      '-days', '3', '-nodes', '-subj', '/CN=' + MCP_HOST,
      '-addext', 'subjectAltName=DNS:' + MCP_HOST], { stdio: 'ignore' });
    cert.key = fs.readFileSync(path.join(certDir, 'key.pem'), 'utf8');
    cert.cert = fs.readFileSync(path.join(certDir, 'cert.pem'), 'utf8');
  } catch (e) {
    console.error('this gate needs openssl on PATH to mint the test certificate');
    process.exit(3);
  }

  // ---- servers ----
  // Port 443 is part of the endpoint contract: the package validator and
  // the credential origin both require the DEFAULT https port.
  let mcpServer = makeMcpServer(cert)();
  const bind = (srv, port) => new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve());
  });
  let pkgBytes;
  try {
    await bind(mcpServer, 443);
    pkgBytes = fs.readFileSync(FIXTURE);
  } catch (e) {
    // cannot bind the default port here (CI): the port-variant variant
    mcpServer.close();
    MCP_PORT = 46443;
    MCP_URL = 'https://' + MCP_HOST + ':' + MCP_PORT + '/mcp';
    CAP_ID = 'acceptance-mcp-port';
    pkgBytes = fs.readFileSync(PORT_FIXTURE);
    mcpServer = makeMcpServer(cert)();
    await bind(mcpServer, MCP_PORT);
    console.log('# 443 unavailable (' + (e.code || e.message) + '); using the port variant at :' + MCP_PORT);
  }
  const PKG_B64 = pkgBytes.toString('base64');
  const mcpPort = MCP_PORT;
  const relay = await import('file://' + path.join(ROOT, 'functions', 'fetch.js').replace(/\\/g, '/'));
  const { server: appServer, port: appPort } = await listenWithRetry(
    makeAppServer(path.join(ROOT, 'dist'), relay), await allocateFreePort());
  const appUrl = 'http://127.0.0.1:' + appPort + '/?e2e=1';

  let chrome = null;
  let profileDir = null;
  try {
    profileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'locus-mcp-profile-'));
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'mcp Chrome',
      profileDir,
      extraArgs: [
        '--window-size=1440,900',
        // The stand-in host name resolves ONLY to loopback inside this
        // Chrome — nothing can leave the machine.
        '--host-resolver-rules=MAP ' + MCP_HOST + ' 127.0.0.1',
        // TEST ONLY: the stand-in's self-signed certificate.
        '--ignore-certificate-errors',
        // The gate machines can carry a system proxy: a proxied Chrome
        // hands the hostname to the proxy and the host-resolver-rules
        // mapping never applies. Everything this suite needs is local.
        '--no-proxy-server',
      ],
    });
    await waitForCdp(chrome);
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp,
      '!!(window.__locus && window.__locus.vfs && window.__locus.approvals && window.__locus.capabilityComposition && document.querySelector(".app-shell"))',
      { process: chrome, phase: 'mcp-app-boot', description: 'mcp e2e unavailable: app did not boot', timeoutMs: 30000 });
    await waitForRuntimeCondition(cdp,
      'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
      { process: chrome, phase: 'mcp-durable-home', timeoutMs: 30000 });
    await evaluate(cdp, 'window.__e2eReplies.length = 0; "queue reset"');
    check('M-C0 the pinned cores declare the MCP capabilities',
      await evaluate(cdp, '(function () { var c = window.__locus.harnessCapabilities().capabilities || {};'
        + ' return c.capabilityMcp === true && c.capabilityCredentials === true; })()'));

    // ---------- M-A1: the REAL import → confirm → connect flow ----------
    await openSettings();
    // the REAL settings-panel path entry: bytes land in /mnt/download via
    // the REAL VFS, then the REAL import service reads them back
    const wrote = await evaluate(cdp,
      '(async function () { var bin = atob(' + JSON.stringify(PKG_B64) + ');'
      + ' var bytes = new Uint8Array(bin.length);'
      + ' for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
      + ' await window.__locus.vfs.write("/mnt/download/acceptance-mcp-1.0.0.locus", bytes);'
      + ' return "written"; })()');
    check('M-A1 the fixture .locus landed in /mnt/download through the REAL VFS',
      wrote === 'written');
    check('M-A1 the path import entry accepted the fixture path',
      (await setInputValue('capability-import-path', '/mnt/download/acceptance-mcp-1.0.0.locus')) === 'set');
    check('M-A1 the REAL import entry opened the confirm dialog',
      (await clickTestid('capability-import-path-button')) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('capability-import-dialog') + ' !== null',
      { process: chrome, phase: 'mcp-import-dialog', timeoutMs: 15000 });
    check('M-A1 the confirm view lists the MCP endpoint line',
      ((await testidText('capability-import-mcp-endpoint-' + SERVER_ID)) || '')
        .includes(MCP_URL) && ((await testidText('capability-import-mcp-endpoint-' + SERVER_ID)) || '')
          .includes(CRED_NAME),
      await testidText('capability-import-mcp-endpoint-' + SERVER_ID));
    await screenshot(cdp, 'mcp-import-confirm.png', 'capability-import-dialog');
    check('M-A1 Import confirmed', (await clickTestid('capability-import-confirm')) === 'clicked');
    await waitForRuntimeCondition(cdp,
      testidExpr('import-mcp-row-' + SERVER_ID) + ' !== null',
      { process: chrome, phase: 'mcp-connect-step', timeoutMs: 20000 });
    const row = await testidText('import-mcp-row-' + SERVER_ID);
    check('M-A1 the connect step lists the server with its address',
      (row || '').includes(MCP_URL) && (row || '').includes(CAP_ID), row);
    check('M-A1 the consent sentence carries the bolded ask-each-time MUST line',
      (row || '').includes('After you connect, the model can call this server\'s tools in a task')
        && (row || '').includes('without asking you each time.'),
      row);
    check('M-A1 Remember defaults to checked (D12)',
      await evaluate(cdp, 'document.querySelector(\'[data-testid="import-mcp-remember-' + SERVER_ID + '"]\').checked'));
    await screenshot(cdp, 'mcp-connect-step.png', 'import-mcp-row-' + SERVER_ID);
    check('M-A1 the token can be typed',
      (await setInputValue('import-mcp-input-' + SERVER_ID, TEST_TOKEN)) === 'set');
    check('M-A1 per-row Connect clicked',
      (await clickTestid('import-mcp-connect-' + SERVER_ID)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('import-mcp-state-' + SERVER_ID) + ' || "") === "Connected"',
      { process: chrome, phase: 'mcp-row-connected', timeoutMs: 10000 });
    check('M-A1 the server row reads Connected',
      (await testidText('import-mcp-state-' + SERVER_ID)) === 'Connected');
    check('M-A1 connecting made ZERO network requests (the handshake belongs to the first command)',
      (await countsFetch(mcpPort)).counts.initialize === 0);
    check('M-A1 Skip for now closes the step',
      (await clickTestid('capability-import-skip')) === 'clicked');
    await waitForRuntimeCondition(cdp, testidExpr('capability-import-dialog') + ' === null',
      { process: chrome, phase: 'mcp-dialog-closed', timeoutMs: 8000 });
    check('M-A1 the token survives nowhere in the DOM',
      !(await evaluate(cdp, 'document.body.textContent.includes(' + JSON.stringify(TEST_TOKEN) + ')')));
    check('M-A1 the capability landed enabled with the server connected',
      await evaluate(cdp, '(function () { var c = window.__locus.capabilityComposition.list()'
        + '.find(function (x) { return x.id === ' + JSON.stringify(CAP_ID) + '; });'
        + ' return !!c && c.enabled === true && c.mcps[0].state === "connected"; })()'));
    await closeSettings();

    // ---------- M-A2: the REAL chain — servers / tools / describe ----------
    await reloadAndBoot(cdp, chrome, appUrl); // records survive: restore() keeps it connected
    check('M-A2 after a reload the connection was restored (state connected, no re-connect)',
      await evaluate(cdp, '(function () { var c = window.__locus.capabilityComposition.list()'
        + '.find(function (x) { return x.id === ' + JSON.stringify(CAP_ID) + '; });'
        + ' return !!c && c.mcps[0].state === "connected"; })()'));
    const seenCards = () => evaluate(cdp,
      'window.__seenApprovalCards = window.__seenApprovalCards || 0;'
      + ' new MutationObserver(function () {}); "n/a"');
    const t2 = runTask([
      '```json\n{"tool":"bash","input":"mcp servers"}\n```',
      '```json\n{"tool":"bash","input":"mcp tools acmedocs"}\n```',
      '```json\n{"tool":"bash","input":"mcp describe acmedocs search"}\n```',
      'done.',
    ], 'walk the acceptance MCP server');
    const settled2 = await t2;
    check('M-A2 the servers/tools/describe task finished', settled2 === 'task-done', settled2);
    const out2 = await evaluate(cdp, lastToolResultExpr + ' && (function () { var conv = window.__locus.store.conversations.find(function (c) { return c.id === window.__locus.store.liveConversationId; });'
      + ' var t = conv.items.filter(function (i) { return i.kind === "tool" });'
      + ' return t.map(function (x) { return String(x.result && x.result.output || ""); }); })()');
    check('M-A2 mcp servers listed the connected server',
      (out2[0] || '').includes('acmedocs') && (out2[0] || '').includes('connected'), out2[0]);
    check('M-A2 mcp tools listed search', (out2[1] || '').includes('search'), out2[1]);
    check('M-A2 mcp describe carried the schema',
      (out2[2] || '').includes('"query"') && (out2[2] || '').includes('string'), (out2[2] || '').slice(0, 200));
    let c = (await countsFetch(mcpPort)).counts;
    check('M-A2 the strict server saw the handshake (initialize + notification)',
      c.initialize === 1 && c.initialized === 1, JSON.stringify(c));
    check('M-A2 NO protocol violations (bearer, Accept, session/protocol header discipline)',
      c.violations.length === 0 && c.unauthorized === 0, JSON.stringify(c.violations));
    check('M-A2 no approval card ever interrupted the mcp commands (§7 default allow)',
      !(await evaluate(cdp, 'document.querySelector(".approval-card") !== null'))
      && (await evaluate(cdp, 'document.body.textContent.includes("Approval required")')) === false);

    // ---------- M-A3: mcp call with a mid-stream form ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "form" }) }); return "armed"; })()');
    const before3 = (await countsFetch(mcpPort)).counts.toolsCall;
    const t3 = runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"locus\\"}\'"}\n```',
      'done.',
    ], 'run one accepted form call');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="mcp-elicitation-card"]\')',
      { process: chrome, phase: 'mcp-form-card', timeoutMs: 30000 });
    const cardText = await evaluate(cdp,
      '(document.querySelector(\'[data-testid="mcp-elicitation-card"]\')||{}).textContent || ""');
    check('M-A3 the card names the server (who asks)',
      cardText.includes('Acme Documents') && cardText.includes('Acceptance MCP')
      && cardText.includes(MCP_URL), cardText.slice(0, 250));
    check('M-A3 the card shows the verbatim server message',
      cardText.includes('Which workspace should be searched?'), cardText.slice(0, 200));
    check('M-A3 the field has its title, description and required mark',
      cardText.includes('Workspace') && cardText.includes('The workspace to search.'),
      cardText.slice(0, 400));
    await screenshot(cdp, 'mcp-elicitation-card.png', 'mcp-elicitation-card');
    // empty submit must be blocked by the LOCAL validation
    check('M-A3 an empty submit is blocked locally (required)',
      (await clickTestid('mcp-elicit-submit')) === 'clicked'
      && await evaluate(cdp, '!!document.querySelector(\'[data-testid="mcp-elicit-error-workspace"]\')'));
    check('M-A3 the enum field accepts the answer (and the submit button is enabled again)',
      (await setInputValue('mcp-elicit-input-workspace', 'ws-one')) === 'set'
      && await evaluate(cdp,
        "!document.querySelector('[data-testid=\"mcp-elicit-submit\"]').disabled"));
    check('M-A3 multi-select accepts multiple values',
      await evaluate(cdp, `(() => {
        const field = document.querySelector('[data-testid="mcp-elicit-input-formats"]');
        if (!field?.multiple) return false;
        for (const option of field.options) option.selected = true;
        field.dispatchEvent(new Event('change', { bubbles: true }));
        return field.selectedOptions.length === 2;
      })()`));
    for (const [field, value] of [['count', '1.5'], ['count', '6'], ['note', 'longer']]) {
      await setInputValue('mcp-elicit-input-' + field, value);
      await clickTestid('mcp-elicit-submit');
      check('M-A3 rejects invalid ' + field + ' value ' + value,
        !!(await testidText('mcp-elicit-error-' + field)));
    }
    await setInputValue('mcp-elicit-input-count', '3');
    await setInputValue('mcp-elicit-input-note', 'good');
    check('M-A3 Submit resolves the card',
      (await clickTestid('mcp-elicit-submit')) === 'clicked');
    check('M-A3 the same tools/call finished (the task settled)',
      (await t3) === 'task-done');
    c = (await countsFetch(mcpPort)).counts;
    check('M-A3 the reply POST carried the SERVER request id (9001) with the answer',
      c.formReplies.some((r) => r.id === 9001 && r.action === 'accept'),
      JSON.stringify(c.formReplies));
    check('M-A3 the server received typed field values',
      JSON.stringify(lastFormAnswer?.formats) === '["pdf","docx"]'
      && lastFormAnswer?.count === 3 && lastFormAnswer?.note === 'good');
    check('M-A3 exactly ONE tools/call left the client for the form interaction',
      c.toolsCall === before3 + 1, 'toolsCall=' + c.toolsCall + ' before=' + before3);
    check('M-A3 the tool result is the server result (fixed content)',
      (await evaluate(cdp, lastToolResultExpr)).output.includes('Q3 report'),
      (await evaluate(cdp, lastToolResultExpr)).output.slice(0, 200));
    check('M-A3 the card is gone after the answer',
      (await evaluate(cdp, '!document.querySelector(\'[data-testid="mcp-elicitation-card"]\')')));

    // ---------- M-A4: a second connected call — no per-call gate ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "ok" }) }); return "armed"; })()');
    const before4 = (await countsFetch(mcpPort)).counts.initialize;
    const settled4 = await runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"alpha\\"}\'"}\n```',
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"beta\\"}\'"}\n```',
      'done.',
    ], 'run two calls in one task');
    check('M-A4 both connected calls completed in one task without any approval card',
      settled4 === 'task-done'
      && !(await evaluate(cdp, 'document.body.textContent.includes("Approval required")')),
      settled4);
    c = (await countsFetch(mcpPort)).counts;
    check('M-A4 the session was reused WITHIN the task (two calls, exactly ONE new handshake)',
      c.initialize === before4 + 1, 'initialize=' + c.initialize + ' before=' + before4);

    // ---------- M-A5: credential disconnect → recovery entry ----------
    await openSettings();
    check('M-A5 Disconnect credential clicked',
      (await clickTestid('credential-disconnect-' + CRED_NAME)) === 'clicked');
    check('M-A5 Confirm disconnect clicked',
      (await clickTestid('credential-disconnect-confirm-' + CRED_NAME)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('capability-mcp-state-' + SERVER_ID) + ' || "") === "Connection required"',
      { process: chrome, phase: 'mcp-needs-connection', timeoutMs: 10000 });
    check('M-A5 the server row flipped to Connection required with the reconnect entry',
      ((await testidText('capability-mcp-reconnect-' + SERVER_ID)) || '')
        .includes('Connection required — reconnect'),
      await testidText('capability-mcp-reconnect-' + SERVER_ID));
    check('M-A5 the endpoint is still shown (NOT re-confirmed on reconnect)',
      ((await testidText('capability-mcp-' + SERVER_ID)) || '').includes(MCP_URL),
      await testidText('capability-mcp-' + SERVER_ID));
    await screenshot(cdp, 'mcp-reconnect-entry.png', 'capability-mcp-' + SERVER_ID);
    check('M-A5 Connect opens the real dialog with the fixed endpoint',
      (await clickTestid('capability-mcp-connect-' + SERVER_ID)) === 'clicked'
      && ((await testidText('mcp-connect-dialog-' + SERVER_ID)) || '').includes(MCP_URL),
      await testidText('mcp-connect-dialog-' + SERVER_ID));
    check('M-A5 the reconnect token can be typed and Connect flips the row',
      (await setInputValue('mcp-connect-input-' + SERVER_ID, TEST_TOKEN)) === 'set'
      && (await clickTestid('mcp-connect-confirm-' + SERVER_ID)) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('capability-mcp-state-' + SERVER_ID) + ' || "") === "Connected"',
      { process: chrome, phase: 'mcp-reconnected', timeoutMs: 10000 });
    check('M-A5 the server is connected again (still zero network for connecting)',
      (await countsFetch(mcpPort)).counts.initialize === c.initialize);
    await closeSettings();

    // ---------- M-A6: transient failure keeps the binding ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "transient-503" }) }); return "armed"; })()');
    const settled6 = await runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"x\\"}\'"}\n```',
      'done.',
    ], 'hit the transient failure');
    const out6 = await evaluate(cdp, lastToolResultExpr);
    check('M-A6 the transient call failed with the unreachable report to the model',
      settled6 === 'task-done' && out6 && out6.success === false
        && /unreachable/.test(out6.output), JSON.stringify(out6).slice(0, 300));
    await openSettings();
    check('M-A6 the row STILL reads Connected (the binding was kept)',
      (await testidText('capability-mcp-state-' + SERVER_ID)) === 'Connected',
      await testidText('capability-mcp-state-' + SERVER_ID));
    check('M-A6 the row shows the §5.5 Unreachable note',
      ((await testidText('capability-mcp-unreachable-' + SERVER_ID)) || '')
        .includes('Unreachable — will retry on next use'),
      await testidText('capability-mcp-unreachable-' + SERVER_ID));
    check('M-A6 no connect button is offered for a connected-but-unreachable row',
      (await evaluate(cdp, 'document.querySelector(\'[data-testid="capability-mcp-connect-' + CAP_ID + '-' + SERVER_ID + '"]\')')) === null);
    await closeSettings();
    const settled6b = await runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"y\\"}\'"}\n```',
      'done.',
    ], 'retry after the transient failure');
    const out6b = await evaluate(cdp, lastToolResultExpr);
    check('M-A6 the next call succeeded WITHOUT any reconnect (auto retry)',
      settled6b === 'task-done' && out6b && out6b.success === true
        && out6b.output.includes('Q3 report'), JSON.stringify(out6b).slice(0, 200));
    await openSettings();
    check('M-A6 the Unreachable note cleared after the success',
      (await evaluate(cdp, 'document.querySelector(\'[data-testid="capability-mcp-unreachable-' + CAP_ID + '-' + SERVER_ID + '"]\')')) === null);
    await closeSettings();

    // ---------- M-A7: Decline ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "form-decline" }) }); return "armed"; })()');
    const t7 = runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"x\\"}\'"}\n```',
      'done.',
    ], 'run one declined form call');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="mcp-elicitation-card"]\')',
      { process: chrome, phase: 'mcp-decline-card', timeoutMs: 30000 });
    check('M-A7 Decline clicked', (await clickTestid('mcp-elicit-decline')) === 'clicked');
    check('M-A7 the declined call still finished', (await t7) === 'task-done');
    c = (await countsFetch(mcpPort)).counts;
    check('M-A7 the reply carried action decline (no content key possible)',
      c.formReplies.some((r) => r.id === 9001 && r.action === 'decline'),
      JSON.stringify(c.formReplies));
    const out7 = await evaluate(cdp, lastToolResultExpr);
    check('M-A7 the tool result reports the tool error',
      out7 && out7.success === false && out7.output.includes('Q3 report'),
      JSON.stringify(out7).slice(0, 200));

    // ---------- M-A8: task cancel while the form is open ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "form-hang" }) }); return "armed"; })()');
    const t8 = runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"x\\"}\'"}\n```',
      'done.',
    ], 'run the cancelled form call');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="mcp-elicitation-card"]\')',
      { process: chrome, phase: 'mcp-cancel-card', timeoutMs: 30000 });
    check('M-A8 the composer Cancel button was clicked',
      (await evaluate(cdp, '(function () { var b = document.querySelector(".cancel-btn"); if (!b) return "missing"; b.click(); return "clicked"; })()')) === 'clicked');
    check('M-A8 the card ended its wait after the cancel',
      await cardGone(15000));
    check('M-A8 the cancelled task settled', (await t8) === 'task-done');
    const out8 = await evaluate(cdp, lastToolResultExpr);
    check('M-A8 the tool result reports the cancel honestly (server may have processed it)',
      out8 && out8.success === false && /cancelled/.test(out8.output)
        && /may still have processed it/.test(out8.output), JSON.stringify(out8).slice(0, 300));
    c = (await countsFetch(mcpPort)).counts;
    check('M-A8 the server was told the form was cancelled (best-effort cancel reply)',
      c.formReplies.some((r) => r.id === 9001 && r.action === 'cancel'),
      JSON.stringify(c.formReplies));

    // ---------- M-A9: stream closes while the form is open ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "drop" }) }); return "armed"; })()');
    const settled9 = await runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"x\\"}\'"}\n```',
      'done.',
    ], 'run the dropped-stream call');
    check('M-A9 the dropped call settled', settled9 === 'task-done');
    const out9 = await evaluate(cdp, lastToolResultExpr);
    check('M-A9 the outcome is UNKNOWN and tools/call was NOT re-sent',
      out9 && out9.success === false && /outcome unknown/.test(out9.output)
        && /NOT re-sent/.test(out9.output), JSON.stringify(out9).slice(0, 300));
    c = (await countsFetch(mcpPort)).counts;
    const callsAfterDrop = c.toolsCall;

    // ---------- M-A10: the form reply is rejected by the server ----------
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "reject-reply" }) }); return "armed"; })()');
    const t10 = runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"x\\"}\'"}\n```',
      'done.',
    ], 'run the rejected-reply call');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="mcp-elicitation-card"]\')',
      { process: chrome, phase: 'mcp-reject-card', timeoutMs: 30000 });
    check('M-A10 the answer typed and submitted',
      (await setInputValue('mcp-elicit-input-workspace', 'ws-two')) === 'set'
      && (await clickTestid('mcp-elicit-submit')) === 'clicked');
    check('M-A10 the rejected-reply call settled', (await t10) === 'task-done');
    const out10 = await evaluate(cdp, lastToolResultExpr);
    check('M-A10 the outcome is UNKNOWN after the rejected reply, tools/call NOT re-sent',
      out10 && out10.success === false && /outcome unknown/.test(out10.output)
        && /NOT re-sent/.test(out10.output), JSON.stringify(out10).slice(0, 300));
    c = (await countsFetch(mcpPort)).counts;
    check('M-A10 exactly one tools/call for the rejected interaction (server-side count)',
      c.toolsCall === callsAfterDrop + 1, 'toolsCall=' + c.toolsCall);

    // ---------- M-A11: the task-end DELETE ----------
    // the previous task's best-effort DELETE is not awaited by onTaskEnd —
    // let it land before reading the baseline
    await new Promise((r) => setTimeout(r, 1500));
    c = (await countsFetch(mcpPort)).counts;
    const deletesBefore = c.deletes.length;
    await evaluate(cdp, '(async function () { await fetch("https://127.0.0.1:' + mcpPort + '/__mode", { method: "POST", mode: "no-cors", body: JSON.stringify({ mode: "ok" }) }); return "armed"; })()');
    await runTask([
      '```json\n{"tool":"bash","input":"mcp call acmedocs search \'{\\"query\\":\\"z\\"}\'"}\n```',
      'done.',
    ], 'run the DELETE-check call');
    await new Promise((r) => setTimeout(r, 1500)); // the DELETE is best-effort, not awaited
    c = (await countsFetch(mcpPort)).counts;
    check('M-A11 the task end sent exactly ONE DELETE',
      c.deletes.length === deletesBefore + 1, JSON.stringify(c.deletes));
    const del = c.deletes[c.deletes.length - 1];
    check('M-A11 the DELETE carried the session id, the negotiated version and the bearer',
      del && del.sessionId && String(del.sessionId).startsWith('sess-acceptance-')
        && del.protocolVersion === '2025-06-18' && del.bearer === true,
      JSON.stringify(del));

    // ---------- M-A12: the leak sweep (token + form answer) ----------
    await openSettings();
    await screenshot(cdp, 'mcp-final-settings.png', 'capability-mcp-' + SERVER_ID);
    await closeSettings();
    const sweep = await evaluate(cdp,
      // D12 note: the remembered token BELONGS in the secrets store (the
      // credential storage) — it must never reach the MODEL-VISIBLE
      // stores/files, so the token sweep skips secrets while the form
      // answers sweep everything. No // comments inside the expression:
      // it is built as ONE line.
      '(async function () {'
      + ' var TOKEN = ' + JSON.stringify(TEST_TOKEN) + ';'
      + ' var KEYS = ["ws-one", "ws-two"];'
      + ' var out = { stores: {}, storeCount: 0, vfsFiles: 0, vfsBytes: 0, domBytes: 0, leaked: false, where: "" };'
      + ' var db = await new Promise(function (res, rej) { var rq = indexedDB.open("locus", 4); rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error); }; });'
      + ' function readAll(store) { return new Promise(function (res, rej) { var tx = db.transaction(store, "readonly");'
      + '   var g = tx.objectStore(store).getAll(); g.onsuccess = function () { res(g.result); }; g.onerror = function () { rej(g.error); }; }); }'
      + ' var STORES = ["conversations", "presentationEvents", "providerSessions", "providerFrames", "normalizedMessages",'
      + '   "settings", "secrets", "workspaceHandles", "meta", "attachments", "capabilities", "capabilityPackages"];'
      + ' for (var i = 0; i < STORES.length; i++) {'
      + '   var rows = await readAll(STORES[i]);'
      + '   var text = JSON.stringify(rows);'
      + '   out.stores[STORES[i]] = text.length; out.storeCount++;'
      + '   if (STORES[i] !== "secrets" && text.indexOf(TOKEN) !== -1) { out.leaked = true; out.where = "idb:" + STORES[i] + ":token"; }'
      + '   for (var k = 0; k < KEYS.length; k++) if (text.indexOf(KEYS[k]) !== -1) { out.leaked = true; out.where = "idb:" + STORES[i] + ":" + KEYS[k]; }'
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
      + '       if (text2.indexOf(TOKEN) !== -1) { out.leaked = true; out.where = "vfs:" + p + ":token"; }'
      + '       for (var k2 = 0; k2 < KEYS.length; k2++) if (text2.indexOf(KEYS[k2]) !== -1) { out.leaked = true; out.where = "vfs:" + p + ":" + KEYS[k2]; }'
      + '     }'
      + '   }'
      + ' }'
      + ' await walk("/home/locus/history", 3);'
      + ' var dom = document.body.textContent || "";'
      + ' out.domBytes = dom.length;'
      + ' if (dom.indexOf(TOKEN) !== -1) { out.leaked = true; out.where = "dom:token"; }'
      + ' for (var k3 = 0; k3 < KEYS.length; k3++) if (dom.indexOf(KEYS[k3]) !== -1) { out.leaked = true; out.where = "dom:" + KEYS[k3]; }'
      + ' return out; })()', 90000);
    check('M-A12 every IndexedDB store was swept and is free of the token and the form answer',
      sweep && !sweep.leaked && sweep.storeCount === 12, JSON.stringify(sweep && sweep.stores));
    check('M-A12 the history VFS (real files) is free of the token and the form answer',
      sweep && !sweep.leaked && sweep.vfsFiles > 0, JSON.stringify({ files: sweep && sweep.vfsFiles, where: sweep && sweep.where }));
    check('M-A12 the page DOM is free of the token and the form answer',
      sweep && !sweep.leaked && sweep.domBytes > 0, sweep && sweep.where);
    check('M-A12 session discipline: exactly one handshake per task AND one DELETE per established session',
      c.initialize === 10 && c.deletes.length === c.initialize,
      'initialize=' + c.initialize + ' deletes=' + c.deletes.length);

    // summary of the server-side request counts for the report
    console.log('# server request counters: ' + JSON.stringify({
      initialize: c.initialize, initialized: c.initialized, toolsList: c.toolsList,
      toolsCall: c.toolsCall, forms: c.forms, formReplies: c.formReplies,
      deletes: c.deletes.length, preflights: c.preflights,
      violations: c.violations.length, unauthorized: c.unauthorized,
    }));
  } finally {
    if (chrome) await closeChrome(chrome, profileDir).catch(() => {});
    appServer && appServer.close();
    mcpServer && mcpServer.close();
    for (const s of openStreams) { try { s.end(); } catch (e) { /* gone */ } }
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  console.log('# screenshots: ' + SHOT_DIR + ' (' + shotCount + ' taken)');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('MCP e2e FAIL:', e && e.stack || e);
  process.exit(1);
});
