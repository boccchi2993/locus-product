// M3c-B dedicated suite: Product storage / capability / skill adapters on
// the three-repo switch (branch refactor/m3c-storage-adapters).
//
// What this suite proves (and what it deliberately does not):
//  - the five converted modules are REAL ES modules whose core symbols come
//    exclusively through src/product/{harness-api,runtime-api}.js — no
//    deep core paths, no globalThis publishes;
//  - the replay validators used by Product persistence are the REAL
//    Harness algorithms (identity with the entry exports, honest accept /
//    reject on valid and corrupted input);
//  - the capability package layer validates and builds through the REAL
//    harness descriptor validators and the REAL shared sha256Hex (valid
//    fixture project builds; descriptor faults and an oversized skill
//    refuse);
//  - the skill instance contract (path, marker, byte bound) agrees with
//    the REAL harness composition values, and skill write/delete still
//    require confirmation with no-op and TOCTOU semantics intact;
//  - storage failures are never converted into success.
//  In-memory doubles appear ONLY as storage/ports (skill storage, the
//  attachment persistence port, the approvals port) — never as a stand-in
//  for an algorithm under test. Browser IDB/OPFS regression is integration
//  D's gate; the independent real-browser pass for this branch is
//  tests/e2e-m3c-storage-adapters.cjs (run separately, recorded in
//  docs/M3C-B-HANDOFF.md).
// Run: node tests/m3c-storage-adapters.test.mjs
// (run-unit.cjs registration is integration D's wiring — see handoff doc.)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as harnessApi from '../src/product/harness-api.js';
import * as runtimeApi from '../src/product/runtime-api.js';
import * as historyWs from '../src/conversation-history-workspace.js';
import * as persistenceMod from '../src/persistence.js';
import * as attachmentsMod from '../src/attachments.js';
import * as extensionsMod from '../src/extensions.js';
import * as capabilityPackageMod from '../src/capability-package.js';

const {
  validateReplayPrefix: harnessValidateReplayPrefix,
  validateNormalizedPrefix: harnessValidateNormalizedPrefix,
  getProviderAdapter,
  skillInstancePath,
  SKILL_INSTANCE_ROOT,
  SKILL_INSTANCE_MARKER,
  SKILL_INSTANCE_MAX_BYTES,
  sha256Hex,
} = harnessApi;
const { WorkspaceAdapter, normalizeWorkspacePath, vfsError } = runtimeApi;
const { ConversationHistoryWorkspace } = historyWs;
const {
  PersistenceService,
  PersistenceServiceInstance,
  LOCUS_HOME_SKELETON,
  persistenceClone,
  validateReplayPrefix,
  validateNormalizedPrefix,
} = persistenceMod;
const {
  AttachmentStore, imageContentPart, textContentPart,
  isAttachmentIntegrityError, attachmentIntegrityError,
} = attachmentsMod;
const {
  StaticFileWorkspace, SkillInstanceStorage, SkillInstanceWorkspace,
  productTaskVfsMounts,
} = extensionsMod;
const { CapabilityBundle, validateProject, buildProject, inspectBundle, LocusCapabilityPackage } = capabilityPackageMod;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
const rejectionCode = (p) => p.then(() => null, (e) => e);
const rejectedCode = (fn) => { try { fn(); return null; } catch (e) { return e.code || e.name; } };

