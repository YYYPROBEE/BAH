/**
 * 28 个银行工具的**出参契约表**（W03 · G-1 的出参侧）。
 *
 * ## 为什么是一张按名索引的表，而不是写进每个 `BankToolSpec`
 *
 * W03 §2 原话是"`BankToolSpec` 加可选 `resultSchema`"。实际改成单表，两个理由：
 * 1. 宿主装配时**本来就是按名查**（`get(name)`），表格式天然契合，21 处内联反而多一次转换；
 * 2. 21 份 schema 分散在 500 行的 specs 数组里，改一个漏一个不会被任何检查发现；
 *    集中一表 + 一张清单测试，漏写立刻红。
 *
 * 本文件是出参形状的**唯一真相源**；spread 进 `ToolContractSource` 的是这里的对象本身。
 *
 * ## 口径（每条都从 `dto.ts` 的接口逐字抄，不猜）
 *
 * - 金额字段一律 `integer`（分）；`*Pct` / `shares` / `ms` 是 `number`；
 * - 领域枚举（`kind` / `status` / `riskGrade` …）只写 `type: 'string'`，
 *   **不复制取值域**——取值域在 `@bah/bank` 的类型里，抄一份就是第二真相源；
 * - 可选字段不进 `required`；**不设 `additionalProperties: false`**：
 *   工具加字段时不该被契约拦下（契约管"该有的在不在、类型对不对"，不管"能不能多"）。
 */

import type { ToolSchema } from '@bah/core'

import type { BankToolName } from './specs.ts'

/** 账户视图（`AccountView`）。 */
const ACCOUNT_VIEW: ToolSchema = {
  type: 'object',
  required: ['accountId', 'tail', 'balanceCents', 'availableCents'],
  properties: {
    accountId: { type: 'string' },
    tail: { type: 'string' },
    type: { type: 'string' },
    status: { type: 'string' },
    balanceCents: { type: 'integer' },
    availableCents: { type: 'integer' },
  },
}

/** 卡片视图（`CardView`）。 */
const CARD_VIEW: ToolSchema = {
  type: 'object',
  required: [
    'cardId',
    'accountId',
    'tail',
    'type',
    'status',
    'dailyLimitCents',
    'monthlyLimitCents',
  ],
  properties: {
    cardId: { type: 'string' },
    accountId: { type: 'string' },
    tail: { type: 'string' },
    type: { type: 'string' },
    status: { type: 'string' },
    dailyLimitCents: { type: 'integer' },
    monthlyLimitCents: { type: 'integer' },
    // 信用产品三件套（ADR-0015）：借记卡不带，老形状不变。
    kind: { type: 'string' },
    creditLimitCents: { type: 'integer' },
    usedCreditCents: { type: 'integer' },
    restrictions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'at'],
        properties: {
          kind: { type: 'string', enum: ['online', 'overseas', 'category'] },
          value: { type: 'string' },
          note: { type: 'string' },
          at: { type: 'integer' },
        },
      },
    },
  },
}

/** 卡片状态迁移结果（`CardStateResult`）。 */
const CARD_STATE: ToolSchema = {
  type: 'object',
  required: ['cardId', 'tail', 'status', 'changed', 'at'],
  properties: {
    cardId: { type: 'string' },
    tail: { type: 'string' },
    status: { type: 'string', enum: ['frozen', 'normal'] },
    changed: { type: 'boolean' },
    at: { type: 'integer' },
  },
}

/** 新卡申请结果（`CardIssuedResult`）。 */
const CARD_ISSUED: ToolSchema = {
  type: 'object',
  required: [
    'cardId',
    'accountId',
    'tail',
    'type',
    'status',
    'dailyLimitCents',
    'monthlyLimitCents',
    'at',
  ],
  properties: {
    cardId: { type: 'string' },
    accountId: { type: 'string' },
    tail: { type: 'string' },
    // 补发时回指旧卡（2026-11-01）；非补发不带此字段。
    replacedCardId: { type: 'string' },
    type: { type: 'string', enum: ['physical', 'virtual'] },
    status: { type: 'string', enum: ['normal'] },
    dailyLimitCents: { type: 'integer' },
    monthlyLimitCents: { type: 'integer' },
    // 信用产品（ADR-0015）：`kind='credit'` 申请出来的卡才带。
    kind: { type: 'string' },
    creditLimitCents: { type: 'integer' },
    usedCreditCents: { type: 'integer' },
    at: { type: 'integer' },
  },
}

