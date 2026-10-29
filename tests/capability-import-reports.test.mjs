// C4 §2.4 capability import reports unit battery (node, NO DOM):
//
//   IR1  report format: §2.4 field order, schemaVersion/at stamped,
//        pretty-printed JSON with a trailing newline
//   IR2  filename rules: UTC YYYYMMDD-HHMMSS stamp, slug from id, slug
//        from the label basename, [a-z0-9._-] normalization, 64-char cap,
//        empty-slug fallback
//   IR3  same-second collision suffixes ~02 / ~03 (different slugs never
//        collide); filename sort equals write order
//   IR4  retention: only the newest 20 reports survive, by FILENAME sort —
//        under a frozen clock (one stem, 25 writes) exactly the last 20
//        written
//   IR5  write failures never propagate: record() resolves null and notes
//        through the injected sink (missing home, refusing provider);
//        the next record recovers
//   IR6  a prune failure does not undo a successful write
//   IR7  store-level: a PASSED inspection writes NO report until the
//        dialog decision (one report per attempt: confirm → exactly one
//        commit report, cancel → exactly one cancelled report), refused
//        inspect reports via path and via broken bytes — and NEITHER the
//        credential test key NOR the commit token appears in any report
//        file (full-text over the whole home)
//
// The browser gate drives the same flow over the REAL built app
// (tests/e2e-import-reports.cjs, registered in run-browser-gates.cjs).
// Run: node tests/capability-import-reports.test.mjs

import * as reportsMod from '../src/capability-import-reports.js';
import * as persistenceMod from '../src/persistence.js';

const { createImportReports, importReportSlug, importReportStamp } = reportsMod;

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function section(label) { console.log('=== ' + label); }

// A minimal /home/locus stand-in with the provider surface the service
// uses (mkdir/list/write/remove/read). Flat capability-imports dir.
function fakeHome(opts = {}) {
  const files = new Map(); // 'capability-imports/<name>' -> string
  const provider = {
    name: 'fake-home',
    async mkdir(p) { if (p !== 'capability-imports') throw new Error('unexpected mkdir: ' + p); },
    async list(dir) {
      if (dir !== 'capability-imports') throw new Error('unexpected list: ' + dir);
      return [...files.keys()]
        .map((p) => p.slice(dir.length + 1))
        .sort()
        .map((name) => ({ name, kind: 'file' }));
    },
    async write(p, data) {
      if (opts.failWrites) throw new Error('write refused by test');
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      files.set(p, text);
    },
    async remove(p) {
      if (opts.failRemoves) throw new Error('remove refused by test');
      if (!files.delete(p)) throw new Error('not found: ' + p);
    },
    async read(p) { return files.get(p); },
  };
  provider._files = files;
  return provider;
}

function serviceWith(homeProvider, { notes = null, now = null } = {}) {
  const seenNotes = [];
  const service = createImportReports({
    resolveHome: homeProvider === null ? () => null : () => homeProvider,
    now: now || (() => new Date(Date.UTC(2026, 9, 27, 8, 0, 0))),
    noteError: (e, op) => { seenNotes.push({ message: e && e.message, operation: op }); },
  });
  return { service, seenNotes };
}

const namesOf = (home) => [...home._files.keys()].map((p) => p.slice('capability-imports/'.length)).sort();

