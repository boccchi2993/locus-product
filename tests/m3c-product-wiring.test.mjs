// M3c-C: Product page-assembly / build-wiring test (Agent C's own suite).
//
// What it proves, WITHOUT agent A's or B's files being present:
//   PW1  the compat check accepts the REAL pinned cores' public
//        declarations (locus-runtime host.capabilities() +
//        locus-harness harnessCapabilities()) with the registryVersion
//        requirement deleted — and still rejects, BEFORE any side
//        effect, unsupported contract/port versions and missing
//        required capabilities; absent declarations are never compatible.
//   PW2  the page assembly loads NO classic script at all (M3c
//        integration: telemetry.js + markdown.js are ESM too):
//        index.html has ZERO classic page scripts and ONE module entry.
//   PW3  the store carries no classic-global dependency anymore: no
//        Model singleton, no __LOCUS_*_CORE__ table read, no deep
//        '../runtime/*' or '../harness/*' import, no globalThis
//        publish, no typeof-guard on an eliminated global.
//   PW4  every symbol store.js/main.js import from the two transfer
//        layers is really exported by the pinned package entries, and
//        every symbol imported from an A/B-converted Product module is
//        really defined at the top level of that module's CURRENT
//        source (names are taken from the code, never guessed — and
//        the ESM conversion contract keeps them).
//   PW5  the converted projector module actually runs as ESM (real
//        createConversation/projectEvent over a task's event sequence).
//   PW6  build-input changes: vite.config copies only the two remaining
//        classic page scripts; the e2e seams survive on real instances.
//
// Run: node tests/m3c-product-wiring.test.mjs
// (D registers it in tests/run-unit.cjs with the shared-suite wiring.)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}

// ============================================================
// PW1 — the compatibility gate against the REAL pinned cores
// ============================================================
const { createRuntime } = await import('locus-runtime');
const { PY_WORKER_SOURCE, GREP_WORKER_SOURCE } = await import('locus-runtime/worker-assets');
const { harnessCapabilities } = await import('locus-harness');
const {
  CompatibilityError, PRODUCT_CORE_REQUIREMENTS, checkCoreCompatibility,
} = await import('../src/product/core-compatibility.js');

