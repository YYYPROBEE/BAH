/**
 * 架构图与事实表生成器（W19）。
 *
 * ## 为什么必须"生成"而不是"手画"
 *
 * 架构图最常见的腐烂方式是"图里有、代码里没有"：组件改名、profile 少装一行，
 * 图还在。所以本脚本**只从代码取值**，一个组件名都不手写：
 *
 * - 组件清单 = `HOST_PLUGINS`（依赖清单，20 项）；
 * - 依赖边 = 每个插件的 `inject`（服务键）→ `SERVICE_OWNER`（服务键 → 提供方插件）；
 * - 装配状态 = **真实的 profile 装载器**（`readProfile` + `loadBundles` + `readLayers` + `mergeLayers`），
 *   不自己解析 YAML——否则"图里说装了"和"真的装了"会各说各话。
 *
 * ## 三态（v2 施工单只写了两种，实测必须三种）
 *
 * | 态 | 判据 | 图上的画法 |
 * |---|---|---|
 * | 生效 | 该 profile 有行，且 config 里没有 `enabled: false` | 实线 |
 * | 装配但关闭 | 有行，但 `enabled: false`（插件 `apply()` 直接 return） | 虚线 + 标注 |
 * | 未装配 | 该 profile 没有这一行（注册表里有，但没人 use） | 不画（其他 profile 里画灰虚线） |
 *
 * `enabled: false` **不是**"没装配"：行在、插件实例在、只是不接管。把它画成"没装"是错的。
 *
 * ## 输出
 *
 * 往三份文档里注入同名块（`BEGIN GENERATED:facts` 等），块外内容手写、脚本不碰：
 * - `docs/architecture.md`：事实表 + 注册表图 + 装配图 + 装配矩阵
 * - `docs/algorithms.md`：事实表（三份共用同一块 ⇒ 不可能互相矛盾）
 * - `docs/security-design.md`：事实表
 *
 * ## 用法
 *
 * ```bash
 * npx tsx scripts/gen-architecture.ts          # 写入（默认）
 * npx tsx scripts/gen-architecture.ts --check  # 只校验，过期即退出码 1（门禁与 CI 用）
 * ```
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BANK_TOOL_SPECS } from '@bah/bank'
import { mergeLayers, type ResolvedRow } from '@bah/host'
import { PLAN_NODE_STATES } from '@bah/runtime'
import { SAGA_TRANSITIONS } from '@bah/saga'

import { loadBundles } from '../packages/cli/src/bundles.ts'
import { readLayers, readProfile } from '../packages/cli/src/profile.ts'
import { HOST_PLUGINS, planPlugin } from '../packages/host/src/boot/plugins/index.ts'
import { isMainModule, projectRoot } from './gate-lib.ts'

/** 真正可运行的四个 profile（`profiles/` 下其余目录是空壳，没有 `profile.yml`）。 */
const PROFILES = ['headless', 'plan', 'web', 'web-plan'] as const
type ProfileName = (typeof PROFILES)[number]

/**
 * 服务键 → 提供方插件 id。
 *
 * 这张表是**唯一手写的映射**，其余全部来自代码。它之所以不能省：`inject` 只告诉你
 * "我要谁"，不告诉你"谁提供"。为了让这张表不能悄悄腐烂，本脚本每次运行都会校验：
 * 1. `HOST_PLUGINS` 里出现过的每个 inject 键都必须在这张表里（漏登记即抛）；
 * 2. 表里每个 owner 都必须是注册表里的 id（或宿主伪节点 `@host`）。
 * 新增一个服务依赖却忘了登记，第一次跑就会红。
 */
