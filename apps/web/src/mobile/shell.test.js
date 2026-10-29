/**
 * 移动壳装配根用例（TC-MOB-25 + 帧路由 + 退避 + 错误归一化 + 能力位门控）。
 *
 * 桩纪律：`api` 与 `connect` 是**注入的假实现**（transport 既有测试同款手法），
 * 但注入点是 `createMobileShell(deps)` 的可选参数——生产路径（m.html 自动挂载）
 * 不传它们，走真实 `createHttpApi()` / `connectEvents()`（A1 探针）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_QUICK_PHRASES,
  RATE_LIMIT_FALLBACK_SECONDS,
  RECONNECT_DEFAULTS,
  backoffDelayMs,
  createMobileShell,
  dispatchFrame,
  uiErrorOf,
} from './shell.js'

/** 移动渠道能力位夹具（与 `packages/channels/src/capabilities.ts` 的 MOBILE_CAPABILITIES 同形）。 */
const MOBILE = {
  richCards: true,
  buttons: true,
  forms: true,
  images: true,
  streaming: true,
  layout: 'narrow',
  approvalSurface: 'bottom-sheet',
  gestureConfirm: true,
  voiceInput: 'ime',
  dagView: 'steps',
}

function fakeApi(overrides = {}) {
  return {
    session: vi.fn(async () => ({ ok: true, status: 200, data: { sessionId: 's-1', lastSeq: 0, capabilities: MOBILE } })),
    health: vi.fn(async () => ({ ok: true, status: 200 })),
    turn: vi.fn(async () => ({ ok: true, status: 202 })),
    interrupt: vi.fn(async () => ({ ok: true, status: 200 })),
    decide: vi.fn(async () => ({ ok: true, status: 200 })),
    verify: vi.fn(async () => ({ ok: true, status: 200 })),
    ...overrides,
  }
}

/** 假 connectEvents：记下每次连接的 options，并可手工推帧/改状态。 */
function fakeConnect() {
  const connections = []
  const fn = (options) => {
    const connection = { options, closed: false, close: vi.fn(() => { connection.closed = true }) }
    connections.push(connection)
    return connection
  }
  fn.connections = connections
  fn.last = () => connections[connections.length - 1]
  return fn
}

function dagFrame(seq, turn = 1) {
  return {
    kind: 'dag',
    seq,
    at: 1000 + seq,
    turn,
    nodes: [
      { id: 'step:1:1', label: '步骤 1', kind: 'step', step: 1, tier: 'unknown', state: 'ok' },
      { id: 'call:c-1', label: 'transfer_preview', kind: 'call', step: 1, tier: 'yellow', state: 'pending' },
    ],
    edges: [{ from: 'step:1:1', to: 'call:c-1' }],
    summary: '2 步',
  }
}

function approvalFrame(seq, ticketId = 'tk-1') {
  return {
    kind: 'approval',
    seq,
    at: 2000 + seq,
    ticketId,
    callId: 'c-1',
    name: 'transfer_create',
    operation: '转账',
    amountText: '¥ 800.00',
    amountConfirmed: false,
    tier: 'yellow',
    rejectReasonRequired: true,
  }
}

