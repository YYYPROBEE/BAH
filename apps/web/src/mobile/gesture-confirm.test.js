/**
 * 滑动确认条用例（TC-MOB-09..15、TC-MOB-30 的手势半边）。
 *
 * 桩纪律（施工单 02 §5）：**决策全在 `reducePointerEvents` 纯函数**，所以大部分用例直接喂
 * `PointerSample[]`，不需要 PointerEvent 构造器（jsdom 没有）；DOM 层用
 * `new Event('pointerdown') + Object.assign(event, { clientX })` 补坐标。
 * 轨道宽经 `deps.trackWidth` 注入——jsdom 没有 CSS 布局，`getBoundingClientRect()` 全是 0。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GESTURE_DEFAULTS, createGestureConfirm, reducePointerEvents } from './gesture-confirm.js'

const CONFIG = { thresholdRatio: 0.85, trackWidthPx: 100 }
// `fileURLToPath(new URL(..., import.meta.url))` 在 jsdom 环境下会拿到非 file 协议的基址，
// 这里用 vitest 提供的 `import.meta.dirname`（与 scripts/gates.smoke.test.ts 同款手法）。
const SOURCE_FILE = join(import.meta.dirname, 'gesture-confirm.js')

/** 造一个 pointer 事件（jsdom 无 PointerEvent 构造器：Event 可扩属性）。 */
function pointer(type, x) {
  const event = new Event(type, { bubbles: true })
  Object.assign(event, { clientX: x, pointerId: 1 })
  return event
}

function key(type, init = {}) {
  return new KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true, ...init })
}

describe('reducePointerEvents（纯函数决策）', () => {
  it('TC-MOB-09 滑到 90% 松手 ⇒ confirmed，且 releasedAtReached 为真', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 90, t: 10 },
        { type: 'up', x: 90, t: 20 },
      ],
      CONFIG,
    )

    expect(result.outcome).toBe('confirmed')
    expect(result.releasedAtReached).toBe(true)
    expect(result.progress).toBeCloseTo(0.9, 5)
  })

  it('TC-MOB-09 到位即确认被否决：move 到 90% 但未松手只是 reached，不是 confirmed', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 90, t: 10 },
      ],
      CONFIG,
    )

    expect(result.outcome).toBe('reached')
    expect(result.releasedAtReached).toBe(false)
  })

  it('TC-MOB-10 滑到 60% 松手 ⇒ aborted、progress 归零', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 60, t: 10 },
        { type: 'up', x: 60, t: 20 },
      ],
      CONFIG,
    )

    expect(result.outcome).toBe('aborted')
    expect(result.progress).toBe(0)
    expect(result.releasedAtReached).toBe(false)
  })

  it('TC-MOB-11 到 95% 再回拉到 50% 松手 ⇒ aborted（以 up 时刻为准，"曾经到过"不算）', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 95, t: 10 },
        { type: 'move', x: 50, t: 20 },
        { type: 'up', x: 50, t: 30 },
      ],
      CONFIG,
    )

    expect(result.outcome).toBe('aborted')
    expect(result.releasedAtReached).toBe(false)
  })

  it('TC-MOB-12 pointercancel ⇒ aborted，包括"已 reached 之后被系统打断"', () => {
    const reached = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 99, t: 10 },
      ],
      CONFIG,
    )
    expect(reached.outcome).toBe('reached')

    const cancelled = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 99, t: 10 },
        { type: 'cancel', x: 99, t: 20 },
      ],
      CONFIG,
    )
    expect(cancelled.outcome).toBe('aborted')
    expect(cancelled.progress).toBe(0)
  })

  it('空样本与"没有 down 就 up"一律 none，不臆造结论', () => {
    expect(reducePointerEvents([], CONFIG)).toEqual({ outcome: 'none', progress: 0, releasedAtReached: false })
    expect(reducePointerEvents([{ type: 'up', x: 99, t: 0 }], CONFIG).outcome).toBe('none')
    expect(reducePointerEvents([{ type: 'move', x: 99, t: 0 }], CONFIG).outcome).toBe('none')
  })

  it('第二次 down 覆盖起点（双击 / 多指不累积旧进度）', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 99, t: 10 },
        { type: 'down', x: 99, t: 20 },
        { type: 'move', x: 100, t: 30 },
        { type: 'up', x: 100, t: 40 },
      ],
      CONFIG,
    )

    expect(result.outcome).toBe('aborted')
    expect(result.progress).toBe(0)
  })

  it('轨道宽为 0（元素未布局）不产生 NaN，判"没动"', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 0, t: 0 },
        { type: 'move', x: 999, t: 10 },
        { type: 'up', x: 999, t: 20 },
      ],
      { thresholdRatio: 0.85, trackWidthPx: 0 },
    )

    expect(result.outcome).toBe('aborted')
    expect(Number.isNaN(result.progress)).toBe(false)
  })

  it('反向拖动被夹到 0，不会出现负进度', () => {
    const result = reducePointerEvents(
      [
        { type: 'down', x: 50, t: 0 },
        { type: 'move', x: 0, t: 10 },
      ],
      CONFIG,
    )

    expect(result.progress).toBe(0)
  })
})

