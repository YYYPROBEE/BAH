# 评委视角走查表（C10 · 2026-10-27）

> 用途：答辩前按赛题逐节自查一遍，**先承认缺口再讲实现**。分数只作内部校准，不对外宣称。
> 口径：每一行的"证据"要么是可跑命令，要么是 `file:line`；没有门禁兜着的写"靠人审"。
> 本表自我约束：缺口不许只列不判（每条都要写"修不修 + 理由"）；不写"运行中能发现篡改"这类本仓做不到的话。

## 0. 一句话结论

六条交付主线里，**权限分级、审计、熔断、沙箱**是"有代码 + 有门禁 + 有负例"的一档；
**跨场景联动**是"引擎在、编排样例薄"的一档；**卡片管理与订阅代扣**只覆盖了赛题要求的一两个动作，是最大缺口。
答辩策略：把前四项讲成"已通电并有边界"，后两项主动说"当前只做了高风险动作，其余在路线图"。

## 1. 按赛题维度逐节打分

评分含义：5 = 可现场演示且有负例兜底；4 = 可演示、边界已写明；3 = 代码在但样例薄；2 = 只覆盖部分动作；1 = 未做。

### 1.1 赛题任务六场景（赛题解析 §二）

| 场景 | 覆盖到的工具 | 证据 | 缺口 | 修复成本 | 修不修 + 理由 | 自评 |
|---|---|---|---|---|---|---:|
| 智能转账 | `transfer_preview` / `transfer_create`（＋三人强验证） | `docs/tool-catalog.md` 第 7–8 行；`packages/bank/src/tools/tier.ts:4-9` | **定时转账、拆分 AA 收款**未做 | 定时：3–5 人日（需调度器 + 幂等窗口）；拆分：2–3 人日（需多收款人 + 部分失败语义） | **赛前不修**：定时会引入跨进程调度，属新子系统；自评 4 分，现场主动说"这两项在路线图" | 4 |
| 账单分析 | `account_list` / `account_balance` / `txn_query` / `bill_analyze` / `bill_report` / `analysis_calc` | `docs/tool-catalog.md` 第 1–6 行 | 年度报告只能靠 `period` 传年，未做专门的年度口径；异常识别是规则式（大额/夜间/重复） | 0.5–1 人日补 `period=year` 的渲染 | **可修（低优先）**：属文案与聚合参数，不影响架构；赛前若只剩半天，优先保 C05/C06 | 4 |
| 理财操作 | `wealth_list` / `wealth_compare` / `wealth_purchase` | `docs/tool-catalog.md` 第 9–11 行；`wealth_purchase` 声明为 `red` | **风险评估问卷、赎回**未做 | 风险评估 2 人日；赎回 2 人日（需持仓模型） | **赛前不修**：赎回要引入持仓账本，属新领域模型；答辩口径"申购已通，赎回在下一版" | 3 |
| 卡片管理 | `card_report_lost` | `docs/tool-catalog.md` 第 15 行 | **卡申请、额度调整、交易限制解锁**未做 | 每个动作 1–2 人日（都要进三档治理） | **赛前不修**：三个动作都要各自的审批与强验证分支，收益低于 C05/C06；主动承认只做了不可逆的挂失 | 2 |
| 订阅/代扣管理 | `sub_cancel`；查询复用 `txn_query` | `docs/tool-catalog.md` 第 16 行 | **自动识别订阅扣费、续费提醒**未做 | 识别 1–2 人日（规则式可做）；提醒需通知通道 | **赛前不修**：提醒依赖外部通道（邮件/推送），不在本期范围；自评 2 分 | 2 |
| 跨场景联动 | `plan:dag` 引擎 + `plan` profile | `profiles/plan/patch.yml:56-65`；`packages/runtime/src/plan/engine.ts` | 没有"生日场景"这类**业务编排样例**，只有引擎与测试场景 | 样例 0.5–1 人日（写一份 plan DSL + 一条快照） | **可修（中优先）**：这是赛题唯一明确点名的联动例子，成本低、讲故事收益高；若排期允许，建议在 C05/C06 之前补 | 3 |

