// ============================================================
//  LOCUS ARCHIVE V1 — the .locus package container
//
//  Pure container layer for Capability projects: safe ZIP reading
//  (central directory only), deterministic ZIP writing, the LOCUS.md
//  manifest meta-file (parse/render), closed-manifest verification
//  and repinning, and packing from a validated project directory.
//
//  Layering:
//    - depends only on src/capability-package.js (canonicalJson,
//      validateProject, buildProject) and the harness public surface
//      (sha256Hex through src/product/harness-api.js). No storage,
//      no UI, no store.js, no network, no npm dependencies.
//    - compression/decompression use the platform streams
//      CompressionStream/DecompressionStream('deflate-raw').
//
//  Error discipline (mirrors capability-package.js):
//    - archive/author faults -> structured diagnostics
//      { code, path, message } (never raw exceptions);
//    - programmer invariants -> thrown Errors (LOCUS.md among the
//      written files, non-string body, non-Map file sets, bad lock).
//
//  Determinism: fixed DOS timestamps, LOCUS.md first then path
//  order, canonical single-line manifest JSON — identical inputs
//  pack to byte-identical archives.
//
//  ZIP safety rules (readLocusArchive):
//    - the CENTRAL DIRECTORY is the only entry source; local headers
//      are located from it, never parsed as a forward stream;
//    - every extent is bounds-checked against the input bytes before
//      any slice is taken; a bad extent is a structural fault;
//    - decompression streams are counted chunk-by-chunk and aborted
//      the moment a byte cap is crossed, so a hostile entry (zip
//      bomb) can never fully materialize;
//    - zip64 markers, multi-disk archives, encryption, unknown
//      compression methods, non-UTF-8 / hostile / duplicate names and
//      symlink entries are rejected loudly as diagnostics.
// ============================================================

import {
  canonicalJson,
  validateProject,
  buildProject,
} from './capability-package.js';
import { sha256Hex } from './product/harness-api.js';

// Package container bounds. 256 project files (the package-core
// shipped-file cap) + LOCUS.md.
export const LOCUS_LIMITS = Object.freeze({
  maxEntries: 257,                 // 256 project files + LOCUS.md
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxLocusMdBytes: 256 * 1024,
});

const LOCUS_MD_NAME = 'LOCUS.md';

// ---------- small byte helpers ----------
const TEXT_ENCODER = new TextEncoder();

function u16At(bytes, off) {
  return bytes[off] | (bytes[off + 1] << 8);
}

function u32At(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

function inBounds(bytes, off, len) {
  return Number.isInteger(off) && off >= 0 && len >= 0 && off + len <= bytes.length;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function hex8(value) {
  return (value >>> 0).toString(16).padStart(8, '0');
}

// ---------- CRC-32 (table driven, polynomial 0xEDB88320) ----------
let CRC_TABLE = null;

function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------- diagnostics ----------
function locusDiagnostic(code, path, message, extra) {
  const d = { code, path, message };
  if (extra) Object.assign(d, extra);
  return d;
}

function failedResult(diagnostics) {
  return { ok: false, diagnostics, files: new Map(), locusMd: null };
}

// Test-only limits override (production callers never pass it).
function resolveLimits(opts) {
  return Object.freeze({ ...LOCUS_LIMITS, ...((opts && opts.limits) || {}) });
}

// The archive name rule (mirrors the package-core source path rule):
// POSIX-style relatives only. Directory entries keep their trailing
// slash, which is not an empty segment.
function archiveNameRejectReason(name) {
  if (typeof name !== 'string' || !name.length) return 'name must be a non-empty string';
  if (name.startsWith('/')) return 'absolute path';
  if (name.includes('\\')) return 'backslash path separator';
  if (name.includes('\0')) return 'NUL byte';
  if (/[\x00-\x1F\x7F]/.test(name)) return 'control character';
  const segments = name.split('/');
  const checked = name.endsWith('/') ? segments.slice(0, -1) : segments;
  for (const seg of checked) {
    if (!seg.length) return 'empty path segment';
    if (seg === '.' || seg === '..') return 'dot path segment';
  }
  return null;
}

// ---------- streaming (bounded) ----------
function byteStream(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.length) controller.enqueue(bytes);
      controller.close();
    },
  });
}

