/**
 * `bah audit replay` 参数面与退出码：只读重放不启动 Agent，参数错误必须是退出码 2。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { JsonlPersistence } from '@bah/persistence'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import { parseAuditReplayArgs, runAuditReplay } from './audit-replay.ts'
import type { CliIo } from './run.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-replay-cli-'))
  cleanup.push(dir)
  return dir
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}

async function run(
  dir: string,
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const captured = capture()
  const code = await runAuditReplay(args, captured.io, { root: dir })
  return { code, out: captured.out.join('\n'), err: captured.err.join('\n') }
}

/** 在 `<root>/sessions/s-1/` 写一个只有一条 user/message 的合法会话。 */
function writeSession(dir: string): void {
  const handle = new JsonlPersistence({ fsync: false, redact: false, warn: () => undefined }).create(
    join(dir, 'sessions', 's-1'),
    asSessionId('s-1'),
    { now: 1 },
  )
  handle.append({ seq: 1, at: 1, formatVersion: 1, type: 'user/message', data: { content: '你好' } })
  void handle.flush()
}

describe('bah audit replay · 参数解析', () => {
  it('支持空格分隔与 = 内联两种写法，缺省值稳定', () => {
    expect(parseAuditReplayArgs(['--session', 's-1', '--dir', 'logs'])).toEqual({
      ok: true,
      args: { session: 's-1', dir: 'logs', format: 'text', help: false },
    })
    expect(parseAuditReplayArgs(['--session=s-1', '--format=json', '--key=k.pem'])).toEqual({
      ok: true,
      args: { session: 's-1', dir: 'sessions', key: 'k.pem', format: 'json', help: false },
    })
    expect(parseAuditReplayArgs(['--verify'])).toMatchObject({
      ok: true,
      args: { dir: 'sessions', format: 'text' },
    })
  })

  it('非法参数 / 缺值 / 越界 format 都返回结构化错误', () => {
    expect(parseAuditReplayArgs(['--nope'])).toEqual({ ok: false, error: '未知参数 --nope' })
    expect(parseAuditReplayArgs(['--session'])).toEqual({ ok: false, error: '--session 需要一个值' })
    expect(parseAuditReplayArgs(['--dir='])).toEqual({ ok: false, error: '--dir 需要一个值' })
    expect(parseAuditReplayArgs(['--format', 'yaml'])).toEqual({
      ok: false,
      error: '--format 只接受 text | json',
    })
  })
})

describe('bah audit replay · 执行与退出码', () => {
  it('help 或无 --session：打印用法；help 退 0，漏 session 退 2', async () => {
    const dir = root()
    const help = await run(dir, ['--help'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('bah audit replay')

    const missing = await run(dir, [])
    expect(missing.code).toBe(2)
    expect(missing.out).toContain('--session')
  })

  it('参数错误 → 退出码 2，错误走 stderr', async () => {
    const result = await run(root(), ['--bogus'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('未知参数 --bogus')
  })

  it('会话不存在 → 退出码 1，并打印 diff', async () => {
    const result = await run(root(), ['--session', 'ghost'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('✘ replay session=ghost')
    expect(result.err).toContain('session-missing')
  })

  it('合法会话：text 与 json 两种输出都返回 0', async () => {
    const dir = root()
    writeSession(dir)

    const text = await run(dir, ['--session', 's-1'])
    expect(text.code).toBe(0)
    expect(text.out).toContain('events=1')
    expect(text.out).toContain('seq=ok')

    const json = await run(dir, ['--session=s-1', '--format=json', '--dir=sessions'])
    expect(json.code).toBe(0)
    const parsed = JSON.parse(json.out) as { ok: boolean; events: unknown[]; sessionId: string }
    expect(parsed.sessionId).toBe('s-1')
    expect(parsed.ok).toBe(true)
    expect(parsed.events).toHaveLength(1)
  })
})