const SERVICE_OWNER: Readonly<Record<string, string>> = {
  // 宿主运行时（`boot()` 自己提供，不是插件）
  'bah:run': '@host',
  'runtime:session': 'core:session',
  'runtime:tools': 'core:tools',
  'runtime:agents': 'core:agent',
  // 系统提示段注册表（`provideSystemPrompt` 由 core:prompt 调用）
  'runtime:system-prompt': 'core:prompt',
  // C4 跨会话记忆：服务键由 `bah:memory-store` 自己 provide（读/写/召回缓存）
  'bah:memory': 'bah:memory-store',
  // 模型适配器注册表（`packages/llm/src/llm/registry.ts` 的 provide，由 core:model 调用）
  'llm:adapters': 'core:model',
  'bah:session-files': 'core:persistence',
  'audit:decisions': 'audit:decisions',
  'bank:identity': 'bank:tools',
  'bank:ticket-guard': 'bank:tools',
  'interaction:approval': 'interaction:approval',
  'safety:sentry': 'safety:sentry',
  // saga 时钟由 `provideSaga` 自己提供（saga.ts 的注释明确禁止把它写进 inject）
  'bah:saga-clock': 'bank:saga',
}

/** 宿主伪节点（不是插件，但依赖边的起点要画出来）。 */
const HOST_NODE = '@host'
const HOST_LABEL = '宿主运行时 boot()'

/** 分层顺序（只影响画图分组顺序，不影响内容）。 */
const LAYERS: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'core', label: '① 内核与主循环（core）' },
  { key: 'audit', label: '② 证据链（audit）' },
  { key: 'bank', label: '③ 银行域（bank）' },
  { key: 'interaction', label: '④ 交互与审批（interaction）' },
  { key: 'safety', label: '⑤ 安全防护（safety）' },
  { key: 'plan', label: '⑥ 编排原语（plan）' },
  { key: 'channel', label: '⑦ 渠道（channel）' },
  { key: 'demo', label: '⑧ 演示件（demo）' },
]

/** 插件 id → 分层键（取 `:` 前缀）。 */
function layerOf(id: string): string {
  return id.split(':')[0] ?? id
}

/** 装配态。 */
type AssemblyState = 'active' | 'disabled' | 'absent'

/** 一个 profile 的装配结果。 */
interface ProfileAssembly {
  readonly name: ProfileName
  /** 注册表 id → 装配态。 */
  readonly states: ReadonlyMap<string, AssemblyState>
  /** 该 profile 最终的行（含覆盖来源层，供排障）。 */
  readonly rows: readonly ResolvedRow[]
}

/** 事实表的六项（全部来自代码，唯一例外是覆盖率——它必须跑一遍才有）。 */
interface Facts {
  readonly registryCount: number
  readonly gateCount: number
  readonly toolCount: number
  readonly planStates: readonly string[]
  readonly sagaStates: readonly string[]
  readonly ticketTtlMs: number
  readonly planTimeoutMs: number
  readonly coverageLine: string
  readonly coveragePackage: string
}

/** 覆盖率台账（由 `--coverage` 那一次实测写死，不参与生成逻辑）。 */
interface CoverageBaseline {
  readonly measuredAt: string
  readonly command: string
  readonly line: { readonly covered: number; readonly total: number; readonly pct: number }
  readonly packages: { readonly atLeast80: number; readonly total: number }
  readonly note?: string
}

const root = projectRoot()

/** 插件对象上的 `inject`（服务键 id 列表）。 */
function injectOf(item: (typeof HOST_PLUGINS)[number]): readonly string[] {
  const plugin = item.plugin as { inject?: readonly { id?: string }[] }
  return (plugin.inject ?? []).map((key) => key.id ?? String(key))
}

/** 读一个 profile 的真实装配结果。 */
async function assemblyOf(name: ProfileName): Promise<ProfileAssembly> {
  const profile = readProfile(root, name)
  const bundles = await loadBundles(root, profile.bundles)
  // home patch 指向一个不存在的目录：图只描述**仓库里可复现的装配**，
  // 不能让某台机器上的 `~/.bah` 私有覆盖改变了架构图。
  const { layers } = readLayers(root, profile, { home: join(root, '.tmp-arch-home'), overlays: [] })
  const rows = mergeLayers(bundles, layers)

  const byPlugin = new Map<string, ResolvedRow>()
  const registryIds = new Set(HOST_PLUGINS.map((item) => item.id))
  for (const row of rows) {
    if (!registryIds.has(row.use)) continue
    if (byPlugin.has(row.use)) {
      throw new Error(
        `profile ${name} 里插件 ${row.use} 被两行引用（${byPlugin.get(row.use)?.id} / ${row.id}）：` +
          '装配图无法表达"同一插件两个实例"，请先决定图怎么画再跑',
      )
    }
    byPlugin.set(row.use, row)
  }

  const states = new Map<string, AssemblyState>()
  for (const id of registryIds) {
    const row = byPlugin.get(id)
    if (row === undefined) {
      states.set(id, 'absent')
      continue
    }
    // `enabled: false` = 装配但自关闭（插件 apply() 里直接 return）；不是"没装"
    states.set(id, row.config['enabled'] === false ? 'disabled' : 'active')
  }

  return { name, states, rows }
}

