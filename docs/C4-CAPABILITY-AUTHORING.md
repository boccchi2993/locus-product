# C4 — 写能力的能力（capability-authoring）与 C5 自举验收（设计 v1）

状态：所有者已批准（2026-10-27）。
关系：细化并部分取代 docs/CAPABILITY-AUTHORING.md §7–§9（Phase D 与自举）。该文档 §1 “人和 agent 走同一条创作路径”、§8 “能写不等于能装，导入是信任转移”、§9 的取消资格条件全部保留。

## 0. 目标

用户用一句话让 Locus 做一个能力。Locus 写出一个能力项目，自己校验、打包，在 `/mnt/download` 产出 `.locus`。用户在设置里“从路径导入”后，下一个任务就能用上这个能力。全程不改 Locus 源码，不走测试注入接口，不手工修改生成物。

## 1. 已定决定（所有者 2026-10-27）

| # | 决定 |
| --- | --- |
| A1 | 确定性的工作（校验、打 wheel、打 `.locus`、查看摘要）由一个纯 Python 的 SDK 完成，作为 plugin 随能力分发；不让模型手算哈希、手拼 zip。 |
| A2 | SDK 与 product / 示例仓库现有的 JS 实现必须**逐字节一致**，由示例仓库 CI 的交叉校验保证。 |
| A3 | product 每次导入（成功或失败）都把结果写到 `/home/locus/capability-imports/`，模型可以读，形成“打包 → 导入 → 读报告 → 修复”的闭环。 |
| A4 | C5 验收能力为 `reference-text-analysis`（一个 plugin + 一个 skill）。 |
| A5 | v1 范围：skill、模型自己写的纯 Python plugin、可选的凭据声明。不支持模型自行下载第三方 wheel，不支持 MCP。 |

> 2026-10-28：为满足 A2，.locus 写入端改为一律 store（见 CAPABILITY-INSTALL.md）。

## 2. 组成

### 2.1 `locus_capability_sdk`（纯 Python，只用标准库）

源码放在 locus-example-capabilities 的 `packages/locus_capability_sdk/`。它的 wheel 提交到 `vendor/wheels/`，在 `vendor/wheels.json` 中登记为 `source: "local"`。检查脚本会从源码重新构建 wheel，结果必须与提交的 wheel 逐字节相同。

API（`import locus_capability_sdk as sdk`）：

| 函数 | 作用 |
| --- | --- |
| `sdk.validate(project_dir)` | 返回诊断列表 `[{code, path, message}]`，空列表表示通过。覆盖 product 的项目校验（validateProject / buildProject 的规则）、D13 的平台标签与预装包遮盖规则、C3 的凭据声明规则，以及 skill 中 curl 必须使用已声明凭据变量、且目标在声明范围内的规则。 |
| `sdk.build_wheel(src_dir, dist, version, out_dir, summary="")` | 把 `src_dir` 下的一个顶层包或模块打成 `{dist}-{version}-py3-none-any.whl`。输出是确定的：固定时间戳、排序、固定权限；METADATA、WHEEL、RECORD 的格式都按标准。返回 wheel 路径。 |
| `sdk.build(project_dir, out_dir)` | 先校验，通过后打出 `<id>-<version>.locus`。读取 `locus.json`（author、purpose、title、changelog），与示例仓库的约定相同。返回 `{path, sha256, bytes}`。校验不通过时不产出文件，返回诊断。 |
| `sdk.inspect(locus_path)` | 返回与 product 导入检查相同含义的摘要：ok、诊断、id、version、作者、用途、组件、凭据声明、文件数、总大小、digest。 |

命令行：`python -m locus_capability_sdk validate|build|build-wheel|inspect ...`。人在普通 CPython 下同样可以用，满足 CAPABILITY-AUTHORING §10 中“不用 Locus 也能构建”。

### 2.2 能力项目目录约定

```
<project>/
  locus.json                       # author, title, purpose, changelog（不进包）
  capability.json
  skills/<skill-id>/skill.json
  skills/<skill-id>/SKILL.md
  plugins/<plugin-id>/plugin.json
  plugins/<plugin-id>/artifacts/<wheel>    # 由 build_wheel 生成
  src/<python-package>/...         # plugin 源码（不进包）
  tests/...                        # 可选（不进包）
```

`src/` 和 `tests/` 是否会被 JS 构建器当成“多余文件”拒绝，由 C4-SDK 任务核实。如果会被拒绝，SDK 和 JS 两边都按“只取包内路径”处理，或者改用独立的源码目录；以交叉校验的结果为准。

项目的存放位置：用户挂载了 `/mnt/workspace` 时，放在 `/mnt/workspace/capabilities/<id>/`；否则放在 `/home/locus/capability-projects/<id>/`。

### 2.3 `capability-authoring` 能力

- plugins：`["py-locus-capability-sdk"]`
- skills：`["capability-authoring"]`
- SKILL.md 讲判断和流程，内容见 §4。

### 2.4 导入报告（product）

每次导入尝试都写一个 JSON 文件到 `/home/locus/capability-imports/`，包括检查阶段失败、提交成功、提交后启用失败三种情况。文件名为 `<UTC 时间 YYYYMMDD-HHMMSS>-<id 或规范化的文件名>.json`，内容：

