# BAH MonoRepo 三视角代码审查报告

- **审查日期**：2026-10-19
- **审查对象**：`D:/项目集/微众杯银行ai智能体/BAH/MonoRepo`（pnpm + TypeScript monorepo）
- **代码规模**：13 个包、约 5.5 万行源码 + 约 2.2 万行测试
- **审查视角**：① 代码质量与可维护性 ② 功能正确性与边界条件 ③ 安全性与性能表现
- **严重程度定义**：Critical（必须立即修复，存在资金/安全/数据风险）· High（应尽快修复，影响正确性或可维护性根基）· Medium（计划内修复）· Low（择机改进）

---

## 0. 执行摘要

### 0.1 总体判断

该仓库工程纪律执行度**显著高于同规模项目平均水平**：错误形态统一（`BahError(code, message, detail)` + kebab-case 理由码）、注册即可逆（`effect()/on()` 返回 disposer）执行一致、全仓 0 处 `as any`、封闭联合普遍以 `assertNever` 收尾、票据五绑定同步 CAS 核销、金额全程整数「分」、saga 逆拓扑补偿 + 屏障 + 确定性退避、JSONL 崩溃容忍语义正确，且多为行为级场景测试（含子进程杀进程恢复用例）。

主要风险不在"代码写得烂"，而在**三类结构性裂缝**：

1. **交付物与版本库脱节**：约 7000+ 行已验收的安全层代码（sentry 内核、沙箱运行时）处于 untracked 状态，随时可丢失；
2. **异步/并发边界不严谨**：强验证提交非原子、错误码在管线边界被压扁、emit 记账可抛错引发账实不符、取消不传播；
3. **安全能力"内核完整、接线不全"**：PII 脱敏已实现但未接到业务落盘路径、沙箱 worker 通道尚差宿主接线、会话路径未防穿越、LLM 调用无超时。

### 0.2 必须立即处理的 5 项（P0）

| # | 问题 | 视角 | 位置 |
|---|------|------|------|
| 1 | sentry/sandbox 约 7000+ 行已交付代码未入 git | 质量 | `packages/safety/src/sentry/{kernel,pipeline}/`、`sandbox-runtime/*` |
| 2 | 会话目录路径穿越（`--session`/`--jsonl` 无校验） | 安全 | `packages/cli/src/cli/run.ts:136`、`host/src/boot/plugins/persistence.ts:58` |
| 3 | 强验证 `submit` 并发竞态：可绕过三连败锁定、已消费挑战可复活 | 正确性 | `packages/bank/src/verify/index.ts:141-218` |
| 4 | 工具异常错误码被压扁成 `tool-failed`，审计与自愈失明 | 正确性 | `packages/runtime/src/tools/pipeline.ts:128-134` |
| 5 | LLM HTTP 调用无超时/无 deadline，上游挂起即无限等待 | 安全/性能 | `packages/llm/src/deepseek/adapter.ts:159-206` |

---

## 1. 视角一：代码质量与可维护性

### 1.1 Critical

#### Q-C1 · 已声称交付的核心安全代码全部未入版本控制
- **位置**：`packages/safety/src/sentry/kernel/`、`packages/safety/src/sentry/pipeline/`、`packages/safety/src/sandbox-runtime/{language,modules,protocol,registry,runner,worker}.ts` 等 21 个 untracked 路径（已实测核实：`git ls-files packages/safety/src` 仅 4 个 `index.ts` 被跟踪）
- **问题**：`PROGRESS.md:21` 已勾选 `[x]`「批次 A+B 已交付」，代码确实存在且已接入调用链（`host/src/boot/plugins/sentry.ts` 已注册进 `HOST_PLUGINS`，运行会话中已见 `sentry/detected` 事件），但整个 sentry 内核、四接缝管线、沙箱运行时**均未提交**。另有 `packages/knowledge/`、`services/rag/` 两个未登记的新增交付面。代码可随时丢失，CI 绿灯与真实入库状态脱节。
- **建议**：立即 `git add` 并提交全部已交付源码；在 `scripts/run-gates.ts` 增加门禁——`PROGRESS.md` 勾选 `[x]` 的模块必须在 `git ls-files` 中存在对应目录，防"文档先行、代码未入库"。
- **优先级**：**P0**

#### Q-C2 · saga 状态机对未知事件静默吞掉，与内核纪律相悖
- **位置**：`packages/saga/src/state-machine/reduce.ts:111`（`default: return projection`）；对照正确示范 `packages/runtime/src/session/derive.ts:191-198`（抛 `BahError('session-unprojected-event')`）
- **问题**：`reduceSaga` 的判别联合 switch 用 `default` 静默忽略未知 saga 事件——新事件类型加入后状态机不推进也不报错，补偿/收敛视图悄悄失真。同仓 `derive.ts` 对同一纪律执行 fail-loud，两处口径不一致。saga 是资金补偿属主，**静默失真比崩溃更危险**。同文件 `:141` `stepStateOfRecovery` 的 `default: return 'PLANNED'` 同病。
- **建议**：`default` 改为 `assertNever(event)` 或抛 `BahError('saga-unreduced-event', …)`（保留事件名进 detail），与 `derive.ts` 对齐。
- **优先级**：**P0**

### 1.2 High

#### Q-H1 · `session.append` 三处逐字复制 + `as unknown as` 类型逃逸
- **位置**：`packages/host/src/boot/plugins/approval.ts:137-144`、`bank-tools.ts:298-310`、`sentry.ts:92-99`（均为 `appendIgnorable`）
- **问题**：三个插件各自复制同一段"把 `session.append` 断言成宽松签名"的代码。根因是 `SessionSink.append`（`runtime/src/session/service.ts:22-27`）签名限定 `S extends SessionEventType`，领域事件族（`ticket/issued`、`sentry/*` 等）不在事件表内，只能靠 `as unknown as` 逃逸——落盘事件的 `data` 形状完全无编译期校验，字段写错只在回放/审计时暴露。
- **建议**：在 `SessionSink` 增加合法通道 `appendDomain(type: string, data: unknown, options: { ignorable: true })`（或重载）；删除三处重复的 `appendIgnorable`，host 侧只留一份；或把领域事件正式纳入 `SessionEventMap`。
- **优先级**：P1

