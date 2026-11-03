/**
 * 常驻 profile 必须保留 `saga/tick`（复审 P1-2）。
 *
 * 只断言配置面：`eligible: []` 证明桥接不接管工具（避免 transfer_create 双层展开），
 * `tickIntervalMs > 0` 证明到期 job（aa-expire / sub-reminder / birthday-reminder）有派发源。
 * `plan` 是批次型入口，仍可只靠 boot 补跑——但这一点必须由本用例显式钉住，
 * 避免"哪天顺手也把它改成 tick-only"时无人发现。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

interface Row {
  readonly id: string
  readonly use?: string
  readonly config?: Readonly<Record<string, unknown>>
}

function rowsOf(profile: string): readonly Row[] {
  const path = fileURLToPath(
    new URL(`../../../../../profiles/${profile}/patch.yml`, import.meta.url),
  )
  return parse(readFileSync(path, 'utf8')) as readonly Row[]
}

function rowOf(rows: readonly Row[], id: string): Row | undefined {
  return rows.find((row) => row.id === id)
}

describe('常驻 profile 的 tick 接线', () => {
  for (const profile of ['web', 'mobile', 'web-plan'] as const) {
    it(`${profile}：saga-bridge 只保留 tick，不接管工具`, () => {
      const rows = rowsOf(profile)
      expect(rowOf(rows, 'bank:saga-bridge')?.config).toMatchObject({
        enabled: true,
        eligible: [],
        tickIntervalMs: 60_000,
      })
      expect(rowOf(rows, 'proactive:reminder')?.config).toMatchObject({
        enabled: true,
        catchUpOnBoot: true,
      })
    })
  }

  it('plan：批次型入口仍关闭 saga-bridge（boot 补跑是唯一触发点）', () => {
    const rows = rowsOf('plan')
    expect(rowOf(rows, 'bank:saga-bridge')?.config).toMatchObject({ enabled: false })
  })
})
