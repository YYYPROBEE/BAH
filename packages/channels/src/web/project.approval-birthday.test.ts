/**
 * 生日计划审批帧：**三腿逐条可见**（G8 的渠道侧证据）。
 *
 * 这一条只回答一个问题：用户点开审批弹窗时，能不能看见
 * 「锁定 ¥1,000.00 / 鲜花 ¥129.00（即刻花）/ 蛋糕 ¥169.00（小满烘焙）」三笔钱，
 * 而不是只看见一个叫 `birthday_plan` 的工具名。
 *
 * 为什么单独一个文件：`project.details.test.ts` 用的是转账夹具（单笔金额），
 * 覆盖不到"一次批准 = 三笔不同的钱"这个形状；而这正是 C-04 缺口的原始描述。
 *
 * 抗自证：帧上的数字**全部**来自事件里的 `details`（服务端签发），本用例不重算；
 * 反例（把明细删掉）会让本条红。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { projectSession } from './project.ts'
import type { ApprovalFrame } from './frames.ts'
import { projectImOutbound } from '../im/render.ts'

let cursor = 0

function ev(type: string, data: unknown, at = 1_700_000_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

/** 宿主侧 `renderBirthdayDetails()` 的产物（这里逐字抄一份，等于钉住"帧原样投影"）。 */
const BIRTHDAY_DETAILS = [
  { label: '锁定预算', value: '¥1,000.00 → 锁定账户(9012)', emphasis: 'amount' },
  { label: '鲜花', value: '¥129.00（即刻花，生日前 2 天 09:00 UTC）', emphasis: 'amount' },
  { label: '蛋糕', value: '¥169.00（小满烘焙，生日前 2 天 09:00 UTC）', emphasis: 'amount' },
  { label: '总预算', value: '¥1,298.00', emphasis: 'amount' },
  { label: '窗口到期', value: '1970-02-06T09:00:00.000Z', emphasis: 'date' },
  { label: '条件快照', value: '余额 ≥ ¥1,298.00' },
  { label: '授权档位', value: '标准（条件成立才自动执行）' },
]

function frameOf(): ApprovalFrame {
  cursor = 0
  const events: AnySessionEvent[] = [
    ev('turn/start', { turn: 1 }),
    ev('tool/call', {
      callId: 'call-birthday',
      name: 'birthday_plan',
      // 注意：入参里**没有** amount —— 金额全在明细里，审批帧不能因此显示 ¥0.00
      args: { birthday: '下个月8号', lockYuan: 1000, flowerYuan: 200, cakeYuan: 200 },
      fingerprint: 'fp-birthday',
      tier: { level: 'yellow' },
      at: 1_700_000_000_000,
    }),
    ev('approval/asked', {
      ticketId: 'ticket:call-birthday',
      callId: 'call-birthday',
      name: 'birthday_plan',
      details: BIRTHDAY_DETAILS,
    }),
  ]
  const frame = projectSession(events).frames.find((item) => item.kind === 'approval')
  expect(frame?.kind).toBe('approval')
  return frame as ApprovalFrame
}

describe('生日计划审批帧', () => {
  it('操作类型走 toolTitle（不是硬编码「转账」，也不是裸工具名）', () => {
    const frame = frameOf()
    expect(frame.operation).toBe('生日定时计划')
    expect(frame.name).toBe('birthday_plan')
  })

  it('三腿逐条可见：锁定预算 / 鲜花 / 蛋糕，各自带商户与金额', () => {
    const frame = frameOf()
    const labels = (frame.details ?? []).map((detail) => detail.label)
    expect(labels.slice(0, 3)).toEqual(['锁定预算', '鲜花', '蛋糕'])

    const detail = (label: string): string | undefined =>
      frame.details?.find((item) => item.label === label)?.value
    expect(detail('锁定预算')).toBe('¥1,000.00 → 锁定账户(9012)')
    expect(detail('鲜花')).toContain('¥129.00')
    expect(detail('鲜花')).toContain('即刻花')
    expect(detail('蛋糕')).toContain('¥169.00')
    expect(detail('蛋糕')).toContain('小满烘焙')
  })

  it('没有 amount 入参就不渲染金额行（不能出现 ¥0.00 冒充"免费"）', () => {
    const frame = frameOf()
    expect(frame.amountText).toBeUndefined()
  })

  it('IM 摘要：有明细时不再并列"金额/收款人"，也不退化成"待确认"', () => {
    const outbound = projectImOutbound([frameOf()])
    expect(outbound).toHaveLength(1)
    const first = outbound[0]
    expect(first?.kind).toBe('approval')
    if (first?.kind !== 'approval') return
    // 标题走 toolTitle（不是「转账」也不是裸工具名）
    expect(first.text).toContain('【审批】生日定时计划')
    // 明细已经有同一份数字：IM 摘要不许再并列一行"金额：待确认"让人猜
    expect(first.text).not.toContain('金额：')
    expect(first.text).not.toContain('待确认')
    // 逐行明细由网关的文本出口追加（`apps/im-gateway/src/approval/texts.ts`），不在本层
  })
})