#### Q-H2 · 泛型 `any` 擦除工具/插件契约类型
- **位置**：`packages/runtime/src/tools/registry.ts:14,31,46,60`、`runtime/src/tools/pipeline.ts:199,211`、`bank/src/tools/catalog.ts:19,46`（`ToolDefinition<any, any>`）；`core/src/plugin.ts:28`、`host/src/plugin-manager/index.ts:40,44,67,117`（`PluginV2<any>`）
- **问题**：全仓零 `as any`（值得肯定），但注册表层用 `ToolDefinition<any, any>` 把 `api.ts:322` 声明的泛型完全擦掉，`get()` 返回后调用方拿到的 args/result 是 `any`，判别与检查全部失效。`registry.ts:31` 的 `definition as ToolDefinition<any, any>` 是典型断言逃逸。
- **建议**：定义 `type AnyToolDefinition = ToolDefinition<unknown, unknown>`，注册表存 existential 形态、`register` 处用泛型收窄；`PluginV2` 同理引入 `AnyPlugin`。
- **优先级**：P1

#### Q-H3 · 审批链路吞掉原始错误对象
- **位置**：`packages/interaction/src/approval/service.ts:127-129、251-256`、`approval/headless-responder.ts:65-67`
- **问题**：`catch { return this.settleNow(input, { decision: 'unavailable', reason: 'approval-request-failed' }, …) }` 丢弃被抛错误本身——`BahError` 的 code/message/detail 全部丢失，排障只剩"审批请求失败"四字。`:251` 的 `void Promise.resolve(attached).catch(() => …)` 连错误参数都不接。违反 AGENTS.md 第 5 条精神（理由码有了，上下文被抹掉）。
- **建议**：catch 绑定 error，用 core 已有的 `describeThrown(error)` 落入 detail 或 reason 后缀；`catch(() => …)` 改 `catch((error) => …)` 并记审计。
- **优先级**：P1

#### Q-H4 · saga-store 行映射零校验断言 + 上帝文件/上帝接口
- **位置**：`packages/persistence/src/saga-store/index.ts:111-114`（`str`/`num`/`optStr`/`optNum`）、`mapTransaction`；接口 `SagaTxHandle`（:74-105，30 个方法）
- **问题**：`const str = (value: unknown): string => value as string` 是零校验断言，`state: str(row['state']) as SagaState` 双重断言把 sqlite 行直接铸成领域联合；`optStr` 对 sqlite 常见的 `undefined` 会漏判。该文件 912 行，SQL、迁移、行映射、vault、幂等全在一起，两接口合计 50+ 方法，实现方必须全量实现。
- **建议**：断言助手换成 `readString/readNumber`（失败抛 `BahError('invalid-row', …, { column })`）；`SagaTxHandle` 按 Transaction/Step/Idempotency/Dlq/Vault 五个窄接口拆分；行映射拆到 `row-mappers.ts`。
- **优先级**：P1

#### Q-H5 · 配置校验函数在 5 个包各自复制实现
- **位置**：`bank/src/tools/args.ts:95,147`、`host/src/boot/config.ts:44,126,148,194`、`safety/src/sentry/pipeline/config.ts:357,376,413`、`saga/src/settings.ts:70,93`、`cli/src/profile.ts:283`
- **问题**：`readBoolean`/`readPositiveInteger`/`readEnum`/`rejectUnknownKeys` 同名同语义函数至少 5 处独立实现，参数顺序、错误前缀、默认值处理已出现漂移。
- **建议**：下沉到 `@bah/util` 作为唯一配置校验面，各包 re-export；加门禁禁止 `function readBoolean` 出现在 util 之外。
- **优先级**：P1

#### Q-H6 · 违反"插件不硬编码可调项"：环境变量与 sessions 路径写死
- **位置**：`host/src/boot/plugins/model.ts:131`（`process.env['DEEPSEEK_API_KEY']`）；`saga.ts:30`、`saga-audit.ts:36`（`resolve(process.cwd(), 'sessions')`）对照 `persistence.ts:41,79`（`root` 可配置）
- **问题**：AGENTS.md 第 4 条要求随部署变化的取值都是校验过的 Config 字段。模型插件直读环境变量名写死；saga 两个插件把链根目录写死为 `<cwd>/sessions`，而 persistence 的 `root` 可配置——部署一旦改 `root`，saga 链与会话日志立刻分家且无校验提示。
- **建议**：`DEEPSEEK_API_KEY` 来源进 `ModelSettings` 并校验；saga/saga-audit 的 `CHAIN_ROOT` 与 persistence 共享同一 `resolveChainRoot(config)`。
- **优先级**：P1

### 1.3 Medium

