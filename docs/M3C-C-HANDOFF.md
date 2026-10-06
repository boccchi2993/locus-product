# M3c-C — Product page assembly & build wiring (Agent C handoff)

Status: M3c-C deliverable. Branch `refactor/m3c-product-wiring`, cut from
`refactor/m3c-base` @ **M3C_BASE_SHA `fa49da4b36634cff4d28643206a5838a94dff741`**
(verified identical to the base PR #1 head on 2026-10-04). Pinned inputs:
source `2aec76e7…`, locus-runtime `2435a57…`, locus-harness `347eed9…`
(installed from the locked `github:` deps — untouched).

C does NOT merge, does NOT delete the in-repo duplicate cores, does NOT touch
package.json/lock/CI, and does NOT modify any file outside C's ownership
column. The full build intentionally WAITs on A/B (§6) — no fake module and
no copied core was introduced to manufacture a green build.

## 1. What changed (files)

| File | Change |
|---|---|
| `src/ui/store.js` | rewired to the two transfer layers; `Model` singleton and every classic global read eliminated (§2/§3) |
| `src/main.js` | imports via `./product/harness-api.js` + `./tools.js`; wire-mode fake installs through the explicit transport port; `window.executeTool` e2e seam preserved (§5) |
| `src/ui/projector.js` | classic → ESM: same `LocusProjector` symbol, now a named export (IIFE body untouched) |
| `src/product/core-compatibility.js` | `supportedRegistryVersions` requirement and both `result.*.registryVersion` projections deleted; all other checks unchanged (§4) |
| `index.html` | 20 classic `<script>` tags → 2 Product classic scripts + ONE module entry (§5) |
| `vite.config.js` | `RUNTIME_SCRIPTS` copy list = `src/telemetry.js` + `src/ui/markdown.js` only; rollup inputs unchanged |
| `tests/m3c-product-wiring.test.mjs` | NEW dedicated suite, 40 checks, all passing without A/B (§7) |
| `docs/M3C-C-HANDOFF.md` | this document |

## 2. store/main import mapping (old → new)

Every former core call now enters through one of the two frozen transfer
layers (`src/product/runtime-api.js` — A, `src/product/harness-api.js` — B);
every Product-owned module is an explicit relative ESM import. No `../runtime/*`
or `../harness/*` specifier remains in product code.

| Former source (classic global / deep import) | New source | Symbols |
|---|---|---|
| `src/runtime/index.js` | `../product/runtime-api.js` | `createRuntime` |
| `src/workspace.js` `VirtualWorkspace` global | `../product/runtime-api.js` | `createWorkspace` (replaces `new VirtualWorkspace({listCommands, homeSkeleton})` — the factory's default command list IS the runtime registry, runtime EXTRACTION-PLAN §1b) |
| `src/workspace.js` provider classes | `../product/runtime-api.js` | `LocalDirectoryWorkspace`, `OPFSWorkspace`, `ensureWorkspacePermission` |
| `src/runtime/worker-assets.js` | `../product/runtime-api.js` | `runtimeWorkerAssets` namespace (aliased `runtimeWorkerAssetBundle` in store — the store's e2e accessor `runtimeWorkerAssets()` keeps its name); `.PY_WORKER_SOURCE` / `.GREP_WORKER_SOURCE` feed `createRuntime({ workerAssets })` |
| `src/harness/index.js` | `../product/harness-api.js` | `createAgentSession`, `createApprovalController`, `createModelClient`, `historyBudgetBytes`, `createModelCapabilityRegistry`, `createImageInputGate`, `runImageInputProbe`, `classifyImageProviderError`, `imageInputUnavailableNotice`, `harnessCapabilities` |
| `src/harness/task-runner.js` | `../product/harness-api.js` | `createTaskRunner`, `isPersistenceFailure` |
| `src/harness/provider-session.js` | `../product/harness-api.js` | `createProviderSessions` |
| `src/model-adapters.js` globals | `../product/harness-api.js` | `getProviderAdapter`, `createProviderIdentity`, `createCredentialIdentity`, `projectNormalizedHistory` |
| `src/capabilities.js` + `src/extension-composition.js` globals | `../product/harness-api.js` | `CapabilityManager`, `SkillSourceStore`, `CAPABILITY_CATALOG`, `PLUGIN_CATALOG`, `SKILL_CATALOG`, `MCP_CATALOG` |
| `src/model.js` `Model` singleton | **deleted** — Product-owned `const productModel` state in store (§3) | — |
| `src/tools.js` globals | `../tools.js` (A converts) | `executeTool`, `AGENT_TOOL_DEFINITIONS` |
| `src/mutation-policy.js` global | `../mutation-policy.js` (A converts) | `LocusMutationPolicy` |
| `src/attachments.js` globals | `../attachments.js` (B converts) | `AttachmentStore`, `imageContentPart`, `textContentPart` |
| `src/persistence.js` globals | `../persistence.js` (B converts) | `PersistenceServiceInstance`, `LOCUS_HOME_SKELETON` |
| `src/extensions.js` globals | `../extensions.js` (B converts) | `SkillInstanceStorage`, `SkillInstanceWorkspace`, `productTaskVfsMounts` |
| `src/conversation-history-workspace.js` global | `../conversation-history-workspace.js` (B converts) | `ConversationHistoryWorkspace` |
| `src/ui/projector.js` global | `./projector.js` (C converted) | `LocusProjector` |

`main.js`: `./harness/index.js` → `./product/harness-api.js` (`harnessCapabilities`);
the e2e hook's bare `executeTool` global → `import { executeTool } from './tools.js'`.

All imported names were taken from the sources, never invented, and are pinned
by the new suite's PW4 checks: every harness/runtime symbol is verified against
the installed pinned entry's export surface; every A/B-module symbol is
verified as a top-level definition in that module's CURRENT source (the
conversion contract preserves the names, so PW4 stays green after A/B land).

## 3. Model settings, transport seam, relay port

- The legacy `Model` singleton (deleted upstream) is replaced by Product-owned
  module state `const productModel` in store.js. `applySettings()` remains the
  ONLY writer (including the endpoint-change auto-clear and the remembered-key
  hydration); `productModelConfig()` / `productModelClient()` /
  `wiredModelClient()` / `testConnection()` read it.
- **Transport seam is an explicit Product port**: `setProductModelTransport(fn)`
  (store export). `?e2e=1&wire=1` in main.js installs its deterministic fake
  through this port — never a page global. Production never sets it, so no
  request can accidentally reach a fake; tests must pass the transport
  explicitly.
- **`relayEligible` stays an explicit Product configuration port**
  (`productModelTransportOpts()`), same semantics as before: same-origin
  `/proxy` relay only on non-`file:` deployments. The harness keeps its
  per-request-entry capture (client `call()` snapshots transport + relay
  decision before any await) — unchanged upstream semantics.
- Settings "test connection" uses `createModelClient({...}).verify()` — the
  client's OWN method (present in the pinned harness entry: returns
  `{ config, call, callText, verify }`). The deleted standalone
  `verifyConnection` wrapper is NOT recreated (handoff §6.4 disposition).

## 4. core-compatibility: registryVersion removal

- `PRODUCT_CORE_REQUIREMENTS.harness.supportedRegistryVersions` deleted.
- The `checkHarness` registryVersion branch (absence → `capability_missing`)
  deleted; `checkCoreCompatibility` no longer projects
  `result.runtime.registryVersion` / `result.harness.registryVersion`.
- KEPT, unchanged: `contractVersion` supported-set checks (both cores),
  required port versions (`taskLifecycle/toolPort/modelClient/approval/
  persistencePort` v1), required semantic capabilities
  (`taskEventIdentity`, `providerReplay`), runtime requirements
  (`executionKinds ⊇ [shell]`, `policyMechanisms ⊇ [mutationPolicy,
  authorization]`, `bootstrap.shaPinned`, non-empty `commands`), and the
  optional-capability report. A missing declaration is still
  `declaration_missing` — absence is never compatible. A stray extra
  `registryVersion` field on a declaration is an unknown extra → ignored,
  never a rejection (no hidden replacement semantic).
- Verified against the REAL pinned cores in Node (PW1): `host.capabilities()`
  + `harnessCapabilities()` pass; contract 999 / port v2 / missing
  `taskEventIdentity` / missing `policyMechanisms.authorization` / absent
  declarations all still reject with the same codes.

## 5. Page build & seams

`index.html` now loads exactly:

1. `./src/telemetry.js` (classic, STAYS — Product Telemetry singleton; the
   ContextRail panel reads `window.Telemetry`. Not a Runtime/Harness core;
   per handoff §6.8 it is D-kept, and the runtime no longer consumes its
   `utf8ByteLength`.)
2. `./src/ui/markdown.js` (classic THIS round — see §9 conflict record).
3. `<script type="module" src="/src/main.js">` — the ONE entry; Vite bundles
   the whole graph (cores via the transfer layers, Product modules via
   explicit imports).

Zero classic Runtime/Harness script tags remain; `vite.config.js` copies only
the two remaining Product classic files into `dist`. The
`tests/runtime-host.html` / `tests/harness-host.html` build inputs are kept
(they are shared-test infrastructure, untouched).

e2e seams (all reference REAL production instances; none is an assembly
dependency — the store never reads them):

- `window.__locus.{store,actions,session,vfs,pythonRuntime,runtime,runtimeHost,
  harnessCapabilities,runtimeAssets,approvals,capabilities,attachments,
  capabilityComposition}` — unchanged shapes.
- `window.executeTool` — NEW explicit seam in the `?e2e=1` block: the REAL
  production executor (same imported function the store's ToolPort closes
  over). It previously existed only as a side effect of classic tools.js;
  e2e-grep / e2e-network / e2e-capabilities wait on it.
- `window.__LOCUS_HOOKS__` — unchanged (modelClient/toolExecutor/harness
  declaration seams; `hooks.runtimeCapabilities` /
  `hooks.harnessCapabilities` still substitute declarations only).
- `window.__locusWire` + `setProductModelTransport` — wire mode as above.

## 6. Build state (honest): waiting on A/B — precise missing inventory

`npx vite build` fails today at the first missing transfer layer. The
complete, verified list of what C's graph needs from A/B (PW4 verifies each
name against the pinned entries / current sources — nothing is guessed):

