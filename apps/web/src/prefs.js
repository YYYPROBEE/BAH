/**
 * 页面级偏好（大字、播报开关、安全提示是否已收起、逐条反馈）。
 *
 * 只存用户自己的界面选择，不存任何业务数据：
 * - 读写全部走 try/catch：Safari 隐私模式与禁用存储的 WebView 会直接抛错；
 * - 反馈键含会话号与消息序号，换会话不会串账；
 * - 存储内容可损坏，读回时一律按空表处理（坏的偏好不该让页面打不开）。
 */

/** 存储键（唯一落点，测试与门禁都读这里）。 */
export const PREF_KEYS = Object.freeze({
  fontScale: 'bah-ui-font-scale',
  speech: 'bah-ui-speech',
  safetyDismissed: 'bah-ui-safety-dismissed',
  feedback: 'bah-ui-feedback',
})

/** 大字模式的根属性（CSS 只认这个属性，不认存储键）。 */
export const FONT_ATTR = 'data-bah-font'

/**
 * 造偏好读写器。
 *
 * @param {Storage | undefined} storage 缺省用 `globalThis.localStorage`；测试可注入内存实现
 */
export function createPrefs(storage) {
  let store = storage
  if (store === undefined && typeof globalThis.localStorage !== 'undefined') {
    store = globalThis.localStorage
  }

  function get(key) {
    try {
      return store?.getItem(key) ?? null
    } catch {
      return null
    }
  }

  function set(key, value) {
    try {
      store?.setItem(key, String(value))
    } catch {
      // 存不进去只影响下一次打开的默认值，不影响本次使用
    }
  }

  function remove(key) {
    try {
      store?.removeItem(key)
    } catch {
      // 同上
    }
  }

  function getJson(key, fallback) {
    const raw = get(key)
    if (raw === null || raw === '') return fallback
    try {
      const parsed = JSON.parse(raw)
      return parsed === null || typeof parsed !== 'object' ? fallback : parsed
    } catch {
      return fallback
    }
  }

  function setJson(key, value) {
    try {
      store?.setItem(key, JSON.stringify(value))
    } catch {
      // 同上
    }
  }

  return { get, set, remove, getJson, setJson }
}

/** 当前是否大字模式。 */
export function isLargeFont(prefs) {
  return prefs.get(PREF_KEYS.fontScale) === 'large'
}

/**
 * 把大字模式写到根元素上。
 *
 * 用属性而不是行内样式：CSP 只放行同源样式，行内 `style` 在这里没有必要，
 * 而且属性可以被 CSS 的 `[hidden]`、打印样式等规则一起覆盖。
 *
 * @param {Document} doc
 * @param {'normal'|'large'} scale
 */
export function applyFontScale(doc, scale) {
  const root = doc?.documentElement
  if (root === undefined || root === null) return
  if (scale === 'large') root.setAttribute(FONT_ATTR, 'large')
  else root.removeAttribute(FONT_ATTR)
}

/**
 * 逐条反馈（👍/👎）。
 *
 * 当前没有服务端反馈端点：数据只落本机存储，界面必须如实标注“仅本机”。
 * 上限 500 条，超出按写入顺序淘汰，防止 localStorage 被无限撑大。
 *
 * @param {ReturnType<typeof createPrefs>} prefs
 * @param {number} [maxEntries]
 */
export function createFeedbackStore(prefs, maxEntries = 500) {
  const all = prefs.getJson(PREF_KEYS.feedback, {})

  function save() {
    const keys = Object.keys(all)
    if (keys.length > maxEntries) {
      for (const key of keys.slice(0, keys.length - maxEntries)) delete all[key]
    }
    prefs.setJson(PREF_KEYS.feedback, all)
  }

  return {
    get(key) {
      const value = all[key]
      return value === 'up' || value === 'down' ? value : null
    },
    /** 再点一次同一结论 = 取消；返回落库后的值（`null` 表示已取消）。 */
    rate(key, value) {
      const next = all[key] === value ? null : value
      if (next === null) delete all[key]
      else all[key] = next
      save()
      return next
    },
  }
}

/**
 * 反馈键：会话号 + 消息序号。
 *
 * `seq` 只在会话内唯一，跨会话会撞；会话号缺失（尚未拿到快照）时用 `local`，
 * 这时最多影响本机演示，不会把 A 客户的评价记到 B 客户头上。
 */
export function feedbackKeyOf(sessionId, seq) {
  return `${typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'local'}:${String(seq)}`
}
