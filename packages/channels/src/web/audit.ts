/**
 * 审计时间线（施工单 13 §2.1「决策链 + 理由码 + 票据生命周期」，答辩演示用）。
 *
 * 口径：**只挑有判决含义的事件**。`user/message`、`request/*`、`system/message` 不进时间线
 * （它们不是"决定"，混进来会把最关键的三行理由码淹掉）。
 *
 * 领域事件（`ticket/*`、`sentry/*`、`knowledge/*`）在 `@bah/core` 的 `SessionEventMap`
 * 里是**动态键**（各自包用模块增强追加），本文件因此按"宽松读取 + 类型守卫"处理：
 * 不认识的事件一律忽略，绝不因为字段缺失而抛错（时间线坏了不能拖垮对话）。
 */

import type { AuditDetail, AuditFrame } from './frames.ts'
import { formatCents, shortId, timeText } from './format.ts'

/** 宽松读取：领域事件的键不在编译期联合里。 */
interface LooseEvent {
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: unknown
}

/** 对象守卫。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 读字符串字段。 */
function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 读数字字段。 */
function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 可展开明细的字段白名单。
 *
 * 只收"解释判决/轨迹所需、且不是用户原话或工具参数结果"的字段；未登记的键一律不进帧。
 * 这是审计面板的展示层，不是原始事件转储——把 payload 整个塞给前端会把 PII 和
 * 大对象一起带出去，也会让一条审计卡撑满屏幕。
 */
const DETAIL_LABELS: Readonly<Record<string, string>> = {
  ticketId: '票据',
  callId: '调用 ID',
  name: '工具',
  toolName: '工具',
  decision: '结论',
  reason: '理由',
  code: '理由码',
  stage: '阶段',
  ruleId: '规则',
  level: '风险级别',
  score: '风险分',
  turn: '轮次',
  step: '步',
  kind: '类型',
  verdict: '判定',
  reasonCode: '理由码',
  merchant: '商户',
  subscriptionId: '订阅',
  affected: '影响项',
  watch: '提醒',
  aheadDays: '提前(天)',
  denies: '拒绝数',
  windowSeconds: '窗口(秒)',
  ticketsRevoked: '吊销票据数',
  by: '操作人',
  invalidArgs: '非法参数',
  threshold: '阈值',
  tools: '工具数',
  limit: '上限',
  isError: '是否失败',
  durationMs: '耗时(ms)',
  detail: '说明',
  message: '消息',
  families: '命中族',
  transforms: '变换',
  untrusted: '不可信来源',
  ts: '轨迹时刻',
}

const DETAIL_KEYS = Object.keys(DETAIL_LABELS)

/** 单个明细值：只接受短标量/标量数组，对象一律跳过（防止把原始 payload 带出去）。 */
function detailValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    return text === '' ? undefined : text.slice(0, 800)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const items = value.filter(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    )
    if (items.length === 0) return undefined
    return items.map((item) => String(item)).join('、').slice(0, 800)
  }
  return undefined
}

/**
 * 造明细：先放调用方点名的字段（可覆盖同名白名单字段），再补白名单里的其余字段。
 * 同标签只留第一份，避免 `name` / `toolName` 都翻成「工具」出现两行。
 */
function detailOf(
  data: Record<string, unknown>,
  extra: ReadonlyArray<readonly [string, unknown]> = [],
): AuditDetail[] {
  const out: AuditDetail[] = []
  const labels = new Set<string>()
  const push = (label: string, value: unknown): void => {
    if (labels.has(label)) return
    const text = detailValue(value)
    if (text === undefined) return
    labels.add(label)
    out.push({ label, value: text })
  }

  for (const [label, value] of extra) push(label, value)
  for (const key of DETAIL_KEYS) {
    const label = DETAIL_LABELS[key]
    if (label !== undefined) push(label, data[key])
  }
  return out
}