// Inflate a 'deflate-raw' slice with hard byte caps. Stops reading the
// moment a cap is crossed and reports how many bytes were actually
// read, so a small hostile entry can never fully materialize.
async function inflateRawBounded(bytes, { fileCap, totalCap, totalSoFar }) {
  const chunks = [];
  let count = 0;
  let abort = null;
  const reader = byteStream(bytes)
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader();
  let streamError = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > fileCap) {
        abort = 'file';
        break;
      }
      if (totalSoFar + count > totalCap) {
        abort = 'total';
        break;
      }
      chunks.push(value);
    }
  } catch (e) {
    // A corrupted deflate stream ends as a short/invalid read: the
    // caller classifies it against the declared size / CRC.
    streamError = true;
  } finally {
    try {
      await reader.cancel();
    } catch (e) { /* already errored or closed */ }
  }
  const data = abort || streamError ? null : concatBytes(chunks);
  return { data, count, abort, streamError };
}

async function deflateRaw(bytes) {
  const reader = byteStream(bytes)
    .pipeThrough(new CompressionStream('deflate-raw'))
    .getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return concatBytes(chunks);
}

// ---------- readLocusArchive ----------
// Central directory record / EOCD signatures.
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

export async function readLocusArchive(bytes, opts) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('locus archive: readLocusArchive requires Uint8Array bytes');
  }
  const limits = resolveLimits(opts);
  const diagnostics = [];

  // --- End of Central Directory (search the tail, comment <= 64 KiB) ---
  let eocdPos = -1;
  const maxComment = Math.min(65535, bytes.length - 22);
  for (let back = 0; back <= maxComment; back++) {
    const pos = bytes.length - 22 - back;
    if (u32At(bytes, pos) !== EOCD_SIG) continue;
    if (u16At(bytes, pos + 20) !== back) continue; // comment must reach EOF exactly
    eocdPos = pos;
    break;
  }
  if (eocdPos < 0) {
    return failedResult([locusDiagnostic('locus_not_zip', '',
      'no End of Central Directory record found (not a zip, or truncated)')]);
  }

  // A zip64 EOCD locator sits immediately before the EOCD.
  if (eocdPos >= 20 && u32At(bytes, eocdPos - 20) === ZIP64_LOCATOR_SIG) {
    diagnostics.push(locusDiagnostic('locus_zip64', '',
      'zip64 EOCD locator is present; zip64 archives are not supported'));
  }

  // --- EOCD fields ---
  const diskNumber = u16At(bytes, eocdPos + 4);
  const cdStartDisk = u16At(bytes, eocdPos + 6);
  const totalEntries = u16At(bytes, eocdPos + 10);
  const cdSize = u32At(bytes, eocdPos + 12);
  const cdOffset = u32At(bytes, eocdPos + 16);

  if (diskNumber !== 0 || cdStartDisk !== 0) {
    diagnostics.push(locusDiagnostic('locus_multi_disk', '',
      'multi-disk archive (disk ' + diskNumber + ', central directory on disk ' + cdStartDisk + ')'));
  }
  if (totalEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
    diagnostics.push(locusDiagnostic('locus_zip64', '',
      'zip64 placeholder values in the End of Central Directory'));
  }
  if (totalEntries > limits.maxEntries) {
    diagnostics.push(locusDiagnostic('locus_too_many_entries', '',
      totalEntries + ' central directory entries, over the ' + limits.maxEntries + '-entry limit'));
  }
  if (!inBounds(bytes, cdOffset, cdSize) || totalEntries * 46 > cdSize) {
    diagnostics.push(locusDiagnostic('locus_not_zip', '',
      'central directory extent is out of bounds (offset ' + cdOffset + ', size ' + cdSize + ')'));
  }
  if (diagnostics.length) return failedResult(diagnostics);

  // --- Central directory records ---
  const entries = [];
  const seenNames = new Set();
  let off = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (!inBounds(bytes, off, 46) || u32At(bytes, off) !== CENTRAL_SIG) {
      diagnostics.push(locusDiagnostic('locus_not_zip', '',
        'central directory record ' + i + ' is out of bounds or has a bad signature'));
      return failedResult(diagnostics);
    }
    const flags = u16At(bytes, off + 8);
    const method = u16At(bytes, off + 10);
    const crc = u32At(bytes, off + 16);
    const compSize = u32At(bytes, off + 20);
    const uncompSize = u32At(bytes, off + 24);
    const nameLen = u16At(bytes, off + 28);
    const extraLen = u16At(bytes, off + 30);
    const commentLen = u16At(bytes, off + 32);
    const diskStart = u16At(bytes, off + 34);
    const externalAttrs = u32At(bytes, off + 38);
    const localOffset = u32At(bytes, off + 42);
    const recordEnd = off + 46 + nameLen + extraLen + commentLen;

    if (diskStart !== 0) {
      diagnostics.push(locusDiagnostic('locus_multi_disk', '',
        'entry ' + i + ' starts on disk ' + diskStart));
    }
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      diagnostics.push(locusDiagnostic('locus_zip64', '',
        'zip64 placeholder values in central directory entry ' + i));
    }

    // Name: fatal UTF-8 decode + strict relative-path rule.
    let name = null;
    let nameBytes = null;
    if (!inBounds(bytes, off + 46, nameLen)) {
      diagnostics.push(locusDiagnostic('locus_bad_name', '',
        'entry ' + i + ' name is out of bounds'));
    } else {
      nameBytes = bytes.subarray(off + 46, off + 46 + nameLen);
      try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
      } catch (e) {
        name = null;
        diagnostics.push(locusDiagnostic('locus_bad_name', '',
          'entry ' + i + ' name is not valid UTF-8'));
      }
    }
    if (name !== null) {
      const reason = archiveNameRejectReason(name);
      if (reason) {
        diagnostics.push(locusDiagnostic('locus_bad_name', name,
          'entry name rejected: ' + reason + ': ' + JSON.stringify(name)));
        name = null; // hostile name — no further per-name accounting
      } else if (seenNames.has(name)) {
        diagnostics.push(locusDiagnostic('locus_duplicate_entry', name,
          'path appears twice in the central directory: ' + JSON.stringify(name)));
      } else {
        seenNames.add(name);
      }
    }

    const isDir = name !== null && name.endsWith('/');
    const unixType = (externalAttrs >>> 16) & 0o170000;
    if (unixType === 0o120000) {
      diagnostics.push(locusDiagnostic('locus_symlink', name || '',
        'entry ' + (name === null ? String(i) : JSON.stringify(name)) + ' is a symbolic link'));
    }
    if ((flags & 0x0001) !== 0) {
      diagnostics.push(locusDiagnostic('locus_encrypted', name || '',
        'entry ' + (name === null ? String(i) : JSON.stringify(name)) + ' is encrypted (general purpose flag bit 0)'));
    }
    if (method !== 0 && method !== 8) {
      diagnostics.push(locusDiagnostic('locus_method_unsupported', name || '',
        'entry ' + (name === null ? String(i) : JSON.stringify(name)) + ' uses unsupported compression method ' + method));
    }

    // Local file header: signature + identical name. Located FROM the
    // central directory — never parsed as a forward stream.
    let dataStart = -1;
    if (!inBounds(bytes, localOffset, 30) || u32At(bytes, localOffset) !== LOCAL_SIG) {
      diagnostics.push(locusDiagnostic('locus_local_header_mismatch', name || '',
        'entry ' + (name === null ? String(i) : JSON.stringify(name)) + ' local file header is missing or has a bad signature'));
    } else {
      const localNameLen = u16At(bytes, localOffset + 26);
      const localExtraLen = u16At(bytes, localOffset + 28);
      const nameStart = localOffset + 30;
      if (!inBounds(bytes, nameStart, localNameLen)
        || nameBytes === null
        || !bytesEqual(bytes.subarray(nameStart, nameStart + localNameLen), nameBytes)) {
        diagnostics.push(locusDiagnostic('locus_local_header_mismatch', name || '',
          'entry ' + (name === null ? String(i) : JSON.stringify(name)) + ' local file header name differs from the central directory'));
      } else {
        dataStart = nameStart + localNameLen + localExtraLen;
      }
    }
    if (dataStart >= 0 && compSize !== 0xFFFFFFFF
      && !inBounds(bytes, dataStart, compSize)) {
      diagnostics.push(locusDiagnostic('locus_not_zip', '',
        'entry ' + (name === null ? String(i) : JSON.stringify(name)) + ' data extent is out of bounds (truncated archive)'));
      dataStart = -1;
    }

    entries.push({ name, isDir, method, crc, compSize, uncompSize, dataStart });
    off = recordEnd;
  }
  if (diagnostics.length) return failedResult(diagnostics);

  // --- Extraction (bounded, counted chunk-by-chunk) ---
  const files = new Map();
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.isDir) continue;
    const name = entry.name;
    const cap = name === LOCUS_MD_NAME ? limits.maxLocusMdBytes : limits.maxFileBytes;
    if (entry.uncompSize > cap) {
      diagnostics.push(locusDiagnostic('locus_file_too_large', name,
        name + ' declares ' + entry.uncompSize + ' uncompressed bytes, over the '
        + cap + '-byte limit'));
      continue;
    }
    const slice = bytes.subarray(entry.dataStart, entry.dataStart + entry.compSize);
    // Store (method 0) data is already plain bytes — a bounded copy,
    // never pushed through the inflater. Deflate (method 8) streams
    // through the bounded inflater below.
    let res;
    if (entry.method === 0) {
      if (slice.byteLength > cap) {
        diagnostics.push(locusDiagnostic('locus_file_too_large', name,
          name + ' is ' + slice.byteLength + ' stored bytes, over the ' + cap + '-byte limit'));
        continue;
      }
      if (totalBytes + slice.byteLength > limits.maxTotalBytes) {
        diagnostics.push(locusDiagnostic('locus_total_too_large', name,
          'archive exceeded the ' + limits.maxTotalBytes + '-byte total while reading '
          + name + ' (' + slice.byteLength + ' bytes)'));
        continue;
      }
      res = { data: slice.slice(), count: slice.byteLength, abort: null };
    } else {
      res = await inflateRawBounded(slice, {
        fileCap: cap,
        totalCap: limits.maxTotalBytes,
        totalSoFar: totalBytes,
      });
    }
    if (res.abort === 'file') {
      diagnostics.push(locusDiagnostic('locus_file_too_large', name,
        name + ' exceeded the ' + cap + '-byte limit while inflating (aborted after '
        + res.count + ' bytes)', { bytesRead: res.count }));
      continue;
    }
    if (res.abort === 'total') {
      diagnostics.push(locusDiagnostic('locus_total_too_large', name,
        'archive exceeded the ' + limits.maxTotalBytes + '-byte total while inflating '
        + name + ' (aborted after ' + res.count + ' bytes)', { bytesRead: res.count }));
      continue;
    }
    totalBytes += res.count;
    if (res.count !== entry.uncompSize || res.data === null) {
      diagnostics.push(locusDiagnostic('locus_size_mismatch', name,
        name + ' inflated to ' + res.count + ' bytes but the central directory declares '
        + entry.uncompSize));
      continue;
    }
    const actualCrc = crc32(res.data);
    if (actualCrc !== entry.crc) {
      diagnostics.push(locusDiagnostic('locus_crc_mismatch', name,
        name + ' CRC-32 mismatch: central directory declares ' + hex8(entry.crc)
        + ', data hashes to ' + hex8(actualCrc)));
      continue;
    }
    files.set(name, res.data);
  }
  if (diagnostics.length) return failedResult(diagnostics);

  // --- LOCUS.md (the one meta file, decoded strictly) ---
  if (!files.has(LOCUS_MD_NAME)) {
    return failedResult([locusDiagnostic('locus_missing_locus_md', LOCUS_MD_NAME,
      'no ' + LOCUS_MD_NAME + ' at the archive root')]);
  }
  let locusMd;
  try {
    locusMd = new TextDecoder('utf-8', { fatal: true }).decode(files.get(LOCUS_MD_NAME));
  } catch (e) {
    return failedResult([locusDiagnostic('locus_bad_locus_md', LOCUS_MD_NAME,
      LOCUS_MD_NAME + ' is not valid UTF-8')]);
  }
  files.delete(LOCUS_MD_NAME);
  return { ok: true, diagnostics: [], files, locusMd };
}

