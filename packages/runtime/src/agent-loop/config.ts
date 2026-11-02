/**
 * 主循环配置（阈值 / 路由 / 采样参数）的校验面。
 *
 * 从 `agent.ts` 拆出：状态机与"配置怎么解析"是两种变化原因；这里只做纯校验，
 * 不依赖 Context / Session。
 */

import { BahError } from '@bah/util'

import type { LlmParams } from '@bah/llm'

import { resolveCompactionConfig } from '../compaction/summarize.ts'
import type { CompactionThresholds } from '../compaction/types.ts'

/** 单 turn 的 step 数上限（防"模型无限要工具"；可调项一律走配置， 第 4 条）。 */
export const DEFAULT_MAX_STEPS = 32

/** 允许的配置键（未知键 fail-loud）。 */
const CONFIG_KEYS = new Set(['model', 'params', 'compaction', 'maxSteps', 'parallelReadTools'])

/** 允许的采样参数键（其余一律拒绝：静默忽略会让"调了没生效"成为隐藏行为）。 */
const PARAM_KEYS = new Set(['temperature', 'topP', 'maxTokens', 'stop'])

/** 校验后的主循环配置。 */
export interface AgentLoopConfig {
  /** 首选模型路由（`provider:model` 或裸模型名；`agent/request` 可再改写）。 */
  readonly model: string
  readonly params?: LlmParams
  /** 上下文压缩阈值（缺省 = 本 agent 不做压缩；主循环在 turn 边界判定）。 */
  readonly compaction?: CompactionThresholds
  /** 单 turn step 上限（缺省 `DEFAULT_MAX_STEPS`）。 */
  readonly maxSteps: number
  /** 同批连续 green 只读工具是否并发执行（缺省 true；写/审批永远串行）。 */
  readonly parallelReadTools: boolean
}

/**
 * 校验主循环配置。
 *
 * @throws `BahError('agent-invalid-config')` 非对象 / 未知键 / `model` 为空 /
 *   参数非数 / 越界 / `maxSteps` 非正整数 / 压缩配置非法
 */
export function resolveAgentLoopConfig(input: unknown): AgentLoopConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BahError('agent-invalid-config', 'agent: 配置必须是对象')
  }
  const record = input as Readonly<Record<string, unknown>>
  for (const key of Object.keys(record)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new BahError(
        'agent-invalid-config',
        `agent: 未知配置键 ${key}（可调项只有 model / params / compaction / maxSteps / parallelReadTools）`,
        { key },
      )
    }
  }

  const model = record['model']
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new BahError(
      'agent-invalid-config',
      'agent: 必须配置 model（`provider:model` 或裸模型名）；主循环不猜默认模型',
    )
  }

  const params = record['params'] === undefined ? undefined : resolveParams(record['params'])
  const maxSteps =
    record['maxSteps'] === undefined
      ? DEFAULT_MAX_STEPS
      : positiveInteger(record['maxSteps'], 'maxSteps')
  const compaction =
    record['compaction'] === undefined
      ? undefined
      : resolveCompactionConfig(record['compaction'])
  const parallelReadTools =
    record['parallelReadTools'] === undefined
      ? true
      : booleanValue(record['parallelReadTools'], 'parallelReadTools')

  return {
    model: model.trim(),
    maxSteps,
    parallelReadTools,
    ...(params === undefined ? {} : { params }),
    ...(compaction === undefined ? {} : { compaction }),
  }
}

/** 校验采样参数。 */
export function resolveParams(input: unknown): LlmParams {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new BahError('agent-invalid-config', 'agent: params 必须是对象')
  }
  const record = input as Readonly<Record<string, unknown>>
  for (const key of Object.keys(record)) {
    if (!PARAM_KEYS.has(key)) {
      throw new BahError(
        'agent-invalid-config',
        `agent: 未知采样参数 ${key}（可调项只有 temperature / topP / maxTokens / stop）`,
        { key },
      )
    }
  }

  const params: {
    temperature?: number
    topP?: number
    maxTokens?: number
    stop?: readonly string[]
  } = {}

  if (record['temperature'] !== undefined) {
    params.temperature = inRange(record['temperature'], 'temperature', 0, 2)
  }
  if (record['topP'] !== undefined) {
    params.topP = inRange(record['topP'], 'topP', 0, 1)
  }
  if (record['maxTokens'] !== undefined) {
    params.maxTokens = positiveInteger(record['maxTokens'], 'maxTokens')
  }
  if (record['stop'] !== undefined) {
    params.stop = stringArray(record['stop'], 'stop')
  }

  return params
}

/** 布尔校验。 */
function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是布尔（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return value
}

/** 闭区间数值校验。 */
function inRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是 ${min}–${max} 之间的数（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return value
}

/** 正整数校验。 */
function positiveInteger(value: unknown, name: string): number {  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是正整数（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return value
}

/** 非空字符串数组校验（`stop` 序列）。 */
function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new BahError(
      'agent-invalid-config',
      `agent: ${name} 必须是非空字符串数组（收到 ${String(value)}）`,
      { name, value },
    )
  }
  return [...(value as string[])]
}
