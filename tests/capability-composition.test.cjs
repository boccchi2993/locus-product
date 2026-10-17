// Capability Composition Runtime v1 unit tests (node):
// descriptor validators, registry load-time validation, CapabilityManager
// lifecycle (enable/disable/states), TaskEnvironment immutability,
// component semantics (plugins/MCP dedupe by id; skill INSTANCES are
// capability-private and never deduped), MCP requirement states,
// system-prompt capability index (lazy instance paths — bodies NEVER in
// prompt), task VFS mounts (introspection only — the old read-only skill
// body mount is gone), the python extension payload/key seam and the
// worker's pre-READY plugin install.
// Skill Definition/Instance lifecycle specifics live in
// tests/skill-instances.test.cjs.
// D10 §6 wheel-only migration: plugin-bearing capabilities arrive ONLY as
// registerPackage wheel packages (the PluginRuntimeProvider seam is gone
// from the harness), and the worker-install block feeds the REAL wheel
// fixtures to the runtime worker's verified offline-install branch.
// Run: node tests/capability-composition.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const readBytes = (p) => fs.readFileSync(path.join(__dirname, '..', p));
const sha256hex = (bytes) => nodeCrypto.createHash('sha256').update(bytes).digest('hex');

// ---- M3c integration: every symbol from the REAL modules (no eval) ----
// Ownership split (documented in locus-harness
// tests/capability-composition.test.mjs): the composition-core checks run
// THERE over the real module; this suite keeps the PRODUCT adapter block
// (F0-F12: productTaskVfsMounts over runtime workspaces + the
// StaticFileWorkspace tree) and the WORKER install block (W0-W9 over the
// runtime's real PY_WORKER_SOURCE, driven through the wheel-only payload
// branch since the D10 §6 migration).
let runtimeApi = null, harnessApi = null, ext = null, toolsMod = null;   // imported in run()

let M = null;   // alias surface, resolved in run()
let A = null;
let PY_WORKER_SOURCE = null;

let passed = 0, failed = 0;
// M2b (repository split): AgentSession consumes a ToolPort
// ({ definitions(), execute({ name, input, context }) }); this suite's
// fakes keep the legacy executor shape and convert through the exact
// mapping the contract documents (docs/REPOSITORY-SPLIT-CONTRACTS.md 3.2).
const asToolPort = (executor) => ({
  definitions: () => A.AGENT_TOOL_DEFINITIONS.slice(),
  execute: ({ name, input, context }) =>
    executor(name, input, (context && context.filesystem) || null, { signal: context && context.signal }),
});

function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
async function throwsWith(name, fn, namePart, msgPart) {
  try {
    await fn();
    check(name, false, 'expected throw');
  } catch (e) {
    const ok = (!namePart || e.name === namePart || String(e.message).includes(namePart))
      && (!msgPart || String(e.message).includes(msgPart));
    check(name, ok, e.name + ': ' + e.message);
  }
}

// ---- synthetic TEST-ONLY catalog (never part of production) ----
// The skill's default Markdown source lives in a real fixture file and is
// injected into the SkillSourceStore — NEVER inline on the descriptor.
// D10 §6: the plugin-bearing capabilities (synthetic-capability / cap-a /
// cap-b) arrive ONLY as registerPackage wheel packages below; the
// constructor catalog keeps exactly the capabilities that need no plugin.
const SYNTH_SKILL_BODY = read('tests/fixtures/skills/synthetic-skill/SKILL.md');

