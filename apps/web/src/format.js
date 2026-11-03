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

/**
 * 服务端理由码 → 人话（封闭表）。
 *
 * 理由码是给审计与门禁看的，不是给用户看的。表里没有的码原样返回——
 * 宁可露出一个陌生码，也不编一个听起来像业务结论的中文。
 */
const REASON_LABELS = Object.freeze({
  'approval-unavailable': '审批无人应答',
  'approval-timeout': '审批超时未应答',
  'approval-rejected': '审批被拒绝',
  'approval-cancelled': '审批已取消',
  'approval-forbidden': '审批被拦截',
  'insufficient-funds': '余额不足',
  'sentry-degraded': '安全防护降级',
  'tool-args-invalid': '参数不合法',
  'tool-result-invalid': '结果不合规',
  'tool-failed': '工具执行失败',
  'network-error': '网络不通',
  'turn-rate-limited': '操作太频繁',
  'turn-conflict-handoff': '人工接管中',
})

/**
 * @param {unknown} code
 * @returns {string}
 */
export function reasonLabelOf(code) {
  const key = String(code ?? '')
  return REASON_LABELS[key] ?? key
}
