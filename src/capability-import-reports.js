// ============================================================
//  CAPABILITY IMPORT REPORTS (C4 §2.4) — pure service
//
//  One JSON report per capability-import attempt, written to
//  /home/locus/capability-imports/<YYYYMMDD-HHMMSS>-<slug>.json so the
//  model can read over bash what happened (success, refused inspection,
//  failed commit, cancelled confirmation) and react on the next turn.
//
//  This module is DELIBERATELY UI-free (no Vue, no store.js, no DOM):
//  the composition site (src/ui/store.js) supplies the CURRENT /home/locus
//  provider lazily via resolveHome() — memory before boot, OPFS after —
//  the same never-capture-a-stale-home pattern as SkillInstanceStorage.
//
//  Reporting must never break the import it describes: record() resolves
//  even when every write fails, routing the error through the injected
//  noteError sink (the composition site forwards to the existing
//  persistence-issue report). Reports carry structural facts ONLY — the
//  caller never passes credential values (credentials are connected AFTER
//  an import and produce no report at all).
// ============================================================

export const CAPABILITY_IMPORTS_DIR = 'capability-imports';
export const CAPABILITY_IMPORTS_KEEP = 20;
export const CAPABILITY_IMPORT_REPORT_SCHEMA_VERSION = 1;

// Same-second name collisions append -2, -3, …; a hard cap keeps a frozen
// test clock from spinning forever.
const COLLISION_LIMIT = 100;
const SLUG_MAX = 64;
const SLUG_FALLBACK = 'import';

// `<UTC YYYYMMDD-HHMMSS>` — fixed width so filename sort == time sort.
export function importReportStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const p2 = (n) => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()).padStart(4, '0')
    + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate())
    + '-' + p2(d.getUTCHours()) + p2(d.getUTCMinutes()) + p2(d.getUTCSeconds());
}

// The filename stem: the package id, else the label's basename, flattened
// to [a-z0-9._-] (other characters become '-', edge hyphens drop), at most
// 64 characters. '.locus' survives as part of the basename — it is part of
// the normalized file name the spec names.
export function importReportSlug(id, label) {
  let base = typeof id === 'string' && id.trim() ? id.trim() : '';
  if (!base && typeof label === 'string' && label.trim()) {
    base = label.trim().split(/[\\/]/).pop() || '';
  }
  let slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/-+$/, '');
  return slug || SLUG_FALLBACK;
}

export function createImportReports(opts) {
  const resolveHome = typeof (opts && opts.resolveHome) === 'function' ? opts.resolveHome : null;
  const now = typeof (opts && opts.now) === 'function' ? opts.now : () => new Date();
  // Failure sink (composition site → the persistence-issue report). With
  // no sink the failure is swallowed: reporting stays best-effort.
  const noteError = typeof (opts && opts.noteError) === 'function' ? opts.noteError : null;

  function _home() {
    const provider = resolveHome ? resolveHome() : null;
    if (!provider) throw new Error('/home/locus is not mounted; import reports are unavailable');
    return provider;
  }

  function _note(error, operation) {
    if (noteError) noteError(error, operation);
  }

  // Pick the first free `<stamp>-<slug>.json` (collisions append -2, -3…)
  // against the CURRENT directory listing.
  async function _pickName(provider, existing, stem) {
    let name = stem + '.json';
    if (!existing.has(name)) return name;
    for (let n = 2; n < COLLISION_LIMIT; n++) {
      name = stem + '-' + n + '.json';
      if (!existing.has(name)) return name;
    }
    throw new Error('capability-imports: no free report name for ' + stem
      + ' after ' + COLLISION_LIMIT + ' attempts');
  }

  // Keep the newest KEEP reports by FILENAME sort, delete the rest. A
  // prune failure never undoes a successful write above — it is noted and
  // the next record's listing self-corrects.
  async function _prune(provider) {
    let entries;
    try {
      entries = await provider.list(CAPABILITY_IMPORTS_DIR);
    } catch (e) {
      _note(e, 'capability import report pruning could not list ' + CAPABILITY_IMPORTS_DIR);
      return;
    }
    const reports = entries
      .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
    const stale = reports.slice(0, Math.max(0, reports.length - CAPABILITY_IMPORTS_KEEP));
    for (const name of stale) {
      try {
        await provider.remove(CAPABILITY_IMPORTS_DIR + '/' + name);
      } catch (e) {
        _note(e, 'capability import report pruning could not remove ' + name);
        return; // stop after the first failure; sorted order keeps the rest well-defined
      }
    }
  }

  // Writes ONE report and returns the filename it landed on, or null when
  // the write failed (already noted). `report` is the §2.4 body WITHOUT
  // schemaVersion/at — record() stamps those.
  async function record(report) {
    try {
      const provider = _home();
      const date = now();
      const stem = importReportStamp(date) + '-' + importReportSlug(report && report.id, report && report.label);
      // §2.4 field order: schemaVersion + at stamped first, the caller's
      // body (built in spec order by the composition site) after — an
      // explicit caller value for either still wins.
      const doc = Object.assign(
        { schemaVersion: CAPABILITY_IMPORT_REPORT_SCHEMA_VERSION, at: date.toISOString() },
        report || {},
      );
      try {
        if (typeof provider.mkdir === 'function') {
          await provider.mkdir(CAPABILITY_IMPORTS_DIR);
        }
      } catch (e) {
        // The skeleton pre-creates the dir; a failure here only matters if
        // the write below cannot proceed without it.
        if (e && e.name !== 'TypeMismatchError') _note(e, 'capability import report directory');
      }
      const entries = await provider.list(CAPABILITY_IMPORTS_DIR);
      const existing = new Set(entries.map((entry) => entry.name));
      const name = await _pickName(provider, existing, stem);
      // UTF-8 BYTES, never a raw string: the byte path is the one every
      // provider (memory + OPFS) is proven on — a string write can land
      // silently empty on OPFS.
      await provider.write(
        CAPABILITY_IMPORTS_DIR + '/' + name,
        new TextEncoder().encode(JSON.stringify(doc, null, 2) + '\n'),
      );
      await _prune(provider);
      return name;
    } catch (e) {
      _note(e, 'capability import report could not be written');
      return null;
    }
  }

  return { record };
}
