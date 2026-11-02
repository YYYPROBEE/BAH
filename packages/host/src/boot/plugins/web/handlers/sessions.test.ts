/**
 * 历史会话面 handler 的单测（历史对话列表 · 2026-11-02）。
 *
 * 为什么**不起 HTTP**：这两条 handler 的输入只有「租户根 + 会话目录 + 请求路径」，
 * 用假 req/res 直接调函数就能覆盖全部分支，且不引入 `listen(0)` 在 Windows 上
 * 落到 undici 禁用端口段（6566/6665-6669/6679/6697）导致的随机 `bad port` 假红。
 * 路由接线（prefix 与 exact 的顺序）由本文件的 `matchRoute` 用例守。
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionApi } from '@bah/runtime'
import { DEFAULT_TENANT_ID } from '@bah/util'
import { JsonlPersistence } from '@bah/persistence'
import { describe, expect, it } from 'vitest'

import type { WebDeps, WebRequest } from '../deps.ts'
import { matchRoute } from '../router.ts'
import { handleSessionList, handleSessionRead } from './sessions.ts'

const NOW = 1_700_000_000_000

/** 收集响应的假 res（只实现两条 handler 用到的 `writeHead` / `end`）。 */
function fakeRes(): { res: ServerResponse; out: { status: number; body: string } } {
  const out = { status: 0, body: '' }
  const res = {
    writeHead(status: number) {
      out.status = status
      return res
    },
    end(body?: string) {
      out.body = body ?? ''
      return res
    },
  } as unknown as ServerResponse
  return { res, out }
}

/** 请求面：`rest` 单独给，因为 prefix 路由的 id 就是它。 */
function request(path: string, rest = ''): WebRequest {
  const url = new URL(`http://127.0.0.1${path}`)
  return { method: 'GET', url, path: url.pathname, rest }
}

/** 最小 deps：只有两条 handler 真正读的字段，其余是空壳。 */
function deps(
  root: string | undefined,
  sessionId = 's-current',
  tenantId: string = DEFAULT_TENANT_ID,
): WebDeps {
  return {
    session: { sessionId, lastSeq: () => 0 } as unknown as SessionApi,
    sessionFiles:
      root === undefined
        ? undefined
        : {
            root,
            baseRoot: root,
            tenantId,
            fileOf: (id: string) => join(root, id, 'session.jsonl'),
          },
  } as unknown as WebDeps
}

/** 写一个会话目录；`events` 是 `[type, data]` 序列。 */
function seed(
  root: string,
  sessionId: string,
  events: readonly (readonly [string, Record<string, unknown>])[],
): void {
  const backend = new JsonlPersistence({ fsync: false, redact: false, warn: () => undefined })
  const handle = backend.create(join(root, sessionId), sessionId as never, { now: NOW })
  events.forEach(([type, data], index) => {
    handle.append({
      seq: index + 1,
      at: NOW + index,
      formatVersion: 1,
      type,
      data,
    } as never)
  })
  handle.close?.()
}

/** 造一个空租户根（路径以租户段结尾，与 `tenantRootOf` 的形态一致）。 */
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-sessions-web-'))
  // `SessionFiles.root` = `<config.root>/<tenantId>`；归属自检要求这个尾部形态，
  // 所以直接把租户段拼进临时目录，而不是让用例去记忆"root 该怎么拼"。
  return join(dir, DEFAULT_TENANT_ID)
}