### 1.2 核心技术要求 1：权限分级（赛题解析 §三.1）

| 要求 | 实现 | 证据 | 缺口 / 边界 | 门禁 | 自评 |
|---|---|---|---|---|---:|
| 绿色（自动执行） | `green` 工具直接执行，但仍过 sentry 与管线 | `packages/bank/src/tools/tier.ts`；`docs/tool-catalog.md` 级别列 | 无 | `scripts/verify-tiers.ts` | 5 |
| 黄色（用户确认） | 签发票据 → 展示详情 → 确认后才执行 | `packages/interaction/src/approval/service.ts`；`packages/host/src/boot/plugins/web/handlers/approval.ts` | 票据 TTL 与 plan 超时的关系已 fail-loud 校验 | 同上；`packages/host/src/boot/plugins/web.test.ts`（含拒绝判红） | 5 |
| 红色（强验证） | 人脸 / 短信 / U 盾挑战链 + 审批 | `docs/tool-catalog.md` 第 11、15 行；`verify_face/verify_sms/verify_ushield` | 强验证是**模拟挑战**，不是真实三方 SDK | `scripts/verify-tiers.ts` | 4 |
| 取高不取低 | `effectiveTier = max(声明, 升级规则)`，重试/渠道切换不降级 | `packages/bank/src/tools/tier.ts:4-9` | 无 | `verify-tiers` 有"重试不得把红降黄"用例 | 5 |

### 1.3 核心技术要求 2：安全机制五项（赛题解析 §三.2）

| 项 | 实现 | 证据 | 缺口 / 边界 | 自评 |
|---|---|---|---|---:|
| 幻觉防护 | 出口断言核验门（`verified` 原文发 / 未核实加前缀）＋ 权威库签名门 | `packages/safety/src/verify/`；`scripts/sign-knowledge.ts --check` | 只约束"有出处的断言"，不对自由文本做事实校验 | 4 |
| 注入防御 | 入口归一化 + 规则检测 + 工具白/黑名单 + PII 预算 | `packages/safety/src/sentry/{normalize,detect,tool-glob,pii,budget}.ts` | 规则式，不是模型判别；新攻击面靠补规则 | 4 |
| 操作审计 | 会话哈希链 + `tool/call`/`tool/result` 摘要/`approval/decided` 入链 + 判决可解释 | `packages/persistence/src/chain/`；`scripts/verify-audit-chain.ts`；`docs/audit.md` | **链上不存理由明文与结果原文**（`tool/result` 只存 `{callId,name,isError,code,durationMs}` 摘要）；签名按密钥存在性启用，缺钥 unsigned | 4 |
| 异常熔断 | HALT 全局停机（工具/审批/plan 三处全拒）＋ 失败预算 | `packages/safety/src/sentry/halt.ts`；`packages/host/src/boot/plugins/halt.test.ts` | HALT 落 `halt.json`、重启仍停机（C3）；不中止在途工具 | 4 |
| 沙箱环境 | 受限算术语言（无网络/无文件/无循环）＋ 沙箱策略与运行时 | `packages/safety/src/sandbox-policy/`、`sandbox-runtime/`；`scripts/verify-sandbox.ts` | 沙箱只覆盖计算工具，不是任意代码执行环境 | 4 |

### 1.4 核心技术要求 3：意图理解与任务规划（赛题解析 §三.3）

