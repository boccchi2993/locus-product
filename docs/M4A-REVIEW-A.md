# M4a review round 1 — fix A (candidate lane: F1 input channel, F2 Product identity)

Status: implemented on `fix/m4a-review-candidate`, base `refactor/m4a-integration`
@ `da5bb09526e61e75925c44cba8907257398eaf56` (PR #9 head, unmodified), 2026-10-05.
Scope: `scripts/core-main-candidate.mjs`, `.github/workflows/core-main-candidate.yml`,
`tests/core-main-candidate.test.mjs`, NEW `tests/core-main-candidate-workflow.test.mjs`,
`docs/M4A-A-CORE-CANDIDATE.md`, this file. Nothing else touched — no production
`src/`, no committed `package.json`/lock, no preflight tool, no `tests/run-unit.cjs`
registration (agent D registers the new suite), no existing CI workflow.

---

## F1 — dispatch inputs must never land in shell source

### Finding

The workflow's sanity and capture steps interpolated dispatch input bytes
directly into bash source:

```yaml
if [ '${{ inputs.source }}' = 'explicit' ]; then
  for sha in '${{ inputs.runtime_sha }}' '${{ inputs.harness_sha }}'; do
```

A value that closes the single quote reaches bash as code. The round-1 review
reproduced this with a harmless marker: the marker printed **before** the SHA
validation errored — proving the regex check does not prevent execution.

### First-fail evidence (old baseline `da5bb09`, unmodified step text)

The committed run source was extracted verbatim, `'${{ inputs.* }}'` tokens
were substituted textually the way GitHub Actions does, and the result was
executed as GitHub executes steps: `bash --noprofile --norc -eo pipefail <script>`.
Only `echo` markers were used — no credentials, no external network. Scripts
and captured outputs are preserved in the review work area
(`evidence/payload*.sh`, `evidence/payload*.meta.json`).

| payload | input field | value (harmless marker only) | observed (old baseline) |
| ------- | ----------- | ----------------------------- | ----------------------- |
| A | `source` | `explicit'; echo CAND_MARKER_RAN; f='` | **validation silently skipped, exit 0** — the payload's quote spans into the surrounding text, the check compares corrupted text (`[ "explicit; echo …" = "explicit" ]` → false), the `then` branch with the actual validation never runs, and the step returns 0 — a green light into capture |
| A2 | `source` | `explicit' 'x'; echo CAND_MARKER_RAN; : '` | same silent skip (exit 0); the marker text stays inside a cross-line quoted word, demonstrating how far the corruption reaches (bash traced the whole `if` list as one test command) |
| B | `runtime_sha` | `0000…0000' '$(echo CAND_MARKER_RAN 1>&2)` | **marker executes, then validation fails** — stderr shows `CAND_MARKER_RAN` first, then `explicit mode requires two full 40-hex SHAs (got: '0000000000000000000000000000000000000000 ')`, exit 2; exactly the review's "marker prints, then the SHA check errors" |

The evidence scripts, verbatim:

```bash
# per case: write the substituted step source, then run it the way GH does
node f1-evidence.cjs        # substitutes '${{ inputs.* }}' textually, runs bash
# payload B on the old baseline:
#   stderr: CAND_MARKER_RAN
#           explicit mode requires two full 40-hex SHAs (got: '0000000000000000000000000000000000000000 ')
#   exit:   2   (after the marker already executed)
# payload A on the old baseline:
#   stdout: SANITY_STEP_RETURNED_0
#   exit:   0   (validation bypassed entirely)
```

### Fix

1. The inline sanity step is **deleted**; its job moved into the tool, which
   validates before any network, npm or filesystem effect (a validation
   failure exits 2 and every later step is gated on capture success, so no
   capture/apply/npm ever runs on bad input).
2. All three dispatch inputs now flow **only** through the capture step's
   `env:` mapping (`CAND_SOURCE`, `CAND_RUNTIME_SHA`, `CAND_HARNESS_SHA`)
   into `node scripts/core-main-candidate.mjs capture --checkout .` — the
   run blocks are static shell; input values never appear in them, are never
   passed through `eval`/`bash -c`, and are never re-interpreted.
3. `source`, `runtime_sha`, `harness_sha` are all checked by the same shared
   entry (`runCli` → `captureCandidate`); main/explicit stay strictly
   separated (main + SHA inputs is a usage error via env exactly as via flags).
4. A scheduled run has no inputs: empty env values mean "not provided" →
   **main mode**.
5. Rejected values are **never echoed**: error messages state only the shape
   (e.g. `rejected a value of length 47`), so hostile bytes can neither
   execute nor reach logs as material.

### Tests (new `tests/core-main-candidate-workflow.test.mjs`, 15 checks)

- **WF1 structural, against the real workflow file**: no `${{`, `eval`, or
  `bash -c` inside any run block; every `inputs.*` reference must sit in an
  env-value position; the capture step passes no mode/SHA flags in shell;
  the schedule trigger is present (its default is main mode). This fails the
  build if anyone ever re-interpolates inputs into run source again.
- **WF2 subprocess, the workflow's exact invocation shape**: the real tool is
  spawned with hostile env values — quote-close + `$(…)`, `$(…)`, backticks,
  semicolon chains, newline payloads, non-hex, uppercase — every one rejected
  as plain data with exit 2, `CAND_MARKER_RAN` never appearing in stdout or
  stderr and no snapshot file written; legal full SHAs pass and bind the real
  fixture Product commit; empty env values (schedule shape) enter main mode
  (proven offline via a repo with no commits: exit 10 at the product-HEAD
  read, not exit 2 at usage).

The tests execute the REAL workflow file and the REAL tool script — no
copied "safe implementation" exists anywhere in the test suite.

---

## F2 — the snapshot must be bound to the actual Product commit

### Finding

`snapshot.product.commit` was recorded but never checked: `apply` could
apply Product A's snapshot to Product B's clean checkout, and `verify` only
checked the two cores.

### First-fail evidence (old baseline, real tool)

Two clones of the baseline content: A at `55fd2752…`, B at `1ed88bc1…`
(one empty commit apart). Snapshot captured against A
(`capture --checkout A --source explicit --runtime-sha 2435a57f… --harness-sha 347eed99…`,
exit 0, `snapshot.product.commit = 55fd2752…`), then:

```bash
node scripts/core-main-candidate.mjs apply --snapshot f2-snapshot.json --checkout B
#   exit 0 — CANDIDATE-RESULT {"ok":true, …, "product":{"commit":"55fd2752…"}, "verified":{…}}
git -C B rev-parse HEAD      # 1ed88bc1…  ≠ snapshot.product.commit
git -C B status --porcelain  #  M package-lock.json
                             #  M package.json
ls B/node_modules/.package-lock.json   # exists — npm ran
```

Snapshot from Product A, applied to Product B: exit 0, manifest rewritten,
npm invoked, provenance "verified" — nothing rejected anywhere.

### Fix

1. One shared check, `assertProductIdentity(checkout, expectedCommit, stage)`,
   reads the **real** `git rev-parse HEAD` — a caller-supplied SHA string is
   never trusted — and reports `{expected, actual}` on mismatch.
2. `apply` runs it after preflight and **before any manifest/lock write and
   before any npm call** (mismatch ⇒ exit 20, zero writes, zero npm calls —
   asserted byte-for-byte in tests).
3. `verify` runs it first, then scopes the working tree: after a successful
   apply exactly `package.json` and `package-lock.json` may differ from HEAD
   (the allowed candidate delta). Tested-source changes or stray untracked
   files impersonating the Product commit are rejected; there is **no dirty
   bypass flag**. A HEAD that moved after apply (e.g. the delta was committed)
   is rejected by the identity check with expected/actual.
4. The workflow, after cloning the throwaway checkout, **explicitly checks
   out the captured Product commit** (`git checkout --detach <sha from
   candidate.json>`) before applying — the identity match is structural, not
   a coincidence of clone HEADs.
5. `capture` now refuses a **dirty** tree (uncommitted source must never be
   recorded as the commit's content) and an unreadable HEAD; all diagnostics
   are written outside the checkout.
6. Unchanged invariants kept: the verified workspace is never a write target,
   both cores are pinned to exact full SHAs, and nothing re-resolves a moving
   branch during a run.

### Tests (`tests/core-main-candidate.test.mjs`, rewritten, 60 checks)

All fixtures now commit **real** SHAs (`makeCheckout` returns the actual
commit; the old arbitrary `ffff…` placeholder is gone) and apply targets are
clean clones of the captured commit — the workflow's shape. Kept from round
0: captured-SHA stability under a moved ref, missing/illegal SHA failures,
install-failure workspace isolation, all provenance-mismatch rejections,
explicit/main mode isolation, informational advance-check, distinct non-zero
exit codes. New: capture refuses dirty tree / unreadable HEAD; apply refuses
a mismatched HEAD with expected+actual and **zero writes / zero npm calls**;
verify refuses a moved HEAD and out-of-scope deltas while accepting the
normal applied state; result JSON carries the snapshot identity (source,
Product commit, both core SHAs) end-to-end.

---

## Verification

- `node tests/core-main-candidate.test.mjs` → **60/60**; `node
  tests/core-main-candidate-workflow.test.mjs` → **15/15**.
- Full registered battery (`npm ci && npm test`, i.e. `tests/run-unit.cjs`
  with D's registrations) → **all 30 suites passed** — the fixes break
  nothing else on the integration baseline.
- Review rehearsal (throwaway clone OUTSIDE the worktree, verified core SHAs
  `2435a57f…` / `347eed99…`, real npm/git, fake nothing):

| step | command | result |
| ---- | ------- | ------ |
| target | clone + one empty commit → Product commit `ee483af29d4c08d8ef15c4edbc9295c8e6c6b15a` | — |
| capture | `capture --checkout <target> --source explicit --runtime-sha 2435a57f… --harness-sha 347eed99…` | exit 0; `snapshot.product.commit = ee483af2…` |
| apply | `apply --snapshot … --checkout <target>` | exit 0; real `npm ci`; `verified: {productIdentity, allowedDelta, manifest, lock, hiddenLock, installed}` all true |
| verify | `verify --snapshot … --checkout <target>` | exit 0 |
| build | `npm run build` in the applied checkout | exit 0 (~1 s) |
| F2 negative | same snapshot onto a clone at `55fd2752…` | **exit 20 (preflight)**: `Product identity mismatch … {"expected":"ee483af2…","actual":"55fd2752…"}` — zero writes, zero npm |

Tool-run commit vs target Product commit, recorded separately and never
confused: the tool ran from the fix branch worktree at
`22d46ac0638b5b71bd29da46334c145f6017cf04` (local commits; server-side SHAs
are rebuilt on push), while the verified Product commit was the target
clone's `ee483af2…`. The snapshot binds the latter; nothing in the run
conflates the two.

### Schedule status (unchanged, still true)

The candidate workflow is **not** on the default branch: GitHub runs
`on: schedule` only from the default branch, and `workflow_dispatch` requires
default-branch registration — no scheduled or manual run has executed on
GitHub, and this fix round did not merge or modify any default branch to
create one. The pipeline stays dormant until the merge chain lands; all
verification above is local.

---

## Handover

- Files: `scripts/core-main-candidate.mjs` (env inputs, no-echo rejections,
  identity binding, delta scope, capture tree checks),
  `.github/workflows/core-main-candidate.yml` (env channel, product-pin step,
  static run blocks), `tests/core-main-candidate.test.mjs` (rewritten),
  **NEW** `tests/core-main-candidate-workflow.test.mjs`,
  `docs/M4A-A-CORE-CANDIDATE.md`, this file.
- **For agent D**: register `'core-main-candidate-workflow.test.mjs',` in the
  `tests/run-unit.cjs` `SUITES` array (the tool suite is already registered).
  Nothing else changes; no existing CI is affected.
- Commits are split by finding: F1 first, F2 second. The base is PR #9's head
  `da5bb09526e61e75925c44cba8907257398eaf56`; the PR targets
  `refactor/m4a-integration` and does not touch PR #9's body, any default
  branch, the two core repos, or the verified dependency lock.
