/**
 * IPC 五条消息（T-DTB-002）。消息名是**固定契约**：名字、载荷形状、以及"不许有表外通道"。
 * 第五条 `newConversation` 是零载荷生命周期动作（重启进程 = 新会话），不是业务通道。
 */

import { describe, expect, it } from 'vitest'

import {
  assertNoCredentialKeys,
  BOOT_INJECTION_KEYS,
  FORBIDDEN_PAYLOAD_KEYS,
  IPC,
  parseBootReady,
  toBootFatal,
  type BootInjections,
} from './ipc.ts'

describe('IPC 常量（T-DTB-002）', () => {
  it('五个名字逐字精确（改一个就是改协议）', () => {
    expect(IPC).toEqual({
      injections: 'bah:boot/injections',
      ready: 'bah:boot/ready',
      fatal: 'bah:boot/fatal',
      shutdown: 'bah:boot/shutdown',
      newConversation: 'bah:app/new-conversation',
    })
  })

  it('恰有五条：四条生命周期 + 一条零载荷重启', () => {
    expect(Object.keys(IPC)).toHaveLength(5)
  })
})

describe('BootInjections 不含凭证（I-DT-06）', () => {
  it('键集恰为五个（多一个键就是载荷变了）', () => {
    const payload: BootInjections = {
      channel: 'desktop',
      sessionId: 'desktop-demo',
      profile: 'desktop',
      port: 51234,
      version: '0.1.0',
    }
    expect(Object.keys(payload).sort()).toEqual([...BOOT_INJECTION_KEYS].sort())
    // 键名里不能出现 token / secret / password / cookie / apikey
    assertNoCredentialKeys(payload as unknown as Record<string, unknown>)
  })

  it('塞进 token 会被当场拒（负控）', () => {
    expect(() => {
      assertNoCredentialKeys({ channel: 'desktop', BAH_WEB_TOKEN: 'x' })
    }).toThrow(/boot-payload-forbidden-key/)
    expect(() => {
      assertNoCredentialKeys({ sessionId: 's', apiKey: 'x' })
    }).toThrow(/boot-payload-forbidden-key/)
  })

  it('禁用键清单本身包含 token（清单被清空会让上一条变成空转）', () => {
    expect([...FORBIDDEN_PAYLOAD_KEYS]).toContain('token')
    expect(FORBIDDEN_PAYLOAD_KEYS.length).toBeGreaterThanOrEqual(3)
  })
})

describe('parseBootReady', () => {
  it('接受 { at: 非负整数 }', () => {
    expect(parseBootReady({ at: 0 })).toBe(true)
    expect(parseBootReady({ at: 1_700_000_000_000 })).toBe(true)
  })

  it('拒绝坏载荷（缺字段 / 类型错 / 负数 / 多余键 / 非对象）', () => {
    for (const bad of [
      undefined,
      null,
      42,
      'x',
      [],
      {},
      { at: '1' },
      { at: -1 },
      { at: 1.5 },
      { at: Number.NaN },
      { at: 1, extra: true },
      { at: 1, token: 'x' },
    ]) {
      expect(parseBootReady(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('toBootFatal', () => {
  it('保留结构化 code 与 message', () => {
    expect(toBootFatal({ code: 'web-listen-failed', message: '端口被占' }, 'fallback')).toEqual({
      code: 'web-listen-failed',
      message: '端口被占',
    })
  })

  it('缺 code 时用 fallback；缺 message 时给可读兜底', () => {
    expect(toBootFatal(new Error('boom'), 'desktop-boot-failed')).toEqual({
      code: 'desktop-boot-failed',
      message: 'boom',
    })
    expect(toBootFatal({ code: 'x' }, 'fallback').message).toContain('启动失败')
    expect(toBootFatal('字符串错误', 'fallback')).toEqual({
      code: 'fallback',
      message: '字符串错误',
    })
  })

  it('**不**把 stack 带进载荷（栈里有绝对路径与内部模块名）', () => {
    const error = new Error('boom')
    error.stack = 'Error: boom\n    at C:\\secret\\path.ts:1:1'
    const fatal = toBootFatal(error, 'fallback')
    expect(Object.keys(fatal).sort()).toEqual(['code', 'message'])
    expect(JSON.stringify(fatal)).not.toContain('secret')
  })
})
