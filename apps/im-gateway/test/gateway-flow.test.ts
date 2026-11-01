/**
 * 网关流程：出站投递 / 入站编排 / HTTP 路由（02 单的集成面）。
 */

import { afterEach, describe, expect, it } from 'vitest'

import type {
  ChildCallResult,
  ChildClient,
  TurnOutcome,
  SubscribeHandlers,
} from '../src/session/client.ts'
import type { WebFrame, ImInbound, PlatformPushResult, PlatformReply, PlatformResponse } from '@bah/channels'
import { deriveImSessionId } from '@bah/channels'

import { ACK_TEXT, BUSY_TEXT, EMPTY_PULL_TEXT, FAILED_TEXT, MAINTENANCE_TEXT, QUEUE_FULL_TEXT, RATE_LIMITED_TEXT, loadConfig } from '../src/config.ts'
import { createPullStore, createTurnCollector, deliverTurn } from '../src/bridge/outbound.ts'
import { handleInbound, type InboundDeps } from '../src/bridge/turn.ts'
import { createDedupe } from '../src/ingress/dedupe.ts'
import { createRateLimiter } from '../src/ingress/ratelimit.ts'
import { createImLogger } from '../src/log.ts'
import { createRegistry } from '../src/platform/registry.ts'
import { createGatewayServer } from '../src/server.ts'
import { createSessionHub } from '../src/session/hub.ts'
import type { ChildHandle, Supervisor } from '../src/session/supervisor.ts'
import { createMockAdapter } from './mock-platform.ts'
import { listenOnSafePort } from './safe-port.ts'

const NOW = 1_793_000_000_000
/** 测试用盐（与 `inboundDeps` 的配置一致）。 */
const SALT = 'salt-0123456789abcdef'
/** `mock` + `u-1` 的真实会话键（不硬编码派生结果，避免与算法漂移）。 */
const SESSION_KEY = deriveImSessionId('mock', 'u-1', SALT)

/** 静默日志。 */
const log = createImLogger('error', () => undefined)

/** 一条可回复的帧。 */
function messageFrame(text: string): WebFrame {
  return { kind: 'message', seq: 1, at: NOW, role: 'assistant', blocks: [{ type: 'text', text }] }
}

/** 本轮结束帧。 */
function endFrame(): WebFrame {
  return { kind: 'turn', seq: 2, at: NOW, turn: 1, phase: 'end', endKind: 'completed' }
}

/** 假 reply：记录 passive 入参与 push 入参。 */
function fakeReply(options: { pushOk?: boolean } = {}): PlatformReply & {
  readonly passives: string[][]
  readonly pushes: string[][]
} {
  const passives: string[][] = []
  const pushes: string[][] = []
  return {
    passives,
    pushes,
    passive(outbounds): PlatformResponse {
      const texts = outbounds.map((outbound) => outbound.text)
      passives.push(texts)
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: texts.join('\n') }
    },
    async push(outbounds) {
      pushes.push(outbounds.map((outbound) => outbound.text))
      return options.pushOk === false ? { ok: false, code: 'unavailable', reason: 'fake' } : { ok: true }
    },
  }
}

/** 假子进程客户端：turn 时按脚本推帧。 */
function fakeClient(options: { frames?: readonly WebFrame[]; outcome?: TurnOutcome } = {}): ChildClient & {
  readonly turns: string[]
} {
  const turns: string[] = []
  return {
    turns,
    async turn(text: string): Promise<TurnOutcome> {
      turns.push(text)
      return options.outcome ?? { kind: 'accepted' }
    },
    subscribe(handlers: SubscribeHandlers): () => void {
      handlers.onOpen?.()
      const frames = options.frames ?? [messageFrame('回复'), endFrame()]
      setTimeout(() => {
        for (const frame of frames) handlers.onFrame(frame)
      }, 0)
      return () => undefined
    },
    async health(): Promise<boolean> {
      return true
    },
    async decide(): Promise<ChildCallResult> {
      return { status: 200, json: { ok: true }, text: '{"ok":true}' }
    },
    async verify(): Promise<ChildCallResult> {
      return { status: 200, json: { ok: true }, text: '{"ok":true}' }
    },
    async requestHandoff(): Promise<ChildCallResult> {
      return { status: 200, json: { active: true }, text: '{"active":true}' }
    },
    async seat(): Promise<ChildCallResult> {
      return { status: 200, json: { ok: true }, text: '{"ok":true}' }
    },
  }
}

