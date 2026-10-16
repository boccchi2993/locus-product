// Context-management wiring tests (node, NO DOM) — product side of P-2
// (docs/CONTEXT-MANAGEMENT.md §3.1–§3.4, DECISIONS.md D9; the harness
// H-A/H-B/H-C capabilities arrive through the installed locus-harness):
//   CM1  compatibility: a harness declaration missing exactly the three new
//        OPTIONAL capabilities is NOT rejected; optional.harness.missing
//        lists exactly requestBudget / toolOutputPath / contextWindowBudget
//   CM2  settings default: contextWindow === null
//   CM3  parseContextWindow through the real sessionStorage read path
//        (module-private helper — observed like max-tokens SET2):
//        '128000' → 128000; '' / 0 / -1 / 'abc' / 1.5 → null
//   CM4  persistence round trip: 64000 saved, boot reads the integer back
//   CM5  applySettings drives session.setContextWindow; a session without
//        the method does not throw
//   CM6  a changed model identity calls session.resetTokenCalibration once;
//        an unchanged identity never calls it
//   CM7  locusEnvironmentNotes: no toolOutputs opt-out line unless
//        toolOutputs === true (the whole line, verbatim)
//   CM8  run option: with durable persistence + mounted history + a
//        harness-declared toolOutputPath, session.run receives a
//        toolOutputPath function resolving under the BOUND conversation;
//        a harness declaration missing the capability passes NO option
//   CM9  submit-time image pre-check: with minimumRequestBytes the small
//        image task is ADMITTED (the whole-history estimate would reject
//        it); without the method the same submit is blocked history_budget
//
// Store loading follows tests/max-tokens-settings.test.cjs (fake
// sessionStorage, window.__LOCUS_HOOKS__.sessionFactory, per-scenario
// ?scenario=N re-import); the scripted submit driver follows
// tests/conversation-routing.test.mjs.
//
// Run: node tests/context-management-wiring.test.mjs

import { checkCoreCompatibility, PRODUCT_CORE_REQUIREMENTS } from '../src/product/core-compatibility.js';
import { locusEnvironmentNotes } from '../src/ui/product-prompt.js';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

function fakeSessionStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = { location: { protocol: 'https:' } };
}

// A harness declaration that satisfies every REQUIRED port/capability and
// carries the pre-P-2 optional set — tests toggle the three new semantic
// capabilities by adding/removing them (same construction family as
// tests/core-compatibility.test.mjs HARNESS_OK).
function harnessDeclarationVariant({ requestBudget = true, toolOutputPath = true, contextWindowBudget = true } = {}) {
  const capabilities = {
    nativeToolCalls: true,
    textFallbackStrict: true,
    taskEventIdentity: true,
    providerReplay: true,
    imageInputGate: true,
    capabilityComposition: true,
  };
  if (requestBudget) capabilities.requestBudget = true;
  if (toolOutputPath) capabilities.toolOutputPath = true;
  if (contextWindowBudget) capabilities.contextWindowBudget = true;
  return {
    contractVersion: 1,
    ports: {
      taskLifecycle: { version: 1 },
      toolPort: { version: 1 },
      descriptionPort: { version: 1, optional: true },
      modelClient: { version: 1 },
      approval: { version: 1, kinds: ['permission', 'capability', 'confirmation'] },
      persistencePort: { version: 1 },
    },
    capabilities,
  };
}

let scenarioCounter = 0;
let persistenceInstancePromise = null;
async function loadStore(sessionData, { reset = true } = {}) {
  if (!persistenceInstancePromise) {
    persistenceInstancePromise = import('../src/persistence.js')
      .then((mod) => mod.PersistenceServiceInstance);
  }
  const persistence = await persistenceInstancePromise;
  globalThis.sessionStorage = fakeSessionStorage(sessionData);
  if (reset) await persistence.reset();
  scenarioCounter++;
  return import('../src/ui/store.js?scenario=' + scenarioCounter);
}

// The session factory AND the harness-declaration seam are both hooks: the
// factory is read once at import time, but harnessDeclaration() is re-read
// on every task — so the caller must keep the hooks installed until its
// tasks have run and call restore() afterwards.
async function loadStoreWithHooks(hooks, sessionData) {
  globalThis.window.__LOCUS_HOOKS__ = hooks;
  const store = await loadStore(sessionData);
  return {
    store,
    restore: () => { delete globalThis.window.__LOCUS_HOOKS__; },
  };
}

