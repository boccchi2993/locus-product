// M3c-B BROWSER e2e (independent of integration D's product-page gates).
// Real headless Chrome drives the five converted Product modules as real
// ES modules over the two product API files (import map: bare core
// specifiers resolve into the installed locus-runtime / locus-harness
// packages — no deep core import anywhere):
//
//   P   REAL IndexedDB: schema v3 migration on open, settings round trip,
//       remembered credentials keyed through the REAL harness credential
//       identity, provider frames, atomic deleteConversation
//   O   REAL OPFS: home skeleton, privileged plugin write/read, attachment
//       bytes ingest/resolve through the REAL IDB+OPFS pair, corruption
//       refused, clear
//   C   capability package: the REAL fixture project validated/built
//       through the REAL harness descriptor validators; the lock hash is
//       sha256Hex and the page's crypto.subtle oracle agrees
//   R   replay validators: the persistence surface IS the harness entry
//       function; valid prefix accepted, corrupted prefix rejected
//   S   skill instance contract: harness-owned marker refused, path
//       identity, confirmation required
//
// In-page doubles are storage/approval PORTS only. Run:
//   node tests/e2e-m3c-storage-adapters.cjs
// (e2e registry wiring is integration D's change — see docs/M3C-B-HANDOFF.md.)

const fs = require('fs/promises');
const fsSync = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const {
  allocateFreePort, closeChrome, connectToTarget, launchChrome, waitForCdp,
  waitForPageTarget, waitForRuntimeCondition,
} = require('./helpers/chrome.cjs');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capability-package', 'minimal');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

function serveFile(res, abs) {
  try {
    const data = fsSync.readFileSync(abs);
    res.setHeader('content-type', MIME[path.extname(abs)] || 'application/octet-stream');
    res.end(data);
  } catch (e) {
    res.statusCode = 404;
    res.end('not found');
  }
}

function safeJoin(base, rel) {
  const abs = path.join(base, rel);
  if (!abs.startsWith(base)) return null;
  return abs;
}

// The fixture tree the page builds the capability project from (embedded as
// base64 — every file is tiny; the wheel is ~1.3 KB).
function fixtureTree() {
  const out = {};
  const walk = (abs, rel) => {
    for (const name of fsSync.readdirSync(abs)) {
      const childAbs = path.join(abs, name);
      const childRel = rel ? rel + '/' + name : name;
      if (fsSync.statSync(childAbs).isDirectory()) walk(childAbs, childRel);
      else out[childRel] = fsSync.readFileSync(childAbs).toString('base64');
    }
  };
  walk(FIXTURE_DIR, '');
  return out;
}

