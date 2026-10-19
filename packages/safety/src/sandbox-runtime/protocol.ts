/**
 * 沙箱执行的共享形状（施工单 11 §3）。
 *
 * 父侧与 worker 侧都 import 本文件，因此这里**只放类型与常量**，不许有任何副作用与包名 import：
 * worker 由 Node 直接加载（不经打包器），依赖一旦越出本包就得走 `dist/`。
 */

import type { SandboxCapability, SandboxTier, TierSpec } from '../sandbox-policy/tier.ts'

/** 已登记进沙箱的执行体（宿主注册；`moduleUrl` 是 worker 里动态 import 的 file:// href）。 */
export interface SandboxHandlerRef {
  readonly key: string
  /** 该执行体声明需要的能力；隔离档位一律拒绝任何非空能力（§2 硬规则的能力侧）。 */
  readonly capabilities: readonly SandboxCapability[]
  readonly moduleUrl: string
}

/**
 * 派发进 worker 的作业（必须可结构化克隆）。
 *
 * `payload` 是执行体自己的形状（计算类是 `{ code, data, limits }`）——档位时限与堆上限
 * 不进载荷，由父侧用作硬杀与 `resourceLimits`，避免"程序自己决定自己能跑多久"。
 */
export interface SandboxJob {
  readonly moduleUrl: string
  readonly tool: string
  readonly payload: unknown
}

/** worker → 父侧的执行结论。 */
export type SandboxWorkerResult =
  | { readonly kind: 'ok'; readonly value: unknown }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }

/** 执行体模块的导出形状（`SANDBOX_HANDLER` 是每个 handler 文件的唯一出口）。 */
export interface SandboxHandlerModule {
  readonly SANDBOX_HANDLER: {
    readonly key: string
    readonly capabilities: readonly SandboxCapability[]
    run(payload: unknown): unknown | Promise<unknown>
  }
}

/**
 * 一次沙箱执行的四种结局（施工单 11 §3.1 的三分 + 成功）。
 *
 * `refused` / `error` / `timeout` 三态在宿主侧一律转成 `isError` 的工具结果，
 * **不冒泡到主循环**（施工单 03 硬约束 5）。
 */
export type SandboxOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly tier: SandboxTier; readonly elapsedMs: number }
  | { readonly kind: 'refused'; readonly code: string; readonly reason: string; readonly tier?: SandboxTier }
  | { readonly kind: 'error'; readonly code: string; readonly message: string; readonly tier: SandboxTier }
  | { readonly kind: 'timeout'; readonly tier: SandboxTier; readonly timeoutMs: number }

/** 结局 → 上报事件名（审计与门禁共用的唯一口径）。 */
export const SANDBOX_OUTCOME_EVENTS: Readonly<Record<SandboxOutcome<unknown>['kind'], string>> = {
  ok: 'sandbox/done',
  refused: 'sandbox/refused',
  error: 'sandbox/error',
  timeout: 'sandbox/timeout',
}

/** 生效限制的可读摘要（`dump-config` 与审计面板用）。 */
export function describeLimits(limits: TierSpec): string {
  return `${String(limits.timeoutMs)}ms / ${String(limits.maxOperations)} 次运算 / ${String(
    limits.maxOldGenMb,
  )}MB`
}
