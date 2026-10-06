// M4a-A + review round 1: unit battery for the core-main candidate tool
// (scripts/core-main-candidate.mjs) — every network/npm hop is a controlled
// fake (no real transport, no real model); real git builds the fixtures so
// Product identity is checked against REAL commit SHAs, never arbitrary
// placeholders.
//
//   CC1  capture (main): each core's main observed exactly once; snapshot is
//        strict (schemaVersion, product commit, repo/ref/sha/source per core)
//   CC2  after capture, a moving main never leaks into the same run: apply
//        reads the captured SHAs only and never re-observes a ref
//   CC3  missing / malformed / throwing transport values fail at the CAPTURE
//        stage with a clear error; explicit SHAs are format-checked
//   CC4  capture modes never mix: explicit SHA flags under --source main are
//        a usage error; explicit mode demands both SHAs
//   CC5  snapshot validation: any tampering (bad sha, extra/missing keys,
//        ref/source mixing between main and explicit) is refused before any
//        checkout is touched
//   CC6  apply happy path: manifest rewritten to the captured SHAs, lockfile
//        regenerated, node_modules rebuilt via npm ci (never a stale install
//        behind a manifest-only edit), provenance verified in npm's records
//   CC7  an install failure leaves the ORIGINAL workspace byte-identical and
//        reports the install stage
//   CC8  provenance mismatch (stale lockfile entry, stale hidden-lockfile
//        entry, missing hidden lockfile, wrong installed package identity) is
//        rejected at the verify stage
//   CC9  explicit and main sources stay distinguishable end-to-end
//   CC10 advance-check is informational: a moved main never fails a run;
//        explicit captures have no main ref to re-observe
//   CC11 downstream failures keep non-zero exits with distinct stage codes
//   F2   the snapshot is bound to the REAL Product commit: capture refuses a
//        dirty tree or unreadable HEAD; apply refuses a checkout whose HEAD
//        differs from snapshot.product.commit with zero writes and zero npm
//        calls; verify re-checks the real HEAD and the allowed candidate
//        delta (only package.json / package-lock.json may differ)
//   F1   dispatch inputs arrive via env (workflow channel) and are validated
//        by the same shared entry — empty inputs mean main mode; mixing
//        main with SHA inputs is refused through env just as through flags
//
// Run: node tests/core-main-candidate.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORES, EXIT, CandidateError, advanceCheck, applyCandidate, captureCandidate,
  runCli, validateSnapshot, verifyProvenance,
} from '../scripts/core-main-candidate.mjs';

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (detail !== undefined ? ' | ' + detail : '')); }
}
async function expectStage(name, stage, fn) {
  try {
    await fn();
    check(name, false, 'no error thrown');
  } catch (e) {
    check(name, e instanceof CandidateError && e.stage === stage,
      JSON.stringify({ stage: e && e.stage, msg: e && e.message, detail: e && e.detail }));
  }
}

const SHA_RT = 'a'.repeat(40);
const SHA_H = 'b'.repeat(40);
const SHA_RT_MOVED = 'c'.repeat(40);
const SHA_H_MOVED = 'd'.repeat(40);
const SHA_INSTALLED_WRONG = 'e'.repeat(40);
const NOW = '2026-10-05T00:00:00.000Z';

function specOf(repo, sha) { return `github:${repo}#${sha}`; }
function resolvedOf(repo, sha) { return `git+ssh://git@github.com/${repo}.git#${sha}`; }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}
function headSha(dir) { return git(dir, ['rev-parse', 'HEAD']); }

// A minimal product checkout with the same dependency shape as the real one:
// two pinned git deps on the cores + a registry dep. Returns the REAL commit
// SHA it was committed with — Product identity checks run against it.
function makeCheckout(dir, { runtimeSha = SHA_RT, harnessSha = SHA_H } = {}) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  const manifest = {
    name: 'candidate-fixture', version: '0.0.0', private: true, type: 'module',
    dependencies: {
      'locus-harness': specOf('boccchi2993/locus-harness', harnessSha),
      'locus-runtime': specOf('boccchi2993/locus-runtime', runtimeSha),
      vue: '^3.5.13',
    },
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeLockfiles(dir, { 'locus-runtime': runtimeSha, 'locus-harness': harnessSha });
  writeInstalled(dir, {});
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'init']);
  return headSha(dir);
}

