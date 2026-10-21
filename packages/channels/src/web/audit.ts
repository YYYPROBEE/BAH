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

import type { AuditFrame } from './frames.ts'
import { formatCents, timeText } from './format.ts'

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
      return {
        ...base,
        category: 'approval',
        label: '审批请求',
        summary: amount === undefined ? `请求执行 ${name}` : `请求执行 ${name} · ${formatCents(amount)}`,
        ticketId: str(data, 'ticketId'),
        toolName: name,
      }
    }
    case 'approval/decided': {
      const decision = str(data, 'decision') ?? 'unknown'
      const reason = str(data, 'reason')
      const code = str(data, 'code')
      return {
        ...base,
        category: 'approval',
        label: '审批结论',
        summary: `${DECISION_LABEL[decision] ?? decision}${reason === undefined ? '' : ` · ${reason}`}`,
        ticketId: str(data, 'ticketId'),
        ...(code === undefined ? {} : { code }),
      }
    }
    case 'tool/result': {
      const name = str(data, 'name') ?? '工具'
      const isError = data['isError'] === true
      const code = str(data, 'code')
      return {
        ...base,
        category: 'tool',
        label: isError ? '工具未执行' : '工具完成',
        summary: isError ? `${name} 未执行${str(data, 'reason') === undefined ? '' : `：${String(str(data, 'reason'))}`}` : name,
        toolName: name,
        ...(code === undefined ? {} : { code }),
      }
    }
    case 'turn/end': {
      const reason = asRecord(data['reason'])
      const kind = reason === undefined ? 'completed' : (str(reason, 'kind') ?? 'completed')
      const detail = reason === undefined ? undefined : str(reason, 'reason')
      return {
        ...base,
        category: 'turn',
        label: '轮次结束',
        summary: `${kind}${detail === undefined ? '' : ` · ${detail}`}`,
        ...(kind === 'completed' ? {} : { code: kind }),
      }
    }
    default: {
      const ticket = TICKET_LABEL[event.type]
      if (ticket !== undefined) {
        return {
          ...base,
          category: 'ticket',
          label: ticket,
          summary: `${str(data, 'name') ?? '未知工具'}`,
          ticketId: str(data, 'ticketId'),
          ...(str(data, 'reason') === undefined ? {} : { code: str(data, 'reason') }),
        }
      }
      if (event.type.startsWith('sentry/')) {
        return {
          ...base,
          category: 'safety',
          label: '安全防护',
          summary: `${event.type} · ${str(data, 'ruleId') ?? str(data, 'reason') ?? '命中'}`,
          ...(str(data, 'ruleId') === undefined ? {} : { code: str(data, 'ruleId') }),
        }
      }
      if (event.type.startsWith('knowledge/')) {
        const verdict = str(data, 'verdict') ?? 'unknown'
        const code = str(data, 'reasonCode')
        return {
          ...base,
          category: 'knowledge',
          label: '知识平面',
          summary: `${event.type} · ${verdict}`,
          ...(code === undefined ? {} : { code }),
        }
      }
      return undefined
    }
  }
}
