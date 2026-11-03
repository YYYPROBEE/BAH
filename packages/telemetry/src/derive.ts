/**
 * 派生：会话事件 → span（纯函数）。
 *
 * **这是本方案的地基**：轨迹不是第二份账，而是对**已经落账的事实**的重新解释。
 * 所以它有四个"必须"：
 *
 * 1. **必须纯**：不读时钟、不读磁盘、不读环境。同一份 `session.jsonl` 在任何时候
 *    重算都必须得到同一张图（2026-10-20 的历史会话也能出图）。
 * 2. **必须单遍**：事件可能上万条，不许二次扫描。
 * 3. **必须全序**：输出按 `(startMs, spanId)` 排序。**只按 `startMs` 是错的**——
 *    快照里 `fixedClock.now()` 幂等，所有事件 `at` 相同，排序会退化成"数组插入顺序"，
 *    而 `session/service.ts` 的排空循环允许监听器重入 append，插入序并不稳定。
 * 4. **必须留住未闭合的**：开着的 span 在末尾产出 `endMs: null` / `status: 'unset'` /
 *    `attributes.open = true`。丢弃是错的——排障最需要看"卡在哪"。
 *
 * 三个必须承认的取舍（都写进偏差登记）：
 *
 * - **时钟不可信 vs 事件自带时长**：`clockTrusted: false`（快照回放）时，靠事件 `at`
 *   相减得到的时长一律塌成 0，但**事件自己带的 `durationMs` 保持真值**
 *   （`tool/result` / `plan/node-result` / `plan/completed`）。否则"快照里工具有耗时、
 *   轮次没耗时"这个事实会被抹平成"全都是 0"。所有 span 仍统一打 `clock: 'frozen'`。
 * - **`plan/node-blocked` 的节点从来没 `node-started`**（被阻塞 = 没调度），
 *   若只做"关闭已开的 span"，这些节点在图里**完全消失**，而它们恰恰是"为什么没跑完"的答案。
 *   所以这里为它**合成**一条 0 时长 span，并标 `attributes.status = 'blocked'`。
 * - **一个 session 只有一个 traceId**：单会话单进程的必然结果。要区分"哪一次请求"，
 *   看 `http.request.attributes.requestSeq`（由包裹点写入）。
 */

import { spanIdOfTelemetry, traceIdOfSession, type SpanId } from './ids.ts'
import {
  assertAttributes,
  type SpanName,
  type SpanStatus,
  type TelemetrySpan,
} from './span.ts'

/** 派生入参的最小事件形状（只认这四样，不依赖任何存储实现）。 */
export interface DeriveEvent {
  readonly seq: number
  readonly at: number
  readonly type: string
  readonly data: unknown
}

export interface DeriveOptions {
  /** 会话 ID（算 traceId）。 */
  readonly sessionId: string
  /**
   * 时钟是否可信。快照回放传 `false`：靠 `at` 相减的时长塌成 0，
   * 并给每个 span 打 `attributes.clock = 'frozen'`。缺省 `true`。
   */
  readonly clockTrusted?: boolean
}

/** 内部草稿：`endMs`/`status` 会在闭合时被改写，所以不能直接建只读对象。 */
interface Draft {
  readonly spanId: SpanId
  readonly parentSpanId: SpanId | null
  readonly name: SpanName
  startMs: number
  endMs: number | null
  status: SpanStatus
  code: string | undefined
  readonly attributes: Record<string, string | number | boolean>
  dropped: boolean
}

/** 安全取字段：事件来自 JSONL 回放，形状只能运行期判定，不能 `as` 断言。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function num(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function str(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

/** `turn/end.reason` 的 kind（缺省按 `failed`，宁可标红也不装作正常）。 */
function endKind(record: Record<string, unknown> | undefined): string {
  return str(asRecord(record?.['reason']), 'kind') ?? 'failed'
}

