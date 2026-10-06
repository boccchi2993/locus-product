// M4a mainline preflight suite (review round C revision), driven entirely by
// FAKE GitHub API responses — no network access happens here. Pins:
//   - the evidence-refusing contract: missing/unknown/skipped evidence is
//     NEVER ready (the v1 implementation failed these — see
//     docs/M4A-REVIEW-C.md for the first-failure record);
//   - two-leg merge traceability (accepted->merge AND merge->current main);
//   - the shared aggregation: summary.verdict, text render, and exit code
//     all derive from the same statuses;
//   - config validation (empty/invalid config is rejected);
//   - the read-only transport contract (argv exactly ['api', path]).
//
// v1-pin corrections, made deliberately as defect fixes (not matrix removals):
//   - "ready-to-merge" now requires explicit job-level CI evidence; the v1
//     suite's GREEN_CI (run-level success only, no jobs) no longer yields
//     ready and was extended.
//   - "no CI run -> ready by policy" was an unauthorized invention in v1 and
//     is gone; the scenario now asserts insufficient-info.
//   - "already-in-main" was renamed landed-other-route (same scenario).
//   - "merged-traceable" now also requires the merge commit to be an
//     ancestor of CURRENT main (v1 only checked accepted->merge).
//   - "summarizeCi status 'none'" no longer exists as a ready path.
//
// Standalone on purpose: NOT registered in tests/run-unit.cjs (M4a-C file
// scope). Run directly:
//   node tests/m4a-mainline-preflight.test.cjs
const assert = require('assert');
const {
  DEFAULT_CONFIG,
  STATUS,
  FAMILIES,
  ConfigError,
  validateConfig,
  buildReport,
  aggregateVerdict,
  summarizeRuns,
  summarizeProtection,
  containedFromCompare,
  evaluateRequiredEvidence,
  evaluateProtectionRequirements,
  renderText,
  ghApiAdapter,
  exitCodeFor,
} = require('../scripts/m4a-mainline-preflight.cjs');

const ACCEPTED = 'a'.repeat(40);
const DRIFTED = 'b'.repeat(40);
const MAIN = 'c'.repeat(40);
const MERGE_COMMIT = 'd'.repeat(40);
const INPUT_HEAD = 'e'.repeat(40);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass++;
  } catch (err) {
    fail++;
    failures.push(`${name}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fake API: exact-path and regex routes; LATER entries win (tests patch a
// base scenario by re-setting a route).
// ---------------------------------------------------------------------------
function fakeApi(routes) {
  const calls = [];
  const fn = function api(path) {
    calls.push(path);
    const entries = Array.from(routes.entries()).reverse();
    for (const [match, res] of entries) {
      const hit = typeof match === 'string' ? path === match : match.test(path);
      if (hit) {
        if (typeof res === 'function') return res(path);
        return res;
      }
    }
    return { status: 404, body: null, error: `fake: no route for ${path}` };
  };
  fn.calls = calls;
  return fn;
}

function ok(body) { return { status: 200, body, error: null }; }
function repoMeta() {
  return ok({
    default_branch: 'main',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  });
}
function branchMain(protectedFlag) {
  return ok({ commit: { sha: MAIN }, protected: protectedFlag });
}
const NOT_PROTECTED = { status: 404, body: null, error: 'gh: Branch not protected (HTTP 404)' };
const FORBIDDEN = { status: 403, body: null, error: 'gh: Forbidden (HTTP 403)' };

const EVIDENCE_SPEC = { workflow: 'CI', jobs: ['unit', 'browser'] };
const ALL_JOBS_OK = [
  { name: 'unit', conclusion: 'success' },
  { name: 'browser', conclusion: 'success' },
];

function pull({ state = 'open', merged = false, headSha = ACCEPTED, mergeable = true,
  mergeableState, draft = false, baseRef = 'main' }) {
  return ok({
    state, merged,
    merge_commit_sha: merged ? MERGE_COMMIT : null,
    draft, title: 'fake PR',
    head: { ref: 'refactor/fake', sha: headSha },
    base: { ref: baseRef, sha: MAIN },
    mergeable,
    mergeable_state: mergeableState !== undefined ? mergeableState
      : (mergeable === true ? 'clean' : (mergeable === false ? 'dirty' : 'unknown')),
  });
}
function compare(status, aheadBy = 0, behindBy = 0, extra = {}) {
  return ok({
    status, ahead_by: aheadBy, behind_by: behindBy,
    total_commits: aheadBy + behindBy,
    commits: extra.commits || [],
    files: extra.files || [],
  });
}

// runs: [{id, conclusion, status?, runAttempt?, event?, headSha?}]
// jobsByRun: {runId: [{name, conclusion}]} — default ALL_JOBS_OK
function baseRoutes(over) {
  const o = Object.assign({
    state: 'open', merged: false, headSha: ACCEPTED, mergeable: true,
    mergeableState: undefined,
    acceptedVsMain: 'behind', // main does NOT contain accepted
    leg1: 'ahead', leg2: 'ahead',
    runs: [{ id: 100, event: 'push' }, { id: 101, event: 'pull_request' }],
    jobsByRun: {},
    protection: NOT_PROTECTED,
    branchProtected: false,
  }, over);
  const repo = 'boccchi2993/locus-fake';
  const R = new Map();
  R.set(`/repos/${repo}`, repoMeta());
  R.set(`/repos/${repo}/branches/main`, branchMain(o.branchProtected));
  R.set(`/repos/${repo}/branches/main/protection`, o.protection);
  R.set(`/repos/${repo}/pulls/1`, pull({
    state: o.state, merged: o.merged, headSha: o.headSha, mergeable: o.mergeable,
    mergeableState: o.mergeableState, draft: o.draft, baseRef: o.baseRef,
  }));
  // The script compares against the target branch's COMMIT SHA, not the word.
  R.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MAIN}$`),
    compare(o.acceptedVsMain, o.acceptedVsMain === 'ahead' ? 3 : 0, o.acceptedVsMain === 'behind' ? 2 : 0));
  R.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.main$`),
    compare(o.acceptedVsMain, o.acceptedVsMain === 'ahead' ? 3 : 0, o.acceptedVsMain === 'behind' ? 2 : 0));
  R.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${ACCEPTED}$`), compare('identical'));
  R.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MERGE_COMMIT}$`),
    compare(o.leg1, 0, 0));
  R.set(new RegExp(`/repos/${repo}/compare/${MERGE_COMMIT}\\.\\.\\.${MAIN}$`),
    compare(o.leg2, 3, 0));
  R.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${DRIFTED}$`), compare(
    'diverged', 2, 1,
    {
      commits: [{ sha: DRIFTED, commit: { message: 'late change\n\nbody' } }],
      files: [{ status: 'modified', filename: 'src/x.js' }, { status: 'added', filename: 'src/y.js' }],
    },
  ));
  R.set(new RegExp('/actions/runs\\?head_sha='), ok({
    total_count: o.runs.length,
    workflow_runs: o.runs.map((r) => ({
      id: r.id, name: 'CI', event: r.event || 'pull_request',
      status: r.status || 'completed',
      conclusion: r.conclusion !== undefined ? r.conclusion : 'success',
      run_attempt: r.runAttempt || 1,
      head_sha: r.headSha || o.headSha,
      created_at: r.createdAt || '2026-10-05T00:00:00Z',
      html_url: `https://github.com/x/actions/runs/${r.id}`,
    })),
  }));
  R.set(new RegExp('/actions/runs/(\\d+)/jobs'), function jobsRoute(path) {
    const id = Number(/\/actions\/runs\/(\d+)\/jobs/.exec(path)[1]);
    const jobs = o.jobsByRun[id] || ALL_JOBS_OK;
    return ok({ total_count: jobs.length, jobs });
  });
  return { repo, routes: R };
}

