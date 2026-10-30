# 编排原语 `plan:dag`

> 代码：`packages/runtime/src/plan/`（纯引擎）、`packages/host/src/boot/plugins/plan.ts`（宿主装配）。
> 配置：`profiles/plan/patch.yml`。门禁：`pnpm gate` 的 `plan-events` 与 `plan-determinism` 两项。
> 单测 81 例（引擎）+ 集成 18 例（真实依赖清单）。

## 1. 它是什么

一个**编排原语**：接受外部传入的一张工具调用 DAG，校验后按拓扑序**串行**执行，
每个节点都走完整的七段工具管线（审批 / Sentry / Saga / 审计一个都不绕），
全过程以 8 个 durable 事件落会话日志。

```text
Plan（外部构造的 JSON）
  → PlanEngine（校验 → 拓扑 → 逐节点调度）
  → session 事件 + 快照
        │
        └─ 每个节点调 PlanInvoker（宿主注入）
               └─ new ToolPipeline().execute()   ← 审批 / Sentry / Saga / 审计
```

## 2. 它不是什么（四条排除）

| 不是 | 依据 |
|---|---|
| **不是 `@bah/saga` 的替代** | saga 是"一笔业务的前向步骤 + 补偿"，节点由配方硬编码；plan 是"外部传入的整张图"。saga 回答"失败了怎么退"，plan 回答"先做什么后做什么" |
| **默认不是模型的规划能力** | 银行工具锁 18 个，**不含** `plan_propose` / `plan_execute`；这两件只在显式打开 `plan:dag.modelTools: true` 的 profile（`profiles/plan`、`profiles/web-plan`）暴露给模型（默认关闭）。默认装配下 plan 由宿主 / 脚本 / 上层插件构造 |
| **不是工作流服务器** | 无独立进程、无 DB、无队列。状态全在会话日志与进程内快照里 |
| **不是并行执行器** | 串行。并行会让"审批一次 = 扣款一次"的对应关系失效 |

与 `bank:saga-bridge` 的分工：saga 外层批一次、内层直调工具定义；
plan **每个节点各走一次** `tools/pre-execute`，所以 N 个写节点就是 N 次审批。

## 3. 数据与状态

```ts
Plan      = { planId, nodes[], meta? }        // meta 只做审计展示，不参与 digest
PlanNode  = { id, tool, args, deps[], optional?, idempotencyKey? }
```

- `id` 字符集 `[A-Za-z0-9_-]{1,64}`：它要进 `callId`（`${planId}#${nodeId}#1`），不能带分隔符；
- `args` 可以是静态字面量，也可以是**整串**模板 `"${node.<id>.<path>}"`（P2 已做，见 §3.1）；
- `optional: true` 表示上游失败时本节点 `skipped`（**下游把它视为满足**），缺省是 `blocked`。

9 态，终态不可逆：

```text
pending → ready → running → succeeded | failed | incident
   │        │         └→ cancelled
   │        └→ cancelled
   ├→ blocked     （上游 failed/blocked/cancelled/incident，没调度）
   ├→ skipped     （optional 兜住 / dry-run，调度过没执行）
   └→ cancelled   （取消后剩下的节点）

incident（第 9 态）：外部不可用、需人工介入。终态；`resume` 用 seed 把它重置回 pending
                     ——那不是一条转移（转移表里 incident 没有出边）。
```

`plan/completed.status` 的判定：`failed > 0 || blocked > 0 → failed`。
**`blocked` 计入失败**——否则一张全被 block 的计划会报"计划完成"。
**`incident` 也记进 `failed` 桶**——载荷只有五个计数字段（W02 冻结），漏掉它会让
"一个节点外部不可用"的计划报 `succeeded`，同时破坏"五计数之和 = total"。

### 3.1 动态 args（W11）

只有**整串**是模板的值才替换：`"${node.a.txnId}"` 是模板，`"单号-${node.a.txnId}"` 是字面量。
理由：字符串插值会把 `800` 变成 `"800"`，金额校验随即按字符串处理。

