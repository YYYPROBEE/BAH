/**
 * DAG → 单列分步清单（`dagView: 'steps'`）。
 *
 * 三条口径：
 * 1. **排序真相源在后端**：`flattenDag` 不重排、不拓扑——帧里的 `nodes` 顺序已经是
 *    `packages/runtime/src/plan/topo.ts` 的 Kahn 字典序结果。前端再排一次就是第二真相源，
 *    两份排序在异常图上必然分叉，而分叉的表现是"清单顺序与审计链顺序不一致"，查不动。
 * 2. **9 态实名**：`DagNode.state` 是 `pending/ok/denied/blocked/running/failed/skipped/incident/cancelled`
 *    （`packages/channels/src/web/frames.ts:216-229`）。方案文档表格里的 `ready`/`succeeded`
 *    **在帧契约里不存在**，照抄就会渲染出没有样式的 `m-step--undefined`（已登记 §9 偏差）。
 * 3. **blocked 显式可见**：不合并、不折进"更多"、连续多个也逐条展示（TC-MOB-23）。
 *    "被阻塞"是用户唯一能自救的信息——把它折叠起来等于让用户盯着一个不动的进度条猜。
 *
 * 状态一律用 `.ds-tag` + 图标着色 + 行背景表达，**严禁左侧竖色条**（00 §5.6 / verify-no-left-accent）：
 * 抽屉与步骤清单正是这条最容易犯的两个面。
 */

import { clear, el, icon } from '../dom.js'
import { bilingualNodeLabel } from '../views/dag.js'

/**
 * 9 态的窄屏呈现表。`tag` 为空串表示"只降文字色，不挂徽标"（skipped/cancelled 是中性终态，
 * 挂个灰徽标反而和"待执行"抢注意力）。
 */
export const STEP_VIEW = {
  pending: { label: '待执行', tag: '', tone: 'tertiary' },
  running: { label: '进行中', tag: 'ds-tag ds-tag--brand', tone: 'default', progress: true },
  ok: { label: '已完成', tag: 'ds-tag ds-tag--success', tone: 'default', icon: 'check' },
  denied: { label: '已拦截', tag: 'ds-tag ds-tag--danger', tone: 'default', icon: 'error' },
  failed: { label: '执行失败', tag: 'ds-tag ds-tag--danger', tone: 'default', icon: 'error' },
  blocked: { label: '被阻塞', tag: 'ds-tag ds-tag--warning', tone: 'default', icon: 'lock' },
  incident: { label: '需人工处理', tag: 'ds-tag ds-tag--danger', tone: 'default', icon: 'error' },
  skipped: { label: '已跳过', tag: '', tone: 'disabled' },
  cancelled: { label: '已取消', tag: '', tone: 'disabled' },
}

/** 默认展开的状态：需要用户看见细节或需要用户行动的。`ok` 折叠（成功了就不用再占屏）。 */
const EXPANDED_BY_DEFAULT = new Set(['running', 'blocked', 'failed', 'incident', 'denied'])

/**
 * 纯函数：`DagFrame` → 有序步骤数组（帧内顺序，不重排）。
 *
 * @param {{ nodes?: readonly any[], edges?: readonly any[] }} dag
 * @returns {Array<{ id: string, label: string, state: string, kind: string, tier: string,
 *                   step: number, deps: string[], callId?: string, planId?: string, code?: string }>}
 */
export function flattenDag(dag) {
  const nodes = dag?.nodes ?? []
  const edges = dag?.edges ?? []
  return nodes.map((node) => {
    const deps = edges.filter((edge) => edge.to === node.id).map((edge) => edge.from)
    // `call` 节点的 id 就是 `call:<callId>`（packages/channels/src/web/dag.ts:38-40）；
    // 工具帧靠它关联到步骤。step / plan 节点没有 callId。
    const callId = node.kind === 'call' && node.id.startsWith('call:') ? node.id.slice('call:'.length) : undefined
    return {
      id: node.id,
      label: bilingualNodeLabel(node),
      state: node.state,
      kind: node.kind,
      tier: node.tier,
      step: node.step,
      deps,
      ...(callId === undefined ? {} : { callId }),
      ...(node.planId === undefined ? {} : { planId: node.planId }),
      ...(node.code === undefined ? {} : { code: node.code }),
    }
  })
}

