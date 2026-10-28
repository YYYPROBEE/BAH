/**
 * 决策表：解析 / 求值 / 静态分析 / YAML 定位（01 §4、§7）。
 *
 * 解析部分按"每个错误码至少一条"覆盖；求值部分钉四条不变式；静态分析覆盖
 * 不可达（同谓词、区间包含）、恒假（常量折叠、值域）、参数未用、deny 顺序告警。
 */

import { describe, expect, it } from 'vitest'

import { analyzeTables, type AnalyzeContext } from './analyze.ts'
import { parseExpression, toIr, type IrExpr } from './expr/parser.ts'
import type { BankTierInput, ParamSpec } from './schema.ts'
import {
  evaluateIr,
  maxLevel,
  readTables,
  type IrAction,
  type ParsedTable,
  type PolicyIr,
  type TableContext,
} from './table.ts'
import { locIn, locOf, parseYaml, toPlain, type YamlSource } from './yaml.ts'

const PARAMS: Record<string, ParamSpec> = { riskyCallThreshold: { min: 1, max: 100 } }
const REASONS = ['declared', 'new-payee', 'daily-limit', 'risky-calls']
const TOOLS = ['transfer_create', 'wealth_purchase']

/** 一份最小的合法规则表。 */
const BASE_RULES = `tables:
  - id: t1
    appliesTo: [transfer_create]
    requires: [preview]
    hit: first
    rows:
      - id: R-001
        when: preview.amountCents > 100
        raise: red
        reason: daily-limit
      - id: R-002
        when: true
        keep: true
`

/** 造一个解析上下文。 */
function context(rules: string, overrides: Partial<TableContext> = {}): TableContext {
  return {
    source: parseYaml(rules, 'rules.yml'),
    params: PARAMS,
    reasons: REASONS,
    denyCodes: ['policy-denied'],
    toolNames: TOOLS,
    ...overrides,
  }
}

/** 解析出 IR。 */
function irOf(rules: string, overrides: Partial<TableContext> = {}): PolicyIr {
  return wrap(readTables(context(rules, overrides)).tables)
}

function wrap(tables: PolicyIr['tables']): PolicyIr {
  return {
    apiVersion: 'bah.policy/v1',
    kind: 'bank.tier',
    name: 'bank-tier',
    version: '1.0.0',
    schema: 'bank.tier.input/v1',
    engine: { min: '1.0.0', max: '1.x' },
    parameters: {},
    reasons: [...REASONS].sort(),
    denyCodes: ['policy-denied'],
    tables,
  }
}

/** 一份合法输入。 */
function input(patch: Record<string, unknown> = {}): BankTierInput {
  const base: Record<string, unknown> = {
    subject: { userId: 'u-1', sessionId: 's-1' },
    action: { name: 'transfer_create', declared: 'yellow' },
    preview: {
      amountCents: 200,
      dailyUsedCents: 0,
      dailyLimitCents: 500_000,
      payee: { binding: 'whitelist' },
    },
    state: { riskyCallsInTurn: 0, verifyLocked: false },
    limits: { dailyLimitCents: 500_000 },
    params: { riskyCallThreshold: 3 },
  }
  return { ...base, ...patch } as unknown as BankTierInput
}

/** 取错误码。 */
function codeOf(read: () => unknown): string {
  try {
    read()
  } catch (error) {
    return (error as { code: string }).code
  }
  throw new Error('期望抛错')
}

/** 取错误详情。 */
function detailOf(read: () => unknown): Record<string, unknown> {
  try {
    read()
  } catch (error) {
    return ((error as { detail?: Record<string, unknown> }).detail ?? {}) as Record<string, unknown>
  }
  throw new Error('期望抛错')
}

