# locus-product

Locus Product is the application repository: Vue UI, browser storage, user
configuration, capability catalogs, and adapters that compose the independent
[locus-runtime](https://github.com/boccchi2993/locus-runtime) and
[locus-harness](https://github.com/boccchi2993/locus-harness) packages.

## Current status

**The M0–M4 repository split is complete and landed on all three main branches.**
Runtime and Harness PR #1, Product integration PR #5, candidate/rollout PR #9,
and dependency-pins PR #12 have merged. This repository is the authoritative
Product implementation; the original monorepo remains historical provenance.

Production imports enter through `src/product/runtime-api.js` and
`src/product/harness-api.js`. Product owns compatibility checks and adapters;
it does not maintain duplicate implementations of either core.

## Verified dependency combination

The first verified mainline combination captured on 2026-10-06 is:

| Component | Exact commit |
| --- | --- |
| Product tested main baseline | `18e3c76d6f2d38770997324c434b14ba319bf8ff` |
| Runtime dependency | `45bc935af91dbf5ea6c1078a939c0589853a50a8` |
| Harness dependency | `5ce67052be3820f607835dd8fd3df373c814ab9c` |

The Product SHA above identifies the tested baseline, not subsequent documentation
commits. `package.json` and `package-lock.json` pin the cores to full SHAs.
This is evidence for that exact combination, not a promise that future main commits
are compatible.

The default-branch candidate workflow was actually executed on GitHub:
[run 37465158293](https://github.com/boccchi2993/locus-product/actions/runs/37465158293).
Capture, install, build, unit and browser stages passed; the captured core heads
had not advanced at the final check. Full provenance, first failures and limitations:
[docs/M4B-MAINLINE-VERIFICATION.md](docs/M4B-MAINLINE-VERIFICATION.md).

## Development

```bash
npm ci
npm run build
npm test
node tests/run-browser-gates.cjs
```

Build before testing: some gates inspect packaged output. The closeout baseline
has 31 unit suites and 16 browser gates. Browser gates require Chrome and exercise
the built Product against fake models. Python gates may download the real,
hash-pinned Pyodide assets; they do not require model keys.

## Following core main branches

The scheduled/manual candidate workflow captures an exact Product/Runtime/Harness
tuple and validates it in an isolated checkout. It records results and advancement
as artifacts; it does not automatically adopt new pins or merge an update.

Promote a passing tuple through a dependency update with exact manifest/lockfile
pins and integration evidence. For rollback, commit the last verified dependency
pair and lockfile again and validate it; do not rewrite main history or imply that
a dependency rollback rolls back user storage.

## Documentation and maintenance

- [Integration record](docs/M3C-D-INTEGRATION.md)
- [Candidate mechanism and rollout](docs/M4A-INTEGRATION.md)
- [Mainline verification](docs/M4B-MAINLINE-VERIFICATION.md)
- [Interface contracts](docs/REPOSITORY-SPLIT-CONTRACTS.md)
- [Ownership inventory](docs/REPOSITORY-SPLIT-INVENTORY.md)
- [Open maintenance TODO](TODO.md)

Historical phase reports describe their recorded commits and may mention branches
or PRs that were open at the time. Current split status is stated above. Known
test-infrastructure failures remain open maintenance work; split completion is not
a claim that every historical CI run was green.

No npm publication or deployment was performed as part of the split.

License: Apache-2.0; see [LICENSE](LICENSE).
