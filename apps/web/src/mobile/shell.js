/**
 * 移动壳装配根（施工单 02 §3.2）。
 *
 * 与桌面 `main.js` 是**平行组装**：共享 `transport.js` / `store.js` / `dom.js` 与
 * `views/` 里的纯渲染件，但"帧 → 交互面"的映射是移动端自己的（00 D1 双壳）。
 * **禁止 import main.js**——那是桌面的装配根，含桌面控制器与标签页逻辑，
 * 引它进来就等于把响应式单壳从后门放回来了。
 *
 * 三条本模块独有的职责：
 * 1. **能力位读取的唯一落点**（`loadCapabilities`）：其他模块只收注入，不各自去问 `/api/session`；
 * 2. **SSE 重连调度**：`connectEvents` 只负责一条连接的生命周期，指数退避与"回前台立即重连"
 *    在这里。刻意**不改共享层**——`transport.js` 正被并行「可观测性」线重写，
 *    改它就得替别人 `git add`（00 §10 明令禁止）；这里只 import 它的工厂，不是第二份实现。
 * 3. **delta 重放过滤**：`DeltaFrame` 没有 `seq`（只有 `kind/at/text`），store 对它是
 *    `streamText += text` 的**累加**语义而非键控替换 ⇒ 重连补发的 delta 会把文本重复一遍。
 *    对策是按 `at` 单调过滤（方案文档写的"按 seq 过滤"与帧契约不符，已登记 §9 偏差）。
 */

import { clear, el } from '../dom.js'
import { createStore, viewKey } from '../store.js'
import { createSessionControls } from './session-controls.js'
import { connectEvents, createHttpApi } from '../transport.js'
import { renderAudit } from '../views/audit.js'
import { renderDraft, renderEmptyState, renderFrame } from '../views/conversation.js'
import { renderTool } from '../views/tool-card.js'
import { createApprovalSheet } from './approval-sheet.js'
import { createChoiceCard } from './choice-card.js'
import { createComposer } from './composer.js'
import { createEffectsList } from './effects-list.js'
import { createLayout } from './layout.js'
import { createPlanSteps } from './plan-steps.js'

/**
 * 快捷短语默认文案（D10 第 5 条：chips 是演示主入口）。
 *
 * 四颗一对一对应 03 单的四类意图，答辩现场一键复现；文案里**不含**真实账号与户名。
 * 视图层零硬编码：composer 只认注入进来的这份配置（TC-MOB-19）。
 */
export const DEFAULT_QUICK_PHRASES = Object.freeze({
  items: Object.freeze([
    Object.freeze({ text: '上次那笔转账再来一次', intent: '模糊复现' }),
    Object.freeze({ text: '转 500 给他', intent: '省略槽位' }),
    Object.freeze({ text: '我下个月 8 号我爱人生日', intent: '隐含意图' }),
    Object.freeze({ text: '查一下那个理财', intent: '歧义消解' }),
  ]),
})

/** 重连缺省值表（可调，不散落字面量）。 */
export const RECONNECT_DEFAULTS = Object.freeze({
  baseMs: 1000,
  maxMs: 30_000,
  /** ±20% 抖动：多个标签页同时断线时不要齐刷刷同一毫秒打回来。 */
  jitter: 0.2,
  /** 连续这么多次重连都没收到新帧 ⇒ 退避封顶 + 明确告诉用户"连接不稳定"。 */
  emptyLimit: 3,
})

/**
 * 429 缺省封锁秒数。
 *
 * ⚠ 如实登记：共享层 `transport.js` 的 `request()` 只回 `{ ok, status, code, reason }`，
 * **不透出 `retry-after` 响应头** ⇒ 生产路径上这个缺省值会被用到。要精确遵守服务端的
 * retry-after，得给 `request()` 的返回对象加一个字段（纯增量），但该文件正被并行线改写，
 * 本单不碰（00 §10 处置规矩 3）。已作为交接项写进 handoff 与复审报告。
 */
export const RATE_LIMIT_FALLBACK_SECONDS = 60

/**
 * 指数退避 + 抖动（纯函数，可确定性测试）。
 *
 * @param {number} attempt 第几次重连（0 起）
 * @param {{ baseMs?: number, maxMs?: number, jitter?: number }} [config]
 * @param {() => number} [random] 缺省 `Math.random`；测试注入固定值
 */
