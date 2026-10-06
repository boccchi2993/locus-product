#!/usr/bin/env node
// M4a mainline preflight (review round C revision) — read-only audit of the
// verified candidate set for landing the three-repo mainline
// (locus-runtime / locus-harness / locus-product).
//
// REVIEW-C CONTRACT: the preflight refuses to answer "ready" on missing or
// unknown evidence. Status table (families):
//
//   ready              open PR, head == accepted, PR base == configured target,
//                      mergeable explicitly true, main facts readable,
//                      protection known (and satisfied if any rules exist),
//                      CI evidence satisfies the EXPLICIT per-repo config.
//   landed-traceable   merged AND accepted->mergeCommit AND
//                      mergeCommit->current-main ancestry both proven
//                      (or accepted already in current main by another route).
//   landed-other-route unmerged but accepted is already an ancestor of
//                      current main.
//   ci-pending         evidence runs still executing (never treated as pass).
//   blocked            explicit non-landable: head drift, base mismatch,
//                      conflict, GitHub-reported merge blocked
//                      (mergeable_state="blocked"), closed-unmerged, draft,
//                      ci-failed, merged-untraceable (merge not in current
//                      main).
//   insufficient-info  anything required but unreadable/missing/unexplainable:
//                      no CI runs, unknown mergeable, unexplained
//                      mergeable_state, unreadable protection, a required-
//                      approving-reviews rule (current approvals are not
//                      provable from historical review lists), truncated
//                      lists, incomplete run inventories, workflow shape
//                      != config.
//
// summary.verdict, the text render, and the process exit code are ALL derived
// from one aggregation of the same statuses (aggregateVerdict):
//   any insufficient -> 'insufficient-info' (exit 2); never overall ready.
//   else any blocked/pending -> 'blocked' (exit 1).
//   else all landed -> 'landed' (0); all ready -> 'ready' (0);
//   else ready+landed mix -> 'continue' (0).
//   Invalid/empty config is rejected outright (ConfigError, CLI exit 3).
//
// REVIEW-R2 CONTRACT (second review round):
//   - mergeable=true only means "no textual merge conflict". The merge
//     verdict comes from mergeable_state: 'blocked' is a blocked status;
//     only 'clean' and 'unstable' may proceed (unstable is still gated by
//     the explicit protection + evidence checks below); any unexplained
//     state is insufficient. A required-approving-reviews protection rule
//     cannot be proven satisfied by this audit (historical review lists do
//     not prove current effective approvals; CI green is not approval
//     green) -> the requirement is unknown -> refuses ready.
//   - No success verdict may carry an unresolved necessary-evidence unknown
//     (e.g. accepted->current-main containment unreadable -> insufficient).
//   - Required CI jobs succeed only on the explicit conclusion 'success';
//     skipped/neutral stay not-executed; stale/missing/other values are
//     unknown-evidence naming the raw value, run id, and job name.
//   - The required workflow's runs are paged to completion within explicit
//     budgets; no latest-N window survives anywhere. An incomplete run or
//     job inventory is insufficient unless an explicit failure was already
//     observed (then blocked, failure reported); the report names the
//     evaluated run ids and the missing/budget reason.
//
// READ-ONLY CONTRACT: every network call is a GET issued through the `gh` CLI
// with argv exactly ['api', <path>]. The script never merges, comments,
// labels, reruns CI, or updates refs. Tests pin both the argv and an endpoint
// allowlist.
//
// Usage:
//   node scripts/m4a-mainline-preflight.cjs                 # text summary
//   node scripts/m4a-mainline-preflight.cjs --json          # machine JSON
//   node scripts/m4a-mainline-preflight.cjs --out report.json
//   node scripts/m4a-mainline-preflight.cjs --config my.json
//
// Exit codes: 0 ready/landed/continue · 1 blocked · 2 insufficient ·
// 3 invalid configuration.

'use strict';

const { spawnSync } = require('child_process');

const SHA_RE = /^[0-9a-f]{40}$/;

// ---------------------------------------------------------------------------
// Verified candidate set for the M4a mainline rollout. This stays pinned to
// the ACCEPTED (reviewed) heads — it must not silently follow M4a work-in-
// progress commits. ciEvidence is the explicit statement of what counts as
// "the project's required verification ran and succeeded" for each repo,
// derived from each repo's real ci.yml job names. Override with --config.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  targetBranch: 'main',
  candidates: [
    {
      repo: 'boccchi2993/locus-runtime',
      pr: 1,
      acceptedSha: '2435a57ff7a66db3db88aa98a88d404c75133483',
    },
    {
      repo: 'boccchi2993/locus-harness',
      pr: 1,
      acceptedSha: '347eed99a415dc080b97d46d8a4271ceb19c5142',
    },
    {
      repo: 'boccchi2993/locus-product',
      pr: 5,
      acceptedSha: 'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b',
    },
  ],
  ciEvidence: {
    'boccchi2993/locus-runtime': {
      workflow: 'CI',
      jobs: [
        'build + package checks',
        'unit tests (Node)',
        'browser gates (headless Chrome)',
        'out-of-repo tarball consumer (headless Chrome)',
      ],
    },
    'boccchi2993/locus-harness': {
      workflow: 'CI',
      jobs: [
        'build + package checks',
        'unit tests (Node)',
        'harness host browser gate (headless Chrome)',
        'out-of-checkout tarball consumer (headless Chrome)',
      ],
    },
    'boccchi2993/locus-product': {
      workflow: 'CI',
      jobs: [
        'unit tests (Node, clean checkout)',
        'browser gates (packaged build, headless Chrome)',
      ],
    },
  },
  // Product integration inputs: content cherry-picked into the #5 head, so
  // their exact commits are not ancestors of it. Reported factually only.
  carriedInputs: {
    repo: 'boccchi2993/locus-product',
    carriedBy: { pr: 5, head: 'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b' },
    prs: [1, 2, 3, 4],
  },
};

class ConfigError extends Error {}

const STATUS = {
  READY: 'ready',
  LANDED_TRACEABLE: 'landed-traceable',
  LANDED_OTHER_ROUTE: 'landed-other-route',
  CI_PENDING: 'ci-pending',
  CI_FAILED: 'ci-failed',
  HEAD_DRIFTED: 'head-drifted',
  BASE_MISMATCH: 'base-mismatch',
  CONFLICT: 'conflict',
  CLOSED_UNMERGED: 'closed-unmerged',
  DRAFT: 'draft',
  MERGE_BLOCKED: 'merge-blocked',
  MERGED_UNTRACEABLE: 'merged-untraceable',
  INSUFFICIENT: 'insufficient-info',
};

const FAMILIES = {
  ready: new Set([STATUS.READY]),
  landed: new Set([STATUS.LANDED_TRACEABLE, STATUS.LANDED_OTHER_ROUTE]),
  pending: new Set([STATUS.CI_PENDING]),
  blocked: new Set([
    STATUS.CI_FAILED, STATUS.HEAD_DRIFTED, STATUS.BASE_MISMATCH,
    STATUS.CONFLICT, STATUS.MERGE_BLOCKED, STATUS.CLOSED_UNMERGED,
    STATUS.DRAFT, STATUS.MERGED_UNTRACEABLE,
  ]),
  unknown: new Set([STATUS.INSUFFICIENT]),
};

const EXPLICIT_FAILURES = ['failure', 'timed_out', 'cancelled', 'action_required'];
const NOT_EXECUTED = ['skipped', 'neutral'];
const PENDING_STATES = ['expected', 'pending', 'in_progress', 'queued'];