/** 事实表取值。 */
function factsOf(planAssembly: ProfileAssembly, coverage: CoverageBaseline): Facts {
  // 票据 TTL 必须走**真实的** validate：直接抄注释里的常数会与默认值脱钩。
  // plan:dag 只在 `plan` profile 装配，所以取它的行；取不到就走插件默认值。
  const planRow = planAssembly.rows.find((row) => row.use === 'plan:dag')
  const planConfig = planRow?.config ?? ({} as Readonly<Record<string, unknown>>)
  const settings = planPlugin.validate({
    ...(planConfig as Record<string, unknown>),
  })

  const gateCount = readdirSync(join(root, 'scripts')).filter((name) =>
    /^verify-[\w-]+\.ts$/.test(name),
  ).length

  return {
    registryCount: HOST_PLUGINS.length,
    gateCount,
    toolCount: BANK_TOOL_SPECS.length,
    planStates: PLAN_NODE_STATES,
    sagaStates: Object.keys(SAGA_TRANSITIONS),
    ticketTtlMs: settings.ticketTtlMs,
    planTimeoutMs: settings.planTimeoutMs,
    coverageLine: `${coverage.line.pct.toFixed(2)}%（行口径，${String(coverage.line.covered)}/${String(coverage.line.total)} 行，实测 ${coverage.measuredAt}）`,
    coveragePackage: `${String(coverage.packages.atLeast80)}/${String(coverage.packages.total)}（包口径：包级行覆盖 ≥80% 的包数 / 参与统计的包数）`,
  }
}

/** 事实表（三份文档共用同一块 ⇒ 结构上不可能互相矛盾）。 */
function renderFacts(facts: Facts): string {
  return [
    '| 事实 | 值 | 唯一来源（以代码为准，改文档不改代码） |',
    '|---|---|---|',
    `| plan 节点态 | **${String(facts.planStates.length)} 态**（${facts.planStates.join('、')}） | packages/runtime/src/plan/types.ts 的 \`PLAN_NODE_STATES\` |`,
    `| saga 状态 | **${String(facts.sagaStates.length)} 态**（${facts.sagaStates.join('、')}） | packages/saga/src/state-machine/transitions.ts 的 \`SAGA_TRANSITIONS\` |`,
    `| 票据 TTL / 计划预算 | **${String(facts.ticketTtlMs)} ms / ${String(facts.planTimeoutMs)} ms**（预算 < TTL） | \`PlanSettings.ticketTtlMs\` / \`planTimeoutMs\`（本行由 planPlugin.validate 实算） |`,
    `| 工具数 | **${String(facts.toolCount)} 个** | packages/bank/src/tools/specs.ts 的 \`BANK_TOOL_SPECS\` |`,
    `| 注册表 / 门禁 | **${String(facts.registryCount)} 项 / ${String(facts.gateCount)} 项** | \`HOST_PLUGINS\`、\`scripts/verify-*.ts\` 计数 |`,
    `| 覆盖率 | **${facts.coverageLine}；${facts.coveragePackage}** | docs/coverage-baseline.json（含测量命令） |`,
  ].join('\n')
}

/** mermaid 节点 id（稳定：按注册表顺序）。 */
function nodeId(index: number): string {
  return `p${String(index)}`
}

/**
 * 分层表：组件按层归组。
 *
 * 为什么分层用**表**不用图：mermaid 的 subgraph 布局对"8 个分组 × 20 个节点且组间无连线"
 * 这种输入没有稳定结果（实测要么横着排到画布外，要么每个分组自成一列）。
 * 分层是**分类信息**，表格比图准；"谁依赖谁"用下面的依赖图。
 */
