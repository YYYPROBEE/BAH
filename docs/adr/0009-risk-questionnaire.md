# ADR-0009 · 风险测评改为服务端问卷（动作豁免 + 确认留痕）

- 状态：**已采纳**（2026-10-31）
- 关联：「模型直接提交 5 个数字」、`docs/contracts/event-table.md` §4.3、`docs/tool-catalog.md` 第 13 行
- 影响面：`packages/bank/src/core/risk-questionnaire.ts`（新）、`packages/bank/src/tools/{specs,tier,governance,wealth,events,dto,result-schemas}.ts`、`packages/llm/src/demo/router.ts`、`packages/channels/src/{web/frames,web/project,im/render}.ts`、`apps/web/src/views/risk-form.js`

---

## 1 背景

`risk_assess` 原来的入参是 `answers: integer[5] (1..5)`：**5 个分值由模型给**。
于是审计链上只有"某次工具调用把客户等级从 R2 改成 R5"，没有任何证据能回答：

1. 用户被问了什么？（题干不在任何地方）
2. 用户答了什么？（只有 1–5 的分值，没有选项文本）
3. 用户确认过吗？（黄级 ask 的审批卡只显示"执行 risk_assess"，没有内容可确认）

结论：C-03 不是"提示词没写好"，是**数据通路缺了三段**。只在提示词里写"不要替用户作答"
无法修复——模型仍然能编一组合法分值走完整个链路。

## 2 决策

### 2.1 问卷实例由服务端签发（题目与分值是代码常量）

新增 `packages/bank/src/core/risk-questionnaire.ts`：

| 结构 | 说明 |
|---|---|
| `RISK_QUESTIONS` | 5 题 × 3 选项，分值 1/3/5。**唯一常量表**，模型不可见亦不可改 |
| `RiskQuestionnaire` | `{ id, userId, version, issuedAt, expiresAt, questions }`，一次性凭证 |
| `RiskQuestionnaireBook` | `issue` / `get` / `assess`；状态机唯一属主（与 `TicketStore` 同定位） |

`MockBankCore` 增加三个方法：`issueRiskQuestions` / `getRiskQuestionnaire` /
`assessRisk({ userId, questionnaireId, answers })`。**入参从"分值数组"改成"问卷 ID + 逐题键"**。

五道校核（顺序即安全边界）：

```text
存在 → 归属 → 重测冷却 → 未过期 → 五题齐全 → 选项属于该题
```

- **归属先于过期**：别人的卷与不存在的卷返回**同一个** `risk-questionnaire-unknown`，
  否则错误码本身就是"这个问卷 ID 存在"的侧信道；
- **冷却在归属之后、过期之前**（2026-11-01 补，R-2）：冷却码只对「本人的真实卷」出现，
  不新增枚举面；过期卷先报过期（更贴近用户实际处境）；
- 任一失败都不写库、不消耗问卷（用户改正后可重试）；
- 落档成功即核销（一次性）：重放得到 `risk-questionnaire-unknown`。
  没有这条，"用户确认过"就可以被重放成多次等级变更。

分数带映射仍走 `model.ts` 的 `riskGradeOfScore`，阈值（≤8 / ≤12 / ≤16 / ≤20）逐字未动。

### 2.2 `risk_assess` 改为动作式，只读动作在 `tier.ts` 里豁免

```json
{ "action": "questions" | "submit", "questionnaireId": "...", "answers": [{ "index": 1, "key": "middle" }] }
```

`action="questions"` 不写库，但工具级 `tier` 是 `yellow` —— 不给读分支开口，用户点
"开始测评"会先看到一张"执行 risk_assess"的审批卡：为一个不写库的请求签名，既吓人又让审批贬值。

**决策：在 `tier.ts` 加封闭表 `READ_ONLY_ACTIONS = [{ name:'risk_assess', action:'questions' }]`，
`decide()` 在身份闸之后、升级规则之前直接返回 `{ kind:'allow', level:'green', reason:'declared' }`。**

四条约束（缺一不可）：

1. **封闭表**：动作值只来自这张表，不从 `args` 里猜；表外 `action` 照常 ask；
2. **只读验证**：豁免分支确实不写库（问卷下发只改实例表，不改主体等级）；
3. **审计留痕**：判决落 `tier/decided`，`level='green'`、`reason='declared'` ——
   回放能看出"这一次为什么没问"，而不是"系统漏问了"；
4. **不许工具内自判**：`wealth.ts` 不含任何 `level` 判断，`execute` 里不出现阈值。