/** 假监督者（`ensureErrorAfter` 指定第几次之后开始抛）。 */
function fakeSupervisor(
  handles: ChildHandle[],
  options: { children?: number; ensureError?: Error; ensureErrorAfter?: number } = {},
): Supervisor {
  let index = 0
  let calls = 0
  const base = { get: () => undefined, list: () => [], spawnCount: () => 0, children: () => options.children ?? handles.length, touch: () => undefined, reapIdle: () => 0, stop: async () => undefined, dispose: async () => undefined }
  return {
    ...base,
    async ensure(): Promise<ChildHandle> {
      calls += 1
      if (options.ensureError !== undefined && calls > (options.ensureErrorAfter ?? 0)) {
        throw options.ensureError
      }
      const handle = handles[index]
      if (handle === undefined) throw new Error('没有更多假子进程')
      index += 1
      return handle
    },
  }
}

/** 入站 fixture。 */
function inbound(overrides: Partial<ImInbound> = {}): ImInbound {
  return {
    platform: 'mock',
    accountKey: 'default',
    userId: 'u-1',
    text: '查余额',
    messageId: 'm-1',
    at: NOW,
    ...overrides,
  }
}

/** 造一组入站依赖。 */
function inboundDeps(handle: ChildHandle, overrides: Partial<InboundDeps> = {}): InboundDeps {
  const config = loadConfig(
    {
      BAH_IM_SESSION_SALT: 'salt-0123456789abcdef',
      BAH_WECHAT_APPID: 'demo-app',
      BAH_WECHAT_SECRET: 'demo-secret',
      BAH_WECHAT_TOKEN: 'demo-callback-token',
      BAH_IM_LINK_SECRET: 'link-secret-0123456789abcdefghij',
      BAH_IM_PASSIVE_WAIT_MS: '800',
    },
    'D:/repo',
  )
  const capabilities = { passiveReply: true, asyncPush: true, interactiveCards: false, threads: false, maxTextBytes: 2048 }
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  return {
    config,
    supervisor: fakeSupervisor([handle]),
    dedupe: createDedupe({ nowMs: () => NOW }),
    rateLimiter: createRateLimiter(),
    pull,
    hub,
    log,
    capabilitiesOf: () => capabilities,
    openWaitMs: 10,
    ...overrides,
  }
}

/** 假句柄。 */
function handleOf(client: ChildClient): ChildHandle {
  return { sessionKey: SESSION_KEY, port: 1234, client }
}

afterEach(() => {
  // 无全局资源需要清理（所有 server 在用例内主动关闭）
})

