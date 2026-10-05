// M4a-A: unit battery for the core-main candidate tool
// (scripts/core-main-candidate.mjs) — every network/npm hop is a controlled
// fake (no real transport, no real model); real git is used only to give the
// fixtures a genuine clean working tree, which preflight insists on.
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
//        behind a manifest-only edit), provenance verified in all three
//        stores (manifest spec, lockfile resolved, hidden lockfile resolved,
//        installed git HEAD)
//   CC7  an install failure leaves the ORIGINAL workspace byte-identical and
//        reports the install stage
//   CC8  provenance mismatch (stale lockfile entry, stale hidden-lockfile
//        entry, missing hidden lockfile, wrong installed package identity) is
//        rejected at the verify stage
//   CC9  explicit and main sources stay distinguishable end-to-end
//   CC10 advance-check is informational: a moved main never fails a run;
//        explicit captures have no main ref to re-observe
//   CC11 downstream failures keep non-zero exits with distinct stage codes
//
// Run: node tests/core-main-candidate.test.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORES, EXIT, CandidateError, advanceCheck, applyCandidate, captureCandidate,
  runCli, validateSnapshot,
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
const PRODUCT_SHA = 'f'.repeat(40);
const NOW = '2026-10-05T00:00:00.000Z';

function specOf(repo, sha) { return `github:${repo}#${sha}`; }
function resolvedOf(repo, sha) { return `git+ssh://git@github.com/${repo}.git#${sha}`; }

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

// A minimal product checkout with the same dependency shape as the real one:
// two pinned git deps on the cores + a registry dep.
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
  return manifest;
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

