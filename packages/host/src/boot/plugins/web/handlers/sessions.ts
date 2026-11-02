/**
 * 历史会话面 handler（历史对话列表 · 2026-11-02）。
 *
 * ## 为什么是"只读"
 *
 * 本进程只服务一个会话：`WebDeps.session` / `firstAgent` 是 readonly 固定引用，22 个
 * handler 全部经由它们读写当前会话。分叉 handler 的头注释已经钉死这条边界——
 * "把渠道切到新会话属于多会话宿主（D4），未实现"。所以这里**只读**：
 * 不 append 任何事件、不改会话目录、不创建新 Agent。
 *
 * ## 为什么返回的是 snapshot 而不是 frames 数组
 *
 * `SnapshotFrame` 自带 `frames[]`（`frames.ts:344`），SSE 的 attach 也只发这一个帧。
 * 再在顶层给一份 `frames` 就是同一个数组的两份引用，前端要么双份渲染、要么自己写去重
 * ——那个麻烦是我们自己造出来的。
 *
 * ## 为什么必须先看目录名等于 sessionId
 *
 * IM 子进程重启时会把旧会话目录改名成 `<sessionId>-prev-<ts>`（`supervisor.ts:230`），
 * 而归档目录里 header 的 sessionId 仍是原值。只按 header 收集会把归档当成活动会话，
 * 去 open 一个不存在的规范目录。`core:persistence` 用的是同一条判据
 * （`persistence.ts:120-125`），这里照抄，不另立一套。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { projectSession } from '@bah/channels'
import { describeThrown } from '@bah/core'
import { JsonlPersistence } from '@bah/persistence'
import type { AnySessionEvent } from '@bah/runtime'
import { assertSafePathSegment } from '@bah/util'

import type { WebDeps, WebRequest } from '../deps.ts'
import type { SessionFiles } from '../../persistence.ts'
import { sendError, sendJson } from '../http.ts'

/** 列表缺省条数（一屏够用，不要求前端分页）。 */
const DEFAULT_LIMIT = 20
/** 列表上限：超过就是调用方在拿列表当导出用。 */
const MAX_LIMIT = 100
/** 标题截断长度（中文按字符数，不按字节）。 */
const TITLE_MAX_CHARS = 24
/** 单会话回放的响应上限，与 `/api/trace` 同口径（超了 503，不截断半棵树）。 */
const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024

/**
 * 没有用户发言时的占位标题。
 *
 * 这类会话（只剩策略装载 / 身份绑定 / 运行时上下文几条启动事件）**不进列表**：
 * 进程每启动一次就落一个，实测本机一天能攒出十几个，它们会占满第一屏把真实对话挤下去。
 * 但直接按 id 回放仍然允许——"这个会话里到底写了什么"是排障问题，不该被产品口味挡住。
 */
const NO_DIALOG_TITLE = '（无对话内容）'

/**
 * 会话根的归属自检。
 *
 * `SessionFiles.root` 应当等于 `<config.root>/<tenantId>`（`tenant-root.ts` 的唯一公式），
 * 这里**不重新拼路径**，只核对一次尾部。理由是 AR-01 的形态：`SessionFiles` 若被别处
 * 错误构造（漏拼租户段、或把 `baseRoot` 当 `root` 传进来），列出来的就是**别人的会话**；
 * 那种错误不会自己报错，只会安静地把跨租户数据端给前端。
 */
function tenantRootMatches(files: SessionFiles): boolean {
  return files.root.replaceAll('\\', '/').endsWith(`/${String(files.tenantId)}`)
}

/** 列表一行。 */
export interface SessionSummary {
  readonly sessionId: string
  readonly title: string
  readonly startedAt: number
  readonly lastAt: number
  readonly events: number
  readonly turns: number
  /** 是否是本进程正在服务的会话（前端据此高亮，不给"打开"按钮）。 */
  readonly current: boolean
}

/**
 * 只读句柄工厂。
 *
 * `redact: false` 与 replay 一致：落盘内容已经脱敏过，读取时再改一遍会让
 * "看到的历史"与"审计里的历史"不是同一份。
 */
function readonlyBackend(): JsonlPersistence {
  return new JsonlPersistence({ fsync: false, redact: false, warn: () => undefined })
}

