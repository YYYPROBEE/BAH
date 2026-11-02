# Web 帧契约（`packages/channels/src/web/frames.ts`）

> 本表是**帧种**的唯一人读清单。机器判据：`scripts/verify-frame-closure.ts`（I-F1..F4）。
> 加一个帧 = 同批改四处：`frames.ts` 联合 → `project.ts` 产出 → 桌面/移动消费者 → 本表。

## 1 帧种

| kind | 载荷要点 | 产出（`project.ts`） | 桌面消费者 | 移动消费者 |
|---|---|---|---|---|
| `turn` | 轮次开始/结束、结束原因 | `turn/start` / `turn/end` | `views/conversation.js` | `mobile/shell.js` |
| `message` | 用户/助手/坐席消息块 | `user/message` / `assistant/message` | `views/conversation.js` | `mobile/feed` |
| `delta` | 流式增量（ephemeral，不落账） | `deltaFrame()` | `store.js` | `store.js` |
| `tool` | 工具卡片三态 + 卡片视图 | `tool/call` / `tool/result` | `views/tool-card.js` | `mobile/plan-steps.js` |
| `approval` | 审批卡（六要素 + **服务端 `details` 明细** + `confirmText` 打字确认） | `approval/asked` | `views/approval.js` | `mobile/approval-sheet.js` |
| `approval-closed` | 审批结论 | `approval/decided` | `views/approval.js` | `mobile/approval-sheet.js` |
| `notice` | 判停/失败/压缩等提示 | `turn/end` 非完成、压缩等 | `views/conversation.js` | `mobile/shell.js` |
| `audit` | 审计条目（事件投影） | `auditOf()` | `views/audit.js` | `mobile/shell.js` |
| `dag` | 一轮的调用图 | `plan/*` 域事件 + 工具调用 | `views/dag.js` | `mobile/plan-steps.js` |
| `choice` | 追问候选卡 | `prompt_ask` 结果 | `views/*`（choice-card） | `mobile/choice-card.js` |
| `risk-questionnaire` | 风险问卷卡（5 题 × 3 选项，整张提交） | `read/risk-questions` 域事件 | `views/risk-form.js` | `mobile/shell.js`（与桌面共用同一张卡） |
| `goal` | 会话级目标条 | `goal_set` 结果 | `store.js` / 头部 | `mobile/plan-steps.js` |
| `todo` | 派生清单 | `plan/*` 派生 | `views`（todo） | `mobile/plan-steps.js` |
| `effects` | 一轮的已发生操作清单 | 写操作的 `tool/result` | `views`（effects） | `mobile/effects-list.js` |
| `handoff` | 人机接管状态 | `handoff/*` 域事件 | `main.js` 横幅 | `mobile/shell.js` |
| `handoff-warn` | SLA 超时预警 | `handoff/timeout-warned` | `main.js` 横幅 | 移动端不展示（见门禁 `MOBILE_IGNORES`） |
| `snapshot` | 全量快照（重同步） | `snapshot()` | `store.js` | `store.js` |
| `plan-card` | 计划卡（授权档/预算/条件快照/判决/补偿） | `plan_arm` / `plan_disarm` / `plan_wake` 的 `tool/result` | `views/plan-card.js` | `mobile/plan-card.js` |

## 2 两条不变量

1. **帧是投影，不落盘**：帧由会话事件（含 `plan/*` 域事件与 `tool/result`）纯函数归约而来；
   同一串事件两次归约必须深度相等（`project.test.ts` 钉住）。
2. **`plan/created` / `plan/resumed` 不产帧**：它们没有节点态；计划卡的投影源是
   `plan_arm` / `plan_wake` 的 `tool/result`，不是这两个键（既有约定保持不动）。
3. **`approval.details` 是原样投影**（2026-10-31）：帧上的 `label` / `value` / `emphasis`
   与 `approval/asked.details` 逐字相同，渠道**不重算金额、不重新格式化日期**；
   形状守卫只做剔除（空标签/空值/未知强调），超 `DETAILS_MAX_ROWS`（12）截断并置
   `detailsTruncated`，完整内容仍在事件里。明细**不参与**票据指纹与判决。
4. **计划卡状态是封闭八态**（2026-11-01）：`armed` / `due` / `running` / `done` / `failed` /
   `cancelled` / `expired` / `needs-reconfirm`。后两个只由 `plan_wake` 的 entry `code` 驱动：
   `window-expired` → `expired`（终止，不补扣）；`details-changed` / `condition-failed` →
   `needs-reconfirm`（还来得及但要重新确认）；其它失守仍是 `failed`。渠道**不得**自己推导状态。

## 3 加帧检查表

```bash
pnpm exec tsx scripts/verify-frame-closure.ts   # I-F1..I-F4
pnpm exec vitest run packages/channels/src/web   # 归约器与帧的纯函数测试
pnpm test:web                                   # 视图渲染
```
