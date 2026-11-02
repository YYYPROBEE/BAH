/**
 * JSONL 会话后端。
 *
 * 文件形态（单会话一目录）：
 * ```text
 * sessions/<id>/session.jsonl        # 第 0 代
 * sessions/<id>/session.v1.jsonl     # 第 1 代（格式升级后的后继）
 * ```
 * 第 1 行是 header，其后每行一个 `SessionEvent`。
 *
 * 读取规则：
 * 1. 选**数值最高的规范代**（非规范名一律忽略）；
 * 2. header 的 `formatVersion` 高于本 reader → **拒绝打开**（不做静默降级）；
 * 3. 尾行截断（半写）→ 丢弃该行并告警；中间行损坏 → 直接抛错（不能把日志读歪）。
 *
 * 写入规则：
 * 1. 读取式 open 不发布后继；
 * 2. 写入式 open 遇到旧格式 → 先编码 + 校验，再以**新代号排他发布**后继文件，源文件不动；
 * 3. 逐行 append；`fsync` 默认开启（可用 `fsync: false` 换取测试速度）。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { BahError, assertSafePathSegment, logJson } from '@bah/util'
import {
  encodeJsonLine,
  encodeSessionHeaderLine,
  isLastNonEmptyLine,
  parseJsonValue,
  parseSessionHeaderLine,
  splitLogLines,
} from '@bah/util'

import type { SessionEvent, SessionId } from '@bah/core'

import type {
  OpenOptions,
  SessionHandle,
  SessionHeader,
  SessionInfo,
  SessionPersistence,
  StatInfo,
} from '../persistence/index.ts'
import { redactSessionEvent, redactValue } from './redact.ts'

/** 本 reader 支持的逻辑格式版本。升级时必须同步 `SESSION_FORMAT_VERSION`（runtime/session/types.ts）。 */
export const JSONL_FORMAT_VERSION = 1

/** 规范文件名：`session.jsonl` / `session.vN.jsonl`。 */
const FILE_PATTERN = /^session(?:\.v(\d+))?\.jsonl$/

/** `stat` 只读首行的分块大小（header 可能超过 4 KiB：按行读到 `\n` 为止）。 */
const HEADER_SCAN_BYTES = 4096
/** header 行的硬上限（防止损坏文件把整个会话读进内存）。 */
const HEADER_MAX_BYTES = 1024 * 1024

/** JSONL 后端选项。 */
export interface JsonlOptions {
  /** 每次 append 后是否 `fsync`（默认 true；测试可关掉换速度）。 */
  readonly fsync?: boolean
  /** 落盘前是否做 PII 掩码（默认 true；原文只留在进程内，不落日志）。 */
  readonly redact?: boolean
  /** 告警出口（默认 `console.warn`；测试注入收集器）。 */
  readonly warn?: (message: string) => void
}

/** 打开后缓存的会话内容。 */
interface LoadedSession {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly generation: number
  readonly path: string
}

export class JsonlPersistence implements SessionPersistence {
  private readonly fsync: boolean
  private readonly redact: boolean
  private readonly warn: (message: string) => void

  constructor(options: JsonlOptions = {}) {
    this.fsync = options.fsync ?? true
    this.redact = options.redact ?? true
    this.warn =
      options.warn ?? ((message) => logJson('warn', 'persistence.jsonl-tail-dropped', { message }))
  }

