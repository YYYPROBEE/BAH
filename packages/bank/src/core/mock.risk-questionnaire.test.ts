/**
 * 风险问卷实例（C-03 的服务端一半）：下发 / 过期 / 越权 / 非法选项 / 齐全性 / 一次性核销。
 *
 * 断言口径：只看**可证伪的事实**——等级有没有变、问卷还能不能用、错误码是哪一个。
 * 不测"实现细节"（比如内部 Map 的键），那些改了不该让用例红。
 */

import { describe, expect, it } from 'vitest'

import { captureRejection } from '@bah/test-support'

import { buildBankDataset, DEMO_NOW } from '../forge/index.ts'
import { MockBankCore } from './mock.ts'
import { bankIds } from './model.ts'
import {
  RISK_QUESTION_COUNT,
  RISK_QUESTIONNAIRE_TTL_MS,
  RISK_QUESTIONS,
  type RiskQuestionnaire,
} from './risk-questionnaire.ts'

const USER = bankIds.user('u-1')
const OTHER = bankIds.user('u-2')

/** 可控时钟的核心（过期用例要把钟推过 TTL；冷却用例注入 `cooldownMs`）。 */
function setup(options: { readonly cooldownMs?: number } = {}): {
  readonly core: MockBankCore
  readonly advance: (ms: number) => void
} {
  let now = DEMO_NOW
  const core = new MockBankCore({
    data: buildBankDataset({ seed: 1 }),
    now: () => now,
    ...(options.cooldownMs === undefined ? {} : { riskCooldownMs: options.cooldownMs }),
  })
  return {
    core,
    advance: (ms) => {
      now += ms
    },
  }
}

/** 把整张卷答成同一档（测试里的"用户作答"）。 */
function answerAll(
  questionnaire: RiskQuestionnaire,
  key: 'conservative' | 'middle' | 'aggressive',
): { readonly index: number; readonly key: string }[] {
  return questionnaire.questions.map((question) => ({ index: question.index, key }))
}

describe('问卷下发（只读分支）', () => {
  it('5 题 × 3 选项，分值 1/3/5；题干来自常量表且返回副本', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)

    expect(questionnaire.questions).toHaveLength(RISK_QUESTION_COUNT)
    expect(questionnaire.questions.map((question) => question.index)).toEqual([1, 2, 3, 4, 5])
    for (const question of questionnaire.questions) {
      expect(question.options.map((option) => option.key)).toEqual([
        'conservative',
        'middle',
        'aggressive',
      ])
      expect(question.options.map((option) => option.score)).toEqual([1, 3, 5])
      expect(question.title.length).toBeGreaterThan(0)
    }
    expect(questionnaire.expiresAt).toBe(questionnaire.issuedAt + RISK_QUESTIONNAIRE_TTL_MS)

    // 改返回值不能污染常量表（否则下一张卷的题干会带着上一次的改动）
    ;(questionnaire.questions[0] as { title: string }).title = '被改过的题干'
    const fresh = await core.issueRiskQuestions(USER)
    expect(fresh.questions[0]?.title).toBe(RISK_QUESTIONS[0]?.title)
  })

  it('下发不改等级；未知用户不发卷', async () => {
    const { core } = setup()
    const before = (await core.getUser(USER))?.riskGrade
    await core.issueRiskQuestions(USER)
    expect((await core.getUser(USER))?.riskGrade).toBe(before)

    expect((await captureRejection(() => core.issueRiskQuestions(bankIds.user('u-x')))).code).toBe(
      'user-unknown',
    )
  })

  it('每次下发都是新实例（ID 唯一），互不覆盖', async () => {
    const { core } = setup()
    const first = await core.issueRiskQuestions(USER)
    const second = await core.issueRiskQuestions(USER)
    expect(first.id).not.toBe(second.id)
    expect(await core.getRiskQuestionnaire(first.id)).toBeDefined()
    expect(await core.getRiskQuestionnaire(second.id)).toBeDefined()
    // 取卷不改状态：两张都还在（提交任意一张都不影响另一张的存在性）
    expect(core.tickets.size).toBe(0)
  })
})