const host = await createRuntime({
  workerAssets: { pyWorkerSource: PY_WORKER_SOURCE, grepWorkerSource: GREP_WORKER_SOURCE },
});
try {
  const runtimeDecl = host.capabilities();
  const harnessDecl = harnessCapabilities();

  check('PW1.runtime-decl-real', runtimeDecl.contractVersion === 1
    && Array.isArray(runtimeDecl.executionKinds) && runtimeDecl.commands.length > 0,
  JSON.stringify(runtimeDecl));
  check('PW1.harness-decl-real', harnessDecl.contractVersion === 1
    && !!harnessDecl.ports && harnessDecl.capabilities.taskEventIdentity === true,
  JSON.stringify({ contractVersion: harnessDecl.contractVersion }));
  check('PW1.harness-decl-has-no-registryVersion', harnessDecl.registryVersion === undefined,
  JSON.stringify(harnessDecl.registryVersion));

  // The requirement table itself no longer asks for the deleted
  // internal-registry version.
  check('PW1.no-supportedRegistryVersions',
    PRODUCT_CORE_REQUIREMENTS.harness.supportedRegistryVersions === undefined,
  JSON.stringify(PRODUCT_CORE_REQUIREMENTS.harness.supportedRegistryVersions));

  // The REAL pair passes — the M3c adaptation must not reject the actual
  // pinned cores.
  let ok = null;
  try { ok = checkCoreCompatibility({ runtime: runtimeDecl, harness: harnessDecl, requirements: PRODUCT_CORE_REQUIREMENTS }); } catch (e) { ok = e; }
  check('PW1.real-pair-compatible', !!ok && ok.compatible === true,
  ok instanceof Error ? (ok.code + ' ' + ok.message) : JSON.stringify(ok));
  check('PW1.result-no-registryVersion-projection',
    !!ok && ok.compatible === true && ok.harness.registryVersion === undefined && ok.runtime.registryVersion === undefined,
  JSON.stringify(ok));

  // A stray extra registryVersion on a declaration is an unknown EXTRA —
  // ignored, never a rejection (the deleted requirement must not linger
  // as a hidden semantic).
  let stray = null;
  try {
    stray = checkCoreCompatibility({
      runtime: runtimeDecl,
      harness: Object.assign({}, harnessDecl, { registryVersion: 999 }),
      requirements: PRODUCT_CORE_REQUIREMENTS,
    });
  } catch (e) { stray = e; }
  check('PW1.stray-registryVersion-ignored', !!stray && stray.compatible === true,
  stray instanceof Error ? (stray.code + ' ' + stray.message) : JSON.stringify(stray));

  // Required-missing / unsupported-version rejections still fire BEFORE
  // any side effect (the checker is pure and throws; prepareTask step (0)
  // is the only production caller and precedes every effect).
  function expectReject(name, input, code, extra) {
    try {
      checkCoreCompatibility({ requirements: PRODUCT_CORE_REQUIREMENTS, ...input });
      check(name, false, 'no error thrown');
    } catch (e) {
      check(name, e instanceof CompatibilityError && e.code === code && (extra ? extra(e) : true),
        e instanceof CompatibilityError ? e.code + ' ' + e.message : String(e));
    }
  }
  expectReject('PW1.reject-runtime-contract-999',
    { runtime: { ...runtimeDecl, contractVersion: 999 }, harness: harnessDecl },
    'contract_version_unsupported', (e) => e.core === 'runtime');
  expectReject('PW1.reject-harness-contract-999',
    { runtime: runtimeDecl, harness: { ...harnessDecl, contractVersion: 999 } },
    'contract_version_unsupported', (e) => e.core === 'harness');
  expectReject('PW1.reject-port-version-2',
    { runtime: runtimeDecl, harness: { ...harnessDecl, ports: { ...harnessDecl.ports, toolPort: { version: 2 } } } },
    'port_version_unsupported', (e) => e.port === 'toolPort');
  const noIdentity = { ...harnessDecl, capabilities: { ...harnessDecl.capabilities, taskEventIdentity: undefined } };
  delete noIdentity.capabilities.taskEventIdentity;
  expectReject('PW1.reject-missing-required-capability',
    { runtime: runtimeDecl, harness: noIdentity },
    'capability_missing', (e) => e.capability === 'taskEventIdentity');
  expectReject('PW1.reject-absent-runtime-declaration', { harness: harnessDecl },
    'declaration_missing', (e) => e.core === 'runtime');
  expectReject('PW1.reject-absent-harness-declaration', { runtime: runtimeDecl },
    'declaration_missing', (e) => e.core === 'harness');
  // registryVersion deletion must not weaken any other check: policy
  // mechanisms, bootstrap pinning and commands are still enforced.
  expectReject('PW1.reject-missing-authorization-mechanism',
    { runtime: { ...runtimeDecl, policyMechanisms: ['mutationPolicy'] }, harness: harnessDecl },
    'capability_missing', (e) => e.capability === 'policyMechanisms.authorization');
} finally {
  host.dispose('test end');
}

// ============================================================
// PW2 — the page loads no classic script at all (M3c integration:
// telemetry.js and ui/markdown.js are ES modules too — the page is
// ONE module entry and nothing else)
// ============================================================
const html = read('index.html');
const classicTags = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const moduleTags = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]);
check('PW2.zero-classic-scripts',
  classicTags.length === 0,
  JSON.stringify(classicTags));
check('PW2.one-module-entry', moduleTags.length === 1 && moduleTags[0] === '/src/main.js',
  JSON.stringify(moduleTags));
const forbiddenPages = [
  'persistence.js', 'model-adapters.js', 'model.js', 'workspace.js', 'vfs.js',
  'conversation-history-workspace.js', 'extension-composition.js', 'extensions.js',
  'capability-package.js', 'attachments.js', 'capabilities.js', 'network.js',
  'shell.js', 'tools.js', 'approval.js', 'agent.js', 'mutation-policy.js',
  'ui/projector.js', 'runtime/', 'harness/',
];
check('PW2.no-core-classic-tag',
  forbiddenPages.every((f) => !classicTags.some((t) => t.includes(f))),
  JSON.stringify(classicTags.filter((t) => forbiddenPages.some((f) => t.includes(f)))));

// ============================================================
// PW3 — the store/main carry no classic-global dependency
// ============================================================
const store = read('src/ui/store.js');
const main = read('src/main.js');

