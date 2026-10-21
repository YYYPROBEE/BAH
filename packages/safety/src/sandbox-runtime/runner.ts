/**
 * 沙箱执行运行时（施工单 11 §3）。
 *
 * 职责边界：档位由 `sandbox-policy` 解析，"能不能执行"由本文件裁决（登记表 + 能力位 +
 * 载荷预算），**怎么执行**只有两条路——隔离档位进 `worker_threads`（带 `resourceLimits`
 * 与硬杀），`none` 档进程内直调（只给仓内受信任代码）。
 *
 * 三态失败一律转成结局（`refused` / `error` / `timeout`），由宿主转成 `isError` 的
 * 工具结果并落审计；沙箱的失败永远不冒泡到主循环（施工单 03 硬约束 5）。
 */

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'

import { assertNever } from '@bah/util'

import type { SandboxPolicy } from '../sandbox-policy/policy.ts'
import type { SandboxTier, TierSpec } from '../sandbox-policy/tier.ts'
import { sandboxModuleUrl } from './modules.ts'
import type { SandboxHandlerModule, SandboxJob, SandboxOutcome, SandboxWorkerResult } from './protocol.ts'
import { describeLimits } from './protocol.ts'
import type { SandboxRegistry } from './registry.ts'

/** 一次沙箱执行的输入。 */
export interface SandboxRunRequest {
  /** 工具名（档位解析的键，也是审计里的可读数）。 */
  readonly tool: string
  /** 登记表的键。 */
  readonly handlerKey: string
  /** 程序来源：`model` 一律禁入 `none`（`sandbox-policy` 的硬规则）。 */
  readonly codeSource: 'model' | 'trusted'
  /** 执行体自己的载荷（计算类是 `{ code, data, limits }`）。 */
  readonly payload: unknown
  /** 参数指纹（有显式批准档时按它匹配）。 */
  readonly fingerprint?: string
}

/** 一次执行的可审计记录（宿主接到 `session.append` 上）。 */
export interface SandboxAuditRecord {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface SandboxRunnerOptions {
  readonly policy: SandboxPolicy
  readonly registry: SandboxRegistry
  /** 并发上限（超出的调用排队等待；每次执行完强制 `terminate`，不复用 worker）。 */
  readonly maxConcurrency?: number
  /** worker 入口的 file:// href（缺省按运行位置解析）。 */
  readonly workerUrl?: string
  /** 时钟（测试与回放注入固定钟）。 */
  readonly now?: () => number
  /** 审计出口（缺省不落账：单测用内存收集器）。 */
  readonly audit?: (record: SandboxAuditRecord) => void
}

/** 执行体的模块形状（`modules.ts` 解析出的文件必须导出这个常量）。 */
type HandlerModule = Partial<SandboxHandlerModule>

export class SandboxRunner {
  private readonly policy: SandboxPolicy
  private readonly registry: SandboxRegistry
  private readonly maxConcurrency: number
  private readonly workerUrl: string
  private readonly now: () => number
  private readonly audit: ((record: SandboxAuditRecord) => void) | undefined
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor(options: SandboxRunnerOptions) {
    this.policy = options.policy
    this.registry = options.registry
    this.maxConcurrency = options.maxConcurrency ?? 4
    this.workerUrl = options.workerUrl ?? sandboxModuleUrl('sandbox-runtime/worker')
    this.now = options.now ?? (() => Date.now())
    this.audit = options.audit
  }

  /**
   * 执行一次沙箱调用。
   *
   * 只有 `sandbox-policy` 的两条硬规则（模型代码禁入 `none`、override 不得放宽）会抛；
   * 其余失败都以结局返回，交调用方转成工具错误。
   */
  async run(request: SandboxRunRequest, sessionId: string): Promise<SandboxOutcome<unknown>> {
    const decision = this.policy.resolve(
      {
        tool: request.tool,
        codeSource: request.codeSource,
        ...(request.fingerprint === undefined ? {} : { fingerprint: request.fingerprint }),
      },
      sessionId,
    )
    const started = this.now()

    const refusal = this.admit(request, decision.limits)
    if (refusal !== undefined) {
      this.record(refusal, request, decision.tier)
      return refusal
    }
    const ref = this.registry.get(request.handlerKey)
    if (ref === undefined) {
      const refused: SandboxOutcome<unknown> = {
        kind: 'refused',
        code: 'sandbox-handler-missing',
        reason: `执行体 ${request.handlerKey} 未登记进沙箱`,
        tier: decision.tier,
      }
      this.record(refused, request, decision.tier)
      return refused
    }
    if (decision.tier !== 'none' && ref.capabilities.length > 0) {
      const refused: SandboxOutcome<unknown> = {
        kind: 'refused',
        code: 'sandbox-capability-denied',
        reason: `执行体 ${ref.key} 需要能力 ${ref.capabilities.join(' / ')}，${describeLimits(
          decision.limits,
        )} 的档位不允许`,
        tier: decision.tier,
      }
      this.record(refused, request, decision.tier)
      return refused
    }

    const job: SandboxJob = { moduleUrl: ref.moduleUrl, tool: request.tool, payload: request.payload }
    await this.acquire()
    try {
      const result =
        decision.tier === 'none'
          ? await this.runInProcess(job)
          : await this.runInWorker(job, decision.limits)
      const outcome = toOutcome(result, decision.tier, decision.limits.timeoutMs, this.now() - started)
      this.record(outcome, request, decision.tier)
      return outcome
    } finally {
      this.release()
    }
  }

