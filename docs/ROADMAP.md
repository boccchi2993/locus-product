# Locus 路线图与时间表

状态基准：2026-11-07。所有者批准后生效；每完成一项在本文件勾选并注明 PR / 提交，时间表按实际进度滚动调整。
细节条目以各仓库 TODO.md 为准（product 的 TODO.md 末尾有跨仓库索引），本文件只管顺序、依赖与目标时间。

仓库：
[locus-product](https://github.com/boccchi2993/locus-product) ·
[locus-runtime](https://github.com/boccchi2993/locus-runtime) ·
[locus-harness](https://github.com/boccchi2993/locus-harness) ·
[locus-example-capabilities](https://github.com/boccchi2993/locus-example-capabilities)

## 0. 当前位置（2026-11-07）

| 仓库 | main | 已合并、未上线 | 打开中的 PR |
| --- | --- | --- | --- |
| product | 74c5247 | #55 渲染与文件卡片、#56 任务上限设置（含 runtime #13 / harness #15）；线上 stable 仍为 5b8ee4e | #57 Actions 升级到 Node 24 |
| runtime | 8ba62f5 | #12 16 MiB、#13 shell 补缺（已随 product #56 锁定） | #14 CI-PORT（Chrome 就绪修复移植） |
| harness | bdb10db | #15 可配置任务上限 | #16 CI-PORT（consumer） |
| example | e3c3d88 | #9 SDK 1.2.0 | #10 capability-authoring 1.1（SKILL） |

已发布：charts@1.0.0、capability-authoring@1.0.0、deepseek-web@1.0.0（pre-release）。
C5 自举验收已在安卓真机通过（2026-10-31，text-metrics）。

## 时间表总览

| 阶段 | 目标时间 | 内容 | 依赖 |
| --- | --- | --- | --- |
| 1 收尾 | 11-07 ～ 11-14 | 部署当前 main、发布 capability-authoring 1.1.0、合并 CI-PORT | 无 |
| 2 Word 演示与视频 | 11-14 ～ 11-28 | 彩排 Word 自构建、修 SKILL 1.1.x、（可选）官方 word 能力、录制视频 | 阶段 1 |
| 3 稳固性 | 11-14 ～ 12-12（穿插） | B-PY1 根因、RT-CI-001 关单、安全审查、iOS 真机、示例仓库小账 | 无（与阶段 2 并行） |
| 4A 增量同步 | 12-01 ～ 12-26 | 设计 → 实现 → 放宽上限 → 部署 → iOS 复测 | 阶段 2 完成 |
| 4B 能力内 MCP | 12-01 ～ 2027-01-23 | 第二阶段设计 → bearer → 示例 MCP 能力 → OAuth | 设计与 bearer 实现不依赖阶段 2，可与 Word 彩排、4A 并行；SKILL 增加编写 MCP 的流程排在 Word 彩排之后 |
| 4C 第二批官方能力 | 11-28 ～ 2027-01-09 | word、excel 先行，然后 pdf、pptx、image | 阶段 1（SDK 1.2.0 已具备） |
| 5 打磨与 v1 | 2027-01-04 ～ 02-06 | 体验积压、cache_control、REAL-WORLD-50、文档与演示、v1 tag | 4A、4B 的 bearer 部分、4C 的 word/excel |

时间是目标而非承诺；每周日回看一次，按实际进度顺延。

---

## 阶段 1：收尾（11-07 ～ 11-14）

- [ ] **审查并合并 CI-PORT**：runtime #14、harness #16、product #57。三个仓库互不依赖，可同时合并。合并后 main 上 push CI 恢复全绿、不再出现 “Node.js 20 is deprecated” 警告。
- [ ] **DEPLOY-5**：部署 product main（≥ 74c5247）。冒烟：`ls -R`、`cat > f <<'EOF'`、`sed -n`、traceback 去噪；代码块 / 表格 / 外链 / `sandbox:` 文件卡片与 Import；设置中工具调用上限 128、工具结果上限 40000、输出上限 32768；390×844 无横向滚动。
- [ ] **REL-CA-1.1**（DEPLOY-5 之后）：合并 example #10，发布 capability-authoring@1.1.0。必须在部署之后，因为新 SKILL 依赖文件卡片、“继续”、新 shell 命令。
- [ ] **所有者**：设置中把“单次回复输出上限”改为 32768（已保存的旧值不随默认值变化），导入 capability-authoring 1.1.0。

## 阶段 2：Word 演示与视频（11-14 ～ 11-28）

- [ ] **彩排**：新对话 `@capability-authoring 帮我做一个能生成 Word 文档的能力`。检查点：
  1. 自己查 PyPI JSON 与 Pyodide 0.26.4 的 pyodide-lock.json，用 `curl -o` 下载 python-docx、lxml、typing_extensions；
  2. `verify_wheel` 通过后才用，`plugin_from_wheel` 生成插件，依赖在前；
  3. 6 MiB 的 lxml 在 Python 中可见（16 MiB 上限），`test_site` 后 import 成功；
  4. validate → build → inspect，用 `sandbox:` 文件卡片交付，用户点 Import；
  5. 下一个任务用新能力生成的 `.docx` 能在 Word / WPS / LibreOffice 打开。
- [ ] **按彩排结果修 SKILL，发布 1.1.x**（预计 2～3 轮；每轮的失败截图 → 修复 PR → 发布 → 再彩排）。
- [ ] **（可选）官方 word 能力**：用 `plugin_from_wheel` 的规范描述符，与模型自建的组件逐字节相同、可共存（D14 第 5 条）。视频中可对照展示“Locus 自己做的”与“官方开箱的”。
- [ ] **录制视频**：脚本先行；API key 不入画；导入的那一下点击作为“信任关口”来讲；彩排稳定后再录。
- 与 4B（能力内 MCP）的先后（2026-11-26 修订）：4B 的设计和 bearer 实现不等待本阶段，可以并行。本阶段的 SKILL 修复稳定之后，4B 再往 SKILL 里加编写 MCP 能力的流程。

## 阶段 3：稳固性（11-14 ～ 12-12，与阶段 2 并行穿插）

- [ ] **B-PY1 / E3 根因**（runtime）：确认 RT-D3（Proxy 与普通函数对比）实验是否执行过，没有就重新执行；按结论修复；删除 product TODO §2 与 runtime TODO 中的临时重跑例外。
- [ ] **RT-CI-001 关单**：CI-PORT 合并后观察两周，三个仓库都未再出现 CDP 就绪超时，由所有者决定关单。
- [ ] **安全审查 SEC-REVIEW**（交给未参与开发的 agent，只读、只出报告）：`?e2e=1` 测试接缝在生产包中的行为、凭据注入与脱敏、导入流程、markdown / 链接渲染（XSS）、`sandbox:` 路径校验、sed `-i` 与 heredoc 的写入边界、edge relay。按严重程度逐项出修复 PR。
- [ ] **MOBILE-REAL**：安卓已验证；iOS Safari 真机测两次——现在一次、增量同步之后一次。
- [ ] **示例仓库小账**：wheel 平台规则改用 runtime 导出（PYODIDE_VERSION / PYTHON_ABI / PYTHON_RUNTIME_PACKAGES / wheelPlatformCompatible / normalizeDistName）；VW2 反例只因预期原因失败；deepseek-web 由所有者实测后以 store 格式重新发布为正式版。
- [ ] **SCREENSHOTS-C3**：所有者决定是否清理旧的 docs/screenshots/c3-*.png。

## 阶段 4A：增量同步（runtime，12-01 ～ 12-26）

输入：2026-10-30 SPIKE-SYNC 实验结论；runtime #12 基线（/tmp 25 MiB 时单次 `print(1)` 约 400 ms、主线程堆约 286 MiB，其中约 97% 是 collect / syncIn / diffOut）。

- [ ] **设计文档**（runtime docs/，所有者批准）：
  - worker 保留上次镜像，不再整树删除重写；
  - 主线程按 stat（大小 + 修改时间）计算差异，只发增量；快照改为哈希；
  - 跑完后的改动发现：包装 FS 写入函数做初筛，只对命中文件逐字比较（覆盖 mmap 盲区）；目录增删另比对清单；
  - 消息协议升版本号；worker 重启、挂载变化时退回全量同步。
- [ ] **实现 PR**：全量 vs 增量的随机操作序列等价性测试（全量路径保留作对照）；0 / 5 / 25 MiB 的耗时与内存对比。
- [ ] **放宽上限**：SYNC_MAX_FILES / SYNC_MAX_TOTAL_BYTES 按内存实测重新定。
- [ ] **product 升级锁定 → 部署 → iOS 复测**。

## 阶段 4B：能力内 MCP（C3 第二阶段，12-01 ～ 2027-01-23）

依据：docs/C3-MCP-STREAMABLE-HTTP.md（规格草案，2026-11-26 提交审阅；待所有者裁决的事项列在它的 §12）、docs/C3-CREDENTIALS-MCP.md §7（最初的轮廓）、DECISIONS.md D4（`mcp` 是 shell 命令，模型工具仍只有 bash / cloud_bash；2026-11-25 修订：首版 Streamable HTTP + bearer，连接由用户确认，工具审批默认继续）、D12（凭据默认记住）。

与 Word 彩排（阶段 2）的先后（2026-11-26 修订）：本阶段的设计和 bearer 实现（下面前两项）不依赖阶段 2 完成，可以并行。排在彩排之后的只有“往 SKILL 加编写 MCP 的流程”这一项，这样彩排得到的 SKILL 修复先稳定下来，不会因为加进 MCP 的内容而重新彩排 Word。

- [ ] **第二阶段设计文档**：docs/C3-MCP-STREAMABLE-HTTP.md 已有规格草案，待审阅。原来列的四个待定问题现在的状态：
  - relay 能否透传 SSE 流式响应：现有 relay 整体缓冲，服务器在流中途发来的表单请求到不了客户端。直连还是经 relay 由 A 的实测决定，证据未到，选路待验证。
  - `Mcp-Session-Id` 在 worker 重启与跨任务时的生命周期：会话只活一个任务，任务结束时清理；MCP 客户端不在 Python worker 里。
  - 只支持远程 MCP：确认，stdio 不做。
  - 浏览器内 OAuth（弹窗、PKCE、回调页、token 刷新与撤销、存储）：仍待定，属于 OAuth 版。
  - 新出现的一项：MCP 规范的当前稳定版 `2026-07-28` 删除了 `initialize` 握手和会话。首版按前一代（`2025-06-18` / `2025-11-25`）实现，连不上只支持 `2026-07-28` 的服务器；是否改为首版就支持它，待所有者裁决。
- [ ] **bearer 版**，按规格 §10.5 分四步，前一步合并后才开始下一步：harness → product 的包核心与连接（含 SDK 同步）→ runtime 的客户端与 `mcp` 命令 → 下面的示例能力。内容：能力包的 `mcp/<id>/mcp.json` 新增 `url`、`auth`、`credential` 三个字段（打包、校验、inspect、SDK 同步支持）；`mcp servers / tools / describe / call`；参数按 inputSchema 在客户端校验；工具审批只留一个默认继续的接入点（审批键 `mcp:<server>:<tool>` 保留给将来）；连接由用户在导入时确认，凭据沿用第一阶段。runtime 那一步要带着 A 的实测结论。
- [ ] **示例 MCP 能力**：选一个公开、bearer 鉴权的远程 MCP 服务器做官方示例并发布。它必须讲 `2025-06-18` 或 `2025-11-25`，或者两代都实现。
- [ ] **capability-authoring 增加编写 MCP 能力的流程**：排在 Word 彩排的 SKILL 修复（1.1.x）稳定之后，随 SDK 的下一个版本发布。
- [ ] **OAuth 版**；支持协议修订版 `2026-07-28`。

## 阶段 4C：第二批官方能力（11-28 ～ 2027-01-09）

vendor wheel 已就绪（example #5），规范描述符已具备（SDK 1.2.0 / XC7）。每个能力一个 PR，可并行；每个完成即发布并登记到 README。

- [ ] word（python-docx + lxml + typing_extensions）
- [ ] excel（openpyxl + et_xmlfile；XlsxWriter 视需要）
- [ ] pdf（pypdf）
- [ ] pptx（python-pptx + lxml + Pillow）
- [ ] image（Pillow）

## 阶段 5：打磨与 v1（2027-01-04 ～ 02-06）

- [ ] **CACHE-CTRL**：Anthropic 方言显式 `cache_control`，实测缓存命中。
- [ ] **体验积压**：设置中显示“作为依赖安装的插件”；对话删除；附件清理（GC）；npm audit；CROSS-CAP-DIST（不同 plugin id 携带同一发行包时的提示，D14 第 5 条）；终端（以后再定）。
- [ ] **REAL-WORLD-50**：定 50 个真实任务，用 flash 系列模型跑一遍，记录通过率作为 v1 质量基线。
- [ ] **对外文档**：README、SDK 文档、演示。
- [ ] **v1**：三个仓库同时打 tag，最后部署。

---

## 依赖关系一览

```
阶段1 收尾 ──► 阶段2 Word/视频 ──► 4A 增量同步 ───────┐
   │                │                                  ├─► 阶段5 v1
   │                ├──► 4C 官方能力 ─────────────────┤
   │                └──► 4B 里的“SKILL 加 MCP 流程”   │
   │                                                   │
   │            4B MCP（设计与 bearer 实现，不依赖阶段 2）─┘
   └─ 阶段3 稳固性（随时穿插，不阻塞主线）
```

2026-11-26 之前，4B 整体挂在“阶段 2 完成”下面。

## 变更记录

- 2026-11-07：初版。
- 2026-11-26：4B 的依据加入 docs/C3-MCP-STREAMABLE-HTTP.md（规格草案）。4B 的设计与 bearer 实现不再依赖阶段 2（Word 彩排），只有“SKILL 加编写 MCP 的流程”排在彩排之后。bearer 版按规格分四步；工具审批改为默认继续的接入点；记下协议修订版 `2026-07-28` 的取舍与选路实测待裁决、待验证。