const bannedInStore = [
  '__LOCUS_RUNTIME_CORE__', '__LOCUS_HARNESS_CORE__', '__LOCUS_HARNESS_REPLAY_VALIDATION__',
  'new Model', 'globalThis.Model',
  "typeof Model === 'undefined'", "typeof Model !== 'undefined'",
  "typeof VirtualWorkspace === 'undefined'", "typeof SHELL_COMMANDS === 'undefined'",
  "typeof LocusProjector === 'undefined'", "typeof Telemetry === 'undefined'",
  "typeof AttachmentStore === 'undefined'", "typeof CapabilityManager === 'undefined'",
  "typeof executeTool === 'undefined'", "typeof AGENT_TOOL_DEFINITIONS === 'undefined'",
  "typeof LocusMutationPolicy === 'undefined'", "typeof getProviderAdapter === 'undefined'",
  "typeof PersistenceServiceInstance === 'undefined'",
  "typeof ConversationHistoryWorkspace === 'undefined'",
  "typeof SkillInstanceStorage === 'undefined'", "typeof SkillInstanceWorkspace === 'undefined'",
  "typeof OPFSWorkspace === 'undefined'", "typeof LocalDirectoryWorkspace === 'undefined'",
  "typeof ensureWorkspacePermission === 'undefined'",
  'eval(', 'new Function(',
];
// `productModel.` is the Product-owned state — a bare-global `Model.` read
// is one NOT preceded by an identifier char or a dot.
const bareModelRead = /(^|[^\w.])Model\.(apiKey|apiBase|model|proxy|dialect|transport)/.test(store);
check('PW3.store-no-classic-global',
  bannedInStore.every((b) => !store.includes(b)) && !bareModelRead,
  JSON.stringify({ banned: bannedInStore.filter((b) => store.includes(b)), bareModelRead }));
