# M4a-B — Product ownership cleanup (stale post-split entries + production-graph ownership gate)

Status: **M4a-B deliverable**, branch `refactor/m4a-product-ownership-cleanup`,
PR base `refactor/m3c-integration` (PR #5 OPEN at head
`d6a74a25a2b98293d9aa1f2a635022d8f5ed733b` — verified on GitHub before any
work; `main` does not contain the baseline, so the integration branch is the
base). Nothing merged, nothing published, no deploy; PR #5 is not modified.

Fixed inputs (unchanged, resolved by `npm ci` from the lockfile):

- locus-runtime `2435a57ff7a66db3db88aa98a88d404c75133483`
- locus-harness `347eed99a415dc080b97d46d8a4271ceb19c5142`
- source snapshot (read-only reference)
  `2aec76e78431382873be1db8a6db6310cc89c782`

Preliminaries verified before work: remote `origin/refactor/m3c-integration`
== `d6a74a25…`, worktree fresh from that SHA, and **no AGENTS.md exists in
locus-product** (`git ls-files` at the baseline; consistent with
M3C-REVIEW-VERIFICATION.md's preamble) — the M3C-PARALLEL-HANDOFF ownership
contract and the task statement govern.

Scope discipline: this round cleans CONFIRMED-stale product-tree entries and
doc links, and persists an ownership gate over the production dependency
closure. It is NOT a repo-wide keyword purge: historical verification and
provenance documents (REPOSITORY-SPLIT-\*, M3C-\*, Locus-audit-\*,
`tests/fixtures/pyodide-lock-snapshot.json`) keep their old names untouched,
and no core implementation is added, copied or rewired.

## 1. Audit method

1. Mechanical closure derivation from the REAL production entry
   (`index.html` → `/src/main.js` → static import graph, Vue SFC script
   blocks included). Result at the baseline: 28 files, all under `src/`,
   zero dangling edges, bare specifiers exactly `{ vue,
   locus-runtime, locus-runtime/workspace, locus-runtime/worker-assets,
   locus-harness }` with the core specifiers ONLY inside the two transfer
   layers. One src/ file outside the closure: `src/capability-package.js`
   (disposition below).
2. Per-candidate caller search (src, tests, docs, `package.json`,
   `vite.config.js`, `index.html`, `.github/workflows/`) before any
   disposition — no directory was removed merely for coming from the source
   snapshot.
3. Live documentation (concept/model/security docs indexed by
   `docs/README.md`) was separated from historical records; only live docs
   with references to files DELETED by the M3c switch were edited.

## 2. Disposition table (before → after)

### Removed (confirmed stale; each with its evidence)

| Item | Actual callers | Reachable? | Ownership of the subject | Disposition |
|---|---|---|---|---|
| `scripts/verify-python-bootstrap-manifest.mjs` | none: not in `tests/run-unit.cjs`, not in `tests/helpers/browser-gate-suites.cjs`, not referenced by `.github/workflows/ci.yml`; doc references only (ROADMAP.md, EXTENSION-MODEL.md — both fixed here) | NO — cannot run: reads `ROOT/src/shell.js`, which the M3c integration deleted (`bad157d`); the manifest itself (`PYTHON_BOOTSTRAP_MANIFEST`) now lives in locus-runtime `src/shell.js` | runtime trusted base (F04c) → locus-runtime; the pinned runtime tree carries NO verifier (`tools/` = consumer-e2e, extract-sources, verify-import-purity only) | DELETE. Migrated subject + zero product use + broken copy. Residual recorded in §6: rehoming the CDN-bytes verifier into locus-runtime is runtime-repo work. Product keeps the provenance fixture (kept row below) |
| `examples/demo-workspace/sales.csv` | zero repo-wide (grep over src/tests/docs/config) | NO — the `?demo=task` mode fabricates its own `q3-sales.csv`/`q3-report.csv` content INLINE in `src/main.js` (OPFS `demo-workspace`); no filesystem or import relationship | sample data, source-snapshot leftover | DELETE (whole `examples/` tree; nothing else is in it) |
| `ROADMAP.md` | zero (no build/test/CI/doc consumer except `docs/README.md`'s pointer — fixed here) | NO (prose only) | source-repo planning doc | DELETE. Status claims false at this baseline: "three-repository split … implementation pending", plus V0.x milestone statuses pointing at deleted product paths (`src/agent.js`, `src/model-adapters.js`, `src/shell.js`) and deleted suites (`tests/agent.test.cjs`, `tests/shell-compat.test.cjs`, `tests/e2e.html`). The real history is retained in REPOSITORY-SPLIT-\*.md and M3C-\*.md |
| `TODO.md` | zero (same as above) | NO (prose only) | source-repo backlog doc | DELETE. "M3/M4 pending" is false — M3 is complete in its actual three-repo form (this branch runs on the pinned-extraction result); the monorepo-era extraction checklist it awaits was superseded by the real repository extraction |

### Kept (with the reason recorded, not assumed)

| Item | Evidence of use | Decision |
|---|---|---|
| `functions/fetch.js`, `functions/proxy.js` | Product deployment infrastructure (edge relay `/fetch`, model relay `/proxy`; REPOSITORY-SPLIT-INVENTORY §2.15). REAL callers: `tests/fetch.test.mjs`, `tests/proxy.test.mjs`, `tests/verify-active-content.cjs`, `tests/e2e-network.cjs` | KEEP unchanged |
| `benchmarks/REAL-WORLD-50.md` + `tests/real-world-50/` | self-contained evaluation corpus + deterministic fixture space (python generator + human-only oracle); no stale source references; runner is manual BY DESIGN ("Runner: not defined in this document") | KEEP. A Product evaluation concern, not a stale copy; wiring a runner is new work, not cleanup |
| `src/telemetry.js` + `globalThis.Telemetry` / `window.__telemetry` handles | M3C-D-INTEGRATION §6 asked to re-examine "once nothing reads them" — things DO read them: `ContextRail.vue` (`Telemetry.records`), `src/ui/store.js` (`telemetryVersion` bump), browser-gate evidence reads (`tests/e2e-network.cjs`, `tests/e2e-ui-page.js`) | KEEP unchanged (condition for removal not met) |
| `src/capability-package.js` | the ONE file under `src/` outside the index.html closure — NOT stale: Product authoring/package boundary whose production-UI wiring is deliberately pending (its own header); REAL consumers: `tests/m3c-storage-adapters.test.mjs`, `tests/e2e-m3c-storage-adapters.cjs`, and the packaged-build gate `tests/e2e-m3c-storage-built.cjs` through `tests/m3c-storage-host.html` (a REAL vite build input importing it) | KEEP, now GUARDED: the ownership gate allowlists exactly this file and asserts the storage host still imports it (`OWN5.exemption-has-real-consumer`), so the exemption cannot silently rot |
| `tests/fixtures/pyodide-lock-snapshot.json` | zero ACTIVE readers (historical since the bootstrap-integrity suites moved to locus-runtime) | KEEP — provenance artifact (documented generation method in its comment); deleting provenance is out of this round's mandate |
| all REPOSITORY-SPLIT-\* / M3C-\* / Locus-audit-\* docs | historical verification and provenance records | KEEP untouched (old names allowed by the task) |

## 3. Live-doc fixes (references to files the M3c switch deleted)

Every edit points the reader at the owning repository's module; historical
docs were deliberately NOT rewritten. Nine files, sixteen spots:

| File (before → after) | Fix |
|---|---|
| `docs/CONCEPTS.md` (ModelCapabilityRegistry) | `src/capabilities.js` → "locus-harness core (`src/capabilities.js`)"; composition registry annotated Product-owned |
| `docs/IMAGE-INPUT.md` (flow diagram + 2 section headers) | `src/capabilities.js`, `src/model-adapters.js` → `locus-harness …` |
| `docs/MODEL-PROTOCOL.md` (envelope note, replay policy, 3-node diagram) | `src/model-adapters.js`, `src/model.js`, `src/agent.js` → `locus-harness …` |
| `docs/NETWORK-RUNTIME.md` (intro, stack diagram, classifier pairing, curl migration) | `src/network.js`, `src/shell.js` → `locus-runtime …`; classifier sentence now says "locus-runtime src/network.js + this repo's functions/fetch.js edge relay" |
| `docs/CAPABILITY-BOUNDARIES.md` (§Image registry) | registry → locus-harness; `src/extensions.js` annotated Product-owned |
| `docs/APPROVALS.md` (API section header) | `src/approval.js` → "locus-harness `src/approval.js`" |
| `docs/EXTENSION-MODEL.md` (manifest supporting fact) | the deleted product verifier replaced by the true post-switch picture: manifest in locus-runtime `src/shell.js`, product witness `tests/helpers/python-manifest.cjs`, verifier belongs to locus-runtime, provenance snapshot retained here |
| `docs/TESTING.md` (TPR v1A paragraph) | `tests/python-plugin-runtime.test.cjs` / `tests/e2e-python-plugin-runtime.cjs` marked as locus-runtime repository suites (same names, pinned SHA), not carried in this product repo |
| `docs/README.md` (status paragraph + normative item 3 + status pointers) | "split is a target architecture … M3/M4 remain pending" → split IMPLEMENTED with pointers to M3C-D-INTEGRATION / M3C-REVIEW-VERIFICATION; dead `../ROADMAP.md` / `../TODO.md` links replaced by the removal record (this document) |

`README.md` (repository root) needed NO change: it already documents the
M3c switch and contains no links to the removed files.

## 4. New ownership gate — `tests/m4a-product-ownership.test.cjs`

A zero-dependency Node suite that scans the ACTUAL production dependency
closure (entry `index.html` → `/src/main.js`, static imports incl. Vue SFC
script blocks — not a repository keyword grep):

- **OWN1** the page is ONE module entry and ZERO classic scripts.
- **OWN2** the closure is non-empty and contains `src/main.js` plus BOTH
  transfer layers (`src/product/runtime-api.js`,
  `src/product/harness-api.js`).
- **OWN3** graph discipline: every relative import resolves to a real file
  under `src/` (catches dangling imports, adjacent-checkout escapes and
  `node_modules` path imports); bare specifiers are exactly `vue` plus the
  public core entries, the latter only inside the two transfer layers, and
  any deeper core subpath (`locus-runtime/src/…`) is rejected anywhere.
- **OWN4** no residual core assembly in the closure, comment-stripped:
  `__LOCUS_RUNTIME_CORE__` / `__LOCUS_HARNESS_CORE__` /
  `__LOCUS_HARNESS_REPLAY_VALIDATION__`, `eval(`, `new Function(`. The
  historical COMMENT mentions in `src/persistence.js` do not fire
  (self-proved).
- **OWN5** ownership coverage: every JS/Vue file under `src/` is reachable
  from the entry EXCEPT the single documented exemption
  (`src/capability-package.js`), and the exemption is tied to its real
  consumer (the packaged storage gate's host page) so it cannot rot
  silently.
- **OWN6–OWN13 + comment exemption**: NEGATIVE SELF-PROOFS. Each forbidden
  shape — classic script tag, core import outside the transfer layer, deep
  core subpath, undeclared dependency, dangling import, adjacent-checkout
  import (target OUTSIDE the tree root), residual core table, `eval` — is
  rebuilt in a throwaway tree under the OS temp dir and run through the
  SAME scanner; each check asserts the specific violation fires. The real
  worktree is never modified. (The first injection drafts placed the
  violating file OUTSIDE the reachable closure and correctly did not fire —
  the scanner judges the closure by design; the injections were fixed to be
  reachable, which is itself documented in the suite comments.)

Relation to existing checks: `m3c-product-wiring` (PW2/PW3/PW4) pins the
page tags, the store's classic-global independence and the symbol-exists
proofs — untouched, nothing weakened. What M3C-D-INTEGRATION §3 recorded as
one-time manual closure greps ("Closure checks (all clean)") existed in NO
persisted suite; this gate is that check, permanent and self-proving.

**Registration suggestion for the integration agent D** (run-unit.cjs is
not modified by this branch, per the M3c registration discipline;
precedent: D's wiring commit `1ff69248`): append one line to `SUITES` in
`tests/run-unit.cjs`:

```js
  // M4a-B: production-graph ownership gate (closure from the real entry;
  // fault-injection self-proofs run in OS-temp trees).
  'm4a-product-ownership.test.cjs',
```

Until D registers it, run it directly: `node
tests/m4a-product-ownership.test.cjs`.

## 5. Verification evidence

| Step | Command | Result |
|---|---|---|
| New gate | `node tests/m4a-product-ownership.test.cjs` | 15 passed, 0 failed |
| Production build | `npm run build` | green — all four inputs (`main`, `runtimeHost`, `harnessHost`, `storageHost`) bundled, 1.02s |
| Full unit gate | `npm test` (27 registered suites) | all 27 suites passed at this head; no assertion weakened |
| Browser gates | not re-run | per the task rule: this round's deletions and doc edits touch NO production import and NO build input (the OWN1–OWN5 pass IS the closure-unchanged proof, and the build chunk set is unchanged); no packaged/browser behavior can differ |

No dependency version changed (`package.json` / `package-lock.json`
untouched); `.github/workflows/`, `tests/run-unit.cjs` and the core-candidate
tooling untouched; the two core repositories and the source repository
untouched.

## 6. Residuals (explicitly NOT done here)

1. **locus-runtime**: rehome the Python bootstrap CDN-bytes verifier
   (deleted from this repo per §2; the runtime's `tools/` at the pinned SHA
   has no such tool). Runtime-repo work.
2. **`src/capability-package.js` production wiring** (TPR authoring/self-
   hosting flows): future product work; the ownership gate now watches the
   seam.
3. **Roadmap content**: not rehomed anywhere — the removed ROADMAP/TODO
   content was stale status, and inventing new planning content is beyond a
   cleanup round. `docs/README.md` now points the status reader at the
   verification records.
4. **REAL-WORLD-50 runner**: stays manual (its own documented scope).
5. `tmp-f04b-probe/` is untracked and carries no branch content; it is not
   part of this PR.