// ---------- LOCUS.md ----------
// Exactly one fenced block whose opening fence is exactly
// ```locus-manifest (trailing whitespace/CR tolerated). The block is
// replaced by a single empty line at its original position.
function splitLocusMdBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```locus-manifest') continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '```') {
        close = j;
        break;
      }
    }
    if (close < 0) break; // unterminated block is not a complete block
    blocks.push({ start: i, end: close, json: lines.slice(i + 1, close).join('\n') });
    i = close;
  }
  return { lines, blocks };
}

function bodyWithoutBlocks(lines, blocks) {
  const out = [];
  let i = 0;
  for (const b of blocks) {
    while (i < b.start) out.push(lines[i++]);
    out.push(''); // the block leaves exactly one empty line in place
    i = b.end + 1;
  }
  while (i < lines.length) out.push(lines[i++]);
  return out.join('\n');
}

function validateLocusManifest(manifest) {
  const diagnostics = [];
  const allowed = ['schemaVersion', 'id', 'version', 'author', 'purpose', 'files'];
  const keys = Object.keys(manifest);
  for (const k of keys) {
    if (!allowed.includes(k)) {
      diagnostics.push(locusDiagnostic('locus_manifest_field', '',
        'unknown manifest field: ' + JSON.stringify(k)));
    }
  }
  if (manifest.schemaVersion === undefined) {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '', 'missing field: schemaVersion'));
  } else if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion !== 1) {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '',
      'schemaVersion must be the number 1'));
  }
  for (const [field, maxLen] of [['id', null], ['version', null], ['author', 200], ['purpose', 2000]]) {
    const value = manifest[field];
    if (value === undefined) {
      diagnostics.push(locusDiagnostic('locus_manifest_field', '', 'missing field: ' + field));
    } else if (typeof value !== 'string') {
      diagnostics.push(locusDiagnostic('locus_manifest_field', '',
        field + ' must be a string'));
    } else if (maxLen !== null && value.length > maxLen) {
      diagnostics.push(locusDiagnostic('locus_manifest_field', '',
        field + ' is ' + value.length + ' characters, over the ' + maxLen + '-character limit'));
    }
  }
  // id/version are additionally required to be non-empty.
  for (const field of ['id', 'version']) {
    if (typeof manifest[field] === 'string' && !manifest[field].length) {
      diagnostics.push(locusDiagnostic('locus_manifest_field', '',
        field + ' must be a non-empty string'));
    }
  }
  if (manifest.files === undefined) {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '', 'missing field: files'));
  } else if (!Array.isArray(manifest.files)) {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '', 'files must be an array'));
    return { diagnostics, files: null };
  }
  return { diagnostics, files: validateManifestFiles(manifest.files, diagnostics) };
}

