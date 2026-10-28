/**
 * 策略管理面的共享实现（`policy:promote|rollback|versions|install|reload|audit-verify`）。
 *
 * 三条纪律（02 §4.4 / §8.3 / §9）：
 * 1. **变更必须可追责**：先 append+fsync 变更链，再原子写 `runtime-state.json`；
 *    链写失败 = 变更失败（与运行期判决相反）。
 * 2. **内容寻址**：切换/安装前用 `loadBundle` 重新编译并核对 lock；registry 的摘要与
 *    现场不符即拒绝，绝不允许"目录在就切"。
 * 3. **不猜状态**：首次 promote 必须显式 `--active`；rollback 没有 history 就拒绝。
 *
 * 本文件只做纯文件读写与决策，CLI 参数解析在 `policy-admin.ts`；测试直接调用这里。
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { loadBundle, loadRuleBundle, peekBundleKind } from '../packages/policy/src/load.ts'
import type { CompileResult } from '../packages/policy/src/compile.ts'
import { createSagaAudit } from '../packages/persistence/src/chain/index.ts'
import { BahError, canonicalJson } from '../packages/util/src/index.ts'

import { projectRoot } from './gate-lib.ts'
import { toolNames } from './policy-cli.ts'

export const REGISTRY_API = 'bah.policy.registry/v1'
export const STATE_API = 'bah.policy.runtime-state/v1'
export const ROLLOUT_CHAIN = 'policy-rollout'
export const TIER_KIND = 'bank.tier'
const PERCENT_BASE = 10_000

/** registry 里的一个版本条目。 */
export interface RegistryEntry {
  readonly path: string
  readonly semanticDigest: string
  readonly sourceDigest: string
  readonly engine: string
  readonly installedAt: number
  readonly demo?: boolean
}

/** registry 文件。 */
export interface RegistryFile {
  readonly apiVersion: string
  readonly kinds: Readonly<
    Record<string, { readonly versions: Readonly<Record<string, RegistryEntry>> }>
  >
}

/** 金丝雀分配。 */
export interface CanaryAssignment {
  readonly version: string
  readonly percent: number
  readonly sessions?: readonly string[]
  readonly epoch: number
}

/** 一个 kind 的分配。 */
export interface Assignment {
  readonly active: string
  readonly canary?: CanaryAssignment
}

/** 变更历史（最多 50 条）。 */
export interface HistoryEntry {
  readonly at: number
  readonly kind: string
  readonly from: string
  readonly to: string
  readonly percent: number
  readonly epoch: number
  readonly operator: string
  readonly reason: string
  readonly action: 'promote' | 'rollback'
}

/** runtime-state 文件。 */
export interface StateFile {
  readonly apiVersion: string
  readonly updatedAt: number
  readonly operator: string
  readonly reason: string
  readonly assignments: Readonly<Record<string, Assignment>>
  readonly history: readonly HistoryEntry[]
}

/** 变更链上的一条记录。 */
export interface RolloutRecord {
  readonly at: number
  readonly kind: string
  readonly action: 'promote' | 'rollback'
  readonly from: string
  readonly to: string
  readonly percent: number
  readonly epoch: number
  readonly operator: string
  readonly reason: string
}

/** 一次变更的完整计划：先写链、再写 state，顺序不可换。 */
export interface ChangePlan {
  readonly state: StateFile
  readonly record: RolloutRecord
  /** 没有实际变化（同版本/同分配）时为 false：不写链、不改 state。 */
  readonly changed: boolean
  readonly summary: string
}

/** 管理面选项。 */
export interface AdminPaths {
  /** 策略根（默认 `policies`）。 */
  readonly root: string
  /** runtime-state 路径（默认 `<root>/runtime-state.json`）。 */
  readonly statePath: string
}

/** 解析默认路径。 */
export function adminPaths(options: {
  readonly root?: string
  readonly statePath?: string
} = {}): AdminPaths {
  const root = resolve(projectRoot(), options.root ?? 'policies')
  return { root, statePath: resolve(options.statePath ?? join(root, 'runtime-state.json')) }
}

