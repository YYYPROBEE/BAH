/**
 * 工具目录 / 卡片契约（施工单 08 §0 第 3–4 条、§6 T-TOOLS-009 / 010）。
 *
 * `docs/tool-catalog.md` 是生成物：这里同时钉住「文档 = 渲染结果」与「工厂 = 目录」，
 * 门禁 `verify-tool-catalog` 是同一断言的提交前版本。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { AccountsResult, BalanceResult, TransferPreviewResult, VerifyResult, WealthListResult } from './dto.ts'
import { BANK_TOOL_FACTORY_NAMES } from './catalog.ts'
import { BANK_SESSION_EVENT_TYPES } from './events.ts'
import {
  accountsCard,
  balanceCard,
  transferCreatedCard,
  transferPreviewCard,
  verifyCard,
  wealthCard,
} from './presenters.ts'
import { renderToolCatalog } from './render.ts'
import { BANK_TOOL_LIMIT, BANK_TOOL_NAMES, BANK_TOOL_SPECS, specOf } from './specs.ts'
import { createBankHarness } from './testing.ts'

/** 仓库根下的生成物（相对本测试文件）。 */
const CATALOG_DOC = new URL('../../../../docs/tool-catalog.md', import.meta.url)

describe('工具目录（施工单 08 §2）', () => {
  it('14 个 P0 工具、数量不超上限、名字唯一', () => {
    expect(BANK_TOOL_SPECS).toHaveLength(14)
    expect(BANK_TOOL_SPECS.length).toBeLessThanOrEqual(BANK_TOOL_LIMIT)
    expect(new Set(BANK_TOOL_NAMES).size).toBe(BANK_TOOL_NAMES.length)
  })

  it('6 查询 + 2 转账 + 3 理财 + 3 强验证，顺序稳定', () => {
    expect(BANK_TOOL_NAMES).toEqual([
      'account_list',
      'account_balance',
      'txn_query',
      'bill_analyze',
      'bill_report',
      'analysis_calc',
      'transfer_preview',
      'transfer_create',
      'wealth_list',
      'wealth_compare',
      'wealth_purchase',
      'verify_face',
      'verify_sms',
      'verify_ushield',
    ])
    expect(specOf('transfer_create').tier).toEqual({ level: 'yellow', amountPath: 'amount' })
    expect(specOf('wealth_purchase').tier.level).toBe('red')
    expect(specOf('account_balance').tier.level).toBe('green')
  })

  it('每个 description 都写「何时用 / 何时不用」两句', () => {
    for (const spec of BANK_TOOL_SPECS) {
      expect(spec.description, spec.name).toContain('用')
      expect(spec.description, spec.name).toContain('不要')
    }
  })

  it('T-TOOLS-010 工厂表与目录穷尽一致', () => {
    expect([...BANK_TOOL_FACTORY_NAMES].sort()).toEqual([...BANK_TOOL_NAMES].sort())
  })

  it('落账事件都在 BANK_SESSION_EVENT_TYPES 内', () => {
    for (const spec of BANK_TOOL_SPECS) {
      expect(BANK_SESSION_EVENT_TYPES).toContain(spec.event)
    }
    expect(new Set(BANK_SESSION_EVENT_TYPES).size).toBe(BANK_SESSION_EVENT_TYPES.length)
  })

  it('T-TOOLS-010 docs/tool-catalog.md 与源码渲染逐字一致（篡改即红）', () => {
    const actual = readFileSync(CATALOG_DOC, 'utf8').replace(/\r\n/g, '\n').trimEnd()
    const expected = renderToolCatalog(BANK_TOOL_SPECS, BANK_TOOL_LIMIT).trimEnd()
    expect(actual).toBe(expected)

    // 负控：删掉一个工具行后，渲染结果必须不同（门禁会红）
    const tampered = actual
      .split('\n')
      .filter((line) => !line.includes('`wealth_purchase`'))
      .join('\n')
    expect(tampered).not.toBe(expected)
  })
})

describe('T-TOOLS-009 presenter 纯度', () => {
  it('余额 / 账户列表 / 转账预演：同输入两次输出全等', () => {
    const accounts: AccountsResult = {
      accounts: [
        {
          accountId: 'a-1' as never,
          tail: '1234',
          type: 'current',
          status: 'active',
          balanceCents: 1_234_567,
          availableCents: 1_234_567,
        },
      ],
      availableTotalCents: 1_234_567,
    }
    const balance: BalanceResult = {
      accountId: 'a-1' as never,
      tail: '1234',
      balanceCents: 1_234_567,
      availableCents: 1_234_567,
      frozenCents: 0,
      asOf: 1_792_000_000_000,
      txnRef: 'balance:c-1',
    }
    const preview: TransferPreviewResult = {
      amountCents: 80_000,
      feeCents: 0,
      payeeName: '王建国',
      payeeBinding: 'whitelist',
      dailyUsedCents: 0,
      dailyLimitCents: 500_000,
      remainingCents: 500_000,
      risks: [],
      verdict: 'allow',
      effectiveTier: 'yellow',
      at: 1_792_000_000_000,
    }
    const wealth: WealthListResult = {
      products: [],
      disclaimerId: 'wealth-risk-v1',
    }
    const verify: VerifyResult = {
      channel: 'sms',
      challengeId: 'vc-1',
      success: false,
      attempts: 1,
      remainingAttempts: 2,
    }

    expect(accountsCard(accounts)).toEqual(accountsCard(accounts))
    expect(balanceCard(balance)).toEqual(balanceCard(balance))
    expect(transferPreviewCard(preview)).toEqual(transferPreviewCard(preview))
    expect(wealthCard(wealth, 'list')).toEqual(wealthCard(wealth, 'list'))
    expect(verifyCard(verify)).toEqual(verifyCard(verify))
    const created = {
      txnId: 't-1' as never,
      ticketId: 'ticket:c-1' as never,
      amountCents: 80_000,
      feeCents: 0,
      payeeName: '王建国',
      balanceCents: 1_154_567,
      availableCents: 1_154_567,
      dailyUsedCents: 80_000,
      dailyLimitCents: 500_000,
      remainingCents: 420_000,
      at: 1_792_000_000_000,
    }
    expect(transferCreatedCard(created)).toEqual(transferCreatedCard(created))
  })

  it('presentCall 不抛错：模型给坏参数时退化为「待定」卡片', () => {
    const h = createBankHarness()
    const tool = h.tools.get('transfer_create')!
    expect(() => tool.presentCall?.({ amount: '八百', payee: 42 })).not.toThrow()
    expect(tool.presentCall?.({})).toMatchObject({
      kind: 'bank.transfer-confirm',
      data: { amountText: '（金额待定）', payeeName: '（收款人待定）' },
    })
  })
})