支持点分路径与数组下标（`${node.a.content.0.text}`）；不支持表达式 / 算术 / 函数
（`"${a + b}"` 按字面串原样传下去，不报错）。`digest` 始终用**模板原样**字符串计算，
执行期替换不回流到计划身份。

解析失败（上游 output 里没有那个字段）→ 该节点 `failed` + `code: plan-args-unresolved`，
**并且不落 `plan/node-started`**：它从未被派发，落"开始了"就是编造事实（与 dry-run 同一取舍）。

## 4. 校验（10 条，全量收集不短路）

| # | 规则 | 错误码 |
|---|---|---|
| V1 | 至少 1 个节点 | `plan-empty` |
| V2 | 节点数 ≤ `maxNodes`（默认 32） | `plan-too-large` |
| V3 | id 合法 + 唯一 | `plan-node-id` / `plan-node-duplicate` |
| V4 | `deps` 引用的节点存在 | `plan-dep-missing` |
| V5 | 无自依赖 | `plan-self-dep` |
| V6 | 无环，且给出**环路径** | `plan-cycle`（附 `cyclePath`） |
| V7 | 工具已注册 | `plan-tool-missing` |
| V8 | `args` 可序列化且 ≤ 64KB | `plan-args-invalid` / `plan-args-too-large` |
| V9 | 模板引用的节点必须存在 | `plan-args-ref-missing` |
| V9 | 模板引用必须落在本节点 **deps 闭包**内（含"引用自己"） | `plan-args-ref-outside-deps` |
| 附 | 依赖边 ≤ `maxEdges`（默认 128） | `plan-too-many-edges` |

**V6 必须给环路径**（`['a','b','c','a']`），只说"有环"等于把排查工作丢回给调用方。

V9 为什么是**闭包**而不是直接 `deps`：串行执行下只有"拓扑序在前且一定先跑"的节点才有 output。
允许旁支引用会让真实执行顺序变成隐性依赖，`ordinal` 与快照排序就都失去意义。
引用自己也算 outside——解析时自己的 output 还不存在。

## 5. 八个 durable 事件

| 事件 | 何时 |
|---|---|
| `plan/created` | 校验通过后、第一个节点之前（带 `digest` 与 `initiator`） |
| `plan/resumed` | 续跑开始（带 `digest`、`skipped`、`resumedFrom`）；**不重发 `plan/created`** |
| `plan/node-started` | 节点**已被派发**（带 `ordinal` 与 `callId`）；args 解析失败时不落 |
| `plan/node-waiting` | 等审批结束之后、`node-result` 之前（带 `waitedMs`，注入钟测出来的事后值） |
| `plan/node-result` | 节点终态为 `succeeded` / `failed` / `skipped`（`incident` 落 `failed` + `code`） |
| `plan/node-blocked` | 节点因上游失败被 block（带 `blockedBy` 与 `reason`） |
| `plan/completed` | 收尾（五个计数之和恒等于 `total`） |
| `plan/aborted` | 取消 / 超时 / dispose / HALT |

`plan/resumed` 为什么**不**重发 `plan/created`：续的不是"新建一张计划"。重发会让审计数出
两张计划，也会让重放自己把窗口起点认错——续跑的起点必须是 `plan/resumed`。

`plan/node-waiting` 为什么是**事后**值：进入等待那一刻还不知道要等多久。它回答
"这个节点卡了多久"，不是"它正在卡"；`waitedMs` 由管线用注入钟测（快照回放才可复现）。

四条纪律：

1. `node-result.status` 是三值：`skipped`（调度过没执行）与 `blocked`（没调度）必须在审计上可区分。
   **`incident` 不是第四个值**——它落 `status:'failed'` + `code: PLAN_INCIDENT_CODE`，
   读侧由 `nodeStateFromResult()` 唯一还原（必须先看 `code` 再看 `status`）；
2. **plan 事件不落 `args` 原文**：只落 `digest` + `tool` + `code`。
   注意口径——工具管线自己的 `tool/call` 仍按平台既有规则落参（那是七段管线的事，plan 不改变它），
   plan 不做的只是"把整张图的 args 再落一遍"。门禁 `plan-events` 的第 5 条检查就钉这条：
   载荷表里声明 `args`、或发射点的对象字面量里出现 `args`，都会失败；