// ============================================================
// 1. ESM import surface
// ============================================================
{
  check('S1 harness-api is a pure entry re-export (55-symbol public surface)',
    typeof harnessApi.createTaskRunner === 'function' && typeof harnessApi.createProviderSessions === 'function'
    && typeof harnessApi.harnessCapabilities === 'function',
    Object.keys(harnessApi).length + ' exports');
  check('S2 runtime-api carries the runtime + workspace + worker-assets surface',
    typeof runtimeApi.createWorkspace === 'function' && !!runtimeApi.runtimeWorkerAssets
    && typeof runtimeApi.runtimeWorkerAssets.PY_WORKER_SOURCE === 'string');
  check('S3 all five product modules import with their outward symbols',
    ConversationHistoryWorkspace.prototype instanceof WorkspaceAdapter
    && typeof PersistenceService === 'function' && PersistenceServiceInstance instanceof PersistenceService
    && typeof AttachmentStore === 'function' && typeof SkillInstanceWorkspace === 'function'
    && typeof LocusCapabilityPackage.validateProject === 'function');
  check('S4 persistence keeps the Product-owned home skeleton value',
    JSON.stringify(LOCUS_HOME_SKELETON) === JSON.stringify(['.skills', '.config/locus/mcp', '.cache/locus']));
  check('S5 persistenceClone survives Maps and typed arrays (structured-clone semantics)',
    (() => { const m = persistenceClone(new Map([['k', new Uint8Array([1, 2])]]));
      return m instanceof Map && m.get('k') instanceof Uint8Array && m.get('k')[1] === 2; })());
}

