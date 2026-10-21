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
- B-PY1 evidence — PR #32 CI, 2026-10-20（排查记录：[PR #32 评论](https://github.com/boccchi2993/locus-product/pull/32#issuecomment-6292116159)）。PR 分支的 browser gates 在 `e2e-m3c-python-integration` 的 B-PY1 上失败两次，同签名 `fail:true, delta:0`，输出为 Pyodide traceback 而非拒绝标记：
  - 首次运行：[run 39421135018 attempt 1](https://github.com/boccchi2993/locus-product/actions/runs/39421135018/attempts/1)，2026-10-20 12:17 UTC，head `75a4e82dffb0445d128638cddeafdd17f3d94827`，失败检查 `B-PY1 python js.fetch denied at the policy layer with the marker`（job `browser gates (packaged build, headless Chrome)`），`delta=0`（发出的请求数为 0），缺失标记 `Python network access is disabled in Locus`。
  - 第一次重跑：[run 39421135018 attempt 2](https://github.com/boccchi2993/locus-product/actions/runs/39421135018/attempts/2)，2026-10-20 12:24 UTC，head `75a4e82dffb0445d128638cddeafdd17f3d94827`，失败检查 `B-PY1 python js.fetch denied at the policy layer with the marker`，`delta=0`（发出的请求数为 0），缺失标记 `Python network access is disabled in Locus`。
  - 这两次失败之后又重跑了一次才变绿：[run 39421135018 attempt 3](https://github.com/boccchi2993/locus-product/actions/runs/39421135018/attempts/3)（2026-10-20 13:34 UTC）browser gates 全绿。按仓库规则，CI 失败不应重跑，这一次违反了规则。
  - 探针判别（5 个探针分支，均已删除，数据留存如下）：
    - main 纯净代码：[run 39423289712](https://github.com/boccchi2993/locus-product/actions/runs/39423289712)（2026-10-20 12:34 UTC，head `072af914723a35f59e88b3cfc20d4b5633152202`），无任何改动，gates 全绿。
    - main + 仅升级依赖：[run 39424666946](https://github.com/boccchi2993/locus-product/actions/runs/39424666946)（2026-10-20 12:44 UTC，head `e4d0f74a3495735a1c9a7ee5a3149abc6889bbe1`），runtime #7 + harness #12 依赖升级、无 product 改动，gates 全绿。
    - 完整 C3 改动 + main 版 e2e 文件：[run 39425933985](https://github.com/boccchi2993/locus-product/actions/runs/39425933985)（2026-10-20 12:54 UTC，head `0730b816daa4ab733c076e4b228aa08697b87f87`），失败：B-SETUP（断言 disabled，与 O1 首次安装自动启用冲突，预期内）、B-PY2（空输出）。
    - 回退 commit 自动启用特性、其余 C3 全保留：[run 39428638859](https://github.com/boccchi2993/locus-product/actions/runs/39428638859)（2026-10-20 13:13 UTC，head `e06e1b01d43909945e140dd3e87cdf204cbe381f`），仅 B-SETUP/SI0 的 O1 断言预期失败，B-PY1 通过。
    - 本分支 + 一行诊断打印（与本 PR 代码完全一致）：[run 39430093983](https://github.com/boccchi2993/locus-product/actions/runs/39430093983)（2026-10-20 13:24 UTC，head `7903d5076c826f0bcd4e226960f26a381953eb1d`），17 gates 全绿、B-PY1 通过——同一代码第三次 CI 运行全绿。
  - 待查假设（2026-10-22 审查）：PR #32 让 e2e-m3c-python-integration 在 B-SETUP 之后新增了一次 enable → disable（首次安装自动启用，再恢复为停用前提），紧接着的第一个 python 任务就是 B-PY1。如果 B-PY1 的抖动和 worker 重启后的第一次运行有关，这次改动可能提高了失败概率。验证办法：在不改断言的前提下，统计 main 上 B-PY1 的失败率（例如手动触发 10 次 browser gates），和 #32 合并前的历史对比。

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
- [x] 该 PR 合并后手动触发一次 core-main-candidate（source=main），转绿后在此处打勾并附 run 链接 — 绿：[run 39039496986](https://github.com/boccchi2993/locus-product/actions/runs/39039496986)（2026-10-17 手动触发；candidate 元组 product `453789d0` × runtime `9e2ee039` × harness `d812869e`，apply/build/unit/browser 各阶段全过）

## Completion discipline

Close each item only with a fixing commit, a regression test and actual verification
results. Preserve first failures and distinguish new runs from historical evidence;
do not use retries or relaxed assertions to manufacture success.

The verified M4b tuple and candidate artifact remain documented in
[the mainline verification record](docs/M4B-MAINLINE-VERIFICATION.md). Future
compatibility requires a fresh candidate result for the precise tuple.
