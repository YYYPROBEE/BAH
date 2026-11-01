/**
 * 账单报告卡的结构化块：从 `read/bill-report` 事件派生，**不读正文、不读时钟**。
 *
 * 为什么必须从事件而不是从正文：`bill_report` 的 `tool/result` 正文是一整段
 * 报告文本（`packages/bank/src/tools/queries.ts` 的 `composeReport`），排版成表格
 * 只能靠字符串反解——和 `aa.ts` / `subscriptions.ts` 同一判断：正文给人读，表格靠结构化数据。
 * `execute()` 里落的 `read/bill-report` 带完整 `analysis`，是唯一可回放的来源。
 *
 * 三条纪律（与 `subscriptions.ts` 一致）：
 * 1. **确定性**：全部输出只依赖事件载荷，两次回放逐字相同（浏览器快照门禁的前提）；
 * 2. **不猜**：字段缺失或形态不对就少一块，绝不补默认值——半张报告卡比没有更糟；
 * 3. **文案同源**：分类中文与账期口径分别镜像 `presenters.ts` 的 `CATEGORY_LABEL`
 *    和 `queries.ts` 的 `REPORT_PERIOD_LABEL`，渠道不发明第三套说法。
 */

import type { CardField, CardTable } from './frames.ts'
import { formatCents } from './format.ts'

/** 卡片上最多列几个收款人（其余只报总数）。 */
export const PAYEE_LIMIT = 5
/** 异常说明最多列几条（其余折叠成计数）。 */
export const ANOMALY_LIMIT = 3

/** 账务分类文案（镜像 `packages/bank/src/tools/presenters.ts` 的 `CATEGORY_LABEL`，两处不许分叉）。 */
const CATEGORY_LABEL: Readonly<Record<string, string>> = {
  transfer: '转账',
  salary: '工资',
  consumption: '消费',
  subscription: '订阅',
  wealth: '理财',
  fee: '手续费',
  refund: '退款',
}

/** 报告口径文案（镜像 `packages/bank/src/tools/queries.ts` 的 `REPORT_PERIOD_LABEL`）。 */
const PERIOD_LABEL: Readonly<Record<string, string>> = {
  month: '月度',
  quarter: '季度',
  year: '年度',
}

