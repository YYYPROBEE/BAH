/**
 * 门禁：改了治理平面的源码，就必须由**对应的场景**重录快照
 * （BAH 代码修改清单 2026-10-20 · B1.2）。
 *
 * 旧实现有五个洞：
 * 1. 干净树直接返回 ok；
 * 2. `git diff` 不含未跟踪文件；
 * 3. 只看 runtime/llm，改 bank/saga/persistence 不需要快照；
 * 4. 任一 snapshot 文件变化都算“带了快照”（与改动无关也算）；
 * 5. 提交信息写 `[no-snapshot]` 即放行，CI 永远绿。
 *
 * 新判定：
 * - 基线：`BAH_SNAPSHOT_BASE` → `origin/main` 的 merge-base → 本地 HEAD；
 *   CI 环境没有显式基线时直接失败，不允许“干净检出即绿”；
 * - 改动面含未跟踪文件（`git status --porcelain -z`）；
 * - 敏感面：runtime/llm/bank/saga/persistence/safety 的 `src/` + host 的 `boot/`；
 * - 场景归属：`snapshots/<case>/scenario.json` 的 `coveredSources` 必须覆盖敏感文件，
 *   且该 case 目录下**至少一个文件**本次有改动；
 * - 逃生口：`BAH_ALLOW_NO_SNAPSHOT=1` 只在非 CI 环境有效。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'
import { covers, digestOfScopes } from './snapshot-digest.ts'

/** 治理平面：改动这些文件等于改动模型/资金可见行为。 */
const SENSITIVE = [
  /^packages\/runtime\/src\//,
  /^packages\/llm\/src\//,
  /^packages\/bank\/src\//,
  // 策略编译器/求值器：判决语义的唯一执行形态；改了它必须由快照背书。
  /^packages\/policy\/src\//,
  /^packages\/saga\/src\//,
  /^packages\/persistence\/src\//,
  /^packages\/safety\/src\//,
  /^packages\/host\/src\/boot\//,
]

/** 测试文件不算“行为改动”。 */
const TEST_FILE = /\.test\.ts$/

/**
 * 在治理平面里、但**没有任何快照场景能观测**的例外。
 *
 * 与 `SENSITIVE` 的区别是语义，不是目录：这些文件在治理平面内，但它们的行为
 * **不出现在 `session.jsonl` / `llm.jsonl` 里**，于是"重录一个场景"证明不了任何事——
 * 把它们挂到某个场景的 `coveredSources` 上才是真正的假仪式（声称覆盖，对话根本没跑到）。
 *
 * 三类，各自的判据不同：
 * - `barrel`：纯再导出。**结构性校验**（`isPureBarrel`）：一旦往里写逻辑，门禁立刻红，
 *   豁免自动失效——不靠人记着；
 * - `offline`：离线读取器。只被 CLI 子命令与脚本调用，不进主循环（先例 `chain/audit-report.ts`）；
 * - `unreachable`：在治理平面内，但当前装配下没有确定性路径能触发它。
 *
 * 后两类必须给 `backing`：**存在的**测试文件，且文件里至少有一条 `expect(`。
 * 豁免可以存在，但必须有人真的为它写断言；删测试或清空断言会让门禁红，而不是静默降级。
 *
 * 名单必须一条一条写清理由，不按目录通配：`persistence/src/chain/` 里还有**写链**的代码，
 * `packages/saga/src/` 里还有正向编排，那些都是真行为面。
 */
interface Exemption {
  /** 精确路径（不按目录通配：同目录里往往还有真行为面）。 */
  readonly file: string
  readonly kind: 'barrel' | 'offline' | 'unreachable'
  readonly reason: string
  /** 背书面（测试文件相对路径）；`barrel` 不需要——它的判据是结构，不是断言。 */
  readonly backing?: string
}