| 要求 | 实现 | 证据 | 缺口 | 修不修 + 理由 | 自评 |
|---|---|---|---|---|---:|
| 模糊表达 / 省略上下文 | 压缩摘要自带"每轮要点"，指代按摘要补全；摘要不宣告失忆 | `docs/plans/…` 修复回执见 `PROGRESS.md` §96.12；`packages/runtime/src/compaction/summarize.ts` | 实体槽位是**静态**（无运行时写入方），复杂指代靠摘要文本而非结构化槽位 | 修：见缺口报告 A1；赛前按"方案 A 承认静态"处理即可 | 3 |
| 复杂任务 DAG | `plan:dag` 引擎（拓扑、并发、超时、dry-run、可选节点） | `packages/runtime/src/plan/engine.ts`；`profiles/plan/patch.yml` | 业务样例薄（见 1.1 末行） | **建议补一份样例** | 3 |
| 中断 / 回退 / 人工接管 | turn 级取消（各阶段边界明确）；回退分叉；审批拒绝走人工；**运行时人工接管平面已落地（C5）**：`POST /api/handoff` 接管 → `/api/turn` 一律 409（不入 inbox）→ `GET /api/handoff` 会话摘要 → `POST /api/handoff/resume` 交回 | `docs/agent-loop.md` §5、§7；`docs/review/judge-walkthrough.md` §2 | 接管状态**在进程内**（重启回到未接管）、**不是**坐席工作台（无排队 / 工单 / SLA）；回退靠 fork 重放，不是交互式"退回一步" | **已做**（C5，2026-10-27 更新，8 条单测 + Web 端点）：残余边界照实说，不宣称坐席级接管 | 4 |

## 2. plan 三条硬约束（逐条给证据与"能否判红"）

| # | 约束 | 证据 | 有负例能判红吗 | 兜底方式 |
|---:|---|---|---|---|
| 1 | 节点执行必须走 `ToolPipeline.execute()`，禁止照抄 `saga-bridge.ts` 的 `executeTool` 绕过审批 | `packages/runtime/src/plan/` 内 `executeTool` 命中 **0**、`ToolPipeline` 命中 **5**；`packages/host/src/boot/plugins/saga-bridge.ts:302-315` 是**唯一**合法旁路（外层次已审批，sub-step 沿用它） | **无专门门禁**；"plan 节点绕审批"没有负例 | **靠人审**：代码评审 + 本表逐条扫描；`grep -rn "executeTool" packages/runtime/src/plan/` 现场可跑 |
| 2 | `packages/runtime/src/plan/` 不得 import 宿主包 | 全目录 `@bah/host` 命中 **2**，且**都在注释里**（`packages/runtime/src/plan/index.ts:5`、`types.ts:4`）；无 import 语句 | **有**：`scripts/verify-package-graph.ts:215` 对领域层反向依赖装配层直接判红 | 门禁（`verify-package-graph`） |
| 3 | `dryRun` 必须在 invoker **之前**短路 | `packages/runtime/src/plan/engine.ts:547-554`：`if (run.dryRun)` 先 `settle(..., 'skipped', 'plan-dry-run')` 并返回，不调用 invoker | **有**：`scripts/verify-plan-determinism.ts` + plan 用例断言 dry-run 不落 `tool/call`、不签票据 | 门禁（`verify-plan-determinism`） |

> 结论：三条里 **两条有门禁、一条靠人审**。答辩时按这个说法讲，不要笼统说"全部有门禁保证"。

## 3. 六条"不许误读"（可以怎么说 / 不许怎么说）

| # | 事实 | 可以怎么说 | 不许怎么说 |
|---:|---|---|---|
| 1 | 会话链签名按密钥存在性启用（B4）：`keys/saga-ed25519.pem` 存在 → `tool/call` / `tool/result` / `sentry/decision` / `approval/decided` 全签名；缺钥 → unsigned（stderr 明示） | "链提供顺序与完整性；私钥在位时四类证据行带 Ed25519 签名；演示缺钥时是 unsigned，哈希链仍连续" | "缺钥也算已签名" / "链不可伪造"（外部锚定仍缺） |
| 2 | 链上只存 `decision` / `policyVersion` / `subject` / `prevHash` | "完整理由在 `sentry/tool-denied` 与 `sentry/trace` 事件里，链上存的是判决数据的哈希" | "链上能看到完整理由" |
| 3 | 验链发生在**启动**与 `bah audit` 时 | "启动扫全链、离线审计可验；长跑进程里外部改中间行**不会立刻**被发现" | "运行中改链会被发现" / "实时检测篡改" |
| 4 | HALT 的持久化边界 | "停机状态落 `halt.json`，重启仍 HALTED；但**票据不持久化**，重启后必须重新走 U 盾审批；`halt.json` 损坏时拒启而不是当 RUNNING" | "重启后能自动解除" / "解除票据也存下来了" |
| 5 | HALT 只拦新 turn / 新工具 / 新 plan 节点 | "正在执行的写操作不打断，是为了保住原子性" | "HALT 会立刻中止在途工具" |
| 6 | 可运行 profile 只有 3 个（`headless` / `web` / `plan`），另 4 个是占位目录 | "演示只走三条 profile；其余是预留目录，没有配置" | "五个 profile 都接了" |

