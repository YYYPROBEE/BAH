/**
 * 审计时间线（施工单 13 §2.1 最后一行：决策链 + 理由码 + 票据生命周期）。
 *
 * 答辩用途：三秒内能指给人看"这笔转账被谁批准、票据什么时候核销、拦截理由码是什么"。
 * 因此每条都带时刻、分类、理由码（等宽）与可回跳的 `seq`。
 */

import { el } from '../dom.js'

/** 分类 → 文案。 */
const CATEGORY = {
  approval: '审批',
  ticket: '票据',
  tool: '工具',
  safety: '安全',
  knowledge: '知识',
  turn: '轮次',
}

/**
 * 一条审计帧 → 列表项。
 *
 * @param {Record<string, any>} frame
 */
export function renderAudit(frame) {
  return el('li', { class: 'audit__item', dataset: { category: frame.category, seq: String(frame.seq) } }, [
    el('span', { class: 'audit__time', text: frame.timeText }),
    el('span', { class: `audit__category audit__category--${frame.category}`, text: CATEGORY[frame.category] ?? frame.category }),
    el('div', { class: 'audit__body' }, [
      el('div', { class: 'audit__label', text: frame.label }),
      el('div', { class: 'audit__detail', text: frame.summary }),
      ...(frame.code === undefined ? [] : [el('code', { class: 'ds-code audit__code', text: frame.code })]),
    ]),
    el('span', { class: 'audit__seq', text: `#${String(frame.seq)}` }),
  ])
}

/**
 * 计数条（审批 / 拒绝 / 阻断）。
 *
 * 判据的**唯一事实源是投影端** `packages/channels/src/web/audit.ts`：
 * - 审批结论帧：`category='approval'` + `label='审批结论'`，summary 前缀取自
 *   `DECISION_LABEL`（`已批准（一次性）` / `已拒绝` / `已取消` / `无人应答（视为拒绝）`）；
 * - 票据阻断帧：`category='ticket'` + `label='票据已阻断'`（"已阻断"在 **label** 里，
 *   summary 只是工具名，`code` 是 `approval-timeout` 这类理由码）。
 *
 * 这里曾经写成 `summary.startsWith('已拒绝')` 与 `summary.includes('已阻断')`：
 * 超时未应答的那条结论 summary 是"无人应答（视为拒绝）…"、阻断那条的"已阻断"在 label 上，
 * 于是时间线明明写着"票据已阻断 / 无人应答（视为拒绝）"，计数条却显示 `0 拒绝 0 阻断`。
 * 显式点"拒绝"的路径反而计数正确——所以这个错只在**没人应答**时暴露，正好是最需要它说话的时候。
 *
 * @param {Record<string, any>[]} frames
 */
export function renderAuditSummary(frames) {
  const audits = frames.filter((frame) => frame.kind === 'audit')
  const approvals = audits.filter((frame) => frame.category === 'approval' && frame.label === '审批请求').length

  // 拒绝 = 结论是"已拒绝"或"无人应答（视为拒绝）"。`已取消` 不计：那是本地关窗，不是判决被否。
  const rejected = audits.filter(
    (frame) =>
      frame.category === 'approval' &&
      frame.label === '审批结论' &&
      (frame.summary.startsWith('已拒绝') || frame.summary.startsWith('无人应答')),
  ).length

  // 阻断按票据去重：同一次事故既可能出"票据已阻断"，也可能让轮次以 `blocked` 收尾，
  // 不能各记一笔（那样 1 次阻断会显示成 2）。
  const blockedKeys = new Set()
  for (const frame of audits) {
    const isTicketBlock = frame.category === 'ticket' && frame.label === '票据已阻断'
    const isTurnBlock = frame.code === 'blocked'
    if (!isTicketBlock && !isTurnBlock) continue
    blockedKeys.add(frame.ticketId ?? `${frame.category}:${String(frame.seq)}`)
  }

  return el('div', { class: 'audit__summary' }, [
    chip('审批', approvals),
    chip('拒绝', rejected),
    chip('阻断', blockedKeys.size),
  ])
}

/** 一个计数。 */
function chip(label, value) {
  return el('div', { class: 'audit__stat' }, [
    el('span', { class: 'audit__stat-value', text: String(value) }),
    el('span', { class: 'audit__stat-label', text: label }),
  ])
}

/** 空态。 */
export function renderAuditEmpty() {
  return el('div', { class: 'ds-empty' }, [
    el('p', { class: 'ds-empty__title', text: '还没有判决记录' }),
    el('p', { class: 'ds-empty__desc', text: '审批、票据、拦截理由码都会出现在这里。' }),
  ])
}
