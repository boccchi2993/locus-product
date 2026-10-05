# M4a-A — Core-main candidate verification for Product

Status: implemented on `feat/m4a-core-main-candidate` (base: `refactor/m3c-integration`,
Product baseline `d6a74a25a2b98293d9aa1f2a635022d8f5ed733b`), 2026-10-05.

Product ships with an **exact, verified dependency lock** on the two cores
(`locus-runtime`, `locus-harness` pinned to full 40-hex SHAs in
`package.json` / `package-lock.json`). This document describes the *candidate*
lane that periodically checks whether the cores' latest `main` would still
satisfy Product — without ever touching the verified lock:

- a **candidate snapshot** freezes one full SHA per core `main`, observed once;
- a **throwaway checkout** gets the candidate SHAs applied, installed, built
  and tested;
- every failure is reported per stage and **dies in the throwaway checkout
  plus its artifacts** — no auto-PR, no push, no merge, no publish, no deploy,
  and the verified lock is never rewritten.

The two lanes are deliberately asymmetric: the verified lock only moves when a
human integrates a candidate that passed; the candidate lane moves on its own
schedule and is allowed to fail.

---

## 1. The tool — `scripts/core-main-candidate.mjs`

```bash
node scripts/core-main-candidate.mjs <subcommand> [flags]
```

### `capture` — freeze a candidate snapshot

```bash
node scripts/core-main-candidate.mjs capture --checkout <dir> \
  [--source main|explicit] [--runtime-sha <sha>] [--harness-sha <sha>] \
  [--out <file>]
```

- `--source main` (default) observes each core's `refs/heads/main` exactly
  once (`git ls-remote`, argv-array invocation) and records the full 40-hex
  SHA per core. The snapshot also records the Product commit being verified
  (`git rev-parse HEAD` of `--checkout`), a UTC `capturedAt`, and
  `source: "main"` with `ref: "refs/heads/main"` per core.
- `--source explicit` verifies caller-given SHAs instead (both
  `--runtime-sha` and `--harness-sha` required); per-core `ref` is `null` and
  `source` is `"explicit"`, so an explicit run can never masquerade as a
  main observation. Use this to re-verify an accepted combination.
- Output: the snapshot JSON on stdout, plus `--out <file>` when given.
  "Latest main" means *observed at capture time* — everything downstream
  reads only the captured SHAs; a main that moves mid-run is next round's
  candidate, never a re-read.

Snapshot schema (`schemaVersion: 1`):

```json
{
  "schemaVersion": 1,
  "capturedAt": "2026-10-05T14:02:03.374Z",
  "source": "main",
  "product": { "repo": "boccchi2993/locus-product", "commit": "<40-hex>" },
  "cores": {
    "locus-runtime": { "repo": "boccchi2993/locus-runtime",
                       "ref": "refs/heads/main", "sha": "<40-hex>", "source": "main" },
    "locus-harness": { "repo": "boccchi2993/locus-harness",
                       "ref": "refs/heads/main", "sha": "<40-hex>", "source": "main" }
  }
}
```

`explicit` snapshots look identical except `source: "explicit"` and
`"ref": null` on both cores. Snapshot reading is strict: exact key sets,
allowlisted repos, 40-hex SHAs, per-core `source`/`ref` consistency with the
capture mode — any deviation is a usage error before a checkout is touched.

### `apply` — install candidates in a clean temporary checkout

```bash
node scripts/core-main-candidate.mjs apply --snapshot <file> --checkout <dir> \
  [--result-file <file>]
```

Preflight refuses: a non-directory, a non-git directory, a **dirty working
tree**, and — hard guard — the checkout that owns the tool itself (the
verified workspace is never a valid target; it is also what makes a failed
apply structurally unable to rewrite the verified deps: the original
workspace is simply never a write target).

Then, inside the temp checkout only:

1. rewrite both dependency specs to `github:boccchi2993/<repo>#<captured-sha>`
   (parsed manifest edit + self-check, not string surgery on the file);
2. `npm install --package-lock-only` — regenerate the lockfile from the
   candidate SHAs;
3. `npm ci` — **wipes node_modules** and reinstalls strictly from the
   regenerated lockfile, so a manifest-only edit can never ride on a stale
   install;
4. verify provenance (see below); on success emit a
   `CANDIDATE-RESULT {...}` line and `--result-file` JSON.

On failure the tool exits non-zero with the stage code and **leaves the
applied manifest/lock in the temp checkout as diagnostics**; the original
workspace is untouched because it was never addressed.

Provenance verification — what "installed really means installed" checks:

- `package.json` dependency spec equals `github:<repo>#<sha>` exactly;
- `package-lock.json` `packages["node_modules/<pkg>"].resolved` ends with
  `#<sha>`;
- `node_modules/.package-lock.json` — npm's own record written from its real
  ci-time resolution — ends with `#<sha>`;
