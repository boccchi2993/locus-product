// Task-limit settings tests (node, NO DOM):
// Harness PR #15 made the per-task limits session configuration
// (AgentSession deps.maxToolCalls, default 128, allowed 8–1000, and
// deps.toolResultMaxChars, default 40000, allowed 2000–400000, plus the
// setMaxToolCalls / setToolResultMaxChars setters). The product exposes
// both in the settings Model section with the SAME storage, parsing and
// fallback rules as maxTokens (invalid → default; DECISIONS.md D5: user
// configuration, never inferred):
//   TLM1 fresh defaults            → maxToolCalls 128 / toolResultMaxChars 40000
//   TLM2 parse + fallback          → in-range ints pass; 0/-1/'abc'/''/1.5/
//                                    out-of-range ints fall back to the default
//                                    (observed through the real sessionStorage
//                                    read path — the parsers are module-private)
//   TLM3 persistence               → saveSettings stores strings; boot parses
//                                    them back to integers
//   TLM4 applySettings             → calls session.setMaxToolCalls /
//                                    session.setToolResultMaxChars with the
//                                    parsed integers (hooks sessionFactory fake
//                                    records the calls)
//   TLM5 session WITHOUT the setters → boot and applySettings do not throw
//   TLM6 creation deps             → the session factory receives both limits
//                                    at creation: the defaults on a fresh boot,
//                                    a seeded in-range value passed through,
//                                    a seeded out-of-range value parsed to the
//                                    default BEFORE creation
// Run: node tests/task-limit-settings.test.cjs

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
// caller opts out (TLM3 seeds the store its boot is supposed to read).
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
async function loadStoreWithSessionFactory(factory, sessionData) {
  globalThis.window.__LOCUS_HOOKS__ = { sessionFactory: factory };
  try {
    return await loadStore(sessionData);
  } finally {
    delete globalThis.window.__LOCUS_HOOKS__;
  }
}

function seededTaskLimitsConfig(v) {
  return {
    'bar.v0.rememberSessionKey.v1': '1',
    'bar.v0.sessionConfig.v1': JSON.stringify(v),
  };
}

