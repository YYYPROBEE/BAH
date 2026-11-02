/**
 * 快照回放 · `birthday-reminder`。
 *
 * 比通用回放多钉两件事：
 * 1. 提醒必须从事件回放成 `notice` 帧（"不问也看得见、刷新还在"的机制同 ADR-0016）；
 * 2. 一年一次：同一条事实在 03-05 发过之后，03-08 当天不许再来一条。
 *
 * **CI 永远只读**：默认 replay，不写文件；重录显式设 `BAH_SNAPSHOT_RECORD=1`。
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

  it('只有一条生日提醒：source=birthday、key 带年份、正文含日期与下一步', () => {
    const snapshot = loadSnapshot(DIR)
    const reminders = snapshot.events.filter((event) => String(event.type) === 'proactive/reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0]?.data).toMatchObject({
      source: 'birthday',
      key: 'birthday:f-1:2026',
      channel: 'in-app',
    })
    const title = String(reminders[0]?.data['title'])
    expect(title).toContain('3 天后是爱人的生日（3 月 8 日）')
    expect(title).toContain('给爱人订生日计划')
  })

  it('提醒会回放成 notice 帧（不问也看得见、刷新还在）', () => {
    const snapshot = loadSnapshot(DIR)
    const projector = new WebProjector()
    for (const event of snapshot.events) projector.apply(event)
    const notices = projector.frames().filter((frame) => frame.kind === 'notice')
    const titles = notices.map((frame) => (frame.kind === 'notice' ? frame.title : ''))
    expect(titles.some((title) => title.includes('爱人的生日'))).toBe(true)
  })

  it('负控：篡改录制里的一条事件 → 比对必须红', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-birthday-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"proactive/reminder"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: { title: string } }
      tampered.data.title = '被人改过的生日提醒'
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
