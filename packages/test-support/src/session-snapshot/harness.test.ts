/**
 * 快照 harness 自测（施工单 12 §3 / §4 第 4 步）。
 *
 * 重点不是"文件写出来了"，而是三条不变量：
 * 1. 录出来的 `session.jsonl` 是**真会话日志**（能被 JSONL 后端读回、header 对得上）；
 * 2. 回放是**只读**的（不写任何文件）；
 * 3. 比对是**逐条整行**的（type 序列一样但载荷变了，必须红）。
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SessionEvent } from '@bah/core'

import { captureThrown } from '../assertions/index.ts'
import type { Exchange } from '../llm-mock-server/index.ts'

import {
  assertSameEvents,
  compareEvents,
  loadSnapshot,
  recordSnapshot,
  snapshotPaths,
  summarize,
  type SnapshotMeta,
} from './harness.ts'

/** 造一段确定性事件流（时钟固定，`at` 全相同）。 */
function eventsOf(count: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let index = 0; index < count; index += 1) {
    events.push({
      seq: index + 1,
      at: 1_000,
      formatVersion: 1,
      type: 'turn/start',
      data: { turn: index + 1 },
    })
  }
  return events
}

/** 造一次 provider 调用。 */
const EXCHANGE: Exchange = {
  index: 0,
  provider: 'mock',
  model: 'mock-chat',
  params: {},
  chunks: [
    { kind: 'block-start', index: 0 },
    { kind: 'text-delta', index: 0, text: '好' },
    { kind: 'block-end', index: 0 },
    { kind: 'finish', reason: 'stop' },
  ],
}

/** 造场景输入。 */
function metaOf(overrides: Partial<SnapshotMeta> = {}): SnapshotMeta {
  return {
    name: 'unit-case',
    profile: 'headless',
    prompts: ['你好'],
    sessionId: 's-snapshot-unit',
    clock: { start: 1_000, step: 1 },
    randomSeed: 7,
    rows: [
      { id: 'core:session', use: 'core:session', config: {} },
      { id: 'core:model', use: 'core:model', config: { provider: 'mock' } },
    ],
    model: {
      provider: 'mock',
      spec: {
        id: 'mock-chat',
        providerId: 'mock',
        capabilities: { toolCall: true, image: false, reasoning: true },
      },
    },
    ...overrides,
  }
}

