// Shared, bounded cleanup for process trees THIS code explicitly spawned
// and owns (m3c review round 2, F1). ONE termination algorithm, two
// consumers — the suite wall-clock timeout (browser-gate-runner.cjs) and
// the preview shutdown (browser-gate-preview.cjs). Ownership rules:
//   - only trees whose root we spawned with detached:true on POSIX, so the
//     root pid IS its own process-group id; the GROUP is the owned
//     identity, not the (possibly already exited) root;
//   - a root that exited on its own never skips group cleanup — POSIX
//     checks the group; Windows, which has no group to signal after the
//     root is gone, reports an explicit cleanup FAILURE instead of a
//     silent ok;
//   - strangers are never touched: no port-based, name-based or
//     machine-wide scans; if cleanup cannot be CONFIRMED within bounded
//     windows, the result is an explicit failure the caller must surface.
// Termination request and verified completion are deliberately separate:
// signalTree() only requests, terminateTree() owns the bounded waiting,
// escalation and confirmation.
'use strict';
const { spawnSync } = require('child_process');

const DEFAULT_TERM_GRACE_MS = 8000;
const DEFAULT_KILL_CONFIRM_MS = 8000;
const POLL_MS = 100;
const TASKKILL_TIMEOUT_MS = 10000;

// Identity captured at spawn time from the root pid we own.
function ownTreeIdentity(rootPid) {
  return process.platform === 'win32'
    ? { platform: 'win32', rootPid }
    : { platform: 'posix', pgid: rootPid, rootPid };
}

// kill(…, 0) checks existence only. A not-yet-reaped zombie still answers
// "alive" here — conservative in the safe direction (we keep waiting or
// escalate instead of declaring victory early); functional proof (port
// release, process function) belongs to the caller's assertions.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

// True while ANY member of the owned group exists (ESRCH = none left).
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; } catch (e) { return false; }
}

// Bounded "condition becomes true" poll. Always settles within ms; the
// poll timer never outlives this promise.
function waitForCondition(fn, ms, pollMs = POLL_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch (e) { v = false; }
      if (v) return resolve(true);
      if (Date.now() - started >= ms) return resolve(false);
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

// Termination REQUEST only — no waiting, no verdict. POSIX: signal the
// owned group; single-pid fallback only when no group with that id exists
// AND the root itself is alive (a root that never became a group leader —
// a spawn-contract violation — is then the honest best effort). Windows:
// taskkill /T /F on the root, the platform's real tree kill, with a
// bounded call so a wedged taskkill cannot hang cleanup.
function signalTree(identity, signal) {
  if (identity.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(identity.rootPid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true, timeout: TASKKILL_TIMEOUT_MS });
    if (r.error) return { ok: false, error: r.error };
    if (r.status !== 0) return { ok: false, error: new Error('taskkill /T /F exited ' + r.status) };
    return { ok: true };
  }
  try {
    process.kill(-identity.pgid, signal);
    return { ok: true };
  } catch (groupErr) {
    if (groupErr && groupErr.code === 'ESRCH') {
      // No such group: nothing of ours is left to signal at group level.
      return { ok: true, gone: true };
    }
    try { process.kill(identity.rootPid, signal); return { ok: true, fallbackSingle: true }; }
    catch (singleErr) { return { ok: false, error: singleErr }; }
  }
}

