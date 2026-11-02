/**
 * `logJson`（D2）：单行 JSON 落 stderr，且**不写密钥/PII**。
 *
 * 为什么单独钉这两个出口：日志是排障的第一入口，也是最容易被顺手塞进
 * `apiKey` / `authorization` 的地方。字段过滤（`FORBIDDEN_KEYS`）此前只靠
 * 集成用例间接经过，`value === undefined` 的丢弃分支更是从未执行——
 * 一旦回归成"打码"或"直接合并字段"，密钥就会以明文/长度进入 stderr。
 */

import { describe, expect, it, vi } from 'vitest'

import { logJson } from './log.ts'

/** 接住 `console.error` 的原始行（不改 stdout，验证出口唯一性）。 */
function captureStderr(): { lines: string[]; logCalls: () => number; restore(): void } {
  const lines: string[] = []
  const error = vi.spyOn(console, 'error').mockImplementation((line?: unknown) => {
    lines.push(String(line))
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  return {
    lines,
    logCalls: () => log.mock.calls.length,
    restore: () => {
      error.mockRestore()
      log.mockRestore()
    },
  }
}

describe('D2 结构化日志出口', () => {
  it('单行 JSON：固定字段 + 标量上下文，只走 stderr', () => {
    const captured = captureStderr()
    try {
      logJson('warn', 'model-retry', { status: 429, attempt: 1, delayMs: 1_000 })

      expect(captured.logCalls()).toBe(0)
      expect(captured.lines).toHaveLength(1)
      const line = captured.lines[0]!
      // 单行是 grep / 日志采集器能按行解析的前提
      expect(line).not.toContain('\n')
      expect(JSON.parse(line)).toMatchObject({
        level: 'warn',
        code: 'model-retry',
        status: 429,
        attempt: 1,
        delayMs: 1_000,
      })
      expect(JSON.parse(line).ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    } finally {
      captured.restore()
    }
  })

  it('禁止字段名一律整条丢弃（不打码）；undefined 不占位', () => {
    const captured = captureStderr()
    try {
      logJson('error', 'provider-failed', {
        apiKey: 'sk-live-do-not-log',
        token: 'tok-secret',
        secret: 's',
        password: 'p',
        authorization: 'Bearer leaked',
        cookie: 'session=leaked',
        key: 'k',
        model: 'deepseek-chat',
        reason: undefined,
      })

      const line = captured.lines[0]!
      const payload = JSON.parse(line) as Record<string, unknown>
      // 只有固定字段与允许的标量：禁止字段不是"打码后保留"，而是根本不出现
      expect(Object.keys(payload).sort()).toEqual(['code', 'level', 'model', 'ts'])
      expect(payload.model).toBe('deepseek-chat')
      expect(line).not.toContain('sk-live')
      expect(line).not.toContain('tok-secret')
      expect(line).not.toContain('Bearer leaked')
      expect(line).not.toContain('session=leaked')
    } finally {
      captured.restore()
    }
  })
})
