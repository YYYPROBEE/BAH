/**
 * 子进程登记表（施工单 02 §2.11 的 `registry.ts`）。
 *
 * WHY 单独一张表而不是把状态塞进 supervisor 的闭包：
 * `sessionKey → ChildRecord` 要能被 `/healthz`、闲置回收、崩溃重启三处**独立读**，
 * 三处各持一份闭包状态就会出现"回收了但表里还在"的幽灵子进程。
 */

import type { ChildClient } from './client.ts'

/** 一条子进程记录（字段与 §2.11 的 `ChildRecord` 对应；实现里多出两个句柄）。 */
export interface ChildRecord {
  readonly platform: string
  /** 平台用户标识（只在内存里用于重启；**不落日志、不进路径**）。 */
  readonly userId: string
  readonly sessionKey: string
  pid: number
  port: number
  token: string
  csrf: string
  /** 最近一次活动时刻（闲置回收用）。 */
  lastSeen: number
  /** 崩溃重启次数（10 分钟窗口内 ≤3）。 */
  restarts: number
  /** 首次启动时刻（重启窗口的起点）。 */
  readonly firstStartAt: number
  status: 'starting' | 'ready' | 'unhealthy' | 'disabled'
  client?: ChildClient
  /** 结束时调用的 kill（supervisor 注入）。 */
  kill?: (signal: 'SIGTERM' | 'SIGKILL') => void
}

/** 登记表。 */
export interface ChildRegistry {
  get(sessionKey: string): ChildRecord | undefined
  set(record: ChildRecord): void
  delete(sessionKey: string): void
  values(): readonly ChildRecord[]
  size(): number
}

/** 造一张登记表（Map 的插入顺序即"最近创建序"，回收时按它挑最久闲置）。 */
export function createChildRegistry(): ChildRegistry {
  const table = new Map<string, ChildRecord>()
  return {
    get: (sessionKey) => table.get(sessionKey),
    set: (record) => {
      table.set(record.sessionKey, record)
    },
    delete: (sessionKey) => {
      table.delete(sessionKey)
    },
    values: () => [...table.values()],
    size: () => table.size,
  }
}
