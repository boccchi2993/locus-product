// Page-side script for the composer @-mentions e2e (owner task 2026-10-29).
// Injected into the real built app (?e2e=1) via CDP Runtime.evaluate, the
// same way as e2e-composer-menu-page.js. Capabilities are seeded through
// injectCapabilityCatalogs() (the documented test-only seam):
//   charts        ready     (enabled at seed — the popup's enabled group)
//   web2          disabled  (d: TYPED mention → auto-enable, then send)
//   deepseek-web  disabled  (f: "+"-menu insert → highlight + auto-enable)
//   broken-cap    disabled  (e: enable ends in state error → BLOCKED send)
// The scripted model client records every request body into
// window.__mentionRequests so the gates assert the mention line and the
// capability index inside the REAL system prompt (built by the harness).
//
//   phase 1 (1440×900):
//     MN-A  popup trigger + enabled-first ordering + filter + keyboard
//           insert (Enter NEVER submits while the popup is open)
//     MN-B  mirror highlight appears / disappears on edit
//     MN-C  IME composition: no popup, keys not intercepted; popup opens
//           after compositionend
//     MN-F  the "+"-menu insert path highlights identically
//     MN-E  an error-state mentioned capability BLOCKS the send (draft
//           preserved, error line + Settings… deep link)
//     MN-D  a typed mention of a disabled capability enables it FIRST,
//           then sends; the recorded system prompt carries the mention
//           line + the capability index; the user message is verbatim
//     MN-G  timeline highlight (text interpolation; message content never
//           becomes innerHTML)
//   phase 2 (390×844): popup + insert + highlight on a phone viewport.
//
// Returns a string report; each line is "PASS name" / "FAIL name | detail".

