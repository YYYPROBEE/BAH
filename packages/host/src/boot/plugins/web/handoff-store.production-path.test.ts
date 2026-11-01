/**
 * 接管状态文件的**生产装配路径**（HO-1 的正向面）。
 *
 * `handoff-store.test.ts` 钉的是格式与失败路径，而 `handoffFileNextToSession` 只被
 * T-08 测了**拒绝**的那一支（目录不含租户段）。这里补两支没人管过的：
 *
 * 1. **正向布局**：坐席认领要落盘的 `handoff.json` 必须与 `session.jsonl` **同目录**，
 *    且落在租户段里。这一步错了不会报错，只会让接管证据静默地写到别的租户下
 *    （复审 AR-01 的同类事故），所以"写对了"也要有用例，不能只验"拦住了"。
 * 2. **清不掉半写 tmp 时仍然 fail-loud**：临时文件本身占着位置（例如上次崩溃留下一个
 *    同名目录）时，`save()` 里那层"清不掉就算了"的吞错**不能**把结论一起吞掉——
 *    报的还是结构化的 `handoff-state-unwritable`，而不是裸的 fs 错误。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'
import type { SessionId } from '@bah/core'
import { parseTenantId } from '@bah/util'

import { createHandoffStore, handoffFileNextToSession, type HandoffSnapshot } from './handoff-store.ts'
import type { SessionFiles } from '../persistence.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SNAPSHOT: HandoffSnapshot = { at: 1_700_000_000_000, lastSeq: 7, reason: '客户要求人工' }

/** `core:persistence` 的真实布局：`<部署根>/<租户>/<会话>/session.jsonl`。 */
function tenantLayout(): { readonly files: SessionFiles; readonly baseRoot: string } {
  const baseRoot = mkdtempSync(join(tmpdir(), 'bah-handoff-layout-'))
  dirs.push(baseRoot)
  const tenantRoot = join(baseRoot, 'demo')
  return {
    baseRoot,
    files: {
      root: tenantRoot,
      baseRoot,
      tenantId: parseTenantId('demo'),
      fileOf: (id) => join(tenantRoot, String(id), 'session.jsonl'),
    },
  }
}

describe('T-09 生产装配：handoff.json 与会话日志同目录', () => {
  it('T-09-1 合法租户布局 → <租户根>/<会话>/handoff.json（不是多一层，也不是漏租户段）', () => {
    const { files, baseRoot } = tenantLayout()
    const file = handoffFileNextToSession(files, 's-1' as SessionId)

    expect(file).toBe(join(baseRoot, 'demo', 's-1', 'handoff.json'))

    // 装配出来的路径直接能用：save 才建会话目录，load 读回同一个对象
    createHandoffStore({ file }).save(SNAPSHOT)
    expect(readdirSync(join(baseRoot, 'demo', 's-1'))).toEqual(['handoff.json'])
    expect(createHandoffStore({ file }).load()).toEqual(SNAPSHOT)
    // 没有第二个租户目录被牵连（路径算错时最常见的痕迹就是多出一段）
    expect(readdirSync(join(baseRoot, 'demo'))).toEqual(['s-1'])
  })

  it('T-09-2 tmp 占位清不掉 → 仍是 handoff-state-unwritable（吞错的那层不吞结论）', () => {
    const { files } = tenantLayout()
    const file = handoffFileNextToSession(files, 's-2' as SessionId)
    mkdirSync(join(file, '..'), { recursive: true })
    mkdirSync(`${file}.tmp`)

    const error = captureThrown(() => createHandoffStore({ file }).save(SNAPSHOT))
    expect((error as { code?: string }).code).toBe('handoff-state-unwritable')
    // 理由码之外还带着"哪个文件、为什么"，运维不用复现也知道该清理什么
    const detail = (error as { detail?: Record<string, unknown> }).detail
    expect(detail?.['file']).toBe(file)
    expect(typeof detail?.['reason']).toBe('string')
    // 半写的 tmp 还在那里：清理是尽力而为，但正式文件绝不能被改动
    expect(existsSync(`${file}.tmp`)).toBe(true)
    expect(existsSync(file)).toBe(false)
  })
})
