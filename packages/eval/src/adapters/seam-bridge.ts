/**
 * 接缝桥（M0 §5 的「工具适配层事件发射处订阅」）。
 *
 * 订阅三个接缝，覆盖一次工具调用从参数到结果的全程：
 * - `tools/pre-execute`（waterfall）：拿到 callId / 工具名 / **参数**；同时是不可逆工具
 *   取「前快照」的唯一正确时机——再晚一点，钱可能已经动了。
 * - `tools/result`（emit）：拿到**冻结的权威结果**；同时取「后快照」。
 * - `tools/post-execute` 不用：它可能被改写（`replace` / `block`），不是权威结果。
 *
 * ── 两个必须解释的实现细节 ──────────────────────────────────────────
 * 1. **绝不断路**：两个接缝都是 waterfall，按 AGENTS.md 编码纪律 2，监听器必须
 *    `return next(payload)`。本模块只观察、不判决，短路会直接改掉 agent 的行为。
 * 2. **写入排队**：`tools/result` 是 `emit`，总线**不 await** 监听器——在监听器里
 *    直接 `await appendFile` 会产生没人接的 floating promise（lint 报错、落盘也可能
 *    在进程退出时丢）。因此内部维护一条 promise 链，监听器只入队，由调用方在
 *    打包证据前 `await drain()`。这样既不阻塞总线，也不丢写入。
 */

import type { TrajectoryRecorder } from '../recorder/TrajectoryRecorder.ts'
import type { SnapshotChain } from '../snapshot/SnapshotChain.ts'
import type { EventSourcePort, SeamListener } from './ports.ts'

export interface SeamBridgeOptions {
  readonly events: EventSourcePort
  readonly recorder: TrajectoryRecorder
  /** 提供时才取快照；不提供＝只记轨迹（轻量模式）。 */
  readonly snapshots?: SnapshotChain
  /** 哪些工具算「不可逆」（需前后快照）。缺省不取任何前后快照。 */
  readonly isIrreversible?: (tool: string) => boolean
}

export interface SeamBridgeHandle {
  /** 注销全部订阅（幂等）。 */
  readonly dispose: () => void
  /** 等所有排队写入落盘；失败会在这里抛出（不在总线里抛）。 */
  readonly drain: () => Promise<void>
  /** 已发起但还没等到 `tools/result` 的 callId（证据缺口的直接证据）。 */
  readonly pendingCallIds: () => readonly string[]
}

interface PendingCall {
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly idempotencyKey?: string
  readonly permissionBranch?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** 从 `tools/pre-execute` 载荷里取调用信息（结构未知，一律窄化后使用）。 */
function readPreExecute(payload: unknown): { callId: string; call: PendingCall } | undefined {
  const envelope = asRecord(payload)
  const rawCall = envelope === undefined ? undefined : asRecord(envelope['call'])
  if (rawCall === undefined) return undefined

  const callId = readString(rawCall, 'callId')
  const name = readString(rawCall, 'name')
  if (callId === undefined || name === undefined) return undefined

  const idempotencyKey = readString(rawCall, 'idempotencyKey')
  const permissionBranch = readString(rawCall, 'permissionBranch')

  return {
    callId,
    call: {
      tool: name,
      // callId 不进 args——它会被一并脱敏，而 callId 是关联键，脱敏后无法与快照配对。
      args: asRecord(rawCall['args']) ?? {},
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      ...(permissionBranch === undefined ? {} : { permissionBranch }),
    },
  }
}

/** 从 `tools/result` 载荷里取结果摘要。 */
function readResult(payload: unknown): { callId: string; digest: Record<string, unknown> } | undefined {
  const record = asRecord(payload)
  if (record === undefined) return undefined
  const callId = readString(record, 'callId')
  if (callId === undefined) return undefined

  const digest: Record<string, unknown> = {
    isError: record['isError'] === true,
  }
  for (const key of ['code', 'reason', 'durationMs'] as const) {
    if (record[key] !== undefined) digest[key] = record[key]
  }
  if (record['content'] !== undefined) digest['content'] = record['content']
  return { callId, digest }
}

export function attachSeamBridge(options: SeamBridgeOptions): SeamBridgeHandle {
  const { events, recorder, snapshots, isIrreversible } = options
  const pending = new Map<string, PendingCall>()

  let tail: Promise<void> = Promise.resolve()
  let failure: unknown

  /** 串行入队：保证落盘顺序与事件顺序一致，且异常不打断后续任务。 */
  const enqueue = (task: () => Promise<void>): void => {
    tail = tail.then(task).catch((error: unknown) => {
      failure ??= error
    })
  }

  const shouldSnapshot = (tool: string): boolean => isIrreversible?.(tool) === true

  const onPreExecute: SeamListener = (payload, next) => {
    const observed = readPreExecute(payload)
    if (observed !== undefined) {
      pending.set(observed.callId, observed.call)
      if (shouldSnapshot(observed.call.tool) && snapshots !== undefined) {
        enqueue(async () => {
          await snapshots.beforeIrreversible(observed.callId)
        })
      }
    }
    // 只观察，不判决：必须交还控制权。
    return next(payload)
  }

  const onResult: SeamListener = (payload) => {
    const result = readResult(payload)
    if (result === undefined) return undefined

    const call = pending.get(result.callId)
    pending.delete(result.callId)
    if (call === undefined) return undefined

    enqueue(async () => {
      await recorder.appendTool({
        tool: call.tool,
        args: call.args,
        result: result.digest,
        ...(call.idempotencyKey === undefined ? {} : { idempotencyKey: call.idempotencyKey }),
        ...(call.permissionBranch === undefined
          ? {}
          : { permissionBranch: call.permissionBranch }),
      })
      if (shouldSnapshot(call.tool) && snapshots !== undefined) {
        await snapshots.afterIrreversible(result.callId)
      }
    })
    return undefined
  }

  const disposers = [
    events.on('tools/pre-execute', onPreExecute),
    events.on('tools/result', onResult),
  ]

  let disposed = false
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const off of disposers) off()
      pending.clear()
    },
    drain: async () => {
      await tail
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
    },
    pendingCallIds: () => [...pending.keys()],
  }
}