/** 读 registry；不存在/形状不对都抛结构化错误。 */
export function readRegistry(root: string): RegistryFile {
  const path = join(root, 'registry.json')
  if (!existsSync(path)) {
    throw new BahError('policy-registry-invalid', `registry.json 不存在：${path}`)
  }
  const parsed = parseJson(path, 'policy-registry-invalid')
  const record = recordOf(parsed, 'registry.json', 'policy-registry-invalid')
  if (record['apiVersion'] !== REGISTRY_API) {
    throw new BahError('policy-registry-invalid', `registry.json 的 apiVersion 必须是 ${REGISTRY_API}`)
  }
  const kinds = recordOf(record['kinds'], 'registry.json.kinds', 'policy-registry-invalid')
  for (const [kind, value] of Object.entries(kinds)) {
    const versions = recordOf(
      recordOf(value, `registry.json.kinds.${kind}`, 'policy-registry-invalid')['versions'],
      `registry.json.kinds.${kind}.versions`,
      'policy-registry-invalid',
    )
    for (const [handle, entry] of Object.entries(versions)) {
      recordOf(entry, `registry.json.kinds.${kind}.versions.${handle}`, 'policy-registry-invalid')
    }
  }
  return parsed as RegistryFile
}

/** 读 runtime-state；不存在返回 `undefined`。 */
export function readState(path: string): StateFile | undefined {
  if (!existsSync(path)) return undefined
  const parsed = parseJson(path, 'policy-state-invalid')
  const record = recordOf(parsed, 'runtime-state.json', 'policy-state-invalid')
  if (record['apiVersion'] !== STATE_API) {
    throw new BahError('policy-state-invalid', `runtime-state.json 的 apiVersion 必须是 ${STATE_API}`)
  }
  recordOf(record['assignments'], 'runtime-state.json.assignments', 'policy-state-invalid')
  if (!Array.isArray(record['history'])) {
    throw new BahError('policy-state-invalid', 'runtime-state.json 的 history 必须是数组')
  }
  return parsed as StateFile
}

/** 读一个已安装版本并重新编译校验（摘要不符即拒绝）。 */
export function loadInstalled(
  root: string,
  kind: string,
  handle: string,
): {
  readonly compiled: CompileResult['compiled'] | import('../packages/policy/src/sentry-rules.ts').CompiledRuleSet
  readonly entry: RegistryEntry
  readonly dir: string
} {
  const registry = readRegistry(root)
  const entry = registry.kinds[kind]?.versions[handle]
  if (entry === undefined) {
    throw new BahError('policy-version-missing', `registry.json 里没有 ${kind} 的版本 ${handle}`)
  }
  const dir = resolveBundleDir(root, entry.path)
  if (!existsSync(dir)) {
    throw new BahError('policy-bundle-missing', `bundle 目录不存在：${dir}`, { handle })
  }
  const result =
    kind === 'sentry.rules'
      ? loadRuleBundle({ dir, toolNames: [], verifyLock: true })
      : loadBundle({ dir, toolNames: toolNames(), verifyLock: true, withCorpus: false })
  if (result.compiled.descriptor.semanticDigest !== entry.semanticDigest) {
    throw new BahError(
      'policy-digest-mismatch',
      `registry 的 semanticDigest 与现场不符（${handle}）`,
      { handle, expected: entry.semanticDigest, actual: result.compiled.descriptor.semanticDigest },
    )
  }
  return { compiled: result.compiled, entry, dir }
}

/** `policy:shadow` 只重放银行三级判决；规则集没有"同一输入两次求值"的影子语义。 */
function asBankPolicy(
  compiled: CompileResult['compiled'] | import('../packages/policy/src/sentry-rules.ts').CompiledRuleSet,
): CompileResult['compiled'] {
  if (!('evaluate' in compiled)) {
    throw new BahError('policy-unavailable', 'policy:shadow 只支持 bank.tier（sentry.rules 用 policy:test 的语料等价）')
  }
  return compiled
}

