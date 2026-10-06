# M4a Review Round 1 — fix D: integration of fixes A and C, and the verification record

Status: integration branch `refactor/m4a-integration` (PR #9), fix D,
2026-10-06. Baseline: PR #9 head `da5bb09526e61e75925c44cba8907257398eaf56`,
**verified unchanged on the remote before starting** (compare API:
`behind_by=0` for both inputs; the expected starting head was the actual
head). Scope honored: cherry-picks of the two verified review-fix branches,
one test registration, these docs, and the PR body — nothing else. No
production `src/`, no dependency locks, no default branch, no core repos.
No PR merged, no CI rerun, no protection change.

> **What this round establishes:** fixes A (candidate lane input channel +
> Product identity binding) and C (preflight refuses `ready` without
> sufficient evidence) are integrated into PR #9, re-verified on the
> integrated tree by real execution (not by grep), and the mainline status is
> re-derived from live remote state.
>
> **What this round does NOT establish:** the mainline has landed, or
> "latest-main" passes. Both cores' `main` still lack the extraction
> implementation (re-verified live, §6); a main-mode candidate apply fails
> honestly at the install stage (§6.3); the mainline merge chain is still
> blocked on locus-runtime #1's never-rerun failed CI run (§6.4). The
> candidate workflow is still not on the default branch, so schedule and
> dispatch remain dormant (§8).

---

## 1. Inputs — full SHAs, verified on GitHub before integration

Both input branches were confirmed actually pushed, correctly based, and
linear on the expected baseline, **via the GitHub compare API** (not local
branch heads). Each round's handover doc was fetched from its branch and
read before any cherry-pick.

| Input | PR | Remote branch | Remote head | Base check |
|---|---|---|---|---|
| A — candidate lane (F1 input channel, F2 identity) | #11 OPEN | `fix/m4a-review-candidate` | `17098cd3c60707387a97bba9f820f4e646263e1f` | `da5bb09` + 3 commits, `behind_by=0` ✓ |
| C — preflight evidence gate | #10 OPEN | `fix/m4a-review-preflight` | `db2be6ac3914883cafdd127397d74dfe7bca30d8` | `da5bb09` + 2 commits, `behind_by=0` ✓ |

Commit ranges (from the compare API, parents verified linear):

- A: `fe4aa1ab` (F1) → `2d7c647e` (F2) → `17098cd3` (docs). Files:
  `.github/workflows/core-main-candidate.yml`, `scripts/core-main-candidate.mjs`,
  `tests/core-main-candidate.test.mjs` (rewritten), NEW
  `tests/core-main-candidate-workflow.test.mjs`, `docs/M4A-A-CORE-CANDIDATE.md`,
  `docs/M4A-REVIEW-A.md`.
- C: `629a3792` (fix) → `db2be6ac` (docs). Files:
  `scripts/m4a-mainline-preflight.cjs`, `tests/m4a-mainline-preflight.test.cjs`,
  `docs/M4A-C-MAINLINE-ROLLOUT.md` (§0 banner), NEW `docs/M4A-REVIEW-C.md`.

Handover docs read before integrating: `docs/M4A-REVIEW-A.md` @ `17098cd3`
(verification tables, rehearsal record, and the explicit D handover:
*register `core-main-candidate-workflow.test.mjs` in `tests/run-unit.cjs`*)
and `docs/M4A-REVIEW-C.md` @ `db2be6ac` (status-table contract, defect
reproductions, aggregation rules). No AGENTS.md exists in this repository
(checked at this baseline as well).

Only the two remote heads above were integrated. No local worktree branch
head was used as a source (the local `fix/m4a-review-*` worktrees were not
touched; `fetch` brought the exact remote objects in and their SHAs were
confirmed identical to the API-reported heads).

## 2. Integration — cherry-picks in A → C order, byte-verified

Cherry-picked onto a clean worktree at `da5bb09` (`Locus-product-m4a-review-d`,
branch `fix/m4a-review-d`), A first, then C. **Zero conflicts.** The two
rounds' footprints are disjoint (A: candidate lane files; C: preflight
files), and the integration proof is byte-level, not narrative:

- A's three commits reproduced their source trees exactly
  (`f49ddf9` = `fe4aa1ab` @ `d3b89021`, `3052b35` = `2d7c647e` @ `93243e14`,
  `d62a036` = `17098cd3` @ `0e6ae574`).
