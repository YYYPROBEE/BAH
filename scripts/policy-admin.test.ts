/**
 * 策略管理面（S3）：promote / rollback / install / audit-verify 的纯文件行为。
 *
 * 每个用例在临时目录造根，**不碰仓库里的 policies/**；断言只看
 * `runtime-state.json` 与 `policy-rollout/audit.jsonl` 的可复核事实。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  adminPaths,
  applyChange,
  installBundle,
  planPromote,
  planRollback,
  readState,
  touchState,
  verifyRollout,
  versionsOf,
} from './policy-admin-lib.ts'

const roots: string[] = []
const STABLE = 'policies/bank-tier/1.0.0'
const DEMO = 'policies/demo/bank-tier-demo/1.0.0'
const NOW = 1_761_700_000_000

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-policy-admin-'))
  roots.push(dir)
  return dir
}

function setup(): { root: string; paths: ReturnType<typeof adminPaths> } {
  const dir = root()
  const paths = adminPaths({ root: dir })
  installBundle({ paths, sourceDir: STABLE, now: NOW })
  installBundle({ paths, sourceDir: DEMO, now: NOW, demo: true })
  return { root: dir, paths }
}

describe('policy:install', () => {
  it('首次安装建 registry；同摘要重装 = no-op；demo 标记保留', () => {
    const dir = root()
    const paths = adminPaths({ root: dir })
    const first = installBundle({ paths, sourceDir: STABLE, now: NOW })
    expect(first.changed).toBe(true)
    expect(existsSync(join(dir, 'registry.json'))).toBe(true)

    const again = installBundle({ paths, sourceDir: STABLE, now: NOW })
    expect(again.changed).toBe(false)

    installBundle({ paths, sourceDir: DEMO, now: NOW, demo: true })
    const rows = versionsOf(paths)
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.handle === 'bank-tier-demo/1.0.0')?.demo).toBe(true)
    expect(rows.find((row) => row.handle === 'bank-tier/1.0.0')?.demo).toBe(false)
  })
})

describe('policy:promote / rollback', () => {
  it('首次 promote 必须给 --active；给了才建 state 与变更链', () => {
    const { paths } = setup()
    expect(() =>
      planPromote({ paths, to: 'bank-tier-demo/1.0.0', reason: 'canary 5 percent', now: NOW }),
    ).toThrowError(/首次 promote 必须显式给 --active/)

    const plan = planPromote({
      paths,
      active: 'bank-tier/1.0.0',
      to: 'bank-tier-demo/1.0.0',
      percent: 500,
      sessions: ['s-canary'],
      reason: 'canary 5 percent',
      now: NOW,
    })
    expect(plan.changed).toBe(true)
    applyChange(paths, plan)

    const state = readState(paths.statePath)!
    expect(state.assignments['bank.tier']).toEqual({
      active: 'bank-tier/1.0.0',
      canary: {
        version: 'bank-tier-demo/1.0.0',
        percent: 500,
        sessions: ['s-canary'],
        epoch: 1,
      },
    })
    expect(state.history).toHaveLength(1)
    expect(verifyRollout(paths.root)).toEqual({ ok: true, rows: 1 })
    expect(versionsOf(paths).filter((row) => row.canary)).toHaveLength(1)
  })

  it('全量 promote 切 active、清 canary；rollback 回到 history 上一条', () => {
    const { paths } = setup()
    const canary = planPromote({
      paths,
      active: 'bank-tier/1.0.0',
      to: 'bank-tier-demo/1.0.0',
      percent: 500,
      reason: 'canary 5 percent',
      now: NOW,
    })
    applyChange(paths, canary)

    const full = planPromote({
      paths,
      to: 'bank-tier-demo/1.0.0',
      percent: 10_000,
      reason: 'promote to full traffic',
      now: NOW + 1,
    })
    applyChange(paths, full)
    let state = readState(paths.statePath)!
    expect(state.assignments['bank.tier']).toEqual({ active: 'bank-tier-demo/1.0.0' })
    expect(state.history.map((entry) => entry.action)).toEqual(['promote', 'promote'])

    const rollback = planRollback({
      paths,
      reason: 'canary deny spike rollback',
      now: NOW + 2,
    })
    expect(rollback.record.to).toBe('bank-tier/1.0.0')
    applyChange(paths, rollback)
    state = readState(paths.statePath)!
    expect(state.assignments['bank.tier']).toEqual({ active: 'bank-tier/1.0.0' })
    expect(state.history.at(-1)?.action).toBe('rollback')
    expect(state.history.at(-1)?.epoch).toBe(3)
    expect(verifyRollout(paths.root)).toEqual({ ok: true, rows: 3 })
  })

  it('无变化 promote 不写链、不改 state；短 reason / 越界 percent 拒绝', () => {
    const { paths } = setup()
    applyChange(
      paths,
      planPromote({
        paths,
        active: 'bank-tier/1.0.0',
        to: 'bank-tier/1.0.0',
        reason: 'initialise policy state',
        now: NOW,
      }),
    )
    const before = readState(paths.statePath)!
    const noop = planPromote({
      paths,
      to: 'bank-tier/1.0.0',
      reason: 'same version no change',
      now: NOW + 1,
    })
    expect(noop.changed).toBe(false)
    applyChange(paths, noop)
    expect(readState(paths.statePath)).toEqual(before)
    expect(verifyRollout(paths.root).rows).toBe(1)

    expect(() =>
      planPromote({ paths, to: 'bank-tier-demo/1.0.0', reason: 'short', now: NOW }),
    ).toThrowError(/至少 8 个字符/)
    expect(() =>
      planPromote({ paths, to: 'bank-tier-demo/1.0.0', percent: 10_001, reason: 'out of range percent', now: NOW }),
    ).toThrowError(/percent/)
  })

  it('reload 只改 updatedAt；state 不存在时拒绝', () => {
    const { paths } = setup()
    expect(() => touchState(paths, NOW)).toThrowError(/没有 runtime-state/)
    applyChange(
      paths,
      planPromote({
        paths,
        active: 'bank-tier/1.0.0',
        to: 'bank-tier/1.0.0',
        reason: 'initialise policy state',
        now: NOW,
      }),
    )
    const next = touchState(paths, NOW + 99)
    expect(next.updatedAt).toBe(NOW + 99)
    expect(readState(paths.statePath)?.updatedAt).toBe(NOW + 99)
  })
})

describe('policy:audit-verify', () => {
  it('篡改变更链一行 → 连续性失败', () => {
    const { paths } = setup()
    applyChange(
      paths,
      planPromote({
        paths,
        active: 'bank-tier/1.0.0',
        to: 'bank-tier-demo/1.0.0',
        percent: 500,
        reason: 'canary 5 percent',
        now: NOW,
      }),
    )
    expect(verifyRollout(paths.root).ok).toBe(true)

    const chainPath = join(paths.root, 'policy-rollout', 'audit.jsonl')
    const lines = readFileSync(chainPath, 'utf8').trim().split('\n')
    const row = JSON.parse(lines[0]!) as Record<string, unknown>
    row['d'] = 'deadbeef'
    writeFileSync(chainPath, `${JSON.stringify(row)}\n`, 'utf8')
    expect(verifyRollout(paths.root).ok).toBe(false)
  })
})