/** 生成一次 promote 的计划（不写盘）。 */
export function planPromote(input: {
  readonly paths: AdminPaths
  readonly to: string
  readonly percent?: number
  readonly sessions?: readonly string[]
  readonly active?: string
  readonly operator?: string
  readonly reason: string
  readonly now: number
  readonly kind?: string
}): ChangePlan {
  assertReason(input.reason)
  const kind = input.kind ?? TIER_KIND
  const percent = input.percent ?? PERCENT_BASE
  assertPercent(percent)
  const sessions = [...(input.sessions ?? [])]
  if (percent === PERCENT_BASE && sessions.length > 0) {
    throw new BahError('policy-invalid-config', '全量切换（percent=10000）不能同时给 --sessions')
  }

  const state = readState(input.paths.statePath)
  const assignment = state?.assignments[kind]
  const currentActive = assignment?.active ?? input.active
  if (currentActive === undefined) {
    throw new BahError(
      'policy-state-missing',
      '首次 promote 必须显式给 --active <handle>（CLI 不猜当前版本）',
    )
  }
  loadInstalled(input.paths.root, kind, currentActive)
  loadInstalled(input.paths.root, kind, input.to)

  const unchanged =
    assignment !== undefined &&
    assignment.active === input.to &&
    assignment.canary === undefined &&
    percent === PERCENT_BASE
  if (unchanged) {
    return {
      state: state as StateFile,
      record: emptyRecord(input, kind, currentActive),
      changed: false,
      summary: `${kind} 已经是 ${input.to}（无变化，不写链/不改 state）`,
    }
  }

  const previousCanary = assignment?.canary
  const epoch = nextEpoch(previousCanary?.epoch, state?.history ?? [])
  const nextAssignment: Assignment =
    percent === PERCENT_BASE
      ? { active: input.to }
      : {
          active: currentActive,
          canary: {
            version: input.to,
            percent,
            ...(sessions.length === 0 ? {} : { sessions }),
            epoch,
          },
        }
  const record: RolloutRecord = {
    at: input.now,
    kind,
    action: 'promote',
    from: currentActive,
    to: input.to,
    percent,
    epoch,
    operator: input.operator ?? osUser(),
    reason: input.reason,
  }
  const nextState = withAssignment(state, input.paths, kind, nextAssignment, record)
  return {
    state: nextState,
    record,
    changed: true,
    summary:
      percent === PERCENT_BASE
        ? `${kind}: ${currentActive} → ${input.to}（全量，epoch=${String(epoch)}）`
        : `${kind}: ${currentActive} 保持 active；canary ${input.to} @ ${String(percent / 100)}%（epoch=${String(epoch)}）`,
  }
}

/** 生成一次 rollback 的计划（不写盘）。 */
export function planRollback(input: {
  readonly paths: AdminPaths
  readonly to?: string
  readonly operator?: string
  readonly reason: string
  readonly now: number
  readonly kind?: string
}): ChangePlan {
  assertReason(input.reason)
  const kind = input.kind ?? TIER_KIND
  const state = readState(input.paths.statePath)
  if (state === undefined) {
    throw new BahError('policy-state-missing', '没有 runtime-state.json：先 promote 再 rollback')
  }
  const assignment = state.assignments[kind]
  if (assignment === undefined) {
    throw new BahError('policy-state-missing', `runtime-state 里没有 ${kind} 的分配`)
  }
  const history = state.history.filter((entry) => entry.kind === kind)
  const previousActive = [...history].reverse().find((entry) => entry.from !== assignment.active)?.from
  // 只有 canary、没有切换过 active 时，"回滚"= 清空 canary（目标就是当前 active）
  const fallback = previousActive ?? (assignment.canary === undefined ? undefined : assignment.active)
  const target = input.to ?? fallback
  if (target === undefined) {
    throw new BahError('policy-rollback-unavailable', '没有可回滚的历史 active（必须显式给 --to）')
  }
  loadInstalled(input.paths.root, kind, target)
  if (target === assignment.active && assignment.canary === undefined) {
    return {
      state,
      record: emptyRecord(input, kind, target),
      changed: false,
      summary: `${kind} 已经是 ${target}（无变化）`,
    }
  }
  const epoch = nextEpoch(assignment.canary?.epoch, state.history)
  const record: RolloutRecord = {
    at: input.now,
    kind,
    action: 'rollback',
    // 只清 canary 时，`from` 写候选版本：审计要看到"从哪份内容退回"
    from: assignment.canary?.version ?? assignment.active,
    to: target,
    percent: PERCENT_BASE,
    epoch,
    operator: input.operator ?? osUser(),
    reason: input.reason,
  }
  const nextState = withAssignment(state, input.paths, kind, { active: target }, record)
  return {
    state: nextState,
    record,
    changed: true,
    summary: `${kind}: 回滚 ${assignment.active} → ${target}（清空 canary，epoch=${String(epoch)}）`,
  }
}

