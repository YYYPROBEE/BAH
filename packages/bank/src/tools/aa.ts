/**
 * AA 拆分收款（赛题 §二 场景 1 的子能力）。
 *
 * `create` 只生成「每人待收多少」；`collect` 是**模拟代收**（demo 口径）：
 * 本进程替某位参与人把那一份记进组织者主账户并写 `in/transfer` 流水。
 * **不伪造真实到账**——跨人收款需要行内清算接口，本仓没有（ADR-0011）。
 */

import type { ToolDefinition } from '@bah/core'
import { BahError } from '@bah/util'

import type { AaGroup, AaGroupId } from '../core/index.ts'
import { bankIds, formatYuan, yuanToCents } from '../core/index.ts'
import { requireUserId } from './accounts.ts'
import { readEnum, readNumber, readOptionalPositiveInteger, readOptionalString } from './args.ts'
import type { AaGroupResult } from './dto.ts'
import { specOf } from './specs.ts'
import type { BankToolDeps } from './types.ts'
import { clockOf } from './types.ts'

/** `aa_create`：黄档写（create）/ 读（status）。 */
export function createAaCreateTool(
  deps: BankToolDeps,
): ToolDefinition<Readonly<Record<string, unknown>>, AaGroupResult> {
  const spec = specOf('aa_create')
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    tier: spec.tier,
    execute: async (args, ctx) => {
      const userId = requireUserId(deps, ctx.sessionId)
      const action =
        readEnum(args, 'action', spec.name, [
          'create',
          'status',
          'collect',
          'decline',
          'close',
        ] as const) ?? 'create'

      if (action === 'status') {
        const groupId = readOptionalString(args, 'groupId', spec.name)
        if (groupId === undefined) {
          throw new BahError('tool-args-invalid', 'bank-tools: aa_create.status 需要 groupId', {})
        }
        const group = await deps.core.getAa(bankIds.user(userId), groupId as AaGroupId)
        if (group === undefined) {
          throw new BahError('aa-unknown', `bank-tools: 找不到 AA 组 ${groupId}`, { groupId })
        }
        const result = toAaResult(group)
        deps.audit.append('read/aa', { result })
        return result
      }

      if (action === 'collect') {
        const groupId = readOptionalString(args, 'groupId', spec.name)
        if (groupId === undefined) {
          throw new BahError('tool-args-invalid', 'bank-tools: aa_create.collect 需要 groupId', {})
        }
        const raw = readOptionalString(args, 'participant', spec.name)
        if (raw === undefined) {
          throw new BahError(
            'tool-args-invalid',
            'bank-tools: aa_create.collect 需要 participant（姓名或序号）',
            {},
          )
        }
        // 纯数字串按序号（"0" / "1" …）；其余按姓名。手机号不会被当成键——
        // 它不是姓名，也不是序号，只会落到 `aa-participant-unknown`。
        const participant = /^\d+$/.test(raw) ? Number(raw) : raw
        const collected = await deps.core.collectAa({
          userId: bankIds.user(userId),
          groupId: groupId as AaGroupId,
          participant,
        })
        const result = toAaResult(collected.group)
        deps.audit.append('aa/collected', {
          groupId: result.groupId,
          participantIndex: collected.participantIndex,
          collectedCents: collected.collectedCents,
          txnId: String(collected.txnId),
          at: clockOf(deps)(),
        })
        return result
      }

      if (action === 'decline' || action === 'close') {
        const groupId = readOptionalString(args, 'groupId', spec.name)
        if (groupId === undefined) {
          throw new BahError(
            'tool-args-invalid',
            `bank-tools: aa_create.${action} 需要 groupId`,
            {},
          )
        }
        if (action === 'close') {
          const settled = await deps.core.closeAa({
            userId: bankIds.user(userId),
            groupId: groupId as AaGroupId,
          })
          const result = toAaResult(settled.group)
          for (const participantIndex of settled.affected) {
            deps.audit.append('aa/participant-updated', {
              groupId: result.groupId,
              participantIndex,
              from: 'pending',
              to: 'expired',
              at: settled.at,
            })
          }
          return result
        }

        const raw = readOptionalString(args, 'participant', spec.name)
        if (raw === undefined) {
          throw new BahError(
            'tool-args-invalid',
            'bank-tools: aa_create.decline 需要 participant（姓名或序号）',
            {},
          )
        }
        const participant = /^\d+$/.test(raw) ? Number(raw) : raw
        const settled = await deps.core.declineAa({
          userId: bankIds.user(userId),
          groupId: groupId as AaGroupId,
          participant,
        })
        const result = toAaResult(settled.group)
        for (const participantIndex of settled.affected) {
          deps.audit.append('aa/participant-updated', {
            groupId: result.groupId,
            participantIndex,
            from: 'pending',
            to: 'declined',
            at: settled.at,
          })
        }
        return result
      }

      const title = readOptionalString(args, 'title', spec.name) ?? 'AA 收款'
      const totalCents = yuanToCents(readNumber(args, 'totalYuan', spec.name))
      if (totalCents <= 0) {
        throw new BahError('aa-invalid', 'bank-tools: AA 总额必须大于 0', { totalCents })
      }
      const split = readEnum(args, 'split', spec.name, ['equal', 'custom'] as const) ?? 'equal'
      const rawParticipants = args['participants']
      if (!Array.isArray(rawParticipants) || rawParticipants.length < 2 || rawParticipants.length > 20) {
        throw new BahError('aa-invalid', 'bank-tools: AA 参与人必须是 2–20 人', {
          count: Array.isArray(rawParticipants) ? rawParticipants.length : 0,
        })
      }
      const participants = rawParticipants.map((raw, index) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
          throw new BahError('aa-invalid', 'bank-tools: AA 参与人必须是对象', { index })
        }
        const record = raw as Readonly<Record<string, unknown>>
        const name = typeof record['name'] === 'string' ? record['name'].trim() : ''
        if (name.length === 0) {
          throw new BahError('aa-invalid', 'bank-tools: AA 参与人姓名不能为空', { index })
        }
        if (name.length > 64) {
          throw new BahError('aa-invalid', 'bank-tools: AA 参与人姓名过长（上限 64）', { index })
        }
        const phone = typeof record['phone'] === 'string' ? record['phone'].trim() : undefined
        const shareYuan =
          typeof record['shareYuan'] === 'number' ? record['shareYuan'] : undefined
        return {
          name,
          ...(phone === undefined || phone.length === 0 ? {} : { phone }),
          ...(shareYuan === undefined ? {} : { shareCents: yuanToCents(shareYuan) }),
        }
      })

      const shares =
        split === 'custom'
          ? participants.map((participant, index) => {
              if (participant.shareCents === undefined || participant.shareCents <= 0) {
                throw new BahError('aa-invalid', 'bank-tools: custom 分摊必须给每人正数份额', {
                  index,
                })
              }
              return participant.shareCents
            })
          : equalShares(totalCents, participants.length)

      const expiresInHours = readOptionalPositiveInteger(args, 'expiresInHours', spec.name)
      const group = await deps.core.createAa({
        userId: bankIds.user(userId),
        title,
        totalCents,
        participants: participants.map((participant, index) => ({
          name: participant.name,
          ...(participant.phone === undefined ? {} : { phone: participant.phone }),
          shareCents: shares[index]!,
        })),
        ...(expiresInHours === undefined ? {} : { expiresInHours }),
      })
      const result = toAaResult(group)
      deps.audit.append('aa/created', { result })
      return result
    },
    projectContent: (result) => [
      {
        type: 'text',
        text:
          `AA 收款「${result.title}」：总额 ${formatYuan(result.totalCents)}，` +
          `已收 ${formatYuan(result.collectedCents)}，待收 ${formatYuan(result.pendingCents)}` +
          `${result.status === 'completed' ? '（已收齐）' : result.status === 'cancelled' ? '（已结束，未收款）' : ''}。\n` +
          result.participants
            .map(
              (participant) =>
                `- ${participant.name}：${formatYuan(participant.shareCents)}（${
                  AA_PARTICIPANT_STATUS_LABEL[participant.status] ?? participant.status
                }）`,
            )
            .join('\n'),
      },
    ],
  }
}

