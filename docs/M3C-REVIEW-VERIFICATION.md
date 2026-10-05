# M3c review round — integration verification record (PR #5, `refactor/m3c-integration`)

Status: **review-fix integration record.** This document records the
integration of the three M3c review-fix branches into
`refactor/m3c-integration` (PR #5): the verified inputs, the cherry-pick
map, the D wiring, the full verification sequence with first results and
exit codes, and the corrections this round makes to
[M3C-D-INTEGRATION.md](M3C-D-INTEGRATION.md) §5. It does not merge
anything, publish anything, or deploy anything; after push the branch
waits for review. §8 records the SECOND review round (2026-10-05: F1
bounded owned-process cleanup, F2 structured negative-self-proof judge,
F3 Python E3 wording) on the same branch.

Established: 2026-10-05. No AGENTS.md exists in locus-product (re-verified
at the baseline via `git ls-tree`; also GitHub-404 per M3C-REVIEW-B.md §1)
— the M3C-PARALLEL-HANDOFF ownership contract is the governing document.

## 1. Inputs (all verified before any work started)

Common baseline (head of `refactor/m3c-integration` at round start, local
== remote, worktree clean):

`b7da804fd24e64c2fb1b3c82b69070d4c55cb31e`

| Review fix | Remote branch | Verified head (full SHA) | Commits after baseline |
|---|---|---|---|
| A — browser-gate orchestrator | `fix/m3c-review-orchestrator` | `8a3848c141e3469ba359a83e114c535e3e266f24` | 1 |
| B — python product-integration gate | `fix/m3c-review-python-gates` | `655f1f195dcea1a46283d633f6f6a6a14f559103` | 2 (`91be96df39d45e908052321137c4085456f15bb7` → tip) |
| C — storage packaged-build gate | `fix/m3c-review-storage-build` | `fdcd03930792a1b986eb723a89ae723ec644f79f` | 1 |

All three branch heads were fetched from GitHub and compared byte-for-byte
against the task's required SHAs before the cherry-pick; all three have
the baseline as their root parent (verified via `git log --format='%H %P'`).
No unfinished branch was adopted; no substitute branch was used.

Fixed dependencies (unchanged, resolved exactly by `npm ci` + `npm ls`):

- `locus-runtime` `2435a57ff7a66db3db88aa98a88d404c75133483`
- `locus-harness` `347eed99a415dc080b97d46d8a4271ceb19c5142`

## 2. Integration construction

In the `refactor/m3c-integration` worktree, in A → B → C order, all four
commits cherry-picked with **zero conflicts** (the branches' file sets are
disjoint: A owns the orchestrator, B owns the python gate, C owns the
storage pair + one `vite.config.js` input). Pushed commit chain (SHAs as
on the remote — see §6 for the push mechanism; file/tree bytes are the
cherry-picked ones, commit metadata is UTC-normalized by the push recipe):

| Pushed commit | Origin | Content |
|---|---|---|
| `a1a511aae25eb68dc6274aaafbb83cbac4780aea` | A `8a3848c1` | single-run orchestrator + owned preview lifecycle + fault-path suite |
| `5b84de09daed602a5cf80f91505a03c0ecf59e2e` | B `91be96df` | python product-integration browser gate (55 checks) + servers/fixtures |
| `eb443f532a5045057d771b51a94b7323cf08203d` | B `655f1f19` | B evidence/push record doc |
| `0b03dd8ef2dd6d840192b327f37e23291239c9f3` | C `fdcd0393` | storage packaged-build gate + shared engine/check table |
| `a8e41f331799310f8255d28b65b699f3718ca7db` | D wiring (this round) | suite registration, see §3 |
| `a4c84de9c27d5830c6f8a237ddf27ae88c46931f` | D docs (this round) | this document + M3C-D-INTEGRATION.md §5a corrections |
| *(this commit)* | D CI-fix (this round) | POSIX tree-kill fix caught by CI (§6) + this record |

No force push anywhere; the remote branch only moves forward. A/B/C
histories untouched.

## 3. D wiring commit `1ff69248`

- `tests/helpers/browser-gate-suites.cjs` — appended
  `e2e-m3c-storage-built.cjs` (C) and `e2e-m3c-python-integration.cjs`
  (B). Default list 14 → 16.
- `tests/browser-gate-orchestrator.test.cjs` — the registry pin updated in
  the SAME commit, as A's handoff requires (test renamed to "14 original +
  review-round registrations"; nothing else changed).
- `tests/run-unit.cjs` — registered `browser-gate-orchestrator.test.cjs`
  so review A's infrastructure test actually RUNS under `npm test`
  (requirement: new infra tests may not exist only as files). Its
  real-vite-preview test remains gated behind
  `BROWSER_GATE_ORCH_REAL_PREVIEW=1` and is exercised separately in §4
  step 1.
- **Official CI uses the fixed orchestrator with no workflow change:**
  `.github/workflows/ci.yml` invokes `node tests/run-browser-gates.cjs`,
  whose CLI contract review A kept while replacing the internals with the
  single-run orchestrator helpers. Verified by reading the refactored CLI
  (thin wrapper over `browser-gate-runner.cjs`) and by the CI runs on the
  pushed heads (§6).

## 4. Verification sequence (results, first results preserved)

Environment note, recorded BEFORE any gate ran: port 4173 was held by a
stale `vite preview` (PID 36128, command line identified via CIM:
`...\Locus-product-m3c-clean\node_modules\...vite.js preview --port 4173
--strictPort`, created 2026-10-04 13:38:58) — a leftover from the finished
M3c clean-checkout parallel task, i.e. the same stale-preview episode
M3C-REVIEW-C.md §3 recorded as its first failure. All parallel tasks of
this round are closed and pushed, so the OPERATOR (not the orchestrator —
the orchestrator still refuses to touch processes it does not own)
terminated it (`taskkill /PID 36128 /T /F`), and the port was verified
free before the round. No other process was touched.

### Step 1 — orchestrator fault-path suite

```
node tests/browser-gate-orchestrator.test.cjs
  → 13 passed, 1 skipped, no failures; exit 0
BROWSER_GATE_ORCH_REAL_PREVIEW=1 node tests/browser-gate-orchestrator.test.cjs
  → 13 passed, 0 skipped, no failures; exit 0   (real vite build → readiness
    identity → verified shutdown → port released; 4173 free afterwards)
```

Behavior contract re-verified on the integration head (each pinned by a
named test): no auto-retry (suite runs exactly once; first failure is the
final verdict and folds into the aggregate exit code); safe later suites
still run after a failure; unknown suite name → exit 2, nothing built or
started; cleanup of owned processes before exit, and a failed cleanup is
never reported as success; foreign port holder refused, never killed; the
readiness probe adopts only a preview serving the dist this run built
(stale/foreign content fails readiness).

### Step 2 — install → build → full unit gate (integration worktree)

```
npm ci          → exit 0 (86 packages)
npm ls locus-runtime locus-harness
  → both resolve to exactly the pinned full SHAs (§1)
npm run build   → exit 0; dist/tests/m3c-storage-host.html +
                  assets/storageHost-V6KPtMcm.js (32.31 kB) present
npm test        → all 25 suites passed; exit 0
                  (24 prior + browser-gate-orchestrator.test.cjs)
```

### Step 3 — all registered browser gates, ONE round, first results kept

`node tests/run-browser-gates.cjs` (no args = the registered 16) — single
orchestrator run, one build, one owned preview, every suite exactly once.
**No suite failed; there was no CDP readiness first-failure this round and
no rerun of any suite. Exit code 0.** First (= final) result per suite:

| Suite | First result |
|---|---|
| e2e-ui | PASS |
| e2e-responsive | PASS |
| e2e-grep | 13 passed |
| e2e-approval | PASS |
| e2e-network | PASS |
| e2e-capabilities | 33 checks passed |
| e2e-image | 56 passed |
| e2e-skill-instances | 28 checks passed |
| e2e-persistence | 26 passed |
| e2e-wire | 16 passed |
| e2e-product-joint | 20 passed (real Pyodide boot through the product chain) |
| e2e-runtime-host | 22 passed |
| e2e-harness-host | 12 passed |
| e2e-m3c-storage-adapters (SOURCE gate) | 24 checks passed (23 shared + E0) |
| e2e-m3c-storage-built (PACKAGED gate) | 27 behavior/audit checks + 2 negative self-proof cases passed |
| e2e-m3c-python-integration (NEW, B) | 55 passed |

Environment record kept distinct from assertions (per discipline): the
B-CDN line of the python gate reported `assets=12 realCdnDownloads=0
cacheHits=12` — the pinned-CDN cache was warm; this is an environment
observation, not a gate claim (the product-joint gate's J2 separately
records a REAL in-page CDN download on its own runs, and B's own evidence
record shows the CDN reachable with 8/12 real downloads on its first run).

Full log preserved at `m3crc-integration-browser-round.log` (worktree
root's parent directory during the session; not committed).

### Step 4 — python product gate (B) specifics

55/55 within the round above. Coverage table of M3C-REVIEW-B.md §3
verified against the gate's actual assertion blocks (judged by execution
chain, not assertion counts): B-FS1–4 (permission + skill confirm/deny/
policy), B-NET1/1b/2 (counter-credibility allow control + pre-dispatch
refusal), B-BOOT1b–d (integrity negative at the product, no fake ready,
failure reaches the model), B-PY0–B-PY14 (authority battery with ZERO
counter deltas, package authority, creator-CSP presence, commit-phase
guard), B-PLG0–B-PLG4 (payload through CapabilityManager →
session.prepare; broken payload = honest failure, no silent fallback;
disabled → core-only), B-LIFE1–3 (cancel + session boundary, honest
`task_cancelled_committed` / non-projected dead-session result +
`session_changed` warning), B-TOT/B-TOTb/B-TOTc (exactly-one dispatch,
URL pinning, zero page errors). Pure-Runtime rows of the table (lifecycle
recovery internals, architecture phases, wheel form) are justified
per-scenario in B §3/§7 — each names where the behaviour is pinned at the
fixed runtime SHA; no row is covered by an assertion-count argument.

Seam decision (review requirement): B proposed NO new production seam —
all injection goes through existing documented seams (`?e2e=1&wire=1`,
`__locusWire`, `capabilityComposition.*`, `actions.*`, `pythonRuntime()`,
test-side document-start fetch patch). The optional orchestrator-level
`/fetch` middleware for a relay-leg positive control stays UNIMPLEMENTED
by agreement: B's python zero-dispatch claims do not depend on the relay
leg, and the relay leg remains covered by the self-contained
`e2e-network` suite. No permission check was closed and no alternative
production execution chain was introduced.

### Step 5 — storage gates reported separately

- **Source-ESM gate** (`e2e-m3c-storage-adapters.cjs`, kept, header now
  states its nature): 24/24 — proves storage semantics on raw source ESM.
  It is NOT packaged-build evidence and is never counted as such.
- **Packaged-build gate** (`e2e-m3c-storage-built.cjs`, new): 27 checks
  (same 23-check shared table + GA resource audit / GB entry-chunk
  identity / GC main-entry absence / GD zero page errors) + 2 negative
  self-proof cases, against `dist/tests/m3c-storage-host.html` served by
  the run's owned preview only. This is the packaged-artifact proof.

### Step 6 — clean checkout of the integration head

Fresh `git clone` (no hardlinks) at `1ff69248004a949d03801a5771ba5ea934ce
1248`, then, in order: `npm ci` → `npm run build` → `npm test` →
`node tests/run-browser-gates.cjs` (full round).

**First failure, kept on record (not overwritten by the later green):**

- `npm ci` exit 0; `npm run build` exit 0; `npm test` → **1 suite(s)
  FAILED**. Defect of the operator's logging, recorded here: the run was
  piped through `tail`, so the failing suite's NAME was not captured in
  the first log — only the summary line survives.
- Diagnostic re-run with full capture (same clone, unchanged tree):
  `m3c-runtime-adapter.test.mjs` — 34 passed, **1 failed**: "RA1 the api
  file publishes nothing global and adds no export beyond the frozen §3
  shape (code only)"; process exit 1. Byte-level root cause, directly
  verified: the global git `core.autocrlf=true` materialized the working
  tree with CRLF (`src/product/runtime-api.js` on disk ends lines `\r`;
  the HEAD blob ends `\n`), and RA1's exact-line frozen-shape audit
  (`code.split('\n')` + full-line equality against
  `"export * from 'locus-runtime';"`) fails on the trailing `\r`. This is
  the SAME documented Windows checkout artifact M3C-REVIEW-B.md §5
  recorded — deterministic, not a flake: the re-run failed identically.
- Disposition, per the B-round precedent: an environment/checkout
  operation, ZERO source or test changes, no assertion weakened — the
  clone was normalized (`core.autocrlf false` + index re-materialization
  + `reset --hard`), `file` confirms the file is LF-only afterwards.
- Normalized re-run: `npm test` → **all 25 suites passed**, exit 0.

**Second first-failure on the normalized tree (kept, not retried away):**
the post-normalization full browser round failed at exactly one suite —
`e2e-m3c-python-integration.cjs` (the other 15 suites all passed; suite
exit 1; round exit 1). Inside the gate: **54 passed, 1 failed — B-PY1**
("python js.fetch denied at the policy layer with the marker"). The
recorded verdict shows the security properties HELD in that run —
`fail:true` (the run failed honestly, never passed) and `delta:0` (ZERO
probe-server dispatch: the fetch never reached the network) — but the
tool-result output was a Pyodide `eval_code_async`/"run_async"
traceback WITHOUT the `Python network access is disabled in Locus`
marker (the gate evaluates the marker against the FULL output, so this
is not a truncation artifact). This is the E3-family error-text
instability the gate's own comment reserves as evidence ("a failure
WITHOUT the marker is a FAIL, not a re-observation"). Per the review
discipline:

- The failed round stands as the recorded result of that round
  (log `m3crc-clean-browser-round2-normalized.log`); no suite was
  re-run inside it, no log was overwritten.
- ONE separate diagnostic re-run of the python gate alone was performed
  and recorded side by side (standalone, throwaway checkout, the
  B-PY1 diagnostic string widened from 300 to 6000 chars — a LOGGING
  change in the diagnostic copy only; the committed gate file stays
  byte-identical to review B's pushed version): **55 passed, 0 failed,
  exit 0** (log `m3crc-python-gate-diagnostic.log`). It captured no
  traceback because nothing failed.
- **Root cause: UNDETERMINED (未定因).** Four runs of the gate today:
  worktree round GREEN, clean-checkout round 1 (CRLF tree) GREEN,
  clean-checkout round 2 FAILED at B-PY1, standalone diagnostic GREEN.
  The failed round's 300-char verdict slice did not capture the
  traceback tail, so the exact exception text is unknown. No
  environment-vs-product attribution is made. Occurrence count and
  capture gap are stated exactly as above; the item is handed to review
  as the E3-family recurrence at the product combination, with the
  suggestion that a follow-up change widen the gate's diagnostic slice
  (a reviewed-deliverable change, deliberately NOT slipped into this
  integration).

Same-tree coherent chain on the normalized checkout: `npm ci` (exit 0,
deps at the pinned SHAs) → `npm run build` (exit 0) → `npm test`
(25/25, exit 0) → browser round 2: **15/16 suites passed; python gate
54/55 with the B-PY1 marker-miss recorded above** (round exit 1). The
worktree round (step 3) remains the 16/16 single-round result; this
clean checkout adds the CRLF lesson and the B-PY1 flake data point.

GitHub CI on the pushed final head re-verifies the chain from a
from-scratch ubuntu checkout (§6) — there `core.autocrlf` defaults to
false and the CRLF artifact cannot occur. If the B-PY1 instability
fires in CI, the single-run orchestrator preserves the first failure by
design; that outcome will be reported as-is, not rerun into green.

### Step 7 — CI on the pushed final head

*(recorded after push; see §6.)*

## 5. Corrections this round makes to M3C-D-INTEGRATION.md

History kept, nothing deleted — the original statements stand with inline
correction markers, and a new §5a summarizes:

1. **"Packaged 14/14" retracted for the storage suite.** At the D head the
   storage browser suite was source-ESM only; the packaged-artifact proof
   exists only since review C (`e2e-m3c-storage-built.cjs`). Correct
   current phrasing: 16 registered gates, of which the storage area is
   covered by BOTH gates, each reported under its own name.
2. **"Environment, not product" root-cause label retracted** (CDP
   cold-start readiness flake, branch-push run vs same-commit-green PR
   run): the observation supports only "not deterministic at that commit".
   No environment root cause was proven, so none is claimed.
3. **Retry sentence corrected:** "the orchestrator now retries a failed
   suite once" described the pre-review-A orchestrator and is false
   today — review A deleted the auto-retry; first failure is final.
4. The zombie-preview episode's factual part (a foreign process held the
   port) was observed and stands; its "tree-kill added" remedy description
   is superseded by review A's bind-probe refusal + identity readiness +
   owned-process cleanup.
5. **Python E3 SystemError:** rooted and fixed in the SOURCE repo during
   F04a (Pyodide exception-bridging diagnosis); this round's product gates
   did not exercise that runtime-internal scenario and no new occurrence
   appeared; the item stays independently tracked — no product-side
   resolution is claimed here.
   **[RETRACTED 2026-10-05, second review round — the original text above
   is kept for history and is superseded by the bracketed correction.**
   Both of its conclusions are withdrawn: (a) the historical E3 root
   cause is UNCONFIRMED — "rooted and fixed" claimed more than the
   records establish; (b) "no new occurrence appeared" is CONTRADICTED by
   this same round's clean-checkout browser round, which recorded a
   marker-less Pyodide-traceback occurrence at B-PY1 (§4 step 6: honest
   failure + zero dispatch held, policy marker absent, root cause
   UNDETERMINED, failed round preserved). For that round the behavior
   gate's verdict is 54/55 — one FAIL — and only the observed security
   properties (honest failure, zero dispatch) are established; the
   diagnostic 55/55 re-run is a separate observation that neither
   overrides the first failure nor proves a root cause. Whether the
   round-2 occurrence shares a root cause with the historical E3 is
   unproven and requires a dedicated experiment; none has been run.
   See §8.]

## 6. Push + CI record

**Push mechanism.** git's HTTPS transport to github.com was down for the
whole session (connect timeouts, the recurring outage; `gh api` still
worked). The three input branch heads were re-verified LIVE through the
API immediately before the push (byte-identical to §1; the target branch
still at the baseline `b7da804`), then the six commits were pushed
through the documented Git Data API fallback: each local commit rebuilt
as a byte-blueprint (message trailing newlines stripped, dates in
`<unix> +0000` form — the API's canonical commit bytes), then uploaded
object-by-object — 24 blobs (every SHA verified equal to the local
object), 6 trees (every SHA byte-identical), 6 commits (every SHA equal
to the rebuilt local object) — and finally a NON-FORCED ref update
(`PATCH`, `b7da804` → `a4c84de9`). Trees and file bytes on the remote
are exactly the cherry-picked/wired bytes; only commit-metadata bytes
differ from the pre-push local objects, so the remote SHAs (§2) are
UTC-normalized twins of the local ones.

**CI first failure on the first pushed head (kept; runs 37224450842
push / 37224454061 pull_request):** the unit job FAILED — the newly
registered `browser-gate-orchestrator.test.cjs` reported
`13 passed, 1 skipped, 2 FAILED` on ubuntu, with `CHECK FAIL: grandchild
dead` and `CHECK FAIL: grandchild port released`. Root cause, read
directly from the CI log and the code: A's `killTree` POSIX branch
signaled only the root pid (`process.kill(pid, 'SIGTERM')`), so a
spawned grandchild survived — Windows was exact (`taskkill /T`), which
is why both local runs were green. This is a REAL Linux defect in the
review deliverable, caught by exactly the registration §3 made (the
same mechanism would also have let a timed-out suite's own children,
e.g. headless Chrome, survive on POSIX). The two failed CI runs stand
as the first-failure record.

**Fix (same commit as this record; POSIX-only, Windows flags untouched;
no assertion changed, no timeout changed):** `killTree` now signals the
whole process group (`-pid`) on POSIX, falling back to the single pid
when the target is not a group leader; every process the orchestrator
owns — preview, suite subprocess, and the test's own fixtures — is
spawned `detached` on POSIX so the root is its own group leader and the
negative pid reaches the tree. Local Windows regression after the fix:
`13 passed, 1 skipped, no failures` and, gated, `13 passed, 0 skipped,
no failures` (real vite build → readiness identity → verified shutdown
→ port released). Linux proof comes from the CI run on the final head
(below) — it cannot be produced locally on this Windows machine.

**Final head + CI.** A commit cannot contain its own hash: the exact
final pushed head SHA and the CI run IDs for that exact head are
recorded in the PR #5 description (the non-git record tying head to
runs). If the branch moves after review, newer runs supersede those.

## 7. Not verified here / residuals

- **B-PY1 error-text instability (top item for review):** one observed
  occurrence in four runs today (see §4 step 6) — honest failure +
  zero dispatch held, the policy marker was replaced by a Pyodide
  traceback; root cause UNDETERMINED, exact exception text not captured
  (300-char verdict slice). Follow-up suggestion: widen the gate's
  diagnostic slice in a reviewed follow-up change.

- The two cores' own suites at the pinned SHAs (runtime TPR wheel gates,
  runtime-internal lifecycle recovery, browser-authority architecture
  phases) are accepted as the fixed-dependency evidence; per B §3 they are
  pure-Runtime scenarios and were not re-driven through the product page.
