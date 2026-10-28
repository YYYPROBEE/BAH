/**
 * 结构化日志（02 / S2.1）。
 *
 * 这些用例守的是"日志坏了没人发现"的四条：
 * 级别过滤（少打但别打错）、禁字段（密钥根本不出现）、上下文（同一条链路能串起来）、
 * 文件出口（轮转失败不能反过来影响 stderr）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureLogging,
  currentLogContext,
  logJson,
  loggingConfig,
  logStats,
  resetLogStats,
  runWithLogContext,
} from './logging.ts'

const captured: string[] = []

function capture(): () => void {
  captured.length = 0
  const spy = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
    captured.push(String(line))
  })
  return () => spy.mockRestore()
}

afterEach(() => {
  configureLogging({ level: 'info', file: null })
  resetLogStats()
})

describe('logging · 级别与字段', () => {
  it('低于配置级别不序列化、只计数；达到级别才落 stderr', () => {
    const restore = capture()
    try {
      configureLogging({ level: 'warn' })
      logJson('info', 'test.suppressed')
      expect(captured).toHaveLength(0)
      logJson('warn', 'test.emitted', { n: 1 })
      expect(captured).toHaveLength(1)
      expect(logStats().suppressed).toBe(1)
      expect(logStats().byLevel.warn).toBe(1)
    } finally {
      restore()
    }
  })

  it('禁止字段整条丢弃（不打码）；undefined 不占位', () => {
    const restore = capture()
    try {
      logJson('warn', 'test.fields', {
        apiKey: 'sk-live',
        token: 'tok',
        secret: 's',
        password: 'p',
        authorization: 'Bearer x',
        cookie: 'session=x',
        key: 'k',
        ok: true,
        missing: undefined,
      })
      const payload = JSON.parse(captured[0]!) as Record<string, unknown>
      expect(payload).toMatchObject({ level: 'warn', code: 'test.fields', ok: true })
      expect(Object.keys(payload).sort()).toEqual(['code', 'level', 'ok', 'ts'])
      expect(captured[0]).not.toContain('sk-live')
    } finally {
      restore()
    }
  })

  it('固定字段 code/ts/level 不被 fields 覆盖（否则事件名/级别会被顶掉）', () => {
    const restore = capture()
    try {
      logJson('warn', 'test.reserved', { code: 'field-code', ts: 'field-ts', level: 'field-level', ok: 1 })
      const payload = JSON.parse(captured[0]!) as Record<string, unknown>
      expect(payload.code).toBe('test.reserved')
      expect(payload.ts).not.toBe('field-ts')
      expect(payload.level).toBe('warn')
      expect(payload.ok).toBe(1)
    } finally {
      restore()
    }
  })

  it('runWithLogContext 自动合并；fields 可覆盖同名键', () => {
    const restore = capture()
    try {
      runWithLogContext({ sessionId: 's-1', turn: 2, component: 'runtime' }, () => {
        expect(currentLogContext()).toMatchObject({ sessionId: 's-1', turn: 2 })
        logJson('info', 'test.context', { turn: 3, extra: 'x' })
      })
      const payload = JSON.parse(captured[0]!) as Record<string, unknown>
      expect(payload).toMatchObject({ sessionId: 's-1', turn: 3, component: 'runtime', extra: 'x' })
    } finally {
      restore()
    }
  })

  it('非法级别回落 info 并留一条 logging.env-invalid', () => {
    const restore = capture()
    try {
      configureLogging({ level: 'verbose' })
      expect(loggingConfig().level).toBe('info')
      expect(captured).toHaveLength(1)
      expect(JSON.parse(captured[0]!)).toMatchObject({ code: 'logging.env-invalid', level: 'warn' })
    } finally {
      restore()
    }
  })
})

describe('logging · 文件出口与统计', () => {
  it('配置文件后同一行同时落 stderr 与文件；换行是单行 JSON', () => {
    const restore = capture()
    const dir = mkdtempSync(join(tmpdir(), 'bah-log-'))
    const file = join(dir, 'app.jsonl')
    try {
      configureLogging({ level: 'debug', file })
      logJson('debug', 'test.file', { n: 1 })
      expect(captured).toHaveLength(1)
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0]!)).toMatchObject({ code: 'test.file', n: 1 })
    } finally {
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件超过阈值时轮转：原文件 → .1，新行写新文件', () => {
    const restore = capture()
    const dir = mkdtempSync(join(tmpdir(), 'bah-log-rot-'))
    const file = join(dir, 'app.jsonl')
    try {
      writeFileSync(file, 'x'.repeat(64), 'utf8')
      configureLogging({ level: 'info', file, maxFileBytes: 16 })
      logJson('info', 'test.rotate')
      const rotated = readFileSync(`${file}.1`, 'utf8')
      expect(rotated.length).toBe(64)
      expect(readFileSync(file, 'utf8')).toContain('test.rotate')
    } finally {
      restore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resetLogStats 清空计数（测试辅助，不影响出口）', () => {
    const restore = capture()
    try {
      logJson('error', 'test.reset')
      expect(logStats().byLevel.error).toBe(1)
      resetLogStats()
      expect(logStats().byLevel.error).toBe(0)
    } finally {
      restore()
    }
  })
})
