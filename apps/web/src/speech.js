/**
 * 语音播报（只读回复，不采集麦克风）。
 *
 * 与“语音输入”是两件事：输入走系统输入法听写（`ime-input.js`），本文件只把
 * 助手回复交给浏览器的 `speechSynthesis` 朗读——不申请媒体权限、不建立网络连接。
 * 不支持的环境（jsdom、部分 WebView）`supported` 为 false，入口直接不出现。
 */

/** 朗读语速与音高：银行场景宁慢勿快，读错一个数字的代价比多听两秒高。 */
const RATE = 0.95
const PITCH = 1

/** 单次朗读上限：超长回答整段朗读会让人等得以为卡死，截断后明确提示。 */
export const SPEECH_MAX_CHARS = 600

/** 截断文案（末尾保留“完整内容请查看屏幕”，不假装读完了）。 */
export const SPEECH_TRUNCATED_NOTE = '（内容较长，仅朗读前 600 字，完整内容请查看屏幕。）'

/**
 * 造播报器。
 *
 * @param {Window} [win]
 */
export function createSpeaker(win) {
  const synth = win?.speechSynthesis
  const Utterance = win?.SpeechSynthesisUtterance
  const supported = typeof synth?.speak === 'function' && typeof Utterance === 'function'
  let enabled = false

  function stop() {
    if (!supported) return
    try {
      synth.cancel()
    } catch {
      // 某些内核对空队列 cancel 会抛：播报失败不能影响发送
    }
  }

  return {
    supported,
    get enabled() {
      return enabled
    },
    setEnabled(next) {
      enabled = next === true && supported
      if (!enabled) stop()
      return enabled
    },
    /**
     * 朗读一段文本（仅在开启且支持时）。
     *
     * @param {string} text
     * @returns {boolean} 是否真的交给了语音引擎
     */
    speak(text) {
      if (!enabled || !supported) return false
      const raw = String(text ?? '').trim()
      if (raw.length === 0) return false
      const body = raw.length > SPEECH_MAX_CHARS ? `${raw.slice(0, SPEECH_MAX_CHARS)}${SPEECH_TRUNCATED_NOTE}` : raw
      stop()
      try {
        const utterance = new Utterance(body)
        utterance.lang = 'zh-CN'
        utterance.rate = RATE
        utterance.pitch = PITCH
        synth.speak(utterance)
        return true
      } catch {
        return false
      }
    },
    stop,
    dispose() {
      enabled = false
      stop()
    },
  }
}