function configFor(repo) {
  return {
    targetBranch: 'main',
    candidates: [{ repo, pr: 1, acceptedSha: ACCEPTED }],
    ciEvidence: { [repo]: EVIDENCE_SPEC },
    carriedInputs: { repo, carriedBy: { pr: 1, head: ACCEPTED }, prs: [] },
  };
}
const classifyOf = (report) => report.candidates[0].status;
const unknownsOf = (report) => report.candidates[0].unknowns;

// ---------------------------------------------------------------------------
// A. The ready positive control: FULL explicit evidence.
// ---------------------------------------------------------------------------
check('ready positive control — complete explicit evidence', () => {
  const { repo, routes } = baseRoutes({});
  const report = buildReport(configFor(repo), fakeApi(routes), '2026-10-05T00:00:00Z');
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.READY);
  assert.strictEqual(c.prState.headMatchesAccepted, true);
  assert.strictEqual(c.prState.baseMatchesTarget, true);
  assert.strictEqual(c.evidence.state, 'satisfied');
  assert.strictEqual(c.acceptedInMain.state, 'not-contained');
  assert.strictEqual(report.summary.verdict, 'ready');
  assert.strictEqual(report.summary.exitCode, 0);
  assert.deepStrictEqual(report.summary.ready, [`${repo}#1: ready`]);
  assert.strictEqual(exitCodeFor(report), 0);
});

