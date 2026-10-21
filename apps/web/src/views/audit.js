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
 * @param {Record<string, any>[]} frames
 */
export function renderAuditSummary(frames) {
  const audits = frames.filter((frame) => frame.kind === 'audit')
  const approvals = audits.filter((frame) => frame.category === 'approval' && frame.label === '审批请求').length
  const rejected = audits.filter(
    (frame) => frame.category === 'approval' && frame.summary.startsWith('已拒绝'),
  ).length
  const blocked = audits.filter((frame) => frame.code === 'blocked' || frame.summary.includes('已阻断')).length

  return el('div', { class: 'audit__summary' }, [
    chip('审批', approvals),
    chip('拒绝', rejected),
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
