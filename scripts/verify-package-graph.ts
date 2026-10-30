/**
 * 门禁：包依赖图零循环 + 分层方向不反转（门禁扩容 07 §2-2）。
 *
 * 为什么这条门禁必须先上：技术债复审 2026-10-20 风险提示 2 要求（该件已撤下）
 * "先在纸面验证无环再动手"，但它自己在纸面上就把 `saga → persistence` 的方向判错了
 * （实测 persistence 在 saga 的 devDependencies，生产源码零引用）。纸面推断不可信，
 * 所以 P1-2 的前置条件是一条**可执行**的检环，而不是一段结论。
 *
 * 四条规则：
 * 1. **只按 `dependencies` 建图检环**：`devDependencies` 是测试设施（`saga → persistence`、
 *    `runtime → persistence`），参与检环会把合法的测试装配报成环；越界另由
 *    `verify-no-dev-dep-in-src` 负责。
 * 2. **子路径归一**：`@bah/llm/deepseek` 归一化为 `@bah/llm` 再查边。`llm` 的 `exports`
 *    已声明该子路径，属合法导入，按整包名一刀切会产生误报。
 * 3. **零依赖原语**：`@bah/util` 的 `dependencies` 必须为空（领域语义一律不许下沉到原语层）。
 * 4. **方向断言**：领域/能力层不得反向依赖装配层（`host`、`cli`），否则装配逻辑会
 *    顺着依赖被拖进领域层，`packages/*` 的分层就此失效。
 *
 * 自环：`package.json` 里出现"自己依赖自己"是真错误（`@bah/core` 内部的相对导入
 * 不经过 package.json，不会出现在本图里），因此照常报环，不做豁免。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { isMainModule, runStandalone, type Gate, type GateResult } from './gate-lib.ts'

/** 领域/能力层：只允许依赖更底层的包，不许回头依赖装配层。 */
const DOMAIN_PACKAGES = new Set([
  '@bah/bank',
  '@bah/knowledge',
  '@bah/llm',
  '@bah/policy',
  '@bah/persistence',
  '@bah/saga',
  '@bah/safety',
  '@bah/interaction',
])

/** 装配层：把零件接起来的一层，领域层不得依赖它。 */
const ASSEMBLY_PACKAGES = new Set(['@bah/host', '@bah/cli'])

/** 零依赖原语包：一旦它有 dependencies，分层的地基就漏了。 */
const PRIMITIVE_PACKAGE = '@bah/util'

/** 一个包的依赖事实。 */
interface PackageFacts {
  /** 包名，如 `@bah/saga`。 */
  readonly name: string
  /** 相对仓库根的 package.json 路径（posix）。 */
  readonly manifest: string
  /** `dependencies` 里归一化后的 `@bah/...` 包名。 */
  readonly deps: readonly string[]
  /** `devDependencies` 里归一化后的 `@bah/...` 包名（只用于说明，不参与检环）。 */
  readonly devDeps: readonly string[]
}

const gate: Gate = {
  name: 'package-graph',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const packages = readPackages(root, findings)
    const graph = new Map(packages.map((item) => [item.name, item.deps]))
    const edgeCount = packages.reduce((sum, item) => sum + item.deps.length, 0)

    notes.push(`包 ${packages.length} 个，dependencies 口径边 ${edgeCount} 条（devDependencies 不参与检环）`)

    const cycles = findCycles(graph)
    for (const cycle of cycles) findings.push(`依赖成环：${cycle.join(' → ')}`)

    checkPrimitive(packages, findings)
    checkLayering(packages, findings)

    const devOnly = packages
      .filter((item) => item.devDeps.length > 0)
      .map((item) => `${item.name} → ${item.devDeps.join('/')}`)
    if (devOnly.length > 0) notes.push(`devDependencies 边（测试设施，不检环）：${devOnly.join('，')}`)

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 读 packages 下每个包的 package.json，只保留 `@bah/` 前缀的边。 */
function readPackages(root: string, findings: string[]): PackageFacts[] {
  const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const packages: PackageFacts[] = []
  for (const dir of dirs) {
    const manifestPath = join(root, 'packages', dir, 'package.json')
    const manifest = relative(root, manifestPath).replace(/\\/g, '/')

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      findings.push(`${manifest}: 无法读取或解析（${reason(error)}）`)
      continue
    }
    if (!isRecord(raw) || typeof raw['name'] !== 'string') {
      findings.push(`${manifest}: 缺少字符串字段 name`)
      continue
    }

    packages.push({
      name: raw['name'],
      manifest,
      deps: bahNames(raw['dependencies']),
      devDeps: bahNames(raw['devDependencies']),
    })
  }
  return packages
}