/**
 * "第 n/m 步"的 n：**已了结**口径 = `ok + skipped + cancelled`。
 *
 * ⚠ 待核：`denied / failed / incident` 也是终态，
 * 但它们是"没走完"，算进"第 n 步"会让人以为进度在推进。04 单若定别的口径，改这一个函数。
 */
export function countSettled(steps) {
  let n = 0
  for (const step of steps) {
    if (step.state === 'ok' || step.state === 'skipped' || step.state === 'cancelled') n += 1
  }
  return n
}

/**
 * 造分步清单。
 *
 * @param {HTMLElement} host feed 里的清单容器
 * @param {object} deps
 * @param {(frame: any) => HTMLElement} deps.renderTool 复用桌面同一渲染件（views/tool-card.js:47）
 */
export function createPlanSteps(host, deps) {
  const goalSlot = el('div', { dataset: { role: 'goal-slot' } })
  const todoSlot = el('ul', { class: 'm-todo-slot', dataset: { role: 'todo-slot' }, hidden: true })
  const countNode = el('span', { class: 'm-stepbar__count', dataset: { role: 'step-count' }, text: '第 0/0 步' })
  const summaryNode = el('span', { class: 'm-stepbar__summary', text: '还没有执行步骤' })
  const stepbar = el('div', { class: 'm-stepbar', dataset: { role: 'stepbar' } }, [summaryNode, countNode])
  const list = el('ol', { class: 'm-steps', dataset: { role: 'steps' } })

  host.append(goalSlot, todoSlot, stepbar, list)

  /** 折叠集是**视图态**：不进 store、不跨模块读（§3.2 状态归属）。 */
  const toggled = new Map()
  /** callId → { frame, node }：同一帧对象只渲染一次（TC-MOB-24 的"恰一次"）。 */
  const toolNodes = new Map()
  /** callId → 最新工具帧。 */
  const toolFrames = new Map()
  let steps = []

  /** 一个状态的图标/进度/空心点（三选一；容器宽高由 CSS 先占好，防布局抖动）。 */
  function stateMark(state) {
    const view = STEP_VIEW[state]
    if (view?.progress === true) {
      return el('div', { class: 'ds-progress ds-progress--brand m-step__progress', role: 'progressbar', 'aria-label': '进行中' }, [
        el('div', { class: 'ds-progress__bar' }),
      ])
    }
    if (view?.icon !== undefined) return icon(view.icon, 16)
    return el('span', { class: 'm-step__dot', 'aria-hidden': 'true' })
  }

  /** blocked 的原因行：**永远可见**，不在折叠体内（TC-MOB-23）。 */
  function blockedReason(step) {
    const labels = step.deps
      .map((id) => steps.find((item) => item.id === id)?.label ?? id)
    return el('p', { class: 'm-step__blocked', dataset: { role: 'blocked-reason' } }, [
      icon('warning', 14),
      el('span', {
        text: labels.length === 0 ? '被阻塞：等待前序步骤' : `被阻塞：等待${labels.join('、')}`,
      }),
    ])
  }

  function toolNodeFor(step) {
    const callId = step.callId
    if (callId === undefined) return null
    const frame = toolFrames.get(callId)
    if (frame === undefined) return null
    const cached = toolNodes.get(callId)
    if (cached !== undefined && cached.frame === frame) return cached.node
    const node = deps.renderTool(frame)
    toolNodes.set(callId, { frame, node })
    return node
  }

  /** 折叠体（`rerender` 与 `attachTool` 的定点更新共用同一份构造，避免两处各写一遍然后漂）。 */
  function buildBody(step, expanded) {
    const toolNode = expanded ? toolNodeFor(step) : null
    return el('div', { class: 'm-step__body', dataset: { role: 'step-body' }, hidden: !expanded }, [
      ...(step.code === undefined ? [] : [el('code', { class: 'ds-code', text: step.code })]),
      ...(toolNode === null ? [] : [toolNode]),
      ...(expanded && toolNode === null && step.callId !== undefined
        ? [el('p', { class: 'm-gesture__note', text: '工具结果尚未到达。' })]
        : []),
    ])
  }

  function isExpanded(step, index) {
    const override = toggled.get(step.id)
    if (override !== undefined) return override
    if (EXPANDED_BY_DEFAULT.has(step.state)) return true
    // 首个 pending 也展开：它是"下一步会发生什么"的唯一线索
    return step.state === 'pending' && index === firstPendingIndex()
  }

  /**
   * 这一行到底有没有可展开的正文。
   *
   * WHY 要先问这个：`step` / `plan` 节点既没有 `code` 也没有 `callId`（见 `flattenDag`
   * 的注释），`buildBody` 对它们只能产出一个空 div。chevron 照画的话就是一个**死控件**——
   * 用户点一下，箭头转 180°，下面什么都不出现，看起来像渲染坏了（2026-10-31 走查）。
   * 与其补一句"没有明细"，不如不给这个按钮：可展开性必须由内容决定。
   */
  function hasBody(step) {
    return step.code !== undefined || step.callId !== undefined
  }

  function renderStep(step, index) {
    const view = STEP_VIEW[step.state] ?? { label: `未知状态：${String(step.state)}`, tag: 'ds-tag ds-tag--warning' }
    const expandable = hasBody(step)
    const expanded = expandable && isExpanded(step, index)

    const toggle = expandable
      ? el('button', {
          class: 'm-step__toggle',
          type: 'button',
          dataset: { role: 'step-toggle', nodeId: step.id },
          'aria-expanded': String(expanded),
          'aria-label': `${expanded ? '收起' : '展开'}步骤 ${String(index + 1)}：${step.label}`,
        }, [icon('chevron-down', 16)])
      : null
    if (toggle !== null) {
      toggle.addEventListener('click', () => {
        toggled.set(step.id, !expanded)
        rerender()
      })
    }

    return el('li', {
      class: `m-step m-step--${String(step.state)}`,
      dataset: { role: 'step', nodeId: step.id, state: String(step.state) },
    }, [
      el('div', { class: 'm-step__head' }, [
        el('span', { class: 'm-step__index', text: String(index + 1) }),
        stateMark(step.state),
        el('span', { class: 'm-step__label', text: step.label }),
        el('span', { class: 'm-step__tags' }, [
          el('span', { class: view.tag === '' ? 'ds-tag' : view.tag, text: view.label }),
        ]),
        ...(toggle === null ? [] : [toggle]),
      ]),
      ...(step.state === 'blocked' ? [blockedReason(step)] : []),
      ...(expandable ? [buildBody(step, expanded)] : []),
    ])
  }

  function firstPendingIndex() {
    return steps.findIndex((step) => step.state === 'pending')
  }

  /** 重画清单（保留折叠集与已渲染的工具卡节点）。 */
  function rerender() {
    clear(list)
    steps.forEach((step, index) => list.append(renderStep(step, index)))
    const settled = countSettled(steps)
    countNode.textContent = `第 ${String(settled)}/${String(steps.length)} 步`
    summaryNode.textContent = steps.length === 0 ? '还没有执行步骤' : `共 ${String(steps.length)} 步`
    stepbar.hidden = steps.length === 0
  }

  return {
    /** 一个 `dag` 帧：整轮替换（帧键 `dag:<turn>`，与 store 的替换语义同粒度）。 */
    render(dagFrame) {
      steps = flattenDag(dagFrame)
      rerender()
      return list
    },
    /**
     * 一个 `tool` 帧：按 callId 关联到步骤；节点展开时复用桌面 `renderTool`。
     *
     * **定点更新**，不整表重画：工具帧在流式执行期来得很密，整表重画会把焦点从
     * 用户刚按住的展开钮上踢走（窄屏上"点一下展开、焦点跑了"是最容易被当成 bug 的一类体验）。
     */
    attachTool(toolFrame) {
      toolFrames.set(toolFrame.callId, toolFrame)
      const step = steps.find((item) => item.callId === toolFrame.callId)
      if (step === undefined) return null
      const row = [...list.querySelectorAll('[data-role="step"]')].find(
        (node) => node.dataset.nodeId === step.id,
      )
      if (row === undefined) return null
      const body = row.querySelector('[data-role="step-body"]')
      const toggle = row.querySelector('[data-role="step-toggle"]')
      if (body === null || toggle === null) return null
      if (toggle.getAttribute('aria-expanded') !== 'true') return null
      const fresh = buildBody(step, true)
      body.replaceWith(fresh)
      return toolNodes.get(toolFrame.callId)?.node ?? null
    },
    /** 会话级目标条（04 单语义，本设计只渲染；跨 turn 存续靠帧键 `goal` 的替换语义）。 */
    setGoal(goalFrame) {
      clear(goalSlot)
      goalSlot.append(
        el('div', { class: 'm-goal', dataset: { role: 'goal', status: String(goalFrame.status) } }, [
          el('span', { class: 'm-goal__title', text: goalFrame.title }),
          ...(goalFrame.amountText === undefined
            ? []
            : [el('span', { class: 'm-goal__amount', text: goalFrame.amountText })]),
          ...(goalFrame.payeePhone === undefined
            ? []
            : [el('span', { class: 'ds-tag', text: goalFrame.payeePhone })]),
          el('span', {
            class: goalFrame.status === 'done' ? 'ds-tag ds-tag--success' : goalFrame.status === 'abandoned' ? 'ds-tag ds-tag--danger' : 'ds-tag ds-tag--brand',
            text: goalFrame.status === 'done' ? '已完成' : goalFrame.status === 'abandoned' ? '已放弃' : '进行中',
          }),
        ]),
      )
      return goalSlot
    },
    /**
     * 待办渲染位（04 单派生帧，D8 不落账）。
     * 本设计只呈现**只读列表**：勾选交互语义归 04，这里不实现，也不假装可点。
     */
    setTodos(todoFrame) {
      clear(todoSlot)
      for (const item of todoFrame.items ?? []) {
        todoSlot.append(
          el('li', {
            class: `m-todo-item${item.done === true ? ' m-todo-item--done' : ''}`,
            dataset: { role: 'todo-item', id: String(item.id), done: String(item.done === true) },
          }, [
            icon(item.done === true ? 'check' : 'clock', 14),
            el('span', { text: item.text }),
            ...(item.code === undefined ? [] : [el('code', { class: 'm-todo-item__code ds-code', text: item.code })]),
            ...(item.blockedBy === undefined || item.blockedBy.length === 0
              ? []
              : [el('span', { class: 'ds-tag ds-tag--warning', text: `等待 ${item.blockedBy.join('、')}` })]),
          ]),
        )
      }
      todoSlot.hidden = (todoFrame.items ?? []).length === 0
      return todoSlot
    },
    /**
     * 这次调用有没有对应的步骤节点。
     *
     * `dispatchFrame` 靠它决定工具卡落在哪儿：绿级只读工具常常不产生 DAG，
     * 一律塞给 planSteps 就等于让它彻底不可见（B 类探针的"帧有投影没有呈现"）。
     */
    hasNode(callId) {
      return steps.some((step) => step.callId === callId)
    },
    node: list,
    stepbar,
    get steps() {
      return steps
    },
    dispose() {
      toggled.clear()
      toolNodes.clear()
      toolFrames.clear()
      host.replaceChildren()
    },
  }
}
