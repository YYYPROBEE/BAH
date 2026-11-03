/**
 * 工具注册表。
 *
 * 纪律：**注册即可逆**——`register` 返回 disposer；
 * 重名即抛（全局唯一、模型可见的名字，重名会让模型侧 schema 冲突）。
 */

import { BahError } from '@bah/util'

import type { Disposer, ToolDefinition } from '@bah/core'

export class ToolRegistry {
  /** 工具名 → 定义（插入顺序 = 注册顺序，`list()` 按此返回）。 */
  private readonly definitions = new Map<string, ToolDefinition<unknown, unknown>>()

  /**
   * 注册一个工具。
   *
   * @returns 注销句柄（幂等；注销后再调用该工具会报「未注册」）
   * @throws `BahError('tool-duplicate')` 工具名重复
   * @throws `BahError('tool-name-empty')` 工具名为空
   */
  register<A, R>(definition: ToolDefinition<A, R>): Disposer {
    const name = definition.name
    if (name.length === 0) {
      throw new BahError('tool-name-empty', 'tools: 工具名不能为空（模型按名字寻址）')
    }
    if (this.definitions.has(name)) {
      throw new BahError('tool-duplicate', `tools: 工具重名 ${name}（全局唯一、模型可见）`, { tool: name })
    }
    this.definitions.set(name, definition as ToolDefinition<unknown, unknown>)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.definitions.delete(name)
    }
  }

  /**
   * 取工具定义。
   *
   * @throws `BahError('tool-missing')` 未注册（fail-loud，不返回 `undefined`）
   */
  get(name: string): ToolDefinition<unknown, unknown> {
    const definition = this.definitions.get(name)
    if (!definition) {
      throw new BahError('tool-missing', `tools: 工具 ${name} 未注册`, { tool: name })
    }
    return definition
  }

  /** 是否已注册（管线的可选路径判断用）。 */
  has(name: string): boolean {
    return this.definitions.has(name)
  }

  /** 全部已注册定义（顺序 = 注册顺序；模型侧 schema 装配按此顺序）。 */
  list(): readonly ToolDefinition<unknown, unknown>[] {
    return [...this.definitions.values()]
  }

  /** 全部已注册工具名。 */
  names(): readonly string[] {
    return [...this.definitions.keys()]
  }
}
