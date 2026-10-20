// ============================================================
//  CAPABILITY PACKAGE INSTALL SERVICE (C1-P2, docs/CAPABILITY-INSTALL.md)
//
//  The non-UI half of .locus import: inspect (parse + verify, zero
//  writes) → user confirmation → commit (durable write + manager
//  registration with rollback), boot-time loading (verify BEFORE
//  register — a mismatch is reported, never silently loaded), the
//  accept/skip flow for a booted mismatch, version replacement,
//  uninstall and the listing projection.
//
//  Pure service module: NO Vue, NO DOM, NO store.js import. Storage
//  arrives as the `persistence` port (src/persistence.js API);
//  composition arrives as the harness `manager` (CapabilityManager,
//  through src/product/harness-api.js); `now` is an injectable
//  ISO-time function.
//
//  Storage split (D10/§5): records live in the 'capabilityPackages'
//  IDB store; the archive bytes live in OPFS capability-packages/<id>/
//  <digest>.locus — a directory NEVER mounted into the VFS (the model
//  can neither read nor write it; verified adversarially by CI14).
//
//  Diagnostics are data, never throws: { code, path, message } with
//  codes capability_closed_list / capability_build /
//  capability_unexpected_files / capability_identity plus the
//  container's locus_* codes.
// ============================================================

import {
  readLocusArchive, parseLocusMd, renderLocusMd, manifestDigest, verifyLocusFiles,
  repinManifest, appendChangelogEntry, writeLocusArchive, expectedPackagePaths, LOCUS_LIMITS,
} from './locus-archive.js';
import { buildProject } from './capability-package.js';
import { createMemoryWorkspace } from './product/runtime-api.js';

// At most this many inspect results wait for their user confirmation;
// the oldest is dropped first (the UI asks the user to inspect again).
const PENDING_LIMIT = 4;

function diagnostic(code, path, message, extra) {
  const d = { code, path, message };
  if (extra) Object.assign(d, extra);
  return d;
}

function randomToken() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'tok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

