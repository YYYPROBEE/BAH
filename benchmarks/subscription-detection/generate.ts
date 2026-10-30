/**
 * 订阅检测的**标注夹具生成器**（场景 5 §10）。
 *
 * 产物是人工可读的 JSON：`{ now, windowDays, transactions, series }`。
 * `series[].merchantKey` 是人工标注的预期键；`metric` 脚本按它算分层 precision/recall。
 *
 * **诚实边界**：这是**合成标注集**，不是真实银行流水。它能回答"算法在已知模式的
 * 脏名/边界上是否按设计工作"，不能回答"真实世界准确率"。答辩必须同句说清。
 *
 * 生成是确定性的（固定 now + 固定偏移，无随机源），重跑逐字节相同。
 * 运行：`npx tsx benchmarks/subscription-detection/generate.ts`
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DAY_MS } from '../../packages/bank/src/core/time.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const NOW = Date.UTC(2026, 9, 30, 2, 0, 0)

interface FixtureTxn {
  readonly id: string
  readonly at: number
  readonly amountCents: number
  readonly name: string
  readonly direction: 'out'
  readonly status: 'success'
  readonly category: 'subscription' | 'consumption'
}

interface FixtureSeries {
  readonly merchantKey: string
  readonly cycle: 'weekly' | 'monthly' | 'quarterly'
  readonly kind: 'subscription' | 'bill' | 'installment'
  readonly txnIds: readonly string[]
  readonly nextChargeAt: number
}

interface Fixture {
  readonly name: string
  readonly now: number
  readonly windowDays: number
  readonly transactions: readonly FixtureTxn[]
  readonly series: readonly FixtureSeries[]
}

let sequence = 0

/** 序号 → 唯一字母码（A..Z, AA..）：商户名里的数字会被归一化剥掉，标签不能用数字区分。 */
function code(index: number): string {
  let value = index
  let text = ''
  while (value > 0) {
    value -= 1
    text = String.fromCharCode(65 + (value % 26)) + text
    value = Math.floor(value / 26)
  }
  return text
}

function txn(name: string, at: number, amountCents: number, category: FixtureTxn['category'] = 'subscription'): FixtureTxn {
  sequence += 1
  return { id: `t-${sequence}`, at, amountCents, name, direction: 'out', status: 'success', category }
}

function monthly(key: string, name: string, amounts: readonly number[], lastAt: number): { txns: FixtureTxn[]; series: FixtureSeries } {
  const txns = amounts.map((amount, index) =>
    txn(name, lastAt - (amounts.length - 1 - index) * 30 * DAY_MS, amount),
  )
  return {
    txns,
    series: { merchantKey: key, cycle: 'monthly', kind: 'subscription', txnIds: txns.map((item) => item.id), nextChargeAt: lastAt + 30 * DAY_MS },
  }
}

function weekly(key: string, name: string, amountCents: number, count: number, lastAt: number): { txns: FixtureTxn[]; series: FixtureSeries } {
  const txns = Array.from({ length: count }, (_, index) =>
    txn(name, lastAt - (count - 1 - index) * 7 * DAY_MS, amountCents),
  )
  return {
    txns,
    series: { merchantKey: key, cycle: 'weekly', kind: 'subscription', txnIds: txns.map((item) => item.id), nextChargeAt: lastAt + 7 * DAY_MS },
  }
}

function quarterly(key: string, name: string, amountCents: number, count: number, lastAt: number): { txns: FixtureTxn[]; series: FixtureSeries } {
  const txns = Array.from({ length: count }, (_, index) =>
    txn(name, lastAt - (count - 1 - index) * 90 * DAY_MS, amountCents),
  )
  return {
    txns,
    series: { merchantKey: key, cycle: 'quarterly', kind: 'subscription', txnIds: txns.map((item) => item.id), nextChargeAt: lastAt + 90 * DAY_MS },
  }
}

function oneOff(name: string, offsetDays: number, amountCents: number): FixtureTxn {
  return txn(name, NOW - offsetDays * DAY_MS, amountCents, 'consumption')
}

/* ── clean-24 ─────────────────────────────────────────────────────────────── */

function buildClean(): Fixture {
  const transactions: FixtureTxn[] = []
  const series: FixtureSeries[] = []
  const last = NOW - DAY_MS
  for (let index = 1; index <= 16; index += 1) {
    const label = `订阅商户${code(index)}`.toLowerCase()
    // 两个带涨价（30→35 的形状），其余稳定
    const amounts =
      index <= 2
        ? [3000, 3000, 3000, 3500, 3500, 3500]
        : Array.from({ length: 6 }, () => 1200 + index * 300)
    const built = monthly(label, label, amounts, last - index * 60_000)
    transactions.push(...built.txns)
    series.push(built.series)
  }
  for (let index = 1; index <= 4; index += 1) {
    const label = `周付商户${code(index)}`.toLowerCase()
    const built = weekly(label, `周付商户${code(index)}`, 600, 8, last - index * 60_000)
    transactions.push(...built.txns)
    series.push(built.series)
  }
  for (let index = 1; index <= 4; index += 1) {
    const label = `季付商户${code(index)}`.toLowerCase()
    const built = quarterly(label, `季付商户${code(index)}`, 4500, 3, NOW)
    transactions.push(...built.txns)
    series.push(built.series)
  }
  for (let index = 1; index <= 20; index += 1) {
    transactions.push(oneOff(`单次商户${code(index)}`, 3 + index * 7, 5000 + index * 1111))
  }
  return { name: 'clean-24', now: NOW, windowDays: 180, transactions, series }
}

