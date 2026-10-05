#!/usr/bin/env node
// M4a-C: read-only preflight for landing the three-repo mainline
// (locus-runtime / locus-harness / locus-product).
//
// For each configured (repo, PR, accepted SHA) candidate it answers, from the
// LIVE GitHub state:
//   - is the PR merged, and is the accepted SHA traceable in main?
//   - does the PR head still equal the accepted SHA (else: drift scope)?
//   - is the merge clean or conflicting?
//   - what did CI conclude on that exact head (including rerun evidence)?
//   - are branch protection rules in force on main?
// It also checks whether the Product integration-input PRs (#1–#4) are already
// carried by the integration head, i.e. whether they need separate merges.
//
// READ-ONLY CONTRACT: every network call is a GET issued through the `gh` CLI
// with no method/field flags. The script never merges, comments, labels, or
// updates refs/releases. The injected-adapter seam (buildReport(config, api))
// is what tests use; the default adapter wraps `gh api <path>` only.
//
// Usage:
//   node scripts/m4a-mainline-preflight.cjs                 # text summary
//   node scripts/m4a-mainline-preflight.cjs --json          # machine JSON
//   node scripts/m4a-mainline-preflight.cjs --out report.json
//   node scripts/m4a-mainline-preflight.cjs --config my.json
//
// Exit code: 0 = every candidate is ready or landed; 1 = a concrete blocker
// (drift / CI failed or pending / conflict / untraceable merge); 2 = some
// state could not be determined (insufficient info / transport failure).

'use strict';

const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Verified candidate set for the M4a mainline rollout (the reviewed, accepted
// heads). Override with --config; the shape is the same JSON.
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  // Core + integration PRs that should land on their repos' main.
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
  // Product integration inputs: the work was cherry-picked into the
  // integration head, so these PRs' exact commits are NOT ancestors of it.
  // The preflight reports the factual containment so the rollout can state
  // whether each input still needs a separate merge (it must not guess).
  carriedInputs: {
    repo: 'boccchi2993/locus-product',
    carriedBy: { pr: 5, head: 'd6a74a25a2b98293d9aa1f2a635022d8f5ed733b' },
    prs: [1, 2, 3, 4],
  },
};

const CLASSIFICATIONS = {
  READY: 'ready-to-merge',
  MERGED_TRACEABLE: 'merged-traceable',
  MERGED_UNTRACEABLE: 'merged-untraceable',
  ALREADY_IN_MAIN: 'already-in-main',
  HEAD_DRIFTED: 'head-drifted',
  CONFLICT: 'conflict',
  CI_PENDING: 'ci-pending',
  CI_FAILED: 'ci-failed',
  INSUFFICIENT: 'insufficient-info',
};

const LANDED = new Set([
  CLASSIFICATIONS.MERGED_TRACEABLE,
  CLASSIFICATIONS.ALREADY_IN_MAIN,
]);
const BLOCKING = new Set([
  CLASSIFICATIONS.HEAD_DRIFTED,
  CLASSIFICATIONS.CONFLICT,
  CLASSIFICATIONS.CI_PENDING,
  CLASSIFICATIONS.CI_FAILED,
  CLASSIFICATIONS.MERGED_UNTRACEABLE,
]);
// Anything else (insufficient-info) is undetermined, not a proven blocker.

const DRIFT_COMMIT_CAP = 20;

// ---------------------------------------------------------------------------
// Transport adapters. api(path) -> {status, body, error}; status is the HTTP
// status code (0 = transport-level failure), body is parsed JSON or null.
// ---------------------------------------------------------------------------

// Default adapter: the `gh` CLI. GET only — the spawned argv is exactly
// ['api', path] with no method/field flags (test pins this byte-for-byte).
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

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested with fake API responses).
// ---------------------------------------------------------------------------

function ok(res) { return res && res.status === 200 && res.body; }

// compare API status -> is `base` commit an ancestor of `head` commit?
// (compare/{base}...{head}: "ahead" = head contains base; "identical" = same.)
function containedFromCompare(cmp) {
  if (!cmp || !cmp.body) return 'unknown';
  const s = cmp.body.status;
  if (s === 'ahead' || s === 'identical') return 'contained';
  if (s === 'behind' || s === 'diverged') return 'not-contained';
  return 'unknown';
}

