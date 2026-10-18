# BAH 施工进度

> 施工单 00 §5 与 `BAH-底座提示词/README.md` §1 的逐项勾选表。
> 纪律：**一次只推进一个阶段，验收通过才进下一阶段**（底座提示词 README §2.1）。
> `[x]` = 该文档对应施工单已按出口标准验收；`[ ]` = 未开工。

## 1. 文档 / 施工单进度（18 行）

| # | 文档 | 对应阶段 | 状态 | 备注 |
|---|---|---|---|---|
| 00 | 全局约定与工程纪律 | 全程（宪法） | [x] | 落为 `AGENTS.md`；合规五条进门禁 `no-upstream-imports` |
| 01 | 仓库骨架与基建 | 阶段 1 · M0 | [x] | 见 §3 出口清单 |
| 02 | 内核 core | 阶段 2 · M1 | [x] | 内核已实装；出口清单见 §5，偏差见 §6 |
| 03 | 会话日志与工具管线 | 阶段 3 · M1 | [x] | 会话日志 + JSONL 后端 + 七段管线；出口清单见 §8，偏差见 §9 |
| 04 | 主循环 agent-loop | 阶段 5 | [x] | turn/step 状态机 + 四接缝 + 回退分叉；出口清单见 §14，偏差见 §15 |
| 05 | 模型层与提示词装配 | 阶段 4 | [x] | 词汇表 + Adapter seam + 六段装配 + reconcile + 压缩；出口清单见 §11，偏差见 §12 |
| 06 | 组合系统 profile | 阶段 6 | [x] | 三层概念（profile/bundle/patch）+ 四层层序 + config-only HMR + CLI 出口；出口清单见 §17，偏差见 §18 |
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

## 5. 阶段 2 出口清单（施工单 02 §0 + §11）

| # | 出口标准（§0） | 状态 | 证据 |
|---|---|---|---|
| 1 | 三段生命周期；`apply` 内 `await ctx.parallel('fake-event')` 报「有监听器未完成」 | ✓ | `T-CORE-001`（并断言监听器一次都没跑：守卫先于副作用）；`install → start → ready` 状态见 `app.phase` 断言 |
| 2 | 读服务 + `effect()` 可逆副作用 + dispose 正确回滚 | ✓ | `T-CORE-003`（逆序）、`T-CORE-019`（reason 透传）、`T-CORE-004`（inject 收到实例） |
| 3 | 五模式语义与 §3 表逐条一致；waterfall 与 §4 精确定义一致 | ✓ | `T-CORE-006`~`T-CORE-013` 覆盖 §4 第 1/3/4/5/6 条与五模式；`emit` 用「派发前同步返回」断言不阻塞 |
| 4 | misconfiguration 在 `apply()` 前抛出，错误带 `bah-core: ` 前缀 | ✓ | `T-CORE-002`（前缀 + 插件名 + 应用置 disposed）、`T-CORE-014/015/016`（未知键 / 类型错 / 正则编译失败） |
| 5 | 单测全绿 + 本包行覆盖 100% | ✓ | `pnpm test` 55 passed；`pnpm test:coverage` 七模块 **Stmts/Branch/Funcs/Lines = 100%** |

| # | 验收清单（§11） | 状态 | 证据 |
|---|---|---|---|
| 1 | 出口标准 §0 五条逐条核对 | ✓ | 见上表 |
| 2 | `pnpm test packages/core` 全绿，行覆盖 100% | ✓ | `pnpm test:coverage` → `All files 100 / 100 / 100 / 100` |
| 3 | `verify-event-modes` 门禁通过 | ✓ 骨架版 | `pnpm gate` → 4/4，其中 `event-modes` 已含真实比对逻辑并做过负控（见 R20）；事件总表冻结后按 TODO 收紧 |
| 4 | `api.ts` 无随意改动 | ✓ | `git diff --stat -- packages/core/src/api.ts` 为空（460 行原样） |

## 6. 已知偏差与残留风险（阶段 2）

| ID | 项 | 处理 |
|---|---|---|
| R9 | `api.ts` 的 `Context` 没有插件注册入口（只有 `get/effect/start/dispose/provide/whenReady/scope/isolate`） | 装配入口放在**新增**的 `context.ts`：`BahContext.use(plugin, config)`。理由：02 §9 第 6 步把「PluginV2 装配」归装配层，且改 api.ts 须走破坏性变更流程 |
| R10 | `effect()` 返回 `Disposer`（api.ts 冻结面），02 §2 正文写 `: void` | 按 api.ts 实现（阶段 1 已记为偏差：02 同段注释要求返回 disposer） |
| R11 | `use()` 返回 `Promise<this>` 而非 `this` | 应用 `ready` 后再注册要跑异步 `apply`（T-CORE-020 要求「前者 effect 回滚」，前提是前者已安装）；而「载入即抛」要求配置错误**同步**抛。用「非 async 函数返回 Promise」同时满足两者 |
| R12 | 顶层未知配置键由内核补检 | schemastery 对未知键是「原样保留」不报错；内核用它自己的 `dict` 字段做顶层键比对。嵌套未知键留给施工单 06 的 profile 校验 |
| R13 | `waterfall` 返回值规则 | 取**最外层 handler 的返回值**；`next(v)` 返回下游链结果。**已定案**：查阅机制对照锚点（施工单 00 §12）确认上游语义同为「返回最外层 listener 的返回值、`next()` 不做值穿透」，故不改实现，只把规则写进 `stepChain` JSDoc，并加一条无 ID 用例钉住「只 `await next(v)` 不 return 会丢值」（防被好心重构改成链尾兜底） |
| R14 | `bail` 的 `next` 是透传函数，不参与裁决 | api.ts 说「waterfall/bail 的监听器必须显式 `await next()` 交还」，但 bail 的裁决只看返回值（首个非 `undefined`），`next` 无交还语义；保留透传是为了形状统一（误调不炸）。**与上游差异**：上游把 `null` / `false` 也算「无裁决」，我们按 api.ts 冻结面只认 `undefined`——`return false` 在本工程会短路。要改需走破坏性变更流程 |
| R15 | 事件监听器声明的 `mode` 与派发模式不一致 → 抛 `event-mode-mismatch` | api.ts 未规定该情形。选择 fail-loud 而非静默跳过：`@mode` 是公开契约，声明与实际派发点分叉属接缝错误 |
| R16 | 根 `vitest.config.ts` + `package.json` 有改动（在 `packages/core/**` 之外） | 提示词硬约束 3 要求「覆盖率门禁本阶段接入」：`include` 改为读 `scripts/coverage-allowlist.ts`（不写死包名，后续阶段名单自动生效），新增 `test:coverage` 脚本；排除 `api.ts`（纯类型、零可执行行）、`*.test.ts`、`index.ts` |
| R17 | 声明产物含 `*.test.d.ts` | **已决议保留**：测试在 composite 工程内才会被 `tsc -b` 检查类型（这才是值钱的部分）；这些 d.ts 不进导出面、仓库私有、不发布 |
| R18 | 实现总量 924 行（含 index 与注释；有效代码 533 行） | **已决议保留**：有效代码在 600–900 区间内，超出的 24 行全是 JSDoc（公开成员与错误码的契约说明），后续阶段靠它读懂内核 |
| R19 | T-CORE-001 语义按人工决议实现 | 决议：install 阶段禁止 `parallel` 广播（此时后续插件的监听器尚未安装），错误文案含「有监听器未完成」；`start` 完成后广播正常（有测试覆盖） |
| R20 | `verify-event-modes` 门禁 | **已落地骨架**：`scripts/verify-event-modes.ts` 并入 `pnpm gate`（现 4 项）。已有真实比对逻辑（声明点向前 20 行找 `@mode`、派发点取字面量事件名，不一致即失败）；当前零声明点、零字面量派发点 → 骨架通过。**负控已验证**：临时注入「声明 emit / 按 waterfall 派发」→ `✘ event-modes` 且 exit 1 |
| R21 | 底部提示词 README 的抽查点笔误 | **已更正**：`BAH-底座提示词/README.md` §3 阶段 2 行改为「T-CORE-003（effect 逆序回滚）+ T-CORE-020（同名覆盖后回滚），waterfall 短路见 T-CORE-007」。该文件在 `MonoRepo/` 之外，不入本仓库提交 |

