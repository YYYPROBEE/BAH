/**
 * scheduled-funds 快照回放：定时转账入口 + 资金锁定三动作的证据底稿。
 *
 * - 逐条全等：schedule → lock → status → release → wake 全链可复现；
 * - 事件级不变量：`transfer_schedule` / `fund_lock` 真的被调用（不是"声明覆盖"）；
 * - 武装时强验证：`approval/challenge-issued` 必须存在，否则宽档窗口签不出来；
 * - 到期代签：`ticket/approved.authorization.kind === 'window'` 且 `plan_wake` executed；
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

import { CASE, runRecord, runReplay } from './scenario.ts'

/** 从 `plan_wake` 的工具结果里读报告（正文是 JSON）。 */
function readReport(event: {
  readonly data: unknown
}): {
  readonly entries: readonly { readonly status: string; readonly code?: string }[]
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

  it('事件级不变量：两个工具真的被调用，到期代签凭预授权成功且只扣一笔', () => {
    const snapshot = loadSnapshot(DIR)
    const events = snapshot.events

    const calls = events.filter((event) => event.type === 'tool/call')
    const names = calls.map((event) => (event.data as { name?: string }).name ?? '')
    expect(names.filter((name) => name === 'transfer_schedule')).toHaveLength(1)
    expect(names.filter((name) => name === 'fund_lock')).toHaveLength(3)

    // 武装宽档窗口前必须完成一次强验证（否则 preauthOf 返回 undefined，工具会抛错）
    expect(events.filter((event) => event.type === 'approval/challenge-issued').length).toBeGreaterThan(0)

    // 三笔：`fund_lock` 的两笔内部划转 + 定时转账到期的那一笔。
    // 修复 F-01 前这里是 2 笔（到期被 `challenge-required` 阻断）；现在到期腿真的动账，
    // 但仍必须**只动一笔**——重复扣款由窗口幂等（`already-ran`）与预算记账挡住。
    expect(events.filter((event) => event.type === 'transfer/created')).toHaveLength(3)
    expect(events.filter((event) => event.type === 'plan/created')).toHaveLength(1)

    // 到期代签：票据在**签发时**就带 window 授权来源。
    const issued = events.filter((event) => event.type === 'ticket/issued')
    const windowIssued = issued.filter(
      (event) => (event.data as { authorization?: { kind?: string } }).authorization?.kind === 'window',
    )
    expect(windowIssued).toHaveLength(1)

    /*
     * 到期代签的真实语义（F-01 修复后，2026-11-22 重录）：
     *
     * `transfer_schedule` 武装时做了强验证，凭据写进 `ArmedPlan.challenge`；
     * 窗口到期执行 `transfer_create`（红级，`daily-limit` 升红）时，审批服务通过
     * `preauth`（窗口账本 + 绑定 + 有效期 + 同进程挑战结论）确认"这次要求的那次
     * 验证已经发生过"，于是 `window-responder` 的 `allowed-once` 被采纳。
     *
     * 这条断言钉死三件事：
     * 1. 代签人必须是 `window-responder`（不是 headless 夹具）；
     * 2. 计划必须 `succeeded` 且只成功一个节点；
     * 3. 不得再出现 `challenge-required`（修复前正是它把计划打成 failed）。
     */
    const wakeResults = events.filter(
      (event) => event.type === 'tool/result' && (event.data as { name?: string }).name === 'plan_wake',
    )
    expect(wakeResults).toHaveLength(1)
    expect(readReport(wakeResults[0]!).entries[0]?.status).toBe('executed')

    const completed = events.filter((event) => event.type === 'plan/completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.data).toMatchObject({ status: 'succeeded', succeeded: 1, failed: 0 })

    const nodeResult = events.filter((event) => event.type === 'plan/node-result')
    expect(nodeResult).toHaveLength(1)
    expect(nodeResult[0]?.data).toMatchObject({ status: 'succeeded' })

    const decided = events.filter((event) => event.type === 'approval/decided')
    const windowDecision = decided.find(
      (event) => (event.data as { by?: string }).by === 'window-responder',
    )
    expect(windowDecision?.data).toMatchObject({
      decision: 'allowed-once',
      // 与"当场验过人"区分：这一次是武装时的预授权凭据在抵账（F-01）
      reason: 'window-preauth',
    })

    expect(events.filter((event) => event.type === 'ticket/blocked')).toHaveLength(0)
  })

  it('负控：篡改一条事件 ⇒ 比对必须红', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-scheduled-tamper-'))
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
