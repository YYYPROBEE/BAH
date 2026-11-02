/**
 * 滑动确认条。
 *
 * ── D11 三句话（对外材料同源，逐字；TC-MOB-15 用 readFileSync 钉住它们存在） ──
 * 1. 手势确认不等于强验证；红级操作仍需 U 盾/人脸/短信挑战（走 /api/verify/:ticketId）。
 * 2. 用脚本直接 POST /api/approval/:ticketId 而不滑动，服务端会接受——滑动是 UI 约束，不是凭证。
 * 3. 因此"手势"不得出现在任何安全评审的"控制项"里，只能出现在"人机工程/防误触"里。
 *
 * ⚠ 2026-10-29 实现期实测补充（**收紧**第 1 句的口径，不是放宽）：
 * `packages/channels/src/http-adapter.ts` 的 `decide()` 只校验票据归属、结论合法性、
 * 拒绝理由必填与长度——**完全不校验 `verify()` 是否已通过**。所以"红级必须先强验证"
 * 与滑动确认同档，也是 **UI 约束**（桌面壳 `views/approval.js` 同样只在界面层拦）。
 * 对外材料因此不得把强验证写成服务端防线；这条已登记进 02-construction.md 与复审报告 C1。
 * 修它要动 `packages/**`（本设计禁改面），归后续单独立项。
 *
 * ── 分层 ──
 * DOM 层只做"事件 → PointerSample[]"的翻译，**决策全在 `reducePointerEvents` 纯函数**里。
 * 这样 jsdom 没有 PointerEvent 构造器也能覆盖全路径（TC-MOB-09..12 直接喂样本），
 * 也保证"界面上跑的那套判定"与"测试里断言的那套判定"是同一份代码，不会各写一遍然后漂。
 */

import { el } from '../dom.js'

/**
 * 缺省值表（与后端 `DEFAULT_*` 同款形态）：阈值与长按时长都是**可调参数**而不是散落字面量，
 * 调用方可覆盖，门禁 `verify-no-hardcoded-config` 的豁免形态也是"缺省值表"。
 */
export const GESTURE_DEFAULTS = Object.freeze({
  /** 到位阈值：滑块行程的 85%。留 15% 是给"手指还没停稳"的余量，防过冲误批。 */
  thresholdRatio: 0.85,
  /** 键盘等价的长按时长（ms）。 */
  holdMs: 600,
})

/**
 * @typedef {{ type: 'down'|'move'|'up'|'cancel', x: number, t: number }} PointerSample
 * `t` 由 DOM 层如实记录（走查证据可复盘"这一滑用了多久"），但**决策不看它**：
 * 判定只依赖位置，纯函数因此不碰时钟 ⇒ 同一串样本永远得到同一个结论。
 */

/**
 * @typedef {{ thresholdRatio: number, trackWidthPx: number }} GestureConfig
 * @typedef {{ outcome: 'none'|'reached'|'confirmed'|'aborted', progress: number, releasedAtReached: boolean }} GestureResult
 */

