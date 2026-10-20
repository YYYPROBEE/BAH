/**
 * `safety:sentry` 的配置面（施工单 10 §2 的两处适配之一：**fail-loud**）。
 *
 * 三条纪律：
 * 1. 阈值 / 窗口 / 白名单**只来自 Config**，模型输出与用户输入都改不了（施工单 10 §9）；
 * 2. 未知键、类型错、阈值越界、正则编译失败 → 载入即抛（错误前缀 `bah-sentry: `）；
 * 3. 默认值必须"不误冻演示主线"（施工单 10 §9 风险表）：demo 档一次转账只有 1–2 个工具调用，
 *    默认预算与熔断阈值都留出数量级余量。
 *
 * 本文件不依赖 `@bah/host` 的 boot 校验器：安全包要在任何宿主（含裸 Node 演示）可加载，
 * 所以校验原语在这里自成一套（行为一致：按键拒绝 + 类型化 `BahError`）。
 */

import {
  BahError,
  readConfigBoolean,
  readConfigEnum,
  readConfigPositiveInteger,
  rejectUnknownConfigKeys,
} from '@bah/util'

import type { ExtraRule } from '../kernel/index.ts'

/** 检测器阈值（透传内核 `detect()`；只允许 0–1 且 warn < high）。 */
export interface SentryDetectorSettings {
  readonly warnThreshold: number
  readonly highThreshold: number
}

/** 规则面配置。 */
export interface SentryRuleSettings {
  /** 停用的内置规则 ID（13 条之外的 ID 也允许写：内核会忽略，配置不因此报错）。 */
  readonly disabled: readonly string[]
  /** NET-001 的 demo/example/mock 校准位（施工单 10 §2 的规则级白名单）。 */
  readonly demoWhitelist: boolean
  /** 是否启用内置的跨场景提权规则（XSC-*，施工单 10 §3 第 4 行）。 */
  readonly crossScenario: boolean
  /** 部署侧追加规则（正则字符串在载入时编译，失败即抛）。 */
  readonly extra: readonly ExtraRule[]
}

/** 预算账本配置（`amount` 维度以元配置，落到内核时换成分）。 */
export interface SentryBudgetSettings {
  readonly totalCalls: number
  readonly riskyCalls: number
  readonly amountYuan: number
}

/** 断路器配置（施工单 10 §5）。 */
export interface SentryBreakerSettings {
  readonly denyThreshold: number
  readonly windowSeconds: number
  /** 冻结时是否吊销 bank-core 的全部在途票据（唯一属主仍是 bank-core）。 */
  readonly revokeTickets: boolean
}

/** 非法参数降级配置（施工单 10 §5 第 4 行）。 */
export interface SentryDegradeSettings {
  readonly invalidArgsThreshold: number
}

/** 循环 guard 配置（施工单 10 §5 第 3 行）。 */
export interface SentryGuardSettings {
  readonly maxToolsPerTurn: number
}

/** 幻觉防护配置（施工单 10 §4）。 */
export interface SentryHonestySettings {
  /** 数值对账（post-execute + turn-stopping 两处）。 */
  readonly numeric: boolean
  /** 无工具结果不陈述（turn-stopping）。 */
  readonly noResult: boolean
}

/** TraceLog 配置（施工单 10 §2 第 8 件）。 */
export interface SentryTraceSettings {
  readonly ringSize: number
  readonly flushThreshold: number
  /**
   * 落盘出口：
   * - `memory` = 只留内存环；
   * - `session` = 逐条落 durable 会话事件（可回放，推荐）；
   * - `stderr` = 逐批写标准错误（仅演示；生产环境宿主会 fail-loud）。
   */
  readonly sink: 'memory' | 'stderr' | 'session'
}

/** `safety:sentry` 的完整配置（校验后形状）。 */
export interface SentrySettings {
  readonly detector: SentryDetectorSettings
  readonly rules: SentryRuleSettings
  readonly budget: SentryBudgetSettings
  readonly breaker: SentryBreakerSettings
  readonly degrade: SentryDegradeSettings
  readonly guard: SentryGuardSettings
  readonly honesty: SentryHonestySettings
  readonly trace: SentryTraceSettings
}

