// Page-side checks for the settings-panel mobile e2e (owner UI review
// 2026-10-29, items 9 and 11). Injected into the real built app (?e2e=1)
// via CDP Runtime.evaluate by tests/e2e-settings-mobile.cjs, which owns
// the device simulation (390×844, mobile, touch) and the REAL touch
// events. Returns a string report; each line is "PASS name" / "FAIL name".
//
//   m1 — scroll the settings panel's body to the very bottom; the head's
//        × must still sit inside the viewport and be the topmost element
//        at its center point (fixed head / scrolling body, item 9).
//   m3 — the composer "+" and send buttons expose a hit area of at least
//        44×44 CSS px in the mobile breakpoint (item 11).

(async () => {
  const phase = '__E2E_PHASE__';
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + detail : ''));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);

  try {
    if (phase === 'm1') {
      const store = window.__locus.store;
      check('M1.0 settings closed at start', store.settingsOpen === false);
      store.settingsOpen = true;
      check('M1.1 settings panel mounts', await (async () => {
        for (let i = 0; i < 50; i++) {
          if ($('[data-testid="settings-head"]')) return true;
          await sleep(60);
        }
        return false;
      })());
      const body = $('.settings-body');
      check('M1.2 the panel has a scrolling body (fixed shell)', !!body,
        'settings-body missing');
      if (body) {
        body.scrollTop = body.scrollHeight; // scroll the content to the very bottom
        await sleep(200);
      }
      const closeBtn = $('[data-testid="settings-close"]');
      check('M1.3 the head close button exists', !!closeBtn);
      if (closeBtn) {
        const r = closeBtn.getBoundingClientRect();
        const inViewport = r.x >= 0 && r.y >= 0
          && r.x + r.width <= window.innerWidth + 0.5
          && r.y + r.height <= window.innerHeight + 0.5;
        check('M1.4 x is inside the viewport after scrolling to the bottom (y=' + Math.round(r.y) + ')',
          inViewport, JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height, iw: window.innerWidth, ih: window.innerHeight }));
        check('M1.5 x is at least 44px tall in the mobile breakpoint', r.height >= 44 && r.width >= 44,
          JSON.stringify({ w: r.width, h: r.height }));
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        check('M1.6 the tap point at the x center hits the x itself (nothing covers it)',
          !!hit && (hit === closeBtn || closeBtn.contains(hit)),
          hit ? (hit.tagName + '.' + hit.className) : 'null');
        check('M1.7 the body actually scrolled (scrollTop > 0)', !!body && body.scrollTop > 0,
          'scrollTop=' + (body && body.scrollTop));
      }
      store.settingsOpen = false;
      await sleep(100);
    } else if (phase === 'm3') {
      const plus = $('.plus-btn');
      const send = $('.send-btn');
      check('M3.0 composer controls present', !!plus && !!send);
      const area = (el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      };
      const pa = plus ? area(plus) : null;
      const sa = send ? area(send) : null;
      check('M3.1 the "+" hit area is at least 44x44', !!pa && pa.w >= 44 && pa.h >= 44, JSON.stringify(pa));
      check('M3.2 the send button hit area is at least 44x44', !!sa && sa.w >= 44 && sa.h >= 44, JSON.stringify(sa));
      check('M3.3 no horizontal page scroll at 390px',
        document.documentElement.scrollWidth <= window.innerWidth + 1,
        'scrollWidth=' + document.documentElement.scrollWidth + ' innerWidth=' + window.innerWidth);
    } else {
      out.push('FAIL unknown phase ' + phase);
    }
  } catch (e) {
    out.push('FAIL e2e-settings-mobile threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'SETTINGS-MOBILE-FAIL' : (phase === 'm1' ? 'M1-PASS' : 'M3-PASS'));
  return out.join('\n');
})()
