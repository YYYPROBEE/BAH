/**
 * `mock/script.ts` · 复述步（`resolveReflect`）的四条分支。
 *
 * 守的不变量：查余额这类"权威数字在工具结果里"的问题，助手唯一诚实的回答就是把
 * 工具给的那串数字原样念出来。所以：
 * - 工具没执行过 → 立刻抛错（脚本与路径写岔了，不许编一个余额）；
 * - 工具失败 / 没有正文 → 退到兜底话术（不把运维错误念给客户）；
 * - 正常 → 原样复述结果正文。
 */

import { BahError } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { reflectStep, resolveReflect, type MockReflect, type MockToolOutcome } from './script.ts'

/** 跑一次并取回抛出的错误（用于断言结构化理由码，而不只是"抛了没抛"）。 */
function caught(fn: () => unknown): BahError | undefined {
  try {
    fn()
    return undefined
  } catch (error) {
    return error as BahError
  }
}

describe('复述步构造器 reflectStep', () => {
  it('把 reflect 挂到步上，正文留给运行时按结果解析', () => {
    const reflect: MockReflect = { tool: 'account_balance', fallback: '没查到' }
    expect(reflectStep(reflect)).toEqual({ reflect })
  })
})

describe('resolveReflect：原样引用工具结果正文', () => {
  it('正常路径 → 复述最后一条匹配结果的 text（权威数字一字不改）', () => {
    const results: MockToolOutcome[] = [
      { name: 'account_balance', isError: false, text: '活期余额 1,234.56 元' },
    ]
    expect(resolveReflect({ tool: 'account_balance', fallback: '没查到' }, results)).toEqual([
      { kind: 'text', text: '活期余额 1,234.56 元' },
    ])
  })

  it('tool 缺省时不过滤，取本 turn 最后一条结果（多工具场景复述最新那个）', () => {
    const results: MockToolOutcome[] = [
      { name: 'sms_send', isError: false, text: '验证码已发送' },
      { name: 'account_balance', isError: false, text: '余额 9 元' },
    ]
    expect(resolveReflect({ fallback: '没查到' }, results)).toEqual([
      { kind: 'text', text: '余额 9 元' },
    ])
  })

  it('工具失败时不复述错误正文，改用兜底话术', () => {
    const results: MockToolOutcome[] = [
      { name: 'account_balance', isError: true, text: 'NullPointer at bank-core' },
    ]
    expect(resolveReflect({ tool: 'account_balance', fallback: '余额查询暂不可用' }, results)).toEqual([
      { kind: 'text', text: '余额查询暂不可用' },
    ])
  })

  it('结果没有正文（undefined）或正文是纯空白 → 走兜底，不输出空回复', () => {
    expect(
      resolveReflect({ tool: 't', fallback: '没查到' }, [{ name: 't', isError: false }]),
    ).toEqual([{ kind: 'text', text: '没查到' }])
    expect(
      resolveReflect({ tool: 't', fallback: '没查到' }, [{ name: 't', isError: false, text: '   ' }]),
    ).toEqual([{ kind: 'text', text: '没查到' }])
  })

  it('绑定的工具本 turn 没执行过 → 抛 mock-reflect-absent，文案点名是哪个工具', () => {
    const error = caught(() =>
      resolveReflect({ tool: 'account_balance', fallback: '没查到' }, [{ name: 'sms_send', isError: false, text: 'x' }]),
    )
    expect(error).toBeInstanceOf(BahError)
    expect(error?.code).toBe('mock-reflect-absent')
    expect(error?.message).toContain('工具 account_balance 未执行过')
    expect(error?.detail).toEqual({ tool: 'account_balance', results: 1 })
  })

  it('未绑定 tool 却一条结果都没有 → 同样抛 mock-reflect-absent（无工具名后缀）', () => {
    const error = caught(() => resolveReflect({ fallback: '没查到' }, []))
    expect(error?.code).toBe('mock-reflect-absent')
    expect(error?.message).toBe('mock: 复述步没有可依据的工具结果')
    expect(error?.detail).toEqual({ tool: null, results: 0 })
  })
})
