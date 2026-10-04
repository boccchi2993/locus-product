# M3c review fix B — Python product-integration browser coverage

Status: **review fix B deliverable**, branch
`fix/m3c-review-python-gates` (from `refactor/m3c-integration` @
`b7da804fd24e64c2fb1b3c82b69070d4c55cb31e`). No PR opened, no dependency
updated, nothing merged, no deploy. Companion to review fixes A/C; this
branch adds TEST files only (one browser gate, one helper module, two
fixtures, this document) — zero production-source, orchestrator, config,
CI or shared-suite changes.

Established: 2026-10-04.

## 1. Fixed inputs (verified before work)

| Role | Repository | Pinned commit | Verified |
|---|---|---|---|
| Product baseline | boccchi2993/locus-product | `b7da804fd24e64c2fb1b3c82b69070d4c55cb31e` | GitHub API 200; local `refactor/m3c-integration` head equals it; clean tree |
| Runtime core | boccchi2993/locus-runtime | `2435a57ff7a66db3db88aa98a88d404c75133483` | GitHub API 200; `npm ci` + `npm ls` resolve exactly this SHA |
| Harness core | boccchi2993/locus-harness | `347eed99a415dc080b97d46d8a4271ceb19c5142` | GitHub API 200; same lockfile resolution |
| Source snapshot | boccchi2993/Locus-browser-agent-runtime | `2aec76e78431382873be1db8a6db6310cc89c782` | GitHub API 200; old suites read from the object |

AGENTS.md: **absent** in locus-product at the baseline (verified: GitHub
contents 404 for AGENTS.md at `b7da804`, and no AGENTS.md/CLAUDE.md in the
checkout). Nothing to comply with; recorded for the review trail.
`package.json` pins both cores to exactly the fixed SHAs (not a range), so
`npm ci` alone reproduces the dependency set; no update was attempted.

Worktree discipline: this branch lives in a fresh standalone clone
(`Locus-product-m3c-review-b`); the `refactor/m3c-integration` workspace
and every other agent's workspace were not touched (no shared checkout
writes, no shared-branch commits, PR #5 untouched).

## 2. The gap this branch closes

`tests/run-browser-gates.cjs` runs 14 product gates. Its header comment
still lists `python-authority / python-browser-authority /
python-plugin-runtime / python-bootstrap` among the product-page gates,
but those suites do not exist in this repository: M3c-D's disposition
moved them "with the runtime package" (same-named suites in locus-runtime
tests/) and kept only `e2e-product-joint` J2 for the product python path.
J2 proves exactly one python behaviour end-to-end: a heredoc `print`,
`pythonStatus === 'ready'`, and a REAL verified Pyodide download. Every
DENIAL, INTEGRITY-NEGATIVE, PLUGIN-PAYLOAD and CANCELLATION behaviour now
had zero coverage on the CURRENT product assembly: the pinned cores' own
suites drive the cores' standalone host pages, so none of them can see a
Product wiring regression (a broken ToolPort injection, a prepare-barrier
regression, a broken approval bridge, a stale composition payload). This
branch re-proves those behaviours **through the packaged product page and
its real production chain**.

## 3. Scenario coverage table

Judged by behaviour and execution chain, not by assertion counts. "Pure
Runtime" = the behaviour's enforcement lives inside the runtime package
and the product merely consumes it; "cross-boundary" = the behaviour
manifests only through the Product's own wiring (composition, prepare
barrier, ToolPort, approval bridge, provider transport). Column "B hit"
names the assertion block of the new gate that covers the gap.

