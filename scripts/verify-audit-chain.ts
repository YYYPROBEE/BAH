/**
 * 门禁：审计证据链全量自检（SA-16 §5 / SA-11 §0 第 8 条）。
 *
 * 三类断言一次跑完：
 * 1. 全量事件流 `prevHash` 连续；
 * 2. 白名单事件全部有 Ed25519 签名且验签通过；
 * 3. 真实写路径（plan → run）产生的链，投影重算 `diff=0`。
 *
 * 自检使用临时目录与临时密钥，不触碰仓库 `sessions/`；跑完清理。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { isMainModule, runStandalone, type Gate } from './gate-lib.ts'

interface PersistenceModule {
  readonly SIGNED_TYPES: readonly string[]
  readonly ChainFile: new (options: { rootDir: string; fsync: boolean }) => {
    read(sagaId: string): readonly { readonly t: string; readonly sig?: string }[]
  }
  readonly createSagaAudit: (options: Record<string, unknown>) => {
    append(sagaId: string, type: string, data: unknown): { seqInSaga: number; recordHash: string }
    verify(sagaId?: string): { ok: boolean; brokenAt?: number }
  }
  readonly createSagaStore: (options: { dbPath: string }) => {
    tx<T>(fn: (tx: unknown) => T): T
    close(): void
  }
  readonly projectionDiff: (
    ctx: unknown,
    chain: unknown,
    sagaId: string,
    reduce: unknown,
  ) => number
}

interface SagaModule {
  readonly SAGA_EVENT_KEYS: readonly string[]
  readonly SAGA_STORE: { readonly id: string }
  readonly SAGA_CLOCK: { readonly id: string }
  readonly SAGA_AUDIT: { readonly id: string }
  readonly makeKey: (namespace: string, sagaId: string, localId: string, nonce: string) => string
  readonly makeNonce: () => string
  readonly installIdempotency: (ctx: unknown) => void
  readonly parseSagaSettings: (config: Record<string, unknown>) => unknown
  readonly planSaga: (ctx: unknown, plan: unknown, settings: unknown) => void
  readonly runSaga: (
    ctx: unknown,
    sagaId: string,
    deps: { settings: unknown; dispatch: (step: { stepId: string }) => Promise<unknown> },
  ) => Promise<void>
  readonly reduceSaga: unknown
}

interface CoreModule {
  readonly createContext: () => {
    provide(key: { id: string }, value: unknown): void
    get<T>(key: { id: string }): T
  }
}

const gate: Gate = {
  name: 'audit-chain',

  async run(root) {
    const persistence = (await import(
      pathToFileURL(join(root, 'packages', 'persistence', 'src', 'index.ts')).href
    )) as PersistenceModule
    const saga = (await import(pathToFileURL(join(root, 'packages', 'saga', 'src', 'index.ts')).href)) as SagaModule
    const core = (await import(pathToFileURL(join(root, 'packages', 'core', 'src', 'index.ts')).href)) as CoreModule

    const dir = mkdtempSync(join(tmpdir(), 'bah-gate-audit-'))
    const findings: string[] = []
    const notes: string[] = []
    let store: ReturnType<PersistenceModule['createSagaStore']> | undefined
    try {
      const { privateKey } = generateKeyPairSync('ed25519')
      const signingKeyPath = join(dir, 'saga-ed25519.pem')
      writeFileSync(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
      const auditRoot = join(dir, 'audit')
      const now = (): number => Date.UTC(2026, 9, 18, 2, 0, 0)

      const audit = persistence.createSagaAudit({
        now,
        rootDir: auditRoot,
        signingKeyPath,
        signedTypes: [...persistence.SIGNED_TYPES],
        fsync: false,
      })

      // ① 全量事件键连续入链。
      for (const type of saga.SAGA_EVENT_KEYS) {
        audit.append('gate-events', type, { sagaId: 'gate-events' })
      }
      const chainVerify = audit.verify('gate-events')
      if (!chainVerify.ok) findings.push(`全量事件链断裂：brokenAt=${String(chainVerify.brokenAt)}`)

      // ② 白名单事件必须全部带签名。
      const rows = new persistence.ChainFile({ rootDir: auditRoot, fsync: false }).read('gate-events')
      const signedWhitelist = persistence.SIGNED_TYPES.filter((type) => type.startsWith('saga/'))
      for (const type of signedWhitelist) {
        const row = rows.find((candidate) => candidate.t === type)
        if (row === undefined) findings.push(`白名单事件未入链：${type}`)
        else if (row.sig === undefined) findings.push(`白名单事件缺签名：${type}`)
      }
      notes.push(`链事件 ${rows.length} 条，白名单 saga 事件 ${signedWhitelist.length} 类`)

      // ③ 真实写路径 → 投影 diff=0。
      store = persistence.createSagaStore({ dbPath: ':memory:' })
      const ctx = core.createContext()
      ctx.provide(saga.SAGA_STORE as never, store)
      ctx.provide(saga.SAGA_CLOCK as never, { now, sleep: async () => undefined })
      const writeAudit = persistence.createSagaAudit({
        ctx,
        now,
        rootDir: auditRoot,
        signingKeyPath,
        signedTypes: [...persistence.SIGNED_TYPES],
        fsync: false,
      })
      ctx.provide(saga.SAGA_AUDIT as never, writeAudit)
      saga.installIdempotency(ctx)

      const settings = saga.parseSagaSettings({})
      const nonce = saga.makeNonce()
      saga.planSaga(
        ctx,
        {
          sagaId: 'gate-saga',
          businessType: 'TRANSFER',
          traceId: 'trace-gate',
          timeoutBudgetMs: 60_000,
          initiator: 'gate',
          steps: [
            {
              stepId: 'gate-step',
              seqNo: 1,
              toolName: 'pay',
              endpoint: '/pay',
              sideEffectClass: 'REVERSIBLE',
              idemKey: saga.makeKey('FWD', 'gate-saga', 'gate-step', nonce),
              nonce,
              topologyDeps: [],
              deadlineMs: 10_000,
            },
          ],
        },
        settings,
      )
      await saga.runSaga(ctx, 'gate-saga', {
        settings,
        dispatch: async () => ({ kind: 'ok', responseDigest: 'gate-resp' }),
      })

      const chain = new persistence.ChainFile({ rootDir: auditRoot, fsync: false })
      const diff = persistence.projectionDiff(ctx, chain, 'gate-saga', saga.reduceSaga)
      if (diff !== 0) findings.push(`投影 diff≠0：${diff}`)
      const writeVerify = writeAudit.verify('gate-saga')
      if (!writeVerify.ok) findings.push(`写路径链断裂：brokenAt=${String(writeVerify.brokenAt)}`)
      notes.push('真实写路径：plan → run → 链校验 + 投影 diff=0')

      store.close()
      store = undefined
    } catch (error) {
      findings.push(`门禁执行失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      try {
        store?.close()
      } catch {
        // 已关闭或无连接。
      }
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Windows 偶发 EBUSY：临时目录由系统回收，不影响门禁结论。
      }
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