export function backoffDelayMs(attempt, config = RECONNECT_DEFAULTS, random = Math.random) {
  const baseMs = config.baseMs ?? RECONNECT_DEFAULTS.baseMs
  const maxMs = config.maxMs ?? RECONNECT_DEFAULTS.maxMs
  const jitter = config.jitter ?? RECONNECT_DEFAULTS.jitter
  const step = Math.max(0, Math.floor(Number(attempt) || 0))
  // 2^step 在 step 很大时会溢出成 Infinity：先用 min 夹住再乘抖动，别指望 Math.min 兜住 NaN
  const capped = Math.min(maxMs, baseMs * 2 ** Math.min(step, 20))
  const spread = capped * jitter * (random() * 2 - 1)
  return Math.max(0, Math.round(capped + spread))
}

/**
 * 把 `transport.js` 的结构化结果翻成前端错误对象 `{ ok, code, message, retryAfterSeconds? }`（§3.0）。
 *
 * WHY 要有这一层：composer 与 approval-sheet 都不该认 HTTP 状态码——认状态码就是在前端
 * 复刻一份服务端的错误分类，两边迟早漂。码名用 kebab-case（`turn-conflict-handoff` /
 * `turn-rate-limited`），与 00 §4 的错误码规矩同源。
 */
export function uiErrorOf(result) {
  if (result?.ok === true) return { ok: true, code: 'ok', message: '' }
  const status = Number(result?.status ?? 0)
  const raw = String(result?.code ?? (status === 0 ? 'network-error' : `http-${String(status)}`))
  const message = String(result?.reason ?? raw)
  if (status === 429 || raw === 'turn-rate-limited') {
    const retryAfter = Number(result?.retryAfterSeconds ?? RATE_LIMIT_FALLBACK_SECONDS)
    return { ok: false, code: 'turn-rate-limited', message, retryAfterSeconds: retryAfter }
  }
  if (status === 409 || raw === 'handoff-active') {
    return { ok: false, code: 'turn-conflict-handoff', message }
  }
  return { ok: false, code: raw, message }
}

/**
 * 帧分发（00 D7：帧是投影层契约，可以自由扩展）。
 *
 * 前端 JS 没有 `assertNever` 的编译期（`verify-assert-never` 只扫 .ts），而 D7 又允许
 * 后端先行加帧 ⇒ `default` 必须是**运行时兜底**（渲染一张可见的"未知帧"卡）而不是穷尽断言。
 * 这是 00 §4「switch 以 assertNever 收尾」在前端 JS 的等价物：显式 default + 兜底可见，
 * 静默丢帧才是这里最坏的失败模式（B 类探针点名过它）。
 *
 * @param {Record<string, any>} frame
 * @param {{ feed: any, planSteps: any, approvalSheet: any, choiceCard: any, effectsList: any, store: any }} ctx
 */
export function dispatchFrame(frame, ctx) {
  switch (frame.kind) {
    case 'turn':
    case 'message':
    case 'notice':
      return ctx.feed.append(frame)
    case 'delta':
      // 显式 no-op：delta 是 ephemeral 帧，由 store 累加成 `streamText`，呈现走 `feed.setDraft()`。
      // 落到 default 会被渲染成"未知帧"，把正常的流式增量误报成异常。
      return undefined
    case 'tool':
      // 有对应步骤就挂在步骤里（复用桌面 renderTool），没有就进会话流——
      // 绿级只读工具常常不产生 DAG，只走 planSteps 会让它彻底不可见。
      return ctx.planSteps.hasNode(frame.callId)
        ? ctx.planSteps.attachTool(frame)
        : ctx.feed.append(frame)
    case 'dag':
      return ctx.planSteps.render(frame)
    case 'approval':
      return ctx.approvalSheet.offer(frame)
    case 'approval-closed':
      return ctx.approvalSheet.closeByServer(frame)
    case 'audit':
      return ctx.feed.append(frame)
    case 'snapshot':
      return ctx.store.apply(frame)
    case 'choice':
      return ctx.choiceCard.show(frame)
    case 'goal':
      return ctx.planSteps.setGoal(frame)
    case 'todo':
      return ctx.planSteps.setTodos(frame)
    case 'effects':
      return ctx.effectsList.append(frame)
    default:
      return ctx.feed.appendUnknown(frame)
  }
}