function validateManifestFiles(list, diagnostics) {
  const out = [];
  for (const item of list) {
    const bad = (message) => diagnostics.push(locusDiagnostic('locus_manifest_files', '',
      message));
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      bad('files entry must be a JSON object');
      continue;
    }
    const keys = Object.keys(item).sort();
    const expectedKeys = ['path', 'sha256', 'size'];
    if (keys.length !== expectedKeys.length || keys.some((k, i) => k !== expectedKeys[i])) {
      bad('files entry must have exactly the fields { path, size, sha256 }');
      continue;
    }
    const { path, size, sha256 } = item;
    const reason = archiveNameRejectReason(path);
    if (reason) {
      bad('files entry path rejected: ' + reason + ': ' + JSON.stringify(path));
      continue;
    }
    if (path === LOCUS_MD_NAME) {
      bad('files must not contain ' + LOCUS_MD_NAME);
      continue;
    }
    if (!Number.isInteger(size) || size < 0) {
      bad('files entry ' + JSON.stringify(path) + ' size must be a non-negative integer');
      continue;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
      bad('files entry ' + JSON.stringify(path) + ' sha256 must be 64 lowercase hex characters');
      continue;
    }
    out.push({ path, size, sha256 });
  }
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].path;
    const cur = out[i].path;
    if (prev === cur) {
      diagnostics.push(locusDiagnostic('locus_manifest_files', '',
        'duplicate path in files: ' + JSON.stringify(cur)));
    } else if (prev > cur) {
      diagnostics.push(locusDiagnostic('locus_manifest_files', '',
        'files must be sorted by path: ' + JSON.stringify(prev) + ' before '
        + JSON.stringify(cur)));
    }
  }
  return out;
}

