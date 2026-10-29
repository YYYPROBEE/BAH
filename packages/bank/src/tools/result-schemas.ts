/**
 * 14 个银行工具的**出参契约表**（W03 · G-1 的出参侧）。
 *
 * ## 为什么是一张按名索引的表，而不是写进每个 `BankToolSpec`
 *
 * W03 §2 原话是"`BankToolSpec` 加可选 `resultSchema`"。实际改成单表，两个理由：
 * 1. 宿主装配时**本来就是按名查**（`get(name)`），表格式天然契合，14 处内联反而多一次转换；
 * 2. 14 份 schema 分散在 300 行的 specs 数组里，改一个漏一个不会被任何检查发现；
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
      period: { type: 'string', enum: ['month', 'quarter'] },
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
      anomalies: { type: 'array' },
      momChangePct: { type: 'number' },
      comparedPeriod: { type: 'string' },
    },
  },

  bill_report: {
    type: 'object',
    required: ['period', 'format', 'text', 'analysis'],
    properties: {
      period: { type: 'string', enum: ['month', 'quarter'] },
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

  wealth_list: {
    type: 'object',
    required: ['products', 'disclaimerId'],
    properties: {
      products: {
        type: 'array',
        items: {
          type: 'object',
          required: ['productId', 'name', 'minAmountCents'],
          properties: {
            productId: { type: 'string' },
            name: { type: 'string' },
            kind: { type: 'string' },
            termDays: { type: 'integer' },
            expectedYieldPct: { type: 'number' },
            riskGrade: { type: 'string' },
            minAmountCents: { type: 'integer' },
          },
        },
      },
      disclaimerId: { type: 'string' },
      filter: { type: 'object' },
    },
  },

  wealth_compare: {
    type: 'object',
    required: ['products', 'disclaimerId'],
    properties: {
      products: { type: 'array' },
      disclaimerId: { type: 'string' },
    },
  },

  wealth_purchase: {
    type: 'object',
    required: ['holdingId', 'productId', 'amountCents', 'disclaimerId', 'at'],
    properties: {
      holdingId: { type: 'string' },
      productId: { type: 'string' },
      productName: { type: 'string' },
      amountCents: { type: 'integer' },
      shares: { type: 'number' },
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

  sub_cancel: {
    type: 'object',
    required: ['subscriptionId', 'merchant', 'status', 'cancelledAt'],
    properties: {
      subscriptionId: { type: 'string' },
      merchant: { type: 'string' },
      status: { type: 'string', enum: ['cancelled'] },
      cancelledAt: { type: 'integer' },
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
}