check('ready requires mergeable explicitly true — null is insufficient (bug 3)', () => {
  const { repo, routes } = baseRoutes({ mergeable: null, mergeableState: 'unknown' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(unknownsOf(report).some((u) => u.includes('mergeability unknown')));
});

check('closed without merge is explicitly not landable (bug 2)', () => {
  const { repo, routes } = baseRoutes({ state: 'closed' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CLOSED_UNMERGED);
  assert.strictEqual(report.candidates[0].family, 'blocked');
  assert.ok(report.candidates[0].reasons[0].includes('closed without being merged'));
});

check('draft can never be ready', () => {
  const { repo, routes } = baseRoutes({ draft: true });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.DRAFT);
  assert.strictEqual(report.candidates[0].family, 'blocked');
});

check('wrong PR base is refused (base-mismatch)', () => {
  const { repo, routes } = baseRoutes({ baseRef: 'release' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.BASE_MISMATCH);
  assert.ok(report.candidates[0].reasons[0].includes('configured landing target is "main"'));
});

check('head drift reported with diff scope; foreign-head CI does not gate', () => {
  const { repo, routes } = baseRoutes({ headSha: DRIFTED });
  routes.set(new RegExp('/actions/runs\\?head_sha='), ok({
    total_count: 2,
    workflow_runs: [
      { id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: ACCEPTED, created_at: '2026-10-05T00:00:00Z', html_url: 'u' },
      { id: 2, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: DRIFTED, created_at: '2026-10-05T01:00:00Z', html_url: 'u' },
    ],
  }));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.HEAD_DRIFTED);
  assert.strictEqual(c.drift.status, 'diverged');
  assert.strictEqual(c.drift.aheadBy, 2);
  assert.strictEqual(c.drift.behindBy, 1);
  assert.deepStrictEqual(c.drift.fileList, ['modified:src/x.js', 'added:src/y.js']);
  assert.strictEqual(c.drift.commits[0].message, 'late change');
  // The evidence fetch is head-scoped (it described the drifted head's own
  // runs), but drift outranks it: the candidate is not ready or ci-failed.
  assert.strictEqual(c.evidence.runs.runs[0].id, 2);
  assert.notStrictEqual(c.status, STATUS.READY);
  assert.notStrictEqual(c.status, STATUS.CI_FAILED);
});

check('mergeable false is conflict', () => {
  const { repo, routes } = baseRoutes({ mergeable: false, mergeableState: 'dirty' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CONFLICT);
  assert.strictEqual(report.summary.verdict, 'blocked');
  assert.strictEqual(report.summary.exitCode, 1);
});

// ---------------------------------------------------------------------------
// B. CI evidence gate.
// ---------------------------------------------------------------------------
check('no CI run for the head -> insufficient, never ready (bug 1)', () => {
  const { repo, routes } = baseRoutes({ runs: [] });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(report.candidates[0].evidence.detail.includes('no run on this head'));
});

check('CI runs unreadable -> insufficient', () => {
  const { repo, routes } = baseRoutes({});
  routes.set(new RegExp('/actions/runs\\?head_sha='), { status: 500, body: null, error: 'boom' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(unknownsOf(report).some((u) => u.includes('required CI evidence not provable')));
});

check('all required jobs skipped is NOT success evidence (bug 4)', () => {
  const { repo, routes } = baseRoutes({
    runs: [{ id: 7, conclusion: 'skipped' }],
    jobsByRun: { 7: [{ name: 'unit', conclusion: 'skipped' }, { name: 'browser', conclusion: 'skipped' }] },
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(report.candidates[0].evidence.detail.includes('did not execute (skipped/neutral)'));
});

check('required job missing from the run -> insufficient (workflow shape drift)', () => {
  const { repo, routes } = baseRoutes({
    jobsByRun: { 100: [{ name: 'unit', conclusion: 'success' }], 101: [{ name: 'unit', conclusion: 'success' }] },
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(report.candidates[0].evidence.detail.includes('missing job(s): browser'));
});

check('required job explicitly failed -> ci-failed, verdict blocked', () => {
  const { repo, routes } = baseRoutes({
    jobsByRun: { 100: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: 'failure' }],
      101: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: 'failure' }] },
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CI_FAILED);
  assert.ok(report.candidates[0].reasons[0].includes('browser=failure'));
  assert.strictEqual(report.summary.verdict, 'blocked');
  assert.strictEqual(report.summary.exitCode, 1);
});

check('a green sibling run cannot erase an executed required-job failure', () => {
  // The real runtime #1 shape: push run all green, PR run browser job failed,
  // never rerun. The failure stands until ITS run is superseded.
  const { repo, routes } = baseRoutes({
    runs: [{ id: 100, event: 'push' }, { id: 101, event: 'pull_request' }],
    jobsByRun: {
      100: ALL_JOBS_OK,
      101: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: 'failure' }],
    },
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CI_FAILED);
  assert.ok(report.candidates[0].reasons[0].includes('browser=failure'));
  assert.ok(report.candidates[0].reasons[0].includes('sibling run(s)'),
    'the satisfied sibling must stay visible next to the failure');
  assert.strictEqual(report.summary.verdict, 'blocked');
});

check('incomplete CI stays pending, never success', () => {
  const { repo, routes } = baseRoutes({
    runs: [{ id: 100, event: 'push', conclusion: 'success' },
      { id: 101, status: 'in_progress', conclusion: null }],
    jobsByRun: { 100: ALL_JOBS_OK },
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CI_PENDING);
  assert.strictEqual(report.candidates[0].family, 'pending');
  assert.strictEqual(report.summary.verdict, 'blocked');
});

check('green after a rerun is ready — with the rerun kept on the record', () => {
  const { repo, routes } = baseRoutes({
    runs: [{ id: 100, event: 'push', runAttempt: 1 },
      { id: 101, event: 'pull_request', runAttempt: 2 }],
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.READY);
  assert.strictEqual(report.candidates[0].evidence.runs.rerunDetected, true);
  assert.ok(report.candidates[0].reasons.some((r) => r.includes('rerun is on record')
    && r.includes('first-attempt')));
});

check('truncated run list -> insufficient (incomplete inventory)', () => {
  const { repo, routes } = baseRoutes({ runs: [{ id: 1 }, { id: 2 }] });
  routes.set(new RegExp('/actions/runs\\?head_sha='), ok({
    total_count: 5,
    workflow_runs: [
      { id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: ACCEPTED, created_at: '2026-10-05T00:00:00Z', html_url: 'u' },
      { id: 2, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: ACCEPTED, created_at: '2026-10-05T00:00:01Z', html_url: 'u' },
    ],
  }));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(report.candidates[0].evidence.detail.includes('truncated'));
});

// ---------------------------------------------------------------------------
// C. Protection.
// ---------------------------------------------------------------------------
check('protection unreadable (403) -> insufficient, not ready (bug 7)', () => {
  const { repo, routes } = baseRoutes({ protection: FORBIDDEN });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(unknownsOf(report).some((u) => u.includes('branch protection unreadable')));
});

check('protection 404 with unreadable branch stays unknown', () => {
  const prot = summarizeProtection({ status: 0, body: null, error: 'down' }, NOT_PROTECTED);
  assert.strictEqual(prot.state, 'unknown');
});

// R2 note: this scenario is now checks-ONLY. Round C's version also carried
// required_pull_request_reviews={count:1}; R2-F1 makes a reviews requirement
// unprovable (-> insufficient), so the checks-satisfied/unsatisfied/pending
// paths are pinned separately from the reviews path (see R2-F1 below).
check('protected + unsatisfied required checks -> blocked, satisfied -> ready', () => {
  const protectedRes = ok({
    required_status_checks: { strict: true, contexts: ['CI / unit'] },
  });
  const headSha = ACCEPTED;
  const checkRunsOk = ok({ total_count: 1, check_runs: [{ name: 'CI / unit', status: 'completed', conclusion: 'success' }] });
  const statusOk = ok({ state: 'success', total_count: 1, statuses: [{ context: 'CI / unit', state: 'success' }] });
  assert.strictEqual(
    evaluateProtectionRequirements(summarizeProtection(branchMain(true), protectedRes), checkRunsOk, statusOk).state,
    'satisfied');
  const missing = ok({ total_count: 0, check_runs: [] });
  const statusMissing = ok({ state: 'expected', total_count: 0, statuses: [] });
  assert.strictEqual(
    evaluateProtectionRequirements(summarizeProtection(branchMain(true), protectedRes), missing, statusMissing).state,
    'unsatisfied');
  const pendingCr = ok({ total_count: 1, check_runs: [{ name: 'CI / unit', status: 'in_progress', conclusion: null }] });
  assert.strictEqual(
    evaluateProtectionRequirements(summarizeProtection(branchMain(true), protectedRes), pendingCr, statusMissing).state,
    'pending');
  // End-to-end: satisfied rules + full evidence -> ready; unreadable -> insufficient.
  const { repo, routes } = baseRoutes({ protection: protectedRes, branchProtected: true });
  routes.set(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, checkRunsOk);
  routes.set(`/repos/${repo}/commits/${headSha}/status`, statusOk);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.READY);
  routes.set(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, { status: 403, body: null, error: 'forbidden' });
  const report2 = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report2), STATUS.INSUFFICIENT);
});

// ---------------------------------------------------------------------------
// D. Merge traceability — two independent legs.
// ---------------------------------------------------------------------------
check('merged with BOTH legs proven -> landed-traceable (bug 5 regression)', () => {
  const { repo, routes } = baseRoutes({ merged: true });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.LANDED_TRACEABLE);
  assert.strictEqual(c.mergeTrace.acceptedToMerge.state, 'contained');
  assert.strictEqual(c.mergeTrace.mergeToMain.state, 'contained');
  assert.strictEqual(report.summary.verdict, 'landed');
  assert.strictEqual(report.summary.exitCode, 0);
});

check('accepted->merge proven but merge NOT in current main -> merged-untraceable (bug 5)', () => {
  const { repo, routes } = baseRoutes({ merged: true, leg2: 'diverged', acceptedVsMain: 'diverged' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.MERGED_UNTRACEABLE);
  assert.ok(c.reasons[0].includes('NOT an ancestor of current main'));
  assert.strictEqual(c.mergeTrace.acceptedToMerge.state, 'contained');
  assert.strictEqual(c.mergeTrace.mergeToMain.state, 'not-contained');
  assert.strictEqual(report.summary.exitCode, 1);
});

check('merge leg unreadable -> insufficient, not silently untraceable', () => {
  const { repo, routes } = baseRoutes({ merged: true, acceptedVsMain: 'diverged' });
  routes.set(new RegExp(`/repos/${repo}/compare/${MERGE_COMMIT}`),
    { status: 0, body: null, error: 'transport down' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(unknownsOf(report).some((u) => u.includes('merge commit -> current main unreadable')));
});

check('accepted compare unreadable at all -> insufficient', () => {
  const { repo, routes } = baseRoutes({ merged: true });
  routes.set(new RegExp('/compare/'), { status: 0, body: null, error: 'transport down' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(unknownsOf(report).length >= 1);
});

check('accepted reached main by another route -> landed-other-route', () => {
  const { repo, routes } = baseRoutes({ acceptedVsMain: 'ahead' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.LANDED_OTHER_ROUTE);
  assert.strictEqual(c.family, 'landed');
  assert.strictEqual(report.summary.verdict, 'landed');
  assert.strictEqual(report.summary.exitCode, 0);
});

// ---------------------------------------------------------------------------
// E. Aggregation: verdict / summary / exit code from ONE source.
// ---------------------------------------------------------------------------
check('all landed: verdict landed + exit 0, consistent (bug 6)', () => {
  const { repo, routes } = baseRoutes({ merged: true });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(report.summary.landed.length, 1);
  assert.notStrictEqual(report.summary.verdict, 'blocked');
  assert.strictEqual(report.summary.verdict, 'landed');
  assert.strictEqual(exitCodeFor(report), 0);
});

check('ready + landed mix -> continue, exit 0', () => {
  const repo = 'boccchi2993/locus-fake';
  const cfg = configFor(repo);
  cfg.candidates.push({ repo, pr: 2, acceptedSha: MERGE_COMMIT });
  const { routes } = baseRoutes({});
  routes.set(`/repos/${repo}/pulls/2`, pull({ merged: true, headSha: MERGE_COMMIT }));
  routes.set(new RegExp(`/repos/${repo}/compare/${MERGE_COMMIT}\\.\\.\\.${MERGE_COMMIT}$`), compare('identical'));
  const report = buildReport(cfg, fakeApi(routes), null);
  assert.deepStrictEqual(report.candidates.map((c) => c.status), [STATUS.READY, STATUS.LANDED_TRACEABLE]);
  assert.strictEqual(report.summary.verdict, 'continue');
  assert.strictEqual(report.summary.exitCode, 0);
});

check('verdict precedence: unknown > blocked > landed/ready', () => {
  assert.deepStrictEqual(aggregateVerdict([STATUS.READY, STATUS.INSUFFICIENT]),
    { verdict: 'insufficient-info', exitCode: 2 });
  assert.deepStrictEqual(aggregateVerdict([STATUS.READY, STATUS.CI_FAILED]),
    { verdict: 'blocked', exitCode: 1 });
  assert.deepStrictEqual(aggregateVerdict([STATUS.LANDED_TRACEABLE, STATUS.CI_PENDING]),
    { verdict: 'blocked', exitCode: 1 });
  assert.deepStrictEqual(aggregateVerdict([STATUS.LANDED_TRACEABLE, STATUS.LANDED_OTHER_ROUTE]),
    { verdict: 'landed', exitCode: 0 });
});

check('unreadable PR -> insufficient, verdict and exit agree', () => {
  const { repo, routes } = baseRoutes({});
  routes.set(`/repos/${repo}/pulls/1`, { status: 404, body: null, error: 'no such PR' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.strictEqual(report.summary.verdict, 'insufficient-info');
  assert.strictEqual(report.summary.exitCode, 2);
  assert.strictEqual(exitCodeFor(report), 2);
  assert.deepStrictEqual(report.summary.undetermined, [`${repo}#1: insufficient-info`]);
});

// ---------------------------------------------------------------------------
// F. Configuration validation.
// ---------------------------------------------------------------------------
check('empty candidates rejected', () => {
  assert.throws(() => validateConfig({ candidates: [], ciEvidence: {} }), ConfigError);
  assert.throws(() => validateConfig({}), ConfigError);
  assert.throws(() => buildReport({ candidates: [] }, fakeApi(new Map())), ConfigError);
});

check('candidate shape and duplicate rejected', () => {
  const base = { ciEvidence: { 'o/r': EVIDENCE_SPEC } };
  assert.throws(() => validateConfig({ candidates: [{ repo: 'o/r', pr: 1, acceptedSha: 'xyz' }], ciEvidence: base.ciEvidence }), ConfigError);
  assert.throws(() => validateConfig({ candidates: [{ repo: 'o/r', pr: 0, acceptedSha: ACCEPTED }], ciEvidence: base.ciEvidence }), ConfigError);
  assert.throws(() => validateConfig({
    candidates: [{ repo: 'o/r', pr: 1, acceptedSha: ACCEPTED }, { repo: 'o/r', pr: 1, acceptedSha: DRIFTED }],
    ciEvidence: { 'o/r': EVIDENCE_SPEC },
  }), ConfigError);
});

check('missing ciEvidence entry for a candidate rejected — evidence is explicit', () => {
  assert.throws(() => validateConfig({ candidates: [{ repo: 'o/r', pr: 1, acceptedSha: ACCEPTED }] }), ConfigError);
  assert.throws(() => validateConfig({
    candidates: [{ repo: 'o/r', pr: 1, acceptedSha: ACCEPTED }],
    ciEvidence: { 'o/r': { workflow: 'CI' } },
  }), ConfigError);
  assert.throws(() => validateConfig({
    candidates: [{ repo: 'o/r', pr: 1, acceptedSha: ACCEPTED }],
    ciEvidence: { 'o/r': { workflow: 'CI', jobs: [] } },
  }), ConfigError);
});

check('invalid carriedInputs rejected', () => {
  assert.throws(() => validateConfig({
    candidates: [{ repo: 'o/r', pr: 1, acceptedSha: ACCEPTED }],
    ciEvidence: { 'o/r': EVIDENCE_SPEC },
    carriedInputs: { repo: 'o/r', carriedBy: { pr: 1, head: 'nope' }, prs: [1] },
  }), ConfigError);
});

// ---------------------------------------------------------------------------
// G. Unit helpers preserved.
// ---------------------------------------------------------------------------
check('contained-from-compare directions (the ahead/behind trap)', () => {
  const mk = (status) => ({ status: 200, body: { status }, error: null });
  assert.strictEqual(containedFromCompare(mk('ahead')), 'contained');
  assert.strictEqual(containedFromCompare(mk('identical')), 'contained');
  assert.strictEqual(containedFromCompare(mk('behind')), 'not-contained');
  assert.strictEqual(containedFromCompare(mk('diverged')), 'not-contained');
  assert.strictEqual(containedFromCompare(null), 'unknown');
  assert.strictEqual(containedFromCompare({ status: 404, body: null }), 'unknown');
});

check('summarizeRuns filters foreign heads; empty stays visible', () => {
  const only = summarizeRuns({
    total_count: 1,
    workflow_runs: [{ id: 9, name: 'CI', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: ACCEPTED, created_at: 't', html_url: 'u' }],
  }, DRIFTED);
  assert.strictEqual(only.runs.length, 0);
  const mixed = summarizeRuns({
    total_count: 2,
    workflow_runs: [
      { id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 1, head_sha: ACCEPTED, created_at: 't', html_url: 'u' },
      { id: 2, name: 'CI', event: 'push', status: 'completed', conclusion: 'failure', run_attempt: 1, head_sha: DRIFTED, created_at: 't', html_url: 'u' },
    ],
  }, ACCEPTED);
  assert.strictEqual(mixed.runs.length, 1);
  assert.strictEqual(mixed.failed.length, 0);
});

check('evaluateRequiredEvidence: no run of the required workflow -> unknown-evidence', () => {
  const runs = [{ id: 1, name: 'Other', status: 'completed', conclusion: 'success', createdAt: 't' }];
  const res = evaluateRequiredEvidence(EVIDENCE_SPEC, runs, new Map());
  assert.strictEqual(res.state, 'unknown-evidence');
  assert.ok(res.detail.includes('has no run on this head'));
});

// ---------------------------------------------------------------------------
// H. Renderer + shipped config.
// ---------------------------------------------------------------------------
check('render text carries marks, unknowns, verdict and exit code', () => {
  const { repo, routes } = baseRoutes({ runs: [] });
  const report = buildReport(configFor(repo), fakeApi(routes), '2026-10-05T01:02:03Z');
  const text = renderText(report);
  assert.ok(text.includes('UNKNOWN (insufficient evidence — refused, not passed)'));
  assert.ok(text.includes('? unknown:'));
  assert.ok(text.includes('verdict: insufficient-info (exit 2)'));
  assert.ok(text.includes('evidence policy'));
  assert.ok(text.includes('(read-only, live GitHub state)'));
});

check('shipped default config: accepted set unchanged, evidence explicit', () => {
  assert.strictEqual(DEFAULT_CONFIG.targetBranch, 'main');
  assert.strictEqual(DEFAULT_CONFIG.candidates.length, 3);
  const [rt, hn, pd] = DEFAULT_CONFIG.candidates;
  assert.deepStrictEqual(
    [rt.repo, rt.pr, rt.acceptedSha],
    ['boccchi2993/locus-runtime', 1, '2435a57ff7a66db3db88aa98a88d404c75133483']);
  assert.deepStrictEqual(
    [hn.repo, hn.pr, hn.acceptedSha],
    ['boccchi2993/locus-harness', 1, '347eed99a415dc080b97d46d8a4271ceb19c5142']);
  assert.deepStrictEqual(
    [pd.repo, pd.pr, pd.acceptedSha],
    ['boccchi2993/locus-product', 5, 'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b']);
  // The evidence requirements mirror the repos' REAL ci.yml jobs (as of the
  // accepted heads) — an unexplainable workflow must fail, not pass.
  assert.deepStrictEqual(DEFAULT_CONFIG.ciEvidence['boccchi2993/locus-runtime'].jobs, [
    'build + package checks',
    'unit tests (Node)',
    'browser gates (headless Chrome)',
    'out-of-repo tarball consumer (headless Chrome)',
  ]);
  assert.deepStrictEqual(DEFAULT_CONFIG.ciEvidence['boccchi2993/locus-harness'].jobs, [
    'build + package checks',
    'unit tests (Node)',
    'harness host browser gate (headless Chrome)',
    'out-of-checkout tarball consumer (headless Chrome)',
  ]);
  assert.deepStrictEqual(DEFAULT_CONFIG.ciEvidence['boccchi2993/locus-product'].jobs, [
    'unit tests (Node, clean checkout)',
    'browser gates (packaged build, headless Chrome)',
  ]);
  assert.deepStrictEqual(DEFAULT_CONFIG.carriedInputs.prs, [1, 2, 3, 4]);
  assert.strictEqual(DEFAULT_CONFIG.carriedInputs.carriedBy.head,
    'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b');
  validateConfig(DEFAULT_CONFIG); // must not throw
});

// ---------------------------------------------------------------------------
// I. Read-only transport contract.
// ---------------------------------------------------------------------------
check('gh adapter argv is exactly ["api", path] — GET by construction', () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const api = ghApiAdapter(fakeSpawn);
  api('/repos/boccchi2993/locus-fake/pulls/1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'gh');
  assert.strictEqual(calls[0].args.length, 2);
  assert.strictEqual(calls[0].args[0], 'api');
  assert.strictEqual(calls[0].args[1], '/repos/boccchi2993/locus-fake/pulls/1');
  for (const a of calls[0].args) {
    assert.ok(!String(a).startsWith('-'), `transport must not pass flags, saw ${a}`);
  }
});

check('every requested endpoint is in the read allowlist (merged + open, paged runs/jobs)', () => {
  const allow = new RegExp('^/repos/[^/]+/[^/]+(/('
    + 'pulls/\\d+'
    + '|branches/[^/]+(/protection)?'
    + '|compare/[0-9a-f]{40}\\.\\.\\.(main|[0-9a-f]{40})'
    + '|actions/runs\\?head_sha=[0-9a-f]{40}(&per_page=\\d+)(&page=\\d+)?'
    + '|actions/runs/\\d+/jobs(\\?per_page=\\d+)(&page=\\d+)?'
    + '|commits/[0-9a-f]{40}/check-runs(\\?per_page=\\d+)?'
    + '|commits/[0-9a-f]{40}/status'
    + '))?$');
  // merged scenario (no evidence fetches) and open scenario (paged runs/jobs)
  for (const scenario of [{ merged: true, protection: FORBIDDEN }, {}]) {
    const { repo, routes } = baseRoutes(scenario);
    const recorder = fakeApi(routes);
    buildReport(configFor(repo), recorder, null);
    assert.ok(recorder.calls.length >= 6, `expected several reads, got ${recorder.calls.length}`);
    for (const p of recorder.calls) {
      assert.match(p, allow, `non-read endpoint requested: ${p}`);
    }
    for (const p of recorder.calls) {
      assert.ok(!/method=|-X|merge|issues\/\d+\/comments|git\/refs/.test(p),
        `mutation-shaped endpoint requested: ${p}`);
    }
  }
});

// ---------------------------------------------------------------------------
// R2 (review round 2, 2026-10-06): the four unearned-ready defects.
//   R2-F1  mergeable=true must not override mergeable_state="blocked";
//          a required-reviews rule cannot be proven satisfied;
//          unexplained mergeable_state is never ready.
//   R2-F2  an unresolved necessary-evidence unknown (accepted->main compare
//          unreadable) must forbid every success verdict.
//   R2-F3  required jobs succeed only on explicit conclusion === 'success'.
//   R2-F4  the full run inventory replaces the latest-4 window; incomplete
//          inventory is insufficient unless an explicit failure was seen.
// Every negative here was reproduced against the PRE-FIX implementation
// (buildReport on the real chain, fake API only); the first-failure record
// lives in docs/M4A-REVIEW-R2.md.
// ---------------------------------------------------------------------------
const R2_JOB_ERROR = { status: 500, body: null, error: 'fake: jobs boom' };

function r2RunRow(id, over) {
  const o = Object.assign({ conclusion: 'success', status: 'completed', runAttempt: 1 }, over);
  return {
    id, name: 'CI', event: 'pull_request', status: o.status, conclusion: o.conclusion,
    run_attempt: o.runAttempt, head_sha: ACCEPTED,
    created_at: o.createdAt
      || `2026-10-05T00:${String(id % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}Z`,
    html_url: `https://github.com/x/actions/runs/${id}`,
  };
}

// A runs route with server-side pagination; pages[0] is page 1. Requests
// WITHOUT a page param (the pre-R2 fetch shape) are answered with page 1.
function r2PagedRunsRoute(pages, totalCount) {
  return function (path) {
    const m = /[?&]page=(\d+)/.exec(path);
    const rows = pages[(m ? Number(m[1]) : 1) - 1];
    if (!rows) return { status: 500, body: null, error: 'fake: no such runs page' };
    return ok({ total_count: totalCount, workflow_runs: rows });
  };
}

function r2SetPagedJobs(routes, runId, pages, totalCount) {
  routes.set(new RegExp(`/actions/runs/${runId}/jobs`), function (path) {
    const m = /[?&]page=(\d+)/.exec(path);
    const rows = pages[(m ? Number(m[1]) : 1) - 1];
    if (!rows) return { status: 500, body: null, error: 'fake: no such jobs page' };
    return ok({ total_count: totalCount, jobs: rows });
  });
}

// --- R2-F1: merge state + required reviews ----------------------------------
check('R2-F1: mergeable=true + mergeable_state=blocked is NOT ready even with all CI green', () => {
  const { repo, routes } = baseRoutes({ mergeableState: 'blocked' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, 'merge-blocked');
  assert.strictEqual(c.family, 'blocked');
  assert.strictEqual(report.summary.verdict, 'blocked');
  assert.strictEqual(report.summary.exitCode, 1);
  assert.strictEqual(exitCodeFor(report), 1);
  assert.ok(c.reasons[0].includes('blocked'));
});

check('R2-F1: required approving reviews cannot be proven satisfied -> insufficient-info', () => {
  const reviewsRes = ok({
    required_status_checks: { strict: true, contexts: ['CI / unit'] },
    required_pull_request_reviews: { required_approving_review_count: 1 },
  });
  const crOk = ok({ total_count: 1, check_runs: [{ name: 'CI / unit', status: 'completed', conclusion: 'success' }] });
  const stOk = ok({ state: 'success', total_count: 1, statuses: [{ context: 'CI / unit', state: 'success' }] });
  // unit level: even fully green required checks leave the reviews rule unproven
  const evald = evaluateProtectionRequirements(summarizeProtection(branchMain(true), reviewsRes), crOk, stOk);
  assert.strictEqual(evald.state, 'unknown');
  assert.ok(evald.detail.includes('1 approving review'));
  // end to end: green checks + green CI + reviews rule still refuses ready
  const { repo, routes } = baseRoutes({ protection: reviewsRes, branchProtected: true });
  routes.set(`/repos/${repo}/commits/${ACCEPTED}/check-runs?per_page=100`, crOk);
  routes.set(`/repos/${repo}/commits/${ACCEPTED}/status`, stOk);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(unknownsOf(report).some((u) => u.includes('approving review')));
  assert.strictEqual(report.summary.exitCode, 2);
});

check('R2-F1: protected with required CHECKS only — satisfied checks still allow ready (no over-blocking)', () => {
  const checksOnly = ok({ required_status_checks: { strict: true, contexts: ['CI / unit'] } });
  const crOk = ok({ total_count: 1, check_runs: [{ name: 'CI / unit', status: 'completed', conclusion: 'success' }] });
  const stOk = ok({ state: 'success', total_count: 1, statuses: [{ context: 'CI / unit', state: 'success' }] });
  assert.strictEqual(
    evaluateProtectionRequirements(summarizeProtection(branchMain(true), checksOnly), crOk, stOk).state,
    'satisfied');
  const { repo, routes } = baseRoutes({ protection: checksOnly, branchProtected: true });
  routes.set(`/repos/${repo}/commits/${ACCEPTED}/check-runs?per_page=100`, crOk);
  routes.set(`/repos/${repo}/commits/${ACCEPTED}/status`, stOk);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.READY);
  assert.strictEqual(report.summary.exitCode, 0);
});

check('R2-F1: unexplained mergeable_state (has_hooks / unknown) is never ready', () => {
  for (const st of ['has_hooks', 'unknown']) {
    const { repo, routes } = baseRoutes({ mergeableState: st });
    const report = buildReport(configFor(repo), fakeApi(routes), null);
    assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT, `mergeable_state=${st}`);
    assert.strictEqual(report.summary.exitCode, 2, `mergeable_state=${st}`);
  }
});

// --- R2-F2: necessary unknowns forbid success -------------------------------
check('R2-F2: accepted->main compare unreadable (403/404/transport) -> insufficient, never ready', () => {
  const cases = [
    ['403', FORBIDDEN],
    ['404', { status: 404, body: null, error: 'gh: Not Found (HTTP 404)' }],
    ['transport', { status: 0, body: null, error: 'curl 56 Recv failure' }],
  ];
  for (const [label, res] of cases) {
    const { repo, routes } = baseRoutes({});
    routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MAIN}$`), res);
    const report = buildReport(configFor(repo), fakeApi(routes), null);
    const c = report.candidates[0];
    assert.strictEqual(c.status, STATUS.INSUFFICIENT, `compare ${label}`);
    assert.ok(c.unknowns.some((u) => u.includes('containment unreadable')), label);
    assert.strictEqual(report.summary.verdict, 'insufficient-info', label);
    assert.strictEqual(report.summary.exitCode, 2, label);
    assert.strictEqual(exitCodeFor(report), 2, label);
    const text = renderText(report);
    assert.ok(text.includes('verdict: insufficient-info (exit 2)'), label);
    assert.ok(!/READY/.test(text), `text must not claim READY (${label})`);
  }
});

check('R2-F2 positive: two-leg landed proof stands even when accepted->main compare is unreadable', () => {
  const { repo, routes } = baseRoutes({ merged: true });
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MAIN}$`), FORBIDDEN);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.LANDED_TRACEABLE);
  assert.strictEqual(report.summary.exitCode, 0);
});

// --- R2-F3: required jobs succeed only on explicit success -------------------
const R2_JOB_CONCLUSIONS = [
  ['success', STATUS.READY, 'ready', 0],
  ['failure', STATUS.CI_FAILED, 'blocked', 1],
  ['timed_out', STATUS.CI_FAILED, 'blocked', 1],
  ['cancelled', STATUS.CI_FAILED, 'blocked', 1],
  ['action_required', STATUS.CI_FAILED, 'blocked', 1],
  ['skipped', STATUS.INSUFFICIENT, 'insufficient-info', 2],
  ['neutral', STATUS.INSUFFICIENT, 'insufficient-info', 2],
  [null, STATUS.INSUFFICIENT, 'insufficient-info', 2],
  [undefined, STATUS.INSUFFICIENT, 'insufficient-info', 2],
  ['stale', STATUS.INSUFFICIENT, 'insufficient-info', 2],
  ['startup_failure', STATUS.INSUFFICIENT, 'insufficient-info', 2],
];
for (const [conc, wantStatus, wantVerdict, wantExit] of R2_JOB_CONCLUSIONS) {
  check(`R2-F3: required job conclusion ${conc === undefined ? 'undefined' : JSON.stringify(conc)} -> ${wantStatus}`, () => {
    const { repo, routes } = baseRoutes({
      runs: [{ id: 7, event: 'push' }],
      jobsByRun: { 7: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: conc }] },
    });
    const report = buildReport(configFor(repo), fakeApi(routes), null);
    const c = report.candidates[0];
    assert.strictEqual(c.status, wantStatus, `conclusion ${String(conc)}`);
    assert.strictEqual(report.summary.verdict, wantVerdict, `conclusion ${String(conc)}`);
    assert.strictEqual(report.summary.exitCode, wantExit, `conclusion ${String(conc)}`);
    if (conc !== 'success') {
      assert.ok(!/READY/.test(renderText(report)), `text must not claim READY (${String(conc)})`);
    }
    if (conc === 'stale') {
      // raw value, run id and job name must all be visible in the report
      assert.ok(c.evidence.detail.includes('stale'), c.evidence.detail);
      assert.ok(JSON.stringify(c.evidence).includes('"runId":7'));
      assert.ok(c.evidence.detail.includes('browser'));
    }
  });
}

check('R2-F3 unit table: evaluateRequiredEvidence states per conclusion', () => {
  const want = [
    ['success', 'satisfied'],
    ['failure', 'failed'], ['timed_out', 'failed'], ['cancelled', 'failed'],
    ['action_required', 'failed'],
    ['skipped', 'not-executed'], ['neutral', 'not-executed'],
    [null, 'unknown-evidence'], [undefined, 'unknown-evidence'],
    ['stale', 'unknown-evidence'], ['startup_failure', 'unknown-evidence'],
  ];
  for (const [conc, expected] of want) {
    const jobs = new Map([[7, {
      ok: true, error: null, truncated: false,
      jobs: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: conc }],
    }]]);
    const runs = [{ id: 7, name: 'CI', status: 'completed', conclusion: 'success', createdAt: 't' }];
    const res = evaluateRequiredEvidence(EVIDENCE_SPEC, runs, jobs);
    assert.strictEqual(res.state, expected, `conclusion ${String(conc)}`);
  }
});

// --- R2-F4: the full run inventory, no latest-N window ----------------------
check('R2-F4: five runs, oldest failed, newer four green -> failure not forgotten (blocked)', () => {
  const runs = [1, 2, 3, 4, 5].map((id) => r2RunRow(id));
  const jobsByRun = { 1: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: 'failure' }] };
  const { repo, routes } = baseRoutes({ runs, jobsByRun });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.CI_FAILED);
  assert.strictEqual(report.summary.verdict, 'blocked');
  assert.strictEqual(report.summary.exitCode, 1);
  assert.ok(c.reasons[0].includes('browser=failure'));
  const evaluated = c.evidence.perRun.map((p) => p.runId);
  assert.ok(evaluated.includes(1), 'the failed run must be among the evaluated runs');
  assert.strictEqual(evaluated.length, 5, 'every run of the required workflow was evaluated');
});

