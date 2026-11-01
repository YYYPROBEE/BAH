/**
 * `fact:store` 宿主接线：重放后事实仍在，且新 id 从已有最大序号续号。
 *
 * 为什么值得单独钉：`maxFactSeq` 是"重启后不撞号"的唯一实现。撞号不会抛错，
 * 只会让新事实覆盖旧事实（静默丢数据），授权窗口的 `fact-unchanged` 也会拿错版本。
 * 本用例走真实 boot + 七段管线，不是只测 `replayFacts` 纯函数。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SESSION_SERVICE, TOOLS_SERVICE, ToolGuard, ToolPipeline } from '@bah/runtime'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import { boot, type BootOptions, type BootedApp, type ProfileSummary } from '../boot.ts'
import { createCatalog } from './index.ts'
import { FACT_SERVICE } from './fact.ts'
import { testRunContext } from '../test-run-context.ts'

import type { Bundle, PluginRow } from '../profile-plugins.ts'

const PROFILE: ProfileSummary = { name: 'fact', bundles: ['base'], hmr: false }
const NOW = 1_000

/** 只装与事实库接线相关的行：会话 / 工具 / 持久化 / 事实库。 */
const ROWS: readonly PluginRow[] = [
  { id: 'core:session' },
  { id: 'core:tools' },
  { id: 'core:persistence', config: { root: 'sessions', fsync: false } },
  { id: 'fact:store', config: { enabled: true } },
]

async function bootWith(dir: string, restore: boolean): Promise<BootedApp> {
  const bundle: Bundle = { name: 'base', rows: ROWS }
  const options: BootOptions = {
    profile: PROFILE,
    bundles: [bundle],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('s-fact'),
      now: () => NOW,
      jsonlDir: dir,
      ...(restore ? { restoreSession: true } : {}),
    }),
  }
  return boot(options)
}

/** 通过七段管线执行工具（模拟模型调用），落 `tool/call` + `tool/result`。 */
async function callTool(
  app: BootedApp,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const session = app.ctx.get(SESSION_SERVICE)
  const pipeline = new ToolPipeline({
    ctx: app.ctx,
    registry: app.ctx.get(TOOLS_SERVICE),
    session,
    guard: new ToolGuard(),
    sessionId: session.sessionId,
    now: () => NOW,
  })
  const execution = await pipeline.execute({ callId: `call-${name}`, name, args })
  expect(execution.result.isError).toBe(false)
  return execution.value
}

const BIRTHDAY = {
  person: '爱人',
  relation: 'spouse',
  kind: 'birthday',
  date: '1990-10-24',
}

describe('fact:store · 重启', () => {
  let dir: string | undefined
  let apps: BootedApp[] = []

  afterEach(async () => {
    for (const app of apps) await app.dispose('test-done')
    apps = []
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  it('重放后事实仍在，新事实 id 从已有序号续号（不覆盖旧事实）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bah-fact-'))
    const first = await bootWith(dir, false)
    apps.push(first)

    const created = (await callTool(first, 'fact_remember', BIRTHDAY)) as { factId: string }
    expect(created.factId).toBe('f-1')

    await first.dispose('restart')
    apps = apps.filter((app) => app !== first)

    const second = await bootWith(dir, true)
    apps.push(second)
    const facts = second.ctx.get(FACT_SERVICE)
    expect(facts.list().map((fact) => fact.factId)).toEqual(['f-1'])
    expect(facts.list()[0]?.person).toBe('爱人')

    const another = (await callTool(second, 'fact_remember', {
      person: '母亲',
      relation: 'parent',
      kind: 'birthday',
      date: '1960-01-01',
    })) as { factId: string }

    expect(another.factId).toBe('f-2')
    expect(facts.list().map((fact) => fact.factId).sort()).toEqual(['f-1', 'f-2'])
  })

  it('重放后同一条事实再确认：版本号在旧版本上继续 +1', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bah-fact-'))
    const first = await bootWith(dir, false)
    apps.push(first)
    await callTool(first, 'fact_remember', BIRTHDAY)

    await first.dispose('restart')
    apps = apps.filter((app) => app !== first)

    const second = await bootWith(dir, true)
    apps.push(second)
    const reconfirmed = (await callTool(second, 'fact_remember', {
      ...BIRTHDAY,
      confirmed: true,
    })) as { factId: string; version: number }

    // 版本号若被重放重置成 1，fact-unchanged 窗口会误判"事实没变过"
    expect(reconfirmed.factId).toBe('f-1')
    expect(reconfirmed.version).toBe(2)
    expect(second.ctx.get(FACT_SERVICE).versions()).toEqual({ 'f-1': 2 })
  })
})