/** 建一个临时快照目录。 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bah-harness-'))
}

describe('recordSnapshot', () => {
  it('落三份文件：session.jsonl（真日志）/ llm.jsonl / scenario.json', async () => {
    const dir = tempDir()
    try {
      const summary = await recordSnapshot({
        dir,
        run: async () => ({ meta: metaOf(), events: eventsOf(3), exchanges: [EXCHANGE] }),
      })

      expect(summary).toEqual({ name: 'unit-case', prompts: 1, events: 3, exchanges: 1 })
      expect(readdirSync(dir).sort()).toEqual(['llm.jsonl', 'scenario.json', 'session.jsonl'])

      // session.jsonl 就是运行时日志：header + 每条事件一行（真后端交叉验证在 snapshots 面）
      const lines = readFileSync(join(dir, 'session.jsonl'), 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
      expect(lines).toHaveLength(4)
      expect(JSON.parse(lines[0]!)).toMatchObject({
        kind: 'bah-session-header',
        sessionId: 's-snapshot-unit',
        formatVersion: 1,
        createdAt: 1_000,
      })
      expect(loadSnapshot(dir).events).toEqual(eventsOf(3))

      // scenario.json 人能读、能 diff
      expect(JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'))).toMatchObject({
        name: 'unit-case',
        prompts: ['你好'],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('重录 = 显式覆盖（不因"会话已存在"失败）', async () => {
    const dir = tempDir()
    try {
      await recordSnapshot({ dir, run: async () => ({ meta: metaOf(), events: eventsOf(2), exchanges: [EXCHANGE] }) })
      await recordSnapshot({ dir, run: async () => ({ meta: metaOf(), events: eventsOf(5), exchanges: [EXCHANGE] }) })

      expect(loadSnapshot(dir).events).toHaveLength(5)
      expect(summarize(loadSnapshot(dir))).toEqual({ name: 'unit-case', prompts: 1, events: 5, exchanges: 1 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('loadSnapshot', () => {
  it('读回三份内容（事件 / 调用 / 场景）', async () => {
    const dir = tempDir()
    try {
      await recordSnapshot({ dir, run: async () => ({ meta: metaOf(), events: eventsOf(2), exchanges: [EXCHANGE] }) })

      const snapshot = loadSnapshot(dir)
      expect(snapshot.paths).toEqual(snapshotPaths(dir))
      expect(snapshot.meta.name).toBe('unit-case')
      expect(snapshot.events).toHaveLength(2)
      expect(snapshot.exchanges).toEqual([EXCHANGE])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺文件 → snapshot-missing（并告诉人怎么录）', () => {
    const dir = tempDir()
    try {
      const error = captureThrown(() => loadSnapshot(dir))
      expect(error.code).toBe('snapshot-missing')
      expect(error.message).toContain('BAH_SNAPSHOT_RECORD=1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scenario.json 形状不对 → snapshot-invalid', async () => {
    const dir = tempDir()
    try {
      await recordSnapshot({ dir, run: async () => ({ meta: metaOf(), events: eventsOf(1), exchanges: [EXCHANGE] }) })
      writeFileSync(join(dir, 'scenario.json'), JSON.stringify({ name: 'x' }), 'utf8')

      expect(captureThrown(() => loadSnapshot(dir)).code).toBe('snapshot-invalid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('session.jsonl 与 scenario.json 的会话 ID 不一致 → snapshot-mismatch', async () => {
    const dir = tempDir()
    try {
      await recordSnapshot({ dir, run: async () => ({ meta: metaOf(), events: eventsOf(1), exchanges: [EXCHANGE] }) })
      writeFileSync(
        join(dir, 'scenario.json'),
        `${JSON.stringify(metaOf({ sessionId: 's-other' }), null, 2)}\n`,
        'utf8',
      )

      expect(captureThrown(() => loadSnapshot(dir)).code).toBe('snapshot-mismatch')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('回放是只读的：loadSnapshot 不写任何文件', async () => {
    const dir = tempDir()
    try {
      await recordSnapshot({ dir, run: async () => ({ meta: metaOf(), events: eventsOf(2), exchanges: [EXCHANGE] }) })
      const before = readdirSync(dir).sort()
      const contents = before.map((file) => readFileSync(join(dir, file), 'utf8'))

      loadSnapshot(dir)
      loadSnapshot(dir)

      expect(readdirSync(dir).sort()).toEqual(before)
      expect(before.map((file) => readFileSync(join(dir, file), 'utf8'))).toEqual(contents)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('compareEvents / assertSameEvents', () => {
  it('逐条整行比对：载荷变了也算差异（不只看 type 序列）', () => {
    const recorded = eventsOf(2)
    const sameTypeDifferentData: SessionEvent[] = [
      recorded[0]!,
      { ...recorded[1]!, data: { turn: 99 } },
    ]

    expect(compareEvents(recorded, recorded)).toMatchObject({ equal: true, diffs: [] })
    const mismatch = compareEvents(recorded, sameTypeDifferentData)
    expect(mismatch.equal).toBe(false)
    expect(mismatch.diffs).toHaveLength(1)
    expect(mismatch.diffs[0]).toContain('#2')
  })

  it('条数不同也要报告', () => {
    const comparison = compareEvents(eventsOf(2), eventsOf(3))
    expect(comparison.diffs.some((line) => line.includes('事件条数'))).toBe(true)
  })

  it('差异清单最多 5 条（够定位，不刷屏）', () => {
    const recorded = eventsOf(8)
    const replayed = recorded.map((event) => ({ ...event, at: 2_000 }))
    expect(compareEvents(recorded, replayed).diffs).toHaveLength(5)
  })

  it('assertSameEvents：全等静默通过，不等抛 snapshot-mismatch', () => {
    expect(() => assertSameEvents(eventsOf(2), eventsOf(2))).not.toThrow()

    const error = captureThrown(() => assertSameEvents(eventsOf(2), eventsOf(1)))
    expect(error.code).toBe('snapshot-mismatch')
    expect(error.message).toContain('不一致')
  })
})