check('PW3.store-no-deep-core-import',
  !/from '\.\.\/runtime\//.test(store) && !/from '\.\.\/harness\//.test(store),
  (store.match(/from '\.\.\/(runtime|harness)\//g) || []).join(','));
check('PW3.store-no-globalThis-publish',
  !/globalThis\.\w+\s*=/.test(store) && !/window\.\w+\s*=(?!=)/.test(store.replace(/window\.__LOCUS_HOOKS__ = hooks/g, '')),
  (store.match(/globalThis\.\w+\s*=|window\.\w+\s*=/g) || []).join(','));
check('PW3.store-through-transfer-layers',
  (store.match(/from '\.\.\/product\/runtime-api\.js'/g) || []).length === 1
  && (store.match(/from '\.\.\/product\/harness-api\.js'/g) || []).length === 1);

// The model settings are Product-owned state; the transport seam is an
// explicit Product port. The harness captures per request entry.
check('PW3.model-state-product-owned',
  /const productModel = \{/.test(store)
  && /export function setProductModelTransport\(/.test(store)
  && /relayEligible: \(\) =>/.test(store)
  && !bareModelRead);

// main.js: the wire fake installs through the explicit port; the harness
// declaration comes through the transfer layer.
check('PW3.main-transport-seam-explicit',
  /ui\.setProductModelTransport\(/.test(main) && !/Model\.transport/.test(main));
check('PW3.main-through-transfer-layer',
  /from '\.\/product\/harness-api\.js'/.test(main) && !/from '\.\/harness\//.test(main));

// The compatibility check still sits at prepareTask step (0) — before the
// image build and before required persistence, in source order.
const gatePos = store.indexOf('checkCoreCompatibility(');
const imagePos = store.indexOf('const imageBuild = await buildImageUserContent(');
const userMsgPos = store.indexOf('await persistenceContext.onUserMessage(');
check('PW3.gate-precedes-side-effects',
  gatePos > -1 && imagePos > -1 && userMsgPos > -1 && gatePos < imagePos && gatePos < userMsgPos,
  JSON.stringify({ gatePos, imagePos, userMsgPos }));

// ============================================================
// PW4 — every imported symbol really exists (entries + current sources)
// ============================================================
function entryExports(relPath) {
  const src = read(relPath);
  const names = new Set();
  // export { A, B } from / export { A, B } blocks
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
  return names;
}
const harnessExports = entryExports('node_modules/locus-harness/src/index.js');
const runtimeRootExports = entryExports('node_modules/locus-runtime/src/index.js');
const runtimeWsExports = entryExports('node_modules/locus-runtime/src/workspace-api.js');
const runtimeWorkerExports = entryExports('node_modules/locus-runtime/src/worker-assets.js');
const runtimeExports = new Set([...runtimeRootExports, ...runtimeWsExports, ...runtimeWorkerExports]);

function importBlock(src, specifier) {
  const re = new RegExp("import\\s*\\{([^}]*)\\}\\s*from\\s*'" + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "'", 'g');
  const out = [];
  for (const m of src.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) out.push(name);
    }
  }
  return out;
}

const harnessImports = importBlock(store, '../product/harness-api.js');
const missingHarness = harnessImports.filter((n) => !harnessExports.has(n));
check('PW4.harness-imports-exported',
  harnessImports.length > 0 && missingHarness.length === 0,
  'missing: ' + JSON.stringify(missingHarness));

const runtimeImports = importBlock(store, '../product/runtime-api.js');
// `runtimeWorkerAssets` is not a package symbol — it is the FROZEN
// namespace re-export of 'locus-runtime/worker-assets' that agent A's
// transfer layer provides (handoff §3); the two worker-source members are
// checked as real exports below.
const runtimeAccepted = new Set([...runtimeExports, 'runtimeWorkerAssets']);
const missingRuntime = runtimeImports.filter((n) => !runtimeAccepted.has(n));
check('PW4.runtime-imports-exported',
  runtimeImports.length > 0 && missingRuntime.length === 0,
  'missing: ' + JSON.stringify(missingRuntime));
check('PW4.worker-assets-namespace-members',
  runtimeWorkerExports.has('PY_WORKER_SOURCE') && runtimeWorkerExports.has('GREP_WORKER_SOURCE')
  && /runtimeWorkerAssetBundle\.PY_WORKER_SOURCE/.test(store)
  && /runtimeWorkerAssetBundle\.GREP_WORKER_SOURCE/.test(store));

// A/B-converted Product modules: the import names must exist as top-level
// definitions in the CURRENT classic source (the conversion contract
// preserves them — this is the no-guessed-API proof, valid before AND
// after A/B land).
function definesTopLevel(src, name) {
  const re = new RegExp('(?:^|\\n)(?:export\\s+)?(?:async\\s+function|function|class|const|let|var)\\s+' + name + '\\b');
  return re.test(src);
}
const abModuleImports = [
  ['src/tools.js', importBlock(store, '../tools.js')],
  ['src/mutation-policy.js', importBlock(store, '../mutation-policy.js')],
  ['src/attachments.js', importBlock(store, '../attachments.js')],
  ['src/persistence.js', importBlock(store, '../persistence.js')],
  ['src/extensions.js', importBlock(store, '../extensions.js')],
  ['src/conversation-history-workspace.js', importBlock(store, '../conversation-history-workspace.js')],
];
for (const [file, names] of abModuleImports) {
  const src = read(file);
  const missing = names.filter((n) => !definesTopLevel(src, n));
  check('PW4.ab-symbol-defined:' + file,
    names.length > 0 && missing.length === 0,
    'imported ' + JSON.stringify(names) + ' missing: ' + JSON.stringify(missing));
}
const mainToolImports = importBlock(main, './tools.js');
const missingMainTools = mainToolImports.filter((n) => !definesTopLevel(read('src/tools.js'), n));
check('PW4.main-tools-import-defined', mainToolImports.length > 0 && missingMainTools.length === 0,
  'missing: ' + JSON.stringify(missingMainTools));

// ============================================================
// PW5 — the converted projector module really runs as ESM
// ============================================================
const { LocusProjector } = await import('../src/ui/projector.js');
check('PW5.projector-esm-export', !!LocusProjector && typeof LocusProjector.projectEvent === 'function');
{
  const conv = LocusProjector.createConversation('pw5-conv');
  LocusProjector.projectEvent(conv, { type: 'task_start', taskId: 't1' });
  LocusProjector.projectEvent(conv, { type: 'tool_call', taskId: 't1', toolCallId: 'c1', tool: 'bash', input: 'echo hi' });
  LocusProjector.projectEvent(conv, { type: 'tool_result', taskId: 't1', toolCallId: 'c1', output: 'hi', success: true });
  LocusProjector.projectEvent(conv, { type: 'task_end', taskId: 't1', reason: 'completed' });
  const toolItem = conv.items.find((i) => i.kind === 'tool');
  check('PW5.projector-timeline',
    conv.runState === 'idle'
      && !!toolItem && toolItem.tool === 'bash'
      && !!toolItem.result && toolItem.result.success === true && toolItem.result.output === 'hi',
    JSON.stringify({ runState: conv.runState, items: conv.items.map((i) => i.kind), toolItem }));
}

// ============================================================
// PW6 — build inputs and the e2e seams
// ============================================================
const vite = read('vite.config.js');
const runScripts = [...vite.matchAll(/'([^']+)'/g)].map((m) => m[1])
  .filter((s) => s.startsWith('src/'));
check('PW6.copy-list-empty',
  runScripts.length === 0,
  JSON.stringify(runScripts));
const buildInputs = read('vite.config.js');
check('PW6.test-host-pages-still-built',
  buildInputs.includes("'tests/runtime-host.html'") && buildInputs.includes("'tests/harness-host.html'"));
check('PW6.e2e-seams-real-instances',
  /window\.__locus\.runtimeHost = \(\) => ui\.runtimeHost\(\)/.test(main)
  && /window\.__locus\.harnessCapabilities = \(\) => harnessCapabilities\(\)/.test(main)
  && /window\.__locus\.runtimeAssets = \(\) => ui\.runtimeWorkerAssets\(\)/.test(main)
  && /window\.executeTool = executeTool;/.test(main));

console.log(`\nm3c-product-wiring: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