// ============================================================
// 2. No forbidden specifiers / no global publishes
// ============================================================
{
  const own = [
    'src/conversation-history-workspace.js', 'src/persistence.js', 'src/attachments.js',
    'src/extensions.js', 'src/capability-package.js', 'src/product/harness-api.js',
  ];
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let badSpecifier = null, badPublish = null;
  for (const rel of own) {
    const text = readFileSync(join(root, rel), 'utf8');
    const coreSpecifier = text.match(/from\s+['"](?:locus-runtime|locus-harness)(?:\/[^'"]*)?['"]/g);
    const deepPath = text.match(/from\s+['"][^'"]*(?:\/|^)(?:runtime|harness)\/[^'"]+['"]/g);
    const publishes = text.match(/\b(?:globalThis|window)\.[A-Za-z_$][\w$]*\s*=[^=]/g);
    if (rel !== 'src/product/harness-api.js' && coreSpecifier && badSpecifier === null) {
      badSpecifier = rel + ': ' + coreSpecifier[0];
    }
    if (deepPath && badSpecifier === null) badSpecifier = rel + ': ' + deepPath[0];
    if (publishes && badPublish === null) badPublish = rel + ': ' + publishes[0];
  }
  check('S6 no core package specifier or deep core path outside the API files', !badSpecifier, badSpecifier);
  check('S7 no globalThis/window publishes in the converted modules', !badPublish, badPublish);
  check('S8 harness-api itself contains exactly one bare entry re-export',
    readFileSync(join(root, 'src/product/harness-api.js'), 'utf8').match(/from\s+['"]locus-harness['"]/g).length === 1);
}

// ============================================================
// 3. REAL replay validators through the persistence surface
// ============================================================
{
  check('R1 persistence.validateReplayPrefix IS the harness entry function (one-way re-export)',
    validateReplayPrefix === harnessValidateReplayPrefix
    && validateNormalizedPrefix === harnessValidateNormalizedPrefix);

  const adapter = getProviderAdapter({ dialect: 'openai', apiBase: 'https://api.example.test/v1' });
  const session = {
    id: 's-b', conversationId: 'c-b', replayCheckpointSequence: 2,
    provider: 'openai', adapterId: adapter.adapterId, dialect: 'openai',
    endpointIdentity: 'https://api.example.test/v1', model: 'm1', protocolVersion: 'chat-completions-v1',
  };
  const frames = [
    { sequence: 1, sessionId: 's-b', conversationId: 'c-b', kind: 'user', role: 'user', raw: { role: 'user', content: 'hi' } },
    { sequence: 2, sessionId: 's-b', conversationId: 'c-b', kind: 'assistant', role: 'assistant', raw: { role: 'assistant', content: 'done' } },
  ];
  const ok = validateReplayPrefix(session, frames, adapter);
  check('R2 the REAL validator accepts a valid contiguous prefix',
    !!ok && ok.valid === true && ok.checkpoint === 2 && ok.frames.length === 2, JSON.stringify(ok));

  const wrongIdentity = rejectedCode(() => validateReplayPrefix(
    session, frames.map((f, i) => (i === 1 ? { ...f, sessionId: 's-other' } : f)), adapter));
  check('R3 corrupted replay: wrong provider session identity is rejected',
    wrongIdentity === 'session_identity_mismatch', String(wrongIdentity));
  const beyondTail = rejectedCode(() => validateReplayPrefix({ ...session, replayCheckpointSequence: 3 }, frames, adapter));
  check('R4 corrupted replay: checkpoint beyond the frame tail is rejected',
    beyondTail === 'checkpoint_beyond_tail', String(beyondTail));
  const noClassifier = rejectedCode(() => validateReplayPrefix(session, frames, null));
  check('R5 corrupted replay: missing raw classifier is rejected, never a silent pass',
    noClassifier === 'raw_classifier_missing', String(noClassifier));

  const normalizedOk = validateNormalizedPrefix('c-b', [
    { conversationId: 'c-b', sequence: 1, kind: 'user' },
    { conversationId: 'c-b', sequence: 2, kind: 'assistant' },
  ]);
  check('R6 the REAL normalized validator accepts a clean conversation prefix',
    normalizedOk.valid === true && normalizedOk.rows.length === 2);
  const dangling = rejectedCode(() => validateNormalizedPrefix('c-b', [
    { conversationId: 'c-b', sequence: 1, kind: 'tool_call', toolCalls: [{ id: 'call-1' }] },
  ]));
  check('R7 corrupted normalized history (dangling tool batch) is rejected',
    dangling === 'normalized_tool_batch_dangling', String(dangling));
}

// ============================================================
// 4. Capability package over the REAL harness validators + REAL sha256Hex
// ============================================================
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'capability-package', 'minimal');
function fixtureWorkspace() {
  // StaticFileWorkspace — the Product's own provider class — supplies the
  // fixture tree. A provider is a STORAGE port; the ALGORITHMS under test
  // (the four descriptor validators, the byte bound, sha256Hex) are all
  // REAL imports.
  const files = {};
  const addDir = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const childAbs = join(abs, name);
      const childRel = rel ? rel + '/' + name : name;
      if (statSync(childAbs).isDirectory()) addDir(childAbs, childRel);
      else files[childRel] = new Uint8Array(readFileSync(childAbs));
    }
  };
  addDir(FIXTURE, '');
  return new StaticFileWorkspace({ name: 'fixture', files });
}

{
  const ws = fixtureWorkspace();
  const validation = await validateProject({ workspace: ws, root: '' });
  check('C1 validateProject accepts the REAL minimal fixture project',
    validation.ok === true && validation.diagnostics.length === 0, JSON.stringify(validation.diagnostics));

  const build = await buildProject({ workspace: ws, root: '' });
  check('C2 buildProject produces a bundle through the REAL validators',
    build.ok === true && build.bundle instanceof CapabilityBundle, JSON.stringify(build.diagnostics || []));

  const skillBytes = build.bundle.readBytes('skills/test-workflow/SKILL.md');
  const lock = build.bundle.lock;
  const lockSkill = lock.skills.find((s) => s.descriptor.id === 'test-workflow');
  const nodeHash = createHash('sha256').update(skillBytes).digest('hex');
  check('C3 the lock hashes are the REAL shared sha256Hex over the exact bytes (node-crypto oracle)',
    lockSkill.sha256 === await sha256Hex(skillBytes) && lockSkill.sha256 === nodeHash
      && lockSkill.size === skillBytes.byteLength);
  const inspect = inspectBundle(build.bundle);
  check('C4 inspectBundle reports a valid bundle with no raw bytes',
    inspect.valid === true && inspect.capability.id === 'package-test-capability'
      && inspect.totalBytes === lock.files.reduce((n, f) => n + f.size, 0));

  // Descriptor fault: the REAL harness validator rejects a broken id.
  const badIdFiles = {
    'capability.json': JSON.stringify({
      schemaVersion: 1,
      capability: {
        id: 'package-test-capability', version: '1', displayName: 'x', description: 'x',
        plugins: [], skills: ['bad-skill'], mcps: [],
      },
    }),
    'skills/bad-skill/skill.json': JSON.stringify({
      schemaVersion: 1,
      skill: { id: 'BAD ID!', version: '1', displayName: 'x', description: 'x' },
      source: 'SKILL.md',
    }),
    'skills/bad-skill/SKILL.md': 'hello',
  };
  const badId = await validateProject({ workspace: new StaticFileWorkspace({ files: badIdFiles }), root: '' });
  check('C5 descriptor fault refuses through the REAL skill validator',
    badId.ok === false && badId.diagnostics.some((d) => d.code === 'package_descriptor_invalid'),
    JSON.stringify(badId.diagnostics));

  // Oversized skill source: the REAL shared 256 KiB contract.
  const bigSkill = {
    'capability.json': JSON.stringify({
      schemaVersion: 1,
      capability: {
        id: 'package-test-capability', version: '1', displayName: 'x', description: 'x',
        plugins: [], skills: ['big-skill'], mcps: [],
      },
    }),
    'skills/big-skill/skill.json': JSON.stringify({
      schemaVersion: 1,
      skill: { id: 'big-skill', version: '1', displayName: 'x', description: 'x' },
      source: 'SKILL.md',
    }),
    'skills/big-skill/SKILL.md': 'x'.repeat(SKILL_INSTANCE_MAX_BYTES + 1),
  };
  const tooBig = await validateProject({ workspace: new StaticFileWorkspace({ files: bigSkill }), root: '' });
  check('C6 oversized skill source refuses at the REAL shared byte bound',
    tooBig.ok === false && tooBig.diagnostics.some((d) => d.code === 'package_skill_too_large'),
    JSON.stringify(tooBig.diagnostics));

  check('C7 PACKAGE_CONSTANTS.SKILL_MAX_BYTES is the harness contract value, not a copy drift',
    LocusCapabilityPackage.PACKAGE_CONSTANTS.SKILL_MAX_BYTES === SKILL_INSTANCE_MAX_BYTES
    && LocusCapabilityPackage.PACKAGE_CONSTANTS.SCHEMA_VERSION === 1);
}

// ============================================================
// 5. Skill instance contract: path / marker / bound agree with the harness
// ============================================================
function skillStorageDouble(initial) {
  const files = new Map(Object.entries(initial || {}));
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const isDir = (rel) => {
    if (files.get(rel)?.isDir) return true;
    for (const key of files.keys()) if (key.startsWith(rel + '/')) return true;
    return false;
  };
  return {
    files, enc, dec, isDir,
    async list(rel) {
      const prefix = rel ? rel + '/' : '';
      const names = new Map();
      const dirs = new Set();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (!seg) continue;
        if (rest.includes('/')) dirs.add(seg);
        else if (files.get(key).isDir) dirs.add(seg);
        else names.set(seg, { name: seg, kind: 'file' });
      }
      for (const d of dirs) names.set(d, { name: d, kind: 'directory' });
      return [...names.values()];
    },
    async readBytes(rel) {
      const f = files.get(rel);
      if (!f || f.isDir || isDir(rel)) { const e = new Error('no such file or directory: ' + rel); e.name = 'NotFoundError'; throw e; }
      return f.bytes.slice();
    },
    async read(rel) { return dec.decode(await this.readBytes(rel)); },
    async writeBytes(rel, bytes) { files.set(rel, { bytes: new Uint8Array(bytes) }); },
    async exists(rel) { return files.has(rel) || isDir(rel); },
    async stat(rel) {
      if (isDir(rel)) return { kind: 'directory', size: 0, modified: null };
      const f = files.get(rel);
      if (!f) { const e = new Error('no such file or directory: ' + rel); e.name = 'NotFoundError'; throw e; }
      return { kind: 'file', size: f.bytes.byteLength, modified: null };
    },
    async removeFile(rel) { files.delete(rel); },
  };
}
function approvalDouble(script) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async request(spec, opts) {
      n++;
      calls.push(spec);
      const mutate = script && script.mutate;
      if (mutate) await mutate(n);
      const outcome = script && script.outcome;
      if (typeof outcome === 'function') return outcome(n, spec);
      return outcome || { outcome: 'confirm' };
    },
  };
}
function liveContext(storage, approvals, extra) {
  const env = {
    capabilities: [{
      id: 'cap1', displayName: 'Capability One', state: 'enabled', skillIds: ['note'],
    }],
    skills: [{ capabilityId: 'cap1', skillId: 'note', displayName: 'Note Skill' }],
  };
  return {
    taskEnvironment: env,
    approvals,
    conversationId: 'c-1',
    taskGeneration: 3,
    getSignal: () => (extra && 'signal' in extra ? extra.signal : { aborted: false }),
  };
}
const NOTE_PATH = 'cap1/note.skill';

