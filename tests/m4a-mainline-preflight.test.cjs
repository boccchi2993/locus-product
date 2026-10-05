// M4a-C preflight classification matrix, driven entirely by FAKE GitHub API
// responses — no network access happens in this suite. Also pins the
// read-only contract: the gh transport's argv is exactly ['api', path].
//
// Standalone on purpose: this suite is NOT registered in tests/run-unit.cjs
// (the M4a-C file scope forbids touching that file). Run it directly:
//   node tests/m4a-mainline-preflight.test.cjs
const assert = require('assert');
const {
  DEFAULT_CONFIG,
  CLASSIFICATIONS,
  buildReport,
  summarizeCi,
  summarizeProtection,
  containedFromCompare,
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
// Fake API: exact-path and prefix routes, plus a call recorder.
// ---------------------------------------------------------------------------
function fakeApi(routes) {
  const calls = [];
  const fn = function api(path) {
    calls.push(path);
    // Later entries win: tests patch a base scenario by re-setting a route.
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

function repoMeta() {
  return {
    status: 200,
    body: {
      default_branch: 'main',
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    },
    error: null,
  };
}
function branchMain(protectedFlag) {
  return { status: 200, body: { commit: { sha: MAIN }, protected: protectedFlag }, error: null };
}
const NOT_PROTECTED = { status: 404, body: null, error: 'gh: Branch not protected (HTTP 404)' };
const FORBIDDEN = { status: 403, body: null, error: 'gh: Permission denied (HTTP 403)' };

function pull({ headSha, merged = false, mergeable = true, mergeableState = 'clean', draft = false }) {
  return {
    status: 200,
    body: {
      state: merged ? 'closed' : 'open',
      merged,
      merge_commit_sha: merged ? MERGE_COMMIT : null,
      draft,
      title: 'fake PR',
      head: { ref: 'refactor/fake', sha: headSha },
      base: { ref: 'main', sha: MAIN },
      mergeable,
      mergeable_state: mergeableState,
    },
    error: null,
  };
}
function compare(status, aheadBy = 0, behindBy = 0, extra = {}) {
  return {
    status: 200,
    body: {
      status, ahead_by: aheadBy, behind_by: behindBy,
      total_commits: aheadBy + behindBy,
      commits: extra.commits || [],
      files: extra.files || [],
    },
    error: null,
  };
}
function ciRuns(list) {
  return { status: 200, body: { workflow_runs: list }, error: null };
}
function run({ id, name = 'CI', event = 'push', status = 'completed', conclusion = 'success', attempt = 1 }) {
  return {
    id, name, event, status, conclusion, run_attempt: attempt,
    head_sha: DRIFTED, // runFor() overrides this with the head under test
    created_at: '2026-10-05T00:00:00Z',
    html_url: `https://github.com/x/actions/runs/${id}`,
  };
}
function runFor(sha, opts) {
  const r = run(opts || {});
  r.head_sha = sha;
  return r;
}

const GREEN_CI = [
  runFor(ACCEPTED, { id: 100, event: 'push', conclusion: 'success' }),
  runFor(ACCEPTED, { id: 101, event: 'pull_request', conclusion: 'success' }),
];

function baseRoutes(opts) {
  const o = Object.assign({
    headSha: ACCEPTED,
    merged: false,
    mergeable: true,
    mergeableState: 'clean',
    acceptedVsMain: 'behind', // main does NOT contain accepted
    ci: GREEN_CI,
    protection: NOT_PROTECTED,
  }, opts);
  const repo = 'boccchi2993/locus-fake';
  const routes = new Map();
  routes.set(`/repos/${repo}`, repoMeta());
  routes.set(`/repos/${repo}/branches/main`, branchMain(false));
  routes.set(`/repos/${repo}/branches/main/protection`, o.protection);
  routes.set(`/repos/${repo}/pulls/1`, pull({
    headSha: o.headSha, merged: o.merged, mergeable: o.mergeable, mergeableState: o.mergeableState,
  }));
  // The script compares against the main branch's COMMIT SHA, not the word.
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MAIN}$`),
    compare(o.acceptedVsMain, o.acceptedVsMain === 'ahead' ? 3 : 0, o.acceptedVsMain === 'behind' ? 2 : 0));
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${ACCEPTED}$`),
    compare('identical'));
  routes.set(new RegExp(`/repos/${repo}/actions/runs\\?head_sha=`), ciRuns(o.ci));
  return { repo, routes };
}

