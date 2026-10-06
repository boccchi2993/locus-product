# M3c-A — Runtime / tool-execution adaptation (agent A handoff)

Status: **M3c-A deliverable.** Converts the Product tool layer
(`src/tools.js`, `src/mutation-policy.js`) to real ES modules and lands the
frozen common interface `src/product/runtime-api.js`. The overall M3c switch
is NOT complete: the page assembly (`index.html`, `src/main.js`,
`src/ui/store.js`), the shared old suites, and the final registry wiring
belong to B/C/D. Everything below is evidence + wiring instructions for
them.

Established: 2026-10-04. Branch: `refactor/m3c-runtime-adapter`.
Base: `refactor/m3c-base` @ **M3C_BASE_SHA `fa49da4b36634cff4d28643206a5838a94dff741`**
(verified three ways: local branch head, `origin/refactor/m3c-base`, and the
base PR #1 description). PR: `refactor/m3c-runtime-adapter` →
`refactor/m3c-base` (kept OPEN; per the M3c task assignment the agent PRs
stack on the base branch instead of `main` — deviation from
M3C-PARALLEL-HANDOFF §7 recorded here for the integrator).

Pinned cores (unchanged, from the baseline `package.json`/lockfile — no
manifest change by A):

- `locus-runtime` @ `2435a57ff7a66db3db88aa98a88d404c75133483`
- `locus-harness` @ `347eed99a415dc080b97d46d8a4271ceb19c5142`

## 1. Files touched (ownership §5 respected)

| File | Change |
|---|---|
| `src/product/runtime-api.js` | **NEW** — the frozen §3 pure re-export layer (exact three lines, nothing else). |
| `src/tools.js` | Classic → ESM. `export` added to `AGENT_TOOL_DEFINITIONS` and `executeTool`; header documents the conversion + free-identifier audit. Behavior byte-identical. |
| `src/mutation-policy.js` | Classic → ESM. `export` added to `LocusMutationPolicy` (the only outward symbol). Behavior byte-identical. |
| `tests/m3c-runtime-adapter.test.mjs` | **NEW** — A's dedicated gate (35 checks, see §6). |
| `docs/M3C-A-HANDOFF.md` | **NEW** — this document. |

No other file is touched (verified: `git diff --stat` against the base SHA
shows exactly these five). `src/product/tool-adapter.js` (C's, already ESM)
needs NO change: it takes `execute` as a dependency and composes over
`executeTool` unchanged.

## 2. Exported symbols (exact, names preserved)

```js
// src/product/runtime-api.js  — ONLY import path to locus-runtime
export * from 'locus-runtime';                    // createRuntime, createWorkspace, createMemoryWorkspace, shellCommandNames
export * from 'locus-runtime/workspace';          // LocalDirectoryWorkspace, OPFSWorkspace, WorkspaceAdapter, ensureWorkspacePermission, normalizeWorkspacePath, vfsError
export * as runtimeWorkerAssets from 'locus-runtime/worker-assets';  // .PY_WORKER_SOURCE / .GREP_WORKER_SOURCE

// src/tools.js
export const AGENT_TOOL_DEFINITIONS;   // model-visible registry (bash, cloud_bash) — byte-stable, test-pinned
export async function executeTool(name, input, workspace, opts);

// src/mutation-policy.js
export const LocusMutationPolicy;      // factory: LocusMutationPolicy.create() → frozen { checkMove, checkRemove, isPolicyRefusal }
```

Real-package evidence (imported from `node_modules` on this branch, Node
24): the three entries expose exactly the symbols above, the root and
`./workspace` surfaces are disjoint (so `export *` cannot collide), and
`utf8ByteLength` is NOT an entry export — M3C-PARALLEL-HANDOFF §6 item 6
confirmed against the pinned package.

Module-local (NOT exported, unchanged): `AGENT_TOOL_NAMES`,
`TOOL_NOT_FOUND`, `firstLine`, `emitTelemetry` (tools.js);
`SKILL_INSTANCE_SHELL_ROOT`, `SKILL_IDENTITY_BOUNDARY_MSG`,
`underSkillInstances`, `LOCUS_MUTATION_POLICY` (mutation-policy.js).

## 3. Import changes callers must make (C/D wiring, not done here)

| Caller (owner) | Today (global read / classic tag) | After C/D wiring |
|---|---|---|
| `src/ui/store.js` (C) | `executeTool`, `AGENT_TOOL_DEFINITIONS`, `LocusMutationPolicy` as page globals (eslint-global at lines 67–68; reads at 340, 585, 589) | `import { executeTool, AGENT_TOOL_DEFINITIONS } from '../tools.js';` and `import { LocusMutationPolicy } from '../mutation-policy.js';` — symbol names unchanged |
| `src/main.js` (C) | `executeTool(...)` global in the e2e hooks seam (line 61) | `import { executeTool } from './tools.js';` |
| `index.html` (C) | `<script src="./src/telemetry.js">`, `<script src="./src/tools.js">` (line 29), `<script src="./src/mutation-policy.js">` (line 32) as classic tags | Load as modules (or bundle via `src/main.js` imports). Until then the classic tags SyntaxError on `export` — the browser app is EXPECTED-BROKEN on this branch until C's rewiring. |
| `tests/run-unit.cjs` (D) | registry without the new suite | add `'m3c-runtime-adapter.test.mjs'` (A's desired registration, placed anywhere; the suite is self-contained, ~35 s cold, needs only `node_modules`) |
| Shared eval fixtures (D) | `eval(read('src/tools.js'))` and evals of `mutation-policy.js` | dynamic `import()` of the ESM files (see §5 for the exact list) |

`utf8ByteLength` / `Telemetry` in `tools.js`: kept as the SAME page-global
bindings published by `src/telemetry.js` (frozen classic file, Product's
owned copy — handoff §6 item 6; no third copy created). `tools.js` still
imports NOTHING, so this coupling is invisible until the call. When D
converts `telemetry.js` to ESM, switch these two reads to static imports of
it in the same change. Cross-boundary record: **A requests that D perform
exactly that follow-up** (one-line import change + keeping/deleting the
`globalThis` publishes in telemetry.js is then D's classic-chain call).

## 4. `executeTool` parameter contract (unchanged, pinned by tests)

```js
executeTool(name, input, workspace, opts)
  name        'bash' | 'cloud_bash' | <anything else → unknown-tool refusal>
  input       STRING — the shell command (the Harness passes the parsed argument string)
  workspace   the task VFS (context.filesystem) — handed to the session, not used locally
  opts {
    runtimeSession  REQUIRED for bash — the RuntimeSession; executeTool routes bash
                    EXCLUSIVELY through `runtimeSession.execute({ kind: 'shell', input,
                    context: { filesystem, signal, mutationPolicy, authorization, cwd } })`.
                    Missing session = loud failure 'bash: no runtime session injected'.
    signal          per-call AbortSignal — passed 1:1 into the runtime context
    mutationPolicy  the Product policy object (store: LocusMutationPolicy.create())
    authorization   the execution authorization port (unchanged pass-through)
    cwd             unchanged pass-through
    telemetry       contained sink { record } — page Telemetry global is the default
  }
→ { output, success, backend, operation }   // `success` mirrors the runtime's normalized ok
                                            // (`ok` = compute AND commit); Runtime failures are
                                            // NEVER converted into Product successes
```

Result mapping preserved (test-pinned): `success = res.ok`; on failure
`error = firstLine(res.output)` goes to the telemetry record only;
`res.backend`/`res.operation` ride through; `io.in/out` byte accounting
comes from the runtime report (UTF-8, via the runtime's io counters), with
`utf8ByteLength(output)` as the fallback for the output side.

## 5. Expected-red shared suites on this branch (first-failure record)

Converting the two files to ESM breaks every shared suite that `eval()`s
their source text (classic global semantics). Per handoff §4 rule 6 and §5,
A does NOT touch those suites; D rewires them to `import()`. The browser
e2e suites (`tests/e2e-*.cjs`, manual NET tasks) additionally require C's
`index.html` rewiring; they are out of A's gate.

MEASURED on this branch (`node tests/run-unit.cjs`, 2026-10-04):
**35 of the 56 registered suites still pass; 21 fail — every one with the
single uniform, expected first failure `SyntaxError: Unexpected token
'export'` at its eval of the converted source text.** No other failure
mode appeared anywhere.

The 21 affected suites (all eval `src/tools.js`; the marked ones also eval
`src/mutation-policy.js`):

`persistence-audit`, `network`, `runtime-visibility`, `workspace`, `shell`,
`shell-compat`, `shell-compat2`, `shell-compat3`, `grep-worker`, `agent`,
`capability-composition`, `skill-instances`*, `agent-approval`,
`native-tools`, `worker-output`, `store-python-lifecycle`*,
`runtime-session-lifecycle`, `harness-prompt-parity`, `product-integration`,
`mutation-policy`*, `vfs-audit`

Rewiring shape for D (per suite): replace the `eval(readSrc(...))`
concatenations with dynamic `import()`s of
`../src/tools.js` / `../src/mutation-policy.js` (and — when converted —
`../src/telemetry.js`), keeping the assertions unchanged; the store-graph
suites additionally need C's store import switches first. `worker-init`
(proves worker sources standalone) is NOT affected — measured pass.

First-failure notes beyond the SyntaxError wave (all observed while
building A's own suite against the REAL installed runtime; they will bite
the rewired suites next):

1. The extracted runtime shell has NO `mkdir`/`touch` commands (the
   pre-switch in-repo shell had `mkdir`; observed:
   `bash: mkdir: command not available in local browser runtime`). Suites
   that build trees through shell `mkdir` will fail on the REAL installed
   runtime even after the import rewiring — a product/runtime fact to
   resolve during integration (real command list: `cat cd curl echo find
   grep head help ls mv pwd python rm sort tail wc which`). A's own suite
   builds trees with redirections only.
2. The extracted runtime's `createWorkspace()` has a NEUTRAL default — no
   `/home` skeleton (the pre-switch in-repo VFS pre-built `/home/locus`).
   Hosts mount their own home (the product store already does). Suites
   that assume `/home/locus` exists on a bare workspace need a mounted
   memory home after rewiring.
3. Providers receive MOUNT-RELATIVE paths from the VFS
   (`provider.write('file.txt', …)` for `/mnt/x/file.txt`). Test fixtures
   parking provider methods must match relative names.
4. `mv` does not create the destination's parent directory ("mv:
   <target>: no such directory") — the old shell suites' expectations
   about implicit parent creation need checking against the pinned
   runtime during rewiring.

## 6. Actual tests (`tests/m3c-runtime-adapter.test.mjs`) — 35 checks, all green

Real installed `locus-runtime` via `src/product/runtime-api.js`, real
`RuntimeSession.execute`, real `executeTool`, real `LocusMutationPolicy`,
real VFS with memory providers. The ONLY test-controlled fakes are manual
release barriers over a REAL memory provider's `write` (held promise) and
recording telemetry sinks. Ordering is proven by reached states
(entered/released flags); timeouts are marked failure bounds; every parking
block restores the provider method and disposes its chain in `finally`.

- **RA1** runtime-api surface = exact union of the real package entries
  (test imports the entries directly as the surface WITNESS; product code
  may not — RA2 pins that); worker assets real and non-empty under
  `runtimeWorkerAssets`; api file publishes nothing global and adds no
  export beyond the frozen shape.
- **RA2/RA3** static audits (comment-stripped code): tools.js and
  mutation-policy.js import NOTHING (no core import, no `require`, no
  local shell/runtime reference, no `runShellCommand`); repo-wide no
  `locus-runtime` specifier outside `runtime-api.js`; bash routes ONLY
  through `runtimeSession.execute`.
- **T1** real shell write + read back through `executeTool` (unicode
  payload; honest UTF-8 io bytes — `output_bytes > char count`); one
  telemetry record per execution.
- **T2** `AGENT_TOOL_DEFINITIONS` byte-stable (pinned JSON).
- **T3** refusal copies byte-stable and all FAILURES: cloud_bash
  (`Cloud execution is not configured.`), unknown tool
  (`unknown tool: X. Available tools: bash, cloud_bash`), missing session
  (`tool execution failed: bash: no runtime session injected`).
- **T4** page-default sink: no `opts.telemetry` → the record lands in the
  real `Telemetry` global (the eval-loaded Product copy).
- **MP0–MP4** the Product policy plumbs THROUGH executeTool → session →
  shell on the real chain: byte-stable texts
  `mv: <src>: Skill instance paths are stable; …` (both directions),
  `rm: refusing to remove capability skill directory: <target>. …`,
  nothing moved/removed, ordinary moves not over-blocked. Home is a
  mounted memory provider (host-owned home, as the store does).
- **S1** a pre-aborted per-call signal reaches the Runtime: the failure
  text is the RUNTIME's own cancellation (`tool execution failed:
  execution cancelled`), zero VFS effect.
- **S2** entered/release barrier, single command: abort while the
  dispatched write is unsettled → NOT settled across a bounded
  macrotask burst before release; after release the run is reported
  FAILED with the runtime's honest downgrade note
  (`runtime: execution cancelled — the run was superseded after its last
  operation was already dispatched; the settled effect is kept (no
  rollback), so the run is reported as failed`); the settled effect
  STAYS; the session is reusable.
- **S3** barrier + `&&`-chain: the aborted run's SECOND operation is never
  dispatched (`park.entered === 1`), the first stays, failure recorded.
- **B1** `session.reset()` boundary mid-write (caller never aborts): the
  run settles FAILED and the output NAMES the boundary
  (`runtime: runtime session reset: m3c-a boundary — the run was
  superseded …`); effect kept; session reusable.
- **B2** `session.dispose()` mid-write: run settles FAILED, effect kept,
  and the disposed session refuses follow-up work LOUDLY
  (`… disposed …`), never a silent success.

Observed cancellation/boundary mapping (recorded for reviewers): a caller
abort that lands between operations yields the shell's own failed
cancellation report byte-identical; an abort landing during the FINAL
unsettled operation downgrades the otherwise-clean report with the additive
note above; a boundary strike always names itself via `report.boundary`
(dropped by `executeTool`'s result shape — the failure still surfaces via
`success=false` + `output` + telemetry). `success/isError/boundary` are
never folded into a success.

## 7. Pending integration items (for B/C/D)

1. **C**: import switches in `src/ui/store.js` + `src/main.js`;
   `index.html` module loading for the converted files; worker-asset
   consumer switch (`runtimeWorkerAssets.PY_WORKER_SOURCE` /
   `.GREP_WORKER_SOURCE`) where `createRuntime({ workerAssets })` is
   assembled; `registryVersion` removal in `core-compatibility.js`
   (handoff §6 item 1).
2. **B**: `src/product/harness-api.js` (frozen shape) + B's file set; A's
   files reference NO harness symbol (verified) — zero A→B coupling.
3. **D**: `tests/run-unit.cjs` registration of
   `tests/m3c-runtime-adapter.test.mjs`; rewiring of the eval-fixture
   suites to `import()` (§5 list); the telemetry.js ESM follow-up (§3
   cross-boundary record); final verification per REPOSITORY-SPLIT §8.
4. **D**: consider the `mkdir`-less runtime shell (§5 note 2) against the
   old suites' expectations — either the suites change their tree-building
   or the product raises a cross-repo request; A made no such request
   (out of A's scope, evidence recorded).
5. Deviation record: A's PR targets `refactor/m3c-base` (task assignment)
   instead of `main` (handoff §7) — integrator rebases/retargets as the
   M3c closeout sees fit. Base SHA stated in §0 and in the PR body.

## Appendix — measured full-gate result on this branch

`node tests/run-unit.cjs` on the final commit of this branch: 56 registered
suites → **35 passed, 21 failed**, every failure the same expected
`SyntaxError: Unexpected token 'export'` inside the suite's eval fixture
(full classified list in §5). `tests/m3c-runtime-adapter.test.mjs` (A's
dedicated gate): **35/35 checks pass**. `vite build`: **succeeds**
(882 ms; the classic `<script>` tags do not participate in bundling, so
the build stays green — the page only breaks at RUNTIME until C rewires
the assembly).