export function createCapabilityPackages({ persistence, manager, now }) {
  if (!persistence) throw new Error('createCapabilityPackages requires a persistence port');
  if (!manager) throw new Error('createCapabilityPackages requires a CapabilityManager');
  const clock = typeof now === 'function' ? now : () => new Date().toISOString();

  // token -> { id, version, kind, files, manifest, body, mismatched,
  //            pkgInput, components, needsMismatchAcceptance, existing }
  const pending = new Map();
  // ids judged 'mismatch' by the LAST loadInstalled — the only ones
  // acceptMismatch may act on (CAPABILITY-INSTALL.md §5.3).
  const mismatchPending = new Set();

  // ---------- shared internal step: analyze (§4.1) ----------
  // Read → parse → closed-list/identity/build verification → the
  // manager's registerPackage input. ZERO writes anywhere: bytes stay
  // in a throwaway memory workspace.
  async function analyze(bytes, expectedManifest) {
    const read = await readLocusArchive(bytes);
    if (!read.ok) return { ok: false, diagnostics: read.diagnostics };
    const parsed = parseLocusMd(read.locusMd);
    if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
    const manifest = parsed.manifest;

    const verification = await verifyLocusFiles(expectedManifest || manifest, read.files);
    if (verification.missing.length || verification.extra.length) {
      // The closed list never "continues": extra and missing files are
      // a rejection, not a repin candidate.
      const parts = [];
      if (verification.missing.length) parts.push('missing: ' + verification.missing.join(', '));
      if (verification.extra.length) parts.push('unexpected: ' + verification.extra.join(', '));
      return { ok: false, diagnostics: [diagnostic('capability_closed_list', '',
        'the archive does not match its closed file list (' + parts.join('; ') + ')')] };
    }
    const mismatched = verification.mismatched.map((m) => m.path);

    // Build the project on a byte-exact memory workspace to reuse the
    // package core unchanged. MemoryWorkspace.write creates parent
    // directories implicitly (verified), so no extra mkdir step.
    const workspace = createMemoryWorkspace({
      maxBytes: LOCUS_LIMITS.maxTotalBytes,
      maxFileBytes: LOCUS_LIMITS.maxFileBytes,
    });
    for (const [path, data] of read.files) await workspace.write(path, data);
    const built = await buildProject({ workspace, root: '' });
    if (!built.ok) {
      return { ok: false, diagnostics: [diagnostic('capability_build', '',
        'project build failed: ' + built.diagnostics.map((d) => d.code + (d.path ? ' at ' + d.path : '')).join('; '),
        { build: built.diagnostics })] };
    }
    const lock = built.bundle.lock;

    const expected = expectedPackagePaths(lock);
    const actual = [...read.files.keys()].sort();
    if (expected.length !== actual.length || expected.some((p, i) => p !== actual[i])) {
      return { ok: false, diagnostics: [diagnostic('capability_unexpected_files', '',
        'archive files do not equal the package’s closed runtime set (expected '
        + expected.length + ' files, archive holds ' + actual.length + ')')] };
    }
    if (manifest.id !== lock.capability.id || manifest.version !== lock.capability.version) {
      return { ok: false, diagnostics: [diagnostic('capability_identity', '',
        'manifest identity ' + JSON.stringify(manifest.id + '@' + manifest.version)
        + ' does not match capability.json ' + JSON.stringify(lock.capability.id + '@' + lock.capability.version))] };
    }

    // The manager's registerPackage input (§6): wheel bytes under the
    // plugin id, default skill text under the skill id.
    const artifacts = {};
    for (const p of lock.plugins) {
      // Package v1: exactly one python-wheel per plugin (CAPABILITY-PACKAGE §2b.2)
      const a = p.artifacts[0];
      artifacts[p.descriptor.id] = {
        filename: a.path.split('/').pop(), format: a.format, size: a.size, sha256: a.sha256,
        bytes: built.bundle.readBytes(a.path),
      };
    }
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const sources = {};
    for (const s of lock.skills) {
      sources[s.descriptor.id] = {
        version: s.descriptor.version,
        source: decoder.decode(built.bundle.readBytes(s.sourcePath)),
      };
    }
    const pkgInput = {
      capability: lock.capability,
      plugins: lock.plugins.map((p) => p.descriptor),
      skills: lock.skills.map((s) => s.descriptor),
      mcps: lock.mcps,
      sources, artifacts,
    };
    const components = {
      plugins: lock.plugins.map((p) => p.descriptor.id),
      skills: lock.skills.map((s) => s.descriptor.id),
      mcps: lock.mcps.map((m) => m.id),
    };
    return { ok: true, files: read.files, manifest, body: parsed.body, mismatched, pkgInput, components };
  }

  async function existingRecord(id) {
    const records = await persistence.loadCapabilityPackages();
    return records.find((r) => r && r.id === id) || null;
  }

  function digestOf(manifest, files, mismatched) {
    return mismatched && mismatched.length
      ? repinManifest(manifest, files).then((m) => manifestDigest(m))
      : manifestDigest(manifest);
  }

  // ---------- inspect (§4.2): check only, zero writes ----------
  async function inspect(bytes) {
    const a = await analyze(bytes, null);
    if (!a.ok) return { ok: false, diagnostics: a.diagnostics };

    const repinned = a.mismatched.length > 0;
    const effectiveManifest = repinned ? await repinManifest(a.manifest, a.files) : a.manifest;
    const digest = await manifestDigest(effectiveManifest);

    const existing = await existingRecord(a.manifest.id);
    let kind;
    if (!existing) kind = 'new';
    else if (existing.version === a.manifest.version && existing.digest === digest && !repinned) kind = 'same';
    else kind = 'replace';

    const needsMismatchAcceptance = repinned
      || (kind === 'replace' && !!existing && existing.version === a.manifest.version);

    const orphanedSkills = existing && existing.components && Array.isArray(existing.components.skills)
      ? existing.components.skills.filter((id) => !a.components.skills.includes(id))
      : [];

    let totalBytes = 0;
    for (const data of a.files.values()) totalBytes += data.byteLength;

    const token = randomToken();
    while (pending.size >= PENDING_LIMIT) {
      pending.delete(pending.keys().next().value);
    }
    pending.set(token, {
      id: a.manifest.id,
      version: a.manifest.version,
      kind,
      files: a.files,
      manifest: a.manifest,
      body: a.body,
      mismatched: a.mismatched,
      pkgInput: a.pkgInput,
      components: a.components,
      needsMismatchAcceptance,
      existing,
    });

    const desc = (list) => list.map((id) => ({ id, displayName: displayNameOf(a.pkgInput, id) }));
    return {
      ok: true,
      token,
      kind,
      id: a.manifest.id,
      version: a.manifest.version,
      author: a.manifest.author,
      purpose: a.manifest.purpose,
      body: a.body,
      digest,
      mismatched: a.mismatched,
      needsMismatchAcceptance,
      components: {
        plugins: desc(a.components.plugins),
        skills: desc(a.components.skills),
        mcps: a.components.mcps.map((id) => {
          const m = (a.pkgInput.mcps || []).find((x) => x && x.id === id);
          return { id, displayName: m ? m.displayName : id };
        }),
      },
      fileCount: a.files.size,
      totalBytes,
      existing: existing
        ? { version: existing.version, digest: existing.digest, enabled: !!existing.enabled }
        : null,
      orphanedSkills,
    };
  }

  function displayNameOf(pkgInput, id) {
    const p = pkgInput.plugins.find((d) => d.id === id);
    if (p) return p.displayName;
    const s = pkgInput.skills.find((d) => d.id === id);
    if (s) return s.displayName;
    return id;
  }

  // The changelog line a user-accepted mismatch appends (§4). Shared by
  // commit and acceptMismatch so both produce the same wording.
  function mismatchChangelogLine(mismatched) {
    return clock().slice(0, 10) + '：导入时内容与元文件不一致，用户确认接受：' + mismatched.join('、');
  }

  // ---------- commit (§4.3): the user confirmed ----------
  async function commit(token, opts) {
    const entry = pending.get(token);
    if (!entry) throw new Error('capability package inspection expired; inspect again');
    pending.delete(token);

    if (entry.needsMismatchAcceptance && !((opts || {}).acceptMismatch === true)) {
      throw new Error('capability package content does not match its manifest; repeat the commit with acceptMismatch to confirm');
    }
    if (entry.kind === 'same') {
      return { id: entry.id, state: manager.capabilityState(entry.id), unchanged: true };
    }

    const id = entry.id;
    let manifest = entry.manifest;
    let body = entry.body;
    if (entry.mismatched.length) {
      manifest = await repinManifest(manifest, entry.files);
      body = appendChangelogEntry(body, mismatchChangelogLine(entry.mismatched));
    }
    const digest = await manifestDigest(manifest);
    const archive = await writeLocusArchive(entry.files, renderLocusMd({ body, manifest }));

    // Ordering with rollback (§4.3 step 6): bytes → unregister old →
    // register new → record → delete old bytes → re-enable. Every
    // step's failure undoes what the earlier steps did.
    await persistence.writeCapabilityPackageBytes(id, digest, archive);

    const existing = entry.existing;
    let wasEnabled = false;
    if (existing) {
      // A registered package reads the LIVE manager state; one the boot
      // verification skipped (never registered — §5.3) only has the
      // record's enabled bit. Either way D10 keeps it: enabled before
      // the replacement, re-enabled after.
      wasEnabled = manager.isPackage(id)
        ? manager.capabilityState(id) !== 'disabled'
        : !!existing.enabled;
      if (manager.isPackage(id)) {
        // keepInstances: true — the skill instance directory survives the
        // replacement; the §6.3 upgrade rule takes over on re-enable.
        await manager.unregisterPackage(id, { keepInstances: true });
      }
    }

    try {
      await manager.registerPackage(entry.pkgInput);
    } catch (e) {
      // Roll the old version back in (the loadInstalled rebuild path
      // over the OLD record + OLD bytes), then remove the new bytes —
      // unless they are also the old version's bytes.
      if (existing) {
        try {
          await loadOne(existing, { registerOnly: true });
          if (wasEnabled) await manager.enable(id);
        } catch (ignored) { /* best-effort rollback; the original error still wins */ }
      }
      if (!existing || existing.digest !== digest) {
        try { await persistence.deleteCapabilityPackageBytes(id, digest); } catch (ignored) { /* keep the original error */ }
      }
      throw e;
    }

    const record = {
      id,
      version: manifest.version,
      digest,
      manifest,
      body,
      components: entry.components,
      enabled: wasEnabled,
      installedAt: existing ? existing.installedAt : clock(),
      updatedAt: clock(),
      verification: 'ok',
    };
    await persistence.saveCapabilityPackage(record);

    if (existing && existing.digest !== digest) {
      await persistence.deleteCapabilityPackageBytes(id, existing.digest);
    }
    if (wasEnabled) await manager.enable(id);

    return { id, state: manager.capabilityState(id), unchanged: false };
  }

  // ---------- enable-state persistence (§4.4) ----------
  async function setEnabled(id, enabled) {
    const record = await existingRecord(id);
    if (!record) return; // only INSTALLED packages are tracked
    record.enabled = !!enabled;
    record.updatedAt = clock();
    await persistence.saveCapabilityPackage(record);
  }

  // ---------- boot-time loading (§4.5) ----------
  // Verify BEFORE registration; a mismatch is reported, never loaded.
  // Returns one { id, version, status, mismatched, message } per record;
  // status ∈ loaded | mismatch | corrupt.
  async function loadInstalled() {
    const records = await persistence.loadCapabilityPackages();
    const results = [];
    mismatchPending.clear();
    for (const record of records) {
      if (!record || !record.id) continue;
      const outcome = await loadOne(record);
      results.push({
        id: record.id,
        version: record.version,
        status: outcome.status,
        mismatched: outcome.mismatched || [],
        message: outcome.message || null,
      });
      if (outcome.record) await persistence.saveCapabilityPackage(outcome.record);
    }
    return results;
  }

  // One record's load path — also the commit rollback's rebuild step
  // (registerOnly), and the per-record body of loadInstalled.
  async function loadOne(record, opts) {
    const registerOnly = !!(opts && opts.registerOnly);
    let bytes;
    try {
      bytes = await persistence.readCapabilityPackageBytes(record.id, record.digest);
    } catch (e) {
      return { status: 'corrupt', message: 'package bytes are missing (' + (e && e.name ? e.name : 'Error') + ')' };
    }

    let a;
    try {
      a = await analyze(bytes, record.manifest);
    } catch (e) {
      return { status: 'corrupt', message: 'package analysis failed: ' + (e && e.message ? e.message : String(e)) };
    }
    if (!a.ok) {
      const codes = a.diagnostics.map((d) => d.code);
      const fatal = codes.some((c) => c === 'capability_closed_list' || c === 'capability_build'
        || c === 'capability_unexpected_files' || c === 'capability_identity');
      if (fatal) return { status: 'corrupt', message: 'package content failed verification: ' + codes.join(', ') };
      return { status: 'corrupt', message: 'package is unreadable: ' + codes.join(', ') };
    }

    if (a.mismatched.length) {
      // Reported, queued for 继续/本次跳过 — NEVER registered. The
      // record keeps the old digest/manifest so 继续 can repin them.
      mismatchPending.add(record.id);
      return {
        status: 'mismatch',
        mismatched: a.mismatched,
        message: 'content does not match the recorded manifest; the package was not loaded',
        record: registerOnly ? undefined : Object.assign({}, record, {
          verification: 'mismatch-skipped',
          updatedAt: clock(),
        }),
      };
    }

    try {
      await manager.registerPackage(a.pkgInput);
    } catch (e) {
      return { status: 'corrupt', message: 'registration failed: ' + (e && e.message ? e.message : String(e)) };
    }
    if (registerOnly) return { status: 'loaded' };
    if (record.enabled) await manager.enable(record.id);
    const verificationWasSkipped = record.verification === 'mismatch-skipped';
    return {
      status: 'loaded',
      record: verificationWasSkipped
        ? Object.assign({}, record, { verification: 'ok', updatedAt: clock() })
        : undefined,
    };
  }

  // ---------- accept a booted mismatch (§4.6) ----------
  // The user clicked 继续: repin to the ACTUAL bytes, append the
  // changelog line, replace the stored archive, register, save with
  // verification 'ok', delete the old bytes, re-enable if it was enabled.
  async function acceptMismatch(id) {
    if (!mismatchPending.has(id)) {
      throw new Error('capability package ' + id + ' was not skipped as a mismatch at load time; nothing to accept');
    }
    const record = await existingRecord(id);
    if (!record) throw new Error('capability package ' + id + ' is not installed');

    const bytes = await persistence.readCapabilityPackageBytes(id, record.digest);
    const a = await analyze(bytes, record.manifest);
    if (!a.ok) {
      throw new Error('capability package ' + id + ' can no longer be analyzed: '
        + a.diagnostics.map((d) => d.code).join(', '));
    }

    const manifest = await repinManifest(a.manifest, a.files);
    const body = appendChangelogEntry(a.body, mismatchChangelogLine(a.mismatched));
    const digest = await manifestDigest(manifest);
    const archive = await writeLocusArchive(a.files, renderLocusMd({ body, manifest }));

    await persistence.writeCapabilityPackageBytes(id, digest, archive);
    try {
      await manager.registerPackage(a.pkgInput);
    } catch (e) {
      if (digest !== record.digest) {
        try { await persistence.deleteCapabilityPackageBytes(id, digest); } catch (ignored) { /* keep the original error */ }
      }
      throw e;
    }
    await persistence.saveCapabilityPackage(Object.assign({}, record, {
      manifest, body, digest, verification: 'ok', updatedAt: clock(),
    }));
    if (record.digest !== digest) {
      await persistence.deleteCapabilityPackageBytes(id, record.digest);
    }
    if (record.enabled) await manager.enable(id);
    mismatchPending.delete(id);
    return { id, state: manager.capabilityState(id) };
  }

  // ---------- uninstall (§4.7; D10 keeps the skill instances) ----------
  async function uninstall(id) {
    if (manager.isPackage(id)) {
      await manager.unregisterPackage(id, { keepInstances: true });
    }
    await persistence.deleteCapabilityPackageBytes(id, null);
    await persistence.deleteCapabilityPackage(id);
    return { id, state: manager.capabilityState(id) };
  }

  // ---------- listing (§4.8) ----------
  async function list() {
    const records = await persistence.loadCapabilityPackages();
    return {
      durable: !!(persistence.opfsAvailable && persistence.mode === 'indexeddb'),
      packages: records.map((r) => ({
        id: r.id,
        version: r.version,
        author: r.manifest ? r.manifest.author : undefined,
        purpose: r.manifest ? r.manifest.purpose : undefined,
        body: r.body,
        digest: r.digest,
        enabled: !!r.enabled,
        verification: r.verification,
        installedAt: r.installedAt,
        updatedAt: r.updatedAt,
        loaded: manager.isPackage(r.id),
      })),
    };
  }

  return { analyze, inspect, commit, setEnabled, loadInstalled, acceptMismatch, uninstall, list };
}
