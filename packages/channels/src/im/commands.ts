/**
 * 审批文本指令解析（施工单 01 §2.5，定义在 01、消费在 03）。
 *
 * 语法（唯一口径）：
 * - `0` → 拉取最新结果；
 * - `1 [票据号]` / `确认 [票据号]` → 批准；
 * - `2 [票据号] 理由...` / `拒绝 [票据号] 理由...` → 拒绝（理由必填，≤500 字）；
 * - `3 [票据号]` / `详情 [票据号]` → 详情；
 * - `4 [票据号]` / `验证 [票据号]` → 强验证；
 * - `转人工 [理由]` → 转人工。
 *
 * WHY 票据号要校验形态：公众号没有按钮，用户会自然地说「1 万元转账」。
 * 若把数字指令后的任意文本当票据号，一句普通转账请求就会被当成"批准某张票"。
 * 所以**只有形如票据号的 token 才被认作票据号**，其余一律不是指令（交主循环当普通消息）。
 */

/** 票据号形态：字母数字开头，允许 `:` `_` `-`，最长 64。中文/空格/标点一律不是票据号。 */
export const IM_TICKET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/

/** 拒绝理由上限（落审计，防整篇文章）。 */
export const IM_COMMAND_MAX_REASON = 500

/** 一条已识别的 IM 指令。 */
export type ImCommand =
  | { readonly kind: 'approve'; readonly ticketId?: string }
  | { readonly kind: 'reject'; readonly ticketId?: string; readonly reason: string }
  | { readonly kind: 'detail'; readonly ticketId?: string }
  | { readonly kind: 'verify'; readonly ticketId?: string }
  | { readonly kind: 'fetch-latest' }
  | { readonly kind: 'takeover'; readonly reason?: string }

/** 解析 `1` / `确认` 的余下部分。 */
function parseApprove(rest: string): ImCommand | undefined {
  if (rest.length === 0) return { kind: 'approve' }
  return IM_TICKET_ID_PATTERN.test(rest) ? { kind: 'approve', ticketId: rest } : undefined
}

/**
 * 解析 `2` / `拒绝` 的余下部分。
 *
 * 票据号可选：首个 token 像票据号就吃掉它；否则整段都是理由。
 * 理由为空或超长都**不返回指令**（宁可不识别，也不默认拒绝）。
 */
function parseReject(rest: string): ImCommand | undefined {
  if (rest.length === 0) return undefined
  const tokens = rest.split(/\s+/)
  const head = tokens[0] ?? ''
  // 只有票据号、没有理由：不识别（拒绝理由必填，绝不替用户编一个）
  if (tokens.length === 1 && IM_TICKET_ID_PATTERN.test(head)) return undefined
  const hasTicket = IM_TICKET_ID_PATTERN.test(head) && tokens.length > 1
  const reason = hasTicket ? rest.slice(head.length).trim() : rest
  if (reason.length === 0 || reason.length > IM_COMMAND_MAX_REASON) return undefined
  return hasTicket ? { kind: 'reject', ticketId: head, reason } : { kind: 'reject', reason }
}

/** 解析 `3` / `4` 的余下部分（只认票据号，别的一律不是指令）。 */
function parseTicketOnly(rest: string, kind: 'detail' | 'verify'): ImCommand | undefined {
  if (rest.length === 0) return { kind }
  return IM_TICKET_ID_PATTERN.test(rest) ? { kind, ticketId: rest } : undefined
}

/** 解析 `转人工` 的余下部分。 */
function parseTakeover(rest: string): ImCommand {
  return rest.length === 0 ? { kind: 'takeover' } : { kind: 'takeover', reason: rest }
}

/**
 * 解析一条用户文本。
 *
 * @returns 识别出的指令；`undefined` = 不是指令（交给主循环当普通消息）
 */
export function parseImCommand(text: string): ImCommand | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined

  const head = trimmed.split(/\s+/)[0] ?? ''
  const rest = trimmed.slice(head.length).trim()

  switch (head) {
    case '0':
      // 只有裸 `0` 才是"拉取最新结果"；`0 元` 之类的普通文本不识别
      return rest.length === 0 ? { kind: 'fetch-latest' } : undefined
    case '1':
    case '确认':
      return parseApprove(rest)
    case '2':
    case '拒绝':
      return parseReject(rest)
    case '3':
    case '详情':
      return parseTicketOnly(rest, 'detail')
    case '4':
    case '验证':
      return parseTicketOnly(rest, 'verify')
    case '转人工':
      return parseTakeover(rest)
    default:
      return undefined
  }
}
