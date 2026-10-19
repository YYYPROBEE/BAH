/**
 * base bundle · `bank:tools`：仿真银行工具族（施工单 08）。
 *
 * 装配三样东西：
 * 1. **mock 银行核心**（`MockBankCore` + demo / stress / adversarial 造数）；
 * 2. **14 个 P0 工具**（注册进 `core:tools` 的注册表）；
 * 3. **治理平面**（pre-execute 三级判决 + 审批票据桥接；施工单 09 的第一段）。
 *
 * 身份：08 还没有会话绑定（09 §4），headless / 演示档由 profile **显式**写 `demoUserId`；
 * 不写就是"未绑定"——所有业务工具在 pre-execute 统一 deny `no-identity`，绝不隐式默认账户。
 */

import {
  BANK_IDENTITY,
  MockBankCore,
  SessionIdentityStore,
  VerifyService,
  buildBankDataset,
  createBankTools,
  createMockVerifyProvider,
  provideBankGovernance,
  restoreSessionIdentity,
  type BankAudit,
  type BankToolDeps,
  type BankToolsConfig,
  type ForgeTier,
  type IdentityBoundData,
  type StrongAuth,
} from '@bah/bank'
import { SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import type { SessionApi } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import {
  asRecord,
  readEnum,
  readPositiveInteger,
  readString,
  rejectUnknownKeys,
} from '../config.ts'

/** `bank:tools` 的配置。 */
export interface BankToolsSettings extends BankToolsConfig {
  /** 演示 / headless 的显式身份（09 落地前；不写 = 未绑定）。 */
  readonly demoUserId?: string
  /** 造数种子（与快照的 `randomSeed` 同源）。 */
  readonly seed: number
  /** 造数档位。 */
  readonly datasetTier: ForgeTier
  /** 强验证 mock 参数。 */
  readonly verify: {
    readonly successAfter: number
    readonly maxAttempts: number
    readonly lockMinutes: number
  }
}

/** 默认配置（只有随部署可调的值；身份必须显式给）。 */
export const DEFAULT_BANK_TOOLS: Omit<BankToolsSettings, 'demoUserId'> = {
  seed: 7,
  datasetTier: 'demo',
  disclaimerId: 'wealth-risk-v1',
  ticketTtlSeconds: 120,
  computeTimeoutMs: 5_000,
  redChallenge: 'sms',
  verify: { successAfter: 1, maxAttempts: 3, lockMinutes: 30 },
}

/** 允许的强验证渠道。 */
const CHANNELS: readonly StrongAuth[] = ['face', 'sms', 'ushield']

/** 允许的造数档位。 */
const DATASET_TIERS: readonly ForgeTier[] = ['demo', 'stress', 'adversarial']

export const bankToolsPlugin: HostPlugin<BankToolsSettings> = {
  id: 'bank:tools',

  plugin: {
    name: 'bank:tools',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, TOOLS_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const dataset = buildBankDataset({
        seed: config.seed,
        tier: config.datasetTier,
        now: run.now(),
      })
      const core = new MockBankCore({ data: dataset, now: run.now })
      const verify = new VerifyService({
        provider: createMockVerifyProvider({ successAfter: config.verify.successAfter }),
        maxAttempts: config.verify.maxAttempts,
        lockMs: config.verify.lockMinutes * 60_000,
        now: run.now,
      })

      const session = ctx.get(SESSION_SERVICE)
      const identity = new SessionIdentityStore()
      ctx.effect(ctx.provide(BANK_IDENTITY, identity))
      // 回放 / 重启：`identity/bound` 是 durable 事实，先按日志恢复
      restoreSessionIdentity(identity, run.sessionId, session.events())
      // 演示档的**显式**身份：写进 profile，不写就保持未绑定（无隐式默认账户）
      if (
        config.demoUserId !== undefined &&
        identity.resolve(run.sessionId) !== config.demoUserId
      ) {
        identity.bind(run.sessionId, config.demoUserId)
        appendIdentityBound(session, {
          userId: config.demoUserId,
          method: 'demo-config',
          at: run.now(),
        })
      }

      const audit: BankAudit = {
        append: (type, data) => {
          // 领域键由本包声明（`tools/events.ts` 的模块增强），运行期按同一 append 落账。
          // `ignorable: true`：平台 reader（`deriveMessages`）不认识领域族，必须显式可跳过；
          // 否则下一条请求装配会把它当成 required-on-read 的缺失而拒绝（施工单 03 §1.5）。
          const append = session.append as unknown as (
            type: string,
            data: unknown,
            options: { ignorable: boolean },
          ) => unknown
          append(type, data, { ignorable: true })
        },
      }
      const deps: BankToolDeps = {
        core,
        tickets: core.tickets,
        audit,
        identity,
        verify,
        config: {
          disclaimerId: config.disclaimerId,
          computeTimeoutMs: config.computeTimeoutMs,
          ticketTtlSeconds: config.ticketTtlSeconds,
          redChallenge: config.redChallenge,
        },
        now: run.now,
      }

      const registry = ctx.get(TOOLS_SERVICE)
      for (const definition of createBankTools(deps)) {
        ctx.effect(registry.register(definition))
      }
      provideBankGovernance({ ctx, sessionId: run.sessionId, deps })
    },
  },

  validate(config) {    rejectUnknownKeys(
      config,
      [
        'demoUserId',
        'seed',
        'datasetTier',
        'disclaimerId',
        'ticketTtlSeconds',
        'computeTimeoutMs',
        'redChallenge',
        'verify',
      ],
      'bank:tools',
    )

    const demoUserId = readString(config, 'demoUserId', 'bank:tools')
    const verify = config['verify'] === undefined ? {} : asRecord(config['verify'], 'bank:tools.verify')
    rejectUnknownKeys(verify, ['successAfter', 'maxAttempts', 'lockMinutes'], 'bank:tools.verify')

    return {
      ...(demoUserId === undefined ? {} : { demoUserId }),
      seed: readPositiveInteger(config, 'seed', 'bank:tools') ?? DEFAULT_BANK_TOOLS.seed,
      datasetTier:
        readEnum(config, 'datasetTier', 'bank:tools', DATASET_TIERS) ??
        DEFAULT_BANK_TOOLS.datasetTier,
      disclaimerId:
        readString(config, 'disclaimerId', 'bank:tools') ?? DEFAULT_BANK_TOOLS.disclaimerId,
      ticketTtlSeconds:
        readPositiveInteger(config, 'ticketTtlSeconds', 'bank:tools') ??
        DEFAULT_BANK_TOOLS.ticketTtlSeconds,
      computeTimeoutMs:
        readPositiveInteger(config, 'computeTimeoutMs', 'bank:tools') ??
        DEFAULT_BANK_TOOLS.computeTimeoutMs,
      redChallenge:
        readEnum(config, 'redChallenge', 'bank:tools', CHANNELS) ?? DEFAULT_BANK_TOOLS.redChallenge,
      verify: {
        successAfter:
          readPositiveInteger(verify, 'successAfter', 'bank:tools.verify') ??
          DEFAULT_BANK_TOOLS.verify.successAfter,
        maxAttempts:
          readPositiveInteger(verify, 'maxAttempts', 'bank:tools.verify') ??
          DEFAULT_BANK_TOOLS.verify.maxAttempts,
        lockMinutes:
          readPositiveInteger(verify, 'lockMinutes', 'bank:tools.verify') ??
          DEFAULT_BANK_TOOLS.verify.lockMinutes,
      },
    }
  },
}

/**
 * 落 `identity/bound`（领域事件；平台 reader 不认识，必须 `ignorable`）。
 *
 * 09 的 credentials 走同一事件名即可复用回放恢复逻辑。
 */
function appendIdentityBound(session: SessionApi, data: IdentityBoundData): void {
  const append = session.append as unknown as (
    type: string,
    data: unknown,
    options: { ignorable: boolean },
  ) => unknown
  append('identity/bound', data, { ignorable: true })
}
