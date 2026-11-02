# 六场景子能力 · 旅程证据覆盖矩阵

> 口径：**行 = 赛题 §二 的 26 个原子子能力**，不是按工具聚合。
> 按工具聚合的视图见 [bank-tools.md](bank-tools.md) §2；两张表不是两个真相源——
> 本表回答「赛题点名的能力有没有可复跑的端到端证据」，bank-tools 回答「每个工具落在哪个模块」。

## 1. 矩阵

**旅程证据列只允许四种取值**：`eval:<ID>`（进 CI 的 91 面）／`gaps:<ID>`（本轮手动复跑面，不进 CI）／`snapshot:<目录>`（快照回放）／`—`（无旅程证据）。
状态列的 base 值闭集：`full`／`gaps-only`／`tool-only`／`partial`；`partial` 在括号里附一句原因。

| 场景 | 官方子能力 | 工具（tier） | 单元/领域用例 | 旅程证据 | 状态 |
|---|---|---|---|---|---|
| 智能转账 | 按人名转账 | `transfer_preview`（绿）`transfer_create`（黄，按金额/收款人升红） | `tools/transfers.test.ts`、`tools/governance.test.ts`、`tools/tier.test.ts` | `eval:T-04`、`eval:P-03` | full |
| 智能转账 | 按手机号转账 | `transfer_preview` / `transfer_create`（payee.phone） | `tools/transfers.test.ts`、`packages/runtime/src/intent/resolve.test.ts` | `eval:U-04` | partial（U-04 证 11 位号码识别为收款人且不被当金额；执行链只在 T-04 用人名收款人，两者尚未合并成一条「按手机号扣款」旅程） |
| 智能转账 | 按备注转账 | `transfer_create`（`memo` 是转账附言） | `tools/transfers.test.ts`、`docs/bank-tools.md` §2 口径句 | `—` | partial（`memo` 只作附言；按备注**检索收款人**未实现，`findPayee` 只认姓名/手机号；同类「上次那笔」体验由 `eval:T-13`／`eval:U-17` 的记忆复现路径承担） |
| 智能转账 | 定时转账 | `transfer_schedule`（宿主工具，黄/红）、`plan_arm` | `packages/host/src/boot/plugins/plan.test.ts`、`plan-wake.test.ts`、`authorization/armed.test.ts` | `snapshot:proactive` | partial（快照证 `plan_arm` 授权窗口的到期执行与条件失守；用户侧 `transfer_schedule` 没有单独的会话旅程） |
| 智能转账 | 拆分 AA 收款 | `aa_create`（黄；`status` 只读绿） | `tools/aa.test.ts`、`tools/aa.boundaries.test.ts`、`core/mock.aa.test.ts` | `gaps:P-41`、`gaps:P-42`、`gaps:P-43` | gaps-only |
| 账单分析 | 消费分类统计 | `bill_analyze`（绿） | `tools/queries.test.ts` | `eval:Q-13` | full |
| 账单分析 | 异常交易识别 | `bill_analyze`（绿） | `tools/queries.test.ts`（`anomalies.length > 0`） | `gaps:Q-33` | gaps-only |
| 账单分析 | 月度账单报告 | `bill_analyze` / `bill_report`（绿） | `tools/queries.test.ts` | `eval:Q-04`、`eval:Q-05` | full |
| 账单分析 | 年度账单报告 | `bill_report`（绿） | `tools/queries.test.ts` | `eval:Q-14` | full |
| 理财操作 | 产品推荐 | `wealth_list`（绿） | `tools/wealth.test.ts` | `eval:Q-07` | full |
| 理财操作 | 产品对比 | `wealth_compare`（绿） | `tools/wealth.test.ts` | `eval:Q-08` | full |
| 理财操作 | 风险评估 | `risk_assess`（黄；`questions` 只读绿） | `tools/risk.test.ts`、`core/risk-questionnaire.test.ts`、`core/mock.risk-questionnaire.test.ts` | `gaps:Q-32`、`gaps:P-40` | gaps-only |
| 理财操作 | 一键申购 | `wealth_purchase`（红，适当性闸门） | `tools/wealth.test.ts`、`tools/governance-suitability.test.ts` | `eval:P-08`、`eval:P-11` | full |
| 理财操作 | 一键赎回 | `wealth_redeem`（红） | `tools/wealth.test.ts`、`tools/governance.redeem-amount.test.ts` | `gaps:P-39`、`gaps:P-46` | gaps-only |
| 卡片管理 | 卡申请 | `card_apply`（黄） | `tools/account-ops.test.ts`、`tools/result-schemas.test.ts` | `gaps:P-31`、`gaps:P-33`、`gaps:P-45` | gaps-only |
| 卡片管理 | 额度调整 | `card_limit_set`（红） | `tools/account-ops.test.ts`、`core/mock.card-limits.test.ts` | `gaps:P-38` | gaps-only |
| 卡片管理 | 交易限制 | `card_restriction`（黄） | `tools/account-ops.test.ts`、`core/mock.cards.test.ts` | `gaps:P-34` | gaps-only |
| 卡片管理 | 交易限制解锁 | `card_restriction`（黄） | `tools/account-ops.test.ts`、`core/mock.cards.test.ts` | `gaps:P-35` | gaps-only |
| 卡片管理 | 卡片挂失 | `card_report_lost`（红）、`card_freeze`（黄）、`card_unfreeze`（红） | `tools/account-ops.test.ts`、`core/mock.cards.test.ts` | `eval:P-09`、`eval:P-10`、`gaps:P-32`、`gaps:P-36`、`gaps:P-37`、`gaps:P-47` | partial（官方面只有拒绝侧（P-09/P-10）；成功挂失与冻结/解冻在 gaps 面） |
| 订阅/代扣 | 自动识别订阅扣费 | `sub_list`（绿，检测只读） | `tools/subscriptions.test.ts`、`scripts/report-subscription-detection.ts` | `snapshot:subscription` | full |
| 订阅/代扣 | 续费提醒 | `sub_watch`（黄）、`proactive/reminder` | `tools/subscriptions.test.ts`、`host/src/boot/plugins/proactive.test.ts` | `snapshot:subscription-reminder` | full |
| 订阅/代扣 | 一键取消订阅 | `sub_cancel`（黄） | `tools/subscriptions.test.ts` | `eval:P-04`、`eval:P-06` | full |
| 跨场景联动 | 检测「我爱人生日」 | `fact_remember` + `birthday-reminder` job | `host/src/boot/plugins/birthday.test.ts`、`runtime/src/fact/fact.test.ts` | `snapshot:birthday-reminder`、`snapshot:cross-scene` | full |
| 跨场景联动 | 当月锁定 1,000 元活期 | `plan`（向本人锁定账户 `a-3(9012)` 的内部划转）、`fund_lock` | `tools/fund-lock.test.ts`、`host/src/boot/plugins/plan.test.ts` | `eval:D-11`、`snapshot:cross-scene`、`snapshot:proactive` | partial（D-11 锁 100 元、cross-scene 锁 300 元到 `a-3`；1,000 元只出现在 `snapshot:proactive` 的预算窗口里，没有 1,000 元锁定的完整旅程） |
| 跨场景联动 | 生日前 2 天订购鲜花 | `transfer_create`（商户腿）、`birthday_plan` | `core/merchant.test.ts`、`host/src/boot/plugins/plan-details.test.ts` | `eval:D-11`、`snapshot:cross-scene` | partial（两份证据都证馨香花艺商户腿执行；「前 2 天」由计划 `dueAt` 表达，没有独立的时间窗旅程） |
| 跨场景联动 | 生日前 2 天订购蛋糕 | `transfer_create`（商户腿）、`birthday_plan` | `core/merchant.test.ts`、`host/src/boot/plugins/plan-details.test.ts` | `eval:D-11`、`snapshot:cross-scene` | partial（同上；D-11 最后一笔 30 元、cross-scene 最后一笔 100 元即甜心蛋糕坊） |

