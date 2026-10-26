# 工具契约（G-1）· 冻结 v1.0.0

> **冻结版本号**：`v1.0.1-frozen-2026-10-26`（v1.0.0 的自审修正，见 §2.5）
> **冻结单**：W02（三件冻结）· **实现单**：W03（运行时校验 + 两个新工具）
> **代码真相源**：`packages/util/src/tool-contract.ts`（纯类型，无运行时代码）
> **变更流程**：见 §5。改签要 ADR + L1 owner 签字。

## 1. 这份契约解决什么

现状（W01 预检 #1/#2 实测）：`ToolDefinition` 只有 `schema`（入参 JSON Schema 的**描述**），
**没有任何运行时校验**——`grep -n "schema" packages/runtime/src/tools/pipeline.ts` 返回空。
模型传啥都进得去，全靠工具体自己 if 判断。

契约要补的就是这三段：**入参形状、出参形状、校验挂在哪**。

## 2. 结构

### 2.1 与 `ToolDefinition.schema` 的关系（最容易搞错的一处）

| 字段 | 在哪 | 谁写 | 语义 |
|---|---|---|---|
| `schema` | `@bah/core` 的 `ToolDefinition`（`api.ts:461`） | 已有，**不动**（宪法 R-1） | 给**模型**看的参数说明（prompt 侧） |
| `argsSchema` | `ToolContract` | W03 在 `BankToolSpec` 上声明 | 给**运行时**校验用的入参 schema |
| `resultSchema` | `ToolContract` | 同上 | 出参 schema，**不挂 core** |

**为什么不合并成一个**：`schema` 是提示词资产，`argsSchema` 是执行闸门。合并会让"改提示词"和
"改校验"变成同一个动作，而前者频繁、后者必须慎重。两者**允许不同**，但 W03 必须保证
`argsSchema` 至少覆盖 `schema` 声明的必填项（否则模型看到的和实际校验的对不上）。

### 2.2 类型

```ts
export type ContractStage = 'pre-execute' | 'post-execute'

export interface ToolContract<ArgsSchema = unknown, ResultSchema = unknown> {
  readonly argsSchema: ArgsSchema
  readonly resultSchema: ResultSchema
  readonly validateAt: ContractStage
}
```

**为什么 schema 是泛型而不是 `ToolSchema`**：`@bah/core` 依赖 `@bah/util`（`packages/core/package.json`
的 dependencies 实测含 `@bah/util`），所以 util **不能**反向 import core，否则成包级环。
使用方代入真实类型：`ToolContract<ToolSchema, ToolSchema>`。

### 2.3 `validateAt` 的语义（本单冻结时的已知窄口）

**它只描述入参的校验时机；出参恒为 `post-execute`。**
理由：入参必须在工具体跑之前拦住（跑完再拦等于钱已经动了）；出参只可能在跑完之后才有。

单一字段表达不了两个时点，这是本版的已知不足。**不要直接加字段**——
W03 若确需分别配置，走 ADR-0003。

### 2.4 失败形状

```ts
export interface ToolContractViolation {
  readonly phase: 'args' | 'result'
  readonly path: string   // JSON Pointer 风格，整体失败为空串
  readonly code: string   // 机器可读原因码，取值域由 W03 定义
  readonly detail: string // 人读；**不得含入参原文**（PII，宪法 §4）
}
```

`detail` 禁含入参原文不是洁癖：本仓审计与日志要落证据链，`args` 原文进去就删不掉了。

### 2.5 v1.0.1 修订（W02 自审，冻结生效前）

自审时发现 **v1.0.0 的示例写错了字段名**：示例写 `resultSchema.required = ['txnId','balance']`，
而 `TransferResult`（`packages/bank/src/core/provider.ts:146`）的字段全是 `*Cents`，**没有 `balance`**。

