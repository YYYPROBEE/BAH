# 场景 DSL · 冻结 v1.0.0

> **冻结版本号**：`v1.0.1-frozen-2026-10-26`（v1.0.0 的自审修正，见 §3.0）
> **冻结**：ADR-0001 · **消费方**：评测场景（60 场景）/ 对抗集 / 重放
> **代码真相源**：`packages/eval/src/scenario/spec.ts`（纯类型）
> **变更流程**：见 §5。

## 1. 冻结目标

实现方要写 **60 个场景**（9 人日）。若每个场景都要顺手改一次引擎，那 9 人日会变成 25 人日。
所以本 DSL 的目标只有一个：**实现方只填数据，不改引擎。**

⇒ 判据：实现方开工后若需要改动本文件的任何字段，说明冻结失败，属本设计缺陷。

## 2. 七族（实现方§1 的口径 + U 族增补，本设计照抄不重定义）

| 族 | 例数 | 覆盖 | 主力断言 kind |
|---|---|---|---|
| **Q** 查询 | 14 | 读类，断言"返回值与场景数据一致"（+实现方的跨场景拒借 / 追问不死循环 + 账单 实现方两条） | `tool-result`、`tool-sequence` |
| **T** 转账主链 | 16 | 试算→审批→扣款；含金额边界（999/1000/1001）与 实现方的四类意图 | `tool-sequence`、`tool-result` |
| **P** 权限分级 | 11 | 绿/黄/红三档 × 批/拒/超时（含理财适当性拦截 P-11） | `tool-denied` |
| **S** 补偿 | 8 | 转账失败→冲正；补偿失败→`COMPENSATION_DLQ`（**不是 INCIDENT**） | `event` |
| **D** 编排（plan） | 15 | 串行/菱形/optional/dry-run/resume | `event`、`tool-sequence` |
| **K** 知识与拒答 | 10 | 命中/未命中/需拒答/签名失效 | `refused`、`event` |
| **U** 意图语料 | 17 | 30 条实战语料中当前有承载的 17 条：直白/缺槽追问/指代复现/实体歧义；零资金动作 | `tool-result`、`no-event` |
| | **91** | | |

## 3. 结构

```ts
export type ScenarioFamily = 'Q' | 'T' | 'P' | 'S' | 'D' | 'K' | 'U'
export type ScenarioMetric = 'task-success' | 'privilege-block' | 'refusal-accuracy'
export type ScenarioApproval = 'allow' | 'reject' | 'unavailable'

export type ScenarioExpectation =
  | { kind: 'tool-sequence'; tools: readonly string[]; mode: 'exact' | 'prefix' | 'contains' }
  | { kind: 'tool-denied'; tool: string; code: string }
  | { kind: 'tool-result'; tool: string; path: string; equals: unknown }
  | { kind: 'refused'; reason: string }
  | { kind: 'event'; type: string; where?: Readonly<Record<string, unknown>> }
  | { kind: 'no-event'; type: string; where?: Readonly<Record<string, unknown>> }

export interface ScenarioSpec {
  id: string            // 族字母 + 两位序号，如 T-03；全局唯一
  family: ScenarioFamily
  title: string
  profile: string       // profiles/<name>；同一 (family, approval) 组合内必须一致
  approval?: ScenarioApproval  // 缺省 allow
  seed: number          // 同 seed 两次跑必须逐字段全等
  dataset?: string      // fixtures 名；缺省 = 空库
  turns: readonly string[]
  expect: readonly ScenarioExpectation[]
  metric?: ScenarioMetric
}
```

### 3.0 v1.0.1 修订（实现方自审，冻结生效前）

自审时发现三处洞，**在下游任何单开工前**修掉，因此**不占用改签名额**：

