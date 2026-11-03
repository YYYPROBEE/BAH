/**
 * `fund_lock`：资金锁定 / 释放（earmark 的显式入口）。
 *
 * ## 为什么不是新账本
 *
 * 核心早就有「活期 → 本人锁定账户」的内部划转：`resolveSelfTransfer` 识别
 * `payee.name === accountDisplayName(本人账户)`，走 `settleSelfTransfer`（双流水、
 * 不吃转账日限额——限额防的是对外转出）。所以"锁定 1000 元活期"在账本上是
 * **同一用户的两个账户之间划转**：可用余额下降、总资产不变、钱没有被转给任何人。
 *
 * 本工具做三件事，不自己改余额：
 * 1. `lock`：活期 → 锁定账户；
 * 2. `release`：锁定账户 → 活期（2026-11-01 新增的回收方向，见 `mock.ts` 的方向校验）；
 * 3. `status`：只读，返回锁定 / 可用金额（走 `read/balance`，不签票）。
 *
 * ## 边界
 *
 * - 锁定账户**只能回到本人活期**，不能对外支付（转出方向仍被 core 拒绝）；
 * - 资金腿一律走 `core.createTransfer`：账本只有一条写路径；
 * - `status` 在 `READ_ONLY_ACTIONS` 里登记，才是真的"只读不签票"。
 *
 * ## 结构
 *
 * 执行体与文案都是模块级函数：工具对象字面量保持短小，
 * `verify-tiers` 才能在回溯窗口内找到 `return {` 并核对 `tier` 声明。
 */

import type { ToolDefinition, ToolExecContext } from '@bah/core'
import { BahError } from '@bah/util'

import { accountDisplayName, bankIds, formatYuan, yuanToCents } from '../core/index.ts'
import { requireUserId } from './accounts.ts'
import { readNumber, readRequiredEnum } from './args.ts'
import type { BalanceResult, TransferCreatedResult } from './dto.ts'
import { specOf } from './specs.ts'
import { ticketRefForCall } from './tickets.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `fund_lock` 的结果（`status` 分支不带金额与流水号）。 */
export interface FundLockResult {
  readonly action: 'lock' | 'release' | 'status'
  /** 锁定账户当前余额（分）。 */
  readonly lockedCents: number
  /** 活期账户当前可用余额（分）。 */
  readonly availableCents: number
  /** 本次动作金额（分；`status` 缺省）。 */
  readonly amountCents?: number
  /** 本次资金流水号（`status` 缺省）。 */
  readonly txnId?: string
}

const FUND_LOCK_ACTIONS = ['lock', 'release', 'status'] as const

/** 只读分支：把"当前锁了多少/还能用多少"落成 `read/balance`（不签票）。 */
async function readStatus(
  deps: BankToolDeps,
  ctx: ToolExecContext,
): Promise<FundLockResult> {
  const userId = requireUserId(deps, ctx.sessionId)
  const accounts = await deps.core.listAccounts(bankIds.user(userId))
  const current = accounts.find((item) => item.type === 'current')
  const locked = accounts.find((item) => item.type === 'locked')
  if (current === undefined) {
    throw new BahError('account-missing', 'bank: 当前用户没有活期账户，无法查询锁定资金', {})
  }
  if (locked === undefined) {
    throw new BahError('account-missing', 'bank: 当前用户没有锁定账户，无法 earmark', {})
  }
  const at = clockOf(deps)()
  const result: BalanceResult = {
    accountId: current.id,
    tail: current.number.replace(/\s+/g, '').slice(-4),
    balanceCents: current.balanceCents,
    availableCents: current.availableCents,
    frozenCents: Math.max(0, current.balanceCents - current.availableCents),
    asOf: at,
    txnRef: `fund-lock:${ctx.callId}`,
  }
  deps.audit.append('read/balance', { result })
  return { action: 'status', lockedCents: locked.balanceCents, availableCents: current.availableCents }
}