function renderLayersTable(): string {
  const lines = ['| 层 | 组件 | 数量 |', '|---|---|---|']
  for (const layer of LAYERS) {
    const members = HOST_PLUGINS.map((item) => item.id).filter((id) => layerOf(id) === layer.key)
    if (members.length === 0) continue
    lines.push(
      `| ${layer.label} | ${members.map((id) => `\`${id}\``).join('、')} | ${String(members.length)} |`,
    )
  }
  lines.push(`| **合计** | — | **${String(HOST_PLUGINS.length)}** |`)
  return lines.join('\n')
}

/** 依赖图：只有 `inject` 关系的组件 + 宿主伪节点，不带分组（布局才干净）。 */
function renderDependencyMermaid(): string {
  const ids = HOST_PLUGINS.map((item) => item.id)
  const indexOf = new Map(ids.map((id, index) => [id, index]))
  const edges = new Set<string>()
  const involved = new Set<number>()

  for (const [index, item] of HOST_PLUGINS.entries()) {
    for (const key of injectOf(item)) {
      const owner = SERVICE_OWNER[key]
      if (owner === undefined) {
        throw new Error(
          `服务键 ${key}（被 ${item.id} 依赖）没有登记提供方：请在 SERVICE_OWNER 里补一行`,
        )
      }
      involved.add(index)
      if (owner === HOST_NODE) {
        edges.add(`  ${nodeId(index)} --> host["${HOST_LABEL}"]`)
        continue
      }
      const ownerIndex = indexOf.get(owner)
      if (ownerIndex === undefined) {
        throw new Error(`SERVICE_OWNER 把 ${key} 指向 ${owner}，但注册表里没有这个插件 id`)
      }
      if (ownerIndex === index) continue
      involved.add(ownerIndex)
      edges.add(`  ${nodeId(index)} --> ${nodeId(ownerIndex)}`)
    }
  }

  // 无依赖的组件也画出来：这张图同时充当"组件全图"，否则 tools / prompt 这类叶子节点会凭空消失
  const drawn = new Set<number>([...involved, ...HOST_PLUGINS.map((_, index) => index)])
  const lines: string[] = ['```mermaid', 'graph LR']
  for (const index of [...drawn].sort((a, b) => a - b)) {
    lines.push(`  ${nodeId(index)}["${ids[index]}"]`)
  }
  lines.push(...[...edges].sort())
  lines.push('```')
  return lines.join('\n')
}

/**
 * 装配图：**只画三个 profile 不一致的组件**。
 *
 * 为什么不画全量：20 个组件 × 3 列 = 60 个节点，图会糊成一团，反而看不出差异。
 * 一致的组件（三个 profile 都生效）在下面的矩阵表里逐行列出，不会丢信息。
 * 这里的判据是"状态向量不全相同"，由代码算出来，不是手挑的。
 */
function renderAssemblyMermaid(assemblies: readonly ProfileAssembly[]): string {
  const ids = HOST_PLUGINS.map((item) => item.id)

  const vectorOf = (id: string): AssemblyState[] =>
    assemblies.map((assembly) => assembly.states.get(id) ?? 'absent')

  const divergent = ids.filter((id) => {
    const vector = vectorOf(id)
    return vector.some((state) => state !== vector[0])
  })

  const lines: string[] = ['```mermaid', 'graph TB']
  const ghosts: string[] = []
  const disabled: string[] = []

  for (const assembly of assemblies) {
    lines.push(`  subgraph P_${assembly.name}["profiles/${assembly.name}"]`)
    for (const [index, id] of ids.entries()) {
      if (!divergent.includes(id)) continue
      const state = assembly.states.get(id) ?? 'absent'
      const node = `p${String(index)}_${assembly.name}`
      if (state === 'absent') {
        lines.push(`    ${node}["${id}（未装配）"]`)
        ghosts.push(node)
        continue
      }
      const suffix = state === 'disabled' ? '（enabled: false）' : ''
      lines.push(`    ${node}["${id}${suffix}"]`)
      if (state === 'disabled') disabled.push(node)
    }
    lines.push('  end')
  }

  lines.push('  classDef ghost stroke-dasharray: 5 5,stroke:#9aa4b2,color:#9aa4b2')
  lines.push('  classDef off stroke-dasharray: 3 3,stroke:#c9822f,color:#c9822f')
  if (ghosts.length > 0) lines.push(`  class ${ghosts.join(',')} ghost`)
  if (disabled.length > 0) lines.push(`  class ${disabled.join(',')} off`)
  lines.push('```')
  return lines.join('\n')
}

