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


### B-PY1 diagnostic evidence appended 2026-10-22 (no resolution)

Dates below are UTC (not the investigation host's clock). Downloaded full job
logs preserve only the following 300-character verdict prefix: the test itself
calls `JSON.stringify(verdict).slice(0, 300)` before logging. Neither downloading
full logs nor `--log-failed` can recover bytes never emitted. The exception type
and final traceback line are **unavailable**, not inferred to be SystemError.

- [39000494789, attempt 1](https://github.com/boccchi2993/locus-product/actions/runs/39000494789/attempts/1), head `ff182d2f8e03952d8e65cd25e1e64ed8564da813`, failure 2026-10-17 03:55:49 UTC, delta=0, exception type unavailable, final line unavailable (source truncation).
- [39421135018, attempt 1](https://github.com/boccchi2993/locus-product/actions/runs/39421135018/attempts/1), head `75a4e82dffb0445d128638cddeafdd17f3d94827`, failure 2026-10-20 12:19:56 UTC, delta=0, exception type unavailable, final line unavailable (source truncation).
- [39421135018, attempt 2](https://github.com/boccchi2993/locus-product/actions/runs/39421135018/attempts/2), head `75a4e82dffb0445d128638cddeafdd17f3d94827`, failure 2026-10-20 12:25:46 UTC, delta=0, exception type unavailable, final line unavailable (source truncation).
- [39637621125, attempt 1](https://github.com/boccchi2993/locus-product/actions/runs/39637621125/attempts/1), head `911f038f740aaf52ccd2bfb7c9924ebd6e90aede`, failure 2026-10-21 16:48:10 UTC, delta=0, exception type unavailable, final line unavailable (source truncation).

All four emitted prefixes are byte-identical after the log timestamp/label is
removed; this does NOT establish that their full tracebacks are identical.
B-PY1b passed in all four, establishing zero probe requests, not which rejection
path produced the error. PR #32's browser gates were rerun again after two
failures and became green only on [attempt 3](https://github.com/boccchi2993/locus-product/actions/runs/39421135018/attempts/3)
(started 2026-10-20 13:34:22 UTC, unchanged head `75a4e82`). This violated the
“CI 失败不重跑” rule; the green attempt does not supersede either failure.

待查假设：PR #32 在 B-SETUP 之后新增了一次“自动启用 → 立即停用”（tests/e2e-m3c-python-integration.cjs 第 322–328 行左右），会让 Python worker 多重启一次，而紧接着的第一个 Python 任务就是 B-PY1。如果 traceback 和 worker 重启后的第一次运行有关，这次改动可能提高了失败概率。

Independent check of that hypothesis: the install/disable sequence is present,
but the statement that B-PY1 is the first Python task is not supported. The
suite first executes B-BOOT1's corrupted bootstrap, then B-PY0's successful
recovery Python task (`print('M3C-B-PY-OK', 2 + 2)`), then B-PY1. All four failed
job logs explicitly report B-PY0 PASS. A worker restart between B-PY0 and B-PY1
has not been measured. Failure predates PR #32; any frequency effect of the
new sequence remains unmeasured. Root cause: **cannot determine**.

Prior diagnostic PR #33 is separate evidence: [run 39425819532](https://github.com/boccchi2993/locus-product/actions/runs/39425819532),
head `2d14ee3b740581a82fdd3f28731929c401204c50`, 2026-10-20, emitted an untruncated
B-PY1 verdict with `fail=true`, `delta=0`, `marker=true`. Its exception was
`pyodide.ffi.JsException: Error: Python network access is disabled in Locus; use the shell curl command for HTTP/HTTPS`.
B-PY1 passed in that run; the run failed in e2e-ui CDP readiness. This passing
traceback must NOT be substituted for any of the four missing failure tails.

Local A/B/C experiment status (2026-10-22): BLOCKED before the first browser run.
No executable Chrome/Chromium is installed or available on PATH in this host;
only Playwright library code and shell completion files were found. Per the
requested stop condition, no installation workaround, browser repetitions, or
CI experiment loop was attempted in this round. A (`911f038`): 0/10 executed,
pass rate N/A, failure traceback types N/A. B (`072af91`): 0/10 executed, pass
rate N/A, types N/A. C: not performed (A/B comparison unavailable); no local
warm-up change made. No inference about relative failure probability is possible.

> **临时例外（所有者 2026-10-23 批准，修复合并后失效）**：browser gate 中 B-PY1（product）/ E3（runtime）检查失败时，如果同时满足以下三条，允许重跑**一次**：
> 1. 失败输出中的异常正好是 `SystemError: error return without exception set`（product 看 `DIAG B-PY1 FULL` 行）；
> 2. 同一次运行中零请求的检查（B-PY1b / E3b）通过，即探针请求数为 0；
> 3. 该次运行中没有任何其他检查失败。
> 重跑前，必须先在这里追加一行：失败 run 的链接、head SHA、日期、DIAG 原文的最后一行。重跑后再追加结果。重跑仍失败，或任一条件不满足，照常停下来报告，不得再次重跑。
> 背景：2026-10-23 本机实验，PR #32 前后各 10 次，各失败 1 次，异常均为上述 SystemError，探针 0 请求；根因在 runtime 的 Pyodide 桥接层，调查中（RT-D3）。

### 追记 2026-10-30：PR #49 / PR #52 的修复与 B-PY1 的区分

- 2026-10-30：PR #52（CI-STAB，合并提交 a70c301）修复了 Chrome 就绪与端口冲突问题：
  `tests/helpers/chrome.cjs` 改为 `--remote-debugging-port=0` + 读取 DevToolsActivePort、
  就绪等待 60 秒、服务端口 EADDRINUSE 重试（同 runtime TODO RT-CI-001 下 2026-10-30 追记）。
  harness TODO 中 2026-10-16 的证据显示 Chrome 在启动后约 10–15 秒才打印 DevTools 监听行，
  与 15 秒就绪超时吻合。
- 2026-10-30：PR #49（FIX-IR1）修复了 IR-G3 同秒报告排序问题；PR #52 修复了服务端口
  EADDRINUSE。这两类（IR-G3 排序、EADDRINUSE）不属于 B-PY1。

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

## 2026-10-30 新增条目

以下条目为 2026-10-30 TODO 同步新增；跨仓库总索引见文末「2026-10-30 待办索引」。

- [ ] **C3-P2（product）：能力内 MCP**
  - 现状：待实现。设计依据：docs/C3-CREDENTIALS-MCP.md 与 DECISIONS.md D4；形态为
    `mcp` shell 命令，先 bearer、后 OAuth。
  - 下一步：按上述设计实现 `mcp` shell 命令。
  - 验收：待确认。
- [ ] **SEC-E2E-SEAM（product）：`?e2e=1` 测试接缝安全审查**
  - 现状：`?e2e=1` 测试接缝在生产包中可用（部署冒烟就用它跑过）；脚本化回复应为
    固定内容，未核实。
  - 下一步：核实脚本化回复是否为固定内容；列入安全审查（见 SEC-REVIEW）。
  - 验收：待确认。
- [ ] **SEC-REVIEW（product）：整体安全审查**
  - 现状：待做；范围含 `?e2e=1` 接缝（SEC-E2E-SEAM）、凭据、导入流程。
  - 下一步：执行整体安全审查。
  - 验收：待确认。
- [ ] **MOBILE-REAL（product）：真机验证**
  - 现状：2026-10-29 Chromium 设备模拟检查（412×915、390×844）核心链路可用；
    iOS Safari 真引擎的内存与 WebAssembly 限制、真实软键盘行为只能真机确认。
  - 下一步：待所有者真机测试。
  - 验收：真机上核心链路可用（待确认）。
- [ ] **CACHE-CTRL（product）：Anthropic 方言显式 cache_control**
  - 现状：Anthropic 方言下显式 cache_control 标记待做；@ 点名说明已设计为不破坏
    提示词缓存（PR #51），但缓存是否实际命中未验证。
  - 下一步：实现 Anthropic 方言下的显式 cache_control 标记；验证缓存是否实际命中。
  - 验收：待确认。
- [ ] **CROSS-CAP-DIST（product）：同发行包多 plugin id 的注册提示**
  - 现状：不同 plugin id 携带同一发行包时，先启用者生效、后者静默跳过
    （DECISIONS.md D14 第 5 条）；当前由 capability-authoring 规避。
  - 下一步：将来可考虑在注册/启用时提示。
  - 验收：待确认。
- [ ] **SCREENSHOTS-C3（product）：旧 c3 截图清理决策**
  - 现状：仓库中存在旧的 docs/screenshots/c3-*.png；gate 已不再写入仓库（PR #51）。
    是否清理待所有者决定。
  - 下一步：等所有者决定后清理或保留。
  - 验收：待确认。
- [ ] **UX-BACKLOG（product）：UX 积压**
  - 现状：待做项：设置中「作为依赖安装的插件」的角色展示；对话删除界面；附件清理
    （GC）；npm audit；终端（菜单入口已在 PR #48 移除，代码保留）。
  - 下一步：逐项排期实现。
  - 验收：待确认（逐项）。
- [ ] **MILESTONE-V1（product）：里程碑**
  - 现状：待做：REAL-WORLD-50 真实任务基准；SDK README 与演示；v1 tag。
  - 下一步：完成上述三项。
  - 验收：待确认。
- [ ] **CI-NODE24（product）：GitHub Actions "Node.js 20 is deprecated" 警告**
  - 现状：同 harness HN-CI-NODE24：CI 每次运行都有 "Node.js 20 is deprecated"
    警告（actions/checkout@v4、actions/setup-node@v4、actions/upload-artifact@v4
    被强制以 Node 24 运行）。
  - 下一步：升级 product 自己的 workflow 所用 action 版本。
  - 验收：CI 运行不再出现该 deprecation 警告。

## 2026-10-30 待办索引

各条目正文在负责仓库的 TODO.md 中：

- runtime（[TODO.md](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md)）：
  - [RT-SYNC-INC 增量同步](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md#2026-10-30-新增条目)
  - [RT-SYNC-LIMIT 单文件同步上限 16 MiB](https://github.com/boccchi2993/locus-runtime/blob/main/TODO.md#2026-10-30-新增条目)
- harness（[TODO.md](https://github.com/boccchi2993/locus-harness/blob/main/TODO.md)）：
  - [HN-CI-NODE24 Node 20 deprecation 警告](https://github.com/boccchi2993/locus-harness/blob/main/TODO.md#2026-10-30-新增条目)
- example-capabilities（[TODO.md](https://github.com/boccchi2993/locus-example-capabilities/blob/main/TODO.md)）：
  - [CA-1.1.0 capability-authoring 1.1.0](https://github.com/boccchi2993/locus-example-capabilities/blob/main/TODO.md#2026-10-30-新增条目)
  - [CAP-GROUP2 第二批官方能力](https://github.com/boccchi2993/locus-example-capabilities/blob/main/TODO.md#2026-10-30-新增条目)
  - [deepseek-web 发布状态](https://github.com/boccchi2993/locus-example-capabilities/blob/main/TODO.md#2026-10-30-新增条目)
  - [VW2 反例测试修正](https://github.com/boccchi2993/locus-example-capabilities/blob/main/TODO.md#2026-10-30-新增条目)
- product（本文件）：
  - [C3-P2 能力内 MCP](#2026-10-30-新增条目)
  - [SEC-E2E-SEAM `?e2e=1` 接缝安全审查](#2026-10-30-新增条目)
  - [SEC-REVIEW 整体安全审查](#2026-10-30-新增条目)
  - [MOBILE-REAL 真机验证](#2026-10-30-新增条目)
  - [CACHE-CTRL 显式 cache_control](#2026-10-30-新增条目)
  - [CROSS-CAP-DIST 同发行包多 plugin id 提示](#2026-10-30-新增条目)
  - [SCREENSHOTS-C3 旧 c3 截图清理决策](#2026-10-30-新增条目)
  - [UX-BACKLOG UX 积压](#2026-10-30-新增条目)
  - [MILESTONE-V1 里程碑](#2026-10-30-新增条目)
  - [CI-NODE24 Node 20 deprecation 警告](#2026-10-30-新增条目)
