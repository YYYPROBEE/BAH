/**
 * 审计轨迹（施工单 10 §3 的内核组件 7：`trace`——铁律三"每个决策点写 TraceLog"的落点）。
 * 对应源文件 `sentry-dsh-plugin/src/kernel/trace.js`——序号分配、会话分桶环缓冲、
 * 攒批阈值与计数指标口径照搬。
 *
 * 检测 / 门禁判决 / 票据生命周期 / 会话边界全部落一份带序号、带时间戳的记录；
 * 内存环缓冲供进程内观察，可选经**注入的 sink** 落盘为 JSONL。
 * 落盘失败不中断主链路（计入 `sinkErrors`，可被后续审计发现——不静默冒充成功）。
 *
 * 两处结构性选择（与源一致）：
 *  - **环缓冲按会话分桶**（`Map<sessionKey, records[]>`）：全局单环在多会话并发时
 *    会互相挤掉彼此的记录，`recent()` 拿到的是一锅杂烩；分桶后每会话独立留存。
 *  - **落盘走缓冲 + 阈值 flush**：`flushThreshold` 默认 1（每条立即落盘），
 *    高频场景调到 32–64 可把 N 次小写入合并成一次 sink 调用。
 *
 * 内核零依赖纪律下的替换：源直接 `appendFileSync`，这里不碰 `fs`——序列化好的 JSONL 行
 * 交给构造时注入的 `sink`（`file` 选项因此不再是内核概念）。时间戳同样走注入时钟。
 */

/** 落盘出口：一次收到一批已序列化的 JSONL 行（行内不含结尾换行，由宿主决定分隔符）。 */
export type TraceSink = (lines: readonly string[]) => void

/** 调用方给入的记录内容（`session` / `kind` 等字段由调用方给出）。 */
export type TraceInput = Record<string, unknown>

/** 落定的审计记录：`ts` + 全局递增 `seq` + 调用方字段。 */
export type TraceRecord = Record<string, unknown>

/** 计数指标（判决与副作用面的计数器；键集封闭）。 */
export interface TraceCounters {
  detections: number
  denies: number
  asks: number
  allows: number
  pii: number
  ticketsIssued: number
  ticketsConsumed: number
  breakerTrips: number
  escalations: number
  sinkErrors: number
  observerErrors: number
}

/** 指标名（`bump()` 只接受已登记的计数位）。 */
export type TraceCounterName = keyof TraceCounters

/** `TraceLog` 的装配参数。 */
export interface TraceOptions {
  /** 落盘出口（省略 = 仅内存环缓冲）。 */
  readonly sink?: TraceSink
  /** 每会话环缓冲大小。 */
  readonly ringSize?: number
  /** 攒够多少条落一次盘（1 = 每条即写）。 */
  readonly flushThreshold?: number
  /** 时钟注入（缺省 `Date.now`；`ts` 由它换算成 ISO 串）。 */
  readonly now?: () => number
}

/**
 * 审计轨迹：内存环缓冲 + 可选 JSONL 落盘（经注入 sink）。
 */
export class TraceLog {
  readonly ringSize: number
  /** 攒够多少条落一次盘（1 = 每条即写）。 */
  readonly flushThreshold: number
  /** 按会话分桶的环缓冲。 */
  readonly rings = new Map<string, TraceRecord[]>()
  /** 全局递增序号（跨会话单调，作为对账锚点）。 */
  seq = 0
  /** 计数指标。 */
  readonly counters: TraceCounters = {
    detections: 0,
    denies: 0,
    asks: 0,
    allows: 0,
    pii: 0,
    ticketsIssued: 0,
    ticketsConsumed: 0,
    breakerTrips: 0,
    escalations: 0,
    sinkErrors: 0,
    observerErrors: 0,
  }

  private readonly sink: TraceSink | undefined
  private readonly clock: () => number
  private readonly pending: TraceRecord[] = []

  constructor(options: TraceOptions = {}) {
    this.ringSize = options.ringSize ?? 500
    this.flushThreshold = options.flushThreshold ?? 1
    this.sink = options.sink
    this.clock = options.now ?? (() => Date.now())
  }

  /**
   * 追加一条审计记录（内存 + 按阈值落盘）。
   *
   * @param entry - 记录内容。
   * @returns 带 `ts` / `seq` 的最终记录。
   */
  append(entry: TraceInput): TraceRecord {
    this.seq += 1
    const record: TraceRecord = { ts: new Date(this.clock()).toISOString(), seq: this.seq, ...entry }

    const session = record.session
    const bucket = typeof session === 'string' && session !== '' ? session : 'unknown'
    const ring = this.rings.get(bucket)
    if (ring === undefined) {
      this.rings.set(bucket, [record])
    } else {
      ring.push(record)
      if (ring.length > this.ringSize) ring.shift()
    }

    if (this.sink !== undefined) {
      this.pending.push(record)
      if (this.pending.length >= this.flushThreshold) this.flush()
    }
    return record
  }

  /**
   * 把缓冲中的记录一次性落盘（幂等；无缓冲时是空操作）。
   *
   * @returns 本次落盘条数。
   */
  flush(): number {
    if (this.pending.length === 0) return 0
    const batch = this.pending.splice(0, this.pending.length)
    const lines = batch.map((record) => JSON.stringify(record))
    try {
      this.sink?.(lines)
    } catch {
      // 落盘失败不影响主链路：计入计数，由审计侧发现（不静默冒充成功）
      this.counters.sinkErrors += batch.length
    }
    return batch.length
  }

  /**
   * 指标自增。
   *
   * @param name - 指标名。
   * @param n - 增量。
   */
  bump(name: TraceCounterName, n: number = 1): void {
    this.counters[name] += n
  }

  /**
   * 最近 N 条记录。
   *
   * @param n - 条数。
   * @param session - 只取该会话（省略 = 跨会话按 seq 合并）。
   * @returns 记录清单（旧 → 新）。
   */
  recent(n: number = 50, session?: string): TraceRecord[] {
    if (session !== undefined) return (this.rings.get(session) ?? []).slice(-n)
    const all: TraceRecord[] = []
    for (const ring of this.rings.values()) all.push(...ring)
    return all.sort((left, right) => Number(left.seq) - Number(right.seq)).slice(-n)
  }
}
