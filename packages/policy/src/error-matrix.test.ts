/**
 * 错误码矩阵自检（01 §6.4 / §14 "错误码矩阵全部有单测"）。
 *
 * 为什么要有这一条：错误码是契约，**"每个码至少一条单测"如果靠人数，迟早会漏**。
 * 这里用一张"触发 → 码"的表逐条跑，最后断言"实际产出的码集合 == 码表"。
 * 新增一个码却没有触发用例，这条测试立刻红。
 *
 * `policy-deny-order` 是**告警**不是错误（§4.3），单独在末尾验证。
 */

import { describe, expect, it } from 'vitest'

import { analyzeTables } from './analyze.ts'
import { compileBundle, type BundleFiles } from './compile.ts'
import { readCorpus } from './corpus.ts'
import { POLICY_ERROR_CODES, type PolicyErrorCode } from './errors.ts'
import { checkCondition } from './expr/check.ts'
import { evaluateExpr } from './expr/eval.ts'
import { tokenize } from './expr/lexer.ts'
import { parseExpression, toIr } from './expr/parser.ts'
import { validateInput } from './schema.ts'
import { compileRuleBundle } from './sentry-rules.ts'
import { parseBundleSignature } from './signature.ts'
import { readTables, type ParsedTable } from './table.ts'
import { parseYaml } from './yaml.ts'

const TOOLS = ['transfer_create']

function codeOf(read: () => unknown): PolicyErrorCode {
  try {
    read()
  } catch (error) {
    return (error as { code: PolicyErrorCode }).code
  }
  throw new Error('期望抛错，但没有抛')
}

/** 一份最小合法 rules（后续按需替换）。 */
function rules(body: string) {
  return parseYaml(`tables:\n  - id: t1\n    hit: first\n${body}`, 'rules.yml')
}

function readRules(body: string) {
  return readTables({
    source: rules(body),
    params: { riskyCallThreshold: { min: 1, max: 100 } },
    reasons: ['declared', 'new-payee', 'daily-limit', 'risky-calls'],
    denyCodes: ['policy-denied'],
    toolNames: TOOLS,
  })
}

const TWO_ROWS = `    rows:
      - id: R-1
        when: true
        keep: true
      - id: R-2
        when: true
        keep: true
`

