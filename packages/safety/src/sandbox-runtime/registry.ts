/**
 * 执行体登记表（施工单 11 §3）。
 *
 * 沙箱不知道"能执行什么"——能力由宿主显式登记，未登记的执行体一律 `refused`。
 * 这条边界让"模型代码进沙箱"与"沙箱能跑什么"两件事各有属主：
 * 档位归 `sandbox-policy`，可执行体归这份登记表（宿主 `safety:sandbox` 行写入）。
 */

import type { Disposer } from '@bah/core'
import { sandboxError } from '../sandbox-policy/policy.ts'
import type { SandboxHandlerRef } from './protocol.ts'

export class SandboxRegistry {
  private readonly handlers = new Map<string, SandboxHandlerRef>()

  /**
   * 登记一个执行体，返回注销句柄（注册即可逆，施工单 00 §9 第 1 条）。
   *
   * @throws `bah-sandbox: handler-duplicate` 同键重复登记（会让"谁在执行"依赖登记顺序）
   */
  register(ref: SandboxHandlerRef): Disposer {
    if (this.handlers.has(ref.key)) {
      throw sandboxError('handler-duplicate', `执行体键 ${ref.key} 重复登记`, { key: ref.key })
    }
    this.handlers.set(ref.key, ref)
    return () => {
      // 只在仍指向本次登记时删除：重复键的 disposer 不该摘掉后来者的条目
      if (this.handlers.get(ref.key) === ref) this.handlers.delete(ref.key)
    }
  }

  /** 取执行体；未登记返回 `undefined`（调用方转成 `refused`，不抛）。 */
  get(key: string): SandboxHandlerRef | undefined {
    return this.handlers.get(key)
  }

  /** 已登记的键（门禁与 `dump-config` 用）。 */
  keys(): readonly string[] {
    return [...this.handlers.keys()]
  }
}
