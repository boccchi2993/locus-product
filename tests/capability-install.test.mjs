// Capability package install service tests (C1-P2, node, NO DOM):
// docs/CAPABILITY-INSTALL.md §3–§8 + DECISIONS.md D10, over the REAL
// locus-archive container, the REAL package core, the REAL harness
// CapabilityManager (upgraded locus-harness: registerPackage /
// unregisterPackage / wheel payload / §6.3 skill-instance upgrade rule)
// and the REAL PersistenceService in its memory mode.
//
//   CI1  inspect a valid new package: kind 'new', full summary, ZERO writes
//   CI2  commit: record + registration + stored bytes re-read cleanly
//   CI3  enable/disable persist into the installed record (store level)
//   CI4  restart: the package reloads registered and enabled, no notices
//   CI5  boot-time tamper detection → mismatch notice → accept repins
//   CI6  “本次跳过”: dismiss drops the notice only; it re-appears on reload
//   CI7  corrupt bytes → 'corrupt'; accept throws; uninstall cleans up
//   CI8  closed manifest list: extra / missing file both refuse
//   CI9  import-time hash drift: commit refuses without acceptMismatch;
//        with it, the manifest is repinned to the actual bytes
//   CI10 same id+version+digest → 'same', commit reports unchanged
//   CI11 version replacement: user skill edits survive, dropped skill
//        stays as an orphan, new skill gets its default, v1 bytes deleted
//   CI12 replacement failure rolls back: conflicting plugin registration
//        restores v1 registered + enabled, v2 bytes removed
//   CI13 uninstall: records/bytes/registration gone, skill instances kept
//   CI14 MODEL UNREACHABLE (adversarial, A-class): no VFS mount (page or
//        task fork) can see the package bytes, LOCUS.md or the
//        capability-packages directory; the shell cannot either
//   CI15 python payload: the enabled capability's wheel bytes are the
//        fixture wheel byte-for-byte
//   CI16 .locus path import via VFS; a non-.locus path is refused
//   CI17 a harness generation without the capabilityPackages declaration:
//        import refuses loudly, boot leaves installed packages untouched
//   CI18 schema 4: reset() wipes records + bytes; clearConversations keeps
//   CI19 memory mode lists durable === false
//   CI20 a stale commit token reports the inspection as expired
//   CI21 F1 fix: version replacement re-enables a package the boot
//        verification skipped (wasEnabled from the record's enabled bit)
//   CI22 F2 fix: capabilityPackageList is read-only — no idle gate, works
//        while a task runs
//   CI23 beginCapabilityImportFromBytes: valid → summary, bad → diagnostics
//   CI24 confirmCapabilityImport: installs + clears the dialog + refreshes
//        the list; a refused commit keeps the dialog with the error
//   CI25 cancelCapabilityImport: drops the dialog, writes nothing
//
// Service-level cases drive createCapabilityPackages directly (real
// CapabilityManager + memory PersistenceService, per
// tests/capability-composition.test.cjs and tests/persistence.test.cjs).
// Store-level cases follow tests/max-tokens-settings.test.cjs (fake
// sessionStorage, ?scenario=N re-imports; "restart" = re-import over the
// SAME persistence singleton with reset: false).
//
// Run: node tests/capability-install.test.mjs

import fs from 'node:fs';
import crypto from 'node:crypto';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function section(label) { console.log('=== ' + label); }

const rejectionOf = (p) => p.then(() => null, (e) => e);
const sha256HexNode = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function bytesEqual(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// Deep file-URL import: runShellCommand is package-internal (not in the
// locus-runtime exports map) — the same pattern as
// tests/history-tool-outputs.test.mjs, used only by CI14's shell probe.
const shellMod = await import(new URL('../node_modules/locus-runtime/src/shell.js', import.meta.url).href);
const runShellCommand = shellMod.runShellCommand;

// ---- modules under test ----
const LA = await import('../src/locus-archive.js');
const harnessApi = await import('../src/product/harness-api.js');
const runtimeApi = await import('../src/product/runtime-api.js');
const ext = await import('../src/extensions.js');
const persistenceMod = await import('../src/persistence.js');
const svcMod = await import('../src/capability-packages.js');
const credSvcMod = await import('../src/credentials.js');

const CAP_ID = 'ci-capability';
const OTHER_CAP_ID = 'other-capability';
const PLUGIN_ID = 'ci-plugin';
const MARKER = 'LOCUS-MD-MARKER-7f3a';
const WHEEL_NAME = 'ci_plugin-1.0.0-py3-none-any.whl';

// C3 fixture credential declarations (v1 and a binding-changed v2).
const CRED_DECL_V1 = [{
  name: 'CI_CRED_KEY', label: 'CI credential', description: 'TEST ONLY.',
  origin: 'https://api.example.test', pathPrefix: '/v1/tools/',
  header: 'Authorization', scheme: 'Bearer',
}];
const CRED_DECL_V2 = [Object.assign({}, CRED_DECL_V1[0], { pathPrefix: '/v2/tools/' })];

// ---------- fixture builders ----------

// Deterministic pseudo wheel bytes. The package core validates the
// DECLARED format only (CAPABILITY-PACKAGE §2b.6: "a declared-shape check
// only") and registerPackage re-hashes the bytes — no zip structure needed.
function wheelBytes(seed) {
  const bytes = new Uint8Array(512);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + seed * 7 + seed) % 251;
  return bytes;
}

function skillBody(id, version) {
  return '# ' + id + ' guidance\n\nDEFAULT-BODY-' + id + '-v' + version + '\n';
}

async function projectWorkspace({ id = CAP_ID, version = '1.0.0', pluginId = PLUGIN_ID,
  skillIds = ['skill-a', 'skill-b'], skillBodies = null, wheelSeed = 1, credentials = null } = {}) {
  const ws = runtimeApi.createMemoryWorkspace({
    maxBytes: LA.LOCUS_LIMITS.maxTotalBytes,
    maxFileBytes: LA.LOCUS_LIMITS.maxFileBytes,
  });
  const capabilityDescriptor = {
    id, version,
    displayName: 'CI Capability ' + id,
    description: 'TEST ONLY fixture for the capability install service.',
    plugins: [pluginId],
    skills: skillIds.slice(),
    mcps: [],
  };
  if (credentials) capabilityDescriptor.credentials = credentials;
  const capabilities = {
    schemaVersion: 1,
    capability: capabilityDescriptor,
  };
  await ws.write('capability.json', JSON.stringify(capabilities, null, 2) + '\n');
  await ws.write('plugins/' + pluginId + '/plugin.json', JSON.stringify({
    schemaVersion: 1,
    plugin: {
      id: pluginId, version: '1.0.0',
      displayName: 'CI Plugin', description: 'TEST ONLY wheel fixture.',
      runtime: 'python', authority: 'none',
      provides: { pythonImports: ['ci_plugin'] },
    },
    artifacts: [{ path: 'artifacts/' + WHEEL_NAME, format: 'python-wheel' }],
  }, null, 2) + '\n');
  await ws.write('plugins/' + pluginId + '/artifacts/' + WHEEL_NAME, wheelBytes(wheelSeed));
  for (const s of skillIds) {
    await ws.write('skills/' + s + '/skill.json', JSON.stringify({
      schemaVersion: 1,
      skill: { id: s, version: '1', displayName: 'Skill ' + s, description: 'TEST ONLY.' },
      source: 'SKILL.md',
    }, null, 2) + '\n');
    const body = skillBodies && skillBodies[s] !== undefined ? skillBodies[s] : skillBody(s, '1');
    await ws.write('skills/' + s + '/SKILL.md', body);
  }
  return ws;
}

