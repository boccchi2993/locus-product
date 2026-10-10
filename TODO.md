# Maintenance TODO

M0–M4 repository splitting is complete. The two remaining closeout items are
tracked by their owning repositories; this page is the Product index.

## 1. Harness browser-driver false success

- [ ] **HN-TEST-001** — [canonical task and acceptance criteria](https://github.com/boccchi2993/locus-harness/blob/main/TODO.md).
- Owner: Harness. `tests/e2e.cjs` maps a signal-terminated child with null exit
  status to success via `gate.status || 0`. The closeout review reproduced this
  with the actual orchestrator and a controlled SIGTERM child result.
- After the core fix, validate a new exact dependency combination before updating
  Product pins. Do not silently reclassify old fully observed assertion runs.

## 2. Intermittent browser/CDP startup failures

- [ ] **RT-CI-001** — [canonical investigation and acceptance criteria](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md).
- Owner: Runtime browser-test infrastructure initially; coordinate cross-repo
  changes only when diagnosis supports them.
- Product evidence includes [failed run 37355773953](https://github.com/boccchi2993/locus-product/actions/runs/37355773953)
  and [passing sibling 37355783370](https://github.com/boccchi2993/locus-product/actions/runs/37355783370).
  Preserve both; a green sibling/rerun does not identify an environment cause or
  exclude a regression.
- Root cause remains unknown. Historical Python E3/B-PY1 errors remain separately
  documented and must not be conflated with CDP readiness failures.

## Completion discipline

Close each item only with a fixing commit, a regression test and actual verification
results. Preserve first failures and distinguish new runs from historical evidence;
do not use retries or relaxed assertions to manufacture success.

The verified M4b tuple and candidate artifact remain documented in
[the mainline verification record](docs/M4B-MAINLINE-VERIFICATION.md). Future
compatibility requires a fresh candidate result for the precise tuple.
