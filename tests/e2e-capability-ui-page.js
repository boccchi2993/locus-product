// Page-side script for the capability-install presentation e2e (C1-P3,
// merged-layout revision). Injected into the real built app (?e2e=1) via
// CDP Runtime.evaluate, the same way as e2e-ui-page.js. The b64
// placeholders below (single-quoted literals that tests/e2e-capability-ui.cjs
// substitutes) carry the base64 of a REAL packLocus-produced .locus whose
// body holds an XSS probe that must stay inert text, and of a FORGED copy
// of the same archive (one skill file's bytes changed, CI5-style) used to
// construct an installed-but-not-loaded package.
//
// The runner drives THREE phases with the same script:
//   phase 1 — import via the artifact rail → the confirmation dialog (the
//             untrusted body stays text) → Import installs the package,
//             which is now shown ONCE: inside its Capability entry (merged
//             package block), with the standalone list empty → the
//             two-step uninstall empties it again. Also asserts the import
//             path input shares the settings-panel input background.
//   phase 2 — re-imports through the import PATH input (the styled box),
//             then overwrites the stored package bytes with the forged
//             archive through the persistence seam (CI5's tamper step).
//   phase 3 — after the runner reloads the page: boot verification refuses
//             the tampered package, which now appears in the standalone
//             installed list with "Not loaded" + reason, and the two-step
//             uninstall works from there.
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
  const L = window.__locus;
  const PKG_ID = 'demo-package';

  const b64ToBytes = (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // Seed the .locus artifact and drive the settings-panel import dialog to
  // a completed install (phases 1 and 2 share the tail; phase 2 enters
  // through the path input instead of the artifact rail).
  async function confirmImportDialog() {
    check('dialog appears', await waitFor(() => !!$('[data-testid="capability-import-dialog"]'), 8000),
      'capability-import-dialog not found');
    if (!$('[data-testid="capability-import-confirm"]')) return false;
    $('[data-testid="capability-import-confirm"]').click();
    return waitFor(() => !$('[data-testid="capability-import-dialog"]'), 8000);
  }

  try {
    if (phase === '1') {
      // ---------- seed the .locus artifact through the test hooks ----------
      const bytes = b64ToBytes('__E2E_LOCUS_B64__');
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

      // ---------- confirm: install → merged Capability display ----------
      $('[data-testid="capability-import-confirm"]').click();
      const installedRow = () => $('[data-testid="capability-package-' + PKG_ID + '"]');
      check('K16 package card appears after install', await waitFor(() => !!installedRow(), 8000),
        'capability-package-demo-package not found');
      check('K16a the package appears EXACTLY ONCE (merged display, no separate duplicate)',
        document.querySelectorAll('[data-testid="capability-package-' + PKG_ID + '"]').length === 1,
        'count=' + document.querySelectorAll('[data-testid="capability-package-' + PKG_ID + '"]').length);
      const capItem = () => $('[data-testid="capability-' + PKG_ID + '"]');
      check('K16b the package card lives INSIDE its Capability entry',
        !!installedRow() && !!installedRow().closest('[data-testid="capability-' + PKG_ID + '"]'),
        'capability-demo-package containment');
      check('K16c the standalone not-loaded list has no entry for the package',
        !$('[data-testid="capability-package-reason-' + PKG_ID + '"]')
        && (installedRow() ? !installedRow().textContent.includes('Not loaded') : false),
        'no reason line / no Not loaded label');
      check('K17 dialog closed after a successful confirm',
        await waitFor(() => !$('[data-testid="capability-import-dialog"]'), 5000));
      check('K18 store projection carries the installed package',
        await waitFor(() => Array.isArray(L.store.capabilityPackages.packages)
          && L.store.capabilityPackages.packages.some((p) => p.id === PKG_ID && p.loaded === true), 5000),
        JSON.stringify(L.store.capabilityPackages.packages.map((p) => p.id)));
      // 2026-10-29 owner UI decision: the merged package block became ONE
      // capability card whose first line shows the DISPLAY NAME (the raw
      // package id is no longer rendered for a loaded package), so K19
      // reads the card text instead of the package wrapper.
      const capCardText = capItem() ? capItem().textContent : '';
      check('K19 merged card shows display name, version, author, purpose',
        capCardText.includes('Demo Package') && capCardText.includes('1.0.0')
        && capCardText.includes('Author (self-declared): e2e-suite')
        && capCardText.includes('Purpose: capability install UI e2e'),
        capCardText.slice(0, 300));
      check('K19a the Capability entry offers the package Uninstall button',
        !!$('[data-testid="capability-package-uninstall-' + PKG_ID + '"]'),
        'capability-package-uninstall-demo-package not found');
      const pathInput = $('[data-testid="capability-import-path"]');
      const apiInput = $('#set-api-base');
      check('K19b import path input shares the settings-panel input background',
        !!pathInput && !!apiInput
        && getComputedStyle(pathInput).backgroundColor === getComputedStyle(apiInput).backgroundColor,
        'path=' + (pathInput ? getComputedStyle(pathInput).backgroundColor : 'missing')
        + ' api=' + (apiInput ? getComputedStyle(apiInput).backgroundColor : 'missing'));

      // ---------- two-step uninstall (from the merged block) ----------
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
      check('K23 package card is gone after uninstall',
        await waitFor(() => L.store.capabilityPackages.packages.length === 0
          && !installedRow(), 8000),
        JSON.stringify(L.store.capabilityPackages.packages.map((p) => p.id)));

      check('K24 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
      check('K25 the XSS still never fired at the end', typeof window.__xss === 'undefined');
    } else if (phase === '2') {
      // ---------- re-import through the import PATH input ----------
      const bytes = b64ToBytes('__E2E_LOCUS_B64__');
      await L.vfs.write('/mnt/download/demo.locus', bytes);
      await L.actions.refreshArtifacts();
      check('P201 settings panel is open from phase 1', L.store.settingsOpen === true);
      const pathInput = () => $('[data-testid="capability-import-path"]');
      check('P202 import path input present', !!pathInput());
      pathInput().value = '/mnt/download/demo.locus';
      pathInput().dispatchEvent(new Event('input', { bubbles: true }));
      $('[data-testid="capability-import-path-button"]').click();
      const ok = await confirmImportDialog();
      check('P203 path import confirm completed', ok, 'dialog did not close');
      const installedRow = () => $('[data-testid="capability-package-' + PKG_ID + '"]');
      check('P204 package installed again (merged card present)',
        await waitFor(() => !!installedRow()
          && L.store.capabilityPackages.packages.some((p) => p.id === PKG_ID && p.loaded === true), 8000),
        JSON.stringify(L.store.capabilityPackages.packages.map((p) => p.id)));

      // ---------- CI5's tamper step: overwrite the stored bytes ----------
      const record = L.store.capabilityPackages.packages.find((p) => p.id === PKG_ID);
      check('P205 store record carries a digest', !!record && !!record.digest);
      const forged = b64ToBytes('__E2E_FORGED_B64__');
      await L.persistence().writeCapabilityPackageBytes(PKG_ID, record.digest, forged);
      check('P206 forged bytes written through the persistence seam', true);
      // Leave the panel open for phase 3's reload.
    } else {
      // ---------- phase 3: after reload, the tampered package is not loaded ----------
      // The reload closed the panel; reopen it the same way
      // e2e-capabilities.cjs does so the Capabilities section renders.
      L.store.settingsOpen = true;
      const sectionFound = await waitFor(() => !!$('[data-testid="capabilities-section"]'), 8000);
      check('P300 settings panel reopened with the Capabilities section', sectionFound,
        sectionFound ? undefined : 'capabilities-section not found');
      const installedRow = () => $('[data-testid="capability-package-' + PKG_ID + '"]');
      check('P301 package card present after reload', await waitFor(() => !!installedRow(), 10000),
        'capability-package-demo-package not found');
      check('P302 the capability entry itself is GONE (package not registered)',
        !$('[data-testid="capability-' + PKG_ID + '"]'),
        'capability-demo-package should not exist after a refused load');
      check('P303 the card is in the standalone list (not inside a capability entry)',
        !!installedRow() && !installedRow().closest('[data-testid="capability-' + PKG_ID + '"]'),
        'unexpected containment');
      check('P304 exactly one package card',
        document.querySelectorAll('[data-testid="capability-package-' + PKG_ID + '"]').length === 1);
      check('P305 the card shows Not loaded',
        installedRow() ? installedRow().textContent.includes('Not loaded') : false,
        installedRow() && installedRow().textContent.slice(0, 200));
      const reason = () => $('[data-testid="capability-package-reason-' + PKG_ID + '"]');
      check('P306 the card shows the reason with the notice status and message',
        await waitFor(() => !!reason()
          && /mismatch/.test(reason().textContent)
          && reason().textContent.includes('content does not match the recorded manifest'), 5000),
        reason() && reason().textContent.slice(0, 200));
      check('P307 the boot notice for the package is still offered',
        !!$('[data-testid="capability-notice-' + PKG_ID + '"]'),
        'capability-notice-demo-package not found');
      const un = () => $('[data-testid="capability-package-uninstall-' + PKG_ID + '"]');
      const unConfirm = () => $('[data-testid="capability-package-uninstall-confirm-' + PKG_ID + '"]');
      check('P308 uninstall starts armed-off', !!un());
      un().click();
      check('P309 second step appears', await waitFor(() => !!unConfirm(), 5000));
      check('P310 the kept-files explanation is stated',
        (installedRow() ? installedRow().textContent : '')
          .includes('guidance files under /home/locus/.skills/' + PKG_ID + '/ are kept'),
        installedRow() && installedRow().textContent.slice(0, 300));
      unConfirm().click();
      check('P311 package card is gone after uninstall',
        await waitFor(() => L.store.capabilityPackages.packages.length === 0
          && !installedRow(), 8000),
        JSON.stringify(L.store.capabilityPackages.packages.map((p) => p.id)));
      check('P312 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
      check('P313 the XSS never fired', typeof window.__xss === 'undefined');
      L.store.settingsOpen = false;
    }
  } catch (e) {
    out.push('FAIL e2e-capability-ui threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'E2E-CAP-UI-FAIL' : 'E2E-CAP-UI-DONE');
  return out.join('\n');
})()