1. **Missing FILES (2)**
   - `src/product/runtime-api.js` (A) — frozen form: `export * from
     'locus-runtime'; export * from 'locus-runtime/workspace';
     export * as runtimeWorkerAssets from 'locus-runtime/worker-assets';`
   - `src/product/harness-api.js` (B) — frozen form: `export * from 'locus-harness';`
2. **Missing NAMED EXPORTS from A's classic→ESM files**
   - `src/tools.js` → `executeTool`, `AGENT_TOOL_DEFINITIONS` (store + main.js)
   - `src/mutation-policy.js` → `LocusMutationPolicy`
3. **Missing NAMED EXPORTS from B's classic→ESM files**
   - `src/attachments.js` → `AttachmentStore`, `imageContentPart`, `textContentPart`
   - `src/persistence.js` → `PersistenceServiceInstance`, `LOCUS_HOME_SKELETON`
   - `src/extensions.js` → `SkillInstanceStorage`, `SkillInstanceWorkspace`, `productTaskVfsMounts`
   - `src/conversation-history-workspace.js` → `ConversationHistoryWorkspace`

Until these land, the packaged page cannot build — that is the agreed
parallel state, NOT a defect of this branch. No fake module, no copied core,
and no skip gate was introduced (task rule).

## 7. Tests (what actually ran)