## 7. 测试地基（阶段 2 追加，按人工要求「把测试框架详细补上」）

| 交付 | 文件 | 内容 |
|---|---|---|
| 测试上下文 | `packages/test-support/src/mock-ctx/index.ts` | `createTestContext` / `withTestContext` / `record(name, mode)` / `flush` / `waitFor`（超时必抛，绝不无限等） |
| 确定性夹具 | `packages/test-support/src/fixtures/index.ts` | `asSessionId` / `asTicketId` / `fixedClock` / `seededRandom`（mulberry32） |
| 错误断言 | `packages/test-support/src/assertions/index.ts` | `captureThrown` / `captureRejection`：验 `code` 与前缀，不只验「抛了」 |
| 快照 fixture | `packages/test-support/src/session-snapshot/fixtures.ts` | `parseSnapshotName` / `selectSnapshot`：`session[.序号][.vN].jsonl` 解析、同组最高代、冲突 fail-loud |
| llm-mock-server | `packages/test-support/src/llm-mock-server/index.ts` | 占位 + TODO（依赖阶段 4 的 wire 形态与阶段 7 的 harness） |
| 测试面解析 | `vitest.shared.ts` | `@bah/<pkg>` → `packages/<pkg>/src/index.ts`（四个面共用，避免跑构建产物） |
| 三类真实用例 | `snapshots/fixtures.test.ts`、`apps/web/src/main.test.js`、`packages/cli/src/main.smoke.test.ts` | 快照通道 2 例、jsdom 入口 2 例、CLI 进程冒烟 1 例 |
| 全链命令 | `scripts/ci.ts` + `pnpm check` | typecheck → test → coverage → gate → e2e → snapshot → web，fail-fast + 耗时汇总 |
| 覆盖率产物 | `vitest.config.ts` | `text` + `lcov` + `json-summary` → `coverage/`（已 gitignore） |
| 操作手册 | `docs/testing.md` | 四个面 / 用例 ID 纪律 / 覆盖率政策 / 别名边界 / 确定性纪律 / fixture 命名 / 常见坑 |

**验收证据**：`pnpm check` → 7/7 全绿（typecheck 1.3s、unit 1.6s、coverage 1.8s、gate 0.6s、e2e 0.7s、snapshot 1.3s、web 2.1s）；
`pnpm test` → **83 用例 / 10 文件**全绿；`pnpm test:coverage` → 名单内 **100 / 100 / 100 / 100**；
`pnpm test:snapshot` / `pnpm test:web` 由「No test files found」变为真用例（各 2 例）。

| ID | 项 | 处理 |
|---|---|---|
| R22 | `@bah/test-support` 结构与依赖扩展 | 模块目录按 00 §6 / 12 §3 改名：`snapshot/`→`session-snapshot/`、`mock-server/`→`llm-mock-server/`（阶段 1 用了缩写）；新增 `fixtures/`、`assertions/` 两个模块目录（00 §6 只列三个）。依赖方向 `test-support → core / runtime / util`：01 §3 的依赖表未列该包，属**追加**；本包只服务测试，不得被运行时包依赖 |
| R23 | 全链命令叫 `pnpm check` 而非 `pnpm ci` | `ci` 是 pnpm 内建命令（`ERR_PNPM_CI_NOT_IMPLEMENTED`），脚本会被它遮蔽；`check` 无冲突 |
| R24 | 测试面把 `@bah/*` 解析到 `src` | 包 `exports` 指向 `dist/`，测试若走包名会静默跑构建产物（改了 src 忘了 build 就假绿）。仅在四个测试配置里 alias，包间真实运行时依赖不变（02 §8 第 1 条） |
| R25 | 测试覆盖面边界 | `snapshots/**` 与 `apps/web/src/*.test.js` 不在 `tsc -b` 覆盖内（只经 vitest 转译），阶段 7 扩快照 harness 时补 `snapshots/tsconfig.json`；e2e 面**零用例是设计**（真实 API 密钥门控），不需要密钥的进程冒烟放 unit 面 |
| R26 | CLI 占位文案去阶段号 | 原文案写死「阶段 1」，已改为「底座骨架」，避免每阶段都要改占位文本（冒烟用例只断言 `^bah: ` 前缀） |

## 8. 阶段 3 出口清单（施工单 03 §0 + §5）