3. `digest` 是 canonical JSON（键排序后 hash）的 sha256 前 16 字节，**不含 `meta`**：改标题不算新计划；
4. 走 `appendDomain`，因此 `ignorable: true`——旧 reader 跳过 plan 事件不影响对话重建。

## 6. 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时不提供 `bah:plan` 服务（等价于没装） |
| `maxNodes` | `32` | 节点数上限 |
| `maxEdges` | `128` | 依赖边上限 |
| `planTimeoutMs` | `30000` | 单次 run 的调度预算；**必须小于 `ticketTtlMs`** |
| `dryRunDefault` | `false` | `run()` 不传 `dryRun` 时的缺省 |
| `ticketTtlMs` | `120000` | 票据 TTL，**只用于越界判定**，不参与执行 |
| `maxNodeAttempts` | `3` | 同一节点允许的**失败次数**（含首次），按 `plan/node-result(status='failed')` 累计；达到即拒绝再 `resume` 重试 |

`ticketTtlMs` 是方案 5 键之外的第 6 键：票据 TTL 的真源在 `bank:tools.ticketTtlSeconds`，
插件之间拿不到彼此的配置，与其在代码里写死一个会过期的常数，不如让它成为显式配置——
改了银行侧 TTL 就必须同步改这里，否则判定说谎。

`maxNodeAttempts` 是第 7 键，也是**唯一一个"政策"键**：它让引擎能拒绝续跑（见 §12.5）。
放配置而不是写死常数，是因为"失败几次算过分"随业务变；不给它缺省值（`Infinity`）是因为
"保护默认关闭"在银行场景里是最坏的默认。

## 7. 六条已知限制（答辩时主动说）

1. **模型入口是受控的、非默认的**。默认装配下 plan 仍由宿主 / 脚本构造；B1 之后
   `plan_propose`（只校验不执行，绿级）与 `plan_execute`（执行整图，黄级 + 一次人工批准）
   只在显式 `modelTools: true` 的 profile（`profiles/plan`、`profiles/web-plan`）可见。
   模型提交的节点只能取银行工具目录（`BANK_TOOL_NAME_SET`）、上限 `modelMaxNodes`（默认 8），
   每个节点仍各走一次完整 ToolPipeline——模型能提出 DAG，绕不过任何审批 / Sentry / 审计。
2. **plan 事件是 `ignorable`**。旧 reader 跳过它，**不能**用于会话完整性校验。
3. **turn 取消不传播进 plan**。plan 拿不到 turn 的 `AbortSignal`（`tools/execute` 的包裹层只拿到 `call`），
   所以 turn 被取消后，已进入的节点仍会跑完。plan 自己的取消只在"下一个节点是否开始"这个决策点生效。
4. **动态 args 跨不了 `resume`**。`output` 只在内存、不进事件，被跳过的上游没有 output 可解析。
   待执行的节点引用了"本次会跳过的 `succeeded` 上游"时，`resume` 在入口就拒
   （`plan-resume-args-unresolved`），一个节点都不跑——**不做"跑到一半才发现"**：
   串行计划的前序节点可能是 `transfer_create`，那时钱已经出去了。
   代价是少一条恢复路径，逃生口仍是"新 `planId` + 冲正"。
5. **不做自动节点重试**。一次失败即 `failed`，下游 `blocked`——幂等键没传给银行核心，
   自动重试一次就是真的多扣一次钱。唯一的重跑入口是 `resume(plan, { from })`，且必须**点名**
   （`incident` 除外：它不是"节点不行"，`resume` 会自动重排）。
6. **`incident` 在本仓没有真实触发源**。mock 银行全内存、无外部依赖，所以"外部不可用"只能由
   宿主闭集（`result.code === PLAN_INCIDENT_CODE`）声明，可达性由引擎单测与宿主集成测试
   （注册一个抛 `upstream-unavailable` 的 stub 工具）证明。真实对接时由 provider seam 给出该码。
   **超时不许映射成 `incident`**：超时可能发生在扣款之后，而 `incident` 在 `resume` 里是自动重跑的。

