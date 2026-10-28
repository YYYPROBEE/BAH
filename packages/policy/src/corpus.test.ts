/**
 * 语料、覆盖率与变异（04 §3）。
 *
 * 语料是验收装置：规则没被命中、边界没被覆盖、变异体杀不死——三种情况都必须红。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { compileBundle, type BundleFiles } from './compile.ts'
import {
  mutateAndKill,
  readCorpus,
  REQUIRED_TAGS,
  runCorpus,
  type CorpusCase,
} from './corpus.ts'
import { evaluateIr, type PolicyIr } from './table.ts'
import { parseYaml } from './yaml.ts'
import type { ParamSpec } from './schema.ts'

const DIR = 'policies/bank-tier/1.0.0'
const REAL_DIR = join(process.cwd(), DIR)
const TOOLS = ['transfer_create', 'wealth_purchase', 'sub_cancel', 'card_report_lost']
const PARAMS: Record<string, ParamSpec> = { riskyCallThreshold: { min: 1, max: 100 } }

function realFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of [
    'bundle.yml',
    'rules.yml',
    'corpus.yml',
    'CHANGELOG.md',
  ]) {
    files[name] = readFileSync(join(REAL_DIR, name), 'utf8')
  }
  return files
}

const compiled = compileBundle({ dir: DIR, files: realFiles() } as BundleFiles, {
  toolNames: TOOLS,
  verifyLock: false,
})

const INPUT_BLOCK = [
  '    input:',
  '      subject: { userId: u-1, sessionId: s-1 }',
  '      action: { name: transfer_create, declared: yellow }',
  '      state: { riskyCallsInTurn: 0, verifyLocked: false }',
  '      limits: { dailyLimitCents: 500000 }',
  '      params: { riskyCallThreshold: 3 }',
].join('\n')

const EXPECT = '    expect: { level: yellow, reason: declared }'

/** 一条用例块（不含 `cases:` 根）。 */
function caseBlock(id = 'C-1', extra = ''): string {
  return [`  - id: ${id}`, INPUT_BLOCK, EXPECT, extra].join('\n')
}

/** 一份单用例语料。 */
function corpusOf(extra = '', id = 'C-1'): string {
  return ['cases:', caseBlock(id, extra), ''].join('\n')
}

function source(text: string) {
  return parseYaml(text, 'corpus.yml')
}

function codeOf(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    return (error as { code: string }).code
  }
  throw new Error('期望抛错')
}

function detailOf(read: () => unknown): Record<string, unknown> {
  try {
    read()
  } catch (error) {
    return ((error as { detail?: Record<string, unknown> }).detail ?? {}) as Record<string, unknown>
  }
  throw new Error('期望抛错')
}

