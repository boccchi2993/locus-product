# M3c review round — integration verification record (PR #5, `refactor/m3c-integration`)

Status: **review-fix integration record.** This document records the
integration of the three M3c review-fix branches into
`refactor/m3c-integration` (PR #5): the verified inputs, the cherry-pick
map, the D wiring, the full verification sequence with first results and
exit codes, and the corrections this round makes to
[M3C-D-INTEGRATION.md](M3C-D-INTEGRATION.md) §5. It does not merge
anything, publish anything, or deploy anything; after push the branch
waits for review.

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
storage pair + one `vite.config.js` input):

| Integration commit | Origin | Content |
|---|---|---|
| `f7568ea3bfa6f8b3734c0d3bda8adb577e724647` | A `8a3848c1` | single-run orchestrator + owned preview lifecycle + fault-path suite |
| `7ce732c5661b2c7100d9c73ffbee6b21b125191a` | B `91be96df` | python product-integration browser gate (55 checks) + servers/fixtures |
| `3686a4bbaf4d6db63d66ea893069f13f3eaa545b` | B `655f1f19` | B evidence/push record doc |
| `b0d040b25ad3bac92f164ccbe6e22e7e59ea9265` | C `fdcd0393` | storage packaged-build gate + shared engine/check table |
| `1ff69248004a949d03801a5771ba5ea934ce1248` | D wiring (this round) | suite registration, see §3 |
| *(final docs commit of this round)* | D docs (this round) | this document + M3C-D-INTEGRATION.md §5a corrections |

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
  pushed head (§4 step 7).

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

## 6. Push + final CI

Push record: `refactor/m3c-integration` is pushed to
boccchi2993/locus-product as a fast-forward (no force, no history
rewrite). The three input branch heads were re-read from the remote
immediately before the push and were byte-identical to §1 — nothing
moved underneath this round.

A commit cannot contain its own hash, so this file pins the
**code-freeze point** and delegates the moving parts:

- every code-level result in §4 was produced against the tree of
  `1ff69248004a949d03801a5771ba5ea934ce1248` (the D wiring commit);
- the commits after it are documentation only (`docs/*.md`: this file
  and the M3C-D-INTEGRATION.md corrections) — no test, source, config
  or CI file differs between the freeze point and the pushed head;
- the exact pushed head SHA and the CI run IDs for that exact head are
  recorded in the PR #5 description (a CI run can only exist after the
  push; the PR body is the non-git record tying head to runs). If the
  branch moves after review, newer runs supersede those.

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