## 8. 与 saga 的交接代价（必须知道的取舍）

`profiles/plan/patch.yml` 里 `bank:saga-bridge.enabled: false`。原因是：如果 plan 的节点是
`transfer_create` 且 saga-bridge 也接管它，一个节点会变成两条 `tool/call`，审计永远说不清
哪条属于哪一层（详见 `packages/host/src/boot/plugins/saga-bridge.ts` 的配方表）。

**代价**：plan 里的 `transfer_create` **仍不自动补偿**（plan profile 关掉 saga-bridge，节点只有前向）。
W12 之后 saga 自身已具备真冲正（`MockBankCore.reverse(txnId)`，两条流水 + 幂等），但那是 saga 层的能力：
要让"第 3 步失败、第 2 步已扣款要退"发生在 plan 里，正确做法仍是让 **plan 编排 saga**
（节点 = 一整笔 saga），而不是让 saga 藏在某个节点里。这条留给 P2。
W12/W05/W06 待办单（2026-10-26，已撤下）的 TC-W12-06 是**配置断言**（profile 里 `enabled: false`），
不是代码级承诺——有人改了 patch，plan 节点就会重新进入 saga 桥接。

判断口诀：**plan 决定"做哪几件事"，saga 决定"一件事做坏了怎么退"。两者是嵌套，不是并列。**

## 9. 命名说明

服务键是 `bah:plan`，与 `runtime:*` 族不一致。这是有意的：
`runtime:` 是基础面（会话 / 工具 / 管线），`bah:` 是业务编排面。
若要统一改成 `runtime:plan`，必须与插件的 `inject` 逐字一致，否则等待队列永远等不到。

## 10. 怎么跑

```bash
# 单测（引擎 81 例，含 W10 的 replay 6 例 + resume 15 例 + W11 的 incident / waiting / args）
npx vitest run packages/runtime/src/plan

# 集成（真实依赖清单 + profiles/plan/patch.yml，18 例）
npx vitest run packages/host/src/boot/plugins/plan.test.ts

# 两道门禁
npx tsx scripts/verify-plan-events.ts
npx tsx scripts/verify-plan-determinism.ts

# 演示（四个场景 + 15 条断言，退出码可直接进 CI；场景 4 = B3 跨场景联动）
npx tsx scripts/demo-plan.ts

# 录屏/现场演示：把打印节奏放慢到能看清（默认 0 = 不等待，CI 行为不变）
npx tsx scripts/demo-plan.ts --pace=220

# 只跑一个场景（录屏分段 / 排障；没跑的场景不作结论）
npx tsx scripts/demo-plan.ts --only=dry --pace=400
```

### 10.1 跨场景联动样例（B3）

场景 4 用**一条计划串起四个场景**：流水 `txn_query` → 账单 `bill_analyze`；
余额 `account_balance` 独立并行；取消订阅 `sub_cancel`（黄级写，触发一次审批）
同时依赖账单与余额（fan-in）。全部是**现有银行工具**，没有新增 mock 商户工具；
订阅 ID 来自 demo 造数（`s-1`，云存储会员），不接任何真实外部服务。

**诚实边界**：这条计划由 `scripts/demo-plan.ts` **外部喂图**（静态 `Plan` 对象），
它演示的是"plan:dag 能跨场景编排、每个节点各走治理管线"，**不是模型自主拆解**；
模型自主规划的入口是 B1 的 `plan_propose` / `plan_execute`（见 §7 第 1 条与
`profiles/web-plan`）。

`scripts/demo-plan.ts` 是**答辩用的证据面**（默认装配 plan 没有模型入口，对话里看不到 DAG；
`web-plan` profile 是"模型可见"的那一面）：
它在一个进程里跑四段——全成功（3 条 `tool/call` / 1 条 `approval/asked`）、
菱形失败传播（`A → {B,C} → D`，`D.blockedBy = ['B','C']`）、dry-run（`tool/call = 0`）、
跨场景联动（B3：四节点跨四个场景，见 §10.1），
并把 `plan/*` 事件逐条打印出来。

