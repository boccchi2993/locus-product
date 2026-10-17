// Capability-install presentation e2e runner (C1-P3). Same shape as
// e2e-ui.cjs: expects the built app served on E2E_APP_URL (the browser-gate
// orchestrator arranges that; standalone runs point it at `vite preview`),
// then drives the real UI through CDP with the model layer faked at the
// documented seams. The .locus fixture is built HERE with the REAL
// packLocus over a memory workspace (skills + one wheel plugin), its body
// carrying an XSS probe; the page-side script (e2e-capability-ui-page.js)
// asserts the probe renders as inert text and the install/uninstall flow
// completes.
//
// Run standalone: npm run build && npx vite preview --port 4173 & then
//   node tests/e2e-capability-ui.cjs
// Run under the orchestrator: node tests/run-browser-gates.cjs e2e-capability-ui.cjs
const fs = require('fs');
const path = require('path');
const {
  closeChrome,
  connectToTarget,
  launchChrome,
  waitForCdp,
  waitForPageTarget,
  waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:4173/?e2e=1';

// The fixture mirrors tests/capability-install.test.mjs's projectWorkspace
// (real package core layout, deterministic pseudo-wheel). Kept local: the
// unit fixture builders live inside the test file's module scope.
async function buildLocusBytes() {
  const LA = await import('../src/locus-archive.js');
  const runtimeApi = await import('../src/product/runtime-api.js');
  const ws = runtimeApi.createMemoryWorkspace({
    maxBytes: LA.LOCUS_LIMITS.maxTotalBytes,
    maxFileBytes: LA.LOCUS_LIMITS.maxFileBytes,
  });
  const wheel = new Uint8Array(512);
  for (let i = 0; i < wheel.length; i++) wheel[i] = (i * 31 + 7) % 251;
  const WHEEL_NAME = 'demo_plugin-1.0.0-py3-none-any.whl';
  const capabilities = {
    schemaVersion: 1,
    capability: {
      id: 'demo-package', version: '1.0.0',
      displayName: 'Demo Package',
      description: 'TEST ONLY capability-install presentation e2e fixture.',
      plugins: ['demo-plugin'],
      skills: ['demo-skill'],
      mcps: [],
    },
  };
  await ws.write('capability.json', JSON.stringify(capabilities, null, 2) + '\n');
  await ws.write('plugins/demo-plugin/plugin.json', JSON.stringify({
    schemaVersion: 1,
    plugin: {
      id: 'demo-plugin', version: '1.0.0',
      displayName: 'E2E Plugin', description: 'TEST ONLY wheel fixture.',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: ['demo_plugin'] },
    },
    artifacts: [{ path: 'artifacts/' + WHEEL_NAME, format: 'python-wheel' }],
  }, null, 2) + '\n');
  await ws.write('plugins/demo-plugin/artifacts/' + WHEEL_NAME, wheel);
  await ws.write('skills/demo-skill/skill.json', JSON.stringify({
    schemaVersion: 1,
    skill: { id: 'demo-skill', version: '1', displayName: 'E2E Skill', description: 'TEST ONLY.' },
    source: 'SKILL.md',
  }, null, 2) + '\n');
  await ws.write('skills/demo-skill/SKILL.md', '# demo-skill guidance\n\nDEFAULT-BODY-demo-skill\n');
  // The body is UNTRUSTED free text: both probes must render as plain text
  // in the confirmation dialog and never execute.
  const body = '# demo-package\n\n'
    + 'Body probes: <img src=x onerror="window.__xss=1"> and <b>bold</b> stay text.\n\n'
    + '## 更改记录\n\n- 1.0.0（2026-10-17）：首个版本\n';
  const packed = await LA.packLocus({
    workspace: ws, root: '', author: 'e2e-suite',
    purpose: 'capability install UI e2e', body,
  });
  if (!packed.ok) throw new Error('e2e fixture pack failed: ' + JSON.stringify(packed.diagnostics));
  return Buffer.from(packed.bytes).toString('base64');
}

async function main() {
  const b64 = await buildLocusBytes();
  const raw = fs.readFileSync(path.join(__dirname, 'e2e-capability-ui-page.js'), 'utf8');
  const pageScript = raw.replace('__E2E_LOCUS_B64__', b64);
  let chrome;
  let cdp;
  try {
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'capability-install UI Chrome',
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'capability-install-app-boot',
      description: 'Capability-install e2e: window.__locus did not boot',
      timeoutMs: 15000,
    });
    const result = await cdp.send('Runtime.evaluate', {
      expression: pageScript,
      awaitPromise: true,
      returnByValue: true,
      timeout: 110000,
    });
    const report = result?.result?.value || ('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
    console.log(report);
    process.exitCode = report.includes('E2E-CAP-UI-FAIL') || report.includes('NO REPORT') ? 1 : 0;
  } catch (error) {
    console.error('E2E-CAP-UI RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('capability-install UI Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('capability-install UI Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
