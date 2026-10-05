// M4a-A: core-main candidate tool — capture / apply / verify / advance-check.
//
// Product keeps shipping with an exact, verified dependency lock on the two
// cores. This tool is the candidate side of that arrangement:
//
//   capture       observe each core's refs/heads/main ONCE, freeze a full
//                 40-hex SHA per core into a snapshot JSON ("main" source),
//                 or take caller-given SHAs ("explicit" source). Everything
//                 downstream reads the captured SHAs only — a main ref that
//                 advances mid-run is never re-read into the same run.
//   apply         in a caller-specified CLEAN TEMP checkout: rewrite the two
//                 git dependency specs, regenerate the lockfile, then `npm ci`
//                 (which wipes node_modules — no stale install can survive a
//                 manifest-only edit) and verify provenance in npm's own
//                 records: the regenerated lockfile, the hidden
//                 node_modules/.package-lock.json npm writes from its real
//                 ci-time resolution, and the installed package's identity.
//                 The original workspace the tool itself lives in is never a
//                 valid target.
//   verify        re-run the provenance check on an already-applied checkout.
//   advance-check informational only: did main move on since capture?
//                 Never fails a run by itself; a moved main is next round's
//                 candidate, not a chase target.
//
// Safety rules (hard, not advisory):
//   - repos and refs are allowlisted constants; SHAs must be full 40-hex;
//     every git/npm invocation is an argv array — no shell string is ever
//     assembled from snapshot or ref data.
//   - apply refuses a dirty checkout, a non-checkout, and the checkout that
//     owns this tool; a failed apply leaves the ORIGINAL workspace untouched
//     by construction (only the temp checkout is ever written).
//   - verification failures and install failures exit non-zero with distinct
//     stage codes so CI reporting can never fold them into "green".
//
// Subcommands:
//   capture --checkout <dir> [--source main|explicit]
//           [--runtime-sha <sha>] [--harness-sha <sha>] [--out <file>]
//   apply   --snapshot <file> --checkout <dir> [--result-file <file>]
//   verify  --snapshot <file> --checkout <dir>
//   advance-check --snapshot <file>
//
// Exit codes: 0 ok · 2 usage/input · 10 capture · 20 preflight ·
// 21 install · 22 verify · 30 unexpected io error.
// Run: node scripts/core-main-candidate.mjs <subcommand> ...

import { spawnSync } from 'node:child_process';
import {
  existsSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
export const PRODUCT_REPO = 'boccchi2993/locus-product';
export const MAIN_REF = 'refs/heads/main';

// The allowlisted core set. A repo string not in this table can never reach
// a git invocation, whatever a snapshot file claims.
export const CORES = Object.freeze([
  Object.freeze({ pkg: 'locus-runtime', repo: 'boccchi2993/locus-runtime' }),
  Object.freeze({ pkg: 'locus-harness', repo: 'boccchi2993/locus-harness' }),
]);

const SHA_RE = /^[0-9a-f]{40}$/;
const SOURCES = ['main', 'explicit'];

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  CAPTURE: 10,
  PREFLIGHT: 20,
  INSTALL: 21,
  VERIFY: 22,
  IO: 30,
});

export class CandidateError extends Error {
  constructor(stage, message, detail) {
    super(detail === undefined ? message : `${message} :: ${
      typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    this.name = 'CandidateError';
    this.stage = stage;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// default transports (all injectable for tests — tests never touch the network)

function gitRun(cwd, args) {
  const r = spawnSync('git', args, { cwd: cwd || undefined, encoding: 'utf8' });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), error: r.error };
}

function remoteUrl(repo) {
  // repo is always an allowlisted table entry — never snapshot input.
  return `https://github.com/${repo}.git`;
}

function listMainShaDefault(repo) {
  const r = gitRun(null, ['ls-remote', remoteUrl(repo), MAIN_REF]);
  if (r.error || r.status !== 0) {
    throw new Error(`git ls-remote ${repo} ${MAIN_REF} failed: ${(r.stderr || String(r.error)).trim().slice(-400)}`);
  }
  const seen = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim());
    if (m && m[2] === MAIN_REF) seen.push(m[1]);
  }
  if (seen.length !== 1) {
    throw new Error(`expected exactly one ${MAIN_REF} line for ${repo}, got ${seen.length}`);
  }
  return seen[0];
}

function npmCliJs() {
  // Prefer node's own bundled npm CLI so Windows never needs a cmd.exe shell.
  const candidate = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(candidate) ? candidate : null;
}

