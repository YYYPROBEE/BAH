/**
 * 会话日志最小实现（快照 fixture 用）的自测。
 *
 * 它必须和运行时 JSONL 后端"同构"：header 一行 + 事件逐行。真后端的交叉验证在
 * `snapshots/` 面（那里可以自由 import `@bah/persistence`，不会形成 project reference 环）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { SessionEvent } from '@bah/core'

import { captureThrown } from '../assertions/index.ts'

import { SESSION_LOG_FILE, readSessionLog, writeSessionLog } from './session-log.ts'

/** 造一条事件。 */
function event(seq: number): SessionEvent {
  return { seq, at: 10, formatVersion: 1, type: 'turn/start', data: { turn: seq } }
}

describe('session-log', () => {
  it('写出来是 header + 逐事件行，读回来逐条相等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-log-'))
    try {
      writeSessionLog(dir, 's-log', [event(1), event(2)], 42)

      const lines = readFileSync(join(dir, SESSION_LOG_FILE), 'utf8').split('\n').filter(Boolean)
      expect(lines).toHaveLength(3)
      expect(JSON.parse(lines[0]!)).toEqual({
        kind: 'bah-session-header',
        sessionId: 's-log',
        formatVersion: 1,
        createdAt: 42,
      })

      expect(readSessionLog(dir)).toEqual({
        sessionId: 's-log',
        events: [event(1), event(2)],
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没有事件时也能写（header 的格式版本回落到 1）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-log-'))
    try {
      writeSessionLog(dir, 's-empty', [], 7)
      const content = readSessionLog(dir)
      expect(content.events).toEqual([])
      expect(JSON.parse(readFileSync(join(dir, SESSION_LOG_FILE), 'utf8').split('\n')[0]!)).toMatchObject({
        formatVersion: 1,
        createdAt: 7,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺文件 → snapshot-missing；header 坏 / 事件坏 → snapshot-invalid（fixture 坏了必须重录）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-log-'))
    const path = join(dir, SESSION_LOG_FILE)
    try {
      expect(captureThrown(() => readSessionLog(dir)).code).toBe('snapshot-missing')

      writeFileSync(path, `${JSON.stringify({ kind: 'nope', sessionId: 's' })}\n`, 'utf8')
      expect(captureThrown(() => readSessionLog(dir)).code).toBe('snapshot-invalid')

      writeFileSync(path, `${JSON.stringify({ kind: 'bah-session-header' })}\n`, 'utf8')
      expect(captureThrown(() => readSessionLog(dir)).code).toBe('snapshot-invalid')

      writeFileSync(
        path,
        `${JSON.stringify({ kind: 'bah-session-header', sessionId: 's' })}\n{半截\n`,
        'utf8',
      )
      expect(captureThrown(() => readSessionLog(dir)).code).toBe('snapshot-invalid')

      writeFileSync(
        path,
        `${JSON.stringify({ kind: 'bah-session-header', sessionId: 's' })}\n{"seq":"x"}\n`,
        'utf8',
      )
      const error = captureThrown(() => readSessionLog(dir))
      expect(error.code).toBe('snapshot-invalid')
      expect(error.message).toContain('第 2 行')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('header 行是数组 / 标量 → snapshot-invalid（不是对象一律拒绝）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bah-log-'))
    try {
      writeFileSync(join(dir, SESSION_LOG_FILE), '[1,2,3]\n', 'utf8')
      expect(captureThrown(() => readSessionLog(dir)).code).toBe('snapshot-invalid')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