function configFor(repo) {
  return {
    candidates: [{ repo, pr: 1, acceptedSha: ACCEPTED }],
    carriedInputs: { repo, carriedBy: { pr: 1, head: ACCEPTED }, prs: [] },
  };
}

// ---------------------------------------------------------------------------
// 1. ready-to-merge: open + head == accepted + green CI + no conflict.
// ---------------------------------------------------------------------------
check('ready-to-merge', () => {
  const { repo, routes } = baseRoutes({});
  const report = buildReport(configFor(repo), fakeApi(routes), '2026-10-05T00:00:00Z');
  const c = report.candidates[0];
  assert.strictEqual(c.classification, CLASSIFICATIONS.READY);
  assert.strictEqual(c.prState.headMatchesAccepted, true);
  assert.strictEqual(c.acceptedInMain.state, 'not-contained');
  assert.strictEqual(c.ci.status, 'success');
  assert.strictEqual(c.ci.rerunDetected, false);
  assert.strictEqual(report.summary.verdict, 'ready');
  assert.deepStrictEqual(report.summary.landableNow, [`${repo}#1`]);
  assert.strictEqual(exitCodeFor(report), 0);
});

// ---------------------------------------------------------------------------
// 2. merged-traceable (true merge: accepted is ancestor of the merge commit).
// ---------------------------------------------------------------------------
check('merged-traceable', () => {
  const { repo, routes } = baseRoutes({ merged: true });
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MERGE_COMMIT}$`),
    compare('ahead', 0, 0));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.classification, CLASSIFICATIONS.MERGED_TRACEABLE);
  assert.strictEqual(exitCodeFor(report), 0);
});

// ---------------------------------------------------------------------------
// 3. merged-untraceable: squash-style merge — accepted NOT an ancestor.
// ---------------------------------------------------------------------------
check('merged-untraceable', () => {
  const { repo, routes } = baseRoutes({ merged: true, acceptedVsMain: 'diverged' });
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MERGE_COMMIT}$`),
    compare('diverged', 5, 5));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.classification, CLASSIFICATIONS.MERGED_UNTRACEABLE);
  assert.ok(c.reasons.some((r) => r.includes('squash/rebase')));
  assert.strictEqual(exitCodeFor(report), 1);
});