- Relay-leg positive control inside the B gate (needs a preview `/fetch`
  middleware) — intentionally not built; `e2e-network` keeps the relay
  coverage.
- Wheel-form payloads through the Product composition — frozen TPR
  boundary at the pinned harness; stays runtime-boundary coverage.
- Nothing merged, published, or deployed; M4 not entered.

## 8. Second review round (2026-10-05): F1 bounded cleanup, F2 self-proof judge, F3 E3 wording

Round scope: Product TEST INFRASTRUCTURE and evidence wording ONLY — no
production implementation change, no dependency change, no core-repo
change, M4 not entered.

Round start (all verified before any work): PR #5 OPEN, base `main`, head
`refactor/m3c-integration` == `2008d90a1d745c521fbccffe3e6c47be572026c1`
== the round's expected head (checked live via the GitHub API; git's
HTTPS transport to github.com was down the whole session again — connect
reset/timeouts — so all remote verification and the push went through the
API, see §8.7). Work done in a DEDICATED clean worktree
(`locus-m3c-review-r2`, branch `fix/m3c-review-r2` cut from that exact
head); no other worktree was touched, nothing was reset or cleaned.
Dependencies re-verified pinned in package.json AND package-lock.json:
runtime `2435a57f…`, harness `347eed99…` (§1); `npm ls` resolves exactly.

