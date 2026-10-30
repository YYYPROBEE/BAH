/**
 * 假微信 API（施工单 02 §2.16）——**仅测试**。
 *
 * 两个端点：`/cgi-bin/token`（换 token）与 `/cgi-bin/message/custom/send`（客服消息）。
 * 有了它，`token.ts` 的单飞/过期/40001 重试与 `transport.ts` 的错误码映射都能在
 * 毫秒级跑完，不必碰真机。
 */

import { createServer, type IncomingMessage, type Server } from 'node:http'

/** 一次出站记录。 */
export interface FakeSend {
  readonly userId: string
  readonly text: string
}

/** 假 API 的对外句柄。 */
export interface FakeWechatApi {
  readonly baseUrl: string
  readonly sends: FakeSend[]
  /** token 端点被调用的次数（单飞断言）。 */
  tokenCalls(): number
  /** 下一次 send 返回指定 errcode（`undefined` = 正常）。 */
  failNextSend(errcode: number | undefined): void
  /** 当前 token 值（每次换 token 都轮换，便于断言"刷新了一次"）。 */
  currentToken(): string
  close(): Promise<void>
}

/** 启动参数。 */
export interface FakeWechatApiOptions {
  /** `expires_in`（秒）。 */
  readonly tokenExpiresIn?: number
}

/** 读请求体（JSON）。 */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return {}
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

/**
 * 启动假微信 API（127.0.0.1:0）。
 *
 * @param options 见 {@link FakeWechatApiOptions}
 */
export function startFakeWechatApi(options: FakeWechatApiOptions = {}): Promise<FakeWechatApi> {
  const sends: FakeSend[] = []
  let tokenCalls = 0
  let token = 'access-token-0'
  let pendingErrcode: number | undefined

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/cgi-bin/token') {
        tokenCalls += 1
        token = `access-token-${String(tokenCalls)}`
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ access_token: token, expires_in: options.tokenExpiresIn ?? 7200 }))
        return
      }
      if (url.pathname === '/cgi-bin/message/custom/send') {
        const body = await readJson(request)
        const errcode = pendingErrcode
        pendingErrcode = undefined
        if (errcode !== undefined) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ errcode, errmsg: 'fake-error' }))
          return
        }
        const touser = typeof body['touser'] === 'string' ? body['touser'] : ''
        const text = body['text']
        const content =
          typeof text === 'object' && text !== null ? (text as Record<string, unknown>)['content'] : undefined
        sends.push({ userId: touser, text: typeof content === 'string' ? content : '' })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ errcode: 404 }))
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  return new Promise<FakeWechatApi>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        sends,
        tokenCalls: () => tokenCalls,
        failNextSend: (errcode) => {
          pendingErrcode = errcode
        },
        currentToken: () => token,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
