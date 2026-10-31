// Page-side script for the rendering/file-delivery e2e (owner task
// 2026-10-31). Injected into the real built app (vite preview, ?e2e=1)
// via CDP; the runner substitutes the phase number marker inside
// Number('...') below and the REAL buildFixturePackage .locus as base64.
// NOTE: never mention the phase marker literal in this comment — the
// runner replaces its FIRST occurrence, which would land here.
//
// Phase 1 (desktop): markdown battery in a real assistant message —
//   fenced code block (+Copy), ordered list, GFM table, http link,
//   javascript: literal, sandbox: cards (existing file / missing file),
//   the global import confirm dialog over a REAL package (Cancel), and
//   the 本次生成的文件 row with sandbox dedupe.
// Phase 2 (390×844): wide table + long code line + file cards must not
//   widen the page (no horizontal document scroll).
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
      if (cond()) return true;
      await sleep(60);
    }
    return false;
  };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const L = window.__locus;
  const phase = Number('__E2E_PHASE__');
  const TID = (p) => String(p).split('/').join('-'); // FileCard testid suffix

  const submitTask = async (text) => {
    const ta = $('.composer-input');
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    if (!await waitFor(() => L.store.busy || $('.item-user'), 4000)) throw new Error('submit did not start a task');
    await waitFor(() => !L.store.busy, 15000);
    await sleep(120);
  };
  const lastConv = () => L.store.conversations.find((c) => c.id === L.store.liveConversationId);

  try {
    if (!L || !$('.app-shell')) throw new Error('app did not boot');

    if (phase === 1) {
      // ---------- seed /mnt/download BEFORE the task: the files the
      // message links must exist; the pre-task write journal snapshot at
      // task_start must already contain them (they are NOT task output). ----------
      const pkgBytes = Uint8Array.from(atob('__E2E_LOCUS_B64__'), (c) => c.charCodeAt(0));
      await L.vfs.write('/mnt/download/report.csv', 'col1,col2\n1,2\n');
      await L.vfs.write('/mnt/download/render-fix.locus', pkgBytes);
      await L.actions.refreshArtifacts();
      await sleep(80);

      // ---------- task 1: the markdown battery ----------
      const msg1 = [
        '## Result',
        '',
        'Config used:',
        '```json',
        '{"tool": "bash", "note": "<script>alert(1)</script> **not bold**"}',
        '```',
        '',
        '- plain item',
        '',
        '1. first',
        '2. second',
        '',
        '| Name | Value |',
        '| :--- | ---: |',
        '| alpha | **1** |',
        '',
        'Docs at https://example.com/docs, and [evil](javascript:alert(1)) stays text.',
        '',
        'Your file: [report.csv](sandbox:/mnt/download/report.csv)',
        '',
        'Gone: [ghost.txt](sandbox:/mnt/download/ghost.txt)',
        '',
        'Capability package: [render-fix.locus](sandbox:/mnt/download/render-fix.locus)',
      ].join('\n');
      window.__e2eReplies.push({ content: msg1 });
      await submitTask('render the report');

      const lastItem = $$('.item-assistant').pop();
      check('R01 assistant message rendered', !!lastItem && lastItem.textContent.includes('Config used'),
        lastItem && lastItem.textContent.slice(0, 120));

      // code block + copy + language label + raw content
      const code = lastItem.querySelector('[data-testid="md-code-block"]');
      check('R02 code block rendered with language tag', !!code
        && (code.querySelector('.md-code-lang') || { textContent: '' }).textContent === 'json',
        code && code.textContent.slice(0, 80));
      const codeText = (code.querySelector('code') || { textContent: '' }).textContent;
      check('R03 code block keeps ** and <script> as raw text (no live markup)',
        codeText.includes('**not bold**') && codeText.includes('<script>alert(1)</script>')
        && code.querySelector('code').children.length === 0, JSON.stringify(codeText));
      const copyBtn = code.querySelector('[data-testid^="code-copy-"]');
      check('R04 copy button present', !!copyBtn && /Copy/.test(copyBtn.textContent));
      copyBtn.click();
      await waitFor(() => /Copied|Copy failed/.test(copyBtn.textContent), 3000);
      check('R05 copy click gives feedback', /Copied|Copy failed/.test(copyBtn.textContent),
        copyBtn.textContent);

      // ordered list + table
      check('R06 ordered list rendered', !!lastItem.querySelector('ol')
        && lastItem.querySelectorAll('ol li').length === 2);
      const table = lastItem.querySelector('table');
      check('R07 table rendered with right-aligned column', !!table
        && !!table.querySelector('th[style*="text-align:right"]')
        && table.textContent.includes('alpha') && !!table.querySelector('td strong'),
        table && table.outerHTML.slice(0, 160));

      // links: http anchored, javascript: literal
      const link = lastItem.querySelector('a[href="https://example.com/docs"]');
      check('R08 https link: new tab + noopener + icon + title',
        !!link && link.getAttribute('target') === '_blank'
        && link.getAttribute('rel') === 'noopener noreferrer'
        && link.getAttribute('title') === 'https://example.com/docs'
        && !!link.querySelector('.ext-link-icon'),
        link && link.outerHTML.slice(0, 200));
      check('R09 javascript: href never becomes an anchor',
        !lastItem.querySelector('a[href^="javascript:"]')
        && lastItem.textContent.includes('[evil](javascript:alert(1))'));

      // file cards: existing file vs missing file
      const card = lastItem.querySelector('[data-testid="file-card-' + TID('/mnt/download/report.csv') + '"]');
      check('R10 sandbox card for existing file',
        await waitFor(() => card && card.getAttribute('data-state') === 'ok', 4000)
        && card.textContent.includes('report.csv')
        && /^\d+(\.\d+)? (B|KB|MB)$/.test((card.querySelector('.file-card-size') || { textContent: '' }).textContent.trim()),
        card && card.textContent.slice(0, 120));
      const cardDl = card.querySelector('[data-testid="file-download-' + TID('/mnt/download/report.csv') + '"]');
      check('R11 card Download present and enabled', !!cardDl && !cardDl.disabled);
      const missing = lastItem.querySelector('[data-testid="file-missing-' + TID('/mnt/download/ghost.txt') + '"]');
      check('R12 missing file degrades to grey non-clickable text',
        !!missing && missing.textContent.includes('文件不存在:/mnt/download/ghost.txt')
        && !missing.querySelector('button'),
        missing && missing.textContent.slice(0, 120));
      check('R13 missing file has no card with actions',
        !lastItem.querySelector('[data-testid="file-card-' + TID('/mnt/download/ghost.txt') + '"]'));

      // ---------- import over a REAL .locus: global confirm dialog ----------
      const locusCard = lastItem.querySelector('[data-testid="file-card-' + TID('/mnt/download/render-fix.locus') + '"]');
      check('R14 .locus card shows Import', await waitFor(() => !!locusCard
        && !!locusCard.querySelector('[data-testid="file-import-' + TID('/mnt/download/render-fix.locus') + '"]'), 4000),
      locusCard && locusCard.textContent.slice(0, 120));
      const settingsBefore = L.store.settingsOpen;
      locusCard.querySelector('[data-testid="file-import-' + TID('/mnt/download/render-fix.locus') + '"]').click();
      check('R15 global confirm dialog pops (settings panel untouched)',
        await waitFor(() => !!$('[data-testid="capability-import-dialog"]'), 8000)
        && L.store.settingsOpen === settingsBefore);
      // The confirm step names the PACKAGE (id · version) in its text; the
      // source path lives in the store state that drove the dialog.
      check('R16 dialog names the package and the store labels the path',
        ($('[data-testid="capability-import-dialog"]') || { textContent: '' }).textContent.includes('render-cap · 1.0.0')
        && L.store.capabilityImport && L.store.capabilityImport.label === '/mnt/download/render-fix.locus',
        ($('[data-testid="capability-import-dialog"]') || { textContent: '' }).textContent.slice(0, 160));
      const cancelBtn = $('[data-testid="capability-import-dialog"] [data-testid="capability-import-cancel"]');
      check('R17 dialog offers Cancel', !!cancelBtn);
      cancelBtn.click();
      await sleep(120);
      check('R18 Cancel closes the dialog, nothing installed',
        !$('[data-testid="capability-import-dialog"]')
        && (L.store.capabilities || []).every((c) => c.id !== 'render-cap'));

      // ---------- task 2: writes during the task → 本次生成的文件 row ----------
      window.__e2eReplies.push(
        { content: '```json\n{"tool": "bash", "input": "produce files"}\n```' },
        {
          content: 'Done. Linked here: [out-linked.txt](sandbox:/mnt/download/out-linked.txt)',
        },
      );
      window.__e2eToolExecutor = async () => {
        // In-page writes through the REAL VFS → the download write journal
        // records them as in-task writes.
        await L.vfs.write('/mnt/download/out-linked.txt', 'linked in the message');
        await L.vfs.write('/mnt/download/out-row.txt', 'row only');
        await L.vfs.write('/mnt/download/render-row.locus', pkgBytes);
        return { output: '3 files written', success: true, backend: 'browser-direct', operation: 'shell' };
      };
      await submitTask('produce output files');
      window.__e2eToolExecutor = null;

      check('R19 linked file deduped: card in body, NOT in the row',
        lastConv().items.some((i) => i.kind === 'assistant'
          && i.content.includes('[out-linked.txt](sandbox:/mnt/download/out-linked.txt)'))
        && !!$('.item-assistant [data-testid="file-card-' + TID('/mnt/download/out-linked.txt') + '"]'));
      const rowAppeared = await waitFor(() => {
        const r = $('.item-assistant [data-testid="task-output-files"]');
        return r && r.textContent.includes('本次生成的文件');
      }, 4000);
      const row = $('.item-assistant [data-testid="task-output-files"]');
      check('R20 本次生成的文件 row under the LAST assistant message',
        rowAppeared && row.closest('.item-assistant') === $$('.item-assistant').pop(),
        row && row.textContent.slice(0, 120));
      check('R21 row holds the two unlinked files as cards',
        !!row.querySelector('[data-testid="file-card-' + TID('/mnt/download/out-row.txt') + '"]')
        && !!row.querySelector('[data-testid="file-card-' + TID('/mnt/download/render-row.locus') + '"]')
        && !row.querySelector('[data-testid="file-card-' + TID('/mnt/download/out-linked.txt') + '"]'),
        row && row.textContent.slice(0, 160));
      check('R22 earlier assistant messages carry no row',
        $$('.item-assistant').slice(0, -1).every((el) => !el.querySelector('[data-testid="task-output-files"]')));
      check('R23 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
    }

    if (phase === 2) {
      // ---------- 390×844: wide content must never widen the page ----------
      const wide = [
        'Wide battery:',
        '```text',
        'x'.repeat(600),
        '```',
        '',
        '| Column AAAAAAAAAA | Column BBBBBBBBBB | Column CCCCCCCCCC | Column DDDDDDDDDD |',
        '| :--- | :--- | :--- | :--- |',
        '| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | cccccccccccccccccccccccccccccccc | dddddddddddddddddddddddddddddddd |',
        '',
        'Card: [report.csv](sandbox:/mnt/download/report.csv)',
      ].join('\n');
      window.__e2eReplies.push({ content: wide });
      await submitTask('wide content on mobile');

      const doc = document.documentElement;
      check('R24 390px: no horizontal page scroll from table/code/cards',
        doc.scrollWidth <= window.innerWidth + 1,
        'scrollWidth=' + doc.scrollWidth + ' innerWidth=' + window.innerWidth);
      const wideItem = $$('.item-assistant').pop();
      const mtable = wideItem.querySelector('table');
      const mcode = wideItem.querySelector('[data-testid="md-code-block"] pre');
      check('R25 table and code scroll inside their own boxes',
        !!mtable && !!mcode && mcode.scrollWidth >= mcode.clientWidth
        && doc.scrollWidth <= window.innerWidth + 1,
        'table=' + (mtable && mtable.scrollWidth) + ' code=' + (mcode && mcode.scrollWidth));
      check('R26 cards render on mobile',
        !!wideItem.querySelector('[data-testid="file-card-' + TID('/mnt/download/report.csv') + '"]'));
    }
  } catch (e) {
    out.push('FAIL e2e-render threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'E2E-RENDER-FAIL' : 'E2E-RENDER-DONE');
  return out.join('\n');
})()
