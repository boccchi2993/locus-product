# M3c-D — integration record (three-repo switch verification)

Status: **M3c-D deliverable.** This document is the integration record of
branch `refactor/m3c-integration`: the fixed inputs, the cherry-pick map,
the D follow-up work, the test-ownership disposition with evidence, the
verification results, and the residuals. It implements the M3c switch on
top of `refactor/m3c-base`; **no PR is merged, nothing is published, no
deploy** — the base PR and every agent PR stay OPEN.

Established: 2026-10-04.

## 1. Fixed inputs (verified reachable before work started)

| Role | Repository | Pinned commit | PR state at integration |
|---|---|---|---|
| Source snapshot | boccchi2993/Locus-browser-agent-runtime | `2aec76e78431382873be1db8a6db6310cc89c782` | PR #7 OPEN, not merged |
| Runtime core | boccchi2993/locus-runtime | `2435a57ff7a66db3db88aa98a88d404c75133483` | PR #1 OPEN, not merged |
| Harness core | boccchi2993/locus-harness | `347eed99a415dc080b97d46d8a4271ceb19c5142` | PR #1 OPEN, not merged |
| Product baseline | boccchi2993/locus-product | `refactor/m3c-base` @ `fa49da4b36634cff4d28643206a5838a94dff741` (M3C_BASE_SHA) | PR #1 OPEN, not merged |

These are a **set of verified candidate SHAs, pinned and locked through
`package-lock.json`** — this is NOT a statement that "the cores' latest
main is compatible". Following the cores' mains (or the source repo's
main) is explicitly M4 work, out of scope here.

Input branch heads (all verified on GitHub before the cherry-pick; every
task completed and pushed — no half-finished branch was adopted):

| Agent | Branch | Head (full SHA) | PR |
|---|---|---|---|
| base | `refactor/m3c-base` | `fa49da4b36634cff4d28643206a5838a94dff741` | #1 OPEN |
| A (runtime/tool adapter) | `refactor/m3c-runtime-adapter` | `afe548d8e3d3351bb057e932320e12082259956b` | #4 OPEN |
| B (storage adapters) | `refactor/m3c-storage-adapters` | `0b635afbbef854fe7099984a69b573497f1b572e` | #3 OPEN |
| C (page wiring) | `refactor/m3c-product-wiring` | `b31b544f11c177b9b5758449afafe069b497d72c` | #2 OPEN |

Dependency lock resolution evidence: `npm ls locus-runtime locus-harness`
resolves both as `git+ssh://git@github.com/…#<full 40-char SHA>` — exactly
the pinned candidates; `npm ci` installs them from the lockfile alone.

## 2. Integration branch construction

`refactor/m3c-integration` = `refactor/m3c-base` + the A → B → C
implementation/handoff commits cherry-picked in that order (histories of
A/B/C untouched; no PR merged):

| Integration commit | Origin | Content |
|---|---|---|
| `e147730` | A `f936a787` | runtime-api re-export layer + tools/mutation-policy ESM |
| `a05e7d0` | A `afe548d8` | A handoff doc |
| `09ff36a` | B `73879596` | storage/capability/skill adapters ESM |
| `fd188c6` | B `e9a77b08` | B dedicated suites |
| `72a1e00` | B `0b635afb` | B handoff doc |
| `4668812` | C `b31b544f` | page wiring (store/main/projector/index.html/vite) |

**Exactly one conflict** across the whole cherry-pick: the expected
`src/product/runtime-api.js` add/add (B's verbatim §3 scaffold vs A's
file). Resolved per B's handoff §6: **A's file taken wholesale**
(byte-verified against `afe548d8`). No ours/theirs wholesale overwrites
anywhere; no A/B/C history rewritten.

D's own commits on top (each detailed in its message):

| Commit | Content |
|---|---|
| `7cb8372` | production graph completion: telemetry.js/markdown.js ESM + consumers; store sessionFactory seam + whenBooted; A/C suite pin updates |
| `7d6400a` | kept-suite rewiring onto the real installed cores (all 17) |
| `bad157d` | duplicated-core + migrated-suite deletion (mapping below) |
| `e0446d0` | browser gates over the packaged build (14/14) |
| `a533fc8` | clean-checkout CI workflow |
| `7654bba` | PW3 negative-pin comment fix (caught by the clean-checkout gate) |

## 3. Production graph (post-integration)

- ONE ESM entry: `index.html` loads ZERO classic scripts; vite bundles
  the whole graph. `dist` carries no copied classics.
- Core code enters ONLY through `src/product/runtime-api.js`
  (`export * from 'locus-runtime'` + `./workspace` + `runtimeWorkerAssets`
  namespace) and `src/product/harness-api.js` (`export * from
  'locus-harness'`). Both are pure re-exports of the installed pinned
  packages — no third implementation, no wrapper, no global publish.
