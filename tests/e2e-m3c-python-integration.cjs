// M3c REVIEW B — Python integration browser gate (the audit's re-coverage
// of the scenarios that moved out of the product with the three-repo
// split). Real headless Chrome, the CURRENT vite build of the PRODUCT page
// (?e2e=1&wire=1), every scenario driven through the REAL production
// chain — scripted provider responses → real store submit → real Harness
// task runner → real Product ToolPort (tool-adapter + tools.js) → real
// installed package RuntimeSession → real worker/VFS. The ONLY fake is the
// wire transport at the model boundary (the product-joint rule).
//
// What this gate proves that the pinned cores' own gates cannot: the
// CURRENT Product ASSEMBLY (composition/storage wiring, prepare barrier,
// ToolPort injection, approval bridging) preserves the Python authority,
// bootstrap-integrity, plugin-payload and lifecycle behaviours on the
// packaged page — not inside a standalone runtime host.
//
//   B-FS   filesystem permission + skill-write confirmation through the
//          REAL chain: legal path commits (positive), confirmation gate
//          Confirm applies / Deny keeps bytes byte-for-byte, policy
//          refusal without any card
//   B-NET  the counter-credibility pair: an ALLOWED curl GET really hits
//          the probe (the counter sits on the direct dispatch path, the
//          tool result names backend browser-direct); the loopback POST is
//          refused pre-approval with ZERO hits and an identifiable reason
//   B-BOOT bootstrap integrity negative AT THE PRODUCT: the test-side
//          fetch patch (document-start, production files untouched)
//          intercepts the page's REAL pinned-CDN asset requests and
//          corrupts one byte on the wire → the boot fails CLOSED with the
//          sha256-mismatch error, no fake ready, the model's python code
//          never runs, the failure reaches the model as a failed tool
//          result; recovery with intact bytes succeeds from scratch
//   B-PY   python-side network/browser authority through the REAL chain:
//          js.fetch / pyfetch / micropip / importScripts / nested Worker /
//          sync XHR / WebSocket / urllib / pyodide.loadPackage / undeclared
//          imports / dynamic-JS escapes (js.eval, run_js, prototype-chain
//          Function recovery, the reconstructed-Function dynamic import)
//          are all denied with ZERO probe requests; the strict-CSP creator
//          iframe hosts the worker on the product page
//   B-PLG  the plugin payload path through the PRODUCT composition:
//          registerPluginRuntimeProvider('python', ...) → CapabilityManager
//          enable → session.prepare installs BEFORE READY → import works
//          (pandas coexists); a broken payload (same plugin id, new
//          version) reconfigures, fails the smoke import honestly, is NOT
//          silently served by the stale payload (the configured key names
//          the broken version) and never falls back to the network;
//          recovery with a good payload; a DISABLED capability returns to
//          core-only (extensionKey null) and the import fails honestly
//   B-LIFE cancel + session boundary DURING python execution through the
//          REAL chain: already-dispatched effects settle truthfully (file
//          exists), later effects never dispatch (file absent), the tool
//          result and the task terminal are honest failures ('cancelled' /
//          'session_changed', never completed)
//   B-TOT  whole-suite totals: exactly the allowed probe hits, every
//          intercepted asset URL is a pinned manifest name, zero page
//          errors
//
// The real Pyodide CDN download happens ONCE in this node process (disk
// cache first) and is recorded distinctly (B-CDN). If the CDN is
// unreachable AND the cache is cold, the gate reports itself BLOCKED —
// it never fills a fake success.
//
// Self-contained: builds dist/ and serves it (vite preview on a free
// port) unless E2E_APP_URL is set (then that page is used as-is — the
// run-browser-gates orchestrator form; add the suite to its SUITES list to
// register). Run standalone:
//   node tests/e2e-m3c-python-integration.cjs
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  allocateFreePort, closeChrome, closeManagedProcess, connectToTarget,
  launchChrome, launchManagedProcess, waitForCdp, waitForHttp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { loadPythonManifest } = require('./helpers/python-manifest.cjs');
const {
  loadPinnedAssets, startM3cPythonAssetServer, startM3cPythonProbeServer,
  buildM3cAssetInterceptionScript,
} = require('./helpers/m3c-python-servers.cjs');

const ROOT = path.join(__dirname, '..');
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const { base: PYODIDE_CDN, manifest: PY_MANIFEST } = loadPythonManifest();

const GOOD_PLUGIN_SRC = fsSync.readFileSync(
  path.join(__dirname, 'fixtures', 'm3c-python', 'locus_m3c_plugin.py'), 'utf8');
const BROKEN_PLUGIN_SRC = fsSync.readFileSync(
  path.join(__dirname, 'fixtures', 'm3c-python', 'locus_m3c_plugin_broken.py'), 'utf8');
const FIXTURE_SKILL = fsSync.readFileSync(
  path.join(__dirname, 'fixtures', 'skills', 'synthetic-skill', 'SKILL.md'), 'utf8');

const INSTANCE_A = '/home/locus/.skills/cap-a/synthetic-skill.skill';
const PYTHON_NETWORK_DENIED = 'Python network access is disabled in Locus';

// Synthetic catalogs — TEST-ONLY injection through the documented
// injectTestCatalog seam; production catalogs stay empty. The plugin
// version IS the extension key, so the broken variant reconfigures the
// interpreter instead of silently reusing the good payload.
function m3cCatalogs(pluginVersion) {
  return {
    plugins: [{
      id: 'm3c-python-plugin', version: String(pluginVersion),
      displayName: 'M3C Python Plugin', runtime: 'python', authority: 'none',
      provides: { pythonImports: ['locus_m3c_plugin'] },
    }],
    skills: [{
      id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill',
      description: 'M3c review B synthetic skill.',
    }],
    mcps: [],
    capabilities: [
      { id: 'cap-a', version: '1', displayName: 'Capability A', description: 'TEST ONLY.', plugins: [], skills: ['synthetic-skill'], mcps: [] },
      { id: 'm3c-plugin-cap', version: '1', displayName: 'M3C Plugin Capability', description: 'TEST ONLY.', plugins: ['m3c-python-plugin'], skills: [], mcps: [] },
    ],
  };
}
const SKILL_SOURCES = { 'synthetic-skill': { version: '1', source: FIXTURE_SKILL } };

