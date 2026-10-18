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
