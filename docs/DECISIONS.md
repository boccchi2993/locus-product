# DECISIONS — 架构决定记录

本文件是 locus-product、locus-runtime、locus-harness 三个仓库共同遵守的架构决定的唯一权威来源。
多个 coding agent 轮流维护这三个仓库，彼此不共享代码和文档之外的任何上下文；没有写进仓库的决定对下一个 agent 不存在。
因此：决定只能记录在这里，不能只留在对话或 PR 评论里。

规则：

- 任何 agent 在做涉及架构的改动之前，必须先阅读本文件；与其中某条决定冲突的改动，必须先由仓库所有者批准，不能自行决定。
- 每条决定按固定格式记录：编号 / 决定 / 理由 / 影响范围 / 被取代的旧表述（如有）。
- 增加新决定走 D8 的判定方法；修改或废除决定必须由所有者批准。被取代的旧文档表述不删除原文，在原处加指向本文件的注释。

---

## D1

**决定**：Locus 只有一条安全边界：一边是模型能控制的内容（模型生成的命令和 Python 代码、读取的文件、工具输出），另一边是宿主代码。runtime、harness、product 三层运行在同一个 JS 环境中，层与层之间是模块化边界，不是安全边界。

所有现有的“模型 vs 宿主”约束都保持不变：工具输出是不可信数据；Python 没有网络；curl 不携带 ambient 凭据；（释义，2026-10-18 所有者）：模型在命令中不写出凭据本身，只能写凭据变量名；变量只在 NetworkRuntime 发送时解析，且仅当目标地址匹配该凭据的绑定（C3 §3）。浏览器 cookie 等 ambient 凭据仍然一律不携带。有副作用的请求需要审批且只发送一次；只读挂载在 shell 和 Python 两侧都只读；修改 skill 实例需要确认；relay 拒绝私网目标；模型不能自动信任自己生成的扩展代码。

**理由**：三层代码同处一个 JS 环境，跨层不存在可强制执行的隔离，把层间当作安全边界会给出虚假的保证；需要对抗性测试守住的是“模型可控内容 vs 宿主”这一条边界。

**影响范围**：三仓的全部架构与安全论述。凡描述安全边界的文档（SECURITY-MODEL、ARCHITECTURE、REPOSITORY-SPLIT 等）都按本条解读；层间措辞只表达职责划分。

**被取代的旧表述**：无。既有“模型 vs 宿主”约束全部保留。

## D2

**决定**：凭据可以存放在任意一层的宿主代码中，但永远不能进入模型够得着的地方：VFS、Pyodide 内存、工具输出、对话历史。

**理由**：安全性质取决于凭据是否模型可达，而不是凭据落在哪一层宿主代码里；层归属是模块化选择（见 D1）。

**影响范围**：三仓。任何需要密钥的新机制（如 MCP 客户端，见 D3）按本条选择存放位置。

**被取代的旧表述**：取代 REPOSITORY-SPLIT §2 中“runtime 不持有授权、授权由外部注入”的表述，但**只取代其中关于凭据存放位置的部分**。REPOSITORY-SPLIT-CONTRACTS §3.5 的 ExecutionAuthorization 端口管理的是副作用操作的审批，与 D2 无关，保持不变，不得移除。

## D3

**决定**：MCP 客户端位于 runtime，凭据只保存在内存中。凭据的持久化由 product 负责，复用现有的“记住 API key”存储。

**理由**：客户端贴近 runtime 已有的有界网络/传输层；持久化复用 product 已有的 opt-in 凭据存储（SECURITY-MODEL §10），不新建第二套持久化机制。（存储方式由 opt-in 改为默认保存，见 D12。）

**影响范围**：runtime（MCP 客户端与内存凭据）、product（凭据持久化）、harness（MCP 的组合与审批编排不变）。

**被取代的旧表述**：CAPABILITY-BOUNDARIES §5、§6.3 中“MCP 集成 / MCP 是 harness 一等能力”的表述，就客户端代码的归属层而言被本条取代。

## D4

**决定**：MCP 通过 shell 命令 `mcp` 暴露给模型（`mcp servers` / `mcp tools <server>` / `mcp describe <server> <tool>` / `mcp call <server> <tool> <json|@file>`），不作为 provider 原生工具。模型可见的工具列表固定为 `bash`、`cloud_bash`。结构化处理放在客户端：参数在发送前按工具的 `inputSchema` 校验；审批按“服务器 + 工具名”判定，走与有副作用 HTTP 请求相同的审批流程；凭据与会话由客户端管理（D2、D3）。

**理由**：固定的工具列表让提示缓存稳定，也不需要按任务边界冻结和排序工具列表；结构化要求由客户端满足，不依赖“原生工具”这一形式；工具定义按需查询，不每轮占用上下文。

**影响范围**：runtime（`mcp` 命令与客户端）、harness（审批编排）、product（服务器配置与凭据 UI）。

**修订记录**：2026-10-18 所有者改写。原决定为“MCP 工具以 provider 原生工具形式暴露，工具列表随 TaskEnvironment 冻结”。