/** `turn/end` 的 kind → span 状态：只有 `completed` 是正常收尾。 */
const TURN_OK_KINDS = new Set(['completed'])

/** 事件 → span。纯函数：同输入同输出，不读时钟、不读磁盘。 */
export function deriveSpans(
  events: readonly DeriveEvent[],
  options: DeriveOptions,
): TelemetrySpan[] {
  const clockTrusted = options.clockTrusted ?? true
  const traceId = traceIdOfSession(options.sessionId)

  const drafts: Draft[] = []

  /** 当前打开的 turn（`turn/end` 后置空）。 */
  let openTurn: Draft | undefined
  /** **最近**一个 turn span（`turn/end` 后不清）：`plan/*` 事件不带 turn，靠它归属。 */
  let lastTurnId: SpanId | null = null
  /** 当前打开的 step。 */
  let openStep: Draft | undefined
  /** 当前打开的 `llm.call`（一个 step 内最多一条在飞）。 */
  let openLlm: Draft | undefined
  /** `(turn,step)` → 该 step 内已出现过的 `request/header` 次数（重试换 id 用）。 */
  const llmAttempts = new Map<string, number>()
  /** `callId` → 打开的 `tool.execute`。 */
  const openTools = new Map<string, Draft>()
  /**
   * `callId` → **最近一条** `tool.execute`（无论是否已闭合）。
   *
   * 与 `openTools` 分开是必要的：撞号的典型形态是"同一 callId 完整跑了两遍"
   * （`resume` 重试），第一次早已闭合，只在 `openTools` 里查是查不到的。
   */
  const lastTool = new Map<string, Draft>()
  /** `ticketId` → 打开的 `approval.wait`。 */
  const openApprovals = new Map<string, Draft>()
  /** `planId` → 打开的 `plan.run`。 */
  const openPlans = new Map<string, Draft>()
  /** `planId` → 本次会话内该计划的运行窗口序号（`plan/created` / `plan/resumed` 递增）。 */
  const planWindows = new Map<string, number>()
  /** `${planId}/${nodeId}` → 已出现过的 `plan/node-started` 次数。 */
  const nodeStarts = new Map<string, number>()
  /** `${planId}/${nodeId}#${n}` → 打开的 `plan.node`。 */
  const openNodes = new Map<string, Draft>()

  const openSpan = (
    name: SpanName,
    key: string,
    startMs: number,
    parentSpanId: SpanId | null,
    attributes: Record<string, string | number | boolean>,
  ): Draft => {
    const draft: Draft = {
      spanId: spanIdOfTelemetry(name, key),
      parentSpanId,
      name,
      startMs,
      endMs: null,
      status: 'unset',
      code: undefined,
      attributes,
      dropped: false,
    }
    drafts.push(draft)
    return draft
  }

  const close = (draft: Draft, endMs: number, status: SpanStatus, code?: string): void => {
    draft.endMs = Math.max(endMs, draft.startMs)
    draft.status = status
    draft.code = code
  }

  for (const event of events) {
    const at = typeof event.at === 'number' && Number.isFinite(event.at) ? event.at : 0
    const data = asRecord(event.data)

    switch (event.type) {
      case 'turn/start': {
        const turn = num(data, 'turn')
        if (turn === undefined) break
        openTurn = openSpan('turn', `t${String(turn)}`, at, null, { turn, steps: 0 })
        lastTurnId = openTurn.spanId
        openStep = undefined
        openLlm = undefined
        break
      }

      case 'turn/end': {
        if (openTurn === undefined) break
        const turn = num(data, 'turn')
        if (turn !== undefined && openTurn.attributes['turn'] !== turn) break
        const kind = endKind(data)
        const ok = TURN_OK_KINDS.has(kind)
        openTurn.attributes['end'] = kind
        close(openTurn, at, ok ? 'ok' : 'error', ok ? undefined : kind)
        openTurn = undefined
        openStep = undefined
        openLlm = undefined
        break
      }

      case 'step/start': {
        const turn = num(data, 'turn')
        const step = num(data, 'step')
        if (turn === undefined || step === undefined) break
        openStep = openSpan('step', `t${String(turn)}.s${String(step)}`, at, openTurn?.spanId ?? null, {
          turn,
          step,
        })
        openLlm = undefined
        if (openTurn !== undefined) {
          openTurn.attributes['steps'] = Number(openTurn.attributes['steps'] ?? 0) + 1
        }
        break
      }

      case 'step/end': {
        if (openStep === undefined) break
        const turn = num(data, 'turn')
        const step = num(data, 'step')
        if (turn !== undefined && openStep.attributes['turn'] !== turn) break
        if (step !== undefined && openStep.attributes['step'] !== step) break
        close(openStep, at, 'ok')
        openStep = undefined
        openLlm = undefined
        break
      }

      case 'request/header': {
        const turn = num(data, 'turn')
        const step = num(data, 'step')
        if (turn === undefined || step === undefined) break
        const stepKey = `t${String(turn)}.s${String(step)}`
        const attempt = (llmAttempts.get(stepKey) ?? 0) + 1
        llmAttempts.set(stepKey, attempt)
        // 上一次 attempt 没收到 message 也没有 attempt 事件（异常中断）：留着不闭合即可。
        // 新 attempt 用独立 key，避免"重试把上一条 span 的 id 顶掉"。
        openLlm = openSpan('llm.call', `${stepKey}#${String(attempt)}`, at, openStep?.spanId ?? null, {
          attempt,
        })
        const model = str(data, 'model')
        if (model !== undefined) openLlm.attributes['model'] = model
        break
      }

      case 'assistant/message': {
        if (openLlm === undefined) break
        close(openLlm, at, 'ok')
        openLlm = undefined
        break
      }

      case 'assistant/attempt': {
        if (openLlm === undefined) break
        const status = str(data, 'status') ?? 'failed'
        close(openLlm, at, 'error', status)
        openLlm = undefined
        break
      }

      case 'tool/call': {
        const callId = str(data, 'callId')
        if (callId === undefined) break
        // 模型调用在第一个工具开始执行时就结束了。
        //
        // 为什么不是等 `assistant/message`：`agent.ts:603-605` 的落账顺序是
        // `tool/call → tool/result → assistant/message`（工具调度完才收尾落账）。
        // 若把 `llm.call` 闭合在 `assistant/message`，**每条用了工具的 step 都会把工具耗时
        // 算进模型耗时**——而"模型慢还是工具慢"恰恰是这个图要回答的第一个问题。
        if (openLlm !== undefined) {
          close(openLlm, at, 'ok')
          openLlm = undefined
        }
        const previous = lastTool.get(callId)
        if (previous !== undefined) {
          // 已知缺陷 `engine.ts:567` 的 `#1` 尾数会让 `resume` 撞号：只保留最后一条，
          // 并标注 `duplicateCallId`——这样"图里少一个节点"是有据可查的，不是丢数据。
          previous.dropped = true
        }
        const draft = openSpan('tool.execute', callId, at, openStep?.spanId ?? openTurn?.spanId ?? null, {
          tool: str(data, 'name') ?? 'unknown',
        })
        const level = str(asRecord(data?.['tier']), 'level')
        if (level !== undefined) draft.attributes['tier'] = level
        if (previous !== undefined) draft.attributes['duplicateCallId'] = true
        lastTool.set(callId, draft)
        openTools.set(callId, draft)
        break
      }

      case 'tool/result': {
        const callId = str(data, 'callId')
        if (callId === undefined) break
        const draft = openTools.get(callId)
        if (draft === undefined) break
        const isError = data?.['isError'] === true
        const code = str(data, 'code')
        const measured = num(data, 'durationMs')
        if (measured !== undefined && measured >= 0) {
          // 权威口径：`tool/result.durationMs` 不含排队与审批等待（`tool/call` 在执行前落账）。
          draft.startMs = at - measured
          draft.attributes['durationSource'] = 'tool'
        } else {
          draft.attributes['durationSource'] = 'wall'
        }
        draft.attributes['isError'] = isError
        if (code !== undefined) draft.attributes['code'] = code
        close(draft, at, isError ? 'error' : 'ok', isError ? code : undefined)
        openTools.delete(callId)
        break
      }

      case 'approval/asked': {
        const ticketId = str(data, 'ticketId')
        if (ticketId === undefined) break
        const callId = str(data, 'callId')
        const parent = callId === undefined ? undefined : openTools.get(callId)
        const draft = openSpan('approval.wait', ticketId, at, parent?.spanId ?? null, {
          tool: str(data, 'name') ?? 'unknown',
        })
        const challenge = str(data, 'challenge')
        if (challenge !== undefined) draft.attributes['challenge'] = challenge
        openApprovals.set(ticketId, draft)
        break
      }

      case 'approval/decided': {
        const ticketId = str(data, 'ticketId')
        if (ticketId === undefined) break
        const draft = openApprovals.get(ticketId)
        if (draft === undefined) break
        const decision = str(data, 'decision') ?? 'unavailable'
        draft.attributes['decision'] = decision
        const ok = decision === 'allowed-once'
        close(draft, at, ok ? 'ok' : 'error', ok ? undefined : decision)
        openApprovals.delete(ticketId)
        break
      }

      case 'plan/created':
      case 'plan/resumed': {
        const planId = str(data, 'planId')
        if (planId === undefined) break
        const window = (planWindows.get(planId) ?? 0) + 1
        planWindows.set(planId, window)
        const attributes: Record<string, string | number | boolean> = { planId }
        const nodes = num(data, 'nodes')
        if (nodes !== undefined) attributes['nodes'] = nodes
        const dryRun = data?.['dryRun']
        if (typeof dryRun === 'boolean') attributes['dryRun'] = dryRun
        // `plan/*` 事件不带 turn：按"`plan/created` 之前最近的那个 turn"归属（不变量 6）。
        openPlans.set(planId, openSpan('plan.run', `${planId}#w${String(window)}`, at, lastTurnId, attributes))
        // 新窗口开始：上一窗口遗留的 node 草稿不再属于本窗口，留给"未闭合"结局。
        for (const key of [...openNodes.keys()]) {
          if (key.startsWith(`${planId}/`)) openNodes.delete(key)
        }
        break
      }

      case 'plan/node-started': {
        const planId = str(data, 'planId')
        const nodeId = str(data, 'nodeId')
        if (planId === undefined || nodeId === undefined) break
        const counter = `${planId}/${nodeId}`
        const run = (nodeStarts.get(counter) ?? 0) + 1
        nodeStarts.set(counter, run)
        const attributes: Record<string, string | number | boolean> = { planId, nodeId }
        const tool = str(data, 'tool')
        if (tool !== undefined) attributes['tool'] = tool
        const ordinal = num(data, 'ordinal')
        if (ordinal !== undefined) attributes['ordinal'] = ordinal
        const key = `${counter}#${String(run)}`
        openNodes.set(
          key,
          openSpan('plan.node', key, at, openPlans.get(planId)?.spanId ?? null, attributes),
        )
        break
      }

      case 'plan/node-result': {
        const planId = str(data, 'planId')
        const nodeId = str(data, 'nodeId')
        if (planId === undefined || nodeId === undefined) break
        const counter = `${planId}/${nodeId}`
        const key = `${counter}#${String(nodeStarts.get(counter) ?? 0)}`
        const draft = openNodes.get(key)
        if (draft === undefined) break
        const status = str(data, 'status') ?? 'failed'
        const measured = num(data, 'durationMs')
        if (measured !== undefined && measured >= 0) {
          draft.startMs = at - measured
          draft.attributes['durationSource'] = 'event'
        } else {
          draft.attributes['durationSource'] = 'wall'
        }
        draft.attributes['status'] = status
        // `skipped` 是"调度过没执行"（dry-run / resume 跳过），是正常态，不是错误。
        const ok = status === 'succeeded' || status === 'skipped'
        close(draft, at, ok ? 'ok' : 'error', ok ? undefined : (str(data, 'code') ?? status))
        openNodes.delete(key)
        break
      }

      case 'plan/node-blocked': {
        const planId = str(data, 'planId')
        const nodeId = str(data, 'nodeId')
        if (planId === undefined || nodeId === undefined) break
        // 被阻塞的节点从未 `node-started`（阻塞 = 没调度）。若不做这一步，
        // "为什么这个计划没跑完"在图里完全看不。合成一条 0 时长 span 并标 `blocked`。
        const draft = openSpan(
          'plan.node',
          `${planId}/${nodeId}#blocked`,
          at,
          openPlans.get(planId)?.spanId ?? null,
          { planId, nodeId, status: 'blocked', durationSource: 'wall' },
        )
        close(draft, at, 'error', 'upstream-blocked')
        break
      }

      case 'plan/completed': {
        const planId = str(data, 'planId')
        if (planId === undefined) break
        const draft = openPlans.get(planId)
        if (draft === undefined) break
        const status = str(data, 'status') ?? 'failed'
        const measured = num(data, 'durationMs')
        if (measured !== undefined && measured >= 0) {
          draft.startMs = at - measured
          draft.attributes['durationSource'] = 'event'
        } else {
          draft.attributes['durationSource'] = 'wall'
        }
        draft.attributes['status'] = status
        const ok = status === 'succeeded'
        close(draft, at, ok ? 'ok' : 'error', ok ? undefined : status)
        openPlans.delete(planId)
        break
      }

      default:
        break
    }
  }

  return finalize(drafts, clockTrusted, traceId)
}