| # | 问题 | 位置 | 建议 | 优先级 |
|---|------|------|------|--------|
| Q-M1 | alert `fanout` 空 `catch {}`、无失败计数；`chainBreakCount` 把任何异常等价于"链断" | `saga/src/alert/index.ts:213、181、175` | 加 `sinkErrors` 计数器暴露给 SLO（对照 `safety/…/trace.ts` 的 `counters.sinkErrors` 先例）；区分"报断"与"抛错" | P2 |
| Q-M2 | 票据指纹算法双实现（bank / runtime 各一份），无共享测试钉一致性 | `bank/src/tools/fingerprint.ts:11-31` vs `runtime/src/tools/guard.ts:48-67` | 抽到 `@bah/util`；抽离前至少加交叉测试断言两侧输出逐字相等 | P2 |
| Q-M3 | `estimateEventTokens` 对未知事件 `default: return 0`（压缩水位被系统性低估）；多处 statement 型 switch 缺 `assertNever` | `runtime/src/compaction/summarize.ts:116`、`safety/src/sandbox-runtime/runner.ts:252`、`bank/src/forge/index.ts:93` 等 | default 改抛错/`assertNever`；统一补收尾 | P2 |
| Q-M4 | commit 段用 `as unknown as` 假设未声明的可选能力（`beforeCommit`/`beginDeferred`） | `saga/src/coordinator/commit.ts:24-44` | 把可选能力声明进 `SagaStore`/`SagaAudit` 接口（`?` 方法），删两个断言 | P2 |
| Q-M5 | 魔法数字散布：分页上限、百分比口径 4 处手写、时区偏移未命名 | `bank/src/core/mock.ts:129,166`、`tools/queries.ts:151,348,378`、`presenters.ts:77`、`forge/risk.ts:116` | 在 `core/model.ts` 补 `toPct()` 与 `PAGE_LIMIT_MAX`/`CN_TZ_OFFSET_MS` 等命名常量 | P2 |
| Q-M6 | `noUncheckedIndexedAccess` 被 `x[0] as string` 索引断言系统性逃逸（约 15 处） | `bank/src/tools/queries.ts:359,395`、`persistence/src/chain/index.ts:279,285`、`safety/…/language.ts:93,97,133` 等 | 统一非空收窄或抽 `at(values, i)` 工具；可空场景显式写 `\| undefined` | P2 |
| Q-M7 | 测试通过 `as unknown as` 窥探/改写私有状态（测实现而非行为，全仓 21 处） | `safety/src/sandbox-policy/policy.test.ts:33-40`、`runtime/src/session/store.test.ts`、`agent-loop/inbox.test.ts` | 优先走公开行为构造（坏配置/过期时钟/损坏输入流）；用导出测试钩子 | P2 |
| Q-M8 | 覆盖率强制名单缺 `saga`——9900 行资金补偿路径证据强度反而是全仓最弱一档；`args.ts`/`presenters.ts` 无直接用例 | `scripts/coverage-allowlist.ts`、`bank/src/tools/{presenters,dto,specs,args}.ts` | allowlist 增补 `saga` 的 coordinator/compensation/state-machine；补 fail-loud 与卡片形态用例 | P2 |
| Q-M9 | 无 lint 工具链；`noImplicitReturns`/`noFallthroughCasesInSwitch` 未启用 | 仓库根（无 eslint/biome）、`tsconfig.base.json` | 引入 oxlint 或 eslint（先开 `no-floating-promises`、`consistent-type-assertions`、`no-explicit-any`）接入 `scripts/ci.ts`；tsconfig 补两项 | P2 |
| Q-M10 | 上帝文件聚集：7 个源文件超 500 行 | `runtime/src/agent-loop/agent.ts`（824 行，状态机+配置解析混放）、`safety/…/config.ts`（537）、`saga/src/compensation/index.ts`（628）、`bank/src/tools/queries.ts`（547） | `agent.ts` 拆出 `config.ts`；sentry 规则表拆 `rules-builtin.ts` | P2 |

### 1.4 Low

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| Q-L1 | `.gitignore` 未覆盖 `.tmp-*/`、`*.check.txt`、`snapshots/` | 根 `.gitignore:1-16` | 追加忽略项；清理现有 `.tmp-sentry-m2/m3` |
| Q-L2 | `verify-event-modes` 门禁在事件总表冻结前是骨架空转（CI 绿灯对该纪律是假保护） | `scripts/verify-event-modes.ts:8-9` | 在 PROGRESS 出口清单升格为带负责人的显式条目，冻结后收紧 |
| Q-L3 | profile/bundle 解析用链式 `as` 代替校验（`record['use'] as string`） | `cli/src/profile.ts:214,260,279`、`bundles.ts:43-47` | 改用统一校验面的 `readString(value, 'use', where)` |
| Q-L4 | 领域理由码字符串无常量表（20+ 处裸 string） | `interaction/src/approval/service.ts:121-232` | 定义 `type ApprovalReason` 联合 + `satisfies` 校验表 |
| Q-L5 | 测试夹具 `testing.ts` 混入 src 并进入 dist-types（依赖 devDependency） | `bank/src/tools/testing.ts`、`bank/dist-types/tools/testing.d.ts` | 迁到 `@bah/test-support` 或发布配置 exclude |

### 1.5 已核查、未见明显问题

- `as any`/`@ts-ignore` 滥用：全仓 0 处 `as any`；`@ts-expect-error` 仅用于钉类型不变量的负控测试（正确用法）
- 注册即可逆纪律：`LlmAdapterRegistry.register`、`ctx.effect(ctx.provide(...))` 等执行一致
- 错误形态统一：全仓 `BahError(code, message, detail)` + kebab-case 理由码，无 `throw 'x'`
- 模块分层与循环依赖：依赖图干净（core←util；业务包只依赖 core+util；host 顶层装配），未见跨包越界或循环
- 长函数控制：>150 行函数全仓仅 1 个（`createControlListener` 173 行）
- 测试规模与结构：约 2.2 万行测试，场景化验收（`acceptance.test.ts`、`recovery-kill.test.ts` 子进程杀进程）质量高
- 文档同步机制：`docs/tool-catalog.md` 由生成器产出 + 门禁逐字比对；`docs/sandbox.md` 对未完项诚实标注

---

## 2. 视角二：功能正确性与边界条件

### 2.1 Critical

