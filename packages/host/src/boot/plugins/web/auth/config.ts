/**
 * `channel:web` 的认证配置面（租户与鉴权 02 · TA-20）。
 *
 * ## 为什么单独一个文件
 *
 * 与 `web/config.ts` 分开：那是"渠道怎么跑"（端口、静态根、限流），这里是"人怎么进来"
 * （模式、cookie、会话寿命、口令目录、防爆破）。两类变化的触发者不同，混在一处会让
 * `web/config.ts` 变成第二个 `apply()`。
 *
 * ## 硬约束（A3）
 *
 * **`auth.mode` 不写 = `static` = 现行为**。8 个 profile 与 7 个快照不写任何 auth 配置时
 * 必须一字不变。默认值是本单能否合入的唯一硬门槛，所以 `DEFAULT_AUTH` 只在这里定义一次。
 */

import { BahError } from '@bah/util'

import { readBoolean, readPositiveInteger, readString, rejectUnknownKeys } from '../../../config.ts'

/** 三种认证模式。 */
export type AuthMode = 'none' | 'static' | 'password'

/** 模式枚举（校验用；顺序即声明顺序）。 */
export const AUTH_MODES: readonly AuthMode[] = ['none', 'static', 'password']

/** 认证配置（全部随部署变化 → 全部可校验）。 */
export interface AuthSettings {
  readonly mode: AuthMode
  readonly cookie: {
    /** 会话 cookie 名（缺省 `bah_sid`）。 */
    readonly name: string
    /** 生产（HTTPS）必须 true；缺省 false 只为本机演示。 */
    readonly secure: boolean
  }
  readonly session: {
    /** 空闲超时（毫秒）。 */
    readonly idleMs: number
    /** 绝对寿命（毫秒），从签发时刻算。 */
    readonly absoluteMs: number
  }
  readonly directory: {
    /** 口令目录路径（相对 cwd）；`mode: password` 时必填。 */
    readonly path: string
  }
  readonly login: {
    readonly maxFailures: number
    readonly lockMs: number
    readonly backoffBaseMs: number
    readonly backoffMaxMs: number
  }
}

/**
 * 缺省配置。
 *
 * `mode: 'static'` 是刻意的（A3）：不写 auth 块 = 今天的行为。
 */
export const DEFAULT_AUTH: AuthSettings = {
  mode: 'static',
  cookie: { name: 'bah_sid', secure: false },
  session: { idleMs: 1_800_000, absoluteMs: 28_800_000 },
  directory: { path: 'auth/users.yml' },
  login: { maxFailures: 5, lockMs: 900_000, backoffBaseMs: 1_000, backoffMaxMs: 60_000 },
}

const WHERE = 'channel:web.auth'

/** 必须是对象（数组/null 都不行）。 */
function asRecord(value: unknown, where: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BahError('web-invalid-config', `${where} 必须是对象`)
  }
  return value as Readonly<Record<string, unknown>>
}

/** 读正整数（未写 → fallback）。 */
function positive(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: number,
): number {
  return readPositiveInteger(record, key, where) ?? fallback
}

/** 读布尔（未写 → fallback）。 */
function boolean(
  record: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
  fallback: boolean,
): boolean {
  return readBoolean(record, key, where, fallback)
}

/**
 * 解析认证配置（不写 → {@link DEFAULT_AUTH}，未知键 / 非法值一律 fail-loud）。
 *
 * @throws `BahError('web-invalid-config')` 任何一处不合法
 */
export function resolveAuthSettings(raw: unknown): AuthSettings {
  if (raw === undefined) return DEFAULT_AUTH
  const record = asRecord(raw, WHERE)
  rejectUnknownKeys(record, ['mode', 'cookie', 'session', 'directory', 'login'], WHERE)

  const rawMode = record['mode']
  if (rawMode !== undefined && !(AUTH_MODES as readonly unknown[]).includes(rawMode)) {
    throw new BahError(
      'web-invalid-config',
      `${WHERE}.mode 只能是 ${AUTH_MODES.join(' | ')}（收到 ${JSON.stringify(rawMode)}）`,
    )
  }
  const mode = (rawMode as AuthMode | undefined) ?? DEFAULT_AUTH.mode

  const cookieRaw = record['cookie']
  const cookie = cookieRaw === undefined ? DEFAULT_AUTH.cookie : (() => {
    const value = asRecord(cookieRaw, `${WHERE}.cookie`)
    rejectUnknownKeys(value, ['name', 'secure'], `${WHERE}.cookie`)
    const name = readString(value, 'name', `${WHERE}.cookie`) ?? DEFAULT_AUTH.cookie.name
    // 名字会直接拼进 `Set-Cookie` 头：`bah_sid; Domain=evil` 这类值等于配置注入
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      throw new BahError(
        'web-invalid-config',
        `${WHERE}.cookie.name 只能是 [A-Za-z0-9_-]{1,64}（收到 ${JSON.stringify(name)}）`,
      )
    }
    return {
      name,
      secure: boolean(value, 'secure', `${WHERE}.cookie`, DEFAULT_AUTH.cookie.secure),
    }
  })()

  const sessionRaw = record['session']
  const session = sessionRaw === undefined ? DEFAULT_AUTH.session : (() => {
    const value = asRecord(sessionRaw, `${WHERE}.session`)
    rejectUnknownKeys(value, ['idleMs', 'absoluteMs'], `${WHERE}.session`)
    return {
      idleMs: positive(value, 'idleMs', `${WHERE}.session`, DEFAULT_AUTH.session.idleMs),
      absoluteMs: positive(value, 'absoluteMs', `${WHERE}.session`, DEFAULT_AUTH.session.absoluteMs),
    }
  })()
  if (session.idleMs > session.absoluteMs) {
    throw new BahError(
      'web-invalid-config',
      `${WHERE}.session.idleMs（${String(session.idleMs)}）不能大于 absoluteMs（${String(session.absoluteMs)}）`,
    )
  }

  const directoryRaw = record['directory']
  const directory = directoryRaw === undefined ? DEFAULT_AUTH.directory : (() => {
    const value = asRecord(directoryRaw, `${WHERE}.directory`)
    rejectUnknownKeys(value, ['path'], `${WHERE}.directory`)
    return { path: readString(value, 'path', `${WHERE}.directory`) ?? DEFAULT_AUTH.directory.path }
  })()

  const loginRaw = record['login']
  const login = loginRaw === undefined ? DEFAULT_AUTH.login : (() => {
    const value = asRecord(loginRaw, `${WHERE}.login`)
    rejectUnknownKeys(
      value,
      ['maxFailures', 'lockMs', 'backoffBaseMs', 'backoffMaxMs'],
      `${WHERE}.login`,
    )
    return {
      maxFailures: positive(value, 'maxFailures', `${WHERE}.login`, DEFAULT_AUTH.login.maxFailures),
      lockMs: positive(value, 'lockMs', `${WHERE}.login`, DEFAULT_AUTH.login.lockMs),
      backoffBaseMs: positive(value, 'backoffBaseMs', `${WHERE}.login`, DEFAULT_AUTH.login.backoffBaseMs),
      backoffMaxMs: positive(value, 'backoffMaxMs', `${WHERE}.login`, DEFAULT_AUTH.login.backoffMaxMs),
    }
  })()

  // `password` 模式没有目录 = 空城：必须在 boot 期就失败（TA-22 的反例）
  if (mode === 'password' && directory.path.trim() === '') {
    throw new BahError('web-invalid-config', `${WHERE}.directory.path 在 mode=password 时必填`)
  }

  return { mode, cookie, session, directory, login }
}
