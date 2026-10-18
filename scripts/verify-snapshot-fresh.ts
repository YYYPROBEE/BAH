/**
 * 门禁：改了治理平面的源码，就必须带快照改动（阶段 8 R69）。
 *
 * 依据：施工单 12 §3–§4 的"快照是验收证据"，以及 AGENTS.md 纪律 3
 * （改主循环 = 破坏性变更：同步更新架构文档 + 全量快照）。
 *
 * 判定面：`packages/runtime/src/**` 与 `packages/llm/src/**`——这两处决定"模型看到什么"
 * 与"事件怎么落账"，改了它们却不重录快照，回放就不再代表当前代码。
 *
 * 判定基线（两选一）：
 * - `BAH_SNAPSHOT_BASE=<ref>`：比对 `<ref>` 与工作树（CI / 评审用）；
 * - 缺省：比对 `HEAD` 与工作树（提交前本地用）。工作树干净时会明确打印"无可检查改动"，
 *   **不是**静默通过。
 *
 * 逃生口（纯重构 / 注释 / 测试专用改动）：
 * - `BAH_ALLOW_NO_SNAPSHOT=1`（提交前，最可靠）；
 * - 或提交信息里带 `[no-snapshot]`（已提交的场景；基线为 `<ref>` 时扫 `<ref>..HEAD`）。
 */

import { spawnSync } from 'node:child_process'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

/** 治理平面：改动这些文件等于改动模型可见行为。 */
const SENSITIVE = [/^packages\/runtime\/src\//, /^packages\/llm\/src\//]

/** 快照目录（任一改动都算"带了快照"）。 */
const SNAPSHOT_DIR = /^snapshots\//

/** 测试文件不算"行为改动"：它们不进产物，改了不必重录快照。 */
const TEST_FILE = /\.test\.ts$/

/** 逃生口标记。 */
const SKIP_TAG = '[no-snapshot]'

const gate: Gate = {
  name: 'snapshot-fresh',

  async run(root) {
    const base = process.env['BAH_SNAPSHOT_BASE']
    const allowSkip = process.env['BAH_ALLOW_NO_SNAPSHOT'] === '1'

    const changed = changedFiles(root, base)
    if (!changed.ok) {
      return { ok: false, findings: [changed.reason], notes: [] }
    }

    const notes = [`基线：${changed.source}；改动 ${changed.files.length} 个文件`]
    if (changed.files.length === 0) {
      notes.push('工作树干净且未设 BAH_SNAPSHOT_BASE —— 本次无可检查的改动')
      return { ok: true, findings: [], notes }
    }

    const sensitive = changed.files.filter(
      (file) => !TEST_FILE.test(file) && SENSITIVE.some((pattern) => pattern.test(file)),
    )
    if (sensitive.length === 0) {
      notes.push('未触及治理平面（packages/{runtime,llm}/src），无需快照')
      return { ok: true, findings: [], notes }
    }

    const touchedSnapshots = changed.files.some((file) => SNAPSHOT_DIR.test(file))
    if (touchedSnapshots) {
      notes.push('已带 snapshots/ 改动')
      return { ok: true, findings: [], notes }
    }

    if (allowSkip) {
      notes.push('BAH_ALLOW_NO_SNAPSHOT=1 —— 按纯重构放行（请确认没有行为变化）')
      return { ok: true, findings: [], notes }
    }

    if (commitTagged(root, base)) {
      notes.push(`提交信息含 ${SKIP_TAG} —— 按纯重构放行`)
      return { ok: true, findings: [], notes }
    }

    return {
      ok: false,
      findings: [
        ...sensitive.map((file) => `${file}: 改了治理平面却没改 snapshots/（需重录或标注 ${SKIP_TAG}）`),
        '修复：`pnpm snapshot:record` 重录快照；纯重构则设 BAH_ALLOW_NO_SNAPSHOT=1 或在提交信息里写 ' +
          SKIP_TAG,
      ],
      notes,
    }
  },
}

/** 执行一条 git 命令并返回非空 stdout 行；失败时给可读原因。 */
function gitLines(root: string, args: readonly string[]): { ok: true; lines: string[] } | { ok: false; reason: string } {
  const result = spawnSync('git', [...args], { cwd: root, encoding: 'utf8' })
  if (result.error !== undefined) {
    return { ok: false, reason: `snapshot-fresh: 无法执行 git —— ${result.error.message}` }
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().split('\n')[0] ?? '未知错误'
    return { ok: false, reason: `snapshot-fresh: git ${args.join(' ')} 失败 —— ${stderr}` }
  }
  return { ok: true, lines: (result.stdout ?? '').split('\n').filter((line) => line.length > 0) }
}

/** 相对判定基线的改动文件清单。 */
function changedFiles(
  root: string,
  base: string | undefined,
): { ok: true; files: string[]; source: string } | { ok: false; reason: string } {
  const target = base === undefined ? 'HEAD' : base
  const diff = gitLines(root, ['diff', '--name-only', target])
  if (!diff.ok) return diff
  if (base === undefined) {
    // 提交前：工作树（含暂存区）相对 HEAD；未跟踪文件不算"改动源码"（新文件另有审查）
    return { ok: true, files: diff.lines, source: 'HEAD（工作树）' }
  }
  return { ok: true, files: diff.lines, source: `${base}（工作树）` }
}

/** 提交信息里是否带逃生标记（基线给定时扫 `<base>..HEAD`，否则只看 HEAD）。 */
function commitTagged(root: string, base: string | undefined): boolean {
  const range = base === undefined ? ['-1', '--format=%B'] : [`${base}..HEAD`, '--format=%B']
  const log = gitLines(root, ['log', ...range])
  return log.ok && log.lines.some((line) => line.includes(SKIP_TAG))
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
