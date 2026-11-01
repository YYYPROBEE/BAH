/**
 * 网关配置面：**只从环境变量读**，必填缺失即启动失败。
 *
 * WHY 不读 profile / `bah.yml`：网关是公网进程，它的配置属于**部署**（端口、盐、
 * 平台密钥），不属于"业务装配"。把它写进 profile 会让"同一份 profile 在开发机起不来"，
 * 也会让平台密钥落进版本控制（02 §2.4 的密钥纪律）。
 *
 * 两类常量刻意留在这里：
 * - `DEFAULT_*`：环境变量缺省值（部署可覆盖）；
 * - `RATE_*` / `PULL_*` / `DEDUPE_*`：**进程内配额**，不是部署参数（改它要改代码 + 跑测试，
 *   避免"调大限流就绕过压测"）。
 */

import { BahError } from '@bah/util'

/** 公网监听缺省值（反代后可改 `127.0.0.1`）。 */
export const DEFAULT_GATEWAY_HOST = '0.0.0.0'
export const DEFAULT_GATEWAY_PORT = 8080

/** 会话盐最小长度（与会话键派生同口径）。 */
export const MIN_SESSION_SALT = 16

/** 链接密钥最小长度（H5 审批链接的 HMAC 密钥）。 */
export const MIN_LINK_SECRET = 32

/** 坐席显示名缺省值（网关注入子进程 `BAH_OPERATOR_NAME`）。 */
export const DEFAULT_OPERATOR_NAME = '坐席'

/** 子进程缺省值。 */
export const DEFAULT_CHILD_ENTRY = 'packages/cli/src/main.ts'
export const DEFAULT_CHILD_LOADER = 'tsx'
export const DEFAULT_MAX_CHILDREN = 8
export const DEFAULT_IDLE_TTL_MS = 1_800_000
export const DEFAULT_CHILD_TIMEOUT_MS = 15_000

/** 推送模式（§2.13）。 */
export const PUSH_MODES = ['auto', 'passive', 'push', 'pull'] as const
export type PushMode = (typeof PUSH_MODES)[number]

/** 被动回复最多等多少毫秒（微信 5 秒窗口，留 1 秒网络余量）。 */
export const DEFAULT_PASSIVE_WAIT_MS = 4_000

/** 拉取式结果缓存（每用户条数 / TTL，§2.13）。 */
export const PULL_MAX_ITEMS = 5
export const PULL_TTL_MS = 10 * 60 * 1000

/** 去重 LRU（容量 / TTL，§2.10）。 */
export const DEDUPE_CAPACITY = 10_000
export const DEDUPE_TTL_MS = 10 * 60 * 1000

/** 限流（每用户 / 全局，固定窗口，§2.15 的 `im-ratelimited`）。 */
export const RATE_USER_LIMIT = 20
export const RATE_USER_WINDOW_MS = 60_000
export const RATE_GLOBAL_LIMIT = 200
export const RATE_GLOBAL_WINDOW_MS = 60_000

/** 用户可见的文案（网关只说人话，不暴露 errcode / 内部码）。 */
export const ACK_TEXT = '已收到，正在处理…（回复 0 获取最新结果；银行不会索要密码/验证码）'
export const BUSY_TEXT = '当前咨询人数较多，请稍后再试'
export const RATE_LIMITED_TEXT = '操作太频繁，请稍后再试'
export const QUEUE_FULL_TEXT = '请等上一条处理完再发'
export const EMPTY_PULL_TEXT = '暂无新消息'
export const MAINTENANCE_TEXT = '系统维护中，请稍后再试'
export const FAILED_TEXT = '处理失败，请重试或回复 0 获取最新结果'
export const OFFLINE_TEXT = '系统繁忙，请稍后再试'

/** 微信适配器配置。 */
export interface WechatConfig {
  readonly appId: string
  readonly appSecret: string
  readonly token: string
  readonly accountKey: string
  readonly apiBase: string
}