(async () => {
  // ---------- TLM1. fresh defaults ----------
  {
    const m = await loadStore(null); // boot runs applySettings() with the defaults
    check('TLM1 default maxToolCalls is 128', m.store.settings.maxToolCalls === 128,
      m.store.settings.maxToolCalls);
    check('TLM1 default toolResultMaxChars is 40000', m.store.settings.toolResultMaxChars === 40000,
      m.store.settings.toolResultMaxChars);
  }

  // ---------- TLM2. parse + fallback via the real sessionStorage read path ----------
  {
    const toolCallCases = [
      ['\'8\' parses to 8', '8', 8],
      ['\'1000\' parses to 1000', '1000', 1000],
      ['0 falls back to 128', 0, 128],
      ['-1 falls back to 128', -1, 128],
      ['7 falls back to 128', 7, 128],
      ['1001 falls back to 128', 1001, 128],
      ['\'abc\' falls back to 128', 'abc', 128],
      ['\'\' falls back to 128', '', 128],
      ['1.5 falls back to 128', 1.5, 128],
      ['\'1.5\' falls back to 128', '1.5', 128],
    ];
    for (const [name, input, expected] of toolCallCases) {
      const m = await loadStore(seededTaskLimitsConfig({ maxToolCalls: input }));
      check('TLM2 maxToolCalls: ' + name, m.store.settings.maxToolCalls === expected,
        m.store.settings.maxToolCalls);
    }
    const charsCases = [
      ['\'2000\' parses to 2000', '2000', 2000],
      ['\'400000\' parses to 400000', '400000', 400000],
      ['0 falls back to 40000', 0, 40000],
      ['1999 falls back to 40000', 1999, 40000],
      ['400001 falls back to 40000', 400001, 40000],
      ['\'abc\' falls back to 40000', 'abc', 40000],
      ['\'\' falls back to 40000', '', 40000],
      ['1.5 falls back to 40000', 1.5, 40000],
    ];
    for (const [name, input, expected] of charsCases) {
      const m = await loadStore(seededTaskLimitsConfig({ toolResultMaxChars: input }));
      check('TLM2 toolResultMaxChars: ' + name, m.store.settings.toolResultMaxChars === expected,
        m.store.settings.toolResultMaxChars);
    }
  }

  // ---------- TLM3. persistence round trip (string storage, int on boot) ----------
  {
    const persistence = await persistenceInstancePromise;
    await persistence.reset();
    await persistence.saveSettings({
      apiBase: 'https://example.test', model: 'tlm3-model', proxy: '',
      dialect: 'anthropic', maxToolCalls: 8, toolResultMaxChars: 2500,
    });
    const loaded = await persistence.loadSettings();
    check('TLM3 saveSettings stored maxToolCalls as a string', loaded.maxToolCalls === '8',
      typeof loaded.maxToolCalls + ':' + JSON.stringify(loaded.maxToolCalls));
    check('TLM3 saveSettings stored toolResultMaxChars as a string', loaded.toolResultMaxChars === '2500',
      typeof loaded.toolResultMaxChars + ':' + JSON.stringify(loaded.toolResultMaxChars));
    // Boot reads the SAME memory store (no reset) and must parse the strings
    // back into the integers the settings are defined to carry.
    const m = await loadStore(null, { reset: false });
    let settled = 0;
    for (let i = 0; i < 200 && settled < 2; i++) { // bootPersistence is fire-and-forget
      settled = (m.store.settings.maxToolCalls === 8 ? 1 : 0)
        + (m.store.settings.toolResultMaxChars === 2500 ? 1 : 0);
      if (settled < 2) await new Promise((r) => setTimeout(r, 10));
    }
    check('TLM3 boot parses the stored strings back to integers',
      m.store.settings.maxToolCalls === 8 && m.store.settings.toolResultMaxChars === 2500,
      JSON.stringify({ calls: m.store.settings.maxToolCalls, chars: m.store.settings.toolResultMaxChars }));
  }

  // ---------- TLM4. applySettings drives the live-session setters ----------
  {
    const toolCallRecorded = [];
    const charsRecorded = [];
    const m = await loadStoreWithSessionFactory(() => ({
      generation: 1,
      setMaxToolCalls: (n) => { toolCallRecorded.push(n); },
      setToolResultMaxChars: (n) => { charsRecorded.push(n); },
    }));
    check('TLM4 boot applied the defaults to the injected session',
      toolCallRecorded.length >= 1 && toolCallRecorded[0] === 128
      && charsRecorded.length >= 1 && charsRecorded[0] === 40000,
      JSON.stringify({ calls: toolCallRecorded, chars: charsRecorded }));
    m.store.settings.maxToolCalls = '8'; // string, as read back from storage
    m.store.settings.toolResultMaxChars = '2500';
    m.applySettings();
    const lastCalls = toolCallRecorded[toolCallRecorded.length - 1];
    const lastChars = charsRecorded[charsRecorded.length - 1];
    check('TLM4 applySettings calls setMaxToolCalls with the parsed integer',
      lastCalls === 8 && Number.isInteger(lastCalls), JSON.stringify(toolCallRecorded));
    check('TLM4 applySettings calls setToolResultMaxChars with the parsed integer',
      lastChars === 2500 && Number.isInteger(lastChars), JSON.stringify(charsRecorded));
    check('TLM4 store values normalized to integers',
      m.store.settings.maxToolCalls === 8 && m.store.settings.toolResultMaxChars === 2500,
      JSON.stringify({ calls: m.store.settings.maxToolCalls, chars: m.store.settings.toolResultMaxChars }));
    // Out-of-range input falls back to the default on the LIVE path too.
    m.store.settings.maxToolCalls = 5000;
    m.store.settings.toolResultMaxChars = 1;
    m.applySettings();
    check('TLM4 out-of-range live input falls back to the defaults',
      toolCallRecorded[toolCallRecorded.length - 1] === 128
      && charsRecorded[charsRecorded.length - 1] === 40000,
      JSON.stringify({ calls: toolCallRecorded, chars: charsRecorded }));
  }

  // ---------- TLM5. session without the setters must not throw ----------
  {
    let m = null, bootErr = null;
    try {
      m = await loadStoreWithSessionFactory(() => ({ generation: 1 }));
    } catch (e) { bootErr = e; }
    check('TLM5 boot tolerates a session without the task-limit setters', !bootErr && !!m,
      bootErr && String(bootErr));
    if (m) {
      let applyErr = null;
      m.store.settings.maxToolCalls = 16;
      m.store.settings.toolResultMaxChars = 8000;
      try { m.applySettings(); } catch (e) { applyErr = e; }
      check('TLM5 applySettings tolerates a session without the task-limit setters', !applyErr,
        applyErr && String(applyErr));
      check('TLM5 store values still normalized to the parsed integers',
        m.store.settings.maxToolCalls === 16 && m.store.settings.toolResultMaxChars === 8000,
        JSON.stringify({ calls: m.store.settings.maxToolCalls, chars: m.store.settings.toolResultMaxChars }));
    }
  }

  // ---------- TLM6. creation deps carry both limits ----------
  {
    const seen = [];
    let m = await loadStoreWithSessionFactory((deps) => {
      seen.push({ calls: deps.maxToolCalls, chars: deps.toolResultMaxChars });
      return { generation: 1 };
    });
    check('TLM6 fresh boot passes the defaults at creation',
      seen.length === 1 && seen[0].calls === 128 && seen[0].chars === 40000,
      JSON.stringify(seen));

    seen.length = 0;
    m = await loadStoreWithSessionFactory((deps) => {
      seen.push({ calls: deps.maxToolCalls, chars: deps.toolResultMaxChars });
      return { generation: 1 };
    }, seededTaskLimitsConfig({ maxToolCalls: '8', toolResultMaxChars: '2500' }));
    check('TLM6 seeded in-range values are passed through at creation',
      seen.length === 1 && seen[0].calls === 8 && seen[0].chars === 2500,
      JSON.stringify(seen));

    seen.length = 0;
    m = await loadStoreWithSessionFactory((deps) => {
      seen.push({ calls: deps.maxToolCalls, chars: deps.toolResultMaxChars });
      return { generation: 1 };
    }, seededTaskLimitsConfig({ maxToolCalls: 5000, toolResultMaxChars: 'abc' }));
    check('TLM6 seeded invalid values are parsed to the defaults BEFORE creation',
      seen.length === 1 && seen[0].calls === 128 && seen[0].chars === 40000,
      JSON.stringify(seen));
  }

  console.log('---');
  console.log('task-limit-settings.test.cjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
