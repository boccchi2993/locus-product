# M4a Review Round 2 — the preflight's four unearned-ready defects, fixed and re-verified

Round: M4a second review round (targeted), 2026-10-06. Scope honored: only
`scripts/m4a-mainline-preflight.cjs`, `tests/m4a-mainline-preflight.test.cjs`,
these docs, and the PR #9 body. Production `src/`, both dependency locks, the
round-1 candidate tooling (`scripts/core-main-candidate.mjs`,
`.github/workflows/core-main-candidate.yml`), `tests/run-unit.cjs` (the suite
was already registered), the browser orchestrator, and the two core repos are
unmodified — verified by `git diff --name-only` before committing. Fix A of
round 1 was reviewed and accepted; this round does not redo it. No PR was
merged, no CI was rerun, no protection was changed, no state was written to
GitHub beyond pushing this branch and updating the PR body.

Baseline: PR #9 head `b714f41f77c826867a02e73f1a4e7d7933b38394` (branch
`refactor/m4a-integration`), verified == remote head before starting
(compare API: `ahead_by=0 behind_by=0 status=identical`). No AGENTS.md exists
in this repository at the baseline. Worktree: `Locus-product-m4a-review-r2`,
branch `fix/m4a-review-r2`, `core.autocrlf=false`.

## 1. The four defects (all: an unearned `ready` / exit 0)

Each was reproduced against the **unmodified baseline implementation**
through the real `buildReport(config, fakeApi)` chain — not through a
reimplementation of the judgment. First-fail record: the final round-2 test
file run against the baseline script scores **50 passed / 15 failed, exit 1**
(log preserved out-of-tree: `locus-m4a-review-r2-tmp/first-fail-preflight.log`;
the 15 failures cover all four families below).

| # | Scenario (all other ready conditions complete) | Old behavior | Why |
|---|---|---|---|
| F1 | `mergeable=true`, `mergeable_state="blocked"`, protection requires ≥1 approving review, CI green | `ready` / exit 0 | the classifier only special-cased `dirty`; `blocked` fell through, and `requiredReviews` was displayed but never judged |
| F2 | accepted→current-main compare answers 403/404/transport-failure | `ready` / exit 0 | the unreadable containment was pushed into `unknowns`, but nothing gated the success exit on it |
| F3 | a required job's `conclusion="stale"` (also: any unrecognized string) | `ready` / exit 0 | the judge only excluded a fixed list of failures and not-executed values — everything else defaulted to satisfied |
| F4 | 5 runs on the head; the OLDEST has an explicit required-job failure, the newer 4 are green, no rerun | `ready` / exit 0 | fetch layer and judge layer each sliced to the latest 4 runs (`MAX_EVIDENCE_RUNS`); the failure was silently dropped while the report still claimed "only a rerun supersedes a failure" |

## 2. What changed (implementation map)

All in `scripts/m4a-mainline-preflight.cjs`:

- **F1 — merge state is explicit.** `mergeable=true` now only means "no
  textual conflict". `classifyCandidate` consults `mergeable_state` directly:
  `"blocked"` → new blocked status `merge-blocked` (family blocked, exit 1);
  `"clean"` and `"unstable"` may proceed (rationale documented in
  `MERGEABLE_STATE_PROCEED`: unstable = only non-required statuses
  failing/pending, and the explicit protection + evidence gates below still
  decide — this keeps an explicit required-job failure a `ci-failed`
  diagnosis instead of an unknown); `has_hooks`/`unknown`/null/anything
  unexplained → `insufficient-info`.
- **F1 — required reviews participate.** `evaluateProtectionRequirements`
  answers `unknown` (→ insufficient) whenever a
  `required_pull_request_reviews` rule exists: this audit has no evidence of
  *currently valid* approvals (historical review lists mix stale/dismissed
  reviews, and green CI is not approval evidence), so the requirement is
  refused, never guessed from a count. The protected-with-required-CHECKS
  paths (satisfied / pending / unsatisfied / unreadable) are unchanged and
  still allow a legitimate ready when satisfied.
- **F2 — no success with an open evidence gap.** `classifyCandidate`'s
  success exit is now gated: `if (unknowns.length)` → `insufficient-info`.
  Explicit blocked/pending diagnoses still return first (a closed or drifted
  PR with an unreadable compare is still diagnosed, not drowned in unknowns).
  Legal landed verdicts keep their alternative-proof rule: accepted→merge AND
  merge→main both proven, or accepted already contained in main.