function runNpmDefault(cwd, args) {
  const cli = npmCliJs();
  if (cli) {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (!r.error) return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
    // spawn failure (not npm failure) — fall through to the PATH npm below.
  }
  // Fallback joins argv into one command line; every token in args is a
  // validated constant or a full 40-hex SHA read from a validated snapshot.
  const cmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r2 = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32',
  });
  return { status: r2.status, stdout: String(r2.stdout || ''), stderr: String(r2.stderr || '') };
}

function headAt(dir) {
  const r = gitRun(dir, ['rev-parse', 'HEAD']);
  const sha = r.stdout.trim();
  return r.status === 0 && SHA_RE.test(sha) ? sha : null;
}

export function defaultIo() {
  return {
    now: () => new Date().toISOString(),
    listMainSha: listMainShaDefault,
    runNpm: runNpmDefault,
    productHead: (checkout) => headAt(checkout),
  };
}

let toolRepoRootCache;
function toolRepoRoot() {
  if (toolRepoRootCache === undefined) {
    const r = gitRun(dirname(fileURLToPath(import.meta.url)), ['rev-parse', '--show-toplevel']);
    toolRepoRootCache = r.status === 0 ? realpathSync(r.stdout.trim()) : null;
  }
  return toolRepoRootCache;
}

// ---------------------------------------------------------------------------
// snapshot

function coreEntry(pkg) {
  return CORES.find((c) => c.pkg === pkg);
}

export async function captureCandidate({
  checkout, source = 'main', runtimeSha, harnessSha, io = defaultIo(),
}) {
  if (checkout) checkout = String(checkout);
  if (!SOURCES.includes(source)) {
    throw new CandidateError(EXIT.USAGE, `--source must be "main" or "explicit", got ${JSON.stringify(source)}`);
  }
  if (source === 'main' && (runtimeSha !== undefined || harnessSha !== undefined)) {
    throw new CandidateError(EXIT.USAGE,
      'explicit SHA flags are not allowed with --source main (capture modes must not be mixed)');
  }
  const explicit = {
    'locus-runtime': runtimeSha,
    'locus-harness': harnessSha,
  };
  if (source === 'explicit') {
    for (const { pkg } of CORES) {
      const v = explicit[pkg];
      if (v === undefined) {
        throw new CandidateError(EXIT.USAGE, `--source explicit requires --${pkg === 'locus-runtime' ? 'runtime' : 'harness'}-sha (missing for ${pkg})`);
      }
      if (typeof v !== 'string' || !SHA_RE.test(v)) {
        throw new CandidateError(EXIT.USAGE, `${pkg} candidate must be a full 40-char lowercase hex SHA, got ${JSON.stringify(v)}`);
      }
    }
  }

  const productCommit = await io.productHead(checkout);
  if (!productCommit) {
    throw new CandidateError(EXIT.CAPTURE,
      `could not read the Product commit being verified from ${checkout} (not a git checkout or detached HEAD unreadable)`);
  }

  const cores = {};
  if (source === 'main') {
    for (const { pkg, repo } of CORES) {
      let sha;
      try {
        sha = await io.listMainSha(repo);
      } catch (e) {
        throw new CandidateError(EXIT.CAPTURE, `failed to observe ${repo} ${MAIN_REF}`, String((e && e.message) || e));
      }
      if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
        throw new CandidateError(EXIT.CAPTURE, `${repo} ${MAIN_REF} returned a non-conforming ref value`, String(sha));
      }
      cores[pkg] = Object.freeze({ repo, ref: MAIN_REF, sha, source: 'main' });
    }
  } else {
    for (const { pkg, repo } of CORES) {
      cores[pkg] = Object.freeze({ repo, ref: null, sha: explicit[pkg], source: 'explicit' });
    }
  }

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    capturedAt: io.now(),
    source,
    product: Object.freeze({ repo: PRODUCT_REPO, commit: productCommit }),
    cores: Object.freeze(cores),
  });
}

