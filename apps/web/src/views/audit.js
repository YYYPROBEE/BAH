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
 * 时刻 → 本地 `HH:MM:SS`（审计时间要跟操作者手表一致）。
 *
 * 帧里的 `timeText` 是 UTC（`format.ts` 为了保证跨时区渲染逐字相同）；
 * 界面上直接显示 UTC 会比本地少 8 小时，答辩时"这笔是几点批的"根本对不上。
 * 所以本地化只发生在视图层：帧保持确定性，屏幕显示本地时间，`title` 里附 UTC 供对照。
 */
function timeOf(frame) {
  if (typeof frame.at !== 'number' || !Number.isFinite(frame.at)) return frame.timeText ?? ''
  const date = new Date(frame.at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':')
}

/**
 * 一条审计帧 → 列表项。
 *
 * @param {Record<string, any>} frame
 */
export function renderAudit(frame) {
  const local = timeOf(frame)
  return el('li', { class: 'audit__item', dataset: { category: frame.category, seq: String(frame.seq) } }, [
    el('span', {
      class: 'audit__time',
      text: local,
      title: frame.timeText === undefined ? local : `本地 ${local} · UTC ${frame.timeText}`,
    }),
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
  // `summary` 先判类型再 `startsWith`：帧字段缺失时不能抛 TypeError 把整个面板拆了。
  const summaryOf = (frame) => (typeof frame.summary === 'string' ? frame.summary : '')
  const rejected = audits.filter(
    (frame) =>
      frame.category === 'approval' &&
      frame.label === '审批结论' &&
      (summaryOf(frame).startsWith('已拒绝') || summaryOf(frame).startsWith('无人应答')),
  ).length

  // 取消单独一格：点遮罩 / Esc / 关闭都走 cancelled，且不要求理由。
  // 混进"拒绝"会虚增否决数，吞掉又会让"点遮罩绕过拒绝理由"看起来毫无痕迹——
  // 分开记才既不撒谎也不漏账。
  const cancelled = audits.filter(
    (frame) =>
      frame.category === 'approval' && frame.label === '审批结论' && summaryOf(frame).startsWith('已取消'),
  ).length

  // 阻断按**事故**去重：同一次事故既出"票据已阻断"，也会让轮次以 `blocked` 收尾，
  // 不能各记一笔（那样 1 次阻断会显示成 2）。
  //
  // 去重不能靠 `ticketId`：投影端的 `turn/end` 审计帧压根不带 ticketId（事件载荷只有
  // `{ turn, reason }`）。所以按"两种记账取较大值"合并：一次事故 = 1 票据 + 1 轮次 = 1；
  // 两次独立事故（各自票据 + 轮次）= 2，不会因为简单跳过而把第二次事故吞掉。
  const ticketBlocks = new Set()
  for (const frame of audits) {
    if (frame.category !== 'ticket' || frame.label !== '票据已阻断') continue
    ticketBlocks.add(frame.ticketId ?? `ticket:${String(frame.seq)}`)
  }
  const turnBlocks = new Set()
  for (const frame of audits) {
    // 只认轮次结束帧的 `blocked` 码：工具结果的理由码也可能叫 blocked，那不是"轮次被挡下"。
    if (frame.category !== 'turn' || frame.code !== 'blocked') continue
    turnBlocks.add(frame.ticketId ?? `turn:${String(frame.seq)}`)
  }
  const blocked = Math.max(ticketBlocks.size, turnBlocks.size)

  return el('div', { class: 'audit__summary' }, [
    chip('审批', approvals),
    chip('拒绝', rejected),
    chip('取消', cancelled),
    chip('阻断', blocked),
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
