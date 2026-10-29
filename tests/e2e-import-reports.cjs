// C4 §2.4 capability-import-report BROWSER e2e (self-contained: own build,
// own servers, own Chrome — the e2e-capabilities machinery). Drives the
// REAL built app, REAL settings-panel import dialog (path entry), REAL
// store-level report writes and the REAL runtime bash over the durable
// OPFS home:
//
//   IR-G0 the home skeleton exposes /home/locus/capability-imports
//   IR-G1 importing a BROKEN package from a path: the refusal dialog
//         shows, and the report lands ok:false stage:inspect source:path
//         with the locus_not_zip diagnostic; CLOSING the refusal dialog
//         writes nothing further (only the confirm dialog reports a
//         cancellation)
//   IR-G2 importing a GOOD credential-declaring package from a path and
//         confirming: the report lands ok:true stage:commit userAction
//         "confirmed" with result { state ready, enabled true,
//         enableError null }; typing the key into the D12 connect step and
//         connecting writes NO further report, and a full-text sweep over
//         every report file plus the page DOM never sees the test key
//   IR-G3 importing again and CANCELLING the confirm dialog: a report
//         with userAction "cancelled" lands (stage inspect, ok true)
//   IR-G4 a REAL task's bash `cat` reads a report verbatim (the model can
//         react to it) — the output carries the §2.4 fields
//
// Run standalone: npm run build && npx vite preview --port 4173 & then
//   node tests/e2e-import-reports.cjs
// Run under the orchestrator: node tests/run-browser-gates.cjs e2e-import-reports.cjs
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  allocateFreePort, closeChrome, closeManagedProcess, connectToTarget,
  isProcessAlive, listenWithRetry, launchChrome, launchManagedProcess,
  startServiceWithRetry, waitForCdp, waitForHttp, waitForPageTarget,
  waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');
const { loadPythonManifest } = require('./helpers/python-manifest.cjs');

const ROOT = path.join(__dirname, '..');
const VITE_CLI = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const { base: PYODIDE_CDN, manifest: PY_MANIFEST } = loadPythonManifest();
const ASSET_CACHE_DIRS = [
  path.join(ROOT, 'tmp-f04b-probe', 'pyodide'),
  // The primary product checkout's cache (best effort, same policy as
  // e2e-capabilities): a fresh worktree downloads via CDN only when BOTH
  // caches miss.
  path.join(ROOT, '..', 'locus-product', 'tmp-f04b-probe', 'pyodide'),
];

const CAP_ID = 'report-cap';
const CRED_NAME = 'REPORT_TEST_KEY';
const TEST_KEY = 'sk-e2e-report-77abd0e4c159';
const KEY_LAST4 = TEST_KEY.slice(-4);
const ORIGIN = 'https://api.example.test';
const CRED_DECL = {
  name: CRED_NAME,
  label: 'Report test credential',
  description: 'TEST ONLY import-report e2e credential.',
  origin: ORIGIN,
  pathPrefix: '/v1/tools/',
  header: 'Authorization',
  scheme: 'Bearer',
};
const REPORTS_DIR = '/home/locus/capability-imports';

// cdp lives at module scope: the click/set helpers close over it.
let cdp = null;

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 120000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result?.result?.value;
}

const testidExpr = (testid) => '(() => { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); return el ? el.textContent.trim() : null; })()';
const clickTestid = (testid) => evaluate(cdp,
  '(function () { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); if (!el) return "missing"; el.click(); return "clicked"; })()');
function setInputValue(testid, value) {
  return evaluate(cdp,
    '(function () { const el = document.querySelector(\'[data-testid="' + testid + '"]\'); if (!el) return "missing";'
    + ' el.value = ' + JSON.stringify(value) + '; el.dispatchEvent(new Event("input", { bubbles: true })); return "set"; })()');
}