describe('readCorpus', () => {
  it('合法语料解析成功', () => {
    const cases = readCorpus(source(corpusOf()), PARAMS, ['declared', 'new-payee'])
    expect(cases).toHaveLength(1)
    expect(cases[0]?.expect).toEqual({ level: 'yellow', reason: 'declared' })
  })

  it('note / tags / deny 可选字段', () => {
    const text = corpusOf('    note: 为什么需要它\n    tags: [limit-eq]').replace(
      EXPECT,
      '    expect: { level: yellow, reason: declared, deny: { code: policy-denied, reason: declared } }',
    )
    const cases = readCorpus(source(text), PARAMS, ['declared'])
    expect(cases[0]?.note).toBe('为什么需要它')
    expect(cases[0]?.tags).toEqual(['limit-eq'])
    expect(cases[0]?.expect.deny).toEqual({ code: 'policy-denied', reason: 'declared' })
  })

  it('根节点/键/cases 形状', () => {
    expect(codeOf(() => readCorpus(source('- a\n'), PARAMS, ['declared']))).toBe('policy-schema-invalid')
    expect(codeOf(() => readCorpus(source('cases: []\nother: 1\n'), PARAMS, ['declared']))).toBe(
      'policy-unknown-key',
    )
    expect(codeOf(() => readCorpus(source('cases: []\n'), PARAMS, ['declared']))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => readCorpus(source('cases:\n  - 1\n'), PARAMS, ['declared']))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => readCorpus(source(corpusOf('    extra: 1')), PARAMS, ['declared']))).toBe(
      'policy-unknown-key',
    )
  })

  it('id 必填且唯一；note/tags 类型', () => {
    expect(codeOf(() => readCorpus(source(corpusOf('', '""')), PARAMS, ['declared']))).toBe(
      'policy-schema-invalid',
    )
    const duplicated = ['cases:', caseBlock('C-1'), caseBlock('C-1'), ''].join('\n')
    expect(codeOf(() => readCorpus(source(duplicated), PARAMS, ['declared']))).toBe('policy-duplicate-rule')
    expect(codeOf(() => readCorpus(source(corpusOf('    note: 1')), PARAMS, ['declared']))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => readCorpus(source(corpusOf('    tags: x')), PARAMS, ['declared']))).toBe(
      'policy-schema-invalid',
    )
  })

  it('input 非法时带 caseId 报 policy-input-invalid', () => {
    const bad = corpusOf().replace('declared: yellow', 'declared: blue')
    const detail = detailOf(() => readCorpus(source(bad), PARAMS, ['declared']))
    expect(detail['caseId']).toBe('C-1')
    expect(codeOf(() => readCorpus(source(bad), PARAMS, ['declared']))).toBe('policy-input-invalid')
  })

  it('expect 形状：level/reason/ruleIds/deny', () => {
    expect(codeOf(() => readCorpus(source(corpusOf().replace(EXPECT, '    expect: 1')), PARAMS, ['declared']))).toBe(
      'policy-schema-invalid',
    )
    expect(
      codeOf(() =>
        readCorpus(source(corpusOf().replace(EXPECT, '    expect: { level: yellow, reason: declared, x: 1 }')), PARAMS, [
          'declared',
        ]),
      ),
    ).toBe('policy-unknown-key')
    expect(
      codeOf(() => readCorpus(source(corpusOf().replace(EXPECT, '    expect: { level: blue, reason: declared }')), PARAMS, ['declared'])),
    ).toBe('policy-schema-invalid')
    expect(
      codeOf(() => readCorpus(source(corpusOf().replace(EXPECT, '    expect: { level: yellow, reason: fast }')), PARAMS, ['declared'])),
    ).toBe('policy-bad-reason')
    expect(
      codeOf(() =>
        readCorpus(
          source(corpusOf().replace(EXPECT, '    expect: { level: yellow, reason: declared, ruleIds: x }')),
          PARAMS,
          ['declared'],
        ),
      ),
    ).toBe('policy-schema-invalid')
    expect(
      codeOf(() =>
        readCorpus(
          source(corpusOf().replace(EXPECT, '    expect: { level: yellow, reason: declared, deny: { code: 1 } }')),
          PARAMS,
          ['declared'],
        ),
      ),
    ).toBe('policy-schema-invalid')
  })
})

describe('runCorpus', () => {
  it('生产语料全绿，覆盖无缺口', () => {
    const report = runCorpus(compiled.compiled.ir, compiled.cases, compiled.compiled)
    expect(report.failures).toEqual([])
    expect(report.coverage.violations).toEqual([])
    expect(report.coverage.cases).toBe(compiled.cases.length)
    expect(report.coverage.rules).toHaveLength(5)
    expect(report.coverage.reasons).toEqual(['daily-limit', 'declared', 'new-payee', 'risky-calls'])
    expect(report.coverage.declared).toEqual(['green', 'yellow', 'red'])
    expect(report.coverage.bindings).toEqual(['new', 'whitelist'])
    expect(report.coverage.tags).toEqual([...REQUIRED_TAGS])
    expect(report.coverage.actions['raise-red']).toBe(2)
    expect(report.coverage.tagCounts['limit-eq']).toBe(1)
  })

  it('期望不符时逐字段报出（level/reason/ruleIds/deny）', () => {
    const broken: CorpusCase[] = compiled.cases.slice(0, 1).map((item) => ({
      ...item,
      expect: { level: 'red', reason: 'new-payee', ruleIds: ['NOPE'], deny: { code: 'policy-denied', reason: 'x' } },
    }))
    const report = runCorpus(compiled.compiled.ir, broken, compiled.compiled)
    expect(report.failures.map((failure) => failure.field).sort()).toEqual([
      'deny',
      'level',
      'reason',
      'ruleIds',
    ])
  })

  it('覆盖缺口：规则/理由/声明级/绑定/边界', () => {
    const onlyNoPreview = compiled.cases.filter((item) => item.input.preview === undefined)
    const report = runCorpus(compiled.compiled.ir, onlyNoPreview, compiled.compiled)
    expect(report.coverage.violations).toContain('row:TR-001-over-daily-limit')
    expect(report.coverage.violations).toContain('reason:daily-limit')
    expect(report.coverage.violations.some((item) => item.startsWith('declared:'))).toBe(false)
    expect(report.coverage.violations.some((item) => item.startsWith('tag:'))).toBe(true)
    expect(report.coverage.violations.some((item) => item.startsWith('binding:'))).toBe(false)
  })
})