// R2-F1: mergeable_state values that may proceed to the remaining explicit
// gates. 'clean' = GitHub sees nothing blocking or pending. 'unstable' =
// only NON-required commit statuses are failing/pending — readiness is still
// decided below by the explicit protection + evidence checks (so an explicit
// required-job failure stays a ci-failed diagnosis, not an unknown).
// Everything else (blocked/has_hooks/unknown/null/…) has its own rule: see
// classifyCandidate.
const MERGEABLE_STATE_PROCEED = ['clean', 'unstable'];

// R2-F4: pagination budgets. The required workflow's runs for one head are
// fetched to completion up to MAX_RUN_PAGES pages (5 × 100 runs); each run's
// jobs up to MAX_JOBS_PAGES pages (5 × 100 jobs). Beyond a budget the
// inventory is reported INCOMPLETE and no positive verdict may rely on it —
// the bound is a guard against unbounded requests, never a silent window.
const MAX_RUN_PAGES = 5;
const MAX_JOBS_PAGES = 5;

const DRIFT_COMMIT_CAP = 20;

// ---------------------------------------------------------------------------
// Transport adapters. api(path) -> {status, body, error}; status is the HTTP
// status (0 = transport-level failure), body is parsed JSON or null.
// ---------------------------------------------------------------------------

// Default adapter: the `gh` CLI. GET only — the spawned argv is exactly
// ['api', path] with no method/field flags (tests pin this byte-for-byte).
function ghApiAdapter(spawn) {
  const run = spawn || spawnSync;
  return function ghApi(path) {
    const res = run('gh', ['api', path], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) {
      const code = res.error.code === 'ENOENT'
        ? 'gh CLI not found on PATH'
        : String(res.error.code || res.error);
      return { status: 0, body: null, error: code };
    }
    if (res.status === 0) {
      let body = null;
      try { body = JSON.parse(res.stdout); } catch (_) { /* non-JSON body */ }
      return { status: 200, body, error: null };
    }
    const m = /\(HTTP (\d{3})\)/.exec(res.stderr || '');
    return {
      status: m ? Number(m[1]) : 0,
      body: null,
      error: (res.stderr || `gh api exited ${res.status}`).trim(),
    };
  };
}

function ok(res) { return res && res.status === 200 && res.body; }

function errText(res) {
  return (res && (res.error || `HTTP ${res.status}`)) || 'no data';
}

// JSON.stringify that survives undefined (plain stringify would silently
// drop the value from a rendered list of observed raw conclusions).
function jsonVal(v) { return v === undefined ? 'undefined' : JSON.stringify(v); }

// compare API status -> is `base` commit an ancestor of `head` commit?
// (compare/{base}...{head}: "ahead"/"identical" = head contains base.)
function containedFromCompare(cmp) {
  if (!cmp || !cmp.body) return 'unknown';
  const s = cmp.body.status;
  if (s === 'ahead' || s === 'identical') return 'contained';
  if (s === 'behind' || s === 'diverged') return 'not-contained';
  return 'unknown';
}

function asContainment(res) {
  if (!res) return { state: 'unknown', detail: 'not fetched' };
  if (!ok(res)) return { state: 'unknown', detail: errText(res) };
  const b = res.body;
  return {
    state: containedFromCompare(res),
    detail: `status=${b.status} ahead_by=${b.ahead_by} behind_by=${b.behind_by}`,
  };
}

function truncatedList(body, listKey) {
  if (!body) return false;
  const total = typeof body.total_count === 'number' ? body.total_count : null;
  const list = Array.isArray(body[listKey]) ? body[listKey] : null;
  if (total === null || list === null) return false;
  return total > list.length;
}

// Raw runs for one head SHA -> slim rows + pending/failed/rerun facts.
// Runs rows carry the LATEST attempt's conclusion only; run_attempt > 1 is
// the runs-API evidence that a rerun happened (the first attempt's
// conclusion is not in this endpoint — it lives in the run's page/logs and
// is preserved in review records, not invented here).
function summarizeRuns(runsBody, headSha) {
  const all = (runsBody && Array.isArray(runsBody.workflow_runs))
    ? runsBody.workflow_runs : [];
  const forHead = all.filter((r) => r.head_sha === headSha);
  const runs = forHead.map((r) => ({
    id: r.id,
    name: r.name,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    runAttempt: r.run_attempt,
    createdAt: r.created_at,
    url: r.html_url,
  }));
  const incomplete = runs.filter((r) => r.status && r.status !== 'completed');
  const failed = runs.filter((r) => EXPLICIT_FAILURES.includes(r.conclusion));
  const rerunDetected = runs.some((r) => (r.runAttempt || 1) > 1);
  const notes = [];
  if (rerunDetected) {
    notes.push('a rerun is recorded (run_attempt > 1); the runs API keeps only '
      + 'the latest attempt conclusion — first-attempt outcomes stay in the review record');
  }
  return { ok: true, error: null, runs, incomplete, failed, rerunDetected, notes, truncated: false };
}