export function validateSnapshot(raw) {
  const problems = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(raw)) throw new CandidateError(EXIT.USAGE, 'snapshot must be a JSON object');
  const top = Object.keys(raw).sort();
  if (JSON.stringify(top) !== JSON.stringify(['capturedAt', 'cores', 'product', 'schemaVersion', 'source'])) {
    problems.push(`unexpected top-level keys: ${top.join(',')}`);
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  if (!SOURCES.includes(raw.source)) problems.push(`source must be main|explicit, got ${JSON.stringify(raw.source)}`);
  if (typeof raw.capturedAt !== 'string' || Number.isNaN(Date.parse(raw.capturedAt))) {
    problems.push('capturedAt must be an ISO timestamp string');
  }
  if (!isObj(raw.product) || raw.product.repo !== PRODUCT_REPO || !SHA_RE.test(String(raw.product.commit))) {
    problems.push(`product must be { repo: "${PRODUCT_REPO}", commit: <40-hex sha> }`);
  }
  if (isObj(raw.product) && raw.product.repo === PRODUCT_REPO && typeof raw.product.commit === 'string'
    && !SHA_RE.test(raw.product.commit)) {
    problems.push('product.commit must be a full 40-hex sha');
  }
  if (isObj(raw)) {
    const expectedPkgs = CORES.map((c) => c.pkg).sort();
    const gotPkgs = isObj(raw.cores) ? Object.keys(raw.cores).sort() : [];
    if (JSON.stringify(gotPkgs) !== JSON.stringify(expectedPkgs)) {
      problems.push(`cores must have exactly the keys ${expectedPkgs.join(',')}`);
    }
    if (isObj(raw.cores) && SOURCES.includes(raw.source)) {
      for (const { pkg, repo } of CORES) {
        const e = raw.cores[pkg];
        if (!isObj(e)) { if (isObj(raw.cores) && gotPkgs.includes(pkg)) problems.push(`cores.${pkg} must be an object`); continue; }
        const keys = Object.keys(e).sort();
        if (JSON.stringify(keys) !== JSON.stringify(['ref', 'repo', 'sha', 'source'])) {
          problems.push(`cores.${pkg} must have exactly repo/ref/sha/source`);
        }
        if (e.repo !== repo) problems.push(`cores.${pkg}.repo must be ${repo}, got ${JSON.stringify(e.repo)}`);
        if (e.source !== raw.source) problems.push(`cores.${pkg}.source must match the snapshot source (${raw.source})`);
        if (typeof e.sha !== 'string' || !SHA_RE.test(e.sha)) problems.push(`cores.${pkg}.sha must be a full 40-hex sha`);
        if (raw.source === 'main' && e.ref !== MAIN_REF) problems.push(`cores.${pkg}.ref must be "${MAIN_REF}" for a main capture`);
        if (raw.source === 'explicit' && e.ref !== null) problems.push(`cores.${pkg}.ref must be null for an explicit capture`);
      }
    }
  }
  if (problems.length) throw new CandidateError(EXIT.USAGE, 'invalid candidate snapshot', problems);
  return raw;
}

function readSnapshotFile(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new CandidateError(EXIT.USAGE, `cannot read snapshot file ${file}`, String((e && e.message) || e));
  }
  return validateSnapshot(raw);
}

// ---------------------------------------------------------------------------
// apply (temporary checkout) + provenance verification

function preflight(checkout) {
  if (typeof checkout !== 'string' || !checkout) {
    throw new CandidateError(EXIT.USAGE, '--checkout is required');
  }
  if (!existsSync(checkout) || !statSync(checkout).isDirectory()) {
    throw new CandidateError(EXIT.PREFLIGHT, `checkout directory does not exist: ${checkout}`);
  }
  const manifestPath = join(checkout, 'package.json');
  const lockPath = join(checkout, 'package-lock.json');
  for (const p of [manifestPath, lockPath]) {
    if (!existsSync(p)) throw new CandidateError(EXIT.PREFLIGHT, `checkout is missing ${p}`);
  }
  const top = gitRun(checkout, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) throw new CandidateError(EXIT.PREFLIGHT, `not a git checkout: ${checkout}`, top.stderr.trim().slice(-200));
  const status = gitRun(checkout, ['status', '--porcelain']);
  if (status.status !== 0) throw new CandidateError(EXIT.PREFLIGHT, `git status failed in ${checkout}`, status.stderr.trim().slice(-200));
  if (status.stdout.trim() !== '') {
    throw new CandidateError(EXIT.PREFLIGHT,
      `checkout working tree is not clean — apply only accepts a clean temp checkout: ${checkout}`);
  }
  const real = realpathSync(checkout);
  const owner = toolRepoRoot();
  if (owner && real === owner) {
    throw new CandidateError(EXIT.PREFLIGHT,
      'refusing to apply candidates to the checkout that owns this tool (the verified workspace must never be the target)');
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new CandidateError(EXIT.PREFLIGHT, 'package.json is not valid JSON', String((e && e.message) || e));
  }
  for (const { pkg } of CORES) {
    if (typeof (manifest.dependencies || {})[pkg] !== 'string') {
      throw new CandidateError(EXIT.PREFLIGHT, `package.json does not declare "${pkg}" as a string dependency`);
    }
  }
  return {
    checkout: real, manifestPath, lockPath,
    originalManifest: readFileSync(manifestPath, 'utf8'),
    originalLock: readFileSync(lockPath, 'utf8'),
  };
}

