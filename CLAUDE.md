> AGENTS.md 与 CLAUDE.md 是同一份规则的两个副本，内容必须完全一致。
> 修改其中任何一份时，必须在同一个提交里对另一份做相同的修改。CI 会比对两份文件，不一致即失败。

## 仓库职责

本仓库是 Locus 三仓结构中的 product：面向用户的应用与能力组合，以及把 runtime 和 harness 集成在一起并证明它们能协同工作的适配层。
另两个仓库：[locus-runtime](https://github.com/boccchi2993/locus-runtime)、[locus-harness](https://github.com/boccchi2993/locus-harness)。
官方参考能力包在 [locus-example-capabilities](https://github.com/boccchi2993/locus-example-capabilities)（见 locus-product docs/DECISIONS.md D11）。

## 架构决定

涉及架构的改动之前，必须先阅读 [locus-product/docs/DECISIONS.md](https://github.com/boccchi2993/locus-product/blob/main/docs/DECISIONS.md)。
与其中某条决定冲突的改动，必须先由所有者批准，不能自行决定。

## 工作规则

- 在分支上工作，通过 PR 提交；不直接推送 main，不自行合并。
- PR 合并前 CI 必须全部通过。
- 不放宽断言、不跳过测试、不靠重跑让红灯变绿。
- 保留第一次失败的记录，证据必须与实际一致。
- 开放的维护项见本仓库的 [TODO.md](TODO.md)。

## 常用命令

以 [package.json](package.json) 的 scripts 为准：

- `npm ci` — 按 lockfile 干净安装依赖
- `npm run dev` — 本地开发（Vite）
- `npm run build` — 构建打包产物
- `npm test` — 单元与结构门（Node）
- `node tests/run-browser-gates.cjs` — 打包产物的浏览器 gate（需要 Chrome）；先运行 `npm run build`，再运行测试，因为部分 gate 检查的是打包产物
- `npm run preview` — 在 4173 端口预览打包产物

## 发布

线上地址是 https://locus-browser-agent-runtime.pages.dev/ ，对应 Cloudflare Pages 项目 `locus-browser-agent-runtime`。
这个项目使用 Direct Upload，没有连接 Git：推送任何分支都不会触发部署。
`stable` 分支记录的是当前线上运行的版本。

只有仓库所有者明确要求发布时才能执行，agent 不得自行发布。发布步骤：
1. 确认 main 的 CI 全绿，然后执行 `git push origin main:stable`
2. 在干净的目录中克隆仓库，检出 stable，执行 `npm ci` 和 `npm run build`
3. 在仓库根目录（functions/ 所在的目录）执行：
   `npx wrangler pages deploy dist --project-name locus-browser-agent-runtime --branch main`
   必须带上 `--branch main`：生产分支是 main，不加的话 wrangler 会读取当前分支名 stable，把这次部署当成预览部署
4. 执行 `npx wrangler pages deployment list --project-name locus-browser-agent-runtime`，
   确认最新一条记录是 Production 环境，提交号与 stable 一致
