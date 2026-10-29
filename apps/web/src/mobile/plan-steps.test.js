/**
 * DAG 分步清单用例（TC-MOB-21..24）。
 *
 * 桩纪律：`deps.renderTool` 是 spy（生产中传 `views/tool-card.js` 的真件）；
 * 帧全部是手写夹具，形状与 `packages/channels/src/web/frames.ts` 的 `DagFrame`/`DagNode` 一致。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STEP_VIEW, countSettled, createPlanSteps, flattenDag } from './plan-steps.js'

/** 9 态实名（`DagNode.state`）——方案文档表格里的 ready/succeeded 在帧契约里不存在。 */
const NINE_STATES = [
  'pending',
  'running',
  'ok',
  'denied',
  'blocked',
  'failed',
  'skipped',
  'incident',
  'cancelled',
]

function node(id, state, overrides = {}) {
  return { id, label: `节点 ${id}`, kind: 'step', step: 1, tier: 'unknown', state, ...overrides }
}

function dagFrame(nodes, edges = [], overrides = {}) {
  return { kind: 'dag', seq: 1, at: 1000, turn: 1, nodes, edges, summary: `${String(nodes.length)} 步`, ...overrides }
}

function toolFrame(callId, overrides = {}) {
  return {
    kind: 'tool',
    seq: 2,
    at: 1100,
    callId,
    name: 'transfer_preview',
    title: '转账预演',
    state: 'pending',
    tier: 'yellow',
    amountConfirmed: false,
    ...overrides,
  }
}

describe('flattenDag（纯函数）', () => {
  it('TC-MOB-21 菱形依赖 A→B,C→D：输出顺序与帧内拓扑序一致，且前端不重排', () => {
    const frame = dagFrame(
      [node('A', 'ok'), node('B', 'ok'), node('C', 'ok'), node('D', 'pending')],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'D' },
      ],
    )

    expect(flattenDag(frame).map((step) => step.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(flattenDag(frame).find((step) => step.id === 'D').deps).toEqual(['B', 'C'])
  })

  it('TC-MOB-21 帧内顺序被打乱时也照实呈现（排序真相源在后端 topo.ts，前端不猜）', () => {
    const frame = dagFrame([node('D', 'pending'), node('A', 'ok')], [{ from: 'A', to: 'D' }])

    expect(flattenDag(frame).map((step) => step.id)).toEqual(['D', 'A'])
  })

  it('TC-MOB-21 重复调用结果相等（确定性：无时钟、无随机、无 DOM）', () => {
    const frame = dagFrame([node('A', 'ok'), node('B', 'blocked')], [{ from: 'A', to: 'B' }])

    expect(flattenDag(frame)).toEqual(flattenDag(frame))
  })

  it('call 节点从 id 里还原 callId，step/plan 节点没有 callId', () => {
    const frame = dagFrame([
      node('call:c-1', 'pending', { kind: 'call' }),
      node('step:1:1', 'ok', { kind: 'step' }),
      node('plan:p-1:n-1', 'running', { kind: 'plan', planId: 'p-1' }),
    ])
    const steps = flattenDag(frame)

    expect(steps[0].callId).toBe('c-1')
    expect(steps[1].callId).toBeUndefined()
    expect(steps[2].planId).toBe('p-1')
  })

  it('空帧与缺字段不炸', () => {
    expect(flattenDag({ kind: 'dag', turn: 1 })).toEqual([])
    expect(flattenDag(undefined)).toEqual([])
  })

  it('countSettled 用"已了结"口径：ok + skipped + cancelled', () => {
    const steps = flattenDag(
      dagFrame([
        node('A', 'ok'),
        node('B', 'skipped'),
        node('C', 'cancelled'),
        node('D', 'denied'),
        node('E', 'failed'),
        node('F', 'incident'),
        node('G', 'pending'),
      ]),
    )

    expect(countSettled(steps)).toBe(3)
  })
})