// Scripted session fake in the conversation-routing family: records every
// run() options object and completes the task with one task_start/task_end
// pair through the runner's per-task emit sink.
class RecordingSession {
  constructor() {
    this.emit = null;
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.runs = [];
    this.setMaxTokensCalls = [];
    this.setContextWindowCalls = [];
    this.resetTokenCalibrationCalls = 0;
  }
  reset() {
    if (this.task) this.task.controller.abort();
    this.history = [];
    this.generation++;
  }
  cancel() { if (this.task) this.task.controller.abort(); }
  setMaxTokens(n) { this.setMaxTokensCalls.push(n); }
  setContextWindow(n) { this.setContextWindowCalls.push(n); }
  resetTokenCalibration() { this.resetTokenCalibrationCalls++; }
  async run(input, opts) {
    this.runs.push(opts || null);
    const o = opts || {};
    const emit = (o.emit && typeof o.emit === 'function') ? o.emit : this.emit;
    const controller = new AbortController();
    this.task = { controller };
    try {
      emit({ type: 'task_start', input });
      emit({ type: 'task_end', reason: 'completed' });
    } finally {
      if (this.task && this.task.controller === controller) this.task = null;
    }
  }
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3, 4]);

function convItems(store, convId) {
  const conv = store.conversations.find((c) => c.id === convId);
  return conv ? conv.items : [];
}

