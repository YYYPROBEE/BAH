/**
 * HALT 状态落盘（C3）：`<会话根>/halt.json`——**与会话无关的部署级文件**。
 *
 * ## 为什么不是"从 session.jsonl 重放"，也不是"每个会话一份"
 *
 * HALT 是**部署级停机**：`halt('manual')` 的含义是"这台机器上的银行智能体停服"，
 * 不是"这个会话停了"。所以：
 *
 * - **不能挂在会话日志上**：`session.jsonl` 是会话级证据，boot 时是否恢复历史取决于
 *   启动参数；把停机状态挂在它上面，等于"换一个会话 ID 就绕过停机"；
 * - **不能放进会话子目录**：`<root>/<sid>/halt.json` 看起来只是路径选择，语义上却是
 *   "每个会话各停各的"——新会话第一次跑就是 RUNNING，停机形同虚设。
 *
 * 因此停机证据放在**会话根**下，与会话 ID 无关，跟着部署目录走。
 * 多租户场景需要按租户分区（每个租户一个 root），那是 D4 的活，不是这里放宽。
 *
 * ## 三条纪律
 *
 * 1. **原子写**：`halt.json.tmp` → `fsync` → `rename`。半写的 JSON 比没有文件更危险
 *    （读到截断内容时无法区分"没停过"与"停机记录被破坏"）。
 * 2. **损坏即拒启**：`load()` 解析失败 / 字段不合法都抛 `BahError`，由 boot 冒泡。
 *    静默当作 `RUNNING` 等于"文件坏了就自动解除停机"。
 * 3. **不写票据**：快照只有 `reason/detail/at`。解除必须重新走 U 盾审批。
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

import { BahError, reasonOf } from '@bah/util'

import type { HaltPersistence, HaltReason, HaltSnapshot } from '@bah/safety'

/** 停机原因（写死三条，与 `HaltReason` 同集合）。 */
const HALT_REASONS: ReadonlySet<string> = new Set<HaltReason>([
  'chain-broken',
  'p0-threshold',
  'manual',
])

/** 状态文件名（与会话日志 `session.jsonl` 同目录）。 */
const HALT_FILE = 'halt.json'

export interface HaltStoreOptions {
  /** 会话根目录（`core:persistence` 的 `root`，或 `--jsonl` 生效值）。 */
  readonly root: string
  /**
   * 写入后是否 `fsync`（默认 true）。
   *
   * 只有演示/测试会关它，理由与 `core:persistence.fsync` 相同：断电丢最后一条状态
   * 在确定性回放里是可接受的，但在真实停机场景里不是——所以默认开。
   */
  readonly fsync?: boolean
}

/** 停机状态文件路径（宿主诊断输出用；不读不写）。 */
export function haltStateFileOf(root: string): string {
  return join(root, HALT_FILE)
}

/**
 * 造一个基于文件系统的 HALT 持久化端口。
 *
 * `load()` 在构造 `HaltState` 时被同步调用（boot 早期），所以这里全部用同步 IO：
 * 异步读会让"启动时是否已停机"取决于微任务顺序，那是最不该有的不确定性。
 */
export function createHaltStore(options: HaltStoreOptions): HaltPersistence {
  const file = haltStateFileOf(options.root)
  const durable = options.fsync ?? true

  return {
    load(): HaltSnapshot | undefined {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        // 只有"文件不存在"是正常路径（从未停过机）。权限/IO 错误必须冒泡：
        // 读不到停机证据与"没有停机证据"是两件事。
        if (isNotFound(error)) return undefined
        throw new BahError('safety-halt-state-unreadable', `HALT 状态文件不可读：${file}`, {
          file,
          reason: reasonOf(error),
        })
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new BahError(
          'safety-halt-state-invalid',
          `HALT 状态文件不是合法 JSON（停机证据被破坏，拒绝以 RUNNING 启动）：${file}`,
          { file, reason: reasonOf(error) },
        )
      }

      return readSnapshot(parsed, file)
    },

    save(snapshot: HaltSnapshot): void {
      mkdirSync(options.root, { recursive: true })
      const temp = `${file}.tmp`
      const body = `${JSON.stringify({
        reason: snapshot.reason,
        ...(snapshot.detail === undefined ? {} : { detail: snapshot.detail }),
        at: snapshot.at,
      })}\n`

      const fd = openSync(temp, 'w')
      try {
        writeSync(fd, body, null, 'utf8')
        if (durable) fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // rename 在同一目录内是原子的：要么旧文件、要么新文件，不会出现半写
      renameSync(temp, file)
    },

    clear(): void {
      try {
        unlinkSync(file)
      } catch (error) {
        // 解除时文件已经不在 = 目标状态已达成；其它错误必须冒泡（否则"解除成功"是假的）
        if (isNotFound(error)) return
        throw new BahError('safety-halt-state-unwritable', `HALT 状态文件无法删除：${file}`, {
          file,
          reason: reasonOf(error),
        })
      }
    },
  }
}

/** 校验并读出快照（字段类型全部逐项检查，不用整体断言）。 */
function readSnapshot(value: unknown, file: string): HaltSnapshot {
  if (typeof value !== 'object' || value === null) {
    throw invalid(file, '顶层不是对象')
  }
  if (!('reason' in value) || typeof value.reason !== 'string' || !HALT_REASONS.has(value.reason)) {
    throw invalid(file, 'reason 不是 chain-broken / p0-threshold / manual')
  }
  if (!('at' in value) || typeof value.at !== 'number' || !Number.isFinite(value.at)) {
    throw invalid(file, 'at 不是有限数字')
  }
  const detail = 'detail' in value ? value.detail : undefined
  if (detail !== undefined && typeof detail !== 'string') {
    throw invalid(file, 'detail 不是字符串')
  }
  return {
    reason: value.reason as HaltReason,
    ...(detail === undefined ? {} : { detail }),
    at: value.at,
  }
}

function invalid(file: string, why: string): BahError {
  return new BahError(
    'safety-halt-state-invalid',
    `HALT 状态文件字段不合法（${why}）：${file}`,
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

