# ADR-0012 · 卡限额与品类限制落到真实扣款路径（mock 收单 + 同卡滚动 30 天）

- 状态：**已采纳**（2026-10-31）
- 关联：`docs/contracts/event-table.md` §5、`docs/bank-tools.md` §2/§6/§10
- 影响面：`packages/bank/src/core/{model,provider,mock,merchant}.ts`、`packages/bank/src/tools/{specs,account-ops,queries,approval-details,dto,events}.ts`、`packages/host/src/boot/plugins/{bank-tools,merchant}.ts`、`packages/llm/src/demo/router.ts`

> 编号说明：ADR-0010 已被并行线的授权窗口（`windowResponder`）占用
> 本设计按顺序取 0012，避免与在途编号相撞。

---

## 1 背景

两条事实：

1. `Card.monthlyLimitCents` **只存不判**——`dailyLimitOf` 只取日限额，月限额从未参与任何风控；
2. `card_restriction` 的 `kind:'category'` **只落规则与审计**——`cardRestrictionRisk` 只处理
   `online` / `overseas`，全仓没有卡消费通道，品类拦截面为零。

两条的共同病根：**模型里有参数、判决里没有读取点**。这种"参数在、拦截无"比"没做"更危险，
因为文档与工具描述会让用户以为它生效了。

路线二选一：

- **路线 A**：把 `category` 删掉、月限额如实登记为展示字段（诚实收口，但不关 B-02）；
- **路线 B**：补卡消费通道，让月限额与品类都落到真实扣款路径。

**本设计选 B**（用户显式选择）：不删参数，而是让参数有判定读取点。

## 2 决策

### 2.1 月限额：同卡、近 30 天滚动窗口（不是自然月）

- `Transaction` 加 `readonly viaCardId?: CardId`（老造数不填）；`createTransfer` 写流水时带上，
  `settleSelfTransfer` 的转出腿带上，`reverse` 生成的冲正流水**继承**原值。
- `MockBankCore.monthlyUsedCents(accountId, cardId, at)`：
  窗口 `[at - 30 * DAY_MS, at]`，只统计 `direction='out'` 且
  `category ∈ {transfer, consumption}` 的成功流水，减去同窗口内带 `reversalOf` 的 `in/refund`；
  结果 `Math.max(0, …)`。
- `cardLimitOf(accountId, cardId?, at)` 返回**卡面**额度与卡口径已用（不与 Config 日限额取 min——
  那是转账口径）。`dailyLimitOf` 保持原语义（min(卡日限额, Config 日限额)）。
- 新增风控规则 `card-monthly-limit`（`severity: block`，`code: card-monthly-limit-exceeded`）：
  - `previewTransfer` 追加该风险条目（仅当显式传 `viaCardId`）；
  - `createTransfer` 在**票据核销之前**抛同名 `BahError`（账本不变、票据不消耗）。
- 消息文案用「近 30 天已用」而不是「本月已用」：判定是滚动窗口，
  说"本月"会让用户按自然月理解，口径不一致。

**为什么不给不带 `viaCardId` 的账户转账也套月限额**：月限额按卡归集，没有卡就没有归集对象；
拿账户流水冒充某张卡的月累计是第二份真相。这条写进 §3 的"不声称"。

### 2.2 卡消费通道 `spendOnCard`（mock 收单）

`BankCoreProvider` 新增：

```ts
spendOnCard(req: {
  userId; cardId; merchantCategory: MerchantCategory; amountCents; memo?; idempotencyKey?
}): Promise<CardSpendResult>
```

校验顺序**固定**（顺序即安全边界，不许换）：

```text
卡存在且归属 → 状态 normal → online 限制 → category 限制 → 日/月限额 → 账户可用余额 → 记账
```

- 前六步任一失败都在记账之前抛出；
- 记账为 `consumption/out`，带 `viaCardId` 与 `memo`（对手方展示名）；
- 幂等表与转账分开（结果形状不同）：同键同参数返回首笔结果，同键换参数
  `idempotency-conflict`；
- `CardSpendResult` 同时给卡口径的日/月已用与限额，渠道无需二次计算。

### 2.3 宿主窄端口：`bank:card-spend`

`bank-core` 不是服务键。宿主新增窄端口，只交出"按会话身份以卡消费"一个方法：

```ts
spend(sessionId, { cardId, merchantCategory, amountCents, memo? })
```

- **身份只能从 `bank:identity` 按会话解析**，端口签名里没有 `userId`——调用方拿不到
  "换成别人的用户 ID"这个入口；
- 未绑定会话 → `no-identity`；
- 扣款成功与 `card/spent` 事件同处落账。

唯一调用方是内部工具 `merchant_order(viaCardId)`（`exposure: 'internal'`，模型不可见）。
执行顺序：

```text
引用闭包（没搜过不扣款）
→ 扣款前预检（缺货 / 超时 / 超预算，失败不扣款）
→ spendOnCard（金额 = 商户当前报价）
→ fulfill
```

扣款后若履约没有按预检成交，返回 `payment-without-order`，**不装作已下单**；
退款/补偿归提示词 3（本设计不实现）。

### 2.4 品类限制的封闭值域

- `CardRestriction.value` 在 `kind='category'` 时必须是 `MerchantCategory` 的已知键
  （`dining` / `coffee` / `grocery` / `transit` / `shopping` / `digital` / `transfer` /
  `salary` / `other`）；写入面直接拒绝自由文本（`card-restriction-invalid`）。
- 品类只在 `spendOnCard` 上判定；**账户转账没有品类语义**，`cardRestrictionRisk` 仍只处理
  `online` / `overseas`。
- `online` 同时阻断以卡转账与卡消费；`overseas` 只阻断以卡转账（mock 消费没有境外维度，
  不假装有）。

### 2.5 事件

新增 `card/spent`（`BANK_SESSION_EVENT_TYPES` 32 → 33），载荷只放账本事实：

```ts
{ cardId, tail, txnId, merchantCategory, amountCents, at }
```

不把"限额结论"落进来：限额会随下一笔变化，落进日志就是第二份会漂移的真相。

## 3 不声称（边界）

1. **mock 收单不是真实收单**：没有商户 API、清算、真实退款；`merchant_order` 的
   `payment-without-order` 只能如实报错，不能自动退。
2. **品类不拦账户转账**：`card_restriction(category='dining')` 不会拦住一笔普通转账。
3. **月限额不跨卡合并、不是自然月**：它是"同卡、近 30 天滚动窗口"；账单的月度口径另有一套。
4. **未带 `viaCardId` 的转账不吃月限额**（见 2.1 的理由）。
5. **卡消费没有独立的路由演示**：商户目录只有鲜花/蛋糕（无咖啡商户），且
   `merchant_order` 是内部工具；因此本设计只做工具面，不做「买杯咖啡用这张卡」的话术。
   路由只加了"关掉这张卡的餐饮/咖啡…消费"→`card_restriction(category)`。
6. **`merchant_order` 的金额绑定是间接的**：票据绑定 `offerId`（票价由目录决定），
   不另绑金额；卡消费金额取同一份报价，预检与履约共用它。

## 4 后果

- 旧行为零变化：不传 `viaCardId` 的转账、不带 `viaCardId` 的商户下单逐字不变；
- 快照面：`card/spent` 只在新路径发射，既有场景不触发；
- 计数联动：银行事件键 32 → 33；工具数仍 28（没有新增银行工具）；
- 负控：临时禁用月限额判定后，`mock.card-limits.test.ts` 2 例 + `transfers.test.ts` 1 例转红，
  还原后全绿（见 §5）。
