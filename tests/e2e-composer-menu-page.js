// Page-side script for the composer Capabilities-menu e2e (owner task
// 2026-10-29). Injected into the real built app (?e2e=1) via CDP
// Runtime.evaluate, the same way as e2e-capability-ui-page.js. The b64
// placeholder carries a REAL buildFixturePackage .locus; the runner seeds
// TWO copies under /mnt/download (menu-old.locus written FIRST, then
// menu-demo.locus) so the third level's "newest first" order is real.
//
// The runner drives TWO phases with the same script:
//   phase 1 (1440×900, desktop cascade):
//     CM-A  structure + hover cascade + keyboard →/←/Esc navigation
//     CM-B  click a listed .locus (settings CLOSED) → the GLOBAL dialog →
//           Cancel → newest /home/locus/capability-imports report says
//           userAction "cancelled"
//     CM-C  same entry, Import → the capability appears in the level-2
//           list with the SAME status pill as the settings panel
//     CM-D  clicking a capability row inserts "@<id> " at the caret and
//           never changes the capability's enabled state
//     CM-E  From path… inline input + Enter → the confirm dialog appears
//   phase 2 (390×844, runner sets the viewport): stepped mode — no
//     cascade panels, "‹ Back" moves between the levels.
//
// Returns a string report; each line is "PASS name" / "FAIL name | detail".

