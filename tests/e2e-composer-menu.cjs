// Composer Capabilities-menu e2e runner (owner task 2026-10-29). Same
// shape as e2e-capability-ui.cjs: expects the built app served on
// E2E_APP_URL (the browser-gate orchestrator arranges that; standalone
// runs point it at `vite preview`), then drives the real UI through CDP.
// The .locus fixture is built HERE with the repo's REAL fixture builder
// (tests/helpers/locus-fixtures.mjs → packLocus); the page script seeds it
// TWICE under /mnt/download (old first, demo second) so the third level's
// newest-first order is exercised, imports through the menu, checks the
// GLOBAL confirm dialog with the settings panel closed, the import-report
// cancellation, the @mention insertion and the <640px stepped mode.
//
// Run standalone: npm run build && npx vite preview --port 4173 & then
//   node tests/e2e-composer-menu.cjs
// Run under the orchestrator: node tests/run-browser-gates.cjs e2e-composer-menu.cjs
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

async function buildLocusBytes() {
  const { buildFixturePackage } = await import('./helpers/locus-fixtures.mjs');
  const bytes = await buildFixturePackage({
    id: 'menu-cap',
    version: '1.0.0',
    displayName: 'Menu Cap',
    description: 'TEST ONLY composer menu e2e capability.',
    skills: [{ id: 'menu-skill', displayName: 'Menu Skill', body: '# menu-skill guidance\n' }],
  });
  return Buffer.from(bytes).toString('base64');
}

async function evaluatePhase(cdp, pageScript, phase) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: pageScript.replace('__E2E_PHASE__', String(phase)),
    awaitPromise: true,
    returnByValue: true,
    timeout: 110000,
  });
  const report = result?.result?.value || ('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
  console.log(report);
  return !report.includes('E2E-COMPOSER-MENU-FAIL') && !report.includes('NO REPORT');
}

async function main() {
  const packedB64 = await buildLocusBytes();
  const raw = fs.readFileSync(path.join(__dirname, 'e2e-composer-menu-page.js'), 'utf8');
  // base64 must never be read as a replace() special pattern.
  const pageScript = raw.replace(/__E2E_LOCUS_B64__/g, () => packedB64);
  let chrome;
  let cdp;
  let ok = true;
  try {
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'composer-menu Chrome',
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome);
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'composer-menu-app-boot',
      description: 'Composer-menu e2e: window.__locus did not boot',
      timeoutMs: 15000,
    });

    // Phase 1: desktop cascade over every menu feature (1440×900 launch size).
    ok = await evaluatePhase(cdp, pageScript, 1) && ok;

    // Phase 2: narrow viewport → stepped mode. The menu recomputes its
    // mode at every open, so no reload is needed — only the viewport.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    ok = await evaluatePhase(cdp, pageScript, 2) && ok;

    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error('E2E-COMPOSER-MENU RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('composer-menu Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('composer-menu Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
