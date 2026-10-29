/**
 * 桌面渠道薄工厂的用例（桌面端 01 §5 T-DTB-CH-001/002）。
 *
 * 只测"它是 desktop 且能力位是同一引用 + 与 Web 的差异恰为两项"：审批语义由
 * `http-adapter.test.ts` 覆盖，在这里重复一遍只会制造两份会漂的断言。
 *
 * ⚠ 本文件**不 import electron**：桌面渠道内核在 `@bah/channels`，与 Electron 无关
 * （桌面端 02 单的 R-DT-10 纪律）。
 */

import { describe, expect, it } from 'vitest'

import { CAPABILITIES_BY_CHANNEL, DESKTOP_CAPABILITIES, WEB_CAPABILITIES } from '../capabilities.ts'
import { DESKTOP_CHANNEL_ID, createDesktopChannelAdapter } from './adapter.ts'

describe('createDesktopChannelAdapter（T-DTB-CH-001）', () => {
  it('id 是 desktop', () => {
    expect(DESKTOP_CHANNEL_ID).toBe('desktop')
    expect(createDesktopChannelAdapter().id).toBe('desktop')
  })

  it('capabilities 与 DESKTOP_CAPABILITIES 是同一引用（不是深拷贝）', () => {
    expect(createDesktopChannelAdapter().capabilities).toBe(DESKTOP_CAPABILITIES)
  })

  it('能力位即 CAPABILITIES_BY_CHANNEL.desktop（单一真相源，不是本地字面量）', () => {
    expect(createDesktopChannelAdapter().capabilities).toBe(CAPABILITIES_BY_CHANNEL.desktop)
  })

  it('与 Web 的**实际**差异只有一项：gestureConfirm=true（voiceInput 在 web 上本就是 none）', () => {
    const desktop = createDesktopChannelAdapter().capabilities
    const differing = (Object.keys(WEB_CAPABILITIES) as (keyof typeof WEB_CAPABILITIES)[]).filter(
      (key) => WEB_CAPABILITIES[key] !== desktop[key],
    )
    // 01 §2.1 原写"差异两项（gestureConfirm + voiceInput）"，实测不成立：
    // `WEB_CAPABILITIES.voiceInput` 已经是 `'none'`，桌面端那一行是同值重复声明。
    // 断言按**事实**钉住：差异集恰为 {gestureConfirm}，并另行显式钉住 voiceInput 的取值，
    // 这样"哪天 Web 开了语音"会让本条立刻变红，而不是被"两项差异"的措辞掩盖。
    expect(differing).toEqual(['gestureConfirm'])
    expect(desktop.gestureConfirm).toBe(true)
    expect(desktop.voiceInput).toBe('none')
    expect(WEB_CAPABILITIES.voiceInput).toBe('none')
  })

  it('sessionId 原样透传：归属校验在桌面端同样生效（W04）', () => {
    const adapter = createDesktopChannelAdapter({ sessionId: 's-desktop' })
    const controller = new AbortController()
    adapter.attachApproval({
      ticketId: 'ticket:x',
      sessionId: 's-other',
      callId: 'call-x',
      name: 'transfer_create',
      signal: controller.signal,
      answer: () => ({ accepted: true }),
    })
    expect(adapter.decide('ticket:x', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'foreign-ticket',
    })
  })
})

describe('审批五法未分叉（T-DTB-CH-002）', () => {
  it('未登记的票据在桌面端同样是 unknown-ticket（与 web 同源实现）', () => {
    const adapter = createDesktopChannelAdapter({ sessionId: 's-desktop' })
    expect(adapter.decide('ticket:none', { decision: 'allowed-once' })).toMatchObject({
      ok: false,
      code: 'unknown-ticket',
    })
  })

  it('非法结论在桌面端同样是 invalid-decision（六码判定不分叉）', () => {
    const adapter = createDesktopChannelAdapter({ sessionId: 's-desktop' })
    const controller = new AbortController()
    adapter.attachApproval({
      ticketId: 'ticket:y',
      sessionId: 's-desktop',
      callId: 'call-y',
      name: 'transfer_create',
      signal: controller.signal,
      answer: () => ({ accepted: true }),
    })
    expect(adapter.decide('ticket:y', { decision: 'yes-please' })).toMatchObject({
      ok: false,
      code: 'invalid-decision',
    })
  })
})