### 8.1 F1 — timeout must be bounded; cleanup verified, not assumed

Defects confirmed by the review and reproduced here:

- `runSuiteProcess`'s timeout callback only fired the termination REQUEST
  (POSIX: one group SIGTERM) while the promise kept waiting for the
  child's exit event — a suite that ignores SIGTERM hangs the
  orchestrator past its own timeout (review repro: real Node child with
  an empty SIGTERM handler; `runSuiteProcess(fixture, 500)` still
  unsettled at 1800 ms until an external SIGKILL).
- `startPreview().kill()` returned `{ok:true}` UNCONDITIONALLY when the
  root had already exited — zero verification that the rest of the owned
  tree was gone.

First-failure evidence, executed on the UNMODIFIED baseline:

- Windows-executable slice (real vite preview, root killed root-only,
  then `kill()`): `KILL-RESULT {"ok":true}` with `isAlive()=false` — the
  unconditional branch, shown live (log `f1-repro-preview-root-exited.log`,
  trimmed into the PR body).
- The SIGTERM-hang is a POSIX behavior and this machine has no WSL — it
  was NOT executable locally. Its committed proof is the POSIX-only test
  below, which EXECUTES on Linux CI (the unit job runs it for real);
  recorded as executed-on-CI, honestly distinguished from local
  execution.