- **F3 — success whitelist.** `evaluateRequiredEvidence` counts a required
  job as succeeded **only** on `conclusion === 'success'`. `skipped`/`neutral`
  keep the round-C `not-executed` classification (alone or mixed with
  successes); `stale`/null/missing/any unrecognized value is
  `unknown-evidence` naming the raw value, run id, and job name.
  `failure`/`timed_out`/`cancelled`/`action_required` keep the explicit
  failed classification; executing states keep `pending`.
- **F4 — full inventory, no window.** `MAX_EVIDENCE_RUNS` (the latest-4
  slice) is gone from both layers. New `fetchRunsForHead` pages the head's
  runs to completion (`&page=N`, budget `MAX_RUN_PAGES=5`×100);
  `fetchJobsForRun` pages each run's jobs (`MAX_JOBS_PAGES=5`×100). Budgets
  are guards against unbounded requests, not windows: exceeding one marks the
  inventory **incomplete**, which `evaluateRequiredEvidence` (new `inventory`
  parameter) turns into `insufficient-info` — **unless an explicit failure
  was already observed**, in which case the candidate is `ci-failed`/blocked
  (unevaluated runs can only add failures, never erase one). The supersession
  rule is unchanged: a failed run stands until *its own* rerun; a green
  sibling does not supersede. The report now carries `evaluatedRunIds` and
  the inventory state/reason (`runs evaluated: …` line in the text render;
  `evidence.evaluatedRunIds` + `evidence.runs.inventory` in JSON).