check('R2-F4 positive: five runs all green with a complete inventory -> ready', () => {
  const runs = [1, 2, 3, 4, 5].map((id) => r2RunRow(id));
  const { repo, routes } = baseRoutes({ runs });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.status, STATUS.READY);
  assert.deepStrictEqual([...c.evidence.evaluatedRunIds].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.strictEqual(c.evidence.runs.inventory.complete, true);
});

check('R2-F4: failure on page 2 of a multi-page run list is not dropped', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => r2RunRow(200 + i)); // 100 green (newer)
  const page2 = [r2RunRow(10, { createdAt: '2026-09-01T00:00:00Z' })]; // oldest run failed
  const jobsByRun = { 10: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: 'failure' }] };
  const { repo, routes } = baseRoutes({ jobsByRun });
  routes.set(new RegExp('/actions/runs\\?head_sha='), r2PagedRunsRoute([page1, page2], 101));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CI_FAILED);
  assert.ok(report.candidates[0].reasons[0].includes('browser=failure'));
  assert.strictEqual(report.summary.verdict, 'blocked');
});

check('R2-F4: pagination failure -> not ready, the failed page is named', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => r2RunRow(300 + i));
  const { repo, routes } = baseRoutes({});
  routes.set(new RegExp('/actions/runs\\?head_sha='), function (path) {
    if (/[?&]page=2/.test(path)) return { status: 0, body: null, error: 'curl 56 Recv failure' };
    return ok({ total_count: 101, workflow_runs: page1 });
  });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  const blob = JSON.stringify(report.candidates[0].evidence);
  assert.ok(blob.includes('page 2'), blob);
});