  /** 载荷预算（超限即拒，连 worker 都不起）。 */
  private admit(request: SandboxRunRequest, limits: TierSpec): SandboxOutcome<unknown> | undefined {
    let size: number
    try {
      const text = JSON.stringify(request.payload)
      if (text === undefined) return { kind: 'refused', code: 'sandbox-payload-unserializable', reason: '载荷无法序列化' }
      size = text.length
    } catch {
      return { kind: 'refused', code: 'sandbox-payload-unserializable', reason: '载荷无法序列化（循环引用？）' }
    }
    if (size > limits.maxPayloadBytes) {
      return {
        kind: 'refused',
        code: 'sandbox-payload-too-large',
        reason: `载荷 ${String(size)} 字节超过档位上限 ${String(limits.maxPayloadBytes)}`,
        tier: undefined,
      }
    }
    return undefined
  }

  /** 隔离档：起一个一次性 worker，超时硬杀，结局三态化。 */
  private runInWorker(job: SandboxJob, limits: TierSpec): Promise<SandboxWorkerResult | 'timeout'> {
    const entry = fileURLToPath(this.workerUrl)
    const worker = new Worker(entry, {
      workerData: job,
      resourceLimits: { maxOldGenerationSizeMb: limits.maxOldGenMb },
      // worker 由 Node 直接加载：入口是 .ts 时才需要类型擦除（dist 里是 .js，不带旗标）
      ...(entry.endsWith('.ts') ? { execArgv: ['--experimental-strip-types'] } : {}),
    })
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void worker.terminate()
        resolve('timeout')
      }, limits.timeoutMs)
      const settle = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
      }
      worker.once('message', (message: unknown) => {
        settle()
        void worker.terminate()
        resolve(message as SandboxWorkerResult)
      })
      worker.once('error', (error: Error & { code?: string }) => {
        settle()
        void worker.terminate()
        resolve({
          kind: 'error',
          code: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'sandbox-out-of-memory' : 'sandbox-worker-error',
          message: error.message,
        })
      })
      worker.once('exit', (code: number) => {
        // 硬杀与正常消息都会先置 settled：走到这里说明 worker 自己崩了
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ kind: 'error', code: 'sandbox-worker-exit', message: `worker 退出码 ${String(code)}` })
      })
    })
  }

  /** `none` 档：进程内直调（只服务仓内受信任代码；模型代码进不到这里）。 */
  private async runInProcess(job: SandboxJob): Promise<SandboxWorkerResult> {
    const loaded: unknown = await import(job.moduleUrl)
    const handler = (loaded as HandlerModule).SANDBOX_HANDLER
    if (handler === undefined || typeof handler.run !== 'function') {
      return {
        kind: 'error',
        code: 'sandbox-handler-load-failed',
        message: `执行体模块缺少 SANDBOX_HANDLER：${job.moduleUrl}`,
      }
    }
    try {
      return { kind: 'ok', value: await handler.run(job.payload) }
    } catch (error) {
      return {
        kind: 'error',
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 并发闸：满了排队，释放时把手里的名额交给下一个等待者。 */
  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiting.push(resolve)
    })
  }

  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) this.running -= 1
    else next()
  }

  /** 落审计（施工单 11 §3.1：三类失败都要留痕）。 */
  private record(
    outcome: SandboxOutcome<unknown>,
    request: SandboxRunRequest,
    tier: SandboxTier,
  ): void {
    if (this.audit === undefined) return
    const data: Record<string, unknown> = { tool: request.tool, handler: request.handlerKey, tier }
    switch (outcome.kind) {
      case 'ok':
        Object.assign(data, { elapsedMs: outcome.elapsedMs })
        break
      case 'error':
        Object.assign(data, { code: outcome.code, reason: outcome.message })
        break
      case 'refused':
        Object.assign(data, { code: outcome.code, reason: outcome.reason })
        break
      case 'timeout':
        Object.assign(data, { code: 'sandbox-timeout', reason: `超过档位时限 ${String(outcome.timeoutMs)}ms` })
        break
      default:
        assertNever(outcome, 'sandbox-outcome')
    }
    this.audit({ type: auditType(outcome), data })
  }
}

/** 结局 → 会话事件名。 */
function auditType(outcome: SandboxOutcome<unknown>): string {
  switch (outcome.kind) {
    case 'ok':
      return 'sandbox/done'
    case 'refused':
      return 'sandbox/refused'
    case 'error':
      return 'sandbox/error'
    case 'timeout':
      return 'sandbox/timeout'
    default:
      return assertNever(outcome, 'sandbox-outcome')
  }
}

/** worker 消息 → 结局（`timeout` 是父侧硬杀的独立判决，不经消息；施工单 11 §3.1）。 */
function toOutcome(
  result: SandboxWorkerResult | 'timeout',
  tier: SandboxTier,
  timeoutMs: number,
  elapsedMs: number,
): SandboxOutcome<unknown> {
  if (result === 'timeout') return { kind: 'timeout', tier, timeoutMs }
  if (result.kind === 'ok') return { kind: 'ok', value: result.value, tier, elapsedMs }
  return { kind: 'error', code: result.code, message: result.message, tier }
}

/** 抛出物 → 理由码。 */
function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { code?: unknown }).code
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return 'sandbox-runtime-error'
}
