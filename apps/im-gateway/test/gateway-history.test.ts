/**
 * IM 历史概览（2026-11-02）。
 *
 * 两条硬纪律，用例就是判据：
 * 1. **不许为了看历史拉起子进程**——子进程闲置会被回收，`ensure()` 会 spawn 一个新的，
 *    等于用户问一句话就开一条钱路；这里断言 `spawnCount() === 0`；
 * 2. **不许把业务语句误判成指令**——"最近转账"是真实业务，不能进历史分支。
 */

import { describe, expect, it } from 'vitest'

import type { ImInbound, PlatformPushResult, PlatformReply } from '@bah/channels'
import { deriveImSessionId } from '@bah/channels'

import { IM_HELP_TEXT } from '../src/bridge/help.ts'
import {
  HISTORY_FAILED_TEXT,
  HISTORY_IDLE_TEXT,
  HISTORY_MAX_ITEMS,
  isHistoryRequest,
  renderHistoryText,
} from '../src/bridge/history.ts'
import { createPullStore } from '../src/bridge/outbound.ts'
import { handleInbound, type InboundDeps } from '../src/bridge/turn.ts'
import { createDedupe } from '../src/ingress/dedupe.ts'
import { createRateLimiter } from '../src/ingress/ratelimit.ts'
import { createImLogger } from '../src/log.ts'
import { createSessionHub } from '../src/session/hub.ts'
import { configFor, fakeChild, fakeSupervisor, recordOf } from './harness-03.ts'

const NOW = 1_793_000_000_000
const log = createImLogger('error', () => undefined)
const CAPABILITIES = {
  passiveReply: true,
  asyncPush: true,
  interactiveCards: false,
  threads: false,
  maxTextBytes: 2048,
} as const

function fakeReply(): PlatformReply & { passives: string[] } {
  const passives: string[] = []
  return {
    passives,
    passive(outbounds) {
      const text = outbounds.map((item) => item.text).join('\n')
      passives.push(text)
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: text }
    },
    async push(): Promise<PlatformPushResult> {
      return { ok: true }
    },
  }
}

/**
 * 造一套依赖。
 *
 * @param withChild `false` = 子进程已被回收（records 为空）
 */
function setup(withChild: boolean): {
  deps: InboundDeps
  child: ReturnType<typeof fakeChild>
  reply: ReturnType<typeof fakeReply>
  supervisor: ReturnType<typeof fakeSupervisor>
} {
  const config = configFor()
  const child = fakeChild()
  const sessionKey = deriveImSessionId('mock', 'u-1', config.sessionSalt)
  const records = new Map()
  if (withChild) {
    records.set(sessionKey, recordOf({ platform: 'mock', userId: 'u-1', sessionKey, client: child }))
  }
  const supervisor = fakeSupervisor({ salt: config.sessionSalt, records })
  const pull = createPullStore({ nowMs: () => NOW })
  const hub = createSessionHub({ config, log, pull, nowMs: () => NOW })
  const reply = fakeReply()
  const deps: InboundDeps = {
    config,
    supervisor,
    dedupe: createDedupe({ nowMs: () => NOW }),
    rateLimiter: createRateLimiter(),
    pull,
    hub,
    log,
    capabilitiesOf: () => CAPABILITIES,
    openWaitMs: 10,
  }
  return { deps, child, reply, supervisor }
}

function inbound(text: string, messageId: string): ImInbound {
  return { platform: 'mock', accountKey: 'default', userId: 'u-1', text, messageId, at: NOW }
}

describe('isHistoryRequest', () => {
  it.each(['历史', '历史记录', '记录', 'history', 'HISTORY', ' 历史 '])('%s 是历史请求', (text) => {
    expect(isHistoryRequest(text)).toBe(true)
  })

  it.each(['最近转账', '帮我看下记录里那笔', '历史账单分期', '1', '帮助', '转人工'])(
    '%s 不是历史请求（业务语句不能被指令抢走）',
    (text) => {
      expect(isHistoryRequest(text)).toBe(false)
    },
  )
})

