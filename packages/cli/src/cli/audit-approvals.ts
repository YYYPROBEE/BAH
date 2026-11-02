/**
 * `bah audit` 的审批联接（租户与鉴权 03 · TA-46）。
 *
 * ## 链上到底有什么（决定本模块能读什么）
 *
 * `audit.jsonl` 是**哈希链**：每行只有 `d = sha256(canonicalJson(data))`，
 * 载荷原文在 `session.jsonl`，链上不可反解。所以联接只能用**信封字段**：
 *
 * | 字段 | 来源 | 用途 |
 * |---|---|---|
 * | `t` | `'approval/actor'` / `'approval/decided'` | 两类条目 |
 * | `sub` | `subjectRefOf(type, data)` | 票据 ID（`ticketId` 是它的取值键） |
 * | `subject` | v2 信封 | actor 行是 `principal:<tenant>/<user>` |
 * | `decision` | v2 信封 | decided 行是 allow / deny |
 * | `recordedAt` | 链行 | 时间 |
 *
 * **不读 `d`**：它是摘要，解析它只会得到"不是 JSON"的告警（03 实现期踩过）。
 * 角色列表因此不在报告里——要角色得去 `session.jsonl` 对齐，而审计命令是只读链的。
 *
 * ## 判据
 *
 * - 按 `ticketId` 配对，返回"票据 → 结论 → 操作者"；
 * - `decision: 'allow'`（= `allowed-once`，见 `audit-decisions.ts` 的映射）却没有前置
 *   actor → 告警行（**人批必有主**）；
 * - 没有 actor 的结论标 `machine`（超时 / 无人值守的 `unavailable` 是合法态）。
 *
 * 只读：不改行、不补写、不影响退出码（告警不是断链）。
 */

import type { ChainRecord } from '@bah/persistence'

/** 链上的操作者记录（来自 v2 信封，不含角色）。 */
export interface ApprovalActorRecord {
  readonly ticketId: string
  readonly userId: string
  readonly tenantId?: string
  /** 链行记录时刻（不是业务时刻；业务时刻在 payload 里，链上不可反解）。 */
  readonly at?: number
}

/** 一张票据的联接结果。 */
export interface ApprovalJoinRow {
  readonly ticketId: string
  /** 结论：`allow` / `deny`；`undefined` = 只有 actor（尝试过但没落结论）。 */
  readonly decision?: string
  readonly actor?: ApprovalActorRecord
  readonly at?: number
  /** 结论没有前置 actor ⇒ 机器决策（超时 / 无人值守）。 */
  readonly machine: boolean
}

/** 联接结果。 */
export interface ApprovalJoin {
  readonly rows: readonly ApprovalJoinRow[]
  readonly warnings: readonly string[]
}

/** 放行结论（`allowed-once` 在链上的映射值）。 */
const HUMAN_ALLOW = 'allow'

/** 从 `principal:<tenant>/<user>` 里拆租户与用户。 */
function parsePrincipalSubject(subject: string | undefined): {
  readonly tenantId: string
  readonly userId: string
} | undefined {
  if (subject === undefined || !subject.startsWith('principal:')) return undefined
  const rest = subject.slice('principal:'.length)
  const slash = rest.lastIndexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { tenantId: rest.slice(0, slash), userId: rest.slice(slash + 1) }
}

/**
 * 把链行联接到"票据 → 结论 → 操作者"。
 *
 * 顺序敏感：只有**结论之前**出现的 actor 才算数。后到的 actor 不能给已有的
 * 机器结论"补一个主人"——那正是审计最怕的伪造面。
 */
export function joinApprovalActors(rows: readonly ChainRecord[]): ApprovalJoin {
  const out = new Map<string, ApprovalJoinRow>()
  const actors = new Map<string, ApprovalActorRecord>()
  const warnings: string[] = []

  for (const row of rows) {
    if (row.t !== 'approval/actor' && row.t !== 'approval/decided') continue
    const ticketId = row.sub
    if (typeof ticketId !== 'string' || ticketId.length === 0) {
      warnings.push(`票据联接：${row.s}#${String(row.q)} 的 ${row.t} 缺 ticketId（sub 为空），已跳过`)
      continue
    }

    if (row.t === 'approval/actor') {
      const principal = parsePrincipalSubject(row.subject)
      if (principal === undefined) {
        warnings.push(
          `票据联接：${row.s}#${String(row.q)} 的 approval/actor 信封 subject 不是 principal:<tenant>/<user>，已跳过`,
        )
        continue
      }
      const actor: ApprovalActorRecord = {
        ticketId,
        userId: principal.userId,
        tenantId: principal.tenantId,
        at: row.recordedAt,
      }
      actors.set(ticketId, actor)
      const current = out.get(ticketId)
      // 已有结论的行不再补 actor（后到的 actor 不能给机器结论"追认"）
      if (current === undefined) out.set(ticketId, { ticketId, actor, machine: false })
      else if (current.decision === undefined) out.set(ticketId, { ...current, actor })
      continue
    }

    const decision = typeof row.decision === 'string' ? row.decision : 'unknown'
    const actor = actors.get(ticketId)
    out.set(ticketId, {
      ticketId,
      decision,
      ...(actor === undefined ? {} : { actor }),
      at: row.recordedAt,
      machine: actor === undefined,
    })
    if (decision === HUMAN_ALLOW && actor === undefined) {
      warnings.push(
        `人批必有主：${ticketId} 的 allowed-once 前没有 approval/actor（按 machine 处理，请核查）`,
      )
    }
  }

  return { rows: [...out.values()], warnings }
}