describe('createPlanSteps（呈现）', () => {
  let host
  let renderTool
  let view

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    renderTool = vi.fn((frame) => {
      const card = document.createElement('section')
      card.className = 'tool-card'
      card.dataset.callId = frame.callId
      return card
    })
    view = createPlanSteps(host, { renderTool })
  })

  afterEach(() => {
    view.dispose()
    host.remove()
  })

  const rows = () => [...host.querySelectorAll('[data-role="step"]')]
  const rowOf = (id) => rows().find((row) => row.dataset.nodeId === id)

  it('TC-MOB-22 9 态参数化：每态渲染对应状态类、标签文案与图标', () => {
    view.render(dagFrame(NINE_STATES.map((state, index) => node(`n${String(index)}`, state))))

    expect(rows().length).toBe(9)
    for (const state of NINE_STATES) {
      const row = rows().find((item) => item.dataset.state === state)
      expect(row, `缺 ${state} 行`).not.toBeUndefined()
      expect(row.classList.contains(`m-step--${state}`)).toBe(true)
      expect(row.querySelector('.m-step__tags .ds-tag').textContent).toBe(STEP_VIEW[state].label)
      const expectedTag = STEP_VIEW[state].tag === '' ? 'ds-tag' : STEP_VIEW[state].tag
      expect(row.querySelector('.m-step__tags span').className).toBe(expectedTag)
    }
  })

  it('TC-MOB-22 图标：ok 用 check、failed/incident/denied 用 error、blocked 用 lock、running 用进度条', () => {
    view.render(dagFrame(NINE_STATES.map((state, index) => node(`n${String(index)}`, state))))

    expect(rowOf('n2').querySelector('.icon--check')).not.toBeNull()
    expect(rowOf('n3').querySelector('.icon--error')).not.toBeNull()
    expect(rowOf('n5').querySelector('.icon--error')).not.toBeNull()
    expect(rowOf('n7').querySelector('.icon--error')).not.toBeNull()
    expect(rowOf('n4').querySelector('.icon--lock')).not.toBeNull()
    expect(rowOf('n1').querySelector('.ds-progress')).not.toBeNull()
    expect(rowOf('n0').querySelector('.m-step__dot')).not.toBeNull()
  })

  it('未知状态不被静默丢弃：渲染成带警告标签的可见行（D7 兜底同款纪律）', () => {
    view.render(dagFrame([node('x', 'teleported')]))

    expect(rowOf('x').classList.contains('m-step--teleported')).toBe(true)
    expect(rowOf('x').querySelector('.ds-tag--warning').textContent).toContain('未知状态')
  })

  it('TC-MOB-23 三个连续 blocked 夹在 ok 之间 ⇒ 三行全部独立可见，不折进任何容器', () => {
    view.render(
      dagFrame(
        [node('A', 'ok'), node('B', 'blocked'), node('C', 'blocked'), node('D', 'blocked'), node('E', 'ok')],
        [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
          { from: 'C', to: 'D' },
          { from: 'D', to: 'E' },
        ],
      ),
    )

    const blocked = host.querySelectorAll('[data-state="blocked"]')
    expect(blocked.length).toBe(3)
    const reasons = [...host.querySelectorAll('[data-role="blocked-reason"]')]
    expect(reasons.length).toBe(3)
    expect(reasons[0].textContent).toBe('被阻塞：等待节点 A')
    expect(reasons[1].textContent).toBe('被阻塞：等待节点 B')
    expect(reasons[2].textContent).toBe('被阻塞：等待节点 C')

    // 不在折叠体内：blocked 的原因是"永远可见"，不是"点开才看"
    for (const reason of reasons) {
      expect(reason.closest('[data-role="step-body"]')).toBeNull()
      expect(reason.hidden).toBe(false)
    }
  })

  it('TC-MOB-23 blocked 的依赖找不到标签时退回 id，不渲染 undefined', () => {
    view.render(dagFrame([node('B', 'blocked')], [{ from: 'ghost', to: 'B' }]))

    expect(host.querySelector('[data-role="blocked-reason"]').textContent).toBe('被阻塞：等待ghost')
  })

  it('TC-MOB-24 n/m 计数随帧更新（第 n 步 = ok+skipped+cancelled）', () => {
    view.render(dagFrame([node('A', 'pending'), node('B', 'pending')]))
    expect(host.querySelector('[data-role="step-count"]').textContent).toBe('第 0/2 步')

    view.render(dagFrame([node('A', 'ok'), node('B', 'pending')]))
    expect(host.querySelector('[data-role="step-count"]').textContent).toBe('第 1/2 步')

    view.render(dagFrame([node('A', 'ok'), node('B', 'skipped')]))
    expect(host.querySelector('[data-role="step-count"]').textContent).toBe('第 2/2 步')
  })

  it('TC-MOB-24 默认折叠 ok、展开 running/blocked/failed/incident/denied 与首个 pending', () => {
    view.render(
      dagFrame([
        node('a', 'ok'),
        node('b', 'running'),
        node('c', 'blocked'),
        node('d', 'failed'),
        node('e', 'incident'),
        node('f', 'denied'),
        node('g', 'pending'),
        node('h', 'pending'),
      ]),
    )

    const expanded = (id) => rowOf(id).querySelector('[data-role="step-toggle"]').getAttribute('aria-expanded')
    expect(expanded('a')).toBe('false')
    expect(expanded('b')).toBe('true')
    expect(expanded('c')).toBe('true')
    expect(expanded('d')).toBe('true')
    expect(expanded('e')).toBe('true')
    expect(expanded('f')).toBe('true')
    expect(expanded('g')).toBe('true')
    expect(expanded('h')).toBe('false')
    expect(rowOf('a').querySelector('[data-role="step-body"]').hidden).toBe(true)
  })

  it('TC-MOB-24 展开节点 ⇒ renderTool 恰一次（同一帧重复展开不重画）', () => {
    view.render(dagFrame([node('call:c-1', 'ok', { kind: 'call' })]))
    view.attachTool(toolFrame('c-1'))
    expect(renderTool).toHaveBeenCalledTimes(0)

    rowOf('call:c-1').querySelector('[data-role="step-toggle"]').dispatchEvent(new Event('click'))
    expect(renderTool).toHaveBeenCalledTimes(1)
    expect(rowOf('call:c-1').querySelector('.tool-card').dataset.callId).toBe('c-1')

    // 收起再展开：缓存命中，不再调渲染件
    rowOf('call:c-1').querySelector('[data-role="step-toggle"]').dispatchEvent(new Event('click'))
    rowOf('call:c-1').querySelector('[data-role="step-toggle"]').dispatchEvent(new Event('click'))
    expect(renderTool).toHaveBeenCalledTimes(1)
  })

  it('TC-MOB-24 同一工具帧重复到达不重画；帧换了三态才重画（缓存按帧对象身份失效）', () => {
    view.render(dagFrame([node('call:c-1', 'running', { kind: 'call' })]))
    const first = toolFrame('c-1', { state: 'pending' })

    view.attachTool(first)
    expect(renderTool).toHaveBeenCalledTimes(1)
    view.attachTool(first)
    expect(renderTool).toHaveBeenCalledTimes(1)

    view.attachTool(toolFrame('c-1', { state: 'done' }))
    expect(renderTool).toHaveBeenCalledTimes(2)
  })

  it('hasNode 决定工具卡落点：没有对应步骤时 shell 会把它放进会话流', () => {
    view.render(dagFrame([node('call:c-1', 'pending', { kind: 'call' })]))

    expect(view.hasNode('c-1')).toBe(true)
    expect(view.hasNode('nope')).toBe(false)
  })

  it('折叠集是视图态：整轮 dag 帧替换后用户的手动折叠仍然保留', () => {
    view.render(dagFrame([node('a', 'running')]))
    rowOf('a').querySelector('[data-role="step-toggle"]').dispatchEvent(new Event('click'))
    expect(rowOf('a').querySelector('[data-role="step-toggle"]').getAttribute('aria-expanded')).toBe('false')

    view.render(dagFrame([node('a', 'running')], [], { seq: 5 }))
    expect(rowOf('a').querySelector('[data-role="step-toggle"]').getAttribute('aria-expanded')).toBe('false')
  })

  it('goal 帧渲染会话级目标条（只读一行，跨 turn 替换）', () => {
    view.setGoal({ kind: 'goal', seq: 1, at: 1, title: '给爱人准备生日', status: 'active', amountText: '¥ 1,000.00', payeePhone: '138****4321' })
    const goal = host.querySelector('[data-role="goal"]')

    expect(goal.textContent).toContain('给爱人准备生日')
    expect(goal.textContent).toContain('¥ 1,000.00')
    expect(goal.textContent).toContain('138****4321')
    expect(goal.dataset.status).toBe('active')

    view.setGoal({ kind: 'goal', seq: 2, at: 2, title: '改后的目标', status: 'done' })
    expect(host.querySelectorAll('[data-role="goal"]').length).toBe(1)
    expect(host.querySelector('[data-role="goal"]').textContent).toContain('改后的目标')
    expect(host.querySelector('[data-role="goal"] .ds-tag--success').textContent).toBe('已完成')
  })

  it('todo 帧只留只读渲染位：无勾选控件、blockedBy 与 code 如实呈现', () => {
    view.setTodos({
      kind: 'todo',
      seq: 3,
      at: 3,
      turn: 1,
      planId: 'p-1',
      openCount: 1,
      items: [
        { id: 'n-1', text: '锁定 1000 元', done: true, tone: 'success' },
        { id: 'n-2', text: '买鲜花', done: false, code: 'await-approval', blockedBy: ['n-1'], tone: 'warning' },
      ],
    })
    const items = [...host.querySelectorAll('[data-role="todo-item"]')]

    expect(items.length).toBe(2)
    expect(items[0].dataset.done).toBe('true')
    expect(items[0].classList.contains('m-todo-item--done')).toBe(true)
    expect(items[1].textContent).toContain('await-approval')
    expect(items[1].textContent).toContain('等待 n-1')
    expect(host.querySelectorAll('[data-role="todo-slot"] button, [data-role="todo-slot"] input').length).toBe(0)
    expect(host.querySelector('[data-role="todo-slot"]').hidden).toBe(false)
  })

  it('todo 空清单收起渲染位（不留一个空盒子占屏）', () => {
    view.setTodos({ kind: 'todo', seq: 1, at: 1, turn: 1, planId: 'p', openCount: 0, items: [] })

    expect(host.querySelector('[data-role="todo-slot"]').hidden).toBe(true)
  })

  it('空 DAG 不画清单，stepbar 收起', () => {
    view.render(dagFrame([]))

    expect(rows().length).toBe(0)
    expect(host.querySelector('[data-role="stepbar"]').hidden).toBe(true)
    expect(host.querySelector('[data-role="step-count"]').textContent).toBe('第 0/0 步')
  })

  it('状态表达不用左侧竖色条（00 §5.6：blocked/incident 走行背景 + 标签）', () => {
    view.render(dagFrame([node('b', 'blocked'), node('i', 'incident')]))
    const css = readMobileCss()

    expect(css).not.toMatch(/border-left[^;]*var\(--status-/)
    expect(css).not.toMatch(/border-inline-start[^;]*var\(--status-/)
    expect(rowOf('b').classList.contains('m-step--blocked')).toBe(true)
  })
})

/** 读页面局部样式（左竖条自查的第二个判据；第一个是 verify-no-left-accent 门禁）。 */
function readMobileCss() {
  return readFileSync(join(import.meta.dirname, '..', '..', 'styles', 'mobile.css'), 'utf8')
}
