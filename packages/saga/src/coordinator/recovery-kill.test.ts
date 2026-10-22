/**
 * T-SA08-007：真实子进程 SIGKILL 后，以同一 sqlite + audit 目录恢复。
 *
 * 断言：EXECUTED 步零重发；CALLING → probe；PLANNED → reissue；链仍可验。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createContext } from '@bah/core'
import { createSagaAudit, createSagaStore } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { installIdempotency } from '../idempotency/index.ts'
import { recoverAll } from '../recovery/index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from '../seams.ts'
import { parseSagaSettings } from '../settings.ts'
import { runSaga } from './index.ts'

const cleanup: string[] = []
const stores: Array<{ close(): void }> = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const store of stores.splice(0)) store.close()
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const childScript = fileURLToPath(new URL('./fixtures/kill-child.ts', import.meta.url))
const settings = parseSagaSettings({})

interface Message {
  readonly kind: 'executed' | 'calling'
  readonly stepId: string
}

/** 等子进程发出 `calling`（超时 fail-loud）。 */
function waitForCalling(child: ChildProcess, messages: Message[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('kill-child 未在 20s 内进入 CALLING')), 20_000)
    child.on('message', (raw: unknown) => {
      const message = raw as Message
      messages.push(message)
      if (message.kind === 'calling') {
        clearTimeout(timer)
        resolve()
      }
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`kill-child 提前退出：code=${String(code)} signal=${String(signal)}`))
    })
  })
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    child.on('exit', () => resolve())
  })
}

describe('T-SA08-007 崩溃恢复', () => {
  it('SIGKILL 后重启：EXECUTED 不重发，CALLING→probe，PLANNED→reissue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-kill-'))
    cleanup.push(root)
    const dbPath = join(root, 'saga.sqlite')
    const auditRoot = join(root, 'audit')

    const child = spawn(process.execPath, ['--import', 'tsx', childScript, dbPath, auditRoot], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    children.push(child)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    const messages: Message[] = []
    await waitForCalling(child, messages)
    child.kill('SIGKILL')
    await waitForExit(child)

    expect(stderr).not.toMatch(/uncaught|Error:/i)
    expect(messages.filter((message) => message.stepId === 'k1' && message.kind === 'executed')).toHaveLength(1)

    // 重启：同一 sqlite + 同一 audit 目录。
    const store = createSagaStore({ dbPath })
    stores.push(store)
    const ctx = createContext()
    ctx.provide(SAGA_STORE, store)
    ctx.provide(SAGA_CLOCK, { now: () => Date.now(), sleep: async () => undefined })
    installIdempotency(ctx)
    const audit = createSagaAudit({ ctx, now: () => Date.now(), rootDir: auditRoot, fsync: false })
    ctx.provide(SAGA_AUDIT, audit)

    const steps = store.listSteps('kill-saga')
    expect(steps.find((step) => step.stepId === 'k1')?.state).toBe('EXECUTED')
    expect(steps.find((step) => step.stepId === 'k2')?.state).toBe('CALLING')
    expect(steps.find((step) => step.stepId === 'k3')?.state).toBe('PLANNED')

    const report = recoverAll(ctx, settings)
    expect(report.dispatched['skip-executed']).toBe(1)
    expect(report.dispatched.probe).toBe(1)
    expect(report.dispatched.reissue).toBe(1)
    expect(audit.verify('kill-saga')).toEqual({ ok: true })

    const calls: string[] = []
    await runSaga(ctx, 'kill-saga', {
      settings,
      dispatch: async (step) => {
        calls.push(step.stepId)
        return { kind: 'ok', responseDigest: `resp-${step.stepId}` }
      },
    })
    expect(calls).toEqual([])
    expect(store.listSteps('kill-saga').find((step) => step.stepId === 'k1')?.state).toBe('EXECUTED')
  })
})
