# M4B — three-repo mainline landing and the first verified latest-main combo

Round: M4b, 2026-10-06. This document records (1) the merge chain that
landed the three-repo extraction on each repo's `main`, (2) the exact
main-sourced dependency combo captured, drilled, and pinned by this branch,
and (3) the honest boundaries of what a "latest-main" pass means. Claims
A/B/C are kept separate at the end — each stands on its own evidence.

No squash, no rebase, no force push, no admin bypass anywhere. All merges
carry an expected-head-SHA condition (REST `sha` field); each merge's
ancestry was re-derived from the compare API afterwards, and the read-only
preflight (`scripts/m4a-mainline-preflight.cjs`, with this round's
full-page fix) re-derived the whole board from live GitHub state before and
after the merge chain.

## 1. The merge chain (all merge commits, ancestry proven)

| order | repo:PR | accepted head | merge commit | evidence after merge |
|---|---|---|---|---|
| 1 | locus-runtime #1 | `2435a57ff7a66db3db88aa98a88d404c75133483` | `45bc935af91dbf5ea6c1078a939c0589853a50a8` | accepted→merge `ahead/behind_by=0`; merge→main `identical`; content audit PR-head→main `files=[]` |
| 2 | locus-harness #1 | `347eed99a415dc080b97d46d8a4271ceb19c5142` | `5ce67052be3820f607835dd8fd3df373c814ab9c` | same three checks, all clean |
| 3 | locus-product #5 | `d6a74a25a2b98293d9aa1f2a635022d8f5ed733b` | `24eb8a9166790479ff47bf8ef115670811a56ae7` | accepted→merge clean; content audit `files=[]` |
| 4 | locus-product #9 | `7870704da3aedff81fb435fb5fb5bb4b4bf2993f` | `1a8ed56cc257f7f476d92ec4143ef5a7efe0ae16` | accepted→merge clean; merge→current main `identical` |

- Post-merge preflight verdict (live, GET-only): **`landed`, exit 0** —
  runtime #1 and harness #1 `landed-traceable` with `merge→main identical`,
  product #5 `landed-traceable` with `merge→main ahead_by=22` (the #9 chain
  landed on top).
- **PR #9 base handling:** after #5 merged, #9's base did NOT auto-retarget
  (still `refactor/m3c-integration`); it was explicitly retargeted to
  `main` via the API. The retargeted diff was audited before merging:
  21 commits, all of the M4a lineage (A/B/C/D + review rounds 1–2) plus the
  one M4b preflight fix — no M3c content re-introduced, no commit lost.
  The retarget triggered no new CI run; the head's existing push+PR runs
  (both green) stand as the head's evidence.
- Runtime #1's historical blocker (run `36987973661`, browser gates, CDP
  readiness, attempt 1) was disposed of first by the authorized single
  **rerun of failed jobs**: attempt 2 completed **success** (2026-10-06
  12:12:49Z). The first failure stays on the record; the runs API keeps
  only the latest attempt's conclusion, so `run_attempt=2` plus this
  paragraph is the evidence of both.
