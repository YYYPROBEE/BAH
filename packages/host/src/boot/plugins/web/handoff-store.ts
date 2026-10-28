/**
 * 接管状态的会话级落盘（`<root>/<sid>/handoff.json`）。
 *
 * 三条纪律照抄 `halt-store.ts`（同一类问题，答案不该有两套）：
 * 1. 原子写：`handoff.json.tmp` → fsync → rename；
 * 2. 损坏即拒启：解析失败 / 字段不合法抛 `BahError`，不静默当作"未接管"；
 * 3. 与会话日志同目录：证据跟着会话走，删会话目录就一起删。
 *
 * 与 `halt.json` 的唯一差别：**这是会话级文件**，路径含 sessionId；
 * HALT 是部署级（`<root>/halt.json`），因为停机与哪个会话无关。
 *
 * ## 边界（必须知道）
 *
 * 落盘只保证"接管状态"跨重启；`session.jsonl` 不会自动重放，且
 * `JsonlPersistence.create()` 对已存在会话排他失败（`session-exists`）。
 * 会话恢复属 D4，不在本文件职责内。
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { BahError, assertSafePathSegment, reasonOf } from '@bah/util'

/** 状态文件名（与会话日志 `session.jsonl` 同目录）。 */
const HANDOFF_FILE = 'handoff.json'

/** 接管快照（JSON 的字段与该形状逐字对应）。 */
export interface HandoffSnapshot {
  /** 进入接管的时刻（注入钟）。 */
  readonly at: number
  readonly reason?: string
  /** 认领的坐席（enter 时为空，claim 后填）。 */
  readonly operator?: string
  /** 超时告警时刻（只告警一次）。 */
  readonly warnedAt?: number
  /** 进入时的会话 seq（用于"接管后新增了多少条"）。 */
  readonly lastSeq: number
}

/** 落盘端口（`HandoffRegistry` 只依赖这三件事）。 */
export interface HandoffPersistence {
  load(): HandoffSnapshot | undefined
  save(snapshot: HandoffSnapshot): void
  clear(): void
}

export interface HandoffStoreOptions {
  /** 会话根目录（`core:persistence` 的 `root`，或 `--jsonl` 生效值）。 */
  readonly root: string
  readonly sessionId: string
  /** 写入后是否 `fsync`（默认 true；只有测试会关）。 */
  readonly fsync?: boolean
}

/** 接管状态文件路径（会话目录 + 固定文件名；拼路径前过白名单）。 */
export function handoffStateFileOf(root: string, sessionId: string): string {
  assertSafePathSegment(sessionId, 'sessionId')
  return join(root, sessionId, HANDOFF_FILE)
}

/** 造一个基于文件系统的接管状态持久化端口（全同步 IO：启动期就要读）。 */
export function createHandoffStore(options: HandoffStoreOptions): HandoffPersistence {
  const dir = join(options.root, options.sessionId)
  const file = handoffStateFileOf(options.root, options.sessionId)
  const durable = options.fsync ?? true

  return {
    load(): HandoffSnapshot | undefined {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        // 只有"文件不存在"是正常路径（从未接管）。权限/IO 错误必须冒泡：
        // 读不到接管证据与"没有接管证据"是两件事。
        if (isNotFound(error)) return undefined
        throw new BahError('handoff-state-unreadable', `接管状态文件不可读：${file}`, {
          file,
          reason: reasonOf(error),
        })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw invalid(file, `不是合法 JSON（${reasonOf(error)}）`)
      }
      return readSnapshot(parsed, file)
    },

    save(snapshot: HandoffSnapshot): void {
      // 构造期不写盘：只有真的进入接管才创建会话目录
      mkdirSync(dir, { recursive: true })
      const temp = `${file}.tmp`
      const body = `${JSON.stringify({
        at: snapshot.at,
        ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
        ...(snapshot.operator === undefined ? {} : { operator: snapshot.operator }),
        ...(snapshot.warnedAt === undefined ? {} : { warnedAt: snapshot.warnedAt }),
        lastSeq: snapshot.lastSeq,
      })}\n`

      try {
        const fd = openSync(temp, 'w')
        try {
          writeSync(fd, body, null, 'utf8')
          if (durable) fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        // rename 在同一目录内是原子的：要么旧文件、要么新文件，不会出现半写
        renameSync(temp, file)
      } catch (error) {
        // 失败时尽量清掉半写的 tmp，免得下次 load 看到一个没用的残片
        try {
          unlinkSync(temp)
        } catch {
          // 清不掉不影响"写入失败"这个结论
        }
        throw new BahError('handoff-state-unwritable', `接管状态文件无法写入：${file}`, {
          file,
          reason: reasonOf(error),
        })
      }
    },

    clear(): void {
      try {
        unlinkSync(file)
      } catch (error) {
        // 解除时文件已经不在 = 目标状态已达成；其它错误必须冒泡（否则"交回成功"是假的）
        if (isNotFound(error)) return
        throw new BahError('handoff-state-unwritable', `接管状态文件无法删除：${file}`, {
          file,
          reason: reasonOf(error),
        })
      }
    },
  }
}

/** 校验并读出快照（字段类型全部逐项检查，不用整体断言）。 */
function readSnapshot(value: unknown, file: string): HandoffSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(file, '顶层不是对象')
  }
  const record = value as Record<string, unknown>
  if (typeof record['at'] !== 'number' || !Number.isFinite(record['at'])) {
    throw invalid(file, 'at 不是有限数字')
  }
  if (!Number.isInteger(record['lastSeq']) || (record['lastSeq'] as number) < 0) {
    throw invalid(file, 'lastSeq 不是非负整数')
  }
  const reason = record['reason']
  if (reason !== undefined && typeof reason !== 'string') {
    throw invalid(file, 'reason 不是字符串')
  }
  const operator = record['operator']
  if (operator !== undefined && typeof operator !== 'string') {
    throw invalid(file, 'operator 不是字符串')
  }
  const warnedAt = record['warnedAt']
  if (warnedAt !== undefined && (typeof warnedAt !== 'number' || !Number.isFinite(warnedAt))) {
    throw invalid(file, 'warnedAt 不是有限数字')
  }
  return {
    at: record['at'],
    lastSeq: record['lastSeq'] as number,
    ...(reason === undefined ? {} : { reason }),
    ...(operator === undefined ? {} : { operator }),
    ...(warnedAt === undefined ? {} : { warnedAt }),
  }
}

function invalid(file: string, why: string): BahError {
  return new BahError(
    'handoff-state-invalid',
    `接管状态文件字段不合法（${why}）：${file}`,
    { file, why },
  )
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}
