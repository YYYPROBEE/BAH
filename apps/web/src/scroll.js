/**
 * 会话流贴底跟随（桌面与移动共用）。
 *
 * 只回答一个问题：用户现在是不是停在底部附近。是就继续跟新消息，
 * 不是（正在上翻读历史）就不抢滚动。发送动作由装配层显式调用 `scrollToBottom`。
 */

/** 距底部多少像素以内算"仍在跟"（移动端拇指回弹通常会多出十几像素）。 */
export const STICK_THRESHOLD_PX = 64

/**
 * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number } | null | undefined} node
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isNearBottom(node, threshold = STICK_THRESHOLD_PX) {
  if (node === null || node === undefined) return true
  const scrollHeight = Number(node.scrollHeight ?? 0)
  const clientHeight = Number(node.clientHeight ?? 0)
  // 内容不足一屏时不存在"离开底部"，一律视为在底部。
  if (scrollHeight <= clientHeight) return true
  return scrollHeight - Number(node.scrollTop ?? 0) - clientHeight <= threshold
}

/** 滚到底（同步；调用方已决定要跟）。 */
export function scrollToBottom(node) {
  if (node === null || node === undefined) return
  const style = node.style
  const previous = style?.scrollBehavior
  // 桌面会话流声明了 `scroll-behavior: smooth`：程序化贴底会变成一段动画，
  // 动画途中的 scroll 事件会被 isNearBottom 判成"用户已上翻"，后续新消息就不再跟随。
  // 贴底必须是瞬时的；用户手势滚动仍走 CSS 的 smooth。
  if (style !== undefined && style !== null) style.scrollBehavior = 'auto'
  // `instant` 同时会取消可能仍在跑的 CSS smooth 动画；只写 scrollTop 时，
  // 上一段"滚到顶部"的平滑动画可能继续抢走滚动位置。
  if (typeof node.scrollTo === 'function') {
    try {
      node.scrollTo({ top: node.scrollHeight, left: 0, behavior: 'instant' })
    } catch {
      // 旧内核或测试桩不认 ScrollToOptions：下面直接写 scrollTop。
    }
  }
  node.scrollTop = node.scrollHeight
  if (style !== undefined && style !== null) style.scrollBehavior = previous ?? ''
}
