/**
 * 认证面的装配（租户与鉴权 02 · TA-24/TA-26 的接线）。
 *
 * ## 为什么单独一个文件
 *
 * `web.ts` 的 `apply` 有 **120 行的结构预算**（`contract.test.ts` 钉死）。认证面要装
 * 会话存储、口令目录、节流器、审计出口、银行身份绑定五个东西，直接铺在 `apply` 里
 * 会立刻超预算。装配细节搬到这里后，`apply` 只剩一行 `auth: createWebAuthRuntime(...)`。
 *
 * ## 三个"取不到就降级"的服务
 *
 * | 服务 | 取不到时 | 为什么不能进 inject |
 * |---|---|---|
 * | `SESSION_FILES` | 认证会话只存内存 + 一条 warn | sdk 等 profile 没有 `core:persistence`，硬依赖会起不来 |
 * | `DECISION_AUDIT` | 审计不落链（登录照常）+ 由 `login` 内部告警 | 审计是旁路，不该阻断认证 |
 * | `CREDENTIALS` | 不绑银行身份 + 一条 warn | 没有 `bank:tools` 的 profile 也能登录（只是工具会说未绑定） |
 * | `BANK_USER_DIRECTORY` | 口令目录跳过"userId 在数据集里"校验 | 同上 |
 */

import { join } from 'node:path'

import { CREDENTIALS } from '@bah/persistence'
import type { Context } from '@bah/core'
import type { TenantId } from '@bah/util'

import type { RunContext } from '../../../boot.ts'
import { describeThrown } from '@bah/core'
import { AUTH_POLICY_VERSION, DECISION_AUDIT } from '../../audit-decisions.ts'
import { BANK_USER_DIRECTORY } from '../../bank-tools.ts'
import { SESSION_FILES } from '../../persistence.ts'
import { tryService } from '../deps.ts'
import type { WebSettings } from '../config.ts'
import {
  createAuthRuntime,
  createSessionStore,
  createStaticIdentifier,
  createThrottle,
  loadDirectory,
  type AuthRuntime,
} from './index.ts'

/** 装配参数（全是 `apply` 手里已有的东西）。 */
export interface WireAuthOptions {
  readonly ctx: Context
  readonly run: RunContext
  readonly config: WebSettings
  readonly webToken: string
  /** 坐席凭证（`static` 模式的第二把；`undefined` = 坐席面整体不可用）。 */
  readonly operatorToken: string | undefined
  /** 进程级 CSRF（`none`/`static` 用它；登录前也用它）。 */
  readonly serverCsrf: string
  readonly warn: (message: string) => void
}

/**
 * 装一个认证运行期。
 *
 * @throws `BahError('auth-directory-*')` `password` 模式下口令目录不合法（boot 期失败）
 */
export function createWebAuthRuntime(options: WireAuthOptions): AuthRuntime {
  const { ctx, run, config, warn } = options

  // 会话日志放租户根下的 auth/（与 <sessionId>/ 同级，**不是**会话事件流）
  const files = tryService(ctx, SESSION_FILES)
  // 只有 password 模式才落盘：static/none 不该在磁盘上留任何 auth/ 痕迹（A3 零回归）
  const logPath =
    config.auth.mode === 'password' && files !== undefined
      ? join(files.root, 'auth', 'sessions.jsonl')
      : undefined
  if (config.auth.mode === 'password' && logPath === undefined) {
    warn('[channel:web] 没有 core:persistence：认证会话只存内存，重启后所有人需要重新登录')
  }

  const userDirectory = tryService(ctx, BANK_USER_DIRECTORY)
  const directory =
    config.auth.mode === 'password'
      ? loadDirectory(config.auth.directory.path, String(run.tenantId), {
          ...(userDirectory === undefined
            ? {}
            : { knownUserIds: (id: string) => userDirectory.has(id) }),
          warn,
        })
      : undefined

  const sessions = createSessionStore({
    now: run.now,
    idleMs: config.auth.session.idleMs,
    absoluteMs: config.auth.session.absoluteMs,
    warn,
    ...(logPath === undefined ? {} : { logPath }),
  })

  const decisionAudit = tryService(ctx, DECISION_AUDIT)
  const credentials = tryService(ctx, CREDENTIALS)

  return createAuthRuntime({
    mode: config.auth.mode,
    tenantId: String(run.tenantId as TenantId),
    now: run.now,
    sessions,
    throttle: createThrottle(config.auth.login),
    ...(directory === undefined ? {} : { directory }),
    serverCsrf: options.serverCsrf,
    // static 双凭证（合流 T-06）：`svc:web=customer` / `svc:operator=agent`
    staticIdentify: createStaticIdentifier({
      tenantId: run.tenantId,
      webToken: options.webToken,
      operatorToken: options.operatorToken,
    }),
    absoluteMs: config.auth.session.absoluteMs,
    cookieName: config.auth.cookie.name,
    cookieSecure: config.auth.cookie.secure,
    onAudit: (entry) => {
      // 认证事实进**审计链**（不是会话事件：事件表 19 键已冻结，加键要动 ADR 名额）
      decisionAudit?.append({
        type: entry.type,
        data: entry.data,
        subject: entry.subject,
        decision: entry.decision,
        policyVersion: AUTH_POLICY_VERSION,
      })
    },
    onLogin: (principal) => {
      // 认证的"你是谁"要变成业务的"你是哪个客户"（TA-27）。取不到就留痕、不阻断登录。
      if (credentials === undefined) {
        warn('[channel:web 登录] 没有 persistence:credentials：本次登录不绑银行身份')
        return
      }
      try {
        credentials.bindSession(run.sessionId, principal.userId, 'session-auth')
      } catch (error) {
        warn(`[channel:web 登录] 绑定银行身份失败：${describeThrown(error)}`)
      }
    },
  })
}