两个开关只影响**打印节奏**与**跑哪几个场景**，不改任何断言、计数与落账：

- `--pace=<ms>`：每行之后等 ms。四场景实跑只要 1 s，不控速的话录屏一闪而过；
- `--only=<ok|diamond|dry|cross>`：没跑的场景**连断言都不执行**，收尾结论按实际跑过的条数收窄
  （`--only=dry` 时是"4 条断言全过 —— dry 场景成立（其余场景本次未运行，不作结论）"）；
- 两个开关都 fail-loud：`--only=xx` / `--nope` 退出码 1 并打印用法。

`run()` 的用法（宿主侧）：

```ts
const api = ctx.get(PLAN_SERVICE)              // 'bah:plan'
const summary = await api.run(plan)            // 或 api.run(plan, { dryRun: true })
await api.resume(plan)                         // 接着上次结果跑（已 succeeded 的不重跑）
await api.resume(plan, { from: ['pay'] })      // 显式授权重跑 pay（只对 failed 生效）
api.snapshot(plan.planId)                      // 运行中或已完成的快照（dry-run 不留档）
```

`initiator` 不接受参数：一律取 `session.sessionId` 落进 `plan/created`，保证"谁发起的"有据可查。

## 11. 与方案文档的偏差登记

| 方案 | 实现 | 原因 |
|---|---|---|
| 事件表用 `declare module '@bah/core'` | 声明在 `packages/runtime/src/plan/events.ts` 的本地接口 | 模块增强只能合并已存在的声明，不能新增可被 `import type` 取到的新导出（TS2724）；`@bah/core` 的 `api.ts` 是冻结契约面，不该为可选插件改它 |
| `planTimeoutMs` 默认 120000 | 默认 30000 | 120000 正好等于票据 TTL，会被 `planTimeoutMs < ticketTtlMs` 直接拒掉 |
| 引擎 `now: () => Date.now()` | 取 `bah:run` 的注入钟 | 与主循环同一时间轴，且快照回放要逐字节相等 |
| 本文件的位置：方案写作 docs/plugins/plan.md | `docs/plan.md` | 本仓 `docs/` 是平铺的（`pipeline.md` / `sandbox.md` / `bank-tools.md`），不另开子目录 |
| `PlanSettings` 5 键 | 6 键（多一个 `ticketTtlMs`） | 票据 TTL 的真源在 `bank:tools`，插件之间拿不到彼此的配置；写死常数会让"< TTL"的判定随时间说谎 |
| 快照 3 场景 | 1 个录音场景（链式 3 节点）+ 单测/集成覆盖失败与 dry-run 分支 | 快照的职责是"整条链路可复现"，不是把每条分支再录一遍；录得越多重录越贵。**不录 cancel**（依赖事件循环时序，会 flaky） |
| `plan/` 未进 100% 覆盖率强制名单 | 未加 | 方案未要求；引擎里有一条不可达的防御分支（`depsSatisfied` 兜底），进名单会逼人给死代码写测试 |
| W11「动态 args 取上游 output」 | `ToolExecution` 增两个**只读**字段：`value`（结构化原值）、`approvalWaitedMs`（审批等待） | `result.content` 是 `projectContent` 之后的**渲染投影**，按字段取不到东西；审批等待只有管线知道。两者都只在内存、不进事件，且默认缺省 ⇒ 对既有消费方零影响 |
| W11「`incident` 落 `failed` + `code`」 | 不改冻结的三值 `node-result.status`，也不新增 `plan/node-incident` | `status` 与 `code` 同时承载"是不是外部故障"会造成两个判定者；新增事件会让"终态计数"认两个事件族。见 `PROGRESS.md` §70.1 |

## 12. 续跑（P1 已做）与仍未做的部分

### 12.1 做了什么：`resume(plan, { from })`

**唯一输入是会话事件**（`session.events()`）：没有跨进程持久化、没有旁路状态文件。
`replayPlan(history, planId)` 是纯函数（不读时钟、不写事件），把 8 类事件重建成
`Map<nodeId, state>`。**`node-result` 与 `node-blocked` 必须一起重放**：非 `optional` 的节点
被上游卡住时只落 `plan/node-blocked`，只读 `node-result` 会把整类 blocked 节点漏掉。
`plan/node-waiting` 不进状态重建（它只回答"等了多久"，没有消费方）。

