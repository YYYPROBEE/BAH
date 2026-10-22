/**
 * 轨迹记录器（M0 §4.6，Q1C 降级基线）。
 *
 * 落盘形态：`eval-runs/<episodeId>/trajectory.jsonl`，**追加写、每行一条记录**。
 * 追加而非覆盖有两个理由：episode 被中断时已写入的事件仍然可用（崩溃后可判）；
 * 且 JSONL 天然可流式读，不必把整条轨迹读进内存。
 *
 * **脱敏在出口做**（00 §6 原话：轨迹落盘时执行）：调用方传进来的参数/结果可能是
 * 明文卡号，本类**先脱敏再拼行**，落盘内容不含原文——而不是「先落盘后清洗」，
 * 那等于原文已经写过一次盘，红线已破。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { redactRecord } from '../redact/redact.ts'
import type { TrajectoryEvent, TrajectoryRecord } from '../types.ts'

/** 默认运行目录（相对 cwd；可被 options.runsDir 覆盖）。 */
export const DEFAULT_RUNS_DIR = 'eval-runs'

export interface TrajectoryRecorderOptions {
  readonly episodeId: string
  readonly runsDir?: string
  /** 注入时钟（测试用；缺省 `() => new Date()`）。 */
  readonly now?: () => Date
  /** 脱敏盐（部署面可换成机密盐；缺省用固定常量保证令牌跨进程稳定）。 */
  readonly redactSalt?: string
}

/** 一次工具调用的原始入参（脱敏前）。 */
export interface ToolCallRecordInput {
  readonly tool: string
  readonly args: Readonly<Record<string, unknown>>
  readonly result?: Readonly<Record<string, unknown>>
  readonly idempotencyKey?: string
  readonly permissionBranch?: string
}

export class TrajectoryRecorder {
  readonly episodeId: string
  readonly runsDir: string
  private readonly now: () => Date
  private readonly redactSalt: string | undefined
  private readonly collected: TrajectoryRecord[] = []
  private nextSeq = 0
  private begun = false
  private ended = false

  constructor(options: TrajectoryRecorderOptions) {
    this.episodeId = options.episodeId
    this.runsDir = options.runsDir ?? DEFAULT_RUNS_DIR
    this.now = options.now ?? (() => new Date())
    this.redactSalt = options.redactSalt
  }

  /** 轨迹文件绝对/相对路径（由 runsDir 决定）。 */
  get trajectoryPath(): string {
    return join(this.runsDir, this.episodeId, 'trajectory.jsonl')
  }

  get records(): readonly TrajectoryRecord[] {
    return this.collected
  }

  get events(): readonly TrajectoryEvent[] {
    return this.collected.flatMap((record) => (record.record === 'tool-event' ? [record.event] : []))
  }

  /** 写 episode 起点标记。重复调用是使用错误，直接抛（不静默容忍双开）。 */
  async begin(): Promise<void> {
    if (this.begun) throw new Error(`episode ${this.episodeId} 的 begin() 被重复调用`)
    this.begun = true
    await this.write({
      record: 'episode-start',
      episodeId: this.episodeId,
      seq: this.takeSeq(),
      ts: this.timestamp(),
    })
  }

  /** 记一次工具调用（**出口脱敏**）。 */
  async appendTool(input: ToolCallRecordInput): Promise<TrajectoryEvent> {
    if (!this.begun) throw new Error(`episode ${this.episodeId} 未 begin() 就记录工具调用`)
    if (this.ended) throw new Error(`episode ${this.episodeId} 已 end()，不能再写入事件`)

    const options = this.redactSalt === undefined ? {} : { salt: this.redactSalt }
    const event: TrajectoryEvent = {
      episodeId: this.episodeId,
      seq: this.takeSeq(),
      ts: this.timestamp(),
      tool: input.tool,
      argsDigest: redactRecord(input.args, options),
      resultDigest: redactRecord(input.result ?? {}, options),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.permissionBranch === undefined
        ? {}
        : { permissionBranch: input.permissionBranch }),
    }

    await this.write({ record: 'tool-event', event })
    return event
  }

  /** 写 episode 终点标记。必须与 `begin()` 成对，缺任一端都会被完整率守卫判为不可判定。 */
  async end(outcome: 'success' | 'failure'): Promise<void> {
    if (!this.begun) throw new Error(`episode ${this.episodeId} 未 begin() 就 end()`)
    if (this.ended) throw new Error(`episode ${this.episodeId} 的 end() 被重复调用`)
    this.ended = true
    await this.write({
      record: 'episode-end',
      episodeId: this.episodeId,
      seq: this.takeSeq(),
      ts: this.timestamp(),
      outcome,
    })
  }

  private takeSeq(): number {
    const seq = this.nextSeq
    this.nextSeq += 1
    return seq
  }

  /** ISO 8601 含时区（`toISOString` 的 `Z` 后缀即 UTC 时区标识）。 */
  private timestamp(): string {
    return this.now().toISOString()
  }

  /**
   * 串行化写入队列。
   *
   * 为什么需要：`appendFile` 的原子性只对**单次小写入**成立。一条轨迹事件带上结果内容
   * 后很容易超过 4KB，两次并发追加就可能互相穿插，落盘成为两行半截 JSON。
   * 更现实的是「调用方忘了 await」——那是最常见的误用，不该由使用纪律来兜。
   *
   * 队列本身不因单次失败而断：错误抛给本次调用的调用方，后续写入仍可继续
   * （否则一次磁盘抖动会让整条轨迹后面的事件全部静默丢失）。
   */
  private queue: Promise<void> = Promise.resolve()

  private write(record: TrajectoryRecord): Promise<void> {
    const run = this.queue.then(async () => {
      await mkdir(join(this.runsDir, this.episodeId), { recursive: true })
      await appendFile(this.trajectoryPath, `${JSON.stringify(record)}\n`, 'utf8')
      this.collected.push(record)
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