  create(
    dir: string,
    sessionId: SessionId,
    options: { readonly meta?: Readonly<Record<string, unknown>>; readonly now?: number } = {},
  ): SessionHandle {
    // 目录由调用方拼好，但会话 ID 本身也必须合法：防止任何入口把 `../` 漏进来
    assertSafePathSegment(String(sessionId), 'sessionId')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'session.jsonl')
    if (existsSync(path)) {
      throw new BahError('session-exists', 'jsonl: 会话已存在，拒绝覆写', { path })
    }
    const header: SessionHeader = {
      sessionId,
      formatVersion: JSONL_FORMAT_VERSION,
      createdAt: options.now ?? Date.now(),
      ...(options.meta === undefined
        ? {}
        : {
            meta: (this.redact ? redactValue(options.meta) : options.meta) as Readonly<
              Record<string, unknown>
            >,
          }),
    }
    writeFileSync(path, `${encodeSessionHeaderLine(header)}\n`, 'utf8')
    if (this.fsync) fsyncFile(path)
    return this.handle(header, path, 0, [], true)
  }

  open(dir: string, options: OpenOptions = {}): SessionHandle {
    const mode = options.mode ?? 'read'
    const loaded = this.load(dir)
    if (mode === 'read') {
      return this.handle(loaded.header, loaded.path, loaded.generation, loaded.events, false)
    }
    if (loaded.header.formatVersion >= JSONL_FORMAT_VERSION) {
      return this.handle(loaded.header, loaded.path, loaded.generation, loaded.events, true)
    }
    // 旧格式 + 写入式：编码 → 校验 → 以新代号排他发布后继；源文件不动
    const generation = loaded.generation + 1
    const path = generationPath(dir, generation)
    const header: SessionHeader = { ...loaded.header, formatVersion: JSONL_FORMAT_VERSION }
    const lines = [encodeSessionHeaderLine(header), ...loaded.events.map((event) => encodeJsonLine(event))]
    // 排他发布：wx 独占创建（目标已存在时由 fs 直接报错，不靠"先查后写"的竞态窗口）
    writeFileSync(path, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
    if (this.fsync) fsyncFile(path)
    return this.handle(header, path, generation, loaded.events, true)
  }

  stat(dir: string): StatInfo {
    const { path, generation } = resolveGeneration(dir)
    const header = this.readHeader(path)
    return {
      path,
      sessionId: header.sessionId,
      formatVersion: header.formatVersion,
      generation,
      bytes: statSync(path).size,
    }
  }

  list(root: string): SessionInfo[] {
    const found: SessionInfo[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(root, entry.name)
      // 一次 readdir 同时完成"是不是会话目录"与"选最高代"
      const generation = highestGeneration(readdirSync(dir))
      if (generation === undefined) continue
      const path = generationPath(dir, generation)
      const header = this.readHeader(path)
      found.push({
        sessionId: header.sessionId,
        formatVersion: header.formatVersion,
        generation,
        bytes: statSync(path).size,
        path,
        dir,
      })
    }
    return found.sort((left, right) => (left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0))
  }

  flush(handle: SessionHandle): Promise<void> {
    // 只读句柄没有待落盘的写入：直接返回（Windows 上对只读句柄 fsync 会 EPERM）
    return handle.flush()
  }

  /** 构造句柄（写句柄自己持有 fd，flush 不再重新 open/close）。 */
  private handle(
    header: SessionHeader,
    path: string,
    generation: number,
    events: readonly SessionEvent[],
    writable: boolean,
  ): SessionHandle {
    return new JsonlHandle({
      header,
      path,
      generation,
      events,
      writable,
      fsync: this.fsync,
      redact: this.redact,
    })
  }

  /** 读入会话目录（选最高规范代 + 解析 header/events，容忍尾行截断）。 */
  private load(dir: string): LoadedSession {
    const { path, generation } = resolveGeneration(dir)
    const header = this.readHeader(path)
    if (header.formatVersion > JSONL_FORMAT_VERSION) {
      throw new BahError(
        'session-format-too-new',
        `jsonl: 格式版本 ${header.formatVersion} 高于本 reader 支持的 ${JSONL_FORMAT_VERSION}，拒绝打开（不做静默降级）`,
        { path, formatVersion: header.formatVersion, supported: JSONL_FORMAT_VERSION },
      )
    }
    const events = this.readEvents(path)
    return { header, events, generation, path }
  }

  /** 按块读到首个换行取 header（不解码 body；超长视为损坏）。 */
  private readHeader(path: string): SessionHeader {
    const fd = openSync(path, 'r')
    const chunks: Buffer[] = []
    let total = 0
    let newline = -1
    try {
      while (newline < 0) {
        const buffer = Buffer.alloc(HEADER_SCAN_BYTES)
        const read = readSync(fd, buffer, 0, HEADER_SCAN_BYTES, total)
        if (read === 0) break
        total += read
        chunks.push(buffer.subarray(0, read))
        newline = buffer.subarray(0, read).indexOf(0x0a)
        if (newline >= 0) newline += total - read
        if (total > HEADER_MAX_BYTES) {
          throw new BahError('session-header-invalid', `jsonl: header 超过上限：${path}`, {
            path,
            limit: HEADER_MAX_BYTES,
          })
        }
      }
    } finally {
      closeSync(fd)
    }
    const firstLine = Buffer.concat(chunks).toString('utf8').split('\n')[0] ?? ''
    const header = parseSessionHeaderLine(firstLine)
    if (header === undefined) {
      throw new BahError('session-header-invalid', 'jsonl: 首行不是合法 header', { path })
    }
    const meta = header['meta']
    return {
      sessionId: header['sessionId'] as SessionId,
      formatVersion: header['formatVersion'] as number,
      createdAt: header['createdAt'] as number,
      ...(meta === undefined ? {} : { meta: meta as Readonly<Record<string, unknown>> }),
    }
  }

  /** 逐行解析事件；只容忍**最后一行**截断。 */
  private readEvents(path: string): readonly SessionEvent[] {
    const lines = splitLogLines(readFileSync(path, 'utf8'))
    const events: SessionEvent[] = []
    for (const [index, line] of lines.entries()) {
      if (index === 0) continue // header
      if (line.length === 0) continue
      const parsed = parseJsonValue(line)
      if (parsed === undefined) {
        if (isLastNonEmptyLine(lines, index)) {
          this.warn(`jsonl: 丢弃截断的尾行（第 ${index + 1} 行）：${path}`)
          continue
        }
        throw new BahError('session-line-invalid', `jsonl: 第 ${index + 1} 行不是合法 JSON`, {
          path,
          line: index + 1,
        })
      }
      events.push(parsed as SessionEvent)
    }
    return events
  }
}