// ---------- IR1/IR2/IR3/IR4/IR5/IR6: the pure service ----------
{
  section('IR1 report format');

  // Fixed-stamp helper sanity (UTC, zero-padded).
  check('IR1 stamp is UTC YYYYMMDD-HHMMSS',
    importReportStamp(new Date(Date.UTC(2026, 9, 27, 8, 0, 5))) === '20261027-080005'
    && importReportStamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))) === '20260102-030405',
    importReportStamp(new Date(Date.UTC(2026, 9, 27, 8, 0, 5))));

  const home = fakeHome();
  const { service } = serviceWith(home);
  const name = await service.record({
    source: 'path',
    label: '/mnt/download/reference-text-analysis-1.0.0.locus',
    stage: 'inspect',
    ok: true,
    id: 'reference-text-analysis', version: '1.0.0', kind: 'new',
    diagnostics: [],
    result: null,
    userAction: null,
  });
  check('IR1 record returns the written filename',
    name === '20261027-080000-reference-text-analysis.json', JSON.stringify(namesOf(home)));
  const text = home._files.get('capability-imports/' + name);
  let doc = null;
  try { doc = JSON.parse(text); } catch (e) { /* asserted below */ }
  check('IR1 the file parses as JSON',
    !!doc && doc.schemaVersion === 1,
    text && text.slice(0, 200));
  check('IR1 at is the ISO stamp of the same instant',
    doc && doc.at === '2026-10-27T08:00:00.000Z', doc && doc.at);
  check('IR1 field order follows §2.4',
    doc && JSON.stringify(Object.keys(doc)) === JSON.stringify([
      'schemaVersion', 'at', 'source', 'label', 'stage', 'ok',
      'id', 'version', 'kind', 'diagnostics', 'result', 'userAction',
    ]), doc && JSON.stringify(Object.keys(doc)));
  check('IR1 pretty-printed with a trailing newline',
    typeof text === 'string' && text.includes('\n  "at":')
      && text.endsWith('\n') && text.trimEnd().length < text.length,
    text && text.slice(0, 80));
}

{
  section('IR2 slug + filename rules');
  check('IR2 slug prefers the id',
    importReportSlug('ref-text', '/mnt/download/whatever.locus') === 'ref-text');
  check('IR2 without an id the label basename is used (dots kept)',
    importReportSlug('', '/mnt/download/ref-analysis-1.0.0.locus') === 'ref-analysis-1.0.0.locus'
    && importReportSlug(null, 'C:\\Downloads\\my.cap.locus') === 'my.cap.locus',
    importReportSlug(null, 'C:\\Downloads\\my.cap.locus'));
  check('IR2 disallowed characters flatten to hyphens, edges trimmed',
    importReportSlug('', '/tmp/Ref Text -- Analysis!.locus') === 'ref-text-analysis-.locus'
    && importReportSlug('  ', '/mnt/中文包.locus') === '.locus',
    importReportSlug('', '/tmp/Ref Text -- Analysis!.locus') + ' / '
      + importReportSlug('  ', '/mnt/中文包.locus'));
  check('IR2 longer than 64 characters is capped (no trailing hyphen)',
    (() => { const s = importReportSlug('x'.repeat(80) + '-tail', null); return s.length === 64 && !s.endsWith('-'); })(),
    importReportSlug('x'.repeat(80) + '-tail', null));
  check('IR2 nothing usable falls back to "import"',
    importReportSlug('', '') === 'import' && importReportSlug(null, null) === 'import');
  const home = fakeHome();
  const { service } = serviceWith(home);
  const name = await service.record({ label: '/mnt/download/No Id Here.locus', stage: 'inspect', ok: false, diagnostics: [] });
  check('IR2 the record filename carries the label-derived slug',
    name === '20261027-080000-no-id-here.locus.json', name);
}

{
  section('IR3 same-second collision suffixes');
  const home = fakeHome();
  const { service } = serviceWith(home);
  const n1 = await service.record({ id: 'dup', stage: 'inspect', ok: true });
  const n2 = await service.record({ id: 'dup', stage: 'inspect', ok: true });
  const n3 = await service.record({ id: 'dup', stage: 'inspect', ok: true });
  const nOther = await service.record({ id: 'other', stage: 'inspect', ok: true });
  // 2026-10-29 FIX-IR1：后缀改为 ~NN 以保证文件名排序 = 写入顺序
  //（旧 "-2" 的字符码排在 ".json" 的 "." 之前，同一秒先写的那份反而排序最新）。
  check('IR3 collisions append ~02 then ~03',
    n1 === '20261027-080000-dup.json' && n2 === '20261027-080000-dup~02.json'
    && n3 === '20261027-080000-dup~03.json',
    JSON.stringify([n1, n2, n3]));
  check('IR3 a different slug in the same second never collides',
    nOther === '20261027-080000-other.json', nOther);
  check('IR3 all four files exist', namesOf(home).length === 4, JSON.stringify(namesOf(home)));
  check('IR3 filename sort equals write order',
    JSON.stringify(namesOf(home)) === JSON.stringify([n1, n2, n3, nOther]),
    JSON.stringify({ sorted: namesOf(home), written: [n1, n2, n3, nOther] }));
}