describe('GET /api/sessions · 列表', () => {
  it('按最近活动降序，并标出当前会话', async () => {
    const base = root()
    seed(base, 's-old', [
      ['user/message', { content: '查余额' }],
      ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ])
    seed(base, 's-new', [
      ['user/message', { content: '转 500 给他' }],
      ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
      ['user/message', { content: '再确认下' }],
    ])

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base, 's-new'))

    expect(out.status).toBe(200)
    const body = JSON.parse(out.body) as {
      sessions: { sessionId: string; title: string; turns: number; current: boolean }[]
      total: number
    }
    expect(body.total).toBe(2)
    expect(body.sessions[0]?.sessionId).toBe('s-new')
    expect(body.sessions[0]?.current).toBe(true)
    expect(body.sessions[0]?.title).toBe('转 500 给他')
    expect(body.sessions[0]?.turns).toBe(1)
    expect(body.sessions[1]?.sessionId).toBe('s-old')
    expect(body.sessions[1]?.current).toBe(false)
  })

  it('空壳会话（只剩启动事件）不进列表——进程每启动一次就落一个', async () => {
    const base = root()
    seed(base, 's-boot', [['policy/bundle-loaded', { kind: 'bank.tier' }]])
    seed(base, 's-real', [['user/message', { content: '查余额' }]])

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base))
    const body = JSON.parse(out.body) as { sessions: { sessionId: string }[]; total: number }
    expect(body.sessions.map((item) => item.sessionId)).toEqual(['s-real'])
    expect(body.total).toBe(1)
  })

  it('运行时上下文不算用户发言，不进标题（否则列表里全是姓名与等级）', async () => {
    const base = root()
    seed(base, 's-ctx', [
      // 真实落盘顺序：每次请求先写一条 runtime-context，再写用户真正说的话
      ['user/message', { content: '【当前用户】姓名：张三；等级：金卡', source: 'runtime-context' }],
      ['user/message', { content: '查下余额', source: 'user' }],
      ['user/message', { content: '系统纠正：金额单位是元', source: 'context' }],
    ])

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base))
    const body = JSON.parse(out.body) as { sessions: { title: string }[] }
    expect(body.sessions[0]?.title).toBe('查下余额')
  })

  it('接管期客户留言（handoff-waiting）算用户发言', async () => {
    const base = root()
    seed(base, 's-wait', [['user/message', { content: '我要找人工', source: 'handoff-waiting' }]])

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base))
    const body = JSON.parse(out.body) as { sessions: { title: string }[] }
    expect(body.sessions[0]?.title).toBe('我要找人工')
  })

  it('只有上下文、没有用户发言：不进列表，但按 id 回放仍给占位标题（排障要看得到）', async () => {
    const base = root()
    seed(base, 's-only-ctx', [
      ['user/message', { content: '【当前用户】姓名：张三', source: 'runtime-context' }],
    ])

    const { res: listRes, out: listOut } = fakeRes()
    await handleSessionList({} as IncomingMessage, listRes, request('/api/sessions'), deps(base))
    expect((JSON.parse(listOut.body) as { sessions: unknown[] }).sessions).toEqual([])

    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-only-ctx', 's-only-ctx'),
      deps(base),
    )
    expect(out.status).toBe(200)
    expect((JSON.parse(out.body) as { title: string }).title).toBe('（无对话内容）')
  })

  it('标题按码点截断，超出加省略号', async () => {
    const base = root()
    const long = '一'.repeat(30)
    seed(base, 's-long', [['user/message', { content: long }]])

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base))
    const body = JSON.parse(out.body) as { sessions: { title: string }[] }
    expect(body.sessions[0]?.title).toBe(`${'一'.repeat(24)}…`)
  })

  it('过滤归档目录（<sid>-prev-<ts>）—— 它的文件头仍带原 sessionId', async () => {
    const base = root()
    seed(base, 's-live', [['user/message', { content: '还在' }]])
    // 归档：目录名带后缀，但 create 时写入的 sessionId 仍是 s-live
    const backend = new JsonlPersistence({ fsync: false, redact: false, warn: () => undefined })
    const handle = backend.create(join(base, 's-live-prev-1700000000000'), 's-live' as never, {
      now: NOW,
    })
    handle.append({
      seq: 1,
      at: NOW,
      formatVersion: 1,
      type: 'user/message',
      data: { content: '归档' },
    } as never)
    handle.close?.()

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base))
    const body = JSON.parse(out.body) as { sessions: { sessionId: string }[]; total: number }
    expect(body.total).toBe(1)
    expect(body.sessions.map((item) => item.sessionId)).toEqual(['s-live'])
  })

  it('跳过空目录与读坏的会话，不因此整体 500', async () => {
    const base = root()
    seed(base, 's-good', [['user/message', { content: '正常' }]])
    // 半写目录：有同名文件但不是合法 JSONL 头
    mkdirSync(join(base, 's-broken'), { recursive: true })
    writeFileSync(join(base, 's-broken', 'session.jsonl'), 'not-a-header\n', 'utf8')
    // 空目录：连 session.jsonl 都没有，list() 本就不会算它
    mkdirSync(join(base, 's-empty'), { recursive: true })

    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(base))
    expect(out.status).toBe(200)
    const body = JSON.parse(out.body) as { sessions: { sessionId: string }[]; total: number }
    expect(body.sessions.map((item) => item.sessionId)).toEqual(['s-good'])
  })

  it('租户根不存在 = 全新部署，返回空列表而不是 500', async () => {
    const { res, out } = fakeRes()
    await handleSessionList(
      {} as IncomingMessage,
      res,
      request('/api/sessions'),
      deps(join(tmpdir(), 'bah-不存在-的-根-9f2c', DEFAULT_TENANT_ID)),
    )
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body)).toEqual({ sessions: [], total: 0 })
  })

  it('limit 生效', async () => {
    const base = root()
    for (const id of ['s-1', 's-2', 's-3']) {
      seed(base, id, [['user/message', { content: id }]])
    }
    const { res, out } = fakeRes()
    await handleSessionList(
      {} as IncomingMessage,
      res,
      request('/api/sessions?limit=2'),
      deps(base),
    )
    const body = JSON.parse(out.body) as { sessions: unknown[]; total: number }
    expect(body.sessions).toHaveLength(2)
    expect(body.total).toBe(3)
  })

  it.each(['0', '101', 'abc', '1.5'])('limit=%s 是 400', async (value) => {
    const { res, out } = fakeRes()
    await handleSessionList(
      {} as IncomingMessage,
      res,
      request(`/api/sessions?limit=${value}`),
      deps(root()),
    )
    expect(out.status).toBe(400)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'sessions-invalid-limit',
    )
  })

  it('没装 core:persistence 时 503，而不是让渠道起不来', async () => {
    const { res, out } = fakeRes()
    await handleSessionList({} as IncomingMessage, res, request('/api/sessions'), deps(undefined))
    expect(out.status).toBe(503)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'persistence-absent',
    )
  })

  it('会话根的租户段与进程租户不一致 → 500（不把别人的会话列出来）', async () => {
    const base = root()
    seed(base, 's-x', [['user/message', { content: 'x' }]])
    const { res, out } = fakeRes()
    // 根是临时目录，不以 /acme 结尾 ⇒ 归属自检必须拦下
    await handleSessionList(
      {} as IncomingMessage,
      res,
      request('/api/sessions'),
      deps(base, 's-current', 'acme'),
    )
    expect(out.status).toBe(500)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'tenant-root-mismatch',
    )
  })
})