- C's commits sit on top of A, so their trees differ from the C-branch
  originals by exactly A's content — verified the other way: the diff from
  C's source head `db2be6ac` to the integrated head is **exactly A's six
  files**, and all four of C's files are blob-identical between source and
  integration.

| Source commit | → Integration commit | Fidelity |
|---|---|---|
| `fe4aa1ab` (A-F1) | `f49ddf9` | tree `d3b89021` identical ✓ |
| `2d7c647e` (A-F2) | `3052b35` | tree `93243e14` identical ✓ |
| `17098cd3` (A-docs) | `d62a036` | tree `0e6ae574` identical ✓ |
| `629a3792` (C-fix) | `447f3d9` | C's 4 files blob-identical ✓ |
| `db2be6ac` (C-docs) | `2396a66` | C's 4 files blob-identical ✓ |
| D registration | `7bd1e54` | `tests/run-unit.cjs` +1 suite (the only code change) |

The single integration change D made: registering
`core-main-candidate-workflow.test.mjs` in `tests/run-unit.cjs` — exactly
what A's handover asked for. A's tool suite and C's preflight suite were
already registered at the baseline. Nothing else needed adaptation: both
fixes compiled and passed their suites on the integrated tree on the first
run (15/15, 60/60, 39/39).

## 3. Recheck 1 — workflow dispatch inputs (real execution, not grep)

The fixed workflow binds the three dispatch inputs only as `env:` values
(`CAND_SOURCE/CAND_RUNTIME_SHA/CAND_HARNESS_SHA`); the capture step's run
block is static shell. This was re-verified by **running the committed run
block verbatim** the way GitHub runs steps — `bash --noprofile --norc -eo
pipefail <script>`, cwd = repo root — with hostile values delivered as real
environment variables. The harness runs on a restricted PATH whose `git`,
`npm`, and `npx` are logging shims that fail loudly: across all payloads the
shim log stayed **empty**, so no effect under those names ever ran.

Harness first-failures (kept, then fixed in the harness — not product
defects): run 1 resolved `spawnSync('bash')` to the WSL stub in System32
(WSL-not-installed noise), and run 2 mis-shaped the env-binding structural
check (comment lines). The green third run is the record; the first two
logs are preserved in the review area.

| Payload (harmless markers only) | Field | Result on the integrated tree |
|---|---|---|
| `explicit'; echo CAND_MARKER_RAN; f='` | `source` | exit **2**, marker never executes, rejection reports only `rejected a value of length 31`, no snapshot written |
| `0000…0000' '$(echo CAND_MARKER_RAN 1>&2)` | `runtime_sha` | exit **2**, marker never executes (the old baseline printed the marker *before* erroring), no snapshot |
| `main$(echo CAND_MARKER_RAN)` | `source` | exit **2**, marker never executes, no snapshot |
| `` `echo CAND_MARKER_RAN` `` | `harness_sha` | exit **2**, marker never executes, no snapshot |

Every payload also asserted: the value is never echoed back (length-shape
only), `candidate.json` is never written, and the workflow's apply stage is
gated on `steps.capture.outcome == 'success'` so a failed validation cannot
reach npm at all. The registered structural suite
(`core-main-candidate-workflow.test.mjs`, 15 checks) pins the same
properties statically; this section is the dynamic half. Rejection path:
`CANDIDATE-FAIL stage=2 exit=2 locus-harness candidate must be a full
40-char lowercase hex SHA (rejected a value of length 22)` — validation in
Node, before any network/npm/filesystem effect.

## 4. Recheck 2 — Product identity binding (two real different commits)

Real-tool execution against a fixture repo with two real commits: C1
(`0e3b0e7d…`) and C2 (`16ecfc9f…`). The snapshot was captured at C1
(explicit mode, verified cores `2435a57f…` / `347eed99…`), **then** the
fixture advanced to C2, so snapshot-A facing checkout-B is a genuine
mismatch.

| Check | Result |
|---|---|
| snapshot binds the real Product commit | `product.commit == C1` ✓ |
| apply snapshot-A onto checkout-B | **exit 20**, `Product identity mismatch` with `expected`(C1)/`actual`(C2) |
| zero writes on that refusal | WB tree still clean, HEAD unmoved, **no `node_modules` ever appeared** |
| apply onto a checkout whose HEAD moved after capture | exit 20 ✓ |
| verify on a moved HEAD | exit 22 ✓ |
| capture on a dirty tree | exit 10 ✓ |
| capture with an unborn/unreadable HEAD | exit 10 ✓ |
| verify snapshot-A against checkout-B | exit 22, wrote nothing ✓ |
| workflow pins the throwaway clone | the product-pin step reads `candidate.json`'s `product.commit` and runs `git checkout --detach` ✓ |

