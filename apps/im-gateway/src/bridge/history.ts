/**
 * IM 的历史概览（2026-11-02）。
 *
 * ## 为什么只有"概览"，没有"回复编号查看"
 *
 * 公众号的消息是一条一条独立处理的，网关不保存"上一次列表里的第 3 条是什么"。
 * 要支持"回复 1 查看"，就得在网关里加一份按 openid 的列表缓存——那既是新的状态面，
 * 也是新的越权面（缓存串号 = 把别人的对话给这个用户看）。
 * 所以这里只回最近几次的标题与时间，**不承诺逐条回看**，文案里写清楚。
 *
 * ## 为什么"看历史"可能失败得很干脆
 *
 * 历史挂在子进程的 `GET /api/sessions` 上，而子进程闲置会被回收（`supervisor.ts:197`）。
 * 用户隔天来问"历史"时子进程早没了；`get()` 拿不到就直说看不了，
 * **不调 `ensure()` 顺手拉一个新进程**——那等于用户问一句话就开一条钱路。
 */

/** 识别词（中文、英文；大小写不敏感）。刻意不含"最近"——「最近转账」是业务语句。 */
const HISTORY_WORDS = new Set(['历史', '历史记录', '记录', 'history'])

/** 一条消息里最多列几次对话（微信长文可读性差，且用户真正看的是"有没有"）。 */
export const HISTORY_MAX_ITEMS = 5

/** 子进程已回收时的提示（不给"再发一条就能看"这种做不到的承诺）。 */
export const HISTORY_IDLE_TEXT =
  '本次会话已结束，暂时看不了历史对话。历史记录可在网页端查看。'

/** 子进程在但请求失败时的提示。 */
export const HISTORY_FAILED_TEXT = '历史对话暂时读不出来，请稍后再试。'

/** 是否是历史请求。 */
export function isHistoryRequest(text: string): boolean {
  return HISTORY_WORDS.has(text.trim().toLowerCase())
}

/** 时间戳 → `MM-DD HH:mm`（本地时区）。 */
function stamp(at: unknown): string {
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '—'
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 列表 → 回复正文。
 *
 * @param sessions 后端 `/api/sessions` 的 `sessions` 字段（形状不可信，逐项判类型）
 */
export function renderHistoryText(sessions: unknown): string {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return '还没有历史对话。'
  }
  const shown = sessions.slice(0, HISTORY_MAX_ITEMS)
  const lines = shown.map((raw, index) => {
    const item = (typeof raw === 'object' && raw !== null ? raw : {}) as {
      title?: unknown
      lastAt?: unknown
      turns?: unknown
    }
    const title = typeof item.title === 'string' && item.title !== '' ? item.title : '（无标题）'
    const turns = typeof item.turns === 'number' ? `${String(item.turns)} 轮` : '未完成'
    return `${String(index + 1)}. ${stamp(item.lastAt)} · ${title}（${turns}）`
  })
  const tail =
    sessions.length > shown.length
      ? `共 ${String(sessions.length)} 次对话，这里显示最近 ${String(shown.length)} 次。`
      : `共 ${String(sessions.length)} 次对话。`
  return ['【最近的历史对话】', ...lines, tail, '（微信里只显示概览，完整对话请在网页端查看）'].join('\n')
}