// The explicit evidence gate: does the configured required workflow have a
// completed run on this head whose jobs prove every required job succeeded?
// R2-F3: a required job counts as succeeded ONLY on the explicit conclusion
// 'success'. skipped/neutral are not-executed; stale/null/missing/any other
// value is unknown-evidence that names the raw value, run id, and job name.
// R2-F4: EVERY run of the required workflow passed here is judged — the
// caller (fetch layer, paged to completion) must not slice, and this layer
// keeps no window either. `inventory` states whether the run list was
// fetched completely (fetch-layer budget); an incomplete inventory is
// insufficient unless an explicit failure was already observed (then the
// failure is reported, since unevaluated runs cannot erase it).
function evaluateRequiredEvidence(spec, runsForHead, jobsByRun, inventory) {
  const inv = (inventory && typeof inventory === 'object')
    ? inventory
    : { complete: true, reason: null };
  const wfRuns = runsForHead
    .filter((r) => r.name === spec.workflow)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (wfRuns.length === 0) {
    return {
      state: 'unknown-evidence',
      detail: `required workflow "${spec.workflow}" has no run on this head — nothing proves the required verification executed`
        + (inv.complete === false && inv.reason ? ` (inventory incomplete: ${inv.reason})` : ''),
      perRun: [],
      evaluatedRunIds: [],
    };
  }
  const perRun = [];
  for (const run of wfRuns) {
    if (run.status && run.status !== 'completed') {
      perRun.push({ runId: run.id, state: 'pending', detail: `${run.name} run ${run.id} is ${run.status}` });
      continue; // eslint-disable-line no-continue
    }
    const j = jobsByRun.get(run.id);
    if (!j) {
      perRun.push({ runId: run.id, state: 'unknown-evidence', detail: `job list for run ${run.id} not fetched/readable` });
      continue; // eslint-disable-line no-continue
    }
    if (!j.ok) {
      perRun.push({ runId: run.id, state: 'unknown-evidence', detail: `job list for run ${run.id} unreadable: ${j.error}` });
      continue; // eslint-disable-line no-continue
    }
    if (j.truncated) {
      perRun.push({
        runId: run.id, state: 'unknown-evidence',
        detail: `job list for run ${run.id} not fully readable${j.reason ? `: ${j.reason}` : ' (total_count > fetched)'} — refusing to judge`,
      });
      continue; // eslint-disable-line no-continue
    }
    const byName = new Map(j.jobs.map((job) => [job.name, job.conclusion]));
    const missing = spec.jobs.filter((n) => !byName.has(n));
    if (missing.length) {
      perRun.push({
        runId: run.id, state: 'unknown-evidence',
        detail: `workflow shape does not match the configured evidence requirement; missing job(s): ${missing.join(', ')}`,
      });
      continue; // eslint-disable-line no-continue
    }
    const failedJobs = spec.jobs.filter((n) => EXPLICIT_FAILURES.includes(byName.get(n)));
    const succeeded = spec.jobs.filter((n) => byName.get(n) === 'success');
    // Non-configured jobs that explicitly failed stay visible but do not gate:
    // the config defines the project's required evidence.
    const failedOther = j.jobs
      .filter((job) => !spec.jobs.includes(job.name) && EXPLICIT_FAILURES.includes(job.conclusion))
      .map((job) => `${job.name}=${job.conclusion}`);
    if (failedJobs.length) {
      perRun.push({
        runId: run.id, state: 'failed',
        detail: `required job(s) explicitly failed: ${failedJobs.map((n) => `${n}=${byName.get(n)}`).join(', ')}`
          + (failedOther.length ? `; non-required failures: ${failedOther.join(', ')}` : ''),
      });
    } else if (succeeded.length === spec.jobs.length) {
      perRun.push({
        runId: run.id, state: 'satisfied', runAttempt: run.runAttempt,
        detail: `all required jobs succeeded on run ${run.id}`
          + (failedOther.length ? ` (visible non-required failures: ${failedOther.join(', ')})` : ''),
      });
    } else {
      const bad = spec.jobs
        .filter((n) => byName.get(n) !== 'success')
        .map((n) => `${n}=${jsonVal(byName.get(n))}`);
      // skipped/neutral (alone or mixed with successes) keep the round-C
      // "not-executed" classification; any other non-success value
      // (stale/null/missing/unrecognized) is unknown-evidence.
      const unclassifiable = spec.jobs
        .filter((n) => byName.get(n) !== 'success' && !NOT_EXECUTED.includes(byName.get(n)));
      if (unclassifiable.length === 0) {
        perRun.push({
          runId: run.id, state: 'not-executed',
          detail: `required job(s) did not execute (skipped/neutral): ${bad.join(', ')}`,
        });
      } else {
        perRun.push({
          runId: run.id, state: 'unknown-evidence',
          detail: `required job(s) on run ${run.id} without explicit success (only conclusion "success" counts; observed: ${bad.join(', ')})`,
        });
      }
    }
  }
  const satisfied = perRun.filter((r) => r.state === 'satisfied');
  const failedRuns = perRun.filter((r) => r.state === 'failed');
  const pendings = perRun.filter((r) => r.state === 'pending');
  const evaluatedRunIds = perRun.map((r) => r.runId);
  // An explicit required-job failure STANDS until its own run is superseded
  // by a rerun (the runs API then reports the latest attempt). A green
  // sibling run (e.g. the push-event run) is additional evidence, but it
  // does not erase an executed, unresolved failure — it is named alongside.
  if (failedRuns.length) {
    const via = Object.assign({}, failedRuns[0]);
    if (satisfied.length) {
      via.detail = `${via.detail}; sibling run(s) also satisfied the requirement (${satisfied.map((s) => `run ${s.runId}`).join(', ')}) — they do not supersede the failed run, only a rerun of it does`;
    }
    if (inv.complete === false && inv.reason) {
      via.detail = `${via.detail}; run inventory incomplete (${inv.reason}) — evaluated runs: ${evaluatedRunIds.join(', ') || 'none'}; unevaluated runs can only add failures, never erase this one`;
    }
    return { state: 'failed', via, perRun, evaluatedRunIds };
  }
  // R2-F4: with no failure in hand, an incomplete inventory can only be
  // "not enough" — a partial list never proves satisfaction.
  if (inv.complete === false) {
    return {
      state: 'unknown-evidence',
      detail: `required-workflow run inventory incomplete and no explicit failure observed among evaluated runs (${evaluatedRunIds.join(', ') || 'none'}) — ${inv.reason || 'reason unknown'}; a ready verdict requires the complete inventory`,
      perRun,
      evaluatedRunIds,
    };
  }
  // Fail-closed: while any run of the required workflow is still executing,
  // the evidence is pending — even if another run already satisfied the
  // requirement — because the eventual outcome is not known yet.
  if (pendings.length) {
    return {
      state: 'pending', via: pendings[0], perRun, evaluatedRunIds,
      note: satisfied.length
        ? 'another run already satisfied the requirement, but a required-workflow run is still executing'
        : undefined,
    };
  }
  // R2-F4: a satisfied run must never shadow another run's unexplained
  // evidence (unreadable/truncated/shape-drifted) — "some run was green"
  // is not a license to skip the remaining unknowns.
  const order = ['not-executed', 'unknown-evidence'];
  for (const s of order) {
    const hit = perRun.filter((r) => r.state === s);
    if (hit.length) return { state: s, via: hit[0], perRun, evaluatedRunIds };
  }
  if (satisfied.length) {
    return { state: 'satisfied', via: satisfied[0], perRun, evaluatedRunIds };
  }
  return { state: 'unknown-evidence', detail: 'no evaluable run', perRun, evaluatedRunIds };
}

// Branch protection rules for the target branch. Permission gaps stay
// "unknown" — never assumed to mean absence. When rules exist, their
// required contexts are CHECKED against the head commit (check-runs +
// combined status), not merely displayed.
function summarizeProtection(mainBranchRes, protectionRes) {
  const branchProtected = ok(mainBranchRes)
    ? !!mainBranchRes.body.protected
    : null;
  if (ok(protectionRes)) {
    const b = protectionRes.body || {};
    return {
      state: 'protected',
      branchProtected,
      requiredStatusChecks: b.required_status_checks
        ? { strict: !!b.required_status_checks.strict, contexts: b.required_status_checks.contexts || [] }
        : null,
      requiredReviews: b.required_pull_request_reviews
        ? { required: b.required_pull_request_reviews.required_approving_review_count ?? null }
        : null,
    };
  }
  if (protectionRes && protectionRes.status === 404) {
    if (branchProtected === false) {
      return { state: 'not-protected', branchProtected, requiredStatusChecks: null, requiredReviews: null };
    }
    return {
      state: 'unknown', branchProtected, requiredStatusChecks: null, requiredReviews: null,
      note: 'protection endpoint 404 while branch readability unconfirmed',
    };
  }
  const note = protectionRes && protectionRes.status === 403
    ? 'permission denied reading protection rules; refusing to assume absence'
    : `protection unreadable: ${errText(protectionRes)}`;
  return { state: 'unknown', branchProtected, requiredStatusChecks: null, requiredReviews: null, note };
}

