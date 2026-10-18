/**
 * 会话日志的最小 JSONL 读写（快照 fixture 用；格式与运行时 `@bah/persistence` 的 JSONL 后端**同构**）。
 *
 * 为什么这里不直接依赖 `@bah/persistence`：`persistence` 与 `runtime` 的 tsconfig 都引用了本包
 * （它们的用例用本包的夹具），本包再反向引用会形成 project reference 环。所以这里只复制
 * **一行 header + 每条事件一行**这个最小格式，并由 `snapshots/` 面的用例用真实
 * `JsonlPersistence.open()` 交叉验证——格式漂移会在那条用例里立刻红。
 *
 * 与运行时的差异（有意为之）：
 * - **容忍尾行截断是运行时的事**；fixture 是一份验收证据，半截就是坏的，直接 fail-loud；
 * - 不做分代选择：fixture 目录里的分代由 `fixtures.ts` 负责。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BahError } from '@bah/util'

import type { SessionEvent } from '@bah/core'

/** header 行的判别标签（与运行时 JSONL 后端一致）。 */
const HEADER_KIND = 'bah-session-header'

/** 快照目录里的会话日志文件名（与运行时一致，也是 `fixtures.ts` 的命名规则）。 */
export const SESSION_LOG_FILE = 'session.jsonl'

/** 读回的会话日志。 */
export interface SessionLogContent {
  /** header 里的会话 ID。 */
  readonly sessionId: string
  /** 事件序列（`seq` 由写方保证单调连续）。 */
  readonly events: readonly SessionEvent[]
}

/**
 * 写会话日志（覆盖）。
 *
 * @param dir 快照目录
 * @param sessionId 会话 ID（与 `scenario.json` 必须一致）
 * @param events 事件序列
 * @param createdAt header 的 `createdAt`（**必须来自确定性时钟**）
 */
export function writeSessionLog(
  dir: string,
  sessionId: string,
  events: readonly SessionEvent[],
  createdAt: number,
): void {
  // 格式版本取事件自己声明的那个（会话日志的不变量：一条日志只有一个格式代）
  const formatVersion = events[0]?.formatVersion ?? 1
  const header = { kind: HEADER_KIND, sessionId, formatVersion, createdAt }
  const lines = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event))]
  writeFileSync(join(dir, SESSION_LOG_FILE), `${lines.join('\n')}\n`, 'utf8')
}

/**
 * 读会话日志。
 *
 * @throws `BahError('snapshot-missing')` 文件不存在
 * @throws `BahError('snapshot-invalid')` header 不对 / 某行不是合法事件（fixture 坏了必须重录）
 */
export function readSessionLog(dir: string): SessionLogContent {
  const path = join(dir, SESSION_LOG_FILE)
  if (!existsSync(path)) {
    throw new BahError('snapshot-missing', `test-support: 缺会话日志 ${path}`, { path })
  }

  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const headerLine = lines[0] ?? ''
  const header = parseJson(headerLine, path, 1)
  if (header === undefined || header['kind'] !== HEADER_KIND) {
    throw new BahError('snapshot-invalid', `test-support: ${path} 第 1 行不是会话 header`, { path })
  }
  const sessionId = header['sessionId']
  if (typeof sessionId !== 'string') {
    throw new BahError('snapshot-invalid', `test-support: ${path} 的 header 缺 sessionId`, { path })
  }

  const events: SessionEvent[] = []
  for (const [index, line] of lines.entries()) {
    if (index === 0 || line.length === 0) continue
    const parsed = parseJson(line, path, index + 1)
    if (parsed === undefined || typeof parsed['seq'] !== 'number' || typeof parsed['type'] !== 'string') {
      throw new BahError(
        'snapshot-invalid',
        `test-support: ${path} 第 ${index + 1} 行不是合法事件（fixture 坏了必须重录）`,
        { path, line: index + 1 },
      )
    }
    events.push(parsed as unknown as SessionEvent)
  }

  return { sessionId, events }
}

/** 解析一行 JSON；坏输入返回 `undefined`（由调用方给带行号的错误）。 */
function parseJson(line: string, path: string, lineNumber: number): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    throw new BahError('snapshot-invalid', `test-support: ${path} 第 ${lineNumber} 行不是合法 JSON`, {
      path,
      line: lineNumber,
    })
  }
}