| # | 洞 | 补法 |
|---|---|---|
| 1 | 示例字段名错（`balance` 实为 `balanceCents`） | 示例改为照 `TransferResult` 逐字抄，并加"入参元、出参分"的警示 |
| 2 | 未说明出参单位与入参不同 | §3 增加对照说明：入参 `amount`（元）vs 出参 `amountCents` / `balanceCents`（分） |

**为什么这算"错"而不算"风格"**：示例是契约的一部分（TC-W02-03 要求每份文档含示例）。
W03 若照错的示例写出参校验，金额阈值会差 100 倍——这类错在测试里只表现为"边界用例不红"，
不会报错，最难查。

**为什么不算改签**：下游 W03 / W13 / W14 / W15 均未开工，v1.0.0 从未被任何代码消费。
因此不占用 ADR-0001 的改签名额。

## 3. 示例（W03 在 `packages/bank/src/tools/specs.ts` 里怎么写）

```ts
import type { ToolSchema } from '@bah/core'
import type { ToolContract } from '@bah/util'

const transferCreateContract: ToolContract<ToolSchema, ToolSchema> = {
  argsSchema: {
    type: 'object',
    required: ['toAccount', 'amount'],
    properties: {
      toAccount: { type: 'string', minLength: 8 },
      // 入参金额是 number，单位「元」—— 14 个工具现状如此，见 W03 的口径
      amount: { type: 'number', exclusiveMinimum: 0 },
      remark: { type: 'string', maxLength: 140 },
    },
  },
  resultSchema: {
    // 出参字段名照 packages/bank/src/core/provider.ts:146 的 TransferResult 抄，不猜
    type: 'object',
    required: ['txnId', 'amountCents', 'balanceCents'],
    properties: {
      txnId: { type: 'string' },        // 不是 transferId（W12 踩过）
      amountCents: { type: 'number' },  // 出参单位是「分」，不是元
      balanceCents: { type: 'number' }, // 不是 balance
      remainingCents: { type: 'number' },
    },
  },
  validateAt: 'pre-execute',
}
```

> **入参元、出参分，这是本仓最容易写反的一处。** `TransferResult`（`packages/bank/src/core/provider.ts:146`）
> 的字段全是 `*Cents`：`amountCents` / `feeCents` / `balanceCents` / `availableCents` /
> `dailyUsedCents` / `dailyLimitCents` / `remainingCents`。**没有 `balance`，也没有 `amount`。**
> W03 写出参边界时若按「元」写，阈值会差 100 倍。

**金额类型提示**：14 个工具当前 `amount` 是 `{ type: 'number' }`（元）。
W03 **只做边界校验**（非有限数 / 负数 / 精度越界 / 超安全整数），
换算复用既有的 `yuanToCents`（已防 `1.005 * 100` 陷阱），**不要自己写 `Math.round(x * 100)`**。

## 4. 不在本契约里的东西

- **校验器实现**（W03）；
- **错误抛出还是返回**（W03）；
- **两个新工具**（`card_report_lost` / `sub_cancel`，W03）；
- **任何默认值**：契约不填默认值，缺省由工具自己声明。

## 5. 变更流程

1. 写 ADR（`docs/adr/`，半页即可）：改什么、为什么现在改、影响哪几个单；
2. **L1 owner 签字**（`docs/owners-2026-10-25.md` 的 `L1-A`）；
3. 版本号升位：加字段 = minor，改字段语义 = major；
4. **W03 开工后 1 天内只允许一次改签**（W02 §5 风险表），之后冻结到期。

## 6. 自检（TC-W02-01 / 02 / 07）

| TC | 怎么验 |
|---|---|
| TC-W02-01 | `grep -nE "^(export )?(const|function|class) " packages/util/src/tool-contract.ts` → 必须为空 |
| TC-W02-02 | `npx tsc -b tsconfig.host.json tsconfig.client.json` 通过；`packages/util/dist/` 无新增 chunk |
| TC-W02-07 | `node -e "console.log(require('./packages/bank/package.json').dependencies)"` → 无 `@bah/runtime` |