check('R2-F4: run-list budget exhausted -> insufficient with the budget named', () => {
  const pages = Array.from({ length: 5 }, (_, p) => Array.from({ length: 100 }, (_, i) => r2RunRow(1000 + p * 100 + i)));
  const { repo, routes } = baseRoutes({});
  routes.set(new RegExp('/actions/runs\\?head_sha='), r2PagedRunsRoute(pages, 1000));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  const blob = JSON.stringify(report.candidates[0].evidence);
  assert.ok(blob.includes('budget'), blob);
});

check('R2-F4: explicit failure + incomplete inventory -> blocked (failure wins), never ready/insufficient', () => {
  const pages = Array.from({ length: 5 }, (_, p) => Array.from({ length: 100 }, (_, i) => r2RunRow(2000 + p * 100 + i)));
  pages[1][7] = r2RunRow(2107, { conclusion: 'failure' });
  const jobsByRun = { 2107: [{ name: 'unit', conclusion: 'success' }, { name: 'browser', conclusion: 'failure' }] };
  const { repo, routes } = baseRoutes({ jobsByRun });
  routes.set(new RegExp('/actions/runs\\?head_sha='), r2PagedRunsRoute(pages, 700));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CI_FAILED);
  assert.strictEqual(report.summary.verdict, 'blocked');
  assert.ok(report.candidates[0].reasons[0].includes('browser=failure'));
  const blob = JSON.stringify(report.candidates[0].evidence);
  assert.ok(blob.includes('incomplete'), 'the incomplete inventory must stay visible');
});