| # | 出口标准（§0） | 状态 | 证据 |
|---|---|---|---|
| 1 | 会话 append-only（内存 + JSONL）：`seq` 单调连续、不可覆写、不可删除 | ✓ | `T-SESS-001`（100 条 seq 连续）、`T-SESS-005`（分代发布、源文件不动）、`T-SESS-008`（接口面无 rename/delete，单测探测）；`SessionStore` 不提供 update/delete，`restore` 拒收断代 |
| 2 | `deriveMessages()` 可从日志投影模型历史；`verify-session-events` 门禁通过 | ✓ | `T-SESS-002/003/004`；`pnpm gate` → 5/5（新门禁 `session-events` 已做负控：未声明事件名 + 白名单外 `deriveMessages` 均被拦） |
| 3 | 七段管线完整，判决顺序与 §2.2 严格一致 | ✓ | `T-TOOL-003~011`；顺序断言：pre-execute → guard → execute → post-execute → 落账（`T-TOOL-006` 证明 deny 短路、ask 不触发） |
| 4 | 失败 step 补记（`ToolCallRecovery`）可用 | ✓ | `ToolCallRecovery.observe/results`（3 例：未闭合补记、已闭合不补、理由可定制）；主循环接线在阶段 5 |
| 5 | 单测全绿 + session / tools / persistence-jsonl 行覆盖 100% | ✓ | `pnpm test` 130 用例 / 18 文件；`pnpm test:coverage` → 三目录 **Lines 100%**（core 仍 100%） |

| # | 验收清单（§5） | 状态 | 证据 |
|---|---|---|---|
| 1 | §0 五条逐条核对 | ✓ | 见上表 |
| 2 | `verify-session-events` 门禁通过 | ✓ | `pnpm gate` 5/5 |
| 3 | 三目录行覆盖 100% | ✓ | 覆盖率报告（session / tools / jsonl 全 100） |
| 4 | 七段顺序与 §2.2 逐段一致 | ✓ | `pipeline.ts` 文件头把七段逐条列出，代码按 ①②③④⑤⑥⑦ 注释分段；`T-TOOL-006` 锁顺序 |
| 5 | 无 update/delete 会话事件 API | ✓ | `T-SESS-008` |

## 9. 已知偏差与残留风险（阶段 3）