describe('deliverTurn（§2.13 的能力驱动）', () => {
  const capabilities = { passiveReply: true, asyncPush: true, interactiveCards: false, threads: false, maxTextBytes: 2048 }

  it('auto：等到消息 → 一次性被动回复，不 push', async () => {
    const collector = createTurnCollector()
    const reply = fakeReply()
    const pull = createPullStore({ nowMs: () => NOW })
    const pending = deliverTurn({ mode: 'auto', capabilities, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 200, log })
    setTimeout(() => {
      collector.push(messageFrame('余额 1000 元'))
    }, 0)
    const result = await pending
    expect(reply.passives).toEqual([['余额 1000 元']])
    expect(reply.pushes).toEqual([])
    await result.done
  })

  it('auto：超时 → 先 ack，后台等到结束再 push', async () => {
    const collector = createTurnCollector()
    const reply = fakeReply()
    const pull = createPullStore({ nowMs: () => NOW })
    const result = await deliverTurn({ mode: 'auto', capabilities, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 50, log })
    expect(reply.passives[0]).toEqual([ACK_TEXT])
    setTimeout(() => {
      collector.push(messageFrame('迟到结果'))
      collector.push(endFrame())
    }, 0)
    await result.done
    expect(reply.pushes).toEqual([['迟到结果']])
  })

  it('auto：push 失败 → 落拉取式（回复 0 可取回）', async () => {
    const collector = createTurnCollector()
    const reply = fakeReply({ pushOk: false })
    const pull = createPullStore({ nowMs: () => NOW })
    const result = await deliverTurn({ mode: 'auto', capabilities, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 10, log })
    setTimeout(() => {
      collector.push(messageFrame('结果'))
      collector.push(endFrame())
    }, 0)
    await result.done
    expect(reply.pushes.length).toBe(1)
    expect(pull.latest('k')).toBe('结果')
  })

  it('pull 模式：不调 push，只落拉取式', async () => {
    const collector = createTurnCollector()
    const reply = fakeReply()
    const pull = createPullStore({ nowMs: () => NOW })
    const result = await deliverTurn({ mode: 'pull', capabilities, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 10, log })
    expect(reply.passives[0]).toEqual([ACK_TEXT])
    setTimeout(() => {
      collector.push(messageFrame('结果'))
      collector.push(endFrame())
    }, 0)
    await result.done
    expect(reply.pushes).toEqual([])
    expect(pull.latest('k')).toBe('结果')
  })

  it('asyncPush=false → auto 退化为 passive + 拉取式（能力位与行为一致）', async () => {
    const collector = createTurnCollector()
    const reply = fakeReply()
    const pull = createPullStore({ nowMs: () => NOW })
    const noPush = { ...capabilities, asyncPush: false }
    const result = await deliverTurn({ mode: 'auto', capabilities: noPush, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 10, log })
    setTimeout(() => {
      collector.push(messageFrame('结果'))
      collector.push(endFrame())
    }, 0)
    await result.done
    expect(reply.pushes).toEqual([])
    expect(pull.latest('k')).toBe('结果')
  })

  it('空出站不 push（用户消息不回发）', async () => {
    const collector = createTurnCollector()
    const reply = fakeReply()
    const pull = createPullStore({ nowMs: () => NOW })
    const result = await deliverTurn({ mode: 'auto', capabilities, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 10, log })
    setTimeout(() => {
      collector.push({ kind: 'message', seq: 1, at: NOW, role: 'user', blocks: [{ type: 'text', text: '我自己的话' }] })
      collector.push(endFrame())
    }, 0)
    await result.done
    expect(reply.pushes).toEqual([])
    expect(pull.latest('k')).toBeUndefined()
  })

  it('push 抛异常 → 按失败处理并落拉取式（不传播）', async () => {
    const collector = createTurnCollector()
    const reply = { ...fakeReply(), push: async () => { throw new Error('boom') } }
    const pull = createPullStore({ nowMs: () => NOW })
    const result = await deliverTurn({ mode: 'auto', capabilities, sessionKey: 'k', reply, collector, pull, passiveWaitMs: 10, log })
    setTimeout(() => {
      collector.push(messageFrame('结果'))
      collector.push(endFrame())
    }, 0)
    await result.done
    expect(pull.latest('k')).toBe('结果')
  })

  it('passiveReply=false：不得调用被动出口（能力位与行为一致）', async () => {
    const collector = createTurnCollector()
    const reply = {
      passive: (): PlatformResponse => {
        throw new Error('passive-unavailable')
      },
      push: async (): Promise<PlatformPushResult> => ({ ok: true }),
    }
    const noPassive = { ...capabilities, passiveReply: false }
    // 平台不能被动回复：同步响应必须是空体，不得把 ack 塞进 passive
    const result = await deliverTurn({ mode: 'push', capabilities: noPassive, sessionKey: 'k', reply, collector, pull: createPullStore({ nowMs: () => NOW }), passiveWaitMs: 10, log })
    expect(result.response.status).toBe(200)
    expect(result.response.body).toBe('')
    setTimeout(() => {
      collector.push(messageFrame('结果'))
      collector.push(endFrame())
    }, 0)
    await result.done
  })
})