/**
 * 应用一次变更：**先 append+fsync 变更链，再原子写 state**。
 *
 * 链写失败 → 直接抛，state 不变；state 写失败 → 链上会留下一条"意图"记录，
 * 这是有意的：宁可让审计看到一次失败尝试，也不让状态与证据都不留痕。
 */
export function applyChange(paths: AdminPaths, plan: ChangePlan): void {
  if (!plan.changed) return
  const audit = createSagaAudit({ now: () => plan.record.at, rootDir: paths.root, fsync: true })
  audit.append(ROLLOUT_CHAIN, 'policy/rollout-changed', plan.record)
  writeStateAtomic(paths.statePath, plan.state)
}

/** 读变更链连续性。 */
export function verifyRollout(root: string): {
  readonly ok: boolean
  readonly rows: number
  readonly brokenAt?: number
} {
  const audit = createSagaAudit({ now: () => 0, rootDir: root, fsync: false })
  const rows = audit.verifyContinuity(ROLLOUT_CHAIN)
  return {
    ok: rows.ok,
    rows: countRolloutRows(root),
    ...(rows.brokenAt === undefined ? {} : { brokenAt: rows.brokenAt }),
  }
}

/** 安装一个 bundle 目录（复制 + registry 更新；已存在同摘要 = no-op，异摘要 = 拒绝）。 */
export function installBundle(input: {
  readonly paths: AdminPaths
  readonly sourceDir: string
  readonly now: number
  readonly demo?: boolean
}): { readonly handle: string; readonly changed: boolean; readonly digest: string } {
  const sourceDir = resolve(input.sourceDir)
  const result =
    peekBundleKind(sourceDir) === 'sentry.rules'
      ? loadRuleBundle({ dir: sourceDir, toolNames: [], verifyLock: true })
      : loadBundle({ dir: sourceDir, toolNames: toolNames(), verifyLock: true })
  const descriptor = result.compiled.descriptor
  const handle = descriptor.handle
  const target = join(input.paths.root, ...handle.split('/'))
  const registry = existsSync(join(input.paths.root, 'registry.json'))
    ? readRegistry(input.paths.root)
    : { apiVersion: REGISTRY_API, kinds: {} } satisfies RegistryFile
  const existing = registry.kinds[descriptor.kind]?.versions[handle]
  if (existing !== undefined) {
    if (existing.semanticDigest === descriptor.semanticDigest) {
      return { handle, changed: false, digest: descriptor.semanticDigest }
    }
    throw new BahError(
      'policy-digest-mismatch',
      `${handle} 已安装且摘要不同：拒绝覆盖（新建版本号再安装）`,
      { handle, expected: existing.semanticDigest, actual: descriptor.semanticDigest },
    )
  }
  if (existsSync(target)) {
    throw new BahError('policy-bundle-exists', `目标目录已存在但不在 registry：${target}`)
  }
  copyTree(resolve(input.sourceDir), target)
  const entry: RegistryEntry = {
    path: registryPathOf(target),
    semanticDigest: descriptor.semanticDigest,
    sourceDigest: descriptor.sourceDigest,
    engine: descriptor.engineVersion,
    installedAt: input.now,
    ...(input.demo === true ? { demo: true } : {}),
  }
  const next: RegistryFile = {
    apiVersion: REGISTRY_API,
    kinds: {
      ...registry.kinds,
      [descriptor.kind]: {
        versions: {
          ...(registry.kinds[descriptor.kind]?.versions ?? {}),
          [handle]: entry,
        },
      },
    },
  }
  writeJsonAtomic(join(input.paths.root, 'registry.json'), next)
  return { handle, changed: true, digest: descriptor.semanticDigest }
}