describe('GET /api/sessions/:id · 只读回放', () => {
  it('返回 snapshot（自带 frames），不给第二份 frames', async () => {
    const base = root()
    seed(base, 's-read', [
      ['user/message', { content: '查余额' }],
      ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ])

    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-read', 's-read'),
      deps(base),
    )

    expect(out.status).toBe(200)
    const body = JSON.parse(out.body) as {
      sessionId: string
      readOnly: boolean
      frames?: unknown
      snapshot: { kind: string; sessionId: string; frames: unknown[] }
    }
    expect(body.sessionId).toBe('s-read')
    expect(body.readOnly).toBe(true)
    // 顶层不该有第二份 frames：`SnapshotFrame` 已经自带
    expect(body.frames).toBeUndefined()
    expect(body.snapshot.kind).toBe('snapshot')
    expect(body.snapshot.sessionId).toBe('s-read')
    expect(body.snapshot.frames.length).toBeGreaterThan(0)
  })

  it('尾部斜杠被吃掉', async () => {
    const base = root()
    seed(base, 's-slash', [['user/message', { content: 'x' }]])
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-slash/', 's-slash/'),
      deps(base),
    )
    expect(out.status).toBe(200)
  })

  it('空 ID 是 404', async () => {
    const { res, out } = fakeRes()
    await handleSessionRead({} as IncomingMessage, res, request('/api/sessions/', ''), deps(root()))
    expect(out.status).toBe(404)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'session-not-found',
    )
  })

  it.each(['../../etc/passwd', '..', 'a/b'])('非法 ID %s 是 400', async (id) => {
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request(`/api/sessions/${id}`, id),
      deps(root()),
    )
    expect(out.status).toBe(400)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'sessions-invalid-id',
    )
  })

  it('URL 编码的穿越也拦得住', async () => {
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/x', '%2e%2e%2fetc'),
      deps(root()),
    )
    expect(out.status).toBe(400)
  })

  it('不存在的会话是 404', async () => {
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-nope', 's-nope'),
      deps(root()),
    )
    expect(out.status).toBe(404)
  })

  it('回放超过 4 MiB 时 503，不返回半棵树', async () => {
    const base = root()
    // 单条 5 MiB 的正文：足够把序列化推过阈值，又不用造几千条事件
    seed(base, 's-huge', [['user/message', { content: 'x'.repeat(5 * 1024 * 1024) }]])
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-huge', 's-huge'),
      deps(base),
    )
    expect(out.status).toBe(503)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'session-too-large',
    )
  })

  it('没装 core:persistence 时 503', async () => {
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-1', 's-1'),
      deps(undefined),
    )
    expect(out.status).toBe(503)
  })

  it('目录在但日志读不出来 → 500（不伪装成 404）', async () => {
    const base = root()
    mkdirSync(join(base, 's-broken'), { recursive: true })
    writeFileSync(join(base, 's-broken', 'session.jsonl'), 'not-a-header\n', 'utf8')

    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-broken', 's-broken'),
      deps(base),
    )
    expect(out.status).toBe(500)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'session-unreadable',
    )
  })

  it('未知的 turn/end.kind 不会让 handler 崩成栈，回 500 且带理由', async () => {
    const base = root()
    // 投影器对未知 kind 走 `assertNever`（project.ts:272）——旧版本/损坏事件会命中
    seed(base, 's-unknown', [
      ['user/message', { content: 'x' }],
      ['turn/end', { turn: 1, reason: { kind: '来自未来的结束原因' } }],
    ])

    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-unknown', 's-unknown'),
      deps(base),
    )
    expect(out.status).toBe(500)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'session-projection-failed',
    )
  })

  it('会话根的租户段与进程租户不一致 → 500', async () => {
    const base = root()
    seed(base, 's-x', [['user/message', { content: 'x' }]])
    const { res, out } = fakeRes()
    await handleSessionRead(
      {} as IncomingMessage,
      res,
      request('/api/sessions/s-x', 's-x'),
      deps(base, 's-current', 'acme'),
    )
    expect(out.status).toBe(500)
    expect((JSON.parse(out.body) as { error: { code: string } }).error.code).toBe(
      'tenant-root-mismatch',
    )
  })
})

describe('路由接线 · prefix 必须排在 exact 之前', () => {
  it('GET /api/sessions/abc 命中回放并带上 id', () => {
    const match = matchRoute('GET', '/api/sessions/abc')
    expect(match?.spec.handler).toBe('session-read')
    expect(match?.rest).toBe('abc')
  })

  it('GET /api/sessions 命中列表而不是回放', () => {
    const match = matchRoute('GET', '/api/sessions')
    expect(match?.spec.handler).toBe('sessions')
    expect(match?.rest).toBe('')
  })

  it('GET /api/session（单数）仍是当前会话，没被复数抢走', () => {
    expect(matchRoute('GET', '/api/session')?.spec.handler).toBe('session')
  })
})