describe('handleInbound（T-IM-001 的编排面）', () => {
  it('正常消息 → 被动回复；turns 收到原文', async () => {
    const client = fakeClient()
    const deps = inboundDeps(handleOf(client))
    const reply = fakeReply()
    const outcome = await handleInbound(deps, inbound(), reply)
    expect(client.turns).toEqual(['查余额'])
    expect(reply.passives[0]).toEqual(['回复'])
    await outcome.done
  })

  it('同 msgId 第二次 → success，不再跑 turn（T-IM-010）', async () => {
    const client = fakeClient()
    const deps = inboundDeps(handleOf(client))
    const reply = fakeReply()
    await handleInbound(deps, inbound(), reply)
    const second = await handleInbound(deps, inbound(), reply)
    expect(client.turns.length).toBe(1)
    expect(second.response.body).toBe('success')
  })

  it('限流命中 → 固定文案，不跑 turn', async () => {
    const client = fakeClient()
    const deps = inboundDeps(handleOf(client), {
      rateLimiter: createRateLimiter({ userLimit: 1, userWindowMs: 60_000 }),
    })
    const reply = fakeReply()
    await handleInbound(deps, inbound({ messageId: 'a' }), reply)
    const denied = await handleInbound(deps, inbound({ messageId: 'b' }), reply)
    expect(client.turns.length).toBe(1)
    expect(denied.response.body).toBe(RATE_LIMITED_TEXT)
  })

  it('untrusted：每条都打标记后转发（不自动降权为"拒答"）', async () => {
    const client = fakeClient()
    const config = loadConfig(
      {
        BAH_IM_SESSION_SALT: 'salt-0123456789abcdef',
        BAH_WECHAT_APPID: 'demo-app',
        BAH_WECHAT_SECRET: 'demo-secret',
        BAH_WECHAT_TOKEN: 'demo-callback-token',
        BAH_IM_LINK_SECRET: 'link-secret-0123456789abcdefghij',
        BAH_IM_UNTRUSTED_USERS: 'mock:u-1',
      },
      'D:/repo',
    )
    const deps = inboundDeps(handleOf(client), { config })
    await handleInbound(deps, inbound(), fakeReply())
    expect(client.turns[0]).toContain('⟦UNTRUSTED:im⟧')
  })

  it('fetch-latest：有缓存回结果，无缓存回"暂无新消息"（不启动子进程）', async () => {
    const client = fakeClient()
    const deps = inboundDeps(handleOf(client))
    const reply = fakeReply()
    const empty = await handleInbound(deps, inbound({ text: '0', messageId: 'z1' }), reply)
    expect(empty.response.body).toBe(EMPTY_PULL_TEXT)
    deps.pull.put(SESSION_KEY, '上次的结果')
    const filled = await handleInbound(deps, inbound({ text: '0', messageId: 'z2' }), reply)
    expect(filled.response.body).toBe('上次的结果')
    expect(client.turns).toEqual([])
  })

  it('inbox-full → "等上一条处理完"；halted → 维护文案', async () => {
    const busy = fakeClient({ outcome: { kind: 'inbox-full' } })
    const first = await handleInbound(inboundDeps(handleOf(busy)), inbound({ messageId: 'b1' }), fakeReply())
    expect(first.response.body).toBe(QUEUE_FULL_TEXT)

    const halted = fakeClient({ outcome: { kind: 'halted' } })
    const second = await handleInbound(inboundDeps(handleOf(halted)), inbound({ messageId: 'b2' }), fakeReply())
    expect(second.response.body).toBe(MAINTENANCE_TEXT)
  })

  it('子进程上限 → 当前咨询人数较多（不静默排队）', async () => {
    const client = fakeClient()
    const deps = inboundDeps(handleOf(client), {
      supervisor: fakeSupervisor([handleOf(client)], { ensureError: Object.assign(new Error('full'), { code: 'im-children-full' }) }),
    })
    const outcome = await handleInbound(deps, inbound({ messageId: 'c1' }), fakeReply())
    expect(outcome.response.body).toBe(BUSY_TEXT)
  })

  it('凭证失效 → 重建一次并成功（只重建一次）', async () => {
    const first = fakeClient({ outcome: { kind: 'auth' } })
    const second = fakeClient()
    let stopped = 0
    const supervisor: Supervisor = {
      ...fakeSupervisor([handleOf(first), handleOf(second)]),
      async stop() {
        stopped += 1
      },
    }
    const deps = inboundDeps(handleOf(first), { supervisor })
    const outcome = await handleInbound(deps, inbound({ messageId: 'd1' }), fakeReply())
    expect(stopped).toBe(1)
    expect(second.turns).toEqual(['查余额'])
    expect(outcome.response.status).toBe(200)
  })

  it('凭证失效且重建也失败 → 处理失败文案', async () => {
    const first = fakeClient({ outcome: { kind: 'auth' } })
    const deps = inboundDeps(handleOf(first), {
      supervisor: fakeSupervisor([handleOf(first)], { ensureError: new Error('cannot rebuild'), ensureErrorAfter: 1 }),
    })
    const outcome = await handleInbound(deps, inbound({ messageId: 'e1' }), fakeReply())
    expect(outcome.response.body).toBe(FAILED_TEXT)
  })
})

