/**
 * 沙箱 worker 入口（施工单 11 §3）。
 *
 * 这个文件由 Node 直接加载（不经 vitest / tsx），所以它有两条硬约束：
 * 1. **零包名 import**——只 import `node:*` 与本目录的相对模块，否则要靠 `dist/` 才能解析；
 * 2. **可擦除语法**——运行时需要带 `--experimental-strip-types`，enum / 参数属性会被拒。
 *
 * 能力剥离在这里做**第二次**复核：登记表说自己是零能力执行体，worker 只认它自己看到的
 * `SANDBOX_HANDLER.capabilities`；父侧漏检也跑不掉（施工单 00 §9：判决不依赖单点）。
 */

import { parentPort, workerData } from 'node:worker_threads'
import { dirname, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SandboxJob, SandboxWorkerResult } from './protocol.ts'
import type { SandboxHandlerModule } from './protocol.ts'

/**
 * worker 侧模块完整性复核：执行体必须落在本目录（`sandbox-runtime/**`）内。
 *
 * 父侧登记表已经解析过路径，但"判决不依赖单点"——父侧被绕过时 worker 仍拒绝越界路径。
 */
function assertModuleWithinRuntime(moduleUrl: string): void {
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const target = fileURLToPath(moduleUrl)
  const rel = relative(selfDir, target)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`sandbox-handler-path-outside-runtime: ${moduleUrl}`)
  }
}

/** 把结论送回父侧（父侧已 terminate 时静默忽略——那条路已有判决）。 */
function post(result: SandboxWorkerResult): void {
  parentPort?.postMessage(result)
}

/** 抛出物 → 结构化理由码（非 ProgramError 的意外抛错也要留码）。 */
function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { code?: unknown }).code
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return 'sandbox-runtime-error'
}

/** 抛出物 → 可读消息。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function main(): Promise<void> {
  const job = workerData as SandboxJob
  let handler: SandboxHandlerModule['SANDBOX_HANDLER']
  try {
    assertModuleWithinRuntime(job.moduleUrl)
    const loaded: unknown = await import(job.moduleUrl)
    handler = readHandler(loaded, job.moduleUrl)
  } catch (error) {
    post({ kind: 'error', code: 'sandbox-handler-load-failed', message: messageOf(error) })
    return
  }
  // 隔离档位的唯一准入条件：零能力。任何能力声明在这里都会被挡下。
  if (handler.capabilities.length > 0) {
    post({
      kind: 'error',
      code: 'sandbox-capability-denied',
      message: `执行体 ${handler.key} 声明了隔离档位不允许的能力：${handler.capabilities.join(' / ')}`,
    })
    return
  }
  try {
    post({ kind: 'ok', value: await handler.run(job.payload) })
  } catch (error) {
    post({ kind: 'error', code: codeOf(error), message: messageOf(error) })
  }
}

/** 校验模块导出的执行体形状（形状不符 = 装配错误，不是运行期可恢复的失败）。 */
function readHandler(loaded: unknown, moduleUrl: string): SandboxHandlerModule['SANDBOX_HANDLER'] {
  if (typeof loaded !== 'object' || loaded === null) {
    throw new Error(`沙箱执行体模块没有导出对象：${moduleUrl}`)
  }
  const candidate = (loaded as Partial<SandboxHandlerModule>).SANDBOX_HANDLER
  if (
    candidate === undefined ||
    typeof candidate.key !== 'string' ||
    !Array.isArray(candidate.capabilities) ||
    typeof candidate.run !== 'function'
  ) {
    throw new Error(`沙箱执行体模块缺少 SANDBOX_HANDLER（key / capabilities / run）：${moduleUrl}`)
  }
  return candidate
}

void main()
