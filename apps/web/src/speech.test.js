import { describe, expect, it, vi } from 'vitest'

import { SPEECH_MAX_CHARS, SPEECH_TRUNCATED_NOTE, createSpeaker } from './speech.js'

function fakeWindow(overrides = {}) {
  const spoken = []
  const cancels = []
  const win = {
    SpeechSynthesisUtterance: class {
      constructor(text) {
        this.text = text
      }
    },
    speechSynthesis: {
      speak: (utterance) => spoken.push(utterance),
      cancel: () => cancels.push(1),
    },
    ...overrides,
  }
  return { win, spoken, cancels }
}

describe('语音播报', () => {
  it('不支持的环境（无 speechSynthesis）→ supported=false，入口由装配层隐藏', () => {
    const speaker = createSpeaker({})
    expect(speaker.supported).toBe(false)
    expect(speaker.speak('你好')).toBe(false)
    expect(speaker.setEnabled(true)).toBe(false)
  })

  it('关闭时不朗读；开启后设置中文、慢速与音高', () => {
    const { win, spoken } = fakeWindow()
    const speaker = createSpeaker(win)
    expect(speaker.speak('你好')).toBe(false)

    expect(speaker.setEnabled(true)).toBe(true)
    expect(speaker.speak('余额 100 元')).toBe(true)
    expect(spoken).toHaveLength(1)
    expect(spoken[0].text).toBe('余额 100 元')
    expect(spoken[0].lang).toBe('zh-CN')
    expect(spoken[0].rate).toBeLessThan(1)
    expect(spoken[0].pitch).toBe(1)
  })

  it('超长回答截断并明确提示只读前 600 字', () => {
    const { win, spoken } = fakeWindow()
    const speaker = createSpeaker(win)
    speaker.setEnabled(true)
    expect(speaker.speak('字'.repeat(SPEECH_MAX_CHARS + 50))).toBe(true)
    expect(spoken[0].text.startsWith('字'.repeat(SPEECH_MAX_CHARS))).toBe(true)
    expect(spoken[0].text).toContain(SPEECH_TRUNCATED_NOTE)
  })

  it('新一段朗读先取消上一段；dispose 关闭并停止', () => {
    const { win, cancels, spoken } = fakeWindow()
    const speaker = createSpeaker(win)
    speaker.setEnabled(true)
    speaker.speak('第一段')
    speaker.speak('第二段')
    expect(cancels.length).toBeGreaterThanOrEqual(1)
    expect(spoken).toHaveLength(2)

    speaker.dispose()
    expect(speaker.enabled).toBe(false)
    expect(speaker.speak('第三段')).toBe(false)
  })

  it('语音引擎抛错时不把异常带到发送路径', () => {
    const { win } = fakeWindow({
      SpeechSynthesisUtterance: class {
        constructor() {
          throw new Error('engine-down')
        }
      },
    })
    const speaker = createSpeaker(win)
    speaker.setEnabled(true)
    expect(speaker.speak('你好')).toBe(false)
  })
})