const SYNTH_CATALOGS = () => ({
  plugins: [],
  skills: [
    { id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill', description: 'How to use the synthetic capability.' },
    { id: 'shared-skill', version: '1', description: 'Shared guidance.' },
  ],
  mcps: [
    { id: 'synthetic-service', displayName: 'Synthetic Service', description: 'TEST ONLY authority' },
  ],
  capabilities: [
    {
      id: 'synthetic-mcp-capability', version: '1', displayName: 'Synthetic MCP Capability',
      description: 'Requires an external authority.',
      plugins: [], skills: ['synthetic-skill'], mcps: ['synthetic-service'],
    },
  ],
});

function synthSources() {
  const s = new M.SkillSourceStore();
  s.define('synthetic-skill', '1', SYNTH_SKILL_BODY);
  s.define('shared-skill', '1', '# shared\n');
  return s;
}

function synthHome() {
  return new M.MemoryWorkspace({ name: 'home', dirs: ['.skills'] });
}

// ---- wheel package fixtures (D10 §6) ----
// The manager verifies the artifact sha256 against the bytes and never
// parses the wheel itself (the real wheel install is the worker's job, see
// the W block), so deterministic synthetic bytes are sufficient here.
const WHEEL_SYN = new Uint8Array(48).map((_, i) => (i * 7 + 3) & 0xff);
const WHEEL_SHARED = new Uint8Array(48).map((_, i) => (i * 11 + 5) & 0xff);

function wheelArtifact(bytes, filename) {
  return {
    filename: filename || 'locus_test_plugin-1.0.0-py3-none-any.whl',
    format: 'python-wheel',
    size: bytes.byteLength,
    sha256: sha256hex(bytes),
    bytes: bytes,
  };
}

// The synthetic-capability package: one python plugin (verified wheel) and
// the synthetic skill with its fixture source.
function synthPkg() {
  return {
    capability: {
      id: 'synthetic-capability', version: '1', displayName: 'Synthetic Capability',
      description: 'TEST ONLY composition proof.',
      plugins: ['synthetic-python-plugin'],
      skills: ['synthetic-skill'],
      mcps: [],
    },
    plugins: [
      {
        id: 'synthetic-python-plugin', version: '1', displayName: 'Synthetic Python Plugin',
        runtime: 'python', authority: 'none',
        provides: { pythonImports: ['locus_test_plugin'] },
      },
    ],
    skills: [
      { id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill', description: 'How to use the synthetic capability.' },
    ],
    mcps: [],
    sources: { 'synthetic-skill': { version: '1', source: SYNTH_SKILL_BODY } },
    artifacts: { 'synthetic-python-plugin': wheelArtifact(WHEEL_SYN) },
  };
}

// cap-a / cap-b share the SAME plugin descriptor + wheel bytes and the
// SAME skill source, so both co-register (shared-component semantics).
function sharedPkg(id, description) {
  return {
    capability: {
      id: id, version: '1', displayName: id === 'cap-a' ? 'Capability A' : 'Capability B',
      description: description,
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
    plugins: [
      {
        id: 'shared-plugin', version: '2', displayName: 'Shared Plugin',
        runtime: 'python', authority: 'none',
        provides: { pythonImports: [] },
      },
    ],
    skills: [
      { id: 'shared-skill', version: '1', description: 'Shared guidance.' },
    ],
    mcps: [],
    sources: { 'shared-skill': { version: '1', source: '# shared\n' } },
    artifacts: { 'shared-plugin': wheelArtifact(WHEEL_SHARED, 'shared_plugin-2.0.0-py3-none-any.whl') },
  };
}

// One manager = one fresh memory home + source store, so lifecycle tests
// never observe each other's files. The plugin-bearing capabilities are
// registered as wheel packages (D10 §6); opts.noPackages keeps a manager
// package-free (the empty production manager).
async function newManager(catalogs, opts) {
  const o = opts || {};
  const home = o.home || synthHome();
  const storage = new M.SkillInstanceStorage({ resolveHome: () => home });
  const sources = o.sources === undefined ? synthSources() : o.sources;
  const instances = o.instances === undefined ? storage : o.instances;
  const m = new M.CapabilityManager({ catalogs: catalogs || SYNTH_CATALOGS(), sources, instances });
  m._testHome = home;
  if (!o.noPackages) {
    await m.registerPackage(synthPkg());
    await m.registerPackage(sharedPkg('cap-a', 'Shares plugin X and the skill definition with B.'));
    await m.registerPackage(sharedPkg('cap-b', 'Also shares plugin X and the skill definition.'));
  }
  return m;
}

async function run() {
  runtimeApi = await import('../src/product/runtime-api.js');
  harnessApi = await import('../src/product/harness-api.js');
  ext = await import('../src/extensions.js');
  toolsMod = await import('../src/tools.js');
  M = {
    CapabilityManager: harnessApi.CapabilityManager,
    SkillSourceStore: harnessApi.SkillSourceStore,
    SkillInstanceStorage: ext.SkillInstanceStorage,
    SkillInstanceWorkspace: ext.SkillInstanceWorkspace,
    StaticFileWorkspace: ext.StaticFileWorkspace,
    productTaskVfsMounts: ext.productTaskVfsMounts,
    MemoryWorkspace: Object.getPrototypeOf(runtimeApi.createMemoryWorkspace({})).constructor,
  };
  A = {
    buildSystemPrompt: harnessApi.buildSystemPrompt,
    AgentSession: harnessApi.AgentSession,
    AGENT_TOOL_DEFINITIONS: toolsMod.AGENT_TOOL_DEFINITIONS,
  };
  PY_WORKER_SOURCE = runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE;

  // (Composition-core coverage — production catalogs, descriptor
  // validation, manager lifecycle, MCP requirement states, system-prompt
  // capability index — moved with the harness package; see the note in
  // this file's head. The wheel-only gate lives in the harness's
  // tests/wheel-only-plugins.test.mjs.)

  const prod = await newManager({}, { noPackages: true });
  const readyMgr = await newManager();
  await readyMgr.enable('synthetic-capability');
  const readyEnv = readyMgr.buildTaskEnvironment();

  // ================= task VFS mounts =================
  const vEnv = readyEnv;
  // M2b: the manager returns pure SPECS; the product adapter builds the providers.
  const specProbe = readyMgr.taskVfsMountSpecs(vEnv);
  check('F0 mount specs are pure data (no provider objects from the composition core)',
    specProbe.every((s) => !('provider' in s) && typeof s.path === 'string' && typeof s.files === 'object'));
  const mounts = M.productTaskVfsMounts(readyMgr, vEnv);
  check('F1 two mounts for a skill-bearing environment (introspection only)', mounts.length === 2, String(mounts.length));
  check('F2 mount paths + system-read-only authority', mounts.every((m) => m.authority === 'system-read-only')
    && mounts.map((m) => m.path).sort().join() === '/mnt/plugins,/usr/local/share/locus/capabilities');

  const vfs = runtimeApi.createWorkspace();
  const fork = vfs.fork();
  for (const m of mounts) fork.mount(m.path, m.provider, m.authority);
  check('F3 the old read-only skill body mount is GONE',
    fork.resolveMount('/usr/local/share/locus/skills') === null
    && fork.resolveMount('/usr/local/share/locus/skills/synthetic-capability/SKILL.md') === null);
  check('F4 a write into the old skill path is refused by the VFS (no provider, structural path)',
    await fork.write('/usr/local/share/locus/skills/whatever', 'x').then(() => false, (e) => e.name === 'ReadOnlyError'));
  check('F5 plugin introspection json is safe metadata', (() => fork.read('/mnt/plugins/synthetic-python-plugin/plugin.json').then((t) => {
    const j = JSON.parse(t);
    return j.id === 'synthetic-python-plugin' && j.runtime === 'python' && j.authority === 'none'
      && JSON.stringify(j.provides) === JSON.stringify({ pythonImports: ['locus_test_plugin'] })
      && !t.includes('return 42');
  })()));
  check('F6 capability introspection json carries resolved state', (() => fork.read('/usr/local/share/locus/capabilities/synthetic-capability/capability.json').then((t) => {
    const j = JSON.parse(t);
    return j.id === 'synthetic-capability' && j.state === 'ready' && Array.isArray(j.skills) && j.skills[0].endsWith('.skill');
  })()));
  await throwsWith('F7 write into the plugin mount is refused (VFS authority layer)',
    () => fork.write('/mnt/plugins/synthetic-python-plugin/plugin.json', '{}'), 'ReadOnlyError');
  await throwsWith('F8 rm into the capability mount is refused',
    () => fork.remove('/usr/local/share/locus/capabilities/synthetic-capability/capability.json'), 'ReadOnlyError');
  check('F9 the live VFS stays untouched by task mounts',
    (await vfs.list('/usr/local/share/locus/skills')).length === 0
    && vfs.resolveMount('/mnt/plugins') === null);
  check('F10 without capabilities the fork gains no mounts', await (async () => {
    const v2 = runtimeApi.createWorkspace();
    const f2 = v2.fork();
    const before = f2.mounts.length;
    for (const m of M.productTaskVfsMounts(await newManager(), prod.buildTaskEnvironment())) f2.mount(m.path, m.provider, m.authority);
    return f2.mounts.length === before;
  })());
  check('F11 mount count follows the resolved set (skills-only env)', await (async () => {
    const mOnly = new M.CapabilityManager({ catalogs: {
      skills: SYNTH_CATALOGS().skills,
      capabilities: [{ id: 's-only', version: '1', displayName: 'S', description: 'd', skills: ['synthetic-skill'] }],
    }, sources: synthSources(), instances: new M.SkillInstanceStorage({ resolveHome: () => synthHome() }) });
    await mOnly.enable('s-only');
    return M.productTaskVfsMounts(mOnly, mOnly.buildTaskEnvironment()).length === 1; // capabilities introspection, no plugins
  })());
  check('F12 StaticFileWorkspace byte tree works standalone', (() => {
    const w = new M.StaticFileWorkspace({ files: { 'a/plugin.json': 'x' } });
    return w.stat('a/plugin.json').then((s) => s.size === 1);
  })());

  // (The python extension payload/key seam moved with the harness
  // package — covered by locus-harness capability-composition tests.)

  // ================= worker plugin install (real worker source, VM) =================
  // M2a: the worker source lives in the runtime asset module; the product
  // page must NOT carry it anymore.
  check('W0 worker source lives in the runtime assets, not index.html',
    PY_WORKER_SOURCE.includes('ensureLockedPyodide') && !read('index.html').includes('py-worker-src'));

  // The REAL wheel fixtures (committed): the proven Package Core wheel for
  // the happy path and the deliberately-broken m3c wheel for the negative
  // smoke-import case — the same bytes the browser e2e installs through
  // the real import service.
  const GOOD_WHEEL = readBytes('tests/fixtures/capability-package/minimal/plugins/locus-test-plugin/artifacts/locus_test_plugin-1.0.0-py3-none-any.whl');
  const GOOD_WHEEL_SHA = sha256hex(GOOD_WHEEL);
  const BROKEN_WHEEL = readBytes('tests/fixtures/m3c-python/locus_m3c_plugin_broken-1.0.0-py3-none-any.whl');
  const BROKEN_WHEEL_SHA = sha256hex(BROKEN_WHEEL);

  function wheelPayloadMeta(bytes, sha, filename) {
    return { filename: filename, format: 'python-wheel', size: bytes.byteLength, sha256: sha };
  }

  function bootWorker(extensionModules, loadPyodideImpl) {
    let recorded = null;
    const c = vm.createContext({
      self: { postMessage() {} },
      fetch: function () {},
      XMLHttpRequest: function () {},
      WebSocket: function () {},
      importScripts() {},
      // The wheel branch re-verifies byte identity through WebCrypto subtle
      // before anything is written; a context without it fails the boot
      // closed (the same rule as the page-side asset gate).
      crypto: { subtle: nodeCrypto.webcrypto.subtle },
      loadPyodide: loadPyodideImpl || (async () => ({
        FS: {
          mkdirTree() {}, writeFile(path2, data) { recorded = recorded || []; recorded.push({ kind: 'write', path: path2, data }); },
          readFile() { return new Uint8Array(); }, readdir() { return []; },
          stat() { return { mode: 0, size: 0 }; }, unlink() {}, rmdir() {}, chmod() {}, isDir() { return false; },
        },
        runPython(code) {
          recorded = recorded || [];
          recorded.push({ kind: 'runPython', code });
          if (code.includes('sysconfig')) return '/lib/python3.12/site-packages';
          return undefined;
        },
        runPythonAsync(code) {
          recorded = recorded || [];
          recorded.push({ kind: 'runPythonAsync', code });
          return Promise.resolve(undefined);
        },
        setStdout() {}, setStderr() {},
        loadPackage: async () => { recorded = recorded || []; recorded.push({ kind: 'loadPackage' }); },
      })),
    });
    vm.runInContext(PY_WORKER_SOURCE, c);
    const boot = vm.runInContext('ensureLockedPyodide()', c);
    // Wheel bytes travel to the real worker as structured-clone Uint8Arrays;
    // across the vm realm they must be REBUILT in-context (a host typed
    // array would fail the in-context `instanceof`), so they cross as plain
    // arrays and are reconstructed before the bootstrap message.
    c.__bootstrapJson = JSON.stringify(
      { id: 1, cmd: 'bootstrap', assets: {
        'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
        'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
      }, extensionModules },
      (k, v) => (v instanceof Uint8Array ? Array.from(v) : v),
    );
    vm.runInContext(`(function () {
      var msg = JSON.parse(__bootstrapJson);
      (msg.extensionModules || []).forEach(function (m) {
        (m.wheels || []).forEach(function (w) { w.bytes = new Uint8Array(w.bytes); });
      });
      self.onmessage({ data: msg });
    })()`, c);
    return { boot, recorded: () => recorded, ctx: c };
  }

  {
    const w = bootWorker([
      {
        pluginId: 'synthetic-python-plugin',
        wheels: [Object.assign({ bytes: new Uint8Array(GOOD_WHEEL) }, wheelPayloadMeta(GOOD_WHEEL, GOOD_WHEEL_SHA, 'locus_test_plugin-1.0.0-py3-none-any.whl'))],
        imports: ['locus_test_plugin'],
      },
    ]);
    let bootErr = null;
    try { await w.boot; } catch (e) { bootErr = e; }
    check('W1 boot with a wheel plugin payload succeeds', !bootErr, bootErr && bootErr.message);
    const rec = w.recorded() || [];
    const writes = rec.filter((r) => r.kind === 'write');
    const imports = rec.filter((r) => r.kind === 'runPython' && r.code.startsWith('import '));
    check('W2 the verified wheel bytes materialize at the scratch path before install',
      writes.length === 1
      && writes[0].path === '/tmp/locus-plugin-artifacts/' + GOOD_WHEEL_SHA + '/locus_test_plugin-1.0.0-py3-none-any.whl'
      && Buffer.compare(Buffer.from(writes[0].data), Buffer.from(GOOD_WHEEL)) === 0, JSON.stringify(writes.map((x) => x.path)));
    check('W3 smoke import ran for the declared module', imports.some((r) => r.code === 'import locus_test_plugin'), JSON.stringify(imports));
    check('W4 runtime package load precedes plugin install', (() => {
      const i = rec.findIndex((r) => r.kind === 'loadPackage');
      const j = rec.findIndex((r) => r.kind === 'write');
      return i !== -1 && j !== -1 && i < j;
    })());
    check('W4b the offline micropip install ran inside the bootstrap window',
      rec.some((r) => r.kind === 'runPythonAsync' && r.code.includes('micropip.install')), JSON.stringify(rec.filter((r) => r.kind === 'runPythonAsync').map((r) => r.code.slice(0, 60))));
    check('W5 post-boot lockdown applied (worker fetch denied)', vm.runInContext(
      "(function () { try { fetch('http://127.0.0.1:9/probe'); return 'allowed'; } catch (e) { return 'denied'; } })()", w.ctx) === 'denied');
  }
  {
    // Negative: the declared sha256 does not match the received bytes —
    // the worker must fail the WHOLE boot closed (no install, no smoke).
    const corrupt = new Uint8Array(GOOD_WHEEL);
    corrupt[0] = (corrupt[0] + 1) & 0xff;
    const w = bootWorker([
      {
        pluginId: 'synthetic-python-plugin',
        wheels: [Object.assign({ bytes: corrupt }, wheelPayloadMeta(GOOD_WHEEL, GOOD_WHEEL_SHA, 'locus_test_plugin-1.0.0-py3-none-any.whl'))],
        imports: ['locus_test_plugin'],
      },
    ]);
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    check('W7 a wheel byte-identity mismatch fails the boot closed', !!err && /sha256 mismatch/.test(err.message), err && err.message);
  }
  {
    // The REAL broken wheel: structurally valid (verification + offline
    // install succeed), but its module does not compile — the smoke import
    // (the interpreter's verdict) must fail the boot honestly.
    const w = bootWorker([
      {
        pluginId: 'broken',
        wheels: [Object.assign({ bytes: new Uint8Array(BROKEN_WHEEL) }, wheelPayloadMeta(BROKEN_WHEEL, BROKEN_WHEEL_SHA, 'locus_m3c_plugin_broken-1.0.0-py3-none-any.whl'))],
        imports: ['locus_m3c_plugin'],
      },
    ], async () => ({
      FS: { mkdirTree() {}, writeFile() {}, readFile() { return new Uint8Array(); }, readdir() { return []; }, stat() { return { mode: 0, size: 0 }; }, unlink() {}, rmdir() {}, chmod() {}, isDir() { return false; } },
      runPython(code) {
        if (code.startsWith('import locus_m3c_plugin')) {
          throw new Error('SyntaxError: invalid syntax (locus_m3c_plugin_broken.py)');
        }
        return undefined;
      },
      runPythonAsync() { return Promise.resolve(undefined); },
      setStdout() {}, setStderr() {}, loadPackage: async () => {},
    }));
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    check('W8 failed smoke import fails the boot closed', !!err && /smoke import failed/.test(err.message) && /plugin broken/.test(err.message), err && err.message);
  }
  {
    const w = bootWorker(undefined);
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    const rec = w.recorded() || [];
    check('W9 no extensionModules -> core-only boot unchanged (no FS writes)',
      !err && rec.filter((r) => r.kind === 'write').length === 0, err && err.message);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