/** 会话流：按视图键替换（复用 store 的 `viewKey`），一轮 pass 结束后剪掉没被触到的节点。 */
function createFeed(container) {
  const rendered = new Map()
  let touched = new Set()

  function upsert(frame, factory) {
    const key = viewKey(frame)
    touched.add(key)
    const entry = rendered.get(key)
    if (entry === undefined) {
      const node = factory(frame)
      rendered.set(key, { node, frame })
      container.append(node)
      return node
    }
    if (entry.frame !== frame) {
      const node = factory(frame)
      entry.node.replaceWith(node)
      rendered.set(key, { node, frame })
      return node
    }
    return entry.node
  }

  return {
    begin() {
      touched = new Set()
    },
    append(frame) {
      // audit 帧不在 conversation.js 的 switch 里（它会渲染成"未知帧"），走 audit.js 的渲染件
      return upsert(frame, frame.kind === 'audit' ? renderAudit : renderFrame)
    },
    appendUnknown(frame) {
      return upsert(frame, (item) =>
        el('div', {
          class: 'frame-unknown',
          dataset: { role: 'unknown-frame', kind: String(item.kind) },
          text: `未知帧：${String(item.kind)}`,
        }),
      )
    },
    end() {
      for (const [key, entry] of rendered) {
        if (touched.has(key)) continue
        entry.node.remove()
        rendered.delete(key)
      }
      touched = new Set()
    },
    /** 流式草稿（`delta` 累积；权威消息到达即被 store 清空）。 */
    setDraft(text) {
      const existing = container.querySelector('[data-draft="true"]')
      if (text.length === 0) {
        existing?.remove()
        return null
      }
      if (existing === null) {
        const node = renderDraft(text)
        container.append(node)
        return node
      }
      const body = existing.querySelector('.bubble__text')
      if (body !== null) body.textContent = text
      return existing
    },
    setEmpty(visible) {
      const existing = container.querySelector('.conversation__empty')
      if (!visible) {
        existing?.remove()
        return
      }
      if (existing === null) container.append(renderEmptyState())
    },
    node: container,
    dispose() {
      rendered.clear()
      clear(container)
    },
  }
}

/**
 * 造移动壳。
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root m.html 的 `#app.m-shell`
 * @param {Window} [deps.win] 测试注入（matchMedia / visualViewport 桩）
 * @param {Document} [deps.doc]
 * @param {Record<string, any>} [deps.capabilities] 能力位夹具（**仅测试传**；生产走 loadCapabilities）
 * @param {ReturnType<typeof createHttpApi>} [deps.api] 测试注入
 * @param {typeof connectEvents} [deps.connect] 测试注入假 connectEvents
 * @param {{ items: ReadonlyArray<{text: string, intent?: string}> }} [deps.phrases] chips 配置
 * @param {{ storage?: Storage }} [deps.imeDeps]
 * @param {{ clock?: () => number, random?: () => number, reconnect?: object, reducedMotion?: boolean }} [deps.tuning]
 * @returns {{ start(): Promise<void>, stop(): void, dispatchFrame(frame: any): any,
 *             get lastSeq(): number, store: any, regions: any, sheet: any, composer: any,
 *             planSteps: any, choiceCard: any, effectsList: any, layout: any }}
 */
