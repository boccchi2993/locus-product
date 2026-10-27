// .locus archive container unit tests (LA1–LA12):
// pack → read → parse → verify round trip over the REAL capability
// package fixture project, deterministic bytes, manifest digest,
// closed-manifest verification, repinning, changelog append,
// LOCUS.md parse/render, the full readLocusArchive diagnostic matrix
// (hand-built hostile zips — bytes assembled in this file, no zip
// tooling), bounded zip-bomb abort, truncation safety, a
// Python-zipfile-generated archive cross-check, and store-only
// writing (LA13: 2026-10-28 owner decision — method 0 everywhere,
// byte-identical re-writes, old deflate-written archives still read).
// Run: node tests/locus-archive.test.mjs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- module under test ----
const LA = await import('../src/locus-archive.js');
const runtimeApi = await import('../src/product/runtime-api.js');
const { LocusCapabilityPackage } = await import('../src/capability-package.js');

let passed = 0, failed = 0;
let section = null;
const sectionStats = [];
function startSection(label) {
  section = { label, passed: 0, failed: 0 };
  sectionStats.push(section);
  console.log('=== ' + label);
}
function check(name, cond, detail) {
  if (cond) { passed++; section.passed++; console.log('PASS ' + name); }
  else { failed++; section.failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
function sha256HexNode(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
function crc32Node(bytes) {
  let table = crc32Node.table;
  if (!table) {
    table = crc32Node.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function codesOf(result) {
  return (result.diagnostics || []).map((d) => d.code);
}

// ---- fixture project (same construction as capability-package.test.cjs) ----
const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'capability-package', 'minimal');
function walkFixture(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFixture(full, r, out);
    else out.set(r, new Uint8Array(fs.readFileSync(full)));
  }
  return out;
}
const FIXTURE_FILES = walkFixture(FIXTURE_DIR, '', new Map());

// Provider caps per the packLocus contract: 128 MiB total, 64 MiB per
// file — the same numbers the archive limits declare.
async function fixtureWorkspace() {
  const ws = runtimeApi.createMemoryWorkspace({ maxBytes: 128 * 1024 * 1024, maxFileBytes: 64 * 1024 * 1024 });
  for (const [rel, data] of FIXTURE_FILES) await ws.write(rel, data);
  return ws;
}

function bytesEqual(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}
function cloneFileMap(m) {
  return new Map([...m].map(([k, v]) => [k, Uint8Array.from(v)]));
}

// ---- hand-built zip container for hostile-input cases ----
// Bytes assembled here directly — no zip library, no external tool.
function u16arr(v) { return [v & 0xFF, (v >>> 8) & 0xFF]; }
function u32arr(v) {
  const b = v >>> 0;
  return [b & 0xFF, (b >>> 8) & 0xFF, (b >>> 16) & 0xFF, (b >>> 24) & 0xFF];
}
function cat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
// entry: { name, data, payload?, method?, flags?, extAttrs?, crc?,
//          compSize?, uncompSize?, localSig?, localName? }
function buildTestZip(entries, opts = {}) {
  const enc = new TextEncoder();
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = e.data !== undefined ? e.data : new Uint8Array(0);
    const payload = e.payload !== undefined ? e.payload : data;
    const crc = e.crc !== undefined ? e.crc : crc32Node(data);
    const compSize = e.compSize !== undefined ? e.compSize : payload.byteLength;
    const uncompSize = e.uncompSize !== undefined ? e.uncompSize : data.byteLength;
    const method = e.method !== undefined ? e.method : 0;
    const flags = e.flags !== undefined ? e.flags : 0;
    const nameBytes = enc.encode(e.name);
    const localNameBytes = enc.encode(e.localName !== undefined ? e.localName : e.name);
    const localSig = e.localSig !== undefined ? e.localSig : 0x04034b50;
    parts.push(cat([
      new Uint8Array([
        ...u32arr(localSig), ...u16arr(20), ...u16arr(flags), ...u16arr(method),
        ...u16arr(0), ...u16arr(33), // time 0, date 1980-01-01
        ...u32arr(crc), ...u32arr(compSize), ...u32arr(uncompSize),
        ...u16arr(localNameBytes.length), ...u16arr(0),
      ]),
      localNameBytes,
      payload,
    ]));
    centrals.push({ nameBytes, crc, compSize, uncompSize, method, flags, extAttrs: e.extAttrs || 0, offset });
    offset += 30 + localNameBytes.length + payload.byteLength;
  }
  const cdStart = offset;
  for (const c of centrals) {
    parts.push(cat([
      new Uint8Array([
        ...u32arr(0x02014b50), ...u16arr(20), ...u16arr(20), ...u16arr(c.flags), ...u16arr(c.method),
        ...u16arr(0), ...u16arr(33),
        ...u32arr(c.crc), ...u32arr(c.compSize), ...u32arr(c.uncompSize),
        ...u16arr(c.nameBytes.length), ...u16arr(0), ...u16arr(0), // extra, comment
        ...u16arr(0), ...u16arr(0),                                // disk start, internal attrs
        ...u32arr(c.extAttrs), ...u32arr(c.offset),
      ]),
      c.nameBytes,
    ]));
    offset += 46 + c.nameBytes.length;
  }
  const totalEntries = opts.totalEntries !== undefined ? opts.totalEntries : entries.length;
  parts.push(new Uint8Array([
    ...u32arr(0x06054b50),
    ...u16arr(opts.diskNumber !== undefined ? opts.diskNumber : 0),
    ...u16arr(opts.cdDisk !== undefined ? opts.cdDisk : 0),
    ...u16arr(totalEntries), ...u16arr(totalEntries),
    ...u32arr(opts.cdSize !== undefined ? opts.cdSize : offset - cdStart),
    ...u32arr(opts.cdOffset !== undefined ? opts.cdOffset : cdStart),
    ...u16arr(0),
  ]));
  return cat(parts);
}

function goodManifestJson() {
  return JSON.stringify({
    schemaVersion: 1,
    id: 'demo-cap',
    version: '1.2.3',
    author: 'tester',
    purpose: 'unit test',
    files: [
      { path: 'a.txt', size: 3, sha256: 'ab'.repeat(32) },
      { path: 'b.txt', size: 4, sha256: 'cd'.repeat(32) },
    ],
  });
}
function locusMdWith(jsonText, body = 'Hello\n') {
  return body + '```locus-manifest\n' + jsonText + '\n```\n';
}

(async () => {
  // ===================== LA1 pack → read → parse → verify =====================
  startSection('LA1 pack/read/parse/verify round trip');
  const ws1 = await fixtureWorkspace();
  const built1 = await LocusCapabilityPackage.buildProject({ workspace: ws1, root: '' });
  check('LA1 fixture project builds', built1.ok === true, JSON.stringify(built1.diagnostics));
  const pack1 = await LA.packLocus({
    workspace: ws1,
    root: '',
    author: 'Locus archive test',
    purpose: 'LA1 round trip',
    body: '# Package Test Capability\n\nRound-trip fixture.\n\n## 更改记录\n- initial\n',
  });
  check('LA1 packLocus succeeds', pack1.ok === true && pack1.bytes instanceof Uint8Array,
    JSON.stringify(pack1.diagnostics));
  check('LA1 manifest identity comes from the lock',
    pack1.manifest.id === 'package-test-capability' && pack1.manifest.version === '1'
    && pack1.manifest.author === 'Locus archive test' && pack1.manifest.purpose === 'LA1 round trip');
  const read1 = await LA.readLocusArchive(pack1.bytes);
  check('LA1 readLocusArchive succeeds', read1.ok === true, JSON.stringify(read1.diagnostics));
  check('LA1 LOCUS.md decoded', typeof read1.locusMd === 'string'
    && read1.locusMd.includes('locus-manifest'));
  const parsed1 = LA.parseLocusMd(read1.locusMd);
  check('LA1 parseLocusMd succeeds and matches the packed manifest',
    parsed1.ok === true && JSON.stringify(parsed1.manifest) === JSON.stringify(pack1.manifest),
    JSON.stringify(parsed1.diagnostics));
  const verify1 = await LA.verifyLocusFiles(parsed1.manifest, read1.files);
  check('LA1 verifyLocusFiles is clean',
    verify1.missing.length === 0 && verify1.extra.length === 0 && verify1.mismatched.length === 0,
    JSON.stringify(verify1));
  const expectedPaths1 = LA.expectedPackagePaths(built1.bundle.lock);
  check('LA1 files match expectedPackagePaths(lock)',
    JSON.stringify([...read1.files.keys()].sort()) === JSON.stringify(expectedPaths1),
    JSON.stringify([...read1.files.keys()].sort()) + ' vs ' + JSON.stringify(expectedPaths1));
  let allBytesMatch = true;
  for (const [rel, data] of read1.files) {
    const original = FIXTURE_FILES.get(rel);
    if (!original || !bytesEqual(data, original)) allBytesMatch = false;
  }
  check('LA1 every packed file equals the workspace original', allBytesMatch);

  // ===================== LA2 determinism =====================
  startSection('LA2 deterministic bytes');
  const ws2 = await fixtureWorkspace();
  const pack2 = await LA.packLocus({
    workspace: ws2,
    root: '',
    author: 'Locus archive test',
    purpose: 'LA1 round trip',
    body: '# Package Test Capability\n\nRound-trip fixture.\n\n## 更改记录\n- initial\n',
  });
  check('LA2 packing the same project twice is byte-identical',
    pack2.ok && bytesEqual(pack1.bytes, pack2.bytes));

  // ===================== LA3 manifest digest =====================
  startSection('LA3 manifestDigest');
  const m3a = JSON.parse(goodManifestJson());
  const m3b = {
    files: [
      { sha256: 'ab'.repeat(32), size: 3, path: 'a.txt' },
      { sha256: 'cd'.repeat(32), size: 4, path: 'b.txt' },
    ],
    purpose: 'unit test',
    author: 'tester',
    version: '1.2.3',
    id: 'demo-cap',
    schemaVersion: 1,
  };
  const d3a = await LA.manifestDigest(m3a);
  const d3b = await LA.manifestDigest(m3b);
  check('LA3 digest is field-order independent',
    /^[0-9a-f]{64}$/.test(d3a) && d3a === d3b, d3a + ' vs ' + d3b);
  const m3c = JSON.parse(goodManifestJson());
  m3c.purpose = 'changed';
  const d3c = await LA.manifestDigest(m3c);
  const m3d = JSON.parse(goodManifestJson());
  m3d.files[0].size = 5;
  const d3d = await LA.manifestDigest(m3d);
  check('LA3 digest changes when any field changes',
    d3c !== d3a && d3d !== d3a);

  // ===================== LA4 verifyLocusFiles =====================
  startSection('LA4 closed-manifest verification');
  const files4 = cloneFileMap(read1.files);
  files4.set('stowaway.txt', new TextEncoder().encode('extra'));
  const v4extra = await LA.verifyLocusFiles(pack1.manifest, files4);
  check('LA4 extra file detected', JSON.stringify(v4extra.extra) === '["stowaway.txt"]'
    && v4extra.missing.length === 0 && v4extra.mismatched.length === 0, JSON.stringify(v4extra));
  const files4b = cloneFileMap(read1.files);
  files4b.delete('capability.json');
  const v4missing = await LA.verifyLocusFiles(pack1.manifest, files4b);
  check('LA4 missing file detected', JSON.stringify(v4missing.missing) === '["capability.json"]'
    && v4missing.extra.length === 0 && v4missing.mismatched.length === 0, JSON.stringify(v4missing));
  const files4c = cloneFileMap(read1.files);
  const victim = 'skills/test-workflow/SKILL.md';
  const originalBytes = files4c.get(victim);
  const flipped = Uint8Array.from(originalBytes);
  flipped[0] ^= 0xFF;
  files4c.set(victim, flipped);
  const v4mm = await LA.verifyLocusFiles(pack1.manifest, files4c);
  const expectedEntry = pack1.manifest.files.find((f) => f.path === victim);
  check('LA4 single flipped byte is a mismatch with correct expected/actual',
    v4mm.mismatched.length === 1 && v4mm.missing.length === 0 && v4mm.extra.length === 0
    && v4mm.mismatched[0].path === victim
    && v4mm.mismatched[0].expected.size === expectedEntry.size
    && v4mm.mismatched[0].expected.sha256 === expectedEntry.sha256
    && v4mm.mismatched[0].actual.size === flipped.byteLength
    && v4mm.mismatched[0].actual.sha256 === sha256HexNode(flipped)
    && v4mm.mismatched[0].expected.sha256 !== v4mm.mismatched[0].actual.sha256,
    JSON.stringify(v4mm));

  // ===================== LA5 repinManifest =====================
  startSection('LA5 repinManifest');
  const repinned = await LA.repinManifest(pack1.manifest, files4c);
  const v5 = await LA.verifyLocusFiles(repinned, files4c);
  check('LA5 repinned manifest verifies clean against the repinned bytes',
    v5.missing.length === 0 && v5.extra.length === 0 && v5.mismatched.length === 0,
    JSON.stringify(v5));
  check('LA5 identity fields are unchanged',
    repinned.id === pack1.manifest.id && repinned.version === pack1.manifest.version
    && repinned.author === pack1.manifest.author && repinned.purpose === pack1.manifest.purpose
    && repinned.schemaVersion === 1);
  check('LA5 repinned files list is sorted and complete',
    JSON.stringify(repinned.files.map((f) => f.path))
      === JSON.stringify([...files4c.keys()].sort()));

  // ===================== LA6 appendChangelogEntry =====================
  startSection('LA6 appendChangelogEntry');
  const b6a = '# Title\n\n## 更改记录\n- a\n- b\n\nfooter text\n';
  const r6a = LA.appendChangelogEntry(b6a, 'c');
  check('LA6 appends under an existing 更改记录 list',
    r6a === '# Title\n\n## 更改记录\n- a\n- b\n- c\n\nfooter text\n', JSON.stringify(r6a));
  const b6b = '# Title\n\n## Changelog\n- x\n';
  const r6b = LA.appendChangelogEntry(b6b, 'y');
  check('LA6 appends under an existing Changelog list',
    r6b === '# Title\n\n## Changelog\n- x\n- y\n', JSON.stringify(r6b));
  const b6c = '# Title\n\nplain body, no changelog yet\n';
  const r6c = LA.appendChangelogEntry(b6c, 'first entry');
  check('LA6 creates 更改记录 when neither heading exists',
    r6c === '# Title\n\nplain body, no changelog yet\n\n## 更改记录\n- first entry\n',
    JSON.stringify(r6c));
  check('LA6 original bodies are untouched',
    b6a === '# Title\n\n## 更改记录\n- a\n- b\n\nfooter text\n'
    && b6b === '# Title\n\n## Changelog\n- x\n'
    && b6c === '# Title\n\nplain body, no changelog yet\n');

  // ===================== LA7 render/parse round trip =====================
  startSection('LA7 renderLocusMd → parseLocusMd');
  const body7 = '# Title\n\nSome body text.\n\n## 更改记录\n- a\n';
  const md7 = LA.renderLocusMd({ body: body7, manifest: m3a });
  const parsed7 = LA.parseLocusMd(md7);
  check('LA7 manifest survives the round trip deeply equal',
    parsed7.ok === true && JSON.stringify(parsed7.manifest) === JSON.stringify(m3a),
    JSON.stringify(parsed7.diagnostics));
  check('LA7 body survives the round trip (modulo surrounding whitespace)',
    typeof parsed7.body === 'string' && parsed7.body.trim() === body7.trim(),
    JSON.stringify(parsed7.body));
  check('LA7 rendered text has exactly one single-line canonical block',
    (md7.match(/```locus-manifest/g) || []).length === 1
    && md7.includes('"id":"demo-cap","purpose":"unit test"'));

  // ===================== LA8 parseLocusMd diagnostics =====================
  startSection('LA8 parseLocusMd diagnostic matrix');
  function parseCase(name, text, code) {
    const r = LA.parseLocusMd(text);
    check(name, r.ok === false && codesOf(r).includes(code),
      JSON.stringify(codesOf(r)));
  }
  parseCase('LA8 missing block', 'Just prose, no manifest block.\n', 'locus_manifest_missing');
  parseCase('LA8 multiple blocks',
    locusMdWith(goodManifestJson(), 'A\n') + 'B\n' + locusMdWith(goodManifestJson()),
    'locus_manifest_multiple');
  parseCase('LA8 bad JSON', locusMdWith('{ not json'), 'locus_manifest_json');
  parseCase('LA8 unknown field',
    locusMdWith(JSON.stringify({ ...JSON.parse(goodManifestJson()), extra: true })),
    'locus_manifest_field');
  parseCase('LA8 schemaVersion 2',
    locusMdWith(JSON.stringify({ ...JSON.parse(goodManifestJson()), schemaVersion: 2 })),
    'locus_manifest_field');
  parseCase('LA8 author over 200 characters',
    locusMdWith(JSON.stringify({ ...JSON.parse(goodManifestJson()), author: 'x'.repeat(201) })),
    'locus_manifest_field');
  parseCase('LA8 files unsorted',
    locusMdWith(JSON.stringify({
      ...JSON.parse(goodManifestJson()),
      files: [
        { path: 'b.txt', size: 4, sha256: 'cd'.repeat(32) },
        { path: 'a.txt', size: 3, sha256: 'ab'.repeat(32) },
      ],
    })), 'locus_manifest_files');
  parseCase('LA8 files containing LOCUS.md',
    locusMdWith(JSON.stringify({
      ...JSON.parse(goodManifestJson()),
      files: [{ path: 'LOCUS.md', size: 1, sha256: 'ab'.repeat(32) }],
    })), 'locus_manifest_files');
  parseCase('LA8 uppercase sha256',
    locusMdWith(JSON.stringify({
      ...JSON.parse(goodManifestJson()),
      files: [{ path: 'a.txt', size: 3, sha256: 'AB'.repeat(32) }],
    })), 'locus_manifest_files');

  // ===================== LA9 readLocusArchive diagnostic matrix =====================
  startSection('LA9 readLocusArchive diagnostic matrix');
  function readCase(name, bytes, code, opts) {
    return LA.readLocusArchive(bytes, opts).then((r) => {
      check(name, r.ok === false && r.files.size === 0 && codesOf(r).includes(code),
        JSON.stringify(codesOf(r)));
    });
  }
  await readCase('LA9 not a zip', new TextEncoder().encode('this is definitely not a zip archive, plain text only'), 'locus_not_zip');
  await readCase('LA9 empty input', new Uint8Array(0), 'locus_not_zip');
  await readCase('LA9 zip64 EOCD placeholders',
    buildTestZip([{ name: 'LOCUS.md', data: new TextEncoder().encode('# x\n') }],
      { totalEntries: 0xFFFF }),
    'locus_zip64');
  await readCase('LA9 zip64 EOCD locator',
    (function () {
      const z = buildTestZip([{ name: 'LOCUS.md', data: new TextEncoder().encode('# x\n') }]);
      // Splice a zip64 EOCD locator (sig 0x07064b50, 20 bytes) right before the EOCD.
      const locator = new Uint8Array([...u32arr(0x07064b50), ...u32arr(0), ...u64arr(0), ...u32arr(1)]);
      const out = new Uint8Array(z.byteLength + locator.byteLength);
      out.set(z.subarray(0, z.byteLength - 22), 0);
      out.set(locator, z.byteLength - 22);
      out.set(z.subarray(z.byteLength - 22), z.byteLength - 22 + locator.byteLength);
      return out;
    })(),
    'locus_zip64');
  await readCase('LA9 multi-disk archive',
    buildTestZip([{ name: 'LOCUS.md', data: new TextEncoder().encode('# x\n') }], { diskNumber: 1 }),
    'locus_multi_disk');
  await readCase('LA9 too many entries',
    buildTestZip(Array.from({ length: 258 }, (_, i) => ({
      name: 'f' + String(i).padStart(4, '0') + '.txt',
      data: new TextEncoder().encode('x'),
    }))),
    'locus_too_many_entries');
  await readCase('LA9 encrypted entry',
    buildTestZip([{ name: 'LOCUS.md', data: new TextEncoder().encode('# x\n'), flags: 0x0001 }]),
    'locus_encrypted');
  await readCase('LA9 unsupported method',
    buildTestZip([{ name: 'LOCUS.md', data: new TextEncoder().encode('# x\n'), method: 12 }]),
    'locus_method_unsupported');
  // Path-name hostility: the five required shapes, each its own zip.
  const enc9 = new TextEncoder();
  await readCase('LA9 bad name ../x',
    buildTestZip([{ name: '../x', data: enc9.encode('x') }]), 'locus_bad_name');
  await readCase('LA9 bad name /abs',
    buildTestZip([{ name: '/abs', data: enc9.encode('x') }]), 'locus_bad_name');
  await readCase('LA9 bad name backslash',
    buildTestZip([{ name: 'a\\b', data: enc9.encode('x') }]), 'locus_bad_name');
  await readCase('LA9 bad name a//b',
    buildTestZip([{ name: 'a//b', data: enc9.encode('x') }]), 'locus_bad_name');
  await readCase('LA9 bad name ./a',
    buildTestZip([{ name: './a', data: enc9.encode('x') }]), 'locus_bad_name');
  await readCase('LA9 symlink entry',
    buildTestZip([{ name: 'link', data: enc9.encode('target'), extAttrs: (0o120777 << 16) >>> 0 }]),
    'locus_symlink');
  await readCase('LA9 duplicate entry',
    buildTestZip([
      { name: 'a.txt', data: enc9.encode('one') },
      { name: 'a.txt', data: enc9.encode('two') },
    ]),
    'locus_duplicate_entry');
  await readCase('LA9 local header bad signature',
    buildTestZip([{ name: 'a.txt', data: enc9.encode('x'), localSig: 0x04034b51 }]),
    'locus_local_header_mismatch');
  await readCase('LA9 local header name differs from central directory',
    buildTestZip([{ name: 'a.txt', data: enc9.encode('x'), localName: 'other.txt' }]),
    'locus_local_header_mismatch');
  await readCase('LA9 declared file over maxFileBytes',
    buildTestZip([{ name: 'big.bin', data: enc9.encode('tiny'), uncompSize: 64 * 1024 * 1024 + 1 }]),
    'locus_file_too_large');
  await readCase('LA9 LOCUS.md over maxLocusMdBytes',
    buildTestZip([{ name: 'LOCUS.md', data: enc9.encode('# x\n'), uncompSize: 256 * 1024 + 1 }]),
    'locus_file_too_large');
  await readCase('LA9 total over maxTotalBytes',
    buildTestZip([
      { name: 'LOCUS.md', data: enc9.encode('# x\n') },
      { name: 'a.txt', data: enc9.encode('yyyyyyyy') },
    ]),
    'locus_total_too_large',
    { limits: { maxTotalBytes: 10 } });
  await readCase('LA9 size mismatch',
    buildTestZip([{ name: 'a.txt', data: enc9.encode('12345'), uncompSize: 10 }]),
    'locus_size_mismatch');
  await readCase('LA9 CRC mismatch',
    buildTestZip([{ name: 'a.txt', data: enc9.encode('hello'), crc: 0xDEADBEEF }]),
    'locus_crc_mismatch');
  await readCase('LA9 missing LOCUS.md',
    buildTestZip([{ name: 'a.txt', data: enc9.encode('x') }]),
    'locus_missing_locus_md');
  await readCase('LA9 LOCUS.md not valid UTF-8',
    buildTestZip([{ name: 'LOCUS.md', data: new Uint8Array([0xFF, 0xFE, 0x23]) }]),
    'locus_bad_locus_md');

  // ===================== LA10 zip bomb =====================
  startSection('LA10 zip bomb abort');
  {
    const bombPlain = new Uint8Array(8 * 1024 * 1024); // inflates far past the cap
    const payload = zlib.deflateRawSync(bombPlain);
    const limits = { ...LA.LOCUS_LIMITS, maxFileBytes: 1024 * 1024 };
    const zip10 = buildTestZip([
      { name: 'LOCUS.md', data: enc9.encode('# x\n') },
      { name: 'bomb.bin', data: new Uint8Array(100), payload, method: 8, crc: 0 },
    ]);
    const r10 = await LA.readLocusArchive(zip10, { limits });
    const bombDiag = (r10.diagnostics || []).find((d) => d.code === 'locus_file_too_large' && d.path === 'bomb.bin');
    check('LA10 bomb aborts with locus_file_too_large', r10.ok === false && r10.files.size === 0 && !!bombDiag,
      JSON.stringify(codesOf(r10)));
    check('LA10 bytes actually read stay within limit + 64 KiB',
      !!bombDiag && bombDiag.bytesRead > limits.maxFileBytes
      && bombDiag.bytesRead <= limits.maxFileBytes + 64 * 1024,
      bombDiag ? String(bombDiag.bytesRead) : 'no diagnostic');
  }

  // ===================== LA11 truncation safety =====================
  startSection('LA11 truncated archives never throw');
  for (const cut of [1, 10, 100]) {
    const truncated = pack1.bytes.slice(0, pack1.bytes.byteLength - cut);
    let r = null;
    let threw = false;
    try {
      r = await LA.readLocusArchive(new Uint8Array(truncated));
    } catch (e) {
      threw = true;
    }
    check('LA11 truncating ' + cut + ' byte(s) fails cleanly',
      !threw && r && r.ok === false && r.files.size === 0 && r.diagnostics.length > 0,
      threw ? 'threw' : JSON.stringify(codesOf(r)));
  }

  // ===================== LA12 Python zipfile archive =====================
  startSection('LA12 Python-generated zip');
  {
    // Generated locally with Python 3.12 (generation script):
    //   import zipfile, base64, io
    //   locus_md = ("# Demo Capability\n\n"
    //               "Packed by Python zipfile for the LA12 cross-check.\n\n"
    //               "## 更改记录\n- packed by python\n\n"
    //               "```locus-manifest\n"
    //               '{"schemaVersion":1,"id":"demo","version":"1","author":"python",'
    //               '"purpose":"LA12 python zipfile cross-check","files":[]}\n'
    //               "```\n")
    //   buf = io.BytesIO()
    //   with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
    //       z.writestr("LOCUS.md", locus_md)
    //       z.writestr("capability.json", '{\n  "schemaVersion": 1,\n  "capability": {"id": "demo"}\n}\n')
    //       z.writestr("skills/demo/SKILL.md", "# Demo skill\n\nBody text.\n")
    //   print(base64.b64encode(buf.getvalue()).decode())
    const PY_ZIP_B64 = ''
      + 'UEsDBBQAAAAIAFclUV04jqhlvQAAAPgAAAAIAAAATE9DVVMubWRVjrEKwjAURff3FY/XtRXq2E10dHByEaFpmtJg24QkFar4Fzr5D+Lg4uDnKH6GUVF0vIfL4QQ4ErXCIdMsk5V0HcCE8YXIMetw0rlSNbiSupCVwEIZdKXA8SDuIzfK2oiXgi96AEGAt/3ptj3fD8frZQcR6q9FvywAaZpWirc2qlkjC2EdrMl6Qc2mwlipGkrikGROCeW+iUJafjjFfrHWe4wfb6EnujVaWeHRK0n/5/4U+u8TWUpm880zBB5QSwMEFAAAAAgAVyVRXQUlXKg2AAAAOQAAAA8AAABjYXBhYmlsaXR5Lmpzb26r5lJQUCpOzkjNTQxLLSrOzM9TslIw1AGJJicWJCZl'
      + '5mSWVAKFqpUyU4CUUkpqbr5SLVctFwBQSwMEFAAAAAgAVyVRXReQ5lQbAAAAGQAAABQAAABza2lsbHMvZGVtby9TS0lMTC5tZFNWcEnNzVcozs7MyeHicspPqVQoSa0o0eMCAFBLAQIUABQAAAAIAFclUV04jqhlvQAAAPgAAAAIAAAAAAAAAAAAAACAAQAAAABMT0NVUy5tZFBLAQIUABQAAAAIAFclUV0FJVyoNgAAADkAAAAPAAAAAAAAAAAAAACAAeMAAABjYXBhYmlsaXR5Lmpzb25QSwECFAAUAAAACABXJVFdF5DmVBsAAAAZAAAAFAAAAAAAAAAAAAAAgAFGAQAAc2tpbGxzL2RlbW8vU0tJTEwubWRQSwUGAAAAAAMAAwC1AAAAkwEAAAAA';
    const bytes12 = new Uint8Array(Buffer.from(PY_ZIP_B64, 'base64'));
    const r12 = await LA.readLocusArchive(bytes12);
    check('LA12 Python zipfile archive reads successfully',
      r12.ok === true && r12.files.size === 2 && typeof r12.locusMd === 'string',
      JSON.stringify(codesOf(r12)));
    check('LA12 file bytes survive',
      r12.ok
      && new TextDecoder().decode(r12.files.get('capability.json')).includes('"schemaVersion": 1')
      && new TextDecoder().decode(r12.files.get('skills/demo/SKILL.md')).startsWith('# Demo skill')
      && r12.locusMd.includes('locus-manifest'));
  }

  // ===================== LA13 store-only writing =====================
  // 2026-10-28 owner decision: writeLocusArchive never deflates.
  // Node >= 24 and Chromium ship zlib-ng while CPython ships classic
  // zlib, and their 'deflate-raw' outputs differ byte-for-byte, so
  // only store (method 0) keeps archives engine-independent. The
  // read side is unchanged and still accepts methods 0 and 8
  // (LA10/LA12 already cover reading deflate entries).
  startSection('LA13 store-only writing (2026-10-28 owner decision)');
  {
    // Central-directory walker — read helpers (buildTestZip above
    // only writes bytes).
    const ru16 = (b, o) => b[o] | (b[o + 1] << 8);
    const ru32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
    function centralEntries(bytes) {
      let eocd = -1;
      for (let back = 0; back <= Math.min(65535, bytes.length - 22); back++) {
        const pos = bytes.length - 22 - back;
        if (ru32(bytes, pos) === 0x06054b50 && ru16(bytes, pos + 20) === back) { eocd = pos; break; }
      }
      if (eocd < 0) return null;
      const total = ru16(bytes, eocd + 10);
      let off = ru32(bytes, eocd + 16);
      const out = [];
      for (let i = 0; i < total; i++) {
        if (ru32(bytes, off) !== 0x02014b50) return null;
        const nameLen = ru16(bytes, off + 28);
        out.push({
          name: new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen)),
          method: ru16(bytes, off + 10),
          compSize: ru32(bytes, off + 20),
          uncompSize: ru32(bytes, off + 24),
          localOffset: ru32(bytes, off + 42),
        });
        off += 46 + nameLen + ru16(bytes, off + 30) + ru16(bytes, off + 32);
      }
      return out;
    }
    // Raw stored payload, located from the local header.
    function storedPayload(bytes, e) {
      const nameLen = ru16(bytes, e.localOffset + 26);
      const extraLen = ru16(bytes, e.localOffset + 28);
      return bytes.subarray(e.localOffset + 30 + nameLen + extraLen,
        e.localOffset + 30 + nameLen + extraLen + e.compSize);
    }

    const files13 = cloneFileMap(read1.files);
    const locusMd13 = read1.locusMd;

    // LA13a: every entry of a freshly written archive is method 0
    // with the raw input bytes as the payload.
    const fresh13 = await LA.writeLocusArchive(files13, locusMd13);
    const entries13 = centralEntries(fresh13);
    check('LA13 central directory parses with all entries',
      Array.isArray(entries13) && entries13.length === files13.size + 1,
      entries13 ? String(entries13.length) : 'null');
    check('LA13 LOCUS.md first, then path order (unchanged layout)',
      !!entries13 && entries13[0].name === 'LOCUS.md'
      && JSON.stringify(entries13.slice(1).map((e) => e.name))
        === JSON.stringify([...files13.keys()].sort()));
    const deflateLeft = (entries13 || []).filter((e) => e.method !== 0 || e.compSize !== e.uncompSize);
    check('LA13 every entry is method 0 with compSize == uncompSize',
      deflateLeft.length === 0, JSON.stringify(deflateLeft.map((e) => [e.name, e.method])));
    let payloadsRaw = true;
    for (const e of entries13 || []) {
      const raw = e.name === 'LOCUS.md'
        ? new TextEncoder().encode(locusMd13)
        : files13.get(e.name);
      if (!bytesEqual(storedPayload(fresh13, e), raw)) payloadsRaw = false;
    }
    check('LA13 stored payloads are the raw input bytes, untouched', payloadsRaw);

    // LA13b: the same input written twice is byte-identical.
    const again13 = await LA.writeLocusArchive(files13, locusMd13);
    check('LA13 writeLocusArchive twice on the same input is byte-identical',
      bytesEqual(fresh13, again13));

    // LA13c: an old-style archive written entirely with deflate
    // (pre-2026-10-28 writer layout, payloads compressed with classic
    // zlib — the CPython-shaped bytes) still reads.
    const order13 = [{ name: 'LOCUS.md', data: new TextEncoder().encode(locusMd13) }];
    for (const p of [...files13.keys()].sort()) order13.push({ name: p, data: files13.get(p) });
    const oldZip13 = buildTestZip(order13.map((e) => {
      const payload = zlib.deflateRawSync(e.data);
      return { name: e.name, data: e.data, payload, method: 8, crc: crc32Node(e.data) };
    }));
    const oldEntries13 = centralEntries(oldZip13);
    check('LA13 old-style fixture really contains method 8 entries',
      (oldEntries13 || []).length === order13.length
      && (oldEntries13 || []).every((e) => e.method === 8),
      JSON.stringify((oldEntries13 || []).map((e) => e.method)));
    const readOld13 = await LA.readLocusArchive(oldZip13);
    check('LA13 old deflate-written archive reads successfully',
      readOld13.ok === true && readOld13.files.size === files13.size,
      JSON.stringify(codesOf(readOld13)));
    let old13Contents = readOld13.ok && readOld13.locusMd === locusMd13;
    for (const [p, data] of files13) {
      if (!readOld13.ok || !bytesEqual(readOld13.files.get(p), data)) old13Contents = false;
    }
    check('LA13 old deflate-written archive yields identical contents', old13Contents);

    // LA13d: the same files packed the old way (deflate) and the new
    // way (store) read back identically — same files, same parsed
    // manifest, same manifestDigest.
    const readNew13 = await LA.readLocusArchive(fresh13);
    const oldParsed13 = readOld13.ok ? LA.parseLocusMd(readOld13.locusMd) : null;
    const newParsed13 = readNew13.ok ? LA.parseLocusMd(readNew13.locusMd) : null;
    const dOld13 = oldParsed13 && oldParsed13.ok ? await LA.manifestDigest(oldParsed13.manifest) : null;
    const dNew13 = newParsed13 && newParsed13.ok ? await LA.manifestDigest(newParsed13.manifest) : null;
    let same13 = !!(readOld13.ok && readNew13.ok && oldParsed13 && newParsed13
      && oldParsed13.ok && newParsed13.ok);
    if (same13) {
      same13 = JSON.stringify([...readOld13.files.keys()].sort())
        === JSON.stringify([...readNew13.files.keys()].sort());
      for (const [p, data] of readNew13.files) {
        if (!bytesEqual(readOld13.files.get(p), data)) same13 = false;
      }
      same13 = same13
        && JSON.stringify(oldParsed13.manifest) === JSON.stringify(newParsed13.manifest)
        && dOld13 === dNew13
        && /^[0-9a-f]{64}$/.test(dNew13);
    }
    check('LA13 old/new packs read back with identical files, manifest and digest',
      same13, JSON.stringify({ old: codesOf(readOld13), new: codesOf(readNew13) }));
  }

  // ---- summary ----
  console.log('---');
  for (const s of sectionStats) {
    console.log(s.label + ': ' + s.passed + ' passed, ' + s.failed + ' failed');
  }
  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : 'all ' + passed + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('SUITE ERROR', e);
  process.exit(1);
});

// zip64 locator needs a 64-bit little-endian field helper (declared
// after use is fine for function declarations — kept next to the
// other builders above for readability).
function u64arr(v) {
  const lo = v >>> 0;
  const hi = Math.floor(v / 0x100000000) >>> 0;
  return [...u32arr(lo), ...u32arr(hi)];
}
