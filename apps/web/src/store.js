/**
 * 前端状态仓库（唯一）。
 *
 * 三条纪律（对应 `docs/web-frontend.md` §4）：
 * 1. **只吃帧**：不解析会话事件、不调接口、不算业务；
 * 2. **按稳定键替换**：同一 `callId` 的工具卡永远只有一个节点（三态更新靠它）；
 * 3. **快照即替换**：`snapshot` 帧到达就清空重建，"半新半旧"在结构上不可能出现。
 */

/** 帧的稳定键（必须与 `@bah/channels/web` 的 `frameKey` 一致）。 */
export function frameKey(frame) {
  switch (frame.kind) {
    case 'turn':
      return `turn:${frame.turn}:${frame.phase}`
    case 'message':
      return `message:${frame.seq}`
    case 'delta':
      return `delta:${frame.at}`
    case 'tool':
      return `tool:${frame.callId}`
    case 'approval':
      return `approval:${frame.ticketId}`
    case 'approval-closed':
      return `approval-closed:${frame.ticketId}`
    case 'notice':
      return `notice:${frame.seq}`
    case 'audit':
      return `audit:${frame.seq}`
    case 'dag':
      return `dag:${frame.turn}`
    case 'handoff':
      // 固定 key（与 @bah/channels/web 的 frameKey 一致）：接管会循环，按 active 分键
      // 会让重放顺序留下旧的 active:false，把"又要人工了"画成"已交回"。
      return 'handoff'
    case 'handoff-warn':
      // 固定 key：超时只该有一个红标，累积多条没有意义。
      return 'handoff-warn'
    case 'snapshot':
      return 'snapshot'
    default:
      return `unknown:${String(frame.seq ?? frame.at)}`
  }
}

/**
 * 视图键：`turn` 的 start/end 合并到同一个节点（否则一轮会出现两条分割线）。
 *
 * 归约层必须保留 `phase`（审计要区分），合并只发生在渲染层。
 */
export function viewKey(frame) {
  return frame.kind === 'turn' ? `turn:${frame.turn}` : frameKey(frame)
}

/** 造仓库。 */
export function createStore() {
  /** 键 → 帧。 */
  const frames = new Map()
  /** 键 → 插入顺序（Map 本身有顺序，保留一份便于快照替换）。 */
  let order = []
  /** 流式草稿（ephemeral）。 */
  let streamText = ''
  /** 连接状态：`connecting` / `online` / `offline`。 */
  let status = 'connecting'
  /** 渠道级故障（横幅）。 */
  let fault = null
  /** 最近一条接管帧（固定 key ⇒ 只有一条）。 */
  let handoff = null
  /** 最近一条超时告警帧。 */
  let handoffWarn = null
  /** 快照里的会话号（服务重启后会变；装配层据此提示"会话已重置"）。 */
  let sessionId = null

  const listeners = new Set()

  /** 当前状态（只读快照；调用方不得改写）。 */
  function state() {
    return {
      frames: order.map((key) => frames.get(key)).filter(Boolean),
      streamText,
      status,
      fault,
      handoff,
      handoffWarn,
      sessionId,
    }
  }

  function emit() {
    const snapshot = state()
    for (const listener of listeners) listener(snapshot)
  }

  /** 订阅；返回退订函数。 */
  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** 应用一帧。 */
  function apply(frame) {
    if (frame.kind === 'snapshot') {
      frames.clear()
      order = []
      handoff = null
      handoffWarn = null
      sessionId = typeof frame.sessionId === 'string' && frame.sessionId.length > 0 ? frame.sessionId : null
      for (const item of frame.frames) put(item)
      streamText = ''
      emit()
      return
    }

    if (frame.kind === 'delta') {
      streamText += frame.text
      emit()
      return
    }

    put(frame)
    // 一轮的开始 / 结束都作废草稿：
    // - `turn/end` 可能是 `failed` / `aborted` / `guard-stopped`，没有权威助手消息来收口，
    //   不在这里清就是"半句话永久残留"，下一轮 delta 还会接在它后面；
    // - `turn/start` 是新一轮的边界，上一轮的残稿不该跨轮活着。
    if (frame.kind === 'turn') streamText = ''
    // 权威**助手**消息到达 → 丢弃草稿（避免"半句话永久残留"）。
    // 不能用任意 message 清：运行时上下文 / 纠正文本也是 message，会把正在生成的草稿抹掉。
    if (frame.kind === 'message' && frame.role === 'assistant') streamText = ''
    emit()
  }

  function put(frame) {
    const key = frameKey(frame)
    if (!frames.has(key)) order.push(key)
    frames.set(key, frame)
    // 接管帧单独暴露：横幅只看"最近一次接管状态"，不随对话流滚动。
    if (frame.kind === 'handoff') handoff = frame
    if (frame.kind === 'handoff-warn') handoffWarn = frame
  }

  function setStatus(next) {
    if (status === next) return
    status = next
    emit()
  }

  function setFault(next) {
    fault = next
    emit()
  }

  function reset() {
    frames.clear()
    order = []
    streamText = ''
    status = 'connecting'
    fault = null
    handoff = null
    handoffWarn = null
    sessionId = null
    emit()
  }

  return { apply, subscribe, state, setStatus, setFault, reset }
}

/** 取最近一条审批（未收尾的）。 */
export function pendingApproval(states) {
  const closed = new Set(
    states
      .filter((frame) => frame.kind === 'approval-closed')
      .map((frame) => frame.ticketId),
  )
  let latest = null
  for (const frame of states) {
    if (frame.kind === 'approval' && !closed.has(frame.ticketId)) latest = frame
  }
  return latest
}

/** 取某一票据的结论帧。 */
export function approvalDecision(states, ticketId) {
  for (let index = states.length - 1; index >= 0; index -= 1) {
    const frame = states[index]
    if (frame.kind === 'approval-closed' && frame.ticketId === ticketId) return frame
  }
  return null
}