/** 列出 registry + state 的合并视图（CLI 输出用）。 */
export function versionsOf(paths: AdminPaths): {
  readonly kind: string
  readonly handle: string
  readonly semanticDigest: string
  readonly demo: boolean
  readonly active: boolean
  readonly canary: boolean
}[] {
  const registry = readRegistry(paths.root)
  const state = readState(paths.statePath)
  const rows: {
    kind: string
    handle: string
    semanticDigest: string
    demo: boolean
    active: boolean
    canary: boolean
  }[] = []
  for (const [kind, group] of Object.entries(registry.kinds)) {
    const assignment = state?.assignments[kind]
    for (const [handle, entry] of Object.entries(group.versions)) {
      rows.push({
        kind,
        handle,
        semanticDigest: entry.semanticDigest,
        demo: entry.demo === true,
        active: assignment?.active === handle,
        canary: assignment?.canary?.version === handle,
      })
    }
  }
  return rows.sort((left, right) => `${left.kind}/${left.handle}`.localeCompare(`${right.kind}/${right.handle}`))
}

/** 触发一次重载：只改 `updatedAt`（watcher 轮询 state 文件）。 */
export function touchState(paths: AdminPaths, now: number): StateFile {
  const state = readState(paths.statePath)
  if (state === undefined) {
    throw new BahError('policy-state-missing', '没有 runtime-state.json：先 promote 再 reload')
  }
  const next: StateFile = { ...state, updatedAt: now }
  writeStateAtomic(paths.statePath, next)
  return next
}

/** 读会话链（`<root>/<session>/session.jsonl`）里可解释的 `tier/decided`。 */
export function readSessionEvents(
  sessionsDir: string,
  sessionId: string,
): readonly Record<string, unknown>[] {
  const path = join(sessionsDir, sessionId, 'session.jsonl')
  if (!existsSync(path)) {
    throw new BahError('session-missing', `会话日志不存在：${path}`)
  }
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.includes('bah-session-header'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 列出 `sessionsDir` 下的会话 ID（只认有 session.jsonl 的一层目录）。 */
export function listSessions(sessionsDir: string): readonly string[] {
  if (!existsSync(sessionsDir)) return []
  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(sessionsDir, entry.name, 'session.jsonl')))
    .map((entry) => entry.name)
    .sort()
}

/** 读 chain 文件行数（没有链返回 0）。 */
function countRolloutRows(root: string): number {
  const path = join(root, ROLLOUT_CHAIN, 'audit.jsonl')
  if (!existsSync(path)) return 0
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length
}

/** 校验 registry 摘要（供 explain/shadow 复用）。 */
export function resolveBundleDir(root: string, path: string): string {
  const direct = resolve(path)
  if (existsSync(direct)) return direct
  const underRoot = resolve(root, path)
  if (existsSync(underRoot)) return underRoot
  return direct
}

/** 写一个 JSON 文件（原子替换；Windows 上 rename 失败时兜底）。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${String(process.pid)}`
  const fd = openSync(temporary, 'w')
  try {
    writeSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
  } catch {
    rmSync(path, { force: true })
    renameSync(temporary, path)
  }
}

/** 写 state（与 `writeJsonAtomic` 相同；单独命名让调用点一眼看出"这是状态"）。 */
export function writeStateAtomic(path: string, state: StateFile): void {
  writeJsonAtomic(path, state)
}

/** 递归复制（不用 `fs.cpSync`：Node 22.17 中文路径下会静默杀进程）。 */
export function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else copyFileSync(from, to)
  }
}

/** `canonicalJson` 的再导出（CLI/测试的摘要口径与 runtime 一致）。 */
export { canonicalJson }

/**
 * registry 里的 `path`：仓库内用 posix 相对路径（跨平台），仓库外用绝对路径。
 * 与 host `compileAt` 的 `resolve(entry.path)` 兼容。
 */
export function registryPathOf(target: string): string {
  const rel = relative(projectRoot(), target)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return target
  return rel.split(sep).join('/')
}

function withAssignment(
  state: StateFile | undefined,
  paths: AdminPaths,
  kind: string,
  assignment: Assignment,
  record: RolloutRecord,
): StateFile {
  const history = [...(state?.history ?? []), record].slice(-50)
  return {
    apiVersion: STATE_API,
    updatedAt: record.at,
    operator: record.operator,
    reason: record.reason,
    assignments: { ...(state?.assignments ?? {}), [kind]: assignment },
    history,
  }
}

function nextEpoch(current: number | undefined, history: readonly HistoryEntry[]): number {
  const fromHistory = history.reduce((max, entry) => Math.max(max, entry.epoch), 0)
  return Math.max(current ?? 0, fromHistory) + 1
}