被否决的替代方案：**新增读工具**（如 `risk_questions`）。否决理由是工具目录已在上限
（28/28，`verify-tool-catalog` 强制），为一个两步流程的一个动作挤掉一个业务工具不划算；
且"发卷/交卷"本就是同一件事的两步，拆开后治理面还要解释"为什么取问卷也是黄级"。

### 2.3 确认凭证写进 `risk/assessed`

```ts
'risk/assessed': {
  result, questionnaireId, version,
  confirmedBy: 'approval-ticket',   // 封闭字面量：没有票据就不该有这条事件
  ticketRef,                        // 票据 ID，可反查审批链
  answers,                          // 逐题键（冗余落账，单条读全）
}
```

新增事件键 `read/risk-questions`（31→32），载荷带**题目快照**与 `currentGrade`：
只留问卷 ID 的话，常量表一改版历史就复现不出来。

`spec.event` 只写 `risk/assessed`，另加 `BankToolSpec.readEvent` 表达只读分支；
目录渲染成 `` `risk/assessed`（读分支：`read/risk-questions`） ``，
避免文档让读者以为"取问卷也会改等级"。

### 2.4 审批卡逐题回显（details）

`risk_assess(action="submit")` 的 `ask` 判决签发 `TicketDraft.details`：
5 行「题干 → 所选项文本（分值）」+ 合计得分 + `from → to`。
题干与分值全部读 `core.getRiskQuestionnaire`（服务端常量），**不是模型参数**；
问卷读不到就整组省略，不填占位符。批准 = 用户逐题确认。

### 2.5 渠道

- **Web**：新增 `risk-questionnaire` 帧（由 `read/risk-questions` 投影），
  5 题一张卡、答满才可提交；提交内容是一条**用户消息**：
  `风险测评作答 rq-1 1=conservative 2=middle …`；
- **IM**：`projectImOutbound` 把问卷投影成文本（题干 + 键/文本/分值 + 作答模板）。
  IM 侧**不做逐题累积状态机**：网关的待办槽位只有审批与计划，再加一份"答到第几题"
  就是第二份问卷状态，且丢一条消息就永久错位。用户一条消息交完整份问卷，
  校验仍在服务端（齐全性 / 归属 / 过期）。

## 3 不声称（对外说明时必须说清）

1. **不是监管全卷**：5 题固定、3 选项，"覆盖度"不等于《证券期货投资者适当性管理办法》
   的正式问卷；
2. **重测冷却只在一个进程内生效**（2026-11-01 补，R-2）：同一用户落档成功后进入
   `bank:tools.riskCooldownDays`（缺省 1 天，演示可配 0）的冷却窗口，窗口内再提交返回
   `risk-retest-cooldown`（工具层翻译成「距上次测评不足 N 小时，请在 M 小时后重试」），
   且**不核销新卷**；冷却结束、卷仍在 15 分钟 TTL 内时可继续用同一张卷。
   `lastAssessedAt` 是进程内 `Map`，重启清零；冷却只节流"同一用户反复刷"，
   不替代审批卡逐题回显与一次性票据（见 R-22）；
3. **IM 不是逐题问答**：一次成型的作答格式，交互体验弱于 Web；
4. **`details` 不参与指纹**：改明细不会让票据失效（这是设计，不是漏洞）；
5. 问卷 ID 是自增序号（`rq-1`），不含随机性 —— 可预测，但归属与一次性核销
   不依赖它的不可猜性。

## 4 后果

- 正向：模型不再持有"客户等级的输入"，只能搬运用户的选择；审计可回答"问了什么、答了什么、谁确认"；
- 正向（2026-11-01，R-2）：重测冷却把"反复取卷刷等级"从无限次变成每冷却周期一次，
  且冷却拒绝**不消耗新卷**；
- 正向（2026-11-01，R-6）：`read/risk-questions` 与 `risk/assessed` 进 Web 审计时间线
  （「查看风险问卷」/「风险测评：R1 → R2（5 题）」），分类复用 `tool`、不新增色条；
- 负向：冷却窗口内无法改等级（含合法更正），需要等窗口过去或把 `riskCooldownDays` 配 0；
- 负向：多一次工具往返（取卷 → 提交），Web 端多一个帧与一张卡；
- 中性：`RiskAssessResult` 从单一形状变为判别式联合，出参契约用 `oneOf` 两个分支表达
  （校验器只支持根级一层 `oneOf`，见 `docs/pipeline.md` §8）；分支必填由 schema 与
  工具体类型**双保险**，不再是"只有 TS 类型在管"（R-8 已关，2026-10-31）。