/**
 * 依赖明细表：每个组件要哪些服务、谁提供。
 *
 * 图上只画箭头（否则 8 条同名边标签会把图挤成一团），**具体是哪个服务看这张表**。
 * 表和图同源（都从 `inject` + `SERVICE_OWNER` 算），不可能对不上。
 */
function renderDependencyTable(): string {
  const lines = ['| 组件 | 依赖的服务（`inject`） | 提供方 |', '|---|---|---|']
  for (const item of HOST_PLUGINS) {
    const keys = injectOf(item)
    if (keys.length === 0) {
      lines.push(`| ${item.id} | —（无依赖） | — |`)
      continue
    }
    const deps = keys.map((key) => `\`${key}\``).join('、')
    const owners = keys
      .map((key) => {
        const owner = SERVICE_OWNER[key]
        return owner === HOST_NODE ? HOST_LABEL : `\`${owner ?? key}\``
      })
      .join('、')
    lines.push(`| ${item.id} | ${deps} | ${owners} |`)
  }
  return lines.join('\n')
}

/** 装配矩阵（表格比图更适合逐项对照）。 */
function renderMatrix(assemblies: readonly ProfileAssembly[]): string {
  const mark: Record<AssemblyState, string> = {
    active: '● 生效',
    disabled: '○ 关闭',
    absent: '· 未装配',
  }
  const header = ['| 组件 | ' + assemblies.map((item) => `profiles/${item.name}`).join(' | ') + ' |', '']
  header[1] = '|---|' + assemblies.map(() => '---').join('|') + '|'
  const rows = HOST_PLUGINS.map((item) => {
    const cells = assemblies.map((assembly) => mark[assembly.states.get(item.id) ?? 'absent'])
    return `| ${item.id} | ${cells.join(' | ')} |`
  })
  return [...header, ...rows].join('\n')
}

/** 抓出文档里的生成块。 */
function replaceBlock(text: string, name: string, body: string, file: string): string {
  const begin = `<!-- BEGIN GENERATED:${name} -->`
  const end = `<!-- END GENERATED:${name} -->`
  const from = text.indexOf(begin)
  const to = text.indexOf(end)
  if (from < 0 || to < 0 || to < from) {
    throw new Error(`${file} 缺少生成块标记 ${begin} / ${end}`)
  }
  return `${text.slice(0, from + begin.length)}\n${body}\n${text.slice(to)}`
}

/** 把要注入的内容按文档分组（事实表三份都注入）。 */
function blocksFor(doc: 'architecture' | 'algorithms' | 'security', payload: Record<string, string>): string[] {
  if (doc === 'architecture') {
    return ['facts', 'layers', 'dependency-graph', 'dependencies', 'assembly', 'matrix']
  }
  return ['facts']
}

const DOCS = {
  architecture: 'docs/architecture.md',
  algorithms: 'docs/algorithms.md',
  security: 'docs/security-design.md',
} as const

/** 主流程用到的三份文档（门禁也读这份表，避免两处各写一遍）。 */
export const DOC_PATHS = DOCS

/** 生成块的完整快照（纯函数：只读代码与文档，不写盘）。 */
export interface ArchitectureSnapshot {
  readonly assemblies: readonly ProfileAssembly[]
  readonly facts: Facts
  readonly payload: Readonly<Record<string, string>>
}