describe('提交与落档', () => {
  it('全选最激进 → 25 分 → R5；返回问卷 ID / 版本 / 逐题键', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const before = (await core.getUser(USER))?.riskGrade
    const result = await core.assessRisk({
      userId: USER,
      questionnaireId: questionnaire.id,
      answers: answerAll(questionnaire, 'aggressive'),
    })

    expect(result).toMatchObject({
      questionnaireId: questionnaire.id,
      version: questionnaire.version,
      score: 25,
      from: before,
      to: 'R5',
    })
    expect(result.answers.map((answer) => answer.index)).toEqual([1, 2, 3, 4, 5])
    expect((await core.getUser(USER))?.riskGrade).toBe('R5')
  })

  it('全选最保守 → 5 分 → R1；分数带沿用既有阈值', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const result = await core.assessRisk({
      userId: USER,
      questionnaireId: questionnaire.id,
      answers: answerAll(questionnaire, 'conservative'),
    })
    expect(result.score).toBe(5)
    expect(result.to).toBe('R1')
  })

  it('中档全选 → 15 分 → R3（阈值边界不漂移）', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const result = await core.assessRisk({
      userId: USER,
      questionnaireId: questionnaire.id,
      answers: answerAll(questionnaire, 'middle'),
    })
    expect(result.score).toBe(15)
    expect(result.to).toBe('R3')
  })

  it('一次性凭证：同一张卷提交两次 → 第二次 risk-questionnaire-unknown', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const answers = answerAll(questionnaire, 'middle')
    await core.assessRisk({ userId: USER, questionnaireId: questionnaire.id, answers })

    const replay = await captureRejection(() =>
      core.assessRisk({ userId: USER, questionnaireId: questionnaire.id, answers }),
    )
    expect(replay.code).toBe('risk-questionnaire-unknown')
    // 重放不改等级：第二次仍是 R3（第一次的结果），没有被第二遍写成别的值
    expect((await core.getUser(USER))?.riskGrade).toBe('R3')
  })
})

describe('重测冷却（R-2）', () => {
  it('冷却内再提交 → risk-retest-cooldown；等级不变、卷不被消耗，冷却后同一张卷仍可用', async () => {
    const { core, advance } = setup({ cooldownMs: 60_000 })
    const first = await core.issueRiskQuestions(USER)
    await core.assessRisk({
      userId: USER,
      questionnaireId: first.id,
      answers: answerAll(first, 'aggressive'),
    })
    expect((await core.getUser(USER))?.riskGrade).toBe('R5')

    advance(30_000)
    const second = await core.issueRiskQuestions(USER)
    const blocked = await captureRejection(() =>
      core.assessRisk({
        userId: USER,
        questionnaireId: second.id,
        answers: answerAll(second, 'conservative'),
      }),
    )
    expect(blocked.code).toBe('risk-retest-cooldown')
    // 冷却只拦"再落档"，不拦"已落档的那一次"：等级仍是第一次的 R5，没被刷回 R1
    expect((await core.getUser(USER))?.riskGrade).toBe('R5')
    // 卷不被消耗：冷却过去后同一张卷仍然能提交（前提是没超过 15 分钟问卷 TTL）
    expect(await core.getRiskQuestionnaire(second.id)).toBeDefined()

    advance(31_000)
    expect(
      await core.assessRisk({
        userId: USER,
        questionnaireId: second.id,
        answers: answerAll(second, 'conservative'),
      }),
    ).toMatchObject({ to: 'R1' })
  })

  it('失败的提交不启动冷却：答错一题（不齐全）后立刻合法提交仍然通过', async () => {
    const { core } = setup({ cooldownMs: 60_000 })
    const questionnaire = await core.issueRiskQuestions(USER)
    const full = answerAll(questionnaire, 'middle')

    const broken = await captureRejection(() =>
      core.assessRisk({ userId: USER, questionnaireId: questionnaire.id, answers: full.slice(0, 4) }),
    )
    expect(broken.code).toBe('risk-questionnaire-incomplete')

    // 同一时刻（钟没动）合法提交：冷却没有因为上一次失败而提前启动
    expect(
      await core.assessRisk({ userId: USER, questionnaireId: questionnaire.id, answers: full }),
    ).toMatchObject({ to: 'R3' })
  })

  it('cooldownMs = 0（缺省）→ 不拦：两次落档可以连续发生', async () => {
    const { core } = setup()
    const first = await core.issueRiskQuestions(USER)
    await core.assessRisk({
      userId: USER,
      questionnaireId: first.id,
      answers: answerAll(first, 'aggressive'),
    })
    const second = await core.issueRiskQuestions(USER)
    expect(
      await core.assessRisk({
        userId: USER,
        questionnaireId: second.id,
        answers: answerAll(second, 'conservative'),
      }),
    ).toMatchObject({ to: 'R1' })
  })
})

