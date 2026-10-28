/**
 * 展示格式化（纯函数，无 DOM、无状态）。
 *
 * 放在独立文件而不是塞进 `main.js`：计时文本要被客户页横幅与坐席台共用，
 * 而 `formatWaited` 的边界（负数 / NaN / 超过一小时）必须有单测钉住。
 */

/**
 * 毫秒 → `m:ss`，一小时以上 → `h:mm:ss`。
 *
 * 负数 / `NaN` / 非数字一律按 0 处理：客户端时钟回拨时不能显示 `-0:01`。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatWaited(ms) {
  const safe = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0
  const total = Math.floor(safe / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${String(hours)}:${pad(minutes)}:${pad(seconds)}` : `${String(minutes)}:${pad(seconds)}`
}
