# 04 单对抗式复审报告

> **审查者与被审者未分离声明（00 §9 协议的硬要求）**：本报告由**施工同一主线程**出具。
> 用户已明令禁止派子智能体（含只读审查），因此本报告**不满足**"审查者新会话、独立视角"的组织前提；
> 缓解手段只有两条：① 每条判据都可机器执行、命令与输出进证据文件；② 结论按三档给出并逐条登记已知缺口。
> **读者应把本报告当作施工方自查，而不是第三方审计。**

- 审查对象：04 单工作树（HEAD `e09b165` + 本单未提交改动），共 95 个文件（+7612/−111）。
- 审查依据：`04-跨场景规划与联动示范.md` §0/§9/§11/§12、`00-全局约定.md` D5/D6/D8/D9/D13/D14。
- 证据文件：`04-baseline.txt`、`04-gate-before.txt`、`04-gate-after.txt`、`04-review-probes.txt`、
  `04-final-batch.txt`、`04-test-coverage*.txt`、`04-snapshot-*.txt`、`04-demo-transcript.txt`。

## 结论：**有条件通过**

"条件"= 下列 K2 / K5 / K6 三条必须在交付口径里保持现状描述（已写入 `docs/mobile.md` §3），
且在答辩前补一次浏览器四幕彩排（K5）。其余为低风险改进项。

## A 类 · 施工方自己会怎么偷懒（逐条给可执行判据）

| # | 探针 | 判据与结果 | 结论 |
|---|------|-----------|------|
| A1 | eval 断言被写松 | `packages/eval/src/scenarios/d/index.ts` 的 D-11…D-15 每条至少有 1 个数值/枚举锚点（`succeeded: 6`、`ordinal: 2`、`blocked: 3`、`failed: 1, skipped: 1`、`skipped: 1`），无 `expect: []`、无恒真断言 | 通过 |
| A2 | 快照断言放松 | `snapshots/cross-scene/snapshot.test.ts` 5 例：逐条全等 + 两次回放全等 + 事件级不变量 + 零新键 + 篡改负控；`reverified.json` 由 `snapshot:reverify` 生成（6 写入/2 未变） | 通过 |
| A3 | 门禁恒绿 | 反夹具 6 个（todo 落账 / goal 新键 / PlanApi.addNode / bulk-approve / 未审批 create / 重复 node-started），`scripts/cross-scene-gate.test.ts` 8 例全绿；正夹具"干净仓库"也必须 0 findings | 通过 |
| A4 | findings 塞进 notes | `verify-cross-scene.ts` 的 `ok` 绑定 `findings.length === 0`；notes 只有计数与扫描面 | 通过 |
| A5 | 抬地板却删用例/缩名单 | `scripts/ci.ts` 地板 unit 2989→3046、snapshot 22→38、web 332→337（均为实测−1）；`coverage-allowlist` 只增不减（+goal/+todo） | 通过 |
| A6 | 手改 reverified.json | 全仓 6 个 `reverified.json` 均由 `pnpm snapshot:reverify` 重写，diff 只有 digest 行 | 通过 |
| A7 | 断言打到 dist 陈旧产物 | `pnpm build` 在 test 之前执行且绿（`04-final-batch.txt`）；快照用例跑的是源码装配 | 通过 |

## B 类 · 契约四点闭环（声明 ↔ 发射 ↔ 投影 ↔ 前端消费）

| # | 探针 | 判据与结果 | 结论 |
|---|------|-----------|------|
| B1 | 工具注册了没人调 | `plan.test.ts` 断言 `goal_set`/`todo_write` 在注册表中且绿级、`sideEffect:'none'`；`cross-scene` 快照里两者都有 `tool/call`+`tool/result` | 通过 |
| B2 | 帧有分支而前端不消费 | `apps/web/src/mobile/shell.js` 的 `dispatchFrame` 已有 `goal`→`planSteps.setGoal`、`todo`→`setTodos`、`effects`→`effectsList.append`；`default` 是可见的"未知帧"卡（不静默吞） | 通过 |
| B3 | 只声明类型没有构造点 | `goal` 帧的构造在 `project.ts` 的 `tool/result` 分支（3 个投影用例）；`effects` 帧的 `writeToolNames` 由 `channel.ts` 从注册表注入（1 个用例） | 通过 |
| B4 | 忘了导出 | `packages/runtime/src/index.ts` 导出 `goal/`、`todo/`；`interaction/src/index.ts` 的 `prompt/` 由 03 单负责 | 通过 |
| B5 | 契约注册 | 本单未给 goal/todo 注册 `tool-contracts` 结果 schema（与 plan/intent 的既有做法不同）——**登记为 K8（低）**：出参形状由类型 + 单测锁定，不经过 ⑤e 运行时校验 | 有条件 |
| B6 | `askLedger` 类状态不跨 turn | `goalStore` 存活于插件实例（=进程/会话生命周期）；`originTurn` 由 `turn/start` 事件推进（`plan.test.ts` 实测 turn=1） | 通过 |