New dedicated suite — `node tests/m3c-product-wiring.test.mjs` → **40/40 PASS**
(no A/B files needed):

- PW1 real-cores compatibility: REAL `host.capabilities()` +
  `harnessCapabilities()` pass the modified checker; rejections (contract 999,
  port v2, missing required capability/mechanism, absent declarations) still
  fire; no registryVersion requirement/projection; a stray registryVersion
  extra is ignored.
- PW2 page assembly loads no classic Runtime/Harness script.
- PW3 store/main carry no classic global (no `Model`, no `__LOCUS_*_CORE__`,
  no deep core import, no globalThis publish, no load-order typeof guards);
  the compatibility gate still sits at prepareTask step (0), before image
  build and required persistence.
- PW4 every imported symbol really exists (pinned entries + current module sources).
- PW5 the converted `LocusProjector` module actually runs as ESM (real
  createConversation/projectEvent over a full task event sequence).
- PW6 build-input changes; e2e seams reference real instances.

**Desired registration (D):** add `tests/m3c-product-wiring.test.mjs` to the
`SUITES` array in `tests/run-unit.cjs`.

Shared unit gate on this branch (`node tests/run-unit.cjs`): 44 suites green,
**8 suites fail — all expected, all D's rewiring surface**:

| Failing suite | Cause | D's rewiring |
|---|---|---|
| `presentation.test.cjs` | evals `src/ui/projector.js` source → `SyntaxError: Unexpected token 'export'` | import the module instead of eval |
| `conversation-routing.test.mjs` | same | same |
| `submit-presentation.test.mjs` | same | same |
| `store-python-lifecycle.test.mjs` | same | same |
| `product-integration.test.mjs` | same (also evals store-era sources) | import real modules |
| `store-defaults.test.cjs` | evals store.js source with seeded globals → `ReferenceError: runtimeWorkerAssetBundle is not defined` | import the real store module (needs A/B present) |
| `core-compatibility.test.mjs` | asserts the deleted `supportedRegistryVersions` (crashes at line 81) | drop the 4 registryVersion cases (CC3 partial, CC8 shape, projection case) |
| `runtime-boundary.test.cjs` | G5 requires a fresh `vite build`; the build blocks on §6's missing A/B inputs | passes once A/B land and dist is rebuilt |

Everything else — task-runner, provider-session, harness-replay, approval,
agent-image (31/31), shell, capabilities, capability-package, persistence,
model/model-adapters, network, opfs — is green, i.e. the rewiring did not
disturb any core behavior suite that does not eval converted sources.