// CI runs for one head SHA -> factual status + rerun evidence.
// Runs rows carry the LATEST attempt's conclusion only; run_attempt > 1 is
// the runs-API evidence that a rerun happened (the failed first attempt's
// conclusion is not in this endpoint — it lives in the run's page/logs).
function summarizeCi(runsBody, headSha) {
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
  const failedConclusions = ['failure', 'timed_out', 'cancelled', 'action_required'];
  const failed = runs.filter((r) => failedConclusions.includes(r.conclusion));
  const rerunDetected = runs.some((r) => (r.runAttempt || 1) > 1);
  let status;
  if (incomplete.length) status = 'pending';
  else if (failed.length) status = 'failed';
  else if (runs.length) status = 'success';
  else status = 'none'; // no workflow run recorded for this head
  const notes = [];
  if (status === 'failed' && rerunDetected) {
    notes.push('still failing after a rerun (latest attempt recorded above)');
  } else if (status === 'success' && rerunDetected) {
    notes.push('green on a rerun; the first attempt conclusion is not in the runs API');
  } else if (status === 'failed') {
    notes.push('failed with no rerun recorded');
  } else if (status === 'none') {
    notes.push('no CI run for this head (workflow absent or not triggered)');
  }
  return { status, rerunDetected, notes, incomplete, failed, runs };
}

// Protection rules for a repo's default branch. Permission gaps stay
// "unknown" — the script never assumes absence from a 403.
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
    // Definitive "not protected" only when the branch itself was readable.
    if (branchProtected === false) {
      return { state: 'not-protected', branchProtected, requiredStatusChecks: null, requiredReviews: null };
    }
    return { state: 'unknown', branchProtected, requiredStatusChecks: null, requiredReviews: null,
      note: 'protection endpoint 404 while branch readability unconfirmed' };
  }
  const note = protectionRes && protectionRes.status === 403
    ? 'permission denied reading protection rules; not assuming absence'
    : ((protectionRes && protectionRes.error) || 'protection unreadable');
  return { state: 'unknown', branchProtected, requiredStatusChecks: null, requiredReviews: null, note };
}

function describeDrift(cmp) {
  if (!cmp || !cmp.body) return { status: 'unknown', error: (cmp && cmp.error) || 'no compare body' };
  const b = cmp.body;
  const commits = (b.commits || []).slice(0, DRIFT_COMMIT_CAP).map((c) => ({
    sha: c.sha,
    message: String(c.commit && c.commit.message || '').split('\n')[0],
  }));
  return {
    status: b.status,
    aheadBy: b.ahead_by, // commits on the PR head that accepted lacks
    behindBy: b.behind_by, // commits on accepted that the PR head lacks
    totalCommits: b.total_commits,
    files: (b.files || []).length,
    fileList: (b.files || []).slice(0, DRIFT_COMMIT_CAP).map((f) => `${f.status}:${f.filename}`),
    commits,
    truncated: (b.commits || []).length > DRIFT_COMMIT_CAP
      || (b.files || []).length > DRIFT_COMMIT_CAP,
  };
}

function asContainment(res) {
  if (!res) return { state: 'unknown', detail: 'not fetched' };
  if (!ok(res)) return { state: 'unknown', detail: res.error || `HTTP ${res.status}` };
  const b = res.body;
  return {
    state: containedFromCompare(res),
    detail: `status=${b.status} ahead_by=${b.ahead_by} behind_by=${b.behind_by}`,
  };
}

