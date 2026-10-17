// Token-calibration persistence tests (node, NO DOM) — product side of the
// bytes-per-token calibration snapshot (docs/CONTEXT-MANAGEMENT.md §3.2,
// DECISIONS.md D5/D9; the harness tokenCalibrationSnapshot capability and
// the session.tokenCalibration()/restoreTokenCalibration() methods arrive
// through the installed locus-harness):
//   TC1  after one task, the calibration record is saved tagged with the
//        CURRENT model identity (apiBase + model + dialect) and the exact
//        samples the session reported
//   TC2  empty samples → nothing is written
//   TC3  restart (same module reload family, reset:false) with the SAME
//        model identity → restoreTokenCalibration called once with the
//        saved samples
//   TC4  the model identity changed before the restart → no restore call
//   TC5  saved samples that the harness rejects → boot continues, the
//        failure is reported through the persistence-issue path
//   TC6  a harness declaration WITHOUT tokenCalibrationSnapshot → neither
//        save nor restore happens
//   TC7  persistence.reset() clears the calibration record
//
// Store loading follows tests/max-tokens-settings.test.cjs and
// tests/context-management-wiring.test.mjs (fake sessionStorage,
// window.__LOCUS_HOOKS__.sessionFactory, per-scenario ?scenario=N
// re-import, reset:false to simulate a restart); the scripted submit
// driver follows tests/conversation-routing.test.mjs.
//
// Run: node tests/token-calibration-persistence.test.mjs

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

// The default identity after a fresh boot (store.js DEFAULTS): the
// calibration is tagged and compared against exactly this key.
const DEFAULT_MODEL_KEY = ['https://api.deepseek.com/anthropic', 'deepseek-flash', 'auto'].join('\n');

const CALIBRATED_SAMPLES = [2.5, 3.125];

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

// The session factory is a hook read once per store module evaluation, the
// harness declaration is re-read per task and on boot — harnessCapabilities
// variants must keep the hooks installed until their task has run.
async function loadStoreWithHooks(hooks, sessionData, { reset = true } = {}) {
  globalThis.window.__LOCUS_HOOKS__ = hooks;
  const store = await loadStore(sessionData, { reset });
  return {
    store,
    restore: () => { delete globalThis.window.__LOCUS_HOOKS__; },
  };
}

