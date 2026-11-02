/**
 * 门禁：跨场景三平面边界 + 生日案例"每步独立审批"。
 *
 * ## 为什么值得一条门禁
 *
 * 三件事都**不会**在单测里被拆掉，却会在后续实现里被悄悄破坏：
 * 1. todo 不再派生（有人给它加事件键，出现第二个真相源）；
 * 2. goal 偷偷落 `goal/created` 事件（D5 零新键被绕过）；
 * 3. `plan_execute` 的"外层批一次"被接线成"批一次放行全部"（一次授权批量扣款）。
 *
 * ## findings / notes 分工
 *
 * findings = 可判定违规（带不变量编号 + 文件），有即 `ok:false`；
 * notes = 扫描面统计。**违规不许塞进 notes**——那是 A 类探针点名的绕过手法。
 *
 * ## 为什么 I4③ / I5 读快照而不是起应用
 *
 * 起应用跑一张图要秒级，pre-commit 受不了。`snapshots/cross-scene/session.jsonl`
 * 是**真跑过**的事件流（录制可复现），对"每个 succeeded 转账节点前有没有自己的审批"
 * 这个存在性命题，读它比再跑一遍更强：快照是逐字节冻结的审计证据。
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/* ────────────────────────────── 纯扫描函数（导出供夹具直测） ────────────────────────────── */

/**
 * I1：todo 平面不落账、派生器不读时钟且必须复用 `replayPlan`。
 *
 * `derive.ts` 的 `\bDate\b` 是硬判据：纯派生器连"注入时钟"都不该有——
 * 一旦它需要时间，就说明有人在派生里做了只能发生一次的判断。
 */