/** 算出本轮应有的生成块。 */
export async function computeArchitecture(rootDir = root): Promise<ArchitectureSnapshot> {
  const coveragePath = join(rootDir, 'docs/coverage-baseline.json')
  if (!existsSync(coveragePath)) {
    throw new Error('缺 docs/coverage-baseline.json（覆盖率是唯一"必须跑一遍"的事实）')
  }
  const coverage = JSON.parse(readFileSync(coveragePath, 'utf8')) as CoverageBaseline

  const assemblies = await Promise.all(PROFILES.map((name) => assemblyOf(name)))
  const planAssembly = assemblies.find((item) => item.name === 'plan')
  if (planAssembly === undefined) throw new Error('缺 plan 装配结果')

  const facts = factsOf(planAssembly, coverage)
  const payload: Record<string, string> = {
    facts: renderFacts(facts),
    layers: renderLayersTable(),
    dependencies: renderDependencyTable(),
    'dependency-graph': renderDependencyMermaid(),
    assembly: renderAssemblyMermaid(assemblies),
    matrix: renderMatrix(assemblies),
  }
  return { assemblies, facts, payload }
}

/** 把快照注入三份文档，返回"哪些文档有变化"。 */
async function applyDocs(
  snapshot: ArchitectureSnapshot,
  write: boolean,
  rootDir: string,
): Promise<string[]> {
  const changed: string[] = []
  for (const [doc, relPath] of Object.entries(DOCS)) {
    const path = join(rootDir, relPath)
    const before = readFileSync(path, 'utf8')
    // 行尾跟着文件本身走：Windows 上编辑器会写成 CRLF，若一律写回 LF，
    // 每次生成都会"有变化"，门禁永远红——而真正的问题只是行尾。
    const newline = before.includes('\r\n') ? '\r\n' : '\n'
    let after = before
    for (const name of blocksFor(doc as keyof typeof DOCS, snapshot.payload as Record<string, string>)) {
      const body = (snapshot.payload[name] ?? '').replace(/\r?\n/g, newline)
      after = replaceBlock(after, name, body, relPath)
    }
    if (after === before) continue
    changed.push(relPath)
    if (write) writeFileSync(path, after, 'utf8')
  }
  return changed
}

/** 校验模式：返回已过期的文档（空数组 = 一致）。门禁与 `--check` 共用。 */
export async function staleDocs(rootDir = root): Promise<string[]> {
  return applyDocs(await computeArchitecture(rootDir), false, rootDir)
}

/** 写入模式：返回被改写的文档。 */
export async function writeDocs(rootDir = root): Promise<string[]> {
  return applyDocs(await computeArchitecture(rootDir), true, rootDir)
}

/** 取块内容（门禁做逐条断言时用；行尾归一到 `\n`，避免 CRLF 伪造成"内容不一致"）。 */
export function blockOf(text: string, name: string): string {
  const begin = `<!-- BEGIN GENERATED:${name} -->`
  const end = `<!-- END GENERATED:${name} -->`
  const from = text.indexOf(begin)
  const to = text.indexOf(end)
  if (from < 0 || to < 0 || to < from) return ''
  return text.slice(from + begin.length, to).replace(/\r\n/g, '\n')
}

/** 主流程。 */
async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  const snapshot = await computeArchitecture()

  if (check) {
    const stale = await staleDocs()
    if (stale.length > 0) {
      console.error(`✘ 生成内容已过期：${stale.join('、')}（跑 npx tsx scripts/gen-architecture.ts 重写）`)
      process.exitCode = 1
      return
    }
    console.log('✔ 三份文档的生成块与代码一致')
    return
  }

  const stale = await writeDocs()
  console.log(`✔ 已生成：${stale.length === 0 ? '（无变化）' : stale.join('、')}`)
  console.log(
    `  注册表 ${String(snapshot.facts.registryCount)} 项 · 门禁 ${String(snapshot.facts.gateCount)} 项 · ` +
      `工具 ${String(snapshot.facts.toolCount)} 个 · plan ${String(snapshot.facts.planStates.length)} 态 · ` +
      `saga ${String(snapshot.facts.sagaStates.length)} 态 · 票据 TTL ${String(snapshot.facts.ticketTtlMs)} ms`,
  )
}

if (isMainModule(import.meta.url)) await main()
