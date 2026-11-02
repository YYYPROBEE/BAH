/**
 * 快照链（M0 §4.6，Q1C 降级基线）。
 *
 * 取景点位四类：episode 起点 S₀、每次**不可逆**工具调用前、其后、终点 Send。
 * 「不可逆」不由本类判断（`snapshotTools` 白名单在 config/checkpoints.json），
 * 本类只负责「取得到、配得上、存得下」。
 *
 * 落盘形态：`eval-runs/<episodeId>/snapshots.json`——**整份一次性写**，不是追加：
 * 快照是判定输入，需要「同一时刻的一致视图」，边取边追加会在中途崩溃时留下
 * 一半的标准答案，比没有更危险。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { FlatState, Snapshot, SnapshotReason } from '../types.ts'
import { deepClone } from '../deep-clone.ts'
import { DEFAULT_RUNS_DIR } from '../recorder/TrajectoryRecorder.ts'
import { leafHash, merkleRoot as rootOf, sampleProofs, type MerkleProof } from './merkle.ts'

export interface SnapshotChainOptions {
  readonly episodeId: string
  /** 读当前状态（**只读**；00 §1：adapters 只读不写）。 */
  readonly readState: () => FlatState | Promise<FlatState>
  readonly runsDir?: string
  readonly now?: () => Date
}

/** 一对前后快照；`after` 缺省即「孤儿 before」，完整率守卫会拦。 */
export interface SnapshotPair {
  readonly callId: string
  readonly before?: Snapshot
  readonly after?: Snapshot
}

export class SnapshotChain {
  readonly episodeId: string
  readonly runsDir: string
  private readonly readState: () => FlatState | Promise<FlatState>
  private readonly now: () => Date
  private readonly collected: Snapshot[] = []
  private closed = false

  constructor(options: SnapshotChainOptions) {
    this.episodeId = options.episodeId
    this.runsDir = options.runsDir ?? DEFAULT_RUNS_DIR
    this.readState = options.readState
    this.now = options.now ?? (() => new Date())
  }

  get snapshotsPath(): string {
    return join(this.runsDir, this.episodeId, 'snapshots.json')
  }

  get snapshots(): readonly Snapshot[] {
    return this.collected
  }

  /** 起点 S₀。 */
  async open(): Promise<Snapshot> {
    return this.capture('episode-start')
  }

  /** 不可逆调用前。 */
  async beforeIrreversible(callId: string): Promise<Snapshot> {
    return this.capture('before-irreversible', callId)
  }

  /** 不可逆调用后（与 `beforeIrreversible` 同 callId 才算一对）。 */
  async afterIrreversible(callId: string): Promise<Snapshot> {
    return this.capture('after-irreversible', callId)
  }

  /** 终点 Send，并落盘。 */
  async close(): Promise<Snapshot> {
    const snapshot = await this.capture('episode-end')
    await this.flush()
    return snapshot
  }

  /** 按 callId 配对；`orphanCallIds` 供完整率守卫与报告使用。 */
  pairs(): readonly SnapshotPair[] {
    const byCall = new Map<string, { before?: Snapshot; after?: Snapshot }>()
    for (const snapshot of this.collected) {
      if (snapshot.callId === undefined) continue
      const slot = byCall.get(snapshot.callId) ?? {}
      if (snapshot.reason === 'before-irreversible') slot.before = snapshot
      if (snapshot.reason === 'after-irreversible') slot.after = snapshot
      byCall.set(snapshot.callId, slot)
    }
    return [...byCall.entries()].map(([callId, slot]) => ({ callId, ...slot }))
  }

  /** 只有 before 没有 after（或反之）的 callId 列表。 */
  orphanCallIds(): readonly string[] {
    return this.pairs()
      .filter((pair) => pair.before === undefined || pair.after === undefined)
      .map((pair) => pair.callId)
  }

  /** 全部快照的叶子哈希（顺序 = 快照顺序）。 */
  merkleLeaves(): readonly string[] {
    return this.collected.map((snapshot) => leafHash(snapshot))
  }

  /** Merkle 根（空链返回空串）。 */
  merkleRoot(): string {
    return rootOf(this.merkleLeaves())
  }

  /** 抽样包含证明（默认 10%）；证明可脱离本实例离线验证。 */
  sampleInclusionProofs(ratio = 0.1): readonly MerkleProof[] {
    return sampleProofs(this.merkleLeaves(), ratio)
  }

  /** 落盘 `snapshots.json`。可重复调用（幂等覆盖）。 */
  async flush(): Promise<void> {
    await mkdir(join(this.runsDir, this.episodeId), { recursive: true })
    await writeFile(
      this.snapshotsPath,
      `${JSON.stringify({ schemaVersion: 'snapshots-v0.1', episodeId: this.episodeId, snapshots: this.collected }, null, 2)}\n`,
      'utf8',
    )
  }

  private async capture(reason: SnapshotReason, callId?: string): Promise<Snapshot> {
    if (this.closed) throw new Error(`episode ${this.episodeId} 的快照链已 close()`)
    const state = await this.readState()
    const snapshot: Snapshot = {
      snapshotId: `${this.episodeId}-s${String(this.collected.length)}`,
      episodeId: this.episodeId,
      seq: this.collected.length,
      ts: this.now().toISOString(),
      reason,
      ...(callId === undefined ? {} : { callId }),
      // **深**拷贝：展平后的叶子可能是数组/空对象，它们是原引用，浅拷贝挡不住后续 mutate。
      // 快照一旦被就地改掉，证据链就失去了「当时是什么样」的意义，而且看不出痕迹。
      state: deepClone(state),
    }
    this.collected.push(snapshot)
    if (reason === 'episode-end') this.closed = true
    return snapshot
  }
}
