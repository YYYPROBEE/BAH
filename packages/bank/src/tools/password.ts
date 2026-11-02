/**
 * `password_change`：交易密码修改（红档典型操作；ADR-0014）。
 *
 * ## 为什么是"交办"而不是"代改"
 *
 * `tool/call` 的 `args` 会被**全量**写进 `sessions/<sessionId>/session.jsonl`。只要密码进入工具参数，
 * 用户密码就落进了审计日志——再多的脱敏声明也救不回来。
 *
 * 所以本工具只做两件事：
 * 1. `request`：签发一张**一次性交接票据**（`pwd:<callId>`，TTL 120s），返回安全页路径；
 * 2. `status`：只读"上一次改密时刻 + 还剩几次机会"。
 *
 * 明文只在渠道安全页的表单里提交一次（`POST /api/secure/password`），那条路径不经过模型、
 * 不进会话日志。**本文件的 schema 里只有 `action`，没有任何密码字段**——这是结构性的，
 * 不是"约定了不传"。
 *
 * ## 票据纪律
 *
 * `request` 是写操作：先核销治理面签发的审批票据（`ticketRefForCall`，金额 0），
 * 核销成功才签交接票。没有审批票据 → `ticket-missing`，连交接票都不给。
 *
 * ## 结构
 *
 * 执行体是模块级函数，工具对象字面量保持短小：`verify-tiers` 要在回溯窗口内
 * 找到 `return {` 并核对 `tier` 声明（见 `fund-lock.ts` 的同一注释）。
 */

import { defineService, type ServiceKey, type ToolDefinition, type ToolExecContext } from '@bah/core'
import { BahError } from '@bah/util'

import { bankIds } from '../core/index.ts'
import { PASSWORD_HANDOFF_TTL_SECONDS } from '../core/password.ts'
import { requireUserId } from './accounts.ts'
import { readRequiredEnum } from './args.ts'
import type { BankAudit } from './events.ts'
import { specOf } from './specs.ts'
import { ticketRefForCall } from './tickets.ts'
import type { BankCoreProvider } from '../core/provider.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `password_change` 的结果（两个分支共用；只读分支不带交接字段）。 */
export interface PasswordChangeResult {
  readonly action: 'request' | 'status'
  /** 交接票据 ID（`request` 分支；`status` 缺省）。 */
  readonly ticketId?: string
  /** 安全页路径（`request` 分支）。 */
  readonly handoffPath?: string
  /** 交接票据过期时刻（`request` 分支）。 */
  readonly expiresAt?: number
  /** 最后一次改密时刻（`status` 分支；从未改过为 `null`）。 */
  readonly lastChangedAt?: number | null
  /** 剩余可尝试次数（`status` 分支；锁定中为 0）。 */
  readonly remainingAttempts?: number
  /** 本次调用时刻（注入钟）。 */
  readonly at: number
}

/** 两个动作（封闭枚举；`status` 是只读，登记在 `READ_ONLY_ACTIONS`）。 */
const PASSWORD_ACTIONS = ['request', 'status'] as const

/** 只读分支：读"上一次改密 + 剩余次数"，落 `read/password-status`（不签票）。 */
async function readPasswordStatus(
  deps: BankToolDeps,
  ctx: ToolExecContext,
): Promise<PasswordChangeResult> {
  const userId = requireUserId(deps, ctx.sessionId)
  const status = await deps.core.passwordStatus(bankIds.user(userId))
  const at = clockOf(deps)()
  deps.audit.append('read/password-status', {
    lastChangedAt: status.lastChangedAt,
    remainingAttempts: status.remainingAttempts,
    at,
  })
  return {
    action: 'status',
    lastChangedAt: status.lastChangedAt,
    remainingAttempts: status.remainingAttempts,
    at,
  }
}

/** 写分支：核销审批票据 → 签一次性交接票据 → 返回安全页交接信息。 */
async function requestPasswordHandoff(
  deps: BankToolDeps,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecContext,
): Promise<PasswordChangeResult> {
  const userId = requireUserId(deps, ctx.sessionId)
  // 金额恒为 0：本工具不动资金。审批票据的五绑定要求这里与签发侧同口径（governance 对
  // 无金额工具记 0），差一分就会 `ticket-binding-mismatch`。
  const approval = ticketRefForCall(deps, ctx, 'password_change', args, 0)
  const handoff = await deps.core.requestPasswordChange(
    bankIds.user(userId),
    { ticketId: `pwd:${ctx.callId}`, ttlMs: PASSWORD_HANDOFF_TTL_SECONDS * 1_000 },
    approval,
  )
  return {
    action: 'request',
    ticketId: handoff.ticketId,
    handoffPath: handoff.handoffPath,
    expiresAt: handoff.expiresAt,
    at: handoff.at,
  }
}