三条过滤规则（顺序即优先级）：

| 上次状态 | 处理 | 理由 |
|---|---|---|
| `succeeded` | 跳过，**永不重跑**（`from` 也改不了） | 幂等键没传给银行核心，重跑 = 二次扣款 |
| `failed` | 不自动重试；只有 `from` 点名才重置为 `pending`（且未达 `maxNodeAttempts`，见 §12.5） | 失败可能已经部分执行，重试是人的决定 |
| `blocked` / `skipped` / `cancelled` / 悬空 `running` / `incident` | 重置为 `pending` 重新调度 | 它们**一次都没成功**；上次结论依赖当时的上游或外部状态 |

`incident` 落在第三档是它与 `failed` 的**唯一区别**：外部不可用不是"这个节点不行"，
人工修好外部条件后 `resume` 应当自动重排，不需要逐个点名。

跳过**只按状态判定**：`ordinal` 只用于拓扑排序与快照排序，`packages/runtime/src/plan/types.ts`
的字段注释里已钉死"不用于跳过判定"。

**完整性判据**（任一条不满足就 `plan-replay-incomplete`，绝不猜）：

1. 该 `planId` 必须见过 `plan/created`；
2. `planDigest(plan)` 必须等于记录里的 `digest`，否则 `plan-identity-mismatch`；
3. 最后一个窗口必须已收尾（`plan/completed` / `plan/aborted`）；
4. 收尾那一刻，重放到的终态节点数必须 ≥ `total - cancelled`
   （被 abort 的 run 天然不满员：`cancelRemaining()` 不给剩余节点落任何事件）。

第 4 条为什么不是"比节点个数"：`plan/created` 的 `nodes` 是**个数**不是清单，
只比个数会把"中间缺一条 `node-result`"放过去——而那正是最危险的场景（会把已成功节点当成没跑过）。

三个错误码**不并进 `PlanIssueCode`**：那是 `validate()` 的"计划本身不合法"（全量收集、不短路），
混进来会让前端 / CLI 分不清"该改计划"还是"该改调用方式"。

```ts
await api.resume(plan)                      // 只补跑没结论的节点
await api.resume(plan, { from: ['pay'] })   // 授权重跑 pay（它上次是 failed）
```

同 `planId` 正在跑 → `plan-already-running`（沿用既有单写者守卫，不新增码）。

### 12.2 已知限制（答辩主动说）

1. **同会话才可续**。续跑读的是当前 `session.events()`：换会话 / 换进程都读不到上次结果，
   会直接 `plan-replay-incomplete`。v1 没有跨进程持久化。
2. **`from` 不级联下游**。下游若是 `blocked` / `cancelled`，本来就由"重置为 `pending`"覆盖；
   若是 `succeeded`，级联重跑就是二次扣款。所以 `from` 的语义是"授权重试某几个失败节点"，
   不是"重算整个分支"。动态 args 也因此**不能靠重跑上游来补 output**（那是二次扣款），
   只能整张换新 `planId`（见 §7 第 4 条）。
3. **快照会丢上次的 `code` / `durationMs`**：重放只重建状态，不重建当时的错误码与耗时。
4. **停机期间续跑不了**：HALT 拦截在宿主层，`run` 与 `resume` 共用同一段闸。
   只包 `run` 的话，停机时用 `resume` 就能绕过——这是 W10 必须堵的洞。

### 12.3 仍未做

- **失败 / dry-run 的录音场景**：只录了"全成功"一条（`snapshots/plan/`），失败传播与 dry-run
  由单测与集成测试兜住（见下节用例清单）。
- **P2 三项已做完**（动态 args / `incident` 态 / `plan/node-waiting`，W11）；仍未做的只有上面这条
  与本文件 §7 登记的限制。

### 12.4 「重做已成功的节点」的口径（2026-10-25 裁定：保持封闭）