export function createMobileShell(deps) {
  const win = deps.win ?? globalThis.window
  const doc = deps.doc ?? win?.document ?? globalThis.document
  const api = deps.api ?? createHttpApi()
  const connect = deps.connect ?? connectEvents
  const random = deps.tuning?.random ?? Math.random
  const reconnectConfig = { ...RECONNECT_DEFAULTS, ...(deps.tuning?.reconnect ?? {}) }
  const store = createStore()

  const layout = createLayout(deps.root, { win })
  const { feed: feedRegion, dock, overlayHost } = layout.regions

  // 半途关闭后的"仍有一笔待确认"提醒条挂在 composer **上方**：
  // 挂在下方会被软键盘与安全区挤到屏幕外，等于没有回收口。
  const reminderHost = el('div', { dataset: { role: 'reminder-host' } })
  dock.append(reminderHost)

  const conversationHost = el('div', { dataset: { role: 'feed-conversation' } })
  const resultHost = el('div', { dataset: { role: 'feed-result' } })
  const echoHost = el('div', { dataset: { role: 'feed-echo' } })
  const planHost = el('div', { dataset: { role: 'feed-plan' } })
  const choiceHost = el('div', { dataset: { role: 'feed-choice' } })
  const effectsHost = el('div', { dataset: { role: 'feed-effects' } })
  feedRegion.append(conversationHost, resultHost, echoHost, planHost, choiceHost, effectsHost)

  const feed = createFeed(conversationHost)
  const planSteps = createPlanSteps(planHost, { renderTool })
  const effectsList = createEffectsList(effectsHost)

  let capabilities = deps.capabilities
  let sheet = null
  let controls = null
  let composer = null
  let choiceCard = null
  let unstableNotice = null

  /** 本地回显（D6 点选 / chips）：等服务端把 user/message 回流后由 sync 撤掉。 */
  const echoes = new Map()

  let lastSeq = 0
  let lastDeltaAt = 0
  let attempts = 0
  let emptyReconnects = 0
  let framesSinceConnect = 0
  let online = false
  let stopped = true
  let connection = null
  let reconnectTimer = null
  let unsubscribe = null

  const ctx = {
    feed,
    planSteps,
    effectsList,
    store,
    get approvalSheet() {
      return sheet
    },
    get choiceCard() {
      return choiceCard
    },
  }

  function showUnstable(visible) {
    if (!visible) {
      unstableNotice?.remove()
      unstableNotice = null
      return
    }
    if (unstableNotice !== null) return
    unstableNotice = el('div', {
      class: 'ds-alert ds-alert--warning notice',
      dataset: { role: 'unstable' },
    }, [
      el('span', { class: 'ds-alert__icon' }, [el('span', { class: 'icon icon--warning', 'aria-hidden': 'true' })]),
      el('div', { class: 'notice__body' }, [
        el('div', { class: 'ds-alert__title', text: '连接不稳定，正在重试' }),
        el('p', { class: 'ds-alert__desc', text: '重连后按续订点补发，已渲染的内容不会重复。' }),
      ]),
    ])
    feedRegion.append(unstableNotice)
  }

  /** 全量同步（幂等；每帧都可能触发一次）。 */
  function sync(state) {
    feed.begin()
    for (const frame of state.frames) dispatchFrame(frame, ctx)
    feed.end()
    feed.setDraft(state.streamText)
    // 空态看**实际落到会话流里的节点数**，不看帧数：tool 帧有 DAG 时挂在步骤里、
    // 不进会话流，用帧数判空会留下一屏"还没有对话"叠在真实内容上面。
    feed.setEmpty(conversationHost.childElementCount === 0 && state.streamText.length === 0 && echoes.size === 0)

    // 回显去重：服务端把用户消息回流成 message 帧之后，本地那条 pending 回显就该消失
    const echoed = new Set()
    for (const frame of state.frames) {
      if (frame.kind !== 'message' || frame.role !== 'user') continue
      echoed.add((frame.blocks ?? []).map((block) => block.text ?? '').join(''))
    }
    for (const [text, node] of echoes) {
      if (!echoed.has(text)) continue
      node.remove()
      echoes.delete(text)
    }

    layout.setStatus(state.status)
    const running = state.frames.some(
      (frame) => frame.kind === 'turn' && frame.phase === 'start' && !hasEnd(state.frames, frame.turn),
    )
    composer?.setRunning(running)
    if (state.fault !== null) composer?.showError(String(state.fault.reason ?? state.fault.code))
    conversationHost.lastElementChild?.scrollIntoView?.({ block: 'nearest' })
  }

  function hasEnd(frames, turn) {
    return frames.some((frame) => frame.kind === 'turn' && frame.turn === turn && frame.phase === 'end')
  }

  function onFrame(frame) {
    if (frame.kind === 'delta') {
      // 唯一允许的 shell 层去重逻辑（TC-MOB-25）：delta 无 seq，只能按 at 单调过滤
      const at = Number(frame.at ?? 0)
      if (at <= lastDeltaAt) return
      lastDeltaAt = at
    }
    const seq = typeof frame.maxSeq === 'number' ? frame.maxSeq : frame.seq
    if (typeof seq === 'number' && Number.isFinite(seq) && seq > lastSeq) lastSeq = seq
    framesSinceConnect += 1
    store.apply(frame)
  }

  function onStatus(status) {
    if (status === 'online') {
      online = true
      attempts = 0
      emptyReconnects = 0
      framesSinceConnect = 0
      showUnstable(false)
      store.setStatus('online')
      store.setFault(null)
      return
    }
    online = false
    store.setStatus('offline')
    // 一次都没收到新帧就断了 ⇒ 记一次"空重连"；连续到阈值就封顶退避并明说
    if (framesSinceConnect === 0) emptyReconnects += 1
    else emptyReconnects = 0
    framesSinceConnect = 0
    if (emptyReconnects >= reconnectConfig.emptyLimit) {
      // 2^5 × 1s = 32s > maxMs(30s) ⇒ 从这一次起退避恒等于封顶值
      attempts = Math.max(attempts, 5)
      showUnstable(true)
    }
    scheduleReconnect()
  }

  function openConnection() {
    connection?.close()
    attempts += 1
    // `maxRetries: 0` 把重连调度权收归 shell（退避策略在这里，不在共享层）。
    // 该字段是并行线新增的可选参数；HEAD 版本会忽略它，此时 shell 的
    // close-then-open 依然只留一条连接，不会出现双连（已在 §9 偏差登记里核过两种版本）。
    connection = connect({
      since: lastSeq,
      maxRetries: 0,
      onFrame,
      onFault: (fault) => store.setFault(fault),
      onStatus,
    })
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return
    const delay = backoffDelayMs(attempts, reconnectConfig, random)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopped || online) return
      openConnection()
    }, delay)
  }

  function onVisibilityChange() {
    if (doc.hidden) {
      // 组合态不得跨后台存活：切走时浏览器不一定派发 compositionend，
      // 卡住的组合态会让回到前台后的每一次回车都被当成"选词"，发送永久锁死。
      composer?.ime.resetComposing()
      return
    }
    if (online) return
    // 回前台立即重连（跳过退避）；差异靠 snapshot + 键控帧的替换语义吸收
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    attempts = 0
    openConnection()
  }

  async function submitTurn(text) {
    return uiErrorOf(await api.turn(text))
  }

  function echoUserMessage(text) {
    const existing = echoes.get(text)
    if (existing !== undefined) return existing
    const node = el('article', {
      class: 'message message--user',
      dataset: { role: 'echo', pending: 'true' },
    }, [
      el('div', { class: 'message__meta' }, [el('span', { text: '你' }), el('span', { class: 'message__seq', text: '发送中' })]),
      el('div', { class: 'bubble__body' }, [el('p', { class: 'bubble__text', text })]),
    ])
    echoes.set(text, node)
    echoHost.append(node)
    return node
  }

  /**
   * 读会话面（全 mobile 目录**唯一**的服务端能力位读取点，§1.2 红线）。
   *
   * 01 单已交付 `GET /api/session` ⇒ 响应形状实测为 `{ sessionId, lastSeq, capabilities }`
   * （`packages/host/src/boot/plugins/web/handlers/session.ts:43`），方案文档里的
   * `TODO(01)` 待核项因此**已回填并删除**（不再是待办）。
   *
   * @returns {Promise<{ capabilities?: Record<string, any>, sessionId?: string }>}
   */
  async function loadSession(client) {
    const result = await client.session()
    if (result.ok !== true || typeof result.data !== 'object' || result.data === null) return {}
    const data = result.data
    return {
      ...(typeof data.capabilities === 'object' && data.capabilities !== null
        ? { capabilities: data.capabilities }
        : {}),
      ...(typeof data.sessionId === 'string' && data.sessionId.length > 0
        ? { sessionId: data.sessionId }
        : {}),
    }
  }

  async function start() {
    stopped = false
    const session = capabilities === undefined ? await loadSession(api) : { capabilities }
    capabilities = session.capabilities
    const confirmed = capabilities !== undefined
    if (typeof session.sessionId === 'string') layout.setSession(session.sessionId)

    sheet = createApprovalSheet(
      overlayHost,
      {
        decide: async (ticketId, decision, reason) => uiErrorOf(await api.decide(ticketId, decision, reason)),
        verify: async (ticketId) => uiErrorOf(await api.verify(ticketId)),
        onError: (error) => composer?.showError(error.message),
      },
      {
        win,
        capabilities: confirmed ? capabilities : {},
        reminderHost,
        resultHost,
        reducedMotion: deps.tuning?.reducedMotion,
        ...(deps.tuning?.clock === undefined ? {} : { clock: deps.tuning.clock }),
        ...(deps.gestureDeps === undefined ? {} : { gestureDeps: deps.gestureDeps }),
      },
    )

    choiceCard = createChoiceCard(choiceHost, {
      submit: submitTurn,
      echo: echoUserMessage,
      focusComposer: () => composer?.focusInput(),
    })

    // 04 单：接管入口/横幅 + 回到上一步。端点客户端默认来自 transport.js；
    // 测试可注入 `deps.controlClient`（不为此在壳里再造第二份 transport）。
    controls = createSessionControls(dock, {
      ...(deps.controlClient === undefined ? {} : { client: deps.controlClient }),
      latestTurn: () => {
        let turn
        for (const frame of store.state().frames) {
          if (frame.kind === 'turn' && frame.phase === 'end') turn = frame.turn
        }
        return turn
      },
      onNotice: (text) => composer?.showError(text),
    })
    void controls.refresh()

    composer = createComposer(dock, {
      submit: submitTurn,
      interrupt: async (reason) => uiErrorOf(await api.interrupt(reason)),
      // chips 只在渠道声明"语音走系统输入法"时渲染（D10 第 5 条）
      ...(confirmed && capabilities.voiceInput === 'ime'
        ? { phrases: deps.phrases ?? DEFAULT_QUICK_PHRASES }
        : {}),
      imeDeps: deps.imeDeps,
    })

    // 三条能力位相关的可见反馈都必须在 composer 建好之后说：早一行就是静默 no-op
    if (!confirmed) {
      // 读不到就**少给** affordance，不猜渠道声明：手势与 chips 全关，抽屉照常工作
      composer.showError('无法读取渠道能力位，已降级为基础呈现。', true)
    } else if (
      capabilities.layout !== 'narrow' ||
      capabilities.approvalSurface !== 'bottom-sheet' ||
      capabilities.dagView !== 'steps'
    ) {
      // fail-loud：profile 把桌面渠道指到了 m.html，这类配置错误必须当场说出来
      composer.showError('渠道声明的呈现面与移动壳不一致（layout / approvalSurface / dagView）。', true)
    }

    unsubscribe = store.subscribe(sync)
    doc.addEventListener('visibilitychange', onVisibilityChange)
    openConnection()
    sync(store.state())
  }

  function stop() {
    stopped = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    connection?.close()
    connection = null
    unsubscribe?.()
    unsubscribe = null
    composer?.dispose()
    controls?.dispose()
    choiceCard?.dispose()
    effectsList.dispose()
    planSteps.dispose()
    sheet?.dispose()
    feed.dispose()
    layout.dispose()
  }

  return {
    start,
    stop,
    dispatchFrame: (frame) => dispatchFrame(frame, ctx),
    sync: () => sync(store.state()),
    get lastSeq() {
      return lastSeq
    },
    get capabilities() {
      return capabilities
    },
    get online() {
      return online
    },
    store,
    layout,
    feed,
    planSteps,
    effectsList,
    echoes,
    get sheet() {
      return sheet
    },
    get composer() {
      return composer
    },
    get controls() {
      return controls
    },
    get choiceCard() {
      return choiceCard
    },
  }
}

/** 自动挂载（浏览器里 `#app` 存在时；测试导入不会触发——jsdom 无该节点）。 */
const rootElement = typeof document === 'undefined' ? null : document.querySelector('#app')
if (rootElement instanceof HTMLElement) {
  void createMobileShell({ root: rootElement }).start()
}
