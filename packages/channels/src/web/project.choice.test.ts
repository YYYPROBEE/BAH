/**
 * `prompt_ask` → `choice` 帧投影（03 单 §3.12）。
 *
 * 只喂事件，断言帧。三条必须成立的性质：
 * 1. 帧字段逐一能追到 `tool/call` 的 args（B7 探针：不编造字段）；
 * 2. `allowFreeText` 恒 true（D6：永远可以「不选，直接说别的」）；
 * 3. `askExhausted`/`degraded` **不进帧**（内部防死循环状态不泄漏给 UI 做判断）。
 */

import { describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { projectSession } from './project.ts'
import type { ChoiceFrame } from './frames.ts'

let cursor = 0

function ev(type: string, data: unknown): AnySessionEvent {
  cursor += 1
  return { seq: cursor, at: 1_700_000_000_000 + cursor, formatVersion: 1, type, data } as unknown as AnySessionEvent
}

function promptAskEvents(args: Record<string, unknown>, isError = false): AnySessionEvent[] {
  cursor = 0
  return [
    ev('turn/start', { turn: 1 }),
    ev('step/start', { turn: 1, step: 1 }),
    ev('user/message', { content: '转500给他' }),
    ev('tool/call', {
      callId: 'call-ask',
      name: 'prompt_ask',
      args,
      fingerprint: 'fp-ask',
      tier: { level: 'green' },
      at: 1_700_000_000_000,
    }),
    ev('tool/result', {
      callId: 'call-ask',
      name: 'prompt_ask',
      isError,
      content: [{ type: 'text', text: '要转给谁？' }],
      durationMs: 3,
    }),
  ]
}

function choiceFrames(events: readonly AnySessionEvent[]): readonly ChoiceFrame[] {
  return projectSession(events).frames.filter((frame): frame is ChoiceFrame => frame.kind === 'choice')
}

describe('prompt_ask → choice 帧（§3.12 映射表）', () => {
  it('question/candidates 逐一映射，callId 可回溯', () => {
    const frames = choiceFrames(
      promptAskEvents({
        question: '要转给谁？',
        candidates: [
          { label: '王建国', value: 'p-wang' },
          { label: '张伟', value: 'p-zhang' },
        ],
        slot: 'payee',
      }),
    )
    expect(frames).toHaveLength(1)
    const frame = frames[0]
    expect(frame?.prompt).toBe('要转给谁？')
    expect(frame?.callId).toBe('call-ask')
    expect(frame?.options).toEqual([
      { id: 'p-wang', label: '王建国' },
      { id: 'p-zhang', label: '张伟' },
    ])
    expect(frame?.allowFreeText).toBe(true)
  })

  it('候选截断到 3 个（manual 出口由前端固定渲染，不占位）', () => {
    const frames = choiceFrames(
      promptAskEvents({
        question: '选哪个？',
        candidates: [
          { label: 'a', value: '1' },
          { label: 'b', value: '2' },
          { label: 'c', value: '3' },
          { label: 'd', value: '4' },
        ],
      }),
    )
    expect(frames[0]?.options).toHaveLength(3)
    expect(frames[0]?.options.map((option) => option.id)).toEqual(['1', '2', '3'])
  })

  it('askExhausted / degraded 不进帧（不让 UI 拿内部状态做判断）', () => {
    const frames = choiceFrames(
      promptAskEvents({ question: 'q', candidates: [], degraded: true, askExhausted: true }),
    )
    const frame = frames[0] as unknown as Record<string, unknown>
    expect('askExhausted' in frame).toBe(false)
    expect('degraded' in frame).toBe(false)
    expect('style' in frame).toBe(false)
  })

  it('空候选 ⇒ options 为空（前端据此只渲染输入出口）', () => {
    const frames = choiceFrames(promptAskEvents({ question: '请直接输入', candidates: [] }))
    expect(frames[0]?.options).toEqual([])
  })

  it('形状不对的候选被丢弃，不污染帧', () => {
    const frames = choiceFrames(
      promptAskEvents({
        question: 'q',
        candidates: [{ label: 'a', value: '1' }, { label: 2, value: '2' }, 'x', null],
      }),
    )
    expect(frames[0]?.options).toEqual([{ id: '1', label: 'a' }])
  })

  it('工具失败（isError）不产 choice 帧', () => {
    const frames = choiceFrames(
      promptAskEvents({ question: 'q', candidates: [{ label: 'a', value: '1' }] }, true),
    )
    expect(frames).toEqual([])
  })

  it('args 不是对象时降级成空帧（投影层不抛错）', () => {
    const frames = choiceFrames(promptAskEvents({ question: 'q', candidates: 'nope' }))
    expect(frames[0]?.options).toEqual([])
    expect(frames[0]?.prompt).toBe('q')
  })

  it('其它工具的结果不产 choice 帧', () => {
    cursor = 0
    const events: AnySessionEvent[] = [
      ev('turn/start', { turn: 1 }),
      ev('tool/call', {
        callId: 'c-bal',
        name: 'account_balance',
        args: {},
        fingerprint: 'fp',
        tier: { level: 'green' },
        at: 1,
      }),
      ev('tool/result', { callId: 'c-bal', name: 'account_balance', isError: false, content: [] }),
    ]
    expect(choiceFrames(events)).toEqual([])
  })

  it('同一次追问只有一张卡（frameKey 替换语义）', () => {
    const frames = choiceFrames(
      promptAskEvents({ question: 'q', candidates: [{ label: 'a', value: '1' }] }),
    )
    expect(new Set(frames.map((frame) => frame.callId)).size).toBe(frames.length)
  })
})