/** 网关配置（冻结后的只读视图）。 */
export interface GatewayConfig {
  readonly sessionSalt: string
  readonly host: string
  readonly port: number
  readonly root: string
  readonly profile: string
  readonly childEntry: string
  readonly childNode: string
  /** `tsx` = `node --import tsx`；`none` = 直接跑已编译入口。 */
  readonly childLoader: 'tsx' | 'none'
  readonly jsonlBase: string
  readonly maxChildren: number
  readonly idleTtlMs: number
  readonly childTimeoutMs: number
  readonly pushMode: PushMode
  readonly passiveWaitMs: number
  readonly untrustedUsers: ReadonlySet<string>
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** H5 公开基址（`https://`；本地联调允许 `http://127.0.0.1`）。 */
  readonly publicBaseUrl: string | undefined
  /** H5 链接签名密钥（03 单必填，≥32 字符）。 */
  readonly linkSecret: string
  /** 运营桥 token（未配置 → `/seat/*` 一律 404）。 */
  readonly operatorToken: string | undefined
  /** 坐席显示名（注入子进程 `BAH_OPERATOR_NAME`）。 */
  readonly operatorName: string
  readonly wechat: WechatConfig
}

/** 环境变量的只读视图（测试直接传对象，不碰 `process.env`）。 */
export type Env = Readonly<Record<string, string | undefined>>

/** 读必填字符串。 */
function required(env: Env, key: string): string {
  const value = env[key]?.trim() ?? ''
  if (value.length === 0) {
    throw new BahError('im-config-missing', `im: 缺少必填环境变量 ${key}`, { key })
  }
  return value
}

/** 读可选字符串。 */
function optional(env: Env, key: string): string | undefined {
  const value = env[key]?.trim() ?? ''
  return value.length === 0 ? undefined : value
}

/** 读整数（缺省或非法 → 用缺省值或抛）。 */
function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, key)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new BahError('im-config-invalid', `im: ${key} 必须是整数（收到 ${raw}）`, { key })
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new BahError('im-config-invalid', `im: ${key} 必须在 ${String(min)}..${String(max)} 之间`, {
      key,
      value,
    })
  }
  return value
}

/** 读枚举。 */
function readEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const raw = optional(env, key)
  if (raw === undefined) return fallback
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new BahError('im-config-invalid', `im: ${key} 只能是 ${allowed.join('/')}（收到 ${raw}）`, { key })
  }
  return raw as T
}

/**
 * 解析 `BAH_IM_UNTRUSTED_USERS`（逗号分隔 `platform:userId`）。
 *
 * 非法元素即启动失败：静默丢弃会让"以为标记了、其实没标"成为不可见的越权面。
 */
export function parseUntrustedUsers(raw: string | undefined): ReadonlySet<string> {
  const entries = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  const result = new Set<string>()
  for (const entry of entries) {
    const index = entry.indexOf(':')
    if (index <= 0 || index === entry.length - 1) {
      throw new BahError(
        'im-config-invalid',
        'im: BAH_IM_UNTRUSTED_USERS 的元素必须形如 platform:userId',
        { entry },
      )
    }
    result.add(entry)
  }
  return result
}

/**
 * 校验 H5 公开基址：生产只许 `https://`；本地联调允许 `http://127.0.0.1[:port]`。
 *
 * WHY 不允许任意 http：H5 链接是**审批凭证**，明文 HTTP 上任何中间人可替换页面并窃取 token。
 */
function isPublicBaseUrl(value: string): boolean {
  if (/^https:\/\/[^\s]+$/u.test(value)) return true
  return /^http:\/\/127\.0\.0\.1(?::\d+)?$/u.test(value)
}

/**
 * 读全部配置。
 *
 * @throws `BahError('im-config-missing')` 必填缺失
 * @throws `BahError('im-config-invalid')` 取值非法
 */
