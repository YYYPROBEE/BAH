/**
 * IM 文本出口的风险问卷投影（`risk-questionnaire` 帧 → 一条可复制的作答模板）。
 *
 * 为什么单独一组：`render.test.ts` 建在问卷帧出现之前，这条投影在台账里是
 * **整段未执行**（`riskQuestionnaireText` 零覆盖）。IM 没有表单控件，用户在微信里
 * 能照抄的只有这一串文本——它一旦变形（键换成序号、模板换行、ID 丢失），
 * 网关收回来的消息就再也解析不出作答，而表现是"用户答了但系统没反应"的静默失败。
 */

import { describe, expect, it } from 'vitest'

import type { RiskQuestionItem, RiskQuestionnaireFrame, WebFrame } from '../web/frames.ts'
import { projectImOutbound } from './render.ts'

const AT = 1_700_000_000_000

/** 一题三选项（分值口径与核心常量表一致：1 / 3 / 5）。 */
function question(index: number, title: string): RiskQuestionItem {
  return {
    index,
    title,
    options: [
      { key: 'conservative', text: `保守-${index}`, score: 1 },
      { key: 'middle', text: `稳健-${index}`, score: 3 },
      { key: 'aggressive', text: `进取-${index}`, score: 5 },
    ],
  }
}

function riskFrame(overrides: Partial<RiskQuestionnaireFrame> = {}): RiskQuestionnaireFrame {
  return {
    kind: 'risk-questionnaire',
    seq: 7,
    at: AT,
    callId: 'call-issue-1',
    questionnaireId: 'rq-9',
    version: 'risk-q/v1',
    expiresAt: AT + 15 * 60_000,
    questions: [
      question(1, '您的投资经验有多久？'),
      question(2, '这笔钱大概多久不用？'),
      question(3, '您能接受的最大亏损是？'),
      question(4, '您的收入稳定性如何？'),
      question(5, '您这次投资的主要目标是？'),
    ],
    ...overrides,
  }
}

/** 投影出唯一一条文本（多一条 / 少一条都说明帧被丢弃或重复出站）。 */
function onlyText(frame: WebFrame): string {
  const out = projectImOutbound([frame])
  expect(out).toHaveLength(1)
  const first = out[0]
  if (first === undefined || first.kind !== 'text') throw new Error('问卷帧必须投影出一条文本')
  return first.text
}

describe('IM 风险问卷投影', () => {
  it('问卷帧不进"表外帧"清单：投影出一条文本，逐题带题干与三个英文键', () => {
    const text = onlyText(riskFrame())
    const lines = text.split('\n')

    expect(lines[0]).toBe('【风险测评】共 5 题，请由本人逐题作答。')
    // 5 题 × (1 行题干 + 3 行选项) + 首行 + 模板行
    expect(lines).toHaveLength(1 + 5 * 4 + 1)
    expect(lines[1]).toBe('第 1 题 您的投资经验有多久？')
    expect(lines[2]).toBe('  · conservative = 保守-1（1 分）')
    expect(lines[3]).toBe('  · middle = 稳健-1（3 分）')
    expect(lines[4]).toBe('  · aggressive = 进取-1（5 分）')
    expect(lines[17]).toBe('第 5 题 您这次投资的主要目标是？')
  })

  it('末行是一条可整条复制的作答模板：带问卷 ID，键用英文而不是序号', () => {
    const lines = onlyText(riskFrame()).split('\n')
    const template = lines[lines.length - 1]

    // 模板必须单行（换行会让微信里复制出来变成多条消息，解析就断了）
    expect(template).not.toContain('\n')
    expect(template).toContain('风险测评作答 rq-9 ')
    expect(template).toContain('1=conservative 2=conservative 3=conservative 4=conservative 5=conservative')
    // 序号→键的映射只应存在于服务端常量表；这里把它写成数字就是第二份真相源
    expect(template).not.toMatch(/=\d/)
  })

  it('题数与问卷实际长度一致（不写死 5），缺 ID 或只有一题也照样成型', () => {
    const single = onlyText(
      riskFrame({ questionnaireId: 'rq-1', questions: [question(1, '第一题')] }),
    )
    expect(single.split('\n')[0]).toBe('【风险测评】共 1 题，请由本人逐题作答。')
    expect(single).toContain('风险测评作答 rq-1 1=conservative')
  })

  it('题面没有选项（异常下发）：回落成保守键，绝不抛错打断出站序列', () => {
    const broken = riskFrame({
      questions: [{ index: 1, title: '空题', options: [] }, question(2, '第二题')],
    })
    const lines = onlyText(broken).split('\n')
    // 第 1 题没有可列的键，模板仍然给出一条可解析的默认键
    expect(lines[1]).toBe('第 1 题 空题')
    expect(lines[lines.length - 1]).toContain('1=conservative 2=conservative')
  })

  it('问卷之后的其它帧照常投影：一张卷不会吃掉后续消息', () => {
    const out = projectImOutbound([
      riskFrame(),
      { kind: 'message', seq: 8, at: AT, role: 'assistant', blocks: [{ type: 'text', text: '已收到作答' }] },
    ])
    expect(out.map((item) => item.kind)).toEqual(['text', 'text'])
    expect(out[1]).toMatchObject({ text: '已收到作答' })
  })

  it('文本不含 undefined / null / [object Object]；帧外的用户身份字段不会被带出（无 PII）', () => {
    // 真实帧没有 userId / 手机号；这里**强行注入**，证明投影只读它认识的字段，
    // 而不是把整个帧对象串化或按字段名遍历。
    const smuggled = {
      ...riskFrame(),
      userId: 'u-1',
      ownerPhone: '13800001111',
      ownerIdCard: '110101199001011234',
    } as unknown as RiskQuestionnaireFrame
    const text = onlyText(smuggled)

    expect(text).not.toMatch(/undefined|null|\[object Object\]/)
    expect(text).not.toContain('u-1')
    expect(text).not.toContain('13800001111')
    expect(text).not.toContain('110101199001011234')
    // 内部 ID（问卷号）是这条消息的**必要**成分：用户整条回复里要带它，服务端才收得住
    expect(text).toContain('rq-9')
  })
})