const EXEMPT: readonly Exemption[] = [
  {
    file: 'packages/persistence/src/chain/audit-report.ts',
    kind: 'offline',
    reason:
      '只被 `bah audit` 与脚本调用：读已落盘的链做只读审计，不参与模型可见内容、不影响资金动作',
    backing: 'packages/persistence/src/chain/audit-report.test.ts',
  },
  {
    file: 'packages/persistence/src/replay/index.ts',
    kind: 'offline',
    reason:
      '离线重放读取器：入口只有 `scripts/replay.ts` 与 `bah audit --replay`，会话主循环不引用它',
    backing: 'packages/eval/tests/replay/replay.test.ts',
  },
  {
    file: 'packages/persistence/src/index.ts',
    kind: 'barrel',
    reason: '纯再导出（`export * from`），自身零逻辑',
  },
  {
    file: 'packages/safety/src/index.ts',
    kind: 'barrel',
    reason: '纯再导出（`export * from`），自身零逻辑',
  },
  {
    file: 'packages/saga/src/compensation/index.ts',
    kind: 'unreachable',
    reason:
      '补偿调度只在"saga 步骤在 preflight 之后失败"时进入；当前唯一配方（transfer_create = ' +
      'preview + create）的失败一律先被 `safety:sentry` 在 `tools/pre-execute` 拦下（实测：' +
      '超限金额那笔 `transfer_create` 根本没到 `tools/execute`，saga 事务不会创建），' +
      '所以任何快照场景都到不了这段代码',
    backing: 'packages/saga/src/compensation/compensation.test.ts',
  },
  {
    file: 'packages/llm/src/deepseek/adapter.ts',
    kind: 'unreachable',
    reason:
      '快照场景一律装配 mock provider（确定性、零外呼）；deepseek 适配器的行为只能在真实网络下观察，' +
      '录制阶段没有确定性路径能触发它。把 deepseek/ 挂进 coveredSources 属于假覆盖——会话根本没走到这里。' +
      '背书面是 adapter.test.ts 的 21 条断言（429/5xx 退避、超时两相位、取消、计价、SSE 边界）',
    backing: 'packages/llm/src/deepseek/adapter.test.ts',
  },
  {
    file: 'packages/llm/src/deepseek/wire.ts',
    kind: 'unreachable',
    reason:
      '同上：SSE/wire 编解码只被 deepseek 适配器在真实外呼里调用，快照装配走 mock provider 不经过它；' +
      '背书面是 wire.test.ts 的逐分片映射断言（含缓存命中字段缺省语义）',
    backing: 'packages/llm/src/deepseek/wire.test.ts',
  },
  {
    file: 'packages/persistence/src/credentials/index.ts',
    kind: 'unreachable',
    reason:
      '租户与鉴权 02 TA-27 只给 `bindSession` 增加可选第三参 `method`（默认 mock-login，向后兼容）；' +
      '快照场景一律用 `bank:tools.demoUserId` 在启动期直绑身份，任何场景都不调用 `bindSession`。' +
      '背书面是 bank-tools.test.ts：T-IDN-002（mock-login）与 TA-27-6（session-auth 载荷）',
    backing: 'packages/host/src/boot/plugins/bank-tools.test.ts',
  },
]

interface SnapshotCase {
  readonly name: string
  readonly coveredSources: readonly string[]
}

