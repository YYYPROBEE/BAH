/**
 * JSONL 行协议原语的单测（施工单 03 §1.5）。
 *
 * 这些原语被 `@bah/persistence`（运行时）与 `@bah/test-support`（快照夹具）共同使用，
 * 所以这里钉的是**格式与容忍边界**，不是某个后端的策略。
 */

import { describe, expect, it } from 'vitest'

import {
  encodeJsonLine,
  encodeSessionHeaderLine,
  isLastNonEmptyLine,
  parseJsonObject,
  parseJsonValue,
  parseSessionHeaderLine,
  SESSION_LOG_HEADER_KIND,
  splitLogLines,
} from './codec.ts'

describe('encodeJsonLine / parseJsonValue', () => {
  it('对象、数组、标量都能往返；中文与换行按 JSON 转义', () => {
    const value = { seq: 1, text: '第一行\n第二行', nested: [1, '两', null] }
    expect(parseJsonValue(encodeJsonLine(value))).toEqual(value)
    expect(encodeJsonLine(value)).not.toContain('\n')
    expect(parseJsonValue('[1,2]')).toEqual([1, 2])
    expect(parseJsonValue('"字"')).toBe('字')
    expect(parseJsonValue('null')).toBeNull()
  })

  it('坏 JSON → undefined（处置交给调用方）', () => {
    expect(parseJsonValue('{"seq":1')).toBeUndefined()
    expect(parseJsonValue('')).toBeUndefined()
    expect(parseJsonValue('undefined')).toBeUndefined()
  })
})

describe('parseJsonObject', () => {
  it('普通对象通过；数组 / 标量 / 坏 JSON 一律拒绝', () => {
    expect(parseJsonObject('{"seq":1}')).toEqual({ seq: 1 })
    expect(parseJsonObject('[]')).toBeUndefined()
    expect(parseJsonObject('1')).toBeUndefined()
    expect(parseJsonObject('null')).toBeUndefined()
    expect(parseJsonObject('{')).toBeUndefined()
  })
})

describe('header 行', () => {
  it('编码补上判别标签，字段顺序稳定（kind 在最前）', () => {
    const line = encodeSessionHeaderLine({
      sessionId: 's-1',
      formatVersion: 1,
      createdAt: 42,
    })
    expect(line.startsWith(`{"kind":"${SESSION_LOG_HEADER_KIND}"`)).toBe(true)
    expect(parseSessionHeaderLine(line)).toEqual({
      kind: SESSION_LOG_HEADER_KIND,
      sessionId: 's-1',
      formatVersion: 1,
      createdAt: 42,
    })
  })

  it('meta 只在给出时出现', () => {
    const withMeta = encodeSessionHeaderLine({
      sessionId: 's-2',
      formatVersion: 1,
      createdAt: 1,
      meta: { channel: 'web' },
    })
    expect(parseSessionHeaderLine(withMeta)).toMatchObject({ meta: { channel: 'web' } })

    const without = encodeSessionHeaderLine({ sessionId: 's-3', formatVersion: 1, createdAt: 1 })
    expect(parseSessionHeaderLine(without)).not.toHaveProperty('meta')
  })

  it('判别标签不命中 / 事件行 / 数组 → undefined', () => {
    expect(parseSessionHeaderLine('{"kind":"nope","sessionId":"s"}')).toBeUndefined()
    expect(parseSessionHeaderLine('{"seq":1,"type":"turn/start"}')).toBeUndefined()
    expect(parseSessionHeaderLine('[1,2,3]')).toBeUndefined()
    expect(parseSessionHeaderLine('{半截')).toBeUndefined()
  })
})

describe('splitLogLines / isLastNonEmptyLine', () => {
  it('LF 与 CRLF 等价；末尾换行不产生空行；文件内空行保留', () => {
    expect(splitLogLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLogLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(splitLogLines('a\n\nb\n')).toEqual(['a', '', 'b'])
    expect(splitLogLines('')).toEqual([])
    expect(splitLogLines('\n')).toEqual([])
  })

  it('尾行判定只看后面还有没有非空行', () => {
    const lines = ['header', 'good', '{"seq":2']
    expect(isLastNonEmptyLine(lines, 2)).toBe(true)
    expect(isLastNonEmptyLine(lines, 1)).toBe(false)
    expect(isLastNonEmptyLine(['a', 'b', ''], 1)).toBe(true)
  })
})
