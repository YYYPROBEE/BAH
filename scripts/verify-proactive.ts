#!/usr/bin/env tsx
/**
 * 门禁：跨场景主动能力的不变量（I13–I17）。
 *
 * | 编号 | 判据 | 坏样本 |
 * |---|---|---|
 * | I13 | 快照里每条带 `inputs` 的窗口判决，digest 必须等于输入的规范化摘要；执行成功的那次 digest 必须出现在 `ticket/approved.authorization` | 改一个余额数字 → digest 对不上 |
 * | I14 | `plan_wake` 必须 `exposure:'internal'`；模型装配侧必须按 exposure 过滤 | 把 wake 注册成模型可见 |
 * | I15 | 同一实例第二次唤醒必须 `skipped/already-ran`，且 `plan/created` 只有一条 | 重复扣款 |
 * | I16 | `authorization/` 与 `notify/` 不出现 Date / Math.random / append / appendDomain / setTimeout | 判定里读了真实时钟 |
 * | I17 | 唤醒执行链（plan.ts / scheduler.ts）不 import `@bah/llm` | 执行期偷偷调模型 |
 *
 * 反例自测：`scripts/verify-proactive.test.ts` 用坏样本证明每条都能红。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson, sha256Hex } from '@bah/util'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 快照里一条 `plan_wake` 报告的条目（只取门禁关心的字段）。 */
export interface WakeEntryLike {
  readonly status: string
  readonly reason?: string
  readonly digest?: string
  readonly inputs?: unknown
  readonly authorizationDigestSeen?: string
}

/** I13 的纯判定：digest 必须等于 inputs 的规范化摘要。 */
export function checkDigests(entries: readonly WakeEntryLike[]): string[] {
  const findings: string[] = []
  let checked = 0
  for (const entry of entries) {
    if (entry.digest === undefined || entry.inputs === undefined) continue
    checked += 1
    if (sha256Hex(canonicalJson(entry.inputs)) !== entry.digest) {
      findings.push(`I13 判决 digest 与 inputs 不一致（${entry.digest.slice(0, 8)}…）`)
    }
  }
  if (checked === 0) findings.push('I13 快照里没有任何带 inputs 的窗口判决 —— "没扫到"不能当"通过"')
  return findings
}

/** I13 的第二半：执行成功的 digest 必须出现在票据的 authorization 里。 */
export function checkTicketWitness(
  executed: readonly { readonly digest?: string }[],
  ticketDigests: readonly string[],
): string[] {
  const findings: string[] = []
  for (const entry of executed) {
    if (entry.digest === undefined) continue
    if (!ticketDigests.includes(entry.digest)) {
      findings.push(`I13 执行成功的窗口 digest 没有出现在任何 ticket/approved.authorization 里`)
    }
  }
  return findings
}

/** I15：第二次唤醒必须 already-ran，且 plan/created 恰好一条。 */
export function checkIdempotency(
  secondEntries: readonly WakeEntryLike[],
  planCreatedCount: number,
): string[] {
  const findings: string[] = []
  if (planCreatedCount > 1) {
    findings.push(`I15 同一实例产生了 ${String(planCreatedCount)} 条 plan/created（重复执行）`)
  }
  const skipped = secondEntries.some(
    (entry) => entry.status === 'skipped' && entry.reason === 'already-ran',
  )
  if (!skipped) findings.push('I15 第二次唤醒没有 skipped/already-ran 条目')
  return findings
}

/** I16：五禁（按**词**判，注释也算——纪律写在源码里就该被扫到）。 */
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\bDate\b/, why: 'Date' },
  { pattern: /\bMath\.random\b/, why: 'Math.random' },
  { pattern: /\bappendDomain\b/, why: 'appendDomain' },
  { pattern: /\.append\s*\(/, why: '.append(' },
  { pattern: /\bsetTimeout\b/, why: 'setTimeout' },
]

/** I16 的纯判定：`files` 是「路径 → 源码」。 */
export function checkForbiddenSources(files: Readonly<Record<string, string>>): string[] {
  const findings: string[] = []
  for (const [path, source] of Object.entries(files)) {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(source)) findings.push(`I16 ${path}: 出现 ${rule.why}（纯函数面禁止）`)
    }
  }
  return findings
}

