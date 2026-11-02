/**
 * 快照 fixture 的命名解析与代次选择。
 *
 * 命名规则：`session[.序号][.vN].jsonl`
 * - 缺省序号 = **parent**（会话主线）；带序号 = **child**（子会话 / 分支，如 `session.1.jsonl`）
 * - `vN` 是格式代次，缺省视为 `v0`
 * - 同一组内取**最高代**；同组同代出现多个文件 = fixture 冲突（fail-loud，不许随手挑一个）
 *
 * 为什么先做这块：它是纯文件逻辑、不依赖会话日志，所以能在阶段 3 之前落地并被测试；
 * record / replay harness 本身见第 4 步（阶段 7）。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { BahError } from '@bah/util'

/** 一个符合命名规则的 fixture 文件的解析结果。 */
export interface SnapshotName {
  /** 文件名（不含目录）。 */
  readonly file: string
  /** 会话序号：`undefined` = parent（主线），数字 = child 分支。 */
  readonly seq?: number
  /** 格式代次（`vN`，缺省 0）。 */
  readonly version: number
}

/** `session` + 可选序号 + 可选代次 + `.jsonl`；其余文件一律忽略。 */
const NAME_PATTERN = /^session(?:\.(\d+))?(?:\.v(\d+))?\.jsonl$/

/**
 * 解析 fixture 文件名。
 *
 * @returns 不符合命名规则时返回 `undefined`（目录里的其他文件不算 fixture）
 */
export function parseSnapshotName(file: string): SnapshotName | undefined {
  const matched = NAME_PATTERN.exec(file)
  if (!matched) return undefined
  return {
    file,
    seq: matched[1] === undefined ? undefined : Number(matched[1]),
    version: matched[2] === undefined ? 0 : Number(matched[2]),
  }
}

/** 选择结果：选中的 fixture + 绝对/相对路径（由调用方传入的目录决定）。 */
export interface SnapshotFixture extends SnapshotName {
  /** 选中文件的完整路径。 */
  readonly path: string
}

/** 选组：`seq` 缺省选 parent 组，数字选该序号的 child 组。 */
export interface SnapshotSelectOptions {
  readonly seq?: number
}

/**
 * 在目录里选出某组 fixture 的最高代。
 *
 * @param dir fixture 目录
 * @param options.seq 选择哪一组（缺省 = parent 组）
 * @throws `BahError('snapshot-missing')` 该组一个文件都没有
 * @throws `BahError('snapshot-conflict')` 该组最高代重复（fixture 冲突必须人工处理）
 */
export function selectSnapshot(dir: string, options: SnapshotSelectOptions = {}): SnapshotFixture {
  const seq = options.seq
  const group = readdirSync(dir)
    .map((file) => parseSnapshotName(file))
    .filter((entry): entry is SnapshotName => entry !== undefined && entry.seq === seq)

  if (group.length === 0) {
    throw new BahError('snapshot-missing', `test-support: 没有 ${groupLabel(seq)} 快照：${dir}`, {
      dir,
      seq,
    })
  }

  const highest = Math.max(...group.map((entry) => entry.version))
  const winners = group.filter((entry) => entry.version === highest)
  if (winners.length > 1) {
    throw new BahError(
      'snapshot-conflict',
      `test-support: ${groupLabel(seq)} 的第 v${highest} 代有 ${winners.length} 个文件：${winners
        .map((entry) => entry.file)
        .join(', ')}`,
      { dir, seq, version: highest, files: winners.map((entry) => entry.file) },
    )
  }

  const winner = winners[0]!
  return { ...winner, path: join(dir, winner.file) }
}

/** 组标签（错误信息用）。 */
function groupLabel(seq: number | undefined): string {
  return seq === undefined ? 'parent' : `child#${seq}`
}
