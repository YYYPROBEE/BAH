/**
 * 快照回放 · `subscription-reminder`（ADR-0016 的订阅续费主动提醒）。
 *
 * **CI 永远只读**：默认 replay 模式，不写任何文件；要重录得显式设
 * `BAH_SNAPSHOT_RECORD=1`（PowerShell：`$env:BAH_SNAPSHOT_RECORD='1'; pnpm test:snapshot`）。
 *
 * 本场景比通用回放多钉一件事：**提醒必须从事件回放成同一条 `notice` 帧**——
 * 这是"用户没提问也看得见、刷新后还在"的全部机制（ADR-0016 §2.2）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { WebProjector } from '@bah/channels'
import { JsonlPersistence } from '@bah/persistence'
import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { CASE, runRecord, runReplay } from './scenario.ts'

/** 本用例快照目录（`snapshots/<case>/`）。 */
const DIR = join(fileURLToPath(new URL('../', import.meta.url)), CASE.name)

/** 录制开关：只有显式设置才写文件（CI 不设 → 只读回放）。 */
const RECORDING = process.env['BAH_SNAPSHOT_RECORD'] === '1'

/** 复制一份快照产物（理由同 `subscription` 用例：Windows + 非 ASCII 路径下 `cpSync` 会崩）。 */
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

  it('同一快照两次回放全等（确定性时钟 + 无网络）', async () => {
    const snapshot = loadSnapshot(DIR)
    const first = await runReplay(snapshot)
    const second = await runReplay(snapshot)

    expect(second).toEqual(first)
    expect(compareEvents(snapshot.events, second).equal).toBe(true)
  })

  it('录制产物就是真会话日志：JsonlPersistence 能原样读回（格式不漂移）', () => {
    const snapshot = loadSnapshot(DIR)
    const handle = new JsonlPersistence({ fsync: false, warn: () => {} }).open(DIR)

    expect(String(handle.header.sessionId)).toBe(snapshot.meta.sessionId)
    expect(handle.events()).toEqual(snapshot.events)
  })

  it('两条提醒进事件：汇总在前、逐条在后，都是 channel=in-app', () => {
    const snapshot = loadSnapshot(DIR)
    const reminders = snapshot.events.filter((event) => String(event.type) === 'proactive/reminder')

    expect(reminders).toHaveLength(2)
    expect(reminders[0]?.data).toMatchObject({
      source: 'subscription',
      key: 'sub:digest:2026-10-20',
      channel: 'in-app',
    })
    expect(reminders[1]?.data).toMatchObject({
      source: 'subscription',
      key: 'sub:s-1:2026-10',
      channel: 'in-app',
    })
    // 逐条那条的正文必须能读出"还剩几天 + 金额"（用户视角的唯一信息源）
    expect(String(reminders[1]?.data['title'])).toMatch(/2 天后扣费 ¥30\.00/)
  })

  it('提醒会回放成 notice 帧（这就是"不问也看得见、刷新还在"的机制）', () => {
    const snapshot = loadSnapshot(DIR)
    const projector = new WebProjector()
    for (const event of snapshot.events) projector.apply(event)

    const notices = projector.frames().filter((frame) => frame.kind === 'notice')
    const titles = notices.map((frame) => (frame.kind === 'notice' ? frame.title : ''))
    expect(titles.some((title) => title.includes('自动续费'))).toBe(true)
    expect(titles.some((title) => title.includes('2 天后扣费'))).toBe(true)
  })

  it('负控：篡改录制里的一条事件 → 比对必须红（护栏真的会响）', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-snapshot-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"proactive/reminder"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: { title: string } }
      tampered.data.title = '被人改过的提醒'
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
