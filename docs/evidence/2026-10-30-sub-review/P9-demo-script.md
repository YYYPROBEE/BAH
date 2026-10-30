# 场景 5 · P9 演示脚本与答辩八问（2026-10-30）

> 口径：全部结论可指到 `file:line` 或可跑命令；**合成数据**与真实数据的边界逐处写明。
> 本轮所有结论由主线程自审（**审查者与被审者未分离**，本仓禁派子智能体）。

## 0. 90 秒演示（离线、确定性）

启动：

```bash
pnpm bah --profile web --serve --patch profiles/web/patch-subscription.yml
# 打印的 URL 自带 Bearer token；审批弹窗走 Web（responder: none）
```

| # | 用户话术 | 期望 | 证据 |
|---|---|---|---|
| 1 | 我有哪些订阅 | `sub_list` 卡片：事实 8 项；三分法「订阅 8 / 账单 2 / 分期 1」；顶部断供失败警报（协议已关仍扣款） | `snapshots/subscription/session.jsonl` 的 `read/subscriptions` |
| 2 | 这个月订阅怎么多了 5 块 | 同一工具，涨价条目排第一：视频会员 30→35（第 4 期起） | `recurring.test.ts` 边界 4 |
| 3 | 彻底停掉云音乐的扣款 | 黄档审批 → `sub_authorize`：影响该商户 1 个订阅；恢复需商户侧重新签约 | `subscriptions.test.ts` 的「关协议」用例 |
| 4 | 视频会员退订 | **硬拦**：合约期至 `now+90d`，`subscription-contract-active`，不签票、不执行 | `snapshots/subscription/session.jsonl` 的 `subscription-contract-active` |
| 5 | 确认，到期即断 | 黄档审批 → `sub_cancel(mode=at-next-cycle)`：状态 `paused` + `pauseUntil`，写 `CancelRequest` | 同上，`sub/cancelled` 载荷仍是旧三字段 |
| 6 | （转场，可选）提前三天提醒我续费云音乐 | `sub_watch` 黄档；【即将扣款】只在该订阅进入提前量窗口时出现 | `slots.test.ts` 的 `reminderAheadDays` 用例 |

时长账：2 张审批卡 + 1 次硬拦 + 1 次影响面复述 ≈ 90 秒。第 6 步作为备用，不作为主脚本。
**与方案的一处偏差**：方案 P9 写「该商户 2 个订阅」，但 P3 数据规格每个商户只有 1 个订阅；
演示按**实际影响面 1 个**说，不虚构。

## 1. 检测指标（答辩第一问的答案）

- 标注集：`benchmarks/subscription-detection/`（clean-24 / dirty-40 / edge-18，**合成数据**）；
- 报告：`docs/evidence/2026-10-30-sub-detect/metrics.md`（命令 `npx tsx scripts/report-subscription-detection.ts`）；
- 本轮口径：high 层 precision **100%**、all 层 recall **97.5%**、kind 准确率 **100%**、
  下次扣款误差 ≤3 天 **97.4%**；2 条 FN 是故意只给 2 笔的系列（低于 3 笔下限）。
- **必须同句说**：这是合成标注集，不是真实银行流水；真实世界 precision 未测。

## 2. 答辩八问（按落地现状）

| # | 问 | 答（可指代码） |
|---|---|---|
| 1 | 检测准确率多少 | 报分层：high 层 precision（直接入册）、medium 层召回（待确认）；N=78 合成 series；口径见 `metrics.md`。**不报 overall 充数** |
| 2 | 误取消怎么办 | 三道闸：① 合约期硬拦（`subscription-contract-active`，`account-ops.ts`）；② 影响面复述（关协议影响该商户全部订阅）；③ 核验窗口（`verifyBy` 后仍扣款 = `failed` + 争议工单） |
| 3 | 银行凭什么能「取消」 | 拆两词：**退订**（`sub_cancel`，停一个订阅）/ **断供**（`sub_authorize`，关商户协议，影响该商户全部订阅）。只做断、不做续——恢复是重新签约，不是撤销的逆运算 |
| 4 | 关了代扣商户说我违约 | 分期类走红档 + 风险提示；合约期 `contractEndAt` 有值时不走快刀，只给「到期即断」；断供后商户继续扣款 → `deriveCutoffFindings` 标 `breached`（critical） |
| 5 | 房租也算订阅吗 | 三分法：`kind` 在检测层就分开；房租/水电是 `bill`，只进统计不进订阅清单（`recurring.ts` 的 `classifyKind`） |
| 6 | 数据是假的，检测有意义吗 | 算法与数据解耦：`detectRecurring(transactions)` 只吃 `Transaction[]`；换真流水只换数据源；标注集与报告可复跑 |
| 7 | 和支付宝代扣管理区别 | ① 主动检测（不用翻设置页）② 跨账户聚合 ③ 决策辅助（涨价/闲置/合约）④ **断供核验**（关了还扣会喊）——第④条是账户本体独占能力 |
| 8 | 安全五件套里「沙箱」落点在哪 | **如实答：本场景没有**。bank 工具族没有文件导出通道，订阅报表导出本期不做；沙箱在本仓用于不可执行代码（`analysis_calc`）。这是登记缺口，不是遗漏 |

## 3. 已知缺口（不靠话术糊）

- 推送通道未接：提醒只在对话内（系统提示词【即将扣款】），不是短信/推送；
- 导出报表无 bank 文件通道：本期不做，登记在 `施工方案 §1`；
- B 档（商户侧代填）不代客提交，只给「预计 2–10 天」路径卡；
- 恢复扣款不做：需商户侧重新签约；
- `confirmContract` 由模型填：审批卡展示「已确认合约后果」，但无法证明用户口头确认（残余风险）。

## 4. 与施工方案的偏差登记

| # | 偏差 | 原因 |
|---|---|---|
| 1 | 新增第 8 个快照场景 `snapshots/subscription`（10 文件 / 43 例） | `verify-snapshot-fresh` 要求新增 `bank/src/detect/` 有场景覆盖；同时作为 P9 的端到端证据 |
| 2 | 离线路由新增订阅意图（`packages/llm/src/demo/router.ts`） | 方案未列，但没有它 Web/离线演示无法触发三个新工具 |
| 3 | `sub_authorize.reason` 删除 | 声明了却不进任何载荷/结果（ADR-0007 载荷冻结），保留就是假参数 |
| 4 | 演示第④步改为「影响 1 个订阅」 | 方案 P9 与 P3 数据规格冲突，按实际数据说 |