**不给 `from` 开口子**：`resume` 永远只做"续"，不做"重做"——`succeeded` 的节点即使被
`from` 点名也不执行（单测「二次扣款不变量」钉着）。

业务上要重做一笔已成功的转账，走**新 `planId` + 冲正原笔**（P2 由"plan 编排 saga"承担）；
两张计划靠 `meta` 里的关联 id 串起来——`meta` 不进 digest，"改标题不算新意图"这条正好让
关联字段可以后补。

三条理由，答辩会被问到：

1. **审计要能一眼分清"续"与"重做"**：混进同一个入参后，只能靠载荷字段去猜，而
   `plan/resumed.skipped` 也会失去单一含义（"跳过了几个"还是"允许重跑了几个"？）；
2. **二次扣款只需一条不变量挡**：`succeeded` 永不重跑；开两个语义共用一个参数，防线就从
   "一条不变量"退化成"两个布尔组合的测试矩阵"；
3. **冲正不是重跑**：银行语义里"退回去再发一笔"是两笔业务事实，用一次 `resume` 抹平会让
   对账少一条流水。

### 12.5 重试上限（2026-10-26 裁定：引擎内硬上限）

`maxNodeAttempts`（默认 3）是**唯一一处让引擎做"政策判决"**的地方，口径写死如下：

- **计数对象**：该节点历史上 `plan/node-result(status='failed')` 的**条数**（跨 `resume` 窗口累计）。
  ★ `incident` 的载荷虽是 `failed`，但**不计数**：外部不可用不是"这个节点不行"，
  把它算进来会让一次基础设施抖动提前打满预算；
- **判定时刻**：`resume(plan, { from })`，且只对 `from` 里**真的会被重试**的节点
  （状态 `failed` / 悬空 `running`）判——`succeeded` 的节点根本不会重跑，对它报超限是噪音；
- **阈值语义**：是"最多失败 3 次"（含首次运行），**不是**"重试 3 次"。默认 3 =
  1 次原始运行 + 2 次重试；第 4 次失败后再想重试 → `plan-resume-retry-exhausted`；
- **逃生口**：换新 `planId`（= 新计划 + 冲正，见 §12.4），不在同一个 `planId` 上无限续。

为什么计数用"失败次数"而不是"重试次数"：`node-result` 里区分不出"这次是首次还是第 4 次"，
硬要算重试次数就得再引入一个状态位，而那个状态位会和事件窗口裁剪打架——裁剪后计数本来就不可信
（那时该报的是 `plan-replay-incomplete`）。

判定顺序也是契约：**完整性判据先于上限判定**。窗口不完整时"失败了几次"这个数本身不可信，
先报"日志坏了"比先报"重试超限"更接近真相（后者会让人去改计划，而问题在日志）。

**这条是取舍，不是优点**：引擎从此认识了一种"政策"，代价在上限打满之后——"续"被逼成"重做"，
而重做要冲正。若将来银行侧真出现"同一收款人当日第 3 次需复核"这类规则，正确落点是审批面
（`interaction:approval` / `safety:sentry`），**不要再往这里加第二个政策键**。

## 13. 证据清单

| 面 | 位置 | 数量 |
|---|---|---|
| 引擎单测 | `packages/runtime/src/plan/`（6 个 `*.test.ts`） | 81 例（含 W10 重放 6 + 续跑 11 + 重试上限 4 + W11 的 incident 4 / waiting 4 / args 8 / 二次 completed 1） |
| 宿主集成 | `packages/host/src/boot/plugins/plan.test.ts` | 18 例（6 场景 + W10 续跑 3 + 配置 4 + profile 一致性 1 + 总开关 1 + W11 接缝 3） |
| 快照回放 | `snapshots/plan/` | 1 场景 4 例（含负控篡改） |
| 门禁 | `scripts/verify-plan-events.ts`、`scripts/verify-plan-determinism.ts` | 6 + 若干项检查，已做负例验证（故意破坏 → 必红） |
| 演示 | `scripts/demo-plan.ts` | 3 场景 10 条断言（全成功 / 菱形传播 / dry-run），退出码 0 才算通过 |
