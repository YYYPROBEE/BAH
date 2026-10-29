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
import { DEFAULT_AUTH, resolveAuthSettings, type AuthSettings } from './auth/config.ts'

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
  /**
   * `/` 的落点（静态根下的相对文件名，默认 `index.html`）。
   * 施工单 01 / 00 D3：移动壳是第二个 HTML 壳 ⇒ `/` 打开哪个壳由渠道自己声明。
   */
  readonly entry: string
  /**
   * token 入口白名单（静态根下的相对文件名数组，默认 `['index.html']`）。
   *
   * **只有**名单里的 HTML 会被注入 Bearer token 与下发 CSRF cookie；其它任何 `.html`
   * 按普通静态资源返回。按扩展名注入会把 staticRoot 下任何 HTML 变成 token 泄漏面。
   */
  readonly entries: readonly string[]
  /** 人工接管（C5）：等待超时告警。 */
  readonly handoff: {
    /** SLA 毫秒（默认 180_000；0 = 只记录不告警）。**不自动交回**。 */
    readonly slaMs: number
  }
  /**
   * 认证面（02）。**整个块可选：不写 = `mode: 'static'` = 改动前的行为**（A3）。
   *
   * 这一条是本单能否合入的硬门槛：8 个 profile 与 7 个快照不写 auth 时必须一字不变。
   */
  readonly auth: AuthSettings
}

/** 默认配置。 */
export const DEFAULT_WEB: WebSettings = {
  port: 7331,
  host: '127.0.0.1',
  staticRoot: 'apps/web',
  heartbeatMs: 15_000,
  rateLimit: { windowMs: 60_000, maxRequests: 120 },
  csrf: { enabled: true },
  entry: 'index.html',
  entries: ['index.html'],
  handoff: { slaMs: 180_000 },
  auth: DEFAULT_AUTH,
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
const WEB_SETTING_KEYS = [
  'port',
  'host',
  'staticRoot',
  'heartbeatMs',
  'rateLimit',
  'csrf',
  'entry',
  'entries',
  'handoff',
  'auth',
] as const

/**
 * 单个入口名的字符校验（`entry` 与 `entries` 共用一份，绝不各写一套）。
 *
 * WHY 禁这些字符：白名单比较的是规范化之后的**绝对路径精确等值**（`handlers/static.ts`），
 * 含分隔符/点段的"文件名"根本到不了那一层（会被 `normalize` 改写），却会让配置看起来
 * 像支持子目录；通配符更糟——写 `*.html` 的人以为自己配了白名单，实际配了"全站 HTML 都可拿 token"。
 */
function assertSafeEntryName(key: 'entry' | 'entries', name: string): void {
  if (name.length === 0 || !name.endsWith('.html')) {
    throw new BahError('web-invalid-config', `channel:web: ${key} 的入口名必须以 .html 结尾（收到 '${name}'）`)
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new BahError('web-invalid-config', `channel:web: ${key} 的入口名不得含路径分隔符或 ..（收到 '${name}'）`)
  }
  for (const bad of ['*', '?', '{', '}']) {
    if (name.includes(bad)) {
      throw new BahError('web-invalid-config', `channel:web: ${key} 的入口名不支持通配符（收到 '${name}'）`)
    }
  }
}

/** 解析 `entry`（未写时用默认值；必须出现在 `entries` 里，见 `resolveWebSettings`）。 */
export function parseEntry(value: unknown): string {
  if (value === undefined) return DEFAULT_WEB.entry
  if (typeof value !== 'string') {
    throw new BahError('web-invalid-config', 'channel:web: entry 必须是字符串')
  }
  assertSafeEntryName('entry', value)
  return value
}

/**
 * 解析 token 入口白名单（00 D3）。
 *
 * WHAT 白名单而不是"后缀是 .html 就注入"：token 只能经 HTML 注入（`injectWebToken`），
 * 按扩展名注入会把 staticRoot 下**任何** HTML 变成 token 泄漏面（`design/bah-ds` 的 preview
 * 页若被误挂进 apps/web 就会中招）。WHY 不支持通配：见 `assertSafeEntryName`。
 */
export function parseEntries(value: unknown): readonly string[] {
  const raw = value ?? DEFAULT_WEB.entries
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BahError('web-invalid-config', 'channel:web: entries 必须是非空数组（token 入口白名单）')
  }
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new BahError('web-invalid-config', 'channel:web: entries 每一项必须是字符串')
    }
    assertSafeEntryName('entries', item)
    if (seen.has(item)) throw new BahError('web-invalid-config', `channel:web: entries 重复：${item}`)
    seen.add(item)
  }
  return [...seen]
}

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
  const entries = parseEntries(config['entries'])
  const entry = parseEntry(config['entry'])
  // `entry` 必须是白名单里的一员：否则 `/` 会返回一个"不注入 token"的壳，
  // 页面起来但永远 401——这是最难查的一类配置错误（O9 的"看起来能用"）。
  if (!entries.includes(entry)) {
    throw new BahError(
      'web-invalid-config',
      `channel:web: entry '${entry}' 必须出现在 entries 里（收到 ${JSON.stringify(entries)}）`,
    )
  }
  const handoff = parseHandoff(config['handoff'])
  const auth = resolveAuthSettings(config['auth'])

  return {
    port: port ?? DEFAULT_WEB.port,
    host: host ?? DEFAULT_WEB.host,
    staticRoot: staticRoot ?? DEFAULT_WEB.staticRoot,
    heartbeatMs: heartbeatMs ?? DEFAULT_WEB.heartbeatMs,
    rateLimit,
    csrf,
    entry,
    entries,
    handoff,
    auth,
  }
}
