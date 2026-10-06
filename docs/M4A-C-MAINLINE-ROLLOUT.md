# M4a-C — Three-Repo Mainline Rollout: Operational Plan and Read-Only Preflight

Status: **plan + read-only tooling only. No PR was merged, closed, commented on, or
retargeted in this round.** Delivered here: the live remote-state audit
(§1), the exact merge list (§2), the executable rollout sequence (§3),
post-merge SHA semantics (§4), the combo record schema (§5), the rollback
plan (§6), the deployment-surface facts (§7), permissions and residual
unknowns (§8), and the read-only preflight tool with its tests (§10).

Everything in §1–§2 was read live from GitHub on
**2026-10-05T13:56:40Z** (and re-verified 14:0xZ for hooks/environments).
Other agents are working in parallel on this reposet, so remote state can
move: **re-run the preflight (§10) immediately before executing §3.**

---

## 0. Revision R1 (2026-10-05, M4a review round C) — superseding classification, same plan

The first-round review reproduced **seven defects** in the v1 preflight
classifier (evidence-free `ready`: no-CI-run policy, closed-unmerged passing,
`mergeable=null` passing, all-skipped CI counted as success, single-leg merge
traceability, verdict/exit divergence when everything landed, protection
`unknown` not gating readiness). Full first-failure record, the corrected
status table, and the fix details live in
[docs/M4A-REVIEW-C.md](M4A-REVIEW-C.md); every defect is reproduced against
the v1 implementation and pinned by `tests/m4a-mainline-preflight.test.cjs`.

**Retraction of derived conclusions.** The v1 §1 table's per-PR verdicts were
produced by that defective classifier. They are hereby retracted *as
derivations*; the underlying facts recorded there (SHAs, run IDs, timestamps,
containment numbers) were read correctly and stand as history. In particular:

- v1 called locus-harness #1 and locus-product #5 "READY" without job-level
  evidence, under a classifier in which `mergeable=null`, closed PRs, and
  skipped CI could also pass. Under R1 both are READY again — now backed by
  explicit job-level evidence (`ciEvidence` config mirroring each repo's real
  ci.yml) — but that coincidence does not rehabilitate the v1 derivation.
- v1's overall "blocked (runtime #1 ci-failed)" narrative happened to match
  the honest state; R1 keeps runtime #1 BLOCKED with sharper evidence: the
  required job `browser gates (headless Chrome)` explicitly failed on PR run
  `36987973661` (attempt 1, no rerun), and the green sibling push run does
  **not** supersede it — only a rerun of the failed run does.
- The v1 exit-code contract (0/1/2) is extended with **exit 3 = invalid
  configuration**, and the v1 §10 taxonomy is superseded by the R1 status
  table (ready / landed-traceable / landed-other-route / ci-pending / six
  blocked states / insufficient-info), aggregated by one `aggregateVerdict`
  that drives the JSON summary, the text render, and the exit code together.
  §10's v1 text is retained below as history.

**R1 live re-run (2026-10-05T16:11:51Z, read-only, GET-only via `gh api`):**

| PR | head == accepted | R1 status | evidence |
|---|---|---|---|
| locus-runtime #1 | yes (`2435a57ff7a66db3db88aa98a88d404c75133483`) | **ci-failed (BLOCKED)** | required job `browser gates (headless Chrome)` failed on PR run `36987973661` (a1, no rerun); sibling push run `36987967403` green — does not supersede |
| locus-harness #1 | yes (`347eed99a415dc080b97d46d8a4271ceb19c5142`) | **ready** | all 4 required jobs succeeded on PR run `37036663781` |
| locus-product #5 | yes (`d6a74a25a2b98293d9aa1f2a635022d8f5ed733b`) | **ready** | both required jobs succeeded on PR run `37293407034` (attempt 2; rerun kept on record, first attempt not rewritten) |

verdict `blocked`, exit 1; carried-input containment unchanged from §2.
The rollout sequence (§3), SHA semantics (§4), combo record (§5), rollback
(§6), deployment surface (§7) and authorization asks (§9) are unchanged by
this revision; Phase 0 now means running the R1 preflight.

### Revision R2 (2026-10-06, review round 2)