(async () => {
  const phase = '__E2E_PHASE__';
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' | ' + detail : ''));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, timeoutMs) => {
    const deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      let v = false;
      try { v = !!cond(); } catch (e) { /* keep polling */ }
      if (v) return true;
      await sleep(60);
    }
    return false;
  };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const L = window.__locus;
  const PKG_ID = 'menu-cap';
  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };
  const hover = (el) => el.dispatchEvent(new MouseEvent('mouseenter'));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  const escKey = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const activeTestid = () => (document.activeElement && document.activeElement.getAttribute
    ? document.activeElement.getAttribute('data-testid') : null);

  function closeMenu() {
    if (L.store.plusMenuOpen) {
      escKey();
    }
  }

  // Deterministic menu state: close if open (Escape closes ONE level, so
  // repeat; fall back to the backdrop outside click), then open and wait
  // for the mount. A bare plus-btn click would TOGGLE, racing the polls
  // when the menu was already open.
  async function openMenuFresh() {
    for (let i = 0; i < 4 && L.store.plusMenuOpen; i++) {
      escKey();
      await waitFor(() => !L.store.plusMenuOpen && !$('.plus-menu'), 1500);
    }
    if (L.store.plusMenuOpen) {
      const backdrop = $('.plus-backdrop');
      if (backdrop) backdrop.click();
      await waitFor(() => !L.store.plusMenuOpen && !$('.plus-menu'), 1500);
    }
    $('.plus-btn').click();
    check('menu opened', await waitFor(() => L.store.plusMenuOpen && !!$('.plus-menu'), 4000));
  }

  // Open "+" and reach the third level with REAL hover events (the same
  // path a mouse user takes: 150ms open delay, panels appear one by one).
  async function openLevel3() {
    await openMenuFresh();
    hover($('[data-testid="plus-capabilities"]'));
    check('level 2 opened on hover', await waitFor(() => !!$('[data-testid="composer-capabilities-menu"]'), 4000));
    hover($('[data-testid="plus-add-capability"]'));
    check('level 3 opened on hover', await waitFor(() => !!$('[data-testid="composer-add-capability-menu"]'), 4000));
    await sleep(80);
  }

  // Consistent-snapshot reader over the durable reports dir (OPFS
  // visibility lags right after a write — same pattern as
  // e2e-import-reports.cjs).
  window.__cmReports = async function () {
    const dir = '/home/locus/capability-imports';
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        const names = (await L.vfs.list(dir))
          .filter((e) => e.kind === 'file').map((e) => e.name).sort();
        const docs = [];
        let consistent = true;
        for (const name of names) {
          let text = '';
          try { text = await L.vfs.read(dir + '/' + name); } catch (e) { consistent = false; break; }
          if (!text) { consistent = false; break; }
          try { docs.push({ name, doc: JSON.parse(text) }); } catch (e) { consistent = false; break; }
        }
        if (consistent) return docs;
      } catch (e) { /* list raced a fresh entry — retry */ }
      await sleep(80);
    }
    return [];
  };
  async function newestReport() {
    const all = await window.__cmReports();
    let best = null;
    for (const r of all) {
      if (!best || r.doc.at > best.doc.at) best = r;
    }
    return best;
  }

  try {
    if (phase === '1') {
      // ---------- seed /mnt/download: OLD first, then the DEMO package ----------
      const bytes = b64ToBytes('__E2E_LOCUS_B64__');
      await L.vfs.write('/mnt/download/menu-old.locus', bytes);
      await L.vfs.write('/mnt/download/menu-demo.locus', bytes);
      await sleep(80);
      check('CM-S settings panel closed before everything', L.store.settingsOpen === false);
      check('CM-S no dialog before everything', !$('[data-testid="capability-import-dialog"]'));

      // ---------- CM-A: structure, hover cascade, keyboard ----------
      await openMenuFresh();
      const level1Texts = $$('.plus-menu .plus-item, .plus-menu [role="menuitem"]').map((b) => b.textContent);
      check('A2 Upload files + Mount folder present, Open terminal gone',
        level1Texts.some((t) => /Upload files/.test(t))
        && level1Texts.some((t) => /Mount folder/.test(t))
        && !level1Texts.some((t) => /Open terminal/.test(t)), level1Texts.join('/'));
      const capBtn = $('[data-testid="plus-capabilities"]');
      check('A3 Capabilities is an aria-haspopup cascade parent (collapsed)',
        !!capBtn && capBtn.getAttribute('aria-haspopup') === 'true'
        && capBtn.getAttribute('aria-expanded') === 'false');
      hover(capBtn);
      check('A4 hover opens level 2 (Add capability + capability list)',
        await waitFor(() => !!$('[data-testid="composer-capabilities-menu"]')
          && !!$('[data-testid="plus-add-capability"]')
          && !!$('[data-testid="composer-capability-list"]'), 4000),
        'hoverNone=' + window.matchMedia('(hover: none)').matches
        + ' maxTouchPoints=' + navigator.maxTouchPoints
        + ' innerWidth=' + window.innerWidth);
      check('A4b aria-expanded flips to true',
        $('[data-testid="plus-capabilities"]').getAttribute('aria-expanded') === 'true');
      check('A4c empty capability list shows its muted line',
        $('[data-testid="composer-capability-list"]').textContent.includes('No capabilities yet'));
      hover($('[data-testid="plus-add-capability"]'));
      check('A5 hover opens level 3 (From file… / From path…)',
        await waitFor(() => !!$('[data-testid="composer-add-capability-menu"]')
          && !!$('[data-testid="composer-import-from-file"]')
          && !!$('[data-testid="composer-import-from-path"]'), 4000));
      check('A5b both seeded .locus files listed, NEWEST FIRST',
        await waitFor(() => {
          const rows = $$('[data-testid="composer-locus-list"] [data-testid^="composer-locus-file-"]');
          return rows.length === 2
            && rows[0].getAttribute('data-testid') === 'composer-locus-file-menu-demo.locus'
            && rows[1].getAttribute('data-testid') === 'composer-locus-file-menu-old.locus';
        }, 4000), $$('[data-testid^="composer-locus-file-"]').map((r) => r.getAttribute('data-testid')).join(','));
      check('A5c file rows show name and size',
        ($('[data-testid="composer-locus-file-menu-demo.locus"]') || { textContent: '' }).textContent.includes('menu-demo.locus')
        && /B\b/.test($('[data-testid="composer-locus-file-menu-demo.locus"]').textContent));

      // keyboard: → opens levels, ← / Esc go back, Esc at level 1 closes.
      // Fresh menu at level 1 ONLY — the hover above left level 3 open,
      // and → on an already-open parent toggles it closed (Windows
      // behavior), which would fake a broken keyboard here.
      await openMenuFresh();
      $('[data-testid="plus-capabilities"]').focus();
      key(document.activeElement, 'ArrowDown');
      check('A6a ArrowDown moves within level 1 (wraps to Upload files)',
        (document.activeElement.textContent || '').includes('Upload files'),
        'active=' + activeTestid());
      key(document.activeElement, 'ArrowUp');
      check('A6b ArrowUp lands back on Capabilities', activeTestid() === 'plus-capabilities');
      key(document.activeElement, 'ArrowRight');
      check('A6c ArrowRight opens level 2 and focuses Add capability',
        await waitFor(() => !!$('[data-testid="composer-capabilities-menu"]')
          && activeTestid() === 'plus-add-capability', 4000), 'active=' + activeTestid());
      key(document.activeElement, 'ArrowRight');
      check('A6d ArrowRight opens level 3 and focuses From file…',
        await waitFor(() => !!$('[data-testid="composer-add-capability-menu"]')
          && activeTestid() === 'composer-import-from-file', 4000), 'active=' + activeTestid());
      key(document.activeElement, 'ArrowLeft');
      check('A6e ArrowLeft returns to level 2 (level 3 closed, Add capability focused, level 2 kept)',
        await waitFor(() => !$('[data-testid="composer-add-capability-menu"]')
          && !!$('[data-testid="composer-capabilities-menu"]')
          && activeTestid() === 'plus-add-capability', 4000), 'active=' + activeTestid());
      escKey();
      check('A6f Esc returns to level 1 (level 2 closed, focus back on Capabilities)',
        await waitFor(() => !$('[data-testid="composer-capabilities-menu"]')
          && activeTestid() === 'plus-capabilities', 4000), 'active=' + activeTestid());
      escKey();
      check('A6g Esc at level 1 closes the whole menu',
        await waitFor(() => !L.store.plusMenuOpen && !$('.plus-menu'), 4000));

      // ---------- CM-B: file click → GLOBAL dialog (settings closed) → Cancel ----------
      check('B1 settings panel still closed', L.store.settingsOpen === false);
      await openLevel3();
      $('[data-testid="composer-locus-file-menu-demo.locus"]').click();
      check('B2 the GLOBAL confirm dialog appears',
        await waitFor(() => !!$('[data-testid="capability-import-dialog"]'), 8000));
      check('B3 settings panel is CLOSED while the dialog is up (global dialog)',
        L.store.settingsOpen === false && !!$('[data-testid="capability-import-dialog"]'));
      check('B4 dialog names the package',
        $('[data-testid="capability-import-dialog"]').textContent.includes(PKG_ID));
      $('[data-testid="capability-import-cancel"]').click();
      check('B5 dialog closes on Cancel',
        await waitFor(() => !$('[data-testid="capability-import-dialog"]'), 8000));
      const cancelled = await newestReport();
      check('B6 newest import report is the CANCELLATION (userAction cancelled, stage inspect, ok true)',
        !!cancelled && cancelled.doc.userAction === 'cancelled'
        && cancelled.doc.stage === 'inspect' && cancelled.doc.ok === true
        && cancelled.doc.id === PKG_ID
        && cancelled.doc.label === '/mnt/download/menu-demo.locus',
        JSON.stringify(cancelled));

      // ---------- CM-C: Import → capability in the level-2 list, status parity ----------
      await openLevel3();
      $('[data-testid="composer-locus-file-menu-demo.locus"]').click();
      check('C1 dialog appears again',
        await waitFor(() => !!$('[data-testid="capability-import-confirm"]'), 8000));
      $('[data-testid="capability-import-confirm"]').click();
      check('C2 dialog closes after Import',
        await waitFor(() => !$('[data-testid="capability-import-dialog"]'), 10000));
      check('C3 the capability registered in the store',
        await waitFor(() => (L.store.capabilities || []).some((c) => c.id === PKG_ID), 8000),
        JSON.stringify((L.store.capabilities || []).map((c) => c.id)));
      await openMenuFresh();
      hover($('[data-testid="plus-capabilities"]'));
      check('C5 level 2 lists the installed capability',
        await waitFor(() => !!$('[data-testid="composer-capability-' + PKG_ID + '"]'), 4000));
      const menuRow = $('[data-testid="composer-capability-' + PKG_ID + '"]');
      const menuPill = menuRow.querySelector('.capability-state');
      check('C6 row shows @id and the displayName',
        menuRow.textContent.includes('@' + PKG_ID) && menuRow.textContent.includes('Menu Cap'),
        menuRow.textContent.slice(0, 120));
      const menuState = { state: menuPill.getAttribute('data-state'), text: menuPill.textContent.trim() };
      // status parity with the settings panel
      L.store.settingsOpen = true;
      check('C7 settings panel shows the same capability section',
        await waitFor(() => !!$('[data-testid="capabilities-section"]'), 8000));
      const settingsPill = document.querySelector('[data-testid="capability-' + PKG_ID + '"] .capability-state');
      check('C8 status pill identical to the settings panel',
        !!settingsPill && settingsPill.getAttribute('data-state') === menuState.state
        && settingsPill.textContent.trim() === menuState.text,
        'menu=' + JSON.stringify(menuState)
        + ' settings=' + (settingsPill ? settingsPill.getAttribute('data-state') + '/' + settingsPill.textContent.trim() : 'missing'));
      L.store.settingsOpen = false;
      await waitFor(() => !$('[data-testid="capabilities-section"]'), 4000);

      // ---------- CM-D: mention insertion, enabled-state untouched ----------
      const capBefore = (L.store.capabilities || []).find((c) => c.id === PKG_ID);
      check('D1 capability enabled before the row click', !!capBefore && capBefore.enabled === true);
      const ta = $('.composer-input');
      ta.value = 'abc';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.setSelectionRange(3, 3);
      await openMenuFresh();
      hover($('[data-testid="plus-capabilities"]'));
      check('D3 level 2 with the capability row',
        await waitFor(() => !!$('[data-testid="composer-capability-' + PKG_ID + '"]'), 4000));
      $('[data-testid="composer-capability-' + PKG_ID + '"]').click();
      check('D4 menu closed by the row click', await waitFor(() => !L.store.plusMenuOpen, 4000));
      check('D5 input becomes "abc @menu-cap " with the caret after the insertion',
        ta.value === 'abc @' + PKG_ID + ' '
        && document.activeElement === ta
        && ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length,
        JSON.stringify({ value: ta.value, active: document.activeElement && document.activeElement.className, caret: ta.selectionStart }));
      const capAfter = (L.store.capabilities || []).find((c) => c.id === PKG_ID);
      check('D6 enabled state unchanged', !!capAfter && capAfter.enabled === true);
      L.store.settingsOpen = true;
      check('D7 settings panel still lists the capability as ENABLED (Remove button)',
        await waitFor(() => !!$('[data-testid="capability-remove-' + PKG_ID + '"]'), 8000));
      L.store.settingsOpen = false;
      await waitFor(() => !$('[data-testid="capabilities-section"]'), 4000);

      // ---------- CM-E: From path… inline entry + Enter ----------
      await openLevel3();
      $('[data-testid="composer-import-from-path"]').click();
      check('E1 inline path input appears',
        await waitFor(() => !!$('[data-testid="composer-import-path-input"]'), 4000));
      const pathInput = $('[data-testid="composer-import-path-input"]');
      pathInput.value = '/mnt/download/menu-old.locus';
      pathInput.dispatchEvent(new Event('input', { bubbles: true }));
      key(pathInput, 'Enter');
      check('E2 Enter triggers the import: the confirm dialog appears (settings still closed)',
        await waitFor(() => !!$('[data-testid="capability-import-dialog"]')
          && L.store.settingsOpen === false, 8000));
      check('E3 the whole menu closed after the import action', !L.store.plusMenuOpen);
      $('[data-testid="capability-import-cancel"]').click();
      check('E4 dialog closes',
        await waitFor(() => !$('[data-testid="capability-import-dialog"]'), 8000));

      closeMenu();
      check('A9 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
    } else {
      // ---------- phase 2: 390×844 → stepped mode ----------
      check('F0 settings closed, no dialog',
        L.store.settingsOpen === false && !$('[data-testid="capability-import-dialog"]'));
      await openMenuFresh();
      check('F1 menu opens in stepped mode: NO cascade panels',
        document.querySelectorAll('.plus-sub').length === 0,
        'subPanels=' + document.querySelectorAll('.plus-sub').length
        + ' hoverNone=' + window.matchMedia('(hover: none)').matches
        + ' maxTouchPoints=' + navigator.maxTouchPoints);
      check('F2 level 1 shows the three entries, no Back yet',
        !$('.plus-menu').textContent.includes('No capabilities yet')
        && !$('[data-testid="plus-menu-back"]')
        && $('.plus-menu').textContent.includes('Capabilities'));
      $('[data-testid="plus-capabilities"]').click();
      check('F3 click enters level 2: Back appears, capability list with the installed row',
        await waitFor(() => !!$('[data-testid="plus-menu-back"]')
          && !!$('[data-testid="composer-capability-list"]')
          && !!$('[data-testid="composer-capability-' + PKG_ID + '"]'), 4000));
      $('[data-testid="plus-add-capability"]').click();
      check('F4 click enters level 3: import entries + file rows',
        await waitFor(() => !!$('[data-testid="composer-import-from-file"]')
          && !!$('[data-testid="composer-locus-file-menu-demo.locus"]'), 4000));
      $('[data-testid="plus-menu-back"]').click();
      check('F5 Back returns to level 2',
        await waitFor(() => !!$('[data-testid="composer-capability-list"]')
          && !$('[data-testid="composer-import-from-file"]'), 4000));
      $('[data-testid="plus-menu-back"]').click();
      check('F6 Back returns to level 1 (Upload files back, Back row gone)',
        await waitFor(() => !$('[data-testid="plus-menu-back"]')
          && $('.plus-menu').textContent.includes('Upload files'), 4000));
      $('[data-testid="plus-capabilities"]').click();
      check('F7 level 2 again for the Back coverage',
        await waitFor(() => !!$('[data-testid="plus-menu-back"]'), 4000));
      $('[data-testid="plus-menu-back"]').click();
      await waitFor(() => !$('[data-testid="plus-menu-back"]'), 4000);
      escKey();
      check('F8 Esc closes the menu',
        await waitFor(() => !L.store.plusMenuOpen, 4000));
      check('F9 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
    }
  } catch (e) {
    out.push('FAIL e2e-composer-menu threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'E2E-COMPOSER-MENU-FAIL' : 'E2E-COMPOSER-MENU-DONE');
  return out.join('\n');
})()
