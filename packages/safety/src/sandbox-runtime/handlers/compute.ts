/**
 * 计算类执行体（`analysis_calc` 的受限表达式）。
 *
 * 载荷形状：`{ code: string, data?: object, limits: { timeoutMs, maxOperations } }`。
 * 与 worker 入口同样受"零包名 import + 可擦除语法"约束（它自己就在 worker 的加载链里）。
 */

import { ProgramError, runProgram } from '../language.ts'
import type { ProgramRequest, ProgramResult } from '../language.ts'

/** 计算类执行体需要的能力：无（这正是它能进隔离档位的前提）。 */
const COMPUTE_CAPABILITIES: readonly [] = []

/** 校验并归一化载荷（任何不符都是 `program-invalid`，不是运行时错误）。 */
function readRequest(payload: unknown): ProgramRequest {
  if (typeof payload !== 'object' || payload === null) {
    throw new ProgramError('program-invalid', '计算载荷必须是对象')
  }
  const record = payload as Record<string, unknown>
  const code = record['code']
  if (typeof code !== 'string') {
    throw new ProgramError('program-invalid', '计算载荷缺少字符串 code')
  }
  const limits = record['limits']
  if (typeof limits !== 'object' || limits === null) {
    throw new ProgramError('program-invalid', '计算载荷缺少 limits')
  }
  const { timeoutMs, maxOperations } = limits as Record<string, unknown>
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ProgramError('program-invalid', 'limits.timeoutMs 必须是正数')
  }
  if (typeof maxOperations !== 'number' || !Number.isInteger(maxOperations) || maxOperations <= 0) {
    throw new ProgramError('program-invalid', 'limits.maxOperations 必须是正整数')
  }
  const data = record['data']
  if (data !== undefined && (typeof data !== 'object' || data === null)) {
    throw new ProgramError('program-invalid', '计算载荷的 data 必须是对象')
  }
  return {
    code,
    limits: { timeoutMs, maxOperations },
    ...(data === undefined ? {} : { data: data as Readonly<Record<string, unknown>> }),
  }
}

/** 沙箱执行体出口（worker 与 `none` 档进程内直调共用同一个形状）。 */
export const SANDBOX_HANDLER = {
  key: 'compute',
  capabilities: COMPUTE_CAPABILITIES,
  run: (payload: unknown): ProgramResult => runProgram(readRequest(payload)),
}