export function parseLocusMd(text) {
  if (typeof text !== 'string') {
    throw new TypeError('locus archive: parseLocusMd requires a string');
  }
  const { lines, blocks } = splitLocusMdBlocks(text);
  if (blocks.length === 0) {
    return failedParse([locusDiagnostic('locus_manifest_missing', '',
      'no ```locus-manifest code block found')]);
  }
  if (blocks.length > 1) {
    return failedParse([locusDiagnostic('locus_manifest_multiple', '',
      blocks.length + ' ```locus-manifest code blocks found, exactly one is allowed')]);
  }
  const block = blocks[0];
  let manifest;
  try {
    manifest = JSON.parse(block.json);
  } catch (e) {
    return failedParse([locusDiagnostic('locus_manifest_json', '',
      'the locus-manifest block is not valid JSON: ' + (e && e.message ? e.message : String(e)))]);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return failedParse([locusDiagnostic('locus_manifest_json', '',
      'the locus-manifest block must contain a JSON object')]);
  }
  const { diagnostics, files } = validateLocusManifest(manifest);
  if (diagnostics.length) return failedParse(diagnostics);
  return {
    ok: true,
    diagnostics: [],
    manifest: {
      schemaVersion: manifest.schemaVersion,
      id: manifest.id,
      version: manifest.version,
      author: manifest.author,
      purpose: manifest.purpose,
      files,
    },
    body: bodyWithoutBlocks(lines, blocks),
  };
}