/** 各层允许的键（与校验器共用，避免"文档里能写、代码里不认"）。 */
export const SENTRY_CONFIG_KEYS = {
  root: ['detector', 'rules', 'budget', 'breaker', 'degrade', 'guard', 'honesty', 'trace'],
  detector: ['warnThreshold', 'highThreshold'],
  rules: ['disabled', 'demoWhitelist', 'crossScenario', 'extra'],
  rule: ['id', 'pattern', 'family', 'note'],
  budget: ['totalCalls', 'riskyCalls', 'amountYuan'],
  breaker: ['denyThreshold', 'windowSeconds', 'revokeTickets'],
  degrade: ['invalidArgsThreshold'],
  guard: ['maxToolsPerTurn'],
  honesty: ['numeric', 'noResult'],
  trace: ['ringSize', 'flushThreshold', 'sink'],
} as const

/**
 * 默认配置。
 *
 * 关键数字的来由（施工单 10 §9「不误冻演示主线」）：
 * - `denyThreshold=5`：幕 2 只产生 1 次拒绝，幕 3 是 0 次；
 * - `budget.amountYuan=200000`：demo 的 800 元与 T-SNT-001 的 5 万元都在额度内；
 * - `maxToolsPerTurn=12`：正常一步 1–2 个工具，离上限有一个数量级。
 */
export const DEFAULT_SENTRY_SETTINGS: SentrySettings = {
  detector: { warnThreshold: 0.45, highThreshold: 0.8 },
  // XSC-001/002 是"部署侧追加规则"：默认关，演示/压测 profile 显式打开。
  // 上线前用 `pnpm sentry:fp` 跑真实语料统计（见 docs/sentry.md §10.7）。
  rules: { disabled: [], demoWhitelist: true, crossScenario: false, extra: [] },
  budget: { totalCalls: 60, riskyCalls: 20, amountYuan: 200_000 },
  breaker: { denyThreshold: 5, windowSeconds: 600, revokeTickets: true },
  degrade: { invalidArgsThreshold: 3 },
  guard: { maxToolsPerTurn: 12 },
  honesty: { numeric: true, noResult: true },
  trace: { ringSize: 200, flushThreshold: 1, sink: 'memory' },
}

/**
 * 内置的跨场景提权规则（施工单 10 §3 第 4 行的确定性拦截面）。
 *
 * 为什么放在 Config 面而不是内核：内核的 13 条规则**算法与阈值不变**（施工单 10 §9）——
 * 这两个正则属于"部署侧追加规则"（内核 `ScanToolArgsOptions.extraRules` 的既有能力），
 * 用 `rules.crossScenario` 一键开关。
 */
export const CROSS_SCENARIO_RULES: readonly ExtraRule[] = [
  {
    id: 'XSC-001',
    family: 'privilege',
    note: '跨场景额度套用指示',
    pattern: /(跨场景|跨业务|跨产品).{0,16}(转账|支付|提现|套现|转出|额度)/,
  },
  {
    id: 'XSC-002',
    family: 'privilege',
    note: '绕过额度限制指示',
    pattern: /(绕过|绕开|规避|突破|骗过|套出).{0,16}(额度|限额|上限|风控)/,
  },
]

/**
 * 校验并补齐默认值（施工单 10 硬约束 3：配置缺失/非法 → 载入即抛）。
 *
 * @param raw 原始配置对象（`{}` = 全默认）
 * @returns 校验后的完整配置
 * @throws `BahError`（`code` 以 `sentry-` 开头、`message` 以 `bah-sentry: ` 开头）
 */
