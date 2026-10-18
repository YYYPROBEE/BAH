/**
 * 快照录制回放 harness（施工单 12 §3 / §4 第 4 步）。
 *
 * 一个快照 = 一个目录里的三份文件：
 * ```text
 * snapshots/<case>/session.jsonl    录制的事件流（就是运行时的会话日志格式，可直接 deriveMessages）
 * snapshots/<case>/llm.jsonl        每次 provider 调用的请求标识 + 响应分片（llm-mock-server 格式）
 * snapshots/<case>/scenario.json    场景输入：profile / prompts / 会话 ID / 时钟 / 种子 / 生效行 / 模型规格
 * ```
 *
 * 为什么把"输入"也录下来：回放必须是**自包含**的——不读 `profiles/`、不读 `bah.yml`、不联网。
 * 这样它才是回归护栏：改了 profile 或提示词，回放会红，提醒你重录并人工确认差异。
 *
 * 录制与回放的分工：harness 只管**落盘 / 读回 / 比对**；"怎么把一个应用跑起来"由场景提供
 * （`recordSnapshot` 的 `run`）。这样 harness 不依赖组合系统，也不会绑死某一个 profile。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BahError } from '@bah/util'

import type { SessionEvent } from '@bah/core'
import type { ModelSpec } from '@bah/llm'

import { readExchanges, writeExchanges, type Exchange } from '../llm-mock-server/index.ts'
import { selectSnapshot } from './fixtures.ts'
import { SESSION_LOG_FILE, readSessionLog, writeSessionLog } from './session-log.ts'

/** 快照目录里的三份文件。 */
export interface SnapshotPaths {
  /** 快照目录。 */
  readonly dir: string
  /** 事件流（= 运行时 JSONL 会话日志）。 */
  readonly session: string
  /** provider 调用序列。 */
  readonly exchanges: string
  /** 场景输入。 */
  readonly scenario: string
}

/** 一行生效的插件行（回放时重建应用用；只留重建需要的三样）。 */
export interface SnapshotRow {
  readonly id: string
  readonly use: string
  readonly config: Readonly<Record<string, unknown>>
}

/** 场景输入（快照里唯一"人可读可改"的部分）。 */
export interface SnapshotMeta {
  /** 用例名（打印与报错用）。 */
  readonly name: string
  /** 录制时用的 profile 名（仅供人看；回放不读它）。 */
  readonly profile: string
  /** 依次送入的用户输入（每个 prompt 跑一个 turn）。 */
  readonly prompts: readonly string[]
  /** 会话 ID（固定值，回放必须逐字相同）。 */
  readonly sessionId: string
  /** 确定性时钟的起点与步长（回放照抄）。 */
  readonly clock: { readonly start: number; readonly step: number }
  /** seeded 随机种子（与 bank-forge 同源接口的预留位；本阶段场景未用到）。 */
  readonly randomSeed: number
  /** 录制时实际生效的插件行（回放不读仓库里的 profile）。 */
  readonly rows: readonly SnapshotRow[]
  /** 录制时的模型规格（能力位决定提示词装配，必须与录制一致）。 */
  readonly model: { readonly provider: string; readonly spec: ModelSpec }
}

/** 一次录制 / 回放的日期无关摘要（打印用；**不含时间**，否则会破坏确定性叙事）。 */
export interface SnapshotSummary {
  readonly name: string
  readonly prompts: number
  readonly events: number
  readonly exchanges: number
}

/** 已加载的快照。 */
export interface LoadedSnapshot {
  readonly paths: SnapshotPaths
  readonly meta: SnapshotMeta
  readonly events: readonly SessionEvent[]
  readonly exchanges: readonly Exchange[]
}

/** 事件比对结果。 */
export interface EventComparison {
  /** 是否逐条全等。 */
  readonly equal: boolean
  /** 差异清单（最多 5 条；为空 = 全等）。 */
  readonly diffs: readonly string[]
  /** 一行摘要（打印 / 断言消息用）。 */
  readonly summary: string
}

/** 差异清单最多留几条（够定位问题，又不至于刷屏）。 */
const MAX_DIFFS = 5

/** 差异里单条载荷最多渲染多少字符。 */
const MAX_RENDER = 400