### 1.1 不在 §二 26 行内、但属于本轮补齐面的两项

下面两项出自赛题 §三·1（权限分级的绿/红档示例），**不占上表 26 行**；
但它们是本轮 11 个缺证据子能力里的 GAP-CAP-05 与 GAP-CAP-10，
对应的 3 条场景必须在这里有落点，否则 Q-31 / P-44 / P-48 会变成矩阵里的孤儿。

- **理财收益/持仓（§三·1 绿档示例）**：工具 `wealth_positions`（绿）；单元/领域用例
  `tools/wealth.test.ts`；旅程证据 `gaps:Q-31`；状态 `gaps-only`。
- **密码修改（§三·1 红档点名）**：工具 `password_change`（红）；单元/领域用例
  `tools/password.test.ts`；旅程证据 `gaps:P-44`、`gaps:P-48`；状态 `gaps-only`。
  会话内只证"发起 + 审批拒绝"；安全页完成腿（`consumePasswordHandoff`）仍只有 16 条单测背书。

上表 18 条 gaps 证据 + 本节 3 条 = 本轮 21 条场景，全部有落点。

## 2. 口径声明

1. **旅程只认真实 `tool/call` 与落账事件**：引用次数、单测调用、代码注释都不算旅程证据。
   `eval:` 前缀 = 官方 91 例（`pnpm eval`，进 CI 的 14 步）；`gaps:` 前缀 = 本轮补齐的 21 条
   （`pnpm eval:gaps`，**不进 CI 的 14 步、不计入 91 口径**）；`snapshot:` = `pnpm test:snapshot` 回放。