describe('帧路由 dispatchFrame', () => {
  function spyCtx() {
    return {
      feed: { append: vi.fn(), appendUnknown: vi.fn() },
      planSteps: {
        hasNode: vi.fn(() => false),
        attachTool: vi.fn(),
        render: vi.fn(),
        setGoal: vi.fn(),
        setTodos: vi.fn(),
      },
      approvalSheet: { offer: vi.fn(), closeByServer: vi.fn() },
      choiceCard: { show: vi.fn() },
      effectsList: { append: vi.fn() },
      store: { apply: vi.fn() },
    }
  }

  it.each([
    ['turn', 'feed'],
    ['message', 'feed'],
    ['notice', 'feed'],
    ['audit', 'feed'],
  ])('%s 帧进会话流', (kind, sink) => {
    const ctx = spyCtx()
    dispatchFrame({ kind, seq: 1 }, ctx)
    expect(ctx[sink].append).toHaveBeenCalledTimes(1)
  })

  it('delta 是显式 no-op（不落进"未知帧"兜底，把正常流式增量误报成异常）', () => {
    const ctx = spyCtx()
    expect(dispatchFrame({ kind: 'delta', at: 1, text: 'a' }, ctx)).toBeUndefined()
    expect(ctx.feed.append).toHaveBeenCalledTimes(0)
    expect(ctx.feed.appendUnknown).toHaveBeenCalledTimes(0)
  })

  it('tool 帧没有对应步骤 ⇒ 进会话流（绿级只读工具常常不产生 DAG）', () => {
    const ctx = spyCtx()
    ctx.planSteps.hasNode.mockReturnValue(false)

    dispatchFrame({ kind: 'tool', seq: 1, callId: 'c-9' }, ctx)

    expect(ctx.planSteps.hasNode).toHaveBeenCalledWith('c-9')
    expect(ctx.feed.append).toHaveBeenCalledTimes(1)
    expect(ctx.planSteps.attachTool).toHaveBeenCalledTimes(0)
  })

  it('tool 帧有对应步骤 ⇒ 挂进步骤，不在会话流里重复出现', () => {
    const ctx = spyCtx()
    ctx.planSteps.hasNode.mockReturnValue(true)

    dispatchFrame({ kind: 'tool', seq: 1, callId: 'c-1' }, ctx)

    expect(ctx.planSteps.attachTool).toHaveBeenCalledTimes(1)
    expect(ctx.feed.append).toHaveBeenCalledTimes(0)
  })

  it.each([
    ['dag', 'planSteps', 'render'],
    ['goal', 'planSteps', 'setGoal'],
    ['todo', 'planSteps', 'setTodos'],
    ['choice', 'choiceCard', 'show'],
    ['effects', 'effectsList', 'append'],
    ['snapshot', 'store', 'apply'],
  ])('%s 帧路由到 %s.%s', (kind, area, method) => {
    const ctx = spyCtx()
    dispatchFrame({ kind, seq: 1 }, ctx)
    expect(ctx[area][method]).toHaveBeenCalledTimes(1)
  })

  it('approval / approval-closed 分别走 offer 与 closeByServer', () => {
    const ctx = spyCtx()
    dispatchFrame({ kind: 'approval', seq: 1 }, ctx)
    dispatchFrame({ kind: 'approval-closed', seq: 2 }, ctx)

    expect(ctx.approvalSheet.offer).toHaveBeenCalledTimes(1)
    expect(ctx.approvalSheet.closeByServer).toHaveBeenCalledTimes(1)
  })

  it('D7 兜底：未知帧 kind 渲染成可见卡片，不静默丢帧', () => {
    const ctx = spyCtx()
    dispatchFrame({ kind: 'telemetry-spam', seq: 1 }, ctx)

    expect(ctx.feed.appendUnknown).toHaveBeenCalledTimes(1)
    expect(ctx.feed.append).toHaveBeenCalledTimes(0)
  })
})

describe('backoffDelayMs（纯函数）', () => {
  it('指数退避并封顶在 maxMs', () => {
    const neutral = () => 0.5
    expect(backoffDelayMs(0, RECONNECT_DEFAULTS, neutral)).toBe(1000)
    expect(backoffDelayMs(1, RECONNECT_DEFAULTS, neutral)).toBe(2000)
    expect(backoffDelayMs(2, RECONNECT_DEFAULTS, neutral)).toBe(4000)
    expect(backoffDelayMs(5, RECONNECT_DEFAULTS, neutral)).toBe(30_000)
    expect(backoffDelayMs(50, RECONNECT_DEFAULTS, neutral)).toBe(30_000)
  })

  it('±20% 抖动落在区间内（random 取两个端点）', () => {
    expect(backoffDelayMs(0, RECONNECT_DEFAULTS, () => 0)).toBe(800)
    expect(backoffDelayMs(0, RECONNECT_DEFAULTS, () => 1)).toBe(1200)
  })

  it('非法 attempt 不产生 NaN 或负数', () => {
    expect(backoffDelayMs(Number.NaN, RECONNECT_DEFAULTS, () => 0.5)).toBe(1000)
    expect(backoffDelayMs(-3, RECONNECT_DEFAULTS, () => 0.5)).toBe(1000)
    expect(backoffDelayMs(Number.POSITIVE_INFINITY, RECONNECT_DEFAULTS, () => 0.5)).toBe(30_000)
  })
})

