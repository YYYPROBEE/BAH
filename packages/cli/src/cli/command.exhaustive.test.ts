import { describe, expect, it, vi } from 'vitest'

vi.mock('./command.ts', () => ({
  parseCommand: () => ({ kind: 'bogus' }),
}))

import { runCli } from './run.ts'

describe('Command 联合穷尽性', () => {
  it('未知 kind 走 assertNever，抛 unreachable-branch', async () => {
    const io = { out: () => undefined, err: () => undefined }
    await expect(runCli(['x'], io)).rejects.toMatchObject({ code: 'unreachable-branch' })
  })
})
