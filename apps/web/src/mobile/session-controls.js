/**
 * 会话控制条（04 单 §5）：人工接管入口/横幅，以及"回到上一步"分叉入口。
 *
 * 语义三条（与 docs/mobile.md 的诚实口径同文）：
 * 1. 接管期 `/api/turn` 202 落账但不驱动模型——本文件只负责**呈现**，闸在服务端；
 * 2. "回到上一步"= 在 turn 边界**分叉新会话**，旧会话原样封存；
 * 3. 接管状态在**进程内**，重启回 `active`（未接管）——横幅不宣称持久化。
 *
 * **不渲染"恢复"按钮**（2026-10-29 移动走查 P1-1）：`POST /api/handoff/resume` 是坐席凭证，
 * 移动渠道按部署纪律不配 `BAH_OPERATOR_TOKEN` ⇒ 该端点恒 404。把一个注定失败的按钮放在
 * 最显眼的位置，等于让用户点一次就得到"恢复失败：没有这个资源"。交回只能由坐席工作台完成，
 * 横幅只陈述这个事实。
 *
 * 端点走 `transport.js` 的 `createSessionControlClient`：token 与 CSRF 的读取面只许一处，
 * 移动壳里不出现第二份 fetch（门禁 I5/I10）。
 */

import { el } from '../dom.js'
import { formatWaited } from '../format.js'
import { createSessionControlClient } from '../transport.js'

/** 本地刷新接管摘要的间隔：坐席认领/等待时长由服务端权威值驱动，前端只负责显示。 */
export const HANDOFF_POLL_MS = 15_000

/** 端点客户端：与 `createHttpApi` 同源（token/CSRF 的读取面只许一处）。 */
export { createSessionControlClient } from '../transport.js'

/**
 * 造会话控制条。
 *
 * @param {HTMLElement} host 挂载点（composer 上方）
 * @param {{ client?: ReturnType<typeof createSessionControlClient>, onNotice?: (text: string, level?: 'info' | 'warning') => void, latestTurn?: () => number | undefined }} options
 */
export function createSessionControls(host, options) {
  const client = options.client ?? createSessionControlClient()
  const notify = options.onNotice ?? (() => undefined)

  const bar = el('div', { class: 'session-controls', dataset: { role: 'session-controls' } })
  const handoffButton = el('button', {
    type: 'button',
    class: 'ds-btn ds-btn--md session-controls__action',
    dataset: { role: 'handoff' },
    text: '转人工',
  })
  const forkButton = el('button', {
    type: 'button',
    class: 'ds-btn ds-btn--md session-controls__action',
    dataset: { role: 'fork' },
    text: '回到上一步',
  })
  const banner = el('div', {
    class: 'ds-alert ds-alert--warning session-controls__banner',
    dataset: { role: 'handoff-banner' },
    hidden: true,
  })

  bar.append(handoffButton, forkButton)
  banner.append(
    el('span', { class: 'ds-alert__title', text: '人工接管中，智能体暂停响应' }),
    el('span', {
      class: 'session-controls__hint',
      dataset: { role: 'handoff-hint' },
      text: '消息会被记录；交回会话请在坐席工作台操作。',
    }),
  )
  host.append(bar, banner)

  let active = false
  let summary = null
  let timer = null
  let polling = false

  /** 把服务端摘要翻译成一句人话（等待时长 / 是否已被认领 / 交回在哪做）。 */
  function renderBanner() {
    if (!active) return
    const hint = banner.querySelector('[data-role="handoff-hint"]')
    if (hint === null) return
    const parts = ['消息会被记录']
    const waitedMs = summary?.waitedMs
    if (typeof waitedMs === 'number' && waitedMs > 0) parts.push(`已等待 ${formatWaited(waitedMs)}`)
    if (summary?.claimed === true) {
      parts.push(typeof summary.operator === 'string' && summary.operator.length > 0 ? `坐席 ${summary.operator} 已认领` : '坐席已认领')
    } else {
      parts.push('等待坐席认领')
    }
    parts.push('交回会话请在坐席工作台操作。')
    hint.textContent = parts.join(' · ')
  }

  function startTimer() {
    if (timer !== null) return
    timer = setInterval(() => {
      void poll()
    }, HANDOFF_POLL_MS)
  }

  function stopTimer() {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  function applyActive(next, nextSummary) {
    active = next === true
    if (nextSummary !== undefined) summary = nextSummary
    if (!active) summary = null
    banner.hidden = !active
    handoffButton.hidden = active
    if (active) {
      renderBanner()
      startTimer()
      return
    }
    stopTimer()
  }

  function setActive(next) {
    applyActive(next, next === true ? summary : null)
  }

  /** 读一次服务端摘要（坐席认领 / 等待时长只在服务端账本里）。 */
  async function poll() {
    if (polling) return { ok: false, status: 0, code: 'poll-in-flight', reason: 'poll-in-flight' }
    polling = true
    const result = await client.handoffStatus()
    polling = false
    if (result.ok === true) {
      const data = result.data
      applyActive(data?.active === true, data === null || data === undefined ? undefined : data)
    }
    return result
  }

  handoffButton.addEventListener('click', async () => {
    const result = await client.handoff('用户在移动壳请求人工')
    if (!result.ok) {
      notify(`转人工失败：${result.reason}`, 'warning')
      return
    }
    applyActive(true, result.data)
    notify('已请求人工接管：智能体暂停响应；你的消息会被记录，人工处理期间不会驱动智能体')
  })

  forkButton.addEventListener('click', async () => {
    // 默认边界 = 最近一个已完成的 turn（turn/end 帧）；没有就不发请求（不猜 0）
    const turn = latestCompletedTurn()
    if (turn === undefined) {
      notify('还没有可回退的完整轮次', 'warning')
      return
    }
    const result = await client.fork(turn)
    if (!result.ok) {
      notify(`回退失败：${result.reason}`, 'warning')
      return
    }
    notify(`已从第 ${String(turn)} 步分叉，原会话保留可查（不会删除、不会改写）`)
  })

  /** 从已渲染帧里取最近一个 `turn/end`（数据来源见 options.latestTurn）。 */
  function latestCompletedTurn() {
    if (typeof options.latestTurn === 'function') return options.latestTurn()
    return undefined
  }

  return {
    element: bar,
    banner,
    setActive,
    /** 启动时同步一次接管状态（GET 只读，不消耗票据）。 */
    refresh: poll,
    dispose() {
      stopTimer()
      bar.remove()
      banner.remove()
    },
  }
}