/** 每条用例：码 + 触发。 */
const TRIGGERS: readonly { readonly code: PolicyErrorCode; readonly run: () => unknown }[] = [
  { code: 'policy-parse-error', run: () => tokenize('1.5') },
  { code: 'policy-schema-invalid', run: () => readRules('    rows: []\n') },
  { code: 'policy-unknown-key', run: () => readRules('    nope: 1\n    rows: []\n') },
  { code: 'policy-unknown-field', run: () => checkCondition(parseExpression('nope.x'), ctx()) },
  { code: 'policy-unknown-operator', run: () => tokenize('a ~= b') },
  { code: 'policy-type-mismatch', run: () => checkCondition(parseExpression('1 + "a" > 0'), ctx()) },
  { code: 'policy-unknown-param', run: () => checkCondition(parseExpression('params.x > 0'), ctx()) },
  {
    code: 'policy-param-unused',
    run: () =>
      analyzeTables([{ id: 't1', rows: [parsedRow('R-1', 'true')], loc: { line: 1, column: 1 } }], {
        source: parseYaml('tables: []\n', 'rules.yml'),
        params: { riskyCallThreshold: { min: 1, max: 100 } },
      }),
  },
  { code: 'policy-unknown-tool', run: () => readRules(`    appliesTo: [foo]\n${TWO_ROWS}`) },
  {
    code: 'policy-duplicate-rule',
    run: () =>
      readRules(`    rows:
      - id: R-1
        when: true
        keep: true
      - id: R-1
        when: true
        keep: true
`),
  },
  {
    code: 'policy-missing-default',
    run: () =>
      readRules(`    rows:
      - id: R-1
        when: true
        keep: true
      - id: R-2
        when: state.riskyCallsInTurn > 0
        keep: true
`),
  },
  {
    code: 'policy-unreachable-row',
    run: () =>
      analyzeTables(
        [
          {
            id: 't1',
            rows: [parsedRow('R-1', 'state.riskyCallsInTurn > 1'), parsedRow('R-2', 'state.riskyCallsInTurn > 1')],
            loc: { line: 1, column: 1 },
          },
        ],
        { source: parseYaml('tables: []\n', 'rules.yml'), params: {} },
      ),
  },
  {
    code: 'policy-unsatisfiable-row',
    run: () =>
      analyzeTables(
        [
          {
            id: 't1',
            rows: [parsedRow('R-1', '1 > 2'), parsedRow('R-2', 'true')],
            loc: { line: 1, column: 1 },
          },
        ],
        { source: parseYaml('tables: []\n', 'rules.yml'), params: {} },
      ),
  },
  {
    code: 'policy-lower-tier',
    run: () =>
      readRules(`    rows:
      - id: R-1
        when: true
        raise: green
        reason: daily-limit
      - id: R-2
        when: true
        keep: true
`),
  },
  {
    code: 'policy-bad-reason',
    run: () =>
      readRules(`    rows:
      - id: R-1
        when: true
        keep: true
        reason: fast
      - id: R-2
        when: true
        keep: true
`),
  },
  {
    code: 'policy-bad-deny-code',
    run: () =>
      readRules(`    rows:
      - id: R-1
        when: true
        deny: nope
        reason: declared
      - id: R-2
        when: true
        keep: true
`),
  },
  {
    code: 'policy-row-action-conflict',
    run: () =>
      readRules(`    rows:
      - id: R-1
        when: true
        raise: red
        keep: true
        reason: daily-limit
      - id: R-2
        when: true
        keep: true
`),
  },
  {
    code: 'policy-bad-semver',
    run: () =>
      compileBundle(
        { dir: 'policies/bank-tier/1.0.0', files: { ...BASE_FILES(), 'bundle.yml': manifest('version: 1.0') } },
        { toolNames: TOOLS, verifyLock: false },
      ),
  },
  {
    code: 'policy-version-mismatch',
    run: () =>
      compileBundle(
        { dir: 'policies/bank-tier/1.0.0', files: { ...BASE_FILES(), 'bundle.yml': manifest('name: bank-tier', 'name: other') } },
        { toolNames: TOOLS, verifyLock: false },
      ),
  },
  {
    code: 'policy-digest-mismatch',
    run: () => {
      const files = BASE_FILES()
      const first = compileBundle({ dir: DIR, files }, { toolNames: TOOLS, verifyLock: false })
      files['lock.json'] = JSON.stringify({
        semanticDigest: 'x',
        sourceDigest: first.lock.sourceDigest,
      })
      return compileBundle({ dir: DIR, files }, { toolNames: TOOLS })
    },
  },
  { code: 'policy-signature-invalid', run: () => parseBundleSignature('{') },
  {
    code: 'policy-corpus-missing',
    run: () => {
      const files = BASE_FILES()
      delete files['corpus.yml']
      return compileBundle({ dir: DIR, files }, { toolNames: TOOLS, verifyLock: false })
    },
  },
  { code: 'policy-limit-exceeded', run: () => tokenize(`1${' + 1'.repeat(2000)}`) },
  {
    code: 'policy-regex-unsafe',
    run: () =>
      compileRuleBundle(
        {
          dir: 'sentry-rules/1.0.0',
          files: {
            'bundle.yml': [
              'apiVersion: bah.policy/v1',
              'kind: sentry.rules',
              'name: sentry-rules',
              'version: 1.0.0',
              'description: 错误码矩阵的最小规则集',
              'owners: [test]',
              'schema: sentry.rules.input/v1',
              'engine: { min: 1.0.0, max: 1.x }',
              'rules:',
              '  - id: CMD-001',
              '    family: destructive',
              '    note: 嵌套量词',
              "    pattern: '(a+)+'",
              '    cases:',
              "      match: ['aa', 'aaa']",
              "      nonMatch: ['bb', 'cc']",
            ].join('\n'),
            'CHANGELOG.md': '# test\n',
          },
        },
        { verifyLock: false },
      ),
  },
  {
    code: 'policy-engine-incompatible',
    run: () =>
      compileBundle(
        {
          dir: DIR,
          files: {
            ...BASE_FILES(),
            'bundle.yml': manifest('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 9.0.0, max: 9.x }'),
          },
        },
        { toolNames: TOOLS, verifyLock: false },
      ),
  },
  { code: 'policy-input-invalid', run: () => validateInput({}, {}) },
  {
    code: 'policy-eval-overflow',
    run: () =>
      evaluateExpr({ op: '+', left: { int: Number.MAX_SAFE_INTEGER }, right: { int: 1 } }, {}),
  },
  { code: 'policy-eval-invalid', run: () => evaluateExpr({ op: 'xor', left: { int: 1 }, right: { int: 1 } } as unknown as ReturnType<typeof toIr>, {}) },
]

const DIR = 'policies/bank-tier/1.0.0'

function ctx() {
  return { params: { riskyCallThreshold: { min: 1, max: 100 } }, requires: new Set<string>() }
}

function parsedRow(id: string, when: string): ParsedTable['rows'][number] {
  const ast = parseExpression(when)
  return { id, when: toIr(ast), ast, action: { kind: 'keep' }, loc: { line: 1, column: 1 } }
}