/** 额度调整结果（`CardLimitsResult`）。 */
const CARD_LIMITS: ToolSchema = {
  type: 'object',
  required: ['cardId', 'tail', 'dailyLimitCents', 'monthlyLimitCents', 'changed', 'at'],
  properties: {
    cardId: { type: 'string' },
    tail: { type: 'string' },
    dailyLimitCents: { type: 'integer' },
    monthlyLimitCents: { type: 'integer' },
    // 信用产品（ADR-0015）：`usedCreditCents` 是**变更时**的已用额度。
    kind: { type: 'string' },
    creditLimitCents: { type: 'integer' },
    usedCreditCents: { type: 'integer' },
    changed: { type: 'boolean' },
    at: { type: 'integer' },
  },
}

/** 交易限制结果（`CardRestrictionsResult`）。 */
const CARD_RESTRICTIONS: ToolSchema = {
  type: 'object',
  required: ['cardId', 'tail', 'mode', 'restrictions', 'changed', 'at'],
  properties: {
    cardId: { type: 'string' },
    tail: { type: 'string' },
    mode: { type: 'string', enum: ['set', 'clear'] },
    restrictions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'at'],
        properties: {
          kind: { type: 'string', enum: ['online', 'overseas', 'category'] },
          value: { type: 'string' },
          note: { type: 'string' },
          at: { type: 'integer' },
        },
      },
    },
    changed: { type: 'boolean' },
    at: { type: 'integer' },
  },
}

/** 风险问卷的一道题（`RiskQuestionView`）。 */
const RISK_QUESTION: ToolSchema = {
  type: 'object',
  required: ['index', 'title', 'options'],
  properties: {
    index: { type: 'integer' },
    title: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        required: ['key', 'text', 'score'],
        properties: {
          key: { type: 'string' },
          text: { type: 'string' },
          score: { type: 'integer' },
        },
      },
    },
  },
}

/**
 * `risk_assess(action="questions")` 的出参（`RiskQuestionsResult`）。
 *
 * 注意这里**没有** `answers / score / from / to`：分支的 `required` 就是"这个动作
 * 必须带回哪些字段"，旧写法（单对象 + 可选键）让缺 `answers` 的 submit 也能过。
 */
const RISK_QUESTIONS_RESULT: ToolSchema = {
  type: 'object',
  required: ['action', 'questionnaireId', 'version', 'issuedAt', 'expiresAt', 'questions', 'at'],
  properties: {
    action: { type: 'string', enum: ['questions'] },
    questionnaireId: { type: 'string' },
    version: { type: 'string' },
    issuedAt: { type: 'integer' },
    expiresAt: { type: 'integer' },
    questions: { type: 'array', items: RISK_QUESTION },
    at: { type: 'integer' },
  },
}

/** `risk_assess(action="submit")` 的出参（`RiskSubmitResult`）：落档结论必须齐全。 */
const RISK_SUBMIT_RESULT: ToolSchema = {
  type: 'object',
  required: ['action', 'questionnaireId', 'version', 'answers', 'score', 'from', 'to', 'at'],
  properties: {
    action: { type: 'string', enum: ['submit'] },
    questionnaireId: { type: 'string' },
    version: { type: 'string' },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'key'],
        properties: {
          index: { type: 'integer' },
          key: { type: 'string' },
        },
      },
    },
    score: { type: 'integer' },
    from: { type: 'string' },
    to: { type: 'string' },
    at: { type: 'integer' },
  },
}