describe('uiErrorOf（错误归一化）', () => {
  it('成功结果透传', () => {
    expect(uiErrorOf({ ok: true, status: 200 })).toEqual({ ok: true, code: 'ok', message: '' })
  })

  it('202 的 accepted 透传（接管期消息只落账不驱动，composer 要靠它说真话）', () => {
    expect(uiErrorOf({ ok: true, status: 202, data: { accepted: 'queued-for-operator' } })).toMatchObject({
      ok: true,
      accepted: 'queued-for-operator',
    })
  })

  it('429 ⇒ turn-rate-limited + retryAfterSeconds（transport 不透出响应头时用缺省值）', () => {
    const mapped = uiErrorOf({ ok: false, status: 429, code: 'rate-limited', reason: '太频繁' })
    expect(mapped).toEqual({
      ok: false,
      code: 'turn-rate-limited',
      message: '太频繁',
      retryAfterSeconds: RATE_LIMIT_FALLBACK_SECONDS,
    })
    expect(RATE_LIMIT_FALLBACK_SECONDS).toBe(60)
  })

  it('409 ⇒ turn-conflict-handoff（人工接管，与"系统停机 423"不是一回事）', () => {
    expect(uiErrorOf({ ok: false, status: 409, code: 'handoff-active', reason: 'x' }).code).toBe('turn-conflict-handoff')
  })

  it('网络层失败与未知状态码都给出可读码，不吞成 undefined', () => {
    expect(uiErrorOf({ ok: false, status: 0, code: 'network-error', reason: 'ECONNREFUSED' }).code).toBe('network-error')
    expect(uiErrorOf({ ok: false, status: 500 }).code).toBe('http-500')
    expect(uiErrorOf(undefined).code).toBe('network-error')
  })
})