Implementation — ONE termination algorithm, two consumers:

- NEW `tests/helpers/browser-gate-cleanup.cjs`: `ownTreeIdentity`
  (spawn-time identity — POSIX group id = root pid, every owned spawn is
  `detached`); `terminateTree`: SIGTERM to the OWNED GROUP → bounded
  grace → SIGKILL to the SAME group while members survive → bounded
  confirmation → an explicit cleanup FAILURE if still unconfirmed. A root
  that exited on its own never skips the group: POSIX verifies (and if
  needed cleans) it; Windows — which has no group to signal after root
  death — reports an explicit `win32-root-exited` FAILURE instead of a
  silent ok. A taskkill-vs-natural-exit race (root verified alive at
  attempt, gone when taskkill ran) is a COMPLETED attempt, kept distinct
  from the never-attempted root-exited case. Strangers are never touched
  (no port/name/machine scans; only explicitly spawned, identity-held
  trees). `killTree` remains the low-level signal REQUEST only; its
  taskkill call is now itself bounded (10 s) with visible errors.
- `browser-gate-runner.cjs` `runSuiteProcess`: the timeout runs the shared
  `terminateTree` and settles WITHIN the bounded terminate+confirm
  window; the verdict STAYS `timeout` even when the child exits 0 during
  the kill; an unconfirmed cleanup is ATTACHED (`result.cleanup`) and
  named in the failure text — it can never swallow the timeout. Exactly
  one settlement under exit/error/timeout/cleanup races; timers and
  listeners released on settle.
