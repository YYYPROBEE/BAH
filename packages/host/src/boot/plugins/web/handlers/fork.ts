/**
 * `POST /api/session/fork`：把"回到上一步"接成 HTTP。
 *
 * 语义（与 `runtime/src/agent-loop/rollback.ts` 头注释同源）：
 * - **原会话只读**：分叉不改写原日志一个字节——它是审计与回放的锚点；
 * - **种子 = 前缀**：新会话拿到到指定 turn 的 `turn/end` 为止的日志前缀；
 * - **新会话 = 新 Context**：`runtime:session` 是服务键，分叉必须另起上下文。
 *
 * 诚实边界（文档同文）：分叉会话在**本进程内**存在（前缀已恢复），但当前 HTTP 渠道
 * 仍服务原会话——"把渠道切到新会话"属于多会话宿主（D4），未实现。用户视角的
 * "回退"在账本视角是**新开一卷、旧卷封存**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { createContext, type SessionId } from '@bah/core'
import type { Agent } from '@bah/runtime'
import { BahError, errorCodeOf } from '@bah/util'

import type { WebDeps, WebRequest } from '../deps.ts'
import { readJson, sendError, sendJson } from '../http.ts'

/** 本进程的分叉登记表（重启即失——与人工接管同一边界，不宣称持久化）。 */
const FORKS = new Map<string, Agent>()

/** 测试用：清空登记表（生产不调用；每个进程只应有一个 web/mobile 渠道实例）。 */
export function clearForks(): void {
  for (const agent of FORKS.values()) {
    if (typeof agent.dispose === 'function') agent.dispose('fork-cleared')
  }
  FORKS.clear()
}

/** 分叉会话 id：确定性（父会话 + 边界 turn + 本进程序号），不用随机 UUID。 */
function nextForkId(parent: string, turn: number): SessionId {
  let seq = 1
  let candidate = `s-fork-${parent}-${String(turn)}-${String(seq)}`
  while (FORKS.has(candidate)) {
    seq += 1
    candidate = `s-fork-${parent}-${String(turn)}-${String(seq)}`
  }
  return candidate as SessionId
}

export async function handleFork(
  req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  if (deps.handoff.summary().active) {
    // 与 `/api/turn` 的 409 同口径：接管期不许改会话结构
    sendError(res, 409, 'fork-during-handoff', '人工接管中，不能分叉会话（先交回会话）')
    return
  }

  let body: Record<string, unknown>
  try {
    body = await readJson(req)
  } catch (error) {
    sendError(res, 400, 'web-invalid-body', error instanceof Error ? error.message : '请求体不是合法 JSON')
    return
  }

  const turn = body['turn']
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) {
    sendError(res, 400, 'fork-invalid-request', 'turn 必须是 ≥1 的整数（分叉边界是该 turn 的 turn/end）')
    return
  }

  const agent = deps.firstAgent()
  if (agent === undefined) {
    sendError(res, 404, 'fork-no-session', '当前没有活动会话可分叉')
    return
  }

  const parent = String(deps.session.sessionId)
  const sessionId = nextForkId(parent, turn)
  let forked: Agent
  try {
    forked = agent.fork({ sessionId, turn, ctx: createContext(), now: deps.now })
  } catch (error) {
    const code = errorCodeOf(error, 'fork-failed')
    if (code === 'fork-turn-missing') {
      // 天然覆盖 in-flight turn：正在跑的 turn 没有 turn/end
      sendError(res, 409, code, `turn ${String(turn)} 尚未完整结束，不能作为分叉边界`)
      return
    }
    if (code === 'session-seq-gap') {
      sendError(res, 500, code, '原会话日志断代（数据完整性事故），拒绝分叉')
      return
    }
    throw new BahError('fork-failed', `分叉失败：${error instanceof Error ? error.message : String(error)}`, {
      turn,
    })
  }

  FORKS.set(String(forked.sessionId), forked)
  sendJson(res, 200, {
    sessionId: String(forked.sessionId),
    parentSession: parent,
    seedLength: forked.forkInfo?.seedLength ?? 0,
    turn: forked.forkInfo?.turn ?? turn,
    forkOf: String(forked.forkInfo?.parentSession ?? parent),
    note: '原会话保留可查：分叉只新建，不改写旧会话一个字节。新会话仅在本进程内存在（重启即失）。',
  })
}