describe('YAML 定位', () => {
  it('parseYaml 报语法错误时带行列', () => {
    const detail = detailOf(() => parseYaml('a: [1,\n', 'x.yml'))
    expect(detail['file']).toBe('x.yml')
    expect(typeof detail['line']).toBe('number')
  })

  it('重复键被拒绝', () => {
    expect(codeOf(() => parseYaml('a: 1\na: 2\n', 'x.yml'))).toBe('policy-parse-error')
  })

  it('别名被拒绝（禁止一份文本两种展开）', () => {
    const source = parseYaml('a: &x 1\nb: *x\n', 'x.yml')
    expect(codeOf(() => toPlain(source))).toBe('policy-parse-error')
  })

  it('locOf 缺失路径退化为 1:1，locIn 支持多行标量', () => {
    const source: YamlSource = parseYaml('a:\n  b: hello\nc: "x"\n', 'x.yml')
    expect(locOf(source, ['a', 'b'])).toEqual({ line: 2, column: 6 })
    expect(locOf(source, ['nope'])).toEqual({ line: 1, column: 1 })
    expect(locIn(source, ['a', 'b'], 'hello', 2)).toEqual({ line: 2, column: 8 })
    expect(locIn(source, ['a', 'b'], 'a\nb', 2)).toEqual({ line: 3, column: 1 })
  })
})

