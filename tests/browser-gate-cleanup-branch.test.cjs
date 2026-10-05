// Round-3 gate for the owned-tree cleanup helper's platform branches
// (m3c review round 3). The REAL helper source is loaded into an isolated
// VM with the OS boundary (child_process.spawnSync, process.kill/…platform)
// replaced by scripted fakes — the terminateTree algorithm itself is NOT
// copied — so the SAME tests execute the Windows branch on Linux CI and
// vice versa, without touching the host process.platform or the require
// cache. Also pins the POSIX TERM→KILL→confirm algorithm unchanged.
//
// The regression this suite pins: a failed taskkill must NEVER be
// reported as a completed cleanup just because the root pid is gone
// afterwards — "taskkill ran" is not "the subtree is clean", and a
// taskkill ETIMEDOUT must not be rewritten into "reported it gone".
// Run: node tests/browser-gate-cleanup-branch.test.cjs
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failed = 0;
let checks = 0;

function check(name, cond, detail) {
  checks++;
  if (cond) return;
  failed++;
  console.error('  CHECK FAIL: ' + name + (detail ? ' — ' + detail : ''));
}

// Load tests/helpers/browser-gate-cleanup.cjs into a VM sandbox with the
// OS calls replaced. No algorithm duplication: this IS the shipped code.
function loadCleanupIsolated({ platform, kill, spawnSync }) {
  const src = fs.readFileSync(path.join(__dirname, 'helpers', 'browser-gate-cleanup.cjs'), 'utf8');
  const sandbox = {
    require: (name) => {
      if (name === 'child_process') return { spawnSync };
      throw new Error('isolated helper refused require: ' + name);
    },
    process: { platform, kill },
    module: { exports: {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Error, Object, Array, String, Number, Boolean, Promise, Math, JSON, Symbol, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'browser-gate-cleanup.cjs (isolated vm)' });
  return sandbox.module.exports;
}

// Windows scenario: a scripted taskkill; the root's liveness is faked via
// process.kill(pid, 0) and may flip to dead exactly when taskkill runs.
function win32Scenario({ taskkillResult, rootDiesAtTaskkill, rootAliveAtStart = true }) {
  const state = { rootAlive: rootAliveAtStart, taskkillCalls: [] };
  const spawnSync = (cmd, args, opts) => {
    state.taskkillCalls.push({ cmd, args, opts });
    if (rootDiesAtTaskkill) state.rootAlive = false;
    return taskkillResult;
  };
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (state.rootAlive) return 0;
      const e = new Error('kill ESRCH');
      e.code = 'ESRCH';
      throw e;
    }
    return 0;
  };
  const cleanup = loadCleanupIsolated({ platform: 'win32', kill, spawnSync });
  return { cleanup, state };
}

// POSIX scenario: scripted group/pid signals with kill(…, 0) liveness.
function posixScenario({ groupDiesOnTerm = true, groupDiesOnKill = true, groupAliveAtStart = true }) {
  const state = { termSignals: 0, killSignals: 0, groupAlive: groupAliveAtStart };
  const esrch = () => { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; return e; };
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (state.groupAlive) return 0;
      throw esrch();
    }
    if (pid < 0 && sig === 'SIGTERM') {
      state.termSignals++;
      if (groupDiesOnTerm) state.groupAlive = false;
      return 0;
    }
    if (pid < 0 && sig === 'SIGKILL') {
      state.killSignals++;
      if (groupDiesOnKill) state.groupAlive = false;
      return 0;
    }
    return 0;
  };
  const cleanup = loadCleanupIsolated({ platform: 'posix', kill, spawnSync: () => { throw new Error('posix path must not spawn'); } });
  return { cleanup, state };
}

const ID = 4242; // scripted root pid / group id