- **New first failure after landing (kept, not rerun, root cause
  unconfirmed):** the FIRST push CI run on locus-runtime's main — run
  `37461978810` at merge commit `45bc935a` — FAILED in job
  `out-of-repo tarball consumer (headless Chrome)`: Chrome started (PID
  alive) but CDP readiness timed out (`phase=cdp elapsedMs=15000`,
  `/json/version` "unavailable"). It is a **browser-startup failure, not a
  behavioral assertion failure** (the job's two content checks passed; the
  same run's `browser gates` job passed all suites). The same content
  passed this same job on the same day (PR run attempt 2 and the branch
  push run), and no rerun was triggered. Logs preserved out-of-tree.

## 2. The captured combo (source = main, one observation per core)

```
capturedAt: 2026-10-06T12:26:14.068Z (source: "main", ref: refs/heads/main)
product:  boccchi2993/locus-product  commit 1a8ed56cc257f7f476d92ec4143ef5a7efe0ae16
cores:    locus-runtime 45bc935af91dbf5ea6c1078a939c0589853a50a8
          locus-harness 5ce67052be3820f607835dd8fd3df373c814ab9c
```

Both core mains were verified to contain the extraction implementation
(root trees hold `package.json`, `src/`, `tests/`, `tools/` — checked via
the contents API at the captured SHAs). `advance-check` after the drill:
`advanced:false` for both cores — this round's result belongs to exactly
the captured SHAs.

**What "latest-main" means here, and only this:** the combo above is the
state of both mains at the captured instant. It is not a claim that future
commits on either main will keep passing; the candidate lane
(`core-main-candidate` workflow) exists precisely to keep testing that,
one captured round at a time.

## 3. The drill (fresh LF clone outside every checkout, real transports)

Throwaway clone of product `1a8ed56c` (`core.autocrlf=false`,
`core.eol=lf`), driven by `scripts/core-main-candidate.mjs`:

| stage | result |
|---|---|
| capture (source=main) | ✓ frozen snapshot (§2); 5 failed attempts first — git→github.com:443 was down for ~2 minutes (connect timeout), then recovered; recorded, not masked |
| apply | ✓ manifest rewrite → lockfile regen → **real** `npm ci` (git deps fetched from GitHub); provenance **6/6** (productIdentity / allowedDelta / manifest / lock / hiddenLock / installed identity) |
| verify | ✓ (inside apply; provenance table above) |
| build | ✓ 982 ms |
| unit battery (`BROWSER_GATE_ORCH_REAL_PREVIEW=1`) | ✓ **31/31 suites** |
| official browser gates (`tests/run-browser-gates.cjs`, single round, no auto-retry) | ✓ **all 16 gates passed**, exit 0 |

Real-network hops, recorded as such: npm/git fetching the two cores
(apply), and the python gates booting the REAL SHA-verified Pyodide from
its pinned CDN ("loading pinned pyodide assets (12 files, cache or CDN)").
The model layer is the gates' built-in fake transport everywhere — no
model, no paid API.

## 4. This branch: the dependency update

`chore/m4b-mainline-core-pins`, branched from product main `1a8ed56c`:

1. `862fd8f` — pins `locus-runtime` → `github:…#45bc935a…` and
   `locus-harness` → `github:…#5ce67052…`; lockfile regenerated by npm
   (`--package-lock-only`), diff is exactly the two expected entries
   (specs + `resolved` SHAs). No hand-edited lockfile, no copied
   node_modules.
2. this docs commit.

The candidate drill (§3) ran against product commit `1a8ed56c` — the pin
commit's parent — with the SAME core SHAs this branch now pins. **The pin
commit's own SHA differs from the drilled SHA by design** (a dependency
commit changes Product's SHA); the distinction is kept: §3 is the drill
evidence for the combo, and the PR carries the clean-checkout gate results
for the final branch head, separately recorded there.

## 5. What this landing does and does not claim

- **A — extraction code is on each repo's main: TRUE.** Evidence: §1
  ancestry table + the post-merge preflight `landed` verdict.
- **B — Product pins and has verified one exact main-source combo: TRUE
  for the §2 instant** (after this branch's own gates/CI pass and the PR
  merges). Not a claim about future main commits.
- **C — the default-branch candidate workflow has actually executed on
  GitHub: claimed only when it happens.** Registering on the default
  branch (done by this merge chain) makes schedule/dispatch POSSIBLE; the
  first real dispatch run is recorded in the round report, not assumed
  here.
- Historical first failures are kept: runtime #1 attempt 1 (CDP), runtime
  main run `37461978810` (CDP), product #5's attempt-1 (recorded in
  earlier docs), the ~2-minute git-transport outage during capture. Root
  causes for the CDP family remain unconfirmed; no environmental
  attribution is made from same-content successes.