## C 类 · 安全 / 资金语义

| # | 探针 | 判据与结果 | 结论 |
|---|------|-----------|------|
| C1 | 一次 `plan_execute` 绕过后续审批 | 快照实测：3 个 `transfer_create` 节点各有一条自己的 `approval/asked`（by callId），计划层另有 1 条 `plan_execute` 审批 → 共 4 条；门禁 I4③ 对同一判据做机器判定 | 通过 |
| C2 | `succeeded` 重跑（二次扣款） | 门禁 I5：快照事件序里同一 nodeId 在 `node-result(succeeded)` 后无第二次 `node-started`；`plan/types.ts` 锚点注释仍在 | 通过 |
| C3 | fork 抹掉旧会话 | `fork.test.ts`：fork 前后旧会话 `JSON.stringify(events)` 逐字节相等；`seedUpTo` 只读前缀 | 通过 |
| C4 | PII 进快照/证据 | 精确判据（前后不接数字）：手机号 0、16–19 位卡号 0、姓名"王建国" 0；`[0-9]{11,}` 的 323 处全是 epoch 毫秒与 sha256 hex（见 `04-review-probes.txt` 探针 2/2b） | 通过 |
| C5 | 内部划转方向被绕过 | `mock.test.ts`：locked 作转出方 `transfer-locked-source`、固定期作转出方 `transfer-internal-unsupported`、目标冻结 `account-inactive`、同名多账户 `payee-ambiguous`；全部在票据核销**之前**（断言票据仍 `approved`） | 通过 |
| C6 | "锁定"被写成已入账 | 内部划转**贷记目标账户**并落两条流水（单测断言目标余额 +100000、两条 counterparty 互指）；移动口径写明"单向 earmark、解锁未仿真" | 通过 |
| C7 | fork 端点鉴权缺口 | 路由表：`auth:'web'`、`csrf:true`、状态码含 401/403；`contract.test.ts` 的 CSRF 名单新增 `fork /api/session/fork` 并要求 403 | 通过 |

## D 类 · 文档 / 口径自身

| # | 探针 | 判据与结果 | 结论 |
|---|------|-----------|------|
| D1 | 把降级写成已实现 | `docs/mobile.md` §3.1–3.5 逐字给出口径（预演叙事/接管进程内/分叉不切流/仿真商户/无原生打包）；`docs/security-design.md` §4 增三条未实现 | 通过 |
| D2 | facts 数字与代码失配 | `verify-facts` 复算：门禁 47 · 工具 16 · plan 2246 行 · 快照 9/39 · 覆盖率 89.06%（41749/46877）；`verify-docs-consistency` 绿 | 通过 |
| D3 | 覆盖率台账漂移 | 台账已更新为 2026-10-29 本机跑批，分母变化与"只认 CI 口径"的旧注记一并改写 | 通过 |
| D4 | `docs/mobile.md` 未进 PUBLIC_DOCS | 已加入（本单新增一行），`verify-docs-consistency` 扫描面 15 份 | 通过 |
| D5 | 计划不可变被改 | 门禁 I3：`PlanApi` 体无 `addNode`、全仓无 `.addNode(` 调用；`plan/` 目录零 diff | 通过 |

## 发现清单（按严重度）

