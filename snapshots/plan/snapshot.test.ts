/**
 * plan 快照回放（方案 §4.6 的 3 个场景：全成功 / 中间失败 / dry-run）。
 *
 * **CI 永远只读**：默认 `replay` 模式，不写任何文件；要重录得显式设
 * `BAH_SNAPSHOT_RECORD=1`（Windows PowerShell：`$env:BAH_SNAPSHOT_RECORD='1'; pnpm test:snapshot`）。
 *
 * 为什么只录"全成功"一条：失败传播与 dry-run 的语义由
 * `packages/runtime/src/plan/engine.test.ts` 的 12 例单测与
 * `packages/host/src/boot/plugins/plan.test.ts` 的 6 个集成场景兜住——
 * 快照的职责是"整条链路逐字节可复现"，不是把每种分支再录一遍（录得越多，重录越贵）。
 * **不录 cancel**：取消依赖事件循环的时序，回放会 flaky。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { CASE, runRecord, runReplay } from './scenario.ts'

/** 本用例快照目录（`snapshots/<case>/`）。 */
const DIR = join(fileURLToPath(new URL('../', import.meta.url)), CASE.name)

/** 录制开关：只有显式设置才写文件（CI 不设 → 只读回放）。 */
const RECORDING = process.env['BAH_SNAPSHOT_RECORD'] === '1'

/** 复制三份产物（不用 `cpSync`：本机 Windows 上对非 ASCII 目录会 abort）。 */
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
      // plan 不经过模型：录制的 exchange 必须是 0（这条断言就是"无模型入口"的证据）
      expect(summary.exchanges).toBe(0)
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

  it('plan 事件齐全但**不含 args 原文**（金额与收款人不得进 append-only 日志）', () => {
    const snapshot = loadSnapshot(DIR)
    const types = snapshot.events.map((event) => event.type)

    expect(types).toContain('plan/created')
    expect(types).toContain('plan/node-result')
    expect(types).toContain('plan/completed')
    // 3 个节点各一条 tool/call（走的是七段管线，不是 definition.execute）
    expect(types.filter((type) => type === 'tool/call')).toHaveLength(3)

    // 口径：**plan/* 事件**不落 args（工具管线自己的 tool/call 仍按平台既有规则落参，
    // 那是既有事实，plan 不改变它，也不把整张图的 args 再落一遍）
    const planEvents = JSON.stringify(snapshot.events.filter((event) => event.type.startsWith('plan/')))
    expect(planEvents).not.toContain('房租')
    expect(planEvents).not.toContain('王建国')
    expect(planEvents).not.toContain('"args"')
    // digest 在：身份可校验，"说了什么"不上链
    expect(JSON.stringify(snapshot.events.find((event) => event.type === 'plan/created')?.data)).toMatch(
      /"digest":"[0-9a-f]{32}"/,
    )
  })

  it('负控：篡改录制里的一条 plan 事件 → 比对必须红（护栏真的会响）', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-plan-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"plan/completed"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: Record<string, unknown> }
      tampered.data['status'] = 'succeeded-by-hand'
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
