/**
 * 证据包（M0 §4.6）与**完整率守卫**（红线 3）。
 *
 * 守卫的位置是刻意的：它必须发生在**打包这一步**，而不是「判定之后打个补丁」。
 * 因为红线 3 的要求是「证据不足 = 不可判定，禁止默认通过」——如果先把判定结果写进
 * 证据包再补一个 undecidable 标记，下游只要读 `verdict.strictPass` 就会看到 true，
 * 补丁形同虚设。所以 `buildEvidencePack` 在打包时**覆写**分量，让证据包里根本
 * 不存在「不完整却通过」的形态。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DEFAULT_RUNS_DIR } from '../recorder/TrajectoryRecorder.ts'
import type {
  ComponentVerdict,
  EvidencePack,
  Snapshot,
  TrajectoryRecord,
  Verdict,
  VerdictComponent,
  VerdictInputs,
} from '../types.ts'
import { COMPONENT_ORDER } from '../types.ts'
import { buildVerdict } from '../verdict.ts'

/** 证据包 schema 版本（升版规则：字段增删即升，禁止就地改语义）。 */
export const EVIDENCE_SCHEMA_VERSION = 'evidence-v0.1'

export interface CompletenessReport {
  readonly complete: boolean
  /** 缺失项的人类可读清单（报告里直接贴）。 */
  readonly missing: readonly string[]
}

export interface CompletenessInput {
  readonly records: readonly TrajectoryRecord[]
  readonly snapshots: readonly Snapshot[]
}

/**
 * 必需事件集合校验：start / end / S₀ 快照 / Send 快照 / 快照对。
 *
 * 「每次工具调用」这一项**无法在这里验证**：记录器只能证明「我记了什么」，
 * 不能证明「agent 还调了没记的」。那一层靠 M0 的接缝订阅（`tools/result` 是唯一
 * 权威结果出口）保证——订阅一旦生效，未记录即等于未发生。这条限制写进汇报，
 * 不假装已覆盖。
 */
export function checkCompleteness(input: CompletenessInput): CompletenessReport {
  const missing: string[] = []

  const hasStart = input.records.some((record) => record.record === 'episode-start')
  const hasEnd = input.records.some((record) => record.record === 'episode-end')
  if (!hasStart) missing.push('trajectory:episode-start')
  if (!hasEnd) missing.push('trajectory:episode-end')

  if (!input.snapshots.some((snapshot) => snapshot.reason === 'episode-start')) {
    missing.push('snapshot:episode-start')
  }
  if (!input.snapshots.some((snapshot) => snapshot.reason === 'episode-end')) {
    missing.push('snapshot:episode-end')
  }

  const beforeCalls = new Set(
    input.snapshots
      .filter((snapshot) => snapshot.reason === 'before-irreversible' && snapshot.callId !== undefined)
      .map((snapshot) => snapshot.callId as string),
  )
  const afterCalls = new Set(
    input.snapshots
      .filter((snapshot) => snapshot.reason === 'after-irreversible' && snapshot.callId !== undefined)
      .map((snapshot) => snapshot.callId as string),
  )
  for (const callId of beforeCalls) {
    if (!afterCalls.has(callId)) missing.push(`snapshot-pair:${callId}:missing-after`)
  }
  for (const callId of afterCalls) {
    if (!beforeCalls.has(callId)) missing.push(`snapshot-pair:${callId}:missing-before`)
  }

  return { complete: missing.length === 0, missing }
}

/** 全分量置为不可判定（红线 3 的唯一合法降级方向：不能往「通过」降）。 */
function undecidableVerdict(verdict: Verdict, reason: string): Verdict {
  const components = Object.fromEntries(
    COMPONENT_ORDER.map((component) => [component, 'undecidable' as ComponentVerdict]),
  ) as Record<VerdictComponent, ComponentVerdict>

  return {
    episodeId: verdict.episodeId,
    components,
    strictPass: false,
    undecidableReason: reason,
  }
}

export interface BuildEvidencePackInput {
  readonly episodeId: string
  readonly records: readonly TrajectoryRecord[]
  readonly snapshots: readonly Snapshot[]
  readonly verdictInputs: VerdictInputs
  readonly verdict: Verdict
  readonly llmLogPath?: string
}

export interface BuiltEvidencePack {
  readonly pack: EvidencePack
  readonly completeness: CompletenessReport
}

export function buildEvidencePack(input: BuildEvidencePackInput): BuiltEvidencePack {
  if (input.verdict.episodeId !== input.episodeId) {
    throw new Error(
      `证据包 episodeId 不一致：pack=${input.episodeId} verdict=${input.verdict.episodeId}`,
    )
  }

  const completeness = checkCompleteness({ records: input.records, snapshots: input.snapshots })
  const verdict = completeness.complete
    ? input.verdict
    : undecidableVerdict(input.verdict, `证据链不完整：${completeness.missing.join(', ')}`)

  const pack: EvidencePack = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    episodeId: input.episodeId,
    trajectory: input.records,
    snapshots: input.snapshots,
    verdictInputs: input.verdictInputs,
    verdict,
    ...(input.llmLogPath === undefined ? {} : { llmLogPath: input.llmLogPath }),
  }

  return { pack, completeness }
}

/** 落盘 `eval-runs/<episodeId>/evidence.json`，返回文件路径。 */
export async function writeEvidencePack(
  pack: EvidencePack,
  runsDir: string = DEFAULT_RUNS_DIR,
): Promise<string> {
  const dir = join(runsDir, pack.episodeId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'evidence.json')
  await writeFile(path, `${JSON.stringify(pack, null, 2)}\n`, 'utf8')
  return path
}

/**
 * 便捷出口：`pack → 覆写守卫 → 落盘`。
 *
 * 单独导出的原因：M1 的判定链需要「先打包再判」的顺序，不允许先判后补。
 */
export async function sealEvidencePack(
  input: BuildEvidencePackInput,
  runsDir: string = DEFAULT_RUNS_DIR,
): Promise<{ pack: EvidencePack; completeness: CompletenessReport; path: string }> {
  const built = buildEvidencePack(input)
  const path = await writeEvidencePack(built.pack, runsDir)
  return { ...built, path }
}

/** 只有分量结果时构造 Verdict 的便捷函数（M0 内部用，等价于 `buildVerdict`）。 */
export function verdictFromComponents(
  episodeId: string,
  components: Record<VerdictComponent, ComponentVerdict>,
): Verdict {
  return buildVerdict({ episodeId, components })
}
