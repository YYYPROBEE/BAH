/**
 * base bundle · `safety:sandbox`：沙箱执行宿主行（施工单 11 §3）。
 *
 * 本行只做接线：档位、硬杀、三态失败全部在 `@bah/safety` 的 sandbox-runtime 里。
 * 它向 `BANK_COMPUTE` 提供服务键，`bank:tools` 在调用 `analysis_calc` 时按需取用；
 * 未装本行时 bank 侧退回进程内求值（单测 / 最小装配），生产 base bundle 默认装本行。
 */

import {
  DEFAULT_TIER_SPECS,
  SandboxPolicy,
  SandboxRegistry,
  SandboxRunner,
  sandboxModuleUrl,
  type SandboxAuditRecord,
  type SandboxOutcome,
  type SandboxTier,
  type TierSpec,
} from '@bah/safety'
import { BANK_COMPUTE, type ComputeRequest, type ComputeResult } from '@bah/bank'
import { BahError } from '@bah/util'
import { SESSION_SERVICE } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { bootError, readPositiveInteger, rejectUnknownKeys } from '../config.ts'

/** `safety:sandbox` 的可调项（随部署变化的值，全部进 Config）。 */
export interface SandboxPluginSettings {
  /** `compute-bounded` 的墙钟上限（ms；超时即 terminate worker）。 */
  readonly timeoutMs: number
  /** 确定性运算预算（与超时无关）。 */
  readonly maxOperations: number
  /** worker 堆上限（MB）。 */
  readonly maxOldGenMb: number
  /** 并发 worker 数（超出的调用排队）。 */
  readonly maxConcurrency: number
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxPluginSettings = {
  timeoutMs: DEFAULT_TIER_SPECS['compute-bounded'].timeoutMs,
  maxOperations: DEFAULT_TIER_SPECS['compute-bounded'].maxOperations,
  maxOldGenMb: DEFAULT_TIER_SPECS['compute-bounded'].maxOldGenMb,
  maxConcurrency: 2,
}

/** 计算工具名 → 档位（模型生成的代码禁入 `none`，由 policy 硬规则保证）。 */
const DEFAULT_TIERS: Readonly<Record<string, SandboxTier>> = {
  analysis_calc: 'compute-bounded',
}

export const sandboxPlugin: HostPlugin<SandboxPluginSettings> = {
  id: 'safety:sandbox',

  plugin: {
    name: 'safety:sandbox',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)

      const specs: Readonly<Record<SandboxTier, TierSpec>> = {
        ...DEFAULT_TIER_SPECS,
        'compute-bounded': {
          ...DEFAULT_TIER_SPECS['compute-bounded'],
          timeoutMs: config.timeoutMs,
          maxOperations: config.maxOperations,
          maxOldGenMb: config.maxOldGenMb,
        },
      }
      const policy = new SandboxPolicy({ defaults: DEFAULT_TIERS, fallbackTier: 'query-only', specs })
      const registry = new SandboxRegistry()
      ctx.effect(
        registry.register({
          key: 'compute',
          capabilities: [],
          moduleUrl: sandboxModuleUrl('sandbox-runtime/handlers/compute'),
        }),
      )

      const audit = (record: SandboxAuditRecord): void => {
        session.appendDomain(record.type, record.data, { ignorable: true })
      }
      const runner = new SandboxRunner({
        policy,
        registry,
        maxConcurrency: config.maxConcurrency,
        audit,
      })

      const seam = async (request: ComputeRequest): Promise<ComputeResult> => {
        const outcome = await runner.run(
          {
            tool: 'analysis_calc',
            handlerKey: 'compute',
            codeSource: 'model',
            payload: request,
          },
          String(run.sessionId),
        )
        return unwrapOutcome(outcome)
      }

      ctx.provide(BANK_COMPUTE, seam)
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['timeoutMs', 'maxOperations', 'maxOldGenMb', 'maxConcurrency'], 'safety:sandbox')
    return {
      timeoutMs: readPositiveInteger(config, 'timeoutMs', 'safety:sandbox') ?? DEFAULT_SANDBOX_SETTINGS.timeoutMs,
      maxOperations:
        readPositiveInteger(config, 'maxOperations', 'safety:sandbox') ??
        DEFAULT_SANDBOX_SETTINGS.maxOperations,
      maxOldGenMb:
        readPositiveInteger(config, 'maxOldGenMb', 'safety:sandbox') ??
        DEFAULT_SANDBOX_SETTINGS.maxOldGenMb,
      maxConcurrency:
        readPositiveInteger(config, 'maxConcurrency', 'safety:sandbox') ??
        DEFAULT_SANDBOX_SETTINGS.maxConcurrency,
    }
  },
}

/** 沙箱结局 → 工具面结果（三态失败一律抛结构化错误，不把不完整值交给业务）。 */
export function unwrapOutcome(outcome: SandboxOutcome<unknown>): ComputeResult {
  switch (outcome.kind) {
    case 'ok':
      return asComputeResult(outcome.value)
    case 'refused':
      throw new BahError(outcome.code, `sandbox: ${outcome.reason}`, {
        ...(outcome.tier === undefined ? {} : { tier: outcome.tier }),
      })
    case 'error':
      throw new BahError(mapErrorCode(outcome.code), `sandbox: ${outcome.message}`, {
        tier: outcome.tier,
      })
    case 'timeout':
      throw new BahError('sandbox-timeout', `sandbox: 执行超过 ${outcome.timeoutMs} ms，已硬杀`, {
        tier: outcome.tier,
        timeoutMs: outcome.timeoutMs,
      })
  }
}

/** 程序级失败码 → 工具面 `compute-*` 口径（与进程内默认 seam 一致）。 */
const COMPUTE_CODES: Readonly<Record<string, string>> = {
  'program-invalid': 'compute-invalid',
  'program-data-missing': 'compute-data-missing',
  'program-limit': 'compute-limit',
  'program-timeout': 'compute-timeout',
  'program-result-invalid': 'compute-result-invalid',
}

function mapErrorCode(code: string): string {
  return COMPUTE_CODES[code] ?? code
}

export function asComputeResult(value: unknown): ComputeResult {
  if (typeof value !== 'object' || value === null) {
    throw new BahError('sandbox-result-invalid', 'sandbox: 执行体返回的不是对象')
  }
  const record = value as Record<string, unknown>
  const result = record['value']
  const operations = record['operations']
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new BahError('sandbox-result-invalid', 'sandbox: 执行体返回的 value 不是有限数字')
  }
  if (typeof operations !== 'number' || !Number.isInteger(operations) || operations < 0) {
    throw new BahError('sandbox-result-invalid', 'sandbox: 执行体返回的 operations 不是非负整数')
  }
  return { value: result, operations }
}
