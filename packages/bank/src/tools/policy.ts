/**
 * 默认策略实现（W04 · `PolicyEngine` 的银行侧）与策略外置（S2）的输入构造。
 *
 * **不复制规则**：legacy 的 `decide()` 直接从 `tier.ts` 调用。这里是适配器，不是第二真相源。
 * 任何想改判决的人只能改 `tier.ts`，或者注入另一个 `PolicyEngine`。
 *
 * 策略外置 S2 之后多了一件事：把治理平面已经拿到的预检/配置**映射**成
 * `bank.tier.input/v1`（`@bah/policy` 的输入契约）。映射本身不含规则、不含阈值来源——
 * 阈值仍然只来自 `bank:tools` 配置，bundle 只声明参数名/边界（I14）。
 */

import { BahError, canonicalJson, sha256Hex } from '@bah/util'

import type { PolicyEngine } from '@bah/runtime'
import type { BankTierInput, TierLevel } from '@bah/policy'
import { assertNever } from '@bah/util'

import { decide, type TierConfig, type TierState, type TransferPreviewLike } from './tier.ts'

/** 把 `tier.ts` 的判定矩阵包成策略引擎。 */
export function createTierPolicy(config: TierConfig): PolicyEngine {
  return {
    decide(subject, action, context) {
      const decision = decide({
        name: action.name,
        declared: action.declared,
        config,
        state: {
          ...(subject.userId === undefined ? {} : { userId: subject.userId }),
          riskyCallsInTurn: context.riskyCallsInTurn,
          verifyLocked: context.verifyLocked,
        },
        ...(context.preview === undefined
          ? {}
          : { preview: context.preview as TransferPreviewLike }),
      })

      switch (decision.kind) {
        case 'allow':
          return { verdict: 'allow', reason: decision.reason }
        case 'ask':
          return { verdict: 'ask', reason: decision.reason }
        case 'deny':
          return { verdict: 'deny', reason: decision.reason, code: decision.code }
        default:
          // 构造不可达：封闭联合已穷尽（纪律 6 要求收尾）
          /* v8 ignore next */
          return assertNever(decision, 'policy-decision')
      }
    },
  }
}

/** 构造 `BankTierInput` 所需的全部原料（由治理平面在预检之后给出）。 */
export interface TierInputSource {
  readonly userId: string
  readonly sessionId: string
  readonly name: string
  readonly declared: TierLevel
  /** 会话侧状态（`userId` 已单独给出，这里只取两个判定量）。 */
  readonly state: Pick<TierState, 'riskyCallsInTurn' | 'verifyLocked'>
  /** 转账类的预检（非转账类缺省）。 */
  readonly preview?: TransferPreviewLike
  /** 生效上限 = `min(core 账本限额, Config 限额)`；**已在治理平面算好**。 */
  readonly dailyLimitCents: number
  /** 参数值（只来自 Config；键集必须与 bundle 的 `parameters` 完全一致）。 */
  readonly params: Readonly<Record<string, number>>
}

/**
 * 把治理平面的原料映射成 `bank.tier.input/v1`。
 *
 * 三条硬约束（与 `@bah/policy` 的 schema 一一对应）：
 * 1. 金额**只传整数分**：`preview` 的三个 `*Cents` 原样透传，不做 `*100` / `/100`；
 * 2. **PII 不进来**：只取 `payee.binding` 枚举，姓名/备注/卡号不出现；
 * 3. **不兜底**：`declared` 是 `tier.ts` 的封闭三级枚举，类型上不存在第四种。
 *
 * 返回的对象**不冻结**：冻结在 `validateInput` 里做（生产路径先校验再求值）；
 * 这里冻结一次、校验时再冻结一次，只会多一层 `Object.freeze`，没有语义收益。
 */
export function buildTierInput(source: TierInputSource): BankTierInput {
  return {
    subject: { userId: source.userId, sessionId: source.sessionId },
    action: { name: source.name, declared: source.declared },
    ...(source.preview === undefined
      ? {}
      : {
          preview: {
            amountCents: source.preview.amountCents,
            dailyUsedCents: source.preview.dailyUsedCents,
            dailyLimitCents: source.preview.dailyLimitCents,
            payee: { binding: source.preview.payee.binding },
          },
        }),
    state: {
      riskyCallsInTurn: source.state.riskyCallsInTurn,
      verifyLocked: source.state.verifyLocked,
    },
    limits: { dailyLimitCents: source.dailyLimitCents },
    params: source.params,
  }
}