// Classification of one candidate from already-fetched facts.
// facts: {pr, repoMeta, mainBranch, protection, acceptedInMain, headInMain,
//         drift, ci} — each a {ok, body, error} flavored record or null.
function classifyCandidate(facts) {
  const reasons = [];
  if (!ok(facts.pr)) {
    reasons.push(`PR not readable: ${(facts.pr && (facts.pr.error || `HTTP ${facts.pr.status}`)) || 'no data'}`);
    return { classification: CLASSIFICATIONS.INSUFFICIENT, reasons };
  }
  const pr = facts.pr.body;
  const headSha = pr.head && pr.head.sha;
  const acceptedSha = facts.acceptedSha;
  const headMatchesAccepted = headSha === acceptedSha;

  if (pr.merged === true) {
    const mergedState = facts.mergedInMain || { state: 'unknown' };
    if (mergedState.state === 'contained') {
      reasons.push(`merged (merge commit ${(pr.merge_commit_sha || '').slice(0, 12)}) and accepted SHA is an ancestor of the merge commit`);
      return { classification: CLASSIFICATIONS.MERGED_TRACEABLE, reasons };
    }
    if (facts.acceptedInMain && facts.acceptedInMain.state === 'contained') {
      reasons.push('PR shows merged but the accepted SHA reached main by another route; merge commit ancestry unverified');
      return { classification: CLASSIFICATIONS.MERGED_TRACEABLE, reasons };
    }
    if (mergedState.state === 'unknown'
      && (!facts.acceptedInMain || facts.acceptedInMain.state === 'unknown')) {
      reasons.push(`merged but traceability could not be read: ${mergedState.detail || 'compare unavailable'}`);
      return { classification: CLASSIFICATIONS.INSUFFICIENT, reasons };
    }
    reasons.push(`merged but accepted SHA is not traceable in main (${mergedState.detail || mergedState.state}) — squash/rebase merge or force-push suspected; content equivalence unproven`);
    return { classification: CLASSIFICATIONS.MERGED_UNTRACEABLE, reasons };
  }

  if (facts.acceptedInMain && facts.acceptedInMain.state === 'contained') {
    reasons.push('PR still open, but the accepted SHA is already an ancestor of main (landed by another route)');
    return { classification: CLASSIFICATIONS.ALREADY_IN_MAIN, reasons };
  }

  if (!headMatchesAccepted) {
    reasons.push(`head ${String(headSha || '?').slice(0, 12)} != accepted ${String(acceptedSha || '?').slice(0, 12)}`);
    if (ok(facts.drift)) {
      const d = describeDrift(facts.drift);
      reasons.push(`drift scope: ${d.status}, +${d.aheadBy}/-${d.behindBy} commits, ${d.files} files${d.truncated ? ' (truncated list)' : ''}`);
    } else {
      reasons.push(`drift scope unknown: ${(facts.drift && facts.drift.error) || 'compare unavailable'}`);
    }
    return { classification: CLASSIFICATIONS.HEAD_DRIFTED, reasons };
  }

  if (pr.draft === true) {
    reasons.push('PR is a draft');
    return { classification: CLASSIFICATIONS.INSUFFICIENT, reasons };
  }
  if (pr.mergeable === false || pr.mergeable_state === 'dirty') {
    reasons.push(`merge conflict (mergeable=${pr.mergeable}, state=${pr.mergeable_state})`);
    return { classification: CLASSIFICATIONS.CONFLICT, reasons };
  }
  if (pr.mergeable_state === 'blocked') {
    reasons.push('merge blocked by branch requirements (mergeable_state=blocked)');
    return { classification: CLASSIFICATIONS.INSUFFICIENT, reasons };
  }

  if (!facts.ci || !facts.ci.ok) {
    reasons.push(`CI runs unreadable: ${(facts.ci && facts.ci.error) || 'no data'}`);
    return { classification: CLASSIFICATIONS.INSUFFICIENT, reasons };
  }
  const ci = facts.ci;
  if (ci.status === 'pending') {
    reasons.push(`CI incomplete: ${ci.incomplete.map((r) => `${r.name} (${r.status})`).join(', ')}`);
    return { classification: CLASSIFICATIONS.CI_PENDING, reasons };
  }
  if (ci.status === 'failed') {
    reasons.push(`CI failed: ${ci.failed.map((r) => `${r.name} run ${r.id} (${r.conclusion})`).join(', ')}`);
    for (const n of ci.notes) reasons.push(n);
    return { classification: CLASSIFICATIONS.CI_FAILED, reasons };
  }
  if (ci.status === 'unknown') {
    reasons.push('CI state undetermined');
    return { classification: CLASSIFICATIONS.INSUFFICIENT, reasons };
  }
  if (ci.status === 'none') {
    reasons.push('no CI run for this head — treating as landable by policy, noted for the record');
    return { classification: CLASSIFICATIONS.READY, reasons };
  }
  reasons.push(`CI green on the accepted head (${ci.runs.map((r) => `${r.name}/${r.event} run ${r.id}${r.runAttempt > 1 ? ` attempt ${r.runAttempt}` : ''}`).join(', ')})`);
  if (pr.mergeable === true) reasons.push(`mergeable (state=${pr.mergeable_state})`);
  return { classification: CLASSIFICATIONS.READY, reasons };
}