/** 取依赖对象里的 `@bah/...` 键，剥掉子路径后去重排序。 */
function bahNames(value: unknown): string[] {
  if (!isRecord(value)) return []
  const names = new Set<string>()
  for (const key of Object.keys(value)) {
    if (!key.startsWith('@bah/')) continue
    names.add(normalize(key))
  }
  return [...names].sort()
}

/** `@bah/llm/deepseek` → `@bah/llm`（exports 声明的子路径是合法导入）。 */
function normalize(specifier: string): string {
  const parts = specifier.split('/')
  return parts.length > 1 ? `${parts[0]}/${parts[1]}` : specifier
}

/**
 * DFS 找环，返回**完整环路**（`a → b → c → a`）。
 *
 * 只报回边构成的环：进入节点的路径栈里，从被回指节点到当前节点的片段就是环本身。
 */
function findCycles(graph: ReadonlyMap<string, readonly string[]>): string[][] {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  const cycles: string[][] = []
  const seen = new Set<string>()

  const visit = (node: string): void => {
    color.set(node, GRAY)
    stack.push(node)

    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue // 外部包或未实装包不参与环判定
      const state = color.get(dep) ?? WHITE
      if (state === WHITE) {
        visit(dep)
        continue
      }
      if (state !== GRAY) continue

      const start = stack.indexOf(dep)
      const cycle = [...stack.slice(start), dep]
      const key = canonicalCycle(cycle)
      if (!seen.has(key)) {
        seen.add(key)
        cycles.push(cycle)
      }
    }

    stack.pop()
    color.set(node, BLACK)
  }

  for (const node of [...graph.keys()].sort()) {
    if ((color.get(node) ?? WHITE) === WHITE) visit(node)
  }
  return cycles
}

/** 环的规范形（旋转到字典序最小的起点），用于去重。 */
function canonicalCycle(cycle: readonly string[]): string {
  const body = cycle.slice(0, -1)
  if (body.length === 0) return ''
  let best = ''
  for (let index = 0; index < body.length; index += 1) {
    const rotated = [...body.slice(index), ...body.slice(0, index)].join('→')
    if (best === '' || rotated < best) best = rotated
  }
  return best
}

/** `@bah/util` 必须零依赖。 */
function checkPrimitive(packages: readonly PackageFacts[], findings: string[]): void {
  const primitive = packages.find((item) => item.name === PRIMITIVE_PACKAGE)
  if (primitive === undefined) {
    findings.push(`${PRIMITIVE_PACKAGE}: 未在 packages/*/package.json 中找到（原语包不可缺失）`)
    return
  }
  if (primitive.deps.length > 0) {
    findings.push(
      `${primitive.manifest}: ${PRIMITIVE_PACKAGE} 必须零依赖，实际依赖 ${primitive.deps.join(', ')}`,
    )
  }
}

/** 领域/能力层不得依赖装配层。 */
function checkLayering(packages: readonly PackageFacts[], findings: string[]): void {
  for (const item of packages) {
    if (!DOMAIN_PACKAGES.has(item.name)) continue
    for (const dep of item.deps) {
      if (!ASSEMBLY_PACKAGES.has(dep)) continue
      findings.push(
        `${item.manifest}: ${item.name} 依赖装配层 ${dep}（领域层不得反向依赖 host/cli）`,
      )
    }
  }
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
