/**
 * 坐席凭证闸（B2 / D11）。
 *
 * 三条硬约束：
 * 1. 坐席 token **只存 sessionStorage**（关标签即失效，不跨标签共享），
 *    不进 localStorage、不进 URL、不进 cookie；
 * 2. 服务端**不注入**坐席 token（`/operator` 是原样 HTML），首次必然要求手输；
 * 3. `sessionStorage` 在隐私模式 / 沙箱 iframe 里可能抛 `SecurityError`——
 *    此时用模块级内存变量兜底，否则坐席会陷入"输入了 token 但页面一直要求重输"。
 */

/** sessionStorage 键名（只此一处）。 */
export const OPERATOR_TOKEN_KEY = 'bah-operator-token'

/** 取浏览器 sessionStorage；不存在（非浏览器）时返回 null。 */
function defaultStorage() {
  if (typeof globalThis.sessionStorage === 'undefined') return null
  return globalThis.sessionStorage
}

/**
 * 造一个凭证闸（注入 storage 便于单测模拟"抛 SecurityError"）。
 *
 * @param {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void } | null} [storage]
 */
export function createGate(storage = defaultStorage()) {
  /** 存不住时的内存兜底（模块级，刷新即失效——与 sessionStorage 的语义一致）。 */
  let memory = ''
  let broken = false

  function readToken() {
    if (storage === null || broken) return memory
    try {
      const value = storage.getItem(OPERATOR_TOKEN_KEY)
      if (value !== null && value !== '') {
        memory = value
        return value
      }
      return memory
    } catch {
      broken = true
      return memory
    }
  }

  /**
   * 保存 token。
   *
   * @returns `true` = 已持久化；`false` = 只能放内存（调用方应提示"刷新后需重输"）
   */
  function saveToken(token) {
    memory = token
    if (storage === null) {
      broken = true
      return false
    }
    try {
      storage.setItem(OPERATOR_TOKEN_KEY, token)
      return true
    } catch {
      broken = true
      return false
    }
  }

  function clearToken() {
    memory = ''
    if (storage === null) return
    try {
      storage.removeItem(OPERATOR_TOKEN_KEY)
    } catch {
      broken = true
    }
  }

  /** 当前浏览器是否无法持久化凭证。 */
  function storageBroken() {
    return broken
  }

  return { readToken, saveToken, clearToken, storageBroken }
}

/** 浏览器默认实例（测试从 `createGate(fakeStorage)` 造）。 */
export const gate = createGate()
