/**
 * 计划校验（方案 §3.3：**8 条规则 + 附则**，W11 加 V9 两条 ⇒ **10 条**，全量收集不短路）。
 *
 * 纪律：本文件**返回问题、不抛错、不读时钟、不读环境**。
 * "拒绝还是告警"是调用方的决定（引擎选择拒绝），校验器只管把问题说全。
 *
 * 为什么不短路：一次只报一个错，调用方要改 N 遍。全量收集后 `plan-invalid` 的
 * `detail.issues` 能一次说清。
 */

import { canonicalJson, reasonOf } from '@bah/util'

import { collectTemplateRefs } from './template.ts'
import { findCyclePath, kahnSort } from './topo.ts'
import { MAX_PLAN_ARGS_BYTES, PLAN_NODE_ID_PATTERN } from './types.ts'

import type { Plan, PlanIssue, PlanNode } from './types.ts'

/** 校验参数（上限与工具判定都由宿主注入）。 */
export interface ValidateOptions {
  readonly maxNodes: number
  readonly maxEdges: number
  /** 宿主注入（`(n) => registry.has(n)`）——runtime 不认识 `ToolRegistry`。 */
  readonly hasTool: (name: string) => boolean
}

/**
 * 校验一张计划。
 *
 * @returns 问题清单；空数组 = 可以执行
 */
export function validatePlan(plan: Plan, options: ValidateOptions): PlanIssue[] {
  const issues: PlanIssue[] = []
  const nodes = plan.nodes

  if (typeof plan.planId !== 'string' || plan.planId.trim().length === 0) {
    // V0（方案未列）：planId 是单写者与 digest 的主键，空值会让 in-flight 判定退化成同一个桶
    issues.push({
      code: 'plan-id-invalid',
      message: 'planId 必须是非空字符串（它是 digest 与单写者判定的主键）',
    })
  }

  // V1 空计划
  if (nodes.length === 0) {
    issues.push({ code: 'plan-empty', message: '计划至少要有一个节点' })
    // 空计划后面的检查全部无意义，直接返回（不算"短路"：这是唯一一处合集为空的规则）
    return issues
  }

  // V2 节点数上限
  if (nodes.length > options.maxNodes) {
    issues.push({
      code: 'plan-too-large',
      message: `节点数 ${nodes.length} 超过上限 ${options.maxNodes}`,
    })
  }

  // V3 id 合法 + 唯一
  const seen = new Set<string>()
  for (const node of nodes) {
    const id = typeof node.id === 'string' ? node.id : ''
    if (!PLAN_NODE_ID_PATTERN.test(id)) {
      issues.push({
        code: 'plan-node-id',
        nodeId: id,
        message: `节点 id "${id}" 不合法（要求 [A-Za-z0-9_-]{1,64}：它要进 callId，不能带分隔符）`,
      })
      continue
    }
    if (seen.has(id)) {
      issues.push({
        code: 'plan-node-duplicate',
        nodeId: id,
        message: `节点 id "${id}" 重复（id 是快照与恢复的主键）`,
      })
      continue
    }
    seen.add(id)
  }

  // V4 / V5 依赖存在 + 无自依赖
  let depIssues = 0
  for (const node of nodes) {
    for (const dep of node.deps) {
      if (dep === node.id) {
        issues.push({
          code: 'plan-self-dep',
          nodeId: node.id,
          dep,
          message: `节点 "${node.id}" 依赖自己`,
        })
        depIssues += 1
        continue
      }
      if (!seen.has(dep)) {
        issues.push({
          code: 'plan-dep-missing',
          nodeId: node.id,
          dep,
          message: `节点 "${node.id}" 依赖了不存在的节点 "${dep}"`,
        })
        depIssues += 1
      }
    }
  }

  // 附：边数上限（防"32 个节点、128 条边"的稠密图把串行执行拖成谜）
  const edges = nodes.reduce((sum, node) => sum + node.deps.length, 0)
  if (edges > options.maxEdges) {
    issues.push({
      code: 'plan-too-many-edges',
      message: `依赖边 ${edges} 条超过上限 ${options.maxEdges}`,
    })
  }

  // V7 工具已注册
  for (const node of nodes) {
    if (!options.hasTool(node.tool)) {
      issues.push({
        code: 'plan-tool-missing',
        nodeId: node.id,
        tool: node.tool,
        message: `节点 "${node.id}" 用的工具 "${node.tool}" 未注册（模型可见工具锁定 14 个）`,
      })
    }
  }

  // V8 入参可序列化 + 体积上限
  issues.push(...checkArgs(nodes))

  // V9 动态 args 的引用必须静态可解析（节点存在 + 在 deps 闭包内）
  issues.push(...checkTemplateRefs(nodes, seen))

  // V6 无环（依赖问题未清时不报环：缺失依赖会让 kahn 的残余集合说的不是环）
  if (depIssues === 0) {
    const { remaining } = kahnSort(nodes)
    if (remaining.length > 0) {
      const cyclePath = findCyclePath(nodes, remaining)
      issues.push({
        code: 'plan-cycle',
        cyclePath,
        message: `计划有环：${cyclePath.join(' → ') || remaining.join('、')}`,
      })
    }
  }

  return issues
}