/** I17 的纯判定：唤醒执行链不得 import LLM 适配器。 */
export function checkNoLlm(sources: Readonly<Record<string, string>>): string[] {
  const findings: string[] = []
  for (const [path, source] of Object.entries(sources)) {
    if (/from\s+['"]@bah\/llm['"]/.test(source)) {
      findings.push(`I17 ${path}: 唤醒执行链 import 了 @bah/llm（执行期不得调模型）`)
    }
  }
  return findings
}

/** 读快照里的 `plan_wake` 报告（正文是 JSON）。 */
function readWakeReports(path: string): { readonly entries: WakeEntryLike[]; readonly raw: string } {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { entries: [], raw: '' }
  }
  const entries: WakeEntryLike[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"tool/result"') || !line.includes('"plan_wake"')) continue
    const parsed = JSON.parse(line) as {
      data?: { content?: readonly { text?: string }[] }
    }
    const body = parsed.data?.content?.[0]?.text
    if (body === undefined) continue
    const report = JSON.parse(body) as { entries?: readonly WakeEntryLike[] }
    entries.push(...(report.entries ?? []))
  }
  return { entries, raw: text }
}

const gate: Gate = {
  name: 'proactive',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    const snapshotPath = join(root, 'snapshots/proactive/session.jsonl')
    const { entries, raw } = readWakeReports(snapshotPath)
    findings.push(...checkDigests(entries.filter((entry) => entry.status !== 'skipped')))
    findings.push(
      ...checkIdempotency(
        entries.filter((entry) => entry.status === 'skipped'),
        (raw.match(/"type":"plan\/created"/g) ?? []).length,
      ),
    )

    // 票据侧的授权 digest（I13 第二半）
    const ticketDigests: string[] = []
    if (raw !== '') {
      for (const line of raw.split('\n')) {
        if (!line.includes('"type":"ticket/approved"')) continue
        const parsed = JSON.parse(line) as { data?: { authorization?: { digest?: string } } }
        const digest = parsed.data?.authorization?.digest
        if (digest !== undefined) ticketDigests.push(digest)
      }
    }
    findings.push(
      ...checkTicketWitness(
        entries.filter((entry) => entry.status === 'executed'),
        ticketDigests,
      ),
    )

    // I14：wake 对模型隐身
    const planSource = readFileSync(join(root, 'packages/host/src/boot/plugins/plan.ts'), 'utf8')
    if (!/name:\s*PLAN_WAKE_TOOL[\s\S]{0,600}?exposure:\s*'internal'/.test(planSource)) {
      findings.push("I14 plan_wake 未声明 exposure:'internal'（模型能提前唤醒计划）")
    }
    const assemble = readFileSync(join(root, 'packages/runtime/src/agent-loop/request.ts'), 'utf8')
    if (!/exposure\s*!==\s*'internal'/.test(assemble)) {
      findings.push('I14 模型装配侧没有按 exposure 过滤')
    }

    // I16：纯函数面五禁
    const pureFiles: Record<string, string> = {}
    for (const file of walk(root, ['packages/runtime/src/authorization', 'packages/runtime/src/notify'], (name) =>
      name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )) {
      pureFiles[file] = readFileSync(file, 'utf8')
    }
    findings.push(...checkForbiddenSources(pureFiles))

    // I17：唤醒链无 LLM
    findings.push(
      ...checkNoLlm({
        'packages/host/src/boot/plugins/plan.ts': planSource,
        'packages/host/src/boot/plugins/scheduler.ts': readFileSync(
          join(root, 'packages/host/src/boot/plugins/scheduler.ts'),
          'utf8',
        ),
      }),
    )

    notes.push(`快照唤醒条目 ${String(entries.length)} 条；票据授权 ${String(ticketDigests.length)} 张`)
    notes.push(`I16 扫描 ${String(Object.keys(pureFiles).length)} 个纯函数源文件`)
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