describe('createGestureConfirm（DOM 层与回调）', () => {
  let host
  let onConfirm
  let onAbort

  beforeEach(() => {
    vi.useFakeTimers()
    host = document.createElement('div')
    document.body.append(host)
    onConfirm = vi.fn()
    onAbort = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
    host.remove()
  })

  function mount(overrides = {}) {
    return createGestureConfirm(host, {
      onConfirm,
      onAbort,
      deps: { trackWidth: () => 100 },
      ...overrides,
    })
  }

  function drag(gesture, positions) {
    gesture.thumb.dispatchEvent(pointer('pointerdown', 0))
    for (const x of positions) gesture.thumb.dispatchEvent(pointer('pointermove', x))
  }

  it('TC-MOB-09 拖到 90% 松手 ⇒ onConfirm 恰一次、onAbort 零次', () => {
    const gesture = mount()
    drag(gesture, [30, 60, 90])
    gesture.thumb.dispatchEvent(pointer('pointerup', 90))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onAbort).toHaveBeenCalledTimes(0)
    expect(gesture.state).toBe('confirmed')
  })

  it('TC-MOB-09 同一次手势里重复 up 不会二次确认（onConfirm 恰一次）', () => {
    const gesture = mount()
    drag(gesture, [90])
    gesture.thumb.dispatchEvent(pointer('pointerup', 90))
    gesture.thumb.dispatchEvent(pointer('pointerup', 90))

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('TC-MOB-10 半途松手 ⇒ onAbort 恰一次、onConfirm 零次、滑块归位', () => {
    const gesture = mount()
    drag(gesture, [60])
    gesture.thumb.dispatchEvent(pointer('pointerup', 60))

    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onConfirm).toHaveBeenCalledTimes(0)
    expect(gesture.thumb.style.getPropertyValue('--thumb-x')).toBe('0px')
  })

  it('TC-MOB-12 pointercancel ⇒ aborted，零 decision', () => {
    const gesture = mount()
    drag(gesture, [99])
    gesture.thumb.dispatchEvent(pointer('pointercancel', 99))

    expect(onConfirm).toHaveBeenCalledTimes(0)
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(gesture.state).toBe('aborted')
  })

  it('TC-MOB-13 键盘等价：长按 Enter 满 600ms ⇒ confirmed', () => {
    const gesture = mount()
    gesture.thumb.dispatchEvent(key('keydown'))
    expect(onConfirm).toHaveBeenCalledTimes(0)

    vi.advanceTimersByTime(600)

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(gesture.state).toBe('confirmed')
  })

  it('TC-MOB-13 键盘等价：599ms 就松开 ⇒ aborted，零确认', () => {
    const gesture = mount()
    gesture.thumb.dispatchEvent(key('keydown'))
    vi.advanceTimersByTime(599)
    gesture.thumb.dispatchEvent(key('keyup'))
    vi.advanceTimersByTime(1)

    expect(onConfirm).toHaveBeenCalledTimes(0)
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(gesture.state).toBe('aborted')
  })

  it('TC-MOB-13 路径 B：kb-confirm 到位前 disabled、到位后 enabled，点击即确认', () => {
    const gesture = mount()
    expect(gesture.confirmButton.disabled).toBe(true)

    drag(gesture, [90])
    expect(gesture.confirmButton.disabled).toBe(false)

    gesture.confirmButton.dispatchEvent(new Event('click'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('TC-MOB-13 键盘长按的 repeat 不会把 600ms 计时器一直重置', () => {
    const gesture = mount()
    gesture.thumb.dispatchEvent(key('keydown'))
    vi.advanceTimersByTime(300)
    gesture.thumb.dispatchEvent(key('keydown', { repeat: true }))
    vi.advanceTimersByTime(300)

    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('TC-MOB-14 播报节流：0→100 全程扫过，live 文本变更 ≤8 次', () => {
    const gesture = mount()
    let last = gesture.live.textContent
    let changes = 0
    const sample = () => {
      const next = gesture.live.textContent
      if (next !== last) {
        changes += 1
        last = next
      }
    }

    gesture.thumb.dispatchEvent(pointer('pointerdown', 0))
    sample()
    for (let x = 0; x <= 100; x += 5) {
      gesture.thumb.dispatchEvent(pointer('pointermove', x))
      sample()
    }
    gesture.thumb.dispatchEvent(pointer('pointerup', 100))
    sample()

    expect(changes).toBeLessThanOrEqual(8)
    expect(changes).toBeGreaterThan(0)
    expect(gesture.live.textContent).toBe('已确认')
  })

  it('TC-MOB-15 D11 三句话逐字存在于源文本（对外材料同源）', () => {
    const source = readFileSync(SOURCE_FILE, 'utf8')

    expect(source).toContain('手势确认不等于强验证；红级操作仍需 U 盾/人脸/短信挑战（走 /api/verify/:ticketId）。')
    expect(source).toContain('用脚本直接 POST /api/approval/:ticketId 而不滑动，服务端会接受——滑动是 UI 约束，不是凭证。')
    expect(source).toContain('因此"手势"不得出现在任何安全自评的"控制项"里，只能出现在"人机工程/防误触"里。')
  })

  it('无障碍口径：滑块 role=button + tabindex=0 + aria-label 写出两条等价路径', () => {
    const gesture = mount()

    expect(gesture.thumb.getAttribute('role')).toBe('button')
    expect(gesture.thumb.getAttribute('tabindex')).toBe('0')
    expect(gesture.thumb.getAttribute('aria-label')).toContain('长按回车 600 毫秒')
    expect(gesture.confirmButton.getAttribute('aria-label')).toBe('确认操作')
    expect(gesture.live.getAttribute('aria-live')).toBe('polite')
  })

  it('缺省阈值就是 0.85，且可被 opts 覆盖（配置面不散落字面量）', () => {
    expect(GESTURE_DEFAULTS.thresholdRatio).toBe(0.85)
    expect(GESTURE_DEFAULTS.holdMs).toBe(600)

    const loose = mount({ thresholdRatio: 0.2 })
    drag(loose, [25])
    loose.thumb.dispatchEvent(pointer('pointerup', 25))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('TC-MOB-30 reduced-motion 下手势 aborted 语义不变（动效降级 ≠ 功能降级）', () => {
    const gesture = mount()
    drag(gesture, [10])
    gesture.thumb.dispatchEvent(pointer('pointerup', 10))

    expect(onConfirm).toHaveBeenCalledTimes(0)
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(gesture.thumb.style.getPropertyValue('--thumb-x')).toBe('0px')
  })

  it('TC-MOB-29 轨道宽在下次 down 时重读（横竖屏旋转后用新宽判定）', () => {
    let width = 100
    const gesture = mount({ deps: { trackWidth: () => width } })

    drag(gesture, [90])
    gesture.thumb.dispatchEvent(pointer('pointerup', 90))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    // 旋转：轨道变宽一半，同样的 90px 不再到位
    width = 200
    gesture.reset()
    drag(gesture, [90])
    gesture.thumb.dispatchEvent(pointer('pointerup', 90))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onAbort).toHaveBeenCalledTimes(1)
  })

  it('destroy 摘掉监听并移除节点（不留游离监听）', () => {
    const gesture = mount()
    const node = gesture.el
    gesture.destroy()

    expect(node.isConnected).toBe(false)
    gesture.thumb.dispatchEvent(pointer('pointerdown', 0))
    gesture.thumb.dispatchEvent(pointer('pointermove', 100))
    gesture.thumb.dispatchEvent(pointer('pointerup', 100))
    expect(onConfirm).toHaveBeenCalledTimes(0)
  })
})