function failedParse(diagnostics) {
  return { ok: false, diagnostics, manifest: null, body: null };
}

export function renderLocusMd({ body, manifest } = {}) {
  const text = body === undefined || body === null ? '' : body;
  if (typeof text !== 'string') {
    throw new TypeError('locus archive: renderLocusMd body must be a string');
  }
  const bodyPart = text.length && !text.endsWith('\n') ? text + '\n' : text;
  return bodyPart + '```locus-manifest\n' + canonicalJson(manifest) + '\n```\n';
}

// ---------- manifest helpers ----------
export async function manifestDigest(manifest) {
  return sha256Hex(TEXT_ENCODER.encode(canonicalJson(manifest)));
}

export async function verifyLocusFiles(manifest, files) {
  if (!(files instanceof Map)) {
    throw new TypeError('locus archive: verifyLocusFiles requires a Map of path -> Uint8Array');
  }
  const list = manifest && Array.isArray(manifest.files) ? manifest.files : [];
  const expected = new Map(list.map((f) => [f.path, f]));
  const missing = [];
  const mismatched = [];
  for (const f of list) {
    if (!files.has(f.path)) {
      missing.push(f.path);
      continue;
    }
    const bytes = files.get(f.path);
    const size = bytes.byteLength;
    const sha256 = await sha256Hex(bytes);
    if (size !== f.size || sha256 !== f.sha256) {
      mismatched.push({
        path: f.path,
        expected: { size: f.size, sha256: f.sha256 },
        actual: { size, sha256 },
      });
    }
  }
  const extra = [...files.keys()].filter((p) => !expected.has(p)).sort();
  missing.sort();
  mismatched.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { missing, extra, mismatched };
}

export async function repinManifest(manifest, files) {
  if (!(files instanceof Map)) {
    throw new TypeError('locus archive: repinManifest requires a Map of path -> Uint8Array');
  }
  if (files.has(LOCUS_MD_NAME)) {
    throw new Error('locus archive: repinManifest files must not contain ' + LOCUS_MD_NAME);
  }
  return { ...manifest, files: await buildFilesList(files) };
}

async function buildFilesList(files) {
  const list = [];
  for (const path of [...files.keys()].sort()) {
    const bytes = files.get(path);
    list.push({ path, size: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }
  return list;
}

// Append `- <line>` at the end of the list under the "## 更改记录" or
// "## Changelog" heading; create the heading at the end when neither
// exists. Everything else in the body is preserved byte-for-byte.
export function appendChangelogEntry(body, line) {
  if (typeof body !== 'string') {
    throw new TypeError('locus archive: appendChangelogEntry requires a string body');
  }
  const trailingNewline = body.endsWith('\n');
  const lines = trailingNewline ? body.slice(0, -1).split('\n') : body.split('\n');
  const entry = '- ' + line;
  let heading = -1;
  for (const target of ['## 更改记录', '## Changelog']) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === target) {
        heading = i;
        break;
      }
    }
    if (heading >= 0) break;
  }
  if (heading < 0) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push('## 更改记录', entry);
  } else {
    // Last list item directly under the heading (blank lines between
    // items and following sections are skipped over, not consumed).
    let last = heading;
    for (let i = heading + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^- /.test(t)) last = i;
      else if (t === '') continue;
      else break;
    }
    lines.splice(last + 1, 0, entry);
  }
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

