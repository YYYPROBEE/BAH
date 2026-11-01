/**
 * 审批明细用例（`approval-details.ts`）。
 *
 * 三组断言，各自钉一条纪律：
 * 1. **内容**：逐工具断言"用户批准时看到的到底是什么"（金额/收款人/额度/状态变更…）；
 * 2. **来源**：同样的入参、只改 core 里的账本 ⇒ 明细跟着变（证明不是从 args 猜的）；
 * 3. **降级**：core 抛错 / 实体不存在 / 工具没有明细 ⇒ 整条省略，绝不编造。
 *
 * 负控（每条都在下面有对应用例）：
 * - 手机号必须已脱敏，完整号码不得出现在明细里（PII）；
 * - AA 参与人手机号完全不得出现（群收款不需要它）；
 * - 明细内容不得参与 fingerprint（在 runtime 的 pipeline 用例里钉）。
 */

import { describe, expect, it } from 'vitest'

import { PASSWORD_HANDOFF_PATH, PASSWORD_HANDOFF_TTL_SECONDS } from '../core/password.ts'
import { createBankHarness, createPipelineHarness } from './testing.ts'
import { specOf } from './specs.ts'
import { detailsForCall } from './approval-details.ts'
import { fingerprintOf } from './fingerprint.ts'
import { formatYuan } from '../core/index.ts'

/** 演示剧本里的那一笔（与 governance 用例同参）。 */
const TRANSFER_800 = {
  amount: 800,
  payee: { name: '王建国', phone: '13900002222' },
  remark: '房租',
}

/** 明细 → `{ 标签: 值 }`（断言比数组下标稳）。 */
function mapOf(rows: readonly { label: string; value: string }[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.label, row.value]))
}

describe('转账明细', () => {
  it('金额/收款人(脱敏)/当日已用/剩余/手续费/附言 齐全且与 core 试算逐字一致', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('transfer_create'), TRANSFER_800)
    const map = mapOf(rows)

    expect(rows).toHaveLength(6)
    expect(map['金额']).toBe('¥800.00')
    expect(map['收款人']).toBe('王建国（139****2222）')
    expect(map['当日已用']).toBe('¥0.00')
    expect(map['当日剩余']).toBe('¥1,000.00')
    expect(map['手续费']).toBe('¥0.00')
    expect(map['附言']).toBe('房租')
    // 强调语义：金额类走等宽字体，日期/风险不参与
    expect(rows.find((row) => row.label === '金额')?.emphasis).toBe('amount')
    expect(rows.find((row) => row.label === '收款人')?.emphasis).toBeUndefined()
  })

  it('PII：完整手机号不得出现在明细里（只有前 3 后 4）', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('transfer_create'), TRANSFER_800)
    expect(JSON.stringify(rows)).not.toContain('13900002222')
    expect(JSON.stringify(rows)).toContain('139****2222')
  })

  it('同样的入参、core 里多了一笔已发生转账 ⇒ 当日已用/剩余 跟着变（来源是 core）', async () => {
    // 用真实管线走一遍写路径（票据门禁照旧），只改账本、不改入参
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const before = mapOf(
        await detailsForCall(h.deps, 'u-1', specOf('transfer_create'), TRANSFER_800),
      )
      expect(before['当日已用']).toBe('¥0.00')

      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(false)

      const after = mapOf(
        await detailsForCall(h.deps, 'u-1', specOf('transfer_create'), TRANSFER_800),
      )
      expect(after['当日已用']).toBe('¥800.00')
      expect(after['当日剩余']).toBe('¥200.00')
      expect(after['金额']).toBe(before['金额'])
    } finally {
      await h.dispose()
    }
  })

  it('core 试算失败（未绑定用户）⇒ 整组省略，不拿参数里的 amount 兜底', async () => {
    const h = createBankHarness({ userId: null })
    const rows = await detailsForCall(h.deps, 'u-404', specOf('transfer_create'), TRANSFER_800)
    expect(rows).toEqual([])
  })
})

