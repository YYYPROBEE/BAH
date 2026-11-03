/**
 * `POST /api/suggest`：基于最近一轮对话生成两条追问。
 *
 * 建议是**辅助件**：模型不可用、超时、没装 core:agent 都返回空数组，
 * 前端回退到本地规则；这里不抛 5xx，也不把"没有建议"变成一次失败。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebDeps, WebRequest } from '../deps.ts'
import { readBodyString, readJson, sendError, sendJson } from '../http.ts'

/** 单段上下文上限：超过就截断，别让建议请求变成整段会话的二次推理。 */
const MAX_CONTEXT_CHARS = 2_000

export async function handleSuggest(
  req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const port = deps.trySuggest()
  if (port === undefined) {
    sendJson(res, 200, { suggestions: [], source: 'unavailable' })
    return
  }

  let body
  try {
    body = await readJson(req)
  } catch {
    sendError(res, 400, 'web-invalid-json', '请求体必须是 JSON')
    return
  }

  const user = (readBodyString(body, 'user') ?? '').slice(0, MAX_CONTEXT_CHARS)
  const assistant = (readBodyString(body, 'assistant') ?? '').slice(0, MAX_CONTEXT_CHARS)
  if (assistant.trim() === '') {
    sendJson(res, 200, { suggestions: [], source: 'empty' })
    return
  }

  const suggestions = await port.suggest({ user, assistant })
  sendJson(res, 200, {
    suggestions,
    source: suggestions.length > 0 ? 'model' : 'empty',
  })
}
