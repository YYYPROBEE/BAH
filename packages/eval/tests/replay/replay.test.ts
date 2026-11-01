/**
 * W15 独立重放 / 证据包 / Merkle 证明的端到端用例。
 *
 * 用真实 `boot()` 生成一段带工具调用与审批的会话（含 `audit.jsonl` 判决链），
 * 然后**只读**重放；重放模块本身不 import host（门禁单独检查）。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, createCatalog , testRunContext } from '@bah/host'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import type { SessionId } from '@bah/core'
import { replaySession } from '@bah/persistence'
import { DEFAULT_TENANT_ID } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { buildSessionEvidencePack, verifySessionEvidencePack } from '../../src/evidence/SessionEvidencePack.ts'
import { sampleProofs, verifyMerkleProof } from '../../src/snapshot/merkle.ts'
import { SnapshotChain } from '../../src/snapshot/SnapshotChain.ts'

import type { BootOptions, ProfileSummary } from '@bah/host'
import type { Bundle, PluginRow } from '@bah/host'

const PROFILE: ProfileSummary = { name: 'fx', bundles: ['fx'], hmr: false }
const SESSION = 's-replay-w15'

function asSessionId(value: string): SessionId {
  return value as SessionId
}

const ROWS: readonly PluginRow[] = [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'core:prompt' },
  {
    id: 'core:model',
    config: {
      provider: 'mock',
      script: [
        {
          tool: {
            id: 'r-1',
            name: 'transfer_preview',
            args: { amount: 1, payee: { name: '王建国' } },
          },
        },
        {
          tool: {
            id: 'r-2',
            name: 'transfer_create',
            args: { amount: 1, payee: { name: '王建国' } },
          },
        },
        { text: '已完成' },
      ],
    },
  },
  { id: 'core:agent', config: { loop: { model: 'mock:mock-chat' } } },
  { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
  { id: 'audit:decisions' },
  { id: 'bank:tools', config: { demoUserId: 'u-1', seed: 7, datasetTier: 'demo' } },
  {
    id: 'interaction:approval',
    config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
  },
]

async function makeSession(): Promise<{
  root: string
  tenantRoot: string
  sessionDir: string
  cleanup: () => void
}> {
  const root = mkdtempSync(join(tmpdir(), 'bah-replay-'))
  const tenantRoot = join(root, DEFAULT_TENANT_ID)
  const bundle: Bundle = { name: 'fx', rows: ROWS }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ sessionId: asSessionId(SESSION), now: () => 1_700_000_000_000, jsonlDir: root }),
  }
  const app = await boot(options)
  try {
    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
    if (agent === undefined) throw new Error('没有活体 agent')
    agent.send('给王建国转 1 元')
    await agent.run()
    expect(app.ctx.get(SESSION_SERVICE).events().length).toBeGreaterThan(0)
  } finally {
    await app.dispose('test')
  }
  return {
    root,
    tenantRoot,
    sessionDir: join(tenantRoot, SESSION),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

describe('W15 · 独立重放', () => {
  it(
    'TC-W15-01 正常会话：事件/判决/票据重建，diff=0',
    async () => {
      const session = await makeSession()
      try {
        const result = replaySession({ root: session.tenantRoot, sessionId: SESSION })
        expect(result.diffs).toEqual([])
        expect(result.ok).toBe(true)
        expect(result.events.length).toBeGreaterThan(0)
        expect(result.decisions.length).toBeGreaterThan(0)
        expect(result.tickets).toHaveLength(1)
        expect(result.tickets[0]?.status).toBe('consumed')
        expect(result.chain.ok).toBe(true)
        expect(result.seqOk).toBe(true)
        // tool/call 的 args 落盘会脱敏 → 与链上原始摘要不可比，只能是 warning。
        expect(result.warnings.some((line) => line.startsWith('cross-check:tool/call'))).toBe(true)
      } finally {
        session.cleanup()
      }
    },
    60_000,
  )

  it(
    'TC-W15-02/03 篡改/删除链上一条 → chain-broken 指出序号',
    async () => {
      const session = await makeSession()
      const chainPath = join(session.sessionDir, 'audit.jsonl')
      const sessionPath = join(session.sessionDir, 'session.jsonl')
      const chainOriginal = readFileSync(chainPath, 'utf8')
      const sessionOriginal = readFileSync(sessionPath, 'utf8')
      try {
        // 篡改第 2 条的 d
        const lines = chainOriginal.split('\n').filter(Boolean)
        const second = JSON.parse(lines[1] as string) as Record<string, unknown>
        second['d'] = '0'.repeat(64)
        lines[1] = JSON.stringify(second)
        writeFileSync(chainPath, `${lines.join('\n')}\n`, 'utf8')
        const tampered = replaySession({ root: session.tenantRoot, sessionId: SESSION })
        expect(tampered.ok).toBe(false)
        expect(tampered.chain.brokenAt).toBe(2)
        expect(tampered.diffs.some((diff) => diff.startsWith('chain-broken:'))).toBe(true)

        // 删除第 2 条
        writeFileSync(chainPath, `${[lines[0], ...lines.slice(2)].join('\n')}\n`, 'utf8')
        const deleted = replaySession({ root: session.tenantRoot, sessionId: SESSION })
        expect(deleted.ok).toBe(false)
        expect(deleted.chain.brokenAt).toBe(3)

      } finally {
        writeFileSync(chainPath, chainOriginal, 'utf8')
        writeFileSync(sessionPath, sessionOriginal, 'utf8')
        session.cleanup()
      }
    },
    60_000,
  )

  it(
    'TC-W15-04 EvidencePack 三件套 + manifest；sha256 可离线复核',
    async () => {
      const session = await makeSession()
      const replay = replaySession({ root: session.tenantRoot, sessionId: SESSION })
      const packDir = join(session.root, 'evidence')
      try {
        const pack = buildSessionEvidencePack({ replay, outDir: packDir })
        expect(pack.paths).toEqual(['events.jsonl', 'decisions.md', 'tickets.md', 'manifest.json'])
        expect(verifySessionEvidencePack(packDir).ok).toBe(true)

        // 篡改 events.jsonl → sha256 不符
        const eventsPath = join(packDir, 'events.jsonl')
        const original = readFileSync(eventsPath, 'utf8')
        writeFileSync(eventsPath, `${original} `, 'utf8')
        const verified = verifySessionEvidencePack(packDir)
        expect(verified.ok).toBe(false)
        expect(verified.findings.some((line) => line.includes('sha256'))).toBe(true)
      } finally {
        session.cleanup()
      }
    },
    60_000,
  )

  it('TC-W15-05 Merkle 抽样 10% 的证明可脱离进程内状态验证', async () => {
    const values = Array.from({ length: 20 }, (_, index) => ({ seq: index, state: { balance: index } }))
    const leaves = values.map((value) => JSON.stringify(value))
    const proofs = sampleProofs(leaves, 0.1)
    expect(proofs).toHaveLength(2)
    for (const proof of proofs) expect(verifyMerkleProof(proof)).toBe(true)
    // 篡改叶值 → 证明失败
    const tampered = { ...proofs[0]!, leaf: 'deadbeef' }
    expect(verifyMerkleProof(tampered)).toBe(false)

    // SnapshotChain 的接口
    let tick = 0
    const chain = new SnapshotChain({
      episodeId: 'ep-merkle',
      runsDir: mkdtempSync(join(tmpdir(), 'bah-merkle-')),
      readState: () => ({ tick: (tick += 1) }),
      now: () => new Date(1_700_000_000_000 + tick),
    })
    await chain.open()
    await chain.beforeIrreversible('c1')
    await chain.afterIrreversible('c1')
    await chain.close()
    const sampled = chain.sampleInclusionProofs(0.1)
    expect(sampled.length).toBeGreaterThan(0)
    for (const proof of sampled) expect(verifyMerkleProof(proof)).toBe(true)
  })
})

/**
 * `--snapshots` 的命令行面（W15 复审补）。
 *
 * 为什么要单独测：抽样逻辑的单测一直是绿的，而脚本头部写的示例文件
 * `session.snapshots.json` **在仓库里不存在**——审阅者照着敲会得到一串 ENOENT 栈。
 * 这条用例跑的就是文档里那条命令本身，示例路径失效会立刻红。
 */
describe('TC-W15-11 scripts/replay.ts --snapshots 可跑性与失败口径', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

  function run(args: readonly string[]): ReturnType<typeof spawnSync> {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/replay.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
    })
  }

  it('真实快照 jsonl：退出码 0，抽样证明离线可验', { timeout: 90_000 }, () => {
    const result = run(['--snapshots', 'snapshots/headless-basic/session.jsonl'])

    expect(result.stderr).not.toContain('ENOENT')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('条证明离线验证通过')
  })

  it('文件不存在：退出码 1 并说清缺哪个文件', { timeout: 90_000 }, () => {
    const result = run(['--snapshots', 'snapshots/headless-basic/nope.json'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('文件不存在')
  })

  it('形状不符（无 snapshots 数组）：退出码 1 并说清要什么形状', { timeout: 90_000 }, () => {
    const result = run(['--snapshots', 'snapshots/headless-basic/reverified.json'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('既不是数组')
  })
})
