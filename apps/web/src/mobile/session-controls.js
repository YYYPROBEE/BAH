/**
 * 会话控制条（04 单 §5）：人工接管入口/横幅/恢复，以及"回到上一步"分叉入口。
 *
 * 语义三条（与 docs/mobile.md 的诚实口径同文）：
 * 1. 接管期 `/api/turn` 一律 409——本文件只负责**呈现**，闸在服务端；
 * 2. "回到上一步"= 在 turn 边界**分叉新会话**，旧会话原样封存；
 * 3. 接管状态在**进程内**，重启回 `active`（未接管）——横幅不宣称持久化。
 *
 * 端点走 `transport.js` 的 `createSessionControlClient`：token 与 CSRF 的读取面只许一处，
 * 移动壳里不出现第二份 fetch（门禁 I5/I10）。
 */

import { el } from '../dom.js'
import { createSessionControlClient } from '../transport.js'

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
  const resumeButton = el('button', {
    type: 'button',
    class: 'ds-btn ds-btn--md ds-btn--primary',
    dataset: { role: 'handoff-resume' },
    text: '恢复',
  })

  bar.append(handoffButton, forkButton)
  banner.append(
    el('span', { class: 'ds-alert__title', text: '人工接管中，智能体暂停响应' }),
    resumeButton,
  )
  host.append(bar, banner)

  let active = false

  function setActive(next) {
    active = next === true
    banner.hidden = !active
    handoffButton.hidden = active
  }

  handoffButton.addEventListener('click', async () => {
    const result = await client.handoff('用户在移动壳请求人工')
    if (!result.ok) {
      notify(`转人工失败：${result.reason}`, 'warning')
      return
    }
    setActive(true)
    notify('已请求人工接管：智能体暂停响应，恢复前发送的消息会被拒绝（409）')
  })

  resumeButton.addEventListener('click', async () => {
    const result = await client.resume()
    if (!result.ok) {
      notify(`恢复失败：${result.reason}`, 'warning')
      return
    }
    setActive(false)
    notify('已交回会话：智能体恢复响应')
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
    async refresh() {
      const result = await client.handoffStatus()
      if (result.ok) setActive(result.data?.active === true)
      return result
    },
    dispose() {
      bar.remove()
      banner.remove()
    },
  }
}
