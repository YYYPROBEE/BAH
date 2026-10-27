/**
 * `tool/result` 上链摘要（B4）——**单独一个文件，只为一件事：收敛重放闭包**。
 *
 * `verify-replay-isolation` 要求 `scripts/replay.ts` 的 value-import 闭包只碰
 * `persistence` / `eval` / `util` / `node:*`，且 persistence 内部不许 value import
 * `@bah/core`。`chain/index.ts` 会 `export * from './vault.ts'`，而 `vault.ts` 用
 * `defineService`（value import `@bah/core`）——所以 replay 只要从 barrel 里拿一个符号，
 * 整条闭包就被判红。
 *
 * 结论：**跨面复用的纯函数必须住在独立文件里**，而不是 barrel 里。
 * 允许的 import 只有 `@bah/util`（门禁白名单内），所以错误仍用 `BahError`，
 * 不引入自定义错误类（那会让调用方的 `instanceof BahError` 分支失效）。
 */

import { BahError } from '@bah/util'

/** 摘要形状（不携带 `content` / `reason`）。 */
export interface ToolResultSummary {
  readonly callId: string
  readonly name: string
  readonly isError: boolean
  readonly code?: string
  readonly durationMs?: number
}

/**
 * 从 `tool/result` 会话事件载荷投影出上链摘要。
 *
 * 为什么不镜像原文：`content` 是渲染投影（可能含收款人等 PII，且体积不可控），
 * `reason` 是自由文本。链的职责是证明"这次调用有结果、结果长这样（哈希）、
 * 是否出错、错了什么码、跑了多久"——重建执行轨迹够用，隐私面最小。
 *
 * 摘要必须**结构稳定**：replay 会从 `session.jsonl` 的 `tool/result` 事件重算同一
 * 摘要比对 `d` 字段（篡改任一侧都变红）。新增字段 = 断旧链核验，须同步 replay。
 *
 * 入参取结构化 `unknown`：persistence 不 import runtime（R-4 同款纪律），
 * 宿主把 `ToolResultData` 传进来即可。
 */
export function toolResultSummaryOf(data: unknown): ToolResultSummary {
  if (typeof data !== 'object' || data === null) {
    throw summaryError('tool/result 载荷必须是对象')
  }
  const record = data as Record<string, unknown>
  const callId = record['callId']
  const name = record['name']
  const isError = record['isError']
  if (typeof callId !== 'string' || typeof name !== 'string' || typeof isError !== 'boolean') {
    throw summaryError('tool/result 缺 callId/name/isError')
  }
  const code = record['code']
  const durationMs = record['durationMs']
  return {
    callId,
    name,
    isError,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof durationMs === 'number' ? { durationMs } : {}),
  }
}

function summaryError(why: string): BahError {
  return new BahError(
    'tool-result-summary-invalid',
    `bah-saga: tool-result-summary-invalid: ${why}`,
  )
}