/** 草稿 → 只读 span：补结构标记、校验白名单、全序排序。 */
function finalize(drafts: readonly Draft[], clockTrusted: boolean, traceId: string): TelemetrySpan[] {
  const spans: TelemetrySpan[] = []
  for (const draft of drafts) {
    if (draft.dropped) continue
    const attributes: Record<string, string | number | boolean> = { ...draft.attributes }
    if (!clockTrusted) attributes['clock'] = 'frozen'

    const startMs = Math.round(draft.startMs)
    let endMs = draft.endMs === null ? null : Math.round(draft.endMs)
    let status = draft.status

    const measured = attributes['durationSource'] === 'tool' || attributes['durationSource'] === 'event'
    if (endMs === null) {
      // 未闭合：`endMs` 保持 null（不是 0），用 `open` 让导出文件自解释。
      attributes['open'] = true
      status = 'unset'
    } else if (!clockTrusted && !measured) {
      // 时钟不可信且时长来自"事件 at 相减"：塌成 0，别让人把 frozen 的 0ms 当成"很快"。
      endMs = startMs
    }

    assertAttributes(draft.name, attributes)

    spans.push({
      traceId,
      spanId: draft.spanId,
      parentSpanId: draft.parentSpanId,
      name: draft.name,
      startMs,
      endMs,
      status,
      ...(draft.code === undefined ? {} : { code: draft.code }),
      attributes: Object.freeze(attributes),
      source: 'derived',
    })
  }

  return orderSpans(spans)
}

/**
 * 全序排序：`(startMs, spanId)`。
 *
 * 只用 `startMs` 会在快照场景下退化成"插入顺序"（所有 `at` 相同），
 * 而插入顺序随监听器重入变化 —— 那就等于没有确定性。记录器的 `snapshot()` 用同一个函数。
 */
export function orderSpans(spans: readonly TelemetrySpan[]): TelemetrySpan[] {
  return [...spans].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs
    return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0
  })
}
