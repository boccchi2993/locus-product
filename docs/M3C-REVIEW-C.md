# M3c Review Round C — Storage Adapter Packaged-Build Gate

- Branch: `fix/m3c-review-storage-build` (locus-product), cut from the fixed
  baseline `b7da804fd24e64c2fb1b3c82b69070d4c55cb31e` (head of
  `refactor/m3c-integration`, verified identical local/remote).
- Fixed cores (verified against `package.json` at the baseline, unchanged):
  `locus-runtime#2435a57ff7a66db3db88aa98a88d404c75133483`,
  `locus-harness#347eed99a415dc080b97d46d8a4271ceb19c5142`.
- No AGENTS.md exists in locus-product (or the source repo) — the
  `docs/M3C-PARALLEL-HANDOFF.md` ownership contract is the governing
  document; this patch stays inside its file boundary.
- Parallel with review fixes A/B: only the files listed in §Ownership were
  touched. No dependency updates (`npm ci` only).

## 1. Confirmed problem

`tests/e2e-m3c-storage-adapters.cjs` starts its own HTTP server, serves the
Product `/src` files and the installed `locus-runtime` / `locus-harness`
package sources **raw**, and resolves bare specifiers with an **import
map**. It is a source-ESM browser test; it never executes the Vite build.
`docs/M3C-D-INTEGRATION.md` §5 counted it under "Browser gates over the
PACKAGED build … 14/14", which made the packaged-artifact claim for the
storage adapters unsupported.

## 2. Fix

Two gates now exist with pinned names, sharing ONE scenario engine and ONE
check table so storage semantics cannot drift:

| | source-ESM gate | packaged-build gate |
|---|---|---|
| file | `tests/e2e-m3c-storage-adapters.cjs` (kept) | `tests/e2e-m3c-storage-built.cjs` (new) |
| page | generated in-memory HTML | `dist/tests/m3c-storage-host.html` — a REAL vite build input |
| module resolution | own server serves `/src` + `/vendor` (node_modules) raw, import map | the bundle: `vite preview` of `dist/` only |
| page provenance proof | B0 binding provenance | B0 + resource audit GA–GD |
| checks | shared 23 + E0 page-error hygiene | shared 23 (identical table, never weakened) + GA–GD audit |

- `tests/helpers/m3c-storage-shared.js` (new): the five storage scenarios
  (P real IndexedDB / O real OPFS / C capability package / R REAL replay
  validators / S skill-instance contract) moved verbatim out of the old
  page; both host pages import it and hand in their resolved module
  namespaces plus the fixture bytes. It records binding provenance
  (`typeof` of the six namespaces + the workspace class) that B0 asserts.
- `tests/helpers/m3c-storage-checks.cjs` (new): the 23-check table, kept
  verbatim from the original suite (B0 strengthened with the provenance
  read — nothing weakened). Both drivers run this one table.
- `tests/e2e-m3c-storage-adapters.cjs` (modified): header now states its
  source-ESM nature and points at the packaged gate; the page body is
  slimmed to imports + fixture decode + one call into the shared engine;
  the server additionally serves `/tests/helpers/` raw (that IS this
  gate's nature). Same boot/budget contract as before (runAll 60 s,
  readiness 15 s — no timeout inflation).
- `tests/m3c-storage-host.html` (new): minimal packaged host. Imports the
  five converted Product modules (`persistence`, `attachments`,
  `extensions`, `capability-package`,
  `conversation-history-workspace`), the two product public API re-export
  layers (`src/product/runtime-api.js`, `src/product/harness-api.js`) and
  the shared engine. Fixture delivery: `import.meta.glob(...,
  { query: '?url', eager: true })` over `tests/fixtures/capability-
  package/minimal/**` — Vite's asset pipeline (every fixture is < 4 KiB,
  so each inlines as a data: URL inside the chunk; the wheel's ZIP bytes
  demonstrably survive — C1–C4 hash/build them in-page). The whole source
  repo is NOT copied into dist. Page errors, unhandled rejections and
  every resource load are recorded for the driver.
- `vite.config.js` (modified): `rollupOptions.input.storageHost:
  'tests/m3c-storage-host.html'` — the only build change required.
