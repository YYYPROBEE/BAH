import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  buildEvidencePack,
  checkCompleteness,
  EVIDENCE_SCHEMA_VERSION,
  sealEvidencePack,
  verdictFromComponents,
  writeEvidencePack,
} from '../../src/evidence/EvidencePack.ts'
import type { Snapshot, TrajectoryRecord } from '../../src/types.ts'
import { buildVerdict } from '../../src/verdict.ts'
import { allPass, dropRunsDir, ev, FIXED_TS, makeRunsDir, snap } from '../helpers/fixtures.ts'

const START: TrajectoryRecord = {
  record: 'episode-start',
  episodeId: 'ep-1',
  seq: 0,
  ts: FIXED_TS,
}
const END: TrajectoryRecord = {
  record: 'episode-end',
  episodeId: 'ep-1',
  seq: 2,
  ts: FIXED_TS,
  outcome: 'success',
}
const S0 = snap(0, 'episode-start', { 'txn.status': 'draft' })
const SEND = snap(1, 'episode-end', { 'txn.status': 'completed' })

const greenVerdict = (): ReturnType<typeof buildVerdict> =>
  buildVerdict({ episodeId: 'ep-1', components: allPass() })

describe('证据包与完整率守卫', () => {
  it('证据链完整时保留原判定', () => {
    const { pack, completeness } = buildEvidencePack({
      episodeId: 'ep-1',
      records: [START, { record: 'tool-event', event: ev(1, 'transfer_create') }, END],
      snapshots: [S0, SEND],
      verdictInputs: { requiredCheckpoints: ['execute'] },
      verdict: greenVerdict(),
    })

    expect(completeness.complete).toBe(true)
    expect(pack.verdict.strictPass).toBe(true)
    expect(pack.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION)
    expect(pack.verdictInputs.requiredCheckpoints).toEqual(['execute'])
  })

  // T13
  it('T13 缺 end 事件判为不可判定（不是通过）', () => {
    const { pack, completeness } = buildEvidencePack({
      episodeId: 'ep-1',
      records: [START, { record: 'tool-event', event: ev(1, 'transfer_create') }],
      snapshots: [S0, SEND],
      verdictInputs: {},
      verdict: greenVerdict(),
    })

    expect(completeness.complete).toBe(false)
    expect(completeness.missing).toContain('trajectory:episode-end')
    expect(pack.verdict.strictPass).toBe(false)
    expect(pack.verdict.components).toEqual({
      ACR: 'undecidable',
      PCR: 'undecidable',
      DSR: 'undecidable',
      TSC: 'undecidable',
      SPR: 'undecidable',
    })
    expect(pack.verdict.undecidableReason).toContain('证据链不完整')
    expect(pack.verdict.firstFailure).toBeUndefined()
  })

  it('缺 S₀ 或 Send 快照同样判不可判定', () => {
    const report = checkCompleteness({ records: [START, END], snapshots: [] })
    expect(report.complete).toBe(false)
    expect(report.missing).toEqual(['snapshot:episode-start', 'snapshot:episode-end'])
  })

  it('快照对不完整（只有 before）被拦下', () => {
    const orphan: Snapshot = snap(2, 'before-irreversible', { a: 1 }, 'call-9')
    const report = checkCompleteness({ records: [START, END], snapshots: [S0, SEND, orphan] })
    expect(report.complete).toBe(false)
    expect(report.missing).toEqual(['snapshot-pair:call-9:missing-after'])
  })

  it('快照对不完整（只有 after）被拦下', () => {
    const orphan: Snapshot = snap(3, 'after-irreversible', { a: 1 }, 'call-9')
    const report = checkCompleteness({ records: [START, END], snapshots: [S0, SEND, orphan] })
    expect(report.missing).toEqual(['snapshot-pair:call-9:missing-before'])
  })

  it('episodeId 不一致直接抛（防串包）', () => {
    expect(() =>
      buildEvidencePack({
        episodeId: 'ep-2',
        records: [START, END],
        snapshots: [S0, SEND],
        verdictInputs: {},
        verdict: greenVerdict(),
      }),
    ).toThrow(/episodeId 不一致/)
  })

  it('llmLogPath 为可选字段：给了才出现（Q1C 不实现录制，只留字段）', () => {
    const base = {
      episodeId: 'ep-1',
      records: [START, END],
      snapshots: [S0, SEND],
      verdictInputs: {},
      verdict: greenVerdict(),
    }
    expect(buildEvidencePack(base).pack.llmLogPath).toBeUndefined()
    expect(buildEvidencePack({ ...base, llmLogPath: 'runs/ep-1/llm.jsonl' }).pack.llmLogPath).toBe(
      'runs/ep-1/llm.jsonl',
    )
  })

  it('verdictFromComponents 等价于 buildVerdict 的合取语义', () => {
    const components = { ...allPass(), ACR: false as const }
    const verdict = verdictFromComponents('ep-1', components)
    expect(verdict.strictPass).toBe(false)
    expect(verdict.firstFailure?.component).toBe('ACR')
  })
})

describe('证据包落盘', () => {
  let runsDir: string

  beforeEach(async () => {
    runsDir = await makeRunsDir()
  })

  afterEach(async () => {
    await dropRunsDir(runsDir)
  })

  it('writeEvidencePack 写到 eval-runs/<episodeId>/evidence.json', async () => {
    const { pack } = buildEvidencePack({
      episodeId: 'ep-1',
      records: [START, END],
      snapshots: [S0, SEND],
      verdictInputs: {},
      verdict: greenVerdict(),
    })

    const path = await writeEvidencePack(pack, runsDir)
    expect(path).toBe(join(runsDir, 'ep-1', 'evidence.json'))

    const parsed = JSON.parse(await readFile(path, 'utf8')) as { episodeId: string }
    expect(parsed.episodeId).toBe('ep-1')
  })

  it('sealEvidencePack 一步完成「打包 → 守卫 → 落盘」', async () => {
    const sealed = await sealEvidencePack(
      {
        episodeId: 'ep-1',
        records: [START],
        snapshots: [S0],
        verdictInputs: {},
        verdict: greenVerdict(),
      },
      runsDir,
    )

    expect(sealed.completeness.complete).toBe(false)
    expect(sealed.pack.verdict.strictPass).toBe(false)
    const parsed = JSON.parse(await readFile(sealed.path, 'utf8')) as { verdict: { strictPass: boolean } }
    expect(parsed.verdict.strictPass).toBe(false)
  })
})
