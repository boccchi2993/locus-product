// Max output tokens setting tests (node, NO DOM):
// DECISIONS.md D5: max_tokens is USER configuration, never inferred from the
// model name. The setting lives in store.settings.maxTokens (default 32768
// since the 2026-10-31 rendering/file-delivery task — was 8192),
// persists through the regular settings rows (string storage, no schema
// bump), and reaches the provider session through applySettings →
// session.setMaxTokens (guarded: injected test sessions may lack the method):
//   SET1 fresh defaults       → maxTokens 32768
//   SET2 parseMaxTokens       → '4096'→4096; 0/-1/'abc'/''/1.5 → 32768
//                               (observed through the real sessionStorage read
//                               path — the helper is module-private)
//   SET3 persistence          → saveSettings stores a string; boot parses it
//                               back to an integer
//   SET4 applySettings        → calls session.setMaxTokens with the parsed
//                               integer (hooks sessionFactory fake records calls)
//   SET5 session WITHOUT setMaxTokens → applySettings does not throw
// Run: node tests/max-tokens-settings.test.cjs

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

let scenarioCounter = 0;
let persistenceInstancePromise = null;
// Same shape as store-defaults: the persistence singleton is shared module
// state, so every scenario starts from a WIPED memory store unless the
// caller opts out (SET3 seeds the store its boot is supposed to read).
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

// The session resolves ONCE per store module evaluation (sessionFactory is
// read at import time), so the fake factory must be installed before the
// scenario import and cleaned up after it.
async function loadStoreWithSessionFactory(factory) {
  globalThis.window.__LOCUS_HOOKS__ = { sessionFactory: factory };
  try {
    return await loadStore(null);
  } finally {
    delete globalThis.window.__LOCUS_HOOKS__;
  }
}

function seededMaxTokensConfig(v) {
  return {
    'bar.v0.rememberSessionKey.v1': '1',
    'bar.v0.sessionConfig.v1': JSON.stringify({ maxTokens: v }),
  };
}

(async () => {
  // ---------- SET1. fresh defaults ----------
  {
    const m = await loadStore(null); // boot runs applySettings() with the defaults
    check('SET1 default maxTokens is 32768', m.store.settings.maxTokens === 32768,
      m.store.settings.maxTokens);
  }

  // ---------- SET2. parseMaxTokens via the real sessionStorage read path ----------
  {
    const cases = [
      ['\'4096\' parses to 4096', '4096', 4096],
      ['0 falls back to 32768', 0, 32768],
      ['-1 falls back to 32768', -1, 32768],
      ['\'abc\' falls back to 32768', 'abc', 32768],
      ['\'\' falls back to 32768', '', 32768],
      ['1.5 falls back to 32768', 1.5, 32768],
    ];
    for (const [name, input, expected] of cases) {
      const m = await loadStore(seededMaxTokensConfig(input));
      check('SET2 ' + name, m.store.settings.maxTokens === expected,
        m.store.settings.maxTokens);
    }
  }

  // ---------- SET3. persistence round trip (string storage, int on boot) ----------
  {
    const persistence = await persistenceInstancePromise;
    await persistence.reset();
    await persistence.saveSettings({
      apiBase: 'https://example.test', model: 'set3-model', proxy: '',
      dialect: 'anthropic', maxTokens: 4096,
    });
    const loaded = await persistence.loadSettings();
    check('SET3 saveSettings stored maxTokens as a string', loaded.maxTokens === '4096',
      typeof loaded.maxTokens + ':' + JSON.stringify(loaded.maxTokens));
    // Boot reads the SAME memory store (no reset) and must parse the string
    // back into the integer the setting is defined to carry.
    const m = await loadStore(null, { reset: false });
    let settled = false;
    for (let i = 0; i < 200 && !settled; i++) { // bootPersistence is fire-and-forget
      settled = m.store.settings.maxTokens === 4096;
      if (!settled) await new Promise((r) => setTimeout(r, 10));
    }
    check('SET3 boot parses the stored string back to an integer',
      m.store.settings.maxTokens === 4096 && Number.isInteger(m.store.settings.maxTokens),
      m.store.settings.maxTokens);
  }

  // ---------- SET4. applySettings drives session.setMaxTokens ----------
  {
    const recorded = [];
    const m = await loadStoreWithSessionFactory(() => ({
      generation: 1,
      setMaxTokens: (n) => { recorded.push(n); },
    }));
    check('SET4 boot applied the default to the injected session',
      recorded.length >= 1 && recorded[0] === 32768, JSON.stringify(recorded));
    m.store.settings.maxTokens = '4096'; // string, as read back from storage
    m.applySettings();
    const last = recorded[recorded.length - 1];
    check('SET4 applySettings calls setMaxTokens with the parsed integer',
      recorded.length >= 2 && last === 4096 && typeof last === 'number' && Number.isInteger(last),
      JSON.stringify(recorded));
    check('SET4 store value normalized to integer', m.store.settings.maxTokens === 4096,
      m.store.settings.maxTokens);
  }

  // ---------- SET5. session without setMaxTokens must not throw ----------
  {
    let m = null, bootErr = null;
    try {
      m = await loadStoreWithSessionFactory(() => ({ generation: 1 }));
    } catch (e) { bootErr = e; }
    check('SET5 boot tolerates a session without setMaxTokens', !bootErr && !!m,
      bootErr && String(bootErr));
    if (m) {
      let applyErr = null;
      m.store.settings.maxTokens = '2048';
      try { m.applySettings(); } catch (e) { applyErr = e; }
      check('SET5 applySettings tolerates a session without setMaxTokens', !applyErr,
        applyErr && String(applyErr));
      check('SET5 store value still normalized to the parsed integer',
        m.store.settings.maxTokens === 2048, m.store.settings.maxTokens);
    }
  }

  console.log('---');
  console.log('max-tokens-settings.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