export function checkTodoSource(rel: string, source: string): string[] {
  if (rel.endsWith('.test.ts')) return []
  const findings: string[] = []
  if (/appendDomain|\.append\(/.test(source)) {
    findings.push(`${rel}: I1 todo 平面出现落账调用（todo 必须由 plan 事件派生，D8）`)
  }
  if (rel.endsWith('/derive.ts') || rel.endsWith('\\derive.ts')) {
    if (/\bDate\b/.test(source)) {
      findings.push(`${rel}: I1 derive.ts 不得出现 Date（纯函数不读时钟）`)
    }
    if (!/replayPlan/.test(source)) {
      findings.push(`${rel}: I1 derive.ts 必须复用 replayPlan（同源同序红线）`)
    }
    if (!/mergeTodoEntries/.test(source)) {
      findings.push(`${rel}: I1 derive.ts 缺同屏合并 Pure 函数入口`)
    }
  }
  return findings
}

/** I2：goal 平面零新事件键、不落账（只看非测试源码里的**字符串字面量**，注释不算）。 */
export function checkGoalSource(rel: string, source: string): string[] {
  if (rel.endsWith('.test.ts')) return []
  const findings: string[] = []
  if (/appendDomain/.test(source)) {
    findings.push(`${rel}: I2 goal 平面出现 appendDomain（goal 只经 tool/call + tool/result 落账）`)
  }
  // 字符串字面量形态（注释里讨论 "goal/" 不触发；模板串里的拼接也拦）
  if (/['"`]goal\//.test(source)) {
    findings.push(`${rel}: I2 goal 平面出现 goal/ 前缀事件键（D5 零新键）`)
  }
  return findings
}

/** I3：PlanApi 不可变——类型体里没有 `addNode`，全仓没有 `.addNode(` 调用。 */
export function checkAddNode(rel: string, source: string): string[] {
  const findings: string[] = []
  if (rel.endsWith('plan/types.ts')) {
    const body = /interface\s+PlanApi\b[\s\S]*?\n}/.exec(source)?.[0] ?? ''
    if (/\baddNode\b/.test(body)) {
      findings.push(`${rel}: I3 PlanApi 出现 addNode（计划不可变，D8）`)
    }
  }
  if (!rel.endsWith('.test.ts') && !rel.startsWith('scripts/') && /\.addNode\(/.test(source)) {
    findings.push(`${rel}: I3 出现 .addNode( 调用（计划不可变，D8）`)
  }
  return findings
}

/**
 * I4①②：`plan_execute` 的静态锚点。
 *
 * ① 黄级 + description 锚点句（删掉审计锚点即红）；
 * ② `tools/pre-execute` 的 ask 包装**先 `await next()`**（deny 优先语义不得反转）；
 * ③ 反向特征串：批量放行（`approveAll` / `skipApproval`）不得出现在 plan 插件与宿主装配面。
 */
export function checkPlanAnchors(rel: string, source: string): string[] {
  if (rel.endsWith('.test.ts')) return []
  const findings: string[] = []
  if (rel.endsWith('host/src/boot/plugins/plan.ts')) {
    if (!/每个写节点还会各自触发审批/.test(source)) {
      findings.push(`${rel}: I4 plan_execute description 缺"每节点各自审批"锚点句`)
    }
    if (!/tier:\s*\{\s*level:\s*'yellow'\s*\}/.test(source)) {
      findings.push(`${rel}: I4 plan_execute 必须声明黄级（tier: yellow）`)
    }
    const nextAt = source.indexOf('await next(payload)')
    const askAt = source.indexOf('PLAN_EXECUTE_TOOL')
    if (nextAt === -1) {
      findings.push(`${rel}: I4 pre-execute 包装缺 await next()（deny 优先语义丢失）`)
    } else if (askAt !== -1 && askAt < nextAt) {
      // 只对"同一段里 ask 先于 next"报红：description 里也出现工具名，取最后一处声明
      const lastAsk = source.lastIndexOf('PLAN_EXECUTE_TOOL')
      if (lastAsk !== -1 && lastAsk < nextAt) {
        findings.push(`${rel}: I4 ask 包装先于 await next()（deny 必须优先）`)
      }
    }
  }
  if (!rel.endsWith('.test.ts') && /\b(approveAll|skipApproval)\b/.test(source)) {
    findings.push(`${rel}: I4 出现批量放行特征串（approveAll/skipApproval）`)
  }
  return findings
}

/** 一条 plan 事件的最小形状（读 jsonl；不 import 运行时类型）。 */
interface PlanLine {
  readonly seq: number
  readonly type: string
  readonly data: Record<string, unknown>
}

function linesOf(jsonl: string): PlanLine[] {
  const out: PlanLine[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed = JSON.parse(line) as { seq?: unknown; type?: unknown; data?: unknown }
      if (typeof parsed.seq !== 'number' || typeof parsed.type !== 'string') continue
      const data = typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : {}
      out.push({ seq: parsed.seq, type: parsed.type, data: data as Record<string, unknown> })
    } catch {
      // 单行坏了不在这里判——那是快照比对的活；门禁只看能读的行
    }
  }
  return out
}

/**
 * I4③：动态判定——每个 `transfer_create` 节点的 started→result 窗口内必须有**自己的**审批记录。
 *
 * 判据与 TC-XSC-08 同源：按 `callId` 匹配（节点启动事件带 callId，审批事件也带）。
 * 缺一条即红：这就是"计划批准 ≠ 节点批准"的机器可执行形态。
 */
export function checkApprovalWindows(events: readonly PlanLine[]): string[] {
  const findings: string[] = []
  // `plan/node-result` 不带 callId（载荷冻结），所以用 nodeId 关联到 node-started 的 callId
  const startedByNode = new Map<string, { callId: string; tool: string }>()
  const approved = new Set<string>()

  for (const event of events) {
    if (event.type === 'plan/node-started') {
      const callId = event.data['callId']
      const nodeId = event.data['nodeId']
      const tool = event.data['tool']
      if (typeof callId === 'string' && typeof nodeId === 'string' && typeof tool === 'string') {
        startedByNode.set(nodeId, { callId, tool })
      }
    }
    if (event.type === 'approval/asked' || event.type === 'approval/decided') {
      const callId = event.data['callId']
      if (typeof callId === 'string') approved.add(callId)
    }
  }

  for (const result of events) {
    if (result.type !== 'plan/node-result' || result.data['status'] !== 'succeeded') continue
    const nodeId = result.data['nodeId']
    if (typeof nodeId !== 'string') continue
    const started = startedByNode.get(nodeId)
    if (started?.tool !== 'transfer_create') continue
    if (!approved.has(started.callId)) {
      findings.push(
        `snapshots/cross-scene/session.jsonl: I4 节点 ${nodeId} 的 transfer_create 没有独立审批记录`,
      )
    }
  }
  return findings
}

/**
 * I5：`succeeded` 永不重跑（动态）。同一节点 `succeeded` 之后不得再出现 `plan/node-started`。
 *
 * WHY 必须动态：静态锚点只能证明注释还在；"跳过已成功节点"的真正判据是事件序。
 */
export function checkNoRerun(events: readonly PlanLine[]): string[] {
  const findings: string[] = []
  const succeeded = new Set<string>()
  for (const event of events) {
    const nodeId = event.data['nodeId']
    if (typeof nodeId !== 'string') continue
    if (event.type === 'plan/node-result' && event.data['status'] === 'succeeded') {
      succeeded.add(nodeId)
    }
    if (event.type === 'plan/node-started' && succeeded.has(nodeId)) {
      findings.push(`snapshots/cross-scene/session.jsonl: I5 节点 ${nodeId} 在 succeeded 之后被重跑（二次扣款风险）`)
    }
  }
  return findings
}

/** I7：零新事件键——`(goal|todo|effects|operator)/xxx` 形态 0 命中。 */
export function checkEventKeys(rel: string, source: string): string[] {
  if (rel.endsWith('.test.ts')) return []
  const pattern = /['"`](?:goal|todo|effects|operator)\/[a-z][a-z-]*['"`]/
  return pattern.test(source)
    ? [`${rel}: I7 出现未批准的事件键（goal/todo/effects/operator 前缀，D5 零新键）`]
    : []
}

/* ────────────────────────────── 门禁本体 ────────────────────────────── */

const isSource = (fileName: string): boolean => fileName.endsWith('.ts') && !fileName.endsWith('.test.ts')

export const gate: Gate = {
  name: 'cross-scene',
  async run(root: string): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    const rel = (file: string): string => relative(root, file).replaceAll('\\', '/')

    const todoFiles = walk(root, ['packages/runtime/src/todo'], isSource)
    for (const file of todoFiles) findings.push(...checkTodoSource(rel(file), readFileSync(file, 'utf8')))

    const goalFiles = walk(root, ['packages/runtime/src/goal'], isSource)
    for (const file of goalFiles) findings.push(...checkGoalSource(rel(file), readFileSync(file, 'utf8')))

    const planFiles = walk(root, ['packages/runtime/src/plan'], isSource)
    for (const file of planFiles) findings.push(...checkAddNode(rel(file), readFileSync(file, 'utf8')))

    // 全仓 `.addNode(` 扫描（scripts 自身不扫：门禁代码里讨论它不构成调用）
    //
    // I4② 的反向特征串**只扫计划面**（`host/src/boot/` + `runtime/src/plan/`）：
    // saga 的 gate 表里有自己的 `approveAll` 字段（那是 saga 的状态语义，不是批量放行），
    // 全仓扫会把好代码判红——门禁一变成噪音，下一个人就会去关掉它。
    const allSources = walk(root, ['packages', 'apps'], isSource)
    for (const file of allSources) {
      const relPath = rel(file)
      const text = readFileSync(file, 'utf8')
      findings.push(...checkAddNode(relPath, text))
      if (relPath.startsWith('packages/host/src/boot/') || relPath.startsWith('packages/runtime/src/plan/')) {
        findings.push(...checkPlanAnchors(relPath, text))
      }
      findings.push(...checkEventKeys(relPath, text))
    }

    // I5 静态锚点：PlanResumeOptions 的"永不重跑"注释还在（删掉即红）
    const planTypes = join(root, 'packages/runtime/src/plan/types.ts')
    try {
      if (!readFileSync(planTypes, 'utf8').includes('succeeded` 的节点永远不重跑')) {
        findings.push('packages/runtime/src/plan/types.ts: I5 缺"succeeded 永不重跑"锚点注释')
      }
    } catch {
      findings.push('packages/runtime/src/plan/types.ts: I5 读不到文件（结构被移动）')
    }

    // I6：生日案例必须存在于 D 族（被悄悄删掉 = 演示的核心证据消失）
    const dScenarios = join(root, 'packages/eval/src/scenarios/d/index.ts')
    try {
      const text = readFileSync(dScenarios, 'utf8')
      if (!/生日案例/.test(text) || !/kind:\s*'plan'/.test(text)) {
        findings.push('packages/eval/src/scenarios/d/index.ts: I6 D 族缺"生日案例"编排场景（action.kind=plan）')
      }
    } catch {
      findings.push('packages/eval/src/scenarios/d/index.ts: I6 读不到 D 族场景文件')
    }

    // I4③ / I5 动态段：读 cross-scene 快照（真跑过的事件流）
    const snapshotPath = join(root, 'snapshots/cross-scene/session.jsonl')
    try {
      const events = linesOf(readFileSync(snapshotPath, 'utf8'))
      findings.push(...checkApprovalWindows(events))
      findings.push(...checkNoRerun(events))
      notes.push(`cross-scene 事件 ${String(events.length)} 条（I4③ / I5 动态判据的来源）`)
    } catch {
      findings.push('snapshots/cross-scene/session.jsonl: I4/I5 缺跨场景快照（演示链路的审计证据）')
    }

    notes.push(
      `扫描面：todo ${String(todoFiles.length)} 文件、goal ${String(goalFiles.length)} 文件、plan ${String(planFiles.length)} 文件、全仓 ${String(allSources.length)} 文件`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

if (isMainModule(import.meta.url)) void runStandalone(gate)
