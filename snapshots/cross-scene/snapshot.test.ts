/**
 * cross-scene 快照回放（§8.1 / TC-XSC-29）。
 *
 * **CI 永远只读**：默认 `replay` 模式，要重录得显式设 `BAH_SNAPSHOT_RECORD=1`。
 *
 * 断言分工：
 * - 逐条全等：整条链路（意图 → 目标 → 提案 → 执行 → 审批 → 票据 → 落账）可复现；
 * - 事件级不变量：goal 零新键、三笔转账各自核销、6 节点收尾计数如实；
 * - 负控：篡改一条事件 ⇒ 比对必须红（护栏真的会响）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { CASE, runRecord, runReplay } from './scenario.ts'

const DIR = join(fileURLToPath(new URL('../', import.meta.url)), CASE.name)
const RECORDING = process.env['BAH_SNAPSHOT_RECORD'] === '1'

function copyArtifacts(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const file of ['session.jsonl', 'llm.jsonl', 'scenario.json']) {
    writeFileSync(join(to, file), readFileSync(join(from, file)))
  }
}

describe(`快照回放 · ${CASE.name}`, () => {
  it('record → replay：无密钥回放，事件流逐条全等', async () => {
    if (RECORDING) {
      const summary = await recordSnapshot({ dir: DIR, run: runRecord })
      expect(summary.events).toBeGreaterThan(0)
    }

    const snapshot = loadSnapshot(DIR)
    const replayed = await runReplay(snapshot)
    const comparison = compareEvents(snapshot.events, replayed)

    expect(comparison.diffs).toEqual([])
    expect(comparison.equal).toBe(true)
  })

  it('TC-XSC-29 同一快照两次回放全等（确定性时钟 + 无网络）', async () => {
    const snapshot = loadSnapshot(DIR)
    const first = await runReplay(snapshot)
    const second = await runReplay(snapshot)
    expect(second).toEqual(first)
    expect(compareEvents(snapshot.events, second).equal).toBe(true)
  })

  it('事件级不变量：goal_set 落账、6 节点收尾、三笔转账各自产生领域事件', () => {
    const snapshot = loadSnapshot(DIR)
    const types = snapshot.events.map((event) => event.type)

    // 目标账本走工具形态（D5：零新事件键）
    const goalResults = snapshot.events.filter(
      (event) => event.type === 'tool/result' && (event.data as { name?: string }).name === 'goal_set',
    )
    expect(goalResults).toHaveLength(1)
    expect((goalResults[0]?.data as { isError?: boolean }).isError).toBe(false)

    // 提案 → 执行 → 收尾（6 节点：a1/a2/b1/b2/c1/c2）
    expect(types).toContain('plan/created')
    expect(types.filter((type) => type === 'plan/node-started')).toHaveLength(6)
    expect(types.filter((type) => type === 'plan/node-result')).toHaveLength(6)
    const completed = snapshot.events.find((event) => event.type === 'plan/completed')
    expect(completed?.data).toMatchObject({ status: 'succeeded', succeeded: 6, blocked: 0 })

    // 三笔转账：各自一笔领域事件（内部划转 300 + 鲜花 200 + 蛋糕 100）
    const created = snapshot.events.filter((event) => event.type === 'transfer/created')
    expect(created).toHaveLength(3)
    expect(
      created.map((event) => (event.data as { result: { amountCents: number } }).result.amountCents),
    ).toEqual([30_000, 20_000, 10_000])

    // 每笔 create 各有一张票据核销记录（独立审批的第③段动态判据，与门禁 I4 同源）
    expect(types.filter((type) => type === 'approval/asked').length).toBeGreaterThanOrEqual(3)
  })

  it('零新事件键：会话流里不存在 goal/ 或 todo/ 前缀事件', () => {
    const snapshot = loadSnapshot(DIR)
    const raw = JSON.stringify(snapshot.events)
    expect(raw).not.toContain('"goal/')
    expect(raw).not.toContain('"todo/')
    expect(raw).not.toContain('"effects/')
  })

  it('负控：篡改录制里的一条事件 → 比对必须红', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-cross-scene-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"plan/completed"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: Record<string, unknown> }
      tampered.data['succeeded'] = 99
      lines[index] = JSON.stringify(tampered)
      writeFileSync(path, lines.join('\n'), 'utf8')

      const comparison = compareEvents(loadSnapshot(DIR).events, loadSnapshot(copy).events)
      expect(comparison.equal).toBe(false)
      expect(comparison.diffs[0]).toBeDefined()
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
