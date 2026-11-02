/**
 * 受控词表（设计文档 §4.1）。
 *
 * 关键约束：**predicate 只能是这里的 6 个**。抽取器不许产出词表外的谓词，
 * G1 结构门按此表拒收——这是"记忆不是随便记"的第一道闸，也是对外说明时
 * "为什么不担心开放式记忆污染"的直接答案。
 */

import type { Scene, UnitType } from './types.ts'

/** 一条 retention_basis 种子行（对应 DDL 的 `retention_basis` 表）。 */
export interface RetentionBasisRow {
  readonly predicate: string
  readonly unitType: UnitType
  /** ✓ 表示读取装配前**必须**经影子核验（工具值优先）。 */
  readonly stateful: boolean
  readonly allowedSensitivity: number
  readonly maxRetentionDays: number
  readonly sceneWhitelist: readonly Scene[]
  readonly erasurePolicy: 'logical_then_physical'
  /** 装配文本模板：按 predicate 固化，占位符由 `renderMemoryText` 填充。 */
  readonly renderTemplate: string
}

const ALL_SCENES: readonly Scene[] = [
  'transfer',
  'bills',
  'investment',
  'card',
  'subscription',
  'cross_scene',
]

/**
 * 六条谓词种子。
 *
 * `card_state` 与 `subscription_state` 是唯二的 STATEFUL 谓词：它们的记忆值只能当
 * **路由线索**，永远不能直接进操作建议——卡丢没丢、订阅退没退，只有银行系统说了算。
 */
export const RETENTION_BASIS: readonly RetentionBasisRow[] = [
  {
    predicate: 'preferred_card_for',
    unitType: 'preference',
    stateful: false,
    allowedSensitivity: 1,
    maxRetentionDays: 365,
    sceneWhitelist: ['transfer'],
    erasurePolicy: 'logical_then_physical',
    renderTemplate: '尾号 {card_last4} 的卡是您的转账首选卡。',
  },
  {
    predicate: 'preferred_payee_card',
    unitType: 'preference',
    stateful: false,
    allowedSensitivity: 2,
    maxRetentionDays: 365,
    sceneWhitelist: ['transfer'],
    erasurePolicy: 'logical_then_physical',
    renderTemplate: '给 {payee} 转账时用尾号 {card_last4} 的卡。',
  },
  {
    predicate: 'alias_of',
    unitType: 'entity_fact',
    stateful: false,
    allowedSensitivity: 1,
    maxRetentionDays: 730,
    sceneWhitelist: ALL_SCENES,
    erasurePolicy: 'logical_then_physical',
    renderTemplate: '「{alias}」指的是尾号 {card_last4} 的卡。',
  },
  {
    predicate: 'card_state',
    unitType: 'entity_fact',
    stateful: true,
    allowedSensitivity: 2,
    maxRetentionDays: 90,
    sceneWhitelist: ['card', 'transfer'],
    erasurePolicy: 'logical_then_physical',
    renderTemplate: '尾号 {card_last4} 的卡当前状态：{status}。',
  },
  {
    predicate: 'subscription_state',
    unitType: 'entity_fact',
    stateful: true,
    allowedSensitivity: 2,
    maxRetentionDays: 180,
    sceneWhitelist: ['subscription'],
    erasurePolicy: 'logical_then_physical',
    renderTemplate: '订阅 {subscription} 当前状态：{status}。',
  },
  {
    predicate: 'account_limit_note',
    unitType: 'entity_fact',
    stateful: false,
    allowedSensitivity: 1,
    maxRetentionDays: 180,
    sceneWhitelist: ['transfer'],
    erasurePolicy: 'logical_then_physical',
    renderTemplate: '您提到过单日转账限额：{note}（仅供参考，不构成额度依据）。',
  },
]

/** 谓词 → 种子行（G1/G2 的门线查表用）。 */
export const BASIS_BY_PREDICATE: ReadonlyMap<string, RetentionBasisRow> = new Map(
  RETENTION_BASIS.map((row) => [row.predicate, row]),
)

/** STATEFUL 谓词集合：读取前 100% 过影子核验（T3.3 断言的依据）。 */
export const STATEFUL_PREDICATES: ReadonlySet<string> = new Set(
  RETENTION_BASIS.filter((row) => row.stateful).map((row) => row.predicate),
)

export const KNOWN_PREDICATES: ReadonlySet<string> = new Set(RETENTION_BASIS.map((row) => row.predicate))

/**
 * 按 predicate 渲染自然语言文本。
 *
 * 不自由生成：模板固定，只做占位符替换。缺值 → 该处留空，而不是抛错——
 * 装配阶段宁可少一句话，也不能因为一个字段缺失让整轮检索崩掉。
 */
export function renderMemoryText(predicate: string, values: Readonly<Record<string, string>>): string {
  const row = BASIS_BY_PREDICATE.get(predicate)
  if (row === undefined) return ''
  return row.renderTemplate.replace(/\{(\w+)\}/g, (_whole, key: string) => values[key] ?? '')
}
