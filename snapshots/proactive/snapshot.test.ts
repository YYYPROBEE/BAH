/**
 * proactive 快照回放（G1/G2 的证据底稿）。
 *
 * - 逐条全等：arm → wake(成立) → 事实改版 → wake(失守) 全链可复现；
 * - 事件级不变量：票据带 `authorization.kind='window'`；失败窗口零 `plan/created`；
 * - 零新键：没有 `wake/` / `armed/` 前缀的会话事件；
 * - 负控：篡改一条事件 ⇒ 比对必须红。
 *
 * CI 永远只读；重录需 `BAH_SNAPSHOT_RECORD=1`。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { digestOfInputs } from '../../packages/runtime/src/authorization/window.ts'
import { CASE, runRecord, runReplay } from './scenario.ts'

/** 从 `plan_wake` 的工具结果里读报告（正文是 JSON）。 */
function readReport(event: {
  readonly data: unknown
}): {
  readonly entries: readonly {
    readonly status: string
    readonly digest?: string
    readonly inputs?: Parameters<typeof digestOfInputs>[0]
  }[]
} {
  const data = event.data as { readonly content?: readonly { readonly text?: string }[] }
  const text = data.content?.[0]?.text ?? '{}'
  return JSON.parse(text) as ReturnType<typeof readReport>
}

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
      // 全程不经过模型：录制的 exchange 必须是 0
      expect(summary.exchanges).toBe(0)
    }

    const snapshot = loadSnapshot(DIR)
    const replayed = await runReplay(snapshot)
    const comparison = compareEvents(snapshot.events, replayed)
    expect(comparison.diffs).toEqual([])
    expect(comparison.equal).toBe(true)
  })

  it('同一快照两次回放全等（可跳转时钟 + 无网络）', async () => {
    const snapshot = loadSnapshot(DIR)
    const first = await runReplay(snapshot)
    const second = await runReplay(snapshot)
    expect(second).toEqual(first)
  })

  it('事件级不变量：窗口授权落票据、成功实例一次、失守窗口零执行', () => {
    const snapshot = loadSnapshot(DIR)
    const events = snapshot.events

    // 票据带授权来源（ADR-0006 的落点）
    const approved = events.filter((event) => event.type === 'ticket/approved')
    expect(approved.length).toBeGreaterThan(0)
    const windowApprovals = approved.filter(
      (event) => (event.data as { authorization?: { kind?: string } }).authorization?.kind === 'window',
    )
    expect(windowApprovals.length).toBeGreaterThan(0)

    // 恰好一张计划真正执行（act 1）；失守窗口不产生 plan/created
    expect(events.filter((event) => event.type === 'plan/created')).toHaveLength(1)

    // 两次 arm 各有一条结构化结果（回放靠它重建 armed store）
    const armResults = events.filter(
      (event) => event.type === 'tool/result' && (event.data as { name?: string }).name === 'plan_arm',
    )
    expect(armResults).toHaveLength(2)

    // 两次唤醒各一条工具结果；失守的那次必须 downgraded
    const wakeResults = events.filter(
      (event) => event.type === 'tool/result' && (event.data as { name?: string }).name === 'plan_wake',
    )
    expect(wakeResults).toHaveLength(2)
    const second = readReport(wakeResults[1])
    expect(second.entries.some((entry) => entry.status === 'downgraded')).toBe(true)

    // 判决可重算（I13 的快照侧证据）：digest 必须等于 inputs 的规范化摘要，
    // 且执行成功的那次 digest 必须出现在票据的 authorization 里
    for (const result of wakeResults) {
      for (const entry of readReport(result).entries) {
        if (entry.digest === undefined || entry.inputs === undefined) continue
        expect(digestOfInputs(entry.inputs)).toBe(entry.digest)
        if (entry.status === 'executed') {
          const hit = approved.some(
            (event) =>
              (event.data as { authorization?: { ref?: string; digest?: string } }).authorization
                ?.digest === entry.digest,
          )
          expect(hit).toBe(true)
        }
      }
    }
  })

  it('零新事件键：不存在 wake/ 或 armed/ 前缀事件', () => {
    const snapshot = loadSnapshot(DIR)
    const raw = JSON.stringify(snapshot.events)
    expect(raw).not.toContain('"wake/')
    expect(raw).not.toContain('"armed/')
    expect(raw).not.toContain('"authorization/')
  })

  it('负控：篡改一条事件 ⇒ 比对必须红', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-proactive-tamper-'))
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