// ---------------------------------------------------------------------------
// 4. merged but both compares unreadable -> insufficient-info, NOT untraceable.
// ---------------------------------------------------------------------------
check('merged-with-unreadable-compares-is-insufficient', () => {
  const { repo, routes } = baseRoutes({ merged: true });
  routes.set(new RegExp(`/repos/${repo}/compare/`), { status: 0, body: null, error: 'transport down' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(report.candidates[0].classification, CLASSIFICATIONS.INSUFFICIENT);
  assert.strictEqual(report.summary.verdict, 'insufficient-info');
  assert.strictEqual(exitCodeFor(report), 2);
});

// ---------------------------------------------------------------------------
// 5. head-drifted: head moved off the accepted SHA; drift scope is reported.
// ---------------------------------------------------------------------------
check('head-drifted-reports-diff-scope', () => {
  const { repo, routes } = baseRoutes({ headSha: DRIFTED });
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${DRIFTED}$`), compare(
    'diverged', 2, 1,
    {
      commits: [{ sha: DRIFTED, commit: { message: 'late change\n\nbody' } }],
      files: [{ status: 'modified', filename: 'src/x.js' }, { status: 'added', filename: 'src/y.js' }],
    },
  ));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.classification, CLASSIFICATIONS.HEAD_DRIFTED);
  assert.strictEqual(c.drift.status, 'diverged');
  assert.strictEqual(c.drift.aheadBy, 2);
  assert.strictEqual(c.drift.behindBy, 1);
  assert.deepStrictEqual(c.drift.fileList, ['modified:src/x.js', 'added:src/y.js']);
  assert.strictEqual(c.drift.commits[0].message, 'late change');
  // CI ran on the DRIFTED head, not the accepted one — must be filtered.
  const { routes: routes2 } = baseRoutes({ headSha: DRIFTED });
  routes2.set(new RegExp('/actions/runs\\?head_sha='), ciRuns([
    runFor(ACCEPTED, { id: 1, conclusion: 'success' }),
    runFor(DRIFTED, { id: 2, conclusion: 'failure' }),
  ]));
  const report2 = buildReport(configFor(repo), fakeApi(routes2), null);
  assert.strictEqual(report2.candidates[0].classification, CLASSIFICATIONS.HEAD_DRIFTED,
    'drift outranks CI state — the failed run is on a foreign head anyway');
});

// ---------------------------------------------------------------------------
// 6. conflict beats CI.
// ---------------------------------------------------------------------------
check('conflict', () => {
  const { repo, routes } = baseRoutes({ mergeable: false, mergeableState: 'dirty' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(report.candidates[0].classification, CLASSIFICATIONS.CONFLICT);
  assert.strictEqual(exitCodeFor(report), 1);
});

// ---------------------------------------------------------------------------
// 7. ci-pending.
// ---------------------------------------------------------------------------
check('ci-pending', () => {
  const { repo, routes } = baseRoutes({});
  routes.set(new RegExp('/actions/runs\\?head_sha='), ciRuns([
    runFor(ACCEPTED, { id: 1, event: 'push', conclusion: 'success' }),
    runFor(ACCEPTED, { id: 2, event: 'pull_request', status: 'in_progress', conclusion: null }),
  ]));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(report.candidates[0].classification, CLASSIFICATIONS.CI_PENDING);
});

// ---------------------------------------------------------------------------
// 8. ci-failed, no rerun (mirrors the real runtime #1 snapshot).
// ---------------------------------------------------------------------------
check('ci-failed-no-rerun', () => {
  const { repo, routes } = baseRoutes({});
  routes.set(new RegExp('/actions/runs\\?head_sha='), ciRuns([
    runFor(ACCEPTED, { id: 1, event: 'push', conclusion: 'success' }),
    runFor(ACCEPTED, { id: 2, event: 'pull_request', conclusion: 'failure' }),
  ]));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.classification, CLASSIFICATIONS.CI_FAILED);
  assert.strictEqual(c.ci.rerunDetected, false);
  assert.ok(c.ci.notes.some((n) => n.includes('no rerun')));
  assert.ok(report.summary.blockers.some((b) => b.includes('ci-failed')));
});

// ---------------------------------------------------------------------------
// 9. green after a rerun: ready, but rerun evidence stays on the record.
// ---------------------------------------------------------------------------
check('green-after-rerun-is-ready-with-evidence', () => {
  const { repo, routes } = baseRoutes({});
  routes.set(new RegExp('/actions/runs\\?head_sha='), ciRuns([
    runFor(ACCEPTED, { id: 1, event: 'push', conclusion: 'success', attempt: 1 }),
    runFor(ACCEPTED, { id: 2, event: 'pull_request', conclusion: 'success', attempt: 2 }),
  ]));
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  const c = report.candidates[0];
  assert.strictEqual(c.classification, CLASSIFICATIONS.READY);
  assert.strictEqual(c.ci.rerunDetected, true);
  assert.ok(c.ci.notes.some((n) => n.includes('first attempt conclusion is not in the runs API')));
});

// ---------------------------------------------------------------------------
// 10. already-in-main: open PR whose accepted SHA reached main another way.
// ---------------------------------------------------------------------------
check('already-in-main', () => {
  const { repo, routes } = baseRoutes({ acceptedVsMain: 'ahead' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(report.candidates[0].classification, CLASSIFICATIONS.ALREADY_IN_MAIN);
  assert.strictEqual(exitCodeFor(report), 0);
});

// ---------------------------------------------------------------------------
// 11. unreadable PR -> insufficient-info (verdict + exit code 2).
// ---------------------------------------------------------------------------
check('unreadable-pr-is-insufficient', () => {
  const { repo, routes } = baseRoutes({});
  routes.set(`/repos/${repo}/pulls/1`, { status: 404, body: null, error: 'no such PR' });
  const report = buildReport(configFor(repo), fakeApi(routes), null);
  assert.strictEqual(report.candidates[0].classification, CLASSIFICATIONS.INSUFFICIENT);
  assert.strictEqual(report.summary.verdict, 'insufficient-info');
  assert.strictEqual(exitCodeFor(report), 2);
});

// ---------------------------------------------------------------------------
// 12. protection states: definitive not-protected vs permission-gap unknown.
// ---------------------------------------------------------------------------
check('protection-not-protected-vs-unknown', () => {
  assert.deepStrictEqual(
    summarizeProtection(branchMain(false), NOT_PROTECTED).state, 'not-protected');
  const unknown403 = summarizeProtection(branchMain(false), FORBIDDEN);
  assert.strictEqual(unknown403.state, 'unknown');
  assert.ok(unknown403.note.includes('not assuming absence'));
  const protectedRes = {
    status: 200,
    body: {
      required_status_checks: { strict: true, contexts: ['CI / unit'] },
      required_pull_request_reviews: { required_approving_review_count: 1 },
    },
    error: null,
  };
  const prot = summarizeProtection(branchMain(true), protectedRes);
  assert.strictEqual(prot.state, 'protected');
  assert.deepStrictEqual(prot.requiredStatusChecks.contexts, ['CI / unit']);
  assert.strictEqual(prot.requiredReviews.required, 1);
  // 404 protection with unreadable branch must stay unknown (no absence guess).
  assert.strictEqual(
    summarizeProtection({ status: 0, body: null, error: 'down' }, NOT_PROTECTED).state,
    'unknown');
});

// ---------------------------------------------------------------------------
// 13. carried inputs: ancestor vs diverged vs unreadable.
// ---------------------------------------------------------------------------
check('carried-inputs-containment', () => {
  const repo = 'boccchi2993/locus-fake';
  const cfg = {
    candidates: [],
    carriedInputs: { repo, carriedBy: { pr: 5, head: ACCEPTED }, prs: [2, 3, 4] },
  };
  const routes = new Map();
  routes.set(`/repos/${repo}/pulls/2`, pull({ headSha: INPUT_HEAD })); // ancestor
  routes.set(`/repos/${repo}/pulls/3`, pull({ headSha: 'f'.repeat(40) })); // diverged
  routes.set(`/repos/${repo}/pulls/4`, { status: 500, body: null, error: 'boom' });
  routes.set(new RegExp(`/repos/${repo}/compare/${INPUT_HEAD}\\.\\.\\.${ACCEPTED}$`),
    compare('ahead', 0, 0));
  routes.set(new RegExp(`/repos/${repo}/compare/f{40}\\.\\.\\.${ACCEPTED}$`),
    compare('diverged', 1, 1));
  const report = buildReport(cfg, fakeApi(routes), null);
  const [pr2, pr3, pr4] = report.carriedInputs;
  assert.strictEqual(pr2.classification, 'contained-by-integration-head');
  assert.strictEqual(pr2.containedInIntegrationHead, 'contained');
  assert.strictEqual(pr3.classification, 'not-contained-in-integration-head');
  assert.strictEqual(pr3.containedInIntegrationHead, 'not-contained');
  assert.strictEqual(pr4.classification, 'insufficient-info');
});

// ---------------------------------------------------------------------------
// 14. read-only contract: the gh transport argv is exactly ['api', path].
// ---------------------------------------------------------------------------
check('gh-adapter-is-get-only-by-construction', () => {
  const calls = [];
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { status: 0, stdout: '{}', stderr: '' };
  };
  const api = ghApiAdapter(fakeSpawn);
  api('/repos/boccchi2993/locus-fake/pulls/1');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].cmd, 'gh');
  assert.strictEqual(calls[0].args.length, 2);
  assert.strictEqual(calls[0].args[0], 'api');
  assert.strictEqual(calls[0].args[1], '/repos/boccchi2993/locus-fake/pulls/1');
  // No flag of any kind: no -X/-f/-F/--method/--input — nothing but path.
  for (const a of calls[0].args) {
    assert.ok(!String(a).startsWith('-'), `transport must not pass flags, saw ${a}`);
  }
  // And every path the orchestrator asks for is a read endpoint.
  const { repo, routes } = baseRoutes({});
  const recorder = fakeApi(routes);
  buildReport(configFor(repo), recorder, null);
  for (const path of recorder.calls) {
    assert.match(path, /^\/repos\/[^/]+\/[^/]+(\/(pulls\/\d+|branches\/[^/]+(\/protection)?|compare\/[a-f0-9]{40}\.\.\.(main|[a-f0-9]{40})|actions\/runs\?head_sha=[0-9a-f]{40}(&per_page=\d+)?))?$/,
      `non-read endpoint requested: ${path}`);
  }
});

// ---------------------------------------------------------------------------
// 15. compare-status -> containment mapping (the direction trap).
// ---------------------------------------------------------------------------
check('contained-from-compare-directions', () => {
  const mk = (status) => ({ status: 200, body: { status }, error: null });
  // compare/{accepted}...{main}: "ahead" means main contains accepted.
  assert.strictEqual(containedFromCompare(mk('ahead')), 'contained');
  assert.strictEqual(containedFromCompare(mk('identical')), 'contained');
  assert.strictEqual(containedFromCompare(mk('behind')), 'not-contained');
  assert.strictEqual(containedFromCompare(mk('diverged')), 'not-contained');
  assert.strictEqual(containedFromCompare(null), 'unknown');
  assert.strictEqual(containedFromCompare({ status: 404, body: null }), 'unknown');
});

// ---------------------------------------------------------------------------
// 16. summarizeCi: filters foreign heads; empty run list -> 'none'.
// ---------------------------------------------------------------------------
check('summarize-ci-filtering', () => {
  const only = summarizeCi({ workflow_runs: [runFor(ACCEPTED, { id: 9, conclusion: 'success' })] }, DRIFTED);
  assert.strictEqual(only.status, 'none');
  assert.ok(only.notes[0].includes('no CI run'));
  const mixed = summarizeCi({
    workflow_runs: [
      runFor(ACCEPTED, { id: 1, conclusion: 'success' }),
      runFor(DRIFTED, { id: 2, conclusion: 'failure' }),
    ],
  }, ACCEPTED);
  assert.strictEqual(mixed.status, 'success');
  assert.strictEqual(mixed.runs.length, 1);
});

// ---------------------------------------------------------------------------
// 17. renderText: human summary mentions marks, verdict, carried inputs.
// ---------------------------------------------------------------------------
check('render-text-smoke', () => {
  const { repo, routes } = baseRoutes({ merged: true, acceptedVsMain: 'diverged' });
  routes.set(new RegExp(`/repos/${repo}/compare/${ACCEPTED}\\.\\.\\.${MERGE_COMMIT}$`),
    compare('diverged', 5, 5));
  const cfg = configFor(repo);
  cfg.carriedInputs.prs = [2];
  routes.set(`/repos/${repo}/pulls/2`, pull({ headSha: INPUT_HEAD }));
  routes.set(new RegExp(`/repos/${repo}/compare/${INPUT_HEAD}\\.\\.\\.${ACCEPTED}$`),
    compare('diverged', 1, 1));
  const report = buildReport(cfg, fakeApi(routes), '2026-10-05T01:02:03Z');
  const text = renderText(report);
  assert.ok(text.includes('BLOCKER (merged, untraceable)'));
  assert.ok(text.includes('verdict: blocked'));
  assert.ok(text.includes('Product integration inputs'));
  assert.ok(text.includes('not-contained-in-integration-head'));
  assert.ok(text.includes('(read-only, live GitHub state)'));
});

// ---------------------------------------------------------------------------
// 18. default config shape sanity: the shipped table matches the task card.
// ---------------------------------------------------------------------------
check('default-config-matches-verified-set', () => {
  assert.strictEqual(DEFAULT_CONFIG.candidates.length, 3);
  const rt = DEFAULT_CONFIG.candidates[0];
  assert.strictEqual(rt.repo, 'boccchi2993/locus-runtime');
  assert.strictEqual(rt.pr, 1);
  assert.strictEqual(rt.acceptedSha, '2435a57ff7a66db3db88aa98a88d404c75133483');
  const hn = DEFAULT_CONFIG.candidates[1];
  assert.strictEqual(hn.acceptedSha, '347eed99a415dc080b97d46d8a4271ceb19c5142');
  const pd = DEFAULT_CONFIG.candidates[2];
  assert.strictEqual(pd.acceptedSha, 'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b');
  assert.deepStrictEqual(DEFAULT_CONFIG.carriedInputs.prs, [1, 2, 3, 4]);
  assert.strictEqual(
    DEFAULT_CONFIG.carriedInputs.carriedBy.head,
    'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b');
});

// ---------------------------------------------------------------------------
console.log(`m4a-mainline-preflight.test.cjs: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log(`FAIL ${f}`);
  process.exitCode = 1;
}