#### F-C1 · 强验证并发提交可绕过"三连败锁定"，挑战状态机非原子
- **位置**：`packages/bank/src/verify/index.ts:141-218`（`VerifyService.submit`）（已实测核实）
- **问题**：`const attempt = challenge.attempts + 1` 在 `await this.provider.verify(...)` **之前**读取，异步返回后用**过期的 challenge 对象**做 `replace(challenge, { attempts: attempt })`（全量覆盖 `{ ...challenge, ...patch }`）。两次并发提交都会读到 `attempts=0`、都以 `attempt=1` 结算：失败计数互相覆盖，`maxAttempts=3` 的锁定阈值永远凑不齐；更糟的是若第一次已 `status:'passed'`，第二次失败路径会把 `status` 从 `passed` 写回 `pending`（stale spread）——**已消费的挑战被复活**。
- **建议**：在 `provider.verify` 之前同步占位（先 `attempts+1` 落库，或引入 per-challenge `inFlight` 标志拒绝并发提交 `challenge-busy`）；`replace` 改为基于 Map 当前值的定向 patch（只改 `attempts`/`status`，不回写旧快照）；补两条并发用例（并发失败不重置计数、通过后不可复活）。
- **优先级**：**P0**

### 2.2 High

#### F-H1 · 工具执行异常的结构化错误码被压扁成 `'tool-failed'`
- **位置**：`packages/runtime/src/tools/pipeline.ts:128-134`（已实测核实）
- **问题**：`catch (error) { isError = true; code = 'tool-failed'; ... }` 丢弃 `BahError.code`。银行工具抛出的 `ticket-binding-mismatch`/`insufficient-balance`/`amount-invalid` 到 `tool/result` 全部变 `tool-failed`。连锁影响：① `governance.ts:238` 记账 `result.code ?? 'tool-failed'` 使票据账本 `blockedReason` 永远是 `tool-failed`；② 模型自愈与审计聚合失去错误分类。而 `reject()` 路径保留 `verdict.code`，两条路径口径不一致。bank 测试走 `createBankHarness.call` 直调 `tool.execute` 绕过管线，该丢失从未被覆盖。
- **建议**：`catch` 中改为 `code = error instanceof BahError ? error.code : 'tool-failed'`；补走 `createPipelineHarness` 的用例断言 `result.code === 'ticket-binding-mismatch'`。
- **优先级**：**P0**

#### F-H2 · 模型幻觉工具名 / 记账监听器抛错会击穿 turn 状态机，`turn/end` 不落账
- **位置**：`runtime/src/tools/pipeline.ts:90`（`registry.get` 直接抛 `tool-missing`，不在归一化 try 内）、`runtime/src/agent-loop/agent.ts:662-682、493-505`
- **问题**：`ToolPipeline.execute` 第一行对未知工具名抛 `tool-missing`，异常一路逃出 `turn()`——`turn()` 只有 `finally { this.abort.end() }`，`session.append('turn/end', …)` **被跳过**，与 `docs/agent-loop.md`「turn/end（reason 必落）」直接矛盾。工具名是不可信输入（幻觉/重复 callId 真实存在），一次幻觉即让会话日志出现未闭合 turn，`forkSession` 也无法以该 turn 为回退边界。
- **建议**：`pipeline.execute` 把 `tool-missing` 归一化为 `isError` 结果（与 `invalidArgumentsResult` 同款）；`turn()` 的 while 循环外套 try/catch，逃逸异常先落 `turn/end {kind:'failed'}` 再抛。
- **优先级**：**P0**

#### F-H3 · `tools/result` 的 emit 记账可抛错：资金已动、日志记失败（账实不符）
- **位置**：`packages/bank/src/tools/governance.ts:229-248`（`tools/result` 监听器）、`:215-223`（`lifecycle?.block` 不在 try 内）
- **问题**：`tools/result` 是同步 emit 事件，监听器里 `lifecycle?.redeem/consume/block` 一旦抛 `ticket-unknown`/`ticket-closed`（`ticket-ledger.ts:187-195、226-232` 会抛），异常炸穿 `pipeline.ts:184` 的 emit——此时 `createTransfer` 已扣款、票据已 redeemed，但 `ToolCallRecovery` 会把该调用补记成 `isError / tool-interrupted`：**资金已动、日志记失败**。触发路径真实存在（`approval/request` 的 else 分支 `lifecycle?.block` 未捕获）。
- **建议**：governance 所有 `lifecycle?.*` 调用包 try 并降级为审计告警（记账失败绝不影响主流程与 core 状态）；`tools/result` 监听器整体 try/catch；补"core=redeemed + lifecycle 抛错"回归用例，断言 `tool/result` 仍为成功。
- **优先级**：**P0**

