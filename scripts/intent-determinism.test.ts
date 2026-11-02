/**
 * 门禁自测（§6.4 / TC-INT-36）。
 *
 * 双向夹具：正夹具必须零 finding（证明注释不触发），反夹具必须命中（证明门禁真的会红）。
 * 只单向绿 = 门禁无效。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { checkAmbiguousAsks, gate, scanSource } from './verify-intent-determinism.ts'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'intent-determinism')

function fixture(name: string): { rel: string; source: string } {
  return { rel: `fixtures/${name}`, source: readFileSync(join(FIXTURES, name), 'utf8') }
}

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url))

describe('scanSource（I1/I2）', () => {
  it('正夹具零 finding：注释里的 Date.now 不算违规，带参 new Date 合法', () => {
    expect(scanSource(fixture('ok-pure.ts'))).toEqual([])
  })

  it('反夹具：Date.now / Math.random 各一条，且带行号', () => {
    const findings = scanSource(fixture('bad-clock.ts'))
    expect(findings.filter((line) => line.includes(':I1:'))).toHaveLength(2)
    for (const line of findings) expect(line).toMatch(/^fixtures\/bad-clock\.ts:\d+:I1:/)
  })

  it('反夹具：无参 new Date 命中，带参不命中', () => {
    const findings = scanSource(fixture('bad-new-date.ts'))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('new Date()')
    expect(scanSource(fixture('ok-pure.ts'))).toEqual([])
  })

  it('反夹具：fetch 命中', () => {
    expect(scanSource(fixture('bad-fetch.ts'))[0]).toContain('I1')
  })

  it('反夹具：DEFAULT_ 标识符命中 I2', () => {
    const findings = scanSource(fixture('bad-default-fill.ts'))
    expect(findings.some((line) => line.includes(':I2:') && line.includes('DEFAULT_PAYEE'))).toBe(true)
  })
})

describe('checkAmbiguousAsks（I2 分支字面量）', () => {
  it('ambiguous 分支 return 非 ask ⇒ 命中', () => {
    const findings = checkAmbiguousAsks('x.ts', fixture('bad-default-fill.ts').source)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain("return 'ask'")
  })

  it('ambiguous 分支 return ask ⇒ 不命中', () => {
    const source = `export function decide(kind: string) {\n  switch (kind) {\n    case 'ambiguous':\n      return 'ask'\n    default:\n      return 'x'\n  }\n}\n`
    expect(checkAmbiguousAsks('x.ts', source)).toEqual([])
  })

  it('ambiguous 分支没有 return ⇒ 命中', () => {
    const source = `export function decide(kind: string) {\n  switch (kind) {\n    case 'ambiguous':\n      break\n  }\n}\n`
    expect(checkAmbiguousAsks('x.ts', source)).toHaveLength(1)
  })
})

describe('gate 整跑', () => {
  it('真实仓库：ok 且 findings 为空', async () => {
    const result = await gate.run(REPO_ROOT)
    expect(result.findings).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.notes.join('\n')).toContain('纯函数面扫描')
  })

  it('负控：注入一个读时钟的纯函数文件 ⇒ 门禁红（证明不是永远绿）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-intent-gate-'))
    try {
      // 复制一个最小仓骨架：纯函数面 + 三处接线文件（让 I3~I5 通过，只让 I1 红）
      for (const rel of [
        'packages/runtime/src/intent/slots.ts',
        'packages/runtime/src/intent/evidence.ts',
        'packages/interaction/src/prompt/candidates.ts',
        'packages/host/src/boot/plugins/intent.ts',
        'packages/host/src/boot/plugins/prompt-ask.ts',
        'packages/llm/src/demo/router.ts',
        'packages/eval/src/scenarios/t/index.ts',
      ]) {
        mkdirSync(join(root, rel, '..'), { recursive: true })
        if (rel.endsWith('slots.ts')) {
          writeFileSync(join(root, rel), 'export function maskPhone(): string { return "" }\nexport function maskName(): string { return "" }\nexport function accountTail(): string { return "" }\n')
        } else if (rel.endsWith('evidence.ts')) {
          writeFileSync(join(root, rel), 'export function sanitizeSpan(t: string): string { return maskName(t) }\n')
        } else if (rel.endsWith('candidates.ts')) {
          writeFileSync(join(root, rel), 'export const MAX_CANDIDATES = 3\nexport const MANUAL_CHOICE = 1\nexport function buildChoices(x: unknown[]) { return [...x.slice(0, MAX_CANDIDATES), MANUAL_CHOICE] }\n')
        } else if (rel.endsWith('intent.ts') || rel.endsWith('prompt-ask.ts')) {
          writeFileSync(join(root, rel), rel.endsWith('intent.ts') ? 'createIntentResolveTool()\n' : 'createPromptAskTool()\n')
        } else if (rel.endsWith('router.ts')) {
          writeFileSync(join(root, rel), "'intent_resolve' 'prompt_ask'\n")
        } else {
          writeFileSync(join(root, rel), "'intent_resolve'\n")
        }
      }
      writeFileSync(
        join(root, 'packages/runtime/src/intent/bad.ts'),
        'export function t(): number { return Date.now() }\n',
      )

      const result = await gate.run(root)
      expect(result.ok).toBe(false)
      expect(result.findings.some((line) => line.includes('I1'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('负控：缺注册点时 I3 命中', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bah-intent-gate3-'))
    try {
      for (const rel of [
        'packages/runtime/src/intent/slots.ts',
        'packages/runtime/src/intent/evidence.ts',
        'packages/interaction/src/prompt/candidates.ts',
        'packages/llm/src/demo/router.ts',
        'packages/eval/src/scenarios/t/index.ts',
      ]) {
        mkdirSync(join(root, rel, '..'), { recursive: true })
        if (rel.endsWith('slots.ts')) {
          writeFileSync(join(root, rel), 'export function maskPhone(): string { return "" }\nexport function maskName(): string { return "" }\nexport function accountTail(): string { return "" }\n')
        } else if (rel.endsWith('evidence.ts')) {
          writeFileSync(join(root, rel), 'export function sanitizeSpan(t: string): string { return maskName(t) }\n')
        } else if (rel.endsWith('candidates.ts')) {
          writeFileSync(join(root, rel), 'export const MAX_CANDIDATES = 3\nexport const MANUAL_CHOICE = 1\nexport function buildChoices(x: unknown[]) { return [...x.slice(0, MAX_CANDIDATES), MANUAL_CHOICE] }\n')
        } else {
          writeFileSync(join(root, rel), "'intent_resolve' 'prompt_ask'\n")
        }
      }
      const result = await gate.run(root)
      expect(result.ok).toBe(false)
      expect(result.findings.some((line) => line.includes('I3'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