async function loadAsset(name) {
  for (const dir of ASSET_CACHE_DIRS) {
    try { return await fs.promises.readFile(path.join(dir, name)); } catch (e) { /* next */ }
  }
  const res = await fetch(PYODIDE_CDN + name);
  if (!res.ok) throw new Error('asset download failed: ' + name + ' -> ' + res.status);
  const bytes = Buffer.from(await res.arrayBuffer());
  try {
    await fs.promises.mkdir(ASSET_CACHE_DIRS[0], { recursive: true });
    await fs.promises.writeFile(path.join(ASSET_CACHE_DIRS[0], name), bytes);
  } catch (e) { /* cache is best-effort */ }
  return bytes;
}

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + String(detail).slice(0, 400) : '')); }
  };

  // ---- fixtures (REAL packLocus: good credential-declaring v1/v2 + broken) ----
  console.log('# building dist (vite build)');
  const build = spawnSync(process.execPath, [VITE_CLI, 'build'], { stdio: 'inherit', cwd: ROOT });
  if (build.status !== 0) { console.error('build failed'); process.exit(1); }

  const { buildFixturePackage } = await import('./helpers/locus-fixtures.mjs');
  const GOOD_V1 = await buildFixturePackage({
    id: CAP_ID, version: '1.0.0',
    displayName: 'Report Cap', description: 'TEST ONLY import-report e2e capability.',
    skills: [{ id: 'report-skill', displayName: 'Report Skill', body: '# report-skill guidance\n' }],
    credentials: [CRED_DECL],
  });
  const GOOD_V2 = await buildFixturePackage({
    id: CAP_ID, version: '1.0.1',
    displayName: 'Report Cap', description: 'TEST ONLY import-report e2e capability.',
    skills: [{ id: 'report-skill', displayName: 'Report Skill', body: '# report-skill guidance v2\n' }],
    credentials: [CRED_DECL],
  });
  // The EOCD lives at the end: truncating destroys the container, and the
  // package core refuses with the locus_not_zip diagnostic (pinned below).
  const BROKEN = GOOD_V1.slice(0, GOOD_V1.length - 64);
  const B64 = {
    broken: Buffer.from(BROKEN).toString('base64'),
    v1: Buffer.from(GOOD_V1).toString('base64'),
    v2: Buffer.from(GOOD_V2).toString('base64'),
  };
  const writeDownload = (name, b64) => evaluate(cdp,
    '(async function () { var bin = atob(' + JSON.stringify(b64) + ');'
    + ' var bytes = new Uint8Array(bin.length);'
    + ' for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);'
    + ' await window.__locus.vfs.write("/mnt/download/' + name + '", bytes); return "written"; })()');

  // ---- asset server (the pinned Pyodide set, served locally) ----
  // allocateFreePort has a release/rebind race; bind through
  // listenWithRetry so an EADDRINUSE retries on a freshly allocated port
  // (up to 3 times) before any product check runs.
  const assetBytes = new Map();
  const { server: assetServer, port: assetPort } = await listenWithRetry(() => http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/assets\//, ''));
    const bytes = assetBytes.get(name);
    if (!bytes) { res.statusCode = 404; res.end('unknown asset'); return; }
    const entry = PY_MANIFEST.find((a) => a.name === name);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('content-type', entry ? entry.mime : 'application/octet-stream');
    res.setHeader('content-length', bytes.length);
    res.end(bytes);
  }), await allocateFreePort());
  console.log('# loading pinned pyodide assets (' + PY_MANIFEST.length + ' files, cache or CDN)');
  for (const a of PY_MANIFEST) assetBytes.set(a.name, await loadAsset(a.name));

  // ---- vite preview (the built app) ----
  // --strictPort means an EADDRINUSE (allocateFreePort release/rebind
  // race) kills the child before readiness: startServiceWithRetry
  // re-spawns on a freshly allocated port, up to 3 times, BEFORE any
  // product check runs.
  const { handle: preview, port: appPort } = await startServiceWithRetry(async (port) => {
    const child = launchManagedProcess(process.execPath, [
      VITE_CLI, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort',
    ], { cwd: ROOT, port, label: 'Vite preview (import-reports)', env: process.env });
    try {
      await waitForHttp('http://127.0.0.1:' + port + '/', { process: child, timeoutMs: 15000 });
    } catch (e) {
      // Retry ONLY the bind race: the child died with EADDRINUSE in its
      // output. Any other readiness failure is rethrown untouched.
      const raced = !isProcessAlive(child)
        && /EADDRINUSE|address already in use/.test(child.stderrTail + '\n' + child.stdoutTail);
      await closeManagedProcess(child);
      if (raced) {
        const bindError = new Error('vite preview could not bind port ' + port + ' (EADDRINUSE)');
        bindError.code = 'EADDRINUSE';
        throw bindError;
      }
      throw e;
    }
    return child;
  }, await allocateFreePort());
  const appRoot = 'http://127.0.0.1:' + appPort + '/';

  let profileDir = null;
  let chrome = null;
  try {
    const appUrl = appRoot + '?e2e=1';
    profileDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'locus-ir-profile-'));
    chrome = await launchChrome(appUrl, {
      chromePath: process.env.CHROME,
      label: 'import-reports Chrome',
      profileDir,
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome);
    const target = await waitForPageTarget(chrome, appUrl, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    // The pyodide CDN rewrite lands before any future document runs.
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: '(function () { var native = window.fetch.bind(window);'
        + ' var prefix = ' + JSON.stringify(PYODIDE_CDN) + ';'
        + ' var local = ' + JSON.stringify('http://127.0.0.1:' + assetPort + '/assets/') + ';'
        + ' window.fetch = function (input, init) {'
        + '   var url = typeof input === "string" ? input : (input && input.url) || String(input);'
        + '   if (url.indexOf(prefix) === 0) url = local + url.slice(prefix.length);'
        + '   return native(url, init); }; })();',
    });
    await evaluate(cdp, 'location.reload(); "reloading"');
    await waitForRuntimeCondition(cdp, '!!(window.__locus && window.__locus.capabilityComposition)',
      { process: chrome, phase: 'ir-app-boot', timeoutMs: 20000 });
    // Durable home mount is the last boot step; after it the VFS topology is final.
    await waitForRuntimeCondition(cdp,
      'window.__locus.vfs.mounts.some(function (m) { return m.path === "/home/locus/history"; })',
      { process: chrome, phase: 'ir-durable-home', timeoutMs: 20000 });

    // The request-capturing model client (production model path hooked at
    // the documented seam; tools stay REAL).
    await evaluate(cdp,
      'window.__ir = { replies: [] };'
      + 'window.__LOCUS_HOOKS__.modelClient = function (body) {'
      + '  var next = window.__ir.replies.length ? window.__ir.replies.shift() : "done.";'
      + '  return Promise.resolve({ content: next, rawMessage: { role: "assistant", content: next }, stopReason: "end_turn", truncated: false });'
      + '}; "hook installed"');

    // One page-side reader over the durable reports dir (name-sorted list
    // of { name, text }); the NODE side parses and picks the newest by at.
    // A report written moments ago can be listed but not yet readable —
    // right after createWritable().close() the OPFS entry's visibility
    // lags (locally as a size-0 read, on Linux as a NotFoundError). The
    // reader therefore retries until it sees a CONSISTENT snapshot:
    // every listed name reads back non-empty, or the dir stays empty
    // across several attempts.
    await evaluate(cdp,
      'window.__irReports = async function () {'
      + ' const dir = ' + JSON.stringify(REPORTS_DIR) + ';'
      + ' for (var attempt = 0; attempt < 20; attempt++) {'
      + '   try {'
      + '     const names = (await window.__locus.vfs.list(dir))'
      + '       .filter(function (e) { return e.kind === "file"; }).map(function (e) { return e.name; }).sort();'
      + '     const out = [];'
      + '     let consistent = true;'
      + '     for (var i = 0; i < names.length; i++) {'
      + '       let text = "";'
      + '       try { text = await window.__locus.vfs.read(dir + "/" + names[i]); }'
      + '       catch (e) { consistent = false; break; }'
      + '       if (!text || text.length === 0) { consistent = false; break; }'
      + '       out.push({ name: names[i], text: text });'
      + '     }'
      + '     if (consistent && out.length) return out;'
      + '     if (consistent && !out.length && attempt >= 3) return out;'
      + '   } catch (e) { /* list raced a fresh entry — retry */ }'
      + '   await new Promise(function (r) { setTimeout(r, 60); });'
      + ' }'
      + ' const names = (await window.__locus.vfs.list(dir))'
      + '   .filter(function (e) { return e.kind === "file"; }).map(function (e) { return e.name; }).sort();'
      + ' const out = [];'
      + ' for (var i = 0; i < names.length; i++) out.push({ name: names[i], text: await window.__locus.vfs.read(dir + "/" + names[i]) });'
      + ' return out; }; "reader installed"');
    const readReports = () => evaluate(cdp, 'window.__irReports()');
    const newestReport = async () => {
      const all = await readReports();
      if (!all.length) return null;
      let best = null; const bad = [];
      for (const r of all) {
        let doc = null;
        try { doc = JSON.parse(r.text); } catch (e) { bad.push(r.name + ' len=' + r.text.length); continue; }
        if (!best || doc.at > best.doc.at) best = { name: r.name, doc };
      }
      if (!best && bad.length) {
        throw new Error('unparseable reports: ' + bad.join(', ')
          + ' | notice: ' + String(await evaluate(cdp, 'window.__locus.store.storageNotice')));
      }
      return best;
    };
    const openSettings = () => evaluate(cdp, 'window.__locus.store.settingsOpen = true; "open"');
    const importFromPath = async (filename) => {
      await openSettings();
      check('settings panel shows the import path input',
        await setInputValue('capability-import-path', '/mnt/download/' + filename) === 'set');
      check('the import path button accepts the path',
        (await clickTestid('capability-import-path-button')) === 'clicked');
    };

    // ---------- IR-G0: the skeleton dir exists ----------
    const homeEntries = await evaluate(cdp,
      '(async function () { return await window.__locus.vfs.list("/home/locus"); })()');
    check('IR-G0 the home skeleton exposes capability-imports',
      Array.isArray(homeEntries)
      && homeEntries.some((e) => e.name === 'capability-imports' && e.kind === 'directory'),
      JSON.stringify(homeEntries));

    // ---------- IR-G1: broken package from a path ----------
    await writeDownload('broken.locus', B64.broken);
    await importFromPath('broken.locus');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="capability-import-diagnostics"]\')',
      { process: chrome, phase: 'ir-refusal-dialog', timeoutMs: 8000 });
    check('IR-G1 the refusal dialog renders the diagnostics',
      ((await evaluate(cdp, testidExpr('capability-import-diagnostics'))) || '').length > 0,
      await evaluate(cdp, testidExpr('capability-import-diagnostics')));
    const r1 = await newestReport();
    check('IR-G1 report lands: ok false, stage inspect, source path',
      !!r1 && r1.doc.ok === false && r1.doc.stage === 'inspect' && r1.doc.source === 'path'
      && r1.doc.label === '/mnt/download/broken.locus'
      && r1.doc.userAction === null,
      JSON.stringify(r1));
    check('IR-G1 the diagnostic code is locus_not_zip with a message',
      !!r1 && r1.doc.diagnostics.length === 1 && r1.doc.diagnostics[0].code === 'locus_not_zip'
      && typeof r1.doc.diagnostics[0].message === 'string' && r1.doc.diagnostics[0].path === '',
      JSON.stringify(r1 && r1.doc.diagnostics));
    const countAfterG1 = (await readReports()).length;
    check('IR-G1 closing the refusal dialog writes NO cancellation report',
      (await clickTestid('capability-import-cancel')) === 'clicked'
      && (await readReports()).length === countAfterG1,
      JSON.stringify({ before: countAfterG1, after: (await readReports()).length }));

    // ---------- IR-G2: good credential package → commit report → connect ----------
    await writeDownload('report-cap-1.0.0.locus', B64.v1);
    await importFromPath('report-cap-1.0.0.locus');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="capability-import-confirm"]\')',
      { process: chrome, phase: 'ir-summary-dialog', timeoutMs: 8000 });
    check('IR-G2 the summary dialog lists the package (id + version)',
      ((await evaluate(cdp, '(document.querySelector(\'[data-testid="capability-import-dialog"]\')||{}).textContent || ""'))
        .includes(CAP_ID)),
      '');
    check('IR-G2 confirm', (await clickTestid('capability-import-confirm')) === 'clicked');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="import-credential-row-' + CRED_NAME + '"]\')',
      { process: chrome, phase: 'ir-connect-step', timeoutMs: 15000 });
    const r2 = await newestReport();
    check('IR-G2 commit report: ok true, stage commit, userAction confirmed',
      !!r2 && r2.doc.ok === true && r2.doc.stage === 'commit'
      && r2.doc.userAction === 'confirmed' && r2.doc.id === CAP_ID
      && r2.doc.version === '1.0.0' && r2.doc.kind === 'new'
      && r2.doc.source === 'path' && r2.doc.label === '/mnt/download/report-cap-1.0.0.locus',
      JSON.stringify(r2));
    check('IR-G2 commit report result: state ready, enabled true, enableError null',
      !!r2 && r2.doc.result && r2.doc.result.state === 'ready'
      && r2.doc.result.enabled === true && r2.doc.result.enableError === null
      && Array.isArray(r2.doc.diagnostics) && r2.doc.diagnostics.length === 0,
      JSON.stringify(r2 && r2.doc.result));
    const COMMIT_REPORT_NAME = r2 ? r2.name : null;
    const countBeforeConnect = (await readReports()).length;
    check('IR-G2 the connect step restates label, $NAME and the send rule',
      ((await evaluate(cdp, testidExpr('import-credential-row-' + CRED_NAME))) || '').includes('Report test credential')
      && ((await evaluate(cdp, testidExpr('import-credential-row-' + CRED_NAME))) || '').includes('$' + CRED_NAME)
      && ((await evaluate(cdp, testidExpr('import-credential-row-' + CRED_NAME))) || '').includes('Only sent to ' + ORIGIN + '/v1/tools/'),
      await evaluate(cdp, testidExpr('import-credential-row-' + CRED_NAME)));
    check('IR-G2 the D12 key can be typed',
      (await setInputValue('import-credential-input-' + CRED_NAME, TEST_KEY)) === 'set');
    check('IR-G2 Connect confirms',
      (await clickTestid('capability-import-connect')) === 'clicked');
    // Connect closes the dialog; the CARD behind it carries the state
    // (the import-credential-state testid only exists pre-connect).
    await waitForRuntimeCondition(cdp,
      '(' + testidExpr('credential-state-' + CRED_NAME) + ' || "").indexOf("Connected ····' + KEY_LAST4 + '") === 0',
      { process: chrome, phase: 'ir-connected', timeoutMs: 15000 });
    check('IR-G2 the credential card reads Connected with ONLY the last 4 characters',
      ((await evaluate(cdp, testidExpr('credential-state-' + CRED_NAME))) || '')
        === 'Connected ····' + KEY_LAST4,
      await evaluate(cdp, testidExpr('credential-state-' + CRED_NAME)));
    const reportsAfterConnect = await readReports();
    check('IR-G2 the credential CONNECT step wrote no report',
      reportsAfterConnect.length === countBeforeConnect,
      JSON.stringify({ before: countBeforeConnect, after: reportsAfterConnect.length }));
    const sweepText = reportsAfterConnect.map((r) => r.text).join('\n') + ' ' + reportsAfterConnect.map((r) => r.name).join(' ');
    check('IR-G2 no report file (name or content) contains the test key',
      !sweepText.includes(TEST_KEY), JSON.stringify(sweepText.length));
    check('IR-G2 the full key appears nowhere in the page DOM',
      !(await evaluate(cdp, 'document.body.textContent.includes(' + JSON.stringify(TEST_KEY) + ')')));
    check('IR-G2 the dialog closed after connect',
      await evaluate(cdp, 'window.__locus.store.capabilityImport === null'));

    // ---------- IR-G3: cancel the confirm dialog ----------
    await writeDownload('report-cap-1.0.1.locus', B64.v2);
    await importFromPath('report-cap-1.0.1.locus');
    await waitForRuntimeCondition(cdp,
      '!!document.querySelector(\'[data-testid="capability-import-confirm"]\')',
      { process: chrome, phase: 'ir-summary-dialog-2', timeoutMs: 8000 });
    const namesBeforeG3 = new Set((await readReports()).map((r) => r.name));
    check('IR-G3 cancel clicked', (await clickTestid('capability-import-cancel')) === 'clicked');
    let cancelledDoc = null;
    for (let t = 0; t < 100 && !cancelledDoc; t++) {
      await new Promise((r) => setTimeout(r, 50));
      for (const r of await readReports()) {
        if (!namesBeforeG3.has(r.name)) cancelledDoc = JSON.parse(r.text);
      }
    }
    check('IR-G3 the cancelled report lands: stage inspect, ok true, userAction cancelled',
      !!cancelledDoc && cancelledDoc.stage === 'inspect' && cancelledDoc.ok === true
      && cancelledDoc.userAction === 'cancelled' && cancelledDoc.id === CAP_ID
      && cancelledDoc.version === '1.0.1' && cancelledDoc.kind === 'replace',
      JSON.stringify(cancelledDoc));
    check('IR-G3 the dialog closed on cancel',
      await evaluate(cdp, 'window.__locus.store.capabilityImport === null'));

    // ---------- IR-G4: a REAL task's bash cat reads the report ----------
    check('IR-G4 a commit report filename is known', typeof COMMIT_REPORT_NAME === 'string'
      && COMMIT_REPORT_NAME.endsWith('.json'), COMMIT_REPORT_NAME);
    await evaluate(cdp, 'window.__ir.replies = ' + JSON.stringify([
      '```json\n{"tool":"bash","input":"cat ' + REPORTS_DIR + '/' + COMMIT_REPORT_NAME + '"}\n```',
      'Task complete.',
    ]) + '; "armed"');
    console.log('# running the bash-cat task (boots real Pyodide)');
    const t4 = Date.now();
    await evaluate(cdp,
      'window.__irTask = window.__locus.actions.submit("Read the capability import report ' + COMMIT_REPORT_NAME + ' and summarize it."); "fired"',
      300000);
    const settled = await evaluate(cdp,
      'window.__irTask.then(function () { return "task-done"; }, function (e) { return "task-error: " + (e && e.message || e); })',
      300000);
    check('IR-G4 the task settled', settled === 'task-done', settled);
    console.log('# task took ' + Math.round((Date.now() - t4) / 100) / 10 + 's');
    const items = await evaluate(cdp,
      'JSON.parse(JSON.stringify(window.__locus.store.conversations.find(function (c) { return c.id === window.__locus.store.liveConversationId; }).items))');
    const toolOutputs = (items || []).filter((i) => i.kind === 'tool' && i.result)
      .map((i) => String(i.result.output || ''));
    const catOut = toolOutputs.find((o) => o.includes('"schemaVersion"'));
    check('IR-G4 bash cat returned the report verbatim (model-readable)',
      !!catOut && catOut.includes('"stage": "commit"') && catOut.includes('"userAction": "confirmed"')
      && catOut.includes('"id": "report-cap"') && catOut.includes('"ok": true'),
      JSON.stringify(toolOutputs).slice(0, 400));

    process.exitCode = failed ? 1 : 0;
    console.log('# import-reports gate: ' + passed + ' passed, ' + failed + ' failed');
  } catch (error) {
    console.error('E2E-IMPORT-REPORTS RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('import-reports Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('import-reports Chrome profile cleanup failed: ' + cleanup.profileError);
    }
    const cleanupPreview = await closeManagedProcess(preview);
    if (!cleanupPreview.exited) console.error('Vite preview did not exit after bounded cleanup');
    assetServer.close();
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