/** 均分：先按分取整，余数全部给第一位参与人（可解释、可复算）。 */
/**
 * 均分（余数给首位）。
 *
 * **导出给审批明细用**：审批卡上的"每人份额"必须与工具体真正写进账本的份额
 * 逐分一致；另抄一份均分算法，就会在"总额除不尽"的那一分钱上分叉。
 */
export function equalShares(totalCents: number, count: number): number[] {
  if (totalCents < count) {
    throw new BahError('aa-invalid', 'bank-tools: AA 总额不足以给每人至少 1 分', {
      totalCents,
      count,
    })
  }
  const base = Math.floor(totalCents / count)
  const remainder = totalCents - base * count
  return Array.from({ length: count }, (_value, index) => (index === 0 ? base + remainder : base))
}

/**
 * 核心实体 → 工具结果（collected/pending 由参与人状态现算，不另存）。
 *
 * `pendingCents` 只统计仍在 `pending` 的份额。从前是"总额 − 已收"，
 * 有了 `declined` / `expired` 之后那个算法会把"钱不会进来"的份额算成待收，
 * 对账时看起来像还有希望——展示口径必须与状态机一致。
 */
function toAaResult(group: AaGroup): AaGroupResult {
  const sumOf = (status: AaGroup['participants'][number]['status']): number =>
    group.participants
      .filter((participant) => participant.status === status)
      .reduce((sum, participant) => sum + participant.shareCents, 0)
  return {
    groupId: group.id,
    title: group.title,
    totalCents: group.totalCents,
    collectedCents: sumOf('paid'),
    pendingCents: sumOf('pending'),
    status: group.status,
    participants: group.participants.map((participant) => ({
      name: participant.name,
      shareCents: participant.shareCents,
      status: participant.status,
      ...(participant.paidAt === undefined ? {} : { paidAt: participant.paidAt }),
    })),
    createdAt: group.createdAt,
    ...(group.expiresAt === undefined ? {} : { expiresAt: group.expiresAt }),
  }
}

/** 参与人状态的中文标签（投影与审批卡共用同一套字，避免两处各写一套）。 */
export const AA_PARTICIPANT_STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '待收',
  paid: '已收',
  declined: '已拒绝',
  expired: '已过期',
}
