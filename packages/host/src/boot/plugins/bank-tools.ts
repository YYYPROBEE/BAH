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
  BANK_COMPENSATION,
  BANK_COMPUTE,
  BANK_IDENTITY,
  BANK_TICKET_GUARD,
  BANK_RESULT_SCHEMAS,
  BANK_TOOL_NAME_SET,
  specOf,
  type BankToolName,
  MockBankCore,
  SessionIdentityStore,
  VerifyService,
  buildBankDataset,
  createBankChallengePort,
  createBankContextSource,
  createBankTools,
  createGatewayVerifyProvider,
  createMockVerifyProvider,
  DEFAULT_CONTEXT_SLOTS,
  provideBankGovernance,
  restoreSessionIdentity,
  tenantSaltOf,
  yuanToCents,
  type BankAudit,
  type BankToolDeps,
  type BankToolsConfig,
  type ContextSlotSettings,
  type ForgeTier,
  type IdentityBoundData,
  type StrongAuth,
  type TicketGuard,
} from '@bah/bank'
import { TicketLedger } from '@bah/interaction'
import {
  CREDENTIALS,
  CredentialsService,
  ImIdentityMap,
  MockSmsLoginService,
} from '@bah/persistence'
import {
  RUNTIME_CONTEXT_SOURCE,
  SESSION_SERVICE,
  TOOLS_SERVICE,
  findPolicyDescriptor,
  findPolicyEngine,
  providePolicyParamCheck,
  provideToolContracts,
} from '@bah/runtime'
import type { PolicyDescriptor, SessionApi } from '@bah/runtime'
import { BahError, seededRandom } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import {
  asRecord,
  bootError,
  readBoolean,
  readEnum,
  readPositiveInteger,
  readString,
  readStringArray,
  rejectUnknownKeys,
} from '../config.ts'
import { logJson } from './log.ts'