const gate: Gate = {
  name: 'snapshot-fresh',

  async run(root) {
    const allowSkip = process.env['BAH_ALLOW_NO_SNAPSHOT'] === '1'
    const isCi = isCiEnvironment()

    const baseline = resolveBaseline(root, isCi)
    if (!baseline.ok) return { ok: false, findings: [baseline.reason], notes: [] }

    const changed = changedFiles(root, baseline.base)
    if (!changed.ok) return { ok: false, findings: [changed.reason], notes: [] }

    const notes = [`基线：${baseline.source}；改动 ${changed.files.length} 个文件（含未跟踪）`]

    // 豁免名单自己也要被审：barrel 必须仍是 barrel，其余必须真有测试兜着。
    // 放在最前面是有意的——名单坏了比快照过期更严重（它会让后面所有判定都失去意义）。
    const audit = auditExemptions(root)
    if (audit.findings.length > 0) return { ok: false, findings: audit.findings, notes }
    for (const line of audit.notes) notes.push(line)

    if (changed.files.length === 0) {
      if (allowSkip && !isCi) {
        notes.push('工作树干净；BAH_ALLOW_NO_SNAPSHOT=1 显式放行（仅本地）')
        return { ok: true, findings: [], notes }
      }
      return {
        ok: false,
        findings: [
          '工作树相对基线没有改动，无法证明快照与当前代码一致；' +
            '请设 BAH_SNAPSHOT_BASE=<ref>，或本地设 BAH_ALLOW_NO_SNAPSHOT=1 显式放行',
        ],
        notes,
      }
    }

    const sensitive = changed.files.filter(
      (file) =>
        !TEST_FILE.test(file) &&
        SENSITIVE.some((pattern) => pattern.test(file)) &&
        !EXEMPT.some((entry) => entry.file === file),
    )
    if (sensitive.length === 0) {
      notes.push('未触及治理平面，无需快照')
      return { ok: true, findings: [], notes }
    }

    // 纯形态改动豁免：去掉纯注释行后代码序列完全一致，说明没有行为变化。
    //
    // 为什么必须有这一条：快照是确定性录制的（scenario.json 固定 clock.start 与 randomSeed），
    // 改动若只涉及注释，重录会产出逐字节相同的内容、git 里没有 diff，
    // 于是下面「快照是否出现在改动集」的判定永远不成立 —— 门禁变成只会红、不会绿的死锁。
    const behavioral: string[] = []
    const formattingOnly: string[] = []
    for (const file of sensitive) {
      if (isCommentOnlyChange(root, baseline.base, file)) formattingOnly.push(file)
      else behavioral.push(file)
    }
    if (formattingOnly.length > 0) {
      notes.push(`纯注释改动（不要求重录）：${formattingOnly.join(', ')}`)
    }
    if (behavioral.length === 0) {
      notes.push('改动不含行为变化，无需快照')
      return { ok: true, findings: [], notes }
    }

    if (allowSkip) {
      if (isCi) {
        return {
          ok: false,
          findings: ['CI 环境禁止 BAH_ALLOW_NO_SNAPSHOT=1；行为改动必须由快照背书'],
          notes,
        }
      }
      notes.push('BAH_ALLOW_NO_SNAPSHOT=1 —— 按纯重构放行（请确认没有行为变化）')
      return { ok: true, findings: [], notes }
    }

    const cases = loadCases(root)
    if (!cases.ok) return { ok: false, findings: cases.findings, notes }

    const findings: string[] = []
    const usedCases = new Set<string>()

    for (const file of behavioral) {
      const covering = cases.cases.filter((entry) =>
        entry.coveredSources.some((scope) => covers(scope, file)),
      )
      if (covering.length === 0) {
        findings.push(
          `${file}: 没有快照场景在 scenario.json 的 coveredSources 里声明覆盖该路径（补场景或重录对应 case）`,
        )
        continue
      }
      const fresh = covering.filter((entry) =>
        changed.files.some(
          (path) =>
            path === `snapshots/${entry.name}/session.jsonl` ||
            path === `snapshots/${entry.name}/llm.jsonl` ||
            // 等价改动的出海通道：核验记录在改动集里，且摘要与当前源码一致。
            // 摘要一变就失配，因此这条不等于"放行一切"。
            (path === `snapshots/${entry.name}/reverified.json` &&
              reverifyMatches(root, entry.name, entry.coveredSources)),
        ),
      )
      if (fresh.length === 0) {
        findings.push(
          `${file}: 由场景 ${covering.map((entry) => entry.name).join(' / ')} 覆盖，但本次没有重录（快照必须随行为一起改）`,
        )
      }
      for (const entry of fresh) usedCases.add(entry.name)
    }

    for (const name of usedCases) notes.push(`已重录场景：${name}`)

    if (findings.length > 0) {
      findings.push('修复：`pnpm snapshot:record` 重录对应场景；纯重构请在本地设 BAH_ALLOW_NO_SNAPSHOT=1')
      return { ok: false, findings, notes }
    }

    return { ok: true, findings: [], notes }
  },
}

/**
 * 审一遍豁免名单本身。
 *
 * 三条判据，都是**可判红**的：
 * 1. 被豁免的文件必须真的存在（删了/改名了就红，不留死条目）；
 * 2. `barrel` 必须仍只含再导出（往 barrel 里写逻辑 → 红，豁免失效）；
 * 3. `offline` / `unreachable` 必须给出存在且含 `expect(` 的测试文件。
 *
 * 每次跑门禁都会把整份名单打进 notes：它是一份**公开的账**，不是暗门。
 */