async function packProject(opts = {}) {
  const ws = await projectWorkspace(opts);
  const body = '# ' + (opts.id || CAP_ID) + '\n\nThe marker lives here: ' + MARKER + '\n\n'
    + '## 更改记录\n\n- ' + (opts.version || '1.0.0') + '（2026-10-17）：首个版本\n';
  const packed = await LA.packLocus({
    workspace: ws, root: '', author: 'ci-suite',
    purpose: 'capability install service tests', body,
  });
  if (!packed.ok) throw new Error('fixture pack failed: ' + JSON.stringify(packed.diagnostics));
  return packed; // { ok, bytes, manifest }
}

// An archive whose bytes disagree with its own manifest on ONE file
// (CRC intact — the container is valid, the content drifted).
async function packWithDrift(opts = {}) {
  const packed = await packProject(opts);
  const read = await LA.readLocusArchive(packed.bytes);
  if (!read.ok) throw new Error('fixture re-read failed');
  const parsed = LA.parseLocusMd(read.locusMd);
  const files = read.files;
  const target = 'skills/skill-a/SKILL.md';
  files.set(target, new TextEncoder().encode('drifted bytes\n'));
  const manifest = parsed.manifest;
  const locusMd = LA.renderLocusMd({ body: parsed.body, manifest });
  return { bytes: await LA.writeLocusArchive(files, locusMd), manifest, driftedPath: target };
}

// An archive carrying ONE file its manifest does not list (or missing one
// it does) — the closed list refuses, mismatched hashes would not matter.
async function packWithExtraFile() {
  const packed = await packProject();
  const read = await LA.readLocusArchive(packed.bytes);
  const parsed = LA.parseLocusMd(read.locusMd);
  const files = new Map(read.files);
  files.set('extra.txt', new TextEncoder().encode('not listed anywhere\n'));
  return LA.writeLocusArchive(files, LA.renderLocusMd({ body: parsed.body, manifest: parsed.manifest }));
}
async function packWithMissingFile() {
  const packed = await packProject();
  const read = await LA.readLocusArchive(packed.bytes);
  const parsed = LA.parseLocusMd(read.locusMd);
  const files = new Map(read.files);
  files.delete('skills/skill-b/SKILL.md');
  return LA.writeLocusArchive(files, LA.renderLocusMd({ body: parsed.body, manifest: parsed.manifest }));
}

// ---------- service-level rig ----------

// Fixed clock: deterministic installed/updated timestamps.
const SERVICE_NOW = () => '2026-10-17T10:00:00.000Z';

function serviceRig(opts = {}) {
  const persistence = opts.persistence || new persistenceMod.PersistenceService();
  const home = runtimeApi.createMemoryWorkspace({ name: 'home', dirs: ['.skills'] });
  // instances === null: the C3 enable-failure rig (a capability with
  // skills cannot materialize → manager.enable lands in state 'error').
  const storage = opts.instances === null ? null : new ext.SkillInstanceStorage({ resolveHome: () => home });
  const manager = new harnessApi.CapabilityManager({
    catalogs: {
      capabilities: harnessApi.CAPABILITY_CATALOG,
      plugins: harnessApi.PLUGIN_CATALOG,
      skills: harnessApi.SKILL_CATALOG,
      mcps: harnessApi.MCP_CATALOG,
    },
    sources: new harnessApi.SkillSourceStore(),
    instances: storage,
  });
  // C3: the credentials service rides the SAME manager (the real default
  // composition; credentials === false exercises the no-service wiring).
  const credentials = opts.credentials === false
    ? null
    : credSvcMod.createCredentialService({ persistence, manager });
  const service = svcMod.createCapabilityPackages({ persistence, manager, now: SERVICE_NOW, credentials });
  return { persistence, manager, home, storage, service, credentials };
}

async function installViaService(rig, packed, opts = {}) {
  const summary = await rig.service.inspect(packed.bytes);
  if (!summary.ok) throw new Error('fixture inspect failed: ' + JSON.stringify(summary.diagnostics));
  const commit = await rig.service.commit(summary.token, opts);
  return { summary, commit };
}

const recordOf = async (persistence, id) => {
  const rows = await persistence.loadCapabilityPackages();
  return rows.find((r) => r.id === id) || null;
};

// ---------- store-level rig (tests/max-tokens-settings.test.cjs style) ----------

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
const sharedPersistence = persistenceMod.PersistenceServiceInstance;
async function loadStore(sessionData, { reset = true } = {}) {
  globalThis.sessionStorage = fakeSessionStorage(sessionData || null);
  if (reset) await sharedPersistence.reset();
  scenarioCounter++;
  return import('../src/ui/store.js?scenario=' + scenarioCounter);
}

async function installViaStore(m, packed, opts = {}) {
  const summary = await m.inspectCapabilityPackage(packed.bytes);
  if (!summary.ok) throw new Error('fixture inspect failed: ' + JSON.stringify(summary.diagnostics));
  const commit = await m.commitCapabilityPackage(summary.token, {});
  if (opts.enable) await m.enableCapability(summary.id);
  return { summary, commit };
}

// A harness declaration that satisfies every required port/capability and
// the pre-C1 optional set, with capabilityPackages toggleable off
// (CI17) — the same construction family as
// tests/context-management-wiring.test.mjs harnessDeclarationVariant.
function harnessDeclarationVariant({ capabilityPackages = true } = {}) {
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
  };
  if (capabilityPackages) capabilities.capabilityPackages = true;
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