function resolvedMatches(resolved, repo, sha) {
  return typeof resolved === 'string'
    && resolved.includes(`/${repo}.git#`)
    && resolved.endsWith(`#${sha}`);
}

export async function verifyProvenance(checkout, snapshot, io = defaultIo()) {
  validateSnapshot(snapshot);
  const problems = [];
  const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(checkout, 'package-lock.json'), 'utf8'));

  const hiddenPath = join(checkout, 'node_modules', '.package-lock.json');
  let hidden = null;
  if (existsSync(hiddenPath)) {
    try { hidden = JSON.parse(readFileSync(hiddenPath, 'utf8')); } catch (e) {
      problems.push(`node_modules/.package-lock.json is not valid JSON: ${String((e && e.message) || e)}`);
    }
  } else {
    problems.push('node_modules/.package-lock.json is missing (node_modules was not freshly installed)');
  }

  for (const { pkg, repo } of CORES) {
    const sha = snapshot.cores[pkg].sha;
    const spec = `github:${repo}#${sha}`;
    const actualSpec = (manifest.dependencies || {})[pkg];
    if (actualSpec !== spec) problems.push(`package.json dependencies.${pkg} is ${JSON.stringify(actualSpec)}, expected ${spec}`);

    const lockEntry = (lock.packages || {})[`node_modules/${pkg}`];
    if (!resolvedMatches(lockEntry && lockEntry.resolved, repo, sha)) {
      problems.push(`package-lock.json node_modules/${pkg}.resolved is ${JSON.stringify(lockEntry && lockEntry.resolved)}, expected it to end with #${sha}`);
    }

    if (hidden) {
      const hiddenEntry = (hidden.packages || {})[`node_modules/${pkg}`];
      if (!resolvedMatches(hiddenEntry && hiddenEntry.resolved, repo, sha)) {
        problems.push(`node_modules/.package-lock.json node_modules/${pkg}.resolved is ${JSON.stringify(hiddenEntry && hiddenEntry.resolved)}, expected it to end with #${sha}`);
      }
    }

    // npm ≥7 extracts git deps WITHOUT a .git directory — `git rev-parse`
    // inside node_modules/<pkg> silently walks up to the OUTER checkout and
    // reports its HEAD (a false oracle the first real rehearsal of this tool
    // caught: it returned the Product commit, not the core's). The provenance
    // of an npm ci install is npm's own record: the hidden lockfile above,
    // rewritten from the real resolution at ci time, plus the installed
    // package actually being there under the right name.
    const installedPkgJson = join(checkout, 'node_modules', pkg, 'package.json');
    if (!existsSync(installedPkgJson)) {
      problems.push(`node_modules/${pkg} is not installed`);
    } else {
      let installedName = null;
      try { installedName = JSON.parse(readFileSync(installedPkgJson, 'utf8')).name; } catch { installedName = null; }
      if (installedName !== pkg) {
        problems.push(`node_modules/${pkg}/package.json declares name ${JSON.stringify(installedName)}, expected "${pkg}"`);
      }
    }
  }

  if (problems.length) {
    throw new CandidateError(EXIT.VERIFY, 'candidate provenance verification failed', problems);
  }
  return { manifest: true, lock: true, hiddenLock: hidden !== null, installed: true };
}

export async function applyCandidate({ snapshot, checkout, io = defaultIo() }) {
  validateSnapshot(snapshot);
  const pre = preflight(checkout);
  const result = {
    stage: 'apply', checkout: pre.checkout, source: snapshot.source,
    product: snapshot.product, cores: snapshot.cores, verified: null,
  };

  const manifest = JSON.parse(pre.originalManifest);
  for (const { pkg, repo } of CORES) {
    manifest.dependencies[pkg] = `github:${repo}#${snapshot.cores[pkg].sha}`;
  }
  const manifestOut = `${JSON.stringify(manifest, null, 2)}\n`;
  JSON.parse(manifestOut); // self-check before touching the checkout
  writeFileSync(pre.manifestPath, manifestOut);
  console.log(`[stage:manifest] ${CORES.map((c) => `${c.pkg}@${snapshot.cores[c.pkg].sha.slice(0, 12)}`).join(' ')} written`);

  const lockUp = await io.runNpm(pre.checkout, ['install', '--package-lock-only', '--no-audit', '--no-fund']);
  if (lockUp.status !== 0) {
    throw new CandidateError(EXIT.INSTALL, 'npm install --package-lock-only failed (lockfile not updated)',
      (lockUp.stderr || lockUp.stdout || '').slice(-4000));
  }
  console.log('[stage:install] lockfile regenerated for the candidate SHAs');

  const ci = await io.runNpm(pre.checkout, ['ci', '--no-audit', '--no-fund']);
  if (ci.status !== 0) {
    throw new CandidateError(EXIT.INSTALL, 'npm ci failed (node_modules is wiped and rebuilt from the lockfile on every apply)',
      (ci.stderr || ci.stdout || '').slice(-4000));
  }
  console.log('[stage:install] node_modules freshly installed from the regenerated lockfile (npm ci)');

  try {
    result.verified = await verifyProvenance(pre.checkout, snapshot, io);
  } catch (e) {
    // The temp checkout keeps the applied manifest/lock as diagnostics; the
    // original workspace was never a write target, so it stays untouched.
    console.log('[stage:verify] FAILED — the applied manifest/lock are left in the temp checkout for diagnosis');
    throw e;
  }
  console.log('[stage:verify] manifest spec / package-lock resolved / hidden lockfile / installed package identity all match the captured SHAs');
  return result;
}