/** 面向模型的叙述：两句话，各自说明"下一步在谁手里"。 */
function describe(result: PasswordChangeResult): string {
  if (result.action === 'request') {
    const seconds = PASSWORD_HANDOFF_TTL_SECONDS
    // 票据拼进 query：安全页会预填票据号并立刻从地址栏抹掉（`apps/web/src/password.js`）。
    // 只给路径不给票据，用户就得从工具卡里手抄一串 `pwd:` 号——演示现场最容易抄错的一步。
    const link = `${String(result.handoffPath)}?ticket=${encodeURIComponent(String(result.ticketId))}`
    return (
      `已发起交易密码修改：请打开安全页 ${link} 提交旧密码与新密码` +
      `（${String(seconds)} 秒内有效，票据 ${String(result.ticketId)}）。` +
      `密码只在这一页填写，我不接收、也无法看到明文。`
    )
  }
  const changed =
    result.lastChangedAt === null || result.lastChangedAt === undefined
      ? '从未改过交易密码'
      : `上次改密于 ${new Date(result.lastChangedAt).toISOString()}`
  return `${changed}；当前还剩 ${String(result.remainingAttempts ?? 0)} 次尝试机会。`
}

export function createPasswordChangeTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, PasswordChangeResult> {
  const spec = specOf('password_change')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const action = readRequiredEnum(args, 'action', spec.name, PASSWORD_ACTIONS)
      return action === 'status'
        ? readPasswordStatus(deps, ctx)
        : requestPasswordHandoff(deps, args, ctx)
    },
    projectContent: (result) => [{ type: 'text', text: describe(result) }],
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, PasswordChangeResult>
}

/**
 * 安全页提交口（**窄端口**，只交出"提交一次改密"一个方法）。
 *
 * 为什么单独开端口而不是让 web 处理器拿 `BankCoreProvider`：
 * 交出整条 Provider 就等于把账本读写面都给了渠道层；这里只需要"校验交接票 → 改密 →
 * 核销交接票 → 落账"这一条链，而**落账**（`security/password-changed`）必须与工具族
 * 用同一个审计出口，否则同一条事实会有两条写法。
 *
 * **身份只从会话来**（与 `bank:card-spend` 同一纪律）：调用方传的是 `sessionId`，不是
 * `userId`。原因有两个：
 * 1. `static` 鉴权模式下 HTTP 主体是合成主体 `svc:web`，它**不是**银行客户号；
 *    会话绑定的 `u-1` 才是"这笔密码属于谁"的唯一答案；
 * 2. 结构上堵掉"拿别人的票 + 自己的 userId"这条路——票的归属在核心再核一次。
 */
export interface PasswordHandoffPort {
  /**
   * 提交一次改密（`sessionId` 由处理器从 `WebDeps.session` 取，不接受请求体给的身份）。
   *
   * @throws `no-identity`（会话未绑定银行用户）/ `password-ticket-*`（未知 / 已用 / 过期 /
   *   不是本人）/ `password-invalid` / `password-mismatch` / `password-locked`
   */
  submit(
    sessionId: string,
    req: {
      readonly ticketId: string
      readonly oldPassword: string
      readonly newPassword: string
    },
  ): Promise<{ readonly changedAt: number }>
}

/** 服务键：`bank:password-handoff`（web 渠道的安全页端点用它）。 */
export const PASSWORD_HANDOFF: ServiceKey<PasswordHandoffPort> =
  defineService<PasswordHandoffPort>('bank:password-handoff')

/** 造安全页端口（唯一构造点；依赖纯注入，便于单测"未绑定身份即拒"）。 */
export function createPasswordHandoffPort(options: {
  readonly core: BankCoreProvider
  readonly audit: BankAudit
  /** 会话 → 银行用户（`BANK_IDENTITY` 的同源解析；未绑定返回 `undefined`）。 */
  readonly resolveUserId: (sessionId: string) => string | undefined
}): PasswordHandoffPort {
  return {
    async submit(sessionId, req) {
      const raw = options.resolveUserId(sessionId)
      if (raw === undefined || raw.trim().length === 0) {
        throw new BahError('no-identity', 'bank-tools: 改密需要已绑定的会话身份', { sessionId })
      }
      const userId = bankIds.user(raw)
      // ① 票据校验（只读）：未知/已用/过期/他人的票在这里全部被拒
      await options.core.checkPasswordHandoff(req.ticketId, userId)
      // ② 改密（写）：校验顺序与失败计数在核心；失败时**不核销**票据，用户可重试
      const changed = await options.core.changeTxnPassword(userId, req.oldPassword, req.newPassword)
      // ③ 核销：一次性票据在成功之后才失效，失败可重试是同一条纪律的另一面
      await options.core.consumePasswordHandoff(req.ticketId)
      // ④ 落账：载荷只有 userId / method / at，**没有**任何密码材料
      options.audit.append('security/password-changed', {
        userId: raw,
        method: 'secure-page',
        at: changed.changedAt,
      })
      return { changedAt: changed.changedAt }
    },
  }
}