(async () => {
  const phase = '__E2E_PHASE__';
  const out = [];
  const check = (name, cond, detail) =>
    out.push((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' | ' + (detail !== undefined ? detail : '')));
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

  const ta = () => $('.composer-input');
  const menu = () => $('[data-testid="composer-mention-menu"]');
  const menuRows = () => $$('[data-testid="composer-mention-list"] [role="option"]');
  const rowIds = () => menuRows().map((r) => r.getAttribute('data-testid').replace('composer-mention-option-', ''));
  const activeRowId = () => {
    const r = menuRows().find((x) => x.getAttribute('aria-selected') === 'true');
    return r ? r.getAttribute('data-testid').replace('composer-mention-option-', '') : null;
  };
  const capOf = (id) => (L.store.capabilities || []).find((c) => c.id === id) || null;
  const type = (text, caret) => {
    const el = ta();
    el.value = text;
    if (caret === undefined) caret = text.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const key = (k, extra) => ta().dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, extra || {})));
  const mirrorMarks = () => $$('.composer-mirror .mention-mark').map((m) => m.textContent);
  const capSection = () => $('[data-testid="capabilities-section"]');

  const FINAL = (text) => (body, opts) => {
    (window.__mentionRequests = window.__mentionRequests || []).push({
      system: String(body.system || ''),
      messages: JSON.parse(JSON.stringify(body.messages || [])),
      busyAtRequest: L.store.busy,
    });
    return Promise.resolve({
      content: text,
      reasoning: null,
      reasoningType: 'raw',
      toolCalls: null,
      rawMessage: { role: 'assistant', content: text },
      stopReason: 'end_turn',
      usage: null,
      providerMetadata: null,
      truncated: false,
    });
  };
  const lastRequest = () => (window.__mentionRequests || []).slice(-1)[0] || null;

  async function waitTaskDone(label, usersBefore) {
    check('task ' + label + ' started',
      await waitFor(() => L.store.busy === true || $$('.item-user').length > usersBefore, 8000));
    check('task ' + label + ' finished', await waitFor(() => L.store.busy === false, 15000));
    await sleep(80);
  }

  function resetComposer() {
    type('', 0);
    if (L.store.settingsOpen) L.store.settingsOpen = false;
  }

  try {
    if (phase === '1') {
      // ---------- seed the synthetic catalogs (test-only seam) ----------
      L.actions.injectCapabilityCatalogs({
        capabilities: [
          { id: 'charts', version: '1.0.0', displayName: 'Charts', description: 'test charts capability', plugins: [], skills: [], mcps: [] },
          { id: 'web2', version: '1.0.0', displayName: 'Web Two', description: 'test typed-mention capability', plugins: [], skills: [], mcps: [] },
          { id: 'deepseek-web', version: '1.0.0', displayName: 'Deepseek Web', description: 'test menu-mention capability', plugins: [], skills: [], mcps: [] },
          { id: 'broken-cap', version: '1.0.0', displayName: 'Broken Cap', description: 'test error capability', plugins: [], skills: ['broken-skill'], mcps: [] },
        ],
        skills: [
          { id: 'broken-skill', version: '1.0.0', description: 'skill without a source → enable ends in state error' },
        ],
      });
      check('S1 four capabilities seeded', (L.store.capabilities || []).length === 4,
        JSON.stringify((L.store.capabilities || []).map((c) => c.id)));
      await L.actions.enableCapability('charts');
      check('S2 charts enabled at seed, the rest not',
        capOf('charts').enabled === true && capOf('web2').enabled === false
        && capOf('deepseek-web').enabled === false && capOf('broken-cap').enabled === false);
      check('S3 broken-cap references a skill with no source (will error on enable)',
        capOf('broken-cap').skills.length === 1);

      // ---------- MN-A: popup trigger, ordering, filter, keyboard ----------
      ta().focus();
      type('@', 1);
      check('A1 typing @ opens the popup', await waitFor(() => !!menu(), 4000));
      check('A2 rows: enabled first (charts), then unenabled by id',
        JSON.stringify(rowIds()) === JSON.stringify(['charts', 'broken-cap', 'deepseek-web', 'web2']),
        JSON.stringify(rowIds()));
      check('A3 enabled row shows the Ready state pill',
        !!$('[data-testid="composer-mention-option-charts"] .capability-state')
        && $('[data-testid="composer-mention-option-charts"] .capability-state').getAttribute('data-state') === 'ready');
      check('A4 unenabled rows show "will be enabled when sent"',
        menuRows().filter((r) => r.textContent.includes('will be enabled when sent')).length === 3,
        menuRows().map((r) => r.textContent.slice(0, 40)).join(' / '));
      check('A5 displayName rendered as secondary text',
        $('[data-testid="composer-mention-option-web2"]').textContent.includes('Web Two'));
      key('ArrowDown');
      check('A6 ArrowDown moves the selection to the second row',
        await waitFor(() => activeRowId() === 'broken-cap', 4000), activeRowId());
      key('ArrowUp');
      check('A7 ArrowUp moves back (wraps at the top)',
        await waitFor(() => activeRowId() === 'charts', 4000), activeRowId());
      type('@ch', 3);
      check('A8 the query filters to the matching row only',
        await waitFor(() => JSON.stringify(rowIds()) === JSON.stringify(['charts']), 4000),
        JSON.stringify(rowIds()));
      key('ArrowDown');
      check('A9 ArrowDown with one row stays on it', activeRowId() === 'charts');
      const usersBefore = $$('.item-user').length;
      key('Enter');
      await sleep(300); // let any accidental submit surface before asserting it did not
      check('A10 Enter inserts "@charts " with the caret right after it',
        ta().value === '@charts ' && ta().selectionStart === 8 && ta().selectionEnd === 8,
        JSON.stringify({ v: ta().value, caret: ta().selectionStart }));
      check('A11 the popup closed after the insert', !(menu()));
      check('A12 Enter while the popup was open did NOT submit',
        L.store.busy === false && $$('.item-user').length === usersBefore,
        'busy=' + L.store.busy + ' users=' + $$('.item-user').length);

      // ---------- MN-B: mirror highlight ----------
      check('B1 the mirror shows a highlight span for the recognized mention',
        await waitFor(() => JSON.stringify(mirrorMarks()) === JSON.stringify(['@charts']), 4000),
        JSON.stringify(mirrorMarks()));
      check('B2 the textarea text itself stays normal (no transparent-text hack on the input)',
        getComputedStyle(ta()).color !== 'rgba(0, 0, 0, 0)');
      type('@chart', 6);
      check('B3 deleting one character of the id removes the highlight',
        await waitFor(() => $$('.composer-mirror .mention-mark').length === 0, 4000),
        JSON.stringify(mirrorMarks()));
      type('user@example.com and a@charts stay plain', 0);
      check('B4 emails and glued ids never highlight', $$('.composer-mirror .mention-mark').length === 0,
        JSON.stringify(mirrorMarks()));

      // ---------- MN-C: IME composition guard ----------
      type('@', 1);
      check('C1 the popup is open before composition', !!menu());
      ta().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      type('@ch', 3);
      await sleep(200); // any popup flicker would have to appear by now
      check('C2 NO popup while the composition is in progress', !menu());
      const beforeIme = ta().value;
      const usersBeforeIme = $$('.item-user').length;
      key('Enter', { isComposing: true });
      check('C3 an isComposing Enter is not intercepted (no insert, no submit)',
        ta().value === beforeIme && L.store.busy === false
        && $$('.item-user').length === usersBeforeIme,
        JSON.stringify({ v: ta().value }));
      ta().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ch' }));
      check('C4 after compositionend the popup evaluates again',
        await waitFor(() => !!menu(), 4000));
      type('', 0);
      check('C5 clearing the text closes the popup', await waitFor(() => !menu(), 4000));

      // ---------- MN-F: the "+"-menu insert path highlights too ----------
      $('.plus-btn').click();
      check('F1 the + menu opens',
        await waitFor(() => L.store.plusMenuOpen === true, 4000));
      $('[data-testid="plus-capabilities"]').dispatchEvent(new MouseEvent('mouseenter'));
      check('F2 the Capabilities level opens',
        await waitFor(() => !!$('[data-testid="composer-capabilities-menu"]'), 4000));
      $('[data-testid="composer-capability-deepseek-web"]').click();
      check('F3 the menu row inserted "@deepseek-web " at the caret',
        ta().value === '@deepseek-web ', JSON.stringify(ta().value));
      check('F4 the menu-inserted mention is highlighted in the mirror',
        await waitFor(() => JSON.stringify(mirrorMarks()) === JSON.stringify(['@deepseek-web']), 4000),
        JSON.stringify(mirrorMarks()));

      // ---------- MN-F (send): the menu-inserted mention auto-enables ----------
      window.__e2eReplies.push(FINAL('mentions e2e: deepseek-web done.'));
      const usersBeforeF = $$('.item-user').length;
      key('Enter');
      check('F5 the menu-inserted mention enabled its capability',
        await waitFor(() => capOf('deepseek-web') && capOf('deepseek-web').enabled === true, 6000),
        JSON.stringify(capOf('deepseek-web') && { enabled: capOf('deepseek-web').enabled, state: capOf('deepseek-web').state }));
      await waitTaskDone('deepseek-web menu mention', usersBeforeF);
      const reqF = lastRequest();
      check('F6 its system prompt carries the mention line with deepseek-web',
        !!reqF && reqF.system.includes('deepseek-web = Deepseek Web;'),
        reqF && (reqF.system.match(/Capability ids:[^\n]*/) || [''])[0]);
      check('F7 its user message keeps the mention verbatim (submit trims the draft, pre-existing)',
        !!reqF && JSON.stringify(reqF.messages).includes('@deepseek-web'));
      check('F8 the draft was cleared after the clean send', ta().value === '');

      // ---------- MN-E: an enable that ends in state error blocks ----------
      type('@broken-cap run me');
      key('Enter');
      check('E1 the send is blocked: an error line appears under the composer',
        await waitFor(() => !!$('[data-testid="composer-mention-error"]'), 8000));
      check('E2 the error line names the capability and the original error',
        $('[data-testid="composer-mention-error"]').textContent.includes('@broken-cap')
        && $('[data-testid="composer-mention-error"]').textContent.includes('no default source'),
        $('[data-testid="composer-mention-error"]').textContent.slice(0, 160));
      check('E3 the draft is preserved (nothing was sent)',
        ta().value === '@broken-cap run me' && L.store.busy === false,
        JSON.stringify({ v: ta().value, busy: L.store.busy }));
      check('E4 the capability is enabled with state error (settings-consistent)',
        capOf('broken-cap').enabled === true && capOf('broken-cap').state === 'error');
      $('[data-testid="composer-mention-error-settings-broken-cap"]').click();
      check('E5 Settings… deep-links to the capability card',
        await waitFor(() => !!capSection(), 6000));
      L.store.settingsOpen = false;
      await waitFor(() => !capSection(), 4000);

      // ---------- MN-D: typed mention of a disabled capability ----------
      window.__mentionRequests = [];
      window.__e2eReplies.push(FINAL('mentions e2e: web2 done.'));
      type('@web2 draw one bar chart');
      check('D0 the caret at the end after plain words does NOT open the popup', !menu());
      const usersBeforeD = $$('.item-user').length;
      key('Enter');
      check('D1 the mentioned capability became enabled',
        await waitFor(() => capOf('web2') && capOf('web2').enabled === true, 6000),
        JSON.stringify(capOf('web2') && { enabled: capOf('web2').enabled, state: capOf('web2').state }));
      await waitTaskDone('web2 mention', usersBeforeD);
      check('D2 the task ran (a user message was added to the timeline)',
        $$('.item-user').length > usersBeforeD);
      const reqD = lastRequest();
      check('D3 the request reached the scripted model', !!reqD);
      check('D4 the system prompt carries the fixed mention line',
        !!reqD && reqD.system.includes('In a user message, "@<capability id>" means the user explicitly asks to use that capability in this task: read its guidance file(s) listed under Capabilities before starting.'),
        reqD && reqD.system.slice(reqD.system.indexOf('Capabilit') - 200) );
      check('D5 the mention line lists the ready ids (charts + deepseek-web + web2), not the error one',
        !!reqD && reqD.system.includes('Capability ids: charts = Charts; deepseek-web = Deepseek Web; web2 = Web Two;')
        && !reqD.system.includes('broken-cap'),
        reqD && (reqD.system.match(/Capability ids:[^\n]*/) || [''])[0]);
      check('D6 the harness capability index lists the newly enabled capability',
        !!reqD && reqD.system.includes('Web Two'),
        reqD && reqD.system.slice(reqD.system.indexOf('## Capabilities'), reqD.system.indexOf('## Capabilities') + 300));
      const flatD = reqD ? JSON.stringify(reqD.messages) : '';
      check('D7 the user message is the VERBATIM text (mention kept, nothing hidden appended)',
        flatD.includes('@web2 draw one bar chart'),
        flatD.slice(-300));
      check('D8 the enable happened before the request (task env frozen at submit)',
        !!reqD && reqD.busyAtRequest === true && capOf('web2').enabled === true);
      check('D9 no error/notice line after a clean mention send',
        !$('[data-testid="composer-mention-error"]') && !$('[data-testid="composer-mention-notice"]'));

      // ---------- MN-G: timeline highlight, no message-content innerHTML ----------
      check('G1 the sent mention is highlighted in the timeline',
        await waitFor(() => !!$('.item-user .mention-mark[data-mention="deepseek-web"]'), 6000));
      check('G2 the timeline highlight shows the exact mention text',
        $('.item-user .mention-mark[data-mention="deepseek-web"]').textContent === '@deepseek-web');
      window.__e2eReplies.push(FINAL('mentions e2e: xss probe done.'));
      type('@charts <img src=x onerror=window.__mentionXss=1>', 0);
      const usersBeforeG = $$('.item-user').length;
      key('Enter');
      await waitTaskDone('xss probe', usersBeforeG);
      check('G3 the second sent message highlights its mention too',
        !!$('.item-user .mention-mark[data-mention="charts"]'));
      check('G4 message content never becomes innerHTML: no img element in the timeline',
        !$('.timeline img') && !$('.user-bubble img'));
      check('G5 the onerror payload never executed',
        window.__mentionXss === undefined);
      check('G6 the raw message text is present as TEXT',
        $$('.user-bubble').some((b) => b.textContent.includes('<img src=x onerror=window.__mentionXss=1>')),
        JSON.stringify($$('.user-bubble').map((b) => b.textContent.slice(0, 80))));

      resetComposer();
      check('Z1 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
    } else {
      // ---------- phase 2: 390×844 ----------
      check('P1 capabilities survived the phase boundary',
        (L.store.capabilities || []).length === 4,
        JSON.stringify((L.store.capabilities || []).map((c) => c.id)));
      ta().focus();
      type('@', 1);
      check('P2 typing @ opens the popup on the phone viewport',
        await waitFor(() => !!menu(), 4000));
      check('P3 the popup stays inside the viewport',
        (() => {
          const r = menu().getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth + 1 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
        })(),
        JSON.stringify(menu() && menu().getBoundingClientRect()));
      key('ArrowDown');
      check('P4 keyboard selection works', activeRowId() !== null);
      key('Enter');
      check('P5 Enter inserts the mention with the caret after it',
        await waitFor(() => /^@[a-z0-9._-]+ $/.test(ta().value) && ta().selectionStart === ta().value.length, 3000),
        JSON.stringify({ v: ta().value, caret: ta().selectionStart }));
      check('P6 the mirror highlights the inserted mention',
        await waitFor(() => $$('.composer-mirror .mention-mark').length === 1, 4000),
        JSON.stringify(mirrorMarks()));
      type('', 0);
      check('P7 no console errors / unhandled rejections',
        (window.__e2eErrors || []).length === 0, (window.__e2eErrors || []).join(' ; '));
    }
  } catch (e) {
    out.push('FAIL e2e-composer-mentions threw | ' + (e && e.stack || e));
  }
  out.push(out.some((l) => l.startsWith('FAIL')) ? 'E2E-COMPOSER-MENTIONS-FAIL' : 'E2E-COMPOSER-MENTIONS-DONE');
  return out.join('\n');
})()
