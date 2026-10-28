/**
 * 实体槽位快照回放（实体槽位方案 S4 / 施工单 12 §3 的 T-AUD-005、T-AUD-006）。
 *
 * **CI 永远只读**：默认 `replay` 模式，不写任何文件；要重录得显式设 `BAH_SNAPSHOT_RECORD=1`
 * （Windows PowerShell：`$env:BAH_SNAPSHOT_RECORD='1'; pnpm test:snapshot`）。
 *
 * 五条用例回答五个问题：
 * 1. 录制 → 回放是不是逐条全等？**并且**槽位真的进了模型输入、路由仍读用户原话；
 * 2. 同一份快照两次回放是不是全等？（时钟/排序/格式化没有隐性不确定性）
 * 3. 录制件是不是真会话日志？（`JsonlPersistence` 能原样读回）
 * 4. 通用篡改负控：改一条 `assistant/message` → 必须红；
 * 5. **槽位篡改负控**：把 `context/slots.accounts` 从 3 改 2 → 必须红
 *    （证明槽位事件真的在比对面内，不是"录了不看"）。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JsonlPersistence } from '@bah/persistence'
import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { CASE, runRecord, runReplay } from './scenario.ts'

/** 本用例快照目录（`snapshots/<case>/`）。 */
const DIR = join(fileURLToPath(new URL('../', import.meta.url)), CASE.name)

/** 录制开关：只有显式设置才写文件（CI 不设 → 只读回放）。 */
const RECORDING = process.env['BAH_SNAPSHOT_RECORD'] === '1'

/** 一条事件是不是某个（可能是域）类型。 */
function isType(event: AnySessionEvent, type: string): boolean {
  return String(event.type) === type
}

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
  it('T-AUD-005 record → replay 逐条全等；槽位真的进了模型输入，路由仍读用户原话', async () => {
    if (RECORDING) {
      const summary = await recordSnapshot({ dir: DIR, run: runRecord })
      expect(summary.events).toBeGreaterThan(0)
      // 一个 turn 至少一次模型调用；带工具调用的 step 会有第二次
      expect(summary.exchanges).toBeGreaterThanOrEqual(CASE.prompts.length)
    }

    const snapshot = loadSnapshot(DIR)
    const replayed = await runReplay(snapshot)
    const comparison = compareEvents(snapshot.events, replayed)

    // 报错时把差异打出来（而不是只说"不一样"）
    expect(comparison.diffs).toEqual([])
    expect(comparison.equal).toBe(true)

    // 附带断言 1：槽位事件存在且是 ok（否则本场景没证明任何事）
    const slots = replayed.filter((event) => isType(event, 'context/slots'))
    expect(slots.length).toBeGreaterThanOrEqual(1)
    expect(slots[0]?.data).toMatchObject({ source: 'bank', status: 'ok', accounts: 3, transactions: 3 })

    // 附带断言 2：槽位文本真的进了 `request/context`（不是只落了事件）
    const contexts = replayed
      .filter((event) => isType(event, 'request/context'))
      .map((event) => (event.data as { texts: readonly string[] }).texts.join('\n'))
    expect(contexts.length).toBeGreaterThanOrEqual(1)
    const context = contexts[0] ?? ''
    expect(context.startsWith('【当前用户】')).toBe(true)
    expect(context).toContain('【账户概览】')
    expect(context).toContain('¥12,345.67')
    expect(context).toContain('【最近交易】')

    // 附带断言 3：离线路由仍读"用户原话"（上下文段没有被当成输入去规划）
    const toolNames = replayed
      .filter((event) => isType(event, 'tool/call'))
      .map((event) => (event.data as { name?: string }).name ?? '')
    expect(toolNames.some((name) => name.startsWith('account_'))).toBe(true)
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

  it('负控：篡改录制里的一条 assistant/message → 比对必须红（护栏真的会响）', () => {
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

  it('负控（槽位）：把 context/slots 的 accounts 从 3 改 2 → 比对必须红', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-snapshot-slots-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"context/slots"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: { accounts: number } }
      // 先确认没搞错行：录制件里确实是 3 个账户
      expect(tampered.data.accounts).toBe(3)
      tampered.data.accounts = 2
      lines[index] = JSON.stringify(tampered)
      writeFileSync(path, lines.join('\n'), 'utf8')

      const comparison = compareEvents(loadSnapshot(DIR).events, loadSnapshot(copy).events)
      expect(comparison.equal).toBe(false)
      expect(comparison.diffs.join('\n')).toContain('context/slots')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