// ---------------------------------------------------------------------------
// Orchestration: fetch live facts, then classify. api is injectable (tests).
// ---------------------------------------------------------------------------
function fetchCandidateFacts(config_entry, api) {
  const { repo, pr: prNumber, acceptedSha } = config_entry;
  const facts = { acceptedSha, pr: null, repoMeta: null, mainBranch: null,
    protection: null, acceptedInMain: null, mergedInMain: null,
    drift: null, ci: null };

  facts.pr = api(`/repos/${repo}/pulls/${prNumber}`);
  const prBody = ok(facts.pr) ? facts.pr.body : null;
  facts.repoMeta = api(`/repos/${repo}`);
  const defaultBranch = ok(facts.repoMeta)
    ? facts.repoMeta.body.default_branch
    : 'main';

  facts.mainBranch = api(`/repos/${repo}/branches/${defaultBranch}`);
  facts.protection = api(`/repos/${repo}/branches/${defaultBranch}/protection`);
  const mainSha = ok(facts.mainBranch) ? facts.mainBranch.body.commit.sha : null;

  if (mainSha && acceptedSha) {
    facts.acceptedInMain = asContainment(api(`/repos/${repo}/compare/${acceptedSha}...${mainSha}`));
  }
  if (prBody && prBody.merged === true && prBody.merge_commit_sha) {
    // Traceability of the ACCEPTED content through the actual merge commit.
    facts.mergedInMain = asContainment(api(`/repos/${repo}/compare/${acceptedSha}...${prBody.merge_commit_sha}`));
  }
  if (prBody && prBody.head && prBody.head.sha
    && prBody.head.sha !== acceptedSha) {
    facts.drift = api(`/repos/${repo}/compare/${acceptedSha}...${prBody.head.sha}`);
  }
  if (prBody && prBody.head && prBody.head.sha) {
    facts.ciRaw = api(`/repos/${repo}/actions/runs?head_sha=${prBody.head.sha}&per_page=50`);
    facts.ci = ok(facts.ciRaw)
      ? summarizeCi(facts.ciRaw.body, prBody.head.sha)
      : { ok: false, error: (facts.ciRaw && facts.ciRaw.error) || `HTTP ${facts.ciRaw && facts.ciRaw.status}`, status: 'unknown' };
    if (facts.ci && facts.ci.ok !== false) facts.ci.ok = true;
  }
  return facts;
}

