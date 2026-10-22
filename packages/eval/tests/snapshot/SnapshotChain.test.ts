import { readFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SnapshotChain } from '../../src/snapshot/SnapshotChain.ts'
import { dropRunsDir, FIXED_TS, makeRunsDir } from '../helpers/fixtures.ts'

const clock = (): Date => new Date(FIXED_TS)

describe('SnapshotChain', () => {
  let runsDir: string

  beforeEach(async () => {
    runsDir = await makeRunsDir()
  })

  afterEach(async () => {
    await dropRunsDir(runsDir)
  })

  it('起点 S₀ → 不可逆前后 → 终点 Send，四类快照齐全', async () => {
    let state: Record<string, unknown> = { 'txn.status': 'draft' }
    const chain = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => state,
    })

    const s0 = await chain.open()
    await chain.beforeIrreversible('call-1')
    state = { 'txn.status': 'completed' }
    await chain.afterIrreversible('call-1')
    const send = await chain.close()

    expect(s0.reason).toBe('episode-start')
    expect(s0.state).toEqual({ 'txn.status': 'draft' })
    expect(send.reason).toBe('episode-end')
    expect(send.state).toEqual({ 'txn.status': 'completed' })
    expect(chain.snapshots).toHaveLength(4)
  })

  it('快照是不可变副本（后续变更不会篡改已取快照）', async () => {
    const state: Record<string, unknown> = { 'a.b': 1 }
    const chain = new SnapshotChain({ episodeId: 'ep-1', runsDir, now: clock, readState: () => state })

    const s0 = await chain.open()
    state['a.b'] = 2
    await chain.close()

    expect(s0.state['a.b']).toBe(1)
  })

  it('嵌套数组/对象同样断开引用（展平后叶子保留原引用，浅拷贝挡不住）', async () => {
    // 回归用例：展平器把数组、空对象当叶子**原引用**保留，
    // 只做 `{...state}` 的话，后续 push 会就地改掉历史快照——证据被篡改且无痕迹。
    const pending: string[] = ['a']
    const state: Record<string, unknown> = { 'subs.pending': pending, 'steps.empty': {} }
    const chain = new SnapshotChain({ episodeId: 'ep-1', runsDir, now: clock, readState: () => state })

    const s0 = await chain.open()
    pending.push('b')
    ;(state['steps.empty'] as Record<string, unknown>)['leaked'] = true
    await chain.close()

    expect(s0.state['subs.pending']).toEqual(['a'])
    expect(s0.state['steps.empty']).toEqual({})
  })

  it('pairs 按 callId 配对；orphanCallIds 暴露只有一半的配对', async () => {
    const chain = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => ({}),
    })

    await chain.open()
    await chain.beforeIrreversible('call-1')
    await chain.afterIrreversible('call-1')
    await chain.beforeIrreversible('call-2')
    await chain.close()

    expect(chain.pairs()).toHaveLength(2)
    expect(chain.orphanCallIds()).toEqual(['call-2'])
  })

  it('close 落盘 snapshots.json（含 schemaVersion 与 episodeId）', async () => {
    const chain = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => ({ x: 1 }),
    })

    await chain.open()
    await chain.close()

    const raw = await readFile(chain.snapshotsPath, 'utf8')
    const parsed = JSON.parse(raw) as { schemaVersion: string; episodeId: string; snapshots: unknown[] }
    expect(parsed.schemaVersion).toBe('snapshots-v0.1')
    expect(parsed.episodeId).toBe('ep-1')
    expect(parsed.snapshots).toHaveLength(2)
  })

  it('close 之后再取快照直接抛（禁止终点后继续追加）', async () => {
    const chain = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => ({}),
    })
    await chain.open()
    await chain.close()
    await expect(chain.beforeIrreversible('call-9')).rejects.toThrow(/已 close/)
  })

  it('flush 可重复调用且覆盖同一文件（幂等）', async () => {
    const chain = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: () => ({ x: 1 }),
    })
    await chain.open()
    await chain.flush()
    await chain.flush()

    const raw = await readFile(chain.snapshotsPath, 'utf8')
    expect((JSON.parse(raw) as { snapshots: unknown[] }).snapshots).toHaveLength(1)
  })

  it('支持异步读状态', async () => {
    const chain = new SnapshotChain({
      episodeId: 'ep-1',
      runsDir,
      now: clock,
      readState: async () => ({ async: true }),
    })
    const s0 = await chain.open()
    expect(s0.state).toEqual({ async: true })
  })
})
