/**
 * `risk_assess` 的动作语义（C-03）：取卷不写库 / 提交必须走票据 / 审计带确认凭证。
 *
 * 与 `mock.risk-questionnaire.test.ts` 的分工：
 * - 那边测**核心**（五道校核、过期、跨用户）；
 * - 这边测**工具与管线**（tier 豁免、票据核销、事件载荷、details）。
 */

import { describe, expect, it } from 'vitest'

import type { TicketId } from '@bah/core'

import { bankIds, RISK_QUESTIONS } from '../core/index.ts'
import type { RiskQuestionsResult, RiskSubmitResult } from './dto.ts'
import { createPipelineHarness } from './testing.ts'

/** 取某类会话事件的载荷。 */
function payloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness
    .events()
    .filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

/** 取某类领域审计事件的载荷。 */
function auditPayloads(
  harness: ReturnType<typeof createPipelineHarness>,
  type: string,
): Record<string, unknown>[] {
  return harness.audits
    .filter((record) => record.type === type)
    .map((record) => record.data as Record<string, unknown>)
}

/** 取一张卷并把 5 题都答成指定档，返回 submit 的入参。 */
async function takeAndAnswer(
  harness: ReturnType<typeof createPipelineHarness>,
  key: 'conservative' | 'middle' | 'aggressive',
): Promise<Readonly<Record<string, unknown>>> {
  const issued = await harness.run('risk_assess', { action: 'questions' })
  expect(issued.result.isError).toBe(false)
  const questionnaire = issued.value as RiskQuestionsResult
  return {
    action: 'submit',
    questionnaireId: questionnaire.questionnaireId,
    answers: questionnaire.questions.map((question) => ({ index: question.index, key })),
  }
}

describe('action="questions"：只读分支', () => {
  it('不签票据、不改等级、不落 risk/assessed，只落 read/risk-questions', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('risk_assess', { action: 'questions' })
      expect(execution.result.isError).toBe(false)
      const result = execution.value as RiskQuestionsResult
      expect(result.action).toBe('questions')
      expect(result.questions).toHaveLength(5)
      expect(result.questionnaireId).toMatch(/^rq-/)

      // 只读动作豁免：没有审批、没有票据
      expect(payloads(h, 'approval/asked')).toHaveLength(0)
      expect(h.core.tickets.size).toBe(0)
      // 等级不变
      expect((await h.core.getUser(bankIds.user('u-1')))?.riskGrade).toBe('R2')
      // 审计：tier 判决按 green + declared，问卷快照单独一条
      expect(auditPayloads(h, 'tier/decided')[0]).toMatchObject({
        name: 'risk_assess',
        level: 'green',
        verdict: 'allow',
        reason: 'declared',
      })
      const questions = auditPayloads(h, 'read/risk-questions')
      expect(questions).toHaveLength(1)
      expect(questions[0]).toMatchObject({ version: result.version, currentGrade: 'R2' })
      expect(questions[0]?.['questions']).toHaveLength(5)
      expect(auditPayloads(h, 'risk/assessed')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('同一 turn 内连取两次卷：两张都可用（互不覆盖）', async () => {
    const h = createPipelineHarness()
    try {
      const first = (await h.run('risk_assess', { action: 'questions' })).value as RiskQuestionsResult
      const second = (await h.run('risk_assess', { action: 'questions' })).value as RiskQuestionsResult
      expect(first.questionnaireId).not.toBe(second.questionnaireId)
      expect(await h.core.getRiskQuestionnaire(first.questionnaireId)).toBeDefined()
      expect(await h.core.getRiskQuestionnaire(second.questionnaireId)).toBeDefined()
    } finally {
      await h.dispose()
    }
  })
})

describe('action="submit"：写分支', () => {
  it('必须走审批：一张票、5 条明细 + 得分 + 等级变更；批准后落档并记确认凭证', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const args = await takeAndAnswer(h, 'aggressive')
      const execution = await h.run('risk_assess', args)
      expect(execution.result.isError).toBe(false)
      const result = execution.value as RiskSubmitResult
      expect(result).toMatchObject({ action: 'submit', score: 25, from: 'R2', to: 'R5' })

      // 一张票（黄级 ask），核销后 consumed
      const asked = payloads(h, 'approval/asked')
      expect(asked).toHaveLength(1)
      expect(asked[0]).toMatchObject({ name: 'risk_assess' })
      expect(h.core.tickets.status(asked[0]?.['ticketId'] as TicketId)).toBe('redeemed')

      // 审批明细：5 题 + 得分 + 等级变化。
      // 题干必须**逐字等于服务端常量表**（独立来源断言，不是拿 details 自证），
      // 否则"用户确认的是哪 5 道题"就无法证明。
      const details = asked[0]?.['details'] as readonly { label: string; value: string }[]
      expect(details).toHaveLength(7)
      expect(details.slice(0, 5).map((row) => row.label)).toEqual(
        RISK_QUESTIONS.map((question) => question.title),
      )
      expect(details[0]?.value).toBe('3 年以上（5 分）')
      expect(details[5]).toMatchObject({ label: '得分' })
      expect(details[5]?.value).toContain('25')
      expect(details[6]?.label).toContain('等级变更')
      expect(details[6]?.value).toBe('R2 → R5')

      // 落档审计：确认凭证三件套齐全
      const assessed = auditPayloads(h, 'risk/assessed')
      expect(assessed).toHaveLength(1)
      expect(assessed[0]).toMatchObject({
        confirmedBy: 'approval-ticket',
        ticketRef: asked[0]?.['ticketId'],
        version: result.version,
      })
      expect(assessed[0]?.['questionnaireId']).toBe(result.questionnaireId)
      expect(assessed[0]?.['answers']).toHaveLength(5)

      // 核心主数据已变
      expect((await h.core.getUser(bankIds.user('u-1')))?.riskGrade).toBe('R5')
    } finally {
      await h.dispose()
    }
  })

  it('不先取卷直接提交 → risk-questionnaire-unknown，等级不变', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('risk_assess', {
        action: 'submit',
        questionnaireId: 'rq-forged',
        answers: [
          { index: 1, key: 'aggressive' },
          { index: 2, key: 'aggressive' },
          { index: 3, key: 'aggressive' },
          { index: 4, key: 'aggressive' },
          { index: 5, key: 'aggressive' },
        ],
      })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('risk-questionnaire-unknown')
      expect((await h.core.getUser(bankIds.user('u-1')))?.riskGrade).toBe('R2')
      expect(auditPayloads(h, 'risk/assessed')).toHaveLength(0)
    } finally {
      await h.dispose()
    }
  })

  it('跨用户：另一个会话拿本人的问卷 ID → 拒绝，原用户等级不变', async () => {
    const owner = createPipelineHarness({ sessionId: 's-owner', approval: 'allowed-once' })
    const intruder = createPipelineHarness({
      sessionId: 's-intruder',
      identity: { resolve: () => 'u-2' },
      core: owner.core,
      callIdPrefix: 'i-',
      approval: 'allowed-once',
    })
    try {
      const issued = (await owner.run('risk_assess', { action: 'questions' })).value as RiskQuestionsResult
      const execution = await intruder.run('risk_assess', {
        action: 'submit',
        questionnaireId: issued.questionnaireId,
        answers: issued.questions.map((question) => ({ index: question.index, key: 'aggressive' })),
      })
      expect(execution.result.isError).toBe(true)
      expect(execution.result.code).toBe('risk-questionnaire-unknown')
      expect((await owner.core.getUser(bankIds.user('u-1')))?.riskGrade).toBe('R2')
      expect((await owner.core.getUser(bankIds.user('u-2')))?.riskGrade).not.toBe('R5')
      // 卷未被消耗：本人仍可正常提交
      const own = await owner.run('risk_assess', {
        action: 'submit',
        questionnaireId: issued.questionnaireId,
        answers: issued.questions.map((question) => ({ index: question.index, key: 'conservative' })),
      })
      expect(own.result.code).toBeUndefined()
      expect((own.value as RiskSubmitResult).to).toBe('R1')
    } finally {
      await intruder.dispose()
      await owner.dispose()
    }
  })
})

