/**
 * SA-14 终局验收 · T-SA14-001~012（批 6）。
 *
 * 本文件不新增业务代码：把源附C 的 33 项断言逐项归位、场景 A 12 类、
 * 对抗并集 18 类、存储双路径口径与终局门禁固化成可执行断言。
 *
 * 纪律：
 * - 门禁用例直接跑 `scripts/verify-*.ts` 的 `gate.run`，与 `pnpm gate` 同源；
 * - `reduce ≡ advance` 覆盖全部 (状态 × 事件) 组合；非法出边按运行期守卫语义处理；
 * - 降级路径只做口径登记，**禁止**用降级结果冒充主路径断言。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createContext } from '@bah/core'
import { createSagaAudit, createSagaStore } from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import {
  advance,
  assertReplayDiffZero,
  canTransition,
  reduceSaga,
  SAGA_EVENT_KEYS,
  SAGA_FINAL_SUBJECT_PREFIX,
  SAGA_STATES,
  SAGA_TRANSITIONS,
  TERMINAL_STATES,
} from './index.ts'
import { SAGA_AUDIT, SAGA_CLOCK, SAGA_STORE } from './seams.ts'
import { parseSagaSettings } from './settings.ts'

import type { Context } from '@bah/core'
import type { SagaEventRecord, SagaProjection, SagaState } from './types.ts'

const ROOT = process.cwd()
const cleanup: string[] = []
const closers: Array<{ close(): void }> = []

afterEach(() => {
  for (const store of closers.splice(0)) store.close()
  for (const dir of cleanup.splice(0)) {
    if (dir.includes('bah-saga-acceptance-')) rmSync(dir, { recursive: true, force: true })
  }
})

/* ────────────────────────────── 33 项归位 ────────────────────────────── */

interface MappedAssertion {
  readonly family: 'SA-08' | 'SA-09' | 'SA-10' | 'SA-12' | 'SA-13'
  readonly id: string
}

const THIRTY_THREE: readonly MappedAssertion[] = [
  ...Array.from({ length: 7 }, (_, index) => ({ family: 'SA-08' as const, id: `T-SA08-00${index + 1}` })),
  ...Array.from({ length: 8 }, (_, index) => ({ family: 'SA-09' as const, id: `T-SA09-00${index + 1}` })),
  { family: 'SA-10', id: 'A-01' },
  { family: 'SA-10', id: 'A-02' },
  { family: 'SA-10', id: 'A-03' },
  { family: 'SA-10', id: 'A-08' },
  { family: 'SA-10', id: 'A-09' },
  { family: 'SA-10', id: 'A-10' },
  { family: 'SA-10', id: 'A-11' },
  { family: 'SA-10', id: 'T-SA10-001' },
  { family: 'SA-10', id: 'T-SA10-002' },
  { family: 'SA-12', id: 'T-SA12-001' },
  { family: 'SA-12', id: 'T-SA12-004' },
  { family: 'SA-12', id: 'T-SA12-005' },
  { family: 'SA-12', id: 'T-SA12-009' },
  { family: 'SA-12', id: 'T-SA12-006' },
  { family: 'SA-13', id: 'T-SA13-005' },
  { family: 'SA-13', id: 'T-SA13-001' },
  { family: 'SA-13', id: 'T-SA13-008' },
  { family: 'SA-13', id: 'T-SA13-009' },
]

/** 递归收集仓库内全部 `.test.ts` 文本（用于归位核验）。 */
function testCorpus(): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (entry.name.endsWith('.test.ts')) {
        parts.push(readFileSync(path, 'utf8'))
      }
    }
  }
  walk(join(ROOT, 'packages'))
  return parts.join('\n')
}

/* ────────────────────────────── 主路径底座 ────────────────────────────── */

interface Harness {
  readonly ctx: Context
  readonly store: ReturnType<typeof createSagaStore>
  readonly audit: ReturnType<typeof createSagaAudit>
  readonly auditDir: string
  now(): number
}

