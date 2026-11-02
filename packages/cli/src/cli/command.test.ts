import { describe, expect, it } from 'vitest'

import { parseCommand } from './command.ts'
import { runCli, type CliIo } from './run.ts'

interface Captured {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}

describe('parseCommand', () => {
  it('首项命中 audit → 子命令模式', () => {
    expect(parseCommand(['audit', '--dir', 'sessions'])).toEqual({ kind: 'audit' })
  })

  it('首项是 flag → 现有 flag 模式', () => {
    expect(parseCommand(['--profile', 'headless'])).toEqual({ kind: 'run' })
  })

  it('无参数 → 现有 flag 模式', () => {
    expect(parseCommand([])).toEqual({ kind: 'run' })
  })

  it('audit 出现在值位置不触发子命令', () => {
    expect(parseCommand(['--profile', 'audit'])).toEqual({ kind: 'run' })
  })
})

describe('runCli 子命令分流', () => {
  it('bah audit --help 走子命令并退出 0', async () => {
    const captured = capture()
    expect(await runCli(['audit', '--help'], captured.io)).toBe(0)
    expect(captured.out.join('\n')).toContain('bah audit')
  })
})