/* ── dirty-40 ─────────────────────────────────────────────────────────────── */

function buildDirty(): Fixture {
  const transactions: FixtureTxn[] = []
  const series: FixtureSeries[] = []
  const last = NOW - DAY_MS
  for (let index = 1; index <= 40; index += 1) {
    const id = code(index)
    const variant = index % 4
    const raw =
      variant === 0
        ? `STM*DIRTY${id}`
        : variant === 1
          ? `支付宝-会员${id}`
          : variant === 2
            ? `财付通-商户${id}(朝阳店)`
            : `会员${id}#${String(100 + index)}`
    const lower = id.toLowerCase()
    const key =
      variant === 0
        ? `dirty${lower}`
        : variant === 1
          ? `会员${lower}`
          : variant === 2
            ? `商户${lower}`
            : `会员${lower}`
    const cycle = index % 5 === 0 ? 'weekly' : index % 7 === 0 ? 'quarterly' : 'monthly'
    const built =
      cycle === 'weekly'
        ? weekly(key, raw, 800, 8, last - index * 60_000)
        : cycle === 'quarterly'
          ? quarterly(key, raw, 6600, 3, NOW)
          : monthly(key, raw, Array.from({ length: 5 }, () => 990 + index * 137), last - index * 60_000)
    // 5 条混用干净名，验证归一化合并
    if (index <= 5) built.txns[built.txns.length - 1] = { ...built.txns[built.txns.length - 1]!, name: `会员${id}` }
    transactions.push(...built.txns)
    series.push(built.series)
  }
  for (let index = 1; index <= 40; index += 1) {
    transactions.push(oneOff(`STM*一次性${code(index)}`, 2 + index * 4, 8000 + index * 777))
  }
  return { name: 'dirty-40', now: NOW, windowDays: 180, transactions, series }
}

/* ── edge-18 ──────────────────────────────────────────────────────────────── */