describe('renderHistoryText', () => {
  it('空列表给一句干净的"还没有"', () => {
    expect(renderHistoryText([])).toBe('还没有历史对话。')
    expect(renderHistoryText(undefined)).toBe('还没有历史对话。')
    expect(renderHistoryText('不是数组')).toBe('还没有历史对话。')
  })

  it('列标题、时间、轮数；超过 5 条只显示 5 条并说明总数', () => {
    const sessions = Array.from({ length: 8 }, (_, index) => ({
      sessionId: `s-${String(index)}`,
      title: `对话 ${String(index)}`,
      lastAt: new Date(2026, 10, 2, 9, index).getTime(),
      turns: index,
    }))
    const text = renderHistoryText(sessions)
    expect(text).toContain('【最近的历史对话】')
    expect(text).toContain('1. 11-02 09:00 · 对话 0（0 轮）')
    expect(text.match(/^\d+\. /gm)).toHaveLength(HISTORY_MAX_ITEMS)
    expect(text).toContain('共 8 次对话，这里显示最近 5 次。')
  })

  it('不超过 5 条时不提"显示最近 5 次"', () => {
    const text = renderHistoryText([{ title: 'A', lastAt: NOW, turns: 1 }])
    expect(text).toContain('共 1 次对话。')
    expect(text).not.toContain('显示最近')
  })

  it('字段残缺也有兜底，不抛', () => {
    const text = renderHistoryText([{}, null, { title: '', lastAt: 'x', turns: 'y' }])
    expect(text).toContain('（无标题）')
    expect(text).toContain('未完成')
    expect(text).toContain('—')
  })

  it('文案里说明"只显示概览"，不承诺逐条回看', () => {
    expect(renderHistoryText([{ title: 'A', lastAt: NOW, turns: 1 }])).toContain('只显示概览')
  })
})

describe('IM 历史闭环', () => {
  it('"历史" → 用客户凭证拉一次列表（limit = 5），回复概览', async () => {
    const { deps, child, reply } = setup(true)
    child.setHistory({
      status: 200,
      json: {
        sessions: [{ sessionId: 's-a', title: '转 500 给他', lastAt: NOW, turns: 2 }],
        total: 1,
      },
      text: '{}',
    })

    const outcome = await handleInbound(deps, inbound('历史', 'm-1'), reply)
    await outcome.done

    expect(child.calls.history).toEqual([HISTORY_MAX_ITEMS])
    expect(reply.passives[0]).toContain('转 500 给他')
    expect(reply.passives[0]).toContain('（2 轮）')
    // 历史不该驱动任何一轮对话
    expect(child.calls.turns).toEqual([])
  })

  it('子进程已被回收：直说看不了，且**不拉起新进程**', async () => {
    const { deps, reply, supervisor } = setup(false)
    const outcome = await handleInbound(deps, inbound('历史', 'm-1'), reply)
    await outcome.done

    expect(reply.passives[0]).toBe(HISTORY_IDLE_TEXT)
    expect(supervisor.spawnCount()).toBe(0)
  })

  it('子进程在但请求失败：给可重试的提示，不吞成空白', async () => {
    const { deps, child, reply } = setup(true)
    child.setHistory({ status: 500, json: { error: { code: 'boom' } }, text: '{}' })
    const outcome = await handleInbound(deps, inbound('历史', 'm-2'), reply)
    await outcome.done
    expect(reply.passives[0]).toBe(HISTORY_FAILED_TEXT)
  })

  it('后端返回的 sessions 不是数组时按空列表处理', async () => {
    const { deps, child, reply } = setup(true)
    child.setHistory({ status: 200, json: {}, text: '{}' })
    const outcome = await handleInbound(deps, inbound('记录', 'm-3'), reply)
    await outcome.done
    expect(reply.passives[0]).toBe('还没有历史对话。')
  })

  it('"最近转账"走业务，不进历史分支', async () => {
    const { deps, child, reply } = setup(true)
    await handleInbound(deps, inbound('最近转账', 'm-4'), reply)
    expect(child.calls.history).toEqual([])
  })

  it('历史命中时不占用去重键，第二次同样的请求仍会回（不是幂等指令）', async () => {
    const { deps, child, reply } = setup(true)
    await handleInbound(deps, inbound('历史', 'm-5'), reply)
    await handleInbound(deps, inbound('历史', 'm-6'), reply)
    expect(child.calls.history).toHaveLength(2)
  })

  it('帮助菜单里有"看历史"入口——不列出来等于用户永远发现不了', () => {
    expect(IM_HELP_TEXT).toContain('看历史')
  })
})