| # | 级别 | 问题 | 判据（可复现） | 建议 |
|---|------|------|---------------|------|
| K1 | **高（口径）** | "回到上一步"只产生分叉元数据，**不切换 HTTP 渠道**；移动壳只显示提示。用户可能以为会话真的回退了 | `grep -n "FORKS" packages/host/src/boot/plugins/web/handlers/fork.ts`（只登记不接管）；`docs/mobile.md` §3.3 已写明"未实现切流" | 答辩口径必须主动说"分叉=新开一卷、旧卷封存；切流属 D4"；不要演示"切过去继续聊" |
| K2 | **高（验证缺口）** | 浏览器四幕**未实跑**（无可见浏览器）；证据是 jsdom 49 例 + 快照级两幕 | `04-demo-transcript.txt` 文首声明；`docs/evidence` 无四幕截图 | 交付前按 `docs/mobile.md` §1 手工彩排一遍并补截图 |
| K3 | **中（内存）** | fork 登记表 `FORKS` **只增不减**（生产无 `clearForks` 调用），每次 fork 留一个 Agent + SessionStore；无上限 | `grep -rn "clearForks" packages apps` 仅测试；`FORKS.set` 无容量判断 | P2：加单进程最多 N 个分叉或 TTL 回收；当前演示场景 ≤ 几次，风险可接受 |
| K4 | **中（双层派生）** | `todo` 帧仍由 01 的 `projectTodo`（DagBuilder）产状态，`deriveTodos` 是并行的第二套派生（仅测试/门禁消费） | `grep -n "projectTodo(" packages/channels/src/web/project.ts` 仍被 `projectPlan` 调用；`deriveTodos` 无生产调用方 | 收敛：让 `projectTodo` 直接消费 `deriveTodos` 的输出（会改 6 个 01 用例），或删掉一套并统一词汇 |
| K5 | **中（门禁判别力）** | `checkPlanAnchors` 的"ask 先于 next"判定用 `lastIndexOf('PLAN_EXECUTE_TOOL')`，可能被别处的同名串干扰；且**没有**"ask 在 next 之前"的反夹具 | 反夹具目录只有 `bulk-approve.ts`；`checkPlanAnchors` 实现见 `scripts/verify-cross-scene.ts` | 加夹具 `ask-before-next.ts`，把判定改成 AST 或"先找 `await next(` 再找其后的 `kind: 'ask'`" |
| K6 | **中（口径偏差）** | 生日案例金额 300/200/100（合计 600）≠ 施工单 §4.2 的 1000/300/200 | `packages/llm/src/demo/router.ts` 的 `BIRTHDAY_NODES`；偏差 6 已登记 | 若必须演示"锁定 1000 元"，需部署级日限（与 I8 冲突，先解门禁规则再改数） |
| K7 | 低 | `goal_set` 的 statement 脱敏**靠模型自律**，工具/账本不做 PII 扫描 | `grep -n "sanitize" packages/runtime/src/goal` 0 命中 | 文档已写"账本只留意图不留原文"，但未写"工具不做脱敏"；建议补一句诚实边界 |
| K8 | 低 | goal/todo 的结果 schema 未注册 `runtime:tool-contracts`，出参畸形不会被 ⑤e 拦 | `grep -rn "GOAL_SET_SCHEMA\|TODO_WRITE_SCHEMA" packages` 0 命中 | 与 intent 的做法对齐，注册结果 schema + 一条真实管线用例 |
| K9 | 低 | `deriveTodos` 的 `text` 是 nodeId；清单文案美化依赖投影层 | `packages/runtime/src/todo/derive.ts` 的 `text: nodeId` | 保持现状，等 K4 收敛时一起定 |
| K10 | 低 | 快照 `cross-scene` 在提交前依赖 `git add -N` 才能让 `snapshot-fresh` 变绿（新目录未被 git 跟踪时 `git status` 折叠成目录） | `04-gate-after.txt` 第 158 行区块；`git add -N snapshots/cross-scene` 后复跑转绿 | 提交后复跑一次 `pnpm gate` 确认；若仍红，改门禁展开未跟踪目录 |

## 已核实通过的要点（摘要）

1. **零新事件键**：`cross-scene` 快照 186 条事件里 `goal/`、`todo/`、`effects/` 前缀 0 命中；门禁 I7 扫全仓 485 文件。
2. **每步独立审批**：3 个 `transfer_create` 各有自己的 `approval/asked`（callId 级），另有 1 条计划层审批；票据 ID = `ticket:<planId>#<node>#1`。
3. **门禁 47 项**：本单新增 `verify-cross-scene` 并自证正反夹具；4 红全部在并行「可观测性」线文件面（`assertions`/`docs-paths`/`snapshot-fresh`/`tracked-sources`），逐条见 `04-construction.md` §4。
4. **逐文件 100%**：`goal/`（3 实现文件）、`todo/`（3）、`fork.ts` 均纳入 `test:coverage` 名单且实测 100%。
5. **eval 71 场景全过**；D 族 15 例；基线重录后 `averageSteps 1.55`（上限 1.63）。
6. **文档一致性**：`verify-facts`、`verify-docs-consistency`、`verify-docs-paths`（除并行线 PROGRESS）、`verify-mobile-shell`、`verify-channel-capabilities` 绿。

## 复审结论

**有条件通过**。条件：

1. K1（fork 不切流）与 K2（浏览器未实跑）必须作为对外口径的**显式声明**，不得用"已实现回退"表述；
2. 交付前补一次四幕手工彩排（截图入证据目录），并把 `04-demo-transcript.txt` 的"快照级"字样保留；
3. K3（分叉登记表无上限）与 K5（门禁反夹具缺一条）列入下一轮改进，不阻塞本单。

签字位：**施工方自查**（审查者与被审者未分离，见文首声明）。
