/**
 * 主动提醒载荷 → `notice` 帧（ADR-0016）。
 *
 * 三条判据都是"宁可少显示，也不显示错的东西"：
 * - 送出去的那条必须变成既有 `notice` 帧（不新增帧 kind，前端零改动）；
 * - 被预算压掉的（`channel='none'`）**不显示**——只进审计；
 * - 载荷形状不合格（旧日志 / 坏样本）返回 `undefined`，不抛错（投影器不能因为一条
 *   坏事件把整段对话的帧流打断）。
 */

import { describe, expect, it } from 'vitest'

import { proactiveNoticeOf } from './proactive.ts'

const AT = 1_700_000_000_000

describe('proactiveNoticeOf', () => {
  it('in-app / im 投递 → notice 帧（level 固定 info，不抢审批的红色）', () => {
    expect(
      proactiveNoticeOf(
        {
          source: 'subscription',
          key: 'sub:s-1:2026-10',
          title: '视频会员 2 天后扣费 ¥30.00',
          channel: 'in-app',
          at: AT,
        },
        7,
        AT,
      ),
    ).toEqual({
      kind: 'notice',
      seq: 7,
      at: AT,
      level: 'info',
      title: '视频会员 2 天后扣费 ¥30.00',
    })
    expect(
      proactiveNoticeOf({ title: 'x', channel: 'im' }, 8, AT)?.kind,
    ).toBe('notice')
  })

  it('channel=none（被静默/日上限/去重压掉）→ 不产帧', () => {
    expect(
      proactiveNoticeOf(
        { title: 'x', channel: 'none', suppressedReason: 'quiet-hours' },
        9,
        AT,
      ),
    ).toBeUndefined()
  })

  it('坏载荷不抛错：缺 title / 空 title / 非对象 / 未知 channel 一律 undefined', () => {
    expect(proactiveNoticeOf(undefined, 1, AT)).toBeUndefined()
    expect(proactiveNoticeOf(null, 1, AT)).toBeUndefined()
    expect(proactiveNoticeOf('proactive', 1, AT)).toBeUndefined()
    expect(proactiveNoticeOf({ channel: 'in-app' }, 1, AT)).toBeUndefined()
    expect(proactiveNoticeOf({ channel: 'in-app', title: '' }, 1, AT)).toBeUndefined()
    expect(proactiveNoticeOf({ channel: 'sms', title: 'x' }, 1, AT)).toBeUndefined()
  })
})
