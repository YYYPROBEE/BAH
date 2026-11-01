import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { attachSeamBridge } from '../../src/adapters/seam-bridge.ts'
import { TrajectoryRecorder } from '../../src/recorder/TrajectoryRecorder.ts'
import { SnapshotChain } from '../../src/snapshot/SnapshotChain.ts'
import { FakeEvents } from '../helpers/fake-events.ts'
import { dropRunsDir, FIXED_TS, makeRunsDir } from '../helpers/fixtures.ts'

const clock = (): Date => new Date(FIXED_TS)

const preExecute = (
  callId: string,
  name: string,
  args: Record<string, unknown> = {},
): Record<string, unknown> => ({ call: { callId, name, args }, verdict: { kind: 'allow' } })

const toolResult = (callId: string, isError = false): Record<string, unknown> => ({
  callId,
  name: 'whatever',
  isError,
  content: [{ type: 'text', text: 'ok' }],
})

describe('接缝桥', () => {
  let runsDir: string

  beforeEach(async () => {
    runsDir = await makeRunsDir()
  })

  afterEach(async () => {
    await dropRunsDir(runsDir)
  })

  it('pre-execute 取参数、tools/result 取结果，合成为一条轨迹事件', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const handle = attachSeamBridge({ events, recorder })

    const payload = preExecute('c1', 'verify_face', { channel: 'face' })
    const returned = await events.waterfall('tools/pre-execute', payload)
    // 只观察不判决：必须把原载荷原样交还（短路会改掉 agent 行为）。
    expect(returned).toBe(payload)

    events.emit('tools/result', toolResult('c1'))
    await handle.drain()

    expect(recorder.events).toHaveLength(1)
    expect(recorder.events[0]).toMatchObject({
      tool: 'verify_face',
      argsDigest: { channel: 'face' },
    })
    expect(recorder.events[0]?.resultDigest).toMatchObject({ isError: false })

    handle.dispose()
  })

  it('幂等键与权限分支随事件落盘', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const handle = attachSeamBridge({ events, recorder })

    await events.waterfall('tools/pre-execute', {
      call: {
        callId: 'c1',
        name: 'transfer_create',
        args: { amount: 100 },
        idempotencyKey: 'idem-1',
        permissionBranch: 'allowed-once',
      },
      verdict: { kind: 'allow' },
    })
    events.emit('tools/result', toolResult('c1'))
    await handle.drain()

    expect(recorder.events[0]).toMatchObject({
      idempotencyKey: 'idem-1',
      permissionBranch: 'allowed-once',
    })
    handle.dispose()
  })

  it('不可逆工具取「前快照 → 后快照」，与 callId 配对', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()

    let state: Record<string, unknown> = { 'txn.status': 'draft' }
    const snapshots = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => state,
    })
    await snapshots.open()

    const handle = attachSeamBridge({
      events,
      recorder,
      snapshots,
      isIrreversible: (tool) => tool === 'transfer_create',
    })

    await events.waterfall('tools/pre-execute', preExecute('c1', 'transfer_create'))
    await handle.drain()
    // 前快照必须在执行前取到：此时状态还是 draft。
    expect(snapshots.snapshots).toHaveLength(2)
    expect(snapshots.snapshots[1]?.state['txn.status']).toBe('draft')

    state = { 'txn.status': 'completed' }
    events.emit('tools/result', toolResult('c1'))
    await handle.drain()

    expect(snapshots.pairs()).toEqual([
      { callId: 'c1', before: expect.objectContaining({ reason: 'before-irreversible' }), after: expect.objectContaining({ reason: 'after-irreversible' }) },
    ])
    expect(snapshots.orphanCallIds()).toEqual([])
    handle.dispose()
  })

  it('只读工具不取快照（避免为无关调用制造噪音快照）', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const snapshots = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => ({}),
    })
    await snapshots.open()

    const handle = attachSeamBridge({
      events,
      recorder,
      snapshots,
      isIrreversible: (tool) => tool === 'transfer_create',
    })

    await events.waterfall('tools/pre-execute', preExecute('c1', 'account_balance'))
    events.emit('tools/result', toolResult('c1'))
    await handle.drain()

    expect(snapshots.snapshots).toHaveLength(1)
    handle.dispose()
  })

  it('pendingCallIds 暴露「发起但无结果」的调用（证据缺口的直接证据）', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const handle = attachSeamBridge({ events, recorder })

    await events.waterfall('tools/pre-execute', preExecute('c1', 'verify_face'))
    expect(handle.pendingCallIds()).toEqual(['c1'])

    events.emit('tools/result', toolResult('c1'))
    await handle.drain()
    expect(handle.pendingCallIds()).toEqual([])

    handle.dispose()
  })

  it('dispose 摘掉订阅，之后的事件不再记录；重复 dispose 不抛', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const handle = attachSeamBridge({ events, recorder })

    expect(events.count('tools/pre-execute')).toBe(1)
    handle.dispose()
    handle.dispose()

    expect(events.count('tools/pre-execute')).toBe(0)
    expect(events.count('tools/result')).toBe(0)

    await events.waterfall('tools/pre-execute', preExecute('c1', 'verify_face'))
    events.emit('tools/result', toolResult('c1'))
    await handle.drain()
    expect(recorder.events).toHaveLength(0)
  })

  it('写入失败在 drain 处抛出，不在总线里抛（总线不该被评测器搞崩）', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()

    const snapshots = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => {
        throw new Error('状态读取失败')
      },
    })

    const handle = attachSeamBridge({
      events,
      recorder,
      snapshots,
      isIrreversible: () => true,
    })

    // 总线侧不抛：waterfall 正常返回。
    await expect(events.waterfall('tools/pre-execute', preExecute('c1', 'transfer_create'))).resolves.toBeDefined()
    await expect(handle.drain()).rejects.toThrow('状态读取失败')
    handle.dispose()
  })

  it('结构不符的载荷被忽略（不抛、不记脏事件）', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const handle = attachSeamBridge({ events, recorder })

    await events.waterfall('tools/pre-execute', { nonsense: true })
    await events.waterfall('tools/pre-execute', { call: { name: 'no-call-id' } })
    events.emit('tools/result', { noCallId: true })
    events.emit('tools/result', toolResult('unknown-call'))
    await handle.drain()

    expect(recorder.events).toHaveLength(0)
    handle.dispose()
  })

  it('不提供 snapshots 时退化为纯轨迹记录', async () => {
    const events = new FakeEvents()
    const recorder = new TrajectoryRecorder({ episodeId: 'ep-1', runsDir, now: clock })
    await recorder.begin()
    const handle = attachSeamBridge({ events, recorder, isIrreversible: () => true })

    await events.waterfall('tools/pre-execute', preExecute('c1', 'transfer_create'))
    events.emit('tools/result', toolResult('c1', true))
    await handle.drain()

    expect(recorder.events).toHaveLength(1)
    expect(recorder.events[0]?.resultDigest).toMatchObject({ isError: true })
    handle.dispose()
  })
})