/** 一份最小可编译 bundle（不读盘，免得上游 fixture 改动把矩阵变成"读文件测试"）。 */
function BASE_FILES(): Record<string, string> {
  return {
    'bundle.yml': [
      'apiVersion: bah.policy/v1',
      'kind: bank.tier',
      'name: bank-tier',
      'version: 1.0.0',
      'description: matrix fixture（只用于错误码矩阵自检）',
      'owners: [risk-platform]',
      'schema: bank.tier.input/v1',
      'engine: { min: 1.0.0, max: 1.x }',
      'parameters:',
      '  riskyCallThreshold: { type: integer, min: 1, max: 100 }',
      'reasons: [declared, new-payee, daily-limit, risky-calls]',
      'denyCodes: [policy-denied]',
      '',
    ].join('\n'),
    'rules.yml': `tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: state.riskyCallsInTurn >= params.riskyCallThreshold
        keep: true
        reason: risky-calls
      - id: R-2
        when: true
        keep: true
`,
    'corpus.yml': ['cases:', '  - id: C-1', '    input:', '      subject: { userId: u-1, sessionId: s-1 }', '      action: { name: transfer_create, declared: yellow }', '      state: { riskyCallsInTurn: 0, verifyLocked: false }', '      limits: { dailyLimitCents: 500000 }', '      params: { riskyCallThreshold: 3 }', '    expect: { level: yellow, reason: declared }', ''].join('\n'),
    'CHANGELOG.md': '# fixture\n',
  }
}

/** 改 manifest 的一行（找不到就原样返回，让用例自己红）。 */
function manifest(from: string, to = ''): string {
  const text = BASE_FILES()['bundle.yml'] as string
  if (to === '') {
    // 单参数形态：整行替换
    const key = from.split(':')[0]?.trim() ?? ''
    const lines = text.split('\n').map((line) => (line.startsWith(`${key}:`) ? from : line))
    return lines.join('\n')
  }
  return text.replace(from, to)
}

describe('错误码矩阵', () => {
  it('每个码表条目都有可复现的触发用例，且触发集合与码表完全一致', () => {
    const produced = new Map<PolicyErrorCode, number>()
    for (const trigger of TRIGGERS) {
      const code = codeOf(trigger.run)
      expect({ expected: trigger.code, actual: code }).toEqual({ expected: trigger.code, actual: trigger.code })
      produced.set(code, (produced.get(code) ?? 0) + 1)
    }

    const expected: readonly PolicyErrorCode[] = POLICY_ERROR_CODES.filter(
      (code) => code !== 'policy-deny-order',
    )
    const missing = expected.filter((code) => !produced.has(code))
    const unexpected = [...produced.keys()].filter((code) => !expected.includes(code))
    expect({ missing, unexpected }).toEqual({ missing: [], unexpected: [] })
  })

  it('policy-deny-order 是告警，不抛错', () => {
    const warnings = analyzeTables(
      [
        {
          id: 't1',
          rows: [
            {
              id: 'R-1',
              when: { bool: true },
              ast: parseExpression('true'),
              action: { kind: 'raise', to: 'red', reason: 'daily-limit' },
              loc: { line: 1, column: 1 },
            },
          ],
          loc: { line: 1, column: 1 },
        },
        {
          id: 't2',
          rows: [
            {
              id: 'R-2',
              when: { bool: true },
              ast: parseExpression('true'),
              action: { kind: 'deny', code: 'policy-denied', reason: 'declared' },
              loc: { line: 1, column: 1 },
            },
          ],
          loc: { line: 1, column: 1 },
        },
      ],
      { source: parseYaml('tables: []\n', 'rules.yml'), params: {} },
    )
    expect(warnings.map((warning) => warning.code)).toEqual(['policy-deny-order'])
  })

  it('readCorpus 的输入错误带 caseId（语料作者能定位）', () => {
    const source = parseYaml(
      ['cases:', '  - id: C-9', '    input: {}', '    expect: { level: yellow, reason: declared }', ''].join('\n'),
      'corpus.yml',
    )
    try {
      readCorpus(source, {}, ['declared'])
      throw new Error('期望抛错')
    } catch (error) {
      expect((error as { detail: { caseId: string } }).detail.caseId).toBe('C-9')
    }
  })

  it('BundleFiles 类型可用（防止 fixture 与编译入口漂移）', () => {
    const files: BundleFiles = { dir: DIR, files: BASE_FILES() }
    expect(compileBundle(files, { toolNames: TOOLS, verifyLock: false }).compiled.ir.tables).toHaveLength(1)
  })
})