describe('mutateAndKill', () => {
  it('生产语料 100% 杀死全部变异体', () => {
    const report = mutateAndKill(compiled.compiled.ir, compiled.cases, (candidate) => ({
      evaluate: (input) => evaluateIr(candidate, input),
    }))
    expect(report.surviving).toEqual([])
    expect(report.unmutated).toEqual([])
    expect(report.total).toBeGreaterThanOrEqual(15)
    expect(report.score).toBe(1)
  })

  it('语料不足时变异体存活（证明语料真的在起作用）', () => {
    const report = mutateAndKill(compiled.compiled.ir, compiled.cases.slice(0, 1), (candidate) => ({
      evaluate: (input) => evaluateIr(candidate, input),
    }))
    expect(report.surviving.length).toBeGreaterThan(0)
    expect(report.score).toBeLessThan(1)
  })

  it('deny 行参与变异与覆盖统计', () => {
    const denyIr: PolicyIr = {
      ...compiled.compiled.ir,
      tables: [
        ...compiled.compiled.ir.tables,
        {
          id: 'deny-table',
          hit: 'first',
          rows: [
            { id: 'D-1', when: { bool: true }, action: { kind: 'deny', code: 'policy-denied', reason: 'declared' } },
            { id: 'D-2', when: { bool: true }, action: { kind: 'keep' } },
          ],
        },
      ],
    }
    const cases: CorpusCase[] = [
      {
        ...(compiled.cases[0] as CorpusCase),
        expect: {
          level: 'yellow',
          reason: 'declared',
          ruleIds: ['TR-003-default', 'RC-002-default', 'D-1'],
          deny: { code: 'policy-denied', reason: 'declared' },
        },
      },
    ]
    const report = runCorpus(denyIr, cases, { evaluate: (input) => evaluateIr(denyIr, input) })
    expect(report.failures).toEqual([])
    expect(report.coverage.actions['deny']).toBe(1)

    const mutation = mutateAndKill(denyIr, cases, (candidate) => ({
      evaluate: (input) => evaluateIr(candidate, input),
    }))
    expect(mutation.unmutated).toEqual([])
    expect(mutation.surviving).toContain('D-2:delete-row')
  })

  it('变异器覆盖数字字面量/逻辑组合/一元条件（含坏 IR 不崩）', () => {
    const literalIr: PolicyIr = {
      ...compiled.compiled.ir,
      tables: [
        {
          id: 'lit',
          hit: 'first',
          rows: [
            {
              id: 'L-1',
              when: {
                op: '&&',
                left: { bool: true },
                right: { op: '>', left: { path: 'state.riskyCallsInTurn' }, right: { int: 2 } },
              },
              action: { kind: 'raise', to: 'red', reason: 'daily-limit' },
            },
            {
              id: 'L-2',
              when: { op: 'not', arg: { path: 'state.verifyLocked' } },
              action: { kind: 'keep', reason: 'risky-calls' },
            },
            {
              id: 'L-3',
              when: { op: '==', left: { op: '+', left: { path: 'state.riskyCallsInTurn' }, right: { int: 1 } }, right: { int: 2 } },
              action: { kind: 'keep' },
            },
            {
              id: 'L-4',
              when: { op: '||', left: { bool: false }, right: { bool: false } },
              action: { kind: 'keep' },
            },
            {
              id: 'L-5',
              when: { op: 'not', arg: { op: '>', left: { path: 'state.riskyCallsInTurn' }, right: { int: 1 } } },
              action: { kind: 'keep' },
            },
            { id: 'L-6', when: { bool: true }, action: { kind: 'keep' } },
          ],
        },
      ],
    }
    const report = mutateAndKill(literalIr, compiled.cases.slice(0, 1), (candidate) => ({
      evaluate: (input) => evaluateIr(candidate, input),
    }))
    expect(report.total).toBeGreaterThanOrEqual(20)
    expect(report.unmutated).toEqual([])
  })

  it('空表不会产生变异体（score 0，unmutated 空）', () => {
    const report = mutateAndKill({ ...compiled.compiled.ir, tables: [] }, compiled.cases, (candidate) => ({
      evaluate: (input) => evaluateIr(candidate, input),
    }))
    expect(report.total).toBe(0)
    expect(report.score).toBe(0)
    expect(report.unmutated).toEqual([])
  })
})
