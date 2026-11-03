/**
 * `bah audit` 文本输出里的**审批行**（03 TA-46）。
 *
 * 这一行是给人看的"谁批的"，所以三种形状必须互不混淆：
 * 有人批 → userId；机器批（超时 / 无人值守）→ `machine`；只有尝试没有结论 → 未决。
 * 把机器决策渲染成人名，等于伪造审批痕迹。
 */
import { describe, expect, it } from 'vitest'

import { renderText, type AuditReport } from './audit.ts'

function render(approvals: readonly unknown[]): string {
  return renderText({
    dir: '/sessions',
    db: 'none',
    chains: [],
    anchors: [],
    reverseGaps: [],
    approvals,
    approvalWarnings: [],
    errors: [],
    dbState: 'missing',
    ok: true,
    exitCode: 0,
  } as unknown as AuditReport)
}

describe('renderText：审批行', () => {
  it('有结论但没有操作者 ⇒ machine（不冒充"有人批的"）', () => {
    expect(render([{ ticketId: 't-1', decision: 'allow', machine: true }])).toContain(
      '审批 t-1 → allow → machine',
    )
  })

  it('既没结论也没操作者 ⇒ 两栏都写未决', () => {
    expect(render([{ ticketId: 't-2', machine: false }])).toContain('审批 t-2 → 未决 → 未决')
  })

  it('有操作者 ⇒ 落 userId，优先于 machine 标记', () => {
    expect(
      render([{ ticketId: 't-3', decision: 'deny', machine: true, actor: { userId: 'u-9' } }]),
    ).toContain('审批 t-3 → deny → u-9')
  })
})
