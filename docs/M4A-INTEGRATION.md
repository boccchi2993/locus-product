# M4a-D — Integration of the three M4a inputs, combined verification, and mainline-landing checklist

Status: integration branch `refactor/m4a-integration`, 2026-10-05.
Base: `refactor/m3c-integration` @ `d6a74a25a2b98293d9aa1f2a635022d8f5ed733b`
(the M3c acceptance baseline — PR #5 head, **still OPEN and unmerged** at
integration time, so per the task contract this PR targets that branch, not
`main`).

Two status statements, kept apart on purpose:

> **What this round establishes:** the M4a implementation (candidate lane +
> ownership cleanup + rollout plan) is integrated and its combined
> verification is green on the recorded fixed combination.
>
> **What this round does NOT establish:** the three-repo mainline has
> landed, or "latest-main" passes. Both cores' `main` still lack the
> extraction implementation (verified live today, §4), and the mainline
> merge chain is blocked on locus-runtime #1's CI (§4.3). §6 is the exact
> operational list for landing it — none of it has been executed here.
> No PR was merged, nothing published, no deploy, no core-repo change, no
> archival of the source repo.

---

## 1. Inputs — full SHAs, verified before integration

All three inputs were confirmed pushed and correctly based **before** any
cherry-pick. Remote heads were read from GitHub (not from local worktrees):
the local `Locus-product-m4a-a` worktree sat at older rewritten SHAs
(`8a05b86…` family — its push went through the Git Data API after git-transport
RSTs, which recreates commits); the remote branch is authoritative and was
used exclusively.

| Input | PR | Remote branch | Remote head (integrated, fixed) | Base check |
|---|---|---|---|---|
| A — core-main candidate | #8 OPEN | `feat/m4a-core-main-candidate` | `6f116e2294c973b79a1a7cd91a247704024f75f5` | = `d6a74a25` + 5 commits ✓ |
| B — ownership cleanup | #6 OPEN | `refactor/m4a-product-ownership-cleanup` | `8e0c5028345fdac352920a6d958c336f6b99daa1` | = `d6a74a25` + 1 commit ✓ |
| C — mainline rollout plan | #7 OPEN | `docs/m4a-mainline-rollout` | `d645fd1ae9b4b6f5634af5a603889817a60ee984` | = `d6a74a25` + 1 commit ✓ |

Acceptance baseline re-confirmed: PR #5 OPEN, head
`d6a74a25a2b98293d9aa1f2a635022d8f5ed733b` = the accepted M3c baseline;
Product `main` (`fe1a1f61f3822905b2f7c5b472a6cb9d0a5ac985`) is a strict
ancestor of it (no drift). No AGENTS.md exists in this repository at the
baseline (root tree checked) — repo conventions are `docs/README.md` and
`docs/TESTING.md`.

### Integration commits (cherry-picked in A → B → C order)

| Input | Source commit | → Integration commit |
|---|---|---|
| A | `a8242e9e063958d653268f6bc4513ed18b264233` | `15f64abb027b1544f57f0c272a471c35f5542a0d` |
| A | `dbf9bec15bfc031968c16991e255e7c869ac7602` | `20402e9ff516e1f38971f3c7eb0ba363ddaf784a` |
| A | `8065f39bef7307152400c7937c166b2a969998be` | `2ac1bcc42be6e19f602f3350e640e53d3ca391d0` |
| A | `51bb8227b4d3205f32c395668b96c8f4be6bf999` | `be72261c90592e52df699a9ff8f6eb1319c24d19` |
| A | `6f116e2294c973b79a1a7cd91a247704024f75f5` | `5b6c004979d83fe6a3e4e84946a1180ead4d239f` |
| B | `8e0c5028345fdac352920a6d958c336f6b99daa1` | `52feb57a4766062d0ec5f5a2f7be1c8648a86f7a` |
| C | `d645fd1ae9b4b6f5634af5a603889817a60ee984` | `664e4e21f7e042016d23169eea7afca3380e9aa9` |
| D (this round) | — | `45655091d58da70c044a7b890da010f813432829` |

No commit was integrated twice; each input's full commit range was carried
exactly once. **PR relationship:** this integration branch carries #6, #7 and
#8 byte-for-byte (cherry-picks). After this PR merges into
`refactor/m3c-integration`, #6/#7/#8 are superseded and should be closed
(never merged individually on top).

### How the branch was pushed (git transport was down; Data API fallback, tree-verified)