**被取代的旧表述**：CAPABILITY-BOUNDARIES §6.3 中‘MCP 应作为 harness 一等能力、可具备 shell/CLI 兼容前端’的表述，就暴露方式而言被本条裁决：走 shell 命令 `mcp`。

## D5

**决定**：provider 不可假定。用户的模型端点可能是任何实现，模型名称不能说明真实能力。所有依赖 provider 行为的判断，都通过能力探测或用户配置来决定，不得按模型名推断。这适用于图片输入、原生工具调用（不支持时必须退回文本协议）、上下文窗口与 max_tokens、思考块回放。唯一的例外是内置种子：只有当完整的 provider 身份与官方端点一致时（经 URL 解析的官方主机名、仅限 http(s) 和默认端口、不带 userinfo），才可以把一份范围很窄的内置种子作为默认值。种子只在没有任何记录时才会被查询；能力探测的结果和用户配置始终优先；第三方端点无论模型名写成什么，都永远不会继承种子。

**理由**：端点任意、模型名与真实能力没有可靠对应关系；按名推断会在第三方端点上产生静默的错误行为。官方端点例外对应 harness `capabilities.js` 中现有的 `BUILTIN_MODEL_CAPABILITIES`，它属于 D6 决定保留的“按 provider 身份记录的图片能力门”的一部分。

**影响范围**：harness 的 provider 适配层（图片能力门、协议选择、上下文预算、思考块回放）。

**被取代的旧表述**：无。SECURITY-MODEL §9（能力证据限定完整 provider 身份、第三方端点不因复制模型名继承官方声明）与本条一致并继续有效。

## D6

**决定**：以下机制经过审查后决定保留。不得以“过度设计”或“简化”为由移除，修改须经所有者批准：

- skill 的三层数据模型（Definition / SourceStore / Instance）与安装标记；
- cloud_bash；
- 三仓之间的契约版本协商；
- 双主线追踪与依赖元组锁定；
- 按 provider 身份记录的图片能力门；
- 每次修改 skill 实例都要确认（不设会话级授权）。

**理由**：这些显式契约是多个 agent 之间唯一共享的“什么是对的”。

**影响范围**：三仓；具体落点包括 CAPABILITY-BOUNDARIES §11（skill 三层模型与标记）、ARCHITECTURE §3 与 CAPABILITY-BOUNDARIES §1（cloud_bash）、REPOSITORY-SPLIT §4/§6（契约协商、双主线追踪与元组锁定）、IMAGE-INPUT 相关机制（图片能力门）、CAPABILITY-BOUNDARIES §11.3b（逐次确认）。

**被取代的旧表述**：无。

## D7

**决定**：/fetch relay 暂不增加限流或鉴权，等 Cloudflare 免费层的额度出现压力时再处理。

**理由**：当前没有出现压力证据；按 D8 的分类，提前加属于 C 类（工程洁癖）。

**影响范围**：/fetch relay 的部署与运维。

**被取代的旧表述**：无。

## D8

**决定**：今后新增或审查任何原则，都先回答“删掉它，模型或注入内容能多做到什么”，并据此归为三类：

- **A 安全边界**（保留，并配对抗性测试）；
- **B 模块化选择**，包括承载跨 agent 共识的显式契约（保留目标，实现可以简化）；
- **C 工程洁癖**（删除或降级）。

**理由**：为原则的增删提供可操作的判定方法，避免按审美或直觉增删约束。

**影响范围**：三仓一切原则性文档（DESIGN-PRINCIPLES、SECURITY-MODEL 等）的新增与审查。

**被取代的旧表述**：无。

## D9

**决定**：上下文管理遵守四条原则（详细设计见 [CONTEXT-MANAGEMENT.md](CONTEXT-MANAGEMENT.md)）：

1. **只追加。** 一条历史记录的内容在写入时定型，之后不再修改。唯一的例外是请求超出预算时的处理：一次处理到预算的 60%（低水位），只用 copy-on-write 替换条目，绝不原地修改；助手消息永远不改，以保证逐字节回放。
2. **历史引用的文件与对话同寿。** 历史中出现的文件路径，在对话存在期间必须一直可读。
3. **harness 只通过端口接触文件和存储。** 是否截断、标记怎么写由 harness 决定；文件放在哪、怎么存由 product 决定。
4. **单次请求预算 = min(传输上限, 上下文上限)。** 上下文上限来自用户配置，并用 provider 返回的 usage 校准，不按模型名推断（与 D5 一致）。

**理由**：每轮都裁到“刚好低于预算”会让请求前缀每轮都变，提示词缓存失效；被截断的工具输出必须能让模型自己取回；重载、切换 provider 前后的行为必须一致。按 D8 归为 B 类：承载跨 agent 共识的显式契约。

**影响范围**：harness 的历史预算、工具结果写入、恢复与跨 provider 投影；product 的 `/home/locus/history` 视图、提交前预检和设置项。

**被取代的旧表述**：harness `enforceHistoryBudget` “裁到刚好低于预算”的行为，以及“预算固定为 `HISTORY_BUDGET_BYTES`（768 KiB）”的表述。

## D10