describe('理财明细', () => {
  it('申购：产品/R×/期限/起投/金额/适当性成对出现', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('wealth_purchase'), {
      productId: 'w-1',
      amount: 1000,
    })
    const map = mapOf(rows)
    expect(map['产品']).toBe('稳盈 90 天')
    expect(map['产品风险等级']).toBe('R1')
    expect(map['期限']).toBe('90 天')
    expect(map['起投金额']).toBe('¥100.00')
    expect(map['本次申购']).toBe('¥1,000.00')
    // 客户 R2 ↔ 产品 R1：同一份 `checkSuitability` 给出的结论
    expect(map['适当性']).toBe('R2 ↔ R1 匹配')
  })

  it('申购：产品不存在 ⇒ 只留金额，不编产品名与适当性', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('wealth_purchase'), {
      productId: 'w-404',
      amount: 500,
    })
    const map = mapOf(rows)
    expect(map['本次申购']).toBe('¥500.00')
    expect(map['产品']).toBeUndefined()
    expect(map['适当性']).toBeUndefined()
  })

  it('赎回：持仓市值/成本/收益/入账账户尾号来自 core', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('wealth_redeem'), { holdingId: 'h-1' })
    const map = mapOf(rows)
    expect(map['持仓产品']).toBe('稳盈 90 天')
    expect(map['持有份额']).toBe('500.00 份')
    expect(map['持仓市值']).toBe('¥508.00')
    expect(map['本次赎回']).toBe('¥508.00')
    expect(map['持仓成本']).toBe('¥500.00')
    expect(map['当前收益']).toBe('¥8.00')
    expect(map['入账账户']).toBe('活期账户(1234)')
  })

  it('赎回：给了 amountYuan 时"本次赎回"用该值，市值仍是 core 的持仓事实', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('wealth_redeem'), {
        holdingId: 'h-1',
        amountYuan: 100,
      }),
    )
    expect(map['本次赎回']).toBe('¥100.00')
    expect(map['持仓市值']).toBe('¥508.00')
  })
})

describe('卡片明细', () => {
  it('冻结：显示卡尾号与状态变更（不再有空的金额区）', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('card_freeze'), {
      cardId: 'c-1',
      reason: '疑似盗刷',
    })
    const map = mapOf(rows)
    expect(map['卡片']).toBe('尾号 1234（实体卡）')
    expect(map['状态变更']).toBe('正常 → 已冻结')
    expect(map['冻结原因']).toBe('疑似盗刷')
    expect(rows.every((row) => !row.label.includes('金额'))).toBe(true)
  })

  it('挂失：状态变更写明不可逆', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('card_report_lost'), { cardId: 'c-1' }),
    )
    expect(map['状态变更']).toBe('正常 → 已挂失（不可逆）')
  })

  it('限额调整：现值来自 core，改账本后同参明细跟着变', async () => {
    const h = createBankHarness()
    const args = { cardId: 'c-1', dailyLimitYuan: 9000 }
    const before = mapOf(await detailsForCall(h.deps, 'u-1', specOf('card_limit_set'), args))
    expect(before['当前日限']).toBe('¥1,000.00')
    expect(before['本次调整为日限']).toBe('¥9,000.00')

    // 只改 core（core 的 setCardLimits 不接票据，票据门禁在治理面）
    await h.core.setCardLimits('u-1' as never, 'c-1' as never, { dailyLimitCents: 500_000 })
    const after = mapOf(await detailsForCall(h.deps, 'u-1', specOf('card_limit_set'), args))
    expect(after['当前日限']).toBe('¥5,000.00')
    expect(after['本次调整为日限']).toBe('¥9,000.00')
  })

  it('明细变了、指纹不变：指纹只取工具名 + 参数（明细不参与绑定）', async () => {
    const h = createBankHarness()
    const args = { cardId: 'c-1', dailyLimitYuan: 9000 }
    const beforePrint = fingerprintOf('card_limit_set', args)
    const before = mapOf(await detailsForCall(h.deps, 'u-1', specOf('card_limit_set'), args))
    await h.core.setCardLimits('u-1' as never, 'c-1' as never, { dailyLimitCents: 700_000 })
    const after = mapOf(await detailsForCall(h.deps, 'u-1', specOf('card_limit_set'), args))

    expect(before['当前日限']).not.toBe(after['当前日限'])
    expect(fingerprintOf('card_limit_set', args)).toBe(beforePrint)
  })

  it('交易限制：现有同类限制条数来自 core', async () => {
    const h = createBankHarness()
    const args = { cardId: 'c-1', mode: 'set', kind: 'online' }
    const before = mapOf(await detailsForCall(h.deps, 'u-1', specOf('card_restriction'), args))
    expect(before['本次操作']).toBe('设置限制：线上交易')
    expect(before['现有同类限制']).toBe('0 条')

    await h.core.setCardRestriction('u-1' as never, 'c-1' as never, {
      mode: 'set',
      kind: 'online',
    })
    const after = mapOf(await detailsForCall(h.deps, 'u-1', specOf('card_restriction'), args))
    expect(after['现有同类限制']).toBe('1 条')
  })

  it('新卡申请：没有尾号就先不写尾号，只给卡型/挂靠账户/本次申请限额', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('card_apply'), {
        type: 'virtual',
        dailyLimitYuan: 3000,
        monthlyLimitYuan: 9000,
      }),
    )
    expect(map['卡类型']).toBe('虚拟卡')
    expect(map['挂靠账户']).toBe('活期账户(1234)')
    expect(map['本次申请日限']).toBe('¥3,000.00')
    expect(map['本次申请月限']).toBe('¥9,000.00')
    expect(map['卡片']).toBeUndefined()
  })
})

