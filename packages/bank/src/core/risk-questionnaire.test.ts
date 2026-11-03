/**
 * 风险问卷实例库（`RiskQuestionnaireBook`）的判定边界。
 *
 * 已有用例（`mock.risk-questionnaire.test.ts`）走的是"账本 + 工具"的整链路；
 * 本文件只打三个**没有别的入口能到达**的分支：
 * - 提交时主体已经不存在（发卷与落档之间用户被摘掉）；
 * - 题号不在问卷里（越界题号不得被当成"缺答案"或更糟——被当成合法答案）；
 * - 未核销实例数这条可观测性口径。
 *
 * 纪律：时钟与主体读写全部注入，无随机、无 `Date.now()`。
 */

import { captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { bankIds } from './index.ts'
import type { RiskGrade } from './model.ts'
import { RiskQuestionnaireBook } from './risk-questionnaire.ts'

/** 一份可拨动的世界：卷库的读写都打到这张表上，测试自己推时钟、自己摘用户。 */
function fixture() {
  const grades = new Map<string, RiskGrade>([['u-1', 'R2']])
  const book = new RiskQuestionnaireBook({
    now: () => 1_700_000_000_000,
    readRiskGrade: (userId) => grades.get(String(userId)),
    writeRiskGrade: (userId, grade) => {
      grades.set(String(userId), grade)
    },
  })
  return { book, grades, user: bankIds.user('u-1') }
}

/** 五题满额作答（aggressive = 5 分 × 5 题 = 25 → R5）。 */
const ALL_AGGRESSIVE = [1, 2, 3, 4, 5].map((index) => ({ index, key: 'aggressive' }))

describe('风险问卷实例库：判定边界', () => {
  it('提交时主体已不存在 ⇒ user-unknown，不落档、不核销问卷', () => {
    const grades = new Map<string, RiskGrade>([['u-1', 'R2']])
    // 发卷时读得到等级、提交时读不到：这就是"发卷之后用户被摘掉"那一臂
    let revoked = false
    const book = new RiskQuestionnaireBook({
      now: () => 1_700_000_000_000,
      readRiskGrade: (userId) => (revoked ? undefined : grades.get(String(userId))),
      writeRiskGrade: (userId, grade) => {
        grades.set(String(userId), grade)
      },
    })

    const questionnaire = book.issue(bankIds.user('u-1'))
    revoked = true

    const error = captureThrown(() =>
      book.assess({
        userId: bankIds.user('u-1'),
        questionnaireId: questionnaire.id,
        answers: ALL_AGGRESSIVE,
      }),
    )
    expect(error.code).toBe('user-unknown')
    // 失败不消耗凭证：卷仍在，用户换一条合法路径还能重答
    expect(book.get(questionnaire.id)).toBeDefined()
    expect(grades.get('u-1')).toBe('R2')
  })

  it('题号越界 ⇒ incomplete（既不静默丢弃，也不当成合法答案）', () => {
    const f = fixture()
    const questionnaire = f.book.issue(f.user)

    const error = captureThrown(() =>
      f.book.assess({
        userId: f.user,
        questionnaireId: questionnaire.id,
        // 五条作答（数量对得上）但第 6 题不存在于问卷里
        answers: [
          { index: 1, key: 'conservative' },
          { index: 2, key: 'middle' },
          { index: 3, key: 'aggressive' },
          { index: 4, key: 'middle' },
          { index: 6, key: 'middle' },
        ],
      }),
    )
    expect(error.code).toBe('risk-questionnaire-incomplete')
    expect(error.detail).toMatchObject({ index: 6 })
    expect(f.grades.get('u-1')).toBe('R2')

    // 题号为 0 同样越界：不能因为"看起来是整数"就被放过
    expect(
      captureThrown(() =>
        f.book.assess({
          userId: f.user,
          questionnaireId: questionnaire.id,
          answers: [
            { index: 0, key: 'middle' },
            { index: 1, key: 'middle' },
            { index: 2, key: 'middle' },
            { index: 3, key: 'middle' },
            { index: 4, key: 'middle' },
          ],
        }),
      ).detail,
    ).toMatchObject({ index: 0 })
  })

  it('size() 只数"已签发且未核销"：核销后回落', () => {
    const f = fixture()
    expect(f.book.size()).toBe(0)

    const first = f.book.issue(f.user)
    const second = f.book.issue(f.user)
    expect(f.book.size()).toBe(2)

    f.book.assess({ userId: f.user, questionnaireId: first.id, answers: ALL_AGGRESSIVE })
    expect(f.book.size()).toBe(1)

    // 同一用户的两张卷各自独立核销（不存在"后发覆盖先发"）
    f.book.assess({ userId: f.user, questionnaireId: second.id, answers: ALL_AGGRESSIVE })
    expect(f.book.size()).toBe(0)
  })
})
