# M4a Review Round C — preflight refuses `ready` without evidence

Round: M4a first-review fix C, parallel with fix A. Scope honored: only
`scripts/m4a-mainline-preflight.cjs`, `tests/m4a-mainline-preflight.test.cjs`,
`docs/M4A-C-MAINLINE-ROLLOUT.md` (§0 revision banner), and this record were
touched. Candidate tooling (`scripts/core-main-candidate.mjs` et al.),
workflows, production code, dependency locks, and `tests/run-unit.cjs` are
unmodified. **No PR was merged, no CI rerun, no protection change, no GitHub
write beyond pushing this branch and opening this round's PR.** PR #9 body
untouched.

Baseline: `refactor/m4a-integration` @ `da5bb09526e61e75925c44cba8907257398eaf56`
(verified == remote branch head and == PR #9 head before starting; my three
files at that baseline are byte-identical to the PR #7 revision `d645fd1a`).
No AGENTS.md exists in locus-product @ `da5bb09` (checked live: 404).
Worktree: `Locus-product-m4a-review-c`, branch `fix/m4a-review-preflight`.

## 1. Status table (the contract the classifier implements)

| status | family | meaning |
|---|---|---|
| `ready` | ready | open, non-draft; head == accepted; PR base == configured target (`main`); mergeable **explicitly** true; main facts readable; protection known (and satisfied/checked if rules exist); CI satisfies the **explicit per-repo evidence config** |
| `landed-traceable` | landed | merged AND accepted→mergeCommit **AND** mergeCommit→current-main both proven (or accepted already in current main) |
| `landed-other-route` | landed | unmerged, accepted already an ancestor of current main |
| `ci-pending` | pending | required-workflow run still executing (never success, even if a sibling run passed) |
| `ci-failed` | blocked | a required job explicitly failed on a run of the required workflow; **stands until its own run is rerun** — a green sibling run does not supersede it |
| `head-drifted` / `base-mismatch` / `conflict` / `closed-unmerged` / `draft` / `merged-untraceable` | blocked | explicit non-landable states, each with reasons |
| `insufficient-info` | unknown | any required evidence missing/unreadable/unexplainable: no CI runs, unreadable runs, `mergeable=null`, protection 403/unexplainable, truncated lists, workflow shape ≠ config, unreadable compares |

Aggregation (single source — `aggregateVerdict`): any unknown → verdict
`insufficient-info`, exit **2**, never overall ready; else any
blocked/pending → `blocked`, exit **1**; else all landed → `landed` (0); all
ready → `ready` (0); ready+landed mix → `continue` (0). `summary.verdict`,
`summary.exitCode`, the text render, and the process exit code all derive
from that one aggregation. Empty/illegal config → `ConfigError`, CLI exit
**3** (no `every([])` success path).

"Giving GitHub's merge rules the green light" (mergeable/protection) and
"the project-required verification actually ran successfully" (evidence
configuration) are two independent gates; both must hold for `ready`, and a
branch that is readable and unprotected does **not** waive the second gate.

## 2. Reproduced defects and first-failure evidence

Driver: `locus-m4a-review-c-tmp/first-fail.cjs` (outside the repo; asserts
the DESIRED behavior against an implementation copy). Against the v1
implementation (`old-preflight.cjs` = the version at `da5bb09`), all seven
reproduced (`first-fail-old.log`, quoted verbatim):

```
FAIL bug1 no CI runs -> insufficient (not ready)
  -> old classification was ready-to-merge
FAIL bug2 closed unmerged -> explicit not-landable (not ready)
  -> old classification was ready-to-merge
FAIL bug3 mergeable null -> insufficient (not ready)
  -> old classification was ready-to-merge
FAIL bug4 all jobs skipped -> not success evidence
  -> old classification was ready-to-merge
FAIL bug5 merge commit absent from current main -> not landed-traceable
  -> old classification was merged-traceable
FAIL bug6 all candidates landed -> verdict landed + exit 0, consistent
  -> old verdict was blocked
FAIL bug7 protection unreadable (403) -> not ready
  -> old classification was ready-to-merge
first-fail vs OLD implementation: 0 already-good, 7 reproduced defects
```

Against the fixed implementation the same driver is 7/7 PASS
(`first-fail-new.log`).

An eighth defect was caught **during this round's own live verification** and
fixed before delivery: the first cut of the job-level evidence gate accepted
"any run of the required workflow with all required jobs green", which let
runtime #1's green push run paper over the failed, never-rerun PR run and
returned READY. The aggregation now ranks an explicit required-job failure
above sibling satisfaction (supersession = rerun of that run, visible via
`run_attempt`). Regression test: "a green sibling run cannot erase an
executed required-job failure".

## 3. Implementation notes

- **Explicit evidence config.** `DEFAULT_CONFIG.ciEvidence` pins, per repo,
  the required workflow and job names taken from the repos' real ci.yml
  (read live at the accepted heads): runtime `CI`×{build + package checks,
  unit tests (Node), browser gates (headless Chrome), out-of-repo tarball
  consumer (headless Chrome)}; harness `CI`×{build + package checks,
  unit tests (Node), harness host browser gate (headless Chrome),
  out-of-checkout tarball consumer (headless Chrome)}; product `CI`×{unit
  tests (Node, clean checkout), browser gates (packaged build, headless
  Chrome)}. A candidate without a config entry is a config error — evidence
  requirements are never inferred. Workflow-shape drift (required job absent
  from the jobs list) is `unknown-evidence`, not a guess.
- **Success requires positive proof**: job-level `success` on the latest
  attempt of a completed run of the required workflow. `skipped`/`neutral` →
  `not-executed` → insufficient; missing conclusions → unknown; run lists or
  job lists with `total_count > fetched` are truncated → refuse (`insufficient`),
  never judged from an incomplete inventory.
- **Two-leg traceability**: merged PRs fetch `accepted...mergeCommit` (leg 1)
  and `mergeCommit...mainSha` (leg 2). Leg 1 alone cannot produce
  `landed-traceable`; leg1 ok + leg2 not-contained → `merged-untraceable`;
  any leg unreadable → `insufficient`. `merged` alone is never treated as
  evidence of current-main content.
- **Protection**: 403/unreadable → unknown → refuses ready (absence is never
  assumed). When rules exist, their required contexts are **checked** against
  the head commit via check-runs + combined status (satisfied / pending /
  unsatisfied / unknown), not merely displayed. `not-protected` is recorded
  as definitive (branches API `protected:false` + 404 "Branch not protected")
  but does not waive the project evidence gate.
- **CI-required-checks interplay**: with no protection there are no
  GitHub-side required checks; the project evidence config is the gate. With
  protection, unsatisfied required contexts block (mapped to `conflict`
  family), pending contexts map to `ci-pending`, unreadable satisfaction →
  insufficient.
- **First failure vs rerun**: `rerunDetected` (any `run_attempt > 1`) stays
  on the record with an explicit note that the runs API keeps only the latest
  attempt's conclusion; a rerun-green run is reported as ready-with-rerun-
  note, never as first-try success.
- **Config validation** (`validateConfig`): non-empty candidates, 40-hex
  accepted SHAs, positive unique PR numbers, per-repo `{workflow, jobs}`
  evidence entries, valid `carriedInputs` — else `ConfigError`.
- Read-only contract unchanged and still pinned: transport argv is exactly
  `['api', <path>]`; every requested endpoint must match the read allowlist
  (now including `runs/{id}/jobs`, `commits/{sha}/check-runs`,
  `commits/{sha}/status`); no mutation-shaped endpoint passes.

## 4. v1 test pins corrected (defect fixes, matrix kept)

| v1 check | correction |
|---|---|
| `ready-to-merge` (GREEN_CI run-level only) | extended with job-level evidence; run-level green alone no longer yields ready |
| "no CI run → ready by policy" | policy deleted (it was an unauthorized invention); scenario asserts `insufficient-info` |
| `already-in-main` | renamed `landed-other-route` (same scenario) |
| `merged-traceable` (single leg) | now requires leg 2 (mergeCommit→current main); new tests for leg2-broken and leg2-unreadable |
| `merged-untraceable` (diverged compare) | sharpened to the leg1-ok/leg2-broken semantics with mergeTrace in the record |
| `summarizeCi` status `none` | no longer a ready path; superseded by `evaluateRequiredEvidence` states |
| protection checks | + unknown-gates-ready, + satisfaction evaluated (satisfied/pending/unsatisfied/unknown) |
| exit-code tests | + bug-6 regression (all-landed → verdict `landed`, exit 0), + verdict precedence, + exit 3 config rejection |

Suite grew 18 → **39 checks**, all fake-API, no network; the driver still
targets the real `buildReport`.

## 5. Verification commands and results

```
node tests/m4a-mainline-preflight.test.cjs
  -> m4a-mainline-preflight.test.cjs: 39 passed, 0 failed
node <tmp>/first-fail.cjs <worktree>/scripts/m4a-mainline-preflight.cjs
  -> 7 already-good, 0 reproduced defects
node scripts/m4a-mainline-preflight.cjs --out <snapshot>.json   # live, exit 1
```

Live read-only run **2026-10-05T16:11:51Z** (all GETs via `gh api`; full
JSON snapshot preserved outside the repo at
`C:/Users/hua/Desktop/文档/locus-m4a-review-c-preflight-snapshot.json`):

| candidate | status | key facts (full SHAs) |
|---|---|---|
| locus-runtime #1 | **ci-failed → verdict blocked, exit 1** | head `2435a57ff7a66db3db88aa98a88d404c75133483` == accepted; base main; mergeable true (`unstable`); main `5bedeeb73f1f0a938d2258bb071fe252e6b11eca` not-protected, accepted not contained (behind_by 13); required job `browser gates (headless Chrome)=failure` on PR run `36987973661` (a1, no rerun); sibling push run `36987967403` green, does not supersede |
| locus-harness #1 | **ready** | head `347eed99a415dc080b97d46d8a4271ceb19c5142` == accepted; main `77f13fe9003ab3b9d7c7242cea651de4181d2d55`; all 4 required jobs succeeded on run `37036663781` |
| locus-product #5 | **ready** | head `d6a74a25a2b98293d9aa1f2a635022d8f5ed733b` == accepted; main `fe1a1f61f3822905b2f7c5b472a6cb9d0a5ac985`; both required jobs succeeded on run `37293407034` (attempt 2, rerun on record) |

Carried inputs unchanged: #1 contained (strict ancestor), #2/#3/#4 diverged
(cherry-pick carry). No failed CI was rerun. No new `unknown` appeared for
the three candidates with the owner token — every fact the classifier needs
was readable; the honest difference vs v1 is precision (job-level evidence,
two-leg trace, sibling-run semantics), not extra unknowns.

## 6. Limits (unchanged or new)

- The runs API keeps only the latest attempt's conclusion per run; a first
  attempt's failure is proven by `run_attempt > 1` presence plus the review
  record, not re-readable from the endpoint. The tool says so explicitly
  instead of reconstructing history.
- `ciEvidence` pins today's workflow shapes; a renamed/added job makes
  evidence `unknown-evidence` (refuse) until the config is updated
  deliberately. This is the intended failure mode.
- Required-check satisfaction is evaluated only when protection rules exist;
  all three mains are currently not protected (definitive), so the project
  evidence config is the operative gate.
- User-level GitHub App deploy integrations remain unknown (403 on
  `/user/installations`), as recorded in the rollout doc §7.

## 7. Handoff to D

1. Re-run `node scripts/m4a-mainline-preflight.cjs --json` immediately before
   any merge decision (parallel agents move the remotes; expect runtime #1
   `ci-failed` → blocked until its PR run is rerun).
2. The runtime #1 clearance is unchanged from the rollout plan §3 Phase 1:
   **one rerun** of the failed `browser gates` job on run `36987973661`;
   green → the same preflight run should flip the candidate to `ready` with a
   rerun note (the failed attempt stays in the record, not rewritten);
   second red → root-cause, no loop reruns.
3. Merging stays **merge-commit only** (never squash): the R1 classifier
   requires both ancestry legs, so a squash landing will be reported
   `merged-untraceable` and block the combo record by design.
4. Report schema is v2 (`schema: 'm4a-mainline-preflight/v2'`):
   `summary.{verdict, exitCode, ready, landed, pending, blocked,
   undetermined}`, candidate `status`/`family`/`reasons`/`unknowns`,
   `mergeTrace`, `evidence.{required, state, detail, perRun, runs}`,
   `protectionRequirements`. Exit codes 0/1/2/3 = ready-or-landed-or-
   continue / blocked / insufficient / invalid config.
5. The rollout doc's §0 banner supersedes its v1 §1 verdicts and §10
   taxonomy; the operational sequence (§3–§7, §9) is unchanged.

## 8. Delivery record (amended after first push)

- Push: git transport was down again (connect timeout); the commit was pushed
  via the Git Data API with every object SHA verified byte-for-byte
  (blobs → tree `c1e26819…` → commit → ref). Because the API strips ALL
  trailing message newlines, the local commit was rebuilt without the
  trailing-newline byte before pushing: local `d60523d` → delivered
  `629a37923731ef3ee5fc721221a322c94c2bf32b` (identical tree/content).
- Delivery PR: **#10** (base `refactor/m4a-integration`, head `629a3792…`).
  PR #9 untouched (verified `updated_at` unchanged).
- **CI on the delivery PR — first attempt FAILED, recorded as-is, not rerun
  (rerun is outside this round's authorization):** run `37340129474`
  (pull_request, attempt 1). `unit tests (Node, clean checkout)` **passed**;
  `browser gates (packaged build, headless Chrome)` failed on exactly one
  gate: `e2e-m3c-python-integration.cjs` — **B-PY1** ("python js.fetch denied
  at the policy layer with the marker", `fail:true, delta:0`, the Pyodide
  `eval_code_async` traceback surfaced instead of the policy marker),
  54 passed / 1 failed; all other 15 gates passed. This matches the
  **documented B-PY1 intermittent flake family** (previously observed
  three-green-one-red across four runs, root cause undetermined, E3 family —
  the security property itself held: `delta=0`). By construction this round's
  diff cannot affect the packaged gates: the preflight script/tests are not
  in the page or gate import graph (the unit job proves the clean-checkout
  install+build+test path). The failure is recorded here and in the run
  history; rerunning it is D's call, exactly like the runtime #1 disposition.

