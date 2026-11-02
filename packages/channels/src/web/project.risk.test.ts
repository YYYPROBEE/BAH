/**
 * 风险问卷的投影用例（C-03）：审批卡逐题回显 + 问卷卡。
 *
 * 纪律同 `project.test.ts`：只喂事件、断言帧；不碰 DOM、不读时钟。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { DETAILS_MAX_ROWS, WebProjector } from './project.ts'
import type { ApprovalFrame, RiskQuestionnaireFrame } from './frames.ts'

/** 造事件的游标。 */
let cursor = 0

function ev(type: string, data: unknown, at = 1_700_000_000_000): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

function reset(): void {
  cursor = 0
}

/** 服务端常量表的 5 道题（与 `core/risk-questionnaire.ts` 逐字一致）。 */
const QUESTIONS = [
  {
    index: 1,
    title: '您的投资经验有多久？',
    options: [
      { key: 'conservative', text: '没有投资经验', score: 1 },
      { key: 'middle', text: '1–3 年', score: 3 },
      { key: 'aggressive', text: '3 年以上', score: 5 },
    ],
  },
  {
    index: 2,
    title: '这笔钱大概多久不用？',
    options: [
      { key: 'conservative', text: '1 年内可能要用', score: 1 },
      { key: 'middle', text: '1–3 年不用', score: 3 },
      { key: 'aggressive', text: '3 年以上不用', score: 5 },
    ],
  },
  {
    index: 3,
    title: '您能接受的最大亏损是？',
    options: [
      { key: 'conservative', text: '不能接受亏损', score: 1 },
      { key: 'middle', text: '10% 以内', score: 3 },
      { key: 'aggressive', text: '30% 以上也能接受', score: 5 },
    ],
  },
  {
    index: 4,
    title: '您的收入稳定性如何？',
    options: [
      { key: 'conservative', text: '不稳定', score: 1 },
      { key: 'middle', text: '一般', score: 3 },
      { key: 'aggressive', text: '稳定且有结余', score: 5 },
    ],
  },
  {
    index: 5,
    title: '您这次投资的主要目标是？',
    options: [
      { key: 'conservative', text: '保住本金', score: 1 },
      { key: 'middle', text: '稳健增值', score: 3 },
      { key: 'aggressive', text: '追求高收益', score: 5 },
    ],
  },
] as const

describe('risk-questionnaire 帧（发卷）', () => {
  it('5 题全部进帧，题干 / 选项 / 分值逐字来自事件', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(
      ev('read/risk-questions', {
        callId: 'call-risk',
        questionnaireId: 'rq-1',
        version: 'risk-q/v1',
        issuedAt: 1_700_000_000_000,
        expiresAt: 1_700_000_900_000,
        currentGrade: 'R2',
        questions: QUESTIONS,
      }),
    )
    const frame = projector
      .frames()
      .find((item): item is RiskQuestionnaireFrame => item.kind === 'risk-questionnaire')
    expect(frame).toBeDefined()
    expect(frame).toMatchObject({ questionnaireId: 'rq-1', callId: 'call-risk', version: 'risk-q/v1' })
    expect(frame?.questions).toHaveLength(5)
    expect(frame?.questions.map((question) => question.title)).toEqual(
      QUESTIONS.map((question) => question.title),
    )
    expect(frame?.questions[0]?.options.map((option) => option.score)).toEqual([1, 3, 5])
  })

  it('形状不合格 → 整张卡不产（不显示半张问卷）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(ev('read/risk-questions', { questionnaireId: 'rq-1', questions: [] }))
    expect(projector.frames().some((item) => item.kind === 'risk-questionnaire')).toBe(false)
  })

  it('坏题被剔除、好题保留：题干为空的那题不显示', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(
      ev('read/risk-questions', {
        callId: 'call-risk',
        questionnaireId: 'rq-1',
        version: 'risk-q/v1',
        expiresAt: 1_700_000_900_000,
        currentGrade: 'R2',
        questions: [QUESTIONS[0], { index: 2, title: '   ', options: QUESTIONS[1].options }, QUESTIONS[2]],
      }),
    )
    const frame = projector
      .frames()
      .find((item): item is RiskQuestionnaireFrame => item.kind === 'risk-questionnaire')
    expect(frame?.questions.map((question) => question.index)).toEqual([1, 3])
  })
})

describe('审批卡 details（逐题回显）', () => {
  it('5 条题目 + 得分 + 等级变化原样进审批帧，顺序不变', () => {
    reset()
    const projector = new WebProjector()
    const details = [
      ...QUESTIONS.map((question) => ({
        label: question.title,
        value: `${question.options[2].text}（${String(question.options[2].score)} 分）`,
      })),
      { label: '得分', value: '25 分', emphasis: 'amount' },
      { label: '等级变更（批准后生效）', value: 'R2 → R5', emphasis: 'risk' },
    ]
    projector.apply(
      ev('tool/call', {
        callId: 'call-submit',
        name: 'risk_assess',
        args: { action: 'submit', questionnaireId: 'rq-1' },
        fingerprint: 'fp-risk',
        tier: { level: 'yellow' },
        at: 1_700_000_000_000,
      }),
    )
    projector.apply(
      ev('approval/asked', {
        ticketId: 'ticket:call-submit',
        callId: 'call-submit',
        name: 'risk_assess',
        details,
      }),
    )
    const frame = projector.frames().find((item): item is ApprovalFrame => item.kind === 'approval')
    expect(frame?.details).toHaveLength(7)
    expect(frame?.details?.slice(0, 5).map((row) => row.label)).toEqual(
      QUESTIONS.map((question) => question.title),
    )
    expect(frame?.details?.[5]).toMatchObject({ label: '得分', value: '25 分' })
    expect(frame?.details?.[6]).toMatchObject({ label: '等级变更（批准后生效）', value: 'R2 → R5' })
    expect(frame?.detailsTruncated).toBeUndefined()
  })

  it('超过展示上限 → 截断并标记（完整明细仍在事件里）', () => {
    reset()
    const projector = new WebProjector()
    const details = Array.from({ length: DETAILS_MAX_ROWS + 3 }, (_unused, index) => ({
      label: `第 ${String(index + 1)} 行`,
      value: 'x',
    }))
    projector.apply(
      ev('tool/call', {
        callId: 'call-many',
        name: 'risk_assess',
        args: { action: 'submit' },
        fingerprint: 'fp-many',
        tier: { level: 'yellow' },
        at: 1_700_000_000_000,
      }),
    )
    projector.apply(
      ev('approval/asked', {
        ticketId: 'ticket:call-many',
        callId: 'call-many',
        name: 'risk_assess',
        details,
      }),
    )
    const frame = projector.frames().find((item): item is ApprovalFrame => item.kind === 'approval')
    expect(frame?.details).toHaveLength(DETAILS_MAX_ROWS)
    expect(frame?.detailsTruncated).toBe(true)
  })

  it('缺 details → 帧上没有 details 键（不伪造空明细）', () => {
    reset()
    const projector = new WebProjector()
    projector.apply(
      ev('tool/call', {
        callId: 'call-plain',
        name: 'risk_assess',
        args: { action: 'submit' },
        fingerprint: 'fp-plain',
        tier: { level: 'yellow' },
        at: 1_700_000_000_000,
      }),
    )
    projector.apply(
      ev('approval/asked', { ticketId: 'ticket:call-plain', callId: 'call-plain', name: 'risk_assess' }),
    )
    const frame = projector.frames().find((item): item is ApprovalFrame => item.kind === 'approval')
    expect(frame).toBeDefined()
    expect(frame?.details).toBeUndefined()
  })
})