/** 按码点截断（`slice` 会切断代理对，把 emoji 切成半个）。 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text.trim())
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, max).join('')}…`
}

/** 从事件序列抽列表摘要（只做一次线性扫描，不解析工具载荷）。 */
function summarize(
  sessionId: string,
  events: readonly AnySessionEvent[],
  current: string,
): SessionSummary {
  let title = ''
  let turns = 0
  for (const event of events) {
    if (title === '' && event.type === 'user/message') {
      const data = event.data as
        | { readonly content?: unknown; readonly source?: unknown }
        | undefined
      /**
       * 不是每条 `user/message` 都是用户说的话。
       *
       * `runtime-context` 是每次请求现渲染的用户档案（姓名/等级/余额），`context` 是
       * 工具后置纠正，`handoff-handover` 是人工交回时的系统交接语——拿它们当标题，
       * 列表里就会显示"【当前用户】姓名：张三；等级：金卡"，既是**错的**（没人这么说话）
       * 也是**不该出现在列表里的**（PII 上屏）。
       *
       * 判据与 `apps/web/src/main.js:386` 的 `isUserSpeechFrame` 逐字相同：前端认哪些帧是
       * 用户发言，这里就认哪些事件是用户发言——两处判据分叉就会出现"列表标题和气泡对不上"。
       */
      const source = data?.source
      const isUserSpeech =
        source === undefined || source === 'user' || source === 'handoff-waiting'
      if (isUserSpeech && typeof data?.content === 'string' && data.content.trim() !== '') {
        title = truncate(data.content, TITLE_MAX_CHARS)
      }
    }
    if (event.type === 'turn/end') turns += 1
  }
  const first = events[0]
  const last = events[events.length - 1]
  return {
    sessionId,
    // 没有用户消息的会话（只剩策略装载、身份绑定这类启动事件）不该冒充"一次对话"
    title: title === '' ? NO_DIALOG_TITLE : title,
    startedAt: first?.at ?? 0,
    lastAt: last?.at ?? 0,
    events: events.length,
    turns,
    current: sessionId === current,
  }
}

/** 一个成功打开的会话目录。 */
interface LoadedSession {
  /** 文件头里写的会话 id（归档目录里它仍是**原** id）。 */
  readonly sessionId: string
  readonly events: readonly AnySessionEvent[]
}

/**
 * 打开一个会话目录。
 *
 * 读坏 / 半写 / 目录不存在一律返回 `undefined`：**一个坏目录不该毁掉整个列表**。
 * 这也是不用 `JsonlPersistence.list()` 的原因——它在 `readHeader` 抛异常时是整体的，
 * 一个 `session.jsonl` 被写坏会让 2234 个正常会话一起消失（2026-11-02 实测踩到）。
 */
function loadSession(backend: JsonlPersistence, dir: string): LoadedSession | undefined {
  try {
    const handle = backend.open(dir, { mode: 'read' })
    return {
      sessionId: String(handle.header.sessionId),
      events: handle.events() as readonly AnySessionEvent[],
    }
  } catch {
    return undefined
  }
}

/**
 * `GET /api/sessions?limit=N` —— 历史会话摘要列表。
 *
 * 只扫本进程的租户根：`SessionFiles.root` 等于 `<config.root>/<tenantId>`，**已含租户段**，
 * 所以这里不再自己 `join` 一次（`tenant-root.ts` 是唯一公式；AR-01 的教训是一处漏拼
 * 不会报错，只会让审计跑到租户外）。`tenantId` 只用来解释"这棵树属于谁"，不参与拼路径。
 *
 * **不跨运行目录**：`--jsonl` 每换一个部署根，历史就在另一棵树下；跨运行发现需要新增
 * 配置面，不在本单（见对抗式审查的头号问题）。
 */