function candidateRecord(entry, api) {
  const facts = fetchCandidateFacts(entry, api);
  const { classification, reasons } = classifyCandidate(facts);
  const prBody = ok(facts.pr) ? facts.pr.body : null;
  const mainBranch = ok(facts.mainBranch) ? facts.mainBranch.body : null;
  const repoMeta = ok(facts.repoMeta) ? facts.repoMeta.body : null;
  const record = {
    repo: entry.repo,
    pr: entry.pr,
    acceptedSha: entry.acceptedSha,
    classification,
    reasons,
    prState: prBody ? {
      state: prBody.state,
      merged: prBody.merged,
      draft: prBody.draft || false,
      title: prBody.title,
      head: prBody.head ? { ref: prBody.head.ref, sha: prBody.head.sha } : null,
      base: prBody.base ? { ref: prBody.base.ref, sha: prBody.base.sha } : null,
      mergeable: prBody.mergeable,
      mergeableState: prBody.mergeable_state,
      mergeCommitSha: prBody.merge_commit_sha,
      headMatchesAccepted: !!(prBody.head && prBody.head.sha === entry.acceptedSha),
    } : { error: (facts.pr && facts.pr.error) || 'unreadable' },
    main: {
      defaultBranch: repoMeta ? repoMeta.default_branch : 'main',
      sha: mainBranch && mainBranch.commit ? mainBranch.commit.sha : null,
      protection: summarizeProtection(facts.mainBranch, facts.protection),
      tokenPermissions: repoMeta && repoMeta.permissions ? repoMeta.permissions : null,
    },
    acceptedInMain: facts.acceptedInMain || { state: 'unknown', detail: 'not fetched' },
    ci: facts.ci && facts.ci.ok ? {
      status: facts.ci.status,
      rerunDetected: facts.ci.rerunDetected,
      notes: facts.ci.notes,
      failed: facts.ci.failed,
      incomplete: facts.ci.incomplete,
      runs: facts.ci.runs,
    } : { status: 'unknown', error: (facts.ci && facts.ci.error) || 'not fetched' },
  };
  if (record.prState.headMatchesAccepted === false && facts.drift) {
    record.drift = ok(facts.drift) ? describeDrift(facts.drift) : { status: 'unknown', error: facts.drift.error };
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
  let classification;
  if (!prBody) classification = 'insufficient-info';
  else if (prBody.merged) classification = 'merged';
  else if (contained === 'contained') classification = 'contained-by-integration-head';
  else if (contained === 'not-contained') classification = 'not-contained-in-integration-head';
  else classification = 'insufficient-info';
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
    classification,
  };
}

function buildReport(config, api, now) {
  const candidates = (config.candidates || []).map((c) => candidateRecord(c, api));
  const carriedInputs = config.carriedInputs && config.carriedInputs.prs
    ? config.carriedInputs.prs.map((n) => carriedInputRecord({
      repo: config.carriedInputs.repo,
      carriedBy: config.carriedInputs.carriedBy,
      pr: n,
    }, api))
    : [];
  const blockers = candidates.filter((c) => BLOCKING.has(c.classification));
  const undetermined = candidates.filter((c) => c.classification === CLASSIFICATIONS.INSUFFICIENT);
  const landableNow = candidates.filter((c) => c.classification === CLASSIFICATIONS.READY);
  const landed = candidates.filter((c) => LANDED.has(c.classification));
  return {
    schema: 'm4a-mainline-preflight/v1',
    generatedAt: now || new Date().toISOString(),
    readonly: true,
    transport: 'gh api (GET only)',
    summary: {
      landableNow: landableNow.map((c) => `${c.repo}#${c.pr}`),
      landed: landed.map((c) => `${c.repo}#${c.pr}`),
      blockers: blockers.map((c) => `${c.repo}#${c.pr}: ${c.classification}`),
      undetermined: undetermined.map((c) => `${c.repo}#${c.pr}`),
      verdict: undetermined.length ? 'insufficient-info'
        : (blockers.length || !landableNow.length) ? 'blocked' : 'ready',
    },
    candidates,
    carriedInputs,
  };
}

// ---------------------------------------------------------------------------
// Rendering + CLI.
// ---------------------------------------------------------------------------
const CLASS_MARK = {
  'ready-to-merge': 'READY',
  'merged-traceable': 'LANDED (traceable)',
  'merged-untraceable': 'BLOCKER (merged, untraceable)',
  'already-in-main': 'LANDED (already in main)',
  'head-drifted': 'BLOCKER (head drifted)',
  'conflict': 'BLOCKER (conflict)',
  'ci-pending': 'BLOCKER (CI pending)',
  'ci-failed': 'BLOCKER (CI failed)',
  'insufficient-info': 'UNKNOWN (insufficient info)',
};