> 检索关键词固定为"不许误读"，同一张表已并入 `docs/drill-qa-100-2026-10-26.md` 与
> `docs/drill-final-checklist-2026-10-26.md` 第 11 条。

## 4. 危险表述扫描

- 扫描命令：`grep -n "运行中" docs/review/judge-walkthrough.md docs/drill-qa-100-2026-10-26.md`
- 允许出现的说法：**"运行中不立刻发现"**、**"启动与离线审计可验"**。
- 禁止出现的说法："运行中可发现篡改"、"实时防篡改"、"运行中验链已上线"。
- §2.4（运行中验链）在方案里是 P1 项，**未实现**；走查表按"未上线"记录。

## 5. 缺口汇总与决策（按"修不修"归档）

| 缺口 | 成本 | 决策 | 理由 |
|---|---|---|---|
| 跨场景联动业务样例 | 0.5–1 人日 | **建议修** | 赛题唯一点名的联动例子，纯新增、零回归风险 |
| 年度账单口径 / 异常识别扩展 | 0.5–1 人日 | 可延后 | 文案与参数级，不影响评分主线 |
| 卡片管理另三个动作 | 3–6 人日 | 不修 | 每个都要独立治理分支，收益低于视频/PPT |
| 理财赎回 + 风险评估 | 4 人日 | 不修 | 需引入持仓账本，属新领域模型 |
| 订阅自动识别与提醒 | 2–4 人日 | 不修 | 提醒依赖外部通道，不在本期范围 |
| 定时转账 / 拆分 AA | 5–8 人日 | 不修 | 需调度子系统与部分失败语义 |
| 运行时人工接管（handoff 平面） | — | **已落地（C5，更新于 2026-10-27）**：`POST /api/handoff` 接管 → `/api/turn` 一律 409 且不入 inbox → `GET /api/handoff` 会话摘要 → `POST /api/handoff/resume` 交回 | 残余边界照旧登记：状态在进程内（重启回到未接管）、**不是**坐席工作台（无排队 / 工单 / SLA），见 README §4 人工接管行 |
| 实体槽位运行时写入 | 3 人日 | 按"方案 A"承认静态 | 静态槽位不影响演示主路径，删死分支即可 |

另有一组**机制面**未实现（与上表"业务面"缺口互补，**不在本表重复维护**）：
HP-2 RAG 响应信封签名、强验证接真实渠道、对抗集幻觉族 H-13/H-14/H-15 未降级、
plan 节点写操作无补偿、plan 动态 args 跨不了 `resume`、`incident` 无真实触发源，
外加覆盖率两包（`memory-store` 72.71% / `eval` 40.73%）。
**统一口径与取舍理由以 `docs/security-design.md` §4 为准**，答辩引用请从该节取。

## 6. 评委可能追问的三问（附标准答法）

1. **"最高的分数在哪？"** —— 权限分级与审计：三档都有代码、门禁与负例，拒绝路径能判红（见 §1.2 与 `web.test.ts` 的拒绝用例）。
2. **"最难看的一条是什么？"** —— 卡片管理和订阅代扣只覆盖了部分动作；我们不把它说成"全场景覆盖"（见 §1.1 自评 2 分）。
3. **"审计能不能防内部人改日志？"** —— 不能宣称能：哈希链 + 启动/离线验链 + `tool/result` 重放硬比对（B4）能让改行在下次启动或离线审计时暴露；无外部锚定，签名在缺钥演示环境是 unsigned（见 §3 第 1–3 条）。