function auditExemptions(root: string): { findings: string[]; notes: string[] } {
  const findings: string[] = []
  const notes: string[] = [`豁免名单 ${EXEMPT.length} 条（逐条带理由，见 scripts/verify-snapshot-fresh.ts）：`]

  for (const entry of EXEMPT) {
    const absolute = join(root, entry.file)
    if (!existsSync(absolute)) {
      findings.push(`豁免条目指向不存在的文件：${entry.file}（删掉该条或改对路径）`)
      continue
    }

    if (entry.kind === 'barrel') {
      const source = readText(absolute) ?? ''
      if (!isPureBarrel(source)) {
        findings.push(
          `${entry.file}: 声明为 barrel 豁免，但文件里出现了再导出之外的代码 —— ` +
            '豁免失效，请补 `coveredSources` 与重录',
        )
        continue
      }
      notes.push(`· [barrel] ${entry.file}`)
      continue
    }

    if (entry.backing === undefined) {
      findings.push(`${entry.file}: ${entry.kind} 豁免必须给 backing（背书面测试文件）`)
      continue
    }
    const backingPath = join(root, entry.backing)
    if (!existsSync(backingPath)) {
      findings.push(`${entry.file}: backing 不存在 —— ${entry.backing}`)
      continue
    }
    const backingSource = readText(backingPath) ?? ''
    if (!/expect\s*\(/.test(backingSource)) {
      findings.push(`${entry.file}: backing ${entry.backing} 里没有 expect(，等于没人为它断言`)
      continue
    }
    notes.push(`· [${entry.kind}] ${entry.file} ← ${entry.backing}`)
  }

  return { findings, notes }
}

/**
 * 是否只做再导出。
 *
 * 取向保守：只认 `export …` 开头的语句（含 `export *` / `export type {…} from`），
 * 其余任何一行（含 `const` / `function` / `if` / 裸调用）都判"不是 barrel"——
 * 宁可让 barrel 豁免失效，不可放行一个偷偷带逻辑的入口。
 */
function isPureBarrel(source: string): boolean {
  let inExportBlock = false
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    // `export { … } from` 可以跨行：块内除了收尾的 `}` 之外不要求带 `export`。
    if (inExportBlock) {
      if (line.includes('}')) inExportBlock = false
      continue
    }
    if (!line.startsWith('export ')) return false
    // 只认三种再导出形态：`export *`、`export {…}`、`export type {…}`。
    // `export const/function/class/default` 都算逻辑，一律判"不是 barrel"
    // —— 负例实测：`export const sneak = 1` 必须让这条豁免当场失效。
    const rest = line.slice('export '.length).trim()
    if (!(rest.startsWith('*') || rest.startsWith('{') || rest.startsWith('type {'))) return false
    const open = line.split('{').length - 1
    const close = line.split('}').length - 1
    if (open > close) inExportBlock = true
  }
  return true
}

/**
 * 去掉「纯注释行」后的代码序列。
 *
 * 只按行首标记判断：`//`、`/*`、`*`（块注释续行）与空行。
 * 取向保守——宁可漏判（继续要求重录），不可错判（放行真实改动）。
 * 统一 `trim()` 同时消掉 CRLF 与缩进差异（TS 里缩进不构成行为差异）。
 */
function codeLinesOf(source: string): string[] {
  const result: string[] = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('//')) continue
    if (trimmed.startsWith('/*')) continue
    if (trimmed.startsWith('*')) continue
    result.push(trimmed)
  }
  return result
}

/**
 * 该文件相对基线是否只改了注释（去掉注释行后代码序列逐行相同）。
 *
 * 基线版本取不到（新增文件、git 失败）时一律返回 false：
 * 无法证明等价，就按有行为变化处理。
 */
function isCommentOnlyChange(root: string, base: string, file: string): boolean {
  const before = gitShow(root, base, file)
  if (before === undefined) return false
  const after = readText(join(root, file))
  if (after === undefined) return false

  const a = codeLinesOf(before)
  const b = codeLinesOf(after)
  if (a.length !== b.length) return false
  return a.every((line, index) => line === b[index])
}