**决定**：Capability 以 `.locus` 文件分发并持久安装（详细设计见 [CAPABILITY-INSTALL.md](CAPABILITY-INSTALL.md)）：

1. `.locus` 是 zip 包，根目录的 `LOCUS.md` 是元文件，写明包内的全部文件（路径、大小、SHA-256）、创建者、创建目的和更改记录。文件清单是封闭的：多出或缺少任何文件都拒绝导入。创建者是作者自述，不做签名验证。
2. 元文件不对模型暴露，只用于核验有效性、记录更改和必要字段。
3. 导入是信任转换，只能由用户在界面上确认完成；来源可以是本地文件，也可以是 VFS 里的 `.locus` 路径。模型没有任何触发导入的途径。
4. 已安装的包和启用状态持久化，存放在不挂载进 VFS 的存储里，每次加载重新核对哈希。不一致时提示用户：“继续”等于按当前字节重新锁定并追加更改记录；“本次跳过”则本次不加载、包保留。卸载是单独的操作。
5. 同一个 id 的版本替换需要确认；替换前启用的，替换后自动启用。用户改过的 skill 实例保持原样，没改过的更新为新默认内容，被新版本删掉的 skill 的实例保留为孤立文件。卸载也保留 skill 实例。
6. plugin 只以校验过的 wheel 进入 Python，删除源码文本合成路径。

**理由**：单文件便于在手机上导入，也便于模型在自举时产出；持久安装避免每次重载都重新导入；把包放在模型写不到的地方、每次加载都核对哈希，保证导入时的那次信任确认不会被事后绕过。按 D8：第 4 条中“存放在模型写不到的地方”和“加载时重新核对”属于 A 类（安全边界，配对抗测试），其余属于 B 类。

**影响范围**：harness 的 CapabilityManager（增量注册、wheel 负载、skill 实例升级规则）；product 的存储、导入、界面；runtime 删除源码文本合成路径。

**被取代的旧表述**：CAPABILITY-PACKAGE §9（导入只在页面会话内有效）、§10（卸载不是 v1 概念）、§12 中“persistent installed-package catalog”；EXTENSION-MODEL §4 中“legacy `files: {sourceText}` 合成路径”的保留说明；CAPABILITY-BOUNDARIES §11.6 中“page-session only”与“incompatible markers fail loudly and the reset path is Remove + Re-add”。D6 保留的 skill 安装标记机制不变，只改变标记与当前版本不一致时的处理。

## D11

**决定**：官方参考能力（示例能力包）的源码不放在 product，统一放在独立仓库 [boccchi2993/locus-example-capabilities](https://github.com/boccchi2993/locus-example-capabilities)。每个能力一个目录 `capabilities/<id>/`；按能力打 tag `<id>@<version>`，每个 tag 对应一个 Release，附件为确定性构建的 `.locus`。该仓库通过锁定 locus-product 的提交来引用打包代码（`src/capability-package.js`、`src/locus-archive.js`、`src/capability-packages.js` 的 inspect），不复制。product 只保证“能安装任何合法的能力包”，不依赖、也不测试任何具体的能力包；具体能力在真实服务上是否好用，由所有者部署后实测。

**理由**：能力的发布节奏和 product 不同；官方能力放在独立仓库，为第三方能力仓库提供样板；避免 product 与具体能力耦合。用一个仓库放多个能力，降低多仓库的维护和协作开销；某个能力需要独立时，可以用 `git subtree split` 带着历史拆出去。

**影响范围**：新仓库 locus-example-capabilities；product（不再收录能力源码；上述打包模块成为被外部锁定引用的接口，修改它们的导出时须在 PR 中注明）；三个仓库的 AGENTS.md 增加第四个仓库的地址。

**被取代的旧表述**：docs/C3-CREDENTIALS-MCP.md §8、§9 中“C3-P2 在 product 中实现参考能力包”的表述。

## D12

**决定**：用户为已安装的能力或 MCP 服务器连接的凭据，默认保存在本设备（opt-out）。范围包括：手动输入的 API key（C3 凭据绑定）、MCP bearer token、MCP OAuth 的 access token / refresh token 以及客户端注册信息。连接界面保留“不在本设备保存”的选项，并写明“保存在本设备浏览器中”。断开连接、卸载能力、重置全部数据时，删除对应的凭据；OAuth 凭据在服务器提供撤销接口时同时撤销。模型 API key 的“在本设备记住”同样默认勾选。凭据仍然一律不进入模型可达的范围（D2 不变）。

**理由**：导入或添加能力本身就表明用户想长期使用它，凭据是能力能工作的必要部分；默认不保存只会让用户每次刷新都重新连接。持久化不改变“模型 vs 宿主”这条安全边界（D1），新增的风险只是凭据以明文存放在本设备浏览器中，与已记住的模型 key 相同。

**影响范围**：product（凭据服务与模型 key 的默认值、连接界面文案、导入流程）；第二阶段 MCP 客户端（OAuth token 的保存、刷新与撤销）。

**被取代的旧表述**：D3 及 docs/SECURITY-MODEL.md §10 中凭据存储为“opt-in”、“API keys are not persisted by default”的表述，被本条取代。