- `node_modules/<pkg>/package.json` exists and declares `name === pkg`.

Why no `git rev-parse` inside `node_modules/<pkg>`: npm ≥ 7 extracts git deps
**without a `.git` directory**, and `git rev-parse` then silently walks up to
the *outer* checkout and reports its HEAD — a false oracle (the first real
rehearsal of this tool caught exactly that: it reported the Product commit as
the installed core). The hidden lockfile is npm's authoritative
what-actually-got-installed record, and `npm ci`'s wipe-and-rebuild is what
makes it trustworthy.

### `verify` — re-check an already-applied checkout

```bash
node scripts/core-main-candidate.mjs verify --snapshot <file> --checkout <dir> \
  [--result-file <file>]
```

Runs step 4 alone. Non-zero when the checkout's manifest/lock/install no
longer match the snapshot.

### `advance-check` — did main move on? (informational, never fails a run)

```bash
node scripts/core-main-candidate.mjs advance-check --snapshot <file> [--result-file <file>]
```

For `main` snapshots: re-observes each core main and reports
`{ applicable: true, advanced: <bool>, cores: {...} }`. A moved main exits **0**
— it is next round's input, not a chase target. For `explicit` snapshots:
`{ applicable: false }` (there is no main ref behind an explicit capture).

### Exit codes

| code | meaning |
| ---- | ------- |
| 0    | success |
| 2    | usage / invalid input (bad flags, malformed or tampered snapshot) |
| 10   | capture failure (transport error, non-conforming ref value, unreadable Product HEAD) |
| 20   | preflight refusal (missing/dirty/not-a-checkout, tool's own workspace) |
| 21   | install failure (lock regeneration or `npm ci` non-zero) |
| 22   | provenance verification failure |
| 30   | unexpected internal error |

Safety invariants, enforced in code: repo names come from an allowlisted
table only; refs are the fixed constant `refs/heads/main`; SHAs must be full
40-hex; every git/npm invocation is an argv array — no shell string is ever
assembled from snapshot or ref data (the only fallback that builds a command
line is the Windows `npm.cmd` path, and every token in it is a validated
constant or a validated SHA).

---

## 2. The workflow — `.github/workflows/core-main-candidate.yml`

- **Triggers**: `schedule` (`30 3 * * *` daily, UTC) and `workflow_dispatch`
  with inputs `source` (`main`/`explicit`), `runtime_sha`, `harness_sha`
  (explicit mode validates both inputs as 40-hex before anything runs).
- **Permissions**: `contents: read` — nothing else. No token write, no PR,
  no push, no merge, no release, no deployment anywhere in the file.
- **Stages**, each its own step with its own log and outcome:
  1. `capture` — snapshot via the tool; artifact `candidate.json`;
  2. `install` — clone the workspace into a throwaway
     `$RUNNER_TEMP/candidate-checkout`, then `apply` (lock regen → `npm ci` →
     provenance verification);
  3. `build` — `npm run build` on the candidate cores;
  4. `unit` — `npm test` (the full unit battery, including the real-preview
     orchestrator test);
  5. `browser` — `node tests/run-browser-gates.cjs`: the **official browser
     gate, existing single-run orchestrator, no auto-retry**; a first failure
     is the final verdict;
  6. `advance-check` (informational, `continue-on-error`);
  7. result assembly + artifact upload (both `if: always()`).

- **Failure semantics**: stages map 1:1 to `result.json` fields
  (`capture` / `install` / `build` / `unit` / `browser`, plus
  `failedStages` and `ok`), written to `$GITHUB_STEP_SUMMARY` as a stage
  table. A failed stage fails the job — the reporting steps run
  `if: always()`, so diagnostics (snapshot, applied `package.json` /
  `package-lock.json`, per-stage logs, `advance-check.json`, `result.json`)
  upload even on failure, and the artifact-upload step is
  `continue-on-error` so a report hiccup can never mask a red run — while a
  red run can never be turned green by reporting.
- **Transports, recorded honestly**: the model layer is the gates' built-in
  fake transport (no model credentials exist in this repo — same as the
  accepted CI). The real-network hops are (1) npm/git fetching the candidate
  cores themselves and (2) the python gates booting the real, SHA-verified
  Pyodide from its pinned CDN; both are called out in the workflow comments
  and in `result.json.notes`.

### Schedule status — read this before assuming the cron is live

**Neither the schedule nor dispatch is live yet.** GitHub has two default-branch
gates here:

1. `on: schedule` only ever executes from the repository's **default branch**.
2. `workflow_dispatch` needs the workflow to be **registered**, and
   registration comes from the default branch — until the file is there, both
   the REST API and `gh workflow run` fail with "workflow … not found on the
   default branch" (verified on 2026-10-05 while this branch was still
   unmerged), and the Actions UI shows no "Run workflow" button for it.