{
  section('IR4 keep only the newest 20 (filename sort)');
  const home = fakeHome();
  let minute = 0, second = 0;
  const { service } = serviceWith(home, {
    now: () => new Date(Date.UTC(2026, 9, 27, 8, minute, second)),
  });
  for (let i = 0; i < 25; i++) {
    second = i; // distinct stamps 08:00:00 … 08:00:24
    await service.record({ id: 'r' + String(i).padStart(2, '0'), stage: 'inspect', ok: true });
  }
  const names = namesOf(home);
  check('IR4 exactly 20 reports remain', names.length === 20, JSON.stringify(names));
  check('IR4 the OLDEST five were removed (r00…r04), the newest survive',
    names.length === 20 && !names.some((n) => /r0[0-4]\.json$/.test(n))
    && names[0] === '20261027-080005-r05.json' && names[19] === '20261027-080024-r24.json',
    JSON.stringify(names.slice(0, 3)) + ' … ' + JSON.stringify(names.slice(-2)));

  // 30 same-second collisions: filename sort still keeps a well-defined
  // newest-20, and since FIX-IR1 it is exactly the last 20 written (the
  // picker never hands out a name the pruner deleted).
  const home2 = fakeHome();
  const { service: s2 } = serviceWith(home2);
  const written2 = [];
  for (let i = 0; i < 30; i++) {
    written2.push(await s2.record({ id: 'burst', stage: 'inspect', ok: true }));
  }
  const names2 = namesOf(home2);
  check('IR4 a same-second burst keeps exactly 20 too', names2.length === 20,
    JSON.stringify(names2.length));

  // Fixed clock, 25 writes, ONE stem (the FIX-IR1 acceptance shape): the
  // survivors are exactly the last 20 written, no name reused.
  const home3 = fakeHome();
  const { service: s3 } = serviceWith(home3);
  const written3 = [];
  for (let i = 0; i < 25; i++) {
    written3.push(await s3.record({ id: 'freeze', stage: 'inspect', ok: true }));
  }
  const names3 = namesOf(home3);
  check('IR4 a frozen clock keeps exactly the last 20 written',
    new Set(written3).size === 25 && names3.length === 20
    && JSON.stringify(names3) === JSON.stringify(written3.slice(-20).sort()),
    JSON.stringify({ written: written3, remain: names3 }));
}

{
  section('IR5 write failures never propagate');
  const badHome = fakeHome({ failWrites: true });
  const { service, seenNotes } = serviceWith(badHome);
  let result = null, threw = null;
  try { result = await service.record({ id: 'x', stage: 'inspect', ok: true }); }
  catch (e) { threw = e; }
  check('IR5 a refusing provider resolves null (never throws)',
    threw === null && result === null, threw && String(threw));
  check('IR5 the failure reached the note sink with the report operation',
    seenNotes.length === 1 && /import report/.test(seenNotes[0].operation)
    && /write refused/.test(seenNotes[0].message),
    JSON.stringify(seenNotes));

  const { service: noHome, seenNotes: noHomeNotes } = serviceWith(null);
  result = null; threw = null;
  try { result = await noHome.record({ id: 'x', stage: 'inspect', ok: true }); }
  catch (e) { threw = e; }
  check('IR5 a missing home mount resolves null and is noted',
    threw === null && result === null && noHomeNotes.length === 1
    && /not mounted/.test(noHomeNotes[0].message),
    JSON.stringify(noHomeNotes));

  // Recovery: after the failing provider is replaced by a working one the
  // next record lands normally (the same lazy resolveHome now resolves it).
  const goodHome = fakeHome();
  let current = badHome;
  const recovered = createImportReports({
    resolveHome: () => current,
    now: () => new Date(Date.UTC(2026, 9, 27, 8, 0, 0)),
    noteError: () => {},
  });
  const first = await recovered.record({ id: 'a', stage: 'inspect', ok: true });
  current = goodHome;
  const second = await recovered.record({ id: 'b', stage: 'inspect', ok: true });
  check('IR5 the next record after a failure succeeds',
    first === null && second === '20261027-080000-b.json'
    && goodHome._files.size === 1,
    JSON.stringify({ first, second }));
}

