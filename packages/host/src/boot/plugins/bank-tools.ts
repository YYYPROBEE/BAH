/**
 * base bundle · `bank:tools`：仿真银行工具族（施工单 08/09）。
 *
 * 装配四样东西：
 * 1. **mock 银行核心**（`MockBankCore` + demo / stress / adversarial 造数；日限额与 Config 同源）；
 * 2. **14 个 P0 工具**（注册进 `core:tools` 的注册表）；
 * 3. **治理平面**（pre-execute 三级判定 + 审批票据桥接；施工单 09 §1–§3）；
 * 4. **票据账本与强验证端口**：账本来自 `@bah/interaction`（`ticket/*` 事件），
 *    端口 `bank:challenge` 供审批插件在红级挑战链里调用。
 *
 * 身份：09 的 credentials 落地后由 `@bah/persistence` 的登录流程绑定；headless / 演示档
 * 仍由 profile **显式**写 `demoUserId`。不写就是"未绑定"——所有业务工具在 pre-execute
 * 统一 deny `no-identity`，绝不隐式默认账户。
 */

import {
  BANK_CHALLENGE,
  BANK_IDENTITY,
  BANK_TOOL_NAME_SET,
  MockBankCore,
  SessionIdentityStore,
  VerifyService,
  buildBankDataset,
  createBankChallengePort,
  createBankTools,
  createMockVerifyProvider,
  provideBankGovernance,
  restoreSessionIdentity,
  yuanToCents,
  type BankAudit,
  type BankToolDeps,
  type BankToolsConfig,
  type ForgeTier,
  type IdentityBoundData,
  type StrongAuth,
} from '@bah/bank'
import { TicketLedger } from '@bah/interaction'
import {
  CREDENTIALS,
  CredentialsService,
  ImIdentityMap,
  MockSmsLoginService,
} from '@bah/persistence'
import { SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import type { SessionApi } from '@bah/runtime'
import { BahError, seededRandom } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import {
  asRecord,
  bootError,
  readEnum,
  readPositiveInteger,
  readString,
  readStringArray,
  rejectUnknownKeys,
} from '../config.ts'

/** `bank:tools` 的配置。 */
export interface BankToolsSettings extends BankToolsConfig {
  /** 演示 / headless 的显式身份（不写 = 未绑定）。 */
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
  dailyTransferLimit: 5_000,
  riskyOps: ['transfer_create', 'wealth_purchase'],
  riskyCallThreshold: 3,
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
      // 日限额与 Config 同源：core 账本只负责「已用多少」，上限由 Config 收紧
      const core = new MockBankCore({
        data: dataset,
        now: run.now,
        limits: { ...dataset.limits, dailyTransferLimitCents: yuanToCents(config.dailyTransferLimit) },
      })
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

      // 身份绑定渠道（施工单 09 §4）：mock 短信登录 / IM 映射 / Web 登录页接缝。
      // 三个渠道最终都只调 `identity.bind` + 落 `identity/bound`（事件名沿用 08 的 R87）。
      const credentials = new CredentialsService({
        login: new MockSmsLoginService({
          users: dataset.users.map((user) => ({ userId: user.id, phone: user.phone })),
          now: run.now,
          random: seededRandom(config.seed),
        }),
        im: new ImIdentityMap(),
        binding: {
          bind: (target, userId, method) => {
            if (target !== run.sessionId) {
              // 一个 host 进程只服务一个会话：别把身份事件写进别人的日志
              throw new BahError('identity-session-mismatch', 'bank-tools: 身份绑定只能作用于当前会话', {
                sessionId: target,
              })
            }
            identity.bind(target, userId)
            appendIdentityBound(session, { userId, method, at: run.now() })
          },
        },
      })
      ctx.effect(ctx.provide(CREDENTIALS, credentials))

      const audit: BankAudit = {
        append: (type, data) => {
          // 领域键由本包声明（`tools/events.ts` 的模块增强），运行期按同一 append 落账。
          // `ignorable: true`：平台 reader（`deriveMessages`）不认识领域族，必须显式可跳过；
          // 否则下一条请求装配会把它当成 required-on-read 的缺失而拒绝（施工单 03 §1.5）。
          appendIgnorable(session, type, data)
        },
      }
      // 票据生命周期账本（施工单 09 §3）：每次转移落 `ticket/*`，核销属主仍是 bank-core
      const tickets = new TicketLedger({
        record: (record) => {
          appendIgnorable(session, record.type, record.data)
        },
      })
      // 强验证端口：审批服务用它在红级 ask 里签发 / 提交挑战（施工单 09 §6）
      ctx.effect(
        ctx.provide(
          BANK_CHALLENGE,
          createBankChallengePort({ verify, sessionId: run.sessionId, audit }),
        ),
      )

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
          dailyTransferLimit: config.dailyTransferLimit,
          riskyOps: config.riskyOps,
          riskyCallThreshold: config.riskyCallThreshold,
        },
        now: run.now,
      }

      const registry = ctx.get(TOOLS_SERVICE)
      for (const definition of createBankTools(deps)) {
        ctx.effect(registry.register(definition))
      }
      provideBankGovernance({ ctx, sessionId: run.sessionId, deps, lifecycle: tickets })
    },
  },

  validate(config) {
    rejectUnknownKeys(
      config,
      [
        'demoUserId',
        'seed',
        'datasetTier',
        'disclaimerId',
        'ticketTtlSeconds',
        'computeTimeoutMs',
        'redChallenge',
        'dailyTransferLimit',
        'riskyOps',
        'riskyCallThreshold',
        'verify',
      ],
      'bank:tools',
    )

    const demoUserId = readString(config, 'demoUserId', 'bank:tools')
    const verify = config['verify'] === undefined ? {} : asRecord(config['verify'], 'bank:tools.verify')
    rejectUnknownKeys(verify, ['successAfter', 'maxAttempts', 'lockMinutes'], 'bank:tools.verify')
    const riskyOps = readStringArray(config, 'riskyOps', 'bank:tools')
    if (riskyOps !== undefined) {
      const unknown = riskyOps.filter((name) => !BANK_TOOL_NAME_SET.has(name))
      if (unknown.length > 0) {
        throw bootError(
          'invalid-config',
          `bank:tools.riskyOps 含未知工具名：${unknown.join('、')}（只允许工具目录里的名字）`,
          { riskyOps, unknown },
        )
      }
    }

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
      dailyTransferLimit:
        readPositiveInteger(config, 'dailyTransferLimit', 'bank:tools') ??
        DEFAULT_BANK_TOOLS.dailyTransferLimit,
      riskyOps: riskyOps ?? DEFAULT_BANK_TOOLS.riskyOps,
      riskyCallThreshold:
        readPositiveInteger(config, 'riskyCallThreshold', 'bank:tools') ??
        DEFAULT_BANK_TOOLS.riskyCallThreshold,
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
  appendIgnorable(session, 'identity/bound', data)
}

/**
 * 按领域键落账（`ignorable: true`）。
 *
 * `SessionApi.append` 的签名收窄在平台事件表上；领域事件由各包模块增强声明，
 * 这里做一次形状适配（与施工单 08 的 `audit` 出口同一策略）。
 */
function appendIgnorable(session: SessionApi, type: string, data: unknown): void {
  const append = session.append as unknown as (
    type: string,
    data: unknown,
    options: { ignorable: boolean },
  ) => unknown
  append(type, data, { ignorable: true })
}