// A clean clone of a fixture carries the SAME Product commit — the shape the
// workflow produces (clone, then check out the captured Product commit).
// core.autocrlf=false keeps the working tree byte-identical to the commit on
// Windows too (otherwise the smudged CRLF checkout shows as modified the
// moment apply rewrites the manifest with LF, and re-apply flows could never
// see a clean tree).
function cloneFixture(src, dest) {
  spawnSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', src, dest], { encoding: 'utf8' });
  return dest;
}

// Simulate what npm writes for the two git deps (package-lock.json and the
// hidden node_modules/.package-lock.json) from the current manifest specs.
function specSha(spec) {
  const m = /^github:boccchi2993\/(locus-(?:runtime|harness))#([0-9a-f]{40})$/.exec(spec);
  if (!m) throw new Error('unexpected spec in fixture: ' + spec);
  return m[2];
}

function writeLockfiles(dir, shaByPkg) {
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lockObject(shaByPkg), null, 2) + '\n');
  writeFileSync(join(dir, 'node_modules', '.package-lock.json'), JSON.stringify(lockObject(shaByPkg), null, 2) + '\n');
}

function lockObject(shaByPkg) {
  const packages = {
    '': { name: 'candidate-fixture', version: '0.0.0', dependencies: {} },
  };
  for (const { pkg, repo } of CORES) {
    packages[`node_modules/${pkg}`] = { version: '0.1.0', resolved: resolvedOf(repo, shaByPkg[pkg]) };
  }
  packages['node_modules/vue'] = { version: '3.5.13', resolved: 'https://registry.npmjs.org/vue/-/vue-3.5.13.tgz' };
  return { name: 'candidate-fixture', version: '0.0.0', lockfileVersion: 3, packages };
}

// Simulate npm's extraction of the git deps: a plain folder per package with
// its own package.json (npm ≥7 keeps no .git inside — see the tool's comment).
function writeInstalled(cwd, nameByPkg) {
  for (const { pkg } of CORES) {
    const dir = join(cwd, 'node_modules', pkg);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'),
      JSON.stringify({ name: nameByPkg[pkg] || pkg, version: '0.1.0' }, null, 2) + '\n');
  }
}

