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
- B-PY1 evidence — push CI [run 39000494789](https://github.com/boccchi2993/locus-product/actions/runs/39000494789)
  (product commit `ff182d2`, the PR #25 merge), browser gates job: the only
  failure was `B-PY1 python js.fetch denied at the policy layer with the marker`
  (`e2e-m3c-python-integration: 54 passed, 1 failed`). In the same run
  `B-PY1b js.fetch produced ZERO requests to the probe (counter oracle)` and
  `B-PY2` both PASS, and the FAIL payload itself carries `"delta":0`: no request
  was issued — only the observable form of the denial (the marker) mismatched.
  Failure output (`gh run view 39000494789 --log-failed`; the gate truncates the
  captured stdout mid-traceback, so the traceback is embedded and cut short):
  ```
  FAIL B-PY1 python js.fetch denied at the policy layer with the marker | {"fail":true,"delta":0,"out":"Traceback (most recent call last):\n  File \"/lib/python312.zip/_pyodide/_base.py\", line 597, in eval_code_async\n    await CodeRunner(\n  File \"/lib/python312.zip/_pyodide/_base.py\", line 411, in run_async\n    coroutine = eval(self.code, globals, locals)\n
  ```
  The next mainline commit `59de0b0`'s push CI
  ([run 39001073229](https://github.com/boccchi2993/locus-product/actions/runs/39001073229))
  passed the same suite in full (B-PY1 PASS). Not rerun; root cause unknown.
  This belongs to the Python E3/B-PY1 family above and is not a CDP readiness
  (RT-CI-001) failure.

## 3. core-main-candidate red since 2026-10-17

- [ ] **CANDIDATE-RED-2026-10-17** — first failure: scheduled
  [run 39015719643](https://github.com/boccchi2993/locus-product/actions/runs/39015719643)
  (2026-10-17 08:00 UTC, product commit 59de0b0, 33s total; previous green was
  the manual [run 38924363605](https://github.com/boccchi2993/locus-product/actions/runs/38924363605)
  on 2026-10-16).
- Captured cores (artifact `core-main-candidate-39015719643`): runtime
  `a1921cf` (unchanged from the package.json lock), harness `d812869` (the lock
  is `2a04c79`; harness main advanced through harness PR #11).
- First failing step: #8 "build the packaged page on the candidate cores".
  Steps #9 (unit battery) and #10 (browser gates) fail on the same root cause.
- Error summary:
  - step 8/10, vite build: `src/main.js (28:30): "registerPluginRuntimeProvider" is not exported by "src/product/harness-api.js", imported by "src/main.js".`
  - step 9, unit battery: `TEST RUNNER FAIL TypeError: M.registerPluginRuntimeProvider is not a function` at `tests/capability-composition.test.cjs:180`.
- Classification: (a) expected core-interface incompatibility — not
  environment, network, npm install, or CDP startup. The candidate applied
  harness main `d812869`, whose PR #11 removed the `registerPluginRuntimeProvider`
  export, while Product `src/main.js` still imports it; the rollup import error
  above is the recorded signal. Distinct from the historical scheduled failure
  [run 38873796405](https://github.com/boccchi2993/locus-product/actions/runs/38873796405)
  (2026-10-16, max_tokens probe assertion I-E18, already fixed).
- Expected fix: Product PR `feat/wheel-only-migration` (C1-L-P).
- [ ] 该 PR 合并后手动触发一次 core-main-candidate（source=main），转绿后在此处打勾并附 run 链接

## Completion discipline

Close each item only with a fixing commit, a regression test and actual verification
results. Preserve first failures and distinguish new runs from historical evidence;
do not use retries or relaxed assertions to manufacture success.

The verified M4b tuple and candidate artifact remain documented in
[the mainline verification record](docs/M4B-MAINLINE-VERIFICATION.md). Future
compatibility requires a fresh candidate result for the precise tuple.