check('R2-F4: a required run whose jobs are unreadable among green siblings -> not ready', () => {
  const runs = [1, 2, 3, 4, 5, 6].map((id) => r2RunRow(id));
  const { repo, routes } = baseRoutes({ runs });
  routes.set(new RegExp('/actions/runs/1/jobs'), function () { return R2_JOB_ERROR; });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  assert.ok(JSON.stringify(report.candidates[0].evidence).includes('run 1'));
});

check('R2-F4 positive: jobs pagination — required job on page 2 is still judged', () => {
  const { repo, routes } = baseRoutes({ runs: [r2RunRow(9)] });
  const aux = Array.from({ length: 100 }, (_, i) => ({ name: `aux ${i}`, conclusion: 'success' }));
  r2SetPagedJobs(routes, 9, [aux, ALL_JOBS_OK], 102);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.READY);
});

// ---------------------------------------------------------------------------
// M4b (2026-10-06): the full-page jobs false rejection. fetchJobsForRun
// already broke out of its loop on "provably complete" (jobs.length >=
// total_count) but then classified the result by `lastPageRows >= 100`
// alone — so a run with EXACTLY 100 (or 200) jobs, fully fetched against a
// trusted total_count, was mislabeled truncated ("ended on a full page
// without a usable total_count") and could never be judged. Every control
// below goes through the real buildReport on the full fake-API chain. The
// first failures (the two full-page positives and the failed-job positive)
// were reproduced against the unmodified PR #9 head 2a01ba8; the two
// negative pins here passed before the fix and must keep passing after it.
// ---------------------------------------------------------------------------
check('M4b: exactly one full page (total_count=100, all fetched) is complete -> ready', () => {
  const page1 = [
    ...Array.from({ length: 98 }, (_, i) => ({ name: `aux ${i}`, conclusion: 'success' })),
    { name: 'unit', conclusion: 'success' },
    { name: 'browser', conclusion: 'success' },
  ];
  const { repo, routes } = baseRoutes({ runs: [r2RunRow(9)] });
  r2SetPagedJobs(routes, 9, [page1], 100);
  const api = fakeApi(routes);
  const report = buildReport(configFor(repo), api, null);
  assert.strictEqual(classifyOf(report), STATUS.READY);
  const c = report.candidates[0];
  assert.strictEqual(c.evidence.state, 'satisfied');
  assert.ok(!JSON.stringify(c.evidence).includes('not fully readable'));
  // provably complete must not keep paging past the proven end
  const jobPages = api.calls.filter((p) => p.includes('/actions/runs/9/jobs'));
  assert.deepStrictEqual(jobPages, [`/repos/${repo}/actions/runs/9/jobs?per_page=100&page=1`]);
});