- `tests/e2e-m3c-storage-built.cjs` (new): the packaged driver.
  - Talks ONLY to `vite preview` (default
    `http://127.0.0.1:4173/tests/m3c-storage-host.html`, override
    `E2E_M3C_STORAGE_BUILT_URL`); serves no `/src`, no `/vendor`, no
    node_modules file; no import map anywhere.
  - Resource audit GA: every loaded resource must be the dist host page,
    the browser-automatic favicon, or a hashed dist asset
    (`assets/<name>-<8-char hash>.<ext>`); `/src`, `/vendor`, `/@vite`,
    `/@fs`, `node_modules` and unhashed paths are violations.
  - GB: the entry chunk parsed out of the BUILT host HTML must be the
    loaded entry. GC: the product main entry chunk parsed out of
    `dist/index.html` must NEVER load. GD: zero page errors /
    unhandled rejections.
  - Its own throwaway Chrome profile per pass (fresh IndexedDB/OPFS — a
    dirty profile could make the real-storage checks pass vacuously);
    profile and Chrome are torn down in `finally`.
  - Negative self-proof (runs on EVERY invocation, two cases): a
    temporary COPY of `dist/` (the real dist/ is never modified) with
    (A) the host page removed, (B) the storageHost entry chunk removed,
    must FAIL the same driver — booted=false or any check failure. Any
    unexpected pass is a gate failure ("no fallback to a source page may
    pass").

    [Annotated 2026-10-05, second review round (F2): "booted=false or any
    check failure" proved too weak — ANY driver exception (a browser/CDP
    infrastructure failure included) made `!booted` true and printed
    "PASS SELFPROOF". The verdict is now a STRUCTURED judge
    (`tests/helpers/m3c-storage-built-verdict.cjs`, one implementation
    shared with the driver and unit-tested in
    `tests/m3c-storage-built-verdict.test.cjs`): the self-proof passes
    only with request-level evidence — the exact host/entry-chunk URL
    observed (CDP Network wired before navigation), the explicit 404,
    the host never booting, no fallback load, server log corroborating.
    An infrastructure failure, an unrelated readiness timeout, or the
    full dist misfed as broken now FAILS the self-proof and the gate.]

## 3. Evidence (this branch, Windows, Node v24.10.0, Chrome 154 headless)

- `npm ci`: clean (github: git deps through the lockfile only).
- `npm run build`: 68 modules; new outputs
  `dist/tests/m3c-storage-host.html` (2.08 kB) and
  `assets/storageHost-V6KPtMcm.js` (32.31 kB) plus shared chunks
  (`conversation-history-workspace-xkQFPosu.js`, `worker-assets`,
  `index-*`); existing outputs unchanged in role.
- Source-ESM gate: `node tests/e2e-m3c-storage-adapters.cjs` —
  **all 24 checks passed** (23 shared + E0).
- Packaged-build gate (own preview on a free port,
  `E2E_M3C_STORAGE_BUILT_URL=http://127.0.0.1:<port>/tests/m3c-storage-host.html`):
  **all 27 behavior/audit checks + 2 negative self-proof cases passed**.
- Resource evidence (actual `performance` resource entries of the built
  page — dist chunk graph + favicon only; no `/src`, `/vendor`, `/@vite`,
  node_modules):
  ```
  /assets/storageHost-V6KPtMcm.js            (entry, = GB expectation)
  /assets/modulepreload-polyfill-B5Qt9EMX.js
  /assets/index-B9RRRRPF.js                  (core chunk)
  /assets/index-Co5HpAdM.js                  (core chunk)
  /assets/conversation-history-workspace-xkQFPosu.js
  /favicon.ico                               (browser-automatic, 404)
  ```
- Unit regression: `node tests/run-unit.cjs` — **all 24 suites passed**
  (incl. `m3c-product-wiring` PW6 build-input checks and the
  `m3c-storage-adapters` Node suite).
- First failure (preserved, and instructive): the first built-gate run
  FAILED honestly — port 4173 was held by a stale preview from a
  different worktree (`Locus-product-m3c-clean`, started 13:38 by a
  parallel task), whose SPA fallback served an OLD `index.html` at the
  host URL; the driver timed out waiting for `window.__m3c`. The gate
  refused the non-build page — precisely the property the self-proof
  pins. Disposition: this suite must run against a preview of ITS OWN
  dist; the orchestrator starts one per run (strictPort fails loudly on
  collisions), and standalone runs should pass `E2E_M3C_STORAGE_BUILT_URL`.

## 4. New command for integration D to register

In `tests/run-browser-gates.cjs` `SUITES` (after
`e2e-m3c-storage-adapters.cjs`):

```
e2e-m3c-storage-built.cjs
```

No env needed in the orchestrator context (default URL matches its
preview). After registration the doc claim to make is: packaged browser
gates 15/15, where storage adapters are covered by BOTH the source-ESM
gate (23+1) and the packaged gate (23+4 audit + self-proof).
`docs/M3C-D-INTEGRATION.md` §5's original "14/14 packaged" sentence is
corrected by this document: at `b7da804` the storage suite was source-ESM
only.

## 5. Ownership / boundaries

Touched (exactly the allowed set):
`tests/e2e-m3c-storage-adapters.cjs`, `tests/e2e-m3c-storage-built.cjs`
(new), `tests/m3c-storage-host.html` (new),
`tests/helpers/m3c-storage-shared.js` (new),
`tests/helpers/m3c-storage-checks.cjs` (new), `vite.config.js` (input
only), `docs/M3C-REVIEW-C.md` (new).

Untouched: production sources, orchestrator (`tests/run-browser-gates.cjs`),
CI, `package.json`/lockfile, `tests/run-unit.cjs`, all other shared tests,
`docs/M3C-D-INTEGRATION.md` (belongs to D). No merge, no deploy, no M4.