- `browser-gate-preview.cjs` `startPreview().kill()`: idempotent
  (memoized first verdict), verified via the same helper; root-exited →
  POSIX verifies group-gone / cleans survivors, Windows fails explicitly.

Required-matrix tests, all in `tests/browser-gate-orchestrator.test.cjs`
(the 13 prior tests are preserved; the suite is now 17):

| Requirement | Test |
|---|---|
| A normal hung suite → timeout, killable | existing `runSuiteProcess: exit/signal/timeout classified, hung suite tree-killed (real)` |
| B SIGTERM-ignoring suite: TERM received but survived, then SIGKILL + bounded settlement | `F1 timeout: a SIGTERM-ignoring suite still settles as timeout, bounded (POSIX; real)` — fixture records the TERM receipt to a file; the run survives the whole TERM grace (elapsed ≥ grace) proving it did not die on TERM; pid verified dead; POSIX-only → executes on Linux CI |
| C root exited, group child still serving (ignores TERM, holds a test port) → cleaned, port rebinds | `F1 cleanup: root exited, owned group still serving — cleaned, port rebindable (POSIX; real)` — functional death proof: HTTP gone AND the port binds again (not `kill(pid,0)` alone); POSIX-only → executes on Linux CI |
| preview root self-exit → verified, never unconditional ok (both platforms) | `F1 preview kill after root self-exit: verified, never unconditional ok (real vite preview)` — win32: explicit failure ("cannot verify"); posix: verified group-gone ok; repeated `kill()` safe; port released |
| D all suites pass but cleanup incomplete → non-zero run | existing `cleanup failure: never reported as a clean success` + the runner folding `cleanup.ok=false` into a non-zero exit |
| E timeout vs natural-exit race → one verdict, no unhandled rejection | `F1 race: timeout vs natural exit — exactly one verdict, no unhandled rejection (real)` — five deadlines around the fixture's exit moment |
| F stranger service stays alive | existing `busy port: refuse to run, foreign fixture untouched (real)` |
| G the 13 prior fault-path tests preserved | unchanged, still green |