{
  check('K1 the harness path algorithm is the instance identity the manager materializes',
    skillInstancePath('cap1', 'note') === SKILL_INSTANCE_ROOT + '/cap1/note.skill');

  const storage = skillStorageDouble({ 'cap1/.locus-installed.json': { bytes: new TextEncoder().encode('{}') } });
  const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvalDouble({})) });
  const rootListed = await ws.list('');
  const capListed = await ws.list('cap1');
  const rawCapListed = await storage.list('cap1');
  check('K2 the install marker is hidden from list() (the raw storage port still sees it)',
    rootListed.length === 1 && rootListed[0].name === 'cap1' && rootListed[0].kind === 'directory'
      && capListed.length === 0
      && rawCapListed.length === 1 && rawCapListed[0].name === SKILL_INSTANCE_MARKER,
    JSON.stringify({ rootListed, capListed, rawCapListed }));

  const markerWrite = rejectionCode(ws.write('cap1/' + SKILL_INSTANCE_MARKER, 'x'));
  check('K3 writing the harness-owned marker is refused as a boundary',
    (await markerWrite)?.code === 'skill_mutation_boundary', String(await markerWrite));
  const foreignWrite = rejectionCode(ws.write('other/thing.skill', 'x'));
  check('K4 a path outside the declared skill set is refused',
    (await foreignWrite)?.code === 'skill_mutation_boundary');
  const dirMkdir = rejectionCode(ws.mkdir('cap1/dir'));
  check('K5 instance directories stay harness-owned (mkdir refused)',
    (await dirMkdir)?.code === 'skill_mutation_boundary');

  const byteBound = rejectionCode(ws.write(NOTE_PATH, 'x'.repeat(SKILL_INSTANCE_MAX_BYTES + 1)));
  check('K6 an oversized skill write refuses at the REAL harness bound',
    (await byteBound)?.code === 'skill_mutation_too_large');
}

