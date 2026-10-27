/**
 * Inbox：两条车道 + 唤醒（施工单 04 §3 / §6 第 2 步）。
 *
 * 这里钉住三件容易写歪的事：
 * 1. `next-turn` / `next-step` 是**两条**车道，认领互不侵占（转向不能悄悄变成新 turn）；
 * 2. 取走即离队（reject 之后不会"复活"）；
 * 3. `wakeDriver()` 是常驻驱动的唤入口：空队列挂起 → 入队即醒。
 */

import { captureThrown } from '@bah/test-support'
import { describe, expect, it } from 'vitest'

import { Inbox } from './inbox.ts'

describe('Inbox · 认领与车道', () => {
  it('默认进 next-turn 车道；claim 取走车道全部消息（FIFO）', () => {
    let now = 1_000
    const inbox = new Inbox({ now: () => (now += 10) })

    inbox.send('第一条')
    inbox.send('第二条')

    expect(inbox.hasPending('next-turn')).toBe(true)
    expect(inbox.hasPending('next-step')).toBe(false)
    expect(inbox.pending).toBe(2)

    const claim = inbox.claim('next-turn', 1)
    expect(claim.turn).toBe(1)
    expect(claim.target).toBe('next-turn')
    expect(claim.messages.map((message) => message.text)).toEqual(['第一条', '第二条'])
    expect(claim.messages.map((message) => message.at)).toEqual([1_010, 1_020])
    expect(claim.messages[0]?.source).toBe('user')
    // 取走即离队
    expect(inbox.hasPending()).toBe(false)
  })

  it('steer 进 next-step 车道，next-turn 认领不到它', () => {
    const inbox = new Inbox()
    inbox.send('用户提问')
    inbox.send('转向指令', { target: 'next-step' })

    expect(inbox.claim('next-turn', 1).messages.map((message) => message.text)).toEqual([
      '用户提问',
    ])
    // 转向消息还在
    expect(inbox.nextStep.map((message) => message.text)).toEqual(['转向指令'])
    expect(inbox.claim('next-step', 1).messages.map((message) => message.text)).toEqual([
      '转向指令',
    ])
  })

  it('空白文本不入队（不制造空事件）', () => {
    const inbox = new Inbox()
    inbox.send('   ')
    inbox.send('\n\t')
    expect(inbox.pending).toBe(0)
  })

  it('source 可指定（工具纠正文本用 context，运行时上下文用 runtime-context）', () => {
    const inbox = new Inbox()
    inbox.send('纠正：金额超限', { source: 'context' })
    expect(inbox.claim('next-turn', 1).messages[0]?.source).toBe('context')
  })

  it('preferredTarget：先 next-turn，只有转向时退化到 next-step', () => {
    const inbox = new Inbox()
    expect(inbox.preferredTarget()).toBe('next-turn')
    inbox.send('a', { target: 'next-step' })
    expect(inbox.preferredTarget()).toBe('next-step')
    inbox.send('b')
    expect(inbox.preferredTarget()).toBe('next-turn')
  })

  it('nextStep 是只读视图（改不动队列）', () => {
    const inbox = new Inbox()
    inbox.send('转向', { target: 'next-step' })
    const view = inbox.nextStep
    expect(view).toHaveLength(1)
    // `nextStep` 返回副本：push 不进真实车道
    ;(view as unknown as unknown[]).push(null)
    expect(inbox.nextStep).toHaveLength(1)
  })
})

describe('Inbox · 唤醒与关闭', () => {
  it('空队列挂起，入队即唤醒（wakeDriver 被调用）', async () => {
    const inbox = new Inbox()
    const waiting = inbox.waitForInput()
    expect(inbox.wakeCount).toBe(0)

    inbox.send('醒醒')
    await waiting

    expect(inbox.wakeCount).toBe(1)
    expect(inbox.pending).toBe(1)
  })

  it('已有待处理消息时 waitForInput 立即返回、不挂起', async () => {
    const inbox = new Inbox()
    inbox.send('已有')
    const wakes = inbox.wakeCount
    await inbox.waitForInput()
    expect(inbox.wakeCount).toBe(wakes)
  })

  it('close：清空两条车道并唤醒挂起的 driver', async () => {
    const inbox = new Inbox()
    inbox.send('a')
    inbox.send('b', { target: 'next-step' })

    const waiting = inbox.waitForInput()
    inbox.close()

    await waiting
    expect(inbox.pending).toBe(0)
    expect(inbox.isClosed).toBe(true)
    expect(inbox.nextStep).toEqual([])
    // 关闭后 waitForInput 立即返回
    await expect(inbox.waitForInput()).resolves.toBeUndefined()
  })

  it('关闭后拒绝新输入（fail-loud，不静默丢）', () => {
    const inbox = new Inbox()
    inbox.close()
    const thrown = captureThrown(() => inbox.send('晚了一步'))
    expect(thrown.code).toBe('inbox-closed')
  })

  it('close 幂等（重复调用不重复唤醒）', () => {
    const inbox = new Inbox()
    inbox.close()
    const wakes = inbox.wakeCount
    inbox.close()
    expect(inbox.wakeCount).toBe(wakes)
  })

  it('D1：待处理到上限即拒绝（inbox-full），不放任无界排队', () => {
    const inbox = new Inbox({ maxPending: 2 })
    inbox.send('第一条')
    inbox.send('第二条')
    const thrown = captureThrown(() => inbox.send('第三条'))
    expect(thrown.code).toBe('inbox-full')
    // 拒绝的是**新**消息：已入队的两条不动，队列状态可解释
    expect(inbox.pending).toBe(2)
    expect(inbox.claim('next-turn', 1).messages.map((message) => message.text)).toEqual([
      '第一条',
      '第二条',
    ])
    // 认领后腾出名额，可以继续入队
    inbox.send('第三条')
    expect(inbox.pending).toBe(1)
  })

  it('D1：两条车道合计计数（转向消息同样占名额）', () => {
    const inbox = new Inbox({ maxPending: 2 })
    inbox.send('turn')
    inbox.send('step', { target: 'next-step' })
    expect(captureThrown(() => inbox.send('again')).code).toBe('inbox-full')
  })
})
