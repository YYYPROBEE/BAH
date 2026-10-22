/**
 * 用**真实会话日志**回归投影层（不是手搓夹具）。
 *
 * 为什么这条用例比 `project.test.ts` 更值钱：
 * 手写事件只能证明"我以为日志长这样"；这条读的是 `snapshots/web-channel/session.jsonl`
 * ——由真 bank 插件、真审批、真票据落账产生。它同时钉住了三件容易漂的事：
 *
 * 1. **金额单位**：`approval/asked.amount = 800` 是**元**（bank governance 写 `amountCents / 100`），
 *    若哪天渠道改回"按分格式化"，这里会红成 `¥8.00`（R-WEB-D9）；
 * 2. **领域事件不炸**：`transfer/created`、`tier/decided`、`read/*` 等不在平台事件表里，
 *    投影器必须忽略而不是抛错；
 * 3. **确定性**：同一份日志两次投影必须深度相等（T-WEB-007 的真实数据版本）。
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import type { ApprovalClosedFrame, ApprovalFrame, AuditFrame, DagFrame, ToolFrame } from './frames.ts'
import { projectSession } from './project.ts'

/** 真实快照（`snapshots/web-channel`，施工单 13 的 T-WEB-010 场景）。 */
const SNAPSHOT = new URL('../../../../snapshots/web-channel/session.jsonl', import.meta.url)

/** 读日志：首行是 header，其余是事件。 */
function loadEvents(): AnySessionEvent[] {
  const lines = readFileSync(SNAPSHOT, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)

  return lines.filter((line) => line['kind'] !== 'bah-session-header') as unknown as AnySessionEvent[]
}

describe('真实日志投影（snapshots/web-channel）', () => {
  it('审批帧六要素来自真日志：¥800.00 / 王建国 / 黄级', () => {
    const { frames } = projectSession(loadEvents(), 's-snapshot-web-channel')
    const approval = frames.find((frame) => frame.kind === 'approval') as ApprovalFrame

    expect(approval.ticketId).toBe('ticket:call-create')
    expect(approval.operation).toBe('转账')
    // 800 元（不是 8 元）：日志里 amount=800，渠道必须按元解释
    expect(approval.amountText).toBe('¥800.00')
    expect(approval.payeeName).toBe('王建国')
    expect(approval.tier).toBe('yellow')
    expect(approval.amountConfirmed).toBe(false)
    expect(approval.rejectReasonRequired).toBe(true)
  })

  it('工具卡拿到真结果：三态收口 + 金额已确认 + 正文可追票据', () => {
    const { frames } = projectSession(loadEvents())
    // 演示改为"预览 → 执行"两步后，第一个工具帧是只读预览（绿级）；
    // 要断言的是真正扣款的那张卡，所以按 name 取而不是取第一个
    const tool = frames.find(
      (frame) => frame.kind === 'tool' && (frame as ToolFrame).name === 'transfer_create',
    ) as ToolFrame

    expect(tool.state).toBe('done')
    expect(tool.amountConfirmed).toBe(true)
    expect(tool.tier).toBe('yellow')
    expect(tool.card?.fields.find((field) => field.amount)?.value).toBe('¥800.00')
    expect(tool.card?.body ?? '').toContain('ticket:call-create')
    expect(tool.card?.body ?? '').toContain('转账成功')
  })

  it('审计时间线含完整票据生命周期', () => {
    const { frames } = projectSession(loadEvents())
    const labels = (frames.filter((frame) => frame.kind === 'audit') as AuditFrame[]).map(
      (frame) => frame.label,
    )

    expect(labels).toEqual(
      expect.arrayContaining(['审批请求', '票据已签发', '票据已批准', '审批结论', '工具完成', '票据已核销', '票据已消费']),
    )
  })

  it('DAG 用真 tier 与真结果：黄级的执行调用、状态 ok', () => {
    const { frames } = projectSession(loadEvents())
    const dag = frames.filter((frame) => frame.kind === 'dag').pop() as DagFrame
    // 预览是绿级、执行是黄级：按标签取"执行"那一节点（演示两步后不再只有一个 call）
    const call = dag.nodes.find((node) => node.kind === 'call' && node.label.includes('transfer_create'))

    expect(call?.tier).toBe('yellow')
    expect(call?.state).toBe('ok')
    expect(dag.summary).toContain('第 1 轮')
  })

  it('领域事件（transfer/created、tier/decided、read/*）不炸、不产帧', () => {
    const events = loadEvents()
    const domain = events.filter((event) =>
      ['transfer/created', 'tier/decided'].includes(String(event.type)),
    )
    expect(domain.length).toBeGreaterThan(0)

    const { frames } = projectSession(events)
    // 只允许出现已知帧类型（未知领域事件不得被当成"未知帧"混进界面）
    const kinds = new Set(frames.map((frame) => frame.kind))
    for (const kind of kinds) {
      expect(['turn', 'message', 'tool', 'approval', 'approval-closed', 'notice', 'audit', 'dag']).toContain(kind)
    }
  })

  it('同一份日志两次投影深度相等（确定性）', () => {
    const first = projectSession(loadEvents())
    const second = projectSession(loadEvents())
    expect(first.frames).toEqual(second.frames)
    expect(first.maxSeq).toBe(second.maxSeq)
  })

  it('审批结论帧是 allowed-once（不是"无人应答"）', () => {
    const { frames } = projectSession(loadEvents())
    const closed = frames.find((frame) => frame.kind === 'approval-closed') as ApprovalClosedFrame
    expect(closed.decision).toBe('allowed-once')
    expect(closed.label).toBe('已批准（一次性）')
  })
})