describe('订阅明细', () => {
  it('取消：商户/扣款/下一次扣费/取消方式/同商户其余项', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('sub_cancel'), {
        subscriptionId: 's-1',
        mode: 'now',
      }),
    )
    expect(map['商户']).toBe('视频会员')
    expect(map['每月扣款']).toBe('¥30.00')
    expect(map['下一次扣费']).toBe('2026-10-24')
    expect(map['取消方式']).toBe('立即取消')
    expect(map['同商户其余在扣项']).toBe('无')
  })

  it('提醒：写明"不改变扣款"（影响面复述）', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('sub_watch'), {
        subscriptionId: 's-1',
        watch: 'remind',
        aheadDays: 3,
      }),
    )
    expect(map['本次设置']).toBe('到期提醒（提前 3 天）')
    expect(map['对扣款的影响']).toBe('仅提醒/标注，不改变扣款')
  })

  it('关协议：影响订阅数与在扣合计来自 core', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('sub_authorize'), { merchant: '视频会员' }),
    )
    expect(map['影响订阅']).toBe('1 项')
    expect(map['在扣合计']).toBe('¥30.00')
    expect(map['协议状态']).toContain('只关不开')
  })
})

describe('AA 明细', () => {
  it('标题/总额/人数/均分份额；手机号完全不进明细', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
      title: '周末聚餐',
      totalYuan: 300,
      split: 'equal',
      participants: [
        { name: '张三', phone: '13800001111' },
        { name: '李四', phone: '13900002222' },
        { name: '王五' },
      ],
    })
    const map = mapOf(rows)
    expect(map['标题']).toBe('周末聚餐')
    expect(map['总额']).toBe('¥300.00')
    expect(map['参与人数']).toBe('3 人')
    expect(map['每人份额']).toBe('均分 ¥100.00/人')
    expect(JSON.stringify(rows)).not.toContain('13800001111')
    expect(JSON.stringify(rows)).not.toContain('13900002222')
  })

  it('均分除不尽：余数如实写在首位，不四舍五入抹掉', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        title: '打车',
        totalYuan: 100,
        participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
      }),
    )
    // 100 元 / 3 人 = 3333 分，余 1 分给首位
    expect(map['每人份额']).toBe('均分 ¥33.33/人（首位 ¥33.34，含余数）')
  })

  it('自定义份额：只给区间，不逐人罗列（避免超长卡片）', async () => {
    const h = createBankHarness()
    const map = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        title: '按量分摊',
        totalYuan: 300,
        split: 'custom',
        participants: [
          { name: '张三', shareYuan: 50 },
          { name: '李四', shareYuan: 250 },
        ],
      }),
    )
    expect(map['每人份额']).toBe('自定义 ¥50.00–¥250.00')
  })

  it('动作式：collect/decline 从 core 现读参与人份额，close 汇总剩余未付', async () => {
    const h = createBankHarness()
    const created = (await h.call('aa_create', {
      title: '周末聚餐',
      totalYuan: 100,
      participants: [{ name: '张三' }, { name: '李四' }, { name: '王五' }],
    })) as { groupId: string }

    const collect = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        action: 'collect',
        groupId: created.groupId,
        participant: '1',
      }),
    )
    expect(collect['动作']).toBe('模拟代收一位参与人')
    expect(collect['参与人']).toBe('李四')
    expect(collect['份额']).toBe('¥33.33')
    expect(collect['本次入账']).toBe('¥33.33')

    const decline = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        action: 'decline',
        groupId: created.groupId,
        participant: '王五',
      }),
    )
    expect(decline['动作']).toBe('记录一位参与人拒绝')
    expect(decline['份额']).toBe('¥33.33')
    expect(decline['本次入账']).toBe('0（拒绝不入账）')

    const close = mapOf(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        action: 'close',
        groupId: created.groupId,
      }),
    )
    expect(close['剩余未付']).toBe('3 人 · ¥100.00')
    expect(close['收口结果']).toContain('转为已过期')
  })

  it('status 没有明细；未知组 / 缺 groupId 整组省略，不编造组名', async () => {
    const h = createBankHarness()
    const created = (await h.call('aa_create', {
      title: '打车',
      totalYuan: 20,
      participants: [{ name: '张三' }, { name: '李四' }],
    })) as { groupId: string }

    expect(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        action: 'status',
        groupId: created.groupId,
      }),
    ).toEqual([])
    expect(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), {
        action: 'collect',
        groupId: 'aa-missing',
        participant: '0',
      }),
    ).toEqual([])
    expect(
      await detailsForCall(h.deps, 'u-1', specOf('aa_create'), { action: 'collect' }),
    ).toEqual([])
  })
})

