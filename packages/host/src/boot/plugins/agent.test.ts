/**
 * `core:agent` 的装配辅助（`packages/host/src/boot/plugins/agent.ts`）。
 *
 * 这里只测"懒取运行时上下文端口"的两种失败语义：
 * - 缺服务 = 这一行没装（合法，返回 undefined）；
 * - 其它异常 = 装配 bug，必须原样上抛，绝不能被降级成"没装"。
 */

import { describe, expect, it } from 'vitest'

import { contextSourceOf, type ServiceReader } from './agent.ts'

/** 假 ctx：`get` 只负责抛指定的错误。 */
function throwingCtx(error: unknown): ServiceReader {
  return {
    get() {
      throw error
    },
  }
}

describe('core:agent · 运行时上下文端口', () => {
  it('service-missing → undefined（这一行没装是合法装配）', () => {
    expect(contextSourceOf(throwingCtx({ code: 'service-missing' }))).toBeUndefined()
  })

  it('其它异常原样上抛（不把装配 bug 当成没装）', () => {
    const boom = Object.assign(new Error('boom'), { code: 'context-source-broken' })
    expect(() => contextSourceOf(throwingCtx(boom))).toThrow('boom')
  })
})