2. **数字口径**：91 例、78/78、6/6、7/7、平均 1.44 步、53 项门禁、14 步等对外数字**均未因本轮变化**。
   补齐面的 21 条只在答辩时以「另经 `pnpm eval:gaps` 手动复跑」单列。
3. **负控**：21 条都做过「故意改错一处断言」的负控（比 DoD 要求的 6 条抽样多做了 15 条），
   改错后 `pnpm eval:gaps` 全部报 `assertion-failed`，恢复后 21/21 绿。没有这一步的场景不记 `gaps:<ID>`。

## 3. 夹具说明（必读）

- `eval:gaps` 的 `allow` / `reject` 组由评测夹具 overlay 决定：`responder: headless`、
  `autoDecision: allow|reject`、`autoVerify: true`。**不是**生产 profile 的默认值，也不改 `profiles/headless.yml`。
- `gaps:P-40` 的 `answers` 是**夹具代答**：等价于演示应答者按用户点选逐题提交，不是模型推断选项。
  工具契约原文「不得替用户作答或推测选项」仍然有效；场景 `title` 已按该口径写死，避免把测试便利当成产品能力。
- `gaps:P-42` 的 AA `collect` 是**模拟代收**：本进程替参与人把份额记进组织者账户并写入账流水，
  **不是真实到账**，跨人清算接口不存在（ADR-0011）。场景 `title` 已写明「不是真实到账」。
- 卡片类事件的载荷没有 `result` 包装（见 `packages/bank/src/tools/events.ts`），因此对应断言用
  `event … where{…}` 钉事件字段；理财持仓/赎回、风险测评、AA 建组走事件的 `result`。

## 4. 30 秒复算

把下面脚本存成 `check-coverage.py` 后运行 `python check-coverage.py`：它校验行数、证据前缀与状态闭集，并打印计数。

```python
import re
from pathlib import Path

text = Path('docs/scenario-coverage.md').read_text(encoding='utf-8')
rows = [line for line in text.splitlines() if line.startswith('|') and '---' not in line]
header, body = rows[0], rows[1:]
assert len(body) == 26, f'期望 26 行子能力，实际 {len(body)}'
allowed = re.compile(r'^(eval:[QTPSDKU]-\d{2}|gaps:[QTPSDKU]-\d{2}|snapshot:[a-z0-9-]+|—)$')
statuses = {'full', 'gaps-only', 'tool-only', 'partial'}
counts = {'eval': 0, 'gaps': 0, 'snapshot': 0, 'none': 0}
for line in body:
    cells = [c.strip() for c in line.strip('|').split('|')]
    assert len(cells) == 6, f'列数应为 6：{line}'
    evidence = cells[4]
    for token in [t.replace('`', '').strip() for t in evidence.split('、')]:
        assert allowed.match(token), f'非法证据取值：{token}'
        counts['none' if token == '—' else token.split(':')[0]] += 1
    base = cells[5].split('（')[0].strip()
    assert base in statuses, f'非法状态：{cells[5]}'
print(f'26 行通过；证据计数 {counts}')
```