// ============================================================
// 6. Skill write/delete: confirmation, no-op, TOCTOU
// ============================================================
{
  // No live task signal → fail closed before anything else.
  {
    const storage = skillStorageDouble();
    const approvals = approvalDouble({});
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals, { signal: null }) });
    const err = await rejectionCode(ws.write(NOTE_PATH, 'hello'));
    check('W1 a write without a live task signal fails closed and writes nothing',
      err?.code === 'skill_mutation_no_task' && storage.files.size === 0 && approvals.calls.length === 0,
      String(err));
  }
  // Missing approvals port → refused.
  {
    const storage = skillStorageDouble();
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, null) });
    const err = await rejectionCode(ws.write(NOTE_PATH, 'hello'));
    check('W2 a missing approval framework refuses the mutation',
      err?.code === 'skill_mutation_no_task' && storage.files.size === 0);
  }
  // Declined confirmation → nothing written.
  {
    const storage = skillStorageDouble();
    const approvals = approvalDouble({ outcome: { outcome: 'cancel' } });
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals) });
    const err = await rejectionCode(ws.write(NOTE_PATH, 'hello'));
    check('W3 a declined confirmation leaves the file untouched',
      err?.code === 'skill_mutation_declined' && storage.files.size === 0 && approvals.calls.length === 1);
  }
  // Confirmed create → bytes land through the storage port.
  {
    const storage = skillStorageDouble();
    const approvals = approvalDouble({});
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals) });
    await ws.write(NOTE_PATH, 'hello');
    const after = storage.files.get(NOTE_PATH);
    check('W4 a confirmed create writes the confirmed bytes',
      !!after && new TextDecoder().decode(after.bytes) === 'hello'
      && approvals.calls.length === 1 && approvals.calls[0].kind === 'confirmation'
      && approvals.calls[0].resource.key === 'cap1:note'
      && approvals.calls[0].resource.label === skillInstancePath('cap1', 'note'));
  }
  // No-op: byte-identical write never asks, never mutates.
  {
    const storage = skillStorageDouble();
    const approvals = approvalDouble({});
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals) });
    await ws.write(NOTE_PATH, 'hello');
    const callsAfterCreate = approvals.calls.length;
    await ws.write(NOTE_PATH, 'hello');
    check('W5 a byte-identical write is a no-op without an approval round trip',
      callsAfterCreate === 1 && approvals.calls.length === 1);
  }
  // TOCTOU: the approved diff only lands on the exact approved before-state.
  // The racing mutation fires on the SECOND approval (the 'v2' edit), never
  // on the setup create.
  {
    const storage = skillStorageDouble();
    let approvalCalls = 0;
    const approvals = approvalDouble({
      mutate: () => {
        approvalCalls++;
        if (approvalCalls === 2) storage.writeBytes(NOTE_PATH, new TextEncoder().encode('raced'));
      },
    });
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals) });
    await ws.write(NOTE_PATH, 'v1');
    const err = await rejectionCode(ws.write(NOTE_PATH, 'v2'));
    check('W6 a file changed while awaiting approval is a conflict, never a stale apply',
      err?.code === 'skill_mutation_conflict'
        && new TextDecoder().decode(storage.files.get(NOTE_PATH).bytes) === 'raced',
      String(err));
  }
  // Delete requires confirmation too; decline keeps the file. The decline
  // script starts at call 2 — the setup create (call 1) confirms.
  {
    const storage = skillStorageDouble();
    const approvals = approvalDouble({
      outcome: (n) => (n === 1 ? { outcome: 'confirm' } : { outcome: 'cancel' }),
    });
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals) });
    await ws.write(NOTE_PATH, 'keep');
    const err = await rejectionCode(ws.remove(NOTE_PATH));
    check('W7 a declined delete keeps the skill file',
      err?.code === 'skill_mutation_declined' && storage.files.has(NOTE_PATH), String(err));
  }
  {
    const storage = skillStorageDouble();
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvalDouble({})) });
    await ws.write(NOTE_PATH, 'gone soon');
    await ws.remove(NOTE_PATH);
    check('W8 a confirmed delete removes the file through the storage port',
      !storage.files.has(NOTE_PATH));
  }
  // The moved SKILL_DIFF_MAX_CHARS bound still fails closed (20000 chars).
  {
    const storage = skillStorageDouble();
    const approvals = approvalDouble({});
    const ws = new SkillInstanceWorkspace({ storage, context: liveContext(storage, approvals) });
    await ws.write(NOTE_PATH, 'base\n');
    const err = await rejectionCode(ws.write(NOTE_PATH, 'base\n' + 'x'.repeat(20100)));
    check('W9 a diff above the moved 20000-char presentation bound refuses before any approval',
      err?.code === 'skill_mutation_too_large' && approvals.calls.length === 1, String(err));
  }
  // productTaskVfsMounts maps pure specs onto StaticFileWorkspace providers.
  {
    const specs = [{
      path: '/mnt/plugins/pkg-a', name: 'pkg-a-introspection',
      files: { 'plugin.json': '{"id":"pkg-a"}' }, authority: 'system-read-only',
    }];
    const manager = { taskVfsMountSpecs: () => specs }; // port double: specs only
    const mounts = productTaskVfsMounts(manager, {});
    const providerText = await mounts[0].provider.read('/plugin.json');
    check('W10 mount specs become read-only StaticFileWorkspace providers',
      mounts.length === 1 && mounts[0].path === '/mnt/plugins/pkg-a'
      && mounts[0].authority === 'system-read-only'
      && mounts[0].provider instanceof StaticFileWorkspace
      && providerText === '{"id":"pkg-a"}'
      && (await rejectionCode(mounts[0].provider.write('/x', 'y')))?.name === 'ReadOnlyError');
  }
  // SkillInstanceStorage addresses relative to the home provider port.
  {
    const home = {
      calls: [],
      async readBytes(p) { this.calls.push(p); return new Uint8Array([1]); },
    };
    const st = new SkillInstanceStorage({ resolveHome: () => home });
    await st.readBytes('cap1/note.skill');
    check('W11 instance storage addresses stay under the .skills root of the CURRENT home',
      home.calls[0] === '.skills/cap1/note.skill');
    const unmounted = rejectionCode(new SkillInstanceStorage({}).readBytes('x'));
    check('W12 an unmounted home fails loudly (NotMountedError), never silently',
      (await unmounted)?.name === 'NotMountedError');
  }
}

