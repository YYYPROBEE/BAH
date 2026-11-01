/**
 * headless 压缩快照回放。
 *
 * **CI 永远只读**：默认 `replay` 模式，不写任何文件；要重录得显式设 `BAH_SNAPSHOT_RECORD=1`
 * （Windows PowerShell：`$env:BAH_SNAPSHOT_RECORD='1'; pnpm test:snapshot`）。
 *
 * 为什么这条用例值钱：它**不需要网络、不需要 API key**，却能挡住"改了提示词 / 装配顺序 /
 * 工具 schema / 压缩摘要文案导致模型看到的东西变了"这类回归——事件流是逐条整行比对的。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JsonlPersistence } from '@bah/persistence'
import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { CASE, runRecord, runReplay } from './scenario.ts'

/** 本用例快照目录（`snapshots/<case>/`）。 */
const DIR = join(fileURLToPath(new URL('../', import.meta.url)), CASE.name)

/** 录制开关：只有显式设置才写文件（CI 不设 → 只读回放）。 */
const RECORDING = process.env['BAH_SNAPSHOT_RECORD'] === '1'

/**
 * 复制一份快照产物。
 *
 * 为什么不用 `fs.cpSync`：本机 Node 22.17 在 Windows 上对含非 ASCII 的源目录调
 * `cpSync(..., { recursive: true })` 会直接 abort 进程（`STATUS_STACK_BUFFER_OVERRUN`）。
 * 这里只复制三份产物，逐个 read/write 既明确又不会碰到那个坑。
 */
function copyArtifacts(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const file of ['session.jsonl', 'llm.jsonl', 'scenario.json']) {
    writeFileSync(join(to, file), readFileSync(join(from, file)))
  }
}

describe(`快照回放 · ${CASE.name}`, () => {
  it('T-AUD-005 record → replay：无密钥回放，事件流逐条全等', async () => {
    if (RECORDING) {
      const summary = await recordSnapshot({ dir: DIR, run: runRecord })
      expect(summary.events).toBeGreaterThan(0)
      // 本场景为纯文本 mock：每轮一次模型调用
      expect(summary.exchanges).toBeGreaterThanOrEqual(CASE.prompts.length)
    }

    const snapshot = loadSnapshot(DIR)
    const replayed = await runReplay(snapshot)
    const comparison = compareEvents(snapshot.events, replayed)

    // 报错时把差异打出来（而不是只说"不一样"）
    expect(comparison.diffs).toEqual([])
    expect(comparison.equal).toBe(true)
  })

  it('T-AUD-006 同一快照两次回放全等（确定性时钟 + 无网络）', async () => {
    const snapshot = loadSnapshot(DIR)
    const first = await runReplay(snapshot)
    const second = await runReplay(snapshot)

    expect(second).toEqual(first)
    expect(compareEvents(first, second).equal).toBe(true)
    // 两次回放也都必须与录制全等，否则"确定性"只证明了两头错得一样
    expect(compareEvents(snapshot.events, second).equal).toBe(true)
  })

  it('录制产物就是真会话日志：运行时的 JsonlPersistence 能原样读回（格式不漂移）', () => {
    const snapshot = loadSnapshot(DIR)
    const handle = new JsonlPersistence({ fsync: false, warn: () => {} }).open(DIR)

    expect(String(handle.header.sessionId)).toBe(snapshot.meta.sessionId)
    expect(handle.events()).toEqual(snapshot.events)
  })

  it('T-CMP-SNAP 摘要真的进入快照：保留被折叠轮次的用户原话，且不承诺 refs 可取回', () => {
    const snapshot = loadSnapshot(DIR)
    const summaries = snapshot.events.filter((event) => event.type === 'compaction/summary')
    // 第 2 轮 end 折叠第 1 轮；第 3 轮请求已经带上这份摘要
    expect(summaries.length).toBeGreaterThanOrEqual(1)

    const data = summaries[0]?.data as { summary?: unknown; refs?: unknown } | undefined
    expect(typeof data?.summary).toBe('string')
    const text = String(data?.summary)
    expect(text).toContain('[已压缩历史] 第 1–1 轮')
    expect(text).toContain('用户：「第一轮：请记住尾号 1234 的账户」')
    expect(text).toContain('助手：「')
    expect(text).not.toContain('（见 refs）')
    expect(text).not.toContain('不要假设更早的对话原文仍在上下文中')
    expect(Array.isArray(data?.refs)).toBe(true)
  })

  it('负控：篡改录制里的一条事件 → 比对必须红（护栏真的会响）', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-snapshot-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"assistant/message"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: { content: unknown } }
      tampered.data.content = [{ type: 'text', text: '被人改过的回复' }]
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