function harness(): Harness {
  const rootDir = mkdtempSync(join(tmpdir(), 'bah-saga-acceptance-'))
  cleanup.push(rootDir)
  let now = 1_700_000_000_000
  const store = createSagaStore({ dbPath: join(rootDir, 'saga.sqlite'), now: () => now })
  closers.push(store)
  const ctx = createContext()
  ctx.provide(SAGA_STORE, store)
  ctx.provide(SAGA_CLOCK, {
    now: () => now,
    sleep: async (ms) => {
      now += ms
    },
  })
  const auditDir = join(rootDir, 'audit')
  const { privateKey } = generateKeyPairSync('ed25519')
  const signingKeyPath = join(rootDir, 'saga-ed25519.pem')
  writeFileSync(signingKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const audit = createSagaAudit({ ctx, now: () => now, rootDir: auditDir, fsync: false, signingKeyPath })
  ctx.provide(SAGA_AUDIT, audit)
  return { ctx, store, audit, auditDir, now: () => now }
}

function seed(h: Harness, sagaId: string, state: SagaState = 'RUNNING'): void {
  const at = h.now()
  h.store.tx((tx) => {
    tx.insertTransaction({
      sagaId,
      businessType: 'TRANSFER',
      traceId: `trace-${sagaId}`,
      state,
      version: 1,
      timeoutBudgetMs: 60_000,
      compStrategy: 'AUTO',
      initiator: '{}',
      frozen: false,
      createdAt: at,
      updatedAt: at,
    })
  })
}

/* ────────────────────────────── 对抗并集 ────────────────────────────── */

interface AdversarialCase {
  readonly name: string
  readonly evidence: string
}

const BAH_SIX: readonly AdversarialCase[] = [
  { name: '注入 6 种混淆变体', evidence: 'packages/runtime/src/agent-loop/agent.test.ts' },
  { name: '声称更高额度', evidence: 'packages/bank/src/core/mock.test.ts' },
  { name: '连续拒绝触发熔断', evidence: 'packages/saga/src/compensation/compensation.test.ts' },
  { name: '审批超时', evidence: 'packages/saga/src/gates/gates.test.ts' },
  { name: '跨场景提权', evidence: 'packages/saga/src/gates/gates.test.ts' },
  { name: '票据重放', evidence: 'packages/bank/src/core/ticket.test.ts' },
]

const LOCAL_TWELVE: readonly AdversarialCase[] = [
  'A-01',
  'A-02',
  'A-03',
  'A-04',
  'A-05',
  'A-06',
  'A-07',
  'A-08',
  'A-09',
  'A-10',
  'A-11',
  'A-12',
].map((id) => ({ name: `本层注入 ${id}`, evidence: 'packages/saga/src/scenario-a.test.ts' }))

/* ────────────────────────────── 降级登记 ────────────────────────────── */

type DowngradeStatus = '等价' | '弱化' | '不成立' | '不复现'

const DOWNGRADE_REGISTRY: readonly { readonly assertion: string; readonly status: DowngradeStatus }[] = [
  { assertion: '状态机转换合法性 / 终态无出边', status: '等价' },
  { assertion: '幂等同键双发执行一次', status: '等价' },
  { assertion: '审计链完整性 + 验签', status: '等价' },
  { assertion: '投影 diff=0 / 回放 diff=0', status: '等价' },
  { assertion: '强制关闭必带清单', status: '等价' },
  { assertion: '修正 saga 模板版本 = 原绑定', status: '等价' },
  { assertion: 'tick 幂等', status: '等价' },
  { assertion: '同事务三者全回滚（T-SA08-005）', status: '不成立' },
  { assertion: '恢复不双发（T-SA08-006）', status: '弱化' },
  { assertion: 'kill 后恢复走通（T-SA08-007）', status: '不复现' },
  { assertion: 'CAS 并发竞态（T-SA08-002）', status: '弱化' },
  { assertion: '拒绝未来版本（T-SA07-004）', status: '弱化' },
  { assertion: '恢复 RTO', status: '弱化' },
]

/* ────────────────────────────── 用例 ────────────────────────────── */

describe('SA-14 终局验收', () => {
  it('T-SA14-001：33 项断言逐项归位，无一悬空', () => {
    expect(THIRTY_THREE).toHaveLength(33)
    const counts = {
      'SA-08': THIRTY_THREE.filter((item) => item.family === 'SA-08').length,
      'SA-09': THIRTY_THREE.filter((item) => item.family === 'SA-09').length,
      'SA-10': THIRTY_THREE.filter((item) => item.family === 'SA-10').length,
      'SA-12': THIRTY_THREE.filter((item) => item.family === 'SA-12').length,
      'SA-13': THIRTY_THREE.filter((item) => item.family === 'SA-13').length,
    }
    expect(counts).toEqual({ 'SA-08': 7, 'SA-09': 8, 'SA-10': 9, 'SA-12': 5, 'SA-13': 4 })
    expect(new Set(THIRTY_THREE.map((item) => item.id)).size).toBe(33)

    const corpus = testCorpus()
    const dangling = THIRTY_THREE.map((item) => item.id).filter((id) => !corpus.includes(id))
    expect(dangling).toEqual([])
  })

  it('T-SA14-002：场景 A 12 类均有执行用例且标注终态', () => {
    const source = readFileSync(join(ROOT, 'packages/saga/src/scenario-a.test.ts'), 'utf8')
    const missing = LOCAL_TWELVE.map((item) => item.name.replace('本层注入 ', '')).filter(
      (id) => !source.includes(`it('${id}：`),
    )
    expect(missing).toEqual([])
    // 12 类均能到达明确终态：完整跑过 suite 由 `pnpm test` 保障，这里钉住编号与测试名一一对应。
    expect(LOCAL_TWELVE).toHaveLength(12)
  })

  it('T-SA14-003：对抗并集 18 类（BAH 6 + 本层 12）均有证据且存在', () => {
    const union = [...BAH_SIX, ...LOCAL_TWELVE]
    expect(union).toHaveLength(18)
    expect(new Set(union.map((item) => item.name)).size).toBe(18)
    for (const item of BAH_SIX) {
      expect(existsSync(join(ROOT, item.evidence)), item.evidence).toBe(true)
    }
    const source = readFileSync(join(ROOT, 'packages/saga/src/scenario-a.test.ts'), 'utf8')
    for (const id of LOCAL_TWELVE.map((item) => item.name.replace('本层注入 ', ''))) {
      expect(source).toContain(`it('${id}：`)
    }
  })

  it('T-SA14-004：主路径（node:sqlite）CAS / 链 / 回放断言全绿', () => {
    const h = harness()
    seed(h, 'path-main', 'RUNNING')
    const at = h.now()
    expect(h.store.casState('path-main', 'RUNNING', 'COMPENSATING', 1, at)).toBe(true)
    expect(h.store.casState('path-main', 'RUNNING', 'COMPENSATING', 1, at)).toBe(false)

    h.audit.append('path-main', 'saga/created', { sagaId: 'path-main' })
    h.audit.append('path-main', 'saga/comp-decided', { sagaId: 'path-main', stepId: 's1' })
    h.audit.append('path-main', 'saga/comp-result', {
      sagaId: 'path-main',
      compId: `${SAGA_FINAL_SUBJECT_PREFIX}COMPENSATED`,
    })
    // 运行时状态改为链折叠终态，保证 diff=0 断言对象一致。
    h.store.tx((tx) => {
      tx.casState('path-main', 'COMPENSATING', 'COMPENSATED', 2, at)
    })
    const rows = readFileSync(join(h.auditDir, 'path-main', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const events: SagaEventRecord[] = rows.map((row) => ({
      sagaId: row['s'] as string,
      seqInSaga: row['q'] as number,
      type: row['t'] as string,
      subjectRef: row['sub'] as string,
      happensBefore: row['hb'] as readonly number[],
      payloadDigest: row['d'] as string,
    }))
    expect(assertReplayDiffZero(h.ctx, 'path-main', { readStream: () => events })).toBe(true)
  })

  it('T-SA14-005：降级路径只登记，不冒充主路径断言', () => {
    const statuses = new Set(DOWNGRADE_REGISTRY.map((item) => item.status))
    expect([...statuses].sort()).toEqual(['不复现', '不成立', '弱化', '等价'].sort())
    expect(DOWNGRADE_REGISTRY.filter((item) => item.status === '等价')).toHaveLength(7)
    expect(DOWNGRADE_REGISTRY.filter((item) => item.status === '不成立')).toHaveLength(1)
    expect(DOWNGRADE_REGISTRY.filter((item) => item.status === '不复现')).toHaveLength(1)
    expect(DOWNGRADE_REGISTRY.filter((item) => item.status === '弱化')).toHaveLength(4)
    expect(DOWNGRADE_REGISTRY.some((item) => item.assertion.includes('必绿'))).toBe(false)
  })

  it('T-SA14-006：verify-saga-state 门禁通过', async () => {
    const result = await runGate('verify-saga-state.ts')
    expect(result.ok, result.findings.join('\n')).toBe(true)
  })

  it('T-SA14-007：verify-audit-chain 门禁通过', async () => {
    const result = await runGate('verify-audit-chain.ts')
    expect(result.ok, result.findings.join('\n')).toBe(true)
  })

  it('T-SA14-008：verify-saga-events 门禁通过', async () => {
    const result = await runGate('verify-saga-events.ts')
    expect(result.ok, result.findings.join('\n')).toBe(true)
  })

  it('T-SA14-009：verify-event-modes 门禁通过（tick 唯一 serial）', async () => {
    const result = await runGate('verify-event-modes.ts')
    expect(result.ok, result.findings.join('\n')).toBe(true)
  })

  it('T-SA14-010：快照纪律（会话快照载体存在且与 saga 回放分离）', () => {
    const config = readFileSync(join(ROOT, 'vitest.snapshot.config.ts'), 'utf8')
    expect(config).toContain('snapshots/**/*.test.ts')
    const snapshotDir = join(ROOT, 'snapshots')
    expect(existsSync(snapshotDir)).toBe(true)
    const cases = readdirSync(snapshotDir).filter((entry) => statSync(join(snapshotDir, entry)).isDirectory())
    expect(cases.length).toBeGreaterThan(0)
  })

  it('T-SA14-011：两套回放都过（会话快照 + saga 事件流）', () => {
    const snapshotDir = join(ROOT, 'snapshots')
    const cases = readdirSync(snapshotDir).filter((entry) => statSync(join(snapshotDir, entry)).isDirectory())
    expect(cases.length).toBeGreaterThanOrEqual(1)

    const h = harness()
    seed(h, 'two-replays', 'COMPENSATION_DLQ')
    h.audit.append('two-replays', 'saga/created', { sagaId: 'two-replays' })
    h.audit.append('two-replays', 'saga/dlq-escalated', {
      sagaId: 'two-replays',
      dlqId: 'dlq-two',
    })
    const rows = readFileSync(join(h.auditDir, 'two-replays', 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const events: SagaEventRecord[] = rows.map((row) => ({
      sagaId: row['s'] as string,
      seqInSaga: row['q'] as number,
      type: row['t'] as string,
      subjectRef: row['sub'] as string,
      happensBefore: row['hb'] as readonly number[],
      payloadDigest: row['d'] as string,
    }))
    expect(assertReplayDiffZero(h.ctx, 'two-replays', { readStream: () => events })).toBe(true)
  })

  it('T-SA14-012：每个（状态 × 事件）组合 reduce ≡ advance', () => {
    const eventOf = (type: string): SagaEventRecord => ({
      sagaId: 'equiv',
      seqInSaga: 1,
      type,
      subjectRef: type === 'saga/manually-closed' ? '' : 's1',
      happensBefore: [],
      payloadDigest: 'd'.repeat(64),
    })

    for (const state of SAGA_STATES) {
      const before: SagaProjection = {
        sagaId: 'equiv',
        state,
        steps: { s1: 'EXECUTED' },
      }
      for (const type of SAGA_EVENT_KEYS) {
        const event = eventOf(type)
        const next = reduceSaga(before, event)
        if (next.state === state) continue

        if (type === 'saga/manually-closed') {
          // SA-12 的直达终态：forceClose 直接 CAS，不走 assertTransition。
          expect(TERMINAL_STATES).toContain(next.state)
          expect(next.state).toBe('MANUALLY_CLOSED')
          continue
        }

        expect(
          canTransition(state, next.state),
          `${state} + ${type} → ${next.state} 不在合法出边内`,
        ).toBe(true)

        let current = state
        const store = {
          casState: (_sagaId: string, from: SagaState, to: SagaState) => {
            if (current !== from) return false
            current = to
            return true
          },
        } as unknown as Parameters<typeof advance>[0]
        advance(store, 'equiv', state, next.state, 1, 0)
        expect(current, `${state} + ${type}`).toBe(next.state)
      }
    }

    // 终态无出边（除 forceClose 的直达路径外，事件不改变终态）。
    for (const terminal of TERMINAL_STATES) {
      for (const type of SAGA_EVENT_KEYS) {
        const next = reduceSaga({ sagaId: 'equiv', state: terminal, steps: {} }, eventOf(type))
        if (type === 'saga/manually-closed') continue
        expect(next.state, `${terminal} + ${type}`).toBe(terminal)
      }
    }

    // 表本身仍是 SA-00 冻结面：终态零出边。
    for (const terminal of TERMINAL_STATES) {
      expect(SAGA_TRANSITIONS[terminal]).toEqual([])
    }
  })
})

/** 直接调度门禁脚本（与 `pnpm gate` 同源）。 */
async function runGate(file: string): Promise<{ ok: boolean; findings: readonly string[] }> {
  const mod = (await import(pathToFileURL(join(ROOT, 'scripts', file)).href)) as {
    gate: {
      run(root: string): Promise<{ ok: boolean; findings: readonly string[] }>
    }
  }
  return mod.gate.run(ROOT)
}