A second review found four more unearned-`ready` defects in the R1
classifier and fixed them (`docs/M4A-REVIEW-R2.md`):
`mergeable_state="blocked"` now blocks (mergeable=true alone never meant
"merge permitted"); a required-approving-reviews rule is answered
insufficient (current approvals are not provable from historical review
lists); a required job counts as succeeded only on the explicit conclusion
`success` (`stale`/unknown values are refused with the raw value, run id,
and job name); and the latest-4-runs window is gone — the required
workflow's runs are paged to completion within explicit budgets, an
incomplete inventory is insufficient unless an explicit failure was already
observed, and the report names the evaluated run ids. Suite 39 → 65 checks;
baseline first-fail record and a fresh live preflight (2026-10-06, still
`blocked` on runtime #1's never-rerun run `36987973661`) are in
`docs/M4A-REVIEW-R2.md` §1/§5. This banner and the script's header contract
supersede the §0-R1 and §10 taxonomy text below, which stays as history.

---


## 1. Live remote state (snapshot)

Produced by `node scripts/m4a-mainline-preflight.cjs` (read-only, GET-only
via `gh api`). Verdict at snapshot time: **blocked** — one blocker.

| Repo | main @ snapshot | main contains accepted? | PR | PR head | head == accepted | CI on head | mergeable | Protection on main |
|---|---|---|---|---|---|---|---|---|
| locus-runtime | `5bedeeb73f1f0a938d2258bb071fe252e6b11eca` | no (13 commits behind PR head) | #1 | `2435a57ff7a66db3db88aa98a88d404c75133483` (`refactor/extract-runtime`) | **yes** | push run `36987967403` **success**; PR run `36987973661` **FAILURE** (attempt 1, **no rerun**) | true / `unstable` | not protected |
| locus-harness | `77f13fe9003ab3b9d7c7242cea651de4181d2d55` | no (9 behind) | #1 | `347eed99a415dc080b97d46d8a4271ceb19c5142` (`refactor/extract-harness`) | **yes** | push `37036658040` + PR `37036663781` both **success** (attempt 1) | true / `clean` | not protected |
| locus-product | `fe1a1f61f3822905b2f7c5b472a6cb9d0a5ac985` | no (31 behind) | #5 | `d6a74a25a2b98293d9aa1f2a635022d8f5ed733b` (`refactor/m3c-integration`) | **yes** | push `37293400764` **success** (a1); PR `37293407034` **success on attempt 2** — first attempt failed, operator reran (known CDP cold-start flake family) | true / `clean` | not protected |

Head drift: **none** — every PR head equals the accepted SHA byte-for-byte.
Every main is a strict ancestor of its PR head (`ahead_by=0` from main), so
merges are clean fast-forward-plus-merge-commit situations, not divergent
histories.

**Runtime #1 failure detail (read from the run's job log):** job
`browser gates (headless Chrome)`, suite `runtime-host` — Chrome started
(PID alive) but CDP readiness failed (`/json/version` → "unavailable:
fetch failed" → `waitForCdp` readinessError at
`tests/helpers/chrome.cjs:302`, thrown from `tests/e2e-runtime-host.cjs:60`).
Every other suite passed on the same run (incl. `e2e-python-plugin-runtime`
33/33), and the same head's push run was fully green. This matches the known
headless-Chrome cold-start flake family seen on product CI — but it is a
hypothesis until a rerun proves it (§3 Phase 1). First-failure vs rerun is
distinguished throughout: the runs API keeps only the latest attempt's
conclusion, `run_attempt > 1` is the rerun evidence, and the preflight
surfaces it as `rerunDetected` with an explicit note.

**Branch protection:** all three mains return `protected: false` from the
branches API and the protection endpoint answers 404 "Branch not protected".
This is a definitive reading (owner token), **not** a permission gap: there
are no required checks, no required reviews, nothing technically blocking a
merge or a direct push. All merge discipline in this plan is procedural.

**Product integration inputs #1–#4 (must they be merged separately? No —
see §2):**

| PR | head | vs #5 head `d6a74a25` | containment |
|---|---|---|---|
| #1 `refactor/m3c-base` | `fa49da4b36634cff4d28643206a5838a94dff741` | `behind_by=0`, status `ahead` | **strict ancestor** — fully contained |
| #2 `refactor/m3c-product-wiring` | `b31b544f11c177b9b5758449afafe069b497d72c` | `diverged` (behind_by 1) | exact commits **not** ancestors |
| #3 `refactor/m3c-storage-adapters` | `0b635afbbef854fe7099984a69b573497f1b572e` | `diverged` (behind_by 3) | exact commits **not** ancestors |
| #4 `refactor/m3c-runtime-adapter` | `afe548d8e3d3351bb057e932320e12082259956b` | `diverged` (behind_by 2) | exact commits **not** ancestors |