describe('五道校核（顺序即安全边界）', () => {
  it('问卷不存在 → risk-questionnaire-unknown，等级不变', async () => {
    const { core } = setup()
    const before = (await core.getUser(USER))?.riskGrade
    const unknown = await captureRejection(() =>
      core.assessRisk({
        userId: USER,
        questionnaireId: 'rq-does-not-exist',
        answers: RISK_QUESTIONS.map((question) => ({
          index: question.index,
          key: 'middle',
        })),
      }),
    )
    expect(unknown.code).toBe('risk-questionnaire-unknown')
    expect((await core.getUser(USER))?.riskGrade).toBe(before)
  })

  it('跨用户：拿别人的问卷 ID → 与"不存在"同码（防枚举），等级不变', async () => {
    const { core } = setup()
    const mine = await core.issueRiskQuestions(USER)
    const otherBefore = (await core.getUser(OTHER))?.riskGrade

    const stolen = await captureRejection(() =>
      core.assessRisk({
        userId: OTHER,
        questionnaireId: mine.id,
        answers: answerAll(mine, 'aggressive'),
      }),
    )
    // 不能返回 -expired / -incomplete：那两个码会泄露"这张卷真实存在"
    expect(stolen.code).toBe('risk-questionnaire-unknown')
    expect((await core.getUser(OTHER))?.riskGrade).toBe(otherBefore)
    // 卷没被消耗：本人仍可正常提交
    expect(
      await core.assessRisk({
        userId: USER,
        questionnaireId: mine.id,
        answers: answerAll(mine, 'aggressive'),
      }),
    ).toMatchObject({ to: 'R5' })
  })

  it('过期 → risk-questionnaire-expired，不落档', async () => {
    const { core, advance } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const before = (await core.getUser(USER))?.riskGrade

    advance(RISK_QUESTIONNAIRE_TTL_MS + 1)
    const expired = await captureRejection(() =>
      core.assessRisk({
        userId: USER,
        questionnaireId: questionnaire.id,
        answers: answerAll(questionnaire, 'aggressive'),
      }),
    )
    expect(expired.code).toBe('risk-questionnaire-expired')
    expect((await core.getUser(USER))?.riskGrade).toBe(before)
  })

  it('到期边界：恰好等于 expiresAt 仍可提交（"过期"是严格大于）', async () => {
    const { core, advance } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    advance(RISK_QUESTIONNAIRE_TTL_MS)
    const result = await core.assessRisk({
      userId: USER,
      questionnaireId: questionnaire.id,
      answers: answerAll(questionnaire, 'middle'),
    })
    expect(result.to).toBe('R3')
  })

  it('不齐全：少答 / 多答 / 重复题 → risk-questionnaire-incomplete', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const full = answerAll(questionnaire, 'middle')

    expect(
      (
        await captureRejection(() =>
          core.assessRisk({
            userId: USER,
            questionnaireId: questionnaire.id,
            answers: full.slice(0, 4),
          }),
        )
      ).code,
    ).toBe('risk-questionnaire-incomplete')

    expect(
      (
        await captureRejection(() =>
          core.assessRisk({
            userId: USER,
            questionnaireId: questionnaire.id,
            answers: [...full, { index: 6, key: 'middle' }],
          }),
        )
      ).code,
    ).toBe('risk-questionnaire-incomplete')

    // 同一题重复两次 + 少一题：条数是对的（5 条），但覆盖不全
    expect(
      (
        await captureRejection(() =>
          core.assessRisk({
            userId: USER,
            questionnaireId: questionnaire.id,
            answers: [
              { index: 1, key: 'middle' },
              { index: 1, key: 'middle' },
              { index: 2, key: 'middle' },
              { index: 3, key: 'middle' },
              { index: 4, key: 'middle' },
            ],
          }),
        )
      ).code,
    ).toBe('risk-questionnaire-incomplete')
  })

  it('选项不属于该题 → risk-questionnaire-option-invalid', async () => {
    const { core } = setup()
    const questionnaire = await core.issueRiskQuestions(USER)
    const answers = answerAll(questionnaire, 'middle')
    const tampered = answers.map((answer, position) =>
      position === 2 ? { index: answer.index, key: 'radical' } : answer,
    )

    expect(
      (
        await captureRejection(() =>
          core.assessRisk({ userId: USER, questionnaireId: questionnaire.id, answers: tampered }),
        )
      ).code,
    ).toBe('risk-questionnaire-option-invalid')
  })
})