check('M4b: exactly two full pages (total_count=200, all fetched) are complete -> ready', () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `aux ${i}`, conclusion: 'success' }));
  const page2 = [
    ...Array.from({ length: 98 }, (_, i) => ({ name: `aux2 ${i}`, conclusion: 'success' })),
    { name: 'unit', conclusion: 'success' },
    { name: 'browser', conclusion: 'success' },
  ];
  const { repo, routes } = baseRoutes({ runs: [r2RunRow(9)] });
  r2SetPagedJobs(routes, 9, [page1, page2], 200);
  const api = fakeApi(routes);
  const report = buildReport(configFor(repo), api, null);
  assert.strictEqual(classifyOf(report), STATUS.READY);
  const pages = api.calls
    .filter((p) => p.includes('/actions/runs/9/jobs'))
    .map((p) => /[?&]page=(\d+)/.exec(p)[1]);
  assert.deepStrictEqual(pages, ['1', '2'], 'both full pages were genuinely fetched');
  assert.ok(!JSON.stringify(report.candidates[0].evidence).includes('not fully readable'));
});

check('M4b: full pages, total_count beyond the fetch budget -> insufficient (budget named)', () => {
  const pages = Array.from({ length: 5 }, (_, p) => Array.from({ length: 100 }, (_, i) => ({
    name: p === 4 && i === 0 ? 'unit' : p === 4 && i === 1 ? 'browser' : `aux ${p}-${i}`,
    conclusion: 'success',
  })));
  const { repo, routes } = baseRoutes({ runs: [r2RunRow(9)] });
  r2SetPagedJobs(routes, 9, pages, 600);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  const blob = JSON.stringify(report.candidates[0].evidence);
  assert.ok(blob.includes('budget exhausted'), blob);
  assert.ok(blob.includes('total_count=600'), blob);
  assert.ok(blob.includes('500 job(s)'), 'the fetched count stays visible');
});

