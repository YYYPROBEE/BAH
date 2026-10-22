/** 测试夹具：轨迹事件与快照的最小构造器，避免每个用例手写一堆字段。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { FlatState, Snapshot, TrajectoryEvent, VerdictComponent } from '../../src/types.ts'

/** 固定时间戳（ISO 8601 含时区），让落盘内容可逐字断言。 */
export const FIXED_TS = '2026-10-22T10:00:00.000Z'

export function ev(
  seq: number,
  tool: string,
  args: Record<string, unknown> = {},
  extra: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  return {
    episodeId: 'ep-1',
    seq,
    ts: FIXED_TS,
    tool,
    argsDigest: args,
    resultDigest: {},
    ...extra,
  }
}

export function snap(
  seq: number,
  reason: Snapshot['reason'],
  state: FlatState,
  callId?: string,
): Snapshot {
  return {
    snapshotId: `ep-1-s${String(seq)}`,
    episodeId: 'ep-1',
    seq,
    ts: FIXED_TS,
    reason,
    ...(callId === undefined ? {} : { callId }),
    state,
  }
}

/** 五分量全通过的分量表（用于 T15 之类的「只改一个分量」用例）。 */
export function allPass(): Record<VerdictComponent, boolean> {
  return { DSR: true, PCR: true, ACR: true, TSC: true, SPR: true }
}

/** 临时运行目录（每个用例独立，避免互相污染）。 */
export async function makeRunsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bah-eval-'))
}

export async function dropRunsDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}