#### F-H4 · `purchaseWealth` 缺账户状态校验：冻结/销户账户仍可购买理财
- **位置**：`packages/bank/src/core/mock.ts:285-335`（已实测核实：只校验归属/金额/产品/起投额/余额，无 `status !== 'active'`）
- **问题**：`createTransfer` 明确校验 `account.status !== 'active'` 即拒（`:225-230`），而 `purchaseWealth` 缺失该检查——`frozen`/`closed` 账户都能扣款买理财。`docs/bank.md` §4 写明写操作校验顺序「账户存在/**状态** → 金额 → …」，实现与文档不符。工具层 `wealth.ts:129-151` 与 `governance.checkWealthPurchase` 也未兜底。
- **建议**：补与 `createTransfer` 相同的 `status !== 'active'` 检查（`account-inactive`）；测试补"frozen 账户购买被拒、票据不消耗"。
- **优先级**：P1

#### F-H5 · 取消传播不完整：中断后批次内剩余工具（含写操作）继续执行
- **位置**：`runtime/src/agent-loop/agent.ts:662-682`（`runToolCalls` 串行循环不查 `signal.aborted`）、`runtime/src/tools/pipeline.ts:89-121`（`execute` 全程不查 signal）
- **问题**：用户 `interrupt()` 后，同批后续的 `transfer_create` 照常完成审批与扣款。全库只有 `queries.ts:475-477` 的 `runBoundedCompute` 与 llm 流尊重 signal。
- **建议**：`runToolCalls` 每次迭代前检查 `signal.aborted` 并以 `tool-interrupted` 结束剩余调用；`pipeline.execute` 在执行段前增加取消短路；写操作工具体执行中不打断（保原子性），但入口要挡。
- **优先级**：P1

### 2.3 Medium

| # | 问题 | 位置 | 建议 | 优先级 |
|---|------|------|------|--------|
| F-M1 | `ApprovalService.dispose()` 对 `await next(input)` 期间的审批失效，产生孤儿 pending（审批永悬到超时） | `interaction/src/approval/service.ts:118-151、163-259` | `handle` 入口即注册占位或引入 `disposed` 标志，`arbitrate` 前检查并立即 `cancelled` | P1 |
| F-M2 | 日限额语义撕裂：预检 `verdict:'block'` 与执行"不拦截、仅升红"矛盾；风控用 `dailyLimitOf()`（仅卡限）而 tier 用 `min(卡限, Config)`，口径不一致 | `forge/risk.ts:47-60`、`tools/governance.ts:371-376`、`core/mock.ts:222-283`、`tools/tier.ts:115-118` | ① daily-limit severity 降 `warn` 并同步文档，或写路径强制复核；② 风控入参日限额改与 tier 同源 `min(卡限, Config)` | P1 |
| F-M3 | 幂等只覆盖"票据重放"，不覆盖语义级重复转账（双 callId 双扣款） | `core/mock.ts:222-283`、`tools/tickets.ts:33-59` | 增加可选幂等键（fingerprint+TTL 窗口），或 `previewTransfer` 对"同收款人同金额 N 分钟内已有成功流水"返回 `duplicate-warning` | P1 |
| F-M4 | `mapPool` 的 `Promise.all` 快速失败后，其余补偿分支成孤儿写入（可能改写已收敛终态 + unhandled rejection） | `saga/src/coordinator/index.ts:79-93`、`compensation/index.ts` | 改 `allSettled` + 聚合后统一抛出（或 AbortController 取消兄弟分支）；先收集全部结果再收敛 | P1 |
| F-M5 | JSONL `readHeader` 只扫 4096 字节：大 meta 的会话无法重开 | `persistence/src/jsonl/backend.ts:64-65、202-223` | 按行读取（读到首个 `\n`）而非定长扫描；或 create 侧显式上限校验 `session-meta-too-large` | P2 |
| F-M6 | `yuanToCents` 浮点舍入误差（`1.005`→100 分而非 101）+ 不校验安全整数；票据金额"分→元→分"双重换算靠 round-trip 碰巧相等 | `core/model.ts:56-63`（已实测核实 `Math.round(value * 100)`）、`tools/governance.ts:321、413-415` | 金额参数先按字符串校验 ≤2 位小数再换算（或 `+ Number.EPSILON`）并显式测 1.005/0.615；末尾加 `Number.isSafeInteger` 断言；票据 draft 直传 `amountCents` 删元中转 | P1 |
| F-M7 | `txn_query` 分页三处不一致：direction 在分页后过滤（每页缩水）、`nextCursor` 返回但入参只收 `page`、越界无提示 | `tools/queries.ts:150-173`、`core/mock.ts:117-134` | direction 下推 core 查询；游标直收或去掉 `nextCursor`；排序键加 `id desc` 稳定序 | P2 |

### 2.4 Low

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| F-L1 | `UsageLedger.record` 不校验 usage 数值，NaN/负数静默入账；`turns` Map 跨 turn 只增不减 | `llm/src/llm/usage.ts:33-44` | record 入口校验 `Number.isFinite`/非负；finishTurn 后裁剪已完成 slot |
| F-L2 | `shiftMonth` 不校验月份区间（`2026-13` 静默算进相邻账期），与 `core/time.ts:parsePeriod` 口径不一致 | `bank/src/tools/time.ts:52-63` | 复用/统一 `parsePeriod` 的月份校验 |
| F-L3 | `assertExecutableNow` 错误码/文案误导（过去时间落 `tool-args-invalid`，文案却说"只能是 now 或未来"，未来反而抛 `unsupported-schedule`） | `bank/src/tools/inputs.ts:62-73` | 过去时间单独给 `when-in-past` 码与文案 |
| F-L4 | `stableStringify` 把 `NaN/Infinity/undefined` 归一为 `null`，指纹存在碰撞面 | `bank/src/tools/fingerprint.ts:16-30` | 非有限数显式标记或直接拒绝 |

### 2.5 已核查、未见明显问题

- **票据状态机本体**（`core/ticket.ts`）：`issued→approved→redeem|blocked` 无非法出边；`redeem` 先查后转且全程无 `await`，单线程 CAS 原子；绑定五元组逐项比对带 `detail.field`；并发双花有用例钉住（两并发 `createTransfer` 只成功一笔）
- **金额主口径**：账本/日累计/票据绑定全链路整数「分」；零金额/非整数分/负数 fail-loud 且有测试覆盖
- **时区/账期**：固定 UTC 切日、夜间大额固定 UTC+8；`periodRange` 半开区间，跨年 `previousMonth` 正确
- **saga 补偿骨架**：逆拓扑分层（含环防御）、barrier 结构性拦截乱序、重试硬停进 DLQ、退避用 seeded 随机、幂等键不含 attempt——设计扎实（F-M4 是其并发收尾缺口）
- **waterfall 纪律**：governance 两处挂点均 `await next()` 后返回或按文档短路；事件链长 32 级防自循环
- **JSONL 崩溃恢复**（除 F-M5）：尾行截断容忍、中间行损坏 fail-loud、分代文件 `wx` 排他发布、格式版本超前拒开；`deriveMessages` 对日志空洞报 `session-log-hole` 不静默合成
- **会话回退分叉**（`rollback.ts`）：原会话只读、种子取到 `turn/end`、`fork-turn-missing` fail-loud

---

## 3. 视角三：安全性与性能表现

### 3.1 前置核实：PROGRESS.md 状态说明

`PROGRESS.md:21` 当前记载 sentry「批次 A+B 已交付」并勾选 `[x]`，代码侧证据（`sentryPlugin` 注册进 `HOST_PLUGINS`、四接缝 `ctx.events.on` 挂载、运行会话已见 `sentry/detected` 事件）证实**注入防御与熔断确实已进入调用链**。但沙箱接线仍未完成（见 S4），且全部安全层源码未入版本控制（见 Q-C1）。

### 3.2 安全性

#### Critical

**S1 · 会话目录可路径穿越（`--session` / `--jsonl` 无校验）**
- **位置**：`packages/cli/src/cli/run.ts:136`（`as SessionId` 无校验，已实测核实）、`host/src/boot/plugins/persistence.ts:58`（`join(root, String(sessionId))`）、`persistence/src/jsonl/backend.ts:97-98`（`mkdirSync` + 写文件）
- **问题**：CLI `--session` 参数取出后只做类型断言，无字符白名单，直接拼进路径并 `mkdirSync`+`writeFileSync`。传 `--session ../../../etc/cron.d` 即可在 `root` 之外建目录写文件。对比 `persistence/src/chain/chain-file.ts:166-169` 有 `assertSagaId`（模式 + 拒 `..`），说明作者意识到该风险但**会话侧漏做**。
- **建议**：`run.ts` 与 `dirOf` 处增加与 `assertSagaId` 同款 ID 白名单（`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`）并显式拒 `..`；`root`/`jsonlDir` resolve 后校验仍在允许根下。
- **优先级**：**P0**

#### High

**S2 · LLM HTTP 调用完全无超时/无 deadline**
- **位置**：`packages/llm/src/deepseek/adapter.ts:159-206`（`stream()`）、`packages/llm/src/llm/route.ts:71-114`（`FallbackRunner.run`）
- **问题**：`stream()` 只透传调用方 `AbortSignal`，整个读流 `while(true)` 无时间上限；`FallbackRunner` 降级链同样只查 `signal.aborted`。全仓 `AbortSignal.timeout|timeoutAfter|requestTimeout` 在 llm/runtime 下零命中。上游挂起时 agent 无限等待，只能靠用户手动中断。
- **建议**：`prepareCall`/`stream` 入口合成 `AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])`，超时值进 Config；对"首分片超时"和"流中静默超时"分别设阈值。
- **优先级**：**P0**

**S3 · PII 脱敏能力已实现但未进入调用链，客户数据明文落盘**
- **位置**：`packages/safety/src/sentry/kernel/pii.ts:76,102-128`（`maskValue`/`tokenize`，仅 safety 内部使用）、`bank/src/tools/accounts.ts:64-69`（唯一业务侧脱敏 `tailOf`）、`persistence/src/chain/vault.ts:138`（只打分类标签）
- **问题**：sentry 内核有完整 PII 代币化（全量替换、掩码、泄露检测），但调用方全在 `safety/src/sentry/**` 内部，bank/persistence/runtime 无一处调用。实测 `sessions/` 会话日志中 `tool/call` 落盘 `{"args":{"amount":50000,"payee":{"name":"王建国"}}}`，`user/message` 落盘用户名——收款人姓名、金额、用户名全部明文。
- **建议**：在 persistence 的 `encodeJsonLine` 前挂 PII 管线（复用 `kernel/pii.ts`），或至少对 `tool/call.args`、`user/message`、`tool/result` 三类事件做字段级掩码（姓名→姓+**，账号→尾4，手机→138****1234）。
- **优先级**：**P0**

**S4 · `analysis_calc` 仍在进程内执行模型生成代码，沙箱未接线**
- **位置**：`packages/bank/src/tools/compute.ts:49-51`（`defaultCompute` 自注"进程内通道"）、`tools/queries.ts:19,250-262`（生产装配直接使用）
- **问题**：沙箱运行时（`sandbox-policy`/`sandbox-runtime`）已落地但宿主行 `safety:sandbox` 未接——生产装配里 `analysis_calc` 走进程内 AST 解释器。缓解：已做无 `eval`/`Function`、`MAX_CODE_LENGTH=2000`、`maxOperations` 预算、timeout 检查点，所以不是任意代码执行；但超时是协作式（忙循环靠运算预算兜底），无堆上限、无硬杀。
- **建议**：补 `safety:sandbox` 宿主插件行（提供 `BANK_COMPUTE` 服务键），让 `queries.ts` 经 seam 走 worker + `resourceLimits` + `terminate()` 硬杀；补齐前至少给 `defaultCompute` 加运算预算双保险。
- **优先级**：**P0**

#### Medium / Low

| # | 问题 | 位置 | 建议 | 优先级 |
|---|------|------|------|--------|
| S5 | 工具参数缺长度与数值范围上限（`readString` 无 `maxLength`、`readNumber` 无上下界；模型可传 10MB memo 或 `1e15` 金额打进落盘与 wire） | `bank/src/tools/args.ts:40-78`、`inputs.ts:43-54` | `readString` 加 `maxLength`（默认 512，memo 类 2000）；`readNumber` 加 `max` 并传业务上限；校验 `Number.isSafeInteger(yuanToCents(amount))` | P1 |
| S6 | 错误信息回灌上游响应体与内部绝对路径（上游 body 截断 500 字符进 message、SSE 原文进 detail、`session 已存在：${path}` 暴露服务器路径） | `deepseek/adapter.ts:174-179`、`wire.ts:306-309`、`jsonl/backend.ts:100,214`、`chain/vault.ts:126-128` | 对外 message 只留结构化 code；上游 body/路径仅进 detail；`messageOf` 输出前过滤绝对路径 | P1 |
| S7 | 票据指纹是明文参数序列化（`${name}:${stableStringify(args)}`）而非不可逆摘要：审计日志与票据账本可读出原始参数，指纹长度随参数无界增长 | `bank/src/tools/fingerprint.ts:11-13`、`runtime/src/tools/guard.ts:48-50` | 改 `sha256(stableStringify(args))` hex 前 16 字节作指纹，定长、可比对、不二次泄漏 | P1 |
| S8 | 沙箱 worker 动态 `import(moduleUrl)` 无包根二次复核 | `safety/src/sandbox-runtime/worker.ts:41`、`modules.ts:27-64` | worker 侧加 `moduleUrl.startsWith(packageRootUrl)` 断言，与父侧双人复核 | P2 |

**已核查、未见明显问题（安全）**：
- 依赖面干净：运行时依赖仅 `yaml`、`schemastery`（`import type`）+ workspace 内部包；全仓 `eval(`/`new Function(`/`child_process`/`exec(`/`spawn(` **零命中**
- API key 只读 `process.env`，`headers()` 不打印，缺 key 时 fail-loud 拒绝静默降级
- 审批链与票据防重放设计严密：`decide()` 顺序固定且升级只上调、模型输入不参与阈值；`redeem()` 五绑定校验 + 票据重放被拒有用例钉住；红级 `allowed-once` 必须过挑战，下游结论也要重验——未见跳级或伪造路径

### 3.3 性能

#### High

**P-P1 · JSONL 每条事件都 open/write/fsync/close 一遍**
- **位置**：`packages/persistence/src/jsonl/backend.ts:325-331`（已实测核实）
- **问题**：每落一条会话事件 4 次系统调用，`fsync` 默认开启。一个 turn 至少 10+ 条事件，同步 fsync 在事件循环上是毫秒级阻塞；`flush()` 还会再 open+fsync+close 一次。
- **建议**：句柄长期持有 fd（`openSync` 一次），或改异步 `fs.promises.appendFile` + 定时/按批 fsync（`fsync` 配成 `always`/`interval`/`never`）；`flush()` 复用已有 fd。
- **优先级**：**P0**

**P-P2 · 每次 LLM 装配都全量重建模型历史，整轮 O(n²)**
- **位置**：`runtime/src/agent-loop/request.ts:215`（`buildModelHistory(input.session.events())`）、`session/store.ts:69-71`（`return this.log.slice()` 全量副本）、`system-prompt/reconcile.ts:172-184`
- **问题**：每个 step 都 `session.events()`（全量数组拷贝）→ `collapseEvents`（2 遍）→ `reconcileContextEvents`（2 遍）→ `deriveMessages`（1 遍）→ `hoistSystem`（2 遍）≈ **每 step 至少 7 次全量遍历 + 1 次拷贝**，随会话长度 O(n²) 放大。
- **建议**：`events()` 返回只读视图而非副本；`buildModelHistory` 结果按 `lastSeq` 增量缓存；`collapseEvents`/`reconcileContextEvents` 合并单遍。
- **优先级**：**P0**

#### Medium

| # | 问题 | 位置 | 建议 | 优先级 |
|---|------|------|------|--------|
| P-P3 | `estimateTokens` 按 `length/4` 估算，中文实际约 1 字≈0.6–1 token，**低估 3–4 倍**（中文恰是本项目主语言），`shouldCompact` 迟迟不触发直到撞 provider 上限 | `runtime/src/compaction/summarize.ts:35、102-105、133-146` | 按字符类别估算（CJK×1.0、ASCII×0.25）；或用 provider `usage.prompt_tokens` 作权威水位 | P1 |
| P-P4 | 工具调用串行 `await`，多个只读查询（`accounts_list`/`balance_query`/`txns_list`）也串行叠加耗时 | `runtime/src/agent-loop/agent.ts:673` | 按 `tier.level === 'green'` 且只读事件族识别，用 `Promise.all` 并行只读批次；写/审批类保持串行 | P1 |
| P-P5 | 多个 Map 无界增长无淘汰：`TicketStore.records`、`TicketLedger.records`（终态票据永不回收）、`persistence.ts:59` `handles`（每 handle 持全量事件副本）、`trace.ts:74` `rings`（桶永不清理） | `bank/src/core/ticket.ts:93`、`interaction/…/ticket-ledger.ts:82,115`、`host/…/persistence.ts:59,70`、`safety/…/trace.ts:74` | 票据表加 TTL 清扫（过期+终态后 N 分钟删除）；handles 会话关闭时 dispose 并 delete；rings 按 LRU 限桶数 | P1 |
| P-P6 | `TicketLedger.forCall` 按 callId O(n) 全表扫（收尾路径每次调用） | `interaction/src/approval/ticket-ledger.ts:203-208` | 加 `byCall = Map<callId, ticketId>` 反向索引，`forCall` 变 O(1) | P2 |
| P-P7 | `planCompaction` 一次约 8 次全量遍历（collapse/completeTurns/shouldCompact/turnOwnership/droppedSeqs/extractFinancial） | `runtime/src/compaction/summarize.ts:195-222、133-146、321-340` | 单遍产出全部派生量，或 SessionStore 维护增量 turn/token 索引 | P2 |

#### Low

| # | 问题 | 位置 | 建议 |
|---|------|------|------|
| P-P8 | `list()` 对每个会话 3 次目录/文件系统调用 | `jsonl/backend.ts:145-155、255-272` | `readdirSync` 一次后内存判定，`readHeader` 按需 |
| P-P9 | HMR 用 `fs.watchFile` 轮询（注释说明为 Windows 稳定性取舍，`persistent:false`） | `host/src/boot/hmr.ts:106` | 现状可接受；patch 文件增多后改 `fs.watch` + debounce |
| P-P10 | `TraceLog.recent()` 跨会话全量排序 O(m log m) 只为取末 n 条 | `safety/src/sentry/kernel/trace.ts:155-162` | 按桶尾取候选后归并 top-n |

---

## 4. 跨视角优先级汇总

### P0（立即处理，共 8 项）

| # | 问题 | 视角 | 关键位置 |
|---|------|------|----------|
| 1 | sentry/sandbox 约 7000+ 行已交付代码未入 git | 质量 | `packages/safety/src/sentry/{kernel,pipeline}/` |
| 2 | 会话目录路径穿越 | 安全 | `cli/src/cli/run.ts:136`、`persistence.ts:58` |
| 3 | 强验证 `submit` 并发竞态（锁定可绕过/挑战可复活） | 正确性 | `bank/src/verify/index.ts:141-218` |
| 4 | 工具错误码压扁成 `tool-failed` | 正确性 | `runtime/src/tools/pipeline.ts:128-134` |
| 5 | LLM 调用无超时 | 安全/性能 | `llm/src/deepseek/adapter.ts:159-206` |
| 6 | `tool-missing` 击穿 turn 状态机，`turn/end` 不落账 | 正确性 | `pipeline.ts:90`、`agent.ts:662-682` |
| 7 | `tools/result` emit 记账抛错→账实不符 | 正确性 | `bank/src/tools/governance.ts:229-248` |
| 8 | JSONL 逐条 open/fsync/close + 每 step 全量重建历史 | 性能 | `jsonl/backend.ts:325-331`、`request.ts:215` |

> 安全侧另有 2 项建议并入 P0 处置：**PII 明文落盘**（S3）与 **analysis_calc 沙箱未接线**（S4）——若本系统承载真实客户数据，二者应与第 2 项同批修复。

### P1（本迭代内处理，共 14 项）

| # | 问题 | 视角 |
|---|------|------|
| 9 | saga `reduce.ts` 静默吞未知事件 | 质量 |
| 10 | `session.append` 三处 `as unknown as` 复制 | 质量/安全 |
| 11 | `ToolDefinition<any,any>`/`PluginV2<any>` 泛型擦除 | 质量 |
| 12 | 审批链路吞掉原始错误对象 | 质量 |
| 13 | saga-store 零校验断言 + 上帝接口（912 行/50+ 方法） | 质量 |
| 14 | 配置校验函数 5 包重复实现 | 质量 |
| 15 | env 变量与 sessions 路径写死（违反可调项纪律） | 质量 |
| 16 | `purchaseWealth` 缺账户状态校验 | 正确性 |
| 17 | 取消传播不完整，中断后写操作继续 | 正确性 |
| 18 | `ApprovalService.dispose` 窗口孤儿 pending | 正确性 |
| 19 | 日限额语义撕裂（block vs 升红；口径不一致） | 正确性 |
| 20 | 语义级重复转账无幂等键 | 正确性 |
| 21 | `mapPool` 快速失败→补偿孤儿写入 | 正确性 |
| 22 | 工具参数缺长度/范围上限（S5）+ 错误信息泄漏内部路径（S6）+ 指纹明文（S7） | 安全 |
| 23 | `yuanToCents` 浮点舍入 + 双重换算 | 正确性 |
| 24 | 中文 token 低估 3–4 倍（P-P3）+ 只读工具未并行（P-P4）+ Map 无界增长（P-P5） | 性能 |

### P2（规划内改进，共 19 项）

质量侧：Q-M1~M10（alert 空 catch、指纹双实现、缺 assertNever、commit 断言、魔法数字、索引断言逃逸、测试窥探私有态、缺 saga 覆盖率、无 lint 工具链、上帝文件）与 Q-L1~L5。
正确性侧：F-M5/M7、F-L1~L4。
安全侧：S8（worker 模块完整性）。
性能侧：P-P6/P-P7/P-P8~P-P10。

---

## 5. 修复路线建议

**第一批（阻塞级，建议 1–2 天内）**
1. `git add` + 提交全部 safety 源码，并加"文档勾选即须入库"门禁（Q-C1）
2. 会话 ID 白名单 + 路径根校验（S1）
3. `VerifyService.submit` 原子化 + 并发用例（F-C1）
4. `pipeline.ts` 错误码保留 + `tool-missing` 归一化 + `turn()` 兜底落 `turn/end`（F-H1/F-H2）
5. LLM 调用加 `AbortSignal.timeout`（S2）

**第二批（正确性/一致性，建议本迭代）**
6. `governance` 记账 try/catch 降级 + `purchaseWealth` 补状态校验 + 取消传播（F-H3/H4/H5）
7. saga `reduce.ts` 补 `assertNever`；PII 接入落盘管线；analysis_calc 接沙箱 seam
8. JSONL 改批量/异步 fsync；模型历史增量缓存

**第三批（结构性收口）**
9. 统一配置校验面与指纹实现；`appendDomain` 替换三处断言；saga-store 拆窄接口
10. 引入 lint 工具链 + `noImplicitReturns`；coverage-allowlist 补 saga
11. token 估算改分类计数、只读工具并行、票据表 TTL 清扫

---

*报告由三路并行深度审查（代码质量 / 功能正确性 / 安全性能）汇总生成；所有 Critical 与主要 High 项均经源码逐条核实（引用行号基于 2026-10-19 工作树状态）。*