function buildEdge(): Fixture {
  const transactions: FixtureTxn[] = []
  const series: FixtureSeries[] = []
  const push = (built: { txns: FixtureTxn[]; series: FixtureSeries }): void => {
    transactions.push(...built.txns)
    series.push(built.series)
  }

  // 1 月末漂移（12-31 / 1-31 / 2-28）
  const monthEnd = [
    txn('月末会员', Date.UTC(2025, 11, 31, 2), 3000),
    txn('月末会员', Date.UTC(2026, 0, 31, 2), 3000),
    txn('月末会员', Date.UTC(2026, 1, 28, 2), 3000),
  ]
  transactions.push(...monthEnd)
  series.push({ merchantKey: '月末会员', cycle: 'monthly', kind: 'subscription', txnIds: monthEnd.map((item) => item.id), nextChargeAt: Date.UTC(2026, 2, 31, 2) })

  // 3 春节顺延 5 天
  const festivalOffsets = [0, 30, 60, 95, 125]
  const festival = festivalOffsets.map((offset) => txn('春节会员', NOW - DAY_MS - (125 - offset) * DAY_MS, 3000))
  transactions.push(...festival)
  series.push({ merchantKey: '春节会员', cycle: 'monthly', kind: 'subscription', txnIds: festival.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  // 4 涨价 30→35；5 单次购买混入；6 房租；7 水电；8 12 期递减；9 试用；10 重复扣款；11 脏名混用；13 等额 12 期
  push(monthly('涨价会员', '涨价会员', [3000, 3000, 3000, 3500, 3500, 3500], NOW - DAY_MS))
  const buy = monthly('单次混入会员', '单次混入会员', [3000, 3000, 3000, 3000], NOW - 31 * DAY_MS)
  push(buy)
  transactions.push(txn('单次混入会员', NOW - 2 * DAY_MS, 30_000, 'consumption'))

  const rent = Array.from({ length: 6 }, (_, index) => txn('房租-王房东', NOW - DAY_MS - (5 - index) * 30 * DAY_MS, 450_000, 'consumption'))
  transactions.push(...rent)
  series.push({ merchantKey: '房租王房东', cycle: 'monthly', kind: 'bill', txnIds: rent.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  const waterAmounts = [15_500, 20_500, 16_000, 20_000, 15_200, 20_700]
  const water = waterAmounts.map((amount, index) => txn('国网电力', NOW - DAY_MS - (5 - index) * 30 * DAY_MS, amount, 'consumption'))
  transactions.push(...water)
  series.push({ merchantKey: '国网电力', cycle: 'monthly', kind: 'bill', txnIds: water.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  const installment = Array.from({ length: 12 }, (_, index) =>
    txn('XX商城分期', NOW - (11 - index) * 30 * DAY_MS, 89_900 - index * 900, 'consumption'),
  )
  transactions.push(...installment)
  series.push({ merchantKey: 'xx商城分期', cycle: 'monthly', kind: 'installment', txnIds: installment.map((item) => item.id), nextChargeAt: NOW + 30 * DAY_MS })

  const trial = [0, 3000, 3000, 3000].map((amount, index) =>
    txn('试用会员', NOW - DAY_MS - (3 - index) * 30 * DAY_MS, amount),
  )
  transactions.push(...trial)
  series.push({ merchantKey: '试用会员', cycle: 'monthly', kind: 'subscription', txnIds: trial.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  const duplicate = [
    txn('重复扣款会员', NOW - 61 * DAY_MS, 1200),
    txn('重复扣款会员', NOW - 60 * DAY_MS, 1200),
    txn('重复扣款会员', NOW - 31 * DAY_MS, 1200),
    txn('重复扣款会员', NOW - DAY_MS, 1200),
  ]
  transactions.push(...duplicate)
  series.push({ merchantKey: '重复扣款会员', cycle: 'monthly', kind: 'subscription', txnIds: duplicate.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  const mixed = [0, 1, 2, 3, 4, 5].map((index) =>
    txn(index < 3 ? 'STM*VIDEO' : '视频会员', NOW - DAY_MS - (5 - index) * 30 * DAY_MS, 3000),
  )
  transactions.push(...mixed)
  series.push({ merchantKey: '视频会员', cycle: 'monthly', kind: 'subscription', txnIds: mixed.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  const equal = Array.from({ length: 12 }, (_, index) => txn('等额会员', NOW - (11 - index) * 30 * DAY_MS, 3000))
  transactions.push(...equal)
  series.push({ merchantKey: '等额会员', cycle: 'monthly', kind: 'subscription', txnIds: equal.map((item) => item.id), nextChargeAt: NOW + 30 * DAY_MS })

  // 12 窗口边界：181 天前的一笔（不标注，检测也不该用它）
  transactions.push(txn('边界会员', NOW - 181 * DAY_MS, 3000))

  // 14/15 只有 2 笔：人工标注为订阅，但算法下限 3 笔 → 预期 FN（诚实暴露召回边界）
  const twoWeekly = [0, 1].map((index) => txn('两笔周付', NOW - DAY_MS - (1 - index) * 7 * DAY_MS, 600))
  transactions.push(...twoWeekly)
  series.push({ merchantKey: '两笔周付', cycle: 'weekly', kind: 'subscription', txnIds: twoWeekly.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 7 * DAY_MS })
  const twoMonthly = [0, 1].map((index) => txn('两笔月付', NOW - DAY_MS - (1 - index) * 30 * DAY_MS, 1200))
  transactions.push(...twoMonthly)
  series.push({ merchantKey: '两笔月付', cycle: 'monthly', kind: 'subscription', txnIds: twoMonthly.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  // 16 季度 5 期；17 大额月度；18 三段跳变账单
  push(quarterly('季度会员', '季度会员', 4500, 5, NOW - DAY_MS))
  push(monthly('大额会员', '大额会员', Array.from({ length: 6 }, () => 199_000), NOW - DAY_MS))
  const noisy = [10_000, 12_000, 9_000, 15_000, 11_000, 20_000].map((amount, index) =>
    txn('波动账单', NOW - DAY_MS - (5 - index) * 30 * DAY_MS, amount, 'consumption'),
  )
  transactions.push(...noisy)
  series.push({ merchantKey: '波动账单', cycle: 'monthly', kind: 'bill', txnIds: noisy.map((item) => item.id), nextChargeAt: NOW - DAY_MS + 30 * DAY_MS })

  return { name: 'edge-18', now: NOW, windowDays: 400, transactions, series }
}

/* ── 写盘 ─────────────────────────────────────────────────────────────────── */

function writeFixture(fixture: Fixture): void {
  // 去重 id 并排序输出，保证重跑逐字节一致
  const transactions = [...fixture.transactions].sort((left, right) => left.at - right.at || (left.id < right.id ? -1 : 1))
  const payload = { ...fixture, transactions }
  writeFileSync(join(HERE, `${fixture.name}.json`), `${JSON.stringify(payload, null, 2)}\n`)
}

mkdirSync(HERE, { recursive: true })
writeFixture(buildClean())
writeFixture(buildDirty())
writeFixture(buildEdge())
console.log('✔ 已生成 clean-24 / dirty-40 / edge-18（合成标注集）')