"Zero npm" is proven here by effects (nothing installed, tree clean); the
structural zero-call proof is the registered unit suite's fake-io npm
counting (60 checks, "apply refuses a mismatched HEAD … zero writes / zero
npm calls"). A PATH-level npm shim cannot intercept this tool on Windows —
its primary npm channel is `node <npm-cli.js>` via `process.execPath`,
bypassing PATH (observed first-hand when the first, mis-ordered fixture run
let a real `npm ci` through and the suite-level shim proved void; recorded
as a harness lesson, and the fixture was fixed so the identity refusal
genuinely precedes any install).

An unplanned extra positive: a first fixture draft captured its snapshot at
C2 and applied onto a C2 checkout — the identity guard correctly allowed it
and the run proceeded to a **real** `npm ci` of both cores' git deps before
failing (correctly) on an out-of-scope delta (`?? node_modules/` in a
fixture without `.gitignore`). That failure is the allowed-delta gate
working as designed, on real installs.

## 5. Recheck 3 — preflight counterexamples and live remote state

- The registered matrix (`m4a-mainline-preflight.test.cjs`) passes on the
  integrated tree: **39/39** — no CI runs → insufficient (never ready);
  closed-unmerged → blocked; `mergeable=null` → insufficient; all required
  jobs skipped → not success evidence; wrong base → blocked; protection 403
  → insufficient; merge commit absent from current main → merged-untraceable;
  **all-landed → verdict `landed` + exit 0 with JSON/text/exit derived from
  one aggregation**; green-sibling-does-not-supersede; truncated inventory
  refused; ready positive control; read-only allowlist (GET by construction).
- **Live read-only preflight on the real remote state** (2026-10-05T18:09Z,
  `gh api` GET-only): verdict **`blocked`**, exit **1**, JSON/text/exit
  consistent. runtime #1 = `ci-failed` (browser-gates job failure on PR run
  `36987973661`, never rerun; the green push run `36987967403` does not
  supersede it); harness #1 = `ready` (run `37036663781`, job-level green);
  product #5 = `ready` (run `37293407034` attempt 2, rerun kept on the
  record, not rewritten as first-try). Carried inputs unchanged (#1
  contained; #2/#3/#4 diverged, not to be merged individually).
- This is a **fresh derivation from current remote state**, not a carried
  conclusion: the "runtime #1 is the blocker" statement now cites today's
  run IDs and the supersession rule, and would change automatically if the
  run were rerun by someone else.

## 6. Verification battery and current main snapshot

### 6.1 Clean-tree battery on the integrated worktree (all green)

`npm ci` ✓ → `npm run build` ✓ (954 ms) → `npm test` with
`BROWSER_GATE_ORCH_REAL_PREVIEW=1` ✓ — **all 31 suites**, including the
browser-gate orchestrator's real `vite preview` checks ("real vite preview:
build, readiness identity, verified shutdown") and the newly registered
workflow-shape suite. First run, no retries, no relaxed assertions.

### 6.2 The verified fixed combination (unchanged)

Product gate content = this branch's integration of A/C onto `da5bb09`;
cores pinned at the accepted heads runtime `2435a57ff7a66db3db88aa98a88d404c75133483`
and harness `347eed99a415dc080b97d46d8a4271ceb19c5142` (both re-confirmed as
runtime #1 / harness #1's exact heads by the live preflight this round).

### 6.3 Main-mode candidate — captured live, honest red

`capture --source main` (real `git ls-remote`) at 2026-10-05T18:17:33Z:
runtime main = `5bedeeb73f1f0a938d2258bb071fe252e6b11eca`, harness main =
`77f13fe9003ab3b9d7c7242cea651de4181d2d55` — both roots still contain only
`.gitignore/LICENSE/README.md/docs` (re-verified via the GitHub contents
API). The main-mode apply into a throwaway clone of this branch failed
**exit 21 at the install stage** (`Could not read package.json` — npm
cannot install a core whose main tree has no package.json). That red is the
mechanism working: until the merge chain lands, "latest-main" does not
build, and this round does not claim otherwise.

Transport incident kept on the record: the first main-capture attempt and
its next three retries failed with `curl 56 Recv failure` / connect timeout
to `github.com:443` (the environment's known intermittent block; `gh api`
on `api.github.com` stayed reachable throughout). The fourth retry, after
transport recovered, succeeded and is the snapshot cited above. No assertion
was relaxed and no cause was invented beyond the logged transport errors.

### 6.4 Mainline status (live, this round)

`blocked` — one blocker: locus-runtime #1's failed PR run `36987973661`
(browser gates) has not been rerun. Harness #1 and product #5 remain ready.
The full operational landing list is in `docs/M4A-INTEGRATION.md` §6 and is
**corrected/reaffirmed** in §8 below; the stale preflight conclusions from
before fix C are superseded by C's status table and this live run.

## 7. Clean drill on the pushed gate head (out-of-checkout)

**How this branch was pushed, and the SHA drift stated openly:** git
transport to `github.com:443` failed twice at push time (`Recv failure` /
connect timeout; `gh api` stayed reachable), so the seven commits were
pushed through the Git Data API (blobs → trees with `base_tree` → commits →
ref PATCH `force=false`, after GET-confirming the ref still sat at
`da5bb09`). Fidelity gates held mechanically: **every remote tree SHA
equals the local tree SHA**, and the compare API shows exactly the expected
7 commits / 13 files. Commit objects drifted in SHA as the API always does
(message trailing newlines stripped; dates stored as UTC):

| Local commit | Remote commit on `refactor/m4a-integration` | Tree equality |
|---|---|---|
| `f49ddf9` (A-F1) | `05372138` | ✓ `d3b89021` |
| `3052b35` (A-F2) | `cc3a2217` | ✓ `93243e14` |
| `d62a036` (A-docs) | `94f7d4f9` | ✓ `0e6ae574` |
| `447f3d9` (C-fix) | `bc4b909e` | ✓ `3caf5b16` |
| `2396a66` (C-docs) | `ed6f4f70` | ✓ `db9a3f74` |
| `7bd1e54` (D registration) | `abd4c594` | ✓ `42f6dbcb` |
| `520074a` (D docs) | `7c294b53` | ✓ `1b3d75fc` |

Because of that drift, the drill below was captured and run against the
**final remote head** — not the local pre-push commit. The remote chain was
additionally rebuilt locally (`git commit-tree`, stripped messages, UTC
dates) and every rebuilt SHA matched the remote commit exactly, so the
local checkout used for cloning is byte-identical to the remote branch.

**The drill** (two throwaway clones outside every checkout, both
`core.autocrlf=false`, at `7c294b53664d82fc71d596b5e21c6b3145a372b0`):

| Step | Result | Binding |
|---|---|---|
| capture (`--source explicit`) | exit 0 | `product.commit = 7c294b53…`, runtime `2435a57f…`, harness `347eed99…` |
| apply (real `npm ci` of both cores from GitHub) | exit 0 | provenance **6/6**: productIdentity, allowedDelta, manifest, lock, hiddenLock, installed |
| verify | exit 0 | same snapshot |
| `npm run build` | exit 0 (965 ms) | — |
| `npm test` (`BROWSER_GATE_ORCH_REAL_PREVIEW=1`) | exit 0 | **all 31 suites** |
| official browser gates (`tests/run-browser-gates.cjs`, single run) | exit 0 | **all 16 gates passed**, no retry |
| legal dependency edit post-apply (devDependency + matching lock entry) | verify exit 0 | the applied/legal delta scope verifies |
| source-file rider (`src/main.js` touch) | verify **exit 22** `changes outside the allowed candidate scope` | source changes cannot ride along |
| HEAD moved after apply (empty commit) | verify **exit 22** `Product identity mismatch` | a moved HEAD cannot impersonate the captured Product commit |

Every line above is bound to the same triple: Product commit
`7c294b53664d82fc71d596b5e21c6b3145a372b0` + runtime
`2435a57ff7a66db3db88aa98a88d404c75133483` + harness
`347eed99a415dc080b97d46d8a4271ceb19c5142`. Logs are preserved in the
review area (`drill-capture.log`, `drill-apply.log`, `drill-verify.log`,
`drill-build.log`, `drill-unit.log`, `drill-browser.log`,
`drill-scope-*.log`). **Gate head vs branch tip, stated explicitly:** the
branch tip at delivery is this docs commit — its tree differs from the
drilled head `7c294b53` only by these two documentation files; every
gate-relevant file (sources, tests, workflow, pins) is byte-identical
between the drilled head and the tip, which the tree hashes of the
delivery commit's parent chain prove.

### CI on the pushed head (PR run and push run reported separately)

| Run | Event | Result |
|---|---|---|
| `37355783370` | pull_request (PR #9 check) | **success** (both jobs) |
| `37355773953` | push | **failure**: exactly one suite, `e2e-ui.cjs`, died at Chrome boot with `CDP browser endpoint unavailable: readiness timeout`; every other suite passed on that run (including `e2e-m3c-python-integration` 55/55) |

First failure kept, not rerun. What the recorded facts show: the identical
commit passed the identical browser-gates job minutes later on the
pull_request run, and the failure hit the run's very first Chrome boot.

> **Correction (2026-10-06, review round 2 — supersedes the sentence that
> followed here originally).** This record originally continued: "the known
> runner-side CDP readiness flake family recorded in earlier rounds, not a
> regression of this integration". That attribution was NOT established by
> the evidence and is **retracted**: the observations do not identify a root
> cause, do not suffice to attribute the failure to the environment or to
> the product, and do not rule out a regression. What stands is exactly the
> table above — first failure on push run `37355773953` (`e2e-ui.cjs`, CDP
> readiness timeout), same-commit success on pull_request run
> `37355783370`, no rerun triggered (out of that round's authorization).
> Root cause: **unconfirmed**. The red push run stays on the record next to
> the green PR run — nothing was deleted or rewritten as a first-try green.
> See `docs/M4A-REVIEW-R2.md` §6 for the round-2 record of this correction.

The candidate
`core-main-candidate` workflow did NOT run anywhere on GitHub — it is not
on the default branch (schedule/dispatch remain dormant, §8.5).

## 8. Corrected mainline landing checklist (reaffirmed on today's evidence)

Supersedes any pre-fix-C "ready" wording; nothing below has been executed.
Order matters; stop on any red.

1. **Rerun locus-runtime #1's failed run** (`36987973661`). A second red
   escalates to a human decision; do not merge on red. (Harness #1 and
   product #5 are ready per today's live preflight, §5.)
2. **Merge locus-harness #1** (`347eed99`) with a **merge commit** — never
   squash (squash orphans the accepted SHA; preflight reports
   `merged-untraceable` by design).
3. **Merge locus-runtime #1** (`2435a57f`) with a merge commit.
4. **Merge this PR (#9)** into `refactor/m3c-integration`; close #6/#7/#8
   and PRs #10/#11 as superseded (byte-identical content carried here;
   merging them individually would duplicate history).
5. **Merge Product #5** (`refactor/m3c-integration` → `main`). At this
   moment the Product default branch first contains the three-repo switch
   AND registers `core-main-candidate.yml` — only then do schedule and
   dispatch become real. **Until then, no "the candidate lane is live"
   claim is permitted** (GitHub API confirms `ci.yml` is the only workflow
   on the default branch today).
6. **Post-merge SHA audit**: re-run the preflight; all three accepted SHAs
   must be reachable from their repos' `main` via merge-commit ancestry.
7. **`chore/m4a-pin-core-main`**: two-file pin/lock update to the
   post-merge core-main SHAs; land only after `npm ci && npm run build &&
   npm test` + the official browser gate are green on it in a clean
   checkout.
8. **Candidate lane first live run**: one manual `workflow_dispatch`
   (source `main`). Expected honest outcome until step 7's pins are the
   cores' mains: an install-stage red (§6.3) — the mechanism, not a bug.
9. Combo-record docs commit; close Product #1–#4 as superseded.

## 9. Honesty notes (scope of this round's claims)

- No real model and no paid API anywhere in this round; the model layer in
  every suite and gate is the built-in fake transport. Real network hops
  actually taken: npm/git fetching the pinned cores (rehearsal apply,
  battery `npm ci`), and the browser gates' pinned-CDN Pyodide download
  (SHA-verified), recorded as such.
- The workflow-shape recheck (§3) ran the capture step locally because the
  workflow itself cannot be dispatched before it reaches the default
  branch; no default branch was modified to make it triggerable.
- Residual unknowns carried from fix C stand (user-level GitHub App
  integrations unauditable at 403 under the owner token).
- First failures are kept: §3's two harness-side first runs, §4's
  mis-ordered fixture run (which also exposed that a PATH-level npm shim
  cannot intercept this tool — see §4), §6.3's four transport-failed
  capture attempts, §7's two failed `git push` attempts (API fallback) and
  the red push-event CI run `37355773953` (CDP readiness timeout, same
  commit green on the PR run). Diagnostic reruns are listed alongside;
  nothing was retried into green by weakening an assertion.
