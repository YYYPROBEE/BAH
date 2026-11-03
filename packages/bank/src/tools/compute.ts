/**
 * 受限计算 seam——**语言的属主已收口到安全平面**。
 *
 * 本文件只做两件事：把 `@bah/safety` 的语言原样跑一遍，再把程序级失败码映射成
 * 工具面的 `compute-*` 口径。为什么不留第二份实现：语言留在业务包里会让
 * "谁能执行模型代码"没有单一属主，两份实现迟早分叉。
 *
 * `defaultCompute` 是**进程内**通道（沙箱的 `none` 档语义：仓内受信任代码直调）。
 * 模型生成的表达式在生产装配里由 `safety:sandbox` 提供的 seam 接管（走 worker +
 * 硬杀），这条默认路径只服务单测与无沙箱的最小装配。
 */

import { defineService } from '@bah/core'
import { ProgramError, runProgram } from '@bah/safety'
import { BahError } from '@bah/util'

import type { ComputeRequest, ComputeResult, ComputeSeam } from './types.ts'

/** 沙箱提供的受限计算接缝（可选服务；缺省走本文件的进程内实现）。 */
export const BANK_COMPUTE = defineService<ComputeSeam>('bank:compute')

/** 默认运算预算（与超时无关的确定性上限）。 */
export const DEFAULT_MAX_OPERATIONS = 10_000

/** 程序级失败码 → 工具面理由码（工具面口径不变，模型看到的仍是 `compute-*`）。 */
const CODE_MAP: Readonly<Record<string, string>> = {
  'program-invalid': 'compute-invalid',
  'program-data-missing': 'compute-data-missing',
  'program-limit': 'compute-limit',
  'program-timeout': 'compute-timeout',
  'program-result-invalid': 'compute-result-invalid',
}

/**
 * 默认受限计算：同步求值，返回数值结果与运算数。
 *
 * @throws `BahError('compute-invalid' | 'compute-data-missing' | 'compute-limit' |
 *   'compute-timeout' | 'compute-result-invalid')`
 */
export function evaluateExpression(request: ComputeRequest): ComputeResult {
  try {
    return runProgram(request)
  } catch (error) {
    if (error instanceof ProgramError) {
      throw new BahError(CODE_MAP[error.code] ?? 'compute-invalid', `bank-tools: ${error.message}`, {
        code: error.code,
      })
    }
    throw error
  }
}

/** 默认 seam（异步签名，便于沙箱插件整体替换）。 */
export const defaultCompute: ComputeSeam = async (request) => evaluateExpression(request)
