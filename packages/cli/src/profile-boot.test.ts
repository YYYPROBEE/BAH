/**
 * W08 TC-07：三个可运行 profile 真的能 **boot**（不是只 `--dump-config`）。
 *
 * 为什么要单独一条：W08 把 `trace.sink` 改成 fail-loud，漏配的三个 profile 会在
 * `PluginManager.validate` 就挂；`--dump-config` 能挡住这一层，但"起得来"还包括
 * `apply()` / `start()`（audit:decisions 建链、web 渠道监听端口、saga 建库）。
 *
 * 三条都注入临时 `jsonlDir`：不写仓库 `sessions/`，也不读开发机 home patch。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, createCatalog, type BootedApp } from '@bah/host'
import { AGENTS_SERVICE } from '@bah/runtime'
import { asSessionId, fixedClock } from '@bah/test-support'
import { afterEach, describe, expect, it } from 'vitest'

import { loadBundles } from './bundles.ts'
import { readLayers, readProfile } from './profile.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bah-w08-boot-${tag}-`))
  scratch.push(dir)
  return dir
}

/** web 必须把端口改成 0：测试不能占用演示端口 7331。 */
function webPortOverlay(): string {
  const dir = tempDir('overlay')
  const path = join(dir, 'port0.yml')
  writeFileSync(path, '- id: channel:web\n  config:\n    port: 0\n', 'utf8')
  return path
}

async function bootProfile(name: 'headless' | 'plan' | 'web'): Promise<BootedApp> {
  const profile = readProfile(repoRoot, name)
  const bundles = await loadBundles(repoRoot, profile.bundles)
  const { layers } = readLayers(repoRoot, profile, {
    home: join(tmpdir(), 'bah-w08-boot-no-home'),
    overlays: name === 'web' ? [webPortOverlay()] : [],
  })
  const clock = fixedClock({ start: 1_700_000_000_000, step: 1 })
  return boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: {
      sessionId: asSessionId(`s-w08-boot-${name}`),
      now: clock.now,
      jsonlDir: tempDir(name),
    },
  })
}

describe('W08 TC-07：三个 profile 真 boot', () => {
  for (const name of ['headless', 'plan', 'web'] as const) {
    it(`${name}：boot 成功，sentry trace.sink=session，audit:decisions 在场`, async () => {
      const app = await bootProfile(name)
      try {
        expect(app.ctx.get(AGENTS_SERVICE).list().length).toBeGreaterThan(0)
        const rows = app.rows()
        const sentry = rows.find((row) => row.id === 'safety:sentry')
        expect(sentry).toBeDefined()
        expect(
          (sentry?.settings as { trace?: { sink?: string } } | undefined)?.trace?.sink,
        ).toBe('session')
        expect(rows.some((row) => row.id === 'audit:decisions')).toBe(true)
        // web 的监听失败会让 boot 直接抛 `web-listen-failed`；能走到这里就证明端口已起。
        if (name === 'web') {
          expect(rows.some((row) => row.id === 'channel:web')).toBe(true)
        }
      } finally {
        await app.dispose('test')
      }
    })
  }
})
