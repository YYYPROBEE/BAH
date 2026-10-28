/**
 * `GET /api/metrics`：**单机**运行指标的只读视图（D2）。
 *
 * 三条纪律：
 *
 * 1. **不新造计数状态**——全部从会话事件现算。理由：另建一套计数器就有了第二真相源，
 *    重启、回放、fork 之后两个数必然对不上，而"哪个对"没人说得清。
 * 2. **不出原文**——只出数字：turn 数、工具成功/失败、审批分布、token、成本、耗时分位、
 *    SSE 连接数。prompt / 工具结果 / 用户输入一律不进这个端点。
 * 3. **不是分布式监控**——这是单进程数字，没有聚合、没有推送、没有保留。要跨实例看指标
 *    得先有实例标识与汇聚层（D4 多租户之后的事）。
 *
 * 成本口径：`costMicroYuan` 只在 `core:model` 配了 `pricing` 时非 0。**本地 provider
 * （mock / router）恒为 0 是正确的**——它们没有上游账单，不是"没配好"。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { BankSessionEventMap } from '@bah/bank'

import type { PolicySessionEventMap } from '../../policy.ts'
import type { WebDeps, WebRequest } from '../deps.ts'
import { sendJson } from '../http.ts'

/** 分位数（空数组返回 `null`，不返回 0——"没有样本"和"很快"是两件事）。 */
function quantile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return Math.round(sorted[index] as number)
}

/** 指标快照（键名固定，前端与脚本按它取数）。 */
export async function handleMetrics(
  _req: IncomingMessage,
  res: ServerResponse,
  _request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  const events = deps.session.events()

  let turns = 0
  let toolCalls = 0
  let toolErrors = 0
  let approvalsAsked = 0
  let approved = 0
  let rejected = 0
  let undecided = 0
  let input = 0
  let output = 0
  let cachedInput = 0
  let costMicroYuan = 0
  const durations: number[] = []

  /** 策略维度（策略外置 S3 / 02 §10）：全部从事件现算，不新造计数器。 */
  let policyDecisions = 0
  let engineErrors = 0
  let legacyDecisions = 0
  let shadowDiffs = 0
  let reloads = 0
  let reloadRejected = 0
  const byPolicyVersion: Record<string, number> = {}
  const byPolicyVerdict: Record<string, number> = {}
  const byPolicyReason: Record<string, number> = {}

  const count = (bucket: Record<string, number>, key: string): void => {
    bucket[key] = (bucket[key] ?? 0) + 1
  }

  for (const event of events) {
    const kind = String(event.type)
    /**
     * 策略事件走 `String(type)` 分支：`SessionEventMap` 的领域增强由 bank / policy 包
     * 分别声明，本文件不 import 运行期实现；用结构类型取值比依赖增强顺序更稳。
     */
    if (kind === 'tier/decided') {
      const data = event.data as unknown as BankSessionEventMap['tier/decided']
      policyDecisions += 1
      // `policyVersion` 是"判决发生时的版本"，不是当前 active——这正是审计需要的口径。
      count(byPolicyVersion, data.policyVersion ?? 'legacy')
      count(byPolicyVerdict, data.verdict)
      count(byPolicyReason, data.reason)
      if (data.engineSource === 'legacy') legacyDecisions += 1
      if (data.code === 'policy-engine-error') engineErrors += 1
      continue
    }
    if (kind === 'policy/bundle-loaded' || kind === 'policy/bundle-switched') {
      reloads += 1
      continue
    }
    if (kind === 'policy/reload-rejected') {
      reloadRejected += 1
      continue
    }
    if (kind === 'policy/shadow-diff') {
      shadowDiffs += 1
      continue
    }
    switch (event.type) {
      case 'turn/end':
        turns += 1
        break
      case 'tool/call':
        toolCalls += 1
        break
      case 'tool/result': {
        if (event.data.isError) toolErrors += 1
        if (typeof event.data.durationMs === 'number') durations.push(event.data.durationMs)
        break
      }
      case 'approval/asked':
        approvalsAsked += 1
        break
      case 'approval/decided': {
        const decision = String(event.data.decision)
        if (decision === 'approved') approved += 1
        else if (decision === 'rejected') rejected += 1
        // `unavailable`（无人值守默认拒绝）/ `timeout` 等一律记"其它"，
        // 不并进 rejected：那会把"没人点"和"人点了拒绝"混成一个数。
        else undecided += 1
        break
      }
      case 'usage/summary':
        input += event.data.input
        output += event.data.output
        cachedInput += event.data.cachedInput
        costMicroYuan += event.data.costMicroYuan
        break
      default:
        break
    }
  }

  const halt = deps.tryHalt()
  sendJson(res, 200, {
    sessionId: String(deps.session.sessionId),
    lastSeq: deps.session.lastSeq(),
    at: deps.now(),
    turns,
    tools: {
      calls: toolCalls,
      errors: toolErrors,
      durationMs: { p50: quantile(durations, 0.5), p95: quantile(durations, 0.95) },
    },
    approvals: { asked: approvalsAsked, approved, rejected, other: undecided },
    policy: {
      decisions: policyDecisions,
      byVersion: byPolicyVersion,
      byVerdict: byPolicyVerdict,
      byReason: byPolicyReason,
      engineErrors,
      legacyDecisions,
      shadowDiffs,
      reloads,
      reloadRejected,
    },
    usage: { input, output, cachedInput, costMicroYuan },
    // `null` = 本 profile 没装 HALT（不是"未停机"）。区分开才知道该不该去看锁。
    halt:
      halt === undefined
        ? null
        : { status: halt.status, halted: halt.halted, reason: halt.reason ?? null },
    sseClients: deps.hub.size(),
  })
}