/** 给帧挂明细；空明细不写字段（避免每帧多一个空数组）。 */
function withDetail(
  frame: AuditFrame,
  data: Record<string, unknown>,
  extra: ReadonlyArray<readonly [string, unknown]> = [],
): AuditFrame {
  const detail = detailOf(data, extra)
  return detail.length === 0 ? frame : { ...frame, detail }
}

/** 审批结论的中文文案。 */
const DECISION_LABEL: Readonly<Record<string, string>> = {
  'allowed-once': '已批准（一次性）',
  rejected: '已拒绝',
  cancelled: '已取消',
  unavailable: '无人应答（视为拒绝）',
}

/** 票据状态的文案。 */
const TICKET_LABEL: Readonly<Record<string, string>> = {
  'ticket/issued': '票据已签发',
  'ticket/approved': '票据已批准',
  'ticket/redeemed': '票据已核销',
  'ticket/consumed': '票据已消费',
  'ticket/blocked': '票据已阻断',
  'ticket/ledger-failed': '票据账本失败',
}

/** 订阅域事件的文案（ADR-0007 四键；`sub/cancelled` 沿用 ADR-0003）。 */
const SUBSCRIPTION_LABEL: Readonly<Record<string, string>> = {
  'read/subscriptions': '订阅清单',
  'sub/cancelled': '订阅已取消',
  'sub/authorization-revoked': '代扣协议已关闭',
  'sub/watch-updated': '订阅提醒已更新',
}

/** 提醒模式文案。 */
const WATCH_LABEL: Readonly<Record<string, string>> = {
  remind: '到期提醒',
  idle: '闲置标记',
  none: '已清除标记',
}

/** 天数差（整数；负差按 0）。 */
function spanDays(from: number, to: number): number {
  return Math.max(0, Math.round((to - from) / (24 * 60 * 60 * 1000)))
}

/** 明细标签集合（最多 8 个；超出折成 `等 N 项`，时间线一行放得下才有用）。 */
const DETAIL_LABEL_MAX = 8

function detailLabelsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const labels: string[] = []
  for (const item of raw) {
    const record = asRecord(item)
    const label = record === undefined ? undefined : str(record, 'label')
    if (label !== undefined) labels.push(label)
  }
  if (labels.length <= DETAIL_LABEL_MAX) return labels
  return [...labels.slice(0, DETAIL_LABEL_MAX), `等 ${String(labels.length)} 项`]
}

/**
 * 订阅域事件的摘要。
 *
 * 口径：**只说事件载荷里有的**。清单条数、推断条数、取证窗口来自 `read/subscriptions`
 * 的三件套；缺哪个就不写哪个，不拿 0 冒充"没有"。
 */
function subscriptionDetail(
  type: string,
  data: Record<string, unknown>,
): { readonly summary: string } {
  switch (type) {
    case 'read/subscriptions': {
      const result = asRecord(data['result'])
      const confirmed = result === undefined ? undefined : result['confirmed']
      const detected = result === undefined ? undefined : result['detected']
      const parts = [
        `${String(Array.isArray(confirmed) ? confirmed.length : 0)} 项订阅`,
        `推断 ${String(Array.isArray(detected) ? detected.length : 0)} 条`,
      ]
      const basis = asRecord(data['basis'])
      if (basis !== undefined) {
        const from = num(basis, 'from')
        const to = num(basis, 'to')
        const txnCount = num(basis, 'txnCount')
        if (from !== undefined && to !== undefined && txnCount !== undefined) {
          parts.push(`近 ${String(spanDays(from, to))} 天 ${String(txnCount)} 笔`)
        }
      }
      return { summary: parts.join(' · ') }
    }
    case 'sub/cancelled': {
      const merchant = str(data, 'merchant')
      const id = str(data, 'subscriptionId')
      return { summary: merchant ?? (id === undefined ? '订阅已取消' : shortId(id)) }
    }
    case 'sub/authorization-revoked': {
      const merchant = str(data, 'merchant') ?? '代扣协议'
      const affected = num(data, 'affected')
      return { summary: affected === undefined ? merchant : `${merchant} · 影响 ${String(affected)} 项` }
    }
    case 'sub/watch-updated': {
      const watch = str(data, 'watch') ?? 'remind'
      const ahead = num(data, 'aheadDays')
      const base = WATCH_LABEL[watch] ?? watch
      return { summary: ahead === undefined ? base : `${base} · 提前 ${String(ahead)} 天` }
    }
    default:
      return { summary: type }
  }
}