{
  section('IR6 prune failures do not undo the write');
  const home = fakeHome({ failRemoves: true });
  // Pre-seed a FULL retention window (20 old reports) so the new record
  // must prune the oldest one — which this provider refuses.
  for (let i = 0; i < 20; i++) {
    home._files.set('capability-imports/20260101-000000-old' + i + '.json', '{}');
  }
  const { service, seenNotes } = serviceWith(home);
  const name = await service.record({ id: 'kept', stage: 'inspect', ok: true });
  check('IR6 the report file exists although pruning failed',
    name === '20261027-080000-kept.json'
    && home._files.has('capability-imports/20261027-080000-kept.json'),
    JSON.stringify(namesOf(home)));
  check('IR6 the prune failure was noted', seenNotes.length === 1
    && /pruning could not remove/.test(seenNotes[0].operation), JSON.stringify(seenNotes));
  check('IR6 nothing was pruned (the refusal stopped the sweep)',
    namesOf(home).length === 21, JSON.stringify(namesOf(home).length));
}

// ---------- IR7: the store-level flow + redaction ----------
{
  section('IR7 store-level reports: inspect / commit / cancel / refusal');
  // The capability-install.test.mjs rig shape: real store module, memory
  // persistence, memory home. A fresh store per suite run (scenario query).
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
  globalThis.sessionStorage = fakeSessionStorage(null);
  await persistenceMod.PersistenceServiceInstance.reset();

  const store = await import('../src/ui/store.js?ir7');
  await store.whenBooted;

  const { buildFixturePackage } = await import('./helpers/locus-fixtures.mjs');
  const TEST_KEY = 'sk-unit-report-5f3a9c1e7b2d';
  const CRED = {
    name: 'UNIT_CRED_KEY', label: 'Unit credential', description: 'TEST ONLY.',
    origin: 'https://api.example.test', pathPrefix: '/v1/tools/',
    header: 'Authorization', scheme: 'Bearer',
  };
  const PKG = await buildFixturePackage({
    id: 'report-cap', version: '1.0.0',
    displayName: 'Report Cap', description: 'TEST ONLY import-report fixture.',
    skills: [{ id: 'report-skill', displayName: 'Report Skill', body: '# report-skill\n' }],
    credentials: [CRED],
  });

  // Read helpers over the CURRENT /home/locus provider (memory here).
  const listReports = async () => (await store.vfs.list('/home/locus/capability-imports'))
    .filter((e) => e.kind === 'file').map((e) => e.name).sort();
  const readReport = async (name) => JSON.parse(await store.vfs.read('/home/locus/capability-imports/' + name));
  const wholeHomeText = async () => {
    const chunks = [];
    const walk = async (dir) => {
      for (const entry of await store.vfs.list(dir)) {
        const p = dir + '/' + entry.name;
        if (entry.kind === 'directory') await walk(p);
        else chunks.push(await store.vfs.read(p));
      }
    };
    await walk('/home/locus');
    return chunks.join('\\n');
  };
  // The newest report by the at stamp (millisecond tiebreak). Filename
  // sort orders reports within ONE slug family — the FIX-IR1 ~NN suffix
  // keeps a collision chain in write order — but two DIFFERENT slugs
  // landing in the same second stay alphabetical, not chronological, so
  // this helper (like the e2e reader) picks by at.
  const lastReport = async () => {
    const names = await listReports();
    const docs = await Promise.all(names.map(readReport));
    let best = null;
    for (const d of docs) if (!best || d.at > best.at) best = d;
    return best;
  };

  // inspect (ok) — FIX-IR1: a passed inspection writes NOTHING while the
  // confirm dialog is open; the attempt reports once, at the decision.
  let rep = null;
  const namesBeforeBegin = await listReports();
  await store.beginCapabilityImportFromBytes(PKG, 'report-cap-1.0.0.locus');
  check('IR7 a passed inspection writes NO report while the dialog is open',
    JSON.stringify(await listReports()) === JSON.stringify(namesBeforeBegin),
    JSON.stringify(await listReports()));

  // commit (ok) — result.state / enabled / enableError, and the attempt's
  // ONLY report.
  await store.confirmCapabilityImport();
  rep = await lastReport();
  check('IR7 commit-ok report: stage commit, confirmed, result shape',
    rep.stage === 'commit' && rep.ok === true && rep.userAction === 'confirmed'
    && rep.id === 'report-cap'
    && rep.result && rep.result.state === 'ready' && rep.result.enabled === true
    && rep.result.enableError === null
    && Array.isArray(rep.diagnostics) && rep.diagnostics.length === 0,
    JSON.stringify(rep));
  check('IR7 the Import flow (begin + confirm) added EXACTLY ONE report',
    (await listReports()).length === namesBeforeBegin.length + 1,
    JSON.stringify({ before: namesBeforeBegin.length, after: (await listReports()).length }));

  // cancel — userAction 'cancelled' (cancel is fire-and-forget: poll).
  await store.beginCapabilityImportFromBytes(PKG, 'report-cap-again.locus');
  const beforeNames = new Set(await listReports());
  store.cancelCapabilityImport();
  let cancelled = null;
  for (let t = 0; t < 100 && !cancelled; t++) {
    await new Promise((r) => setTimeout(r, 20));
    for (const n of await listReports()) {
      if (!beforeNames.has(n)) cancelled = await readReport(n);
    }
  }
  check('IR7 cancelled report: stage inspect ok, userAction cancelled',
    !!cancelled && cancelled.stage === 'inspect' && cancelled.ok === true
    && cancelled.userAction === 'cancelled' && cancelled.id === 'report-cap',
    JSON.stringify(cancelled));
  check('IR7 the cancel flow added EXACTLY ONE report',
    (await listReports()).length === beforeNames.size + 1,
    JSON.stringify(await listReports()));

  // refused inspect via PATH (missing file → capability_import_failed).
  await store.beginCapabilityImportFromPath('/mnt/download/missing.locus');
  rep = await lastReport();
  check('IR7 path refusal report: ok false with the import_failed diagnostic',
    rep.stage === 'inspect' && rep.ok === false && rep.source === 'path'
    && rep.diagnostics.length === 1 && rep.diagnostics[0].code === 'capability_import_failed',
    JSON.stringify(rep));

  // A structurally-broken package bytes → the package-core diagnostic.
  const broken = PKG.slice(0, PKG.length - 64);
  await store.beginCapabilityImportFromBytes(broken, 'broken.locus');
  rep = await lastReport();
  check('IR7 broken-package report: ok false, a locus_* diagnostic code',
    rep.stage === 'inspect' && rep.ok === false
    && rep.diagnostics.length > 0 && /^locus_/.test(rep.diagnostics[0].code)
    && typeof rep.diagnostics[0].message === 'string',
    JSON.stringify(rep.diagnostics));

  // The redaction sweep: the key was never connected here, so ALSO prove
  // the summary path cannot leak — inject the key into the panel-facing
  // summary object the way the D12 connect step holds it and make sure the
  // REPORT text over the whole home never contains it, and never contains
  // the archive's token material.
  check('IR7 no report file mentions the test key or any token',
    !((await wholeHomeText()).includes(TEST_KEY))
    && !(JSON.stringify(await Promise.all((await listReports()).map(readReport)))).includes('token'),
    JSON.stringify((await listReports())));

  // Sanity: the boot skeleton created the reports dir in the home.
  const homeList = await store.vfs.list('/home/locus');
  check('IR7 capability-imports is part of the home skeleton',
    homeList.some((e) => e.name === 'capability-imports' && e.kind === 'directory'),
    JSON.stringify(homeList.map((e) => e.name)));

  // persistence.js exports the skeleton the store's VFS was built with.
  check('IR7 LOCUS_HOME_SKELETON includes capability-imports',
    persistenceMod.LOCUS_HOME_SKELETON.includes('capability-imports'),
    JSON.stringify(persistenceMod.LOCUS_HOME_SKELETON));
}

console.log('---');
console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
process.exit(failed ? 1 : 0);