describe('交易密码明细（ADR-0014）', () => {
  it('request：讲清交接页/一次性 TTL/密码去向，且不渲染任何密码材料', async () => {
    const h = createBankHarness()
    const rows = await detailsForCall(h.deps, 'u-1', specOf('password_change'), {
      action: 'request',
      oldPassword: 'bank1234',
      newPassword: 'bank5678',
    })
    const map = mapOf(rows)
    expect(map['操作']).toContain('交办，不代改')
    expect(map['交接页']).toBe(PASSWORD_HANDOFF_PATH)
    expect(map['票据有效期']).toBe(`${String(PASSWORD_HANDOFF_TTL_SECONDS)} 秒（一次性）`)
    expect(map['密码去哪']).toBe('只在安全页表单里提交；不进模型、不进会话日志')
    expect(map['事后']).toContain('security/password-changed')
    // 负控：即使入参误带了密码，明细也必须一个字符都不回显
    expect(JSON.stringify(rows)).not.toContain('bank1234')
    expect(JSON.stringify(rows)).not.toContain('bank5678')
  })

  it('status：查询没有"即将改变什么"，返回空明细', async () => {
    const h = createBankHarness()
    expect(
      await detailsForCall(h.deps, 'u-1', specOf('password_change'), { action: 'status' }),
    ).toEqual([])
  })
})

describe('风险测评明细', () => {
  it('五题「题干 → 所选项」+ 得分 + 等级变更，题干来自服务端问卷', async () => {
    const h = createBankHarness()
    const questionnaire = await h.core.issueRiskQuestions('u-1' as never)
    const rows = await detailsForCall(h.deps, 'u-1', specOf('risk_assess'), {
      action: 'submit',
      questionnaireId: questionnaire.id,
      answers: [
        { index: 1, key: 'conservative' },
        { index: 2, key: 'middle' },
        { index: 3, key: 'conservative' },
        { index: 4, key: 'middle' },
        { index: 5, key: 'conservative' },
      ],
    })
    const map = mapOf(rows)
    // 题干逐字来自 `risk-questionnaire.ts` 的常量表（模型只回传 key）
    expect(map['您的投资经验有多久？']).toBe('没有投资经验（1 分）')
    expect(map['这笔钱大概多久不用？']).toBe('1–3 年不用（3 分）')
    // 1 + 3 + 1 + 3 + 1 = 9 → R2（当前 R2 → R2）
    expect(map['得分']).toBe('9 分')
    expect(map['等级变更（批准后生效）']).toBe('R2 → R2')
    expect(rows).toHaveLength(7)
  })

  it('问卷不存在 / 五题不齐 ⇒ 空明细，不猜答案', async () => {
    const h = createBankHarness()
    const questionnaire = await h.core.issueRiskQuestions('u-1' as never)
    expect(
      await detailsForCall(h.deps, 'u-1', specOf('risk_assess'), {
        action: 'submit',
        questionnaireId: questionnaire.id,
        answers: [{ index: 1, key: 'conservative' }],
      }),
    ).toEqual([])
  })
})