- **Found by this round's own tests, fixed in the same pass:** the
  aggregation ranked a satisfied run above other runs' `unknown-evidence`,
  so one green run could shadow another run's unreadable job list. Order is
  now failed > incomplete-inventory > pending > not-executed/unknown-evidence
  > satisfied — satisfied is only reachable when *every* evaluated run is.
  (This is the "cannot skip remaining unknowns because some run succeeded"
  rule; the catching test is "R2-F4: a required run whose jobs are unreadable
  among green siblings".)
- Test-harness first-failure, kept on the record: the first baseline replay
  used a fixture that did not forward `mergeableState` into the fake PR
  route, so the F1 scenarios were silently exercised with `clean`; caught on
  the fixed implementation's first run (4 red), fixed, and the honest
  baseline replay (§1) was captured afterwards.

## 3. Tests

`tests/m4a-mainline-preflight.test.cjs`: 39 → **65 checks**, all fake-API, no
network, every negative driven through the real `buildReport`. New pins:

- R2-F1: `mergeable_state=blocked` not ready with all CI green (blocked,
  exit 1); reviews-required unprovable → insufficient (unit + end-to-end);
  checks-only protection still allows ready (no over-blocking);
  `has_hooks`/`unknown` state never ready.
- R2-F2: compare 403/404/transport → insufficient, `unknowns` name the gap,
  JSON verdict/exit and text render all refuse ready; positive controls for
  two-leg landed (with unreadable accepted→main), landed-other-route, and the
  complete ready path.
- R2-F3: table-driven over `success, failure, timed_out, cancelled,
  action_required, skipped, neutral, null, undefined, stale, startup_failure`
  end-to-end (status + verdict + exit + no READY in text) plus a unit-level
  state table on the production `evaluateRequiredEvidence`; the `stale` case
  asserts raw value, run id, and job name are visible.
- R2-F4: five-runs-oldest-failed → blocked with the failed run among the
  evaluated run ids; five-runs-all-green → ready (complete inventory);
  multi-page run list with the failure on page 2 → blocked; pagination
  failure → insufficient naming the failed page; budget exhaustion →
  insufficient naming the budget; failure + incomplete inventory → blocked
  (failure wins, incompleteness stays visible); a required run with
  unreadable jobs among green siblings → insufficient; jobs pagination with
  the required job on page 2 → ready. The round-C pins (green-sibling-does-
  not-supersede, rerun-green allowed with the rerun note, truncated list
  refused) are all retained unchanged.
- Existing pins corrected deliberately (defect-fix, not relaxation): the
  checks-only protection scenario no longer carries a
  `required_pull_request_reviews` rule (that combination is now pinned
  separately as insufficient by R2-F1); the allowlist test now covers the
  paged runs/jobs URLs via an added open-PR scenario.

## 4. Verification (all real runs)

| Gate | Result |
|---|---|
| Baseline first-fail (final tests × unmodified script) | 50 passed / **15 failed**, exit **1** — all four families (§1) |
| `node tests/m4a-mainline-preflight.test.cjs` (fixed) | **65 passed / 0 failed**, exit 0 |
| `node tests/core-main-candidate-workflow.test.mjs` | all 15 checks passed, exit 0 |
| `node tests/core-main-candidate.test.mjs` | all 60 checks passed, exit 0 |
| `npm ci` | exit 0 |
| `npm run build` | exit 0 (built in 1.03s) |
| `npm test` (`BROWSER_GATE_ORCH_REAL_PREVIEW=1`) | **all 31 suites passed**, exit 0 |

Per this round's scope (scripts/tests/docs only), the Runtime/Python-specific
and full browser-gate rounds were not re-run locally; whatever the PR's CI
runs automatically is reported as observed, without manual reruns.

## 5. Live read-only preflight (real remote state, this round)

`node scripts/m4a-mainline-preflight.cjs` at **2026-10-06T08:24Z** (GET-only
via `gh api`): verdict **`blocked`**, exit **1**, JSON/text/exit consistent
(snapshots preserved out-of-tree: `locus-m4a-review-r2-tmp/live-preflight.json`
and `live-preflight-text.log`). This is a fresh derivation, not a carried
conclusion:

| candidate | status | facts (run ids are the evaluated inventory) |
|---|---|---|
| locus-runtime #1 | **ci-failed** (blocked) | head `2435a57ff7a66db3db88aa98a88d404c75133483` == accepted; `mergeable_state=unstable` (informational note under the new allowlist); required job `browser gates (headless Chrome)=failure` on PR run `36987973661` (attempt 1, no rerun); sibling push run `36987967403` green, does not supersede; inventory complete (total_count=2, 1 page) |
| locus-harness #1 | **ready** | head `347eed99a415dc080b97d46d8a4271ceb19c5142` == accepted; `clean`; all 4 required jobs succeeded on run `37036663781` (+ green push run `37036658040`); inventory complete |
| locus-product #5 | **ready** | head `d6a74a25a2b98293d9aa1f2a635022d8f5ed733b` == accepted; `clean`; run `37293407034` attempt 2 (rerun kept on record) + green push run `37293400764`; inventory complete |

No branch protection exists on any of the three mains (definitive
`protected:false` + 404), so the new required-reviews rule is not exercised
by today's live data. Carried inputs unchanged: #1 contained by the #5 head;
#2/#3/#4 diverged (content carried by cherry-picks). The sole blocker remains
locus-runtime #1's never-rerun failed run — the live result is what the
fixed tool derived from current facts, not a preserved conclusion.

## 6. CI-attribution correction (affects round-1 records)

Round 1 observed, on gate head `7c294b53…`: push-event run `37355773953`
failed (exactly one suite, `e2e-ui.cjs`, CDP readiness timeout at the run's
first Chrome boot) while pull_request run `37355783370` on the **identical
commit** succeeded minutes later, and no rerun was triggered.

Round 1's records then wrote this up as "the known runner-side CDP readiness
flake family … not a regression of this integration". **That attribution is
retracted** (2026-10-06): those facts do not establish a root cause, do not
suffice to assign the failure to the environment or to the product, and do
not rule out a regression. The confirmed content is exactly: first failure on
push run `37355773953`; same-commit success on pull_request run
`37355783370`; no rerun. Both runs stand side by side in the round-1 record —
the first failure has not been deleted or rewritten as a first-try green.
`docs/M4A-REVIEW-VERIFICATION.md` §7 carries the in-place correction. This
round does not investigate the CDP root cause, does not touch timeouts, and
adds no retry.

## 7. Limits

- The runs API still keeps only the latest attempt's conclusion per run; a
  first-attempt failure is proven by `run_attempt > 1` plus the review record.
  The budget bounds (500 runs/head, 500 jobs/run) are guards: a head that
  genuinely exceeds them gets an explicit `insufficient-info` with the budget
  named, never a silent cut.
- Required-reviews satisfaction remains unimplemented **by design** (the task
  does not ask for an approval engine): any reviews requirement refuses ready
  until a reviewed change adds a valid current-approvals evidence source.
- `ciEvidence` still pins workflow shapes; a renamed/added job stays
  `unknown-evidence` until the config is deliberately updated.