/**
 * 求值参数（**只有 bundle 声明过的那几个**）。
 *
 * `@bah/policy` 的 `validateInput` 要求 `params` 的键集与 bundle 的 `parameters`
 * **恰好相等**（多一个也是 `policy-input-invalid`）。所以这里刻意只给
 * `riskyCallThreshold`：`riskyOps` / `redChallenge` / 日限额都不进表达式——
 * 前两者由治理平面自己解释，后者走 `limits.dailyLimitCents`。
 */
export function tierEvaluationParams(config: TierConfig): Readonly<Record<string, number>> {
  return { riskyCallThreshold: config.riskyCallThreshold }
}

/**
 * 参数摘要（审计口径，**覆盖比求值参数更广**）。
 *
 * 为什么覆盖 `riskyOps` / `dailyTransferLimitCents` / `redChallenge`：
 * 它们都会改变判决，却不改 `policyVersion`（规则文件没变）。只记版本号回答不了
 * "当时用的哪组参数"，所以 `tier/decided` 同时记 `paramsDigest`（02 §3.2）。
 *
 * 稳定排序是摘要的前提：`riskyOps` 的书写顺序不应改变摘要。
 */
export function tierParamsOf(config: TierConfig, redChallenge: string): TierParams {
  return {
    dailyTransferLimitCents: config.dailyTransferLimitCents,
    riskyCallThreshold: config.riskyCallThreshold,
    riskyOps: [...config.riskyOps].sort(),
    redChallenge,
  }
}

/** 参与 `paramsDigest` 的部署参数（不含任何规则结构）。 */
export interface TierParams {
  readonly dailyTransferLimitCents: number
  readonly riskyCallThreshold: number
  readonly riskyOps: readonly string[]
  readonly redChallenge: string
}

/**
 * `paramsDigest`：`sha256:<64 hex>`。
 *
 * 写成带算法前缀的形式（而不是裸 hex）是为了和 `lock.json` 里 64 hex 的
 * `semanticDigest` 区分开：审计里看到 `sha256:` 就知道可以按这个前缀复核（02 §3.2）。
 */
export function paramsDigestOf(params: TierParams): string {
  return `sha256:${sha256Hex(canonicalJson(params))}`
}

/**
 * 判决输入的摘要（`evidence.inputDigest`）。
 *
 * 与 `paramsDigest` 同一格式；`canonicalJson` 保证键序与数字格式稳定，因此
 * "同一份输入 → 同一摘要"，`policy:explain` 才能用摘要快速比对而不必逐字段 diff。
 */
export function inputDigestOf(input: BankTierInput): string {
  return `sha256:${sha256Hex(canonicalJson(input))}`
}

/** 证据单条上限（字节）。超限说明输入被污染（02 §4.2）；`bank.tier.input/v1` 正常约 300 字节。 */
export const MAX_EVIDENCE_BYTES = 1_024

/** 判决证据（只进 `tier/decided`；链上只有它的哈希）。 */
export interface PolicyEvidence {
  /** `sha256:<64 hex>` of `canonicalJson(input)`。 */
  readonly inputDigest: string
  /** 完整判决输入（无 PII：只有枚举与整数分）。 */
  readonly input: BankTierInput
}

/**
 * 构造判决证据，**超限即抛**（`policy-input-invalid`）。
 *
 * @throws `BahError('policy-input-invalid')` 序列化后超过 1 KiB
 */
export function evidenceOf(input: BankTierInput): PolicyEvidence {
  const text = canonicalJson(input)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_EVIDENCE_BYTES) {
    throw new BahError(
      'policy-input-invalid',
      `判决输入序列化后 ${String(bytes)} 字节，超过证据上限 ${String(MAX_EVIDENCE_BYTES)}`,
      { bytes, max: MAX_EVIDENCE_BYTES },
    )
  }
  return { inputDigest: `sha256:${sha256Hex(text)}`, input }
}