// A narrow harness declaration in the same construction family as
// tests/context-management-wiring.test.mjs — only the token-calibration
// toggle is exercised here; the installed harness declares everything true.
function harnessDeclarationVariant({ tokenCalibrationSnapshot = true } = {}) {
  const capabilities = {
    nativeToolCalls: true,
    textFallbackStrict: true,
    taskEventIdentity: true,
    providerReplay: true,
    imageInputGate: true,
    capabilityComposition: true,
    requestBudget: true,
    toolOutputPath: true,
    contextWindowBudget: true,
    capabilityPackages: true,
  };
  if (tokenCalibrationSnapshot) capabilities.tokenCalibrationSnapshot = true;
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

// Scripted session fake in the conversation-routing family (one
// task_start/task_end pair through the runner's per-task emit sink),
// extended with the two calibration snapshot methods and call records.
class CalibrationSession {
  constructor({ samples = CALIBRATED_SAMPLES, restoreThrows = false } = {}) {
    this.emit = null;
    this.history = [];
    this.generation = 0;
    this.task = null;
    this.runs = [];
    this.tokenCalibrationCalls = 0;
    this.restoredWith = [];
    this.calibrationSamples = samples;
    this.restoreThrows = restoreThrows;
  }
  reset() {
    if (this.task) this.task.controller.abort();
    this.history = [];
    this.generation++;
  }
  cancel() { if (this.task) this.task.controller.abort(); }
  tokenCalibration() {
    this.tokenCalibrationCalls++;
    return this.calibrationSamples.slice();
  }
  restoreTokenCalibration(samples) {
    if (this.restoreThrows) throw new Error('invalid token calibration samples');
    this.restoredWith.push(samples);
  }
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

async function delay(ms) { await new Promise((r) => setTimeout(r, ms)); }

// Poll for a state change (or a stable absence); bootPersistence and the
// fire-and-forget save are asynchronous relative to submit().
async function pollUntil(fn, { wantChange = true, tries = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (wantChange && v !== undefined && v !== null) return v;
    if (!wantChange && i === tries - 1) return v;
    await delay(10);
  }
  return await fn();
}

(async () => {
  const persistence = () => persistenceInstancePromise;

  // ---------- TC1. one task saves the calibration tagged with the identity ----------
  {
    const session = new CalibrationSession();
    const { store: m, restore } = await loadStoreWithHooks({ sessionFactory: () => session });
    await m.whenBooted;
    await m.submit('tc1 a completed task leaves its calibration behind');
    const saved = await pollUntil(() => persistence().then((p) => p.loadTokenCalibration()));
    check('TC1 the task ran exactly once', session.runs.length === 1, String(session.runs.length));
    check('TC1 the calibration record carries the current model identity and the reported samples',
      !!saved && saved.modelKey === DEFAULT_MODEL_KEY
        && JSON.stringify(saved.samples) === JSON.stringify(CALIBRATED_SAMPLES),
      JSON.stringify(saved));
    restore();
  }

  // ---------- TC2. empty samples → nothing is written ----------
  {
    const session = new CalibrationSession({ samples: [] });
    const { store: m, restore } = await loadStoreWithHooks({ sessionFactory: () => session });
    await m.whenBooted;
    await m.submit('tc2 no measured samples, nothing to persist');
    await delay(150); // the save is fire-and-forget; give it every chance to land
    const saved = await persistence().then((p) => p.loadTokenCalibration());
    check('TC2 empty samples wrote no calibration record',
      saved == null && session.tokenCalibrationCalls >= 1,
      JSON.stringify(saved) + ' calls=' + session.tokenCalibrationCalls);
    restore();
  }

  // ---------- TC3. restart with the SAME identity restores the saved samples ----------
  {
    // Save phase (fresh store), then restart the SAME durable state.
    const first = new CalibrationSession();
    {
      const { store: m, restore } = await loadStoreWithHooks({ sessionFactory: () => first });
      await m.whenBooted;
      await m.submit('tc3 first page load measures the calibration');
      await pollUntil(() => persistence().then((p) => p.loadTokenCalibration()));
      restore();
    }
    const second = new CalibrationSession();
    const { store: m, restore } = await loadStoreWithHooks(
      { sessionFactory: () => second }, null, { reset: false },
    );
    await m.whenBooted;
    check('TC3 the restart restored the calibration exactly once',
      second.restoredWith.length === 1
        && JSON.stringify(second.restoredWith[0]) === JSON.stringify(CALIBRATED_SAMPLES),
      JSON.stringify(second.restoredWith));
    restore();
  }

  // ---------- TC4. a changed model identity before the restart → no restore ----------
  {
    // Save under the default identity, then switch the model and persist.
    const first = new CalibrationSession();
    {
      const { store: m, restore } = await loadStoreWithHooks({ sessionFactory: () => first });
      await m.whenBooted;
      await m.submit('tc4 first page load, default identity');
      await pollUntil(() => persistence().then((p) => p.loadTokenCalibration()));
      m.store.settings.model = 'tc4-other-model';
      await m.persistSettingsIfNeeded();
      restore();
    }
    const second = new CalibrationSession();
    const { store: m, restore } = await loadStoreWithHooks(
      { sessionFactory: () => second }, null, { reset: false },
    );
    await m.whenBooted;
    check('TC4 the restart on a different model identity did not restore',
      second.restoredWith.length === 0 && m.store.settings.model === 'tc4-other-model',
      JSON.stringify({ restoredWith: second.restoredWith, model: m.store.settings.model }));
    const saved = await persistence().then((p) => p.loadTokenCalibration());
    check('TC4 the saved record still belongs to the identity it was measured on',
      !!saved && saved.modelKey === DEFAULT_MODEL_KEY,
      JSON.stringify(saved && saved.modelKey));
    restore();
  }

  // ---------- TC5. harness-rejected samples → reported, boot continues ----------
  {
    // Earlier scenarios persisted a non-default model (TC4); put the
    // settings rows back on the default identity so the seeded record and
    // this boot's currentModelKey() actually match — the case under test.
    await persistence().then((p) => p.saveSettings({
      apiBase: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', proxy: '',
      dialect: 'auto', maxTokens: '8192', contextWindow: '',
    }));
    await persistence().then((p) => p.saveTokenCalibration(DEFAULT_MODEL_KEY, [0]));
    // Observe the EXISTING reporting channel: reportPersistenceIssue always
    // forwards to the persistence singleton's notePersistenceError. Memory
    // mode boot reports its own (plugin/home) notices afterwards, so the
    // storageNotice snapshot is not attributable — the forwarded call is.
    const persistedIssues = [];
    const p = await persistence();
    const originalNote = p.notePersistenceError.bind(p);
    p.notePersistenceError = (error, message) => {
      persistedIssues.push(message);
      return originalNote(error, message);
    };
    const second = new CalibrationSession({ restoreThrows: true });
    const { store: m, restore } = await loadStoreWithHooks(
      { sessionFactory: () => second }, null, { reset: false },
    );
    await m.whenBooted;
    p.notePersistenceError = originalNote;
    check('TC5 the rejected restore did not interrupt the boot',
      m.store.settings.maxTokens === 8192 && second.restoredWith.length === 0,
      JSON.stringify({ maxTokens: m.store.settings.maxTokens, restoredWith: second.restoredWith }));
    check('TC5 the failure was reported through the persistence-issue path',
      persistedIssues.includes('Token calibration could not be restored'),
      JSON.stringify(persistedIssues));
    restore();
  }

  // ---------- TC6. a harness without the declaration neither saves nor restores ----------
  {
    // No save: samples exist, but the declaration omits the capability.
    const session = new CalibrationSession();
    const { store: m, restore } = await loadStoreWithHooks({
      sessionFactory: () => session,
      harnessCapabilities: () => harnessDeclarationVariant({ tokenCalibrationSnapshot: false }),
    });
    await m.whenBooted;
    await m.submit('tc6 the gate task under a harness that does not declare the snapshot');
    await delay(150);
    const saved = await persistence().then((p) => p.loadTokenCalibration());
    check('TC6 no calibration record without the declared capability',
      saved == null && session.tokenCalibrationCalls === 0,
      JSON.stringify({ saved, calls: session.tokenCalibrationCalls }));
    restore();
    // No restore: a saved record for THIS identity stays untouched on boot.
    await persistence().then((p) => p.saveTokenCalibration(DEFAULT_MODEL_KEY, CALIBRATED_SAMPLES));
    const second = new CalibrationSession();
    const { store: m2, restore: restore2 } = await loadStoreWithHooks({
      sessionFactory: () => second,
      harnessCapabilities: () => harnessDeclarationVariant({ tokenCalibrationSnapshot: false }),
    }, null, { reset: false });
    await m2.whenBooted;
    check('TC6 the saved calibration is not restored without the declared capability',
      second.restoredWith.length === 0,
      JSON.stringify(second.restoredWith));
    const saved2 = await persistence().then((p) => p.loadTokenCalibration());
    check('TC6 the saved record survived untouched',
      !!saved2 && saved2.modelKey === DEFAULT_MODEL_KEY
        && JSON.stringify(saved2.samples) === JSON.stringify(CALIBRATED_SAMPLES),
      JSON.stringify(saved2));
    restore2();
  }

  // ---------- TC7. reset() clears the calibration record ----------
  {
    await persistence().then((p) => p.saveTokenCalibration(DEFAULT_MODEL_KEY, CALIBRATED_SAMPLES));
    check('TC7 the record exists before the reset',
      (await persistence().then((p) => p.loadTokenCalibration())) !== undefined, '');
    await persistence().then((p) => p.reset());
    const after = await persistence().then((p) => p.loadTokenCalibration());
    check('TC7 reset() cleared the calibration record', after == null, JSON.stringify(after));
  }

  console.log('---');
  console.log('token-calibration-persistence.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
