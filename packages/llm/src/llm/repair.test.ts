import { describe, expect, it } from 'vitest'

import { repairToolCall, validateArguments } from './repair.ts'
import type { AssembledToolCall, ToolSchema } from './types.ts'

/** 转账工具的参数 schema（金融特例：金额是 number，收款人是 string）。 */
const TRANSFER_SCHEMA: ToolSchema = {
  type: 'object',
  properties: {
    amount: { type: 'number', description: '金额（元）' },
    payee: { type: 'string', description: '收款人' },
    urgent: { type: 'boolean', description: '是否加急' },
    count: { type: 'integer', description: '笔数' },
  },
  required: ['amount', 'payee'],
}

/** 造一个装配好的调用（args 与 argsText 保持一致）。 */
function call(name: string, args: unknown, argsText = JSON.stringify(args)): AssembledToolCall {
  return {
    callId: 'call-1',
    name,
    argsText,
    ...(typeof args === 'object' && args !== null && !Array.isArray(args)
      ? { args: args as Readonly<Record<string, unknown>> }
      : {}),
  }
}

describe('repairToolCall', () => {
  it('T-LLM-003 增量拼接坏 JSON：结构化回灌 + 修复重试 1 次后成功', async () => {
    const feedbacks: string[] = []
    const outcome = await repairToolCall({
      // 模型把金额写成字符串（最高频的一类漂移），且首轮 JSON 还是坏的
      call: {
        callId: 'call-1',
        name: 'transfer_money',
        argsText: '{"amount":"一百",',
        parseError: '参数不是合法 JSON：Unexpected end of JSON input',
      },
      schema: TRANSFER_SCHEMA,
      reissue: (feedback) => {
        feedbacks.push(feedback)
        return Promise.resolve({ argsText: '{"amount":100,"payee":"张三"}' })
      },
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.repaired).toBe(true)
    expect(outcome.args).toEqual({ amount: 100, payee: '张三' })

    // 只重试一次，且回灌内容是结构化的（说得清哪个参数、应为什么）
    expect(feedbacks).toHaveLength(1)
    expect(feedbacks[0]).toContain('参数不是合法 JSON')
    expect(feedbacks[0]).toContain('只返回该工具的完整参数 JSON 对象')
  })

  it('T-LLM-003 修复后仍不合法：以 tool-args-invalid 判失败（不无限重试）', async () => {
    const feedbacks: string[] = []
    const outcome = await repairToolCall({
      call: call('transfer_money', { amount: '一百', payee: '张三' }),
      schema: TRANSFER_SCHEMA,
      reissue: (feedback) => {
        feedbacks.push(feedback)
        // 第二次仍然把金额写成字符串
        return Promise.resolve({ argsText: '{"amount":"还是一百","payee":"张三"}' })
      },
    })

    expect(feedbacks).toHaveLength(1)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.code).toBe('tool-args-invalid')
    expect(outcome.reason).toContain('参数 amount 类型错误：应为 number（实际 string）')
    expect(outcome.issues).toHaveLength(1)
    expect(outcome.issues[0]!.path).toBe('$.amount')
  })

  it('模型没有给出可用重发（undefined）→ 直接判失败', async () => {
    const outcome = await repairToolCall({
      call: call('transfer_money', { payee: '张三' }),
      schema: TRANSFER_SCHEMA,
      reissue: () => Promise.resolve(undefined),
    })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') throw new Error('unreachable')
    expect(outcome.issues[0]!.path).toBe('$.amount')
    expect(outcome.issues[0]!.actual).toBe('missing')
  })

  it('一次就合法时完全不打扰模型（reissue 不被调用）', async () => {
    let called = 0
    const outcome = await repairToolCall({
      call: call('transfer_money', { amount: 100, payee: '张三' }),
      schema: TRANSFER_SCHEMA,
      reissue: () => {
        called += 1
        return Promise.resolve(undefined)
      },
    })

    expect(called).toBe(0)
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.repaired).toBe(false)
  })

  it('重发草稿的 callId / name 可被模型改写（落账跟随新值）', async () => {
    const outcome = await repairToolCall({
      call: call('transfer_money', { amount: 'x', payee: '张三' }),
      schema: TRANSFER_SCHEMA,
      reissue: () => Promise.resolve({ callId: 'call-2', name: 'transfer_money', argsText: '{"amount":1,"payee":"李四"}' }),
    })

    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.callId).toBe('call-2')
    expect(outcome.args).toEqual({ amount: 1, payee: '李四' })
  })
})

describe('validateArguments（JSON Schema 有限子集）', () => {
  it('required 缺失与类型不符各报一条，且带 JSON 路径', () => {
    const result = validateArguments(TRANSFER_SCHEMA, { amount: '100', urgent: 'yes', count: 1.5 })
    expect(result.ok).toBe(false)
    const paths = result.issues.map((issue) => issue.path)
    // payee 缺失（required）排在前，其余按 schema 属性顺序
    expect(paths).toEqual(['$.payee', '$.amount', '$.urgent', '$.count'])
    expect(result.issues[1]!.message).toBe('参数 amount 类型错误：应为 number（实际 string）')
    expect(result.issues[3]!.message).toBe('参数 count 类型错误：应为 integer（实际 number）')

    // 必填缺失（缺 payee）单独一条 required 问题
    const missing = validateArguments(TRANSFER_SCHEMA, { amount: 1 })
    expect(missing.issues).toEqual([
      { path: '$.payee', expected: 'required', actual: 'missing', message: '缺少必填参数 payee' },
    ])
  })

  it('参数根不是对象 → 单独一条 $ 级问题', () => {
    expect(validateArguments(TRANSFER_SCHEMA, null).issues[0]!.path).toBe('$')
    expect(validateArguments(TRANSFER_SCHEMA, [1, 2]).issues[0]!.actual).toBe('array')
  })

  it('合法参数通过；未声明 type 的参数与未知类型一律放行', () => {
    expect(validateArguments(TRANSFER_SCHEMA, { amount: 1, payee: '张三' }).ok).toBe(true)
    const loose: ToolSchema = {
      type: 'object',
      properties: { anything: {}, mode: { type: 'enum' } },
    }
    expect(validateArguments(loose, { anything: 42, mode: 'fast' }).ok).toBe(true)
  })

  it('object / array 两种复合类型也校验（不是只挡数字和字符串）', () => {
    const schema: ToolSchema = {
      type: 'object',
      properties: { meta: { type: 'object' }, tags: { type: 'array' } },
    }
    expect(validateArguments(schema, { meta: { a: 1 }, tags: [1, 2] }).ok).toBe(true)

    const bad = validateArguments(schema, { meta: [1], tags: 'x' })
    expect(bad.issues.map((issue) => issue.path)).toEqual(['$.meta', '$.tags'])
    expect(bad.issues[0]!.actual).toBe('array')
    expect(bad.issues[1]!.actual).toBe('string')
  })
})