- telemetry.js/markdown.js are ES modules now (A's recorded §3 follow-up
  + C's recorded markdown-pair item). `globalThis.Telemetry` /
  `window.__telemetry` remain as documented observability handles
  (e2e evidence reads, console) — not load-bearing for any import.
- Test-side surface witnesses (A/C dedicated suites, python-manifest
  helper) read the INSTALLED pinned packages directly — the documented
  witness pattern; production code has zero `node_modules` references.

Closure checks (all clean): no `../locus-runtime|../locus-harness`
adjacency, no `node_modules` deep imports in production, no
`eval`/`new Function`, no `__LOCUS_*_CORE__` /
`__LOCUS_HARNESS_REPLAY_VALIDATION__` tables, no two production
Agent/Runtime authorities (the in-repo duplicates are deleted — §4).

## 4. Deletion / retention / migration map

Deleted duplicate cores (per handoff §6.8): `src/runtime/**`,
`src/harness/**`, and the classic duplicates `workspace.js`, `vfs.js`,
`network.js`, `shell.js`, `agent.js`, `model.js`, `model-adapters.js`,
`approval.js`, `capabilities.js`, `extension-composition.js`.
KEPT: `src/telemetry.js` (Product observability singleton; the runtime no
longer consumes its utf8ByteLength). Deletion was per the actual reference
graph: each file's consumers were first rewired, the deletion then
verified by repo-wide grep + full green gates.

**RegistryVersion deletion** (handoff §6.1): the harness package carries
no internal-registry version — `supportedRegistryVersions` and both
`result.*.registryVersion` projections are deleted (C); the compatibility
checker pins a stray extra `registryVersion` as an ignored unknown extra
(CC3c) and `contractVersion`/port-version/semantic-capability checks are
unchanged. **Skill display policy** (`SKILL_DIFF_MAX_CHARS` = 20000 +
fail-closed) is Product-owned in `src/extensions.js` (handoff §6.2, B).

Suite disposition (full evidence: per-suite diff + assertion-count
comparison against the pinned core's copy; a removal required core ≥
product):

- **Removed (coverage lives at the pinned cores — same suites, migrated
  verbatim-assertion per the cores' own headers)**: `model`,
  `model-adapters`, `model-adapters-image`, `image-probe`, `agent`,
  `agent-approval`, `agent-image`, `approval`, `native-tools`,
  `task-runner`, `provider-session`, `harness-replay`,
  `harness-standalone`, `harness-boundary`, `workspace`, `vfs`,
  `vfs-audit`, `shell`, `shell-compat{,2,3}`, `grep-worker`, `worker-init`,
  `worker-output`, `opfs-workspace`, `network`, `network-runtime`,
  `runtime-standalone`, `runtime-session-lifecycle`, `runtime-boundary`,
  `python-authority`, `python-bootstrap-integrity`,
  `python-plugin-runtime`, `python-lifecycle`, plus
  `runtime-self-assembly` (self-assembly era superseded by
  `runtime-import-purity` + the packaged-entry host gates) and the legacy
  pre-split runtime e2e page chain (`tests/e2e.html`, `e2e.cjs`,
  `run-e2e.cjs`, `reload-e2e.cjs`; superseded by the runtime-host gate +
  the product-page e2e suites). Browser python gates
  (`e2e-python-authority/-browser-authority/-bootstrap/-plugin-runtime`)
  moved with the runtime package (same-named suites in locus-runtime
  tests/); the PRODUCT python path stays covered by `e2e-product-joint`
  J2 (REAL verified Pyodide download through the packaged page).
  helpers `runtime.cjs` / `grep-fake-worker.cjs` died with their
  consumers.
- **Kept and rewired to the real modules (Product behavior, assertions
  unchanged)**: `runtime-visibility` (V4–V8/V10 — the V1–V3 internal
  network surface moved to locus-runtime per its header; V9/V9b direct
  builder calls are harness-internal, the contract pinned end-to-end by
  V5–V8), `mutation-policy` (drives the REAL runtime through the PUBLIC
  `session.execute` shell surface; MP9's fake-interpreter injection is
  locus-runtime MP-G7 coverage — the Product policy's refusal
  classification stays), `capability-composition` (F0–F12 + W0–W9 kept —
  the harness's header documents exactly this split; composition-core
  checks live in locus-harness), `capability-package`, `skill-instances`,
  `persistence`, `persistence-audit`, `provider-replay-persistence`,
  `attachments`, `capabilities`, `harness-prompt-parity`,
  `core-compatibility` (registryVersion cases removed per C's §4; a
  stray extra pinned ignored), `presentation`, `conversation-routing`,
  `submit-presentation`, `store-defaults`, `store-python-lifecycle`,
  `product-integration` (the two-core joint suite), `proxy`, `fetch`,
  `chrome-helper`.
- **New**: `m3c-runtime-adapter` (A, 35), `m3c-storage-adapters` (B, 56 +
  23 browser), `m3c-product-wiring` (C, 40) — registered in
  `tests/run-unit.cjs`.

No failing suite was deleted to make the total green: every removal is a
documented migration with the core-side counterpart present at the pinned
SHA; every kept suite runs green against the real combination.

New test seams (production-inert, never set by production builds):
`hooks.sessionFactory` (scripted-session injection),
`window.__locusWire.fn` + `setProductModelTransport` (wire fake
wrap/reinstall), `window.__locus.persistence()`,
`capabilityComposition.{registerPluginRuntimeProvider,productTaskVfsMounts,
ApprovalController,SkillInstanceWorkspace}`, `capabilities.
createProviderIdentity`, `whenBooted` boot barrier.

## 5. Verification evidence

Node gate (integration worktree AND clean local checkout):
`npm ci` (github: git deps through the lockfile only) → `vite build` →
`node tests/run-unit.cjs` → **24/24 suites green**.

Browser gates over the PACKAGED build (`tests/run-browser-gates.cjs`:
vite build → vite preview → real Chrome): **14/14 green** — ui,
responsive, grep, approval, network, capabilities (image-input
capability), image (56 checks), skill-instances (28), persistence (26),
wire (16), product-joint (20 — real submit → Harness → ToolPort →
Runtime → VFS chain; real-network verified Pyodide bootstrap recorded
distinctly; cancel; network-approval Deny with zero dispatch;
compatibility negatives; zero page errors), runtime-host (22),
harness-host (12), m3c-storage-adapters (23). First-failure evidence for
every suite fixed along the way is preserved in the integration commit
messages and was never overwritten by a later rerun.

Real-browser interaction walkthrough (in-app browser, wire-mode fake
transport — no real model/relay/key contacted): cold start (app shell +
Python: cold) → file write/read through the REAL chain (tool item carries
the shell's read-back; `/tmp/walkthrough.txt` durable in the VFS) →
network approval: loopback POST refused pre-approval by the runtime's
private-address guard (correct product behavior), public POST raises the
REAL approval card → UI Deny → `curl: network request denied by user` +
ZERO fetch dispatch → python long task: REAL cold boot (CDN) with the
panel `cold → ready`, the 30s execution budget honestly bounding a 40s
sleep, and UI Cancel mid-run → `python: execution cancelled` +
`task_cancelled_committed` + honest cancelled terminal (no rollback
banner semantics) → session switch + reload restore (conversations and
13-item history restored; unsaved settings correctly not persisted).
Screenshot evidence archived with the run.

Known environment notes (recorded, both pre-existing and distinct):
the historical python E3 Pyodide SystemError and the CDP readiness
timeout flake remain separately tracked; neither was assumed resolved
here. The browser-gate run surfaced one CDP readiness failure caused by
a zombie preview process holding the port — an environment fault
(orchestrator tree-kill added), not a product failure.

Clean-checkout gate: fresh local clone → `npm ci` → build → full suite →
14/14 browser gates. It caught one real integration defect (a comment
mentioning the deleted `Model.transport` tripping C's PW3 negative pin —
the worktree full-gate run predated the seam edit), fixed in `7654bba`
and re-verified. CI (`.github/workflows/ci.yml`) runs the same two jobs
on every push/PR from a from-scratch checkout.

CI evidence on the integration head: both the push and the PR run are
green from a from-scratch checkout
(unit 14–17s; browser gates 1m27s/1m33s,
runs 37181058575 / 37181060946). One earlier branch-push run hit the
documented CDP cold-start readiness flake on its first two suites while
the PR run of the SAME commit was fully green — environment, not
product; the orchestrator now retries a failed suite once with the
first failure preserved in the log, and CI exports the runner's Chrome
explicitly (commit c0d1503).

## 6. Residuals / M4 (explicitly NOT done here)

- No PR merged (base PR #1 and A/B/C PRs #2/#3/#4 stay OPEN), no npm
  publish, no deploy, no M4.
- M4 candidates: following the cores' latest main (this branch is pinned
  to the verified candidate SHAs only), dependency upgrades, the
  leftover source-snapshot extras (`benchmarks/`, `examples/`,
  `functions/`, roadmap docs) rehomed or trimmed, and the
  telemetry/markdown classic-era console handles re-examined once
  nothing reads them.
- Recorded cross-boundary facts for future core work: the runtime entry
  does not export `NetworkRuntime`/`safeNetworkUrlForDisplay`/
  `GrepRegexRuntime`/`createPythonRuntime`/`MemoryWorkspace`-as-class
  (product tests observe them through public seams only); the harness
  entry exports `registerPluginRuntimeProvider` but deliberately not the
  unregistration; `normalizeCredentialEndpoint` and
  `nativeResultContent` are harness-internal.
