/**
 * `channel:web` 的配置面（W16 从 `web.ts` 拆出）。
 *
 * 为什么单独一个文件：配置解析与 `apply()` 的装配是**两种变化原因**——前者随部署变化
 * （端口、静态目录、限流、CSRF 开关），后者随路由变化。混在一起，`apply()` 永远降不到
 * 120 行以下（施工单 §2.1 的实测结论），而配置校验塞进 handler 又会让 handler 反过来
 * 依赖配置面。
 */

import { BahError } from '@bah/util'

import { readBoolean, readPositiveInteger, readString, rejectUnknownKeys } from '../../config.ts'

/** `channel:web` 的配置（全部随部署变化 → 全部可校验）。 */
export interface WebSettings {
  /** 监听端口（默认 7331）。 */
  readonly port: number
  /** 监听地址（默认 127.0.0.1；对外暴露需显式改）。 */
  readonly host: string
  /** 静态根（默认 `apps/web`；纯原生 ES 模块，无需构建）。 */
  readonly staticRoot: string
  /** SSE 心跳间隔（ms，默认 15000）。 */
  readonly heartbeatMs: number
  /** 每个来源的固定窗口限流（默认 60s / 120 次）。 */
  readonly rateLimit: {
    readonly windowMs: number
    readonly maxRequests: number
  }
  /** CSRF 加固（W09）：写请求要求同源 Origin 或 double-submit cookie。 */
  readonly csrf: {
    readonly enabled: boolean
  }
  /** 人工接管（C5）：等待超时告警。 */
  readonly handoff: {
    /** SLA 毫秒（默认 180_000；0 = 只记录不告警）。**不自动交回**。 */
    readonly slaMs: number
  }
}

/** 默认配置。 */
export const DEFAULT_WEB: WebSettings = {
  port: 7331,
  host: '127.0.0.1',
  staticRoot: 'apps/web',
  heartbeatMs: 15_000,
  rateLimit: { windowMs: 60_000, maxRequests: 120 },
  csrf: { enabled: true },
  handoff: { slaMs: 180_000 },
}

/** 解析 `rateLimit` 配置（未写时用默认值）。 */
export function parseRateLimit(value: unknown): WebSettings['rateLimit'] {
  if (value === undefined) return DEFAULT_WEB.rateLimit
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BahError('web-invalid-config', 'channel:web: rateLimit 必须是对象')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, ['windowMs', 'maxRequests'], 'channel:web.rateLimit')
  return {
    windowMs:
      readPositiveInteger(record, 'windowMs', 'channel:web.rateLimit') ??
      DEFAULT_WEB.rateLimit.windowMs,
    maxRequests:
      readPositiveInteger(record, 'maxRequests', 'channel:web.rateLimit') ??
      DEFAULT_WEB.rateLimit.maxRequests,
  }
}

/** 解析 `csrf` 配置（未写时用默认值）。 */
export function parseCsrf(value: unknown): WebSettings['csrf'] {
  if (value === undefined) return DEFAULT_WEB.csrf
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BahError('web-invalid-config', 'channel:web: csrf 必须是对象')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, ['enabled'], 'channel:web.csrf')
  return { enabled: readBoolean(record, 'enabled', 'channel:web.csrf', DEFAULT_WEB.csrf.enabled) }
}

/** 解析 `handoff` 配置（未写时用默认值）。 */
export function parseHandoff(value: unknown): WebSettings['handoff'] {
  if (value === undefined) return DEFAULT_WEB.handoff
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BahError('web-invalid-config', 'channel:web: handoff 必须是对象')
  }
  const record = value as Record<string, unknown>
  rejectUnknownKeys(record, ['slaMs'], 'channel:web.handoff')
  const raw = record['slaMs']
  // 与 readPositiveInteger 的差别：**0 合法**（关闭告警）
  if (
    raw !== undefined &&
    (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0)
  ) {
    throw new BahError('web-invalid-config', 'channel:web: handoff.slaMs 必须是非负整数')
  }
  return { slaMs: (raw as number | undefined) ?? DEFAULT_WEB.handoff.slaMs }
}

/** 本插件认的顶层键（`validate` 的白名单只此一份）。 */
const WEB_SETTING_KEYS = ['port', 'host', 'staticRoot', 'heartbeatMs', 'rateLimit', 'csrf', 'handoff'] as const

/**
 * 把原始配置解析成 `WebSettings`（未知键 / 非法值一律 fail-loud）。
 *
 * 端口单独校验：0 是合法值（OS 分配随机端口，测试与桌面壳内嵌用）。
 */
export function resolveWebSettings(config: Readonly<Record<string, unknown>>): WebSettings {
  rejectUnknownKeys(config, WEB_SETTING_KEYS, 'channel:web')

  const rawPort = config['port']
  if (
    rawPort !== undefined &&
    (typeof rawPort !== 'number' || !Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65_535)
  ) {
    throw new BahError('web-invalid-config', 'channel:web: port 必须是 0..65535 的整数')
  }
  const port = rawPort as number | undefined
  const heartbeatMs = readPositiveInteger(config, 'heartbeatMs', 'channel:web')
  const host = readString(config, 'host', 'channel:web')
  const staticRoot = readString(config, 'staticRoot', 'channel:web')
  const rateLimit = parseRateLimit(config['rateLimit'])
  const csrf = parseCsrf(config['csrf'])
  const handoff = parseHandoff(config['handoff'])

  return {
    port: port ?? DEFAULT_WEB.port,
    host: host ?? DEFAULT_WEB.host,
    staticRoot: staticRoot ?? DEFAULT_WEB.staticRoot,
    heartbeatMs: heartbeatMs ?? DEFAULT_WEB.heartbeatMs,
    rateLimit,
    csrf,
    handoff,
  }
}
