/**
 * `--tenant` 的口径用例（租户与鉴权 01 · TA-11）。
 *
 * 三条优先级（CLI > env > demo）与一条硬要求（非法值 = **退出码 2**，不回落）。
 * 为什么"不回落"值得一条用例：静默回落会让运维以为在为 acme 记账，实际写进了 demo。
 */

import { describe, expect, it } from 'vitest'

import { resolveTenantId, runCli } from './run.ts'

/** 收集输出（runCli 的 io 端口）。 */
function io(): { out: string[]; err: string[]; outFn: (m: string) => void; errFn: (m: string) => void } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, outFn: (m) => out.push(m), errFn: (m) => err.push(m) }
}

describe('resolveTenantId', () => {
  it('TA-11-1 优先级：CLI > env > 缺省 demo', () => {
    expect(String(resolveTenantId(undefined, {}))).toBe('demo')
    expect(String(resolveTenantId(undefined, { BAH_TENANT: 'acme-bank' }))).toBe('acme-bank')
    expect(String(resolveTenantId('other', { BAH_TENANT: 'acme-bank' }))).toBe('other')
  })

  it('TA-11-2 空串按"未设置"处理（shell 展开事故不该变成"租户是空串"）', () => {
    expect(String(resolveTenantId('', { BAH_TENANT: 'acme' }))).toBe('acme')
    expect(String(resolveTenantId('   ', {}))).toBe('demo')
  })

  it('TA-11-3 非法值抛 tenant-id-invalid（不静默回落 demo）', () => {
    for (const bad of ['Demo', '../x', 'a', 'demo_bank', 'x'.repeat(32)]) {
      let code = ''
      try {
        resolveTenantId(bad, {})
      } catch (error) {
        code = (error as { code?: string }).code ?? ''
      }
      expect(code, bad).toBe('tenant-id-invalid')
    }
  })
})

describe('runCli · 非法租户是用法错误', () => {
  it('TA-11-4 --tenant ../x → 退出码 2 + stderr 带 tenant-id-invalid（不 boot）', async () => {
    const collector = io()
    const code = await runCli(
      ['--profile', 'web', '--tenant', '../x', '--dump-config'],
      { out: collector.outFn, err: collector.errFn },
      { env: {} },
    )
    expect(code).toBe(2)
    expect(collector.err.join('\n')).toContain('tenant-id-invalid')
    // 用法错误不给"用法"以外的噪音：没启动过 app，所以没有落盘提示
    expect(collector.out.join('\n')).toBe('')
  })

  it('TA-11-5 缺值（--tenant 后面没有值）→ 退出码 2', async () => {
    const collector = io()
    const code = await runCli(
      ['--profile', 'web', '--tenant', '--dump-config'],
      { out: collector.outFn, err: collector.errFn },
      { env: {} },
    )
    // `--dump-config` 被当成 --tenant 的值（非法的 "--dump-config"）→ 仍是 2
    expect(code).toBe(2)
  })
})
