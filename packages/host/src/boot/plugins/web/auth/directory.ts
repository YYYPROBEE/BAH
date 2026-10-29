/**
 * 口令目录 `auth/users.yml`（租户与鉴权 02 · TA-22）。
 *
 * ## 为什么它是"唯一定义处"
 *
 * 身份必须来自**一个**地方，否则 02 的登录与 09 的 `demoUserId` 会各绑一次，后写的赢、
 * 行为不可预测（TA-27 的 `auth-demo-user-conflict` 就是给这件事兜底的）。
 *
 * ## 六条 boot 期校验（全部 fail-loud）
 *
 * | # | 校验 | 错误码 | 为什么在这一层 |
 * |---|---|---|---|
 * | 1 | 文件存在且可读 | `auth-directory-missing` | `mode: password` 没有目录 = 空城 |
 * | 2 | `tenant` 与 `RunContext.tenantId` 一致 | `auth-directory-tenant-mismatch` | 把 demo 的目录拷给 acme 是最容易犯的运维错误 |
 * | 3 | `userId` 唯一 / 非空 / 不含 `/` | `auth-directory-invalid` | 它要拼进审计 `subject` |
 * | 4 | `roles` 非空且都在 `ROLES` 里 | `auth-directory-invalid` | 未知角色会让 03 的授权矩阵出现空洞 |
 * | 5 | `userId` 在银行数据集里 | `auth-directory-unknown-user` | 否则登录成功后第一次工具调用才炸，排查成本高十倍 |
 * | 6 | `password` 是 `scrypt$` 编码串 | `auth-directory-invalid` | 明文口令不允许出现在目录里 |
 *
 * YAML 解析复用 `@bah/policy` 的 `parseYaml`/`toPlain`（host 不允许引 `yaml`：R3 零运行时依赖）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseYaml, toPlain } from '@bah/policy'
import { BahError, isTenantId, logJson, ROLES, type Role } from '@bah/util'

/** 目录里的一行。 */
export interface DirectoryUser {
  readonly userId: string
  readonly phone: string
  readonly roles: readonly Role[]
  /** 编码串（`scrypt$N$r$p$salt$hash`），绝不是明文。 */
  readonly password: string
}

/** 口令目录（只读）。 */
export interface UserDirectory {
  /** 目录文件声明的租户（已校验与当前租户一致）。 */
  readonly tenant: string
  readonly size: number
  findById(userId: string): DirectoryUser | undefined
  findByPhone(phone: string): DirectoryUser | undefined
}

/** 加载选项。 */
export interface LoadDirectoryOptions {
  /** 银行数据集里是否存在这个 userId（缺省不校验：sdk/headless 没有 bank:tools）。 */
  readonly knownUserIds?: (userId: string) => boolean
  /** 告警出口（缺省 console.warn）。 */
  readonly warn?: (message: string) => void
}

/** 目录结构非法。 */
function invalid(file: string, reason: string): never {
  throw new BahError('auth-directory-invalid', `auth-directory-invalid: ${file}: ${reason}`, { file })
}

/** 非空字符串。 */
function readText(value: unknown, what: string, file: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(file, `${what} 必须是非空字符串`)
  return value.trim()
}

/**
 * 读取并校验口令目录。
 *
 * @param path 相对 cwd（或绝对路径）
 * @param tenant 当前进程的租户（`RunContext.tenantId`）
 * @throws `BahError` 见模块注释的六条校验
 */
export function loadDirectory(
  path: string,
  tenant: string,
  options: LoadDirectoryOptions = {},
): UserDirectory {
  const warn =
    options.warn ??
    ((message: string) => logJson('warn', 'web.auth-directory-warn', { reason: message }))
  const file = resolve(process.cwd(), path)

  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    throw new BahError(
      'auth-directory-missing',
      `auth-directory-missing: 口令目录不可读：${file}（mode=password 时必须有它；没有目录 = 没有人能登录）`,
      { file },
    )
  }

  let document: unknown
  try {
    const parsed = parseYaml(raw, file)
    document = toPlain(parsed)
  } catch (error) {
    // YAML 错误来自 `@bah/policy`（码是 policy-parse-error）：翻译成本层的码，
    // 否则运维会以为"策略文件坏了"。
    const reason = error instanceof Error ? error.message : String(error)
    invalid(file, `YAML 解析失败：${reason}`)
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    invalid(file, '顶层必须是对象')
  }
  const record = document as Record<string, unknown>

  const declaredTenant = readText(record['tenant'], 'tenant', file)
  if (!isTenantId(declaredTenant)) invalid(file, `tenant 不是合法租户 ID：${JSON.stringify(declaredTenant)}`)
  if (declaredTenant !== tenant) {
    throw new BahError(
      'auth-directory-tenant-mismatch',
      `auth-directory-tenant-mismatch: 目录声明的租户是 ${declaredTenant}，本进程服务 ${tenant}（把 demo 的目录拷给了别的租户？）`,
      { file, declared: declaredTenant, tenant },
    )
  }

  const version = record['version']
  if (version !== 1) invalid(file, `version 必须是 1（收到 ${JSON.stringify(version)}）`)

  const rows = record['users']
  if (!Array.isArray(rows) || rows.length === 0) invalid(file, 'users 必须是非空数组')

  const byId = new Map<string, DirectoryUser>()
  const byPhone = new Map<string, DirectoryUser>()
  for (const [index, entry] of rows.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalid(file, `users[${String(index)}] 必须是对象`)
    }
    const user = entry as Record<string, unknown>
    const userId = readText(user['userId'], `users[${String(index)}].userId`, file)
    if (userId.includes('/') || userId.includes('\\')) invalid(file, `userId 不许含路径分隔符：${userId}`)
    if (byId.has(userId)) invalid(file, `userId 重复：${userId}`)

    const phone = readText(user['phone'], `users[${String(index)}].phone`, file)
    if (byPhone.has(phone)) invalid(file, `phone 重复：${phone}`)

    const rawRoles = user['roles']
    if (!Array.isArray(rawRoles) || rawRoles.length === 0) invalid(file, `${userId} 的 roles 必须是非空数组`)
    const unknown = rawRoles.filter(
      (role) => typeof role !== 'string' || !(ROLES as readonly string[]).includes(role),
    )
    if (unknown.length > 0) invalid(file, `${userId} 的角色非法：${JSON.stringify(unknown)}`)

    const password = readText(user['password'], `${userId}.password`, file)
    if (!password.startsWith('scrypt$')) invalid(file, `${userId}.password 不是 scrypt 编码串（不许明文）`)

    if (options.knownUserIds !== undefined && !options.knownUserIds(userId)) {
      throw new BahError(
        'auth-directory-unknown-user',
        `auth-directory-unknown-user: ${userId} 不在银行数据集里（登录后第一次工具调用必然失败，所以这里是 boot 期错误）`,
        { file, userId },
      )
    }

    const directoryUser: DirectoryUser = {
      userId,
      phone,
      // 顺序按 ROLES 固定：审计链要对主体算哈希，序列化必须稳定
      roles: ROLES.filter((role) => rawRoles.includes(role)),
      password,
    }
    byId.set(userId, directoryUser)
    byPhone.set(phone, directoryUser)
  }

  warn(`[web-auth] 口令目录已载入：${String(byId.size)} 个用户（${file}）`)

  return {
    tenant: declaredTenant,
    size: byId.size,
    findById: (userId) => byId.get(userId),
    findByPhone: (phone) => byPhone.get(phone),
  }
}