describe('重测冷却（R-2）：工具层的用户可读文案', () => {
  it('冷却内再提交 → 同一个理由码 + 「距上次测评不足 24 小时，请在 24 小时后重试」，等级与卷都不动', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const first = await takeAndAnswer(h, 'aggressive')
      const firstRun = await h.run('risk_assess', first)
      expect(firstRun.result.isError).toBe(false)
      expect((firstRun.value as RiskSubmitResult).to).toBe('R5')

      const second = await takeAndAnswer(h, 'conservative')
      const blocked = await h.run('risk_assess', second)
      expect(blocked.result.isError).toBe(true)
      expect(blocked.result.code).toBe('risk-retest-cooldown')
      // 文案逐字（施工单 6-1 第 4 条）：不是把核心的内部 message 直接漏给用户
      expect(blocked.result.reason).toBe('距上次测评不足 24 小时，请在 24 小时后重试')
      // 冷却拦在落档之前：等级仍是第一次的 R5
      expect((await h.core.getUser(bankIds.user('u-1')))?.riskGrade).toBe('R5')
      // 卷没被消耗（冷却过后仍可拿它提交，只要没超过问卷 TTL）
      expect(
        await h.core.getRiskQuestionnaire(String(second['questionnaireId'])),
      ).toBeDefined()
    } finally {
      await h.dispose()
    }
  })

  it('配置 riskCooldownDays=0 → 不拦：同一会话连续两次提交都落档', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once', config: { riskCooldownDays: 0 } })
    try {
      const first = await takeAndAnswer(h, 'aggressive')
      expect((await h.run('risk_assess', first)).value).toMatchObject({ to: 'R5' })

      const second = await takeAndAnswer(h, 'conservative')
      const again = await h.run('risk_assess', second)
      expect(again.result.isError).toBe(false)
      expect((again.value as RiskSubmitResult).to).toBe('R1')
    } finally {
      await h.dispose()
    }
  })

  it('其它错误不被翻译：不先取卷直接提交仍报核心原文（不吞错、不改码）', async () => {
    const h = createPipelineHarness({ approval: 'allowed-once' })
    try {
      const execution = await h.run('risk_assess', {
        action: 'submit',
        questionnaireId: 'rq-forged',
        answers: RISK_QUESTIONS.map((question) => ({ index: question.index, key: 'middle' })),
      })
      expect(execution.result.code).toBe('risk-questionnaire-unknown')
      expect(execution.result.reason).toContain('问卷不存在')
    } finally {
      await h.dispose()
    }
  })
})

