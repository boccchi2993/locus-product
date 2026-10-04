// Store settings-defaults tests (node, NO DOM):
// M3c integration: the store is a REAL singleton ES module over the two
// installed cores — each scenario imports it FRESH via a cache-busting
// specifier after seeding sessionStorage (persistence degrades to its
// memory mode in Node), and exercises the actual settings path:
//   D1 fresh defaults        → deepseek-flash @ https://api.deepseek.com/anthropic, dialect auto,
//                              and the default reaches the MODEL LAYER (the real read path:
//                              testConnection → createModelClient(productModelConfig()))
//   D2 user override          → custom model beats the default; empty falls back to default
//   D3 remembered session     → saved user model beats the new default
//   D4 test connection        → verifies the user-configured model, never a hardcoded one
//   D5 store boots ONE persistent VFS
// (The legacy globalThis.Model singleton is deleted upstream — the
// "reaches the model layer" half of D1–D3 is now observed through the
// explicit transport port + the REAL client the same way production
// requests are built. Same assertion intent, current assembly.)
// Run: node tests/store-defaults.test.cjs

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
// The persistence singleton is a module-level shared instance (the store
// module imports it); D1/D2's testConnection persists settings through it,
// so every scenario starts from a WIPED memory store — otherwise D3's
// boot would honor earlier scenarios' persisted settings over the
// session-seeded remembered config.
async function loadStore(sessionData) {
  if (!persistenceInstancePromise) {
    persistenceInstancePromise = import('../src/persistence.js')
      .then((mod) => mod.PersistenceServiceInstance);
  }
  const persistence = await persistenceInstancePromise;
  globalThis.sessionStorage = fakeSessionStorage(sessionData);
  await persistence.reset();
  scenarioCounter++;
  return import('../src/ui/store.js?scenario=' + scenarioCounter);
}

// A recording transport fake standing in for the network hop. Returns a
// minimal successful Anthropic-shaped response; captures every request.
function recordingTransport(bodies) {
  return async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body) });
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }),
    };
  };
}

(async () => {
  // ---------- D1. fresh defaults (nothing in sessionStorage) ----------
  {
    const m = await loadStore(null); // boot runs applySettings() with the defaults
    check('D1 fresh apiBase', m.store.settings.apiBase === 'https://api.deepseek.com/anthropic',
      m.store.settings.apiBase);
    check('D1 fresh model is deepseek-flash', m.store.settings.model === 'deepseek-flash',
      m.store.settings.model);
    check('D1 fresh dialect is auto', m.store.settings.dialect === 'auto', m.store.settings.dialect);
    // boot applies the default model to the MODEL LAYER: observed through
    // the production read path (createModelClient over the applied config).
    const bodies = [];
    m.setProductModelTransport(recordingTransport(bodies));
    await m.testConnection();
    check('D1 boot applies default model to the model layer',
      bodies.length >= 1 && bodies[0].body.model === 'deepseek-flash',
      JSON.stringify(bodies.map((b) => b.body.model)));
    check('D1 boot keeps endpoint', bodies.length >= 1 && bodies[0].url.startsWith('https://api.deepseek.com/anthropic'),
      bodies[0] && bodies[0].url);
    m.setProductModelTransport(null);
  }

  // ---------- D2. user override wins; empty falls back to default ----------
  {
    const m = await loadStore(null);
    m.store.settings.model = 'custom-model-x';
    m.applySettings();
    const bodies1 = [];
    m.setProductModelTransport(recordingTransport(bodies1));
    await m.testConnection();
    check('D2 user model override wins',
      bodies1.length >= 1 && bodies1[0].body.model === 'custom-model-x',
      JSON.stringify(bodies1.map((b) => b.body.model)));
    m.store.settings.model = '   ';
    m.applySettings();
    const bodies2 = [];
    m.setProductModelTransport(recordingTransport(bodies2));
    await m.testConnection();
    check('D2 blank model falls back to default',
      bodies2.length >= 1 && bodies2[0].body.model === 'deepseek-flash',
      JSON.stringify(bodies2.map((b) => b.body.model)));
    m.setProductModelTransport(null);
  }

  // ---------- D3. remembered session config beats the new default ----------
  {
    const m = await loadStore({
      'bar.v0.rememberSessionKey.v1': '1',
      'bar.v0.sessionConfig.v1': JSON.stringify({ model: 'saved-user-model' }),
    });
    check('D3 remembered model survives default upgrade', m.store.settings.model === 'saved-user-model',
      m.store.settings.model);
    const bodies = [];
    m.setProductModelTransport(recordingTransport(bodies));
    await m.testConnection();
    check('D3 boot applies remembered model to the model layer',
      bodies.length >= 1 && bodies[0].body.model === 'saved-user-model',
      JSON.stringify(bodies.map((b) => b.body.model)));
    m.setProductModelTransport(null);
  }

  // ---------- D4. test connection uses the user-configured model ----------
  // The check goes through the REAL entry client; a recorded transport
  // fake stands in for the network hop and captures the request.
  {
    const m = await loadStore(null);
    m.store.settings.model = 'user-picked-model';
    const bodies = [];
    m.setProductModelTransport(recordingTransport(bodies));
    await m.testConnection();
    check('D4 test connection targets the user model',
      bodies.length >= 1 && bodies[0].body.model === 'user-picked-model',
      JSON.stringify(bodies.map((b) => b.body.model)));
    check('D4 test connection reports that model',
      m.store.settingsResult && m.store.settingsResult.ok === true
        && m.store.settingsResult.message.includes('user-picked-model'),
      m.store.settingsResult && m.store.settingsResult.message);
    m.setProductModelTransport(null);
  }

  // ---------- D5. store boots ONE persistent VFS ----------
  {
    const m = await loadStore(null);
    check('D5 store exposes the VFS', !!m.vfs && m.vfs.isLocusVFS === true);
    check('D5 unmounted defaultCwd is /home/locus', m.vfs.defaultCwd() === '/home/locus',
      m.vfs.defaultCwd());
    check('D5 uploads wired', m.store.attachmentsWired === true);
    check('D5 artifacts start empty', Array.isArray(m.store.artifacts)
      && m.store.artifacts.length === 0);
  }

  console.log('---');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