export function loadConfig(env: Env, cwd: string): GatewayConfig {
  const sessionSalt = required(env, 'BAH_IM_SESSION_SALT')
  if (sessionSalt.length < MIN_SESSION_SALT) {
    throw new BahError(
      'im-config-invalid',
      `im: BAH_IM_SESSION_SALT 必须至少 ${String(MIN_SESSION_SALT)} 字符`,
      { key: 'BAH_IM_SESSION_SALT' },
    )
  }

  const root = optional(env, 'BAH_IM_ROOT') ?? cwd
  const publicBaseUrl = optional(env, 'BAH_IM_PUBLIC_BASE_URL')
  if (publicBaseUrl !== undefined && !isPublicBaseUrl(publicBaseUrl)) {
    throw new BahError(
      'im-config-invalid',
      'im: BAH_IM_PUBLIC_BASE_URL 必须是 https://（本地联调允许 http://127.0.0.1）',
      { key: 'BAH_IM_PUBLIC_BASE_URL' },
    )
  }
  const linkSecret = required(env, 'BAH_IM_LINK_SECRET')
  if (linkSecret.length < MIN_LINK_SECRET) {
    throw new BahError(
      'im-config-invalid',
      `im: BAH_IM_LINK_SECRET 必须至少 ${String(MIN_LINK_SECRET)} 字符`,
      { key: 'BAH_IM_LINK_SECRET' },
    )
  }

  return {
    sessionSalt,
    host: optional(env, 'BAH_IM_HOST') ?? DEFAULT_GATEWAY_HOST,
    port: readInt(env, 'BAH_IM_PORT', DEFAULT_GATEWAY_PORT, 1, 65_535),
    root,
    profile: optional(env, 'BAH_IM_PROFILE') ?? 'im',
    childEntry: optional(env, 'BAH_IM_CHILD_ENTRY') ?? DEFAULT_CHILD_ENTRY,
    childNode: optional(env, 'BAH_IM_CHILD_NODE') ?? process.execPath,
    childLoader: readEnum(env, 'BAH_IM_CHILD_LOADER', ['tsx', 'none'] as const, DEFAULT_CHILD_LOADER),
    jsonlBase: optional(env, 'BAH_IM_JSONL_BASE') ?? `${root}/sessions/im`,
    maxChildren: readInt(env, 'BAH_IM_MAX_CHILDREN', DEFAULT_MAX_CHILDREN, 1, 64),
    idleTtlMs: readInt(env, 'BAH_IM_IDLE_TTL_MS', DEFAULT_IDLE_TTL_MS, 1_000, 24 * 60 * 60 * 1000),
    childTimeoutMs: readInt(env, 'BAH_IM_CHILD_TIMEOUT_MS', DEFAULT_CHILD_TIMEOUT_MS, 1_000, 120_000),
    pushMode: readEnum(env, 'BAH_IM_PUSH_MODE', PUSH_MODES, 'auto'),
    passiveWaitMs: readInt(env, 'BAH_IM_PASSIVE_WAIT_MS', DEFAULT_PASSIVE_WAIT_MS, 100, 4_500),
    untrustedUsers: parseUntrustedUsers(env['BAH_IM_UNTRUSTED_USERS']),
    logLevel: readEnum(env, 'BAH_IM_LOG', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    publicBaseUrl: publicBaseUrl === undefined ? undefined : publicBaseUrl.replace(/\/+$/u, ''),
    linkSecret,
    operatorToken: optional(env, 'BAH_IM_OPERATOR_TOKEN'),
    operatorName: optional(env, 'BAH_OPERATOR_NAME') ?? DEFAULT_OPERATOR_NAME,
    wechat: {
      appId: required(env, 'BAH_WECHAT_APPID'),
      appSecret: required(env, 'BAH_WECHAT_SECRET'),
      token: required(env, 'BAH_WECHAT_TOKEN'),
      accountKey: optional(env, 'BAH_WECHAT_ACCOUNT_KEY') ?? 'default',
      apiBase: optional(env, 'BAH_WECHAT_API_BASE') ?? 'https://api.weixin.qq.com',
    },
  }
}