// ---------- write ----------
export async function writeLocusArchive(files, locusMdText) {
  if (!(files instanceof Map)) {
    throw new TypeError('locus archive: writeLocusArchive requires a Map of path -> Uint8Array');
  }
  if (files.has(LOCUS_MD_NAME)) {
    throw new Error('locus archive: files must not contain ' + LOCUS_MD_NAME
      + '; it is written separately');
  }
  if (typeof locusMdText !== 'string') {
    throw new TypeError('locus archive: writeLocusArchive requires a string LOCUS.md');
  }
  const locusMdBytes = TEXT_ENCODER.encode(locusMdText);
  for (const [path, bytes] of files) {
    if (typeof path !== 'string' || archiveNameRejectReason(path)) {
      throw new Error('locus archive: refusing to write invalid entry name: ' + JSON.stringify(path));
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('locus archive: file ' + path + ' must be Uint8Array');
    }
    if (bytes.byteLength > LOCUS_LIMITS.maxFileBytes) {
      throw new Error('locus archive: file ' + path + ' is ' + bytes.byteLength
        + ' bytes, over the ' + LOCUS_LIMITS.maxFileBytes + '-byte limit');
    }
  }
  if (files.size + 1 > LOCUS_LIMITS.maxEntries) {
    throw new Error('locus archive: ' + (files.size + 1)
      + ' entries would exceed the ' + LOCUS_LIMITS.maxEntries + '-entry limit');
  }
  let totalBytes = locusMdBytes.byteLength;
  for (const bytes of files.values()) totalBytes += bytes.byteLength;
  if (totalBytes > LOCUS_LIMITS.maxTotalBytes) {
    throw new Error('locus archive: ' + totalBytes
      + ' total bytes would exceed the ' + LOCUS_LIMITS.maxTotalBytes + '-byte limit');
  }
  if (locusMdBytes.byteLength > LOCUS_LIMITS.maxLocusMdBytes) {
    throw new Error('locus archive: ' + LOCUS_MD_NAME + ' is '
      + locusMdBytes.byteLength + ' bytes, over the ' + LOCUS_LIMITS.maxLocusMdBytes + '-byte limit');
  }

  // LOCUS.md first, then everything else in path order. Fixed DOS
  // timestamps (1980-01-01 00:00) keep identical inputs identical.
  const ordered = [{ name: LOCUS_MD_NAME, data: locusMdBytes }];
  for (const path of [...files.keys()].sort()) ordered.push({ name: path, data: files.get(path) });

  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const entry of ordered) {
    const nameBytes = TEXT_ENCODER.encode(entry.name);
    const crc = crc32(entry.data);
    let method = 8;
    let payload = await deflateRaw(entry.data);
    if (payload.byteLength >= entry.data.byteLength) {
      method = 0; // deflate did not shrink — store
      payload = entry.data;
    }
    const utf8Flag = /[^\x00-\x7F]/.test(entry.name) ? 0x0800 : 0;
    const local = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, LOCAL_SIG, true);
    dv.setUint16(4, 20, true);            // version needed
    dv.setUint16(6, utf8Flag, true);      // flags
    dv.setUint16(8, method, true);
    dv.setUint16(10, 0, true);            // time
    dv.setUint16(12, 33, true);           // date 1980-01-01
    dv.setUint32(14, crc, true);
    dv.setUint32(18, payload.byteLength, true);
    dv.setUint32(22, entry.data.byteLength, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);            // extra field length
    local.set(nameBytes, 30);
    chunks.push(local, payload);
    centrals.push({ nameBytes, utf8Flag, crc, method, compSize: payload.byteLength, uncompSize: entry.data.byteLength, offset });
    offset += local.byteLength + payload.byteLength;
  }

  const cdStart = offset;
  for (const c of centrals) {
    const rec = new Uint8Array(46 + c.nameBytes.length);
    const dv = new DataView(rec.buffer);
    dv.setUint32(0, CENTRAL_SIG, true);
    dv.setUint16(4, 20, true);            // version made by
    dv.setUint16(6, 20, true);            // version needed
    dv.setUint16(8, c.utf8Flag, true);    // flags
    dv.setUint16(10, c.method, true);
    dv.setUint16(12, 0, true);            // time
    dv.setUint16(14, 33, true);           // date 1980-01-01
    dv.setUint32(16, c.crc, true);
    dv.setUint32(20, c.compSize, true);
    dv.setUint32(24, c.uncompSize, true);
    dv.setUint16(28, c.nameBytes.length, true);
    dv.setUint16(30, 0, true);            // extra field length
    dv.setUint16(32, 0, true);            // comment length
    dv.setUint16(34, 0, true);            // disk number start
    dv.setUint16(36, 0, true);            // internal attributes
    dv.setUint32(38, 0, true);            // external attributes (regular file)
    dv.setUint32(42, c.offset, true);
    rec.set(c.nameBytes, 46);
    chunks.push(rec);
    offset += rec.byteLength;
  }

  const eocd = new Uint8Array(22);
  const dv = new DataView(eocd.buffer);
  dv.setUint32(0, EOCD_SIG, true);
  dv.setUint16(4, 0, true);               // this disk
  dv.setUint16(6, 0, true);               // central directory disk
  dv.setUint16(8, centrals.length, true); // entries on this disk
  dv.setUint16(10, centrals.length, true);
  dv.setUint32(12, offset - cdStart, true);
  dv.setUint32(16, cdStart, true);
  dv.setUint16(20, 0, true);              // comment length
  chunks.push(eocd);
  return concatBytes(chunks);
}

