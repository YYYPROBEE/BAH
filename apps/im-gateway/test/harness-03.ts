/**
 * 测试设施：假子进程客户端 / 假监督者 / 配置。
 *
 * 与 02 的 `fake-child.ts` 不同：这里不启 HTTP server，直接实现 `ChildClient` 契约，
 * 让审批 / 接管 / 运营桥的状态机可以在毫秒级测完。
 */

import { deriveImSessionId } from '@bah/channels'
import type { WebFrame } from '@bah/channels'

import { loadConfig, type Env } from '../src/config.ts'
import type { ChildCallResult, ChildClient, SubscribeHandlers, TurnOutcome } from '../src/session/client.ts'
import type { ChildRecord } from '../src/session/registry.ts'
import type { ChildHandle, Supervisor } from '../src/session/supervisor.ts'

/** 合法配置（H5 用公网基址 + 固定链接密钥）。 */
export function configFor(overrides: Env = {}): ReturnType<typeof loadConfig> {
  const env: Env = {
    BAH_IM_SESSION_SALT: 'salt-0123456789abcdef',
    BAH_IM_LINK_SECRET: 'link-secret-0123456789abcdefghij',
    BAH_IM_PUBLIC_BASE_URL: 'https://im.example.test',
    BAH_IM_PASSIVE_WAIT_MS: '400',
    BAH_WECHAT_APPID: 'demo-app',
    BAH_WECHAT_SECRET: 'demo-secret',
    BAH_WECHAT_TOKEN: 'demo-callback-token',
    ...overrides,
  }
  return loadConfig(env, 'D:/repo')
}

/** 假子进程的可观测面。 */
export interface FakeChild03 extends ChildClient {
  /** 向所有订阅者推一帧（常驻订阅与 per-turn 订阅都会收到）。 */
  emit(frame: WebFrame): void
  /** 让所有订阅者收到一次错误（模拟常驻 SSE 断线）。 */
  failStream(error?: Error): void
  /** 订阅者数量（常驻 + per-turn）。 */
  subscribers(): number
  readonly calls: {
    readonly turns: string[]
    readonly decisions: { ticketId: string; decision: string; reason?: string }[]
    readonly verifies: string[]
    readonly handoffs: (string | undefined)[]
    readonly seats: { method: 'GET' | 'POST'; path: string; body?: unknown }[]
  }
  setDecide(result: ChildCallResult | ((ticketId: string) => ChildCallResult)): void
  setVerify(result: ChildCallResult | ((ticketId: string) => ChildCallResult)): void
  setHandoff(result: ChildCallResult): void
  setSeat(result: ChildCallResult | ((path: string) => ChildCallResult)): void
  setTurn(outcome: TurnOutcome): void
}

/** 造一个假子进程客户端。 */
export function fakeChild(): FakeChild03 {
  const handlers = new Set<SubscribeHandlers>()
  const turns: string[] = []
  const decisions: { ticketId: string; decision: string; reason?: string }[] = []
  const verifies: string[] = []
  const handoffs: (string | undefined)[] = []
  const seats: { method: 'GET' | 'POST'; path: string; body?: unknown }[] = []
  let decideResult: ChildCallResult | ((ticketId: string) => ChildCallResult) = {
    status: 200,
    json: { ok: true },
    text: '{"ok":true}',
  }
  let verifyResult: ChildCallResult | ((ticketId: string) => ChildCallResult) = {
    status: 200,
    json: { ok: true },
    text: '{"ok":true}',
  }
  let handoffResult: ChildCallResult = { status: 200, json: { active: true }, text: '{"active":true}' }
  let seatResult: ChildCallResult | ((path: string) => ChildCallResult) = {
    status: 200,
    json: { ok: true },
    text: '{"ok":true}',
  }
  let turnOutcome: TurnOutcome = { kind: 'accepted' }

  return {
    calls: { turns, decisions, verifies, handoffs, seats },

    async turn(text: string): Promise<TurnOutcome> {
      turns.push(text)
      return turnOutcome
    },

    subscribe(subscriber: SubscribeHandlers): () => void {
      handlers.add(subscriber)
      subscriber.onOpen?.()
      return () => {
        handlers.delete(subscriber)
      }
    },

    async health(): Promise<boolean> {
      return true
    },

    async decide(ticketId, body): Promise<ChildCallResult> {
      decisions.push({
        ticketId,
        decision: body.decision,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      })
      return typeof decideResult === 'function' ? decideResult(ticketId) : decideResult
    },

    async verify(ticketId): Promise<ChildCallResult> {
      verifies.push(ticketId)
      return typeof verifyResult === 'function' ? verifyResult(ticketId) : verifyResult
    },

    async requestHandoff(reason): Promise<ChildCallResult> {
      handoffs.push(reason)
      return handoffResult
    },

    async seat(method, path, body): Promise<ChildCallResult> {
      seats.push({ method, path, ...(body === undefined ? {} : { body }) })
      return typeof seatResult === 'function' ? seatResult(path) : seatResult
    },

    emit(frame): void {
      for (const subscriber of [...handlers]) subscriber.onFrame(frame)
    },

    failStream(error): void {
      for (const subscriber of [...handlers]) {
        subscriber.onError?.(error ?? new Error('stream-boom'))
      }
    },

    subscribers: () => handlers.size,

    setDecide(result): void {
      decideResult = result
    },
    setVerify(result): void {
      verifyResult = result
    },
    setHandoff(result): void {
      handoffResult = result
    },
    setSeat(result): void {
      seatResult = result
    },
    setTurn(outcome): void {
      turnOutcome = outcome
    },
  }
}

/** 假监督者的可观测面。 */
export interface FakeSupervisor03 extends Supervisor {
  readonly records: Map<string, ChildRecord>
}

/** 造一条记录。 */
export function recordOf(input: {
  platform: string
  userId: string
  sessionKey: string
  client: ChildClient
  lastSeen?: number
}): ChildRecord {
  return {
    platform: input.platform,
    userId: input.userId,
    sessionKey: input.sessionKey,
    pid: 4242,
    port: 1234,
    token: 'child-web-token',
    csrf: 'child-csrf',
    lastSeen: input.lastSeen ?? 1_793_000_000_000,
    restarts: 0,
    firstStartAt: 1_793_000_000_000,
    status: 'ready',
    client: input.client,
    kill: () => undefined,
  }
}

/** 造一个假监督者（`ensure` 按派生出的 sessionKey 查表）。 */
export function fakeSupervisor(input: {
  readonly salt: string
  readonly records: Map<string, ChildRecord>
  readonly ensureError?: Error
}): FakeSupervisor03 {
  let spawns = 0
  return {
    records: input.records,

    async ensure(platform, userId): Promise<ChildHandle> {
      if (input.ensureError !== undefined) throw input.ensureError
      const sessionKey = deriveImSessionId(platform, userId, input.salt)
      const record = input.records.get(sessionKey)
      if (record === undefined || record.client === undefined) throw new Error('没有子进程')
      spawns += 1
      return { sessionKey, port: record.port, client: record.client }
    },

    get: (sessionKey) => input.records.get(sessionKey),
    list: () => [...input.records.values()],
    spawnCount: () => spawns,
    children: () => input.records.size,

    touch(sessionKey): void {
      const record = input.records.get(sessionKey)
      if (record !== undefined) record.lastSeen = 1_793_000_001_000
    },

    reapIdle: () => 0,
    stop: async (sessionKey): Promise<void> => {
      input.records.delete(sessionKey)
    },
    dispose: async (): Promise<void> => {
      input.records.clear()
    },
  }
}