/** 写入分支：lock = 活期 → 锁定；release = 锁定 → 活期。 */
async function moveFunds(
  deps: BankToolDeps,
  args: Readonly<Record<string, unknown>>,
  ctx: ToolExecContext,
  action: 'lock' | 'release',
): Promise<FundLockResult> {
  const userId = requireUserId(deps, ctx.sessionId)
  const accounts = await deps.core.listAccounts(bankIds.user(userId))
  const current = accounts.find((item) => item.type === 'current')
  const locked = accounts.find((item) => item.type === 'locked')
  if (current === undefined || locked === undefined) {
    throw new BahError(
      'account-missing',
      'bank: 当前用户缺少活期或锁定账户，无法锁定/释放资金',
      {},
    )
  }

  const amountCents = yuanToCents(readNumber(args, 'amountYuan', 'fund_lock'))
  if (amountCents <= 0) {
    throw new BahError('tool-args-invalid', 'bank-tools: amountYuan 必须大于 0（单位：元）', {
      amountCents,
    })
  }

  const from = action === 'lock' ? current : locked
  const to = action === 'lock' ? locked : current
  const ticket = ticketRefForCall(deps, ctx, 'fund_lock', args, amountCents)
  const created = await deps.core.createTransfer(
    {
      fromAccountId: from.id,
      payee: {
        name: accountDisplayName(to),
        memo: action === 'lock' ? '资金锁定' : '解除锁定',
      },
      amountCents,
      channel: 'app',
    },
    ticket,
  )
  const transfer: TransferCreatedResult = {
    txnId: created.txnId,
    ticketId: created.ticketId,
    amountCents: created.amountCents,
    feeCents: created.feeCents,
    payeeName: accountDisplayName(to),
    balanceCents: created.balanceCents,
    availableCents: created.availableCents,
    dailyUsedCents: created.dailyUsedCents,
    dailyLimitCents: created.dailyLimitCents,
    remainingCents: created.remainingCents,
    at: created.at,
  }
  deps.audit.append('transfer/created', { result: transfer })

  // 动作后重读：锁定额与可用额以账本为准，不拿动作前的快照凑数
  const after = await deps.core.listAccounts(bankIds.user(userId))
  const lockedAfter = after.find((item) => item.type === 'locked')
  const currentAfter = after.find((item) => item.type === 'current')
  return {
    action,
    amountCents,
    txnId: created.txnId,
    lockedCents: lockedAfter?.balanceCents ?? locked.balanceCents,
    availableCents: currentAfter?.availableCents ?? current.availableCents,
  }
}

/** 面向模型的叙述：三种动作各一句，金额一律来自工具结果。 */
function describe(result: FundLockResult): string {
  if (result.action === 'status') {
    return `当前锁定 ${formatYuan(result.lockedCents)}，活期可用 ${formatYuan(result.availableCents)}。`
  }
  if (result.action === 'lock') {
    return (
      `已锁定 ${formatYuan(result.amountCents ?? 0)}：活期可用 ${formatYuan(result.availableCents)}、` +
      `锁定户合计 ${formatYuan(result.lockedCents)}（总资产不变，流水 ${String(result.txnId)}）。`
    )
  }
  return (
    `已释放 ${formatYuan(result.amountCents ?? 0)} 回活期：可用 ${formatYuan(result.availableCents)}、` +
    `锁定户剩余 ${formatYuan(result.lockedCents)}（流水 ${String(result.txnId)}）。`
  )
}

export function createFundLockTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, FundLockResult> {
  const spec = specOf('fund_lock')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const action = readRequiredEnum(args, 'action', spec.name, FUND_LOCK_ACTIONS)
      return action === 'status'
        ? readStatus(deps, ctx)
        : moveFunds(deps, args, ctx, action)
    },
    projectContent: (result) => [{ type: 'text', text: describe(result) }],
  } satisfies ToolDefinition<Readonly<Record<string, unknown>>, FundLockResult>
}