// ============================================================
// 7. Storage failures are never converted into success
// ============================================================
{
  // AttachmentStore against a persistence port double whose metadata write fails:
  // the ingest fails with the ORIGINAL failure and rolls back only its own blob.
  {
    const deleted = [];
    const blobs = new Map();
    const failing = {
      async findAttachmentMetaBySha256() { return null; },
      async hasAttachmentBytes() { return false; },
      async writeAttachmentBytes(key) { blobs.set(key, true); },
      async saveAttachmentMeta() { const e = new Error('idb write failed'); e.name = 'PersistenceError'; throw e; },
      async deleteAttachmentBytes(key) { deleted.push(key); blobs.delete(key); },
      async getAttachmentMeta() { return null; },
    };
    const store = new AttachmentStore({ persistence: failing });
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]);
    const err = await rejectionCode(store.ingestImage({ bytes: png, name: 'a.png', declaredType: 'image/png' }));
    check('F1 a failed attachment metadata write surfaces as the storage failure it is',
      !!err && err.name === 'PersistenceError' && err.message === 'idb write failed', String(err));
    check('F2 only the blob THIS ingest created is rolled back (no silent success)',
      deleted.length === 1 && !blobs.has(deleted[0]));
  }
  // Corrupted durable bytes fail loudly on the verified read path.
  {
    const service = new PersistenceService();
    await service.ready;
    const store = new AttachmentStore({ persistence: service });
    const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9]);
    const record = await store.ingestImage({ bytes: png, name: 'ok.png', declaredType: 'image/png' });
    // Same-length bit-flip first: the size gate passes, the hash gate fires.
    await service.writeAttachmentBytes(record.storageKey, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9]));
    const err = await rejectionCode(store.getBytes(record.id));
    check('F3 a bit-flipped durable blob is an integrity failure, never base64 material',
      isAttachmentIntegrityError(err) && err.reason === 'hash_mismatch', String(err));
    const wireErr = await rejectionCode(store.resolveForWire(record.id));
    check('F4 resolveForWire refuses corrupted bytes instead of a null payload',
      isAttachmentIntegrityError(wireErr) && wireErr.reason === 'hash_mismatch');
    // A truncated blob fails at the CHEAP first gate (size), by design order.
    await service.writeAttachmentBytes(record.storageKey, new Uint8Array([1, 2, 3]));
    const truncErr = await rejectionCode(store.getBytes(record.id));
    check('F4b a truncated durable blob fails at the size gate before any hashing',
      isAttachmentIntegrityError(truncErr) && truncErr.reason === 'size_mismatch');
    // The happy path: a clean ingest resolves to the exact bytes as one-request base64.
    await service.writeAttachmentBytes(record.storageKey, png);
    const wire = await store.resolveForWire(record.id);
    check('F5 a clean ingest resolves to the exact bytes as one-request base64',
      wire.mimeType === 'image/png'
      && Buffer.from(wire.dataBase64, 'base64').equals(Buffer.from(png))
      && record.sha256 === createHash('sha256').update(png).digest('hex'));
    const part = imageContentPart(record), text = textContentPart('hi');
    check('F6 content parts stay reference-shaped (no base64 in the semantic part)',
      part.attachmentId === record.id && part.sha256 === record.sha256 && part.dataBase64 === undefined
        && text.type === 'text' && text.text === 'hi');
  }
  // PersistenceService memory path keeps record validation honest.
  {
    const service = new PersistenceService();
    await service.ready;
    const err = await rejectionCode(service.put('settings', { noKey: true }));
    check('F7 a persisted record without id/key is a serialization failure, never a silent drop',
      err?.code === 'persistence_serialization_failed', String(err));
    const integrity = attachmentIntegrityError('size_mismatch', { id: 'att_x' });
    check('F8 the integrity error shape is stable for UI/debug surfaces',
      integrity.name === 'AttachmentIntegrityError' && integrity.code === 'attachment_integrity_error'
        && integrity.reason === 'size_mismatch' && integrity.attachmentId === 'att_x');
  }
}