function buildPage(fixtureB64) {
  const importMap = {
    imports: {
      'locus-runtime': '/vendor/locus-runtime/src/index.js',
      'locus-runtime/workspace': '/vendor/locus-runtime/src/workspace-api.js',
      'locus-runtime/worker-assets': '/vendor/locus-runtime/src/worker-assets.js',
      'locus-harness': '/vendor/locus-harness/src/index.js',
    },
  };
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>M3c-B storage adapters</title>'
    + '<script type="importmap">' + JSON.stringify(importMap) + '<\/script>'
    + '</head><body>'
    + '<script type="module">'
    + `const FIXTURE_B64 = ${JSON.stringify(fixtureB64)};\n`
    + `
import * as harnessApi from '/src/product/harness-api.js';
import * as runtimeApi from '/src/product/runtime-api.js';
import { ConversationHistoryWorkspace } from '/src/conversation-history-workspace.js';
import * as persistenceMod from '/src/persistence.js';
import * as attachmentsMod from '/src/attachments.js';
import * as extensionsMod from '/src/extensions.js';
import * as cpMod from '/src/capability-package.js';

const b64ToBytes = (b64) => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const subtleSha = async (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const service = new persistenceMod.PersistenceService();
const boot = (async () => {
  await service.ready;
  return {
    persistenceMode: service.mode,
    health: service.persistenceHealth,
    opfsAvailable: service.opfsAvailable,
  };
})();

async function runP() {
  await service.saveSettings({ apiBase: 'https://api.example.test/v1', model: 'm1' });
  const settings = await service.loadSettings();
  const config = { dialect: 'openai', apiBase: 'https://api.example.test/v1', model: 'm1' };
  await service.setRememberedApiKey('sk-browser', true, config);
  const remembered = await service.loadRememberedApiKey(config);
  const other = await service.loadRememberedApiKey({ ...config, apiBase: 'https://other.example.test/v1' });
  await service.saveConversation({ id: 'c-br', title: 't', updatedAt: '2026-10-04T00:00:00.000Z' });
  await service.saveProviderSession({ id: 'ps-br', conversationId: 'c-br', provider: 'openai', updatedAt: '2026-10-04T00:00:00.000Z' });
  await service.appendProviderFrame({ id: 'pf-1', sessionId: 'ps-br', conversationId: 'c-br', sequence: 1, role: 'user', kind: 'user', raw: { role: 'user', content: 'q' } });
  const framesBefore = await service.loadProviderFrames('ps-br');
  const deleted = await service.deleteConversation('c-br');
  const framesAfter = await service.loadProviderFrames('ps-br');
  const conversationsAfter = await service.loadConversations();
  return {
    settingsOk: settings.apiBase === 'https://api.example.test/v1' && settings.model === 'm1',
    rememberedOk: remembered === 'sk-browser' && other === null,
    framesBefore: framesBefore.length,
    deleted,
    framesAfter: framesAfter.length,
    conversationsAfter: conversationsAfter.length,
  };
}

async function runO() {
  await service.ensureHomeSkeleton();
  await service.opfsDirectory(['home', 'locus', '.skills']); // throws if absent
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  await service.writePlugin('pkg-x/plugin.json', payload);
  const readBack = await service.readPlugin('pkg-x/plugin.json');
  await service.clearPlugins();
  let pluginGone;
  try { await service.readPlugin('pkg-x/plugin.json'); pluginGone = false; } catch (e) { pluginGone = true; }

  const store = new attachmentsMod.AttachmentStore({ persistence: service });
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 7, 7, 7]);
  const record = await store.ingestImage({ bytes: png, name: 'b.png', declaredType: 'image/png' });
  const hasBefore = await service.hasAttachmentBytes(record.storageKey);
  const wire = await store.resolveForWire(record.id);
  const wireBytes = Uint8Array.from(atob(wire.dataBase64), (c) => c.charCodeAt(0));
  const sameLen = new Uint8Array([1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9]);
  await service.writeAttachmentBytes(record.storageKey, sameLen);
  let corruptReason = null;
  try { await store.getBytes(record.id); } catch (e) { corruptReason = attachmentsMod.isAttachmentIntegrityError(e) ? e.reason : String(e.message); }
  await service.clearAttachments();
  const hasAfter = await service.hasAttachmentBytes(record.storageKey);
  return {
    pluginRoundTrip: readBack instanceof Uint8Array && [...readBack].join() === [...payload].join(),
    pluginGone,
    attachmentDurable: hasBefore === true,
    wireOk: wire.mimeType === 'image/png' && [...wireBytes].join() === [...png].join(),
    corruptReason,
    cleared: hasAfter === false,
  };
}

async function runC() {
  const files = {};
  for (const [rel, b64] of Object.entries(FIXTURE_B64)) files[rel] = b64ToBytes(b64);
  const ws = new extensionsMod.StaticFileWorkspace({ name: 'fixture', files });
  const validation = await cpMod.validateProject({ workspace: ws, root: '' });
  const build = await cpMod.buildProject({ workspace: ws, root: '' });
  if (!build.ok) return { validateOk: validation.ok, buildOk: false, diagnostics: build.diagnostics };
  const skillBytes = build.bundle.readBytes('skills/test-workflow/SKILL.md');
  const lockSkill = build.bundle.lock.skills.find((s) => s.descriptor.id === 'test-workflow');
  const inspect = cpMod.inspectBundle(build.bundle);
  return {
    validateOk: validation.ok === true && validation.diagnostics.length === 0,
    buildOk: build.ok === true && build.bundle instanceof cpMod.CapabilityBundle,
    hashAgreesWithSubtle: lockSkill.sha256 === await subtleSha(skillBytes)
      && lockSkill.size === skillBytes.byteLength,
    inspectValid: inspect.valid === true && inspect.capability.id === 'package-test-capability',
  };
}

async function runR() {
  const adapter = harnessApi.getProviderAdapter({ dialect: 'openai', apiBase: 'https://api.example.test/v1' });
  const session = {
    id: 's-br', conversationId: 'c-br', replayCheckpointSequence: 2,
    provider: 'openai', adapterId: adapter.adapterId, dialect: 'openai',
    endpointIdentity: 'https://api.example.test/v1', model: 'm1', protocolVersion: 'chat-completions-v1',
  };
  const frames = [
    { sequence: 1, sessionId: 's-br', conversationId: 'c-br', kind: 'user', role: 'user', raw: { role: 'user', content: 'hi' } },
    { sequence: 2, sessionId: 's-br', conversationId: 'c-br', kind: 'assistant', role: 'assistant', raw: { role: 'assistant', content: 'done' } },
  ];
  const ok = persistenceMod.validateReplayPrefix(session, frames, adapter);
  let badCode = null;
  try {
    persistenceMod.validateReplayPrefix(session, [frames[0], { ...frames[1], sessionId: 's-x' }], adapter);
  } catch (e) { badCode = e.code; }
  return {
    identity: persistenceMod.validateReplayPrefix === harnessApi.validateReplayPrefix,
    validAccepted: !!ok && ok.valid === true && ok.checkpoint === 2,
    corruptedCode: badCode,
  };
}

async function runS() {
  const storage = {
    files: new Map([['cap1/note.skill', { bytes: new TextEncoder().encode('v1') }]]),
    async list() { return [{ name: 'cap1', kind: 'directory' }]; },
    async readBytes(rel) {
      const f = this.files.get(rel);
      if (!f) { const e = new Error('no such file: ' + rel); e.name = 'NotFoundError'; throw e; }
      return f.bytes.slice();
    },
    async read(rel) { return new TextDecoder().decode(await this.readBytes(rel)); },
    async writeBytes(rel, bytes) { this.files.set(rel, { bytes: new Uint8Array(bytes) }); },
    async exists(rel) { return this.files.has(rel); },
    async stat(rel) {
      const f = this.files.get(rel);
      if (!f) { const e = new Error('no such file: ' + rel); e.name = 'NotFoundError'; throw e; }
      return { kind: 'file', size: f.bytes.byteLength, modified: null };
    },
    async removeFile(rel) { this.files.delete(rel); },
  };
  const noApprovals = new extensionsMod.SkillInstanceWorkspace({
    storage,
    context: { taskEnvironment: { capabilities: [{ id: 'cap1', state: 'enabled', skillIds: ['note'] }], skills: [] }, approvals: null, getSignal: () => ({ aborted: false }) },
  });
  let noApprovalsCode = null;
  try { await noApprovals.write('cap1/note.skill', 'x'); } catch (e) { noApprovalsCode = e.code; }
  return {
    pathIdentity: harnessApi.skillInstancePath('cap1', 'note')
      === harnessApi.SKILL_INSTANCE_ROOT + '/cap1/note.skill',
    markerWriteCode: await (async () => {
      const ws = new extensionsMod.SkillInstanceWorkspace({
        storage,
        context: {
          taskEnvironment: { capabilities: [{ id: 'cap1', state: 'enabled', skillIds: ['note'] }], skills: [] },
          approvals: { request: async () => ({ outcome: 'confirm' }) },
          conversationId: 'c', taskGeneration: 1, getSignal: () => ({ aborted: false }),
        },
      });
      try { await ws.write('cap1/' + harnessApi.SKILL_INSTANCE_MARKER, 'x'); return null; }
      catch (e) { return e.code; }
    })(),
    noApprovalsCode,
    bound: harnessApi.SKILL_INSTANCE_MAX_BYTES,
  };
}

window.__m3c = {
  ready: false,
  boot: null,
  error: null,
  async runAll() {
    await boot;
    const out = {};
    for (const [key, fn] of [['p', runP], ['o', runO], ['c', runC], ['r', runR], ['s', runS]]) {
      try { out[key] = await fn(); }
      catch (e) { out[key] = { error: String(e && e.message || e) }; }
    }
    return out;
  },
};
boot.then(() => { window.__m3c.bootData = boot; window.__m3c.ready = true; })
  .catch((e) => { window.__m3c.error = String(e && e.message || e); window.__m3c.ready = true; });
<\/script></body></html>`;
}

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs || 30000,
  });
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600));
  return result?.result?.value;
}