function renderText(report) {
  const lines = [];
  lines.push(`m4a-mainline-preflight — ${report.generatedAt} (read-only, live GitHub state)`);
  lines.push('');
  for (const c of report.candidates) {
    lines.push(`[${c.repo.replace('boccchi2993/', '')} #${c.pr}] ${CLASS_MARK[c.classification] || c.classification}`);
    if (c.prState && !c.prState.error) {
      const p = c.prState;
      lines.push(`  head ${p.head ? `${p.head.ref} @ ${String(p.head.sha).slice(0, 12)}` : '?'} | accepted ${String(c.acceptedSha).slice(0, 12)} | match=${p.headMatchesAccepted}`);
      lines.push(`  state=${p.state} merged=${p.merged} mergeable=${p.mergeable} (${p.mergeableState})`);
    } else {
      lines.push(`  PR unreadable: ${c.prState.error}`);
    }
    if (c.main) {
      const prot = c.main.protection || {};
      lines.push(`  main ${String(c.main.sha || '?').slice(0, 12)} | protection=${prot.state}${prot.requiredStatusChecks ? ` requiredChecks=${JSON.stringify(prot.requiredStatusChecks.contexts)}` : ''}`);
      lines.push(`  accepted in main: ${c.acceptedInMain.state}${c.acceptedInMain.detail ? ` (${c.acceptedInMain.detail})` : ''}`);
    }
    if (c.drift) {
      lines.push(`  drift: ${c.drift.status} +${c.drift.aheadBy ?? '?'}/-${c.drift.behindBy ?? '?'} commits, files=${c.drift.files ?? '?'}`);
    }
    if (c.ci && c.ci.status) {
      const failed = (c.ci.failed || []).map((f) => `${f.name}#${f.id} ${f.conclusion}`).join('; ');
      const pend = (c.ci.incomplete || []).map((f) => `${f.name}#${f.id} ${f.status}`).join('; ');
      const det = [failed && `failed: ${failed}`, pend && `pending: ${pend}`].filter(Boolean).join(' | ');
      lines.push(`  CI: ${c.ci.status}${c.ci.rerunDetected ? ' (rerun detected)' : ''}${det ? ` — ${det}` : ''}`);
      for (const n of c.ci.notes || []) lines.push(`    · ${n}`);
    }
    for (const r of c.reasons) lines.push(`  → ${r}`);
    lines.push('');
  }
  if (report.carriedInputs.length) {
    lines.push('Product integration inputs (are they already carried by #5?):');
    for (const i of report.carriedInputs) {
      lines.push(`  #${i.pr} ${i.title ? `"${String(i.title).slice(0, 60)}"` : ''} state=${i.state} merged=${i.merged} → ${i.classification}`);
      lines.push(`    head ${i.head ? `${i.head.ref} @ ${String(i.head.sha).slice(0, 12)}` : '?'} vs integration head ${String(i.integrationHead).slice(0, 12)}: containment=${i.containedInIntegrationHead} (${i.containmentDetail})`);
    }
    lines.push('');
  }
  lines.push(`verdict: ${report.summary.verdict}`);
  if (report.summary.landableNow.length) lines.push(`  landable now: ${report.summary.landableNow.join(', ')}`);
  if (report.summary.landed.length) lines.push(`  landed (traceable): ${report.summary.landed.join(', ')}`);
  for (const b of report.summary.blockers) lines.push(`  blocker: ${b}`);
  for (const u of report.summary.undetermined) lines.push(`  undetermined: ${u}`);
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

// Exit-code contract: 0 all ready/landed; 1 concrete blockers; 2 undetermined.
function exitCodeFor(report) {
  const hasUnknown = report.candidates.some((c) => c.classification === CLASSIFICATIONS.INSUFFICIENT);
  const hasBlocker = report.candidates.some((c) => BLOCKING.has(c.classification));
  const allSettled = report.candidates.every((c) => LANDED.has(c.classification)
    || c.classification === CLASSIFICATIONS.READY);
  return allSettled ? 0 : (hasUnknown ? 2 : (hasBlocker ? 1 : 2));
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'Usage: node scripts/m4a-mainline-preflight.cjs [--json] [--out FILE] [--config FILE]',
      '',
      'Read-only live audit of the M4a mainline candidates. GET-only GitHub',
      " access via the `gh` CLI. Exit 0 = all candidates ready/landed,",
      ' 1 = concrete blockers, 2 = insufficient information.',
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
  CLASSIFICATIONS,
  buildReport,
  classifyCandidate,
  summarizeCi,
  summarizeProtection,
  containedFromCompare,
  describeDrift,
  renderText,
  ghApiAdapter,
  parseArgs,
  exitCodeFor,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
