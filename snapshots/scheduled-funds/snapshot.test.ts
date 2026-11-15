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

  it('事件级不变量：两个工具真的被调用，到期代签被挑战校验阻断且零误扣', () => {
    const snapshot = loadSnapshot(DIR)
    const events = snapshot.events

    const calls = events.filter((event) => event.type === 'tool/call')
    const names = calls.map((event) => (event.data as { name?: string }).name ?? '')
    expect(names.filter((name) => name === 'transfer_schedule')).toHaveLength(1)
    expect(names.filter((name) => name === 'fund_lock')).toHaveLength(3)

    // 武装宽档窗口前必须完成一次强验证（否则 preauthOf 返回 undefined，工具会抛错）
    expect(events.filter((event) => event.type === 'approval/challenge-issued').length).toBeGreaterThan(0)

    // 只有 fund_lock 的两笔内部划转真的动了账；定时转账到期**没有**产生第三笔
    // （见下面的安全失败断言——这条"零误扣"是本场景最重要的负向证据）。
    expect(events.filter((event) => event.type === 'transfer/created')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'plan/created')).toHaveLength(1)

    // 到期代签：票据在**签发时**就带 window 授权来源（`ticket/issued` 是唯一携带它的
    // 事件；`ticket/approved` 只有票据 ID，因为本次代签随后被挑战校验阻断）。
    const issued = events.filter((event) => event.type === 'ticket/issued')
    const windowIssued = issued.filter(
      (event) => (event.data as { authorization?: { kind?: string } }).authorization?.kind === 'window',
    )
    expect(windowIssued).toHaveLength(1)

    /*
     * 到期代签的真实语义（2026-11-15 实测，已登记为待修缺陷 F-01）：
     *
     * `transfer_schedule` 武装时做了强验证，但 `TicketAuthorization` 只有
     * `{kind, ref, digest}`，没有承载 challenge 的字段；窗口到期执行
     * `transfer_create`（红级）时，审批服务只能判定 `challenge-required` 并阻断。
     * 结果是"窗口执行了、计划失败了、钱没动"——安全方向正确，但不是"到期必成功"。
     *
     * 这条断言刻意钉死当前行为：谁把窗口代签改成"无凭据也放行"，这里立刻红。
     */
    const wakeResults = events.filter(
      (event) => event.type === 'tool/result' && (event.data as { name?: string }).name === 'plan_wake',
    )
    expect(wakeResults).toHaveLength(1)
    expect(readReport(wakeResults[0]!).entries[0]?.status).toBe('executed')

    const completed = events.filter((event) => event.type === 'plan/completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.data).toMatchObject({ status: 'failed', failed: 1, succeeded: 0 })

    const nodeResult = events.filter((event) => event.type === 'plan/node-result')
    expect(nodeResult).toHaveLength(1)
    expect(nodeResult[0]?.data).toMatchObject({ status: 'failed', code: 'approval-rejected' })

    const blocked = events.filter((event) => event.type === 'ticket/blocked')
    expect(blocked).toHaveLength(1)
    expect(blocked[0]?.data).toMatchObject({ reason: 'challenge-required' })
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
