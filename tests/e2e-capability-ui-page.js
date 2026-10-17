// Page-side script for the capability-install presentation e2e (C1-P3).
// Injected into the real built app (?e2e=1) via CDP Runtime.evaluate, the
// same way as e2e-ui-page.js. The b64 placeholder below (a single-quoted
// literal that tests/e2e-capability-ui.cjs substitutes) carries the base64
// of a REAL packLocus-produced .locus whose body holds an XSS probe that
// must stay inert text.
//
// Flow: seed /mnt/download/demo.locus through the test hooks → the
// Artifacts rail offers Import → click opens the settings panel with the
// confirmation dialog → the body renders verbatim (no <img> element, no
// window.__xss) → Import installs the package (installed list) → the
// two-step uninstall empties the list again.
//
// Returns a string report; each line is "PASS name" / "FAIL name | detail".

(async () => {
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
  const L = window.__locus;
  const PKG_ID = 'demo-package';

  try {
    // ---------- seed the .locus artifact through the test hooks ----------
    const b64 = '__E2E_LOCUS_B64__';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await L.vfs.write('/mnt/download/demo.locus', bytes);
    await L.actions.refreshArtifacts();
    check('K01 artifact listed', await waitFor(() => L.store.artifacts.some((a) => a.path === 'demo.locus'), 5000),
      JSON.stringify(L.store.artifacts));

    // ---------- the Import offer ----------
    const importBtn = () => $('[data-testid="artifact-import-demo.locus"]');
    check('K02 .locus artifact offers Import', await waitFor(() => !!importBtn(), 5000),
      'artifact-import-demo.locus not found');
    check('K03 settings panel closed before Import', L.store.settingsOpen === false);

    importBtn().click();
    check('K04 Import opens the settings panel', await waitFor(() => L.store.settingsOpen === true, 5000));
    check('K05 confirmation dialog appears', await waitFor(() => !!$('[data-testid="capability-import-dialog"]'), 8000),
      'capability-import-dialog not found');

    // ---------- the summary dialog: untrusted content stays text ----------
    const bodyEl = () => $('[data-testid="capability-import-body"]');
    check('K06 body text block present', await waitFor(() => !!bodyEl(), 5000));
    const bodyText = bodyEl() ? bodyEl().textContent : '';
    check('K07 body shows the XSS probe VERBATIM as text',
      bodyText.includes('<img src=x onerror="window.__xss=1">'),
      JSON.stringify(bodyText.slice(0, 200)));
    check('K08 body shows the bold probe verbatim', bodyText.includes('<b>bold</b>'),
      JSON.stringify(bodyText.slice(0, 200)));
    check('K09 no img element anywhere on the page', document.querySelectorAll('img').length === 0,
      document.querySelectorAll('img').length + ' img elements');
    check('K10 the XSS never fired', typeof window.__xss === 'undefined', String(window.__xss));
    const dlgText = $('[data-testid="capability-import-dialog"]').textContent;
    check('K11 dialog shows id, version, self-declared author and purpose',
      dlgText.includes('demo-package') && dlgText.includes('1.0.0')
      && dlgText.includes('Author (self-declared): e2e-suite')
      && dlgText.includes('Purpose: capability install UI e2e'),
      dlgText.slice(0, 300));
    check('K12 dialog shows the component manifest with counts',
      dlgText.includes('Plugins (1): E2E Plugin') && dlgText.includes('Skills (1): E2E Skill')
      && dlgText.includes('MCP (0):'),
      dlgText.slice(0, 400));
    check('K13 dialog shows the file count and the fixed python warning',
      /Files: 5 ·/.test(dlgText)
      && dlgText.includes("Importing runs this package's code inside Locus's Python environment."),
      dlgText.slice(0, 400));
    check('K14 confirm button reads plain Import (no mismatch acceptance)',
      ($('[data-testid="capability-import-confirm"]') || { textContent: '' }).textContent.trim() === 'Import');
    // The body stays verbatim while collapsed AND after expanding.
    if ($('[data-testid="capability-import-body-toggle"]')) {
      $('[data-testid="capability-import-body-toggle"]').click();
      await sleep(60);
    }
    check('K15 body still verbatim after expanding the details',
      (bodyEl() ? bodyEl().textContent : '').includes('<img src=x onerror="window.__xss=1">'));

    // ---------- confirm: install ----------
    $('[data-testid="capability-import-confirm"]').click();
    const installedRow = () => $('[data-testid="capability-package-' + PKG_ID + '"]');
    check('K16 installed list shows the package', await waitFor(() => !!installedRow(), 8000),
      'capability-package-demo-package not found');
    check('K17 dialog closed after a successful confirm',
      await waitFor(() => !$('[data-testid="capability-import-dialog"]'), 5000));
    check('K18 store projection carries the installed package',
      await waitFor(() => Array.isArray(L.store.capabilityPackages.packages)
        && L.store.capabilityPackages.packages.some((p) => p.id === PKG_ID && p.loaded === true), 5000),
      JSON.stringify(L.store.capabilityPackages.packages.map((p) => p.id)));
    const rowText = installedRow() ? installedRow().textContent : '';
    check('K19 installed row shows id, version, author, purpose',
      rowText.includes('demo-package') && rowText.includes('1.0.0')
      && rowText.includes('Author (self-declared): e2e-suite')
      && rowText.includes('Purpose: capability install UI e2e'),
      rowText.slice(0, 300));

    // ---------- two-step uninstall ----------
    const un = () => $('[data-testid="capability-package-uninstall-' + PKG_ID + '"]');
    const unConfirm = () => $('[data-testid="capability-package-uninstall-confirm-' + PKG_ID + '"]');
    check('K20 uninstall starts armed-off', !!un());
    un().click();
    check('K21 second step appears', await waitFor(() => !!unConfirm(), 5000));
    check('K22 the kept-files explanation is stated',
      (installedRow() ? installedRow().textContent : '')
        .includes('guidance files under /home/locus/.skills/' + PKG_ID + '/ are kept'),
      installedRow() && installedRow().textContent.slice(0, 300));
    unConfirm().click();
    check('K23 installed list is empty after uninstall',
      await waitFor(() => L.store.capabilityPackages.packages.length === 0
        && !installedRow(), 8000),
      JSON.stringify(L.store.capabilityPackages.packages.map((p) => p.id)));

    // ---------- hygiene ----------
    check('K24 no console errors / unhandled rejections',
      (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
    check('K25 the XSS still never fired at the end', typeof window.__xss === 'undefined');
    L.store.settingsOpen = false;
  } catch (e) {
    out.push('FAIL e2e-capability-ui threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'E2E-CAP-UI-FAIL' : 'E2E-CAP-UI-DONE');
  return out.join('\n');
})()