/** 代数 → 规范文件名。 */
function generationPath(dir: string, generation: number): string {
  return join(dir, generation === 0 ? 'session.jsonl' : `session.v${generation}.jsonl`)
}

/** 在目录里选数值最高的规范代。 */
function resolveGeneration(dir: string): { path: string; generation: number } {
  const generation = highestGeneration(readdirSync(dir))
  if (generation === undefined) {
    throw new BahError('session-missing', `jsonl: 目录里没有规范分代文件：${dir}`, { dir })
  }
  return { path: generationPath(dir, generation), generation }
}

/** 从文件名列表选最高规范代；没有返回 `undefined`。 */
function highestGeneration(names: readonly string[]): number | undefined {
  let best = -1
  for (const name of names) {
    const matched = FILE_PATTERN.exec(name)
    if (!matched) continue
    const generation = matched[1] === undefined ? 0 : Number(matched[1])
    if (generation > best) best = generation
  }
  return best < 0 ? undefined : best
}

/** 对一个路径做 fsync（不存在则静默：只读句柄没必要 fsync）。 */
function fsyncFile(path: string): void {
  if (!existsSync(path)) return
  // 用 r+ 打开：Windows 上对只读 fd 调 fsync 会 EPERM
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** 文件句柄实现：常驻 fd 追加（按选项 fsync；不再每条事件 open/close 一遍）。 */
class JsonlHandle implements SessionHandle {
  readonly header: SessionHeader
  readonly path: string
  readonly generation: number
  readonly writable: boolean

  private readonly log: SessionEvent[]
  private readonly fsyncEnabled: boolean
  private readonly redactEnabled: boolean
  /** 懒打开的追加 fd：进程内一个会话只开一次。 */
  private fd: number | undefined

  constructor(options: {
    readonly header: SessionHeader
    readonly path: string
    readonly generation: number
    readonly events: readonly SessionEvent[]
    readonly writable: boolean
    readonly fsync: boolean
    readonly redact: boolean
  }) {
    this.header = options.header
    this.path = options.path
    this.generation = options.generation
    this.writable = options.writable
    this.log = [...options.events]
    this.fsyncEnabled = options.fsync
    this.redactEnabled = options.redact
  }

  events(): readonly SessionEvent[] {
    return this.log.slice()
  }

  append(event: SessionEvent): void {
    if (!this.writable) {
      throw new BahError('session-readonly', `jsonl: 读取式打开的句柄不能追加：${this.path}`, {
        path: this.path,
      })
    }
    // 落盘副本脱敏；进程内的原始事件不被改写（live 会话仍可继续用原文）
    const stored = this.redactEnabled ? redactSessionEvent(event) : event
    const fd = this.ensureFd()
    writeSync(fd, `${encodeJsonLine(stored)}\n`)
    if (this.fsyncEnabled) fsyncSync(fd)
    this.log.push(stored)
  }

  flush(): Promise<void> {
    if (!this.writable) return Promise.resolve()
    if (this.fsyncEnabled) fsyncSync(this.ensureFd())
    return Promise.resolve()
  }

  /** 释放 fd（宿主在会话关闭 / dispose 时调用；重复调用幂等）。 */
  close(): void {
    if (this.fd === undefined) return
    try {
      closeSync(this.fd)
    } finally {
      this.fd = undefined
    }
  }

  private ensureFd(): number {
    this.fd ??= openSync(this.path, 'a')
    return this.fd
  }
}