```json
{
  "schemaVersion": 1,
  "at": "2026-10-27T08:00:00Z",
  "source": "file" | "path",
  "label": "/mnt/download/reference-text-analysis-1.0.0.locus",
  "stage": "inspect" | "commit",
  "ok": false,
  "id": "reference-text-analysis", "version": "1.0.0", "kind": "new" | "replace" | "same",
  "diagnostics": [{ "code": "...", "path": "...", "message": "..." }],
  "result": { "state": "ready", "enabled": true, "enableError": null },
  "userAction": "confirmed" | "cancelled" | null
}
```

- 不包含任何凭据值。凭据在导入之后单独连接，与报告无关。
- 只保留最近 20 份，更早的自动删除。
- `/home/locus/capability-imports` 加入 home 目录骨架（LOCUS_HOME_SKELETON）。
- 用户在确认框里点了取消，同样写一份，`userAction` 为 `"cancelled"`，让模型知道用户没有导入。

## 3. 安全与信任

- 模型只能写文件、运行 SDK、产出 `.locus`。导入仍然只能由用户在设置里点击完成。模型没有任何触发导入的途径，这一条不变。
- 模型写的 plugin 和其他 plugin 权限相同（authority none），运行在同一个受拦截的 worker 中。
- 模型写的凭据声明在用户连接时会明确展示目标地址。SKILL.md 要求模型在交付时，把声明的地址告诉用户。
- 用户第二次导入同 id 的包时，会走“版本替换”确认框。SKILL.md 要求每次重新打包都提升版本号（补丁位），避免同版本、不同内容。

## 4. SKILL.md 要点（C4-CAP 任务撰写）

1. **判断**
   - 只需要知识和流程的，做成 skill。
   - 需要确定性计算、而且重复使用的，写一个 plugin。
   - 需要访问外部 HTTP API 的，在 skill 里用 curl 加凭据声明。
   - 不需要新能力就能完成的（模型现有工具已经够用），直接做，不要造能力。
2. **规范**
   - id 规则；版本号；目录约定（§2.2）。
   - plugin 只用标准库和 runtime 预装包（pandas、numpy）。
   - 凭据声明的字段和限制。
   - skill 中 curl 只能写 `$NAME`。
3. **Locus 环境限制**
   - python heredoc 必须是一次单独的 bash 调用；不支持反斜杠续行；没有网络。
   - 文件系统的各个目录及其用途。
4. **流程**
   1. 和用户确认需求，必要时提一两个问题。
   2. 写项目文件。
   3. 用 `sys.path` 直接导入 `src/` 测试 plugin，跑 tests。
   4. `build_wheel` → `validate` → `build` → `inspect`。
   5. 告诉用户三件事：文件路径；在“设置 → Capabilities → 从路径导入”中填入哪个路径；导入后会看到什么（组件、凭据目标地址）。
   6. 用户说已导入后，读取 `/home/locus/capability-imports/` 中最新的一份报告：成功就说明怎么使用；失败就根据诊断修复，提升版本号，重新打包。
5. **示例**：用 `reference-text-analysis` 完整走一遍，作为样例。示例写在 SKILL.md 中，但必须注明“这是示例，不要原样执行”。

## 5. C5 验收

**前提**：capability-authoring 已发布，product 已部署了导入报告功能。

**步骤**（由所有者在真实页面上操作，也可以交给使用电脑的 agent 按截图记录）：

1. 导入 `capability-authoring-1.0.0.locus`。
2. 新建对话：“帮我做一个文本分析能力：统计字数、找出出现最多的词。”
3. Locus 写项目、测试、打包，并告诉你路径。
4. 在设置里从路径导入。
5. 新建对话：“用文本分析能力分析一下这段文字……”（附一段文字）。

**通过标准**：

- 第 5 步的任务调用了新的 plugin（`import` 成功，输出与 plugin 计算一致）。
- 第 4 步之后，报告文件存在，`ok` 为 true。
- 全程没有出现 CAPABILITY-AUTHORING §9 列出的任何取消资格行为。

**加测**：故意要一个会出错的能力（例如要求它声明一个指向 `http://` 地址的凭据）。确认 SDK 在打包前就拦下来；或者导入报告给出诊断后，Locus 能自己修好。

## 6. 任务拆分

| 编号 | 仓库 | 内容 | 依赖 |
| --- | --- | --- | --- |
| C4-DOC | product | 落地本文档；在 CAPABILITY-AUTHORING.md §7–§9 加指向注释 | 无 |
| C4-SDK | example-capabilities | SDK 源码、wheel、`source: "local"` 的可复现检查，以及 SDK ↔ JS 交叉校验 | 示例仓库 #4、#5 已合并 |
| C4-REPORT | product | 导入报告 | product #42 已合并 |
| C4-CAP | example-capabilities | capability-authoring 能力（SKILL.md + SDK plugin）+ CI 中模拟 C5 的流程测试 | C4-SDK 已合并 |
| C5 | — | 部署 + 发布 + 所有者实测 | C4-REPORT、C4-CAP 都已合并 |