export const BANK_RESULT_SCHEMAS: Partial<Readonly<Record<BankToolName, ToolSchema>>> = {
  account_list: {
    type: 'object',
    required: ['accounts', 'cards', 'availableTotalCents'],
    properties: {
      accounts: { type: 'array', items: ACCOUNT_VIEW },
      cards: { type: 'array', items: CARD_VIEW },
      availableTotalCents: { type: 'integer' },
    },
  },

  account_balance: {
    type: 'object',
    required: ['accountId', 'balanceCents', 'availableCents', 'asOf', 'txnRef'],
    properties: {
      accountId: { type: 'string' },
      tail: { type: 'string' },
      balanceCents: { type: 'integer' },
      availableCents: { type: 'integer' },
      frozenCents: { type: 'integer' },
      asOf: { type: 'integer' },
      // 幻觉防护的锚点：模型转述金额必须带它
      txnRef: { type: 'string' },
    },
  },

  txn_query: {
    type: 'object',
    required: ['items', 'page', 'limit', 'hasMore', 'from', 'to'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['txnId', 'at', 'amountCents', 'direction'],
          properties: {
            txnId: { type: 'string' },
            at: { type: 'integer' },
            amountCents: { type: 'integer' },
            direction: { type: 'string' },
            counterpartyName: { type: 'string' },
            category: { type: 'string' },
            channel: { type: 'string' },
            status: { type: 'string' },
          },
        },
      },
      page: { type: 'integer' },
      limit: { type: 'integer' },
      hasMore: { type: 'boolean' },
      nextCursor: { type: 'string' },
      from: { type: 'integer' },
      to: { type: 'integer' },
    },
  },

  bill_analyze: {
    type: 'object',
    required: ['period', 'months', 'totalInCents', 'totalOutCents', 'byCategory', 'anomalies'],
    properties: {
      period: { type: 'string', enum: ['month', 'quarter', 'year'] },
      months: { type: 'array', items: { type: 'string' } },
      totalInCents: { type: 'integer' },
      totalOutCents: { type: 'integer' },
      byCategory: {
        type: 'array',
        items: {
          type: 'object',
          required: ['category', 'amountCents', 'sharePct'],
          properties: {
            category: { type: 'string' },
            amountCents: { type: 'integer' },
            sharePct: { type: 'number' },
          },
        },
      },
      byPayee: {
        type: 'array',
        items: {
          type: 'object',
          required: ['payee', 'amountCents', 'sharePct'],
          properties: {
            payee: { type: 'string' },
            amountCents: { type: 'integer' },
            sharePct: { type: 'number' },
          },
        },
      },
      // 品类维度（叙事层）：可选，不进 `required`——旧结果不因此失配
      byMerchantCategory: {
        type: 'array',
        items: {
          type: 'object',
          required: ['category', 'amountCents', 'sharePct'],
          properties: {
            category: { type: 'string' },
            amountCents: { type: 'integer' },
            sharePct: { type: 'number' },
          },
        },
      },
      anomalies: { type: 'array' },
      momChangePct: { type: 'number' },
      comparedPeriod: { type: 'string' },
      // 年度覆盖声明（`period = 'year'` 时给）
      coveredMonths: { type: 'integer' },
    },
  },

  bill_report: {
    type: 'object',
    required: ['period', 'format', 'text', 'analysis'],
    properties: {
      period: { type: 'string', enum: ['month', 'quarter', 'year'] },
      format: { type: 'string', enum: ['summary', 'detail'] },
      text: { type: 'string' },
      analysis: { type: 'object' },
    },
  },

  analysis_calc: {
    type: 'object',
    required: ['code', 'value', 'operations'],
    properties: {
      code: { type: 'string' },
      value: { type: 'number' },
      operations: { type: 'integer' },
      elapsedMs: { type: 'number' },
    },
  },

  transfer_preview: {
    type: 'object',
    required: ['amountCents', 'feeCents', 'payeeName', 'verdict', 'effectiveTier', 'at'],
    properties: {
      amountCents: { type: 'integer' },
      feeCents: { type: 'integer' },
      payeeName: { type: 'string' },
      payeeBinding: { type: 'string' },
      payeeId: { type: 'string' },
      dailyUsedCents: { type: 'integer' },
      dailyLimitCents: { type: 'integer' },
      remainingCents: { type: 'integer' },
      risks: { type: 'array' },
      verdict: { type: 'string' },
      effectiveTier: { type: 'string', enum: ['green', 'yellow', 'red'] },
      // 仅当传了 viaCardId 时出现（可选字段不进 required）
      viaCardTail: { type: 'string' },
      viaCardStatus: { type: 'string', enum: ['normal', 'frozen', 'lost'] },
      at: { type: 'integer' },
    },
  },

  // 与 `transfers.ts` 的 `return { txnId, amountCents, … }` 逐字对齐
  transfer_create: {
    type: 'object',
    required: ['txnId', 'amountCents', 'balanceCents'],
    properties: {
      txnId: { type: 'string' },
      ticketId: { type: 'string' },
      amountCents: { type: 'integer' },
      feeCents: { type: 'integer' },
      payeeName: { type: 'string' },
      balanceCents: { type: 'integer' },
      availableCents: { type: 'integer' },
      dailyUsedCents: { type: 'integer' },
      dailyLimitCents: { type: 'integer' },
      remainingCents: { type: 'integer' },
      at: { type: 'integer' },
    },
  },

  aa_create: {
    type: 'object',
    required: [
      'groupId',
      'title',
      'totalCents',
      'collectedCents',
      'pendingCents',
      'status',
      'participants',
      'createdAt',
    ],
    properties: {
      groupId: { type: 'string' },
      title: { type: 'string' },
      totalCents: { type: 'integer' },
      collectedCents: { type: 'integer' },
      pendingCents: { type: 'integer' },
      status: { type: 'string', enum: ['collecting', 'completed', 'cancelled'] },
      participants: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'shareCents', 'status'],
          properties: {
            name: { type: 'string' },
            shareCents: { type: 'integer' },
            status: {
              type: 'string',
              enum: ['pending', 'paid', 'declined', 'expired'],
            },
            paidAt: { type: 'integer' },
          },
        },
      },
      createdAt: { type: 'integer' },
      expiresAt: { type: 'integer' },
    },
  },

  wealth_list: {
    type: 'object',
    required: ['products', 'customerRisk', 'disclaimerId'],
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          required: ['productId', 'name', 'minAmountCents', 'eligible'],
          properties: {
            productId: { type: 'string' },
            name: { type: 'string' },
            kind: { type: 'string' },
            termDays: { type: 'integer' },
            expectedYieldPct: { type: 'number' },
            riskGrade: { type: 'string' },
            minAmountCents: { type: 'integer' },
            eligible: { type: 'boolean' },
            suitabilityNote: { type: 'string' },
          },
        },
      },
      customerRisk: { type: 'string' },
      disclaimerId: { type: 'string' },
      filter: { type: 'object' },
    },
  },

  wealth_compare: {
    type: 'object',
    required: ['products', 'customerRisk', 'disclaimerId'],
    properties: {
      products: { type: 'array' },
      customerRisk: { type: 'string' },
      disclaimerId: { type: 'string' },
    },
  },

  wealth_purchase: {
    type: 'object',
    required: ['holdingId', 'productId', 'amountCents', 'disclaimerId', 'at', 'riskMatch'],
    properties: {
      holdingId: { type: 'string' },
      productId: { type: 'string' },
      productName: { type: 'string' },
      amountCents: { type: 'integer' },
      shares: { type: 'number' },
      disclaimerId: { type: 'string' },
      at: { type: 'integer' },
      riskMatch: {
        type: 'object',
        required: ['customerRisk', 'productRisk', 'at'],
        properties: {
          customerRisk: { type: 'string' },
          productRisk: { type: 'string' },
          at: { type: 'integer' },
        },
      },
    },
  },

  risk_assess: {
    type: 'object',
    // 判别式联合：questions / submit 两个分支各自声明必填，**恰好命中一个**才算通过。
    // 校验器（`@bah/util`）只支持根级一层 `oneOf`、分支必须是 object（见 `docs/pipeline.md` §8）。
    oneOf: [RISK_QUESTIONS_RESULT, RISK_SUBMIT_RESULT],
  },

  wealth_positions: {
    type: 'object',
    required: [
      'holdings',
      'totalCostCents',
      'totalMarketValueCents',
      'totalProfitCents',
      'disclaimerId',
    ],
    properties: {
      holdings: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'holdingId',
            'productId',
            'productName',
            'shares',
            'costCents',
            'marketValueCents',
            'profitCents',
          ],
          properties: {
            holdingId: { type: 'string' },
            productId: { type: 'string' },
            productName: { type: 'string' },
            shares: { type: 'number' },
            costCents: { type: 'integer' },
            marketValueCents: { type: 'integer' },
            profitCents: { type: 'integer' },
          },
        },
      },
      totalCostCents: { type: 'integer' },
      totalMarketValueCents: { type: 'integer' },
      totalProfitCents: { type: 'integer' },
      disclaimerId: { type: 'string' },
    },
  },

  wealth_redeem: {
    type: 'object',
    required: [
      'holdingId',
      'productId',
      'productName',
      'amountCents',
      'shares',
      'txnId',
      'balanceCents',
      'availableCents',
      'disclaimerId',
      'at',
    ],
    properties: {
      holdingId: { type: 'string' },
      productId: { type: 'string' },
      productName: { type: 'string' },
      amountCents: { type: 'integer' },
      shares: { type: 'number' },
      txnId: { type: 'string' },
      balanceCents: { type: 'integer' },
      availableCents: { type: 'integer' },
      disclaimerId: { type: 'string' },
      at: { type: 'integer' },
    },
  },

  /** 三个 `verify_*` 共用同一张 `VerifyResult`。 */
  verify_face: {
    type: 'object',
    required: ['channel', 'challengeId', 'success', 'attempts', 'remainingAttempts'],
    properties: {
      channel: { type: 'string', enum: ['face', 'sms', 'ushield'] },
      challengeId: { type: 'string' },
      success: { type: 'boolean' },
      attempts: { type: 'integer' },
      remainingAttempts: { type: 'integer' },
      lockedUntil: { type: 'integer' },
    },
  },

  verify_sms: {
    type: 'object',
    required: ['channel', 'challengeId', 'success', 'attempts', 'remainingAttempts'],
    properties: {
      channel: { type: 'string', enum: ['face', 'sms', 'ushield'] },
      challengeId: { type: 'string' },
      success: { type: 'boolean' },
      attempts: { type: 'integer' },
      remainingAttempts: { type: 'integer' },
      lockedUntil: { type: 'integer' },
    },
  },

  card_report_lost: {
    type: 'object',
    required: ['cardId', 'tail', 'status', 'reportedAt'],
    properties: {
      cardId: { type: 'string' },
      tail: { type: 'string' },
      status: { type: 'string', enum: ['lost'] },
      reportedAt: { type: 'integer' },
    },
  },

  fund_lock: {
    type: 'object',
    required: ['action', 'lockedCents', 'availableCents'],
    properties: {
      action: { type: 'string', enum: ['lock', 'release', 'status'] },
      lockedCents: { type: 'integer' },
      availableCents: { type: 'integer' },
      amountCents: { type: 'integer' },
      txnId: { type: 'string' },
    },
  },

  sub_cancel: {
    type: 'object',
    required: [
      'subscriptionId',
      'merchant',
      'status',
      'mode',
      'path',
      'cancelRequestId',
      'expectedEffectiveAt',
      'verifyBy',
      'cancelledAt',
    ],
    properties: {
      subscriptionId: { type: 'string' },
      merchant: { type: 'string' },
      status: { type: 'string', enum: ['cancelled', 'paused'] },
      mode: { type: 'string', enum: ['now', 'at-next-cycle'] },
      path: { type: 'string', enum: ['authorize', 'merchant', 'manual'] },
      cancelRequestId: { type: 'string' },
      expectedEffectiveAt: { type: 'integer' },
      verifyBy: { type: 'integer' },
      cancelledAt: { type: 'integer' },
      contractEndAt: { type: 'integer' },
      pauseUntil: { type: 'integer' },
    },
  },

  sub_list: {
    type: 'object',
    required: ['confirmed', 'detected', 'spendSplit', 'cutoffFindings', 'detectedAt', 'basis', 'detectorVersion'],
    properties: {
      confirmed: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'subscriptionId',
            'merchant',
            'merchantKey',
            'cycle',
            'amountCents',
            'monthlyCents',
            'nextChargeAt',
            'status',
          ],
          properties: {
            subscriptionId: { type: 'string' },
            merchant: { type: 'string' },
            merchantKey: { type: 'string' },
            cycle: { type: 'string' },
            amountCents: { type: 'integer' },
            monthlyCents: { type: 'integer' },
            nextChargeAt: { type: 'integer' },
            status: { type: 'string' },
            note: { type: 'string' },
            reminderAheadDays: { type: 'integer' },
            contractEndAt: { type: 'integer' },
            pauseUntil: { type: 'integer' },
            authorizationStatus: { type: 'string' },
          },
        },
      },
      detected: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'merchantKey',
            'displayName',
            'kind',
            'cycle',
            'amountCents',
            'monthlyCents',
            'confidence',
            'nextChargeAt',
            'count',
          ],
          properties: {
            merchantKey: { type: 'string' },
            displayName: { type: 'string' },
            kind: { type: 'string' },
            cycle: { type: 'string' },
            amountCents: { type: 'integer' },
            monthlyCents: { type: 'integer' },
            confidence: { type: 'string' },
            nextChargeAt: { type: 'integer' },
            count: { type: 'integer' },
            priceHike: { type: 'object' },
            priceDrop: { type: 'object' },
            trialConverted: { type: 'boolean' },
            suspectedInstallment: { type: 'boolean' },
            matchedSubscriptionId: { type: 'string' },
          },
        },
      },
      spendSplit: {
        type: 'object',
        required: [
          'subscriptionCents',
          'billCents',
          'installmentCents',
          'subscriptionCount',
          'billCount',
          'installmentCount',
        ],
        properties: {
          subscriptionCents: { type: 'integer' },
          billCents: { type: 'integer' },
          installmentCents: { type: 'integer' },
          subscriptionCount: { type: 'integer' },
          billCount: { type: 'integer' },
          installmentCount: { type: 'integer' },
        },
      },
      cutoffFindings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['kind', 'verdict', 'merchantKey', 'hint', 'dueAt'],
          properties: {
            kind: { type: 'string' },
            verdict: { type: 'string' },
            merchantKey: { type: 'string' },
            subscriptionId: { type: 'string' },
            authorizationId: { type: 'string' },
            level: { type: 'string' },
            hint: { type: 'string' },
            dueAt: { type: 'integer' },
          },
        },
      },
      detectedAt: { type: 'integer' },
      basis: {
        type: 'object',
        required: ['from', 'to', 'txnCount'],
        properties: {
          from: { type: 'integer' },
          to: { type: 'integer' },
          txnCount: { type: 'integer' },
        },
      },
      detectorVersion: { type: 'string' },
    },
  },

  sub_watch: {
    type: 'object',
    required: ['subscriptionId', 'merchant', 'watch', 'at'],
    properties: {
      subscriptionId: { type: 'string' },
      merchant: { type: 'string' },
      watch: { type: 'string', enum: ['remind', 'idle', 'none'] },
      aheadDays: { type: 'integer' },
      note: { type: 'string' },
      reminderAheadDays: { type: 'integer' },
      at: { type: 'integer' },
    },
  },

  sub_authorize: {
    type: 'object',
    required: [
      'authorizationId',
      'merchant',
      'status',
      'affected',
      'affectedSubscriptions',
      'restoreHint',
      'verifyBy',
      'revokedAt',
    ],
    properties: {
      authorizationId: { type: 'string' },
      merchant: { type: 'string' },
      status: { type: 'string', enum: ['revoked'] },
      affected: { type: 'integer' },
      affectedSubscriptions: { type: 'array', items: { type: 'string' } },
      restoreHint: { type: 'string' },
      verifyBy: { type: 'integer' },
      revokedAt: { type: 'integer' },
    },
  },

  verify_ushield: {
    type: 'object',
    required: ['channel', 'challengeId', 'success', 'attempts', 'remainingAttempts'],
    properties: {
      channel: { type: 'string', enum: ['face', 'sms', 'ushield'] },
      challengeId: { type: 'string' },
      success: { type: 'boolean' },
      attempts: { type: 'integer' },
      remainingAttempts: { type: 'integer' },
      lockedUntil: { type: 'integer' },
    },
  },

  card_freeze: CARD_STATE,
  card_unfreeze: CARD_STATE,
  card_apply: CARD_ISSUED,
  card_limit_set: CARD_LIMITS,
  /**
   * 交易密码（ADR-0014）：两条分支的出参形状不同，用根级 `oneOf` 钉住（与 `risk_assess` 同构）。
   *
   * - `request`：票据 + 交接页 + 过期时刻；**没有任何密码字段**（出参契约本身就是
   *   "工具拿不到明文"的第二道证明）；
   * - `status`：上次改密时刻（可为 `null`，故不声明 `type`——写 `integer` 会把 `null` 判红）
   *   + 剩余尝试次数。
   */
  password_change: {
    type: 'object',
    oneOf: [
      {
        type: 'object',
        required: ['action', 'ticketId', 'handoffPath', 'expiresAt', 'at'],
        properties: {
          action: { type: 'string', enum: ['request'] },
          ticketId: { type: 'string' },
          handoffPath: { type: 'string' },
          expiresAt: { type: 'integer' },
          at: { type: 'integer' },
        },
      },
      {
        type: 'object',
        required: ['action', 'lastChangedAt', 'remainingAttempts', 'at'],
        properties: {
          action: { type: 'string', enum: ['status'] },
          lastChangedAt: { description: '最后一次改密时刻（epoch ms）；从未改过为 null' },
          remainingAttempts: { type: 'integer' },
          at: { type: 'integer' },
        },
      },
    ],
  },

  card_restriction: CARD_RESTRICTIONS,
}