/** 夹到 0..1。 */
function clamp01(value) {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * pointer 样本序列 → 决策（纯函数：无 DOM、无时钟、无随机）。
 *
 * 关键口径是**以 `up` 时刻的进度为准**（TC-MOB-11）：滑到 95% 又回拉到 50% 再松手 = 取消。
 * "曾经到过阈值"不构成确认——否则手指在阈值附近抖一下就成了批准，银行语境下这个代价不对称。
 *
 * @param {readonly PointerSample[]} samples
 * @param {GestureConfig} config
 * @returns {GestureResult}
 */
export function reducePointerEvents(samples, config) {
  const threshold = config.thresholdRatio
  // 轨道宽为 0（元素还没布局 / jsdom 无 CSS）时不让它变成除零：一律判"没动"
  const travel = config.trackWidthPx > 0 ? config.trackWidthPx : Number.POSITIVE_INFINITY
  /** 当前手势的起点 x；null = 没有进行中的手势。 */
  let origin = null
  let progress = 0
  let outcome = 'none'
  let releasedAtReached = false

  for (const sample of samples) {
    switch (sample.type) {
      case 'down':
        // 第二次 down（双击 / 多指）覆盖起点：以最后一次按下为准，不累积旧进度
        origin = sample.x
        progress = 0
        outcome = 'none'
        releasedAtReached = false
        break
      case 'move':
        if (origin === null) break
        progress = clamp01((sample.x - origin) / travel)
        outcome = progress >= threshold ? 'reached' : 'none'
        break
      case 'up':
        if (origin === null) break
        releasedAtReached = progress >= threshold
        outcome = releasedAtReached ? 'confirmed' : 'aborted'
        // 半途松手归位：进度归零，界面上滑块滑回去（≤200ms，00 §5.8）
        if (!releasedAtReached) progress = 0
        origin = null
        break
      case 'cancel':
        // 系统手势 / 来电 / 浏览器抢走指针：与半途松手同档，一律 aborted（TC-MOB-12）
        if (origin === null) break
        outcome = 'aborted'
        progress = 0
        releasedAtReached = false
        origin = null
        break
      default:
        break
    }
  }

  return { outcome, progress, releasedAtReached }
}

/** 播报档位：0/25/50/75/100（TC-MOB-14 的节流判据）。 */
const BUCKETS = [0, 25, 50, 75, 100]

/** progress → 最近档位。 */
function bucketOf(progress) {
  const percent = Math.round(progress * 100)
  let best = BUCKETS[0]
  for (const bucket of BUCKETS) {
    if (Math.abs(bucket - percent) < Math.abs(best - percent)) best = bucket
  }
  return best
}

/**
 * 造滑动确认条。
 *
 * @param {HTMLElement} host 挂载点（抽屉的 `data-role="gesture"` 容器）
 * @param {object} opts
 * @param {() => void} opts.onConfirm 仅 `outcome === 'confirmed'` 时恰一次
 * @param {() => void} [opts.onAbort] 半途松手 / cancel：归位，**零 decision**
 * @param {number} [opts.thresholdRatio] 覆盖缺省阈值
 * @param {number} [opts.holdMs] 覆盖键盘长按时长
 * @param {{ trackWidth?: () => number }} [opts.deps] 测试注入轨道宽（jsdom 无 CSS 布局）
 * @returns {{ reset(): void, destroy(): void, el: HTMLElement, thumb: HTMLElement,
 *             confirmButton: HTMLElement, live: HTMLElement, get state(): string }}
 */
export function createGestureConfirm(host, opts) {
  const thresholdRatio = opts.thresholdRatio ?? GESTURE_DEFAULTS.thresholdRatio
  const holdMs = opts.holdMs ?? GESTURE_DEFAULTS.holdMs
  /** 只用于给样本盖时间戳（走查证据可复盘）；**决策不读它**，所以换成假时钟也不改判定。 */
  const clock = opts.deps?.clock ?? (() => Date.now())

  const label = el('span', { class: 'm-gesture-label', text: '滑动以确认' })
  const thumb = el('div', {
    class: 'm-gesture-thumb',
    role: 'button',
    tabindex: '0',
    dataset: { role: 'thumb', dragging: 'false', holding: 'false' },
    'aria-label': '滑动确认：按住滑块拖动到最右侧；或聚焦后长按回车 600 毫秒',
  }, [el('span', { class: 'icon icon--check', 'aria-hidden': 'true' })])
  const track = el('div', { class: 'm-gesture-track' }, [label, thumb])

  const confirmButton = el('button', {
    class: 'ds-btn ds-btn--primary ds-btn--lg m-gesture-confirm',
    type: 'button',
    dataset: { role: 'kb-confirm' },
    disabled: true,
    'aria-label': '确认操作',
    text: '确认',
  })
  const live = el('p', { class: 'm-gesture-live', 'aria-live': 'polite', dataset: { role: 'live' } })
  const note = el('p', {
    class: 'm-gesture__note',
    text: '滑动确认只防误触，不是身份验证；红级操作仍需完成强验证。',
  })
  const node = el('div', { class: 'm-gesture', dataset: { role: 'gesture-root' } }, [
    el('div', { class: 'm-gesture__row' }, [track, confirmButton]),
    live,
    note,
  ])
  host.append(node)

  /** @type {PointerSample[]} */
  let samples = []
  /** 本次手势是否已给过结论（保证 onConfirm 恰一次）。 */
  let settled = false
  let dragging = false
  let holdTimer = null
  let state = 'idle'
  let lastBucket = null
  let travelPx = 0

  /** 轨道行程 = 轨道宽 − 滑块宽。用整个轨道宽会让手指必须移出轨道才算到位（§3.5）。 */
  function measureTravel() {
    if (opts.deps?.trackWidth !== undefined) return Math.max(1, opts.deps.trackWidth())
    const trackRect = track.getBoundingClientRect()
    const thumbRect = thumb.getBoundingClientRect()
    return Math.max(1, Math.round(trackRect.width - thumbRect.width))
  }

  /** 写滑块位移：CSSOM（`style.setProperty`），不是 style 属性 ⇒ CSP `style-src 'self'` 不管它（C5）。 */
  function paint(progress) {
    thumb.style.setProperty('--thumb-x', `${String(Math.round(progress * travelPx))}px`)
    thumb.style.setProperty('--thumb-travel', `${String(travelPx)}px`)
  }

  /** 播报节流：同文本不重写；档位与事件句共用一个出口（TC-MOB-14 ≤8 次）。 */
  function announce(text) {
    if (live.textContent === text) return
    live.textContent = text
  }

  /** 当前决策（唯一出口：DOM 层任何地方都不自己判阈值）。 */
  function current() {
    return reducePointerEvents(samples, { thresholdRatio, trackWidthPx: travelPx })
  }

  function applyResult(result) {
    paint(result.outcome === 'aborted' ? 0 : result.progress)
    node.classList.toggle('m-gesture--reached', result.outcome === 'reached')
    // 路径 B：轨道旁的显式确认按钮，**到位后才可用**（常态可见是读屏可发现性要求）
    confirmButton.disabled = result.outcome !== 'reached'
    state = result.outcome === 'none' && dragging ? 'dragging' : result.outcome
  }

  function settle(outcome) {
    if (settled) return
    settled = true
    dragging = false
    thumb.dataset.dragging = 'false'
    thumb.dataset.holding = 'false'
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    if (outcome === 'confirmed') {
      state = 'confirmed'
      travelPx = travelPx > 0 ? travelPx : measureTravel()
      node.classList.add('m-gesture--reached')
      paint(1)
      confirmButton.disabled = true
      announce('已确认')
      opts.onConfirm()
      return
    }
    state = 'aborted'
    node.classList.remove('m-gesture--reached')
    // 归位：data-dragging 摘掉后 CSS 的 200ms transform 过渡接管（≤200ms，00 §5.8）
    paint(0)
    confirmButton.disabled = true
    announce('已取消，未确认')
    opts.onAbort?.()
  }

  /** 累积一个样本并重算决策（DOM 层不自己判阈值）。 */
  function push(sample) {
    samples.push(sample)
    applyResult(current())
  }

  function onPointerDown(event) {
    // 上一轮已出结论的手势自动复位：抽屉可能在同一节点上连开两张票据
    if (settled) reset()
    travelPx = measureTravel()
    dragging = true
    settled = false
    thumb.dataset.dragging = 'true'
    announce('滑动以确认')
    lastBucket = null
    push({ type: 'down', x: event.clientX ?? 0, t: clock() })
    // 移出元素仍收事件（否则手指滑出轨道就永远等不到 up，卡在 dragging）
    thumb.setPointerCapture?.(event.pointerId)
  }

  function onPointerMove(event) {
    if (!dragging) return
    const before = current().outcome
    push({ type: 'move', x: event.clientX ?? 0, t: clock() })
    const result = current()
    // 跨阈值的事件句优先于档位播报：两者同一时刻只需说一句。
    // 到位之后也不再播报档位——"已到位"就是最后一句有用的话，继续报 90%/95%/100%
    // 只会把读屏用户的队列塞满（TC-MOB-14 的 ≤8 次靠这两条守住，实测 7 次）。
    if (before !== 'reached' && result.outcome === 'reached') announce('已到位，松手确认')
    else if (result.outcome !== 'reached') {
      const bucket = bucketOf(result.progress)
      if (bucket !== lastBucket) {
        lastBucket = bucket
        announce(`进度 ${String(bucket)}%`)
      }
    }
  }

  function onPointerUp(event) {
    if (!dragging) return
    push({ type: 'up', x: event.clientX ?? 0, t: clock() })
    const outcome = current().outcome
    settle(outcome === 'confirmed' ? 'confirmed' : 'aborted')
  }

  function onPointerCancel() {
    if (!dragging) return
    push({ type: 'cancel', x: 0, t: clock() })
    settle('aborted')
  }

  // ── 键盘等价（00 §5.9：手势必须有键盘等价路径）──────────────────────────
  // 路径 A：长按 Enter/Space ≥ holdMs ⇒ confirmed；提前松开 ⇒ aborted（与"半途松手"同档）。
  // 路径 B：到位后 `confirmButton` 可用，点一下即 confirmed（不能长按的用户的出路）。
  function onKeyDown(event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    // 按住不放会重复派发 keydown：只在第一次起表，否则长按会被重置成"永远到不了 600ms"
    if (event.repeat || holdTimer !== null) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    if (settled) reset()
    settled = false
    dragging = false
    thumb.dataset.holding = 'true'
    announce('按住不放以确认')
    holdTimer = setTimeout(() => {
      holdTimer = null
      settle('confirmed')
    }, holdMs)
  }

  function onKeyUp(event) {
    if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return
    if (holdTimer === null) return
    event.preventDefault()
    settle('aborted')
  }

  function onConfirmClick() {
    if (confirmButton.disabled) return
    settle('confirmed')
  }

  thumb.addEventListener('pointerdown', onPointerDown)
  thumb.addEventListener('pointermove', onPointerMove)
  thumb.addEventListener('pointerup', onPointerUp)
  thumb.addEventListener('pointercancel', onPointerCancel)
  thumb.addEventListener('keydown', onKeyDown)
  thumb.addEventListener('keyup', onKeyUp)
  confirmButton.addEventListener('click', onConfirmClick)

  /** 回到初始态（下一张票据复用同一节点）。 */
  function reset() {
    samples = []
    settled = false
    dragging = false
    lastBucket = null
    state = 'idle'
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
    thumb.dataset.dragging = 'false'
    thumb.dataset.holding = 'false'
    node.classList.remove('m-gesture--reached')
    confirmButton.disabled = true
    paint(0)
    announce('')
  }

  reset()

  return {
    reset,
    destroy() {
      if (holdTimer !== null) clearTimeout(holdTimer)
      thumb.removeEventListener('pointerdown', onPointerDown)
      thumb.removeEventListener('pointermove', onPointerMove)
      thumb.removeEventListener('pointerup', onPointerUp)
      thumb.removeEventListener('pointercancel', onPointerCancel)
      thumb.removeEventListener('keydown', onKeyDown)
      thumb.removeEventListener('keyup', onKeyUp)
      confirmButton.removeEventListener('click', onConfirmClick)
      node.remove()
    },
    el: node,
    thumb,
    confirmButton,
    live,
    get state() {
      return state
    },
  }
}