So on this PR branch the file is **dormant by construction**: no cron, no
manual trigger. That is deliberate — the candidate lane must not exist as a
half-armed pipeline. It becomes operational exactly when the merge chain
(PR #8 → `refactor/m3c-integration` → Product default branch) completes; see
the enablement conditions below. Do not describe the mechanism as "online"
before that point.

### Formal enablement conditions

1. This PR merges into `refactor/m3c-integration` (agent D's line), and that
   branch reaches `main` (the Product default branch) — only then does
   GitHub register the workflow, enabling **both** `workflow_dispatch` and
   the daily cron.
2. After the merge, one manual `workflow_dispatch` (source `main`) is green —
   note that until both cores' extraction branches merge to their mains, the
   expected main-mode outcome is an **install-stage failure** (see the
   rehearsal record below); that is the mechanism working as designed, not a
   blocker for enabling it.
3. Only then is "scheduled candidate following" actually live: the daily cron
   fires on the default branch and every run's verdict lands in the Actions
   tab plus the `core-main-candidate-<run_id>` artifact bundle.

---

## 3. Wiring for agent D (integration)

- **Tests**: add one line to the `SUITES` array in `tests/run-unit.cjs`:
  `'core-main-candidate.test.mjs',` (suggested position: next to the other
  M4a suites). The suite is self-contained (`node
  tests/core-main-candidate.test.mjs`), needs no network and no model — all
  transports are fakes. It was **not** registered here: registration belongs
  to the integrator, so parallel agents don't collide on `run-unit.cjs`.
- **Workflow**: no further wiring — the file is self-contained and read-only.
  Nothing in existing CI (`ci.yml`) changes.
- **Merge order**: this branch is based directly on the Product baseline
  `d6a74a25` (PR #5 head). Merge as-is on top of `refactor/m3c-integration`;
  no rebase choreography is expected. `run-unit.cjs` is the only file both
  this PR and D's registration touch, and only that one line.
- **Review pointers**: the snapshot schema is frozen at `schemaVersion: 1`
  (validation is strict/exact-key); if a future change needs new fields, bump
  the version and teach `validateSnapshot` both shapes.

---

## 4. Rehearsal record (2026-10-05, local, real npm/git, fake nothing)

All rehearsals ran against the accepted combination — Product baseline
`d6a74a25a2b98293d9aa1f2a635022d8f5ed733b`, cores `2435a57f…` (runtime) and
`347eed99…` (harness) — with the tool driving real `git`/`npm`, into
throwaway clones only.

| # | rehearsal | result |
| - | --------- | ------ |
| 1 | `capture --source explicit` (accepted SHAs) | OK — snapshot marks `source: "explicit"`, `ref: null` |
| 2 | `apply` on a fresh clone of the baseline | OK — manifest rewritten, lockfile regenerated, real `npm ci` fetched both cores, provenance verified in all four checks, exit 0 |
| 3 | `npm run build` in the applied checkout | OK — full packaged build in ~1 s, exit 0 |
| 4 | `capture --source main` (real network) | OK — runtime `5bedeeb7…`, harness `77f13fe9…` observed once each |
| 5 | `apply` with the main snapshot | **FAILS at stage install (exit 21)** — npm's git clone of a core main contains no `package.json`; see below. The failure is reported honestly: stage-tagged, non-zero, no fallback to any PR head |
| 6 | `advance-check` on the main snapshot | OK — `advanced: false`, exit 0 (informational) |
| 7 | `apply` targeting the tool's own workspace | refused at preflight (exit 20) |
| 8 | unit suite `tests/core-main-candidate.test.mjs` | 47/47 checks pass |

Why rehearsal 5 fails, and why that is correct: as of this date **neither
core's `main` contains the extraction implementation yet**. `locus-runtime`
main `5bedeeb7…` and `locus-harness` main `77f13fe9…` root trees hold only
`.gitignore / LICENSE / README.md / docs` — no `package.json`, no `src/`
(verified via the GitHub contents API and a shallow clone). The verified
extraction commits are *ahead of* their mains (runtime +13, harness +9
commits, merge-base = main), living on the reviewed PR branches that Product
already pins. npm therefore cannot install a main-mode candidate — the
candidate mechanism surfaces exactly that as an install-stage failure instead
of silently falling back to a PR head. Main-mode runs will start producing
meaningful verdicts once the cores' extraction branches merge to their mains.

One real fix the rehearsals forced (recorded for reviewers): the first
implementation verified installed git deps with `git rev-parse` inside
`node_modules/<pkg>`; npm ≥ 7 doesn't keep `.git` there, so the command
walked up and returned the Product checkout's own HEAD. The oracle was
replaced by npm's hidden lockfile + installed-package identity checks
(rehearsals 2 and 5 both ran against the fixed logic).