/** 一个快照目录的三份文件路径。 */
export function snapshotPaths(dir: string): SnapshotPaths {
  return {
    dir,
    session: join(dir, SESSION_LOG_FILE),
    exchanges: join(dir, 'llm.jsonl'),
    scenario: join(dir, 'scenario.json'),
  }
}

/**
 * 录制一个快照。
 *
 * @param options.dir 快照目录（已存在则**覆盖**：录制是显式动作，不是 CI 的默认行为）
 * @param options.run 跑场景：返回场景输入 + 事件流 + provider 调用序列
 * @throws `BahError('snapshot-invalid')` 事件序列或 exchange 序列不自洽
 */
export async function recordSnapshot(options: {
  readonly dir: string
  readonly run: () => Promise<{
    readonly meta: SnapshotMeta
    readonly events: readonly SessionEvent[]
    readonly exchanges: readonly Exchange[]
  }>
}): Promise<SnapshotSummary> {
  const { meta, events, exchanges } = await options.run()
  const paths = snapshotPaths(options.dir)
  mkdirSync(paths.dir, { recursive: true })

  writeSessionLog(paths.dir, meta.sessionId, events, meta.clock.start)
  writeExchanges(paths.exchanges, exchanges)
  writeFileSync(paths.scenario, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

  return {
    name: meta.name,
    prompts: meta.prompts.length,
    events: events.length,
    exchanges: exchanges.length,
  }
}

/**
 * 读一个快照（回放前调用）。
 *
 * @throws `BahError('snapshot-missing')` 缺任意一份文件（提示怎么录）
 * @throws `BahError('snapshot-invalid')` 文件内容不自洽
 * @throws `BahError('snapshot-mismatch')` session.jsonl 的 header 与 scenario.json 的会话 ID 不一致
 */
export function loadSnapshot(dir: string): LoadedSnapshot {
  const paths = snapshotPaths(dir)
  for (const path of [paths.session, paths.exchanges, paths.scenario]) {
    if (!existsSync(path)) {
      throw new BahError(
        'snapshot-missing',
        `test-support: 缺快照文件 ${path}；录制请跑 \`BAH_SNAPSHOT_RECORD=1 pnpm test:snapshot\`（Windows: \`$env:BAH_SNAPSHOT_RECORD='1'; pnpm test:snapshot\`）`,
        { path },
      )
    }
  }

  const meta = parseMeta(JSON.parse(readFileSync(paths.scenario, 'utf8')) as unknown, paths.scenario)

  // 会话日志按"真日志"的格式读回：header 与会话 ID 必须对得上
  const log = readSessionLog(dir)
  if (log.sessionId !== meta.sessionId) {
    throw new BahError(
      'snapshot-mismatch',
      `test-support: ${paths.session} 的会话 ID（${log.sessionId}）与 scenario.json（${meta.sessionId}）不一致`,
      { session: paths.session, scenario: meta.sessionId },
    )
  }

  return {
    paths,
    meta,
    events: log.events,
    exchanges: readExchanges(paths.exchanges),
  }
}

/**
 * 逐条比对事件流。
 *
 * 比较的是整行 JSON（seq / at / formatVersion / type / data 全部参与）——
 * 「回放全等」的意思就是**模型看到的与用户看到的完全一样**，不能只看 type 序列。
 */
export function compareEvents(
  recorded: readonly SessionEvent[],
  replayed: readonly SessionEvent[],
): EventComparison {
  const diffs: string[] = []
  const common = Math.min(recorded.length, replayed.length)

  for (let index = 0; index < common; index += 1) {
    const left = JSON.stringify(recorded[index])
    const right = JSON.stringify(replayed[index])
    if (left === right) continue
    diffs.push(`#${index + 1}: 录制 ${render(left)} ⟶ 回放 ${render(right)}`)
    if (diffs.length >= MAX_DIFFS) break
  }

  if (recorded.length !== replayed.length) {
    diffs.push(`事件条数：录制 ${recorded.length} / 回放 ${replayed.length}`)
  }

  return {
    equal: diffs.length === 0,
    diffs,
    summary: diffs.length === 0 ? `${recorded.length} 条事件逐条全等` : `${diffs.length} 处差异（最多列 ${MAX_DIFFS} 条）`,
  }
}

/**
 * 比对并**在不等时抛错**（用例里一行断言，报错里带差异）。
 *
 * @throws `BahError('snapshot-mismatch')` 回放与录制不一致
 */
export function assertSameEvents(
  recorded: readonly SessionEvent[],
  replayed: readonly SessionEvent[],
): void {
  const comparison = compareEvents(recorded, replayed)
  if (comparison.equal) return
  throw new BahError(
    'snapshot-mismatch',
    `test-support: 回放与录制不一致：${comparison.diffs.join('\n')}`,
    { diffs: comparison.diffs },
  )
}

/** 打印用的摘要。 */
export function summarize(snapshot: LoadedSnapshot): SnapshotSummary {
  return {
    name: snapshot.meta.name,
    prompts: snapshot.meta.prompts.length,
    events: snapshot.events.length,
    exchanges: snapshot.exchanges.length,
  }
}

/** 选一个快照 fixture 的最高代（与 `selectSnapshot` 同源，登记处留个显式入口）。 */
export function resolveSnapshotFixture(dir: string): string {
  return selectSnapshot(dir).path
}

/** 渲染单条差异（截断，避免刷屏）。 */
function render(text: string): string {
  return text.length <= MAX_RENDER ? text : `${text.slice(0, MAX_RENDER)}…`
}

/**
 * 校验 scenario.json 的形状。
 *
 * @throws `BahError('snapshot-invalid')` 缺字段 / 类型不对
 */
function parseMeta(value: unknown, path: string): SnapshotMeta {
  const fail = (reason: string): never => {
    throw new BahError('snapshot-invalid', `test-support: ${path} 不是合法场景：${reason}`, { path })
  }

  if (typeof value !== 'object' || value === null) return fail('顶层必须是对象')
  const record = value as Record<string, unknown>

  if (typeof record['name'] !== 'string') return fail('缺 name')
  if (typeof record['profile'] !== 'string') return fail('缺 profile')
  if (typeof record['sessionId'] !== 'string') return fail('缺 sessionId')
  if (!Array.isArray(record['prompts']) || record['prompts'].some((item) => typeof item !== 'string')) {
    return fail('prompts 必须是字符串数组')
  }

  const clock = record['clock']
  if (typeof clock !== 'object' || clock === null) return fail('缺 clock')
  const clockRecord = clock as Record<string, unknown>
  if (typeof clockRecord['start'] !== 'number' || typeof clockRecord['step'] !== 'number') {
    return fail('clock 必须是 { start, step } 数字')
  }

  if (typeof record['randomSeed'] !== 'number') return fail('randomSeed 必须是数字')

  const rows = record['rows']
  if (!Array.isArray(rows) || rows.length === 0) return fail('rows 必须是非空数组')
  for (const [index, row] of rows.entries()) {
    if (typeof row !== 'object' || row === null) return fail(`rows[${index}] 必须是对象`)
    const rowRecord = row as Record<string, unknown>
    if (typeof rowRecord['id'] !== 'string' || typeof rowRecord['use'] !== 'string') {
      return fail(`rows[${index}] 缺 id / use`)
    }
  }

  const model = record['model']
  if (typeof model !== 'object' || model === null) return fail('缺 model')
  const modelRecord = model as Record<string, unknown>
  if (typeof modelRecord['provider'] !== 'string') return fail('model.provider 必须是字符串')
  const spec = modelRecord['spec']
  if (typeof spec !== 'object' || spec === null) return fail('缺 model.spec')
  const specRecord = spec as Record<string, unknown>
  if (typeof specRecord['id'] !== 'string' || typeof specRecord['providerId'] !== 'string') {
    return fail('model.spec 缺 id / providerId')
  }

  return {
    name: record['name'] as string,
    profile: record['profile'] as string,
    prompts: record['prompts'] as string[],
    sessionId: record['sessionId'] as string,
    clock: { start: clockRecord['start'] as number, step: clockRecord['step'] as number },
    randomSeed: record['randomSeed'] as number,
    rows: rows as SnapshotRow[],
    model: { provider: modelRecord['provider'] as string, spec: spec as ModelSpec },
  }
}