| # | 洞 | 补法 |
|---|---|---|
| 1 | **缺否定断言**：D 族 dry-run 的核心就是"零 `tool/call`"，`event` 只能断"出现"，测不了"没出现" | 加 `no-event` kind |
| 2 | **P 族测不出差异**：`profiles/headless` 把 `autoDecision` 固定成 `allow`，10 个场景结果会全一样 | 加 `approval` 字段（三值对齐 `ApprovalSettings`，不发明第四种） |
| 3 | **"超时"不在能力范围**：`ApprovalSettings` 只有 `responder` + `autoDecision`，没有 timeout 语义；超时是票据 TTL 到期 | 明确 `unavailable ≠ 超时`；真要做超时走 ADR-0003 |

> **对 TC-09 的修正**：原文要求"`boot()` 调用次数 = 6"。
> 加了 `approval` 维度后，复用单位变成 **(family, approval)**：P 族 3 次 + 其余 5 族各 1 次 = **8 次**。
> 这是 实现方的 TC 需要同步的口径，**不是** DSL 的缺陷。

### 3.1 六个 kind 是封闭集，每个都直接喂一项指标

| kind | 喂哪项指标 | 为什么必须有它 |
|---|---|---|
| `tool-sequence` | 任务成功率、**平均步数**（由长度导出） | 不数步数就没法证"没绕路" |
| `tool-denied` | **越权拦截率** | P 族的唯一硬断言 |
| `refused` | **拒答正确率** | K 族的唯一硬断言 |
| `tool-result` | 任务成功率（一致性） | Q 族"返回值与场景数据一致" |
| `event` | 任务成功率（副作用已落账） | S/D/K 三族靠事件判成败 |
| `no-event` | 任务成功率（**没留假记录**） | D 族 dry-run、K 族拒答后无副作用 |

**没有 `or` 语义**：`expect` 数组是合取，全部满足才 PASS。理由：析取会让失败原因无法定位，
而 实现方的 TC 是 ID 级的——一条 TC 对应一个可复现的失败点。

### 3.2 为什么不设 `setup` / `teardown` 字段

族内**复用同一个 `boot()`**（实现方的 TC-09 要求 `boot()` 调用次数 = 6，不是 60）。
所以场景之间不许有独立生命周期钩子——有钩子就会有人写"在这个场景里换个 profile"，
`boot()` 复用立刻失效。数据差异一律走 `dataset` + `turns` 表达。

## 4. 示例

```ts
// packages/eval/src/scenarios/t/T-03.ts —— 金额边界 1000 元（赛题日累计上限）
import type { ScenarioSpec } from '../../scenario/spec.ts'

export const spec: ScenarioSpec = {
  id: 'T-03',
  family: 'T',
  title: '单笔 1000 元整（日累计上限）应当放行，1001 元应当被拒',
  profile: 'headless',
  seed: 20261026,
  dataset: 'fresh-account',
  turns: ['给 6222 开头那个账户转 1000 元'],
  expect: [
    { kind: 'tool-sequence', tools: ['transfer_preview', 'transfer_create'], mode: 'prefix' },
    { kind: 'tool-result', tool: 'transfer_create', path: 'status', equals: 'succeeded' },
  ],
  metric: 'task-success',
}
```

## 5. 变更流程

1. 加 kind / 加字段：ADR + L1 owner 签字 + 版本号 minor；
2. 改已有 kind 语义：major，且**必须同时改 实现方全部 60 个场景**（成本极高，基本等于重做）；
3. **实现方开工后 1 天内允许一次改签**（实现方§5），之后冻结到期。

## 6. 边界（本设计不做什么）

- **不实现校验器**：`id` 唯一性、schema 合法性由 实现方的 runner 校验（本文件只给类型，
  TS 的 `tsc` 已经负责"字段名/类型对不对"这一半）；
- **不写任何场景**；
- **不定义 runner 接口**（实现方§2 已有 `runner.ts` 的落点）；
- **不新增 `snapshots/` 场景**：`snapshots/` 维持现有 4 个录音场景不动（复审 V-3，
  两者是"录音回放"与"能力度量"两件事，不能混）。

## 7. 自检（TC-01）

```bash
grep -nE "^(export )?(const|function|class) " packages/eval/src/scenario/spec.ts   # 必须为空
npx tsc -b tsconfig.host.json tsconfig.client.json                                 # 必须通过
```