export async function handleSessionList(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const files = deps.sessionFiles
  if (files === undefined) {
    sendError(res, 503, 'persistence-absent', '本部署没有装配 core:persistence，无法列出历史会话')
    return
  }
  if (!tenantRootMatches(files)) {
    sendError(res, 500, 'tenant-root-mismatch', '会话根的租户段与进程租户不一致，拒绝列出历史')
    return
  }

  const rawLimit = request.url.searchParams.get('limit')
  let limit = DEFAULT_LIMIT
  if (rawLimit !== null) {
    const parsed = Number(rawLimit)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      sendError(
        res,
        400,
        'sessions-invalid-limit',
        `limit 必须是 1..${String(MAX_LIMIT)} 的整数（收到 ${rawLimit}）`,
      )
      return
    }
    limit = parsed
  }

  const backend = readonlyBackend()
  let entries
  try {
    entries = readdirSync(files.root, { withFileTypes: true })
  } catch {
    // 与 `core:persistence` 同口径：根目录不存在 = 本次是全新部署；
    // "列不出来"不等于"读坏了"，更不能因此回 500。
    sendJson(res, 200, { sessions: [], total: 0 })
    return
  }

  const current = String(deps.session.sessionId)
  const rows: SessionSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const loaded = loadSession(backend, join(files.root, entry.name))
    if (loaded === undefined || loaded.events.length === 0) continue
    // 归档目录（`<sid>-prev-<ts>`）里文件头的 sessionId 仍是原值；
    // 活动会话的目录名必须等于它。`core:persistence:120-125` 用的是同一条判据。
    if (entry.name !== loaded.sessionId) continue
    const summary = summarize(loaded.sessionId, loaded.events, current)
    // 空壳会话（只剩启动事件）不进列表：进程每启动一次就落一个，会占满第一屏
    if (summary.title === NO_DIALOG_TITLE) continue
    rows.push(summary)
  }

  // 新的在前：历史列表的第一屏就该是"最近聊过什么"
  rows.sort((left, right) => right.lastAt - left.lastAt)
  sendJson(res, 200, { sessions: rows.slice(0, limit), total: rows.length })
}

/**
 * `GET /api/sessions/{id}` —— 单会话只读回放。
 *
 * 返回体只有一份 `snapshot`（含 frames）。前端 `store.apply(snapshot)` 一行就能重建
 * 整个视图，与 SSE 的 attach 走同一条路径。
 */
export async function handleSessionRead(
  _req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const files = deps.sessionFiles
  if (files === undefined) {
    sendError(res, 503, 'persistence-absent', '本部署没有装配 core:persistence，无法回放历史会话')
    return
  }
  if (!tenantRootMatches(files)) {
    sendError(res, 500, 'tenant-root-mismatch', '会话根的租户段与进程租户不一致，拒绝回放')
    return
  }

  const raw = request.rest.replace(/\/+$/, '')
  if (raw === '') {
    sendError(res, 404, 'session-not-found', '缺少会话 ID')
    return
  }

  let sessionId: string
  try {
    sessionId = decodeURIComponent(raw)
    // 会话 ID 会拼进路径：先过白名单，绝不允许 `../../etc/passwd` 之类进来
    assertSafePathSegment(sessionId, 'sessionId')
  } catch (error) {
    sendError(res, 400, 'sessions-invalid-id', `会话 ID 非法：${describeThrown(error)}`)
    return
  }

  const backend = readonlyBackend()
  const dir = join(files.root, sessionId)
  const loaded = loadSession(backend, dir)
  if (loaded === undefined) {
    // 目录在但读不出来 = 数据事故，不能伪装成"没有这个会话"；
    // 目录不在 = 用户点了个过期链接。两者必须给不同状态码。
    if (existsSync(dir)) {
      sendError(res, 500, 'session-unreadable', `会话日志读不出来：${sessionId}`)
      return
    }
    sendError(res, 404, 'session-not-found', `没有这个会话：${sessionId}`)
    return
  }

  const events = loaded.events
  const summary = summarize(sessionId, events, String(deps.session.sessionId))

  // 投影是纯函数，但它对**未知的 `turn/end.kind`** 会走 `assertNever` 抛错
  // （`project.ts:272` 的 noticeLevel）。读到旧版本/损坏事件时不能让 500 冒成崩溃栈。
  let snapshot
  try {
    snapshot = projectSession(events, sessionId).snapshot
  } catch (error) {
    sendError(res, 500, 'session-projection-failed', `会话事件投影失败：${describeThrown(error)}`)
    return
  }

  const payload = {
    sessionId,
    title: summary.title,
    startedAt: summary.startedAt,
    lastAt: summary.lastAt,
    events: summary.events,
    turns: summary.turns,
    readOnly: true,
    snapshot,
  }

  // 先量再写：`sendJson` 里没有上限判据，超限时它会把整个响应发出去。
  // 序列化两次是可接受的代价（单会话回放本来就是低频动作），换来安全头只有一处实现。
  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_TRANSCRIPT_BYTES) {
    sendError(
      res,
      503,
      'session-too-large',
      '回放超过 4 MiB；请用 `pnpm bah audit replay --session <id>` 在终端查看',
    )
    return
  }

  sendJson(res, 200, payload)
}
