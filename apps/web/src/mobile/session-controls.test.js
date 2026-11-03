/**
 * 会话控制条用例（04 单 §5 / TC-XSC-24 的前端一半）。
 *
 * 钉三件事：接管横幅的显隐、"恢复"只能由坐席工作台完成、"回到上一步"发的是**已完成 turn 号**。
 * 端点的 HTTP 形状在 transport.js 的 `createSessionControlClient`；服务端闸（409/400/500）
 * 由 `packages/host/.../fork.test.ts` 证明，这里只注入假客户端，不重复造第二份 transport。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSessionControls, HANDOFF_POLL_MS } from './session-controls.js'

/** 假端点客户端（与 `createSessionControlClient` 同形；刻意没有 resume——移动壳不调坐席端点）。 */
function fakeClient(overrides = {}) {
  return {
    handoffStatus: vi.fn(async () => ({ ok: true, status: 200, data: { active: false } })),
    handoff: vi.fn(async () => ({ ok: true, status: 200, data: { active: true } })),
    fork: vi.fn(async () => ({ ok: true, status: 200, data: { sessionId: 's-fork-x' } })),
    ...overrides,
  }
}

describe('会话控制条', () => {
  let host
  let notify
  let client

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    notify = vi.fn()
    client = fakeClient()
  })

  afterEach(() => {
    vi.useRealTimers()
    host.remove()
  })

  it('转人工 → 横幅出现、入口隐藏；不提供"恢复"（交回由坐席工作台完成）', async () => {
    const controls = createSessionControls(host, { client, onNotice: notify })

    expect(controls.banner.hidden).toBe(true)
    host.querySelector('[data-role="handoff"]').click()
    await vi.waitFor(() => expect(controls.banner.hidden).toBe(false))
    expect(client.handoff).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-role="handoff"]').hidden).toBe(true)
    // 移动壳不渲染恢复钮：调坐席端点只会拿到 404（未配 BAH_OPERATOR_TOKEN 时不暴露存在性）
    expect(host.querySelector('[data-role="handoff-resume"]')).toBeNull()
    expect(controls.banner.textContent).toContain('坐席工作台')
    expect(notify).toHaveBeenLastCalledWith(
      '已请求人工接管：智能体暂停响应；你的消息会被记录，人工处理期间不会驱动智能体',
    )
    controls.dispose()
  })

  it('M-02 转人工先二次确认；取消时零 POST、横幅不动', async () => {
    const confirm = vi.fn(async () => false)
    const controls = createSessionControls(host, { client, onNotice: notify, confirm })

    host.querySelector('[data-role="handoff"]').click()
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))

    expect(client.handoff).not.toHaveBeenCalled()
    expect(controls.banner.hidden).toBe(true)
    controls.dispose()
  })

  it('M-02 确认后才发 POST /api/handoff', async () => {
    const confirm = vi.fn(async () => true)
    const controls = createSessionControls(host, { client, onNotice: notify, confirm })

    host.querySelector('[data-role="handoff"]').click()
    await vi.waitFor(() => expect(client.handoff).toHaveBeenCalledTimes(1))
    expect(confirm.mock.calls[0][0]).toContain('只能在坐席工作台交回')
    controls.dispose()
  })

  it('M-03 接管中「回到上一步」一并隐藏（移动端没有交回入口，别让他撞 409）', async () => {
    client.handoffStatus.mockResolvedValue({ ok: true, status: 200, data: { active: true } })
    const controls = createSessionControls(host, { client, onNotice: notify })
    await controls.refresh()
    expect(host.querySelector('[data-role="fork"]').hidden).toBe(true)
    controls.dispose()
  })

  it('回到上一步 → 发 turn 号 = 最近一个已完成轮次；提示原会话保留', async () => {
    const controls = createSessionControls(host, { client, onNotice: notify, latestTurn: () => 3 })

    host.querySelector('[data-role="fork"]').click()
    await vi.waitFor(() => expect(notify.mock.calls.at(-1)?.[0]).toContain('原会话保留可查'))
    expect(client.fork).toHaveBeenCalledWith(3)
    controls.dispose()
  })

  it('没有已完成轮次 ⇒ 不发请求，只提示（不猜 0）', async () => {
    const controls = createSessionControls(host, { client, onNotice: notify, latestTurn: () => undefined })

    host.querySelector('[data-role="fork"]').click()
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('还没有可回退的完整轮次', 'warning'))
    expect(client.fork).not.toHaveBeenCalled()
    controls.dispose()
  })

  it('refresh 读接管状态：active=true ⇒ 横幅可见', async () => {
    client.handoffStatus.mockResolvedValue({ ok: true, status: 200, data: { active: true } })
    const controls = createSessionControls(host, { client, onNotice: notify })
    await controls.refresh()
    expect(controls.banner.hidden).toBe(false)
    controls.dispose()
  })

  it('失败响应：横幅不变、提示带服务端理由（不静默）', async () => {
    client.handoff.mockResolvedValue({
      ok: false,
      status: 409,
      code: 'handoff-already-active',
      reason: '已在接管中',
    })
    const controls = createSessionControls(host, { client, onNotice: notify })

    host.querySelector('[data-role="handoff"]').click()
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('转人工失败：已在接管中', 'warning'))
    expect(controls.banner.hidden).toBe(true)
    controls.dispose()
  })

  it('服务端摘要驱动横幅：等待时长与已认领坐席（不显示 undefined）', async () => {
    client.handoffStatus.mockResolvedValue({
      ok: true,
      status: 200,
      data: { active: true, waitedMs: 65_000, claimed: true, operator: 'A-102' },
    })
    const controls = createSessionControls(host, { client, onNotice: notify })
    await controls.refresh()

    const hint = host.querySelector('[data-role="handoff-hint"]')
    expect(controls.banner.hidden).toBe(false)
    expect(hint.textContent).toContain('已等待 1:05')
    expect(hint.textContent).toContain('坐席 A-102 已认领')
    expect(hint.textContent).toContain('坐席工作台')
    controls.dispose()
  })

  it('摘要缺坐席名 / 未认领时各有兜底文案（不出现 undefined）', async () => {
    const controls = createSessionControls(host, { client, onNotice: notify })

    client.handoffStatus.mockResolvedValueOnce({ ok: true, status: 200, data: { active: true, claimed: true } })
    await controls.refresh()
    expect(host.querySelector('[data-role="handoff-hint"]').textContent).toContain('坐席已认领')

    client.handoffStatus.mockResolvedValueOnce({ ok: true, status: 200, data: { active: true, claimed: false } })
    await controls.refresh()
    const hint = host.querySelector('[data-role="handoff-hint"]')
    expect(hint.textContent).toContain('等待坐席认领')
    expect(hint.textContent).not.toContain('undefined')
    controls.dispose()
  })

  it('轮询在飞时不叠加请求（第二次直接返回 poll-in-flight）', async () => {
    let release
    client.handoffStatus.mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const controls = createSessionControls(host, { client, onNotice: notify })

    const first = controls.refresh()
    const second = await controls.refresh()
    expect(client.handoffStatus).toHaveBeenCalledTimes(1)
    expect(second).toMatchObject({ ok: false, code: 'poll-in-flight' })

    release({ ok: true, status: 200, data: { active: true } })
    await first
    controls.dispose()
  })

  it('接管中每 15 秒自动刷新摘要；dispose 后定时器停止', async () => {
    vi.useFakeTimers()
    client.handoff.mockResolvedValue({ ok: true, status: 200, data: { active: true } })
    client.handoffStatus.mockResolvedValue({ ok: true, status: 200, data: { active: true, waitedMs: 30_000 } })
    const controls = createSessionControls(host, { client, onNotice: notify })

    host.querySelector('[data-role="handoff"]').click()
    await Promise.resolve()
    await Promise.resolve()
    expect(controls.banner.hidden).toBe(false)
    expect(client.handoffStatus).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS)
    expect(client.handoffStatus).toHaveBeenCalledTimes(1)

    controls.dispose()
    await vi.advanceTimersByTimeAsync(HANDOFF_POLL_MS * 2)
    expect(client.handoffStatus).toHaveBeenCalledTimes(1)
  })
})