/** V8：`args` 必须是可 canonical 序列化的对象，且 ≤ 64KB。 */
function checkArgs(nodes: readonly PlanNode[]): PlanIssue[] {
  const issues: PlanIssue[] = []
  for (const node of nodes) {
    const args: unknown = node.args
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      issues.push({
        code: 'plan-args-invalid',
        nodeId: node.id,
        message: `节点 "${node.id}" 的 args 必须是对象`,
      })
      continue
    }
    let text: string
    try {
      text = canonicalJson(args)
    } catch (error) {
      issues.push({
        code: 'plan-args-invalid',
        nodeId: node.id,
        message: `节点 "${node.id}" 的 args 不可序列化：${reasonOf(error)}`,
      })
      continue
    }
    const bytes = new TextEncoder().encode(text).length
    if (bytes > MAX_PLAN_ARGS_BYTES) {
      issues.push({
        code: 'plan-args-too-large',
        nodeId: node.id,
        message: `节点 "${node.id}" 的 args ${bytes} 字节超过上限 ${MAX_PLAN_ARGS_BYTES}`,
      })
    }
  }
  return issues
}

/**
 * V9：`"${node.<id>.<path>}"` 的引用必须**静态可解析**。
 *
 * 两条码分开报，因为修法不同：
 * - `plan-args-ref-missing`：计划里没这个节点 → 改 args（一个字母的事）；
 * - `plan-args-ref-outside-deps`：节点存在但不在**闭包**里 → 改图或改依赖，不是改字。
 *
 * 为什么必须闭包而不是直接 `deps`：串行执行下只有"拓扑序在前且一定先跑"的节点才有 output。
 * 允许旁支引用会让真实执行顺序成为隐性依赖，`ordinal` 与快照排序就都失去意义。
 *
 * 为什么引用自己也算 outside：自引用的 output 在解析时根本不存在（自己还没跑完）。
 */
function checkTemplateRefs(nodes: readonly PlanNode[], known: ReadonlySet<string>): PlanIssue[] {
  const issues: PlanIssue[] = []
  const closure = depClosureOf(nodes)
  for (const node of nodes) {
    for (const ref of collectTemplateRefs(node.args)) {
      if (!known.has(ref.nodeId)) {
        issues.push({
          code: 'plan-args-ref-missing',
          nodeId: node.id,
          dep: ref.nodeId,
          message: `节点 "${node.id}" 的 args 引用了不存在的节点 "${ref.nodeId}"（${ref.raw}）`,
        })
        continue
      }
      if (closure.get(node.id)?.has(ref.nodeId) !== true) {
        issues.push({
          code: 'plan-args-ref-outside-deps',
          nodeId: node.id,
          dep: ref.nodeId,
          message:
            `节点 "${node.id}" 的 args 引用了 "${ref.nodeId}"（${ref.raw}），` +
            '但它不在本节点的依赖闭包内：执行到本节点时那个 output 还不存在',
        })
      }
    }
  }
  return issues
}

/** 每个节点的**传递依赖集**（迭代 BFS：无递归深度上限，也不怕环——环由 V6 单独报）。 */
function depClosureOf(nodes: readonly PlanNode[]): Map<string, Set<string>> {
  const deps = new Map<string, readonly string[]>()
  for (const node of nodes) deps.set(node.id, node.deps)
  const out = new Map<string, Set<string>>()
  for (const node of nodes) {
    const seen = new Set<string>()
    const stack = [...node.deps]
    while (stack.length > 0) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const up of deps.get(id) ?? []) stack.push(up)
    }
    out.set(node.id, seen)
  }
  return out
}