(async () => {
  // --- the round-3 counterexamples: a FAILED taskkill is not a cleanup ---

  {
    // 1) taskkill exits non-zero while the root disappears around it:
    //    the old code answered { ok: true, how: '…taskkill reported it
    //    gone…' } with zero subtree-completion evidence.
    const { cleanup, state } = win32Scenario({ taskkillResult: { status: 128 }, rootDiesAtTaskkill: true });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 100, killConfirmMs: 300 });
    check('CE1 a non-zero taskkill with the root vanishing is a FAILURE, not ok:true', r.ok === false, JSON.stringify(r));
    check('CE1 stage names the taskkill attempt', r.stage === 'taskkill', JSON.stringify(r));
    check('CE1 rootExited recorded as diagnostics only', r.rootExited === true, JSON.stringify(r));
    check('CE1 the exit status survives verbatim', (r.error && r.error.status === 128) || /exited 128/.test(String(r.error && r.error.message)), JSON.stringify(r.error && (r.error.status || r.error.message)));
    check('CE1 taskkill still used the tree semantics', state.taskkillCalls.length === 1 && state.taskkillCalls[0].args.includes('/T') && state.taskkillCalls[0].args.includes('/F'), JSON.stringify(state.taskkillCalls));
  }

  {
    // 2) taskkill itself TIMES OUT (spawnSync error ETIMEDOUT) while the
    //    root disappears: the old code returned ok:true and its message
    //    rewrote the timeout into "taskkill reported it gone".
    const timedOut = Object.assign(new Error('spawnSync taskkill ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const { cleanup } = win32Scenario({ taskkillResult: { error: timedOut }, rootDiesAtTaskkill: true });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 100, killConfirmMs: 300 });
    check('CE2 an ETIMEDOUT taskkill with the root vanishing is a FAILURE, not ok:true', r.ok === false, JSON.stringify(r));
    check('CE2 stage names the taskkill attempt', r.stage === 'taskkill', JSON.stringify(r));
    check('CE2 rootExited recorded as diagnostics only', r.rootExited === true, JSON.stringify(r));
    check('CE2 the timeout code survives verbatim (not rewritten)', r.error && r.error.code === 'ETIMEDOUT', JSON.stringify(r.error && r.error.code));
  }

  {
    // 3) taskkill fails and the root STAYS alive: failure either way.
    const { cleanup, state } = win32Scenario({ taskkillResult: { status: 1 }, rootDiesAtTaskkill: false });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 100, killConfirmMs: 300 });
    check('CE3 a failed taskkill on a live root stays a failure', r.ok === false && r.stage === 'taskkill', JSON.stringify(r));
    check('CE3 the exit status survives verbatim', (r.error && r.error.status === 1) || /exited 1\b/.test(String(r.error && r.error.message)), JSON.stringify(r.error && (r.error.status || r.error.message)));
    check('CE3 no ok-shaped result exists', r.how === undefined, JSON.stringify(r));
  }

  {
    // 4) the healthy control: taskkill succeeds, root exit is confirmed.
    const { cleanup } = win32Scenario({ taskkillResult: { status: 0 }, rootDiesAtTaskkill: true });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 100, killConfirmMs: 1000 });
    check('CE4 taskkill success + confirmed root exit stays ok:true', r.ok === true, JSON.stringify(r));
    check('CE4 the how describes the verified path', /taskkill \/T \/F/.test(String(r.how)), r.how);
  }

  {
    // 5) root already exited before the call: the pre-existing explicit
    //    failure semantics are unchanged.
    const { cleanup, state } = win32Scenario({ taskkillResult: { status: 0 }, rootDiesAtTaskkill: false, rootAliveAtStart: false });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 100, killConfirmMs: 300 });
    check('CE5 root-exited-before-cleanup stays an explicit failure', r.ok === false && r.stage === 'win32-root-exited', JSON.stringify(r));
    check('CE5 no taskkill was even attempted', state.taskkillCalls.length === 0, JSON.stringify(state.taskkillCalls));
  }

  // --- POSIX TERM → KILL → confirm: pinned UNCHANGED by this round ---

  {
    const { cleanup, state } = posixScenario({ groupDiesOnTerm: true });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 300, killConfirmMs: 400 });
    check('P1 group exiting on SIGTERM resolves ok', r.ok === true, JSON.stringify(r));
    check('P1 no SIGKILL escalation was needed', state.killSignals === 0 && state.termSignals === 1, JSON.stringify(state));
    check('P1 the how names the SIGTERM path', /SIGTERM/.test(String(r.how)), r.how);
  }
  {
    const { cleanup, state } = posixScenario({ groupDiesOnTerm: false, groupDiesOnKill: true });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 300, killConfirmMs: 400 });
    check('P2 TERM-ignoring group is escalated to SIGKILL and resolves ok', r.ok === true, JSON.stringify(r));
    check('P2 exactly one TERM then one KILL', state.termSignals === 1 && state.killSignals === 1, JSON.stringify(state));
  }
  {
    const { cleanup, state } = posixScenario({ groupDiesOnTerm: false, groupDiesOnKill: false });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 300, killConfirmMs: 400 });
    check('P3 an unconfirmable group is an explicit kill-confirm failure', r.ok === false && r.stage === 'kill-confirm', JSON.stringify(r));
    check('P3 both signals were sent to the owned group', state.termSignals === 1 && state.killSignals === 1, JSON.stringify(state));
  }
  {
    const { cleanup } = posixScenario({ groupAliveAtStart: false });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(ID), { termGraceMs: 100, killConfirmMs: 200 });
    check('P4 a verified-gone tree needs no signal at all', r.ok === true && /already gone/.test(String(r.how)), JSON.stringify(r));
  }
  {
    // Cross-check: the SAME loaded helper on posix identity still reports
    // a root that would not die as an explicit bare-root failure.
    const { cleanup } = posixScenario({ groupDiesOnTerm: false, groupDiesOnKill: false });
    const r = await cleanup.terminateTree(cleanup.ownTreeIdentity(0), { termGraceMs: 100, killConfirmMs: 200 });
    check('P5 posix failure keeps its stage label', r.ok === false && !!r.stage, JSON.stringify(r));
  }

  console.log('---');
  console.log(failed ? failed + ' check(s) FAILED (' + checks + ' total)' : 'all ' + checks + ' cleanup-branch checks passed');
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('SUITE ERROR: ' + (e && e.stack || e));
  process.exit(1);
});
