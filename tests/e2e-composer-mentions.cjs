// Composer @-mentions e2e runner (owner task 2026-10-29). Same shape as
// e2e-composer-menu.cjs: expects the built app served on E2E_APP_URL (the
// browser-gate orchestrator arranges that; standalone runs point it at
// `vite preview`), then drives the real UI through CDP. Capabilities are
// seeded through the documented test seam injectCapabilityCatalogs():
//   charts        ready     (enabled at seed — the popup's enabled group)
//   web2          disabled  (gate d: typed mention → enable, then send)
//   deepseek-web  disabled  (gate f: "+"-menu insert → highlight + enable)
//   broken-cap    disabled  (gate e: enable ends in state error → block)
// The scripted ?e2e=1 model client records every request body so the
// gates can assert the mention line and the capability index inside the
// REAL system prompt.
//
// Run standalone: npm run build && npx vite preview --port 4173 & then
//   node tests/e2e-composer-mentions.cjs
// Run under the orchestrator: node tests/run-browser-gates.cjs e2e-composer-mentions.cjs
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

async function evaluatePhase(cdp, pageScript, phase) {
  const result = await cdp.send('Runtime.evaluate', {
    expression: pageScript.replace('__E2E_PHASE__', String(phase)),
    awaitPromise: true,
    returnByValue: true,
    timeout: 110000,
  });
  const report = result?.result?.value || ('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
  console.log(report);
  return !report.includes('E2E-COMPOSER-MENTIONS-FAIL') && !report.includes('NO REPORT');
}

async function main() {
  const raw = fs.readFileSync(path.join(__dirname, 'e2e-composer-mentions-page.js'), 'utf8');
  let chrome;
  let cdp;
  let ok = true;
  try {
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'composer-mentions Chrome',
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'composer-mentions-app-boot',
      description: 'Composer-mentions e2e: window.__locus did not boot',
      timeoutMs: 15000,
    });

    // Phase 1: the full battery at 1440×900.
    ok = await evaluatePhase(cdp, raw, 1) && ok;

    // Phase 2: 390×844 — the popup + insert + highlight on a phone
    // viewport.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    ok = await evaluatePhase(cdp, raw, 2) && ok;

    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error('E2E-COMPOSER-MENTIONS RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('composer-mentions Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('composer-mentions Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