(async () => {
  // ---------- CM1. compatibility: the three optional capabilities ----------
  {
    const r = checkCoreCompatibility({
      runtime: {
        contractVersion: 1,
        executionKinds: ['shell', 'python'],
        bootstrap: { shaPinned: true },
        policyMechanisms: ['mutationPolicy', 'authorization'],
        commands: ['cat', 'echo'],
      },
      harness: harnessDeclarationVariant({
        requestBudget: false, toolOutputPath: false, contextWindowBudget: false,
      }),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    });
    check('CM1 a harness missing the three new capabilities is not rejected', r.compatible === true,
      JSON.stringify(r));
    check('CM1 optional.harness.missing lists exactly the three new capabilities',
      JSON.stringify(r.optional.harness.missing)
        === JSON.stringify(['requestBudget', 'toolOutputPath', 'contextWindowBudget']),
      JSON.stringify(r.optional.harness.missing));
    const full = checkCoreCompatibility({
      runtime: {
        contractVersion: 1,
        executionKinds: ['shell'],
        bootstrap: { shaPinned: true },
        policyMechanisms: ['mutationPolicy', 'authorization'],
        commands: ['cat'],
      },
      harness: harnessDeclarationVariant({}),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    });
    check('CM1 a fully-declaring harness reports no missing optional capabilities',
      full.compatible === true && full.optional.harness.missing.length === 0,
      JSON.stringify(full.optional.harness.missing));
  }

  // ---------- CM2. settings default ----------
  {
    const m = await loadStore(null);
    check('CM2 default contextWindow is null', m.store.settings.contextWindow === null,
      JSON.stringify(m.store.settings.contextWindow));
  }

  // ---------- CM3. parseContextWindow via the sessionStorage read path ----------
  {
    const cases = [
      ['\'128000\' parses to 128000', '128000', 128000],
      ['\'\' stays null', '', null],
      ['0 stays null', 0, null],
      ['-1 stays null', -1, null],
      ['\'abc\' stays null', 'abc', null],
      ['1.5 stays null', 1.5, null],
    ];
    for (const [name, input, expected] of cases) {
      const m = await loadStore({
        'bar.v0.rememberSessionKey.v1': '1',
        'bar.v0.sessionConfig.v1': JSON.stringify({ contextWindow: input }),
      });
      check('CM3 ' + name, m.store.settings.contextWindow === expected,
        JSON.stringify(m.store.settings.contextWindow));
    }
  }

  // ---------- CM4. persistence round trip (string storage, int on boot) ----------
  {
    const persistence = await persistenceInstancePromise;
    await persistence.reset();
    await persistence.saveSettings({
      apiBase: 'https://example.test', model: 'cm4-model', proxy: '',
      dialect: 'anthropic', maxTokens: 8192, contextWindow: 64000,
    });
    const loaded = await persistence.loadSettings();
    check('CM4 saveSettings stored contextWindow as a string', loaded.contextWindow === '64000',
      typeof loaded.contextWindow + ':' + JSON.stringify(loaded.contextWindow));
    const m = await loadStore(null, { reset: false });
    let settled = false;
    for (let i = 0; i < 200 && !settled; i++) { // bootPersistence is fire-and-forget
      settled = m.store.settings.contextWindow === 64000;
      if (!settled) await new Promise((r) => setTimeout(r, 10));
    }
    check('CM4 boot parses the stored string back to the integer',
      m.store.settings.contextWindow === 64000 && Number.isInteger(m.store.settings.contextWindow),
      JSON.stringify(m.store.settings.contextWindow));
  }

  // ---------- CM5. applySettings drives session.setContextWindow ----------
  {
    const { store: m, restore } = await loadStoreWithHooks({
      sessionFactory: () => new RecordingSession(),
    });
    const inst = m.session;
    check('CM5 boot applied the default (null) to the injected session',
      inst.setContextWindowCalls.length >= 1 && inst.setContextWindowCalls[0] === null,
      JSON.stringify(inst.setContextWindowCalls));
    m.store.settings.contextWindow = 64000;
    m.applySettings();
    const last = inst.setContextWindowCalls[inst.setContextWindowCalls.length - 1];
    check('CM5 applySettings calls setContextWindow with the parsed integer',
      last === 64000 && Number.isInteger(last), JSON.stringify(inst.setContextWindowCalls));
    restore();
  }
  {
    let m = null, bootErr = null;
    globalThis.window.__LOCUS_HOOKS__ = { sessionFactory: () => ({ generation: 1 }) };
    try {
      m = await loadStore(null);
    } catch (e) { bootErr = e; } finally { delete globalThis.window.__LOCUS_HOOKS__; }
    check('CM5 boot tolerates a session without setContextWindow', !bootErr && !!m,
      bootErr && String(bootErr));
    if (m) {
      let applyErr = null;
      m.store.settings.contextWindow = 128000;
      try { m.applySettings(); } catch (e) { applyErr = e; }
      check('CM5 applySettings tolerates a session without setContextWindow', !applyErr,
        applyErr && String(applyErr));
      check('CM5 store value still normalized to the parsed integer',
        m.store.settings.contextWindow === 128000, m.store.settings.contextWindow);
    }
  }

  // ---------- CM6. a changed model resets the token calibration ----------
  {
    const { store: m, restore } = await loadStoreWithHooks({
      sessionFactory: () => new RecordingSession(),
    });
    const inst = m.session;
    const before = inst.resetTokenCalibrationCalls;
    check('CM6 boot with unchanged defaults does not reset calibration', before === 0,
      String(before));
    m.store.settings.model = 'cm6-other-model';
    m.applySettings();
    check('CM6 changing the model calls resetTokenCalibration exactly once',
      inst.resetTokenCalibrationCalls === before + 1,
      String(inst.resetTokenCalibrationCalls));
    m.applySettings();
    check('CM6 applying again without a model change does not reset again',
      inst.resetTokenCalibrationCalls === before + 1,
      String(inst.resetTokenCalibrationCalls));
    restore();
  }

  // ---------- CM7. environment notes ----------
  {
    const plain = locusEnvironmentNotes({ workspace: null });
    const off = locusEnvironmentNotes({ workspace: null, toolOutputs: false });
    const on = locusEnvironmentNotes({ workspace: null, toolOutputs: true });
    const marker = '/home/locus/history';
    check('CM7 no toolOutputs line without the option', !plain.includes(marker), '');
    check('CM7 no toolOutputs line with toolOutputs:false', !off.includes(marker), '');
    check('CM7 toolOutputs:false output is byte-identical to the plain output', off === plain, '');
    const line = '- When a long tool output is truncated, the truncation marker may name a file under /home/locus/history that holds the full output (read-only). Read it with head/tail/grep -n; to process it with python, cp it to /tmp first.';
    check('CM7 toolOutputs:true appends the full line verbatim',
      on.includes(line) && on.endsWith(line), JSON.stringify(on.slice(-200)));
    check('CM7 the opt-in output is the plain output plus exactly that line',
      on === plain + '\n' + line, '');
  }

  // ---------- CM8. the run option toolOutputPath ----------
  {
    // Real harness declaration (no hooks harnessCapabilities): the installed
    // locus-harness declares toolOutputPath. Boot mounts the history view in
    // memory mode, so the mounted flag must be observable.
    const { store: m, restore } = await loadStoreWithHooks({
      sessionFactory: () => new RecordingSession(),
    });
    const inst = m.session;
    await m.whenBooted;
    check('CM8 the history view is mounted after boot (memory mode)',
      m.historyToolOutputsActive() === true, String(m.historyToolOutputsActive()));
    const convId = m.store.liveConversationId;
    await m.submit('cm8 run option present under the real declaration');
    check('CM8 the task ran exactly once', inst.runs.length === 1, String(inst.runs.length));
    const opts = inst.runs[0];
    const expected = '/home/locus/history/' + convId + '/tool-outputs/7.txt';
    check('CM8 run received a toolOutputPath function bound to the conversation',
      opts && typeof opts.toolOutputPath === 'function'
        && opts.toolOutputPath({ sequence: 7 }) === expected,
      JSON.stringify(opts && opts.toolOutputPath && opts.toolOutputPath({ sequence: 7 })));
    check('CM8 the path function rejects non-integer sequences (null)',
      opts.toolOutputPath({ sequence: 0 }) === null && opts.toolOutputPath({}) === null,
      JSON.stringify([opts.toolOutputPath({ sequence: 0 }), opts.toolOutputPath({})]));
    restore();
  }
  {
    // A genuinely different-declaring harness generation WITHOUT
    // toolOutputPath (the narrow declaration seam; the SAME production
    // check runs): no run option may be passed. The hooks stay installed
    // for the whole task — the declaration is re-read per task.
    const { store: m, restore } = await loadStoreWithHooks({
      sessionFactory: () => new RecordingSession(),
      harnessCapabilities: () => harnessDeclarationVariant({ toolOutputPath: false }),
    });
    const inst = m.session;
    await m.whenBooted;
    await m.submit('cm8 no run option without the declared capability');
    check('CM8 the degrade task ran exactly once', inst.runs.length === 1, String(inst.runs.length));
    check('CM8 run received NO toolOutputPath option',
      inst.runs[0] && inst.runs[0].toolOutputPath === undefined,
      JSON.stringify(inst.runs[0] && { keys: Object.keys(inst.runs[0]), value: inst.runs[0].toolOutputPath }));
    restore();
  }

  // ---------- CM9. the submit-time image pre-check ----------
  {
    // minimumRequestBytes present: the small image is admitted even though
    // the whole-history estimate (10 MB) exceeds the budget (768 KiB) —
    // the pre-check follows the run-time ladder (DECISIONS.md D9).
    const inst = new RecordingSession();
    inst.minimumRequestBytes = async () => 1000;
    inst.historyRequestBytes = async () => 10000000;
    inst.requestBudgetBytes = () => 786432;
    const { store: m, restore } = await loadStoreWithHooks({ sessionFactory: () => inst });
    await m.whenBooted;
    m.addUploadFiles([new File([PNG_BYTES], 'cm9-small.png', { type: 'image/png' })]);
    const convId = m.store.liveConversationId;
    await m.submit('cm9 small image with a loaded history, minimum achievable fits');
    const errors = convItems(m.store, convId).filter((i) => i.kind === 'error');
    check('CM9 the small image task is admitted (no history_budget error)',
      errors.length === 0 && inst.runs.length === 1
        && m.store.conversations.find((c) => c.id === convId).status === 'completed',
      JSON.stringify({ errors: errors.map((e) => e.code), runs: inst.runs.length }));
    check('CM9 the admitted task carried the image parts',
      inst.runs[0] && Array.isArray(inst.runs[0].userContent)
        && inst.runs[0].userContent.some((p) => p && p.type === 'image'),
      JSON.stringify(inst.runs[0] && inst.runs[0].userContent && inst.runs[0].userContent.map((p) => p.type)));
    // Same session, method gone: the whole-history fallback estimate must
    // block the same submit BEFORE any task starts.
    delete inst.minimumRequestBytes;
    const runsBefore = inst.runs.length;
    await m.submit('cm9 same image, whole-history estimate exceeds the budget');
    const blocked = convItems(m.store, convId).some((i) => i.kind === 'error' && i.code === 'history_budget');
    check('CM9 without minimumRequestBytes the submit is blocked history_budget before any run',
      blocked && inst.runs.length === runsBefore,
      JSON.stringify({ blocked, runs: inst.runs.length }));
    restore();
  }

  console.log('---');
  console.log('context-management-wiring.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