async function main() {
  let server;
  let chrome = null;
  let profileDir = null;
  let passed = 0, failed = 0;
  const check = (name, condition, detail) => {
    if (condition) { passed++; console.log('PASS ' + name); }
    else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
  };

  const port = await allocateFreePort();
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/' || p === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(buildPage(fixtureTree()));
      return;
    }
    if (p.startsWith('/src/')) {
      const abs = safeJoin(path.join(ROOT, 'src'), p.slice('/src/'.length));
      return serveFile(res, abs);
    }
    if (p.startsWith('/vendor/locus-runtime/')) {
      const abs = safeJoin(path.join(ROOT, 'node_modules', 'locus-runtime'), p.slice('/vendor/locus-runtime/'.length));
      return serveFile(res, abs);
    }
    if (p.startsWith('/vendor/locus-harness/')) {
      const abs = safeJoin(path.join(ROOT, 'node_modules', 'locus-harness'), p.slice('/vendor/locus-harness/'.length));
      return serveFile(res, abs);
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const pageUrl = 'http://127.0.0.1:' + port + '/';
  try {
    profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'locus-m3cb-profile-'));
    chrome = await launchChrome(pageUrl, {
      chromePath: process.env.CHROME,
      label: 'M3c-B storage adapters Chrome',
      profileDir,
      extraArgs: ['--window-size=1280,800'],
    });
    await waitForCdp(chrome, { timeoutMs: 15000 });
    const target = await waitForPageTarget(chrome, pageUrl, { timeoutMs: 15000 });
    const cdp = await connectToTarget(target);
    await waitForRuntimeCondition(cdp, '!!(window.__m3c && window.__m3c.ready)',
      { process: chrome, phase: 'm3cb-boot', timeoutMs: 15000 });
    check('B0 all five converted modules imported over the two API files', true);
    const bootData = await evaluate(cdp, 'window.__m3c.bootData');
    if (!bootData) throw new Error('boot failed: ' + JSON.stringify(await evaluate(cdp, 'window.__m3c.error')));

    check('B1 REAL IndexedDB: schema v3 opened, health healthy',
      bootData.persistenceMode === 'indexeddb' && bootData.health === 'healthy',
      JSON.stringify(bootData));
    check('B2 REAL OPFS available', bootData.opfsAvailable === true);

    const r = await evaluate(cdp, 'window.__m3c.runAll()', 60000);

    check('P1 settings round trip over REAL IndexedDB', r.p.settingsOk === true, JSON.stringify(r.p));
    check('P2 remembered credentials keyed through the REAL harness identity', r.p.rememberedOk === true);
    check('P3 deleteConversation atomically removes frames over REAL IndexedDB',
      r.p.framesBefore === 1 && r.p.deleted === true && r.p.framesAfter === 0 && r.p.conversationsAfter === 0,
      JSON.stringify(r.p));

    check('O1 home skeleton created in REAL OPFS', r.o.error === undefined && r.o.pluginRoundTrip === true, JSON.stringify(r.o));
    check('O2 privileged plugin write/read round-trips REAL OPFS bytes', r.o.pluginRoundTrip === true && r.o.pluginGone === true);
    check('O3 attachment ingest is durable (REAL IDB meta + OPFS bytes)', r.o.attachmentDurable === true);
    check('O4 resolveForWire returns the exact ingested bytes', r.o.wireOk === true);
    check('O5 corrupted durable bytes refused with hash_mismatch', r.o.corruptReason === 'hash_mismatch', String(r.o.corruptReason));
    check('O6 clearAttachments removes the durable bytes', r.o.cleared === true);

    check('C1 REAL fixture project validates', r.c.validateOk === true, JSON.stringify(r.c));
    check('C2 REAL fixture project builds a bundle', r.c.buildOk === true);
    check('C3 lock hash = sha256Hex = crypto.subtle oracle over exact bytes', r.c.hashAgreesWithSubtle === true);
    check('C4 inspectBundle reports the valid bundle', r.c.inspectValid === true);

    check('R1 persistence validators ARE the harness entry functions', r.r.identity === true, JSON.stringify(r.r));
    check('R2 the REAL validator accepts a valid prefix in the browser', r.r.validAccepted === true);
    check('R3 corrupted prefix rejected with session_identity_mismatch', r.r.corruptedCode === 'session_identity_mismatch');

    check('S1 harness skill-instance path identity holds in the browser', r.s.pathIdentity === true, JSON.stringify(r.s));
    check('S2 the harness-owned install marker is refused for mutation', r.s.markerWriteCode === 'skill_mutation_boundary');
    check('S3 skill mutation without an approval port fails closed', r.s.noApprovalsCode === 'skill_mutation_no_task');
    check('S4 the shared 256 KiB skill bound is the harness value', r.s.bound === 262144);
  } finally {
    if (chrome) await closeChrome(chrome);
    if (profileDir) { try { await fs.rm(profileDir, { recursive: true, force: true }); } catch (e) {} }
    if (server) { try { await new Promise((r) => server.close(r)); } catch (e) {} }
  }
  console.log('---');
  if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
  console.log('all ' + passed + ' checks passed');
}

main().catch((e) => { console.error('SUITE ERROR: ' + (e && e.message || e)); process.exit(1); });