describe('readTables · 形状错误', () => {
  it('根节点/键/表数组的形状', () => {
    expect(codeOf(() => readTables(context('- a\n')))).toBe('policy-schema-invalid')
    expect(codeOf(() => readTables(context('tables: []\nother: 1\n')))).toBe('policy-unknown-key')
    expect(codeOf(() => readTables(context('tables: []\n')))).toBe('policy-schema-invalid')
    expect(codeOf(() => readTables(context('tables:\n  - 1\n')))).toBe('policy-schema-invalid')
    expect(codeOf(() => readTables(context('tables:\n  - id: t1\n    nope: 1\n    rows: []\n')))).toBe(
      'policy-unknown-key',
    )
  })

  it('表数上限 32', () => {
    const tables = Array.from({ length: 33 }, (_, index) =>
      `  - id: t${String(index)}\n    hit: first\n    rows:\n      - id: R-${String(index)}-a\n        when: true\n        keep: true\n      - id: R-${String(index)}-b\n        when: true\n        keep: true\n`,
    ).join('')
    expect(codeOf(() => readTables(context(`tables:\n${tables}`)))).toBe('policy-limit-exceeded')
  })

  it('表 ID / hit / appliesTo / requires', () => {
    expect(codeOf(() => readTables(context('tables:\n  - id: ""\n    hit: first\n    rows: []\n')))).toBe(
      'policy-schema-invalid',
    )

    const duplicated = `tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        keep: true
      - id: R-2
        when: true
        keep: true
  - id: t1
    hit: first
    rows:
      - id: R-3
        when: true
        keep: true
        reason: risky-calls
      - id: R-4
        when: true
        keep: true
      - id: R-4
        when: true
        keep: true
`
    expect(codeOf(() => readTables(context(duplicated)))).toBe('policy-duplicate-rule')
    expect(codeOf(() => readTables(context('tables:\n  - id: t1\n    hit: last\n    rows: []\n')))).toBe(
      'policy-schema-invalid',
    )

    const twoRows = `      - id: R-1
        when: true
        keep: true
      - id: R-2
        when: true
        keep: true
`
    expect(
      codeOf(() => readTables(context(`tables:\n  - id: t1\n    hit: first
    appliesTo: transfer_create\n    rows:\n${twoRows}`))),
    ).toBe('policy-schema-invalid')
    expect(
      codeOf(() => readTables(context(`tables:\n  - id: t1\n    hit: first
    appliesTo: [unknown_tool]\n    rows:\n${twoRows}`))),
    ).toBe('policy-unknown-tool')
    expect(
      codeOf(() => readTables(context(`tables:\n  - id: t1\n    hit: first
    requires: [payee]\n    rows:\n${twoRows}`))),
    ).toBe('policy-schema-invalid')
  })

  it('rows 为空数组被拒绝', () => {
    const rules = ['tables:', '  - id: t1', '    hit: first', '    rows: []', ''].join('\n')
    expect(codeOf(() => readTables(context(rules)))).toBe('policy-schema-invalid')
  })

  it('行数下限 2 / 上限 128', () => {
    expect(
      codeOf(() =>
        readTables(
          context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        keep: true
`),
        ),
      ),
    ).toBe('policy-schema-invalid')

    const rows = Array.from(
      { length: 129 },
      (_, index) => `      - id: R-${String(index)}\n        when: true\n        keep: true\n`,
    ).join('')
    expect(codeOf(() => readTables(context(`tables:\n  - id: t1\n    hit: first\n    rows:\n${rows}`)))).toBe(
      'policy-limit-exceeded',
    )
  })

  it('行 ID 必填/唯一', () => {
    expect(
      codeOf(() =>
        readTables(
          context(`tables:
  - id: t1
    hit: first
    rows:
      - id: ""
        when: true
        keep: true
      - id: R-2
        when: true
        keep: true
`),
        ),
      ),
    ).toBe('policy-schema-invalid')

    const duplicate = detailOf(() =>
      readTables(
        context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        keep: true
      - id: R-1
        when: true
        keep: true
`),
      ),
    )
    expect(duplicate['id']).toBe('R-1')
    expect(duplicate['firstLine']).toBe(5)
  })

  it('when 必须是表达式或布尔 true', () => {
    expect(
      codeOf(() =>
        readTables(
          context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: 1
        keep: true
      - id: R-2
        when: true
        keep: true
`),
        ),
      ),
    ).toBe('policy-schema-invalid')
    expect(
      codeOf(() =>
        readTables(
          context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: nope.x
        keep: true
      - id: R-2
        when: true
        keep: true
`),
        ),
      ),
    ).toBe('policy-unknown-field')
  })

  it('表达式错误的行列被映射回 YAML', () => {
    const detail = detailOf(() =>
      readTables(
        context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: 1 +
        keep: true
      - id: R-2
        when: true
        keep: true
`),
      ),
    )
    expect(detail['file']).toBe('rules.yml')
    expect(detail['line']).toBe(6)
    expect(detail['ruleId']).toBe('R-1')
  })

  it('动作：必须有且只有一个；raise 只能黄/红；keep 只接受 true', () => {
    const withAction = (action: string): string => `tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
${action}
      - id: R-2
        when: true
        keep: true
`
    expect(codeOf(() => readTables(context(withAction('        note: x'))))).toBe('policy-schema-invalid')
    expect(
      codeOf(() => readTables(context(withAction('        raise: red\n        keep: true\n        reason: daily-limit')))),
    ).toBe('policy-row-action-conflict')
    expect(codeOf(() => readTables(context(withAction('        raise: green\n        reason: daily-limit'))))).toBe(
      'policy-lower-tier',
    )
    expect(codeOf(() => readTables(context(withAction('        raise: blue\n        reason: daily-limit'))))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => readTables(context(withAction('        raise: red'))))).toBe('policy-bad-reason')
    expect(codeOf(() => readTables(context(withAction('        raise: red\n        reason: fast'))))).toBe(
      'policy-bad-reason',
    )
    expect(codeOf(() => readTables(context(withAction('        keep: false'))))).toBe('policy-schema-invalid')
    expect(codeOf(() => readTables(context(withAction('        keep: true\n        reason: fast'))))).toBe(
      'policy-bad-reason',
    )
  })

  it('deny：拒绝码格式/未声明/缺理由', () => {
    const withAction = (action: string): string => `tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
${action}
      - id: R-2
        when: true
        keep: true
`
    expect(codeOf(() => readTables(context(withAction('        deny: nope'))))).toBe('policy-bad-deny-code')
    expect(
      codeOf(() => readTables(context(withAction('        deny: policy-other\n        reason: daily-limit')))),
    ).toBe('policy-bad-deny-code')
    expect(codeOf(() => readTables(context(withAction('        deny: policy-denied'))))).toBe('policy-bad-reason')
    expect(
      readTables(context(withAction('        deny: policy-denied\n        reason: daily-limit'))).tables[0]?.rows[0]
        ?.action,
    ).toEqual({ kind: 'deny', code: 'policy-denied', reason: 'daily-limit' })
  })

  it('最后一行必须是 when: true', () => {
    expect(
      codeOf(() =>
        readTables(
          context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        keep: true
      - id: R-2
        when: state.riskyCallsInTurn > 1
        keep: true
`),
        ),
      ),
    ).toBe('policy-missing-default')
  })

  it('lower / level 字段按"降级"报码', () => {
    expect(codeOf(() => readTables(context('tables:\n  - id: t1\n    lower: green\n    rows: []\n')))).toBe(
      'policy-lower-tier',
    )
    expect(
      codeOf(() =>
        readTables(
          context(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        level: yellow
        keep: true
      - id: R-2
        when: true
        keep: true
`),
        ),
      ),
    ).toBe('policy-lower-tier')
  })
})

describe('evaluateIr', () => {
  it('appliesTo / requires 跳过整表；raise 只升不降', () => {
    const ir = irOf(BASE_RULES)
    expect(evaluateIr(ir, input({ preview: undefined }))).toEqual({
      level: 'yellow',
      reason: 'declared',
      ruleIds: [],
      tables: [],
    })
    expect(evaluateIr(ir, input())).toEqual({
      level: 'red',
      reason: 'daily-limit',
      ruleIds: ['R-001'],
      tables: ['t1'],
    })
    expect(
      evaluateIr(
        ir,
        input({
          preview: { amountCents: 1, dailyUsedCents: 0, dailyLimitCents: 1, payee: { binding: 'new' } },
        }),
      ),
    ).toEqual({
      level: 'yellow',
      reason: 'declared',
      ruleIds: ['R-002'],
      tables: ['t1'],
    })
  })

  it('raise yellow 从 green 起跳；keep 可改理由；多表按序执行', () => {
    const ir = irOf(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        raise: yellow
        reason: daily-limit
      - id: R-2
        when: true
        keep: true
  - id: t2
    hit: first
    rows:
      - id: R-3
        when: true
        keep: true
        reason: risky-calls
      - id: R-4
        when: true
        keep: true
`)
    expect(evaluateIr(ir, input({ preview: undefined }))).toEqual({
      level: 'yellow',
      reason: 'risky-calls',
      ruleIds: ['R-1', 'R-3'],
      tables: ['t1', 't2'],
    })
  })

  it('deny 是终态：返回时不再执行后续表', () => {
    const ir = irOf(`tables:
  - id: t1
    hit: first
    rows:
      - id: R-1
        when: true
        deny: policy-denied
        reason: declared
      - id: R-9
        when: true
        keep: true
  - id: t2
    hit: first
    rows:
      - id: R-2
        when: true
        keep: true
      - id: R-8
        when: true
        keep: true
`)
    expect(evaluateIr(ir, input())).toEqual({
      level: 'yellow',
      reason: 'declared',
      deny: { code: 'policy-denied', reason: 'declared' },
      ruleIds: ['R-1'],
      tables: ['t1'],
    })
  })

  it('maxLevel 取高不取低', () => {
    expect(maxLevel('green', 'yellow')).toBe('yellow')
    expect(maxLevel('red', 'yellow')).toBe('red')
    expect(maxLevel('yellow', 'yellow')).toBe('yellow')
  })
})

/** 一行（表达式来自源码，便于覆盖各种形态）。 */
function row(id: string, when: string, action: IrAction = { kind: 'keep' }): ParsedTable['rows'][number] {
  return {
    id,
    when: toIr(parseExpression(when)),
    ast: parseExpression(when),
    action,
    loc: { line: 1, column: 1 },
  }
}

/** 单表。 */
function table(rows: ParsedTable['rows']): ParsedTable[] {
  return [{ id: 't0', rows, loc: { line: 1, column: 1 } }]
}

/** 多表。 */
function tableList(tables: ParsedTable['rows'][]): ParsedTable[] {
  return tables.map((rows, index) => ({ id: `t${String(index)}`, rows, loc: { line: 1, column: 1 } }))
}

/** 分析上下文（默认无参数，避免"参数未用"干扰其它断言）。 */
function analyzeContext(params: Record<string, ParamSpec> = {}): AnalyzeContext {
  return { source: parseYaml('tables: []\n', 'rules.yml'), params }
}

/** 跑一次分析，返回错误码或 `ok`。 */
function analyzeCode(tables: ParsedTable[], params: Record<string, ParamSpec> = {}): string {
  try {
    analyzeTables(tables, analyzeContext(params))
  } catch (error) {
    return (error as { code: string }).code
  }
  return 'ok'
}

describe('analyzeTables', () => {
  it('同一谓词重复 → 后一行不可达', () => {
    expect(
      analyzeCode(table([row('R-1', 'state.riskyCallsInTurn > 1'), row('R-2', 'state.riskyCallsInTurn > 1')])),
    ).toBe('policy-unreachable-row')
  })

  it('区间包含 → 后一行不可达（<、<=、>、>=、==、!=）', () => {
    const cases: [string, string][] = [
      ['state.riskyCallsInTurn < 5', 'state.riskyCallsInTurn < 5'],
      ['state.riskyCallsInTurn < 5', 'state.riskyCallsInTurn <= 4'],
      ['state.riskyCallsInTurn <= 5', 'state.riskyCallsInTurn < 6'],
      ['state.riskyCallsInTurn > 5', 'state.riskyCallsInTurn >= 6'],
      ['state.riskyCallsInTurn >= 6', 'state.riskyCallsInTurn > 5'],
      ['state.riskyCallsInTurn > 5', 'state.riskyCallsInTurn > 5'],
      ['state.riskyCallsInTurn == 5', 'state.riskyCallsInTurn == 5'],
      ['state.riskyCallsInTurn != 5', 'state.riskyCallsInTurn != 5'],
      ['preview.payee.binding == "new"', 'preview.payee.binding == "new"'],
    ]
    for (const [first, second] of cases) {
      expect(analyzeCode(table([row('R-1', first), row('R-2', second)]))).toBe('policy-unreachable-row')
    }
  })

  it('不同路径 / 无法证明覆盖时不报', () => {
    expect(
      analyzeCode(table([row('R-1', 'state.riskyCallsInTurn > 1'), row('R-2', 'state.verifyLocked == true')])),
    ).toBe('ok')
    expect(
      analyzeCode(table([row('R-1', 'state.riskyCallsInTurn > 5'), row('R-2', 'state.riskyCallsInTurn < 3')])),
    ).toBe('ok')
    expect(
      analyzeCode(table([row('R-1', '5 == state.riskyCallsInTurn'), row('R-2', '6 == state.riskyCallsInTurn')])),
    ).toBe('ok')
    expect(
      analyzeCode(table([row('R-1', '5 != state.riskyCallsInTurn'), row('R-2', '6 != state.riskyCallsInTurn')])),
    ).toBe('ok')
    expect(
      analyzeCode(table([row('R-1', 'state.riskyCallsInTurn == "a"'), row('R-2', 'true')])),
    ).toBe('ok')
    expect(analyzeCode(table([row('R-1', 'level != "green"'), row('R-2', 'true')]))).toBe('ok')
    expect(
      analyzeCode(table([row('R-1', 'state.riskyCallsInTurn < "a"'), row('R-2', 'true')])),
    ).toBe('ok')
  })

  it('镜像写法（常量在左）也能证明覆盖', () => {
    expect(
      analyzeCode(table([row('R-1', '6 < state.riskyCallsInTurn'), row('R-2', '5 < state.riskyCallsInTurn')])),
    ).toBe('policy-unreachable-row')
    expect(
      analyzeCode(table([row('R-1', '5 <= state.riskyCallsInTurn'), row('R-2', '4 <= state.riskyCallsInTurn')])),
    ).toBe('policy-unreachable-row')
    expect(
      analyzeCode(table([row('R-1', '5 > state.riskyCallsInTurn'), row('R-2', '6 > state.riskyCallsInTurn')])),
    ).toBe('policy-unreachable-row')
    expect(
      analyzeCode(table([row('R-1', '5 >= state.riskyCallsInTurn'), row('R-2', '6 >= state.riskyCallsInTurn')])),
    ).toBe('policy-unreachable-row')
  })

  it('常量折叠覆盖一元/逻辑/未知运算符（坏 IR 不误报）', () => {
    expect(analyzeCode(table([row('R-1', '-1 == -1'), row('R-2', 'true')]))).toBe('ok')
    expect(analyzeCode(table([row('R-1', '!(1 > 2)'), row('R-2', 'true')]))).toBe('ok')
    expect(analyzeCode(table([row('R-1', '-"a" == "b"'), row('R-2', 'true')]))).toBe('ok')
    expect(analyzeCode(table([row('R-1', '(true && true) == true'), row('R-2', 'true')]))).toBe('ok')
    expect(analyzeCode(table([row('R-1', '(false || true) == true'), row('R-2', 'true')]))).toBe('ok')
    const corrupted = {
      ...row('R-1', 'true'),
      when: { op: 'xor', left: { int: 1 }, right: { int: 1 } } as unknown as IrExpr,
    }
    expect(analyzeCode(table([corrupted, row('R-2', 'true')]))).toBe('ok')
  })

  it('恒假：常量折叠与值域', () => {
    const unsat = [
      'false',
      '!true',
      '1 > 2',
      '1 + 1 == 3',
      '2 - 1 == 2',
      '2 * 2 == 5',
      '1 < 1',
      '1 <= 0',
      '1 > 1',
      '1 >= 2',
      '"a" == "b"',
      '"a" != "a"',
      'true && false',
      'false || false',
      'state.riskyCallsInTurn < 0',
      'state.riskyCallsInTurn <= -1',
      'state.riskyCallsInTurn > 100',
      'state.riskyCallsInTurn >= 101',
      'state.riskyCallsInTurn == 101',
      'params.riskyCallThreshold == 0',
      'preview.payee.binding == "other"',
      'level == "blue"',
    ]
    for (const when of unsat) {
      expect({ when, code: analyzeCode(table([row('R-1', when), row('R-2', 'true')]), PARAMS) }).toEqual({
        when,
        code: 'policy-unsatisfiable-row',
      })
    }
  })

  it('恒真表达式不误报', () => {
    expect(analyzeCode(table([row('R-1', 'state.riskyCallsInTurn >= 0'), row('R-2', 'true')]))).toBe('ok')
    expect(analyzeCode(table([row('R-1', 'true || false'), row('R-2', 'true')]))).toBe('ok')
  })

  it('参数声明了没人用 → 报错', () => {
    expect(analyzeCode(table([row('R-1', 'true')]), PARAMS)).toBe('policy-param-unused')
  })

  it('deny 排在 raise 表之后 → 告警（不阻断）', () => {
    const warnings = analyzeTables(
      tableList([
        [row('R-1', 'true', { kind: 'raise', to: 'red', reason: 'daily-limit' })],
        [row('R-2', 'true', { kind: 'deny', code: 'policy-denied', reason: 'declared' })],
      ]),
      analyzeContext(),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('policy-deny-order')
  })

  it('没有 deny 时不告警', () => {
    expect(analyzeTables(table([row('R-1', 'true')]), analyzeContext())).toEqual([])
  })
})
