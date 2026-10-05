# M3c review fix A — browser-gate orchestrator

Branch: `fix/m3c-review-orchestrator` (independent worktree off reviewed
baseline `b7da804fd24e64c2fb1b3c82b69070d4c55cb31e`, the head of
`refactor/m3c-integration` when this task started; the remote was re-checked
before branching and had not moved). Target: PR #5 review findings about
`tests/run-browser-gates.cjs` only. No production semantics, dependency
versions, vite config, CI, run-unit, other browser suites, or shared
integration docs were touched.

## Defects → fixes

All six confirmed defects lived in the old single-file orchestrator:

1. **`const r` reassigned on retry** — the CDP-flake retry at the old
   line 80 threw `Assignment to constant variable` on the first suite
   failure, crashing the whole run. Fix: the auto-retry is deleted, not
   repaired. Each suite runs exactly once per run (`runSuiteProcess` in
   `tests/helpers/browser-gate-runner.cjs`); a first failure is the final
   verdict for this run and is folded into the aggregate exit code.
   Remaining suites still run while the preview is healthy, and the
   summary lists every failure.

2. **Every non-zero exit triggered a retry** — gone together with the
   retry. No readiness-detection heuristic was added in its place; the
   spec ("delete the retry") is implemented literally.

3. **`process.exit` inside the `try`** — the old line 87 terminated the
   process before `finally`, leaking the preview process holding port
   4173. `runBrowserGates()` now RETURNS an exit code; the CLI applies
   `process.exit(code)` only after cleanup has finished (the .then handler,
   outside the protected section). Everything inside the run uses
   return/throw + finally.

4. **Unknown suite names silently filtered to an empty list** — old line 53
   let `run-browser-gates.cjs typo.cjs` print "all 0 browser gates passed"
   and exit 0. Suite resolution moved to `tests/helpers/browser-gate-suites.cjs`:
   unknown names are a hard usage error (exit 2, names listed, known list
   printed) and nothing is built, served, or run. Mixed valid+unknown
   requests are refused the same way.