check('M4b: full pages with no usable total_count, budget exhausted -> insufficient', () => {
  const pages = Array.from({ length: 5 }, () => Array.from({ length: 100 }, (_, i) => ({ name: `aux ${i}`, conclusion: 'success' })));
  const { repo, routes } = baseRoutes({ runs: [r2RunRow(9)] });
  r2SetPagedJobs(routes, 9, pages, null);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.INSUFFICIENT);
  const blob = JSON.stringify(report.candidates[0].evidence);
  assert.ok(blob.includes('without a usable total_count'), blob);
});

check('M4b: complete 100-job list with a required job failed -> blocked (judged, not refused)', () => {
  const page1 = [
    ...Array.from({ length: 98 }, (_, i) => ({ name: `aux ${i}`, conclusion: 'success' })),
    { name: 'unit', conclusion: 'success' },
    { name: 'browser', conclusion: 'failure' },
  ];
  const { repo, routes } = baseRoutes({ runs: [r2RunRow(9)] });
  r2SetPagedJobs(routes, 9, [page1], 100);
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(classifyOf(report), STATUS.CI_FAILED);
  assert.ok(report.candidates[0].reasons[0].includes('browser=failure'));
  assert.strictEqual(report.summary.verdict, 'blocked');
  assert.strictEqual(report.summary.exitCode, 1);
});

// ---------------------------------------------------------------------------
console.log(`m4a-mainline-preflight.test.cjs: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exitCode = 1;
}
