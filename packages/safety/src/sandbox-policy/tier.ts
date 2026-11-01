/**
 * 沙箱档位词汇表。
 *
 * 三档位是**执行环境**的隔离强度，不是权限级别（绿/黄/红属 `@bah/bank` 的治理平面）。
 * 一次工具调用先由三级权限决定"能不能执行"，再由本模块决定"在什么环境里执行"。
 *
 * `rank` 只用来回答"这个 override 是收紧还是放宽"：`none` 最宽（进程内直调，无隔离），
 * `query-only` 最严。数值越大越宽。
 */

/** 沙箱档位。 */
export type SandboxTier = 'query-only' | 'compute-bounded' | 'none'

/** 档位允许的排序（越大越宽；`none` = 不受限）。 */
export const TIER_RANK: Readonly<Record<SandboxTier, number>> = {
  'query-only': 0,
  'compute-bounded': 1,
  none: 2,
}

/** 沙箱能力的封闭联合（`none` 之外的档位一律全部拒绝； 的能力剥离清单）。 */
export type SandboxCapability = 'network' | 'filesystem' | 'process' | 'external-io'

/** 一个档位的执行限制（数值全部来自 Config，本模块只定义形状与缺省）。 */
export interface TierLimits {
  /** 墙钟上限（ms）；超时即 `worker.terminate()`。 */
  readonly timeoutMs: number
  /** 运算数上限（确定性预算，与超时无关）。 */
  readonly maxOperations: number
  /** 堆上限（MB）；交给 `worker.resourceLimits`，超限即运行时错误。 */
  readonly maxOldGenMb: number
  /** 允许程序读取的投影数据字节上限（序列化后）。 */
  readonly maxPayloadBytes: number
}

/** 一个档位的完整规格：限制 + 允许的能力（沙箱侧永远是空数组）。 */
export interface TierSpec extends TierLimits {
  readonly rank: number
  readonly capabilities: readonly SandboxCapability[]
}

/**
 * 缺省档位规格（query-only 2s / compute-bounded 5s）。
 *
 * `none` 的 `timeoutMs` 只是**进程内**环绕用的兜底值——它不经 worker，因此没有
 * `resourceLimits` 与硬杀；这正是"模型生成的代码一律不得进入 none"的原因（§2 硬规则）。
 */
export const DEFAULT_TIER_SPECS: Readonly<Record<SandboxTier, TierSpec>> = {
  'query-only': {
    rank: TIER_RANK['query-only'],
    timeoutMs: 2_000,
    maxOperations: 10_000,
    maxOldGenMb: 64,
    maxPayloadBytes: 256 * 1_024,
    capabilities: [],
  },
  'compute-bounded': {
    rank: TIER_RANK['compute-bounded'],
    timeoutMs: 5_000,
    maxOperations: 100_000,
    maxOldGenMb: 128,
    maxPayloadBytes: 1024 * 1_024,
    capabilities: [],
  },
  none: {
    rank: TIER_RANK.none,
    timeoutMs: 5_000,
    maxOperations: 1_000_000,
    maxOldGenMb: 512,
    maxPayloadBytes: 8 * 1024 * 1_024,
    capabilities: ['network', 'filesystem', 'process', 'external-io'],
  },
}

/** 档位名数组（配置校验与门禁共用的唯一口径）。 */
export const SANDBOX_TIERS: readonly SandboxTier[] = ['query-only', 'compute-bounded', 'none']

/** 是不是合法档位名（配置解析用；不做静默回退）。 */
export function isSandboxTier(value: unknown): value is SandboxTier {
  return typeof value === 'string' && (SANDBOX_TIERS as readonly string[]).includes(value)
}

/** `a` 是否比 `b` 更宽（rank 比较；相等视为不放宽）。 */
export function isWider(a: SandboxTier, b: SandboxTier): boolean {
  return TIER_RANK[a] > TIER_RANK[b]
}
