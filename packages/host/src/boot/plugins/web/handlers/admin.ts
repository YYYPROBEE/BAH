/**
 * 管理面 handler（W16 从 `web.ts` 拆出）：人工解冻断路器 / 人工 HALT / 解除票据。
 *
 * 为什么它不是普通业务 handler：这四条路由**豁免 CSRF**，用独立的 admin token + 回环绑定，
 * 并且必须先于 Web 凭证检查（CLI 没有 Origin/cookie，`bah halt` 不能被 403）。
 *
 * 施工单管这一组叫 tools handler；仓内没有 `/api/tools` 路由，第四个逻辑组只能是管理面，
 * 故按语义命名为 admin（偏差已登记 PROGRESS W16）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { WebDeps, WebRequest } from '../deps.ts'
import { sendError, sendJson } from '../http.ts'
import {
  ADMIN_HALT_PATH,
  ADMIN_HALT_REQUEST_PATH,
  ADMIN_HALT_UNFREEZE_PATH,
  ADMIN_UNFREEZE_PATH,
} from '../router.ts'
import { guardAdmin, readAdminBody } from '../admin-guard.ts'
import { parseHaltBody, parseUnfreezeBody, parseUnfreezeTicketBody } from '../../web-admin.ts'

/** 人工解冻（HP-0 §3.2）；幂等：本来没冻结就返回 `unfrozen:false`，不是错误。 */
async function handleUnfreeze(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: WebDeps,
): Promise<void> {
  if (!(await guardAdmin(req, res, method, ADMIN_UNFREEZE_PATH))) return

  const body = await readAdminBody(req, res)
  if (!body.ok) return
  const parsed = parseUnfreezeBody(body.body)
  if (!parsed.ok) {
    sendError(res, 400, parsed.code, parsed.detail)
    return
  }

  const sentry = deps.trySentry()
  if (sentry === undefined) {
    sendError(res, 503, 'sentry-absent', '当前 profile 没有 safety:sentry，无法解冻')
    return
  }

  const unfrozen = sentry.unfreeze(parsed.by, parsed.reason)
  sendJson(res, 200, { ok: true, unfrozen })
}

/**
 * 人工 HALT（W07）：reason 写死 `manual`，body 只允许 `detail`。
 *
 * 幂等：已 HALT 时 `changed:false`，不是错误。
 */
async function handleHalt(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: WebDeps,
): Promise<void> {
  if (!(await guardAdmin(req, res, method, ADMIN_HALT_PATH))) return

  const body = await readAdminBody(req, res)
  if (!body.ok) return
  const parsed = parseHaltBody(body.body)
  if (!parsed.ok) {
    sendError(res, 400, parsed.code, parsed.detail)
    return
  }

  const halt = deps.tryHalt()
  if (halt === undefined) {
    sendError(res, 503, 'halt-absent', '当前 profile 没有 safety:sentry，无法 HALT')
    return
  }
  // `halt.enabled=false` 是回滚开关：此时返回 503，而不是伪装成"已经在 HALT"
  if (!halt.enabled) {
    sendError(res, 503, 'halt-disabled', 'HALT 已被配置关闭（safety.halt.enabled=false）')
    return
  }
  const changed = parsed.detail === undefined ? halt.halt('manual') : halt.halt('manual', parsed.detail)
  sendJson(res, 200, { ok: true, halted: halt.halted, changed })
}

/**
 * 申请解除票据（W07 §2.3）：在**运行中的会话**里发起一次 U 盾 MFA 审批。
 *
 * 票据由审批链签发，CLI 只拿票号去解冻（不能自签）。没有应答者时不等满 TTL，
 * 直接 409（fail-closed）。
 */
async function handleHaltRequest(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: WebDeps,
): Promise<void> {
  if (!(await guardAdmin(req, res, method, ADMIN_HALT_REQUEST_PATH))) return
  // 消费请求体（keep-alive 下不读会把下一个请求的头当成 body）；本路由没有 body 契约
  const body = await readAdminBody(req, res)
  if (!body.ok) return

  const halt = deps.tryHalt()
  if (halt === undefined) {
    sendError(res, 503, 'halt-absent', '当前 profile 没有 safety:sentry，无法申请解除')
    return
  }
  const result = await halt.requestUnfreeze()
  if (!result.ok) {
    sendError(
      res,
      result.code === 'halt-approval-absent' || result.code === 'halt-disabled' ? 503 : 409,
      result.code,
      result.code === 'halt-approval-rejected'
        ? '会话内没有可用的 MFA 应答者，解除票据未签发'
        : `申请解除失败（${result.code}）`,
    )
    return
  }
  sendJson(res, 200, {
    ok: true,
    ticketId: result.ticketId,
    expiresAt: result.expiresAt,
  })
}

/**
 * 凭票据解除 HALT（W07 §2.3）：**唯一**解除路径。
 *
 * 没有 `force` / 没有"跳过票据" —— 状态机在 `@bah/safety` 里逐项校验
 * approved / mfa / 未过期，web 只做传输与状态码映射。
 */
async function handleHaltUnfreeze(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  deps: WebDeps,
): Promise<void> {
  if (!(await guardAdmin(req, res, method, ADMIN_HALT_UNFREEZE_PATH))) return

  const body = await readAdminBody(req, res)
  if (!body.ok) return
  const parsed = parseUnfreezeTicketBody(body.body)
  if (!parsed.ok) {
    sendError(res, 400, parsed.code, parsed.detail)
    return
  }

  const halt = deps.tryHalt()
  if (halt === undefined) {
    sendError(res, 503, 'halt-absent', '当前 profile 没有 safety:sentry，无法解除 HALT')
    return
  }
  const result = halt.unfreeze(parsed.ticketId)
  if (!result.ok) {
    const status =
      result.code === 'halt-disabled' ? 503 : result.code === 'halt-not-halted' ? 409 : 400
    sendError(
      res,
      status,
      result.code,
      result.code === 'halt-not-halted'
        ? '当前没有处于 HALT'
        : result.code === 'halt-disabled'
          ? 'HALT 已被配置关闭'
          : '解除票据无效',
    )
    return
  }
  sendJson(res, 200, { ok: true, halted: false })
}

/** 管理面入口：按路径分派（方法已在各自的闸里判过）。 */
export async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  request: WebRequest,
  deps: WebDeps,
): Promise<void> {
  switch (request.path) {
    case ADMIN_UNFREEZE_PATH:
      return handleUnfreeze(req, res, request.method, deps)
    case ADMIN_HALT_PATH:
      return handleHalt(req, res, request.method, deps)
    case ADMIN_HALT_REQUEST_PATH:
      return handleHaltRequest(req, res, request.method, deps)
    case ADMIN_HALT_UNFREEZE_PATH:
      return handleHaltUnfreeze(req, res, request.method, deps)
    default:
      // 路由表命中才会进来；留一条兜底，避免将来新增路径时静默成功
      sendError(res, 404, 'web-not-found', '没有这个资源')
  }
}