// Controlled npm stand-in: re-locks the two core entries from the manifest
// the tool just rewrote; knobs let a test inject staleness or failure —
//   failOn           that npm subcommand exits non-zero
//   lockOverrides    stale/wrong SHA in package-lock.json
//   hiddenOverrides  stale/wrong SHA in node_modules/.package-lock.json
//   skipHidden       hidden lockfile absent (node_modules not freshly installed)
//   corruptInstalled installed folder declares the wrong package name
function fakeNpm(opts = {}) {
  return async (cwd, args) => {
    if (opts.failOn === args[0]) {
      return { status: 1, stdout: '', stderr: `npm ERR! simulated ${args[0]} failure` };
    }
    if (args[0] === 'install') {
      // a fresh clone has no node_modules (gitignored) — npm ci creates it
      mkdirSync(join(cwd, 'node_modules'), { recursive: true });
      const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      const fromManifest = {};
      for (const { pkg } of CORES) fromManifest[pkg] = specSha(manifest.dependencies[pkg]);
      writeFileSync(join(cwd, 'package-lock.json'),
        JSON.stringify(lockObject({ ...fromManifest, ...(opts.lockOverrides || {}) }), null, 2) + '\n');
      if (opts.skipHidden) {
        rmSync(join(cwd, 'node_modules', '.package-lock.json'), { force: true });
      } else {
        writeFileSync(join(cwd, 'node_modules', '.package-lock.json'),
          JSON.stringify(lockObject({ ...fromManifest, ...(opts.hiddenOverrides || {}) }), null, 2) + '\n');
      }
      writeInstalled(cwd, opts.corruptInstalled || {});
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

function fakeIo({ mains = {}, npm = fakeNpm(), env = {} } = {}) {
  const calls = { listMainSha: [], npm: [] };
  return {
    io: {
      now: () => NOW,
      env,
      listMainSha: async (repo) => {
        calls.listMainSha.push(repo);
        const v = mains[repo];
        if (v instanceof Error) throw v;
        return v;
      },
      runNpm: async (cwd, args) => { calls.npm.push({ cwd, args }); return npm(cwd, args); },
    },
    calls,
  };
}

function snapObject(productCommit, { source = 'main', runtimeSha = SHA_RT, harnessSha = SHA_H } = {}) {
  return {
    schemaVersion: 1, capturedAt: NOW, source,
    product: { repo: 'boccchi2993/locus-product', commit: productCommit },
    cores: {
      'locus-runtime': { repo: 'boccchi2993/locus-runtime',
        ref: source === 'main' ? 'refs/heads/main' : null, sha: runtimeSha, source },
      'locus-harness': { repo: 'boccchi2993/locus-harness',
        ref: source === 'main' ? 'refs/heads/main' : null, sha: harnessSha, source },
    },
  };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'core-main-candidate-test-'));
  try {
    const mainsAccepted = { 'boccchi2993/locus-runtime': SHA_RT, 'boccchi2993/locus-harness': SHA_H };
    const mainsMoved = { 'boccchi2993/locus-runtime': SHA_RT_MOVED, 'boccchi2993/locus-harness': SHA_H_MOVED };

    // --- CC1 + CC2: capture once; a moving main never leaks into the run ----
    let captureFixture; // reused by the F1 env cases below
    {
      const fixture = join(tmp, 'capture');
      const productSha = makeCheckout(fixture);
      captureFixture = fixture;
      const { io, calls } = fakeIo({ mains: mainsAccepted });
      const snap = await captureCandidate({ checkout: fixture, io });
      check('CC1 capture records the observed main SHAs', snap.cores['locus-runtime'].sha === SHA_RT
        && snap.cores['locus-harness'].sha === SHA_H);
      check('CC1 snapshot is strict and binds the REAL fixture Product commit',
        snap.schemaVersion === 1 && snap.source === 'main'
        && snap.product.repo === 'boccchi2993/locus-product' && snap.product.commit === productSha
        && snap.cores['locus-runtime'].ref === 'refs/heads/main' && snap.cores['locus-runtime'].source === 'main');
      check('CC1 each core main observed exactly once', calls.listMainSha.length === 2);

      // The ref moves AFTER capture; the frozen snapshot and everything read
      // from it must still carry the captured SHAs. The apply target is a
      // clean clone of the captured Product commit (the workflow's shape).
      const { io: io2, calls: calls2 } = fakeIo({ mains: mainsMoved, npm: fakeNpm() });
      const checkout = cloneFixture(fixture, join(tmp, 'apply-stable'));
      check('CC2 clone carries the captured Product commit', headSha(checkout) === productSha);
      await applyCandidate({ snapshot: snap, checkout, io: io2 });
      const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
      check('CC2 apply uses the captured SHAs after the ref moved',
        manifest.dependencies['locus-runtime'] === specOf('boccchi2993/locus-runtime', SHA_RT)
        && manifest.dependencies['locus-harness'] === specOf('boccchi2993/locus-harness', SHA_H));
      const lock = JSON.parse(readFileSync(join(checkout, 'package-lock.json'), 'utf8'));
      check('CC2 lockfile matches the captured SHAs (not the moved ref)',
        lock.packages['node_modules/locus-runtime'].resolved.endsWith('#' + SHA_RT)
        && lock.packages['node_modules/locus-harness'].resolved.endsWith('#' + SHA_H));
      check('CC2 apply never re-observes a ref', calls2.listMainSha.length === 0);
      check('CC6 apply runs lock-regen then a fresh npm ci',
        JSON.stringify(calls2.npm.map((c) => c.args[0])) === JSON.stringify(['install', 'ci'])
        && calls2.npm[0].args.includes('--package-lock-only'));
    }

    // --- F2 (capture side) + F1 (env inputs) --------------------------------
    {
      const fixture = join(tmp, 'capture-dirty');
      makeCheckout(fixture);
      writeFileSync(join(fixture, 'untracked-src.js'), 'intentional dirt\n');
      await expectStage('F2 capture refuses a dirty tree (no uncommitted source recorded as the commit)',
        EXIT.CAPTURE, () => captureCandidate({ checkout: fixture, io: fakeIo({ mains: mainsAccepted }).io }));

      const unborn = join(tmp, 'capture-unborn');
      mkdirSync(unborn, { recursive: true });
      git(unborn, ['init', '-q', '-b', 'main']);
      await expectStage('F2 capture refuses a checkout with no readable Product commit',
        EXIT.CAPTURE, () => captureCandidate({ checkout: unborn, io: fakeIo({ mains: mainsAccepted }).io }));

      const cleanSha = headSha(captureFixture);

      // env channel (F1): explicit SHAs through env, validated by the shared
      // entry, binding the real Product commit.
      const envOut = join(tmp, 'snap-env.json');
      const envCode = await runCli(['capture', '--checkout', captureFixture, '--out', envOut],
        fakeIo({ mains: mainsAccepted, env: { CAND_SOURCE: 'explicit', CAND_RUNTIME_SHA: SHA_RT, CAND_HARNESS_SHA: SHA_H } }).io);
      const envSnap = envCode === EXIT.OK ? JSON.parse(readFileSync(envOut, 'utf8')) : null;
      check('F1 env inputs drive explicit capture through the shared entry',
        envSnap !== null && envSnap.source === 'explicit' && envSnap.product.commit === cleanSha
        && envSnap.cores['locus-runtime'].sha === SHA_RT);

      // empty env (schedule shape) → main mode, offline via the fake transport
      const mainOut = join(tmp, 'snap-env-main.json');
      const mainCode = await runCli(['capture', '--checkout', captureFixture, '--out', mainOut],
        fakeIo({ mains: mainsAccepted, env: {} }).io);
      const mainSnap = mainCode === EXIT.OK ? JSON.parse(readFileSync(mainOut, 'utf8')) : null;
      check('F1 empty env inputs (schedule shape) resolve to main mode offline',
        mainSnap !== null && mainSnap.source === 'main' && mainSnap.product.commit === cleanSha);

      // main mode with SHA env inputs is refused exactly like with flags
      const mixedCode = await runCli(['capture', '--checkout', captureFixture, '--source', 'main'],
        fakeIo({ env: { CAND_RUNTIME_SHA: SHA_RT } }).io);
      check('F1 main mode with SHA env inputs is a usage error, like flags',
        mixedCode === EXIT.USAGE);
    }

    // --- CC3: missing / malformed / failing transport -----------------------
    {
      const fixture = join(tmp, 'capture-bad');
      makeCheckout(fixture);
      for (const [name, mains] of [
        ['CC3 non-hex transport value', { 'boccchi2993/locus-runtime': 'not-a-sha', 'boccchi2993/locus-harness': SHA_H }],
        ['CC3 short transport value', { 'boccchi2993/locus-runtime': 'a'.repeat(39), 'boccchi2993/locus-harness': SHA_H }],
        ['CC3 uppercase transport value', { 'boccchi2993/locus-runtime': 'A'.repeat(40), 'boccchi2993/locus-harness': SHA_H }],
      ]) {
        await expectStage(name, EXIT.CAPTURE, () => captureCandidate({ checkout: fixture, io: fakeIo({ mains }).io }));
      }
      await expectStage('CC3 failing transport surfaces as capture stage',
        EXIT.CAPTURE, () => captureCandidate({
          checkout: fixture,
          io: fakeIo({ mains: { 'boccchi2993/locus-runtime': new Error('network down'), 'boccchi2993/locus-harness': SHA_H } }).io,
        }));
    }

    // --- CC4 + CC9: capture modes never mix ---------------------------------
    {
      const fixture = join(tmp, 'capture-modes');
      const productSha = makeCheckout(fixture);
      await expectStage('CC4 explicit SHA flags under --source main are refused', EXIT.USAGE, () => captureCandidate({
        checkout: fixture, source: 'main', runtimeSha: SHA_RT, io: fakeIo().io,
      }));
      await expectStage('CC4 explicit mode demands the runtime SHA', EXIT.USAGE, () => captureCandidate({
        checkout: fixture, source: 'explicit', harnessSha: SHA_H, io: fakeIo({ mains: mainsAccepted }).io,
      }));
      await expectStage('CC4 explicit mode demands the harness SHA', EXIT.USAGE, () => captureCandidate({
        checkout: fixture, source: 'explicit', runtimeSha: SHA_RT, io: fakeIo({ mains: mainsAccepted }).io,
      }));
      await expectStage('CC4 invalid source value refused', EXIT.USAGE, () => captureCandidate({
        checkout: fixture, source: 'pr-head', runtimeSha: SHA_RT, harnessSha: SHA_H, io: fakeIo().io,
      }));

      const snap = await captureCandidate({
        checkout: fixture, source: 'explicit', runtimeSha: SHA_RT, harnessSha: SHA_H, io: fakeIo().io,
      });
      check('CC9 explicit capture marks source explicit and has no main ref',
        snap.source === 'explicit' && snap.cores['locus-runtime'].ref === null
        && snap.cores['locus-runtime'].source === 'explicit');
      const checkout = cloneFixture(fixture, join(tmp, 'apply-explicit'));
      const result = await applyCandidate({ snapshot: snap, checkout, io: fakeIo().io });
      check('CC9/F2 apply result keeps snapshot identity end-to-end (source, Product, cores)',
        result.source === 'explicit' && result.product.commit === productSha
        && result.cores['locus-runtime'].sha === SHA_RT
        && result.cores['locus-harness'].sha === SHA_H
        && result.verified.productIdentity === true && result.verified.allowedDelta === true);
    }

    // --- CC5: snapshot validation -------------------------------------------
    {
      const base = snapObject('f'.repeat(40));
      const explicitWithMainRef = snapObject(base.product.commit, { source: 'explicit' });
      explicitWithMainRef.cores['locus-runtime'].ref = 'refs/heads/main';
      const mainWithNullRef = snapObject(base.product.commit);
      mainWithNullRef.cores['locus-runtime'].ref = null;
      const clones = {
        'CC5 bad sha in snapshot': { ...base, cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], sha: 'zz' } } },
        'CC5 extra top-level key': { ...base, extra: true },
        'CC5 wrong core repo string': { ...base, cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], repo: 'evil/locus-runtime' } } },
        'CC5 per-core source mismatch': { ...base, cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], source: 'explicit' } } },
        'CC5 explicit snapshot carrying a main ref': explicitWithMainRef,
        'CC5 main snapshot with null ref': mainWithNullRef,
        'CC5 missing product commit': { ...base, product: { repo: 'boccchi2993/locus-product', commit: 'short' } },
      };
      for (const [name, snap] of Object.entries(clones)) {
        let ok = false, detail = '';
        try { validateSnapshot(snap); } catch (e) { ok = e instanceof CandidateError && e.stage === EXIT.USAGE; detail = e.message; }
        check(name, ok, detail);
      }
      // apply refuses a tampered snapshot before touching anything
      const checkout = join(tmp, 'apply-tampered');
      makeCheckout(checkout);
      const before = readFileSync(join(checkout, 'package.json'), 'utf8');
      await expectStage('CC5 apply refuses a tampered snapshot', EXIT.USAGE, () => applyCandidate({
        snapshot: clones['CC5 bad sha in snapshot'], checkout, io: fakeIo().io,
      }));
      check('CC5 refused apply left the checkout manifest untouched',
        readFileSync(join(checkout, 'package.json'), 'utf8') === before);
    }

    // --- F2 (apply side): identity binding before any effect -----------------
    let f2ProductDir; // reused by CC7 as the snapshot source fixture
    {
      const fixture = join(tmp, 'f2-product-a');
      const productSha = makeCheckout(fixture);
      f2ProductDir = fixture;
      const snap = validateSnapshot(snapObject(productSha));

      // a DIFFERENT Product commit: same tree shape, different HEAD
      const other = cloneFixture(fixture, join(tmp, 'f2-product-b'));
      git(other, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
        'commit', '-q', '--allow-empty', '-m', 'product b head']);

      const beforeManifest = readFileSync(join(other, 'package.json'), 'utf8');
      const beforeLock = readFileSync(join(other, 'package-lock.json'), 'utf8');
      const { io, calls } = fakeIo();
      let caught = null;
      try {
        await applyCandidate({ snapshot: snap, checkout: other, io });
      } catch (e) { caught = e; }
      check('F2 apply refuses a checkout whose HEAD differs from the snapshot Product commit',
        caught instanceof CandidateError && caught.stage === EXIT.PREFLIGHT
        && caught.detail && caught.detail.expected === productSha
        && typeof caught.detail.actual === 'string' && caught.detail.actual !== productSha
        && /^[0-9a-f]{40}$/.test(caught.detail.actual),
        JSON.stringify({ stage: caught && caught.stage, detail: caught && caught.detail }));
      check('F2 refused apply wrote zero bytes (manifest untouched)',
        readFileSync(join(other, 'package.json'), 'utf8') === beforeManifest);
      check('F2 refused apply wrote zero bytes (lock untouched)',
        readFileSync(join(other, 'package-lock.json'), 'utf8') === beforeLock);
      check('F2 refused apply made zero npm calls', calls.npm.length === 0);

      // the identity check reads the REAL git HEAD — a caller-supplied string
      // cannot substitute for it — and a dirty checkout is still refused
      // outright (no dirty bypass flag exists).
      writeFileSync(join(other, 'src-tampered.js'), 'rode along\n');
      await expectStage('F2 a dirty checkout is still refused outright (no dirty bypass)',
        EXIT.PREFLIGHT, () => applyCandidate({ snapshot: snap, checkout: other, io: fakeIo().io }));
    }

    // --- CC7: install failure never touches the original workspace ----------
    {
      const temp = cloneFixture(f2ProductDir, join(tmp, 'temp-checkout'));
      const tempSha = headSha(temp);
      const workspace = join(tmp, 'original-workspace');
      makeCheckout(workspace);
      const beforeManifest = readFileSync(join(workspace, 'package.json'), 'utf8');
      const beforeLock = readFileSync(join(workspace, 'package-lock.json'), 'utf8');

      const snap = validateSnapshot(snapObject(tempSha, { runtimeSha: SHA_RT_MOVED, harnessSha: SHA_H_MOVED }));
      const { io, calls } = fakeIo({ npm: fakeNpm({ failOn: 'ci' }) });
      await expectStage('CC7 a failing npm ci reports the install stage', EXIT.INSTALL, () => applyCandidate({ snapshot: snap, checkout: temp, io }));
      check('CC7 original workspace manifest byte-identical',
        readFileSync(join(workspace, 'package.json'), 'utf8') === beforeManifest);
      check('CC7 original workspace lockfile byte-identical',
        readFileSync(join(workspace, 'package-lock.json'), 'utf8') === beforeLock);
      check('CC7 npm was only ever pointed at the temp checkout',
        calls.npm.length > 0 && calls.npm.every((c) => c.cwd.startsWith(temp)));
      // the tool also refuses its own repo as a target — covered by the
      // preflight guard; a dirty checkout is refused the same way:
      writeFileSync(join(temp, 'untracked.txt'), 'dirt\n');
      await expectStage('CC7 a dirty temp checkout is refused at preflight', EXIT.PREFLIGHT, () => applyCandidate({ snapshot: snap, checkout: temp, io }));
    }

    // --- CC8: provenance mismatches + F2 verify-side identity ----------------
    {
      const fixture = join(tmp, 'verify-fixture');
      const productSha = makeCheckout(fixture);
      const snap = validateSnapshot(snapObject(productSha));
      const snapFile = join(tmp, 'verify-snap.json');
      writeFileSync(snapFile, JSON.stringify(snap, null, 2));
      const mk = (name) => cloneFixture(fixture, join(tmp, name));

      // stale lockfile: npm "wrote" resolved entries pointing at the OLD sha
      await expectStage('CC8 lockfile resolved mismatch is rejected', EXIT.VERIFY, () => applyCandidate({
        snapshot: snap, checkout: mk('verify-stale-lock'),
        io: fakeIo({ npm: fakeNpm({ lockOverrides: { 'locus-runtime': SHA_RT_MOVED } }) }).io,
      }));
      // stale hidden lockfile: node_modules' npm-recorded provenance is not the candidate
      await expectStage('CC8 hidden-lockfile resolved mismatch is rejected', EXIT.VERIFY, () => applyCandidate({
        snapshot: snap, checkout: mk('verify-stale-hidden'),
        io: fakeIo({ npm: fakeNpm({ hiddenOverrides: { 'locus-runtime': SHA_INSTALLED_WRONG } }) }).io,
      }));
      // no hidden lockfile: node_modules was not freshly installed
      await expectStage('CC8 missing hidden lockfile is rejected', EXIT.VERIFY, () => applyCandidate({
        snapshot: snap, checkout: mk('verify-no-hidden'),
        io: fakeIo({ npm: fakeNpm({ skipHidden: true }) }).io,
      }));
      // broken extraction: the installed folder declares a different package
      await expectStage('CC8 wrong installed package identity is rejected', EXIT.VERIFY, () => applyCandidate({
        snapshot: snap, checkout: mk('verify-wrong-identity'),
        io: fakeIo({ npm: fakeNpm({ corruptInstalled: { 'locus-runtime': 'totally-other-pkg' } }) }).io,
      }));

      // F2 verify side: the applied state (only the two dependency files
      // modified) passes a standalone verify — the expected candidate delta.
      const applied = mk('verify-applied');
      await applyCandidate({ snapshot: snap, checkout: applied, io: fakeIo().io });
      const okVerify = await runCli(['verify', '--snapshot', snapFile, '--checkout', applied], fakeIo().io);
      check('F2 standalone verify accepts the applied state (allowed delta only)', okVerify === EXIT.OK,
        `exit ${okVerify}`);

      // HEAD moved after apply → verify refuses with expected/actual
      git(applied, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
        'commit', '-q', '-a', '--amend', '-m', 'head moved after apply']);
      let movedErr = null;
      try {
        await verifyProvenance(applied, snap, fakeIo().io);
      } catch (e) { movedErr = e; }
      check('F2 verify refuses a checkout whose HEAD moved after apply',
        movedErr instanceof CandidateError && movedErr.stage === EXIT.VERIFY
        && movedErr.detail && movedErr.detail.expected === productSha
        && typeof movedErr.detail.actual === 'string' && movedErr.detail.actual !== productSha,
        JSON.stringify({ stage: movedErr && movedErr.stage, detail: movedErr && movedErr.detail }));

      // tampered tested source riding along → verify refuses the delta scope
      const dirtyDelta = mk('verify-dirty-delta');
      await applyCandidate({ snapshot: snap, checkout: dirtyDelta, io: fakeIo().io });
      writeFileSync(join(dirtyDelta, 'extra-src.js'), 'impersonating change\n');
      let deltaErr = null;
      try {
        await verifyProvenance(dirtyDelta, snap, fakeIo().io);
      } catch (e) { deltaErr = e; }
      check('F2 verify refuses tested-source changes impersonating the Product commit',
        deltaErr instanceof CandidateError && deltaErr.stage === EXIT.VERIFY
        && JSON.stringify(deltaErr.detail).includes('extra-src.js'),
        JSON.stringify({ stage: deltaErr && deltaErr.stage, detail: deltaErr && deltaErr.detail }));
    }

    // --- CC10 + CC11: advance-check informational; CLI exit codes ------------
    {
      const snapFile = join(tmp, 'snap.json');
      const fixture = join(tmp, 'cli-fixture');
      const productSha = makeCheckout(fixture);
      const snap = validateSnapshot(snapObject(productSha));
      writeFileSync(snapFile, JSON.stringify(snap, null, 2));

      const moved = await advanceCheck(snap, fakeIo({ mains: mainsMoved }).io);
      check('CC10 a moved main is reported, not failed', moved.applicable === true && moved.advanced === true
        && moved.cores['locus-runtime'].advanced === true);
      const quiet = await advanceCheck(snap, fakeIo({ mains: mainsAccepted }).io);
      check('CC10 an unmoved main reports advanced=false', quiet.advanced === false);

      const explicitSnap = validateSnapshot(snapObject(productSha, { source: 'explicit' }));
      const na = await advanceCheck(explicitSnap, fakeIo().io);
      check('CC10 explicit captures have no main ref to re-observe', na.applicable === false);

      const checkout = cloneFixture(fixture, join(tmp, 'cli-codes'));
      const captureBad = await runCli(['capture', '--checkout', fixture, '--source', 'main'],
        fakeIo({ mains: { 'boccchi2993/locus-runtime': new Error('down'), 'boccchi2993/locus-harness': SHA_H } }).io);
      check('CC11 capture failure exits non-zero (CAPTURE)', captureBad === EXIT.CAPTURE && captureBad !== 0);

      const installFail = await runCli(['apply', '--snapshot', snapFile, '--checkout', checkout],
        fakeIo({ npm: fakeNpm({ failOn: 'ci' }) }).io);
      check('CC11 install failure exits non-zero (INSTALL)', installFail === EXIT.INSTALL && installFail !== 0);

      const verifyFail = await runCli(['apply', '--snapshot', snapFile, '--checkout', checkout],
        fakeIo({ npm: fakeNpm({ corruptInstalled: { 'locus-runtime': 'not-locus-runtime' } }) }).io);
      check('CC11 verify failure exits non-zero (VERIFY)', verifyFail === EXIT.VERIFY && verifyFail !== 0);

      const ok = await runCli(['apply', '--snapshot', snapFile, '--checkout', checkout], fakeIo().io);
      check('CC11 a clean apply exits 0', ok === EXIT.OK);
      check('CC11 stage codes are distinct', new Set([EXIT.CAPTURE, EXIT.INSTALL, EXIT.VERIFY, EXIT.OK]).size === 4);

      const usage = await runCli(['nonsense'], fakeIo().io);
      check('CC11 unknown subcommand exits USAGE', usage === EXIT.USAGE);
      const noFlag = await runCli(['apply', '--checkout', checkout], fakeIo().io);
      check('CC11 missing --snapshot exits USAGE', noFlag === EXIT.USAGE);

      const advanceFile = join(tmp, 'advance.json');
      const advCode = await runCli(['advance-check', '--snapshot', snapFile, '--result-file', advanceFile],
        fakeIo({ mains: mainsMoved }).io);
      check('CC10 advance-check with a moved main still exits 0',
        advCode === EXIT.OK && JSON.parse(readFileSync(advanceFile, 'utf8')).advanced === true);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED' : `all ${passed} checks passed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => { console.error('SUITE ERROR', e); process.exitCode = 1; });