describe('HTTP 路由（T-IM-022）', () => {
  /** 起一个只带 mock 适配器的网关服务。 */
  async function startServer(handleMessage = async (): Promise<{ response: PlatformResponse; done: Promise<void> }> => ({
    response: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
    done: Promise.resolve(),
  })): Promise<{ base: string; close(): Promise<void> }> {
    const registry = createRegistry([createMockAdapter()])
    const server = createGatewayServer({
      registry,
      log,
      handleMessage,
      children: () => 0,
      startedAtMs: NOW,
      nowMs: () => NOW,
    })
    const port = await listenOnSafePort(server)
    return {
      base: `http://127.0.0.1:${String(port)}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    }
  }

  it('GET /healthz → 只给数量，不给账号/用户', async () => {
    const app = await startServer()
    const response = await fetch(`${app.base}/healthz`)
    const body = (await response.json()) as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body['platforms']).toBe(1)
    expect(body['children']).toBe(0)
    expect(JSON.stringify(body)).not.toContain('mock')
    expect(JSON.stringify(body)).not.toContain('u-1')
    await app.close()
  })

  it('未知平台 / 未知账号 → 404 im-unknown-platform', async () => {
    const app = await startServer()
    const unknown = await fetch(`${app.base}/im/feishu/default?token=mock-token`)
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe('im-unknown-platform')
    const account = await fetch(`${app.base}/im/mock/other?token=mock-token`)
    expect(account.status).toBe(404)
    await app.close()
  })

  it('挑战请求 → 原样回显 echostr', async () => {
    const app = await startServer()
    const response = await fetch(`${app.base}/im/mock/default?token=mock-token&echostr=echo-1`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('echo-1')
    await app.close()
  })

  it('验签失败 → 401，响应体只有 invalid signature', async () => {
    const app = await startServer()
    const response = await fetch(`${app.base}/im/mock/default?token=bad`, {
      method: 'POST',
      body: '{"userId":"u-1","text":"查余额"}',
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toBe('invalid signature')
    await app.close()
  })

  it('文本消息 → handleMessage 被调用', async () => {
    let calls = 0
    const app = await startServer(async () => {
      calls += 1
      return { response: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'handled' }, done: Promise.resolve() }
    })
    const response = await fetch(`${app.base}/im/mock/default?token=mock-token`, {
      method: 'POST',
      body: '{"userId":"u-1","text":"查余额"}',
    })
    expect(await response.text()).toBe('handled')
    expect(calls).toBe(1)
    await app.close()
  })

  it('未知路径 / 不支持的方法 → 404', async () => {
    const app = await startServer()
    expect((await fetch(`${app.base}/nope`)).status).toBe(404)
    expect((await fetch(`${app.base}/im/mock/default?token=mock-token`, { method: 'PUT' })).status).toBe(404)
    await app.close()
  })

  it('超大 body → 413（不整段读进内存）', async () => {
    const app = await startServer()
    const response = await fetch(`${app.base}/im/mock/default?token=mock-token`, {
      method: 'POST',
      body: 'x'.repeat(70 * 1024),
    })
    expect(response.status).toBe(413)
    await app.close()
  })

  it('handleMessage 抛错 → 500 且服务不崩', async () => {
    const app = await startServer(async () => {
      throw new Error('boom')
    })
    const response = await fetch(`${app.base}/im/mock/default?token=mock-token`, {
      method: 'POST',
      body: '{"userId":"u-1","text":"查余额"}',
    })
    expect(response.status).toBe(500)
    // 服务仍可响应下一次请求
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200)
    await app.close()
  })

  it('后台任务拒绝 → 不产生 unhandledRejection（进程不崩）', async () => {
    let unhandled = 0
    const onUnhandled = (): void => {
      unhandled += 1
    }
    process.on('unhandledRejection', onUnhandled)
    const app = await startServer(async () => ({
      response: { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' },
      done: Promise.reject(new Error('background-boom')),
    }))
    const response = await fetch(`${app.base}/im/mock/default?token=mock-token`, {
      method: 'POST',
      body: '{"userId":"u-1","text":"查余额"}',
    })
    expect(await response.text()).toBe('ok')
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toBe(0)
    await app.close()
  })
})