// ============================================================
// 8. Real PersistenceService (memory mode in Node) + harness identity import
// ============================================================
{
  const service = new PersistenceService();
  await service.ready;
  check('P1 the service degrades honestly outside the browser (memory mode, unavailable health)',
    service.mode === 'memory' && service.persistenceHealth === 'unavailable'
      && service.lastPersistenceError.code === 'persistence_unavailable');

  await service.saveSettings({ apiBase: 'https://api.example.test/v1', model: 'm1' });
  const settings = await service.loadSettings();
  check('P2 settings round-trip through the real storage implementation',
    settings.apiBase === 'https://api.example.test/v1' && settings.model === 'm1');

  const config = { dialect: 'openai', apiBase: 'https://api.example.test/v1', model: 'm1' };
  await service.setRememberedApiKey('sk-test', true, config);
  const remembered = await service.loadRememberedApiKey(config);
  const forgotten = await service.loadRememberedApiKey({ ...config, apiBase: 'https://other.example.test/v1' });
  check('P3 remembered credentials key through the REAL harness credential identity',
    remembered === 'sk-test' && forgotten === null);

  await service.saveConversation({ id: 'c-9', title: 't', updatedAt: '2026-10-04T00:00:00.000Z' });
  await service.appendPresentationEvent('c-9', 1, { type: 'task_start' });
  await service.saveProviderSession({ id: 'ps-1', conversationId: 'c-9', provider: 'openai', updatedAt: '2026-10-04T00:00:00Z' });
  await service.appendProviderFrame({ id: 'f1', sessionId: 'ps-1', conversationId: 'c-9', sequence: 1, role: 'user', kind: 'user', raw: { role: 'user', content: 'q' } });
  await service.saveNormalizedMessage({ conversationId: 'c-9', sequence: 1, role: 'user', kind: 'user', text: 'q' });
  const frames = await service.loadProviderFrames('ps-1');
  const rows = await service.loadNormalizedMessages('c-9');
  check('P4 conversation records keep their durable format (frames, normalized rows)',
    frames.length === 1 && frames[0].sequence === 1 && frames[0].sessionId === 'ps-1'
      && rows.length === 1 && rows[0].conversationId === 'c-9');

  // ConversationHistoryWorkspace is a read-only persistence view over the service.
  const hws = new ConversationHistoryWorkspace(service);
  const conversations = await hws.list('');
  const messages = (await hws.read('c-9/messages.jsonl')).trim().split('\n').map((l) => JSON.parse(l));
  const roErr = await rejectionCode(hws.write('c-9/messages.jsonl', 'x'));
  check('P5 the history view lists conversations, serves messages.jsonl, refuses writes',
    conversations.length === 1 && conversations[0].name === 'c-9'
      && messages.length === 1 && messages[0].text === 'q'
      && roErr.message.startsWith('read-only filesystem'));
  const normalizedView = await hws.readBytes('c-9/messages.jsonl');
  check('P6 the history view hands out bytes (TextEncoder of the text view)',
    normalizedView instanceof Uint8Array && new TextDecoder().decode(normalizedView).endsWith('\n'));

  // The normalizeWorkspacePath algorithm is the ONE runtime algorithm
  // (relative form; traversal past the root throws).
  let escapes = null;
  try { normalizeWorkspacePath('/../../etc'); } catch (e) { escapes = e; }
  check('P7 normalizeWorkspacePath normalizes and rejects root escape for every provider alike',
    normalizeWorkspacePath('/a/../b') === 'b' && normalizeWorkspacePath('') === ''
      && !!escapes && /escapes workspace/.test(escapes.message));
}

console.log('---');
if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('all ' + passed + ' checks passed');
