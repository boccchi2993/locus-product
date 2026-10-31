// Rendering / file-delivery e2e runner (owner task 2026-10-31). Same
// shape as e2e-composer-mentions.cjs: expects the built app served on
// E2E_APP_URL (the browser-gate orchestrator arranges that), drives the
// real UI through CDP in two phases over ONE page session:
//   phase 1 (1440×900) — markdown battery in real assistant messages:
//     fenced code block + Copy, ordered list, GFM table, http link,
//     javascript: literal, sandbox: file cards (existing / missing), the
//     global import confirm dialog over a REAL fixture .locus (Cancel),
//     and the 本次生成的文件 row with sandbox dedupe;
//   phase 2 (390×844) — wide table + long code line + cards must not
//     widen the page.
// The REAL .locus is built runner-side (tests/helpers/locus-fixtures.mjs)
// and injected as base64 — the same pattern e2e-composer-menu.cjs uses.
//
// Set E2E_RENDER_SHOTS=<dir> to save full-page screenshots after each
// phase (local review only — CI never sets it, nothing is written).
//
// Run standalone: npm run build && npx vite preview --port 4173 & then
//   node tests/e2e-render.cjs
// Run under the orchestrator: node tests/run-browser-gates.cjs e2e-render.cjs
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
const SHOTS_DIR = process.env.E2E_RENDER_SHOTS || null;

const sleepShots = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildLocusBytes() {
  const { buildFixturePackage } = await import('./helpers/locus-fixtures.mjs');
  const bytes = await buildFixturePackage({
    id: 'render-cap',
    version: '1.0.0',
    displayName: 'Render Cap',
    description: 'TEST ONLY rendering e2e capability.',
    skills: [{ id: 'render-skill', displayName: 'Render Skill', body: '# render-skill guidance\n' }],
  });
  return Buffer.from(bytes).toString('base64');
}

async function evaluatePhase(cdp, pageScript, phase) {
  // Global substitution (split/join — replace() would only hit the FIRST
  // occurrence) and a hard check that nothing was left unsubstituted: a
  // surviving marker would make Number('...') NaN and silently skip the
  // whole phase (a vacuous "pass").
  const expression = pageScript.split('__E2E_PHASE__').join(String(phase));
  if (expression.includes('__E2E_PHASE__') || expression.includes('__E2E_LOCUS_B64__')) {
    console.error('E2E-RENDER RUNNER FAIL: unsubstituted placeholder after injection');
    return false;
  }
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 110000,
  });
  const report = result?.result?.value || ('NO REPORT: ' + JSON.stringify(result).slice(0, 500));
  console.log(report);
  // A phase that produced ZERO check lines is a failure, never a pass —
  // this is what makes a vacuous run loud instead of green.
  const lines = report.split('\n').filter((l) => l.startsWith('PASS ') || l.startsWith('FAIL '));
  return lines.length > 0
    && !report.includes('E2E-RENDER-FAIL')
    && !report.includes('NO REPORT');
}

async function saveShot(cdp, name) {
  if (!SHOTS_DIR) return;
  try {
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
    });
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    const file = path.join(SHOTS_DIR, name);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('SHOT saved: ' + file);
  } catch (e) {
    console.error('SHOT failed (' + name + '): ' + (e && e.message || e));
  }
}

async function main() {
  const packedB64 = await buildLocusBytes();
  const raw = fs.readFileSync(path.join(__dirname, 'e2e-render-page.js'), 'utf8');
  // base64 must never be read as a replace() special pattern.
  const pageScript = raw.replace(/__E2E_LOCUS_B64__/g, () => packedB64);
  let chrome;
  let cdp;
  let ok = true;
  try {
    chrome = await launchChrome(APP_URL, {
      chromePath: process.env.CHROME,
      label: 'render e2e Chrome',
      extraArgs: ['--window-size=1440,900'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    cdp = await connectToTarget(target);

    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'render-e2e-app-boot',
      description: 'Render e2e: window.__locus did not boot',
      timeoutMs: 15000,
    });

    // Phase 1: the full markdown/file-card battery at 1440×900.
    ok = await evaluatePhase(cdp, pageScript, 1) && ok;
    if (SHOTS_DIR) {
      // The timeline scrolls INSIDE its own container — bring the top of
      // the first assistant message (code block, table, links) into view
      // for the second shot; the first shot keeps the cards + row view.
      await cdp.send('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector('.item-assistant'); if (el) el.scrollIntoView({ block: 'start' }); return true; })()`,
        returnByValue: true,
      });
      await sleepShots(300);
      await saveShot(cdp, 'render-desktop-top.png');
    }
    await saveShot(cdp, 'render-desktop-1440.png');

    // Phase 2: 390×844 — wide table/code/cards must not scroll the page.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    ok = await evaluatePhase(cdp, pageScript, 2) && ok;
    await saveShot(cdp, 'render-mobile-390.png');

    process.exitCode = ok ? 0 : 1;
  } catch (error) {
    console.error('E2E-RENDER RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('render e2e Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('render e2e Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