// ============================================================
(async () => {
  // ---------- CI1. inspect a valid new package ----------
  {
    section('CI1 inspect: valid new package, zero writes');
    const rig = serviceRig();
    const packed = await packProject();
    const s = await rig.service.inspect(packed.bytes);
    const expectedDigest = await LA.manifestDigest(packed.manifest);
    check('CI1 inspect ok + kind new', s.ok === true && s.kind === 'new' && typeof s.token === 'string' && s.token.length > 0,
      JSON.stringify(s.ok ? { kind: s.kind } : s.diagnostics));
    check('CI1 summary identity fields',
      s.id === CAP_ID && s.version === '1.0.0' && s.author === 'ci-suite'
      && s.purpose === 'capability install service tests',
      JSON.stringify({ id: s.id, version: s.version }));
    check('CI1 body carries the fixture marker', typeof s.body === 'string' && s.body.includes(MARKER));
    check('CI1 digest equals the manifest digest, no mismatch flag',
      s.digest === expectedDigest && Array.isArray(s.mismatched) && s.mismatched.length === 0
      && s.needsMismatchAcceptance === false,
      JSON.stringify({ digest: s.digest, expectedDigest }));
    check('CI1 components summary',
      s.components.plugins.length === 1 && s.components.plugins[0].id === PLUGIN_ID
      && s.components.plugins[0].displayName === 'CI Plugin'
      && JSON.stringify(s.components.skills.map((x) => x.id)) === JSON.stringify(['skill-a', 'skill-b'])
      && Array.isArray(s.components.mcps) && s.components.mcps.length === 0,
      JSON.stringify(s.components));
    check('CI1 fileCount/totalBytes/orphans/existing',
      s.fileCount === 7 && s.totalBytes > 0 && s.orphanedSkills.length === 0 && s.existing === null,
      JSON.stringify({ fileCount: s.fileCount, totalBytes: s.totalBytes }));
    check('CI1 inspect wrote nothing: no records, no registration',
      (await rig.persistence.loadCapabilityPackages()).length === 0
      && rig.manager.isPackage(CAP_ID) === false);
  }

  // ---------- CI2. commit ----------
  {
    section('CI2 commit: record, registration, stored bytes');
    const rig = serviceRig();
    const packed = await packProject();
    const { summary, commit } = await installViaService(rig, packed);
    // C3 O1 (owner decision, 2026-10-18): a FIRST install auto-enables.
    // Was: commit.state === 'disabled' → now the commit lands enabled.
    check('CI2 commit result (C3 O1: first install auto-enables)',
      commit.id === CAP_ID && commit.unchanged === false
      && commit.state === 'ready' && commit.enabled === true, JSON.stringify(commit));
    const record = await recordOf(rig.persistence, CAP_ID);
    check('CI2 record written enabled + verified (C3 O1: was enabled === false)',
      !!record && record.enabled === true
      && record.verification === 'ok' && record.version === '1.0.0' && record.digest === summary.digest,
      JSON.stringify(record && { enabled: record.enabled, verification: record.verification }));
    check('CI2 registered and listed enabled (C3 O1: was disabled)',
      rig.manager.isPackage(CAP_ID) === true
      && rig.manager.listCapabilities().some((c) => c.id === CAP_ID && c.state === 'ready' && c.enabled === true));
    const stored = await rig.persistence.readCapabilityPackageBytes(CAP_ID, record.digest);
    const reread = await LA.readLocusArchive(stored);
    const reparsed = reread.ok ? LA.parseLocusMd(reread.locusMd) : null;
    check('CI2 stored bytes re-read to the same manifest', reread.ok && reparsed.ok
      && reparsed.manifest.id === CAP_ID && reparsed.manifest.version === '1.0.0'
      && reparsed.manifest.files.length === packed.manifest.files.length);
  }

  // ---------- CI3. enable state persistence (store level) ----------
  {
    section('CI3 enable/disable persists into the record');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    const { summary } = await installViaStore(m, packed);
    await m.enableCapability(summary.id);
    let record = await recordOf(sharedPersistence, CAP_ID);
    check('CI3 enableCapability sets enabled=true', !!record && record.enabled === true,
      JSON.stringify(record && record.enabled));
    await m.disableCapability(summary.id);
    record = await recordOf(sharedPersistence, CAP_ID);
    check('CI3 disableCapability sets enabled=false', !!record && record.enabled === false,
      JSON.stringify(record && record.enabled));
  }

  // ---------- CI4. restart recovery (store level) ----------
  {
    section('CI4 restart: package reloads registered and enabled');
    const packed = await packProject();
    {
      const m = await loadStore(null);
      await m.whenBooted;
      await installViaStore(m, packed, { enable: true });
    }
    {
      const m = await loadStore(null, { reset: false }); // the "restart"
      await m.whenBooted;
      check('CI4 package registered after restart', m.capabilityManager.isPackage(CAP_ID) === true);
      const listed = m.store.capabilities.find((c) => c.id === CAP_ID);
      check('CI4 enabled state restored (ready)', !!listed && listed.enabled === true && listed.state === 'ready',
        JSON.stringify(listed && { enabled: listed.enabled, state: listed.state }));
      check('CI4 no notices after a clean reload', m.store.capabilityPackageNotices.length === 0,
        JSON.stringify(m.store.capabilityPackageNotices));
    }
  }

  // ---------- CI5. boot-time tamper detection + accept ----------
  {
    section('CI5 tampered bytes → mismatch notice → accept repins');
    const packed = await packProject();
    let originalDigest = null;
    {
      const m = await loadStore(null);
      await m.whenBooted;
      const { summary } = await installViaStore(m, packed, { enable: true });
      originalDigest = summary.digest;
      // Forge: same manifest (so the record digest still matches), one
      // file's bytes changed — valid container, drifted content.
      const read = await LA.readLocusArchive(packed.bytes);
      const files = new Map(read.files);
      files.set('skills/skill-a/SKILL.md', new TextEncoder().encode('tampered by the adversary\n'));
      const forged = await LA.writeLocusArchive(files, read.locusMd);
      await sharedPersistence.writeCapabilityPackageBytes(CAP_ID, originalDigest, forged);
    }
    {
      const m = await loadStore(null, { reset: false });
      await m.whenBooted;
      const n = m.store.capabilityPackageNotices.find((x) => x.id === CAP_ID);
      check('CI5 restart reports the mismatch and does not register',
        !!n && n.status === 'mismatch'
        && JSON.stringify(n.mismatched) === JSON.stringify(['skills/skill-a/SKILL.md'])
        && m.capabilityManager.isPackage(CAP_ID) === false,
        JSON.stringify(m.store.capabilityPackageNotices));
      const record = await recordOf(sharedPersistence, CAP_ID);
      check('CI5 record marked mismatch-skipped', !!record && record.verification === 'mismatch-skipped');
      let acceptErr = null;
      try { await m.acceptCapabilityPackageMismatch(CAP_ID); } catch (e) { acceptErr = e; }
      check('CI5 accept repins and registers', acceptErr === null
        && m.capabilityManager.isPackage(CAP_ID) === true,
        acceptErr && String(acceptErr));
      const updated = await recordOf(sharedPersistence, CAP_ID);
      const bodyHasChangelog = !!updated && typeof updated.body === 'string'
        && updated.body.includes('导入时内容与元文件不一致，用户确认接受：skills/skill-a/SKILL.md');
      check('CI5 record body carries the accepted-mismatch changelog line',
        bodyHasChangelog && updated.digest !== originalDigest && updated.verification === 'ok',
        JSON.stringify({ digestChanged: updated && updated.digest !== originalDigest }));
      const oldGone = await rejectionOf(sharedPersistence.readCapabilityPackageBytes(CAP_ID, originalDigest));
      check('CI5 old digest bytes deleted', !!oldGone && oldGone.name === 'NotFoundError',
        oldGone && oldGone.name);
      check('CI5 notices cleared after accept', m.store.capabilityPackageNotices.length === 0);
      const stored = await sharedPersistence.readCapabilityPackageBytes(CAP_ID, updated.digest);
      const reread = await LA.readLocusArchive(stored);
      const repinned = reread.ok ? LA.parseLocusMd(reread.locusMd) : null;
      check('CI5 stored manifest now pins the actual bytes', !!repinned && repinned.ok
        && repinned.manifest.id === CAP_ID
        && (await LA.verifyLocusFiles(repinned.manifest, reread.files)).mismatched.length === 0);
    }
  }

  // ---------- CI6. dismiss (“本次跳过”) ----------
  {
    section('CI6 dismiss: notice dropped only; re-appears on next reload');
    const packed = await packProject();
    let digest = null;
    {
      const m = await loadStore(null);
      await m.whenBooted;
      const { summary } = await installViaStore(m, packed);
      digest = summary.digest;
      const read = await LA.readLocusArchive(packed.bytes);
      const files = new Map(read.files);
      files.set('skills/skill-b/SKILL.md', new TextEncoder().encode('tampered again\n'));
      await sharedPersistence.writeCapabilityPackageBytes(CAP_ID, digest,
        await LA.writeLocusArchive(files, read.locusMd));
    }
    {
      const m = await loadStore(null, { reset: false });
      await m.whenBooted;
      check('CI6 mismatch notice queued', m.store.capabilityPackageNotices.length === 1
        && m.store.capabilityPackageNotices[0].id === CAP_ID
        && m.store.capabilityPackageNotices[0].status === 'mismatch');
      m.dismissCapabilityPackageNotice(CAP_ID);
      const record = await recordOf(sharedPersistence, CAP_ID);
      check('CI6 dismiss leaves storage untouched',
        m.store.capabilityPackageNotices.length === 0
        && !!record && record.digest === digest && record.verification === 'mismatch-skipped'
        && m.capabilityManager.isPackage(CAP_ID) === false,
        JSON.stringify(record && { digest: record.digest, verification: record.verification }));
    }
    {
      const m = await loadStore(null, { reset: false });
      await m.whenBooted;
      check('CI6 the notice re-appears on the next reload',
        m.store.capabilityPackageNotices.length === 1
        && m.store.capabilityPackageNotices[0].status === 'mismatch');
    }
  }

  // ---------- CI7. corrupt bytes ----------
  {
    section('CI7 corrupt bytes → corrupt; accept throws; uninstall cleans');
    const packed = await packProject();
    let digest = null;
    {
      const m = await loadStore(null);
      await m.whenBooted;
      const { summary } = await installViaStore(m, packed);
      digest = summary.digest;
      const garbage = new Uint8Array(64);
      for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 97 + 13) % 256;
      await sharedPersistence.writeCapabilityPackageBytes(CAP_ID, digest, garbage);
    }
    {
      const m = await loadStore(null, { reset: false });
      await m.whenBooted;
      const n = m.store.capabilityPackageNotices.find((x) => x.id === CAP_ID);
      check('CI7 corrupt bytes reported as corrupt', !!n && n.status === 'corrupt',
        JSON.stringify(m.store.capabilityPackageNotices));
      const acceptErr = await rejectionOf(m.acceptCapabilityPackageMismatch(CAP_ID));
      check('CI7 accept refuses a non-mismatch skip', !!acceptErr, acceptErr && acceptErr.message);
      const uninstallErr = await rejectionOf(m.uninstallCapabilityPackage(CAP_ID));
      check('CI7 uninstall succeeds', uninstallErr === null, uninstallErr && String(uninstallErr));
      check('CI7 record and bytes are gone',
        (await recordOf(sharedPersistence, CAP_ID)) === null
        && (await rejectionOf(sharedPersistence.readCapabilityPackageBytes(CAP_ID, digest)))?.name === 'NotFoundError'
        && m.capabilityManager.isPackage(CAP_ID) === false
        && m.store.capabilityPackageNotices.length === 0);
    }
  }

  // ---------- CI8. closed manifest list ----------
  {
    section('CI8 closed list: extra / missing file both refuse');
    const rig = serviceRig();
    const extraBytes = await packWithExtraFile();
    const r1 = await rig.service.inspect(extraBytes);
    check('CI8 extra file refused with capability_closed_list', r1.ok === false
      && r1.diagnostics.some((d) => d.code === 'capability_closed_list'),
      JSON.stringify(r1.ok ? 'unexpected pass' : r1.diagnostics));
    const missingBytes = await packWithMissingFile();
    const r2 = await rig.service.inspect(missingBytes);
    check('CI8 missing file refused with capability_closed_list', r2.ok === false
      && r2.diagnostics.some((d) => d.code === 'capability_closed_list'),
      JSON.stringify(r2.ok ? 'unexpected pass' : r2.diagnostics));
    check('CI8 refusals wrote nothing', (await rig.persistence.loadCapabilityPackages()).length === 0);
  }

  // ---------- CI9. import-time hash drift ----------
  {
    section('CI9 hash drift: commit needs acceptMismatch, then repins');
    const rig = serviceRig();
    const drifted = await packWithDrift();
    const s = await rig.service.inspect(drifted.bytes);
    check('CI9 inspect flags the drift', s.ok === true && s.needsMismatchAcceptance === true
      && JSON.stringify(s.mismatched) === JSON.stringify([drifted.driftedPath]),
      JSON.stringify(s.ok ? { mismatched: s.mismatched } : s.diagnostics));
    const refused = await rejectionOf(rig.service.commit(s.token, {}));
    check('CI9 commit without acceptMismatch throws', !!refused, refused && refused.message);
    check('CI9 the refused commit wrote nothing',
      (await rig.persistence.loadCapabilityPackages()).length === 0
      && rig.manager.isPackage(CAP_ID) === false);
    const s2 = await rig.service.inspect(drifted.bytes);
    const done = await rig.service.commit(s2.token, { acceptMismatch: true });
    check('CI9 commit with acceptMismatch succeeds', done.unchanged === false && done.id === CAP_ID);
    const record = await recordOf(rig.persistence, CAP_ID);
    const stored = await rig.persistence.readCapabilityPackageBytes(CAP_ID, record.digest);
    const reread = await LA.readLocusArchive(stored);
    const reparsed = reread.ok ? LA.parseLocusMd(reread.locusMd) : null;
    const verify = reparsed && reparsed.ok
      ? await LA.verifyLocusFiles(reparsed.manifest, reread.files) : null;
    check('CI9 stored manifest pins the actual bytes', !!verify
      && verify.missing.length === 0 && verify.extra.length === 0 && verify.mismatched.length === 0,
      JSON.stringify(verify));
    check('CI9 body carries the accepted-mismatch changelog line',
      !!record && record.body.includes('导入时内容与元文件不一致，用户确认接受：skills/skill-a/SKILL.md'));
  }

  // ---------- CI10. same id+version+content ----------
  {
    section('CI10 same package: kind same, unchanged commit');
    const rig = serviceRig();
    const packed = await packProject();
    await installViaService(rig, packed);
    const before = await recordOf(rig.persistence, CAP_ID);
    const again = await rig.service.inspect(packed.bytes);
    // C3 O1: the first install above auto-enabled the package, so the
    // existing record reads enabled (was: enabled === false).
    check('CI10 second inspect reports same (C3 O1: existing.enabled is now true)',
      again.ok === true && again.kind === 'same'
      && again.existing && again.existing.version === '1.0.0' && again.existing.enabled === true,
      JSON.stringify(again.ok ? { kind: again.kind } : again.diagnostics));
    const done = await rig.service.commit(again.token, {});
    check('CI10 same commit reports unchanged', done.unchanged === true && done.id === CAP_ID);
    const after = await recordOf(rig.persistence, CAP_ID);
    check('CI10 record untouched by the same commit', after.updatedAt === before.updatedAt
      && after.installedAt === before.installedAt && after.digest === before.digest);
  }

  // ---------- CI11. version replacement ----------
  {
    section('CI11 replace: user edits survive, orphan kept, v1 bytes deleted');
    const m = await loadStore(null);
    await m.whenBooted;
    const v1 = await packProject({ version: '1.0.0' });
    const { summary: s1 } = await installViaStore(m, v1, { enable: true });
    await m.vfs.write('/home/locus/.skills/' + CAP_ID + '/skill-a.skill', 'A-custom');
    const v2 = await packProject({
      version: '2.0.0',
      skillIds: ['skill-a', 'skill-c'],
      skillBodies: { 'skill-a': skillBody('skill-a', '2') },
    });
    const s2 = await m.inspectCapabilityPackage(v2.bytes);
    check('CI11 inspect reports replace + orphan', s2.ok === true && s2.kind === 'replace'
      && JSON.stringify(s2.orphanedSkills) === JSON.stringify(['skill-b'])
      && s2.needsMismatchAcceptance === false,
      JSON.stringify(s2.ok ? { kind: s2.kind, orphaned: s2.orphanedSkills } : s2.diagnostics));
    const done = await m.commitCapabilityPackage(s2.token, {});
    check('CI11 replacement auto-enables to ready', done.state === 'ready' && done.unchanged === false,
      JSON.stringify(done));
    const skillA = new TextDecoder().decode(await m.vfs.readBytes('/home/locus/.skills/' + CAP_ID + '/skill-a.skill'));
    const skillBExists = await m.vfs.exists('/home/locus/.skills/' + CAP_ID + '/skill-b.skill');
    const skillC = new TextDecoder().decode(await m.vfs.readBytes('/home/locus/.skills/' + CAP_ID + '/skill-c.skill'));
    check('CI11 user edit survives, orphan kept, new skill default',
      skillA === 'A-custom' && skillBExists === true && skillC === skillBody('skill-c', '1'),
      JSON.stringify({ skillA, skillBExists, skillC }));
    const record = await recordOf(sharedPersistence, CAP_ID);
    check('CI11 record now v2', !!record && record.version === '2.0.0');
    const v1Gone = await rejectionOf(sharedPersistence.readCapabilityPackageBytes(CAP_ID, s1.digest));
    check('CI11 v1 bytes deleted', !!v1Gone && v1Gone.name === 'NotFoundError', v1Gone && v1Gone.name);
  }

  // ---------- CI12. replacement failure rolls back ----------
  {
    section('CI12 conflicting replacement rolls back to v1 enabled');
    const rig = serviceRig();
    const v1 = await packProject({ version: '1.0.0', wheelSeed: 1 });
    await installViaService(rig, v1);
    await rig.manager.enable(CAP_ID); // service-level: manager-enabled v1
    // `other` shares v1's plugin id AND bytes (identical component =
    // coexistence allowed), so it registers beside v1.
    const other = await packProject({ id: OTHER_CAP_ID, version: '1.0.0', wheelSeed: 1, skillIds: ['skill-x'] });
    const otherResult = await installViaService(rig, other);
    check('CI12 setup: other registered beside v1',
      otherResult.commit.unchanged === false && rig.manager.isPackage(OTHER_CAP_ID) === true,
      JSON.stringify(otherResult.commit));
    // v2: same plugin id, DIFFERENT wheel bytes → registration conflict.
    const v2 = await packProject({ version: '2.0.0', wheelSeed: 2, skillIds: ['skill-a', 'skill-c'] });
    const s2 = await rig.service.inspect(v2.bytes);
    const v2Digest = s2.digest;
    const conflict = await rejectionOf(rig.service.commit(s2.token, {}));
    check('CI12 commit throws the registration conflict', !!conflict && /conflicts with an already registered/.test(conflict.message),
      conflict && conflict.message);
    check('CI12 v1 still registered and enabled', rig.manager.isPackage(CAP_ID) === true
      && rig.manager.capabilityState(CAP_ID) !== 'disabled'
      && rig.manager.isEnabled(CAP_ID) === true,
      rig.manager.capabilityState(CAP_ID));
    const record = await recordOf(rig.persistence, CAP_ID);
    check('CI12 record still v1', !!record && record.version === '1.0.0');
    const v2Gone = await rejectionOf(rig.persistence.readCapabilityPackageBytes(CAP_ID, v2Digest));
    check('CI12 v2 bytes do not exist', !!v2Gone && v2Gone.name === 'NotFoundError', v2Gone && v2Gone.name);    check('CI12 other survives the rollback', rig.manager.isPackage(OTHER_CAP_ID) === true);
  }

  // ---------- CI13. uninstall ----------
  {
    section('CI13 uninstall: everything gone but the skill instances');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await installViaStore(m, packed, { enable: true });
    const skillARel = '/home/locus/.skills/' + CAP_ID + '/skill-a.skill';
    check('CI13 setup: instances materialized', await m.vfs.exists(skillARel) === true);
    const err = await rejectionOf(m.uninstallCapabilityPackage(CAP_ID));
    check('CI13 uninstall succeeds', err === null, err && String(err));
    check('CI13 record and bytes gone',
      (await recordOf(sharedPersistence, CAP_ID)) === null
      && m.capabilityManager.isPackage(CAP_ID) === false
      && !m.store.capabilities.some((c) => c.id === CAP_ID));
    check('CI13 skill instance files kept (D10)',
      await m.vfs.exists(skillARel) === true
      && await m.vfs.exists('/home/locus/.skills/' + CAP_ID + '/skill-b.skill') === true);
  }

  // ---------- CI14. MODEL UNREACHABLE (adversarial, A-class) ----------
  {
    section('CI14 no VFS mount or shell path reaches the package storage');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await installViaStore(m, packed, { enable: true });

    const offenders = [];
    async function walkProvider(mountPath, provider, relPrefix, depth) {
      if (depth > 8) return;
      let entries = [];
      try { entries = await provider.list(relPrefix); } catch (e) { return; }
      for (const e of entries) {
        const rel = relPrefix ? relPrefix + '/' + e.name : e.name;
        const p = mountPath + '/' + rel;
        if (e.kind === 'directory') { await walkProvider(mountPath, provider, rel, depth + 1); continue; }
        offenders.push(p);
        try {
          const bytes = await provider.readBytes(rel);
          if (bytes.byteLength <= 4 * 1024 * 1024
            && new TextDecoder('utf-8', { fatal: false }).decode(bytes).includes(MARKER)) {
            offenders.push(p + ' <CONTAINS MARKER>');
          }
        } catch (e) { /* unreadable is fine — the path listing is checked */ }
      }
    }
    const mounts = m.vfs.mounts.map((x) => x.path);
    for (const mount of m.vfs.mounts) await walkProvider(mount.path, mount.provider, '', 0);
    // The task fork's introspection mounts (the same providers a task sees).
    const env = m.capabilityManager.buildTaskEnvironment();
    for (const spec of ext.productTaskVfsMounts(m.capabilityManager, env)) {
      await walkProvider(spec.path, spec.provider, '', 0);
    }
    check('CI14 no readable VFS path contains the marker, capability-packages or LOCUS.md',
      offenders.length > 0
      && offenders.every((p) => !p.includes(MARKER) && !p.includes('capability-packages') && !p.toLowerCase().includes('locus.md')
        && !p.endsWith('<CONTAINS MARKER>')),
      JSON.stringify(offenders.slice(0, 20)));
    check('CI14 the page mounts were actually enumerated (home/tmp/download/history…)',
      mounts.length >= 6 && mounts.includes('/home/locus') && mounts.includes('/mnt/download'),
      JSON.stringify(mounts));
    check('CI14 task-fork mounts carry only introspection manifests',
      ext.productTaskVfsMounts(m.capabilityManager, env).every((spec) =>
        [...spec.provider.files.keys()].every((k) => k.endsWith('plugin.json') || k.endsWith('capability.json'))),
      JSON.stringify([...ext.productTaskVfsMounts(m.capabilityManager, env).flatMap((s) => [...s.provider.files.keys()])]));

    const ls = await runShellCommand('ls /', m.vfs, {});
    check('CI14 shell ls / cannot see the package storage',
      ls.isError === false && !ls.output.includes('capability-packages') && !ls.output.includes('LOCUS.md'),
      JSON.stringify(ls.output.slice(0, 200)));
    const cat = await runShellCommand('cat /capability-packages', m.vfs, {});
    check('CI14 shell cat /capability-packages fails', cat.isError === true,
      JSON.stringify(cat.output.slice(0, 120)));
  }

  // ---------- CI15. python payload ----------
  {
    section('CI15 wheel bytes ride the python payload byte-for-byte');
    const rig = serviceRig();
    const packed = await packProject({ wheelSeed: 7 });
    await installViaService(rig, packed);
    await rig.manager.enable(CAP_ID);
    const payload = rig.manager.pythonExtensionPayload(rig.manager.buildTaskEnvironment());
    const wheel = payload.modules.length === 1 ? payload.modules[0].wheels[0] : null;
    check('CI15 one python module with exactly one wheel', !!wheel && wheel.format === 'python-wheel',
      JSON.stringify(payload.modules.map((x) => x.pluginId)));
    check('CI15 wheel bytes equal the fixture bytes', bytesEqual(wheel.bytes, wheelBytes(7)));
    check('CI15 wheel identity metadata match', wheel.sha256 === sha256HexNode(wheelBytes(7))
      && wheel.size === wheelBytes(7).byteLength && wheel.filename === WHEEL_NAME);
  }

  // ---------- CI16. VFS path import ----------
  {
    section('CI16 .locus path import; non-.locus refused');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await m.vfs.write('/mnt/download/x.locus', packed.bytes);
    const s = await m.inspectCapabilityPackageFromPath('/mnt/download/x.locus');
    check('CI16 path import inspects cleanly', s.ok === true && s.kind === 'new' && s.id === CAP_ID,
      JSON.stringify(s.ok ? { kind: s.kind } : s.diagnostics));
    await m.vfs.write('/mnt/download/y.zip', packed.bytes);
    const zipErr = await rejectionOf(m.inspectCapabilityPackageFromPath('/mnt/download/y.zip'));
    check('CI16 non-.locus path refused', !!zipErr && /\.locus/.test(zipErr.message),
      zipErr && zipErr.message);
  }

  // ---------- CI17. harness without the capabilityPackages declaration ----------
  {
    section('CI17 unsupported harness: import refuses, boot leaves storage alone');
    const packed = await packProject();
    {
      const m = await loadStore(null);
      await m.whenBooted;
      await installViaStore(m, packed, { enable: true });
    }
    {
      globalThis.window.__LOCUS_HOOKS__ = {
        harnessCapabilities: () => harnessDeclarationVariant({ capabilityPackages: false }),
      };
      let m = null;
      try {
        m = await loadStore(null, { reset: false });
        await m.whenBooted;
        check('CI17 boot does NOT load installed packages',
          m.capabilityManager.isPackage(CAP_ID) === false
          && m.store.capabilities.every((c) => c.id !== CAP_ID),
          JSON.stringify(m.store.capabilities.map((c) => c.id)));
        check('CI17 boot raised no notices and left the record in place',
          m.store.capabilityPackageNotices.length === 0
          && (await recordOf(sharedPersistence, CAP_ID)) !== null);
        const err = await rejectionOf(m.inspectCapabilityPackage(packed.bytes));
        check('CI17 import functions refuse loudly',
          !!err && err.message === 'this harness does not support capability packages',
          err && err.message);
        const listErr = await rejectionOf(m.capabilityPackageList());
        check('CI17 the list refuses too', !!listErr && listErr.message === 'this harness does not support capability packages');
      } finally {
        delete globalThis.window.__LOCUS_HOOKS__;
      }
    }
  }

  // ---------- CI18. schema 4 and the clear paths ----------
  {
    section('CI18 schema 4: reset wipes packages, clearConversations keeps them');
    check('CI18 schema version is 4', persistenceMod.PERSISTENCE_SCHEMA_VERSION === 4);
    check('CI18 capabilityPackages is a declared store',
      persistenceMod.PERSISTENCE_STORES.includes('capabilityPackages'));
    const rig = serviceRig();
    const packed = await packProject();
    await installViaService(rig, packed);
    const digest = (await recordOf(rig.persistence, CAP_ID)).digest;
    await rig.persistence.reset();
    check('CI18 reset clears records and bytes',
      (await rig.persistence.loadCapabilityPackages()).length === 0
      && (await rejectionOf(rig.persistence.readCapabilityPackageBytes(CAP_ID, digest)))?.name === 'NotFoundError');
    // A fresh manager (reset() wipes storage, never a live manager).
    const rig2 = serviceRig();
    await installViaService(rig2, packed);
    await rig2.persistence.clearConversations();
    const kept = await recordOf(rig2.persistence, CAP_ID);
    const bytesKept = await rejectionOf(rig2.persistence.readCapabilityPackageBytes(CAP_ID, kept.digest));
    check('CI18 clearConversations leaves installed packages alone',
      !!kept && bytesKept === null, bytesKept && String(bytesKept));
  }

  // ---------- CI19. memory mode is not durable ----------
  {
    section('CI19 memory mode lists durable === false');
    const m = await loadStore(null);
    await m.whenBooted;
    const list = await m.capabilityPackageList();
    check('CI19 durable is false in node memory mode', list.durable === false
      && sharedPersistence.mode === 'memory' && sharedPersistence.opfsAvailable === false,
      JSON.stringify({ durable: list.durable, mode: sharedPersistence.mode }));
    check('CI19 list shape carries the packages array', Array.isArray(list.packages));
  }

  // ---------- CI20. stale token ----------
  {
    section('CI20 unknown commit token reports the inspection as expired');
    const rig = serviceRig();
    const err = await rejectionOf(rig.service.commit('no-such-token', {}));
    check('CI20 expired-token error', !!err && /inspection expired/.test(err.message),
      err && err.message);
  }

  // ---------- CI21. F1: replacement re-enables a boot-skipped package ----------
  {
    section('CI21 F1: replace re-enables a package the boot verification skipped');
    const v1 = await packProject({ version: '1.0.0' });
    let v1Digest = null;
    {
      const m = await loadStore(null);
      await m.whenBooted;
      const { summary } = await installViaStore(m, v1, { enable: true });
      v1Digest = summary.digest;
      // Forge: same manifest (the record digest still matches), one file's
      // bytes drifted — the boot path then SKIPS the package (never
      // registered) while the record keeps enabled: true.
      const read = await LA.readLocusArchive(v1.bytes);
      const files = new Map(read.files);
      files.set('skills/skill-a/SKILL.md', new TextEncoder().encode('adversarial v1 drift\n'));
      await sharedPersistence.writeCapabilityPackageBytes(CAP_ID, v1Digest,
        await LA.writeLocusArchive(files, read.locusMd));
    }
    {
      const m = await loadStore(null, { reset: false }); // the "restart"
      await m.whenBooted;
      const n = m.store.capabilityPackageNotices.find((x) => x.id === CAP_ID);
      const record = await recordOf(sharedPersistence, CAP_ID);
      check('CI21 restart skips v1: mismatch notice, unregistered, record enabled=true',
        !!n && n.status === 'mismatch'
        && m.capabilityManager.isPackage(CAP_ID) === false
        && !!record && record.enabled === true && record.verification === 'mismatch-skipped',
        JSON.stringify({ notices: m.store.capabilityPackageNotices, enabled: record && record.enabled }));
      const v2 = await packProject({ version: '2.0.0' });
      const s2 = await m.inspectCapabilityPackage(v2.bytes);
      check('CI21 v2 inspect: replace, no mismatch acceptance (different version)',
        s2.ok === true && s2.kind === 'replace' && s2.needsMismatchAcceptance === false,
        JSON.stringify(s2.ok ? { kind: s2.kind, needs: s2.needsMismatchAcceptance } : s2.diagnostics));
      const done = await m.commitCapabilityPackage(s2.token, {});
      check('CI21 v2 lands ready (F1: wasEnabled read from the record)', done.state === 'ready' && done.unchanged === false,
        JSON.stringify(done));
      const updated = await recordOf(sharedPersistence, CAP_ID);
      check('CI21 record now v2 and still enabled',
        !!updated && updated.version === '2.0.0' && updated.enabled === true);
      check('CI21 v2 registered', m.capabilityManager.isPackage(CAP_ID) === true);
    }
  }

  // ---------- CI22. F2: the list is read-only ----------
  {
    section('CI22 F2: capabilityPackageList works while a task is running');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await installViaStore(m, packed);
    // The established running-task shape (the fake-session pattern): a
    // task object with a controller on the live session, plus the busy flag.
    const controller = new AbortController();
    m.session.task = { controller };
    m.store.busy = true;
    try {
      const list = await m.capabilityPackageList();
      check('CI22 list succeeds mid-task', !!list && list.durable === false
        && Array.isArray(list.packages) && list.packages.some((p) => p.id === CAP_ID),
        JSON.stringify(list && list.packages.map((p) => p.id)));
      check('CI22 the UI support gate still reports supported',
        m.capabilityPackagesSupported() === true);
    } finally {
      m.store.busy = false;
      if (m.session.task && m.session.task.controller === controller) m.session.task = null;
    }
  }

  // ---------- CI23. the import dialog state: begin/inspect ----------
  {
    section('CI23 beginCapabilityImportFromBytes: summary vs diagnostics');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await m.beginCapabilityImportFromBytes(packed.bytes, 'packed.locus');
    check('CI23 valid package sets source/label/summary', !!m.store.capabilityImport
      && m.store.capabilityImport.source === 'file'
      && m.store.capabilityImport.label === 'packed.locus'
      && !!m.store.capabilityImport.summary
      && m.store.capabilityImport.summary.ok === true
      && typeof m.store.capabilityImport.summary.token === 'string'
      && !m.store.capabilityImport.diagnostics,
      JSON.stringify(m.store.capabilityImport
        ? { source: m.store.capabilityImport.source, label: m.store.capabilityImport.label } : null));
    const bad = new Uint8Array([0, 1, 2, 3, 4, 5]);
    await m.beginCapabilityImportFromBytes(bad, 'bad.locus');
    check('CI23 bad package sets diagnostics, no summary', !!m.store.capabilityImport
      && m.store.capabilityImport.source === 'file'
      && m.store.capabilityImport.label === 'bad.locus'
      && Array.isArray(m.store.capabilityImport.diagnostics)
      && m.store.capabilityImport.diagnostics.length > 0
      && !m.store.capabilityImport.summary,
      JSON.stringify(m.store.capabilityImport && m.store.capabilityImport.diagnostics));
    check('CI23 neither inspect wrote anything',
      (await recordOf(sharedPersistence, CAP_ID)) === null
      && m.capabilityManager.isPackage(CAP_ID) === false);
  }

  // ---------- CI24. confirmCapabilityImport ----------
  {
    section('CI24 confirm: installs, clears the dialog, refreshes the list');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await m.beginCapabilityImportFromBytes(packed.bytes, 'packed.locus');
    await m.confirmCapabilityImport();
    check('CI24 confirm clears the dialog', m.store.capabilityImport === null,
      JSON.stringify(m.store.capabilityImport));
    const record = await recordOf(sharedPersistence, CAP_ID);
    check('CI24 package installed', !!record && record.id === CAP_ID
      && m.capabilityManager.isPackage(CAP_ID) === true);
    check('CI24 the installed list refreshed', Array.isArray(m.store.capabilityPackages.packages)
      && m.store.capabilityPackages.packages.some((p) => p.id === CAP_ID),
      JSON.stringify(m.store.capabilityPackages.packages.map((p) => p.id)));
    // Refusal path: a running task rejects the commit; the dialog stays
    // with the error and the package is untouched.
    const v2 = await packProject({ version: '2.0.0' });
    await m.beginCapabilityImportFromBytes(v2.bytes, 'v2.locus');
    const controller = new AbortController();
    m.session.task = { controller };
    m.store.busy = true;
    try {
      await m.confirmCapabilityImport();
    } finally {
      m.store.busy = false;
      if (m.session.task && m.session.task.controller === controller) m.session.task = null;
    }
    check('CI24 refused confirm keeps the dialog with the error', !!m.store.capabilityImport
      && !!m.store.capabilityImport.summary
      && typeof m.store.capabilityImport.error === 'string'
      && /task is running/.test(m.store.capabilityImport.error),
      JSON.stringify(m.store.capabilityImport && m.store.capabilityImport.error));
    check('CI24 the refused replacement changed nothing',
      (await recordOf(sharedPersistence, CAP_ID)).version === '1.0.0');
  }

  // ---------- CI25. cancelCapabilityImport writes nothing ----------
  {
    section('CI25 cancel: drops the dialog, zero writes');
    const m = await loadStore(null);
    await m.whenBooted;
    const packed = await packProject();
    await m.beginCapabilityImportFromBytes(packed.bytes, 'packed.locus');
    m.cancelCapabilityImport();
    check('CI25 dialog cleared', m.store.capabilityImport === null);
    check('CI25 nothing was written',
      (await recordOf(sharedPersistence, CAP_ID)) === null
      && m.capabilityManager.isPackage(CAP_ID) === false
      && m.store.capabilityPackages.packages.length === 0);
  }

  // ---------- CI26. C3: first install auto-enable survives a restart ----------
  {
    section('CI26 C3 O1: auto-enabled install reloads enabled');
    const packed = await packProject();
    const shared = new persistenceMod.PersistenceService();
    {
      const rig = serviceRig({ persistence: shared });
      const { commit } = await installViaService(rig, packed);
      check('CI26 first install lands enabled (C3 O1)',
        commit.enabled === true && commit.state === 'ready', JSON.stringify(commit));
    }
    {
      // "Restart": a fresh manager + service over the SAME persistence.
      const rig = serviceRig({ persistence: shared });
      const results = await rig.service.loadInstalled();
      const record = await recordOf(rig.persistence, CAP_ID);
      check('CI26 the reload restores the enabled package',
        results.length === 1 && results[0].status === 'loaded'
        && !!record && record.enabled === true
        && rig.manager.isEnabled(CAP_ID) === true
        && rig.manager.capabilityState(CAP_ID) === 'ready',
        JSON.stringify({ results, enabled: record && record.enabled }));
    }
  }

  // ---------- CI27. C3 O1: enable failure keeps the package, disabled ----------
  {
    section('CI27 C3 O1: enable failure → installed, disabled, no throw');
    const rig = serviceRig({ instances: null }); // no instance storage → enable fails
    const packed = await packProject();
    const { commit } = await installViaService(rig, packed);
    check('CI27 the commit reports enabled:false with the reason',
      commit.enabled === false && typeof commit.enableError === 'string' && commit.enableError.length > 0
      && commit.state === 'error',
      JSON.stringify(commit));
    const record = await recordOf(rig.persistence, CAP_ID);
    check('CI27 the package stays installed and DISABLED (record bit)',
      !!record && record.enabled === false && record.version === '1.0.0');
    const list = await rig.service.list();
    check('CI27 the package is still listed',
      list.packages.length === 1 && list.packages[0].id === CAP_ID
      && list.packages[0].enabled === false, JSON.stringify(list.packages));
  }

  // ---------- CI28. C3: replace keeps the enabled/disabled state (D10) ----------
  {
    section('CI28 D10 matrix: replace enabled/disabled behaves as before');
    for (const oldEnabled of [true, false]) {
      const rig = serviceRig();
      const v1 = await packProject({ version: '1.0.0' });
      await installViaService(rig, v1);
      if (oldEnabled) await rig.manager.enable(CAP_ID); // auto-enabled already; idempotent
      else {
        await rig.manager.disable(CAP_ID);
        await rig.service.setEnabled(CAP_ID, false);
      }
      const v2 = await packProject({ version: '2.0.0' });
      const s2 = await rig.service.inspect(v2.bytes);
      const done = await rig.service.commit(s2.token, {});
      check('CI28 old ' + (oldEnabled ? 'enabled' : 'disabled') + ' → new '
        + (oldEnabled ? 'enabled' : 'disabled') + ' (unchanged behavior)',
        done.unchanged === false
        && (done.state === 'ready') === oldEnabled
        && rig.manager.isEnabled(CAP_ID) === oldEnabled,
        JSON.stringify({ state: done.state, isEnabled: rig.manager.isEnabled(CAP_ID) }));
    }
  }

  // ---------- CI29. C3: commit/uninstall route through the credentials ----------
  {
    section('CI29 credentials: commit replace + uninstall drive the service');
    const rig = serviceRig();
    const v1 = await packProject({ version: '1.0.0', credentials: CRED_DECL_V1 });
    const { summary: s1 } = await installViaService(rig, v1);
    check('CI29 the registered credential starts needs-connection',
      rig.manager.listCapabilities().some((c) => c.id === CAP_ID
        && c.credentials.some((x) => x.name === 'CI_CRED_KEY' && x.state === 'needs-connection')),
      JSON.stringify(rig.manager.listCapabilities().map((c) => c.credentials)));
    await rig.credentials.connect('CI_CRED_KEY', 'ci-cred-value-123456', { remember: true });
    check('CI29 connected through the service', rig.credentials.summary('CI_CRED_KEY').state === 'connected');
    // Version replace, binding UNCHANGED → stays connected.
    const v2 = await packProject({ version: '2.0.0', credentials: CRED_DECL_V1 });
    const s2 = await rig.service.inspect(v2.bytes);
    check('CI29 v2 inspect: replace', s2.ok === true && s2.kind === 'replace', JSON.stringify(s2.ok ? s2.kind : s2.diagnostics));
    await rig.service.commit(s2.token, {});
    check('CI29 unchanged binding keeps the connection through the replace',
      rig.credentials.summary('CI_CRED_KEY').state === 'connected');
    // Version replace, binding CHANGED (pathPrefix) → needs-reconfirm, value kept.
    const v3 = await packProject({ version: '3.0.0', credentials: CRED_DECL_V2 });
    const s3 = await rig.service.inspect(v3.bytes);
    await rig.service.commit(s3.token, {});
    check('CI29 changed binding flips to needs-reconfirm with the value kept',
      rig.credentials.summary('CI_CRED_KEY').state === 'needs-reconfirm'
      && rig.credentials.summary('CI_CRED_KEY').hasValue === true,
      JSON.stringify(rig.credentials.summary('CI_CRED_KEY')));
    // Uninstall removes the binding + remembered value.
    await rig.service.uninstall(CAP_ID);
    check('CI29 uninstall removed the credential data',
      rig.credentials.summary('CI_CRED_KEY').state === null
      && rig.credentials.summary('CI_CRED_KEY').hasValue === false
      && rig.credentials.summary('CI_CRED_KEY').last4 === null,
      JSON.stringify(rig.credentials.summary('CI_CRED_KEY')));
    const bindingsRow = await rig.persistence.get('meta', 'credentialBindings');
    check('CI29 binding records gone after uninstall',
      !bindingsRow || !bindingsRow.bindings.length, JSON.stringify(bindingsRow));
    const s1digestGone = await rejectionOf(rig.persistence.readCapabilityPackageBytes(CAP_ID, s1.digest));
    check('CI29 v1 bytes cleaned', !!s1digestGone && s1digestGone.name === 'NotFoundError');
  }

  console.log('---');
  console.log('capability-install.test.mjs: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