E2E browser suites were NOT run: they need the packaged build (blocked by §6)
and are shared infrastructure. Nothing in them was modified.

## 8. Instance ownership graph (text)

```
Product page (one per browser tab)
└── src/ui/store.js owns:
    ├── vfs                     — createWorkspace({ homeSkeleton }) (runtime transfer layer)
    │                             static mounts wired by the factory; /mnt/workspace via mountFolder
    ├── capabilityManager       — new CapabilityManager (harness transfer layer classes/catalogs
    │                             + Product SkillInstanceStorage over the CURRENT /home/locus mount)
    ├── RuntimeHost  (retained) — ONE createRuntime({ workerAssets: runtimeWorkerAssets namespace })
    │   └── RuntimeSession      — host.createSession(); prepare / execute / reset / dispose ALL
    │                             resolve through the SAME memoized chain (whenRuntimeSession /
    │                             ensureRuntimeSession); NO second execution path exists
    ├── AgentSession            — createAgentSession({ modelClient: wiredModelClient,
    │                             toolPort: productToolPort, descriptionPort, environmentNotes,
    │                             emit: handleRuntimeEvent, onSessionReset → session.reset() })
    │   └── session.imageInput  — REAL gate trio; per-task run binding from the frozen
    │                             compatibility decision (M2c round 2, unchanged)
    ├── taskRunner              — createTaskRunner({ prepare: prepareTask, onTaskEnd, … })
    │                             prepareTask step (0) = checkCoreCompatibility over
    │                             host.capabilities() + harnessCapabilities() (hooks seams may
    │                             substitute declarations only) → frozen per-task decision
    ├── approvals               — createApprovalController (canonical pending state; store mirrors)
    ├── productModel            — Product-owned settings state + explicit transport port
    └── productToolPort         — createLocusToolPort({ definitions: AGENT_TOOL_DEFINITIONS,
                                  execute: hooks-seam → executeTool, resolveRuntimeSession:
                                  whenRuntimeSession, mutationPolicy: taskMutationPolicy,
                                  authorization: productNetworkAuthorization })
                                  → executeTool → runtimeSession.execute (the ONE dispatch path)
```

Preserved verbatim from the reviewed baseline (untouched semantics): taskId
event identity and `taskEventTargets` routing, `adoptEpoch`, staged
finalize/ended, quiesce storage gate + write-failure priority
(`persistence_error` > error > session_changed > cancelled), session-scope
image run binding incl. historical images (I8d/J7 semantics), per-task frozen
compatibility decision, capability-composition refusal for user-enabled
capabilities, `blocked` rejection path with structured `CompatibilityError`.

## 9. Cross-boundary records (for D; C did NOT grab-edit)

1. **`src/ui/markdown.js` ownership conflict.** It is C's file (src/ui/**)
   AND in the handoff §4 conversion inventory, but its ONLY page consumer is
   `src/components/Timeline.vue` (`/* global LocusMarkdown */` +
   `LocusMarkdown.render`), which belongs to NO owner column. Per handoff §4.5
   (convert a file together with ALL its callers) and the "record, don't
   grab" rule, C left the pair classic: markdown.js keeps its script tag
   (like telemetry.js), Timeline.vue keeps working, and D should land the
   two-line pair at integration (`import { LocusMarkdown } from '../ui/markdown.js';`
   + delete the tag + drop the `/* global */` line; the module needs the same
   one-line named export projector.js got).
2. **`src/components/**` and `src/App.vue` are unassigned** in the handoff §5
   ownership table. No component other than Timeline.vue needed a change:
   everything imports from `./ui/store.js` (exports unchanged), and
   ContextRail.vue's `Telemetry` global stays valid (telemetry.js is kept).
3. **`tests/core-compatibility.test.mjs` / eval-based suites** — see §7 table;
   shared tests are D's to rewire.
4. **For A (observation only):** telemetry.js stays a page classic and still
   publishes `globalThis.Telemetry` / `globalThis.utf8ByteLength`. When A
   converts `src/tools.js` to ESM, a bare `utf8ByteLength` identifier will no
   longer link — A owns the disposition (handoff §6.6: keep consuming the
   Product-owned copy or record an entry-export request). C's page build
   neither depends on nor changes this.
5. **PR base deviation (per task instruction):** handoff §7 says agent PRs
   target `main`; C's task explicitly requires `base=refactor/m3c-base`, so
   this PR stacks on the (still OPEN) base PR #1 for D's serial integration.

## 10. Not done (stop boundary)

No merge, no deletion of `src/runtime/**` / `src/harness/**` or any extracted
classic duplicate (D's removal list), no package.json/lock/CI change, no
publish, no deploy, no M4, no real model/relay/key contacted anywhere.