// ---------------------------------------------------------------------------
// advance-check (informational — a moved main is next round's input)

export async function advanceCheck(snapshot, io = defaultIo()) {
  validateSnapshot(snapshot);
  if (snapshot.source !== 'main') {
    return { applicable: false, reason: 'explicit captures pin caller-given SHAs; there is no main ref to re-observe' };
  }
  const cores = {};
  let advanced = false;
  for (const { pkg, repo } of CORES) {
    let now;
    try {
      now = await io.listMainSha(repo);
    } catch (e) {
      throw new CandidateError(EXIT.CAPTURE, `advance-check could not re-observe ${repo} ${MAIN_REF}`, String((e && e.message) || e));
    }
    const moved = now !== snapshot.cores[pkg].sha;
    cores[pkg] = { captured: snapshot.cores[pkg].sha, now, advanced: moved };
    advanced = advanced || moved;
  }
  return { applicable: true, advanced, cores };
}

// ---------------------------------------------------------------------------
// CLI

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    throw new CandidateError(EXIT.USAGE, `flag ${flag} needs a value`);
  }
  return v;
}

function requireValue(argv, flag) {
  const v = argValue(argv, flag);
  if (v === undefined) throw new CandidateError(EXIT.USAGE, `missing required flag ${flag}`);
  return v;
}

function emitResult(resultFile, payload) {
  const line = `CANDIDATE-RESULT ${JSON.stringify(payload)}`;
  if (resultFile) writeFileSync(resultFile, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(line);
}

export async function runCli(argv, io = defaultIo()) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'capture') {
      const out = argValue(rest, '--out');
      const snapshot = await captureCandidate({
        checkout: requireValue(rest, '--checkout'),
        source: argValue(rest, '--source') || 'main',
        runtimeSha: argValue(rest, '--runtime-sha'),
        harnessSha: argValue(rest, '--harness-sha'),
        io,
      });
      if (out) writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(JSON.stringify(snapshot, null, 2));
      return EXIT.OK;
    }
    if (cmd === 'apply') {
      const snapshot = readSnapshotFile(requireValue(rest, '--snapshot'));
      const result = await applyCandidate({ snapshot, checkout: requireValue(rest, '--checkout'), io });
      emitResult(argValue(rest, '--result-file'), { ok: true, ...result });
      return EXIT.OK;
    }
    if (cmd === 'verify') {
      const snapshot = readSnapshotFile(requireValue(rest, '--snapshot'));
      const checkout = requireValue(rest, '--checkout');
      await verifyProvenance(checkout, snapshot, io);
      console.log('[stage:verify] ok');
      emitResult(argValue(rest, '--result-file'), { ok: true, stage: 'verify', checkout, source: snapshot.source });
      return EXIT.OK;
    }
    if (cmd === 'advance-check') {
      const snapshot = readSnapshotFile(requireValue(rest, '--snapshot'));
      const r = await advanceCheck(snapshot, io);
      emitResult(argValue(rest, '--result-file'), r);
      return EXIT.OK;
    }
    throw new CandidateError(EXIT.USAGE,
      `unknown subcommand ${JSON.stringify(cmd)} — expected capture | apply | verify | advance-check`);
  } catch (e) {
    if (e instanceof CandidateError) {
      console.error(`CANDIDATE-FAIL stage=${e.stage} exit=${e.stage} ${e.message}`);
      if (Array.isArray(e.detail)) for (const p of e.detail) console.error(`  - ${p}`);
      return e.stage;
    }
    console.error(`CANDIDATE-FAIL stage=${EXIT.IO} exit=${EXIT.IO} unexpected error: ${(e && e.stack) || e}`);
    return EXIT.IO;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
