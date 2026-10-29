// Settings-panel mobile e2e runner (owner UI review 2026-10-29, items
// 9/10/11). Same shape as e2e-composer-menu.cjs: expects the built app
// served on E2E_APP_URL, then drives the REAL UI under a 390×844 device
// simulation (mobile:true, touch emulation ON) where every tap is a REAL
// Input.dispatchTouchEvent — not an element.click().
//
//   M1  scrolled to the bottom of the settings panel, the head's × is
//       still inside the viewport and is the element under the tap point
//       (fixed head / scrolling body shell).
//   M2  opening Settings from the sidebar DRAWER closes the drawer and
//       opens the panel; the FIRST touch on × closes the panel (the old
//       drawer overlay used to swallow that first touch).
//   M3  the composer "+" and send buttons expose a hit area of at least
//       44×44 CSS px in the mobile breakpoint.
//
// Run standalone: npm run build && npx vite preview --port 4173 & then
//   node tests/e2e-settings-mobile.cjs
// Run under the orchestrator: node tests/run-browser-gates.cjs e2e-settings-mobile.cjs
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
const PAGE_SCRIPT = path.join(__dirname, 'e2e-settings-mobile-page.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 30000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 800));
  return result?.result?.value;
}

// A REAL touch: touchStart + touchEnd at the element's viewport center.
async function touchCenter(cdp, x, y) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function main() {
  const pageScript = fs.readFileSync(PAGE_SCRIPT, 'utf8');
  let chrome;
  let cdp;
  let ok = true;
  try {
    chrome = await launchChrome('about:blank', {
      chromePath: process.env.CHROME,
      label: 'settings-mobile Chrome',
      extraArgs: ['--window-size=390,844'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, 'about:blank', { timeoutMs: 15000 });
    cdp = await connectToTarget(target);
    await cdp.send('Page.enable');

    // 390×844 device simulation with touch (isMobile + hasTouch), the same
    // setup the owner used for the 2026-10-29 mobile review.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'settings-mobile-app-boot',
      description: 'Settings-mobile e2e: window.__locus did not boot',
      timeoutMs: 15000,
    });
    const env = await evaluate(cdp,
      '({ touch: navigator.maxTouchPoints > 0, hoverNone: window.matchMedia("(hover: none)").matches, w: window.innerWidth, h: window.innerHeight })');
    console.log('# device simulation: ' + JSON.stringify(env));

    // ---- M1: scroll the panel to the bottom; × stays visible + tappable ----
    const m1 = await evaluate(cdp, pageScript.replace('__E2E_PHASE__', 'm1'), 60000);
    console.log(m1);
    ok = ok && m1.includes('M1-PASS') && !m1.includes('FAIL');

    // ---- M2: drawer → Settings → drawer closed → first × touch closes ----
    // Fresh document so no M1 state leaks in.
    await cdp.send('Page.navigate', { url: APP_URL });
    await waitForPageTarget(chrome, APP_URL, { timeoutMs: 15000 });
    await waitForRuntimeCondition(cdp, '!!(window.__locus && document.querySelector(".app-shell"))', {
      process: chrome,
      phase: 'settings-mobile-reboot',
      timeoutMs: 15000,
    });
    await evaluate(cdp, 'window.__locus.actions.openSidebarDrawer(); "open"');
    await sleep(450); // let the drawer transition settle before touching
    const btn = await evaluate(cdp,
      '(function () { var el = document.querySelector(\'[data-testid="sidebar-settings"]\'); if (!el) return null;'
      + ' var r = el.getBoundingClientRect();'
      + ' return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    if (!btn) throw new Error('sidebar-settings button not found');
    await touchCenter(cdp, btn.x, btn.y);
    await sleep(450); // drawer close transition + panel mount
    const m2a = await evaluate(cdp,
      '({ open: window.__locus.store.settingsOpen === true, drawerClosed: window.__locus.store.sidebarDrawerOpen === false })');
    console.log('M2a tap drawer Settings -> ' + JSON.stringify(m2a)
      + ' ' + (m2a.open && m2a.drawerClosed ? 'PASS' : 'FAIL'));
    ok = ok && m2a.open && m2a.drawerClosed;

    const closeBtn = await evaluate(cdp,
      '(function () { var el = document.querySelector(\'[data-testid="settings-close"]\'); if (!el) return null;'
      + ' var r = el.getBoundingClientRect();'
      + ' return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()');
    if (!closeBtn) throw new Error('settings-close button not found');
    await touchCenter(cdp, closeBtn.x, closeBtn.y);
    await sleep(300);
    const m2b = await evaluate(cdp, 'window.__locus.store.settingsOpen === false');
    console.log('M2b first touch on x closes the panel -> ' + m2b + ' ' + (m2b ? 'PASS' : 'FAIL'));
    ok = ok && m2b;

    // ---- M3: composer "+" and send hit areas >= 44×44 ----
    const m3 = await evaluate(cdp, pageScript.replace('__E2E_PHASE__', 'm3'), 60000);
    console.log(m3);
    ok = ok && m3.includes('M3-PASS') && !m3.includes('FAIL');

    process.exitCode = ok ? 0 : 1;
    console.log('===');
    console.log(ok ? 'settings-mobile e2e passed' : 'settings-mobile e2e FAILED');
  } catch (error) {
    console.error('E2E-SETTINGS-MOBILE RUNNER FAIL: ' + (error && error.stack || error));
    process.exitCode = 1;
  } finally {
    try { cdp?.close(); } catch (e) {}
    if (chrome) {
      const cleanup = await closeChrome(chrome);
      if (!cleanup.exited) console.error('settings-mobile Chrome did not exit after bounded cleanup');
      if (!cleanup.profileRemoved) console.error('settings-mobile Chrome profile cleanup failed: ' + cleanup.profileError);
    }
  }
}

main().catch((error) => { console.error(error && error.stack || error); process.exitCode = 1; });