// Are the protected branch's required contexts satisfied on this head?
function evaluateProtectionRequirements(protection, checkRunsRes, statusRes) {
  if (protection.state === 'not-protected') {
    return {
      state: 'not-applicable',
      detail: 'branch not protected — no GitHub-side required checks; the project evidence config still governs readiness',
    };
  }
  if (protection.state === 'unknown') {
    return { state: 'unknown', detail: protection.note || 'protection unreadable' };
  }
  // R2-F1: a required-approving-reviews rule cannot be proven satisfied by
  // this audit. Historical review lists mix stale/dismissed reviews with
  // currently valid ones, and green CI is not approval evidence — so the
  // requirement is answered "unknown" (which refuses ready), never guessed
  // from any count.
  if (protection.requiredReviews) {
    const n = protection.requiredReviews.required;
    return {
      state: 'unknown',
      detail: `branch protection requires ${n === null || n === undefined ? 'an unreadable number of' : n} approving review(s) — this audit has no evidence of currently valid approvals (a historical review list or green CI does not prove them); refusing ready`,
    };
  }
  const contexts = (protection.requiredStatusChecks && protection.requiredStatusChecks.contexts) || [];
  if (!contexts.length) {
    return { state: 'none-required', detail: 'protected but no required status checks configured' };
  }
  if (!ok(checkRunsRes) || !ok(statusRes)) {
    return {
      state: 'unknown',
      detail: `required-check satisfaction unreadable: check-runs ${errText(checkRunsRes)}, status ${errText(statusRes)}`,
    };
  }
  const crBody = checkRunsRes.body;
  const stBody = statusRes.body;
  if (truncatedList(crBody, 'check_runs') || truncatedList(stBody, 'statuses')) {
    return { state: 'unknown', detail: 'check-runs/status list truncated (total_count > fetched) — refusing to judge satisfaction' };
  }
  const details = [];
  let state = 'satisfied';
  for (const ctx of contexts) {
    const cr = (crBody.check_runs || []).find((r) => r.name === ctx);
    const st = (stBody.statuses || []).find((s) => s.context === ctx);
    const conc = cr ? cr.conclusion : null;
    const stState = st ? st.state : null;
    if (conc === 'success' || stState === 'success') {
      details.push(`${ctx}: satisfied`);
    } else if ((cr && cr.status && cr.status !== 'completed')
      || (stState && PENDING_STATES.includes(stState))) {
      if (state === 'satisfied') state = 'pending';
      details.push(`${ctx}: pending`);
    } else {
      state = 'unsatisfied';
      details.push(`${ctx}: ${conc || stState || 'required check not found on this head'}`);
    }
  }
  return { state, detail: details.join('; ') };
}

function describeDrift(cmp) {
  if (!cmp || !cmp.body) return { status: 'unknown', error: errText(cmp) };
  const b = cmp.body;
  const commits = (b.commits || []).slice(0, DRIFT_COMMIT_CAP).map((c) => ({
    sha: c.sha,
    message: String(c.commit && c.commit.message || '').split('\n')[0],
  }));
  return {
    status: b.status,
    aheadBy: b.ahead_by,
    behindBy: b.behind_by,
    totalCommits: b.total_commits,
    files: (b.files || []).length,
    fileList: (b.files || []).slice(0, DRIFT_COMMIT_CAP).map((f) => `${f.status}:${f.filename}`),
    commits,
    truncated: (b.commits || []).length > DRIFT_COMMIT_CAP
      || (b.files || []).length > DRIFT_COMMIT_CAP,
  };
}