describe('createMobileShell（装配与重连）', () => {
  let root
  let api
  let connect
  let shell

  beforeEach(async () => {
    root = document.createElement('div')
    root.id = 'app'
    root.className = 'm-shell'
    document.body.append(root)
    api = fakeApi()
    connect = fakeConnect()
  })

  afterEach(() => {
    shell?.stop()
    shell = null
    root.remove()
  })

  async function start(overrides = {}) {
    shell = createMobileShell({
      root,
      api,
      connect,
      gestureDeps: { trackWidth: () => 100 },
      tuning: { random: () => 0.5, ...(overrides.tuning ?? {}) },
      ...overrides,
    })
    await shell.start()
    return shell
  }

  const push = (frame) => connect.last().options.onFrame(frame)

  it('启动读一次 /api/session，把能力位与 sessionId 落进界面', async () => {
    await start()

    expect(api.session).toHaveBeenCalledTimes(1)
    expect(shell.capabilities).toEqual(MOBILE)
    expect(root.textContent).toContain('会话 s-1')
  })

  it('三区骨架 + 遮罩挂载点就位，脚本入口只有一个', async () => {
    await start()

    expect(root.querySelector('.m-header')).not.toBeNull()
    expect(root.querySelector('.m-feed')).not.toBeNull()
    expect(root.querySelector('.m-dock')).not.toBeNull()
    expect(root.querySelector('.m-overlay-host')).not.toBeNull()
    expect(root.querySelectorAll('.m-feed').length).toBe(1)
  })

  it('TC-MOB-25 同 seq 的 dag 帧派发两次 ⇒ DOM 只有一份（frameKey 替换语义）', async () => {
    await start()
    const frame = dagFrame(1)

    push(frame)
    push(frame)

    expect(root.querySelectorAll('[data-role="steps"]').length).toBe(1)
    expect(root.querySelectorAll('[data-role="step"]').length).toBe(2)
    expect(root.querySelectorAll('[data-role="step-count"]').length).toBe(1)
  })

  it('TC-MOB-25 同一票据的 approval 帧派发两次 ⇒ 只有一张抽屉', async () => {
    await start({ tuning: { reducedMotion: true } })
    const frame = approvalFrame(2)

    push(frame)
    push(frame)

    expect(root.parentElement.querySelectorAll('[data-role="sheet"]').length).toBe(1)
    expect(shell.sheet.state).toBe('open')
  })

  it('TC-MOB-25 delta 重放被丢弃：同 at 的增量只累加一次', async () => {
    await start()

    push({ kind: 'delta', at: 500, text: '你好' })
    push({ kind: 'delta', at: 500, text: '你好' })
    push({ kind: 'delta', at: 400, text: '旧的' })

    expect(shell.store.state().streamText).toBe('你好')
    expect(root.querySelector('[data-draft="true"]')?.textContent).toContain('你好')
  })

  it('delta 之后到达的权威 message 帧清掉草稿（半句话不永久残留）', async () => {
    await start()

    push({ kind: 'delta', at: 500, text: '你' })
    push({ kind: 'message', seq: 3, at: 600, role: 'assistant', blocks: [{ type: 'text', text: '你好' }] })

    expect(shell.store.state().streamText).toBe('')
    expect(root.querySelector('[data-draft="true"]')).toBeNull()
  })

  it('TC-MOB-25 重连必带 since=lastSeq，且旧连接被关掉（不留双连）', async () => {
    vi.useFakeTimers()
    try {
      await start()
      push(dagFrame(4))
      expect(shell.lastSeq).toBe(4)

      connect.last().options.onStatus('offline')
      // attempts 已经是 1（首连算一次），所以这一跳的退避是 baseMs·2^1 = 2s；
      // 推进 60s 是为了不把断言钉在某个具体指数上（那会让"改退避基数"变成测试失败）
      vi.advanceTimersByTime(60_000)

      expect(connect.connections.length).toBe(2)
      expect(connect.connections[0].close).toHaveBeenCalledTimes(1)
      expect(connect.last().options.since).toBe(4)
      // 重连调度权收归 shell：不让共享层再自己重连一次
      expect(connect.last().options.maxRetries).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('连续 3 次空重连 ⇒ 退避封顶 + 明确告诉用户"连接不稳定"', async () => {
    vi.useFakeTimers()
    try {
      await start()
      expect(root.querySelector('[data-role="unstable"]')).toBeNull()

      for (let round = 0; round < 3; round += 1) {
        connect.last().options.onStatus('offline')
        vi.advanceTimersByTime(60_000)
      }

      expect(connect.connections.length).toBe(4)
      expect(root.querySelector('[data-role="unstable"]')).not.toBeNull()
      expect(root.textContent).toContain('连接不稳定，正在重试')

      connect.last().options.onStatus('online')
      expect(root.querySelector('[data-role="unstable"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('收到过帧的断线不算"空重连"（不无故吓用户）', async () => {
    vi.useFakeTimers()
    try {
      await start()
      for (let round = 0; round < 3; round += 1) {
        push(dagFrame(10 + round))
        connect.last().options.onStatus('offline')
        vi.advanceTimersByTime(60_000)
      }

      expect(root.querySelector('[data-role="unstable"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('visibilitychange 到 hidden ⇒ 组合态复位（否则回前台后回车永远被当成选词）', async () => {
    await start()
    const input = root.querySelector('[data-role="composer-input"]')

    input.dispatchEvent(new Event('compositionstart', { bubbles: true }))
    expect(shell.composer.ime.isComposing()).toBe(true)

    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(shell.composer.ime.isComposing()).toBe(false)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('回到前台且已断开 ⇒ 立即重连，不等退避', async () => {
    vi.useFakeTimers()
    try {
      await start()
      connect.last().options.onStatus('offline')
      expect(connect.connections.length).toBe(1)

      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      document.dispatchEvent(new Event('visibilitychange'))

      expect(connect.connections.length).toBe(2)
      expect(connect.last().options.since).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('能力位 voiceInput=ime ⇒ 渲染 chips；none ⇒ 不渲染（D10 第 5 条）', async () => {
    await start()
    expect(root.querySelectorAll('[data-role="chip"]').length).toBe(DEFAULT_QUICK_PHRASES.items.length)
    shell.stop()
    shell = null
    root.replaceChildren()

    api = fakeApi({
      session: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { sessionId: 's-2', capabilities: { ...MOBILE, voiceInput: 'none' } },
      })),
    })
    connect = fakeConnect()
    await start()
    expect(root.querySelectorAll('[data-role="chip"]').length).toBe(0)
  })

  it('能力位 gestureConfirm=true ⇒ 抽屉里挂手势条（声明了就必须有对应 UI，B 类探针）', async () => {
    await start({ tuning: { reducedMotion: true } })
    push(approvalFrame(6))

    expect(document.querySelector('[data-role="gesture"]')).not.toBeNull()
    expect(document.querySelector('[data-role="thumb"]')).not.toBeNull()
  })

  it('chips 文案可被注入覆盖（视图层零硬编码）', async () => {
    await start({ phrases: { items: [{ text: '自定义短语', intent: '测试' }] } })

    expect(root.querySelectorAll('[data-role="chip"]').length).toBe(1)
    expect(root.textContent).toContain('自定义短语')
  })

  it('读不到能力位 ⇒ 降级为基础呈现并如实说出来（不猜渠道声明）', async () => {
    api = fakeApi({ session: vi.fn(async () => ({ ok: false, status: 0, code: 'network-error', reason: '不可达' })) })
    await start()

    expect(shell.capabilities).toBeUndefined()
    expect(root.textContent).toContain('无法读取渠道能力位')
    expect(root.querySelectorAll('[data-role="chip"]').length).toBe(0)
  })

  it('渠道声明的呈现面与移动壳不符 ⇒ fail-loud（profile 把桌面渠道指到了 m.html）', async () => {
    api = fakeApi({
      session: vi.fn(async () => ({
        ok: true,
        status: 200,
        data: { sessionId: 's-3', capabilities: { ...MOBILE, layout: 'wide', dagView: 'graph' } },
      })),
    })
    await start()

    expect(root.textContent).toContain('渠道声明的呈现面与移动壳不一致')
  })

  it('未知帧 kind 不崩且可见（D7 兜底在真实装配里也成立）', async () => {
    await start()
    push({ kind: 'brand-new-frame', seq: 9, at: 9 })

    const unknown = root.querySelector('[data-role="unknown-frame"]')
    expect(unknown).not.toBeNull()
    expect(unknown.textContent).toBe('未知帧：brand-new-frame')
  })

  it('handoff 帧只更新横幅，不当成"未知帧"灌进会话流', async () => {
    const controlClient = {
      handoffStatus: vi.fn(async () => ({ ok: true, status: 200, data: { active: false } })),
      handoff: vi.fn(async () => ({ ok: true, status: 200, data: { active: true } })),
      fork: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
    }
    await start({ controlClient })
    push({ kind: 'handoff', seq: 5, at: 5, active: true, reason: '客户要求人工' })

    expect(root.querySelector('[data-role="unknown-frame"]')).toBeNull()
    expect(root.querySelector('[data-role="handoff-banner"]').hidden).toBe(false)
  })

  it('实时 handoff 帧从接管到交回：横幅收起并明说恢复（不靠刷新页面）', async () => {
    const controlClient = {
      handoffStatus: vi.fn(async () => ({ ok: true, status: 200, data: { active: false } })),
      handoff: vi.fn(async () => ({ ok: true, status: 200, data: { active: true } })),
      fork: vi.fn(async () => ({ ok: true, status: 200, data: {} })),
    }
    await start({ controlClient })
    push({ kind: 'handoff', seq: 5, at: 5, active: true })
    expect(root.querySelector('[data-role="handoff-banner"]').hidden).toBe(false)

    push({ kind: 'handoff', seq: 6, at: 6, active: false, operator: '坐席小周' })
    expect(root.querySelector('[data-role="handoff-banner"]').hidden).toBe(true)
    const error = root.querySelector('[data-role="composer-error"]')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('坐席 坐席小周 已交回会话')
  })

  it('handoff-warn 帧不渲染"未知帧"，实时到达时提示已等待多久', async () => {
    await start()
    push({ kind: 'handoff-warn', seq: 7, at: 7, waitedMs: 7 * 60_000, slaMs: 5 * 60_000 })

    expect(root.querySelector('[data-role="unknown-frame"]')).toBeNull()
    const error = root.querySelector('[data-role="composer-error"]')
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('已等待 7 分钟')
  })

  it('点 chip ⇒ 一条 user/message 走 POST /api/turn（与 D6 同一路径），且不本地回显', async () => {
    await start({ phrases: { items: [{ text: '转 500 给他', intent: '省略槽位' }] } })

    root.querySelector('[data-role="chip"]').dispatchEvent(new Event('click'))
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(api.turn).toHaveBeenCalledTimes(1)
    expect(api.turn).toHaveBeenCalledWith('转 500 给他')
    // 输入区不做本地回显：用户消息一律等 `user/message` 帧（conversation.js 头注释的同一条纪律，
    // 否则回显与回流帧会短暂并存成两个"你"）。回显只属于选择题卡片（D6 点选需要即时反馈）。
    expect(root.querySelector('[data-role="echo"]')).toBeNull()
  })

  it('选择题点选先本地回显，服务端把用户消息回流后回显被撤掉（不留两份"你"）', async () => {
    await start()
    push({
      kind: 'choice',
      seq: 10,
      at: 10,
      callId: 'call-1',
      prompt: '你要转给谁？',
      options: [{ id: 'o1', label: '查余额' }],
      allowFreeText: true,
    })
    root.querySelector('[data-role="choice-option"]').dispatchEvent(new Event('click'))
    for (let index = 0; index < 8; index += 1) await Promise.resolve()

    expect(api.turn).toHaveBeenCalledWith('查余额')
    expect(root.querySelector('[data-role="echo"]')).not.toBeNull()
    expect(root.querySelector('[data-role="echo"]').textContent).toContain('查余额')

    push({ kind: 'message', seq: 11, at: 11, role: 'user', blocks: [{ type: 'text', text: '查余额' }] })

    expect(root.querySelector('[data-role="echo"]')).toBeNull()
    expect(shell.echoes.size).toBe(0)
  })

  it('snapshot 帧整体替换：不残留上一份状态的节点', async () => {
    await start()
    push(dagFrame(1))
    push({ kind: 'message', seq: 2, at: 2, role: 'assistant', blocks: [{ type: 'text', text: '旧消息' }] })
    expect(root.textContent).toContain('旧消息')

    push({
      kind: 'snapshot',
      sessionId: 's-1',
      maxSeq: 20,
      frames: [{ kind: 'message', seq: 20, at: 20, role: 'assistant', blocks: [{ type: 'text', text: '新消息' }] }],
    })

    expect(root.textContent).toContain('新消息')
    expect(root.textContent).not.toContain('旧消息')
    expect(shell.lastSeq).toBe(20)
  })

  it('空态只在真的没有内容时出现，且重复 sync 不会把它自己删掉（P1-3）', async () => {
    await start()
    expect(root.querySelector('.conversation__empty')).not.toBeNull()

    // 状态变化（连接、重连、故障）都会再跑一次 sync：判据数容器子节点会把空态卡自己数进去
    shell.sync()
    shell.sync()
    expect(root.querySelector('.conversation__empty')).not.toBeNull()

    push({ kind: 'message', seq: 1, at: 1, role: 'user', blocks: [{ type: 'text', text: '你好' }] })
    expect(root.querySelector('.conversation__empty')).toBeNull()
  })

  it('stop 关掉连接并摘掉 visibilitychange 监听', async () => {
    await start()
    const connection = connect.last()

    shell.stop()
    expect(connection.close).toHaveBeenCalledTimes(1)

    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(connect.connections.length).toBe(1)
    shell = null
  })
})
