/**
 * 审计链 JSONL 读写（SA-07 §3.3 / SA-11 §3.1）。
 *
 * 布局：`<root>/<sagaId>/audit.jsonl`，只追加；每次 append 后 `fsync`。
 * 不使用 `JsonlPersistence`：它只认 `session*.jsonl` 命名（SA-11 §6 风险条）。
 *
 * 尾行截断策略与会话后端一致：**只容忍最后一行**半写（丢弃并告警）；
 * 中间行损坏直接 fail-loud（不能把日志读歪）。
 * `rootDir` 缺省时退化为进程内内存链（测试/装配空跑用）。
 */

import {
  appendFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

import {
  BahError,
  encodeJsonLine,
  isLastNonEmptyLine,
  logJson,
  parseJsonValue,
  splitLogLines,
} from '@bah/util'

/** 审计信封版本：v2 显式写 `version: 2`；v1 是历史行（没有 `version` 字段）。 */
export type ChainEnvelopeVersion = 2

/** 一项判决（v2 信封的语义字段）。 */
export type ChainDecision = 'allow' | 'deny' | 'ask'

/**
 * v2 判决信封（W08）。
 *
 * - `subject`：**谁**被判决（本仓用 `session:<sessionId>`；与 v1 的 `sub`（对象引用）不同）；
 * - `decision`：最终判决；
 * - `policyVersion`：做出判决的策略版本（可追溯"当时用的是哪套规则"）；
 * - `prevHash`：前一条的 `recordHash`。它与 `p` **同值**，是 v2 显式化的人读别名：
 *   单条导出时不必再记 v1 的短键，也能直接自证前驱。
 */
export interface ChainDecisionEnvelope {
  readonly subject: string
  readonly decision: ChainDecision
  readonly policyVersion: string
}

/** 一条链记录（写进 JSONL 的完整行）。 */
export interface ChainRecord {
  readonly s: string
  readonly q: number
  readonly t: string
  readonly sub: string
  readonly hb: readonly number[]
  readonly d: string
  readonly v?: string
  readonly p: string
  readonly r: string
  readonly sig?: string
  readonly keyVersion: number
  readonly recordedAt: number
  /* ── v2 信封（W08；v1 行没有这些键，读取时按 `version` 区分） ── */
  readonly version?: ChainEnvelopeVersion
  readonly subject?: string
  readonly decision?: ChainDecision
  readonly policyVersion?: string
  readonly prevHash?: string
  /**
   * 租户（01 TA-15）：**新行才有**，历史链没有。
   *
   * 刻意**不进** `isChainRecord` 的 v2 键集（v2 的规则是"出现任一 v2 键就必须齐"）：
   * 把它加进去会让所有历史 v2 行变成"不合法"，等于把老证据判死。
   * 它与 v2 键互不依赖：v1 行（`tool/call`）也可以带租户。
   */
  readonly tenant?: string
}

/** 链文件选项。 */
export interface ChainFileOptions {
  /** 根目录；缺省 = 内存链。 */
  readonly rootDir?: string
  /** 每次 append 后是否 fsync（默认 true）。 */
  readonly fsync?: boolean
  /** 尾行截断告警出口（默认 console.warn）。 */
  readonly warn?: (message: string) => void
}

const SAGA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/

/** 单 saga 目录里的链文件。 */
export class ChainFile {
  private readonly rootDir: string | undefined
  private readonly fsync: boolean
  private readonly warn: (message: string) => void
  private readonly memory: ChainRecord[] = []

  constructor(options: ChainFileOptions = {}) {
    this.rootDir = options.rootDir
    this.fsync = options.fsync ?? true
    this.warn =
      options.warn ?? ((message) => logJson('warn', 'persistence.chain-tail-dropped', { message }))
  }

  /** 追加一行；sagaId 会做路径安全校验。 */
  append(sagaId: string, row: ChainRecord): void {
    if (this.rootDir === undefined) {
      this.memory.push(row)
      return
    }
    const path = this.pathOf(sagaId)
    mkdirSync(join(this.rootDir, sagaId), { recursive: true })
    appendFileSync(path, `${encodeJsonLine(row)}\n`, 'utf8')
    if (this.fsync) fsyncFile(path)
  }

  /** 读一个 saga 的链（尾行截断容忍）。 */
  read(sagaId: string): readonly ChainRecord[] {
    if (this.rootDir === undefined) {
      return this.memory.filter((row) => row.s === sagaId)
    }
    const path = this.pathOf(sagaId)
    if (!existsSync(path)) return []
    return this.readFile(path)
  }

  /** 读全部 saga 的链（按 `recordedAt, s, q` 稳定排序）。 */
  readAll(): readonly ChainRecord[] {
    if (this.rootDir === undefined) {
      return stableSort(this.memory)
    }
    const rows: ChainRecord[] = []
    const entries = existsSync(this.rootDir) ? readdirSync(this.rootDir, { withFileTypes: true }) : []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(this.rootDir, entry.name, 'audit.jsonl')
      if (!existsSync(path)) continue
      rows.push(...this.readFile(path))
    }
    return stableSort(rows)
  }

  /** 链文件的绝对路径（内存链返回空串）。 */
  pathOf(sagaId: string): string {
    assertSagaId(sagaId)
    if (this.rootDir === undefined) return ''
    return join(this.rootDir, sagaId, 'audit.jsonl')
  }

  private readFile(path: string): readonly ChainRecord[] {
    const lines = splitLogLines(readFileSync(path, 'utf8'))
    const rows: ChainRecord[] = []
    for (const [index, line] of lines.entries()) {
      if (line.length === 0) continue
      const parsed = parseJsonValue(line)
      if (!isChainRecord(parsed)) {
        if (isLastNonEmptyLine(lines, index)) {
          this.warn(`bah-saga: 丢弃截断的链尾行（第 ${index + 1} 行）：${path}`)
          continue
        }
        throw new BahError('chain-line-invalid', `bah-saga: chain-line-invalid: 第 ${index + 1} 行不是合法链记录`, {
          path,
          line: index + 1,
        })
      }
      rows.push(parsed)
    }
    return rows
  }
}

