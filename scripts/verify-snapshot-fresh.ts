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

/** 治理平面：改动这些文件等于改动模型/资金可见行为。 */
const SENSITIVE = [
  /^packages\/runtime\/src\//,
  /^packages\/llm\/src\//,
  /^packages\/bank\/src\//,
  /^packages\/saga\/src\//,
  /^packages\/persistence\/src\//,
  /^packages\/safety\/src\//,
  /^packages\/host\/src\/boot\//,
]

/** 测试文件不算“行为改动”。 */
const TEST_FILE = /\.test\.ts$/

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
      (file) => !TEST_FILE.test(file) && SENSITIVE.some((pattern) => pattern.test(file)),
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
            path === `snapshots/${entry.name}/llm.jsonl`,
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

/** 目录前缀或单文件精确匹配。 */
function covers(scope: string, file: string): boolean {
  const normalized = scope.replace(/\\/g, '/')
  if (normalized.endsWith('/')) return file.startsWith(normalized)
  return file === normalized || file.startsWith(`${normalized}/`)
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