| # | Original scenario (source `2aec76e` → migrated form at runtime `2435a57`) | Behaviour it proves | Chain | Current product coverage before B | Gap → B hit |
|---|---|---|---|---|---|
| 1 | `python-authority` E1/E2 (basic python, pandas/numpy) | compute + declared packages intact under the lockdown | pure Runtime (worker) | J2 (print only) | partial → B-PY0 (pandas coexists in B-PLG1) |
| 2 | `python-authority` E3–E7c/f, E14, E18 (`js.fetch`, `pyfetch`, `micropip`, `importScripts`, nested Worker, sync XHR, WebSocket, `urllib`, prototype-chain family) | python-side network authority denied, probe counters stay ZERO | cross-boundary (worker × browser) | none (moved out) | **gap → B-PY1–B-PY8** (counter oracle + denial marker, single attempt, no auto-retry) |
| 3 | `python-authority` E8/E9 (undeclared imports honest, `loadPackage`/`loadPackagesFromImports` denied) | package authority stays with the runtime | pure Runtime | none | **gap → B-PY9, B-PY10** |
| 4 | `python-authority` E10/E10e (dynamic JS escapes; reconstructed-Function dynamic import blocked by the creator CSP with ZERO requests) + E10g (strict-CSP creator iframe present) | CSP architecture on the REAL page | pure Runtime (hosted by product) | none | **gap → B-PY11–B-PY13** (E10g-equivalent on the product page) |
| 5 | `python-authority` E11/E12 (reset / worker-crash recovery re-applies lockdown) | authority survives lifecycle events | pure Runtime | none | not copied — lifecycle-internal, covered at the pinned runtime; see §7 residuals |
| 6 | `python-authority` E16/E17 (ZERO probe traffic across the whole suite; no page errors) | no hidden attempts anywhere | cross-boundary | none | **gap → B-TOT / B-TOTc** (whole-suite counter total) |
| 7 | `python-browser-authority` Phase A/B (strict-CSP architecture proof, in-memory bootstrap, no-CSP control workers) | the architecture itself | pure Runtime | none | architecture proof not copied (it is runtime-internal); product-page residue covered by B-PY13 |
| 8 | `python-bootstrap-integrity` (F04c browser E1–E8: sha256 fail-closed, no fake ready, exact pinned URL set, budget separation, verified-cache reuse) | bootstrap integrity is enforced on the page that ASSEMBLES the runtime | pure Runtime (page fetch = trusted harness role; product plays that role here) | J2 positive path only | **gap → B-BOOT1** (test-side interception corrupts the product's ACTUAL asset request: fail-closed + no fake ready + sentinel never ran + failure reached the model) + B-TOTb (URL pinning) + B-PLG1c/B-PLG2c (verified-cache reuse, zero asset fetches) |
| 9 | `python-plugin-runtime` (TPR browser E1–E2, I2–I5, S2–S3, U2: install-before-READY, smoke import, integrity negatives, post-READY package authority) | payload integrity + post-READY authority | pure Runtime (`configureExtensions`) | none | wheel form stays at the runtime boundary (see §7); **Product composition gap → B-PLG1/B-PLG2/B-PLG3/B-PLG4** (provider-seam payload through CapabilityManager → session.prepare), post-READY authority → B-PY1–B-PY9 on a live plugin interpreter |
| 10 | `python-lifecycle` (unit: prepare/reset/dispose/queue algebras) | lifecycle semantics | pure Runtime | `store-python-lifecycle` (kept unit suite) | execution-phase cancel/session-boundary through the REAL chain unproven → **gap → B-LIFE1, B-LIFE2** |
| 11 | `e2e-product-joint` J2 (kept) | product python print + REAL CDN | cross-boundary | present | kept as the positive control; B-PY0 re-proves the boot through the same chain |
| 12 | `e2e-network` (kept, self-contained) | curl approval/deny, direct vs relay legs | cross-boundary (own server hosts the real relay) | present, but its counters never met a python denial | counter-credibility pairing missing → **gap → B-NET1/B-NET1b/B-NET2** (allow control names the dispatch location; loopback write refused pre-dispatch); python deny zero-delta → B-PY1–B-PY12 |
| 13 | `e2e-skill-instances` (kept) | skill-write confirmation (fenced-JSON model fake, shell focus) | cross-boundary | present | python write-back under the wire fake + commit-phase honesty → **gap → B-FS2/B-FS3/B-PY14** |

Not copied on purpose (behaviour already pinned where it lives, and the
B gate adds no value there): runtime-internal lifecycle recovery (row 5),
the browser-authority architecture phases (row 7), the unit-level suites
(`python-authority`/`python-bootstrap-integrity`/`python-plugin-runtime`/
`python-lifecycle` unit files) whose browser equivalents above subsume
them for product purposes, and the TPR wheel-delivery form (row 9; the
pinned harness `pythonExtensionPayload` deliberately carries files-form
payloads only — `validatePluginPayload` is the frozen TPR boundary — so a
wheel cannot flow through the Product composition at this dependency set;
it remains covered by the runtime package's own TPR gates and by B's
storage-adapter suite's REAL fixture wheel validation).

## 4. The new gate

`tests/e2e-m3c-python-integration.cjs` — real headless Chrome, the
CURRENT vite build served by `vite preview`, `?e2e=1&wire=1`. Every
scenario runs the REAL production chain: scripted provider responses →
real store submit → real Harness task runner (prepare→run→settle) → real
Product ToolPort (`createLocusToolPort` + `executeTool`) → real installed
package `RuntimeSession` → real worker/VFS. The only fake is the wire
transport at the model boundary (the product-joint rule). No scenario
calls the package's python implementation directly to stand in for the
product chain.

Test-side infrastructure (production untouched):

- `tests/helpers/m3c-python-servers.cjs` — the pinned-asset server with
  fault modes (`good | down | corrupt:<name>`), the probe/target
  "internet" stand-in whose request counters are the only zero-dispatch
  oracle, the pinned-asset loader (disk cache → one REAL CDN pass,
  recorded), and the document-start fetch patch that RECORDS every
  pinned-CDN URL the product page requests (URL-pinning oracle) and
  serves the bytes locally (the e2e-skill-instances technique, plus
  recording). The corruption happens on the WIRE (one flipped byte,
  exact content-length) — the product's manifest, acquisition and
  verification logic are never modified.
- `tests/fixtures/m3c-python/locus_m3c_plugin.py` and
  `locus_m3c_plugin_broken.py` — the good/broken plugin sources served
  through the documented `registerPluginRuntimeProvider('python', ...)`
  seam (a real wheel loader would implement the same seam).

Scenario blocks (55 assertions): B-SETUP, B-FS1–B-FS4 (filesystem
permission + skill-write confirm/deny/policy-refusal), B-NET1/B-NET1b/
B-NET2 (counter-credibility pair), B-BOOT1/B-BOOT1b–d (integrity negative
at the product + recovery), B-PY0–B-PY14 (recovery boot, the authority
battery, the creator-CSP presence, the python skill-write commit-phase
guard), B-PLG0–B-PLG4 (payload path through the composition, broken
payload, recovery, disabled → core-only), B-LIFE1/B-LIFE2/B-LIFE3
(cancel + session boundary mid-python with state-driven admission
barriers — no fixed sleep proves any timing), B-TOT/B-TOTb/B-TOTc
(whole-suite totals).

Fault/breakage positive controls required by the review: the corrupt-asset
wire injection (B-BOOT1), the broken-plugin payload (B-PLG2) and the
tampered payload key (B-PLG2b) are real fault injections that the gate
must DETECT (assertions on the closed failure, the absent READY, the zero
counters); B-NET1 is the counter-credibility control that makes every
subsequent zero-delta claim meaningful; and the preserved first-failure
logs below show the gate failing loudly when reality deviates from any
expectation.

## 5. Verification evidence

- `npm ci` → `vite build` → **`node tests/e2e-m3c-python-integration.cjs`
  → 55 passed, 0 failed** (run 4, 2026-10-04, warm asset cache; wall
  clock ≈ 3.5 min including the build). Every suite total held: exactly
  ONE probe-server dispatch across the whole gate (the B-NET1 allow
  control), every intercepted asset URL a pinned manifest name, zero page
  errors.
- Real Pyodide CDN record (B-CDN line): run 1 downloaded **8 of 12 assets
  from cdn.jsdelivr.net** (4 disk-cache hits); runs 2–4 were fully served
  from the warmed cache. The CDN was reachable — NOT an environment
  blockage. The bootstrap scenarios themselves run on locally served,
  manifest-verified bytes for determinism; J2 in the product-joint gate
  separately records the REAL in-page CDN download on every run.
- Cold-boot timing observed through the chain: ≈2 s clean boot (warm
  verified cache, local bytes).
- First-failure discipline (all three were TEST-side defects; none was
  asserted away, none was retried into a pass, each fix is in the commit
  trail):
  1. run 1 — 21 checks green (FS/NET/BOOT first-try green), then a gate
     bug (a removed local variable still referenced in `pyDeny`'s return).
     Log preserved as run-1 evidence.
  2. run 2 — the cancelled LIFE1 task left its unused staged response in
     the wire queue and LIFE2's first request consumed it, so LIFE2 never
     reached python (admission barrier timeout, full diagnostics
     preserved). Fix: the fake's scripted queue is now SET per task, not
     appended.
  3. run 3 — one FAIL: B-LIFE2c expected a projected tool result for the
     boundary-struck python call. The harness contract (agent.js native
     batch) DELIBERATELY does not project a tool result that finished
     after a session switch (dead-session ownership; it emits the
     `session_changed` warning instead). The assertion was re-shaped to
     pin that documented behaviour (no fabricated result + explicit
     warning) — an expectation correction against the contract, never a
     lowering: the failure, its cause and the contract citation are in
     the run-3 log.
  4. The in-run cancel warning code was corrected from `task_cancelled`
     to `task_cancelled_committed` BEFORE it could fail a run: the two
     codes mark different cancellation points (prepare-phase vs
     a tool already executed), and the honest-committed semantics is the
     stronger assertion for a mid-execution cancel.

## 6. Registration (integration D)

The gate is orchestrator-compatible and self-contained:

- Standalone: `node tests/e2e-m3c-python-integration.cjs` (builds,
  previews on a free port, drives its own Chrome).
- Orchestrator: add one entry to `SUITES` in `tests/run-browser-gates.cjs`:

  ```
  'e2e-m3c-python-integration.cjs',
  ```

  The gate honours `E2E_APP_URL` when the orchestrator provides the
  shared preview (same contract as `e2e-product-joint`), so registration
  needs NO orchestrator change beyond the SUITES entry and no second
  build.

**No production seam and no build input are required.** All injection
goes through existing, documented test seams: `?e2e=1&wire=1`,
`window.__locusWire`, `capabilityComposition.injectTestCatalog`,
`capabilityComposition.registerPluginRuntimeProvider`,
`capabilityComposition.enable/disable`, `actions.resolveApproval/
denyApproval/cancelTask/newTask`, `pythonRuntime()`, and the
document-start fetch patch (test-side interception; no production file
reads or behaves differently under the gate).

## 7. Residuals / not verified here (explicit)

- **Relay-leg positive control.** Cross-origin POST/PUT chooses the edge
  relay (`/fetch` on the app origin) BEFORE dispatch; the plain
  `vite preview` server has no `/fetch` route, so a relay-leg allow
  control cannot run against the packaged preview page, and this gate
  does not claim one. The python-side zero-dispatch claims do NOT depend
  on the relay leg (the worker's only possible dispatch locations are
  the direct browser primitives, all counter-observed; its CSP sets
  `connect-src 'none'`), and the shell write-path refusal (B-NET2) is
  proven pre-dispatch with the counter made credible by B-NET1. The
  relay leg itself stays covered by the kept self-contained
  `e2e-network` suite (real relay handler, N2/N4 legs). If D wants a
  relay positive control INSIDE this gate, the requirement is an
  orchestrator-level `/fetch` middleware on the preview server (a build/
  orchestrator input, deliberately not improvised here).
- **Wheel-form payloads through the composition.** The pinned harness's
  `validatePluginPayload` accepts files-form payloads only (frozen TPR
  boundary), so the B gate drives the provider seam with real plugin
  SOURCES; verified-wheel artifact delivery remains runtime-boundary
  coverage (runtime TPR gates + the storage-adapter suite's REAL fixture
  wheel). If the composition ever grows wheel payloads, B-PLG's
  fixture/provider pair is where the browser negative belongs.
- **Runtime-internal lifecycle recovery** (reset/crash re-lockdown,
  E11/E12/E18-after-recovery) is intentionally not re-driven through the
  product page; it is pinned by the runtime package's own gates at the
  fixed SHA, and the product adds no logic on that path.
- **This branch does not update PR #5, does not merge, does not deploy,
  and does not enter M4**; the fixed dependency SHAs stay exactly as
  locked.
