/**
 * 运营桥（施工单 03 §2.6 运营侧）。
 *
 * 公网只暴露 `/seat/*`，且**必须先过运营 token**：
 * - 未配置 `BAH_IM_OPERATOR_TOKEN` → 整条 404（在方法/路径判定之前，不暴露存在性）；
 * - 配了但请求头缺失/不符 → 401；
 * - token 不符用常量时间比较（长度不等也先做一次同长比较）。
 *
 * 转发纪律：
 * - 用**子进程自己的** operator token + CSRF，不把公网 token 下发给子进程；
 * - 不反代任意 `/api/*`：路径由本文件的白名单构造；
 * - 响应原样回传状态码与 JSON；不额外包装，也不回显 token。
 */

import { timingSafeEqual } from 'node:crypto'

import type { ServerResponse } from 'node:http'

import { IM_SESSION_ID_PATTERN } from '@bah/channels'

import type { GatewayConfig } from '../config.ts'
import type { ImLogger } from '../log.ts'
import type { SessionHub } from '../session/hub.ts'
import type { Supervisor } from '../session/supervisor.ts'

/** 运营桥依赖。 */
export interface SeatDeps {
  readonly config: GatewayConfig
  readonly log: ImLogger
  readonly supervisor: Supervisor
  readonly hub: SessionHub
}

/** 子进程路径（白名单；只在 seat 方法里构造）。 */
const SEAT_PATHS = {
  summary: '/api/handoff',
  claim: '/api/handoff/claim',
  message: '/api/handoff/message',
  heartbeat: '/api/handoff/heartbeat',
  resume: '/api/handoff/resume',
  queue: '/api/handoff/queue',
} as const

/** `/seat/:sessionKey/handoff[/<action>]`。 */
const SEAT_PATH = new RegExp(
  `^/seat/(im-[0-9a-f]{16})/handoff(?:/(claim|message|heartbeat|resume|queue))?$`,
  'u',
)

/** 鉴权结果。 */
type SeatAuth = 'ok' | 'missing' | 'mismatch'

/** 定长比较（长度不等也做一次同长比较，避免提前返回成为计时侧信道）。 */
function secretEqual(expected: string, presented: string): boolean {
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(presented, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(Buffer.alloc(right.length), Buffer.alloc(right.length))
    return false
  }
  return timingSafeEqual(left, right)
}

/** 运营鉴权（header 名固定 `x-bah-operator-token`）。 */
function authenticate(deps: SeatDeps, headers: Readonly<Record<string, string | undefined>>): SeatAuth {
  const expected = deps.config.operatorToken
  if (expected === undefined) return 'missing'
  const presented = headers['x-bah-operator-token'] ?? ''
  if (presented.length === 0) return 'missing'
  return secretEqual(expected, presented) ? 'ok' : 'mismatch'
}

/** 写 JSON（错误体与子进程同形：`{ error: { code, reason } }`）。 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** 解析转发体（空体按 `{}`；非对象 → `undefined`）。 */
function bodyOf(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 处理一条 `/seat/*` 请求。
 *
 * 调用方（`server.ts`）已在 `operatorToken` 未配置时直接 404；本函数再判一次是防御。
 */
export async function handleSeatRequest(
  deps: SeatDeps,
  input: {
    readonly method: 'GET' | 'POST'
    readonly path: string
    readonly headers: Readonly<Record<string, string | undefined>>
    readonly body: string
  },
  res: ServerResponse,
): Promise<void> {
  const auth = authenticate(deps, input.headers)
  if (auth !== 'ok') {
    deps.log.warn('im-seat-denied', { code: auth })
    writeJson(res, 401, {
      error: { code: 'im-seat-unauthorized', reason: '运营凭证无效' },
    })
    return
  }

  // 列表不转发：网关内存即可回答（不含平台用户标识）
  if (input.path === '/seat/sessions') {
    if (input.method !== 'GET') {
      writeJson(res, 405, { error: { code: 'im-seat-method', reason: '只支持 GET' } })
      return
    }
    const sessions = listSessions(deps)
    deps.log.info('im-seat-forward', { path: '/seat/sessions', status: 200 })
    writeJson(res, 200, { sessions })
    return
  }

  const match = SEAT_PATH.exec(input.path)
  if (match === null) {
    writeJson(res, 404, { error: { code: 'im-seat-unknown', reason: '没有这个运营路由' } })
    return
  }
  const sessionKey = match[1] ?? ''
  const action = match[2] as keyof typeof SEAT_PATHS | undefined
  const wanted = action ?? 'summary'
  const expectedMethod: 'GET' | 'POST' = wanted === 'summary' || wanted === 'queue' ? 'GET' : 'POST'
  if (input.method !== expectedMethod) {
    writeJson(res, 405, {
      error: { code: 'im-seat-method', reason: `该路由只支持 ${expectedMethod}` },
    })
    return
  }

  if (!IM_SESSION_ID_PATTERN.test(sessionKey)) {
    writeJson(res, 404, { error: { code: 'im-seat-unknown-session', reason: '没有这个会话' } })
    return
  }
  const record = deps.supervisor.get(sessionKey)
  if (record === undefined || record.status !== 'ready' || record.client === undefined) {
    writeJson(res, 404, { error: { code: 'im-seat-unknown-session', reason: '没有这个会话' } })
    return
  }

  let body: Record<string, unknown> | undefined
  if (input.method === 'POST') {
    body = bodyOf(input.body)
    if (body === undefined) {
      writeJson(res, 400, { error: { code: 'im-seat-invalid-body', reason: '请求体必须是 JSON 对象' } })
      return
    }
  }

  const childPath = SEAT_PATHS[wanted]
  const result = await record.client.seat(
    input.method,
    childPath,
    input.method === 'POST' ? { ...(body ?? {}) } : undefined,
  )
  if (result.status === 0) {
    deps.log.warn('im-seat-forward', { path: childPath, status: 0 })
    writeJson(res, 502, { error: { code: 'im-seat-upstream', reason: '子进程不可达' } })
    return
  }
  deps.log.info('im-seat-forward', { path: childPath, status: result.status })
  if (typeof result.json === 'object' && result.json !== null) {
    writeJson(res, result.status, result.json)
    return
  }
  writeJson(res, 502, { error: { code: 'im-seat-upstream', reason: '子进程返回非 JSON' } })
}

/** 当前存活会话列表（sessionKey / platform / lastSeen / 接管与待审批数量）。 */
function listSessions(deps: SeatDeps): readonly Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const record of deps.supervisor.list()) {
    if (record.status !== 'ready') continue
    result.push({
      sessionKey: record.sessionKey,
      platform: record.platform,
      lastSeen: record.lastSeen,
      handoffActive: deps.hub.handoffActive(record.sessionKey),
      pendingCount: deps.hub.pendingCount(record.sessionKey),
    })
  }
  return result
}
