# M3c — parallel switch handoff (M3c-0 baseline)

Status: **M3c-0 deliverable.** This document establishes the COMMON baseline
for the three parallel M3c switch agents (A/B/C) and the integration agent
(D). It implements NO part of the switch itself: the product still runs the
imported in-repo cores; no PR is merged by M3c-0; nothing is published.

Established: 2026-10-04.

## 1. Fixed inputs (all verified reachable on 2026-10-04)

| Role | Repository | Pinned commit | PR state at baseline |
|---|---|---|---|
| Source snapshot | [boccchi2993/Locus-browser-agent-runtime](https://github.com/boccchi2993/Locus-browser-agent-runtime) | `2aec76e78431382873be1db8a6db6310cc89c782` (`refactor/repository-split-m2c`) | PR #7 OPEN, **not merged**; source `main` is NOT the baseline and must not be substituted |
| Runtime core | [boccchi2993/locus-runtime](https://github.com/boccchi2993/locus-runtime) | `2435a57ff7a66db3db88aa98a88d404c75133483` | PR #1 OPEN, not merged |
| Harness core | [boccchi2993/locus-harness](https://github.com/boccchi2993/locus-harness) | `347eed99a415dc080b97d46d8a4271ceb19c5142` | PR #1 OPEN, not merged |
| This repository | [boccchi2993/locus-product](https://github.com/boccchi2993/locus-product) | `main` = `fe1a1f61f3822905b2f7c5b472a6cb9d0a5ac985` (minimal README + LICENSE + provenance) | created in M3c-0 |

**M3C_BASE_SHA** — the full SHA of `refactor/m3c-base`'s head — is recorded
in the base PR description (the PR from `refactor/m3c-base` to `main`).
A/B/C MUST all branch from that exact commit; they never stack on each
other's branches.

No `AGENTS.md` exists in the imported snapshot (verified against the source
SHA via the GitHub contents API). The applicable rules are the imported
`docs/` set (`REPOSITORY-SPLIT.md`, `REPOSITORY-SPLIT-CONTRACTS.md`,
`REPOSITORY-SPLIT-INVENTORY.md`, `REPOSITORY-SPLIT-M2C-*.md`, `TESTING.md`)
plus this handoff.

## 2. What `refactor/m3c-base` contains

1. **The verbatim source snapshot** (tracked tree of the source @
   `2aec76e7…`): source code and tests kept as the pre-switch baseline.
   NOT imported: `node_modules`, `dist`, logs, secrets, `.git`.
2. **The two pinned core dependencies** (`package.json` + real
   `package-lock.json`, lockfileVersion 3):
   - `locus-harness`: `github:boccchi2993/locus-harness#347eed99a415dc080b97d46d8a4271ceb19c5142`
   - `locus-runtime`: `github:boccchi2993/locus-runtime#2435a57ff7a66db3db88aa98a88d404c75133483`

   GitHub git dependencies only — no `file:`, no adjacent directories, no
   symlinks, no floating branches, no uncommitted tarballs. A/B/C must NOT
   modify `package.json` or the lockfile (owner: D, §5).
3. **This document.**

### Baseline verification evidence (recorded, reproducible)

- `npm ci` clean-installs both cores (86 packages).
- All four public entries import from `node_modules` in Node:
  - `locus-runtime` → `createMemoryWorkspace, createRuntime, createWorkspace, shellCommandNames`
  - `locus-runtime/workspace` → `LocalDirectoryWorkspace, OPFSWorkspace, WorkspaceAdapter, ensureWorkspacePermission, normalizeWorkspacePath, vfsError`
  - `locus-runtime/worker-assets` → `GREP_WORKER_SOURCE, PY_WORKER_SOURCE`
  - `locus-harness` → 55 exports (full list: locus-harness `README.md`;
    includes `createTaskRunner`, `createProviderSessions`,
    `validateReplayPrefix`, `validateNormalizedPrefix`,
    `validateCapabilityDescriptor`, `skillInstancePath`, `sha256Hex`, … so
    every deep store import at the source baseline is coverable)
- Installed `node_modules/locus-runtime/src` and
  `node_modules/locus-harness/src` are byte-identical to the pinned
  checkouts (diff-verified), LICENSEs identical.
- Lockfile resolves both packages as `git+ssh://git@github.com/…#<full
  40-char SHA>`; registry-dependency drift: none (lock diff = the two new
  entries only).
- Source baseline still works on this branch: full unit gate **all 56
  suites passed** (clean sequential run) and `vite build` succeeds.
- Scope honesty: this proves the SOURCE snapshot works as before. It is
  NOT three-repo integration evidence. Integration proof is the M3c switch
  work itself (compatibility gate + joint suites + packaged browser gates
  per `REPOSITORY-SPLIT.md` §8).

## 3. Common interface (frozen shapes)

The ONLY import path from product code to the cores:

```js
// src/product/runtime-api.js — created by Agent A
export * from 'locus-runtime';
export * from 'locus-runtime/workspace';
export * as runtimeWorkerAssets from 'locus-runtime/worker-assets';
```

```js
// src/product/harness-api.js — created by Agent B
export * from 'locus-harness';
```

Rules:

- The two files ONLY re-export the cores' public API. No global
  registration (`globalThis`/`window` publishes), no copied algorithms, no
  added wrappers or compat shims, no extra exports.
- All product imports of core code go through these two files. No
  `locus-runtime/…` or `locus-harness/…` specifier outside them.
  (`export *` is safe here: the runtime root and `./workspace` surfaces are
  disjoint — verified by the import check above.)
- Consumers switch mechanically, preserving symbol names, e.g. the store's
  current imports at the source baseline:
  - `import { … } from '../harness/index.js'` → `'../product/harness-api.js'`
  - `import { createTaskRunner, isPersistenceFailure } from '../harness/task-runner.js'`
    and `import { createProviderSessions } from '../harness/provider-session.js'`
    → same symbols from `'../product/harness-api.js'`
  - `import { createRuntime } from '../runtime/index.js'` → `'../product/runtime-api.js'`
  - `import { PY_WORKER_SOURCE, GREP_WORKER_SOURCE } from '../runtime/worker-assets.js'`
    → `import { runtimeWorkerAssets } from '../product/runtime-api.js'`
    (`runtimeWorkerAssets.PY_WORKER_SOURCE` / `.GREP_WORKER_SOURCE`)

## 4. ESM conversion rules (classic files → ES modules)

`index.html` loads these classic scripts in order (the conversion
inventory; `src/main.js` is already a module):

`telemetry.js`, `persistence.js`, `model-adapters.js`, `model.js`,
`workspace.js`, `vfs.js`, `conversation-history-workspace.js`,
`extension-composition.js`, `extensions.js`, `capability-package.js`,
`attachments.js`, `capabilities.js`, `network.js`, `shell.js`, `tools.js`,
`approval.js`, `agent.js`, `mutation-policy.js`, `ui/projector.js`,
`ui/markdown.js`

Rules (mandatory):

1. Top-level outward symbols become named `export`s.
2. Existing symbol names are preserved exactly — callers rename imports,
   never symbols.
3. Callers switch to explicit `import` (via the §3 interface files for core
   symbols; direct relative imports inside Product-owned files).
4. Never restore the lexical chain through `globalThis`/`window` publishes
   or `eval`/`new Function` — the cores' own boundary gates enforce zero
   host-side publishes/eval, and the product side must not reintroduce what
   the split removed.
5. Convert file-by-file together with ALL of that file's callers in the
   same change; a half-converted chain (file exports ESM but a caller still
   reads the classic global) is a broken state, never an intermediate
   commit.
6. Existing test suites are SHARED (`tests/run-unit.cjs` registry, eval /
   import fixtures). A/B/C do not modify existing suites; A/B/C add NEW
   suite files only and record the desired registration in their own notes
   (§5); D performs the final registry wiring.

## 5. File ownership (parallel, non-overlapping)

| Agent | Owns |
|---|---|
| **A** | `src/product/runtime-api.js` · `src/tools.js` · `src/mutation-policy.js` · A-specific new tests and docs |
| **B** | `src/product/harness-api.js` · `src/extensions.js` · `src/capability-package.js` · `src/persistence.js` · `src/attachments.js` · the conversation-history-workspace module present in the source (`src/conversation-history-workspace.js`) · B-specific new tests and docs |
| **C** | `src/ui/**` · `src/main.js` · `src/product/core-compatibility.js` · `src/product/tool-adapter.js` · `index.html` · `vite.config.*` · build assembly files · C-specific new tests and docs |
| **D** (integration) | `package.json` / `package-lock.json` follow-up changes · `.github/workflows/**` · final wiring of the existing shared tests (incl. `tests/run-unit.cjs` registration) · deletion of duplicated core files · repo-wide documentation index and final verification |

Hard boundaries for A/B/C:

- No `package.json`, no lockfile, no CI/workflow changes.
- No edits to other agents' files, to EXISTING shared/old tests, or to the
  original core implementations (the in-repo duplicate cores are frozen on
  this baseline until D deletes them after the switch).
- A cross-boundary need is recorded, never hacked: append it to your OWN
  agent notes doc (`docs/M3C-A-NOTES.md` / `docs/M3C-B-NOTES.md` /
  `docs/M3C-C-NOTES.md`, created by that agent) with the concrete request
  and rationale. D resolves recorded requests during integration.

## 6. Known mandatory adaptations (recorded by M3c-0, implemented at switch time)

Found in the pinned cores' extraction records; each lands with the file's
owner, in the same change that switches that file's imports:

1. **`registryVersion` is deleted from the harness package**
   (locus-harness `docs/EXTRACTION-PLAN.md` §6). The Product checker
   requires it today → **C** drops `supportedRegistryVersions` from
   `PRODUCT_CORE_REQUIREMENTS` and the `result.harness.registryVersion`
   projection in `src/product/core-compatibility.js` in the switch change.
   Absence must stop being a `capability_missing` rejection; public
   `contractVersion` semantics are unchanged.
2. **`SKILL_DIFF_MAX_CHARS` is deliberately not exported** by the harness
   (approval-card display bound, no Harness consumer) → **B** moves the
   constant into Product `src/extensions.js` (value and fail-closed
   semantics unchanged).
3. **Replay-validator delegates** — `src/persistence.js` currently
   delegates over the deleted `__LOCUS_HARNESS_REPLAY_VALIDATION__` global
   → **B** replaces the delegates with imports of
   `validateReplayPrefix`/`validateNormalizedPrefix` via
   `src/product/harness-api.js` (they are entry exports).
4. **`verifyConnection` is deleted upstream** (legacy `Model` wrapper;
   absent from the harness entry) → **C** moves the settings
   test-connection path onto `createModelClient` (or records the chosen
   product wrapper in C's notes). Never silently copy the deleted wrapper.
5. **Legacy `Model` / `callModel` / `callModelText` wrappers are deleted**
   upstream; the store is already `createModelClient`-based (M2b) → **C**
   removes any residual global reads during the store switch.
6. **`utf8ByteLength` is NOT a runtime public export** (runtime split it
   into its internal `src/lib/utf8.js`; the entry exports only the four
   symbols listed in §2) → **A** keeps `src/tools.js` consuming the
   Product-owned copy in `src/telemetry.js` (same owner), or records a
   cross-boundary request for an entry export. Never create a third copy.
7. **Worker assets** ride the `runtimeWorkerAssets` namespace (§3) — the
   deep `'../runtime/worker-assets.js'` import is replaced, and the
   `createRuntime({ workerAssets })` call keeps its shape.
8. **D's removal list (only after A/B/C are wired and gates pass)**: the
   in-repo duplicate cores `src/runtime/**`, `src/harness/**`, and the
   extracted classic duplicates `workspace.js`, `vfs.js`, `network.js`,
   `shell.js`, `agent.js`, `model.js`, `model-adapters.js`, `approval.js`,
   `capabilities.js`, `extension-composition.js`. `src/telemetry.js`
   STAYS (Product Telemetry singleton; see item 6).

Authoritative references (in the pinned repos, not vendored here):
locus-runtime `docs/EXTRACTION-PLAN.md` (+ `PROVENANCE.md`,
`TEST-COVERAGE-MAP.md`) @ `2435a57…`; locus-harness `docs/EXTRACTION-PLAN.md`
(§3 caller audit, §6 registryVersion disposition) @ `347eed9…`; source
`docs/REPOSITORY-SPLIT*.md` @ `2aec76e7…` (imported into this repo's
`docs/`).

## 7. Branch and PR discipline

- A/B/C branch directly from `refactor/m3c-base` @ **M3C_BASE_SHA**
  (recorded in the base PR). Parallel work; no serial stacking on each
  other's branches.
- Every agent PR targets `main` of this repository and states its base SHA.
- The base PR (`refactor/m3c-base` → `main`) stays OPEN; merging it — and
  any PR — is integration/closeout work, not part of M3c-0.
- M3c-0 stop boundary: no merge, no publish, no product execution-chain
  switch, no M4.