// ---------------------------------------------------------------------------
// The shared classifier. Every consumer (JSON, text, exit code) derives from
// the status this returns. facts are pre-fetched; see fetchCandidateFacts.
// ---------------------------------------------------------------------------
function classifyCandidate(facts) {
  const reasons = [];
  const unknowns = [];

  if (!ok(facts.pr)) {
    unknowns.push(`PR not readable: ${errText(facts.pr)}`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  const pr = facts.pr.body;
  const headSha = pr.head && pr.head.sha;
  const acceptedSha = facts.acceptedSha;
  const targetBranch = facts.baseBranch;
  const headMatchesAccepted = headSha === acceptedSha;

  if (pr.merged === true) {
    // Two independent ancestry legs; accepted->merge alone is NOT enough.
    const leg1 = facts.acceptedToMerge || { state: 'unknown', detail: 'not fetched' };
    const leg2 = facts.mergeToMain || { state: 'unknown', detail: 'not fetched' };
    const inMain = facts.acceptedInMain || { state: 'unknown', detail: 'not fetched' };
    if (leg1.state === 'contained' && leg2.state === 'contained') {
      reasons.push(`merged (merge commit ${String(pr.merge_commit_sha || '').slice(0, 12)}); accepted -> merge commit and merge commit -> current main both proven (${leg1.detail}; ${leg2.detail})`);
      return { status: STATUS.LANDED_TRACEABLE, reasons, unknowns };
    }
    if (inMain.state === 'contained') {
      reasons.push(`PR merged, and the accepted SHA is an ancestor of current main (${inMain.detail}); merge commit -> main leg: ${leg2.state}`);
      return { status: STATUS.LANDED_TRACEABLE, reasons, unknowns };
    }
    if (leg1.state === 'unknown' || leg2.state === 'unknown' || inMain.state === 'unknown') {
      if (leg1.state === 'contained' && leg2.state === 'unknown') {
        unknowns.push(`accepted -> merge commit proven (${leg1.detail}) but merge commit -> current main unreadable: ${leg2.detail}`);
      } else {
        unknowns.push(`merge traceability unreadable: accepted->merge ${leg1.detail}; merge->main ${leg2.detail}; accepted->main ${inMain.detail}`);
      }
      return { status: STATUS.INSUFFICIENT, reasons, unknowns };
    }
    if (leg1.state === 'contained' && leg2.state === 'not-contained') {
      reasons.push(`the merge commit exists and contains the accepted SHA (${leg1.detail}) but is NOT an ancestor of current main (${leg2.detail}) — the landing is not in the current main line (main moved on or was rewritten)`);
      return { status: STATUS.MERGED_UNTRACEABLE, reasons, unknowns };
    }
    reasons.push(`merged but accepted content is not traceable in current main (accepted->merge ${leg1.state}, merge->main ${leg2.state}, accepted->main ${inMain.state})`);
    return { status: STATUS.MERGED_UNTRACEABLE, reasons, unknowns };
  }

  // Not merged. First: has the accepted content landed by another route?
  const inMain = facts.acceptedInMain || { state: 'unknown', detail: 'not fetched' };
  if (inMain.state === 'contained') {
    reasons.push(`PR still ${pr.state}, but the accepted SHA is already an ancestor of current main (${inMain.detail}) — landed by another route`);
    return { status: STATUS.LANDED_OTHER_ROUTE, reasons, unknowns };
  }
  if (inMain.state === 'unknown') {
    unknowns.push(`accepted -> current main containment unreadable: ${inMain.detail}`);
  }

  if (pr.state === 'closed') {
    reasons.push(`PR is closed without being merged (merged=${pr.merged}) — explicitly not landable through this PR`);
    return { status: STATUS.CLOSED_UNMERGED, reasons, unknowns };
  }
  if (pr.draft === true) {
    reasons.push('PR is a draft — cannot be ready');
    return { status: STATUS.DRAFT, reasons, unknowns };
  }
  if (pr.base && pr.base.ref !== targetBranch) {
    reasons.push(`PR base is "${pr.base.ref}" but the configured landing target is "${targetBranch}" — refused as mismatched`);
    return { status: STATUS.BASE_MISMATCH, reasons, unknowns };
  }
  if (!headMatchesAccepted) {
    reasons.push(`head ${String(headSha || '?').slice(0, 12)} != accepted ${String(acceptedSha || '?').slice(0, 12)}`);
    if (ok(facts.drift)) {
      const d = describeDrift(facts.drift);
      reasons.push(`drift scope: ${d.status}, +${d.aheadBy}/-${d.behindBy} commits, ${d.files} files${d.truncated ? ' (truncated list)' : ''}`);
    } else {
      unknowns.push(`drift scope unreadable: ${errText(facts.drift)}`);
    }
    return { status: STATUS.HEAD_DRIFTED, reasons, unknowns };
  }
  if (!ok(facts.mainBranch)) {
    unknowns.push(`target branch "${targetBranch}" unreadable: ${errText(facts.mainBranch)}`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    reasons.push(`merge conflict (mergeable=${pr.mergeable}, state=${jsonVal(pr.mergeable_state)})`);
    return { status: STATUS.CONFLICT, reasons, unknowns };
  }
  // Unknown mergeability must not pass: GitHub may still be computing, and a
  // failed read is indistinguishable from that here.
  if (pr.mergeable !== true) {
    unknowns.push(`mergeability unknown (mergeable=${jsonVal(pr.mergeable)}, state=${jsonVal(pr.mergeable_state)}) — not treated as passable`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  // R2-F1: mergeable=true only means "no textual merge conflict" — it is NOT
  // "merge permitted". mergeable_state decides, explicitly:
  //   'blocked'  -> GitHub itself states protection requirements are unmet.
  //   'clean'    -> nothing blocking or pending; may proceed.
  //   'unstable' -> only NON-required statuses failing/pending; the explicit
  //                 protection + evidence gates below still decide.
  //   anything else (has_hooks/unknown/null/…) does not prove readiness.
  if (pr.mergeable_state === 'blocked') {
    reasons.push('GitHub reports the merge as blocked (mergeable=true but mergeable_state="blocked") — branch protection requirements (approvals / required checks) are not satisfied on this head');
    return { status: STATUS.MERGE_BLOCKED, reasons, unknowns };
  }
  if (!MERGEABLE_STATE_PROCEED.includes(pr.mergeable_state)) {
    unknowns.push(`mergeable_state=${jsonVal(pr.mergeable_state)} is not an explained state (allowlist with rationale: clean, unstable) — readiness cannot be proven from it`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  if (pr.mergeable_state === 'unstable') {
    reasons.push('note: mergeable_state="unstable" (GitHub sees failing/pending non-required statuses); readiness below still requires the explicit protection + evidence gates');
  }

  // Protection: an unknown state cannot back a ready; existing rules must be
  // CHECKED against the head, not merely displayed.
  const protection = facts.protectionFacts
    || summarizeProtection(facts.mainBranch, facts.protection);
  const protReq = facts.protectionRequirements || { state: 'unknown', detail: 'not evaluated' };
  if (protection.state === 'unknown') {
    unknowns.push(`branch protection unreadable: ${protection.note || 'unknown'}`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  if (protReq.state === 'unknown') {
    unknowns.push(`protection requirement satisfaction unknown: ${protReq.detail}`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  if (protReq.state === 'unsatisfied') {
    reasons.push(`protected branch requirements not satisfied: ${protReq.detail}`);
    return { status: STATUS.CONFLICT, reasons, unknowns };
  }
  if (protReq.state === 'pending') {
    reasons.push(`protected branch requirements pending: ${protReq.detail}`);
    return { status: STATUS.CI_PENDING, reasons, unknowns };
  }

  // Project evidence: the explicit per-repo CI requirement.
  const evidence = facts.requiredEvidence
    || { state: 'unknown-evidence', detail: 'evidence requirement not evaluated' };
  if (evidence.state === 'unknown-evidence') {
    unknowns.push(`required CI evidence not provable: ${evidence.detail || (evidence.via && evidence.via.detail) || 'unknown'}`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }
  if (evidence.state === 'pending') {
    reasons.push(`required CI evidence pending: ${evidence.via && evidence.via.detail}`);
    return { status: STATUS.CI_PENDING, reasons, unknowns };
  }
  if (evidence.state === 'failed') {
    reasons.push(`required CI evidence explicitly failed: ${evidence.via && evidence.via.detail}`);
    return { status: STATUS.CI_FAILED, reasons, unknowns };
  }
  if (evidence.state === 'not-executed') {
    unknowns.push(`required CI evidence did not execute (skipped/neutral is not success evidence): ${evidence.via && evidence.via.detail}`);
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }

  // R2-F2: no success verdict may carry an unresolved necessary-evidence gap
  // (e.g. accepted->current-main containment unreadable above). Explicit
  // blocked/pending diagnoses already returned; reaching here with a gap
  // means the gap alone stands between this candidate and success.
  if (unknowns.length) {
    return { status: STATUS.INSUFFICIENT, reasons, unknowns };
  }

  reasons.push(`required CI evidence satisfied: ${evidence.via && evidence.via.detail}`);
  if (facts.runs && facts.runs.rerunDetected) {
    reasons.push('note: a rerun is on record for this head (run_attempt > 1) — the first-attempt outcome stays in the review record, not rewritten as first-try success');
  }
  reasons.push(`head == accepted ${String(acceptedSha).slice(0, 12)}; base ${pr.base.ref} == target; mergeable=true (${pr.mergeable_state}); protection=${protection.state} (${protReq.state})`);
  return { status: STATUS.READY, reasons, unknowns };
}

// ---------------------------------------------------------------------------
// Fetch layer (GET-only). api is injectable; every path used here is in the
// read allowlist the tests pin.
//
// R2-F4: both fetch helpers page to COMPLETION within explicit budgets and
// return an honest inventory flag — the judgment layer never slices, and an
// incomplete inventory is surfaced, not papered over.
// ---------------------------------------------------------------------------
function fetchRunsForHead(repo, headSha, api) {
  const runs = [];
  let totalCount = null;
  let pagesFetched = 0;
  let lastPageRows = 0;
  for (let page = 1; page <= MAX_RUN_PAGES; page++) {
    const res = api(`/repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100&page=${page}`);
    pagesFetched = page;
    if (!ok(res)) {
      const error = `run list page ${page} unreadable: ${errText(res)}`;
      return { ok: false, error, runs, totalCount, pagesFetched, complete: false, reason: error };
    }
    totalCount = typeof res.body.total_count === 'number' ? res.body.total_count : totalCount;
    const rows = Array.isArray(res.body.workflow_runs) ? res.body.workflow_runs : [];
    runs.push(...rows);
    lastPageRows = rows.length;
    if (rows.length < 100) break; // server says this is the last page
    if (totalCount !== null && runs.length >= totalCount) break; // provably complete
  }
  if (lastPageRows >= 100 && (totalCount === null || runs.length < totalCount)) {
    return {
      ok: true, runs, totalCount, pagesFetched, complete: false,
      reason: `run list budget exhausted: ${pagesFetched} page(s) fetched, ${runs.length} run(s) of a claimed total_count=${totalCount === null ? 'absent' : totalCount} — raise MAX_RUN_PAGES deliberately if a head really has more`,
    };
  }
  if (totalCount !== null && runs.length < totalCount) {
    return {
      ok: true, runs, totalCount, pagesFetched, complete: false,
      reason: `run list truncated: total_count=${totalCount} but only ${runs.length} fetched`,
    };
  }
  return { ok: true, runs, totalCount, pagesFetched, complete: true, reason: null };
}

function fetchJobsForRun(repo, runId, api) {
  const jobs = [];
  let totalCount = null;
  let pagesFetched = 0;
  let lastPageRows = 0;
  for (let page = 1; page <= MAX_JOBS_PAGES; page++) {
    const res = api(`/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`);
    pagesFetched = page;
    if (!ok(res)) {
      return { ok: false, error: errText(res), truncated: false, reason: null, jobs: [] };
    }
    totalCount = typeof res.body.total_count === 'number' ? res.body.total_count : totalCount;
    const rows = Array.isArray(res.body.jobs) ? res.body.jobs : [];
    jobs.push(...rows.map((j) => ({ name: j.name, conclusion: j.conclusion })));
    lastPageRows = rows.length;
    if (rows.length < 100) break; // server says this is the last page
    if (totalCount !== null && jobs.length >= totalCount) break; // provably complete
  }
  // ONE completeness decision for every exit path: the list is complete when
  // a trusted total_count is fully fetched (a final page of exactly 100 is
  // then the PROOF of completeness, not a gap), or when the server itself
  // ended the list on a short page. A full final page alone proves nothing:
  // with no usable total_count it keeps paging and, at the budget, is
  // reported explicitly incomplete; with a total_count still above the
  // fetched count it is missing pages. Every incomplete shape stays
  // truncated -> unknown-evidence -> never ready.
  const complete = (totalCount !== null && jobs.length >= totalCount)
    || (totalCount === null && lastPageRows < 100);
  if (complete) {
    return { ok: true, error: null, truncated: false, reason: null, jobs };
  }
  return {
    ok: true, error: null, truncated: true,
    reason: totalCount !== null
      ? (lastPageRows >= 100
        ? `jobs budget exhausted for run ${runId}: ${pagesFetched} page(s) fetched, ${jobs.length} job(s) of a claimed total_count=${totalCount}`
        : `job list truncated for run ${runId}: total_count=${totalCount} but only ${jobs.length} fetched`)
      : `job list for run ${runId} ended on a full page without a usable total_count (fetched ${pagesFetched} page(s) within the budget) — completeness unproven`,
    jobs,
  };
}

function fetchCandidateFacts(entry, config, api) {
  const { repo, pr: prNumber, acceptedSha } = entry;
  const targetBranch = entry.baseBranch || config.targetBranch || 'main';
  const spec = (config.ciEvidence || {})[repo];
  const facts = {
    acceptedSha, baseBranch: targetBranch, evidenceSpec: spec,
    pr: null, repoMeta: null, mainBranch: null, protection: null,
    acceptedInMain: null, acceptedToMerge: null, mergeToMain: null,
    drift: null, runs: null, runsRes: null, jobsByRun: new Map(),
    requiredEvidence: null, protectionRequirements: null,
  };

  facts.pr = api(`/repos/${repo}/pulls/${prNumber}`);
  const prBody = ok(facts.pr) ? facts.pr.body : null;
  facts.repoMeta = api(`/repos/${repo}`);
  facts.mainBranch = api(`/repos/${repo}/branches/${targetBranch}`);
  facts.protection = api(`/repos/${repo}/branches/${targetBranch}/protection`);
  facts.protectionFacts = summarizeProtection(facts.mainBranch, facts.protection);
  const mainSha = ok(facts.mainBranch) ? facts.mainBranch.body.commit.sha : null;

  if (mainSha && SHA_RE.test(acceptedSha)) {
    facts.acceptedInMain = asContainment(api(`/repos/${repo}/compare/${acceptedSha}...${mainSha}`));
  }
  if (prBody && prBody.merged === true && prBody.merge_commit_sha) {
    facts.acceptedToMerge = asContainment(api(`/repos/${repo}/compare/${acceptedSha}...${prBody.merge_commit_sha}`));
    if (mainSha) {
      facts.mergeToMain = asContainment(api(`/repos/${repo}/compare/${prBody.merge_commit_sha}...${mainSha}`));
    }
  }
  if (prBody && prBody.head && prBody.head.sha && prBody.head.sha !== acceptedSha) {
    facts.drift = api(`/repos/${repo}/compare/${acceptedSha}...${prBody.head.sha}`);
  }

  // Evidence fetches matter for OPEN PRs (landed PRs are judged by ancestry).
  const needsEvidence = prBody && prBody.merged !== true && prBody.head && prBody.head.sha;
  if (needsEvidence) {
    const headSha = prBody.head.sha;
    const runsFetch = fetchRunsForHead(repo, headSha, api);
    if (runsFetch.ok) {
      facts.runs = summarizeRuns({ workflow_runs: runsFetch.runs }, headSha);
      facts.runs.truncated = runsFetch.complete === false;
      facts.runs.inventory = {
        complete: runsFetch.complete,
        reason: runsFetch.reason,
        totalCount: runsFetch.totalCount,
        pagesFetched: runsFetch.pagesFetched,
      };
      if (runsFetch.complete === false && runsFetch.reason) {
        facts.runs.notes.push(`run inventory incomplete: ${runsFetch.reason}`);
      }
      // R2-F4: jobs are fetched for EVERY run of the required workflow on
      // this head — no latest-N slice survives in either layer.
      const wfRuns = spec
        ? facts.runs.runs.filter((r) => r.name === spec.workflow)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        : [];
      for (const run of wfRuns) {
        facts.jobsByRun.set(run.id, fetchJobsForRun(repo, run.id, api));
      }
      facts.requiredEvidence = spec
        ? evaluateRequiredEvidence(spec, facts.runs.runs, facts.jobsByRun, {
          complete: runsFetch.complete,
          reason: runsFetch.reason,
        })
        : {
          state: 'unknown-evidence',
          detail: `no explicit evidence requirement configured for ${repo}`,
        };
    } else {
      facts.runs = {
        ok: false, error: runsFetch.error, runs: [], incomplete: [], failed: [],
        rerunDetected: false, notes: [], truncated: true,
        inventory: {
          complete: false, reason: runsFetch.reason,
          totalCount: runsFetch.totalCount, pagesFetched: runsFetch.pagesFetched,
        },
      };
      facts.requiredEvidence = { state: 'unknown-evidence', detail: `CI runs unreadable: ${runsFetch.error}` };
    }

    if (facts.protectionFacts.state === 'protected') {
      const headSha = prBody.head.sha;
      const checkRunsRes = api(`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`);
      const statusRes = api(`/repos/${repo}/commits/${headSha}/status`);
      facts.protectionRequirements = evaluateProtectionRequirements(
        facts.protectionFacts, checkRunsRes, statusRes);
    }
  }
  if (!facts.protectionRequirements) {
    facts.protectionRequirements = evaluateProtectionRequirements(facts.protectionFacts, null, null);
  }
  if (!facts.acceptedInMain) {
    facts.acceptedInMain = {
      state: 'unknown',
      detail: mainSha ? 'not fetched' : `target branch unreadable: ${errText(facts.mainBranch)}`,
    };
  }
  return facts;
}

function candidateRecord(entry, config, api) {
  const facts = fetchCandidateFacts(entry, config, api);
  const { status, reasons, unknowns } = classifyCandidate(facts);
  const prBody = ok(facts.pr) ? facts.pr.body : null;
  const mainBranch = ok(facts.mainBranch) ? facts.mainBranch.body : null;
  const repoMeta = ok(facts.repoMeta) ? facts.repoMeta.body : null;
  const record = {
    repo: entry.repo,
    pr: entry.pr,
    acceptedSha: entry.acceptedSha,
    targetBranch: facts.baseBranch,
    status,
    family: FAMILIES.ready.has(status) ? 'ready'
      : FAMILIES.landed.has(status) ? 'landed'
        : FAMILIES.pending.has(status) ? 'pending'
          : FAMILIES.blocked.has(status) ? 'blocked' : 'unknown',
    reasons,
    unknowns,
    prState: prBody ? {
      state: prBody.state,
      merged: prBody.merged,
      draft: prBody.draft || false,
      title: prBody.title,
      head: prBody.head ? { ref: prBody.head.ref, sha: prBody.head.sha } : null,
      base: prBody.base ? { ref: prBody.base.ref, sha: prBody.base.sha } : null,
      baseMatchesTarget: !!(prBody.base && prBody.base.ref === facts.baseBranch),
      mergeable: prBody.mergeable,
      mergeableState: prBody.mergeable_state,
      mergeCommitSha: prBody.merge_commit_sha,
      headMatchesAccepted: !!(prBody.head && prBody.head.sha === entry.acceptedSha),
    } : { error: errText(facts.pr) },
    main: {
      defaultBranch: repoMeta ? repoMeta.default_branch : 'main',
      sha: mainBranch && mainBranch.commit ? mainBranch.commit.sha : null,
      protection: facts.protectionFacts,
      tokenPermissions: repoMeta && repoMeta.permissions ? repoMeta.permissions : null,
    },
    acceptedInMain: facts.acceptedInMain,
  };
  if (prBody && prBody.merged === true) {
    record.mergeTrace = {
      mergeCommitSha: prBody.merge_commit_sha,
      acceptedToMerge: facts.acceptedToMerge || { state: 'unknown', detail: 'not fetched' },
      mergeToMain: facts.mergeToMain || { state: 'unknown', detail: 'not fetched' },
    };
  }
  if (record.prState.headMatchesAccepted === false && facts.drift) {
    record.drift = ok(facts.drift) ? describeDrift(facts.drift) : { status: 'unknown', error: errText(facts.drift) };
  }
  if (facts.requiredEvidence) {
    record.evidence = {
      required: facts.evidenceSpec ? {
        workflow: facts.evidenceSpec.workflow, jobs: facts.evidenceSpec.jobs,
      } : null,
      state: facts.requiredEvidence.state,
      detail: facts.requiredEvidence.detail
        || (facts.requiredEvidence.via && facts.requiredEvidence.via.detail) || null,
      via: facts.requiredEvidence.via || null,
      perRun: facts.requiredEvidence.perRun || [],
      evaluatedRunIds: facts.requiredEvidence.evaluatedRunIds || [],
      runs: facts.runs ? {
        truncated: !!facts.runs.truncated,
        inventory: facts.runs.inventory || null,
        rerunDetected: facts.runs.rerunDetected,
        notes: facts.runs.notes,
        incomplete: facts.runs.incomplete,
        failed: facts.runs.failed,
        runs: facts.runs.runs,
      } : null,
    };
    record.protectionRequirements = facts.protectionRequirements;
  }
  return record;
}

function carriedInputRecord(input, api) {
  const { repo, carriedBy } = input;
  const facts = { pr: null, containment: null };
  facts.pr = api(`/repos/${repo}/pulls/${input.pr}`);
  const prBody = ok(facts.pr) ? facts.pr.body : null;
  if (prBody && prBody.head && carriedBy.head) {
    facts.containment = api(`/repos/${repo}/compare/${prBody.head.sha}...${carriedBy.head}`);
  }
  const containment = facts.containment;
  const contained = containedFromCompare(containment);
  let status;
  if (!prBody) status = 'insufficient-info';
  else if (prBody.merged) status = 'merged';
  else if (contained === 'contained') status = 'contained-by-integration-head';
  else if (contained === 'not-contained') status = 'not-contained-in-integration-head';
  else status = 'insufficient-info';
  return {
    repo,
    pr: input.pr,
    title: prBody ? prBody.title : null,
    state: prBody ? prBody.state : null,
    merged: prBody ? prBody.merged : null,
    head: prBody && prBody.head ? { ref: prBody.head.ref, sha: prBody.head.sha } : null,
    integrationHead: carriedBy.head,
    containedInIntegrationHead: contained,
    containmentDetail: containment && containment.body
      ? `status=${containment.body.status} ahead_by=${containment.body.ahead_by} behind_by=${containment.body.behind_by}`
      : ((containment && containment.error) || 'not fetched'),
    status,
  };
}

// ---------------------------------------------------------------------------
// Configuration validation. Invalid/empty config is rejected — never silently
// treated as "zero candidates, everything fine".
// ---------------------------------------------------------------------------
function validateConfig(config) {
  const problems = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError('invalid preflight config: expected an object');
  }
  const candidates = config.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new ConfigError('invalid preflight config: candidates must be a non-empty array');
  }
  const seen = new Set();
  candidates.forEach((c, i) => {
    const at = `candidates[${i}]`;
    if (!c || typeof c !== 'object') { problems.push(`${at} must be an object`); return; }
    if (typeof c.repo !== 'string' || !c.repo.includes('/')) problems.push(`${at}.repo must be "owner/repo"`);
    if (!Number.isInteger(c.pr) || c.pr <= 0) problems.push(`${at}.pr must be a positive integer`);
    if (typeof c.acceptedSha !== 'string' || !SHA_RE.test(c.acceptedSha)) problems.push(`${at}.acceptedSha must be a 40-hex commit SHA`);
    if (c.baseBranch !== undefined && (typeof c.baseBranch !== 'string' || !c.baseBranch)) problems.push(`${at}.baseBranch must be a non-empty string when present`);
    if (typeof c.repo === 'string' && Number.isInteger(c.pr)) {
      const key = `${c.repo}#${c.pr}`;
      if (seen.has(key)) problems.push(`duplicate candidate ${key}`);
      seen.add(key);
    }
  });
  const ci = config.ciEvidence;
  if (!ci || typeof ci !== 'object' || Array.isArray(ci)) {
    problems.push('ciEvidence must map each candidate repo to {workflow, jobs} — the required verification evidence is explicit, never inferred');
  } else {
    for (const c of candidates) {
      if (!c || typeof c.repo !== 'string') continue;
      const spec = ci[c.repo];
      if (!spec || typeof spec !== 'object'
        || typeof spec.workflow !== 'string' || !spec.workflow
        || !Array.isArray(spec.jobs) || spec.jobs.length === 0
        || !spec.jobs.every((j) => typeof j === 'string' && j)) {
        problems.push(`ciEvidence[${c.repo}] must be {workflow: non-empty string, jobs: [non-empty string, ...]}`);
      }
    }
  }
  if (config.carriedInputs) {
    const ci2 = config.carriedInputs;
    if (typeof ci2.repo !== 'string' || !ci2.repo.includes('/')) problems.push('carriedInputs.repo must be "owner/repo"');
    if (!ci2.carriedBy || !SHA_RE.test(ci2.carriedBy.head || '')) problems.push('carriedInputs.carriedBy.head must be a 40-hex commit SHA');
    if (!Array.isArray(ci2.prs) || !ci2.prs.every((n) => Number.isInteger(n) && n > 0)) problems.push('carriedInputs.prs must be positive integers');
  }
  if (problems.length) {
    throw new ConfigError(`invalid preflight config:\n  - ${problems.join('\n  - ')}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregation — the single source for verdict, summary lists, and exit code.
// ---------------------------------------------------------------------------
function aggregateVerdict(statuses) {
  if (statuses.length === 0) {
    return { verdict: 'insufficient-info', exitCode: 2 }; // defensive; validateConfig rejects empty
  }
  const inSet = (set) => statuses.some((s) => set.has(s));
  if (inSet(FAMILIES.unknown)) return { verdict: 'insufficient-info', exitCode: 2 };
  if (inSet(FAMILIES.pending) || inSet(FAMILIES.blocked)) return { verdict: 'blocked', exitCode: 1 };
  if (statuses.every((s) => FAMILIES.landed.has(s))) return { verdict: 'landed', exitCode: 0 };
  if (statuses.every((s) => s === STATUS.READY)) return { verdict: 'ready', exitCode: 0 };
  return { verdict: 'continue', exitCode: 0 }; // ready+landed mix, no gaps
}

function buildReport(config, api, now) {
  validateConfig(config);
  const candidates = (config.candidates || []).map((c) => candidateRecord(c, config, api));
  const carriedInputs = config.carriedInputs && config.carriedInputs.prs
    ? config.carriedInputs.prs.map((n) => carriedInputRecord({
      repo: config.carriedInputs.repo,
      carriedBy: config.carriedInputs.carriedBy,
      pr: n,
    }, api))
    : [];
  const by = (family) => candidates.filter((c) => c.family === family)
    .map((c) => `${c.repo}#${c.pr}: ${c.status}`);
  const { verdict, exitCode } = aggregateVerdict(candidates.map((c) => c.status));
  return {
    schema: 'm4a-mainline-preflight/v2',
    generatedAt: now || new Date().toISOString(),
    readonly: true,
    transport: 'gh api (GET only)',
    evidencePolicy: 'explicit per-repo ciEvidence config; missing/unknown/skipped evidence is never ready',
    summary: {
      verdict,
      exitCode,
      ready: by('ready'),
      landed: by('landed'),
      pending: by('pending'),
      blocked: by('blocked'),
      undetermined: by('unknown'),
    },
    candidates,
    carriedInputs,
  };
}

// The exit code derives from the aggregated verdict only — it can never
// disagree with what the summary reports.
function exitCodeFor(report) {
  return report.summary.exitCode;
}

// ---------------------------------------------------------------------------
// Rendering + CLI.
// ---------------------------------------------------------------------------
const STATUS_MARK = {
  'ready': 'READY',
  'landed-traceable': 'LANDED (traceable: accepted->merge->main)',
  'landed-other-route': 'LANDED (accepted already in main)',
  'ci-pending': 'NOT READY (CI pending)',
  'ci-failed': 'BLOCKED (CI failed)',
  'head-drifted': 'BLOCKED (head drifted)',
  'base-mismatch': 'BLOCKED (PR base != target)',
  'conflict': 'BLOCKED (conflict / unsatisfied requirements)',
  'merge-blocked': 'BLOCKED (GitHub reports the merge blocked — protection requirements unmet)',
  'closed-unmerged': 'NOT LANDABLE (closed without merge)',
  'draft': 'NOT LANDABLE (draft)',
  'merged-untraceable': 'BLOCKED (landing not traceable in current main)',
  'insufficient-info': 'UNKNOWN (insufficient evidence — refused, not passed)',
};

function renderText(report) {
  const lines = [];
  lines.push(`m4a-mainline-preflight v2 — ${report.generatedAt} (read-only, live GitHub state)`);
  lines.push(`evidence policy: ${report.evidencePolicy}`);
  lines.push('');
  for (const c of report.candidates) {
    lines.push(`[${c.repo.replace('boccchi2993/', '')} #${c.pr}] ${STATUS_MARK[c.status] || c.status}`);
    if (c.prState && !c.prState.error) {
      const p = c.prState;
      lines.push(`  head ${p.head ? `${p.head.ref} @ ${String(p.head.sha).slice(0, 12)}` : '?'} | accepted ${String(c.acceptedSha).slice(0, 12)} | match=${p.headMatchesAccepted} | base ${p.base ? p.base.ref : '?'} == target ${c.targetBranch}: ${p.baseMatchesTarget}`);
      lines.push(`  state=${p.state} merged=${p.merged} draft=${p.draft} mergeable=${p.mergeable} (${p.mergeableState})`);
    } else {
      lines.push(`  PR unreadable: ${c.prState.error}`);
    }
    if (c.main) {
      const prot = c.main.protection || {};
      lines.push(`  main ${String(c.main.sha || '?').slice(0, 12)} | protection=${prot.state}${prot.requiredStatusChecks ? ` requiredChecks=${JSON.stringify(prot.requiredStatusChecks.contexts)}` : ''}`);
      lines.push(`  accepted in main: ${c.acceptedInMain.state}${c.acceptedInMain.detail ? ` (${c.acceptedInMain.detail})` : ''}`);
    }
    if (c.mergeTrace) {
      lines.push(`  merge trace: accepted->merge ${c.mergeTrace.acceptedToMerge.state}; merge->main ${c.mergeTrace.mergeToMain.state}`);
    }
    if (c.drift) {
      lines.push(`  drift: ${c.drift.status} +${c.drift.aheadBy ?? '?'}/-${c.drift.behindBy ?? '?'} commits, files=${c.drift.files ?? '?'}`);
    }
    if (c.evidence) {
      const e = c.evidence;
      lines.push(`  required evidence: ${e.state}${e.detail ? ` — ${e.detail}` : ''}`);
      const ev = e.evaluatedRunIds || [];
      const inv = e.runs && e.runs.inventory;
      lines.push(`  runs evaluated: ${ev.length ? ev.join(', ') : 'none'}`
        + (inv && inv.complete === false && inv.reason ? ` — inventory incomplete: ${inv.reason}` : ''));
      const r = e.runs;
      if (r) {
        const det = [
          r.failed.length && `failed: ${r.failed.map((f) => `${f.name}#${f.id} ${f.conclusion}`).join('; ')}`,
          r.incomplete.length && `pending: ${r.incomplete.map((f) => `${f.name}#${f.id} ${f.status}`).join('; ')}`,
          r.truncated && 'RUN LIST TRUNCATED',
        ].filter(Boolean).join(' | ');
        lines.push(`  runs: rerunDetected=${r.rerunDetected}${det ? ` — ${det}` : ''}`);
        for (const n of r.notes) lines.push(`    · ${n}`);
      }
      if (c.protectionRequirements) {
        lines.push(`  protection requirements: ${c.protectionRequirements.state}${c.protectionRequirements.detail ? ` — ${c.protectionRequirements.detail}` : ''}`);
      }
    }
    for (const u of c.unknowns) lines.push(`  ? unknown: ${u}`);
    for (const r of c.reasons) lines.push(`  → ${r}`);
    lines.push('');
  }
  if (report.carriedInputs.length) {
    lines.push('Product integration inputs (are they already carried by the integration head?):');
    for (const i of report.carriedInputs) {
      lines.push(`  #${i.pr} ${i.title ? `"${String(i.title).slice(0, 60)}"` : ''} state=${i.state} merged=${i.merged} → ${i.status}`);
      lines.push(`    head ${i.head ? `${i.head.ref} @ ${String(i.head.sha).slice(0, 12)}` : '?'} vs integration head ${String(i.integrationHead).slice(0, 12)}: containment=${i.containedInIntegrationHead} (${i.containmentDetail})`);
    }
    lines.push('');
  }
  const s = report.summary;
  lines.push(`verdict: ${s.verdict} (exit ${s.exitCode})`);
  for (const key of ['ready', 'landed', 'pending', 'blocked', 'undetermined']) {
    for (const item of s[key]) lines.push(`  ${key}: ${item}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { json: false, config: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else { args.help = true; args.unknownArg = a; }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'Usage: node scripts/m4a-mainline-preflight.cjs [--json] [--out FILE] [--config FILE]',
      '',
      'Read-only live audit of the M4a mainline candidates. GET-only GitHub',
      ' access via the `gh` CLI. Refuses "ready" on missing/unknown evidence.',
      'Exit 0 = ready/landed/continue, 1 = blocked, 2 = insufficient info,',
      ' 3 = invalid configuration.',
      '',
    ].join('\n'));
    return 0;
  }
  let report;
  try {
    let config = DEFAULT_CONFIG;
    if (args.config) {
      const { readFileSync } = require('fs');
      config = JSON.parse(readFileSync(args.config, 'utf8'));
    }
    report = buildReport(config, ghApiAdapter());
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 3;
    }
    process.stderr.write(`preflight failed: ${err && err.stack || err}\n`);
    return 2;
  }
  const json = JSON.stringify(report, null, 2);
  if (args.out) {
    const { writeFileSync } = require('fs');
    writeFileSync(args.out, json + '\n');
  }
  if (args.json) {
    process.stdout.write(json + '\n');
  } else {
    process.stdout.write(renderText(report) + '\n');
    if (args.out) process.stdout.write(`(JSON written to ${args.out})\n`);
  }
  return exitCodeFor(report);
}

module.exports = {
  DEFAULT_CONFIG,
  STATUS,
  FAMILIES,
  ConfigError,
  validateConfig,
  buildReport,
  classifyCandidate,
  summarizeRuns,
  evaluateRequiredEvidence,
  evaluateProtectionRequirements,
  summarizeProtection,
  containedFromCompare,
  describeDrift,
  aggregateVerdict,
  renderText,
  ghApiAdapter,
  parseArgs,
  exitCodeFor,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