export function resolveSentrySettings(
  raw: Readonly<Record<string, unknown>> = {},
): SentrySettings {
  rejectUnknown(raw, SENTRY_CONFIG_KEYS.root, 'safety:sentry')

  const detector = readSection(raw, 'detector', SENTRY_CONFIG_KEYS.detector)
  const rules = readSection(raw, 'rules', SENTRY_CONFIG_KEYS.rules)
  const budget = readSection(raw, 'budget', SENTRY_CONFIG_KEYS.budget)
  const breaker = readSection(raw, 'breaker', SENTRY_CONFIG_KEYS.breaker)
  const degrade = readSection(raw, 'degrade', SENTRY_CONFIG_KEYS.degrade)
  const guard = readSection(raw, 'guard', SENTRY_CONFIG_KEYS.guard)
  const honesty = readSection(raw, 'honesty', SENTRY_CONFIG_KEYS.honesty)
  const trace = readSection(raw, 'trace', SENTRY_CONFIG_KEYS.trace)

  const warnThreshold = readRatio(
    detector,
    'warnThreshold',
    'safety:sentry.detector',
    DEFAULT_SENTRY_SETTINGS.detector.warnThreshold,
  )
  const highThreshold = readRatio(
    detector,
    'highThreshold',
    'safety:sentry.detector',
    DEFAULT_SENTRY_SETTINGS.detector.highThreshold,
  )
  if (warnThreshold >= highThreshold) {
    throw sentryConfigError(
      'sentry-invalid-config',
      `safety:sentry.detector 的 warnThreshold（${warnThreshold}）必须小于 highThreshold（${highThreshold}）`,
      { warnThreshold, highThreshold },
    )
  }

  return {
    detector: { warnThreshold, highThreshold },
    rules: {
      disabled: readStringArray(rules, 'disabled', 'safety:sentry.rules') ?? [],
      demoWhitelist: readBoolean(
        rules,
        'demoWhitelist',
        'safety:sentry.rules',
        DEFAULT_SENTRY_SETTINGS.rules.demoWhitelist,
      ),
      crossScenario: readBoolean(
        rules,
        'crossScenario',
        'safety:sentry.rules',
        DEFAULT_SENTRY_SETTINGS.rules.crossScenario,
      ),
      extra: readExtraRules(rules),
    },
    budget: {
      totalCalls: readPositiveInteger(
        budget,
        'totalCalls',
        'safety:sentry.budget',
        DEFAULT_SENTRY_SETTINGS.budget.totalCalls,
      ),
      riskyCalls: readPositiveInteger(
        budget,
        'riskyCalls',
        'safety:sentry.budget',
        DEFAULT_SENTRY_SETTINGS.budget.riskyCalls,
      ),
      amountYuan: readPositiveInteger(
        budget,
        'amountYuan',
        'safety:sentry.budget',
        DEFAULT_SENTRY_SETTINGS.budget.amountYuan,
      ),
    },
    breaker: {
      denyThreshold: readPositiveInteger(
        breaker,
        'denyThreshold',
        'safety:sentry.breaker',
        DEFAULT_SENTRY_SETTINGS.breaker.denyThreshold,
      ),
      windowSeconds: readPositiveInteger(
        breaker,
        'windowSeconds',
        'safety:sentry.breaker',
        DEFAULT_SENTRY_SETTINGS.breaker.windowSeconds,
      ),
      revokeTickets: readBoolean(
        breaker,
        'revokeTickets',
        'safety:sentry.breaker',
        DEFAULT_SENTRY_SETTINGS.breaker.revokeTickets,
      ),
    },
    degrade: {
      invalidArgsThreshold: readPositiveInteger(
        degrade,
        'invalidArgsThreshold',
        'safety:sentry.degrade',
        DEFAULT_SENTRY_SETTINGS.degrade.invalidArgsThreshold,
      ),
    },
    guard: {
      maxToolsPerTurn: readPositiveInteger(
        guard,
        'maxToolsPerTurn',
        'safety:sentry.guard',
        DEFAULT_SENTRY_SETTINGS.guard.maxToolsPerTurn,
      ),
    },
    honesty: {
      numeric: readBoolean(
        honesty,
        'numeric',
        'safety:sentry.honesty',
        DEFAULT_SENTRY_SETTINGS.honesty.numeric,
      ),
      noResult: readBoolean(
        honesty,
        'noResult',
        'safety:sentry.honesty',
        DEFAULT_SENTRY_SETTINGS.honesty.noResult,
      ),
    },
    trace: {
      ringSize: readPositiveInteger(
        trace,
        'ringSize',
        'safety:sentry.trace',
        DEFAULT_SENTRY_SETTINGS.trace.ringSize,
      ),
      flushThreshold: readPositiveInteger(
        trace,
        'flushThreshold',
        'safety:sentry.trace',
        DEFAULT_SENTRY_SETTINGS.trace.flushThreshold,
      ),
      sink: readEnum(
        trace,
        'sink',
        'safety:sentry.trace',
        ['memory', 'stderr', 'session'] as const,
        DEFAULT_SENTRY_SETTINGS.trace.sink,
      ),
    },
  }
}

/** 构造带包前缀的结构化配置错误。 */
function sentryConfigError(code: string, message: string, detail?: unknown): BahError {
  return new BahError(code, `bah-sentry: ${message}`, detail)
}

const invalidSentry = (message: string, detail: Readonly<Record<string, unknown>>): never => {
  throw sentryConfigError('sentry-invalid-config', message, detail)
}
const unknownSentry = (message: string, detail: Readonly<Record<string, unknown>>): never => {
  throw sentryConfigError('sentry-unknown-config-key', message, detail)
}

/** 拒绝未声明的键。 */
function rejectUnknown(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
): void {
  rejectUnknownConfigKeys(record, allowed, where, unknownSentry)
}