5. **Readiness = "something answered HTTP on 4173"** — the old `waitHttp`
   would happily adopt a stale service left by any previous run and test
   against it. Now, in `tests/helpers/browser-gate-preview.cjs`:
   - the port is bind-probed BEFORE the build; a busy port is an explicit
     refusal ("ALREADY IN USE … never takes over or kills a process it did
     not start") — demonstrated live: during this session a foreign
     node.exe held 4173 and the orchestrator refused, exit 1, without
     touching it;
   - the preview is spawned as a DIRECT node child
     (`node node_modules/vite/bin/vite.js preview --strictPort …`, no
     `npx`/`shell:true`), so the pid we own is the real server process;
   - readiness (`waitHealthy`) requires OUR process alive AND the port to
     answer HTTP with the hashed asset token from the dist/index.html we
     just built — a foreign/stale build on the port fails readiness with a
     content-mismatch diagnosis; every wait is bounded;
   - preview stderr/stdout is captured and shown when readiness fails.

6. **Cleanup precision** — `killTree` + `waitForPidExit` (taskkill /T /F on
   the owned root pid, then a bounded liveness confirmation) only ever
   touch the tree this run started; a kill that did not take is reported
   (`CLEANUP FAILED …`) and forces a non-zero exit, so a run can never be
   reported as a clean success while its preview survived. A suite that
   exceeds its wall-clock bound (default 15 min, env
   `BROWSER_GATE_SUITE_TIMEOUT_MS`; deliberately far above every suite's
   internal Python/CDP budgets, which this change does not shorten) is
   tree-killed and recorded as a timeout failure.

   [Annotated 2026-10-05, second review round (F1): the cleanup semantics
   above are superseded by a SHARED bounded, verified helper —
   `tests/helpers/browser-gate-cleanup.cjs` — used by BOTH the suite
   timeout and the preview shutdown. SIGTERM to the owned process group →
   bounded grace → SIGKILL to the same group → bounded confirmation;
   the timeout verdict settles WITHIN that bounded window (a suite
   ignoring SIGTERM can no longer hang the orchestrator forever), stays
   `timeout` even when the child exits 0 during the kill, and an
   unconfirmed cleanup is attached to the verdict and fails the run.
   Preview `kill()` no longer returns unconditional `ok` when the root
   already exited: POSIX verifies (and if needed cleans) the group;
   Windows reports an explicit unconfirmable-cleanup failure. `killTree`
   survives only as the low-level signal primitive.]

## Tests (tests-first, red then green)

New: `tests/browser-gate-orchestrator.test.cjs` (+ the three
`tests/helpers/browser-gate-*.cjs` seams it exercises). Real subprocesses
only — tiny node fixtures, no model/relay/Chrome; every spawned process is
tracked and force-cleaned in finally; all waits bounded and labeled.

- **First fail on unmodified baseline** (worktree at `b7da804` with ONLY the
  new test file present; helpers moved aside to reproduce the baseline
  state exactly):

  ```
  $ node tests/browser-gate-orchestrator.test.cjs
  Error: Cannot find module './helpers/browser-gate-runner.cjs'
      at Object.<anonymous> (…\tests\browser-gate-orchestrator.test.cjs:21:16)
      code: 'MODULE_NOT_FOUND'
  exit=1
  ```

  A behavioral red against the OLD CLI (`node tests/run-browser-gates.cjs
  definitely-not-a-suite.cjs` → old code builds, serves, prints
  "all 0 browser gates passed", exits 0) was NOT reproduced live: port 4173
  was held by a foreign process for the whole session (see below) and the
  old code's first step is a real build + preview on 4173, which would have
  collided with the parallel agents' work. The defect is instead covered by
  the fixed code's CLI test (below), which pins the new contract.

- **Green after the fix**: `13 passed, 0 skipped, no failures` (plus the
  gated 14th test → `BROWSER_GATE_ORCH_REAL_PREVIEW=1 …` → `13 passed,
  0 skipped, no failures` with the real vite build/preview lifecycle).

Coverage of the required matrix:

| Requirement | Test |
| --- | --- |
| all pass → exit 0, own server exits, port released | `all pass: exit 0, server exits, port released (real subprocess)` |
| suite failure → runs once, later suites run, non-zero | `suite failure: runs exactly once, later suites still run, non-zero` |
| spawn failure / signal exit / hang → non-zero, cleaned | `runSuiteProcess: exit/signal/timeout classified, hung suite tree-killed (real)` (real timeout kill verified by pid; signal-shape assertion is POSIX-only because Windows TerminateProcess reports an ordinary exit code) |
| unknown suite → non-zero, nothing started | seam test + `CLI: unknown suite exits 2 without starting anything (real CLI)` |
| port held by another fixture → refuse, do not kill it | `busy port: refuse to run, foreign fixture untouched (real)` |
| build failure → preview never started | `build failure: preview never started, non-zero` |
| cleanup failure ≠ clean success | `cleanup failure: never reported as a clean success` |
| cleanup is real, not "kill was called" | `real tree-kill: grandchild port released (real cleanup)` + port-release probes in every lifecycle test |

`registry: default suite list unchanged` pins the original 14-suite default
list; new B/C suites get registered by D (see handoff).

## Independent runs (this session, this worktree)

- `node tests/browser-gate-orchestrator.test.cjs` → 13/13 green (1 gated
  skip by default).
- `BROWSER_GATE_ORCH_REAL_PREVIEW=1 node
  tests/browser-gate-orchestrator.test.cjs` → 13/13 green including the
  real vite build → readiness identity → verified shutdown → port released.
- Normal targeted browser gates on an alternate port (4173 was held by a
  foreign process all session — refusal demonstrated above):
  `BROWSER_GATE_PORT=4573 E2E_APP_URL=http://127.0.0.1:4573/?e2e=1 node
  tests/run-browser-gates.cjs e2e-ui.cjs e2e-responsive.cjs e2e-grep.cjs`
  → `all 3 browser gates passed`, exit 0, port 4573 released afterwards,
  the foreign 4173 process untouched.

These validate the orchestrator infrastructure only. They are NOT a
re-validation of the full 14-suite integration gate; that stays with the
integration owner once review fixes land.

## Handoff to D (suite registration)

- Add ONE line to `tests/run-unit.cjs` `SUITES`:
  `'browser-gate-orchestrator.test.cjs',`
  (after `'chrome-helper.test.cjs'` groups naturally). The file is
  standalone-runnable (`node tests/browser-gate-orchestrator.test.cjs`,
  exit code 0/1) and matches run-unit's spawn-a-child convention; no eval
  coupling. Full unit run takes ~15–25 s (only the gated real-vite test is
  skipped; it never runs under run-unit unless CI opts in via
  `BROWSER_GATE_ORCH_REAL_PREVIEW=1`).
- No other registration is needed: `tests/run-browser-gates.cjs` keeps the
  same CLI contract (`node tests/run-browser-gates.cjs [suite ...]`), so CI
  invocations are unchanged. B/C's new suites, once landed, are appended to
  `SUITES` in `tests/helpers/browser-gate-suites.cjs` (single source; the
  test pins the list, so the pin must be updated in the same commit).

## Environment note (port 4173)

Port 4173 was LISTENING under a foreign `node.exe` (PID 36128) for the
whole session — most likely another parallel review agent's preview or a
stale service, i.e. exactly the situation defect 5 describes. Per the
ownership rules it was left running; the new orchestrator refuses that port
instead of adopting it, and the session's targeted gate ran on 4573 via env
overrides. Whoever finds 4173 held later should identify and stop the
holder themselves; the orchestrator will not do it.
