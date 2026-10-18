# BAH 施工进度

> 施工单 00 §5 与 `BAH-底座提示词/README.md` §1 的逐项勾选表。
> 纪律：**一次只推进一个阶段，验收通过才进下一阶段**（底座提示词 README §2.1）。
> `[x]` = 该文档对应施工单已按出口标准验收；`[ ]` = 未开工。

## 1. 文档 / 施工单进度（18 行）

| # | 文档 | 对应阶段 | 状态 | 备注 |
|---|---|---|---|---|
| 00 | 全局约定与工程纪律 | 全程（宪法） | [x] | 落为 `AGENTS.md`；合规五条进门禁 `no-upstream-imports` |
| 01 | 仓库骨架与基建 | 阶段 1 · M0 | [x] | 见 §3 出口清单 |
| 02 | 内核 core | 阶段 2 · M1 | [ ] | 契约已冻结在 `packages/core/src/api.ts`，实现未开工 |
| 03 | 会话日志与工具管线 | 阶段 3 · M1 | [ ] | envelope 与工具契约已冻结在 api.ts |
| 04 | 主循环 agent-loop | 阶段 5 | [ ] | 依赖阶段 4（模型层）先行 |
| 05 | 模型层与提示词装配 | 阶段 4 | [ ] | llm-mock 保证无密钥可跑 |
| 06 | 组合系统 profile | 阶段 6 | [ ] | `bah.yml` 与本文件同批落地 |
| 07 | 仿真银行 bank | 插件线 | [ ] | 接缝冻结后才可开工 |
| 08 | 银行工具族 | 插件线 | [ ] | |
| 09 | 三级权限审批票据 | 插件线 | [ ] | `ToolDefinition.tier` 已预留 |
| 10 | 安全防护层 sentry | 插件线 | [ ] | |
| 11 | 沙箱运行时 | 插件线 | [ ] | |
| 12 | 审计轨迹与回放测试 | 阶段 7（建议项） | [ ] | `snapshots/` 与 `test:snapshot` 已就位 |
| 13 | Web 前端 | 插件线 | [ ] | `apps/web` 纯原生骨架已就位 |
| 14 | 移动 H5 与跨场景规划 | 插件线 | [ ] | |
| 15 | IM 网关与桌面端 | 插件线 | [ ] | `apps/im-gateway`、`apps/desktop` 占位 |
| 16 | 交付材料与验收 | 插件线 | [ ] | |
| — | 一致性检查（文档 ↔ 代码） | 每阶段末 | [ ] | 阶段 1 已做：api.ts ↔ 02/03 逐条对照，见 §4 |

## 2. U3 · 人力裁剪决议（施工单 01 出口标准第 7 条）

| 项 | 内容 |
|---|---|
| 人力评估 | **≥3 人** |
| 决议 | **不裁剪，全量实现** |
| 保留项（不落裁剪线） | 真定时跟进（`schedule`）、Electron 桌面端、SQLite 后端与迁移包、卡片场景（`plan/goal/todo` + 卡片渲染） |
| 影响 | 插件线 07–15 全量排期；底座阶段的接缝按「全部保留」设计，不为裁剪留空实现 |
| 记录时间 | 2026-10-18（阶段 1 开工前） |

> 说明：底座本身不受人力裁剪影响（底座提示词 README §2.6）。本决议只影响**插件线范围**。

## 3. 阶段 1 出口清单（施工单 01 §0 + §9）

| # | 出口标准 | 状态 | 证据 |
|---|---|---|---|
| 1 | `pnpm install && pnpm typecheck && pnpm test` 全绿 | ✓ | install 成功（1 条 engines 警告，见 §4 风险 R1）；typecheck 0 error；test `No test files found, exiting with code 0`（`passWithNoTests`） |
| 2 | 12 个物理包骨架就位 | ✓ | `packages/{core,runtime,llm,interaction,safety,bank,persistence,host,channels,cli,test-support,util}`，各含 `package.json` / `tsconfig.json` / `src/index.ts` + 逻辑模块子目录 |
| 3 | `NOTICE.md` / `AGENTS.md` / `PROGRESS.md` 就位 | ✓ | 三文件按施工单 01 §4 模板全文落盘 |
| 4 | 4 个 vitest 配置就位 | ✓ | `vitest.config.ts` / `vitest.e2e.config.ts` / `vitest.snapshot.config.ts` / `vitest.web.config.ts` |
| 5 | 3 个门禁脚本可运行 | ✓ | `pnpm gate` → 3/3 通过；三项均做过**负控**（注入违规 → exit 1） |
| 6 | 内核接口定稿签审（§8） | ✓ 作者自审 | `packages/core/src/api.ts` 六项契约齐备；逐条对照见汇报 §4，待人工复核 |
| 7 | U3 人力决议写入本文件 | ✓ | 见 §2 |

| # | 验收清单（§9） | 状态 |
|---|---|---|
| 1 | `pnpm install` 无错误 | ✓ |
| 2 | `pnpm typecheck` 通过 | ✓ |
| 3 | `pnpm test`（空集）通过 | ✓ |
| 4 | `pnpm gate` 三脚本通过 | ✓ |
| 5 | 12 包骨架 + 目录树与施工单 00 §7 一致 | ✓ |
| 6 | `NOTICE.md` / `AGENTS.md` / `PROGRESS.md` 就位 | ✓ |
| 7 | `api.ts` 接口签审冻结 | ✓ 自审完成 |
| 8 | U3 人力决议写入本文件 | ✓ |

## 4. 已知偏差与残留风险（阶段 1）

| ID | 项 | 处理 |
|---|---|---|
| R1 | 本机 Node `v22.17.0`，低于 `engines: ^22.19 \|\| >=24` | 按决议保留规格钉死；pnpm 仅 warn 不 error。CI 需统一到 22.19+ 或 24（施工单 01 §10 风险表第 1 行） |
| R2 | `@bah/core` 的逻辑模块目录：`core` 模块与包同名，未再建 `src/core/` 子目录 | 保留 `src/api.ts` 平铺（施工单 02 §9 指定该路径），避免与阶段 2 的 `context.ts`/`events.ts` 混层 |
| R3 | 依赖白名单外新增：`schemastery`（ConfigSchema） | 经决议引入；`jsdom` / `yaml` / `@types/node` 为施工单 01 §5、§6 与 Node 编译面所必需 |
| R4 | 声明产物中的相对说明符保留 `.ts` 后缀 | 仓内通过 project references 解析；对外发布面是 `dist/`（tsdown 打包），不受影响 |
| R5 | `scripts/*.ts` 未纳入 `pnpm typecheck` | 施工单 01 §2 的 references 只含 packages；由 tsx 直跑保证可执行。后续可加独立 project |
| R6 | 根 `build` 脚本原样 `--filter='./packages/*'` 在 Windows `cmd` 下不匹配任何包（单引号被当作字面量） | 改为 `--filter "./packages/*"`；`pnpm build` 12 包全部产出 `dist/` |
| R7 | tsconfig 相对施工单原文的增补 | `outDir` / `tsBuildInfoFile` 用 `${configDir}` 前缀（否则 12 包产物与增量状态互相覆盖，删产物后 `tsc -b` 会误判"已最新"而跳过 emit）；`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（施工单 00 §10 要求包内相对导入带 `.ts`）；client 面加 `allowJs` + `rootDir`（`apps/web/src` 是 JS） |
| R8 | 包 `exports` 用 `{ types, import }` 条件而非裸 `"./dist/index.js"` | 声明产物在 `dist-types/`（施工单 01 §2 的 base `outDir`），裸字符串形式下 `tsc` 解析不到类型 |
