/**
 * SSE 解析（02 单 §2.11 第 3 步）：纯函数面。
 *
 * 网关只消费宿主的 `frame` 事件与心跳注释，解析错一位就是"帧错位 / 整段静默丢帧"，
 * 线上只能靠用户发现对话缺了一段。这里钉死分块、CRLF、注释、多行 data 与半截帧。
 */

import { describe, expect, it } from 'vitest'

import { frameOfEvent, parseSseBuffer } from '../src/bridge/sse.ts'

describe('parseSseBuffer：帧边界', () => {
  it('心跳注释块不算事件；完整帧一次解出，rest 为空', () => {
    const parsed = parseSseBuffer(': connected\n\nevent: frame\ndata: {"kind":"turn","seq":1}\n\n')
    expect(parsed.events).toEqual([{ event: 'frame', data: '{"kind":"turn","seq":1}' }])
    expect(parsed.rest).toBe('')
  })

  it('半截帧留在 rest：补齐后只产出一个事件（不重复、不丢）', () => {
    const first = parseSseBuffer('event: frame\ndata: he')
    expect(first.events).toEqual([])
    expect(first.rest).toBe('event: frame\ndata: he')

    const second = parseSseBuffer(`${first.rest}llo\n\n`)
    expect(second.events).toEqual([{ event: 'frame', data: 'hello' }])
    expect(second.rest).toBe('')
  })

  it('CRLF 归一：\\r\\n\\r\\n 也是帧边界；被块边界切开的 \\r\\n 在拼回后仍成立', () => {
    expect(parseSseBuffer('event: frame\r\ndata: x\r\n\r\n').events).toEqual([
      { event: 'frame', data: 'x' },
    ])

    const partial = parseSseBuffer('data: x\r')
    expect(partial.events).toEqual([])
    expect(partial.rest).toBe('data: x\r')
    expect(parseSseBuffer(`${partial.rest}\n\r\n`).events).toEqual([{ event: 'message', data: 'x' }])
  })

  it('多行 data 用 \\n 拼接；`data:` 后只去掉一个前导空格', () => {
    const parsed = parseSseBuffer('event: frame\ndata: 第一行\ndata:  第二行\n\n')
    expect(parsed.events).toEqual([{ event: 'frame', data: '第一行\n 第二行' }])
  })

  it('无 event: 行时事件名为 message；只有注释的块整体丢弃', () => {
    expect(parseSseBuffer('data: x\n\n').events).toEqual([{ event: 'message', data: 'x' }])
    expect(parseSseBuffer(': ping\n\n: pong\n\n').events).toEqual([])
    expect(parseSseBuffer('event: frame\n\n').events).toEqual([])
  })

  it('多帧一次到达：逐个解出，尾随半帧仍留在 rest', () => {
    const parsed = parseSseBuffer('data: a\n\ndata: b\n\nevent: frame\ndata: tail')
    expect(parsed.events).toEqual([
      { event: 'message', data: 'a' },
      { event: 'message', data: 'b' },
    ])
    expect(parsed.rest).toBe('event: frame\ndata: tail')
  })

  it('空 buffer ⇒ 无事件、无剩余', () => {
    expect(parseSseBuffer('')).toEqual({ events: [], rest: '' })
  })
})

describe('frameOfEvent：只认 frame 事件且形状必须是对象', () => {
  it('合法帧原样返回（不重排、不补字段）', () => {
    const frame = { kind: 'turn', seq: 2, at: 1, turn: 1, phase: 'end', endKind: 'completed' }
    expect(frameOfEvent({ event: 'frame', data: JSON.stringify(frame) })).toEqual(frame)
  })

  it('非 frame 事件、坏 JSON、null / 数组、缺 kind / kind 非字符串 ⇒ undefined', () => {
    expect(frameOfEvent({ event: 'message', data: '{"kind":"turn"}' })).toBeUndefined()
    expect(frameOfEvent({ event: 'frame', data: 'not-json' })).toBeUndefined()
    expect(frameOfEvent({ event: 'frame', data: 'null' })).toBeUndefined()
    expect(frameOfEvent({ event: 'frame', data: '[]' })).toBeUndefined()
    expect(frameOfEvent({ event: 'frame', data: '{}' })).toBeUndefined()
    expect(frameOfEvent({ event: 'frame', data: '{"kind":""}' })).toBeUndefined()
    expect(frameOfEvent({ event: 'frame', data: '{"kind":42}' })).toBeUndefined()
  })
})
