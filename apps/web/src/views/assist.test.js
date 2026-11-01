import { describe, expect, it, vi } from 'vitest'

import {
  FEEDBACK_LOCAL_NOTE,
  QUICK_ACTIONS,
  SERVICE_SCOPE,
  answerFooterModel,
  renderAnswerFooter,
  renderAssistPanel,
  renderFeedbackRow,
  renderFollowUps,
  renderQuickActions,
  renderSafetyBanner,
  renderSafetyChip,
  renderServiceScope,
  suggestFollowUps,
} from './assist.js'

describe('assist · 安全提醒', () => {
  it('文案同时包含"不会索要密码"与"安全账户"，关闭钮回调一次', () => {
    const onDismiss = vi.fn()
    const node = renderSafetyBanner({ onDismiss })
    expect(node.textContent).toContain('不会索要密码')
    expect(node.textContent).toContain('安全账户')
    node.querySelector('[data-role="safety-dismiss"]').click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('assist · 顶栏安全提醒', () => {
  it('顶栏 chip 带全文 title、盾牌与收起钮', () => {
    const onDismiss = vi.fn()
    const node = renderSafetyChip({ onDismiss })
    expect(node.className).toContain('app-header__safety')
    expect(node.getAttribute('title')).toContain('不会索要密码')
    expect(node.textContent).toContain('安全提醒')
    expect(node.textContent).toContain('安全账户')
    node.querySelector('[data-role="safety-dismiss"]').click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})

describe('assist · 常用业务', () => {
  it('六项都带可发送原话；点击后等待期间整组禁用，完成恢复', async () => {
    let release
    const onPick = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const node = renderQuickActions({ onPick })
    const buttons = [...node.querySelectorAll('[data-role="quick-action"]')]

    expect(buttons).toHaveLength(QUICK_ACTIONS.length)
    expect(buttons.map((button) => button.textContent)).toEqual(
      expect.arrayContaining(['查余额账户与可用额度', '转账汇款收款人 + 金额']),
    )

    buttons[0].click()
    expect(onPick).toHaveBeenCalledWith(QUICK_ACTIONS[0].text)
    expect(buttons.every((button) => button.disabled)).toBe(true)

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(buttons.every((button) => button.disabled === false)).toBe(true)
  })
})

describe('assist · 服务范围与免责', () => {
  it('把暂未开放的能力写明，并给出强验证与官方口径', () => {
    const node = renderServiceScope()
    expect(node.textContent).toContain('信用卡还款')
    expect(node.textContent).toContain('账单分期')
    expect(node.textContent).toContain('利率查询')
    expect(node.textContent).toContain('人脸 / 短信 / U 盾')
    expect(node.textContent).toContain('不构成合同')
    expect(SERVICE_SCOPE.limits).toContain('不能替你跳过验证')
  })
})

describe('assist · 反馈', () => {
  it('点赞后写明"仅本机"；再点同一结论取消', () => {
    let value = null
    const onRate = vi.fn((next) => {
      value = value === next ? null : next
      return value
    })
    const node = renderFeedbackRow({ onRate })
    const up = node.querySelector('[data-role="feedback-up"]')
    const note = node.querySelector('[data-role="feedback-note"]')

    up.click()
    expect(onRate).toHaveBeenCalledWith('up')
    expect(up.getAttribute('aria-pressed')).toBe('true')
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe(FEEDBACK_LOCAL_NOTE)

    up.click()
    expect(up.getAttribute('aria-pressed')).toBe('false')
    expect(note.hidden).toBe(true)
  })
})

describe('assist · 服务面板', () => {
  it('不支持语音时不渲染播报开关；大字开关把下一次状态交给回调', () => {
    const onToggleFont = vi.fn(() => true)
    const node = renderAssistPanel({
      fontLarge: false,
      speechSupported: false,
      onToggleFont,
    })
    expect(node.querySelector('[data-role="toggle-speech"]')).toBeNull()

    const font = node.querySelector('[data-role="toggle-font"]')
    expect(font.getAttribute('aria-pressed')).toBe('false')
    font.click()
    expect(onToggleFont).toHaveBeenCalledTimes(1)
    expect(font.getAttribute('aria-pressed')).toBe('true')
    expect(font.textContent).toContain('已开启')
  })
})

/** 造一条消息帧。 */
function message(seq, role, text, extra = {}) {
  return { kind: 'message', seq, at: seq, role, blocks: [{ type: 'text', text }], ...extra }
}

describe('assist · 答后快捷追问', () => {
  it('按最近一轮内容选域：理财给持仓/在售，转账给余额/账单', () => {
    expect(
      suggestFollowUps([message(1, 'user', '看看理财产品'), message(2, 'assistant', '在售产品如下：稳盈90天……')]),
    ).toEqual(['看看我的理财持仓', '看看在售的理财产品'])

    expect(
      suggestFollowUps([
        message(1, 'user', '给王建国转 800 元'),
        message(2, 'assistant', '已为你在模拟环境完成 800 元转账。', {
          toolCalls: [{ callId: 'c1', name: 'transfer_create' }],
        }),
      ]),
    ).toEqual(['查一下我的余额', '分析一下我这个月的账单'])
  })

  it('助手最后一句在提问时，两条按钮直接回答它（需要 / 不用）', () => {
    const items = suggestFollowUps([
      message(1, 'user', '看看理财产品'),
      message(2, 'assistant', '您持有的稳盈 90 天正是其中之一。需要我把 w-1 和 w-2 放在一起详细比较一下吗？'),
    ])
    expect(items).toEqual(['需要，把 w-1 和 w-2 放在一起详细比较一下', '不用了，先看看别的'])
  })

  it('账单口径提问只取第一个动作分句，不把解释塞进按钮', () => {
    const items = suggestFollowUps([
      message(1, 'user', '分析一下我这个月的账单'),
      message(2, 'assistant', '本月是空的。要不要我按「近三个月」口径重新分析一次，这样能把 10 月的支出一起算进去？'),
    ])
    expect(items[0]).toBe('需要，按「近三个月」口径重新分析一次')
    expect(items[0]).not.toContain('这样能')
  })

  it('开放问题（"您看哪个？"）没有明确动作时不硬编选项，退回业务域追问', () => {
    const items = suggestFollowUps([
      message(1, 'user', '看看理财产品'),
      message(2, 'assistant', '在售产品有稳盈 90 天等。您看哪个？'),
    ])
    expect(items).toEqual(['看看我的理财持仓', '看看在售的理财产品'])
  })

  it('运行时上下文里的"订阅/扣款"不把余额回答带偏', () => {
    const items = suggestFollowUps([
      message(1, 'user', '查一下我的余额'),
      message(2, 'user', '【当前用户】张三【即将扣款】视频会员 5 天后 ¥30.00', { source: 'runtime-context' }),
      message(3, 'assistant', '账户尾号 1234：余额 ¥12,345.67，可用 ¥12,345.67。'), // 账户尾号不是"卡片"域

    ])
    expect(items).toEqual(['分析一下我这个月的账单', '看看在售的理财产品'])
  })

  it('没有命中域时给两条安全的只读追问，且去重、不与用户原话重复', () => {
    const items = suggestFollowUps([message(1, 'assistant', '您好，我是智能助手。')])
    expect(items).toHaveLength(2)
    expect(new Set(items).size).toBe(2)
    expect(suggestFollowUps([message(1, 'user', '查一下我的余额')])).not.toContain('查一下我的余额')
  })

  it('只认最后一条带正文的助手消息；运行中 / 流式中 / 接管中 / 待选卡都不出', () => {
    const frames = [message(1, 'user', '查余额'), message(2, 'assistant', '余额 100 元')]
    expect(answerFooterModel(frames)?.frame.seq).toBe(2)
    expect(answerFooterModel(frames, { running: true })).toBeNull()
    expect(answerFooterModel(frames, { streamText: '正在生成' })).toBeNull()
    expect(answerFooterModel(frames, { handoffActive: true })).toBeNull()
    expect(answerFooterModel([...frames, { kind: 'choice', seq: 3, callId: 'ask', prompt: '要转给谁？', options: [] }])).toBeNull()
    // 用户刚说完、助手还没答：不拿上一条旧回答收口
    expect(answerFooterModel([message(1, 'assistant', '旧回答'), message(2, 'user', '新问题')])).toBeNull()
  })
})

describe('assist · 答后收口块', () => {
  it('唯一反馈行 + 两条可点追问；点击后等待期间禁用，完成恢复', async () => {
    let release
    const onPick = vi.fn(() => new Promise((resolve) => { release = resolve }))
    const node = renderAnswerFooter({
      suggestions: ['查一下我的余额', '分析一下我这个月的账单'],
      onPick,
    })

    expect(node.querySelectorAll('[data-role="feedback"]')).toHaveLength(1)
    const buttons = [...node.querySelectorAll('[data-role="follow-up"]')]
    expect(buttons.map((button) => button.textContent)).toEqual([
      '查一下我的余额',
      '分析一下我这个月的账单',
    ])

    buttons[0].click()
    expect(onPick).toHaveBeenCalledWith('查一下我的余额')
    expect(buttons.every((button) => button.disabled)).toBe(true)

    release()
    await Promise.resolve()
    await Promise.resolve()
    expect(buttons.every((button) => button.disabled === false)).toBe(true)
  })

  it('追问为空时不渲染空按钮', () => {
    const node = renderFollowUps({ items: [] })
    expect(node.querySelectorAll('button')).toHaveLength(0)
    expect(node.textContent).toContain('接着问')
  })
})