The #2/#3/#4 divergence is expected, not drift: M3c-D integrated A→B→C by
**cherry-pick** onto the `m3c-base` lineage (the only conflict, the
runtime-api `add/add`, was resolved deliberately then), so their content is
carried by `d6a74a25` while their original commits are not in its ancestry.
Ancestry cannot prove content equality by itself — the proof is #5's own
clean-checkout CI running the integrated result, which is green.

---

## 2. What merges where (the exact merge list)

Three PRs land; nothing else merges. Order: the two cores are independent of
each other; Product adoption is strictly last.

| Order | PR | merged into | method | precondition |
|---|---|---|---|---|
| 1 | locus-harness **#1** | `main` | merge commit (`--merge`, **never** `--squash`) | preflight READY (already true) |
| 2 | locus-runtime **#1** | `main` | merge commit | **CI blocker cleared** (Phase 1 below) |
| 3 | locus-product **#5** | `main` | merge commit | cores merged, combo verified (Phases 3–5) |
| 4 | pin branch `chore/m4a-pin-core-main` (created in the follow-up round) | `main` | merge commit | clean-checkout combo verification green (Phase 5) |

**Product #1–#4: do NOT merge them — not now, not after #5.** #1's head is
already an ancestor of #5's head; merging it is a no-op. #2/#3/#4 are
content-carried by #5 via cherry-picks; merging them after #5 would replay
duplicate changes against their already-integrated descendants (the
runtime-api `add/add` collision would come back). This round leaves all four
**open, untouched**. In the follow-up round, after #5 is merged, close them
as superseded with a comment linking #5 and the cherry-pick commit list
(closing requires its own reviewed authorization; it is not part of this
plan's asks).

---

## 3. Operational sequence (dependency-ordered, executable)

### Phase 0 — re-verify candidates (read-only, always first)

```
node scripts/m4a-mainline-preflight.cjs --json --out preflight.json
```

Gate: all three `headMatchesAccepted` true; runtime #1 not `ci-failed`
unless Phase 1 has since cleared it; no `head-drifted`, no `conflict`,
nothing `insufficient-info`. If any of these fails, stop and re-audit —
parallel agents may have moved the remotes.

### Phase 1 — dispose of the Runtime #1 CI failure

One rerun of the failed `browser gates` job on run `36987973661` (or a
fresh empty-commit CI run on the branch) is authorized and expected green
(same-head push run green + known flake family). Record both the first
failure and the rerun outcome in the combo record (§5).

- Rerun green → proceed.
- Red again → **STOP**. Two consecutive failures on the same suite is a
  regression signal, not a flake: root-cause inside locus-runtime before any
  merge. Do not merge on red, do not loop reruns.

### Phase 2 — merge the core PRs (requires authorization; not this round)

```
gh pr merge 1 --repo boccchi2993/locus-harness --merge
gh pr merge 1 --repo boccchi2993/locus-runtime --merge
```

- **Merge commits, not squash** (see §4: squash orphans the accepted SHAs
  from main and the preflight will classify `merged-untraceable`, which
  blocks Phase 4 by design).
- The order between the two is free; there is no cross-repo CI coupling.
- Watch each merge commit's own push CI on main — this is the first time
  `ci.yml` exists on either main (both mains currently carry **no**
  workflows; CI arrives with these PRs). If a main push run is red → STOP
  before product adoption and investigate; the branch runs proved the head,
  the main run proves the landing.

### Phase 3 — capture the actual post-merge main SHAs and audit them

```
R2=$(gh api repos/boccchi2993/locus-runtime/branches/main --jq .commit.sha)
H2=$(gh api repos/boccchi2993/locus-harness/branches/main  --jq .commit.sha)
node scripts/m4a-mainline-preflight.cjs --json        # expect merged-traceable ×2
# content audit: main must add NOTHING beyond the merge commit itself
gh api "repos/boccchi2993/locus-runtime/compare/refactor/extract-runtime...$R2" \
  --jq '{status, ahead_by, behind_by, files: [.files[].filename]}'
gh api "repos/boccchi2993/locus-harness/compare/refactor/extract-harness...$H2" \
  --jq '{status, ahead_by, behind_by, files: [.files[].filename]}'
```

Expected: `status=ahead, behind_by=0, files=[]`. **Any** file delta means
extra changes rode into main (someone else merged in between; these repos
are unprotected) — then the combo member is R2/H2, *not* the accepted SHA:
audit the delta, re-run that core repo's own gates on its main, and record
R2/H2. Do not claim compatibility from "contains the old commit" alone.

### Phase 4 — product pin + lockfile update (follow-up round; branch from `d6a74a25`)

The product pins the cores as GitHub git dependencies and a clean checkout
must install from manifest + lockfile alone (this is exactly what product CI
asserts with `npm ci`):

```
# package.json dependencies:
"locus-runtime": "github:boccchi2993/locus-runtime#<R2>",
"locus-harness": "github:boccchi2993/locus-harness#<H2>",
npm install                       # regenerates package-lock.json (v3)
git grep -E '"node_modules/locus-(runtime|harness)"' -A2 package-lock.json
#   resolved must be git+ssh://git@github.com/…#<R2 / H2> — same shape as today
```

Today's lock resolves to the accepted SHAs (`…#2435a57f…`, `…#347eed99…`),
verified at `d6a74a25`. The pin commit must touch exactly `package.json` and
`package-lock.json` — nothing else. (Note: `npm install` may also refresh
unrelated transitive resolutions; if the lock diff exceeds the two core
entries, re-run with `npm install --package-lock-only` after
`git checkout package-lock.json` and inspect; a two-entry diff is the
expected shape.)

### Phase 5 — verify the new combo on a CLEAN checkout

Not the dev worktree — a fresh clone/worktree of the pin branch:

```
npm ci && npm run build && npm test      # full unit gate incl. orchestrator
node tests/run-browser-gates.cjs         # 16 packaged-build gates
```

All green → the **new** combo (R2 + H2) is verified. Any red here **blocks
adoption**: do not merge the pin branch, do not merge #5's follow-on; the
previous verified combo stays live on product main. (Product #5 itself is
already verified for the OLD combo — its head pins the accepted SHAs and its
CI is green — so #5 may land even if the NEW combo later fails Phase 5;
only the pin flip waits.)

### Phase 6 — product mainline adoption

1. Merge **#5** (base `main`, `--merge`) → product main contains `d6a74a25`
   (the old combo, independently verified).
2. Merge the pin branch (retarget its PR to main after #5 lands; it is a
   clean fast-forward of the integration branch) → product main adopts
   R2 + H2.

Both merges get their own push CI on product main; both must be green.
Alternative (also valid): merge the pin branch into `refactor/m3c-integration`
first, then #5 once. Recommended: the two-step above — each combo then owns
an independent verified commit and an independent CI run, and the record
(§5) can distinguish them.

### Phase 7 — record and clean up

Append the combo record (§5) in a **separate docs commit after** the adoption
merge. Close product #1–#4 as superseded (own authorization; §2).

---

## 4. Merge-commit semantics: the landed SHA ≠ the accepted SHA

A merge (even a clean one) creates a new commit: R2 ≠ `2435a57f…`,
H2 ≠ `347eed99…`. The plan therefore never equates them:

- **Ancestry** is proven mechanically: the preflight's `merged-traceable`
  requires the accepted SHA to be an ancestor of the merge commit (or,
  failing that, of main). Squash/rebase merges break ancestry and are
  classified `merged-untraceable` → treated as a blocker. This is why §3
  pins `--merge`.
- **Content** is proven by the compare audit in Phase 3 (`files: []`,
  `behind_by=0` between the PR head and the new main). Ancestry alone does
  not prove the combo: if main carries additional commits, they are
  unreviewed input to the combo and must be audited and re-gated (Phase 3
  stop rule).
- The combo record (§5) stores R2/H2 — the SHAs the product pins actually
  reference — alongside the accepted SHAs for traceability.

---

## 5. Verified-combo record (append-only)

One row per adopted combo, appended by a docs commit **after** the adoption
merge. Recommended fields:

| field | meaning |
|---|---|
| `comboId` | monotonic (1 = the pre-split accepted set, 2 = first post-merge set, …) |
| `productCommit` | product main tip at adoption (the pin-merge commit) |
| `runtimeCoreSha` / `harnessCoreSha` | R2 / H2 — the exact main SHAs the pins reference |
| `acceptedShas` | the reviewed PR-head SHAs (`2435a57f…`, `347eed99…`) for provenance |
| `lockfileBlob` | `git hash-object package-lock.json` at `productCommit` |
| `verifiedAt` | UTC timestamp of the verification |
| `verification` | the combo commit's own GitHub Actions run URLs (unit + browser jobs) — the CI run is the immutable artifact; a local clean-checkout run is recorded as secondary evidence |
| `gates` | observed results (e.g. `unit 27/27`, `browser 16/16`) |
| `firstFailures` | any first-failure/rerun events behind the combo (run IDs, suite, phase, outcome) — e.g. product #5's PR run `37293407034` attempt-2 story |
| `previousCombo` | prior `comboId` (this is the rollback target, §6) |

**Anti-self-reference rule:** a record never certifies the commit it lives
in. The combo commit is verified by *its own* CI run (which exists the moment
the commit lands); the record commit comes afterwards and may reference the
combo commit's SHA and run URLs. The record commit's own SHA is referenced
only by the *next* record. Never edit the verified fields of a past record.

---

## 6. Rollback plan

The product pins are the combo switch — rollback is a **forward commit**:

1. New commit on product main setting both pins back to
   `previousCombo`'s `runtimeCoreSha`/`harnessCoreSha`, then `npm install`
   to regenerate the lock. Run the same clean-checkout gates (Phase 5)
   before merging when time permits; if production is actively broken, merge
   immediately and record the shortened path honestly in the next record.
2. **Never** force-push, reset, or rewrite any main; the adoption merge
   commit stays in history (forward-only). Core repos: normally no action at
   all (the pins choose the combo); if a core main itself must back out, that
   is a `git revert` of its merge commit — a new forward commit, never a
   reset.
3. **User data is never rolled back.** The persisted schema is frozen (v3)
   and both combos ship the same persistence code paths (the pin flip
   changes only dependency SHAs), so a pin flip is data-safe. The real
   protection is the Phase 5 gate: an incompatible combo never adopts, so
   there is nothing to roll back. If an incompatibility only manifests after
   adoption with user data on disk: flip the pins back (step 1) to stop the
   bleeding, and treat any data-migration question as a separate reviewed
   change — not as part of rollback.

---

## 7. Deployment surface: what a main merge triggers

Facts (audited live 2026-10-05 with the owner token):

- **Inside GitHub: a merge to main triggers exactly one thing — the
  `ci.yml` push run** (build + unit gates + packaged-build browser gates;
  runtime additionally runs the out-of-repo tarball consumer). **No deploy,
  publish, or release job exists** in any of the three repos' workflows
  (`ci.yml` is the only workflow, on the PR heads; the three mains currently
  contain no workflows at all — CI arrives with these merges).
- Triggers are `push` to `[main, 'refactor/**']` and `pull_request`. Merging
  does not publish npm packages; no npm publish path exists anywhere.
- All three repos: **0 webhooks, 0 environments, 0 deployments, no GitHub
  Pages**. Nothing inside GitHub consumes a main push except Actions.
- Known external fact: the *legacy* source repo
  (`locus-browser-agent-runtime`) deploys to Cloudflare Pages in
  **direct-upload** mode — triggered manually via wrangler from that repo.
  Merges in the three split repos cannot trigger it.
- **UNKNOWN (with reason):** user-level GitHub App integrations (e.g. a
  Cloudflare Pages git-integration App) are invisible to this check —
  `GET /user/installations` answers 403 (token is not App-authorized). The
  empty repo-webhook list rules out webhook-based integrations but not
  App-based ones. If such an App watched these mains, a merge could start an
  unattended external build of gate-green code — annoying, not destructive
  (nothing publishes). Cheapest closure: eyeball
  *Settings → Applications → Installed GitHub Apps* on the account once
  before Phase 2. Until then this stays **unknown**, not assumed-empty.

---

## 8. Permissions and residual unknowns

| item | state |
|---|---|
| Token capabilities | `admin`/`maintain`/`push`/`triage`/`pull` all true on all three repos (owner account) — merge, push, PR, Actions-rerun are all available |
| Branch protection | definitively **absent** on all three mains (not a permission gap) |
| Required checks | none (follows from no protection) |
| Webhooks / environments / deployments / Pages | definitively empty on all three repos |
| User-level GitHub Apps | **unknown** (403 on `/user/installations`; see §7) |
| Runtime #1 failure root cause | unconfirmed — flake-family hypothesis pending the Phase 1 rerun |
| Product #5 first-attempt CI failure | known family (CDP cold-start), operator rerun green; recorded, no open action |
| Parallel-agent interference | live risk by design: re-run Phase 0 immediately before Phase 2; the preflight's drift/conflict/traceability checks are the net |

---

## 9. This round's boundary and the minimal follow-up authorization

This round shipped: the live audit (§1), the read-only preflight + tests
(§10), this plan, and the branch/PR carrying them. It did **not** merge,
close, comment on, or retarget anything, and did not touch deploy settings,
npm, or the source repo.

Minimal authorization the follow-up round needs:

1. **Actions:** one rerun of locus-runtime run `36987973661`'s failed
   `browser gates` job (Phase 1; escalate on a second red).
2. **Merges (merge-commit method):** locus-harness #1 → main;
   locus-runtime #1 → main; then locus-product #5 → main; then the pin
   branch → product main (Phase 2/6).
3. **One product branch + PR:** `chore/m4a-pin-core-main` from `d6a74a25`
   (two-file pin/lock change per Phase 4) — created and pushed in the
   follow-up round because R2/H2 do not exist yet.
4. **One docs commit** on product main appending the combo record (§5).
5. **Close product #1–#4** as superseded with a link to #5 (§2).

Explicitly out of scope, not requested by this plan: npm publish, deploy
configuration changes, branch-protection changes, force-pushes, source-repo
archival, and any merge executed without a green Phase 0 preflight in hand.

---

## 10. The preflight tool

`scripts/m4a-mainline-preflight.cjs` — Node stdlib only, transport is the
`gh` CLI.

```
node scripts/m4a-mainline-preflight.cjs                  # human summary
node scripts/m4a-mainline-preflight.cjs --json           # machine JSON
node scripts/m4a-mainline-preflight.cjs --out report.json
node scripts/m4a-mainline-preflight.cjs --config custom.json
```

Exit codes: `0` every candidate ready/landed · `1` concrete blocker
(drift / CI failed or pending / conflict / untraceable merge) ·
`2` insufficient information (unreadable PR, transport failure).

Classification taxonomy (one per `(repo, PR, acceptedSha)` candidate):

| classification | meaning |
|---|---|
| `ready-to-merge` | open, head == accepted, CI green (rerun evidence kept in the record), mergeable |
| `merged-traceable` | merged and the accepted SHA is an ancestor of the merge commit / main |
| `merged-untraceable` | merged but the accepted SHA is not in main's ancestry (squash/rebase suspected) — blocker |
| `already-in-main` | PR open but the accepted SHA already reached main by another route |
| `head-drifted` | PR head moved off the accepted SHA; report carries the drift scope (commits, files) |
| `conflict` | `mergeable=false` or `mergeable_state=dirty` |
| `ci-pending` / `ci-failed` | CI state on the exact head, first-failure vs rerun distinguished (`rerunDetected`, notes) |
| `insufficient-info` | anything unreadable — the report says what and why; absence is never assumed from a 403 |

The Product #1–#4 inputs are reported separately (`carriedInputs`) with
their containment against the integration head — that is the data behind
§2's "no separate merges" conclusion.

**Read-only contract, enforced by construction:** the transport spawns
exactly `gh api <path>` — no method/field flags exist in the code; the test
suite pins the argv byte-for-byte and asserts every requested endpoint is in
the read allowlist (pulls, branches, protection, compare, actions runs).
No merge, comment, label, ref-update, or release call exists in the script.

**Tests** (`tests/m4a-mainline-preflight.test.cjs`, standalone by design —
the M4a-C file scope forbids touching `tests/run-unit.cjs`):

```
node tests/m4a-mainline-preflight.test.cjs     # 18 checks, all fake-API, no network
```

They drive the full classification matrix (ready / merged-traceable /
merged-untraceable / merged-with-unreadable-compares → insufficient /
head-drifted with diff scope / conflict / ci-pending / ci-failed-no-rerun /
green-after-rerun / already-in-main / unreadable PR), the protection states
(definitive not-protected vs permission-gap unknown), the compare-direction
mapping (the `ahead`/`behind` trap), CI head filtering, the carried-input
containments, the text renderer, the shipped default config, and the
read-only transport contract.