Fixture discipline: readiness via explicit ready-FILES the fixtures write
at their own ready points (never "sleep and assume"); TERM receipts
recorded to files; every fixture is hard-killed in `finally` — a failed
test leaves no SIGTERM-ignoring orphan behind.

CI wiring: the unit job now sets `BROWSER_GATE_ORCH_REAL_PREVIEW=1`
(`.github/workflows/ci.yml`) — the real vite-preview lifecycle test and
the two POSIX-only F1 tests execute in CI instead of being local-only
evidence.

Local results (Windows): plain → `17 passed, 3 skipped, no failures`;
with `BROWSER_GATE_ORCH_REAL_PREVIEW=1` → `17 passed, 2 skipped, no
failures` (only the POSIX-only F1 pair skips). Linux execution proof:
CI unit job on the pushed head (§8.7).

### 8.2 F2 — the negative self-proof judges evidence, not exceptions

Defect: `selfProofCase` treated ANY `runBuiltGate` exception as the
expected rejection (`!booted ⇒ PASS SELFPROOF`). Both review injections
were reproduced on the UNMODIFIED baseline before any edit:

- injection 1 — browser launch failure (`CHROME=C:/nonexistent/chrome.exe`):
  `PASS SELFPROOF-A … driver error (as required): Chrome executable not
  found` + `PASS SELFPROOF-B` (log `f2-repro1-launch-failure.log`);
