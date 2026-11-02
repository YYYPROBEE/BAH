/**
 * 假子进程——**仅测试**。
 *
 * 形状与真实子进程的 HTTP 面一致：`/api/health`、`/m.html`（下发 `bah_csrf`）、
 * `/api/events`（SSE）、`/api/turn`。它不跑模型，只按脚本产帧——
 * 于是"订阅 → turn → 出站"这条链路可以在毫秒级测完，不必真的拉起 `--profile im`。
 *
 * 它实现 `LaunchedChild`（`kill` / `onExit`），因此能直接喂给监督者的注入 launcher，
 * 用来测崩溃重启与闲置回收。
 */

import { createServer, type Server, type ServerResponse } from 'node:http'

import type { WebFrame } from '@bah/channels'

import type { LaunchedChild } from '../src/session/supervisor.ts'

/** 假子进程的可观测面。 */
export interface FakeChildApi {
  readonly port: number
  readonly token: string
  readonly csrf: string
  /** 收到的 turn 文本（断言"文案是否带 untrusted 标记"）。 */
  readonly turns: string[]
  /** 推一帧给当前 SSE 订阅者（无订阅者则丢弃）。 */
  pushFrame(frame: WebFrame): void
  /** 下一次 `/api/turn` 的结论。 */
  setNextTurn(outcome: 'accepted' | 'inbox-full' | 'halted' | 'auth' | 'failed'): void
  /** 等 SSE 订阅建立（拿不到就超时）。 */
  waitSubscriber(ms?: number): Promise<void>
  close(): Promise<void>
}

/** 假子进程句柄（`crash()` 用来模拟非预期退出）。 */
export interface FakeChildHandle extends LaunchedChild {
  readonly api: FakeChildApi
  crash(): void
}

/** 假子进程选项。 */
export interface FakeChildOptions {
  /** 收到 turn 后自动产的帧（默认：一条助手消息 + turn/end）。 */
  readonly reply?: (text: string) => readonly WebFrame[]
  readonly token?: string
  readonly csrf?: string
  readonly pid?: number
}

/** 默认回复帧（seq 从 1 起，形状与宿主投影的帧一致）。 */
function defaultReply(text: string): readonly WebFrame[] {
  const at = Date.now()
  return [
    {
      kind: 'message',
      seq: 1,
      at,
      role: 'assistant',
      blocks: [{ type: 'text', text: `回复：${text}` }],
    },
    { kind: 'turn', seq: 2, at, turn: 1, phase: 'end', endKind: 'completed' },
  ]
}

/**
 * 在 `port` 上启动一个假子进程。
 *
 * 调用方（测试）负责给一个**空闲端口**（生产由 `reservePort` 预分配）。
 */
export function launchFakeChild(port: number, options: FakeChildOptions = {}): FakeChildHandle {
  const token = options.token ?? 'fake-web-token'
  const csrf = options.csrf ?? 'fake-csrf'
  const turns: string[] = []
  let nextTurn: 'accepted' | 'inbox-full' | 'halted' | 'auth' | 'failed' = 'accepted'
  let sse: ServerResponse | undefined
  let notifySubscriber: (() => void) | undefined
  const subscriberReady = new Promise<void>((resolve) => {
    notifySubscriber = resolve
  })
  let exitListener: ((code: number | null) => void) | undefined
  let closed = false

  const emit = (frames: readonly WebFrame[]): void => {
    if (sse === undefined) return
    for (const frame of frames) {
      sse.write(`event: frame\ndata: ${JSON.stringify(frame)}\n\n`)
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (path === '/api/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, lastSeq: 0, pendingTicketCount: 0 }))
        return
      }

      if (path === '/m.html') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `bah_csrf=${csrf}; Path=/; SameSite=Strict`,
        })
        response.end('<html>fake</html>')
        return
      }

      if (path === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.write(': connected\n\n')
        sse = response
        notifySubscriber?.()
        request.on('close', () => {
          sse = undefined
        })
        return
      }

      if (path === '/api/turn' && request.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(chunk as Buffer)
        const body = Buffer.concat(chunks).toString('utf8')
        let text = ''
        try {
          const parsed: unknown = JSON.parse(body)
          if (typeof parsed === 'object' && parsed !== null) {
            const value = (parsed as Record<string, unknown>)['text']
            text = typeof value === 'string' ? value : ''
          }
        } catch {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'web-invalid-json', reason: 'bad json' } }))
          return
        }
        turns.push(text)

        if (nextTurn === 'inbox-full') {
          nextTurn = 'accepted'
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'web-inbox-full', reason: 'full' } }))
          return
        }
        if (nextTurn === 'halted') {
          nextTurn = 'accepted'
          response.writeHead(423, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'safety-halted', reason: 'halted' } }))
          return
        }
        if (nextTurn === 'auth') {
          nextTurn = 'accepted'
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'web-unauthorized', reason: 'bad token' } }))
          return
        }
        if (nextTurn === 'failed') {
          nextTurn = 'accepted'
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 'web-internal', reason: 'boom' } }))
          return
        }

        response.writeHead(202, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        // 入队之后才产帧：与真实宿主的顺序一致（先 202，再 SSE）
        setTimeout(() => {
          emit((options.reply ?? defaultReply)(text))
        }, 0)
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'web-not-found', reason: 'nope' } }))
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  server.listen(port, '127.0.0.1')

  const api: FakeChildApi = {
    port,
    token,
    csrf,
    turns,
    pushFrame: (frame) => emit([frame]),
    setNextTurn: (outcome) => {
      nextTurn = outcome
    },
    waitSubscriber: async (ms = 2_000): Promise<void> => {
      await Promise.race([
        subscriberReady,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          timer.unref()
        }),
      ])
    },
    close: async (): Promise<void> => {
      if (closed) return
      closed = true
      sse?.end()
      sse = undefined
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    },
  }

  return {
    api,
    pid: options.pid ?? 20_000 + port,
    kill: () => {
      void api.close()
    },
    onExit: (listener) => {
      exitListener = listener
    },
    crash: () => {
      void api.close()
      exitListener?.(1)
    },
  }
}
