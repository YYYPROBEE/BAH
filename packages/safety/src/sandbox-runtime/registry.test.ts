/**
 * 执行体登记表（沙箱运行时 · ）。
 *
 * 登记表是"沙箱能跑什么"的唯一属主。两条必须钉住的纪律：
 * 1. 同键重复登记必须拒绝——否则"谁在执行"会依赖登记顺序；
 * 2. 注销必须可逆且只摘自己那次登记——旧 disposer 不能摘掉后来者的条目。
 */

import { describe, expect, it } from 'vitest'

import type { SandboxHandlerRef } from './protocol.ts'
import { SandboxRegistry } from './registry.ts'

/** 造一条登记。 */
function ref(key: string, moduleUrl = `file:///tmp/${key}.ts`): SandboxHandlerRef {
  return { key, capabilities: [], moduleUrl }
}

/** 取抛出的错误（safety 包的 tsconfig 不引用 test-support，这里本地收敛）。 */
function errorOf(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    return error as { code: string; message: string }
  }
  throw new Error('期望抛出错误，但没有抛')
}

describe('SandboxRegistry', () => {
  it('登记后可取、可列出；未登记返回 undefined（调用方转成 refused）', () => {
    const registry = new SandboxRegistry()
    const compute = ref('compute')
    registry.register(compute)

    expect(registry.get('compute')).toBe(compute)
    expect(registry.get('nope')).toBeUndefined()
    expect(registry.keys()).toEqual(['compute'])
  })

  it('同键重复登记：handler-duplicate（不静默覆盖）', () => {
    const registry = new SandboxRegistry()
    registry.register(ref('compute'))
    const error = errorOf(() => registry.register(ref('compute')))
    expect(error.code).toBe('handler-duplicate')
    expect(error.message).toContain('bah-sandbox:')
  })

  it('注销摘掉自己的条目；重复注销是幂等的', () => {
    const registry = new SandboxRegistry()
    const dispose = registry.register(ref('compute'))

    dispose()
    expect(registry.get('compute')).toBeUndefined()
    expect(registry.keys()).toEqual([])
    dispose()
    expect(registry.keys()).toEqual([])
  })

  it('旧 disposer 不摘后来者的条目（登记顺序不能被过期句柄改写）', () => {
    const registry = new SandboxRegistry()
    const first = ref('compute')
    const disposeFirst = registry.register(first)
    disposeFirst()

    const second = ref('compute', 'file:///tmp/other.ts')
    registry.register(second)
    // 再调用一次旧句柄：此时表里指向的是 second，不能被误删
    disposeFirst()
    expect(registry.get('compute')).toBe(second)
  })
})