| ID | 项 | 处理 |
|---|---|---|
| R27 | `SessionEventMap` / `BahEventMap` 用**模块增强**补键，而非改 `api.ts` | 阶段 3 硬约束「不动 core/**」与 api.ts「阶段 3 收窄为逐键声明」冲突，取前者：`session/types.ts` + `seams.ts` 用 `declare module '@bah/core'` 追加。**后果**：core 的索引签名仍在，事件名拼错不会被类型系统拦住（`SessionEventType` 仍是 string）——由 `verify-session-events` 词法门禁兜底。彻底收窄要走破坏性变更流程（可列为下阶段选项） |
| R28 | `session/event` 载荷是单参数信封 `{ session, event }` | 04 §5 写的是 `(session, event)` 两参；内核 `emit` 只传一个 payload，故包成信封 |
| R29 | 会话事件族只声明**平台族**（turn/step、请求、消息、工具、审批） | 03 §1.2 的领域族（`transfer/*`、`card/*`、`wealth/*`、`verify/*`…）按同表注释「由各自插件包声明」留给插件线，用同一增强机制追加 |
| R30 | 审批接缝 = `approval/request`（waterfall）+ `decision` 字段默认 `unavailable` | 票据**状态机**未实现（属主 bank-core，施工单 07 §3）；本阶段只签发 `TicketRef` 并落 `approval/asked` / `approval/decided` 事件对。`unavailable = deny` 符合 00 §11 |
| R31 | JSONL 升级只改文件 header，事件行原样保留 | 「不改写历史」优先于「事件 formatVersion 一起升级」；`open` 用 `flag: 'wx'` 排他发布后继（不靠先查后写的竞态窗口），源文件一个字节不动（T-SESS-005 断言） |
| R32 | `DerivedMessage` 是 wire-agnostic 视图 | 阶段 4 的 Adapter 负责映射到 DeepSeek wire（messages / tool_calls）；`deriveMessages` 只保证「模型可见序列」正确 |
| R33 | 两个 M0 门禁的误报修复 | `tiers` 原来把纯类型引用（`Map<string, ToolDefinition>`）算成声明点 → 误报；改为只认 `satisfies X` 与 `: X = {`。`session-events` 跳过注释行（文档里提到 `deriveMessages` 不算调用）。两者都重新做过负控 |
| R34 | 覆盖率排除 `runtime/src/tools/types.ts` | 纯类型模块（只有 `export type`），与 `core/api.ts` 同理；`session/types.ts` 有运行时常量，**不**排除 |
| R35 | 依赖面变化 | `runtime` / `persistence` 新增 `@bah/util`（BahError / assertNever）与 `devDependency @bah/test-support`；`test-support` 去掉未使用的 `@bah/runtime`（否则 `runtime → test-support → runtime` 形成 project reference 环）。01 §3 的依赖表未列这些边，属追加 |

## 10. 阶段 3 残留风险闭环（人工要求「残留风险解决」）

| # | 原风险 | 处理 | 证据 |
|---|---|---|---|
| 1 | 事件名拼错在编译期拦不住（R27） | **已闭环**：session 侧本就由 `append<S extends SessionEventType>` 收窄，补 `@ts-expect-error` 编译期断言把它钉住；派发侧（`ctx.events.<mode>` 仍是 string）由 `verify-session-events` 门禁兜住。api.ts 的索引签名收窄仍留给「接缝总表冻结」时一次做完（避免阶段 4/5 反复触发破坏性流程） | `session/types.test.ts`（3 条断言）；负控：去掉 `@ts-expect-error` → `error TS2345: '"ghost/event"' is not assignable to ...` |
| 2 | `tools/execute` 的「函数中间件」形态需插件作者理解（R28 相关） | **已闭环**：新增 [docs/pipeline.md](docs/pipeline.md)（七段 + 四个 waterfall 载荷 + 超时/重试/指标三种环绕写法 + 审批流 + 补记 + 铁律）；`seams.ts` 的 `ToolExecutor` 加最小示例 | 新增用例「超时包裹可用」：环绕层抛错经管线归一化为 `isError / tool-failed`，不冒泡 |
| 3 | `deriveMessages` 尚未包含 `request/context` reconcile 与压缩重建 | **已定性并钉住**：`request/context` **有意**不进模型历史（reconcile 归施工单 05 §5 的提示词装配），JSDoc 写明理由 + 一条用例锁语义；压缩重建属施工单 05 的独立模块 | `derive.test.ts`「request/context 不进模型历史」 |
| 4 | 阶段 3 的两处人工抽查未实跑 | **已实跑**：① `pnpm test -t T-SESS-001` → `1 passed / 132 skipped`；② 手工把真实 `session.jsonl` 尾行砍半 → `open` 只告警不抛错 | ② 的现场输出：`jsonl: 丢弃截断的尾行（第 3 行）…`，`open 成功，读到事件数 = 1`，`seq 列表 = [1]` |

## 11. 阶段 4 出口清单（施工单 05 §0 + §8）

| # | 出口标准（§0） | 状态 | 证据 |
|---|---|---|---|
| 1 | provider-neutral 词汇表冻结：ContentBlock / StreamChunk | ✓ | `packages/llm/src/llm/types.ts`（7 kind 内容块 + 7 kind 分片 + 块索引约定）；`assemble.ts` 逐 kind 消费、`push` 以 `assertNever` 收尾（负控：`{kind:'ghost-delta'}` → `llm-stream-chunk: …`） |
| 2 | LlmAdapter seam 可用：DeepSeek 真实流式 + llm-mock 无密钥跑通完整 turn | ✓ | seam：`registry.ts`（register / disposer / replace / resolve）+ 服务键 `llm:adapters`；DeepSeek：`wire.ts` 纯映射 + `adapter.ts` SSE 读流（注入假 fetch 全覆盖，真实 key 走 `adapter.e2e.test.ts`）；mock：`T-LLM-001` 脚本化跑完整 turn |
| 3 | 系统提示词六 section 装配顺序正确；能力位缺失时对应 section 不装配 | ✓ | `T-LLM-007`（order 0/10/20/30/40/50 单调递增；乱序注册也按 order 拼）；`T-LLM-006`（无 toolCall 能力 → `bank.capabilities` 不装配，`policy.approval` 同时不装配） |
| 4 | 运行时上下文 reconcile 语义落地：user/message 落历史 + 下次装配核对回收 | ✓ | `T-LLM-008`（两次 attempt → 旧 `system/message` 与旧 `runtime-context` 被撤回，日志仍 append-only）；`T-LLM-009`（`agent.inject` 走同一路径、模型可见） |
| 5 | 压缩：token/turn 阈值触发；金融特例字段不丢 | ✓ | `T-CMP-001`（token 水位触发、最近 N 轮保留原文）；`T-CMP-003`（`{amount,payee,ticketId,decision}` 结构化保留）；`T-CMP-002`（摘要落账为 `compaction/summary`）；`T-CMP-004`（JSON 往返后仍能重建） |

| # | 验收清单（§8） | 状态 | 证据 |
|---|---|---|---|
| 1 | §0 五条逐条核对 | ✓ | 见上表 |
| 2 | `bah --profile headless`（真实 key + mock 双跑通） | ✗（延后） | CLI / profile / boot 属阶段 6；本阶段用 `T-LLM-001` 的编程式装配验证同一链路。真实 key 的 e2e 见 §13 |
| 3 | compaction 行覆盖 100% | ✓ | `pnpm test:coverage` → `runtime/src/compaction` 行 100%（apply.ts / summarize.ts 均 100） |
| 4 | 降级 / 参数修复路径有单测 | ✓ | `T-LLM-005`（failed+retried 两条留痕、出流首片失败也降级、取消不重试）；`T-LLM-003`（坏 JSON 回灌 → 重试一次 → 仍坏则 `tool-args-invalid`） |
| 5 | 密钥只从环境变量读取（grep 无硬编码 key） | ✓ | `wire.ts` 只有 `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 两个键名常量；测试里的 `sk-test` 是伪造值，真实 key 由 e2e 从 env 读 |

**规格用例落点（T-LLM-001~009 / T-CMP-001~004，编号与期望逐条一致）**

| ID | 用例 | 文件 |
|---|---|---|
| T-LLM-001 | mock 跑通 turn（事件序列 + 历史重建） | `runtime/src/system-prompt/model-turn.test.ts`（2 例） |
| T-LLM-002 | tool-call-delta 拼接 | `llm/src/llm/assemble.test.ts` |
| T-LLM-003 | 坏 JSON → 回灌 + 重试 1 次 + 仍坏 isError | `llm/src/llm/repair.test.ts`（2 例） |
| T-LLM-004 | usage 按 turn 汇总落审计 | `runtime/src/system-prompt/model-turn.test.ts` + `llm/src/llm/usage.test.ts` |
| T-LLM-005 | 降级链 + `assistant/attempt` 落账 | `llm/src/llm/route.test.ts` |
| T-LLM-006 | 能力位裁剪 | `runtime/src/system-prompt/sections.test.ts` |
| T-LLM-007 | section 顺序单调递增 | `runtime/src/system-prompt/registry.test.ts`（2 例） |
| T-LLM-008 | runtime.context 落账 + 下次装配回收 | `runtime/src/system-prompt/reconcile.test.ts` |
| T-LLM-009 | agent.inject 走同一路径、模型可见 | `runtime/src/system-prompt/reconcile.test.ts` |
| T-CMP-001 | token 阈值触发折叠 | `runtime/src/compaction/summarize.test.ts` |
| T-CMP-002 | 摘要落账（可回放） | `runtime/src/compaction/apply.test.ts` |
| T-CMP-003 | 金融特例字段结构化保留 | `runtime/src/compaction/summarize.test.ts` |
| T-CMP-004 | 压缩后 deriveMessages 仍可重建 | `runtime/src/compaction/apply.test.ts` |

**规模**：`pnpm test` **260 用例 / 33 文件**（阶段 3 为 135 / 19）；`pnpm check` 7/7、`pnpm gate` 5/5、`pnpm build` 12 包全绿；覆盖率 **All files 行 100%**（分支 96.43 / 函数 99.23）。文档：新增 [docs/model-layer.md](docs/model-layer.md)。

## 12. 已知偏差与残留风险（阶段 4）

| ID | 项 | 处理 |
|---|---|---|
| R36 | 施单 05 §2 写的是 `ctx.llm.registerAdapter(...)` | `api.ts` 冻结、`Context` 上不会长出 `llm` 成员 → 按 00 §9「按键寻址」落地为服务键 `llm:adapters`（`provideLlm`）。语义等价：注册返回 disposer、重名必须显式 `replace` |
| R37 | 会话事件表 +2 键（`compaction/summary` / `usage/summary`）、`user/message.source` 追加 `runtime-context` | 施单 05 §5 要求摘要落账、§3 要求 usage 进审计，而事件表在 `session/types.ts`（阶段 4 白名单外）。**经人工授权**做最小增量：+2 键 + `derive.ts` +2 个空 case + source 联合 +1 值。`runtime-context` 与 `context` 必须分源，否则撤回旧上下文会顺手撤掉工具纠正文本 |
| R38 | 依赖面：`runtime` 增 `devDependency @bah/llm` + project reference；`llm` 增 `@bah/util` | 集成测试（`T-LLM-001`）与阶段 5 主循环都需要 `@bah/llm`；本阶段先作 devDependency，阶段 5 转正为 dependencies。无环：`runtime → llm → core/util` |
| R39 | `FinancialSummaryEntry.ticketId` 为可选 | 施单 05 §5 的接口草图是必填；但绿色直通调用**没有票据**，硬填等于伪造票号。改为可选 + `decision: 'not-required'`，并在类型注释写明 |
| R40 | 压缩摘要**不调模型**，由结构化折叠生成 | 确定性、零成本、可逐字回放（快照回放依赖这点）。模型生成散文摘要留作可选增强（扩展点在 `renderSummaryText`） |
| R41 | `T-LLM-001` 的「完整 turn」是脚本化驱动 | 主循环属阶段 5（`agent-loop`）。本阶段的驱动写在测试里、只用公开接缝（session + 七段管线 + 提示词 + mock adapter）；阶段 5 用真实主循环复跑同一 ID |
| R42 | 覆盖率名单扩容 | 新增 `llm`（整包）、`runtime/system-prompt/`、`runtime/compaction/`；`vitest.config.ts` 新增两个纯类型文件排除（`llm/src/llm/types.ts`、`runtime/src/compaction/types.ts`），理由同 `core/api.ts`：零可执行行会得到假 0% |
| R43 | `verify-no-hardcoded-limits` 门禁（施单 05 §5 提到）未实现 | 用等价约束替代：阈值只作为 `resolveCompactionConfig` 的入参（未知键 / 非正整数 / 一个阈值都没配 → 载入即抛）。门禁留到阶段 6（配置落 `bah.yml` 时才有静态扫描面） |

## 13. 阶段 4 待人工确认项

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| 1 | DeepSeek 真实流式未在本机实跑（无 `DEEPSEEK_API_KEY`） | e2e 面按设计自动 skip（无 key 时不收集用例），CI 仍绿 | 有 key 时跑一次 `pnpm test:e2e`，确认 `adapter.e2e.test.ts` 出文本且 usage 非零 |
| 2 | `assistant/message` 与 `tool/result` 的先后：施单 04 §7 的 T-LOOP-001 把 `assistant/message` 列在 `tool/result` **之后** | 本阶段脚本化驱动按 wire 合法性落账（assistant 带 toolCalls → tool/result），否则 OpenAI 兼容 wire 无法配对。**阶段 5 已照此实现**（见 §15 R44），仍待人工确认 | 阶段 5 与施单核对一次；若确实要求 assistant 在后，需同时说明 tool 消息如何配对。建议保留当前顺序并在 04 的测试表加注 |
| 3 | `usage/summary` 与 `@bah/llm` 的 `TurnUsage` 同形 | 靠 `T-LLM-004` 的编译期赋值断言钉住（字段漂移即编译失败） | 阶段 5 若给 `TurnUsage` 加字段，同步 `UsageSummaryData` |
| 4 | `api.ts` 的索引签名收窄（R27 遗留） | 仍未做（session 侧有编译期断言、派发侧有门禁） | 建议阶段 6「接缝总表冻结」时一次做完（走破坏性变更流程 + 全量快照） |

## 14. 阶段 5 出口清单（施工单 04 §0 + §8）

| # | 出口标准（§0） | 状态 | 证据 |
|---|---|---|---|
| 1 | 编程式装配（base bundle + llm-mock）跑通完整 turn，会话 JSONL 正确落盘 | ✓ | `T-LOOP-001`（2 例：事件序列 + 历史重建）；`T-LOOP-013`（真实 `session.jsonl`：header + 逐事件行，重开后 seq 一致、`deriveMessages` 结果与内存态全等） |
| 2 | 复刻检查表五条全部实现并有单测（§4） | ✓ | 失败补记 `T-LOOP-006`；max-tokens 粘性 `T-LOOP-007`；turn-stopping 是 serial `T-LOOP-008`（2 例）；两处取消不提交 system/user `T-LOOP-009`/`T-LOOP-010`；首个认领为空 `T-LOOP-011` |
| 3 | Inbox 认领、中断、转向、回退、人工接管五能力接口可用 | ✓ | `Inbox`（claim/nextStep/wakeDriver）+ `TurnAbort`（每 turn 一个 controller）+ `AgentLoop.steer/fork/dispose`；T-LOOP-003（唤醒新 turn）、T-LOOP-004（转向不新开 turn）、T-LOOP-005（中断）、T-LOOP-012（分叉）。人工接管是 `approval/request` 接缝（阶段 3 已验，主循环只负责把调用送进七段管线） |
| 4 | 失败 step 补记工具结果的单测存在且通过 | ✓ | `T-LOOP-006`：两个调用 → 执行完的有真实结果、未执行的补记 `isError/code=tool-interrupted`，`step/end` 照落、turn 不闭合（伪代码原样抛出） |

| # | 验收清单（§8） | 状态 | 证据 |
|---|---|---|---|
| 1 | §0 四条逐条核对 | ✓ | 见上表 |
| 2 | 复刻检查表五条对应单测全绿 | ✓ | `pnpm test` → **330 用例 / 39 文件**全绿 |
| 3 | `verify-event-modes` 门禁通过 | ✓ | `pnpm gate` → 5/5，`event-modes`：声明点 10 个、字面量派发点 11 个逐条比对 |
| 4 | agent-loop 目录行覆盖 100% | ✓ | `pnpm test:coverage` → `runtime/src/agent-loop` **Stmts/Branch/Funcs/Lines = 100 / 96 / 100 / 100**；全局 All files 行 100% |
| 5 | `bah --profile headless`（mock）端到端跑通（M1 出口） | ✗（延后） | CLI / profile / boot 属阶段 6；本阶段用 `T-LOOP-013` 的"真实 JSONL 落盘 + 重开投影"验证同一链路 |

**规格用例落点（T-LOOP-001~013，编号与期望逐条一致）**

| ID | 用例 | 文件 |
|---|---|---|
| T-LOOP-001 | 完整 turn（事件序列 / 历史重建） | `runtime/src/agent-loop/agent.test.ts`（2 例） |
| T-LOOP-002 | preStep reject → blocked，无 step | 同上 |
| T-LOOP-003 | inbox 有待处理 → wakeDriver 唤醒、新 turn | 同上 |
| T-LOOP-004 | steer → 当前 step 完成后立即认领、不新开 turn | 同上 |
| T-LOOP-005 | interrupt → `aborted`，信号传到 `llm/stream` | 同上 |
| T-LOOP-006 | step 中途抛错 → 补记 isError 的 `tool/result` | 同上 |
| T-LOOP-007 | max-tokens 粘性 | 同上 |
| T-LOOP-008 | turn-stopping（serial 顺序 / 停止决策） | 同上（2 例） |
| T-LOOP-009 | agent/request 阶段取消 → system/user 不落账 | 同上 |
| T-LOOP-010 | prepareCall 阶段取消 → 同上 | 同上 |
| T-LOOP-011 | 首个认领为空 → completed 且无 `step/start` | 同上 |
| T-LOOP-012 | 回退分叉（parentSession/seedLength、原会话只读） | `runtime/src/agent-loop/rollback.test.ts`（2 例） |
| T-LOOP-013 | JSONL 落盘 + `deriveMessages` 重建 | `runtime/src/agent-loop/agent.test.ts` |

**补充用例（无编号）**：`inbox.test.ts`（11）、`interrupt.test.ts`（5）、`request.test.ts`（14：投影/装配/冻结/与 `beginAttempt` 的提交一致性）、`tool-calls.test.ts`（8：坏参数不执行、失败补记观察口）、`agent.test.ts` 补充 15 例（配置 fail-loud、outcomeOf/sticky、step 上限、空转拒绝、注册表、dispose/并发、drive 常驻、inject、fork、模型解析失败、prepareCall 抛错/AbortError、流 aborted、pre-step 改写、默认时钟）。

**规模**：`pnpm test` **330 用例 / 39 文件**（阶段 4 为 260 / 33）；`pnpm check` 7/7、`pnpm gate` 5/5、`pnpm build` 12 包全绿。文档：新增 [docs/agent-loop.md](docs/agent-loop.md)。

**人工抽查点实跑**（README §3 阶段 5：抽 max-tokens 粘性与失败补记）：`pnpm exec vitest run -t T-LOOP-006` → `1 passed / 329 skipped`；`-t T-LOOP-007` → `1 passed / 329 skipped`。

## 15. 已知偏差与残留风险（阶段 5）

| ID | 项 | 处理 |
|---|---|---|
| R44 | 施单 04 §7 的 T-LOOP-001 把 `assistant/message` 列在 `tool/result` **之后** | 按 wire 合法性落账：带 `toolCalls` 的 assistant 消息先落，再 `tool/call` → `tool/result`。否则 `deriveMessages` 产出的历史是"tool 消息在前、assistant 的 tool_calls 在后"，OpenAI 兼容 wire 无法配对。**建议在 04 的测试表加注**（详见 §16 第 1 条） |
| R45 | 伪代码两处 `return false`（reject / 首个认领为空） | 改为 `break` 走到收尾段再 `turn/end`：照字面 `return` 会让 turn 永不闭合，与 T-LOOP-002/011 的"以 blocked / completed 关闭"直接冲突。这是**关闭动作**，不是重排。`turn()` 返回值由伪代码的 `boolean` 改为 `TurnEndReason`（驱动侧从未使用那个 boolean） |
| R46 | `agent/turn-stopping` 的"可返回停止决策" | 内核 `serial` 没有返回值通道（只顺序 await），落地为载荷里的 `stop(reason?)`：调用即让本 turn 不再继续，`reason` 写成 `turn/end.reason = {kind:'failed', reason}`，让"为什么停"在审计里可解释（施工单 10 §4 的 guard 判停可读） |
| R47 | `agent/pre-step` 的 `startsRequestSeries` | 类型与透传保留、本阶段不消费（插件线用它标记"新请求序列"，做风险分 / 压缩边界）；一条用例钉住"listener 设置它不会破坏 turn" |
| R48 | 主循环不内建降级链 | 降级 = `agent/request` 改路由 + `llm/stream` 环绕；`FallbackRunner` 仍是插件 / 阶段 6 可直接用的工具（它的链在构造期固定，与"请求阶段可改写路由"冲突） |
| R49 | 没有复用阶段 4 的 `beginAttempt` | 取消边界要求"提交晚于 `prepareCall`"，而 `beginAttempt` 在调用时就把 system/context/user 写进日志。改在 `agent-loop/request.ts` 实现 `commitAttempt`，并加一条**对照用例**逐条比对两者的落账形状（防两处实现漂移） |
| R50 | 依赖面：`runtime` 的 `@bah/llm` 由 devDependency 转正为 dependencies；新增 devDependency `@bah/persistence` + project reference | 主循环生产代码 import `@bah/llm`（词汇表 / 装配 / 账本）；T-LOOP-013 用 JSONL 后端验证落盘。无环：`runtime → llm / persistence → core / util` |
| R51 | `seams.ts` 追加 4 个接缝声明 | 施单 04 §5 说"本单只列、实现方挂接"，但 `verify-session-events` / `verify-event-modes` 只认 `seams.ts` 的声明，故做**纯声明增量**（不改 `api.ts`） |
| R52 | `AgentLoop.fork` 需要新的 `Context` | `runtime:session` 是服务键、一个应用承载一个会话（阶段 3 的装配方式），故分叉 = 新宿主上下文；`SessionApi` 上没有 `meta` 字段，`parentSession / seedLength` 由 `ForkInfo` 挂在 agent 上 |
| R53 | 参数不可用（坏 JSON / 根不是 object）的调用**不执行**工具体 | 直接落 `isError` 的 `tool/result`（`code: tool-args-invalid`，内容含原文）：主线只保证"配对上、有理由码"，模型下一 step 自我修复。阶段 4 的 `repairToolCall`（回灌 + 重试一次）留给插件线 / 阶段 6 接 |
| R54 | 未注册工具（模型幻觉工具名）仍 fail-loud 抛出 | 七段管线原本就这么设计（连 ① 都不进：调用没有一个可执行体）。模型可读的纠错属插件线（sentry 归一化），本阶段不吞错 |

## 16. 阶段 5 待人工确认项

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| 1 | T-LOOP-001 里 `assistant/message` 与 `tool/result` 的先后（R44） | 已按 wire 合法性实现（assistant 在前）并有测试锁定 | 请确认保留；若要按施单原顺序，需要同时给出"tool 消息如何与 assistant 的 toolCalls 配对"的方案（否则 DeepSeek / OpenAI 兼容 wire 会拒收） |
| 2 | `turn-stopping` 的判停语义（R46） | `stop()` 把 turn 记为 `failed{reason}` | 若希望"判停"记为 `completed` 或新增 `guard-stopped` 原因，需要扩 `TurnEndReason` 联合（属会话事件表增量，需授权） |
| 3 | 压缩只在 turn 边界判定 | 配置了 `compaction` 才跑；长 turn（多 step）内不会压缩 | 阶段 6 决定是否在 attempt 前也判一次（会引入"同一 turn 内折叠"的审计复杂度） |
| 4 | 分叉的宿主模型（R52） | 一应用一会话，分叉需新 `Context` | 若阶段 6 要"同应用多会话"，`runtime:session` 需改成按会话键寻址（破坏性变更流程 + 全量快照） |
| 5 | 真实 provider 的流式中断未在本机实跑（无 key） | `adapter.e2e.test.ts` 仍按设计 skip | 有 key 时跑 `pnpm test:e2e`，并手工验证一次"流到一半按停"（断言无 `assistant/message`、`turn/end.reason=aborted`） |

## 17. 阶段 6 出口清单（施工单 06 §0 + §7）

> 本阶段完成 = **底座出口达成**。

| # | 出口标准（§0） | 状态 | 证据 |
|---|---|---|---|
| 1 | `bah --profile headless` 可启动：base bundle + headless patch，用 llm-mock 跑通完整 turn | ✓ | `pnpm bah --profile headless --prompt 你好 --session s-demo` → 回复「已为你在模拟环境完成查询。」+ `sessions/s-demo/session.jsonl`（20 条事件，header + 逐事件行）。进程内同链路：`host/src/boot/plugins.test.ts`（真实 `HOST_PLUGINS`，工具调用 → 结果 → 收尾）；真仓库端到端：`cli/src/cli/run.test.ts`（JSONL 行数 = `lastSeq()+1`、`deriveMessages` 重建出 tool/assistant） |
| 2 | `--dump-config` 打印实际生效的插件树，任何一行可被上层 patch 替换 | ✓ | 三列 `id / 来源层 / 配置`，来源层形如 `bundle:base`、`profile-patch:profiles/headless/patch.yml`、`home-patch:…`、`overlay:…`。手工验收：`--patch` 覆盖 `core:model` 后该行来源层变 `overlay`，**旧 `chunkSize` 与旧脚本整体消失**（整块替换） |
| 3 | 四层层序正确（profile bundles → profile patch → home patch → `--patch` overlay），整块替换不深合并 | ✓ | `T-PRF-001`（home 盖 profile）、`T-PRF-002`（只写一个字段 → 旧字段整体消失、其余走插件默认值）、`T-PRF-003`（插入新行）；`cli/run.test.ts` 用真实四层文件端到端断言四种来源标注 |
| 4 | config-only 热重载：改配置不重启进程（base 开、headless 关） | ✓ | `T-PRF-007`（真实 `fs.watchFile` + 注入 watcher 两条路径：配置换新、`apply` 次数不变、派发 `bah/config-reload`、非法配置保留旧值并告警）、`T-PRF-008`（`hmr: false` → 不装任何监听） |
| 5 | `verify-plugin-config` 门禁通过 | ✓ | 门禁从骨架版升级为**四方一致**校验（`bah.yml` ↔ `packages/cli/package.json` 的 `bah.profile.bundles` ↔ `bundles/<name>/index.ts` ↔ `HOST_PLUGINS`），并校验 profile 清单与 patch 行（含 `use` 必须命中依赖清单）；`pnpm gate` 5/5 |

**底座出口（本阶段一并验收）**：`pnpm typecheck && pnpm test && pnpm gate` 全绿 ✓；headless mock turn 的 JSONL 可派生重建 ✓（`deriveMessages` 从文件重建出 user/assistant/tool 三类消息）。

| # | 验收清单（§7） | 状态 | 证据 |
|---|---|---|---|
| 1 | §0 五条逐条核对 | ✓ | 见上表 |
| 2 | `verify-plugin-config` 门禁通过 | ✓ | `pnpm gate` 5/5；两次负控（见下）均 exit 1 |
| 3 | headless profile 端到端（配合 04/05 的 M1 出口） | ✓ | 真实进程冒烟 `cli/src/main.smoke.test.ts`（`--profile headless --dump-config` 退出码 0、stderr 干净）；真仓库 turn 端到端见 §17 第 1 条 |
| 4 | dump-config 输出与文档示例一致（文档不腐） | ✓ | [docs/profile.md](docs/profile.md) §3 的示例与 `pnpm bah --profile headless --dump-config` 逐列一致（列宽自适应） |

**门禁负控实跑**（改完即还原，`git status` 无残留）：

- `bah.yml` 的 `profile.bundles` 加一个未声明的 `ghost` → 两条 findings（未在 package.json 声明 / 缺 `bundles/ghost/index.ts`），exit 1；
- `profiles/headless/patch.yml` 加一行 `use: ghost` → findings「`use` 指向的插件 `ghost` 不在依赖清单中（packages/host 的 `HOST_PLUGINS`）」并带行号，exit 1。

**规格用例落点（T-PRF-001~008，编号与期望逐条一致）**

| ID | 用例 | 文件 |
|---|---|---|
| T-PRF-001 | 层序覆盖（home patch 盖 profile patch 同 id 行） | `host/src/boot/profile-plugins.test.ts` |
| T-PRF-002 | 整块替换（patch 只写一个字段，其余走插件默认值） | 同上 |
| T-PRF-003 | 插入新行（无 id 冲突时生效） | 同上 |
| T-PRF-004 | 未知键 → 载入即抛 `bah-boot: ` | `host/src/boot/boot.test.ts` |
| T-PRF-005 | 引用缺失插件 → 载入即抛（同 verify-plugin-config 检查） | 同上（bundle 行与 patch 插入行两种形态） |
| T-PRF-006 | dump-config 含来源层标注 | `cli/src/dump-config.test.ts` + `cli/src/cli/run.test.ts` |
| T-PRF-007 | config HMR：改 patch → config 重载、插件代码不重载 | `host/src/boot/hmr.test.ts`（3 例） |
| T-PRF-008 | headless HMR 关闭：改文件无反应 | 同上（2 例） |

**补充用例（无编号）**：`profile-plugins.test.ts`（17：合并/插入/结构校验/差异比较/插件管理器）、`config.test.ts`（10：配置原语逐条 fail-loud）、`boot.test.ts`（13：装配顺序与 `inject`、boot injection、逆序回滚、启动失败回滚、reload 四种结局）、`plugins.test.ts`（10：真实插件集跑通 turn + 逐行配置校验表）、`cli/src/profile.test.ts`（17：profile/patch 解析、四层层序、BOM 容忍、bundle 加载）、`cli/src/cli/run.test.ts`（19：参数解析、退出码 0/1/2、真仓库端到端、事件流辅助函数）、`main.smoke.test.ts`（2：真实进程 `--help` / `--dump-config`）。

**规模**：`pnpm check` **7/7 全绿**；`pnpm test` **424 用例 / 47 文件**（阶段 5 为 330 / 39）；`pnpm gate` 5/5；`pnpm build` 12 包全绿；`pnpm test:coverage` → **All files 100% 行 / 95.99% 分支 / 98.6% 函数**，新增强制名单：`host/src/boot`（100/99.34/100/100）、`host/src/plugin-manager`、`cli/src/cli`、`cli/src/profile.ts`、`cli/src/bundles.ts`、`cli/src/dump-config.ts`（行覆盖均 100%）。文档：新增 [docs/profile.md](docs/profile.md)。

**人工抽查点实跑**（README §3 阶段 6：亲手 `--dump-config` + 改一行 patch 验证整块替换）：

- `pnpm bah --profile headless --dump-config` → 7 行，四层来源标注正确；
- `pnpm bah --profile headless --dump-config --patch .tmp-overlay.yml`（只写 `core:model` 的三个字段）→ 该行来源层 `overlay`，`chunkSize` 与旧脚本消失（整块替换生效）。

## 18. 已知偏差与残留风险（阶段 6）

| ID | 项 | 处理 |
|---|---|---|
| R55 | 根 `tsconfig.json` 增加 `compilerOptions.paths`（12 包 → `packages/*/src/index.ts`） | 让 `pnpm bah` 直接跑源码、**不依赖构建产物**——否则改完 `src` 忘了 `pnpm build` 会静默跑旧 `dist`（vitest 侧早有同类教训，见 `vitest.shared.ts` 的注释）。只影响 tsx / 编辑器解析；`tsc -b` 仍走各包 project references，发布面（`dist/`）不变 |
| R56 | `runtime/src/seams.ts` 追加 1 条**纯声明**（`bah/config-reload` + `ConfigReloadEvent` 类型） | "通知受影响插件重载 config"只能走事件系统；而 `verify-session-events` 只认 `seams.ts` / `session/types.ts` 的声明。**零逻辑改动**（无派发器、无管线改动、无 `api.ts` 改动），但仍越出"本阶段只动 cli/host/profiles/scripts"的字面范围 → 需签认（§19 第 1 条） |
| R57 | `packages/cli/tsconfig.json`：`rootDir: "."` + `include: ["src","bundles"]`；`exports.types` 改指 `dist-types/src/index.d.ts` | bundle 数据（`bundles/<name>/index.ts`）也要进 typecheck。副作用是声明产物多一层 `src/`；已实跑"删掉 `dist-types` 后重建"确认布局正确 |
| R58 | 施单 06 §5 第 3 步写 `host/src/plugin-manager.ts`，本仓落为 `host/src/plugin-manager/index.ts` | 遵循 00 §6「每个逻辑模块占一个 `src/<模块>/` 目录并从包入口导出」 |
| R59 | "profile 是 home 中的命名组合"在 M1 落地为仓库内 `profiles/<name>/` 模板；home 的 `bah.patch.yml` 只作第 3 层 | 本阶段不做 `bah profile add` 之类安装命令（属插件线/后续）；`--home` 可指向任意目录，层语义一致 |
| R60 | 依赖清单里带一个 `demo:echo` 示例工具（非银行业务） | headless 验收要证明"完整 turn 包含工具七段管线"，而银行工具族属插件线（08）。插件线可用自己的 bundle 覆盖/移除它 |
| R61 | 插入新行必须写 `use`（施单 06 §2 的示例只写 `id`） | 未知 id 无法绑定插件实现 → `row-without-plugin` 载入即抛；bundle 行可省略 `use`（默认 = `id`） |
| R62 | `core:model` 的 mock **必须**写 `script`；`core:agent` 的 `loop` 缺省 = `{model:'deepseek:deepseek-chat'}` | 前者：mock 没有真实模型，没脚本必然在第一次请求时炸，提前到载入期（`mock-script-missing`）；后者：profile 只写 `channel` 时主循环仍有可用默认值 |
| R63 | YAML / JSON 读入会去掉 UTF-8 BOM | Windows 记事本默认写 BOM，`yaml` 与 `JSON.parse` 都会直接报错；属"平台差异"，不是配置错误 |

## 19. 阶段 6 待人工确认项

| # | 项 | 现状 | 建议 |
|---|---|---|---|
| 1 | `seams.ts` 的事件声明增量（R56） | 已加 `bah/config-reload`（`@mode emit`）+ 类型 `ConfigReloadEvent` | 请确认接受；若不接受，替代方案是 host 侧回调（`BootOptions.onConfigReload`），代价是"插件无法自行订阅" |
| 2 | 根 `tsconfig.json` 的 `paths`（R55） | 已加，`pnpm bah` 因此免构建 | 请确认接受为常态；否则 `pnpm bah` 必须先 `pnpm build`，且存在"跑旧产物"风险 |
| 3 | `demo:echo` 是否留在 base 依赖清单（R60） | 已留 | 若插件线不希望底座带示例工具，可在插件线开工时从 `HOST_PLUGINS` 移除并同步 headless patch |
| 4 | profile 的"安装"模型（R59） | 仓库内模板 + `--home` 覆盖 | 若要"用户级安装 profile"，需在插件线定 `$BAH_HOME` 目录结构与版本策略 |
| 5 | 阶段 5 §16 的五条仍未闭环（T-LOOP-001 顺序 R44、`stop()` 语义 R46、压缩时机、一应用一会话 R52、真实 provider 中断） | 本阶段实现不依赖这些决议 | 建议插件线开工前一并拍板（尤其 R44 与 R46 会影响审计导出与 guard 判停的形状） |
| 6 | 真实 provider（`provider: deepseek`）只做了启动期验证 | 无 `DEEPSEEK_API_KEY`，`pnpm test:e2e` 仍按设计 skip | 有 key 时跑 `pnpm bah --profile <真实 provider profile> --prompt …` 并保留 JSONL 作为验收证据 |


