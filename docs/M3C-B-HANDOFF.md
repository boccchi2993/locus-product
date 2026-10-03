# M3c-B handoff — Product storage / capability / skill adapters (agent B)

Status: **M3c-B deliverable.** Branch `refactor/m3c-storage-adapters`, cut
directly from `refactor/m3c-base` @ **M3C_BASE_SHA
`fa49da4b36634cff4d28643206a5838a94dff741`** (verified locally against the
base branch head before branching). PR targets `refactor/m3c-base` per the
switch task (the handoff doc's base-`main` default is superseded by the
explicit task instruction). **No merge, no publish, no core changes, no M4.**

Fixed inputs (all verified at the pinned commits before work started):

| Role | Commit |
|---|---|
| Source baseline | `2aec76e78431382873be1db8a6db6310cc89c782` (verified: `git rev-parse 2aec76e` in the source checkout resolves to exactly this object; the malformed 38-char variant that also appeared in the task text is NOT a git object) |
| locus-runtime | `2435a57ff7a66db3db88aa98a88d404c75133483` |
| locus-harness | `347eed99a415dc080b97d46d8a4271ceb19c5142` |

## 1. Changed files (ownership-clean)

| File | Change |
|---|---|
| `src/product/harness-api.js` | **NEW** (B-owned): `export * from 'locus-harness';` — pure entry re-export, nothing else. |
| `src/product/runtime-api.js` | **NEW — see §6 (scaffold declaration).** Verbatim M3C-PARALLEL-HANDOFF §3 frozen shape (A's file). |
| `src/conversation-history-workspace.js` | classic → ESM; imports `WorkspaceAdapter`/`normalizeWorkspacePath` via `./product/runtime-api.js`; exports `ConversationHistoryWorkspace`. Body otherwise untouched. |
| `src/persistence.js` | classic → ESM; replay delegates over `__LOCUS_HARNESS_REPLAY_VALIDATION__` **deleted**, replaced by a one-way re-export of the REAL entry validators; `createCredentialIdentity` typeof-guarded fallback branch deleted (real import); exports the Product-owned surface. Storage/IDB/OPFS implementation, schema, data format and required-write semantics untouched. |
| `src/attachments.js` | classic → ESM; `typeof PersistenceServiceInstance` fallback replaced by a real import (opts-injection keeps priority); exports the Product-owned surface. Data layout, MIME semantics, integrity read path untouched. |
| `src/extensions.js` | classic → ESM; Runtime symbols via `./product/runtime-api.js`, harness contract symbols via `./product/harness-api.js`; `SKILL_DIFF_MAX_CHARS` moved INTO this module (value 20000 + fail-closed semantics unchanged); exports the Product adapter surface. |
| `src/capability-package.js` | classic → ESM; the four REAL descriptor validators, `EXTENSION_ID_PATTERN`, `SKILL_INSTANCE_MAX_BYTES`, `sha256Hex` imported via `./product/harness-api.js`; `globalThis.LocusCapabilityPackage` publish removed (named exports instead). No validation algorithm copied, no shared constant transcribed. |
| `tests/m3c-storage-adapters.test.mjs` | **NEW** dedicated Node suite (56 checks). |
| `tests/e2e-m3c-storage-adapters.cjs` | **NEW** independent real-browser suite (23 checks, real Chrome via CDP, own host page + import map). |

Not touched: store/main/tools, `package.json`, lockfile, CI, existing shared
tests, the in-repo duplicate cores, everything owned by A/C/D.

## 2. Module export tables (outward symbols, consumer-verified)

**src/product/harness-api.js** — re-exports the 55-symbol locus-harness entry.
**src/product/runtime-api.js** — re-exports the runtime root (4), `./workspace`
(6), and the `runtimeWorkerAssets` namespace (worker assets), 11 top-level
names total.

**src/conversation-history-workspace.js**: `ConversationHistoryWorkspace`.

**src/persistence.js**: `PERSISTENCE_SCHEMA_VERSION`, `PERSISTENCE_DB_NAME`,
`LOCUS_HOME_SKELETON`, `PERSISTENCE_STORES`, `persistenceClone`,
`PersistenceService`, `PersistenceServiceInstance`, plus one-way re-exports
`validateReplayPrefix`, `validateNormalizedPrefix`.
Module-private (no external consumer found at 2aec76e): `persistenceUuid`,
`persistenceCloneFallback`, `persistenceSerializationError`, `persistenceError`,
`storageClearError`, `persistenceNow`, `persistenceMemoryStores`,
`persistenceUpgrade`, `persistenceRequest`, `persistenceTx`,
`persistenceSafeString`, `locusPersistence`. The local `replayValidationError`
definition is DELETED (the real one lives in the harness entry export
`replayValidationError`, available via harness-api).

**src/attachments.js**: `AttachmentStore`, `isAttachmentIntegrityError`,
`attachmentIntegrityError`, `imageContentPart`, `textContentPart`,
`IMAGE_MIME_TYPES`, `MAX_IMAGE_ATTACHMENT_BYTES`, `resolveImageMime`,
`uint8ToBase64`. Module-private: `sniffImageMime`, `base64WireBytes`,
`attachmentUuid`, `IMAGE_MAGIC`.

**src/extensions.js**: `StaticFileWorkspace`, `SkillInstanceStorage`,
`SkillInstanceWorkspace`, `productTaskVfsMounts`.
Module-private: `SKILL_DIFF_MAX_CHARS` (20000, moved from the composition
core — see §4), the local `vfsNotFound`/`vfsReadOnly` shims (see §4).

**src/capability-package.js**: `LocusCapabilityPackage` (frozen namespace,
unchanged shape incl. `PACKAGE_CONSTANTS`), `CapabilityBundle`,
`validateProject`, `buildProject`, `inspectBundle`.

## 3. Import migration table

| Module | Old implicit source (classic lexical chain) | New explicit import |
|---|---|---|
| conversation-history-workspace.js | `WorkspaceAdapter`, `normalizeWorkspacePath` ← workspace.js | `./product/runtime-api.js` |
| persistence.js | `__LOCUS_HARNESS_REPLAY_VALIDATION__` table | one-way re-export `./product/harness-api.js` (identity with the entry function — pinned by test R1) |
| persistence.js | `createCredentialIdentity` ← model-adapters.js (typeof-guarded) | `./product/harness-api.js` |
| attachments.js | `PersistenceServiceInstance` ← persistence.js (typeof-guarded) | `./persistence.js` (Product→Product direct) |
| extensions.js | `WorkspaceAdapter`, `normalizeWorkspacePath`, `vfsError`/`vfsNotFound`/`vfsReadOnly` ← workspace.js/vfs.js | `./product/runtime-api.js` |
| extensions.js | `EXTENSION_ID_PATTERN`, `skillInstancePath`, `SKILL_INSTANCE_ROOT`, `SKILL_INSTANCE_MARKER`, `SKILL_INSTANCE_MAX_BYTES`, `sha256Hex`, `SKILL_DIFF_MAX_CHARS` ← extension-composition.js | `./product/harness-api.js` (all but SKILL_DIFF_MAX_CHARS, which moved INTO this file) |
| capability-package.js | `WorkspaceAdapter`, `normalizeWorkspacePath` ← workspace.js | `./product/runtime-api.js` |
| capability-package.js | `validateCapabilityDescriptor`, `validatePluginDescriptor`, `validateSkillDescriptor`, `validateMcpDescriptor`, `EXTENSION_ID_PATTERN`, `SKILL_INSTANCE_MAX_BYTES`, `sha256Hex` ← extension-composition.js | `./product/harness-api.js` |

Zero `locus-runtime/…` / `locus-harness/…` specifiers outside
`src/product/{harness-api,runtime-api}.js`, zero deep core paths, zero
`globalThis`/`window` publishes in the converted modules (all pinned by the
dedicated suite's S6–S8 static scans).

## 4. Recorded adaptations & decisions

1. **`SKILL_DIFF_MAX_CHARS`** (handoff §6.2): moved into Product
   `src/extensions.js` as a module-private `const` with the ORIGINAL value
   (20000) and the original fail-closed semantics: a diff above the bound, or
   a header+diff detail above it, refuses with `skill_mutation_too_large`
   BEFORE any approval round trip (pinned by W9).
2. **Replay delegates** (handoff §6.3): `__LOCUS_HARNESS_REPLAY_VALIDATION__`
   delegate machinery deleted; persistence one-way re-exports the REAL
   entry validators under the same names (R1 pins function identity; R2–R7
   pin honest accept/reject).
3. **`vfsNotFound`/`vfsReadOnly` are NOT public runtime exports** (runtime
   workspace surface publishes `vfsError` only, and the cores are frozen).
   extensions.js now defines two one-line locals that call the public
   `vfsError` factory with the EXACT same names and message strings the
   runtime helpers produce (`'NotFoundError', 'no such file or directory: '
   + path` / `'ReadOnlyError', 'read-only filesystem: ' + path`). Same
   factory, same errors — not a second algorithm. All original call sites
   are textually unchanged. If integration prefers entry-level exports of
   the two helpers instead, that is a locus-runtime change and must go
   through a core-repo request, not this branch.
4. **`createCredentialIdentity` typeof-fallback** deleted: production always
   took the real-harness path (script order guaranteed it); the imported
   real function is now the only path. The null-config guard keeps the
   exact pre-switch `PersistenceSerializationError`. The never-taken
   manual-identity fallback branch is gone with the lexical chain.
5. **`AttachmentStore` persistence fallback**: `opts.persistence` keeps
   priority; the canonical instance import replaces the typeof dance.
   Storage doubles for tests remain fully supported (the port is a
   constructor parameter, unchanged).
6. **`LOCUS_HOME_SKELETON`** stays a Product-owned export of persistence.js
   (value unchanged); store.js passes it into the VFS explicitly today and
   will import the name from this module at C's switch (§7).

## 5. Test evidence

**Dedicated Node suite — `node tests/m3c-storage-adapters.test.mjs`: 56/56
checks PASS.** Coverage: ESM import surface + export tables (S1–S5); static
scans for forbidden specifiers/deep paths/global publishes (S6–S8); REAL
replay validators — function identity with the entry, valid prefix accepted,
`session_identity_mismatch` / `checkpoint_beyond_tail` /
`raw_classifier_missing` / `normalized_tool_batch_dangling` rejected (R1–R7);
capability package over the REAL fixture project — validate/build/inspect
with the lock hash equal to BOTH `sha256Hex` and an independent node-crypto
oracle; descriptor fault refuses through the REAL validator
(`package_descriptor_invalid`); oversized skill refuses at the REAL shared
bound (`package_skill_too_large`) (C1–C7); skill contract agreement with the
harness (path identity, marker hidden from `list()` but present on the raw
storage port, marker/foreign/mkdir refusals, byte bound) (K1–K6); skill
write/delete confirmation semantics — no-signal fails closed, missing
approval port refuses, declined keeps the file, confirmed write/delete
apply, byte-identical write is a no-op without an approval round trip,
TOCTOU race is a conflict that never applies a stale diff, the moved 20000
diff bound fails closed before any approval (W1–W9); mount-spec →
StaticFileWorkspace mapping and the `.skills`-rooted storage addressing
(W10–W12); storage-failure honesty — failed attachment metadata write
surfaces the ORIGINAL failure and rolls back only its own blob, bit-flip →
`hash_mismatch`, truncation → `size_mismatch` (gate order), record without
id/key is a serialization failure (F1–F8); real PersistenceService memory
path + harness credential identity + durable record format + history view
(P1–P7). In-memory doubles appear ONLY as storage/approval ports.

**Independent real-browser suite — `node tests/e2e-m3c-storage-adapters.cjs`:
23/23 checks PASS** (first run, real headless Chrome via CDP, own host page
with an import map that resolves the bare core specifiers into the installed
packages; NO product page, so it does not depend on C's index.html switch):
REAL IndexedDB open at schema v3 with healthy health + settings round trip +
remembered credentials keyed through the REAL harness identity + atomic
`deleteConversation` (B1, P1–P3); REAL OPFS home skeleton, privileged plugin
write/read, attachment ingest durable across REAL IDB+OPFS, exact-bytes
`resolveForWire`, corruption refused `hash_mismatch`, clear removes bytes
(B2, O1–O6); the REAL fixture capability project validates/builds in-page
with the lock hash equal to the page's `crypto.subtle` oracle (C1–C4);
replay-validator identity + accept/reject in the browser (R1–R3); skill
marker refusal + path identity + fail-closed without approvals + shared
bound (S1–S4).

**Regression status on this branch** (parallel-window state, by design):

- `npm run build` (vite): **succeeds**.
- Full unit registry `npm test`: **43/56 suites pass; 13 fail — exactly and
  only the suites that `readFileSync + eval` the converted sources**
  (top-level import/export is a parse error under eval). These are:
  `persistence`, `persistence-audit`, `attachments`, `capabilities`,
  `image-probe`, `agent-image`, `capability-package`, `capability-composition`,
  `skill-instances`, `python-plugin-runtime`, `python-lifecycle`,
  `store-python-lifecycle`, `product-integration`. Per handoff §4.6/§5 D
  rewires these onto the ESM imports (the two new suites show every one of
  their behavioral claims is re-provable against the converted modules);
  registration of `tests/m3c-storage-adapters.test.mjs` in
  `tests/run-unit.cjs` is D's wiring too. NO shared suite was modified.
  (`runtime-boundary` G5 failed once in the fresh worktree purely because
  `dist/` did not exist yet; after the recorded `vite build` it passes
  21/21 — environmental, not caused by this change.)
- Browser suites that drive the product page (`index.html`) will fail until
  C removes/repoints the five `<script>` tags (the converted files are no
  longer classic scripts). That switch is C's; this branch's own browser
  evidence is the independent host-page suite above.

## 6. Cross-boundary record: `src/product/runtime-api.js` scaffold

**Created by B, verbatim, and deduped at integration.** The frozen §3
interface requires B's modules to import `../product/runtime-api.js`, but
that file is A's and does not exist at M3C_BASE — without it no B module
imports and no B test can run. Resolution taken: B created the file with
EXACTLY the handoff §3 frozen shape (comment line + the three export lines,
nothing else), so:

- If A's file lands byte-identical (the §3 shape), git auto-resolves the
  add/add cleanly.
- If A's file differs by any byte, git raises an add/add conflict — D takes
  **A's file** wholesale; B's modules import by symbol name only and need
  no further change.

B claims no ownership of the file's content beyond the verbatim scaffold.

## 7. Wiring contract for C/D (consumers of B's modules)

store.js (and any other consumer) keeps every symbol name; only the import
site changes:

| store.js reads today (global) | Import after C/D wiring |
|---|---|
| `PersistenceServiceInstance`, `PersistenceService`, `LOCUS_HOME_SKELETON`, `persistenceClone` | `../persistence.js` |
| `AttachmentStore`, `imageContentPart`, `textContentPart`, `isAttachmentIntegrityError` | `../attachments.js` |
| `ConversationHistoryWorkspace` | `../conversation-history-workspace.js` |
| `SkillInstanceStorage`, `SkillInstanceWorkspace`, `productTaskVfsMounts`, `StaticFileWorkspace` | `../extensions.js` |
| `LocusCapabilityPackage` (or the named pieces) | `../capability-package.js` |
| harness symbols (`createTaskRunner`, `isPersistenceFailure`, `createProviderSessions`, `harnessCapabilities`, `historyBudgetBytes`, …) | `../product/harness-api.js` |
| runtime symbols (`createRuntime`, `createWorkspace`, `WorkspaceAdapter`, …) | `../product/runtime-api.js` (`runtimeWorkerAssets.PY_WORKER_SOURCE` / `.GREP_WORKER_SOURCE` for worker assets) |

C's remaining known adaptation (recorded in handoff §6.1, owner C, NOT done
here): drop `supportedRegistryVersions` + the `result.harness.registryVersion`
projection in `src/product/core-compatibility.js` — the harness package no
longer declares `registryVersion`, and C must remove that requirement in the
same integration change.

## 8. Not done here (boundaries respected)

No store/main/tools changes, no `index.html`/`vite.config.js` changes, no
package/lock/CI changes, no edits to the in-repo duplicate cores, no shared
test modifications, no run-unit registration (D), no merges/publishes, no
M4. Browser IDB/OPFS product-page regression is integration D's gate; this
branch's own browser evidence is recorded above.