function fakeIo({ mains = {}, npm = fakeNpm(), productHead = PRODUCT_SHA } = {}) {
  const calls = { listMainSha: [], npm: [] };
  return {
    io: {
      now: () => NOW,
      listMainSha: async (repo) => {
        calls.listMainSha.push(repo);
        const v = mains[repo];
        if (v instanceof Error) throw v;
        return v;
      },
      runNpm: async (cwd, args) => { calls.npm.push({ cwd, args }); return npm(cwd, args); },
      productHead: async () => productHead,
    },
    calls,
  };
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'core-main-candidate-test-'));
  try {
    const mainsAccepted = { 'boccchi2993/locus-runtime': SHA_RT, 'boccchi2993/locus-harness': SHA_H };
    const mainsMoved = { 'boccchi2993/locus-runtime': SHA_RT_MOVED, 'boccchi2993/locus-harness': SHA_H_MOVED };

    // --- CC1 + CC2: capture once; a moving main never leaks into the run ----
    {
      const fixture = join(tmp, 'capture');
      makeCheckout(fixture);
      const { io, calls } = fakeIo({ mains: mainsAccepted });
      const snap = await captureCandidate({ checkout: fixture, io });
      check('CC1 capture records the observed main SHAs', snap.cores['locus-runtime'].sha === SHA_RT
        && snap.cores['locus-harness'].sha === SHA_H);
      check('CC1 snapshot is strict', snap.schemaVersion === 1 && snap.source === 'main'
        && snap.product.repo === 'boccchi2993/locus-product' && snap.product.commit === PRODUCT_SHA
        && snap.cores['locus-runtime'].ref === 'refs/heads/main' && snap.cores['locus-runtime'].source === 'main');
      check('CC1 each core main observed exactly once', calls.listMainSha.length === 2);

      // The ref moves AFTER capture; the frozen snapshot and everything read
      // from it must still carry the captured SHAs.
      const { io: io2, calls: calls2 } = fakeIo({ mains: mainsMoved, npm: fakeNpm() });
      const checkout = join(tmp, 'apply-stable');
      makeCheckout(checkout);
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
      await expectStage('CC3 unreadable product HEAD fails at capture', EXIT.CAPTURE, () => captureCandidate({
        checkout: fixture, io: fakeIo({ mains: mainsAccepted, productHead: null }).io,
      }));
    }

    // --- CC4 + CC9: capture modes never mix ---------------------------------
    {
      const fixture = join(tmp, 'capture-modes');
      makeCheckout(fixture);
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
      const checkout = join(tmp, 'apply-explicit');
      makeCheckout(checkout);
      const result = await applyCandidate({ snapshot: snap, checkout, io: fakeIo().io });
      check('CC9 apply result keeps the explicit source visible', result.source === 'explicit');
    }

    // --- CC5: snapshot validation -------------------------------------------
    {
      const base = {
        schemaVersion: 1, capturedAt: NOW, source: 'main',
        product: { repo: 'boccchi2993/locus-product', commit: PRODUCT_SHA },
        cores: {
          'locus-runtime': { repo: 'boccchi2993/locus-runtime', ref: 'refs/heads/main', sha: SHA_RT, source: 'main' },
          'locus-harness': { repo: 'boccchi2993/locus-harness', ref: 'refs/heads/main', sha: SHA_H, source: 'main' },
        },
      };
      const clones = {
        'CC5 bad sha in snapshot': { ...base, cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], sha: 'zz' } } },
        'CC5 extra top-level key': { ...base, extra: true },
        'CC5 wrong core repo string': { ...base, cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], repo: 'evil/locus-runtime' } } },
        'CC5 per-core source mismatch': { ...base, cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], source: 'explicit' } } },
        'CC5 explicit snapshot carrying a main ref': {
          ...base, source: 'explicit',
          cores: {
            'locus-runtime': { repo: 'boccchi2993/locus-runtime', ref: 'refs/heads/main', sha: SHA_RT, source: 'explicit' },
            'locus-harness': { repo: 'boccchi2993/locus-harness', ref: null, sha: SHA_H, source: 'explicit' },
          },
        },
        'CC5 main snapshot with null ref': {
          ...base,
          cores: { ...base.cores, 'locus-runtime': { ...base.cores['locus-runtime'], ref: null } },
        },
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

    // --- CC7: install failure never touches the original workspace ----------
    {
      const workspace = join(tmp, 'original-workspace');
      const temp = join(tmp, 'temp-checkout');
      makeCheckout(workspace);
      makeCheckout(temp);
      const beforeManifest = readFileSync(join(workspace, 'package.json'), 'utf8');
      const beforeLock = readFileSync(join(workspace, 'package-lock.json'), 'utf8');

      const snap = validateSnapshot({
        schemaVersion: 1, capturedAt: NOW, source: 'main',
        product: { repo: 'boccchi2993/locus-product', commit: PRODUCT_SHA },
        cores: {
          'locus-runtime': { repo: 'boccchi2993/locus-runtime', ref: 'refs/heads/main', sha: SHA_RT_MOVED, source: 'main' },
          'locus-harness': { repo: 'boccchi2993/locus-harness', ref: 'refs/heads/main', sha: SHA_H_MOVED, source: 'main' },
        },
      });
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

    // --- CC8: provenance mismatches are rejected ----------------------------
    {
      const snap = validateSnapshot({
        schemaVersion: 1, capturedAt: NOW, source: 'main',
        product: { repo: 'boccchi2993/locus-product', commit: PRODUCT_SHA },
        cores: {
          'locus-runtime': { repo: 'boccchi2993/locus-runtime', ref: 'refs/heads/main', sha: SHA_RT, source: 'main' },
          'locus-harness': { repo: 'boccchi2993/locus-harness', ref: 'refs/heads/main', sha: SHA_H, source: 'main' },
        },
      });
      const mk = (name) => { const d = join(tmp, name); makeCheckout(d); return d; };

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
    }

    // --- CC10 + CC11: advance-check informational; CLI exit codes ------------
    {
      const snapFile = join(tmp, 'snap.json');
      const snap = validateSnapshot({
        schemaVersion: 1, capturedAt: NOW, source: 'main',
        product: { repo: 'boccchi2993/locus-product', commit: PRODUCT_SHA },
        cores: {
          'locus-runtime': { repo: 'boccchi2993/locus-runtime', ref: 'refs/heads/main', sha: SHA_RT, source: 'main' },
          'locus-harness': { repo: 'boccchi2993/locus-harness', ref: 'refs/heads/main', sha: SHA_H, source: 'main' },
        },
      });
      writeFileSync(snapFile, JSON.stringify(snap, null, 2));

      const moved = await advanceCheck(snap, fakeIo({ mains: mainsMoved }).io);
      check('CC10 a moved main is reported, not failed', moved.applicable === true && moved.advanced === true
        && moved.cores['locus-runtime'].advanced === true);
      const quiet = await advanceCheck(snap, fakeIo({ mains: mainsAccepted }).io);
      check('CC10 an unmoved main reports advanced=false', quiet.advanced === false);

      const explicitSnap = validateSnapshot({
        ...snap, source: 'explicit',
        cores: {
          'locus-runtime': { repo: 'boccchi2993/locus-runtime', ref: null, sha: SHA_RT, source: 'explicit' },
          'locus-harness': { repo: 'boccchi2993/locus-harness', ref: null, sha: SHA_H, source: 'explicit' },
        },
      });
      const na = await advanceCheck(explicitSnap, fakeIo().io);
      check('CC10 explicit captures have no main ref to re-observe', na.applicable === false);

      const checkout = join(tmp, 'cli-codes');
      makeCheckout(checkout);
      const captureBad = await runCli(['capture', '--checkout', checkout, '--source', 'main'],
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
