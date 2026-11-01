/**
 * 生日主动检测（04 单）：从**已有的事实账本**扫描，不另造画像存储。
 *
 * 数据源是 `fact:store` 的 `LifeFact`（结构化字段 `kind='birthday'` + `date`），
 * 所以本模块**不做文本约定格式**：用户说"记住我爱人生日 3 月 8 日"，模型写
 * `kind='birthday', date='YYYY-MM-DD'`，这里只取月/日。
 *
 * 三条纪律：
 * 1. 规则写死在代码里（提前 3 天；不是每用户配置）；
 * 2. 幂等键 `birthday:<factId>:<YYYY>`——同一生日一年只提醒一次；
 * 3. 一条脏事实（缺日期 / 日期非法）**静默跳过**，不抛错拖垮整轮扫描。
 *
 * 投递一律走 `PROACTIVE_SERVICE.push`（ADR-0016 的唯一通道）：
 * 预算、静默时段、去重、落账都在那边，本模块只负责"该说什么"。
 */

import type { LifeFact } from '@bah/runtime'

import { logJson } from './log.ts'
import type { ProactiveCandidate, ProactiveDelivery, ProactiveService } from './proactive.ts'

const DAY_MS = 86_400_000
/** UTC+8（与 `proactive.ts` 的 wallOf 同源口径：提醒的"今天"必须一致）。 */
const CST_OFFSET_MS = 8 * 3_600_000

/** 默认提前量（天）。**写死**：赛题没要求可配，配置面每加一个键门禁就多验一处。 */
export const BIRTHDAY_AHEAD_DAYS = 3

/** 时区口径下的日历字段。 */
interface WallDate {
  readonly year: number
  readonly month: number
  readonly day: number
}

/** 一次生日命中（含闰日归一后的实际月日）。 */
export interface BirthdayOccurrence {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly daysUntil: number
}

function wallOf(at: number): WallDate {
  const shifted = new Date(at + CST_OFFSET_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/**
 * 解析事实里的生日：只认合法的 `YYYY-MM-DD`，但**年份只用于校验、不参与提醒**。
 *
 * 校验到"该月该日真实存在"：`1990-02-30` 这类脏数据在这里被丢掉，
 * 而不是在 `Date.UTC` 里悄悄滚到 3 月 2 日。
 *
 * 闰日特殊：用户往往不知道出生年是不是闰年，模型也可能写成 `2026-02-29`。
 * 只要月/日是合法的 2 月 29 日就接受；平年怎么算见 `occurrenceOf`（3 月 1 日）。
 * 校验基准用闰年 2000 做"日是否存在"的探针。
 */
export function parseBirthday(date: string | undefined): { month: number; day: number } | undefined {
  if (date === undefined) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) return undefined
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined
  const probe = new Date(Date.UTC(2000, month - 1, day))
  if (probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return undefined
  return { month, day }
}

/**
 * 下一次生日（含今天）与剩余天数。
 *
 * 闰日：`Date.UTC(平年, 1, 29)` 会滚到 3 月 1 日——这就是任务书要的
 * "2 月 29 日按平年 3 月 1 日处理"，不另写分支。返回的 `month/day` 是**归一后**的
 * 实际日期，提醒文案里说的日期与真正要过的日期一致。
 */
export function occurrenceOf(
  month: number,
  day: number,
  at: number,
): BirthdayOccurrence | undefined {
  const today = wallOf(at)
  const todayEpochDay = Date.UTC(today.year, today.month - 1, today.day)
  for (const year of [today.year, today.year + 1]) {
    const target = Date.UTC(year, month - 1, day)
    const daysUntil = Math.round((target - todayEpochDay) / DAY_MS)
    if (daysUntil < 0) continue
    const shifted = new Date(target)
    return {
      year,
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      daysUntil,
    }
  }
  return undefined
}

/** 提醒正文：带可执行下一步，不只说"快到了"。 */
function titleOf(person: string, occurrence: BirthdayOccurrence): string {
  if (occurrence.daysUntil === 0) {
    return (
      `今天是${person}的生日（${String(occurrence.month)} 月 ${String(occurrence.day)} 日）。` +
      `要现在安排鲜花/蛋糕吗？回复"给${person}订生日计划"即可。`
    )
  }
  return (
    `${String(occurrence.daysUntil)} 天后是${person}的生日` +
    `（${String(occurrence.month)} 月 ${String(occurrence.day)} 日）。` +
    `要现在锁定 1000 元预算并安排鲜花/蛋糕吗？回复"给${person}订生日计划"即可。`
  )
}

/**
 * 候选生成（**纯函数**：不读时钟、不读随机、不写账本）。
 *
 * 只认 `kind='birthday'` 且有合法 `date` 的事实；进 3 天窗口（含当天）才出候选。
 * 键带目标年份：今年提醒过，明年同一条事实还会再提醒一次。
 */
export function birthdayCandidatesOf(
  facts: readonly LifeFact[],
  at: number,
): readonly ProactiveCandidate[] {
  const candidates: ProactiveCandidate[] = []
  for (const fact of facts) {
    if (fact.kind !== 'birthday') continue
    const birthday = parseBirthday(fact.date)
    if (birthday === undefined) continue
    const occurrence = occurrenceOf(birthday.month, birthday.day, at)
    if (occurrence === undefined || occurrence.daysUntil > BIRTHDAY_AHEAD_DAYS) continue
    candidates.push({
      source: 'birthday',
      key: `birthday:${fact.factId}:${String(occurrence.year)}`,
      // 生日是用户自己记录过的事 → `decision` 档（静默时段不推，但没有同档最小间隔）
      priority: 'decision',
      at,
      title: titleOf(fact.person, occurrence),
    })
  }
  return candidates
}

/** 一次生日扫描的依赖（纯注入：单测直接喂账本与 `push`）。 */
export interface BirthdayScanDeps {
  readonly now: () => number
  /** 事实账本视图；未装配 `fact:store` 时返回 `undefined`（静默跳过整轮）。 */
  readonly facts: () => readonly LifeFact[] | undefined
  readonly push: ProactiveService['push']
}

/**
 * 扫一次并逐条投递。
 *
 * 任何一条失败都不影响其余条目；脏事实在 `birthdayCandidatesOf` 里已被过滤。
 */
export async function scanBirthdays(
  deps: BirthdayScanDeps,
): Promise<readonly ProactiveDelivery[]> {
  const facts = deps.facts()
  if (facts === undefined || facts.length === 0) return []
  const candidates = birthdayCandidatesOf(facts, deps.now())
  const delivered: ProactiveDelivery[] = []
  for (const candidate of candidates) {
    try {
      delivered.push(await deps.push(candidate))
    } catch (error) {
      logJson('warn', 'host.birthday-push-failed', {
        key: candidate.key,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return delivered
}