describe('降级与封闭清单', () => {
  it('实体不存在（未知卡号）⇒ 空明细，不编造尾号', async () => {
    const h = createBankHarness()
    expect(await detailsForCall(h.deps, 'u-1', specOf('card_freeze'), { cardId: 'c-404' })).toEqual([])
  })

  it('core 读取抛错 ⇒ 该工具整组省略；其它读取不受影响（不抛穿审批链）', async () => {
    const h = createBankHarness()
    const deps = {
      ...h.deps,
      core: new Proxy(h.core, {
        get(target, property, receiver) {
          if (property === 'listCards') {
            return async () => {
              throw new Error('core-down')
            }
          }
          return Reflect.get(target, property, receiver)
        },
      }),
    }
    expect(await detailsForCall(deps, 'u-1', specOf('card_freeze'), { cardId: 'c-1' })).toEqual([])
    // 同一份 deps 上，不依赖 listCards 的工具照常出明细
    const transfer = mapOf(await detailsForCall(deps, 'u-1', specOf('transfer_create'), TRANSFER_800))
    expect(transfer['金额']).toBe('¥800.00')
  })

  it('没有明细的工具返回空数组（读操作 / 强验证）', async () => {
    const h = createBankHarness()
    expect(await detailsForCall(h.deps, 'u-1', specOf('account_list'), {})).toEqual([])
    expect(await detailsForCall(h.deps, 'u-1', specOf('verify_sms'), {})).toEqual([])
  })

  it('参数形状不对（缺 answers / 非数组）⇒ 空明细，不猜', async () => {
    const h = createBankHarness()
    expect(await detailsForCall(h.deps, 'u-1', specOf('risk_assess'), {})).toEqual([])
    expect(
      await detailsForCall(h.deps, 'u-1', specOf('risk_assess'), {
        action: 'submit',
        questionnaireId: 'rq-404',
        answers: [],
      }),
    ).toEqual([])
  })
})

/**
 * 端到端：治理面签票 → 管线落账 → 事件里带明细。
 *
 * 这条是验收口径的机器版：「审批弹窗里看到的就是服务端即将执行的内容」——
 * 明细里的每个金额都必须与同 turn 的 `transfer_preview` **出参**逐字一致，
 * 而不是与入参一致（入参是模型写的，出参是 core 算的）。
 */
describe('端到端：approval/asked 携带明细', () => {
  it('transfer_create：明细 ≥ 5 条，金额/已用/剩余/手续费与 transfer_preview 出参逐字一致', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const preview = await h.run('transfer_preview', TRANSFER_800)
      const values = preview.value as {
        amountCents: number
        feeCents: number
        dailyUsedCents: number
        remainingCents: number
      }

      const execution = await h.run('transfer_create', TRANSFER_800)
      expect(execution.result.isError).toBe(false)

      const asked = h.events().find((event) => event.type === 'approval/asked')
      const details = (asked?.data as { details?: readonly { label: string; value: string }[] })
        .details
      expect(details).toBeDefined()
      expect(details?.length).toBeGreaterThanOrEqual(5)
      const map = mapOf(details ?? [])

      // 逐字一致：同一份 core 数字，两种出口（工具出参 / 审批明细）
      expect(map['金额']).toBe(formatYuan(values.amountCents))
      expect(map['当日已用']).toBe(formatYuan(values.dailyUsedCents))
      expect(map['当日剩余']).toBe(formatYuan(values.remainingCents))
      expect(map['手续费']).toBe(formatYuan(values.feeCents))
      expect(map['收款人']).toBe('王建国（139****2222）')
    } finally {
      await h.dispose()
    }
  })

  it('card_freeze：非金额操作的明细不含金额，只含尾号与状态变更', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      await h.run('card_freeze', { cardId: 'c-1' })
      const asked = h.events().find((event) => event.type === 'approval/asked')
      const details = (asked?.data as { details?: readonly { label: string; value: string }[] })
        .details
      const map = mapOf(details ?? [])
      expect(map['卡片']).toBe('尾号 1234（实体卡）')
      expect(map['状态变更']).toBe('正常 → 已冻结')
      expect(Object.keys(map)).not.toContain('金额')
    } finally {
      await h.dispose()
    }
  })
})

describe('风险测评明细 · 归属负控', () => {
  it('别人的问卷（同 ID 但卷主不同）⇒ 空明细，不渲染任何题目', async () => {
    const h = createBankHarness()
    const questionnaire = await h.core.issueRiskQuestions('u-1' as never)
    // 第二个 harness 的用户不是卷主：同一份问卷 ID 传进来必须被拦
    const other = createBankHarness({ userId: 'u-2' })
    const rows = await detailsForCall(other.deps, 'u-2', specOf('risk_assess'), {
      action: 'submit',
      questionnaireId: questionnaire.id,
      answers: [
        { index: 1, key: 'middle' },
        { index: 2, key: 'middle' },
        { index: 3, key: 'middle' },
        { index: 4, key: 'middle' },
        { index: 5, key: 'middle' },
      ],
    })
    expect(rows).toEqual([])
  })
})