function emptyRecord(
  input: { readonly reason: string; readonly now: number; readonly operator?: string },
  kind: string,
  current: string,
): RolloutRecord {
  return {
    at: input.now,
    kind,
    action: 'promote',
    from: current,
    to: current,
    percent: PERCENT_BASE,
    epoch: 0,
    operator: input.operator ?? osUser(),
    reason: input.reason,
  }
}

function assertReason(reason: string): void {
  if (reason.trim().length < 8) {
    throw new BahError('policy-invalid-config', '--reason 至少 8 个字符（变更必须可追责）')
  }
}

function assertPercent(percent: number): void {
  if (!Number.isInteger(percent) || percent < 0 || percent > PERCENT_BASE) {
    throw new BahError(
      'policy-invalid-config',
      `--percent 必须是 [0, ${String(PERCENT_BASE)}] 内的整数（万分比）`,
    )
  }
}

function parseJson(path: string, code: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    throw new BahError(code, `${path} 不是合法 JSON：${String(error)}`)
  }
}

function recordOf(
  value: unknown,
  where: string,
  code: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BahError(code, `${where} 必须是对象`)
  }
  return value as Readonly<Record<string, unknown>>
}

function osUser(): string {
  try {
    return userInfo().username
  } catch {
    return 'unknown'
  }
}

/** 供测试/CLI 复用的常量。 */
export { PERCENT_BASE }

/** 影子重放的一条差异。 */
export interface ShadowDiff {
  readonly session: string
  readonly callId: string
  readonly fields: readonly string[]
  readonly from: {
    readonly level: string
    readonly reason: string
    readonly deny?: string
    readonly ruleIds: readonly string[]
  }
  readonly to: {
    readonly level: string
    readonly reason: string
    readonly deny?: string
    readonly ruleIds: readonly string[]
  }
}

/** 影子重放报告。 */
export interface ShadowReport {
  readonly from: string
  readonly to: string
  readonly total: number
  readonly changed: number
  readonly skipped: number
  readonly diffs: readonly ShadowDiff[]
}

/** 用真实判决证据比较两个版本（只读；不改 state/不写链）。 */
export function compareShadow(input: {
  readonly paths: AdminPaths
  readonly from: string
  readonly to: string
  readonly sessionsDir: string
}): ShadowReport {
  const current = asBankPolicy(loadInstalled(input.paths.root, TIER_KIND, input.from).compiled)
  const candidate = asBankPolicy(loadInstalled(input.paths.root, TIER_KIND, input.to).compiled)
  if (current.descriptor.semanticDigest === candidate.descriptor.semanticDigest) {
    throw new BahError('policy-invalid-config', '--from 与 --to 指向同一份内容（影子无意义）')
  }
  const diffs: ShadowDiff[] = []
  let total = 0
  let skipped = 0
  for (const session of listSessions(input.sessionsDir)) {
    for (const event of readSessionEvents(input.sessionsDir, session)) {
      if (event['type'] !== 'tier/decided') continue
      const data = event['data'] as {
        readonly callId?: string
        readonly evidence?: { readonly input: unknown }
      }
      if (data.evidence === undefined) {
        skipped += 1
        continue
      }
      total += 1
      const fromResult = current.evaluate(current.validateInput(data.evidence.input))
      const toResult = candidate.evaluate(candidate.validateInput(data.evidence.input))
      const fields: string[] = []
      if (fromResult.level !== toResult.level) fields.push('level')
      if (fromResult.reason !== toResult.reason) fields.push('reason')
      if ((fromResult.deny?.code ?? '') !== (toResult.deny?.code ?? '')) fields.push('deny')
      if (fromResult.ruleIds.join(',') !== toResult.ruleIds.join(',')) fields.push('ruleIds')
      if (fields.length === 0) continue
      diffs.push({
        session,
        callId: data.callId ?? '-',
        fields,
        from: {
          level: fromResult.level,
          reason: fromResult.reason,
          ...(fromResult.deny === undefined ? {} : { deny: fromResult.deny.code }),
          ruleIds: fromResult.ruleIds,
        },
        to: {
          level: toResult.level,
          reason: toResult.reason,
          ...(toResult.deny === undefined ? {} : { deny: toResult.deny.code }),
          ruleIds: toResult.ruleIds,
        },
      })
    }
  }
  return { from: input.from, to: input.to, total, changed: diffs.length, skipped, diffs }
}