/** `bank:tools` 的配置。 */
export interface BankToolsSettings extends BankToolsConfig {
  /** 演示 / headless 的显式身份（不写 = 未绑定）。 */
  readonly demoUserId?: string
  /** 造数种子（与快照的 `randomSeed` 同源）。 */
  readonly seed: number
  /** 造数档位。 */
  readonly datasetTier: ForgeTier
  /** 强验证参数（W09：`provider` 可选网关适配器或确定性 mock）。 */
  readonly verify: {
    readonly provider: 'mock' | 'gateway'
    readonly successAfter: number
    readonly maxAttempts: number
    readonly lockMinutes: number
  }
  /**
   * 执行 lease（W12）：审批通过后的短窗口。
   *
   * `enforce: false` = 回滚到"只用票据 TTL"的旧行为；`ttlSeconds` 缺省 = `ticketTtlSeconds`
   * （默认与今日等价，快照不动）。`ttlSeconds > ticketTtlSeconds` 启动即 fail-loud。
   */
  readonly ticketLease: {
    readonly enforce: boolean
    readonly ttlSeconds: number
  }
  /**
   * 实体槽位的预算/超时/熔断参数（`core:agent.slots.source=bank` 时才会被读）。
   *
   * 写在 `bank:tools` 而不是 `core:agent`：这些是**读核心**的参数（超时、熔断、取数上限），
   * 属数据层；`core:agent` 只管"要不要读"。
   */
  readonly contextSlots: ContextSlotSettings
  /**
   * 策略引擎模式（策略外置 S2）。
   *
   * - `legacy`（缺省）：`createTierPolicy` = 既有 `tier.ts`，行为逐字不变；
   * - `bundle`：用 `policy:rules` 提供的外置规则引擎；缺服务 = 启动失败。
   *
   * **不写版本**：版本的唯一来源是 `policy:rules.active` / `runtime-state.json`，
   * 两处配置打架时没人知道哪份是真的（03 §3.1）。
   */
  readonly policy: {
    readonly engine: 'legacy' | 'bundle'
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
  /**
   * 日累计转账限额（元）。赛题分级线：黄色 ≤ 1000 元，红色 > 1000 元。
   *
   * 这个数同时决定**判决**（`tier.ts` 的 `min(预览卡限额, 本值)`）与**展示**
   * （`core/mock.ts` 的 `dailyLimitOf` 也取 min）——改一处，两处一起变。
   */
  dailyTransferLimit: 1_000,
  riskyOps: ['transfer_create', 'wealth_purchase'],
  riskyCallThreshold: 3,
  // W09：默认走测试网关适配器；`mock` 只是回滚开关（两者行为在演示档等价）。
  verify: { provider: 'gateway', successAfter: 1, maxAttempts: 3, lockMinutes: 30 },
  // W12：默认 lease 窗口 = 票据 TTL（等价于今日行为）；要更紧的窗口由 profile 显式调小。
  ticketLease: { enforce: true, ttlSeconds: 120 },
  // 实体槽位：默认值与 02 §ES-23 / 00 §5.1 逐字一致（数据行 800 字符、超时 250ms、熔断 3×10s）
  contextSlots: DEFAULT_CONTEXT_SLOTS,
  // 策略外置：S2 默认 legacy（零行为变化）；S3 由各 profile 显式写 bundle
  policy: { engine: 'legacy' },
}

/** 允许的强验证渠道。 */
const CHANNELS: readonly StrongAuth[] = ['face', 'sms', 'ushield']

/** 强验证 Provider 选择（W09 §5 的 `verify.provider` 回滚开关）。 */
const VERIFY_PROVIDERS = ['mock', 'gateway'] as const

/** 允许的造数档位。 */
const DATASET_TIERS: readonly ForgeTier[] = ['demo', 'stress', 'adversarial']

/** 允许的策略引擎模式（策略外置 S2）。 */
const POLICY_ENGINES = ['legacy', 'bundle'] as const

/**
 * 槽位告警出口（`runtime:context-source` 的 `warn`）。
 *
 * bank 适配器只报 code + 计数/窗口（脱敏在那边做），这里统一转结构化日志。
 * 抽成具名导出是为了单测：熔断打开需要核心真的故障，而 `MockBankCore` 的读路径
 * 不抛错，host 级装配走不到这条回调。
 */
export function warnContextSlots(
  code: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  logJson('warn', code, fields)
}

export const bankToolsPlugin: HostPlugin<BankToolsSettings> = {
  id: 'bank:tools',

  plugin: {
    name: 'bank:tools',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, TOOLS_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      // 租户盐（01 TA-14）：让 `stress` / `adversarial` 档的仿真数据按租户不同；
      // `demo` 档造数是固定脚本（不含随机源），盐对它**没有作用**——这是刻意的，
      // 见 `tenantSaltOf` 与 `docs/contracts/tenant-model.md` 的"明确不声称"。
      const dataset = buildBankDataset({
        seed: config.seed,
        tier: config.datasetTier,
        now: run.now(),
        tenantSalt: tenantSaltOf(String(run.tenantId)),
      })
      // 日限额与 Config 同源：core 账本只负责「已用多少」，上限由 Config 收紧
      const core = new MockBankCore({
        data: dataset,
        now: run.now,
        limits: { ...dataset.limits, dailyTransferLimitCents: yuanToCents(config.dailyTransferLimit) },
      })
      const verify = new VerifyService({
        provider:
          config.verify.provider === 'gateway'
            ? createGatewayVerifyProvider({ successAfter: config.verify.successAfter })
            : createMockVerifyProvider({ successAfter: config.verify.successAfter }),
        maxAttempts: config.verify.maxAttempts,
        lockMs: config.verify.lockMinutes * 60_000,
        now: run.now,
      })
      // 票据状态机的宿主出口（状态读取 + 熔断批量吊销；核销入口不外泄）。
      // 施工单 10 §5：sentry 的断路器只通过这个窄端口吊销在途票据，不自己核销。
      // 只交出两个方法——`issue/approve/block/redeem` 留在 bank-core，不跨包可见。
      const ticketGuard: TicketGuard = {
        status: (ticketId) => core.tickets.status(ticketId),
        revokeAll: (reason, at) => core.tickets.revokeAll(reason, at),
      }
      ctx.effect(ctx.provide(BANK_TICKET_GUARD, ticketGuard))

      // W12：冲正窄端口（saga 补偿调用）。只交出 reverse / reversalOf，
      // 不暴露票据、审批或任意账本写入面。
      ctx.effect(
        ctx.provide(BANK_COMPENSATION, {
          reverse: (txnId) => core.reverse(txnId),
          reversalOf: (txnId) => core.reversalOf(txnId),
        }),
      )

      const session = ctx.get(SESSION_SERVICE)
      const identity = new SessionIdentityStore()
      ctx.effect(ctx.provide(BANK_IDENTITY, identity))
      // 回放 / 重启：`identity/bound` 是 durable 事实，先按日志恢复。
      // 租户取当前进程（日志所在目录即证明），见 `restoreSessionIdentity` 的注释
      restoreSessionIdentity(identity, run.sessionId, session.events(), String(run.tenantId))
      // 演示档的**显式**身份：写进 profile，不写就保持未绑定（无隐式默认账户）
      if (
        config.demoUserId !== undefined &&
        identity.resolve(run.sessionId) !== config.demoUserId
      ) {
        identity.bind(run.sessionId, config.demoUserId, String(run.tenantId))
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
            identity.bind(target, userId, String(run.tenantId))
            appendIdentityBound(session, { userId, method, at: run.now() })
          },
        },
      })
      ctx.effect(ctx.provide(CREDENTIALS, credentials))

      /**
       * 实体槽位数据源（`runtime:context-source`）。
       *
       * - 端口是**每 host 一个实例**：熔断状态跨会话共享（核心挂了不该每个会话各等 250ms）；
       * - `warn` 只透传 code + 计数/窗口（`logJson` 自己还会丢 key/token 类字段）；
       * - `core:agent` 懒取它（不在 `inject` 里），因为 base 不能被 bank 绑死。
       */
      ctx.effect(
        ctx.provide(
          RUNTIME_CONTEXT_SOURCE,
          createBankContextSource({
            core,
            identity,
            settings: config.contextSlots,
            warn: warnContextSlots,
          }),
        ),
      )

      const audit: BankAudit = {
        append: (type, data) => {
          // 领域键由本包声明（`tools/events.ts` 的模块增强）；统一走 `appendDomain`，
          // 落账一律补 `ignorable: true`（平台 reader 不认识领域族）。
          session.appendDomain(type, data, { ignorable: true })
        },
      }
      // 票据生命周期账本（施工单 09 §3）：每次转移落 `ticket/*`，核销属主仍是 bank-core
      const tickets = new TicketLedger({
        record: (record) => {
          session.appendDomain(record.type, record.data, { ignorable: true })
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
        // `safety:sandbox` 在场时走 worker 硬隔离。
        //
        // D5①（fail-closed）：**缺这行不再回退进程内求值**。以前 service-missing 就退到
        // `defaultCompute`——那等于"漏装一行装配 = 模型生成的表达式直接在宿主进程里跑"，
        // 是典型的 fail-open。现在返回 `compute-sandbox-unavailable`，工具面表现为结构化失败，
        // 装配漏行会立刻暴露，而不是悄悄降级。
        compute: async (request) => {
          let seam
          try {
            seam = ctx.get(BANK_COMPUTE)
          } catch (error) {
            if ((error as { code?: string }).code !== 'service-missing') throw error
            throw new BahError(
              'compute-sandbox-unavailable',
              'bank-tools: 未装配 safety:sandbox，受限计算拒绝执行（fail-closed）',
            )
          }
          return seam(request)
        },
      }

      const registry = ctx.get(TOOLS_SERVICE)
      for (const definition of createBankTools(deps)) {
        ctx.effect(registry.register(definition))
      }

      /**
       * 契约注册表（W03）：把本包的工具目录包成 `runtime:tool-contracts` 的实现。
       *
       * **这一行不通电，整条 G-1 校验就等于没做**——`pipeline` 拿不到契约会静默跳过校验
       * （见 `packages/runtime/src/tools/contracts.ts` 的"缺省不校验"说明）。
       *
       * `argsSchema` 直接复用 `spec.schema`：它本来就是入参 JSON Schema，
       * 再抄一份就是第二真相源（TC-W03-08 的"快照 diff=0"也靠这个保证）。
       * 没写 `resultSchema` 的工具返回 `{}`（无约束）= 出参不校验，属登记的降级。
       */
      ctx.effect(
        provideToolContracts(ctx, {
          get: (name) => {
            if (!BANK_TOOL_NAME_SET.has(name)) return undefined
            const spec = specOf(name as BankToolName)
            return {
              argsSchema: spec.schema,
              resultSchema: BANK_RESULT_SCHEMAS[name as BankToolName] ?? {},
              validateAt: 'pre-execute',
            }
          },
        }),
      )

      // 策略引擎（W04 + 策略外置 S2）。
      //
      // - `legacy`：直接用 `createTierPolicy`（= 既有 tier.ts，零行为变化）；
      // - `bundle`：**必须**拿到 `runtime:policy`，否则启动失败（I15：没有静默回退）。
      //   传**函数**而不是对象：热重载换引擎后下一次判决就生效，重载不需要重建治理平面。
      const mode = config.policy.engine
      const inlinePolicy = findPolicyEngine(ctx)
      if (mode === 'bundle' && inlinePolicy === undefined) {
        throw new BahError(
          'policy-service-missing',
          'bank:tools.policy.engine=bundle 但没有装配 policy:rules（或它排在 bank:tools 之后）',
          { where: 'bank:tools.policy.engine' },
        )
      }
      /**
       * 早拒路径的"当前生效版本"必须**每次判决时读**：热重载后描述符是活引用，
       * 装配期捕获字符串会把所有后续早拒判决钉在旧版本上（I12）。
       */
      const activePolicyVersion = (): string =>
        mode === 'bundle' ? (findPolicyDescriptor(ctx)?.version ?? 'unknown') : 'legacy'
      if (mode === 'bundle') {
        const params = { riskyCallThreshold: config.riskyCallThreshold }
        assertPolicyParams(findPolicyDescriptor(ctx), params)
        // 热重载换 bundle 时，policy:rules 在原子替换前回调这里；绑定不兼容 = 拒绝重载
        ctx.effect(
          providePolicyParamCheck(ctx, (descriptor) => {
            assertPolicyParams(descriptor, params)
          }),
        )
      }
      provideBankGovernance({
        ctx,
        sessionId: run.sessionId,
        deps,
        lifecycle: tickets,
        policy: mode === 'bundle' ? () => findPolicyEngine(ctx) : (inlinePolicy ?? undefined),
        policyEngineMode: mode,
        activePolicyVersion,
        lease: {
          enforce: config.ticketLease.enforce,
          ttlMs: config.ticketLease.ttlSeconds * 1_000,
        },
      })
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
        'ticketLease',
        'contextSlots',
        'policy',
      ],
      'bank:tools',
    )

    const demoUserId = readString(config, 'demoUserId', 'bank:tools')
    const verify = config['verify'] === undefined ? {} : asRecord(config['verify'], 'bank:tools.verify')
    rejectUnknownKeys(
      verify,
      ['provider', 'successAfter', 'maxAttempts', 'lockMinutes'],
      'bank:tools.verify',
    )
    const ticketTtlSeconds =
      readPositiveInteger(config, 'ticketTtlSeconds', 'bank:tools') ??
      DEFAULT_BANK_TOOLS.ticketTtlSeconds
    const leaseConfig =
      config['ticketLease'] === undefined
        ? {}
        : asRecord(config['ticketLease'], 'bank:tools.ticketLease')
    rejectUnknownKeys(leaseConfig, ['enforce', 'ttlSeconds'], 'bank:tools.ticketLease')
    const leaseTtlSeconds =
      readPositiveInteger(leaseConfig, 'ttlSeconds', 'bank:tools.ticketLease') ?? ticketTtlSeconds
    // TC-W12-09：装配期 fail-loud。运行期用 Math.min 兜住是防御，不是许可——
    // 配置把 lease 写得比票据还长，等于宣称"短窗口"却发了一张全窗口的票。
    if (leaseTtlSeconds > ticketTtlSeconds) {
      throw bootError(
        'invalid-config',
        `bank:tools.ticketLease.ttlSeconds(${String(leaseTtlSeconds)}s) 不得大于 ` +
          `ticketTtlSeconds(${String(ticketTtlSeconds)}s)：lease 是票据 TTL 内的短窗口`,
        { where: 'bank:tools.ticketLease', leaseTtlSeconds, ticketTtlSeconds },
      )
    }
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

    // 策略外置（S3）：整块只允许 `engine`；值只有两档
    const policyConfig =
      config['policy'] === undefined ? {} : asRecord(config['policy'], 'bank:tools.policy')
    rejectUnknownKeys(policyConfig, ['engine'], 'bank:tools.policy')
    const policyEngine =
      readEnum(policyConfig, 'engine', 'bank:tools.policy', POLICY_ENGINES) ??
      DEFAULT_BANK_TOOLS.policy.engine

    // 实体槽位：七键各自有界；越界是配置错误（运行期不许"静默收敛成一个别的数"）
    const contextSlotsRecord =
      config['contextSlots'] === undefined
        ? {}
        : asRecord(config['contextSlots'], 'bank:tools.contextSlots')
    rejectUnknownKeys(
      contextSlotsRecord,
      [
        'accounts',
        'transactions',
        'windowDays',
        'timeoutMs',
        'maxChars',
        'breakerFailures',
        'breakerOpenMs',
      ],
      'bank:tools.contextSlots',
    )
    const bounded = (key: string, min: number, max: number, fallback: number): number => {
      const value = readPositiveInteger(contextSlotsRecord, key, 'bank:tools.contextSlots')
      if (value === undefined) return fallback
      if (value < min || value > max) {
        throw bootError(
          'invalid-config',
          `bank:tools.contextSlots.${key} 必须在 ${String(min)}..${String(max)}（收到 ${String(value)}）`,
          { where: 'bank:tools.contextSlots', key, value, min, max },
        )
      }
      return value
    }
    const contextSlots: ContextSlotSettings = {
      accounts: bounded('accounts', 1, 10, DEFAULT_CONTEXT_SLOTS.accounts),
      transactions: bounded('transactions', 1, 10, DEFAULT_CONTEXT_SLOTS.transactions),
      windowDays: bounded('windowDays', 1, 365, DEFAULT_CONTEXT_SLOTS.windowDays),
      timeoutMs: bounded('timeoutMs', 50, 5_000, DEFAULT_CONTEXT_SLOTS.timeoutMs),
      maxChars: bounded('maxChars', 200, 2_000, DEFAULT_CONTEXT_SLOTS.maxChars),
      breakerFailures: bounded('breakerFailures', 1, 10, DEFAULT_CONTEXT_SLOTS.breakerFailures),
      breakerOpenMs: bounded('breakerOpenMs', 1_000, 60_000, DEFAULT_CONTEXT_SLOTS.breakerOpenMs),
    }

    return {
      ...(demoUserId === undefined ? {} : { demoUserId }),
      seed: readPositiveInteger(config, 'seed', 'bank:tools') ?? DEFAULT_BANK_TOOLS.seed,
      datasetTier:
        readEnum(config, 'datasetTier', 'bank:tools', DATASET_TIERS) ??
        DEFAULT_BANK_TOOLS.datasetTier,
      disclaimerId:
        readString(config, 'disclaimerId', 'bank:tools') ?? DEFAULT_BANK_TOOLS.disclaimerId,
      ticketTtlSeconds,
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
      ticketLease: {
        enforce: readBoolean(leaseConfig, 'enforce', 'bank:tools.ticketLease', true),
        ttlSeconds: leaseTtlSeconds,
      },
      contextSlots,
      policy: { engine: policyEngine },
      verify: {
        provider:
          readEnum(verify, 'provider', 'bank:tools.verify', VERIFY_PROVIDERS) ??
          DEFAULT_BANK_TOOLS.verify.provider,
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
  session.appendDomain('identity/bound', data, { ignorable: true })
}

/**
 * 参数绑定校验（02 §3.1）：bundle 只声明参数名/类型/边界，**值只来自 `bank:tools`**。
 *
 * 三条都要报 `policy-param-mismatch`（而不是静默用默认值）：
 * 1. 声明了但部署没给 → 求值器会拿到 `undefined`（`validateInput` 会拒，但那是运行期）；
 * 2. 部署给了但 bundle 没声明 → 改这个参数不会改变判决，改它是自欺；
 * 3. 值越界 → bundle 的语义假设被破坏（它按区间写了规则）。
 *
 * 这是**启动期**校验：坏配置不该等到第一笔转账才发现。
 */
function assertPolicyParams(
  descriptor: PolicyDescriptor | undefined,
  values: Readonly<Record<string, number>>,
): void {
  const declared = descriptor?.parameters ?? {}
  const declaredKeys = Object.keys(declared).sort()
  const actualKeys = Object.keys(values).sort()
  if (
    declaredKeys.length !== actualKeys.length ||
    declaredKeys.some((key, index) => key !== actualKeys[index])
  ) {
    throw new BahError(
      'policy-param-mismatch',
      `bundle 声明的参数 [${declaredKeys.join(', ')}] 与部署参数 [${actualKeys.join(', ')}] 不一致`,
      { declared: declaredKeys.join(','), actual: actualKeys.join(',') },
    )
  }
  for (const key of declaredKeys) {
    const spec = declared[key]
    const value = values[key]
    if (spec === undefined || value === undefined) continue
    if (value < spec.min || value > spec.max) {
      throw new BahError(
        'policy-param-mismatch',
        `参数 ${key}=${String(value)} 超出 bundle 声明的区间 [${String(spec.min)}, ${String(spec.max)}]`,
        { key, value, min: spec.min, max: spec.max },
      )
    }
  }
}