/** 账单报告卡的一块：字段 + 表格 + 补充说明。 */
export interface BillReportBlock {
  readonly fields: readonly CardField[]
  readonly table?: CardTable
  readonly note?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function num(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function strArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : undefined
}

/** 百分比（保留两位、去掉多余的 0；与 bank 侧 `percent()` 同口径）。 */
function pctText(value: number): string {
  return `${String(Math.round(value * 100) / 100)}%`
}

/**
 * `read/bill-report` 的事件载荷 → 卡片块。
 *
 * @returns `undefined` = 载荷形态不符（卡片退回正文排版，不抛错也不出半张卡）
 */
export function billReportBlockOf(data: unknown): BillReportBlock | undefined {
  const outer = asRecord(data)
  const result = outer === undefined ? undefined : asRecord(outer['result'])
  const analysis = result === undefined ? undefined : asRecord(result['analysis'])
  if (analysis === undefined) return undefined

  const totalIn = num(analysis, 'totalInCents')
  const totalOut = num(analysis, 'totalOutCents')
  // 收支总额是这张卡的骨架：拿不到就整块不产（宁可退回正文，不拼一张缺了总数的表）
  if (totalIn === undefined || totalOut === undefined) return undefined

  const fields: CardField[] = [{ label: '账期', value: periodText(analysis) }]
  fields.push({ label: '收入', value: formatCents(totalIn), mono: true })
  fields.push({ label: '支出', value: formatCents(totalOut), mono: true })
  const mom = num(analysis, 'momChangePct')
  if (mom !== undefined) fields.push({ label: '环比', value: pctText(mom), mono: true })

  const notes: string[] = []
  const payees = payeeNote(analysis['byPayee'])
  if (payees !== undefined) notes.push(payees)
  const anomalies = anomalyLines(analysis['anomalies'])
  if (anomalies !== undefined) {
    fields.push({ label: '异常', value: `${String(anomalies.count)} 条` })
    if (anomalies.lines.length > 0) notes.push(`异常：${anomalies.lines.join('、')}`)
  }

  const table = categoryTable(analysis['byCategory'])
  return {
    fields,
    ...(table === undefined ? {} : { table }),
    ...(notes.length === 0 ? {} : { note: notes.join('\n') }),
  }
}

/** 账期文案：`2026-08 ~ 2026-10（季度）`；年度口径补"覆盖 N/12 个账期"。 */
function periodText(analysis: Record<string, unknown>): string {
  const months = strArray(analysis['months'])
  const period = typeof analysis['period'] === 'string' ? PERIOD_LABEL[analysis['period']] : undefined
  const covered = num(analysis, 'coveredMonths')
  // 首末两端：`months` 是窗口账期（连续），全列出来会把字段挤成两行
  const span =
    months === undefined || months.length === 0
      ? '账期未知'
      : months.length === 1
        ? months[0]
        : `${months[0]} ~ ${months.at(-1)}`
  const head = `${span}${period === undefined ? '' : `（${period}）`}`
  return covered === undefined ? head : `${head} · 覆盖 ${String(covered)}/12 个账期`
}

/** 分类汇总表（分类 / 金额 / 占比）；一行都拼不出来就不产表。 */
function categoryTable(raw: unknown): CardTable | undefined {
  if (!Array.isArray(raw)) return undefined
  const rows: string[][] = []
  for (const entry of raw) {
    const line = asRecord(entry)
    if (line === undefined) continue
    const category = typeof line['category'] === 'string' ? line['category'] : undefined
    const amountCents = num(line, 'amountCents')
    const sharePct = num(line, 'sharePct')
    if (category === undefined || amountCents === undefined || sharePct === undefined) continue
    rows.push([CATEGORY_LABEL[category] ?? category, formatCents(amountCents), pctText(sharePct)])
  }
  return rows.length === 0 ? undefined : { headers: ['分类', '金额', '占比'], rows }
}

/** 收款人行：`收款人前 5：京东 ¥1,200.00（15.7%）、…`；没有可用条目返回 `undefined`。 */
function payeeNote(raw: unknown): string | undefined {
  if (!Array.isArray(raw)) return undefined
  const items: string[] = []
  let total = 0
  for (const entry of raw) {
    const line = asRecord(entry)
    if (line === undefined) continue
    const payee = typeof line['payee'] === 'string' && line['payee'].length > 0 ? line['payee'] : undefined
    const amountCents = num(line, 'amountCents')
    const sharePct = num(line, 'sharePct')
    if (payee === undefined || amountCents === undefined || sharePct === undefined) continue
    total += 1
    if (items.length < PAYEE_LIMIT) items.push(`${payee} ${formatCents(amountCents)}（${pctText(sharePct)}）`)
  }
  if (items.length === 0) return undefined
  const rest = total > items.length ? `（共 ${String(total)} 项，下列前 ${String(items.length)} 项）` : ''
  return `收款人前 ${String(items.length)}：${items.join('、')}${rest}`
}

/** 异常：计数 + 可读说明（说明取事件里的 `note`，超出上限只报数）。 */
function anomalyLines(raw: unknown): { count: number; lines: readonly string[] } | undefined {
  if (!Array.isArray(raw)) return undefined
  const lines: string[] = []
  for (const entry of raw) {
    const item = asRecord(entry)
    const note = item === undefined ? undefined : item['note']
    if (typeof note === 'string' && note.length > 0 && lines.length < ANOMALY_LIMIT) lines.push(note)
  }
  return { count: raw.length, lines }
}