/** 取一个子配置段（未写 = 空对象；非对象即抛）。 */
function readSection(
  record: Readonly<Record<string, unknown>>,
  key: string,
  allowed: readonly string[],
): Readonly<Record<string, unknown>> {
  const value = record[key]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw sentryConfigError(
      'sentry-invalid-config',
      `safety:sentry.${key} 必须是对象（收到 ${describe(value)}）`,
      { key },
    )
  }
  const section = value as Readonly<Record<string, unknown>>
  rejectUnknown(section, allowed, `safety:sentry.${key}`)
  return section
}

/** 读 0–1 之间的阈值。 */
function readRatio(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: number,
): number {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw sentryConfigError(
      'sentry-invalid-config',
      `${where}.${key} 必须是 (0, 1] 之间的数字（收到 ${describe(value)}）`,
      { where, key },
    )
  }
  return value
}

/** 读布尔（未写取默认值）。 */
function readBoolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: boolean,
): boolean {
  return readConfigBoolean(record, key, where, fallback, invalidSentry)
}

/** 读正整数（未写取默认值）。 */
function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: number,
): number {
  return readConfigPositiveInteger(record, key, where, fallback, invalidSentry) ?? fallback
}

/** 读字符串数组（未写返回 `undefined`；空串成员即抛）。 */
function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): readonly string[] | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw sentryConfigError(
      'sentry-invalid-config',
      `${where}.${key} 必须是非空字符串数组（收到 ${describe(value)}）`,
      { where, key },
    )
  }
  return [...(value as readonly string[])]
}

/** 读单值枚举（未写取默认值）。 */
function readEnum<T extends string>(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return readConfigEnum(record, key, where, allowed, fallback, invalidSentry) ?? fallback
}

/** 读追加规则（逐条校验并按字符串编译正则，失败即抛）。 */
function readExtraRules(record: Readonly<Record<string, unknown>>): readonly ExtraRule[] {
  const value = record['extra']
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw sentryConfigError(
      'sentry-invalid-config',
      `safety:sentry.rules.extra 必须是数组（收到 ${describe(value)}）`,
      { key: 'extra' },
    )
  }
  const rules: ExtraRule[] = []
  const ids = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw sentryConfigError(
        'sentry-invalid-config',
        `safety:sentry.rules.extra[${index}] 必须是对象`,
        { index },
      )
    }
    const rule = item as Readonly<Record<string, unknown>>
    rejectUnknown(rule, SENTRY_CONFIG_KEYS.rule, `safety:sentry.rules.extra[${index}]`)
    const id = rule['id']
    const pattern = rule['pattern']
    if (typeof id !== 'string' || id.length === 0) {
      throw sentryConfigError(
        'sentry-invalid-config',
        `safety:sentry.rules.extra[${index}].id 必须是非空字符串`,
        { index },
      )
    }
    if (ids.has(id)) {
      throw sentryConfigError(
        'sentry-invalid-config',
        `safety:sentry.rules.extra 的规则 ID 重复：${id}`,
        { id },
      )
    }
    if (typeof pattern !== 'string' || pattern.length === 0) {
      throw sentryConfigError(
        'sentry-invalid-config',
        `safety:sentry.rules.extra[${index}].pattern 必须是非空字符串`,
        { index, id },
      )
    }
    let compiled: RegExp
    try {
      compiled = new RegExp(pattern)
    } catch (error) {
      throw sentryConfigError(
        'sentry-invalid-rule',
        `safety:sentry.rules.extra[${index}].pattern 不是合法正则：${messageOf(error)}`,
        { index, id, pattern },
      )
    }
    const family = readOptionalString(rule, 'family', `safety:sentry.rules.extra[${index}]`)
    const note = readOptionalString(rule, 'note', `safety:sentry.rules.extra[${index}]`)
    ids.add(id)
    rules.push({
      id,
      pattern: compiled,
      ...(family === undefined ? {} : { family }),
      ...(note === undefined ? {} : { note }),
    })
  }
  return rules
}

/** 读可选字符串（未写返回 `undefined`；类型错即抛）。 */
function readOptionalString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw sentryConfigError(
      'sentry-invalid-config',
      `${where}.${key} 必须是非空字符串（收到 ${describe(value)}）`,
      { where, key },
    )
  }
  return value
}

/** 配置值 → 可读文本（错误文案用）。 */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value)
    } catch {
      // 不可序列化值（循环引用 / BigInt）：退化成 String，错误文案仍可读
      return String(value)
    }
  }
  return String(value)
}

/** 任意抛出物 → 可读理由。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