// Bounded, VERIFIED cleanup of one owned tree. Never throws; resolves
// { ok: true, how } or { ok: false, stage, error }.
//   POSIX: SIGTERM to the owned group → bounded grace → SIGKILL to the same
//   group while members survive → bounded confirmation; a group that is
//   already gone (root exited naturally, no members left) is verified, not
//   assumed. Windows: root alive → bounded taskkill /T /F → root-exit
//   confirmation; root already exited → explicit failure (the orphaned
//   descendants have no recorded identity on this platform).
async function terminateTree(identity, opts = {}) {
  const termGraceMs = opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const killConfirmMs = opts.killConfirmMs ?? DEFAULT_KILL_CONFIRM_MS;

  if (identity.platform === 'win32') {
    if (!pidAlive(identity.rootPid)) {
      return {
        ok: false,
        stage: 'win32-root-exited',
        error: new Error('owned tree root pid ' + identity.rootPid
          + ' already exited before cleanup — win32 has no group to signal and cannot verify the rest of the tree is gone'),
      };
    }
    const k = signalTree(identity, 'SIGKILL');
    if (!k.ok) {
      // taskkill races natural exits: it reports failure ("not found")
      // when the root died between our aliveness check and the kill. If
      // the root is verifiably dead NOW, this is a COMPLETED attempt
      // (taskkill ran while the root was verified alive) — unlike the
      // never-attempted root-exited case below, which stays an explicit
      // failure. Real taskkill failures on a live tree stay visible.
      if (!pidAlive(identity.rootPid)) {
        return { ok: true, how: 'root exited during the kill race (taskkill reported it gone); win32 cannot enumerate anything beyond the root' };
      }
      return { ok: false, stage: 'taskkill', error: k.error };
    }
    const rootGone = await waitForCondition(() => !pidAlive(identity.rootPid), killConfirmMs);
    if (!rootGone) {
      return {
        ok: false,
        stage: 'win32-confirm',
        error: new Error('owned root pid ' + identity.rootPid + ' still alive ' + killConfirmMs + 'ms after taskkill /T /F'),
      };
    }
    return { ok: true, how: 'taskkill /T /F, root exit confirmed' };
  }

  const groupExists = groupAlive(identity.pgid);
  if (!groupExists && !pidAlive(identity.rootPid)) {
    return { ok: true, how: 'owned tree already gone (verified: no group members, root gone)' };
  }
  if (groupExists) {
    const t = signalTree(identity, 'SIGTERM');
    if (!t.ok) return { ok: false, stage: 'term', error: t.error };
    if (!t.gone) {
      const termDead = await waitForCondition(() => !groupAlive(identity.pgid), termGraceMs);
      if (termDead) return { ok: true, how: 'owned group exited on SIGTERM' };
      const k = signalTree(identity, 'SIGKILL');
      if (!k.ok) return { ok: false, stage: 'kill', error: k.error };
      if (k.gone) return { ok: true, how: 'owned group gone at SIGKILL' };
    }
    const killDead = await waitForCondition(() => !groupAlive(identity.pgid), killConfirmMs);
    if (killDead) return { ok: true, how: 'owned group confirmed gone after SIGKILL' };
    return {
      ok: false,
      stage: 'kill-confirm',
      error: new Error('owned process group ' + identity.pgid
        + ' still has live members ' + killConfirmMs + 'ms after SIGKILL — cleanup could not be confirmed'),
    };
  }
  // Root alive but never formed its own group (spawn-contract violation —
  // every spawn in runner/preview sets detached on POSIX). Best effort on
  // the root alone, honestly labeled: its children were never in a group
  // we own.
  try { process.kill(identity.rootPid, 'SIGTERM'); } catch (e) { /* gone */ }
  const termDead = await waitForCondition(() => !pidAlive(identity.rootPid), termGraceMs);
  if (termDead) return { ok: true, how: 'bare root (no owned group) exited on SIGTERM' };
  try { process.kill(identity.rootPid, 'SIGKILL'); } catch (e) { /* gone */ }
  const killDead = await waitForCondition(() => !pidAlive(identity.rootPid), killConfirmMs);
  if (killDead) return { ok: true, how: 'bare root (no owned group) confirmed gone after SIGKILL' };
  return {
    ok: false,
    stage: 'kill-confirm',
    error: new Error('owned root pid ' + identity.rootPid + ' (no process group) still alive ' + killConfirmMs + 'ms after SIGKILL'),
  };
}

// SIGKILL backstop for OUR OWN tracked fixtures (test scaffolding): group
// first, then the bare pid. Never for strangers.
function forceKillIdentity(identity) {
  if (identity.platform === 'win32') {
    signalTree(identity, 'SIGKILL');
    return;
  }
  try { process.kill(-identity.pgid, 'SIGKILL'); } catch (e) {
    try { process.kill(identity.rootPid, 'SIGKILL'); } catch (e2) { /* gone */ }
  }
  try { process.kill(identity.rootPid, 'SIGKILL'); } catch (e) { /* gone */ }
}

module.exports = {
  DEFAULT_TERM_GRACE_MS,
  DEFAULT_KILL_CONFIRM_MS,
  TASKKILL_TIMEOUT_MS,
  ownTreeIdentity,
  pidAlive,
  groupAlive,
  signalTree,
  terminateTree,
  forceKillIdentity,
};