function stableSort(rows: readonly ChainRecord[]): readonly ChainRecord[] {
  // 按 (sagaId, seqInSaga) 排序：saga 内全序是因果唯一依据；recordedAt 不参与排序。
  return [...rows].sort((left, right) => {
    if (left.s !== right.s) return left.s < right.s ? -1 : 1
    return left.q - right.q
  })
}

function isChainRecord(value: unknown): value is ChainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const base =
    typeof record['s'] === 'string' &&
    typeof record['q'] === 'number' &&
    Number.isSafeInteger(record['q']) &&
    typeof record['t'] === 'string' &&
    typeof record['sub'] === 'string' &&
    typeof record['d'] === 'string' &&
    typeof record['p'] === 'string' &&
    typeof record['r'] === 'string' &&
    typeof record['keyVersion'] === 'number' &&
    typeof record['recordedAt'] === 'number' &&
    Array.isArray(record['hb'])
  if (!base) return false

  // v2：只要出现任一 v2 键，就必须是完整形状（`version` 必须为 2）。
  // 刻意**不**校验 decision 的枚举值：被改成任意字符串也要能读出来，
  // 由 `verifyContinuity` 用 recordHash 定位"第几条被改"，而不是在解析期丢掉证据。
  const v2Keys = ['version', 'subject', 'decision', 'policyVersion', 'prevHash'] as const
  if (v2Keys.every((key) => record[key] === undefined)) return true
  return (
    record['version'] === 2 &&
    typeof record['subject'] === 'string' &&
    record['subject'].length > 0 &&
    typeof record['decision'] === 'string' &&
    typeof record['policyVersion'] === 'string' &&
    record['policyVersion'].length > 0 &&
    typeof record['prevHash'] === 'string'
  )
}

function assertSagaId(sagaId: string): void {
  if (SAGA_ID_PATTERN.test(sagaId) && !sagaId.includes('..')) return
  throw new BahError('saga-id-invalid', `bah-saga: saga-id-invalid: 非法 sagaId ${sagaId}`, { sagaId })
}

function fsyncFile(path: string): void {
  if (!existsSync(path) || statSync(path).size === 0) return
  // Windows 上对只读 fd fsync 会 EPERM，用 r+ 打开。
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
