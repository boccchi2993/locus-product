# locus-product

Locus Product — the application repository of the three-repository Locus
split: Vue 3 presentation, browser storage, user configuration, capability
catalogs, and the integration adapters that compose `locus-runtime` and
`locus-harness` into the shipped product.

## Branch `refactor/m3c-integration`: the M3c switch, verified (M3c-D)

This branch completes the three-repository switch: the product page is ONE
ESM entry over the two installed cores; the in-repo duplicate
implementations are deleted; production core imports enter only through
`src/product/{runtime-api,harness-api}.js`.

This is a **verified set of candidate SHAs, locked through the lockfile**
— NOT a claim that the cores' latest main is compatible:

- source snapshot `2aec76e78431382873be1db8a6db6310cc89c782`
- locus-runtime `2435a57ff7a66db3db88aa98a88d404c75133483` (PR #1 OPEN)
- locus-harness `347eed99a415dc080b97d46d8a4271ceb19c5142` (PR #1 OPEN)

Integration record + verification evidence:
[docs/M3C-D-INTEGRATION.md](docs/M3C-D-INTEGRATION.md). The base and
agent PRs (#1–#4) stay OPEN until M3c closeout; nothing is merged,
published or deployed here.

Verification on this branch (local AND clean checkout): `npm ci` →
`npm run build` → `npm test` (24/24 suites) → `node
tests/run-browser-gates.cjs` (14/14 packaged-build browser gates in real
Chrome). CI runs the same gates from a from-scratch checkout.

## This branch: `refactor/m3c-base` (M3c-0 common baseline)

This branch is the common baseline for the parallel M3c switch agents
(A/B/C) and the integration agent (D). It contains:

1. The verbatim source snapshot of the product code, imported from
   [boccchi2993/Locus-browser-agent-runtime](https://github.com/boccchi2993/Locus-browser-agent-runtime)
   @ `2aec76e78431382873be1db8a6db6310cc89c782` (branch
   `refactor/repository-split-m2c`, head of OPEN PR #7) — source code and
   tests kept as the pre-switch baseline. NOT imported: `node_modules`,
   `dist`, logs, secrets, `.git`. The import switch itself is intentionally
   NOT implemented on this branch.
2. The two pinned core dependencies in `package.json` (GitHub git
   dependencies, locked to full commit SHAs, real `package-lock.json`):
   - `locus-runtime` @ `2435a57ff7a66db3db88aa98a88d404c75133483`
     ([locus-runtime PR #1](https://github.com/boccchi2993/locus-runtime/pull/1))
   - `locus-harness` @ `347eed99a415dc080b97d46d8a4271ceb19c5142`
     ([locus-harness PR #1](https://github.com/boccchi2993/locus-harness/pull/1))
3. `docs/M3C-PARALLEL-HANDOFF.md` — the shared interface contract
   (`src/product/runtime-api.js`, `src/product/harness-api.js`), the ESM
   conversion rules for the classic files, and the per-agent file
   ownership map.

A/B/C must all branch from this branch's head (M3C_BASE_SHA, recorded in
the handoff document and in the base PR); they never stack on each other.

Until the switch lands and is verified, the source repository remains the
authoritative product implementation.

License: Apache-2.0 (see [LICENSE](LICENSE)).
