# ADR-0013：生日计划原子性与补偿（商户腿两阶段 + 父预算 + 冲正）

> 状态：已接受（2026-11-01）
> 解决的缺口：三腿互不关联、商户失败不冲正、无父预算账本、涨价不复验
> 关联：ADR-0008（授权窗口）、ADR-0010（窗口代签）、ADR-0012（卡消费）

## 1. 问题

`birthday_plan` 原先一次武装**三张互不关联**的窗口（锁预算 / 鲜花 / 蛋糕）：

1. 唤醒时「银行腿成功 → 再串行商户履约」，商户失败只把 entry 标 `failed`，**已扣的钱不冲正**；
2. 三条腿各自判自己的预算，没有父预算账本；
3. 商户涨价后按新价成交，用户看到的报价与实际支付可能不一致。

## 2. 决策

### 2.1 父计划与预算

- `ArmedPlan` 新增可选字段 `parentPlanId` / `legKind` / `parentBudgetCents`；
  `birthday_plan` 以 `${ictx.callId}-birthday` 作为父 id，三腿共享父预算（三腿预算之和）。
- 唤醒时，同一父计划下**已成功腿**的累计金额从 `plan/completed`（`status='succeeded'` 且
  `at >= armedAt`）派生，不另建账本文件；累计 + 本腿 > 父预算 ⇒ `skipped(budget-exhausted)`，
  不扣款、不订商户，发 alert。
- 边界：`birthday_plan` 的算术下三腿预算之和 = 父预算，先验上"超父预算"不可达；
  守卫抽成纯函数 `parentBudgetAllows` 并由单测钉住等号/超 1 分边界，供将来动态 args 使用。

### 2.2 商户腿两阶段（先订后付）

`packages/bank/src/forge/merchants.ts`：

- `reserveOffer(offers, offerId, fault, seq)`：只占位，返回值语义的 `MerchantReservation`
  （无模块级登记表）；缺货/超时/未知 offer 在这里失败，**不产生资金动作**。
- `commitOffer(offers, reservation, fault)`：重新对照目录；库存没了 / 价格变了 → 失败
  （`price-changed`）。`releaseOffer` 是 mock 语义动作。
- `orderOffer` 保留为兼容包装（reserve → commit），既有调用方行为不变。

`packages/host/src/boot/plugins/merchant.ts` 的 `MerchantService` 增加 `reserve` / `commit` / `release`；
引用闭包在 `reserve` 就判定（没搜过的 offer 连占位都不许）。`fulfil` 保留，内部仍走 reserve→commit。

### 2.3 唤醒顺序（固定）

```
reserve（缺货/超时在此失败，未扣款）
→ 价格复验：预占价 ≠ 用户批准价 ⇒ release + skipped(price-changed) + alert
→ 预算复验：预占价 > 本腿预算 ⇒ release + skipped(over-budget)
→ 银行腿（transfer_create，窗口代签）
→ commit
commit 失败 ⇒ BANK_COMPENSATION.reverse(txnId)，entry 记 compensation.kind='reversed'
```

- 用户批准价存在 `ArmedPlan.merchant.priceCents`（武装时 `birthday_plan` 的商户报价）；
  `armFactsOf` 优先用它渲染明细，**涨价不会被 `detailsMismatch` 抢先说成"明细被改"**，
  而是走更具体的 `price-changed`。
- 冲正的 `txnId` 取自本次 run 之后新的 `transfer/created` 事件（结构化字段），
  不解析 `tool/result` 展示文案。
- `compensation` 封闭三值：`reversed` / `reversal-failed` / `reversal-unavailable`；
  只有 `reversed` 代表钱回来了。

### 2.4 可见性

- `PlanWakeEntry.compensation` 进 `plan_wake` 出参（CLI 直接可见）；
- `PlanCardFrame` 加可选 `compensation`，Web 桌面与移动计划卡各渲染一行
  「已冲正 ¥X（原流水 …）」/「冲正失败（code）」/「冲正不可用」。

## 3. 不声称

1. **不是分布式事务**：补偿是**逐腿对冲**，部分成功是合法终态；不保证"三腿全成或全不成"。
2. **不是真实退款**：mock 商户域没有收单/退款接口；`release` 是语义动作，真实商户应对应取消接口。
3. **不覆盖 plan 的任意转账**：冲正只发生在"商户腿 commit 失败"的生日计划路径；
  plan 里普通节点的失败仍没有补偿（那是 saga 的职责）。
4. **父预算守卫先验不可达**：见 §2.1，边界由纯函数单测钉住。
5. **commit 抛错**按"没成交"处理并仍然冲正；不允许"commit 炸了就假装已成交"。

## 4. 后果

- 正向：扣款后商户没成交会留下 `compensation=reversed` 与回补余额；涨价不会自动支付；
- 负向：多一次预占往返；快照重录后 `plan_wake` 出参多一个可选字段；
- 中性：零新事件键（`compensation` 是内部工具的出参字段，不是会话事件）。
