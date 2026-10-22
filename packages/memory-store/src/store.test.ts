/**
 * M1 存储与读取最小链路（T1.1–T1.7）。
 *
 * 每个用例都用 `:memory:` + 固定时钟：记忆层的 bug 大多与"时间"和"残留状态"有关，
 * 不控住这两样，测试会变成掷骰子。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createMemoryLayer } from './layer.ts'
import { createMemoryStore } from './store/index.ts'

import type { MemoryLayer } from './layer.ts'

const FIXED_NOW = Date.parse('2026-10-22T10:00:00.000Z')
const TENANT = 't-bank'
const USER = 'u-001'

let layer: MemoryLayer | undefined

function makeLayer(now: number = FIXED_NOW): MemoryLayer {
  layer = createMemoryLayer({ dbPath: ':memory:', now: () => now })
  return layer
}

afterEach(() => {
  layer?.close()
  layer = undefined
})

function baseIngest(text: string, scene: 'transfer' | 'card' | 'investment' | 'bills' = 'transfer') {
  return {
    tenant: TENANT,
    user_id: USER,
    session_id: 's-1',
    turn_id: 1,
    scene,
    speaker: 'user' as const,
    text,
  }
}

describe('M1 · 存储与检索', () => {
  it('T1.1 即写即查：ingest 后 retrieve 立即命中', async () => {
    const app = makeLayer()
    const write = await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡'))
    expect(write.written).toBe(1)

    const read = await app.retrieveMemory(async () => null, {
      tenant: TENANT,
      user_id: USER,
      session_id: 's-2',
      scene: 'transfer',
    })

    expect(read.memories).toHaveLength(1)
    expect(read.memories[0]?.renderedText).toContain('8888')
    expect(read.logLine.injected).toHaveLength(1)
  })

  it('T1.2 supersede：旧行物理保留、标记为 superseded（FM-8）', async () => {
    const app = makeLayer()
    await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡'))
    const second = await app.ingestTurn(baseIngest('以后转账都用尾号6666的卡'))

    expect(second.written).toBe(1)
    expect(second.superseded).toHaveLength(1)

    const rows = app.store.listUnits(TENANT, USER)
    expect(rows).toHaveLength(2)
    const oldRow = rows.find((row) => row.unitId === second.superseded[0])
    expect(oldRow?.state).toBe('superseded')
    expect(oldRow?.supersededBy).toBe(rows.find((row) => row.state === 'active')?.unitId)
    // 物理保留：行还在，血统可追。
    expect(oldRow).toBeDefined()
  })

  it('T1.3 幂等跳过：同内容二次 ingest = IDEMPOTENT_SKIP', async () => {
    const app = makeLayer()
    await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡'))
    const again = await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡'))

    expect(again.written).toBe(0)
    expect(again.rejected.map((item) => item.code)).toContain('IDEMPOTENT_SKIP')
    expect(app.store.listUnits(TENANT, USER)).toHaveLength(1)
  })

  it('T1.4 复位幂等：reset 连跑两次状态一致', async () => {
    const app = makeLayer()
    await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡'))

    app.resetSandbox()
    const first = app.store.listUnits(TENANT, USER).length
    app.resetSandbox()
    const second = app.store.listUnits(TENANT, USER).length

    expect(first).toBe(0)
    expect(second).toBe(first)
    // retention_basis 重灌种子：6 条谓词一条不少（漏灌会让 G2 依据门误拒全部写入）。
    expect(app.store.listBasis()).toHaveLength(6)
    expect(app.store.listBasis().map((row) => row.predicate)).toContain('preferred_card_for')
  })

  it('T1.5 unknown scene fail-closed：不检索 + 结果码（ATK-02）', async () => {
    const app = makeLayer()
    await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡'))

    const read = await app.retrieveMemory(async () => null, {
      tenant: TENANT,
      user_id: USER,
      session_id: 's-2',
      scene: 'unknown',
    })

    expect(read.routeCode).toBe('EMPTY_UNKNOWN_SCENE')
    expect(read.memories).toHaveLength(0)
    // 关键：连"查过但没命中"都不该发生——retrieved 为空证明确实没查。
    expect(read.logLine.retrieved).toHaveLength(0)
  })

  it('T1.6 valid_to 过滤：过期行不召回且给出原因（FM-7）', async () => {
    const app = makeLayer()
    app.store.writeUnit(
      {
        unitId: 'mu_expired',
        tenant: TENANT,
        userId: USER,
        unitType: 'preference',
        sceneTags: ['transfer'],
        sensitivity: 1,
        state: 'active',
        subject: 'user',
        predicate: 'preferred_card_for',
        object: { card_last4: '1111' },
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: '2026-02-01T00:00:00.000Z',
        supersededBy: null,
        sourceType: 'user_statement',
        confidence: 0.9,
        provenance: {
          session_id: 's-0',
          turn_id: 1,
          pipeline: { extractor: 'rules@v1', pattern: 'P1' },
        },
        contentHash: 'hash-expired',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastVerifiedAt: null,
      },
      [],
    )

    const read = await app.retrieveMemory(async () => null, {
      tenant: TENANT,
      user_id: USER,
      session_id: 's-2',
      scene: 'transfer',
    })

    expect(read.memories).toHaveLength(0)
    expect(read.logLine.filteredOut).toEqual([{ unitId: 'mu_expired', reason: 'valid_to' }])
  })

  it('T1.7 场景白名单：investment 不召回 transfer 行（ATK-01）', async () => {
    const app = makeLayer()
    await app.ingestTurn(baseIngest('以后转账都用尾号8888的卡', 'transfer'))

    const read = await app.retrieveMemory(async () => null, {
      tenant: TENANT,
      user_id: USER,
      session_id: 's-2',
      scene: 'investment',
    })

    expect(read.memories).toHaveLength(0)
    expect(read.logLine.filteredOut[0]?.reason).toBe('scene')
  })

  it('同一库文件重复打开走「版本相等」分支，不重跑 v0', () => {
    // 必须用**文件**库：`:memory:` 每次都是全新空库，永远走 applyV0，测不到这条分支。
    const dir = mkdtempSync(join(tmpdir(), 'bah-memory-'))
    const dbPath = join(dir, 'memory.sqlite')
    try {
      const first = createMemoryStore({ dbPath, now: () => FIXED_NOW })
      first.close()
      const again = createMemoryStore({ dbPath, now: () => FIXED_NOW })
      expect(again.listBasis()).toHaveLength(6)
      expect(again.listUnits(TENANT, USER)).toHaveLength(0)
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
