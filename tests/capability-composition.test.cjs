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
// Run: node tests/capability-composition.test.cjs

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ---- M3c integration: every symbol from the REAL modules (no eval) ----
// Ownership split (documented in locus-harness
// tests/capability-composition.test.mjs): the composition-core checks run
// THERE over the real module; this suite keeps the PRODUCT adapter block
// (F0-F12: productTaskVfsMounts over runtime workspaces + the
// StaticFileWorkspace tree) and the WORKER install block (W0-W9 over the
// runtime's real PY_WORKER_SOURCE).
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
const SYNTH_SKILL_BODY = read('tests/fixtures/skills/synthetic-skill/SKILL.md');

const SYNTH_CATALOGS = () => ({
  plugins: [
    {
      id: 'synthetic-python-plugin', version: '1', displayName: 'Synthetic Python Plugin',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: ['locus_test_plugin'] },
    },
    {
      id: 'shared-plugin', version: '2', displayName: 'Shared Plugin',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: [] },
    },
  ],
  skills: [
    { id: 'synthetic-skill', version: '1', displayName: 'Synthetic Skill', description: 'How to use the synthetic capability.' },
    { id: 'shared-skill', version: '1', description: 'Shared guidance.' },
  ],
  mcps: [
    { id: 'synthetic-service', displayName: 'Synthetic Service', description: 'TEST ONLY authority' },
  ],
  capabilities: [
    {
      id: 'synthetic-capability', version: '1', displayName: 'Synthetic Capability',
      description: 'TEST ONLY composition proof.',
      plugins: ['synthetic-python-plugin'],
      skills: ['synthetic-skill'],
      mcps: [],
    },
    {
      id: 'cap-a', version: '1', displayName: 'Capability A',
      description: 'Shares plugin X and the skill definition with B.',
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
    {
      id: 'cap-b', version: '1', displayName: 'Capability B',
      description: 'Also shares plugin X and the skill definition.',
      plugins: ['shared-plugin'], skills: ['shared-skill'], mcps: [],
    },
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

// One manager = one fresh memory home + source store, so lifecycle tests
// never observe each other's files.
function newManager(catalogs, opts) {
  const o = opts || {};
  const home = o.home || synthHome();
  const storage = new M.SkillInstanceStorage({ resolveHome: () => home });
  const sources = o.sources === undefined ? synthSources() : o.sources;
  const instances = o.instances === undefined ? storage : o.instances;
  const m = new M.CapabilityManager({ catalogs: catalogs || SYNTH_CATALOGS(), sources, instances });
  m._testHome = home;
  return m;
}

function synthProvider() {
  return {
    runtime: 'python',
    async prepare(plugin) {
      if (plugin.id === 'synthetic-python-plugin') {
        return {
          files: { 'locus_test_plugin.py': 'def answer():\n    return 42\n' },
          imports: ['locus_test_plugin'],
        };
      }
      return { files: { ['shared_' + plugin.id.replace(/[^a-z0-9]/g, '_') + '.py']: 'x = 1\n' }, imports: [] };
    },
  };
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
    registerPluginRuntimeProvider: harnessApi.registerPluginRuntimeProvider,
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
  // this file's head.)

  // The synthetic python plugin runtime provider is SUITE-registered via
  // the harness PUBLIC registerPluginRuntimeProvider — the old suite did
  // the same inside its descriptor-validation section; unregistered in
  // the run() tail.
  M.registerPluginRuntimeProvider('python', synthProvider());
  const prod = newManager({});
  const readyMgr = newManager();
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
  check('F10 without capabilities the fork gains no mounts', (() => {
    const v2 = runtimeApi.createWorkspace();
    const f2 = v2.fork();
    const before = f2.mounts.length;
    for (const m of M.productTaskVfsMounts(newManager(), prod.buildTaskEnvironment())) f2.mount(m.path, m.provider, m.authority);
    return f2.mounts.length === before;
  })());
  check('F11 mount count follows the resolved set (skills-only env)', (async () => {
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

  function bootWorker(extensionModules, loadPyodideImpl) {
    let recorded = null;
    const c = vm.createContext({
      self: { postMessage() {} },
      fetch: function () {},
      XMLHttpRequest: function () {},
      WebSocket: function () {},
      importScripts() {},
      loadPyodide: loadPyodideImpl || (async () => ({
        FS: {
          mkdirTree() {}, writeFile(path2, data) { recorded = recorded || []; recorded.push({ kind: 'write', path: path2, data }); },
          readFile() { return new Uint8Array(); }, readdir() { return []; },
          stat() { return { mode: 0, size: 0 }; }, unlink() {}, chmod() {}, isDir() { return false; },
        },
        runPython(code) {
          recorded = recorded || [];
          recorded.push({ kind: 'runPython', code });
          if (code.includes('sysconfig')) return '/lib/python3.12/site-packages';
          return undefined;
        },
        setStdout() {}, setStderr() {},
        loadPackage: async () => { recorded = recorded || []; recorded.push({ kind: 'loadPackage' }); },
      })),
    });
    vm.runInContext(PY_WORKER_SOURCE, c);
    const boot = vm.runInContext('ensureLockedPyodide()', c);
    vm.runInContext(`self.onmessage({ data: ${JSON.stringify({
      id: 1, cmd: 'bootstrap',
      assets: {
        'pyodide.js': { text: '/* unit stub: loadPyodide comes from the sandbox */' },
        'pyodide.asm.js': { text: 'var _createPyodideModule = function () {};' },
      },
      extensionModules,
    })} })`, c);
    return { boot, recorded: () => recorded, ctx: c };
  }

  {
    const w = bootWorker([
      { pluginId: 'synthetic-python-plugin', files: { 'locus_test_plugin.py': 'def answer():\n    return 42\n' }, imports: ['locus_test_plugin'] },
    ]);
    let bootErr = null;
    try { await w.boot; } catch (e) { bootErr = e; }
    check('W1 boot with a plugin payload succeeds', !bootErr, bootErr && bootErr.message);
    const rec = w.recorded() || [];
    const writes = rec.filter((r) => r.kind === 'write');
    const imports = rec.filter((r) => r.kind === 'runPython' && r.code.startsWith('import '));
    check('W2 plugin file written into site-packages',
      writes.length === 1 && writes[0].path === '/lib/python3.12/site-packages/locus_test_plugin.py'
      && String(writes[0].data).includes('return 42'), JSON.stringify(writes));
    check('W3 smoke import ran for the declared module', imports.some((r) => r.code === 'import locus_test_plugin'), JSON.stringify(imports));
    check('W4 runtime package load precedes plugin install', (() => {
      const i = rec.findIndex((r) => r.kind === 'loadPackage');
      const j = rec.findIndex((r) => r.kind === 'write');
      return i !== -1 && j !== -1 && i < j;
    })());
    check('W5 post-boot lockdown applied (worker fetch denied)', vm.runInContext(
      "(function () { try { fetch('http://127.0.0.1:9/probe'); return 'allowed'; } catch (e) { return 'denied'; } })()", w.ctx) === 'denied');
  }
  {
    const w = bootWorker([
      { pluginId: 'bad', files: { '../evil.py': 'x' }, imports: [] },
    ]);
    let err = null;
    try { await w.boot; } catch (e) { err = e; }
    check('W7 invalid payload path fails the boot closed', !!err && /invalid payload path/.test(err.message), err && err.message);
  }
  {
    const w = bootWorker([
      { pluginId: 'broken', files: { 'mod.py': 'raise ImportError("nope")\n' }, imports: ['mod'] },
    ], async () => ({
      FS: { mkdirTree() {}, writeFile() {}, readFile() { return new Uint8Array(); }, readdir() { return []; }, stat() { return { mode: 0, size: 0 }; }, unlink() {}, chmod() {}, isDir() { return false; } },
      runPython(code) {
        if (code.includes('sysconfig')) return '/lib/python3.12/site-packages';
        throw new Error('ModuleNotFoundError: no module named mod');
      },
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

  // Best-effort cleanup: the harness ENTRY exports the registration but
  // deliberately not the unregistration — the suite process exits here
  // anyway, so the suite-registered provider cannot leak anywhere.
  if (typeof harnessApi.unregisterPluginRuntimeProvider === 'function') {
    harnessApi.unregisterPluginRuntimeProvider('python');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('TEST RUNNER FAIL', e); process.exit(1); });