/** 取基线版本的文件内容；不存在或失败返回 undefined。 */
function gitShow(root: string, base: string, file: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${base}:${file}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

/** 读文件文本；失败返回 undefined。 */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** CI 环境判定：GitHub Actions / 通用 CI 变量。 */
function isCiEnvironment(): boolean {
  return (
    process.env['CI'] === 'true' ||
    process.env['CI'] === '1' ||
    process.env['GITHUB_ACTIONS'] === 'true'
  )
}

/**
 * 解析比较基线。
 *
 * 顺序：显式环境变量 → origin/main 的 merge-base → 本地 HEAD。
 * CI 里没有前两者时直接失败：干净检出不能靠“没基线”变绿。
 */
function resolveBaseline(
  root: string,
  isCi: boolean,
): { ok: true; base: string; source: string } | { ok: false; reason: string } {
  const explicit = process.env['BAH_SNAPSHOT_BASE']
  if (explicit !== undefined && explicit.trim().length > 0) {
    const verified = gitLines(root, ['rev-parse', '--verify', `${explicit}^{commit}`])
    if (!verified.ok) {
      return { ok: false, reason: `BAH_SNAPSHOT_BASE=${explicit} 不是可解析的提交` }
    }
    return { ok: true, base: explicit, source: `BAH_SNAPSHOT_BASE=${explicit}` }
  }

  const origin = gitLines(root, ['rev-parse', '--verify', 'origin/main'])
  if (origin.ok) {
    const mergeBase = gitLines(root, ['merge-base', 'origin/main', 'HEAD'])
    if (mergeBase.ok && mergeBase.lines.length > 0) {
      return {
        ok: true,
        base: mergeBase.lines[0] ?? 'origin/main',
        source: 'merge-base(origin/main, HEAD)',
      }
    }
    return { ok: true, base: 'origin/main', source: 'origin/main' }
  }

  if (isCi) {
    return {
      ok: false,
      reason:
        'CI 环境没有 BAH_SNAPSHOT_BASE 且找不到 origin/main：无法判断快照是否随行为更新（拒绝默认通过）',
    }
  }

  return { ok: true, base: 'HEAD', source: 'HEAD（本地工作树）' }
}

/** 相对基线的改动文件：已跟踪 diff + 未跟踪文件。 */
function changedFiles(
  root: string,
  base: string,
): { ok: true; files: string[] } | { ok: false; reason: string } {
  const diff = gitLines(root, ['diff', '--name-only', base])
  if (!diff.ok) return { ok: false, reason: `snapshot-fresh: 无法计算相对 ${base} 的 diff` }

  const status = gitStatus(root)
  if (!status.ok) return status

  const files = new Set<string>([...diff.lines, ...status.files])
  return { ok: true, files: [...files].sort() }
}

/** `git status --porcelain=v1 -z`：包含未跟踪与重命名两端。 */
function gitStatus(
  root: string,
): { ok: true; files: string[] } | { ok: false; reason: string } {
  let output: string
  try {
    output = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    return {
      ok: false,
      reason: `snapshot-fresh: git status 失败 —— ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const parts = output.split('\0')
  const files: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? ''
    if (entry.length < 4) continue
    const statusCode = entry.slice(0, 2)
    const path = entry.slice(3)
    files.push(path)
    if (statusCode.startsWith('R') || statusCode.startsWith('C')) {
      const previous = parts[index + 1]
      if (previous !== undefined && previous.length > 0) {
        files.push(previous)
        index += 1
      }
    }
  }
  return { ok: true, files }
}

/** 读取全部快照场景的 coveredSources（读不到就失败，不静默跳过）。 */
function loadCases(
  root: string,
): { ok: true; cases: SnapshotCase[] } | { ok: false; findings: string[] } {
  const dir = join(root, 'snapshots')
  if (!existsSync(dir)) {
    return { ok: false, findings: ['snapshots/ 目录不存在，无法校验快照归属'] }
  }

  const findings: string[] = []
  const cases: SnapshotCase[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const scenario = join(dir, entry.name, 'scenario.json')
    if (!existsSync(scenario)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(scenario, 'utf8'))
    } catch {
      findings.push(`snapshots/${entry.name}/scenario.json: 不是合法 JSON`)
      continue
    }
    if (!isRecord(parsed)) {
      findings.push(`snapshots/${entry.name}/scenario.json: 顶层必须是对象`)
      continue
    }
    const covered = parsed['coveredSources']
    if (covered === undefined) {
      cases.push({ name: entry.name, coveredSources: [] })
      continue
    }
    if (!Array.isArray(covered) || covered.some((item) => typeof item !== 'string')) {
      findings.push(`snapshots/${entry.name}/scenario.json: coveredSources 必须是字符串数组`)
      continue
    }
    cases.push({ name: entry.name, coveredSources: covered as string[] })
  }

  return findings.length === 0 ? { ok: true, cases } : { ok: false, findings }
}

/**
 * 该场景的 `reverified.json` 是否与当前源码一致。
 *
 * 文件缺失、内容损坏、摘要失配——一律视为未核验：宁可要求重录，不可放过漂移。
 * 摘要算法与 `snapshot:reverify` 共用 `snapshot-digest.ts`，两边不会算出两个值。
 */
function reverifyMatches(root: string, name: string, scopes: readonly string[]): boolean {
  const path = join(root, 'snapshots', name, 'reverified.json')
  if (!existsSync(path)) return false
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sourceDigest?: unknown }
    if (typeof parsed.sourceDigest !== 'string') return false
    return parsed.sourceDigest === digestOfScopes(root, scopes)
  } catch {
    return false
  }
}

function gitLines(
  root: string,
  args: readonly string[],
): { ok: true; lines: string[] } | { ok: false; reason: string } {
  try {
    const output = execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return { ok: true, lines: output.split('\n').filter((line) => line.length > 0) }
  } catch {
    return { ok: false, reason: `git ${args.join(' ')} 失败` }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