function literal(value) { return JSON.stringify(value); }

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result?.result?.value;
}

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 600) : '')); }
  };

  // ---- assets: disk cache → ONE real CDN pass (recorded) -----------------
  console.log('# loading pinned pyodide assets (' + PY_MANIFEST.length
    + ' files; disk cache first, CDN once, recorded)');
  const assets = await loadPinnedAssets(ROOT, PYODIDE_CDN, PY_MANIFEST);
  const missingAssets = PY_MANIFEST.filter((a) => !assets.bytes.has(a.name)).map((a) => a.name);
  if (missingAssets.length) {
    console.error('GATE BLOCKED (environment): the pinned Pyodide asset set is unavailable —'
      + ' missing: ' + JSON.stringify(missingAssets)
      + ' CDN reachable: ' + assets.cdnReachable
      + '. This is an environment blockage, NOT a product pass.');
    process.exit(1);
  }
  console.log('# B-CDN real-CDP record: assets=' + PY_MANIFEST.length
    + ' realCdnDownloads=' + assets.realCdnDownloads
    + ' cacheHits=' + assets.cacheHits
    + ' (the CDN download is an environment record, distinct from every gate assertion)');

  // ---- servers ------------------------------------------------------------
  const assetServer = await startM3cPythonAssetServer(PY_MANIFEST);
  for (const [name, buf] of assets.bytes) assetServer.bytes.set(name, buf);
  const probe = await startM3cPythonProbeServer();
  const PROBE = probe.origin;

  // ---- app: build + preview (unless E2E_APP_URL hosts it) -----------------
  let preview = null;
  let appRoot;
  if (process.env.E2E_APP_URL) {
    appRoot = process.env.E2E_APP_URL;
    console.log('# using E2E_APP_URL: ' + appRoot);
  } else {
    console.log('# building dist (vite build)');
    const build = spawnSync(process.execPath, [VITE_CLI, 'build'], { stdio: 'inherit', cwd: ROOT });
    if (build.status !== 0) { console.error('BUILD FAILED'); process.exit(1); }
    const appPort = await allocateFreePort();
    preview = launchManagedProcess(process.execPath, [
      VITE_CLI, 'preview', '--host', '127.0.0.1', '--port', String(appPort), '--strictPort',
    ], { cwd: ROOT, port: appPort, label: 'Vite preview (m3c python integration)', env: process.env });
    appRoot = 'http://127.0.0.1:' + appPort + '/';
    await waitForHttp(appRoot, { process: preview, timeoutMs: 20000 });
  }
  const APP_URL = appRoot.replace(/\/$/, '') + '/?e2e=1&wire=1';

  let profileDir = null;
  let chrome = null;
  let cdp = null;
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3c-py-profile-'));
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'm3c python integration Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    // The interception patch is registered for the NEXT document start, so
    // the app reloads under it: every pinned-CDN fetch the product page
    // makes is recorded (URL pinning oracle) and served locally (fault
    // modes). Production files are untouched — this is the browser test
    // side, the same technique e2e-skill-instances uses for its asset
    // hosting.
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: buildM3cAssetInterceptionScript(PYODIDE_CDN, assetServer.origin),
    });
    await evaluate(cdp, 'location.reload(); "reloading"');
    await waitForRuntimeCondition(cdp,
      '!!(window.__locus && document.querySelector(".app-shell") && window.__locusWire && window.__pyAssetFetches)',
      { process: chrome, phase: 'm3c-py-app-boot', timeoutMs: 20000 });
    await waitForRuntimeCondition(cdp,
      'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
      { process: chrome, phase: 'm3c-py-durable-home', timeoutMs: 20000 });

    // ---- page-side helpers ------------------------------------------------
    const wireSettings = () => evaluate(cdp, `(async () => {
      await window.__locus.actions.resetAllData();
      const s = window.__locus.store.settings;
      s.apiBase = 'https://m3c-b.invalid/v1'; s.dialect = 'openai';
      s.model = 'm3c-b-model'; s.apiKey = 'M3C-B-KEY'; s.remember = false;
      window.__locus.actions.applySettings();
      await window.__locus.actions.persistSettingsIfNeeded();
    })()`);
    // SET (not append) the scripted queue: a previous task that ended
    // before consuming every staged response must not leak its leftovers
    // into the next task's requests (run-2 first-failure evidence: LIFE1's
    // cancelled task left its unused final response in the queue and
    // LIFE2's first request consumed it).
    const pushResponses = (responses) => evaluate(cdp,
      'window.__locusWire.responses = ' + literal(responses) + '; "armed"');
    const wireCalls = () => evaluate(cdp, 'window.__locusWire.calls.length');
    const newTask = () => evaluate(cdp, 'window.__locus.actions.newTask(); "new-task"');
    const submit = (text) => evaluate(cdp,
      '(function () { window.__locus.actions.submit(' + literal(text) + '); return "fired"; })()', 30000);
    const convByTitle = (title) => evaluate(cdp,
      '(function () { var c = window.__locus.store.conversations.find(function (x) { return x.title === '
      + literal(title) + '; }); return c ? JSON.parse(JSON.stringify({ status: c.status, items: c.items })) : null; })()');
    const waitConv = (title, phase, predicate, timeoutMs) => waitForRuntimeCondition(cdp,
      '(function () { var c = window.__locus.store.conversations.find(function (x) { return x.title === '
      + literal(title) + '; }); return c ? c.status : null; })()',
      { process: chrome, phase, timeoutMs: timeoutMs || 60000, predicate: predicate || ((v) => v === 'completed') });
    const toolResults = (title) => evaluate(cdp,
      '(function () { var c = window.__locus.store.conversations.find(function (x) { return x.title === '
      + literal(title) + '; }); return c ? JSON.parse(JSON.stringify('
      + 'c.items.filter(function (i) { return i.kind === "tool" && i.result; })'
      + '.map(function (i) { return i.result; }))) : null; })()');
    const toolMessages = (callIndex) => evaluate(cdp,
      '(function () { var c = window.__locusWire.calls[' + callIndex + ']; return c ? '
      + 'c.body.messages.filter(function (m) { return m.role === "tool"; }).map(function (m) { return String(m.content || ""); }) : null; })()');
    const pendingApproval = () => evaluate(cdp,
      '(function () { var p = window.__locus.store.pendingApproval; return p ? '
      + '{ kind: p.kind, type: p.action && p.action.type, id: p.id } : null; })()');
    const resolveApproval = (decision) => evaluate(cdp,
      '(function () { var p = window.__locus.store.pendingApproval; if (!p) return "no-card"; '
      + 'return String(window.__locus.actions.resolveApproval(p.id, ' + literal(decision) + ')); })()');
    const denyApproval = () => evaluate(cdp,
      '(function () { return String(window.__locus.actions.denyApproval()); })()');
    const pyState = () => evaluate(cdp,
      '(function () { var p = window.__locus.pythonRuntime && window.__locus.pythonRuntime(); '
      + 'var s = p ? p.snapshot() : null; '
      + 'return { projected: window.__locus.store.pythonStatus, interpreter: s ? s.interpreter : null, '
      + 'extensionKey: s ? s.extensionKey : null, busyExecutions: s ? s.busyExecutions : null }; })()');
    const assetFetches = () => evaluate(cdp, 'window.__pyAssetFetches.length');
    const pageErrors = () => evaluate(cdp, '(window.__e2eErrors || []).slice(0, 5)');
    // The ONE allowed probe hit of the whole gate is B-NET1's curl GET.
    // Every later zero-dispatch claim asserts against this baseline.
    const probeBeyondAllowed = () => probe.hitCount() - 1;

    // One full wire-mode task through the REAL chain. Returns the
    // conversation snapshot after it reached `status`.
    const runTask = async (title, responses, wantStatus, timeoutMs, phase) => {
      await pushResponses(responses);
      await newTask();
      await submit(title);
      await waitConv(title, phase || ('m3c-py-task: ' + title),
        (v) => v === (wantStatus || 'completed'), timeoutMs || 60000);
      return convByTitle(title);
    };
    const toolCall = (id, input) => ({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'bash', arguments: JSON.stringify({ input }) } }] }, finish_reason: 'tool_calls' }],
    });
    const finalAnswer = (text) => ({
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    });
    const pyCmd = (code) => "python <<'PY'\n" + (Array.isArray(code) ? code.join('\n') : code) + '\nPY';

    await wireSettings();
    // TEST-ONLY composition setup: synthetic catalogs + the python plugin
    // runtime provider (the documented provider seam — a real wheel loader
    // would implement the same seam). Production catalogs stay empty.
    await evaluate(cdp,
      'window.__locus.capabilityComposition.injectTestCatalog('
      + literal(m3cCatalogs(1)) + ', ' + literal(SKILL_SOURCES) + '); "catalog"');
    const registerProvider = (sourceText) => evaluate(cdp,
      'window.__locus.capabilityComposition.registerPluginRuntimeProvider("python", '
      + '{ prepare: async function () { return { files: { "locus_m3c_plugin.py": '
      + literal(sourceText) + ' }, imports: ["locus_m3c_plugin"] }; } }); "provider"');
    await registerProvider(GOOD_PLUGIN_SRC);
    const enableCap = (id) => evaluate(cdp,
      '(async function () { var s = await window.__locus.capabilityComposition.enable(' + literal(id) + '); return s; })()');
    check('B-SETUP cap-a (skills) enabled ready', (await enableCap('cap-a')) === 'ready');
    const capList = await evaluate(cdp, 'window.__locus.capabilityComposition.list()'
      + '.filter(function (c) { return c.id === "cap-a"; })[0].state');
    check('B-SETUP composition projects the enabled capability', capList === 'ready', String(capList));

    // ======================= B-FS: filesystem + skill confirmation ========
    {
      const fs1 = await runTask('B-FS1 legal write', [
        toolCall('m3c-fs1', 'echo m3c-fs1-body > /tmp/m3c-fs1.txt && cat /tmp/m3c-fs1.txt'),
        finalAnswer('B-FS1 done'),
      ]);
      const fs1Read = await evaluate(cdp, '(async function () { return await window.__locus.vfs.read("/tmp/m3c-fs1.txt"); })()');
      check('B-FS1 legal path write through the real chain commits and reads back',
        (fs1Read || '').includes('m3c-fs1-body') && fs1.status === 'completed',
        JSON.stringify({ status: fs1.status, read: String(fs1Read).slice(0, 80) }));

      const before = await evaluate(cdp, '(async function () { return await window.__locus.vfs.read(' + literal(INSTANCE_A) + '); })()');
      await pushResponses([
        toolCall('m3c-fs2', 'echo "m3c approved edit" >> ' + INSTANCE_A),
        finalAnswer('B-FS2 done'),
      ]);
      await newTask();
      await submit('B-FS2 skill write confirm');
      await waitForRuntimeCondition(cdp, '!!window.__locus.store.pendingApproval',
        { process: chrome, phase: 'm3c-py-fs2-card', timeoutMs: 20000 });
      const card = await pendingApproval();
      check('B-FS2a the skill write raises the REAL confirmation card (kind confirmation, skill-write)',
        card && card.kind === 'confirmation' && card.type === 'skill-write', JSON.stringify(card));
      check('B-FS2b Confirm applies the write through the real guard',
        (await resolveApproval({ outcome: 'confirm', scope: 'once' })) === 'true');
      await waitConv('B-FS2 skill write confirm', 'm3c-py-fs2-done');
      const after = await evaluate(cdp, '(async function () { return await window.__locus.vfs.read(' + literal(INSTANCE_A) + '); })()');
      check('B-FS2c the approved skill instance really changed',
        (after || '').includes('m3c approved edit') && !(before || '').includes('m3c approved edit'),
        JSON.stringify(String(after).slice(0, 100)));

      const beforeDeny = await evaluate(cdp, '(async function () { return await window.__locus.vfs.read(' + literal(INSTANCE_A) + '); })()');
      await pushResponses([
        toolCall('m3c-fs3', 'echo "m3c denied edit" >> ' + INSTANCE_A),
        finalAnswer('B-FS3 done'),
      ]);
      await newTask();
      await submit('B-FS3 skill write deny');
      await waitForRuntimeCondition(cdp, '!!window.__locus.store.pendingApproval',
        { process: chrome, phase: 'm3c-py-fs3-card', timeoutMs: 20000 });
      check('B-FS3a Deny (escape) refuses the confirmation',
        (await denyApproval()) === 'true');
      await waitConv('B-FS3 skill write deny', 'm3c-py-fs3-done');
      const afterDeny = await evaluate(cdp, '(async function () { return await window.__locus.vfs.read(' + literal(INSTANCE_A) + '); })()');
      const fs3res = await toolResults('B-FS3 skill write deny');
      check('B-FS3b the refused write leaves the file byte-for-byte unchanged and reports the failure',
        afterDeny === beforeDeny && fs3res.some((r) => r.success === false
          && /cancelled|declined|not modified/i.test(r.output || '')),
        JSON.stringify({ same: afterDeny === beforeDeny, results: fs3res.map((r) => String(r.output).slice(0, 120)) }));

      await pushResponses([toolCall('m3c-fs4', 'rm -r /home/locus/.skills/cap-a'), finalAnswer('B-FS4 done')]);
      await newTask();
      await submit('B-FS4 policy refusal');
      await waitConv('B-FS4 policy refusal', 'm3c-py-fs4-done');
      const fs4res = await toolResults('B-FS4 policy refusal');
      const fs4card = await pendingApproval();
      const fs4dirGone = await evaluate(cdp,
        '(async function () { return await window.__locus.vfs.exists(' + literal(INSTANCE_A) + '); })()');
      check('B-FS4 the mutation-policy refusal needs no card, keeps the file and names the boundary',
        !fs4card && fs4dirGone === true && fs4res.some((r) => r.success === false
          && /skill|capabilit/i.test(r.output || '')),
        JSON.stringify({ card: fs4card, exists: fs4dirGone, outputs: fs4res.map((r) => String(r.output).slice(0, 140)) }));
    }

    // ======================= B-NET: counter credibility pair ==============
    {
      const t1 = probe.hitCount();
      const net1 = await runTask('B-NET1 allow positive', [
        toolCall('m3c-net1', 'curl ' + PROBE + '/target/cors-ok'),
        finalAnswer('B-NET1 done'),
      ]);
      const net1res = await toolResults('B-NET1 allow positive');
      const delta1 = probe.hitCount() - t1;
      check('B-NET1 ALLOWED curl GET really dispatches: the probe counter sits on the real path',
        delta1 === 1 && net1res.some((r) => r.success === true && r.output.includes('"cors":"ok"')),
        JSON.stringify({ delta: delta1, results: net1res.map((r) => String(r.output).slice(0, 120)) }));
      check('B-NET1b the chain names its dispatch location: backend browser-direct',
        net1res.some((r) => r.backend === 'browser-direct'),
        JSON.stringify(net1res.map((r) => r.backend)));

      const t2 = probe.hitCount();
      const net2 = await runTask('B-NET2 loopback write refusal', [
        toolCall('m3c-net2', 'curl -X POST ' + PROBE + '/target/echo -d m3c-b-body'),
        finalAnswer('B-NET2 done'),
      ]);
      const net2res = await toolResults('B-NET2 loopback write refusal');
      const net2card = await pendingApproval();
      check('B-NET2 the cross-origin loopback write is refused BEFORE any dispatch (zero hits, identifiable reason, no card)',
        probe.hitCount() - t2 === 0 && !net2card && net2.status === 'completed'
        && net2res.some((r) => r.success === false && /private or loopback/i.test(r.output || '')),
        JSON.stringify({ delta: probe.hitCount() - t2, card: net2card, outputs: net2res.map((r) => String(r.output).slice(0, 140)) }));
    }

    // ======================= B-BOOT: integrity negative AT THE PRODUCT ====
    let bootPhaseAssetBaseline = await assetFetches();
    {
      assetServer.setMode('corrupt:pyodide.asm.wasm');
      const callsBefore = await wireCalls();
      await pushResponses([
        toolCall('m3c-boot1', pyCmd("print('M3C-B-NEVER')")),
        finalAnswer('B-BOOT1 acknowledged the bootstrap failure'),
      ]);
      await newTask();
      await submit('B-BOOT1 corrupt asset');
      await waitConv('B-BOOT1 corrupt asset', 'm3c-py-boot1-done', (v) => v === 'completed', 300000);
      const boot1 = await toolResults('B-BOOT1 corrupt asset');
      const boot1State = await pyState();
      const boot1ToolMsgs = await toolMessages(callsBefore + 1); // the follow-up request carries the tool result
      check('B-BOOT1 the corrupted wire byte fails the boot CLOSED with the integrity error',
        boot1.some((r) => r.success === false && /integrity check failed/i.test(r.output || '')
          && /sha256 mismatch/i.test(r.output || '')),
        JSON.stringify(boot1.map((r) => String(r.output).slice(0, 220))));
      check('B-BOOT1b no fake ready: neither the projection nor the interpreter reports ready',
        boot1State.projected !== 'ready' && boot1State.interpreter !== 'ready', JSON.stringify(boot1State));
      check('B-BOOT1c the model\'s python code never ran (sentinel absent from every tool result)',
        boot1.every((r) => !(r.output || '').includes('M3C-B-NEVER')),
        JSON.stringify(boot1.map((r) => String(r.output).slice(0, 120))));
      check('B-BOOT1d the failure reached the model as a failed tool result (next provider request)',
        Array.isArray(boot1ToolMsgs) && boot1ToolMsgs.some((m) => /integrity check failed/i.test(m) && /sha256 mismatch/i.test(m)),
        JSON.stringify(boot1ToolMsgs && boot1ToolMsgs.map((m) => m.slice(0, 160))));
      assetServer.setMode('good');
    }

    // ======================= B-PY: authority battery (warm interpreter) ===
    {
      const t0 = Date.now();
      const py1 = await runTask('B-PY0 recovery boot', [
        toolCall('m3c-py0', pyCmd("print('M3C-B-PY-OK', 2 + 2)")),
        finalAnswer('B-PY0 done'),
      ], 'completed', 300000, 'm3c-py-py0-boot');
      const py0res = await toolResults('B-PY0 recovery boot');
      console.log('# B-PY0 clean boot took ' + Math.round((Date.now() - t0) / 1000) + 's');
      check('B-PY0 recovery: intact bytes boot from scratch through the product chain and python works',
        py0res.some((r) => r.success === true && r.output.includes('M3C-B-PY-OK 4')) && py1.status === 'completed',
        JSON.stringify(py0res.map((r) => String(r.output).slice(0, 140))));

      // The provider result for every denial below: { ok, output } shaped by
      // the probe counter DELTA — the text alone never proves zero dispatch.
      const pyDeny = async (label, id, code, extra) => {
        const t = probe.hitCount();
        await runTask(label, [toolCall(id, pyCmd(code)), finalAnswer(label + ' done')],
          'completed', 180000, 'm3c-py-' + id);
        const res = await toolResults(label);
        const delta = probe.hitCount() - t;
        const fail = res.some((r) => r.success === false);
        const out = res.map((r) => String(r.output || '')).join('\n');
        const verdict = Object.assign({ fail, delta, out }, extra ? extra(fail, out) : {});
        return { verdict, res };
      };

      // E3 discipline: single attempt, no auto-retry. The denial must carry
      // the policy marker; a failure WITHOUT the marker is a FAIL, not a
      // re-observation. The E3-family error-text instability (a Pyodide
      // traceback surfacing instead of the marker) has an UNDETERMINED
      // root cause — no "fixed at the pinned runtime" claim is made here
      // (this round's own verification recorded one such marker-less
      // occurrence: fail=true and zero dispatch held, marker absent).
      // Every occurrence is evidence; calling it the same root cause as
      // the historical E3 requires a dedicated experiment, not wording.
      // [Reworded 2026-10-05, second review round: the previous text said
      // the historical Pyodide SystemError bridge glitch "is fixed at the
      // pinned runtime" — withdrawn as unproven.]
      {
        const { verdict } = await pyDeny('B-PY1 js.fetch deny', 'm3c-py1',
          ['import js', "js.fetch('" + PROBE + "/probe-hit')"],
          (fail, out) => ({ marker: out.includes(PYTHON_NETWORK_DENIED) }));
        check('B-PY1 python js.fetch denied at the policy layer with the marker',
          verdict.fail && verdict.marker, JSON.stringify(verdict).slice(0, 300));
        check('B-PY1b js.fetch produced ZERO requests to the probe (counter oracle)',
          verdict.delta === 0, 'delta=' + verdict.delta);
      }
      {
        const { verdict } = await pyDeny('B-PY2 pyfetch deny', 'm3c-py2', [
          'import asyncio, time',
          'from pyodide.http import pyfetch',
          'async def go():',
          '    try:',
          "        r = await pyfetch('" + PROBE + "/probe-hit')",
          "        print('pyfetch ALLOWED', r.status)",
          '    except Exception as ex:',
          "        print('pyfetch denied:', str(ex)[:80])",
          'asyncio.ensure_future(go())',
          'time.sleep(1.5)',
        ], (fail, out) => ({ ran: out.includes('pyfetch denied:'), allowed: out.includes('pyfetch ALLOWED') }));
        check('B-PY2 pyodide.http.pyfetch denied inside the run, ZERO requests',
          verdict.ran && !verdict.allowed && verdict.delta === 0,
          JSON.stringify(verdict).slice(0, 300));
      }
      {
        const { verdict } = await pyDeny('B-PY3 micropip deny', 'm3c-py3', [
          'import micropip',
          "await micropip.install('" + PROBE + "/probe_wheel_fake-1.0-py3-none-any.whl')",
        ]);
        check('B-PY3 micropip.install of a local wheel URL denied, ZERO requests',
          verdict.fail && verdict.delta === 0, JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY4 importScripts deny', 'm3c-py4', [
          'import js', "js.importScripts('" + PROBE + "/probe-script.js')",
        ]);
        check('B-PY4 importScripts denied, ZERO requests', verdict.fail && verdict.delta === 0,
          JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY5 nested Worker deny', 'm3c-py5', [
          'import js',
          'blob = js.Blob.new(["fetch(\'' + PROBE + '/probe-hit\')"], {"type": "text/javascript"})',
          'wurl = js.URL.createObjectURL(blob)',
          'w = js.Worker.new(wurl)',
        ], (fail, out) => ({ marker: out.includes(PYTHON_NETWORK_DENIED) }));
        check('B-PY5 nested-Worker escape denied with the marker, ZERO requests',
          verdict.fail && verdict.marker && verdict.delta === 0, JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY6 sync XHR deny', 'm3c-py6', [
          'import js',
          'x = js.XMLHttpRequest.new()',
          "x.open('GET', '" + PROBE + "/probe-hit', False)",
          'x.send()',
        ]);
        check('B-PY6 sync XMLHttpRequest denied, ZERO requests', verdict.fail && verdict.delta === 0,
          JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY7 WebSocket deny', 'm3c-py7', [
          'import js',
          "ws = js.WebSocket.new('ws://127.0.0.1:" + probe.port + "/probe-hit')",
          "print('WS CONSTRUCTED')",
        ], (fail, out) => ({ constructed: out.includes('WS CONSTRUCTED') }));
        check('B-PY7 WebSocket construction denied, never constructed, ZERO requests',
          verdict.fail && !verdict.constructed && verdict.delta === 0,
          JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY8 urllib deny', 'm3c-py8', [
          'import urllib.request',
          "urllib.request.urlopen('" + PROBE + "/probe-hit', timeout=3)",
        ]);
        check('B-PY8 urllib cannot reach the network either, ZERO requests',
          verdict.fail && verdict.delta === 0, JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY9 loadPackage deny', 'm3c-py9', [
          'import pyodide', "pyodide.loadPackage('regex')",
        ], (fail, out) => ({ bounded: out.includes('Python package loading is controlled by the Locus runtime')
          || out.includes("has no attribute 'loadPackage'") }));
        check('B-PY9 pyodide.loadPackage denied (package authority stays with the runtime)',
          verdict.fail && verdict.bounded, JSON.stringify(verdict).slice(0, 240));
      }
      {
        const { verdict } = await pyDeny('B-PY10 undeclared import honest', 'm3c-py10', [
          'try:',
          '    import regex',
          "    print('regex IMPORTED')",
          'except ModuleNotFoundError:',
          "    print('regex ModuleNotFoundError')",
        ], (fail, out) => ({ honest: out.includes('regex ModuleNotFoundError') }));
        check('B-PY10 a lockfile package outside the declared set fails honestly, ZERO network fallback',
          !verdict.fail && verdict.honest && verdict.delta === 0,
          JSON.stringify(verdict).slice(0, 240));
      }
      {
        const since = Date.now();
        const t = probe.hitCount();
        await runTask('B-PY11 dynamic escapes', [toolCall('m3c-py11', pyCmd([
          'import js',
          "js.eval(\"fetch('" + PROBE + "/probe-hit')\")",
        ])), toolCall('m3c-py11b', pyCmd([
          'from pyodide.code import run_js',
          "run_js(\"fetch('" + PROBE + "/probe-hit')\")",
        ])), toolCall('m3c-py11c', pyCmd([
          'import js',
          'F = js.Function.new("url", "const f = Object.getPrototypeOf(self).fetch; return Reflect.apply(f, self, [url])")',
          "F('" + PROBE + "/probe-hit')",
        ])), finalAnswer('B-PY11 done')], 'completed', 180000, 'm3c-py-py11');
        const res = await toolResults('B-PY11 dynamic escapes');
        const delta = probe.hitCount() - t;
        check('B-PY11 dynamic-JS escapes (js.eval, run_js, prototype-chain Function recovery) all denied, ZERO requests',
          res.length === 3 && res.every((r) => r.success === false) && delta === 0,
          JSON.stringify({ n: res.length, ok: res.map((r) => r.success), delta }));
      }
      {
        const t = probe.hitCount();
        await runTask('B-PY12 reconstructed-Function dynamic import', [toolCall('m3c-py12', pyCmd([
          'import js',
          'F = js.Function.new("u", "return import(u).then(function(){ return \'LOADED\'; }, function(e){ return \'ERR: \' + (e && e.message || String(e)); })")',
          "res = await F('" + PROBE + "/probe-script.js')",
          "print('PROBE-IMPORT:', res)",
        ])), finalAnswer('B-PY12 done')], 'completed', 180000, 'm3c-py-py12');
        const res = await toolResults('B-PY12 reconstructed-Function dynamic import');
        await new Promise((r) => setTimeout(r, 1000)); // settle a possible in-flight import before reading the counter
        const delta = probe.hitCount() - t;
        const out = res.map((r) => String(r.output || '')).join('\n');
        check('B-PY12 the called dynamic import from a reconstructed Function is browser-CSP blocked (ERR surfaced, never LOADED, ZERO requests)',
          out.includes('PROBE-IMPORT: ERR') && !out.includes('PROBE-IMPORT: LOADED') && delta === 0,
          JSON.stringify({ out: out.slice(-240), delta }));
      }
      {
        const creator = await evaluate(cdp, `(function () {
          var f = document.querySelector('iframe[data-locus-py-creator]');
          return f ? { present: true, srcdoc: f.srcdoc || '' } : { present: false };
        })()`);
        check('B-PY13 the product page hosts the strict-CSP creator iframe around the python worker',
          creator.present && /default-src 'none'/.test(creator.srcdoc)
          && /connect-src 'none'/.test(creator.srcdoc)
          && /worker-src blob:/.test(creator.srcdoc),
          JSON.stringify(String(creator.srcdoc || '').slice(0, 160)));
      }

      // Python write-back through the skill guard (the commit phase honors
      // the SAME confirmation the shell path uses).
      const pyBefore = await evaluate(cdp,
        '(async function () { return await window.__locus.vfs.read(' + literal(INSTANCE_A) + '); })()');
      await pushResponses([
        toolCall('m3c-py-skill', pyCmd([
          "open('/tmp/m3c-py-ordinary.txt', 'w').write('ordinary committed')",
          "open('" + INSTANCE_A + "', 'w').write('# python denied edit')",
          "print('py done')",
        ])),
        finalAnswer('B-PY14 done'),
      ]);
      await newTask();
      await submit('B-PY14 python skill-write deny');
      await waitForRuntimeCondition(cdp, '!!window.__locus.store.pendingApproval',
        { process: chrome, phase: 'm3c-py-py14-card', timeoutMs: 20000 });
      const py14card = await pendingApproval();
      await denyApproval();
      await waitConv('B-PY14 python skill-write deny', 'm3c-py-py14-done');
      const py14res = await toolResults('B-PY14 python skill-write deny');
      const pyAfter = await evaluate(cdp,
        '(async function () { return await window.__locus.vfs.read(' + literal(INSTANCE_A) + '); })()');
      const pyOrdinary = await evaluate(cdp,
        '(async function () { return await window.__locus.vfs.read("/tmp/m3c-py-ordinary.txt"); })()');
      check('B-PY14 the python commit phase suspends on the SAME confirmation; Deny keeps the skill byte-for-byte while the legal ordinary write commits (positive control)',
        py14card && py14card.kind === 'confirmation' && pyAfter === pyBefore
        && (pyOrdinary || '').includes('ordinary committed')
        && py14res.some((r) => /conflict/.test(r.output || '') && /cancelled/.test(r.output || ''))
        && py14res.some((r) => (r.output || '').includes('[written: /tmp/m3c-py-ordinary.txt]')),
        JSON.stringify({ card: py14card, same: pyAfter === pyBefore, ordinary: String(pyOrdinary).slice(0, 60),
          outputs: py14res.map((r) => String(r.output).slice(-200)) }));
    }

    // ======================= B-PLG: payload path through the composition ==
    {
      const bootAssetsBefore = await assetFetches();
      check('B-PLG0 plugin capability enabled ready through the manager',
        (await enableCap('m3c-plugin-cap')) === 'ready');
      const plg1 = await runTask('B-PLG1 plugin import', [
        toolCall('m3c-plg1', pyCmd([
          'import pandas as pd',
          'import locus_m3c_plugin',
          "print('ANSWER', locus_m3c_plugin.answer())",
          "print('DF', int(pd.DataFrame({'a': [2, 20]}).a.sum()))",
        ])),
        finalAnswer('B-PLG1 done'),
      ], 'completed', 300000, 'm3c-py-plg1');
      const plg1res = await toolResults('B-PLG1 plugin import');
      const plg1State = await pyState();
      check('B-PLG1 the Product-composed plugin really installed BEFORE READY: import answers 42, pandas coexists',
        plg1res.some((r) => r.success === true && r.output.includes('ANSWER 42') && r.output.includes('DF 22')),
        JSON.stringify(plg1res.map((r) => String(r.output).slice(0, 200))));
      check('B-PLG1b the interpreter carries the composed payload key',
        plg1State.extensionKey === 'm3c-python-plugin@1', JSON.stringify(plg1State));
      check('B-PLG1c the payload rebuild fetched ZERO assets (verified cache; payload rides the bootstrap message, never the network)',
        (await assetFetches()) === bootAssetsBefore, 'delta=' + ((await assetFetches()) - bootAssetsBefore));

      // Broken payload: SAME plugin id, version 2 → a genuinely different
      // extension key → prepare reconfigures → smoke import fails the boot.
      await evaluate(cdp, 'window.__locus.capabilityComposition.injectTestCatalog('
        + literal(m3cCatalogs(2)) + ', ' + literal(SKILL_SOURCES) + '); "catalog2"');
      await registerProvider(BROKEN_PLUGIN_SRC);
      check('B-PLG2 the broken-payload capability still enables (the payload is structurally valid; compilation is the interpreter\'s verdict)',
        (await enableCap('m3c-plugin-cap')) === 'ready');
      const plg2Assets = await assetFetches();
      await pushResponses([
        toolCall('m3c-plg2', pyCmd("import locus_m3c_plugin\nprint('M3C-B-PLG-NEVER', locus_m3c_plugin.answer())")),
        finalAnswer('B-PLG2 acknowledged the failure'),
      ]);
      await newTask();
      await submit('B-PLG2 broken payload');
      await waitConv('B-PLG2 broken payload', 'm3c-py-plg2-done', (v) => v === 'completed', 300000);
      const plg2res = await toolResults('B-PLG2 broken payload');
      const plg2State = await pyState();
      const plg2Out = plg2res.map((r) => String(r.output || '')).join('\n');
      check('B-PLG2 the broken payload fails the boot honestly at the smoke import, no READY, sentinel never runs',
        /smoke import failed/i.test(plg2Out) && !plg2Out.includes('M3C-B-PLG-NEVER')
        && plg2State.interpreter !== 'ready' && plg2State.projected !== 'ready',
        JSON.stringify({ out: plg2Out.slice(0, 260), state: plg2State }));
      check('B-PLG2b no silent fallback: the configured key names the BROKEN version (not the stale good payload)',
        plg2State.extensionKey === 'm3c-python-plugin@2', JSON.stringify(plg2State));
      check('B-PLG2c the failed payload install fetched ZERO assets and ZERO probe requests',
        (await assetFetches()) === plg2Assets && probeBeyondAllowed() === 0,
        'assets delta=' + ((await assetFetches()) - plg2Assets) + ' probeBeyond=' + probeBeyondAllowed());

      // Recovery: good payload under version 3.
      await evaluate(cdp, 'window.__locus.capabilityComposition.injectTestCatalog('
        + literal(m3cCatalogs(3)) + ', ' + literal(SKILL_SOURCES) + '); "catalog3"');
      await registerProvider(GOOD_PLUGIN_SRC);
      check('B-PLG3 the good-payload capability re-enables ready',
        (await enableCap('m3c-plugin-cap')) === 'ready');
      const plg3 = await runTask('B-PLG3 recovery import', [
        toolCall('m3c-plg3', pyCmd("import locus_m3c_plugin\nprint('ANSWER', locus_m3c_plugin.answer())")),
        finalAnswer('B-PLG3 done'),
      ], 'completed', 300000, 'm3c-py-plg3');
      const plg3res = await toolResults('B-PLG3 recovery import');
      check('B-PLG3 recovery with a good payload answers 42 again',
        plg3res.some((r) => r.success === true && r.output.includes('ANSWER 42')) && plg3.status === 'completed',
        JSON.stringify(plg3res.map((r) => String(r.output).slice(0, 140))));

      // Disabled: back to core-only; the import fails honestly with zero
      // network fallback.
      await evaluate(cdp, '(async function () { await window.__locus.capabilityComposition.disable("m3c-plugin-cap"); return "off"; })()');
      const plg4 = await runTask('B-PLG4 disabled plugin import', [
        toolCall('m3c-plg4', pyCmd([
          'try:',
          '    import locus_m3c_plugin',
          "    print('PLUG IMPORTED')",
          'except ModuleNotFoundError:',
          "    print('plugin ModuleNotFoundError')",
        ])),
        finalAnswer('B-PLG4 done'),
      ], 'completed', 300000, 'm3c-py-plg4');
      const plg4res = await toolResults('B-PLG4 disabled plugin import');
      const plg4State = await pyState();
      const plg4Out = plg4res.map((r) => String(r.output || '')).join('\n');
      check('B-PLG4 a disabled capability returns the interpreter to core-only: import fails honestly, payload key cleared, ZERO network',
        plg4Out.includes('plugin ModuleNotFoundError') && !plg4Out.includes('PLUG IMPORTED')
        && plg4State.extensionKey === null && probeBeyondAllowed() === 0,
        JSON.stringify({ out: plg4Out.slice(0, 200), state: plg4State, probeBeyond: probeBeyondAllowed() }));
    }

    // ======================= B-LIFE: cancel + session boundary ============
    {
      await pushResponses([
        toolCall('m3c-life1a', 'echo dispatched-and-committed > /tmp/m3c-life-a.txt'),
        toolCall('m3c-life1b', pyCmd([
          'import time',
          'time.sleep(60)',
          "open('/tmp/m3c-life-b.txt', 'w').write('late')",
          "print('LIFE-B-WRITTEN')",
        ])),
        finalAnswer('B-LIFE1 never reaches the model'),
      ]);
      await newTask();
      await submit('B-LIFE1 cancel mid-python');
      // State-driven barrier (never a fixed sleep): the second tool call is
      // in AND the python run is admitted (busyExecutions >= 1).
      await waitForRuntimeCondition(cdp,
        '(function () { var c = window.__locus.store.conversations.find(function (x) { return x.title === "B-LIFE1 cancel mid-python"; }); '
        + 'var p = window.__locus.pythonRuntime && window.__locus.pythonRuntime(); '
        + 'var busy = p ? p.snapshot().busyExecutions : 0; '
        + 'return c ? (c.items.filter(function (i) { return i.kind === "tool"; }).length >= 2 && busy >= 1) : false; })()',
        { process: chrome, phase: 'm3c-py-life1-admitted', timeoutMs: 120000 });
      const callsAtCancel = await wireCalls();
      await evaluate(cdp, 'window.__locus.actions.cancelTask(); "cancel requested"');
      await waitConv('B-LIFE1 cancel mid-python', 'm3c-py-life1-cancelled', (v) => v === 'cancelled', 60000);
      const life1 = await convByTitle('B-LIFE1 cancel mid-python');
      const life1res = await toolResults('B-LIFE1 cancel mid-python');
      const aCommitted = await evaluate(cdp,
        '(async function () { try { return await window.__locus.vfs.read("/tmp/m3c-life-a.txt"); } catch (e) { return null; } })()');
      const bAbsent = await evaluate(cdp,
        '(async function () { try { await window.__locus.vfs.read("/tmp/m3c-life-b.txt"); return true; } catch (e) { return false; } })()');
      const callsAfter = await wireCalls();
      check('B-LIFE1 the cancelled task ends cancelled with the honest committed-effects warning (never completed)',
        life1.status === 'cancelled'
        && life1.items.some((i) => i.kind === 'warning' && i.code === 'task_cancelled_committed'),
        JSON.stringify({ status: life1.status,
          warnings: life1.items.filter((i) => i.kind === 'warning').map((i) => i.code) }));
      check('B-LIFE1b the already-dispatched effect settled truthfully (file committed before the cancel)',
        (aCommitted || '').includes('dispatched-and-committed'), String(aCommitted).slice(0, 80));
      check('B-LIFE1c the later side effect never dispatched (the post-cancel write is absent)',
        bAbsent === false, 'b exists=' + bAbsent);
      check('B-LIFE1d the python tool result is an honest cancellation failure',
        life1res.length >= 2 && life1res[life1res.length - 1].success === false
        && /cancelled/i.test(life1res[life1res.length - 1].output || ''),
        JSON.stringify(life1res.map((r) => String(r.output).slice(-100))));
      check('B-LIFE1e no further model request after the cancel',
        callsAfter === callsAtCancel, JSON.stringify({ at: callsAtCancel, after: callsAfter }));

      // Session boundary during python: newTask() while the run is in.
      await pushResponses([
        toolCall('m3c-life2a', 'echo boundary-committed > /tmp/m3c-life-g.txt'),
        toolCall('m3c-life2b', pyCmd([
          'import time',
          'time.sleep(60)',
          "open('/tmp/m3c-life-h.txt', 'w').write('late')",
          "print('LIFE-H-WRITTEN')",
        ])),
        finalAnswer('B-LIFE2 never reaches the model'),
      ]);
      await newTask();
      await submit('B-LIFE2 session boundary mid-python');
      await waitForRuntimeCondition(cdp,
        '(function () { var c = window.__locus.store.conversations.find(function (x) { return x.title === "B-LIFE2 session boundary mid-python"; }); '
        + 'var p = window.__locus.pythonRuntime && window.__locus.pythonRuntime(); '
        + 'var busy = p ? p.snapshot().busyExecutions : 0; '
        + 'return c ? (c.items.filter(function (i) { return i.kind === "tool"; }).length >= 2 && busy >= 1) : false; })()',
        { process: chrome, phase: 'm3c-py-life2-admitted', timeoutMs: 120000 });
      const life2Calls = await wireCalls();
      await newTask(); // the session boundary itself
      await waitConv('B-LIFE2 session boundary mid-python', 'm3c-py-life2-boundary',
        (v) => v !== null && v !== 'running' && v !== 'completed', 60000);
      const life2 = await convByTitle('B-LIFE2 session boundary mid-python');
      const life2res = await toolResults('B-LIFE2 session boundary mid-python');
      const gCommitted = await evaluate(cdp,
        '(async function () { try { return await window.__locus.vfs.read("/tmp/m3c-life-g.txt"); } catch (e) { return null; } })()');
      const hAbsent = await evaluate(cdp,
        '(async function () { try { await window.__locus.vfs.read("/tmp/m3c-life-h.txt"); return true; } catch (e) { return false; } })()');
      check('B-LIFE2 the session-boundary task ends session_changed (an honest supersession, never completed)',
        life2.status === 'session_changed', JSON.stringify({ status: life2.status }));
      check('B-LIFE2b the pre-boundary effect settled, the post-boundary write never dispatched',
        (gCommitted || '').includes('boundary-committed') && hAbsent === false,
        JSON.stringify({ g: String(gCommitted).slice(0, 60), hExists: hAbsent }));
      // Harness contract (agent.js native batch): a tool that finishes after
      // a SESSION SWITCH has its result deliberately NOT projected — it
      // belongs to the dead session. The honest shape is: no fabricated
      // result for the python call + an explicit session_changed warning.
      check('B-LIFE2c the in-flight tool result is deliberately not projected (dead-session ownership) and the boundary warning is raised',
        life2res.length === 1
        && life2.items.some((i) => i.kind === 'warning' && i.code === 'session_changed')
        && life2.items.some((i) => i.kind === 'tool' && !i.result),
        JSON.stringify({ results: life2res.map((r) => String(r.output).slice(-100)),
          warnings: life2.items.filter((i) => i.kind === 'warning').map((i) => i.code) }));
      // Admission is released: the new conversation completes a trivial task.
      const life3 = await runTask('B-LIFE3 admission after boundary', [
        finalAnswer('B-LIFE3 ran'),
      ], 'completed', 60000, 'm3c-py-life3');
      check('B-LIFE3 the slot was released: the next legal task runs',
        life3.status === 'completed' && (await wireCalls()) === life2Calls + 1,
        JSON.stringify({ status: life3.status }));
    }

    // ======================= B-TOT: suite totals ==========================
    {
      const total = probe.hitCount();
      const paths = probe.hits.map((h) => h.path);
      check('B-TOT the whole suite produced EXACTLY the one allowed dispatch (B-NET1); every python/plugin/lifecycle scenario contributed ZERO',
        total === 1 && paths[0] === '/target/cors-ok',
        JSON.stringify({ total, paths: [...new Set(paths)] }));
      const fetched = await evaluate(cdp,
        'JSON.parse(JSON.stringify(window.__pyAssetFetches))');
      const namesOk = fetched.every((u) => u.indexOf(PYODIDE_CDN) === 0
        && PY_MANIFEST.some((a) => PYODIDE_CDN + a.name === u));
      check('B-TOTb every bootstrap asset the product page requested is EXACTLY a pinned manifest URL (no path/query variation)',
        fetched.length >= PY_MANIFEST.length && namesOk,
        JSON.stringify({ n: fetched.length, sample: fetched.slice(0, 3), namesOk }));
      const errs = await pageErrors();
      check('B-TOTc the browser reported no unhandled errors or rejections across the whole gate',
        errs.length === 0, JSON.stringify(errs));
    }

    console.log('---');
    console.log('e2e-m3c-python-integration: ' + passed + ' passed, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } catch (error) {
    console.error('M3C PYTHON INTEGRATION E2E FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    const cleanupChrome = await closeChrome(chrome);
    if (cleanupChrome && !cleanupChrome.exited) console.error('m3c python Chrome did not exit after bounded cleanup');
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (preview) {
      const cleanupPreview = await closeManagedProcess(preview);
      if (cleanupPreview && !cleanupPreview.exited) console.error('Vite preview did not exit after bounded cleanup');
    }
    await assetServer.close();
    await probe.close();
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