/**
 * 一条事件 → 一条审计条目。
 *
 * @returns `undefined` = 该事件不进时间线
 */
export function auditOf(event: LooseEvent): AuditFrame | undefined {
  const data = asRecord(event.data) ?? {}
  const base = { kind: 'audit' as const, seq: event.seq, at: event.at, timeText: timeText(event.at) }

  switch (event.type) {
    case 'approval/asked': {
      const amount = num(data, 'amount')
      const name = str(data, 'name') ?? '未知操作'
      // 明细的**标签集合**进摘要：回放这一行就能回答「用户当时看到了哪些项」。
      // 只取标签不取数值——数值已经在卡片与事件里，时间线再抄一遍只会制造第二份口径。
      const labels = detailLabelsOf(data['details'])
      const labelText = labels.length === 0 ? '' : ` · 明细 ${String(labels.length)} 项：${labels.join('/')}`
      // 金额口径：`approval/asked.amount` 是**元**（`ApprovalTicketView.amount` 的注释写明，
      // bank governance 用 `amountCents / 100` 填票据）。`formatCents` 吃分，所以先 ×100。
      // 这里曾经直接 `formatCents(amount)`，把 800 元显示成 ¥8.00——审批弹窗里差 100 倍。
      return withDetail(
        {
          ...base,
          category: 'approval',
          label: '审批请求',
          summary:
            (amount === undefined
              ? `请求执行 ${name}`
              : `请求执行 ${name} · ${formatCents(Math.round(amount * 100))}`) + labelText,
          ticketId: str(data, 'ticketId'),
          toolName: name,
        },
        data,
        [['明细项', labels.join('、')]],
      )
    }
    case 'approval/decided': {
      const decision = str(data, 'decision') ?? 'unknown'
      const reason = str(data, 'reason')
      const code = str(data, 'code')
      return withDetail(
        {
          ...base,
          category: 'approval',
          label: '审批结论',
          summary: `${DECISION_LABEL[decision] ?? decision}${reason === undefined ? '' : ` · ${reason}`}`,
          ticketId: str(data, 'ticketId'),
          ...(code === undefined ? {} : { code }),
        },
        data,
      )
    }
    case 'tool/result': {
      const name = str(data, 'name') ?? '工具'
      const isError = data['isError'] === true
      const code = str(data, 'code')
      return withDetail(
        {
          ...base,
          category: 'tool',
          label: isError ? '工具未执行' : '工具完成',
          summary: isError ? `${name} 未执行${str(data, 'reason') === undefined ? '' : `：${String(str(data, 'reason'))}`}` : name,
          toolName: name,
          ...(code === undefined ? {} : { code }),
        },
        data,
      )
    }
    // R-6：风险测评的两条业务事件进时间线。
    // 分类复用 `tool`（它们确实是工具产出的），不新增分类——新增分类会带出一条新的
    // CSS 类别色，而施工单明确不许为这个面板加左竖色条。
    case 'read/risk-questions': {
      const questions = data['questions']
      // 0 题是异常下发，不写成「0 题」（把异常当事实）
      const count = Array.isArray(questions) && questions.length > 0 ? questions.length : undefined
      const version = str(data, 'version')
      const parts = [count === undefined ? '查看风险问卷' : `查看风险问卷 · ${String(count)} 题`]
      if (version !== undefined) parts.push(version)
      return withDetail(
        {
          ...base,
          category: 'tool',
          label: '查看风险问卷',
          summary: parts.join(' · '),
          toolName: 'risk_assess',
        },
        data,
        [['题数', count]],
      )
    }
    case 'risk/assessed': {
      const result = asRecord(data['result'])
      const from = result === undefined ? undefined : str(result, 'from')
      const to = result === undefined ? undefined : str(result, 'to')
      // 题数优先取 `result.answers`（事件两处都冗余了一份），没有再看顶层；
      // 空数组/缺失都不写题数——"0 题"不是一次合法落档。
      const answersInResult = result === undefined ? undefined : result['answers']
      const answers = Array.isArray(answersInResult) ? answersInResult : data['answers']
      const count = Array.isArray(answers) && answers.length > 0 ? answers.length : undefined
      const grade = from === undefined || to === undefined ? '风险测评已落档' : `风险测评：${from} → ${to}`
      return withDetail(
        {
          ...base,
          category: 'tool',
          label: '风险测评',
          summary: count === undefined ? grade : `${grade}（${String(count)} 题）`,
          toolName: 'risk_assess',
        },
        data,
        [
          ['原等级', from],
          ['新等级', to],
          ['作答题数', count],
        ],
      )
    }
    case 'turn/end': {
      const reason = asRecord(data['reason'])
      const kind = reason === undefined ? 'completed' : (str(reason, 'kind') ?? 'completed')
      const detail = reason === undefined ? undefined : str(reason, 'reason')
      return withDetail(
        {
          ...base,
          category: 'turn',
          label: '轮次结束',
          summary: `${kind}${detail === undefined ? '' : ` · ${detail}`}`,
          ...(kind === 'completed' ? {} : { code: kind }),
        },
        data,
        [
          ['结束原因', kind],
          ['说明', detail],
        ],
      )
    }
    default: {
      const ticket = TICKET_LABEL[event.type]
      if (ticket !== undefined) {
        return withDetail(
          {
            ...base,
            category: 'ticket',
            label: ticket,
            summary: `${str(data, 'name') ?? '未知工具'}`,
            ticketId: str(data, 'ticketId'),
            ...(str(data, 'reason') === undefined ? {} : { code: str(data, 'reason') }),
          },
          data,
        )
      }
      const subscription = SUBSCRIPTION_LABEL[event.type]
      if (subscription !== undefined) {
        return withDetail(
          { ...base, category: 'subscription', label: subscription, ...subscriptionDetail(event.type, data) },
          data,
        )
      }
      if (event.type.startsWith('sentry/')) {
        // `sentry/trace` 是轨迹副本，不是规则命中：摘要必须说 `kind`（turn-start / tool-call…），
        // 否则整列都显示"命中"，看不出这条记录到底在记什么。
        const traceKind = str(data, 'kind')
        const traceName = str(data, 'name')
        const summary =
          event.type === 'sentry/trace'
            ? `${event.type} · ${traceKind ?? '轨迹'}${traceName === undefined ? '' : ` · ${traceName}`}`
            : `${event.type} · ${str(data, 'ruleId') ?? str(data, 'reason') ?? '命中'}`
        return withDetail(
          {
            ...base,
            category: 'safety',
            label: '安全防护',
            summary,
            ...(str(data, 'ruleId') === undefined ? {} : { code: str(data, 'ruleId') }),
          },
          data,
        )
      }
      if (event.type.startsWith('knowledge/')) {
        const verdict = str(data, 'verdict') ?? 'unknown'
        const code = str(data, 'reasonCode')
        return withDetail(
          {
            ...base,
            category: 'knowledge',
            label: '知识平面',
            summary: `${event.type} · ${verdict}`,
            ...(code === undefined ? {} : { code }),
          },
          data,
        )
      }
      return undefined
    }
  }
}