The git HTTPS transport to github.com:443 was unreachable at push time (two
connection failures; `gh api` on the same host worked). The branch was pushed
through the Git Data API instead (blobs → trees → commits → ref), the same
recipe the inputs themselves used. Fidelity was verified mechanically, not
assumed: **every pushed tree SHA equals the local tree SHA**, and A's five
commits reproduced their local SHAs exactly (same objects). B/C/D commit
objects drifted in SHA only — local git stores a trailing newline in commit
messages, the API form does not (the known GitHub commit-object pitfall;
content is byte-identical, proven by the tree equality):

| Local commit (above) | Remote commit on `refactor/m4a-integration` | Tree equality |
|---|---|---|
| `15f64ab` | `15f64abb027b1544f57f0c272a471c35f5542a0d` (identical) | ✓ |
| `20402e9` | `20402e9ff516e1f38971f3c7eb0ba363ddaf784a` (identical) | ✓ |
| `2ac1bcc` | `2ac1bcc42be6e19f602f3350e640e53d3ca391d0` (identical) | ✓ |
| `be72261` | `be72261c90592e52df699a9ff8f6eb1319c24d19` (identical) | ✓ |
| `5b6c004` | `5b6c004979d83fe6a3e4e84946a1180ead4d239f` (identical) | ✓ |
| `52feb57` (B) | `1f6f040573120733960c4717a76b2c46efd0952c` | ✓ `81e8dba` |
| `664e4e2` (C) | `c933c43c18c5b84ed5c60f3ebf1876b529fb8182` | ✓ `fe85286` |
| `4565509` (D) | `b8e356a1ea9fc2a78bc7cd79d4ad7032f903c891` | ✓ `1815e46` |
| `c94615b` (doc) | `c08142c1ed7a0f3ea260618fcabc2069a66ec52d` | ✓ `f1954e3` |

Remote branch tip at PR creation: **`c08142c1ed7a0f3ea260618fcabc2069a66ec52d`**.

### Conflicts and their disposition

**Zero conflicts.** Disjoint footprints made this expected, and it was
verified, not assumed: A adds exactly four new files (tool, test battery,
workflow, A-doc) and touches nothing existing; B deletes four stale files,
edits nine docs, adds one test; C adds three new files (plan doc, preflight
tool, preflight test). The only file two rounds "share" is
`tests/run-unit.cjs`, and both A and B deliberately left registration to the
integrator (D). D's commit `4565509` registers all three new suites there
(see §2).

## 2. D wiring — test registration and entry docs

`tests/run-unit.cjs` `SUITES` gained exactly three lines (battery went
27 → 30 suites):

- `core-main-candidate.test.mjs` (A's 47-check battery — faked npm/git
  transports; offline)
- `m4a-product-ownership.test.cjs` (B's production-graph ownership gate —
  15 checks, fault-injection in OS-temp trees)
- `m4a-mainline-preflight.test.cjs` (C's 18-check classification matrix —
  faked GitHub API). C shipped this standalone by scope discipline; D
  registered it because the task requires new meaningful tests in the
  official battery and the suite is self-contained and offline. The real
  preflight TOOL remains GET-only and is not invoked by the suite.

Entry doc (`docs/README.md`): the four M4a docs joined the "Start here"
table, and a new section **"Two dependency lanes — do not conflate them"**
states (1) the verified fixed combination (verified history), (2) the
core-main candidate lane (ongoing latest-main verification that never
rewrites the pins), and that a pass in one lane must never be reported as a
pass in the other; until the workflow file reaches the default branch, the
candidate pipeline has not run automatically anywhere.

## 3. The verified fixed combination

**Product `refactor/m4a-integration` @ `45655091d58da70c044a7b890da010f813432829`
= baseline `d6a74a25` + A + B + C + D-wiring, consuming
`locus-runtime` `2435a57ff7a66db3db88aa98a88d404c75133483` and
`locus-harness` `347eed99a415dc080b97d46d8a4271ceb19c5142`** (pins unchanged
from the M3c acceptance; `package.json` / `package-lock.json` untouched by
M4a). Every result below is against exactly this combination, in two places:

1. **Integration worktree** `Locus-product-m4a-d` (HEAD `4565509`, clean,
   LF checkout, fresh `npm ci`): build ✓ (951 ms); full unit battery ✓
   (30/30 suites) with `BROWSER_GATE_ORCH_REAL_PREVIEW=1` — the real-preview
   orchestrator check ("real vite preview: build, readiness identity,
   verified shutdown") ran and passed; the RA1 frozen-§3-shape check passed
   here (LF), corroborating the CRLF diagnosis in §5.
2. **Candidate drill throwaway** — fresh clone of the same commit
   (`candidate-checkout-lf`, outside every checkout, `core.autocrlf=false`
   forced), driven by A's candidate tool in explicit mode with the exact
   accepted core SHAs: capture ✓ (`source:"explicit"`, `ref:null`) → apply ✓
   (manifest rewrite → lockfile regeneration → real `npm ci` fetching both
   cores from GitHub → provenance 4/4: manifest spec, `package-lock.json`
   resolved, hidden `node_modules/.package-lock.json` resolved, installed
   package identity) → re-verify ✓ → build ✓ → full unit battery ✓ (30/30
   suites) → **official browser gate** (`node tests/run-browser-gates.cjs`,
   single round, no auto-retry): ✓ **all 16 browser gates passed** (exit 0).

The drill and the integration worktree are the same code and the same
dependency SHAs (`4565509` + `2435a57f` + `347eed99`); per the task's reuse
clause the drill's browser-gate run IS the final code's browser-gate run —
the worktree did not run a second browser round. Every green run above was
executed at gate head `4565509`; the delivered branch tip differs from it
ONLY by this document (docs-only delta, no code, no config, no dependency
change). Diagnostics retained:
`apply-result-lf.json`, `explicit-snapshot-lf.json`, `drill-unit-lf.log`,
`drill-browser-gate.log`.

## 4. Current main snapshot — captured, verified, and honestly red

### 4.1 Main-mode capture (A's tool, real `git ls-remote`, 2026-10-05T14:47:26Z)

- `locus-runtime` `main` = `5bedeeb73f1f0a938d2258bb071fe252e6b11eca`
- `locus-harness` `main` = `77f13fe9003ab3b9d7c7242cea651de4181d2d55`
- Product commit recorded in the snapshot: `4565509` (integration head)
- Snapshot: strict schema v1, `source:"main"`, `ref:"refs/heads/main"`.
- `advance-check` on this snapshot: `advanced:false`, exit 0 (informational —
  a moved main is next round's input, never a chase target). On an explicit
  snapshot it reports `applicable:false` — verified both modes.

### 4.2 The blocker fact (first-hand, not inherited)

**Neither core's `main` contains the extraction implementation.** GitHub
contents API on the captured SHAs (2026-10-05): both root trees hold only
`.gitignore / LICENSE / README.md / docs` — no `package.json`, no `src/`.
The verified implementations live on the open PR branches Product pins
(runtime #1 @ `2435a57f`, harness #1 @ `347eed99`), strictly ahead of their
mains.

Applying the main snapshot therefore fails **at stage install, exit 21**
(first-hand reproduction this round: npm's git clone of a core main finds no
`package.json`; log: `main-apply.log`). The tool reports the failure
honestly with no fallback to any PR head — that is requirement "report the
blocker, do not fabricate a latest-main pass" working as designed. **No
"latest-main green" record exists or may be inferred from this round.**

### 4.3 C's read-only preflight — live run 2026-10-05T14:48Z (verdict: `blocked`)

- `locus-runtime #1` → **`ci-failed` — the only mainline blocker**: PR run
  `36987973661` failed at attempt 1 (browser gates → runtime-host, CDP
  readiness per the M4a-C snapshot), **no rerun recorded**; the push run is
  green. Unchanged from C's audit-time snapshot.
- `locus-harness #1` → ready-to-merge (push + PR green, attempt 1).
- `locus-product #5` → ready-to-merge (green at attempt 2; attempt 1 was the
  known CDP cold-start flake).
- Product #1–#4: none needs a separate merge (#1 contained by the #5 head;
  #2/#3/#4 diverged with content carried by #5 via the M3c-D cherry-picks).
- Branch protection: none on any of the three mains (definitive).
- Full machine JSON retained: `preflight.json` (GET-only transport
  contract; no state was changed by this run).

## 5. Actual runs vs unverified scope

**Actually run this round (all real transports except the model):**

- Cherry-pick integration on the fixed baseline; zero conflicts.
- Candidate tool, explicit mode, end-to-end with real npm/git (see §3).
- Candidate tool, main mode: capture ✓, apply fails honestly at install
  (exit 21 — §4.2), advance-check ✓.
- C preflight: live GET-only audit (§4.3).
- Worktree: fresh `npm ci` → build → full unit battery (30 suites) with
  `BROWSER_GATE_ORCH_REAL_PREVIEW=1` (real-preview orchestrator test
  included).
- Candidate workflow: static confirmation that a red stage fails the job —
  `continue-on-error` exists only on the informational advance-check step
  and the artifact-upload step (comment: "an artifact-upload hiccup must
  never mask a red run"); `permissions: contents: read`; zero push/PR/merge
  statements in the file.

**First failure — kept, diagnosed with evidence, not retried away:**
the first drill unit run (CRLF clone) failed 1 of 30 suites:
`m3c-runtime-adapter.test.mjs` — RA1 "runtime-api.js must stay the frozen
§3 shape" (byte-exact export-line check). Root cause established, not
guessed: the throwaway clone materialized with `w/crlf` because **system
git `core.autocrlf=true`** applies to fresh clones (the integration worktree
inherits its parent repo's local `autocrlf=false`, hence `w/lf`); the check
splits on `\n` and compares lines byte-for-byte. Index blobs are `i/lf`
everywhere; Linux CI checks out LF and is unaffected. First-fail log
preserved (`drill-unit.log`); the green rerun ran in a **newly created
LF clone** (`candidate-checkout-lf`), not a blind retry of the same tree.

**Known-unverified / recorded honestly:**

- The model layer everywhere is the gates' built-in fake transport; the real
  network hops were npm/git fetching the pinned cores (drill apply) and —
  inside the browser gates' python suites — Pyodide from its pinned CDN,
  SHA-verified (same as accepted CI).
- The candidate **schedule/dispatch is NOT live**: GitHub Actions API shows
  `ci.yml` as the only workflow registered on the default branch;
  schedule and dispatch are both default-branch gated. The pipeline becomes
  operational only after the merge chain reaches `main` (conditions in
  `docs/M4A-A-CORE-CANDIDATE.md` §2). Nothing in this round may be described
  as "the candidate lane runs automatically now".
- C's residual unknowns stand (user-level GitHub App integrations unauditable
  at 403).

## 6. Exact operational list to land the mainline (from C's plan + today's facts)

None of this has been executed. Order matters; stop on any red.

1. **Rerun locus-runtime #1's failed CI job** (run `36987973661`, browser
   gates). Second red → escalate to a human decision; do not merge on red.
   (Harness #1 and Product #5 are already ready per §4.3.)
2. **Merge locus-harness #1** (`347eed99`) with a **merge commit** — never
   squash (squash orphans the accepted SHA and C's preflight blocks on
   `merged-untraceable` by design).
3. **Merge locus-runtime #1** (`2435a57f`) with a merge commit.
4. **Merge this integration PR** into `refactor/m3c-integration`; close
   #6/#7/#8 as superseded (byte-identical cherry-picks; merging them
   individually would duplicate history).
5. **Merge Product #5** (`refactor/m3c-integration` → `main`) — this is the
   moment the Product default branch first contains the three-repo switch
   AND registers the `core-main-candidate` workflow (schedule + dispatch
   become real).
6. **Post-merge SHA audit** (C's preflight re-run): all three accepted SHAs
   must be reachable from their repos' `main` (merge-commit ancestry).
7. **`chore/m4a-pin-core-main`**: two-file pin/lock update to the post-merge
   core-main SHAs, landed only after a clean-checkout `npm ci && npm run
   build && npm test` + the official browser gate are green on it. Until
   that lands, Product's pins stay on the verified fixed combination.
8. **Candidate lane first live run**: one manual `workflow_dispatch`
   (source `main`). Expected honest outcome until step 7's pins are the
   cores' mains: an install-stage red (that is the mechanism, not a bug).
9. Combo-record docs commit; close Product #1–#4 as superseded.

Rollback and stop rules: `docs/M4A-C-MAINLINE-ROLLOUT.md`.

## 7. Evidence index

| Artifact | Path |
|---|---|
| Main snapshot (cores' main, strict v1) | `tmp-m4ad-drill/main-snapshot.json` |
| Explicit snapshot (accepted SHAs) | `tmp-m4ad-drill/explicit-snapshot-lf.json` |
| Apply result + provenance 4/4 | `tmp-m4ad-drill/apply-result-lf.json` |
| First-hand main-mode install failure (exit 21) | `tmp-m4ad-drill/main-apply.log` |
| First-fail unit log (CRLF clone, preserved) | `tmp-m4ad-drill/drill-unit.log` |
| Green unit battery, LF clone, 30/30 | `tmp-m4ad-drill/drill-unit-lf.log` |
| Official browser gate (single round) | `tmp-m4ad-drill/drill-browser-gate.log` |
| Live preflight JSON (verdict `blocked`) | `tmp-m4ad-drill/preflight.json` |
| advance-check (main + explicit modes) | `tmp-m4ad-drill/advance-check.json` |

`tmp-m4ad-drill/` is an out-of-checkout diagnostics directory kept outside
the repository on purpose (the candidate tool hard-refuses to apply into the
tool's own workspace; nothing above requires it in-repo).