// ---------- expected package paths ----------
// capability.json + one plugin.json per plugin + one skill.json per
// skill + one mcp.json per mcp + every lock.files path, sorted.
export function expectedPackagePaths(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new TypeError('locus archive: expectedPackagePaths requires a lock object');
  }
  const out = new Set(['capability.json']);
  for (const p of lock.plugins || []) out.add('plugins/' + p.descriptor.id + '/plugin.json');
  for (const s of lock.skills || []) out.add('skills/' + s.descriptor.id + '/skill.json');
  for (const m of lock.mcps || []) out.add('mcp/' + m.id + '/mcp.json');
  for (const f of lock.files || []) out.add(f.path);
  return [...out].sort();
}

// ---------- pack ----------
// validateProject + buildProject, read exactly the expected package
// paths from the workspace, generate manifest + LOCUS.md + zip.
export async function packLocus({ workspace, root, author, purpose, body } = {}) {
  const text = body === undefined || body === null ? '' : body;
  if (typeof text !== 'string') {
    throw new TypeError('locus archive: packLocus body must be a string');
  }
  const diagnostics = [];
  const fail = () => ({ ok: false, diagnostics, bytes: null, manifest: null });

  const validation = await validateProject({ workspace, root });
  if (!validation.ok) {
    diagnostics.push(...validation.diagnostics);
    return fail();
  }
  const built = await buildProject({ workspace, root });
  if (!built.ok) {
    diagnostics.push(...built.diagnostics);
    return fail();
  }
  const lock = built.bundle.lock;

  if (author !== undefined && typeof author !== 'string') {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '', 'author must be a string'));
  } else if (author && author.length > 200) {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '',
      'author is ' + author.length + ' characters, over the 200-character limit'));
  }
  if (purpose !== undefined && typeof purpose !== 'string') {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '', 'purpose must be a string'));
  } else if (purpose && purpose.length > 2000) {
    diagnostics.push(locusDiagnostic('locus_manifest_field', '',
      'purpose is ' + purpose.length + ' characters, over the 2000-character limit'));
  }
  if (diagnostics.length) return fail();

  const paths = expectedPackagePaths(lock);
  if (paths.length + 1 > LOCUS_LIMITS.maxEntries) {
    diagnostics.push(locusDiagnostic('locus_too_many_entries', '',
      paths.length + ' project files would exceed the '
      + (LOCUS_LIMITS.maxEntries - 1) + '-file limit'));
    return fail();
  }

  const files = new Map();
  let totalBytes = 0;
  for (const rel of paths) {
    const providerPath = root ? root + '/' + rel : rel;
    let bytes;
    try {
      bytes = await workspace.readBytes(providerPath);
    } catch (e) {
      diagnostics.push(locusDiagnostic('locus_read_failed', rel,
        rel + ' could not be read from the workspace: ' + (e && e.name ? e.name : 'Error')));
      continue;
    }
    if (!(bytes instanceof Uint8Array)) {
      diagnostics.push(locusDiagnostic('locus_read_failed', rel,
        rel + ' did not read as bytes'));
      continue;
    }
    if (bytes.byteLength > LOCUS_LIMITS.maxFileBytes) {
      diagnostics.push(locusDiagnostic('locus_file_too_large', rel,
        rel + ' is ' + bytes.byteLength + ' bytes, over the '
        + LOCUS_LIMITS.maxFileBytes + '-byte limit'));
      continue;
    }
    totalBytes += bytes.byteLength;
    files.set(rel, bytes);
  }
  if (totalBytes > LOCUS_LIMITS.maxTotalBytes) {
    diagnostics.push(locusDiagnostic('locus_total_too_large', '',
      totalBytes + ' project bytes exceed the ' + LOCUS_LIMITS.maxTotalBytes + '-byte total'));
  }
  if (diagnostics.length) return fail();

  const manifest = {
    schemaVersion: 1,
    id: lock.capability.id,
    version: lock.capability.version,
    author: author || '',
    purpose: purpose || '',
    files: await buildFilesList(files),
  };
  const locusMd = renderLocusMd({ body: text, manifest });
  if (TEXT_ENCODER.encode(locusMd).byteLength > LOCUS_LIMITS.maxLocusMdBytes) {
    diagnostics.push(locusDiagnostic('locus_locus_md_too_large', LOCUS_MD_NAME,
      'rendered ' + LOCUS_MD_NAME + ' exceeds the ' + LOCUS_LIMITS.maxLocusMdBytes + '-byte limit'));
    return fail();
  }
  const bytes = await writeLocusArchive(files, locusMd);
  return { ok: true, diagnostics: [], bytes, manifest };
}