- injection 2 — the review's exact string (`chrome.waitForCdp` patched to
  throw `CDP browser endpoint unavailable: readiness timeout (phase=cdp)`):
  `PASS SELFPROOF-A/B` again (log `f2-repro2-cdp-injection.log`).

Both proved only that the browser did not run — nothing about the gate's
ability to detect a broken artifact.

Implementation:

- NEW `tests/helpers/m3c-storage-built-verdict.cjs` — THE judge, one
  implementation shared by the driver and the unit tests.
  `classifySelfProof(caseKind, expected, result)` consumes STRUCTURED
  driver outcomes (`infrastructure` with phase `browser-launch`/`cdp`/
  `navigation`, `no-boot`, `boot-error`, `assertion`, `completed`) plus
  request-level observations — never exception strings. A pass requires
  POSITIVE evidence: case A — the exact host URL requested by the
  browser (CDP Network), an explicit 404, the host never booting, no
  fallback load, and the throwaway server's own log corroborating;
  case B — the host HTML served (200) first, the exact entry-chunk
  request failed/404, the host never booting, no fallback, server log
  corroborating. Infrastructure failures, unrelated ready timeouts
  (all resources 200), fallback pages, and the full dist misfed as a
  broken scenario all FAIL.
- `tests/e2e-m3c-storage-built.cjs`: `runBuiltGate` returns classified
  outcomes (it no longer throws for classified failures); the driver
  attaches CDP to `about:blank` FIRST, wires Network listeners BEFORE
  navigating (the target page's FIRST request is observed), then
  navigates; a fallback is any 200 outside {the host page, hashed dist
  assets}; the negative flow breaks TEMP COPIES only (the real dist/ is
  never modified). The positive gate is unchanged: real dist via the
  run's vite preview, the shared 23-check table, GA–GD audit, throwaway
  profile, no dev server, no source fallback.
- `tests/helpers/chrome.cjs` `connectToTarget`: ADDITIVE CDP event
  subscription (`on(method, handler)`); the message pump and the
  request/response API are unchanged (chrome-helper suite green).
- NEW `tests/m3c-storage-built-verdict.test.cjs`, REGISTERED in
  `tests/run-unit.cjs` (25 → 26 suites): the review's injections, the
  real A/B observation shapes, the near-misses (chunk actually served,
  chunk never requested, no server corroboration, unknown case kind,
  null result), and a source pin that the driver uses THE shared judge.
  21 checks.

Verification (Windows, real Chrome):

- Fixed orchestrator, packaged storage gate: 27 behavior/audit checks +
  BOTH negative self-proofs PASS with request-level evidence, exit 0
  (log `f2-orchestrator-storage-gate.log`). Case A evidence:
  `hostRequest{status:404}` + serverLog 404, `pageBooted:false`,
  `fallbackLoads:[]`. Case B: `hostRequest{status:200}`,
  `chunkRequest{status:404,failed:true}` + serverLog 404, the sibling
  hashed assets 200, no fallback.
- The same two injections re-run on the FIXED gate: `FAIL SELFPROOF-A/B —
  browser/CDP infrastructure failure (…)` with the phase named, counted
  into `selfProofFailures`, gate exits non-zero (logs
  `f2-fixed-injection1.log` / `f2-fixed-injection2.log`).
- Judge unit suite: 21/21.

### 8.3 F3 — Python E3 wording unified with the records

No Python behavior changed, no marker assertion weakened, no history
rewritten — the withdrawn sentences stay in place with explicit
retraction annotations.

- `tests/e2e-m3c-python-integration.cjs` (E3 comment): no longer claims
  the historical glitch "is fixed at the pinned runtime". Now: E3-family
  root cause UNDETERMINED; a failure WITHOUT the marker is a FAIL (single
  attempt, no auto-retry); fail=true + zero dispatch establish only the
  OBSERVED security properties; same-root-cause attribution with the
  historical E3 requires a dedicated experiment. The withdrawn sentence
  is quoted inside the retraction note.
- `M3C-REVIEW-VERIFICATION.md` §5 item 5: original text kept, RETRACTED
  inline — "rooted and fixed" and "no new occurrence appeared" are both
  withdrawn; the latter was contradicted by this same record's §4 step 6
  (B-PY1 marker-less traceback, root cause UNDETERMINED). The
  behavior-gate verdict for that round remains 54/55 — one FAIL; the
  diagnostic 55/55 re-run is a separate observation that neither
  overrides the first failure nor proves a cause.
- `M3C-D-INTEGRATION.md` §5a item 3: the "(rooted/fixed …)" parenthetical
  annotated as withdrawn as unproven.
- PR #5 body: the previous body was checked — it contained no
  fixed/rooted E3 claim (its B-PY1 wording was already "root cause
  UNDETERMINED"); the updated body states explicitly that the historical
  E3 root cause is UNCONFIRMED and points at the §5 retraction.

### 8.4 Round-2 verification sequence (results, in order)

```
npm ci                                             → exit 0; npm ls: both cores at the pinned SHAs
npm run build                                      → exit 0
node tests/m3c-storage-built-verdict.test.cjs      → all 21 judge checks passed
node tests/browser-gate-orchestrator.test.cjs      → 17 passed, 3 skipped, no failures; exit 0
BROWSER_GATE_ORCH_REAL_PREVIEW=1 node tests/browser-gate-orchestrator.test.cjs
                                                   → 17 passed, 2 skipped, no failures; exit 0
BROWSER_GATE_ORCH_REAL_PREVIEW=1 npm test          → all 26 suites passed; exit 0
CHROME=C:/nonexistent/chrome.exe node tests/e2e-m3c-storage-built.cjs
                                                   → FAIL SELFPROOF-A/B (infra), exit 1 — as required
(injected waitForCdp) node <repro>                 → FAIL SELFPROOF-A/B (infra), exit 1 — as required
node tests/run-browser-gates.cjs e2e-m3c-storage-built.cjs
                                                   → 27 checks + 2 negative self-proofs passed; exit 0
node tests/run-browser-gates.cjs   (all 16 registered gates, ONE round, no retry)
                                                   → all 16 browser gates passed; exit 0
```

The final full round: 16/16 suites in a single single-retry-free round;
the python gate 55/55 (B-PY1 green this run — one more observation, not a
root-cause finding); B-CDN environment record `assets=12
realCdnDownloads=0 cacheHits=12` (warm pinned-CDN cache — an environment
observation, recorded separately from every gate assertion). Logs are
kept worktree-adjacent during the session; only the trimmed evidence
above enters the repo (oversized logs stay out of git).

### 8.5 This round's first failures (all kept on record)

1. **F2 injections (the round's assigned first failures):** reproduced on
   the UNMODIFIED baseline BEFORE any edit (§8.2) — PASS SELFPROOF under
   a launch failure and under the review's exact CDP failure; preserved,
   then re-run green-to-red on the fixed gate as the corrected behavior.
2. **F1 kill-race check failure during development (Windows):** the new
   race test caught a REAL race — taskkill reported failure ("not found")
   when the fixture exited during taskkill's own startup latency, which
   the first terminateTree draft misreported as a cleanup failure (would
   have failed whole runs for a Windows scheduling race). Fixed with the
   completed-attempt semantics (§8.1); the committed race test now pins
   exactly this contract and is green.
3. No suite-level first failure occurred in the final verification runs
   above; the two POSIX-only F1 tests have their FIRST EXECUTION on Linux
   in CI (§8.7) — their result there is recorded as-is, whatever it is.

### 8.6 Round-2 residuals

- The POSIX-only F1 tests execute on Linux CI only (no WSL on this
  machine) — platform execution is recorded per-platform, never implied.
- B-PY1 error-text instability: root cause still UNDETERMINED (unchanged;
  this round made no Python-behavior change and ran no experiment).
- Nothing merged, published, or deployed; M4 not entered.

### 8.7 Round-2 push + CI record

Push mechanism: git's HTTPS transport to github.com was down for the whole
session again (connect reset/timeouts; `gh api` worked). The three round-2
commits were normalized locally to the API's byte-blueprint form (message
trailing newlines stripped — `git commit -m` appends one; the UTC
`<unix> +0000` dates were already right), then uploaded object-by-object
through the Git Data API with EVERY object's SHA verified equal to the
local git object before the ref moved: 15 blobs, 3 trees (base_tree +
changed entries), 3 commits, and finally a NON-FORCED ref update
(`PATCH … force:false`, `2008d90a` → `358f3cca`). Nothing on the remote
was rebuilt or rewritten; the branch only moved forward; the local branch
was set to the pushed chain before uploading (no local/remote divergence).

Round-2 pushed commits (SHAs as on the remote — identical to the local
byte-blueprints):

| Pushed commit | Content |
|---|---|
| `9dcd05bb` | F1: shared bounded verified owned-process cleanup + orchestrator tests + CI real-preview wiring |
| `0ef46071` | F2: structured negative-self-proof judge + driver + unit suite (run-unit 25→26) + chrome.cjs additive event subscription |
| `358f3cca` | F3: Python E3 wording unified + this round's verification record (§8) |

CI on the pushed head `358f3cca…` — both runs GREEN, and this is the
FIRST Linux execution of the POSIX-only F1 tests:

- PR run **37275926584 — success** (unit job: all 26 suites passed; the
  orchestrator suite reported **17 passed, 0 skipped, no failures** on
  ubuntu — the SIGTERM-ignoring-timeout test and the orphaned-group
  cleanup test EXECUTED for real there, as did the real vite preview
  lifecycle via the new `BROWSER_GATE_ORCH_REAL_PREVIEW=1` wiring;
  browser job: all 16 gates green on ubuntu).
- Push run **37275921233 — success**.
