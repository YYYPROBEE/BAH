/**
 * 属性测试（04 §4 / PE-18）。
 *
 * 固定种子、固定 10000 组：失败可复现。断言不是"举几个例子"，而是**语义不变量**：
 * 单调、确定、总函数、输入不可变、规则完备、理由合法、输出不含金额。
 *
 * 生成器只喂合法输入（`validateInput` 把关），因为"坏输入"由 schema 测试与负控覆盖；
 * 这里要证明的是"合法输入域上，求值器不会做出违反不变量的判决"。
 */

import { describe, expect, it } from 'vitest'

import { canonicalJson } from '@bah/util'

import { compileBundle } from './compile.ts'
import type { BankTierInput, TierLevel } from './schema.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'policies/bank-tier/1.0.0'
const TOOLS = ['transfer_create', 'wealth_purchase', 'sub_cancel', 'card_report_lost']
const LEVELS: readonly TierLevel[] = ['green', 'yellow', 'red']
const RANK: Record<TierLevel, number> = { green: 0, yellow: 1, red: 2 }

/** 固定种子的 LCG（与仓内 `seededRandom` 同思路，不引第三方）。 */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

const random = rng(0xba11)

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T
}

function int(max: number): number {
  return Math.floor(random() * (max + 1))
}

/** 生成一个合法输入。 */
function generate(): unknown {
  const name = pick(TOOLS)
  const withPreview = name === 'transfer_create' && random() < 0.85
  return {
    subject: { userId: 'u-1', sessionId: `s-${String(int(9))}` },
    action: { name, declared: pick(LEVELS) },
    ...(withPreview
      ? {
          preview: {
            amountCents: int(900_000),
            dailyUsedCents: int(900_000),
            dailyLimitCents: int(1_000_000),
            payee: { binding: pick(['new', 'whitelist']) },
          },
        }
      : {}),
    state: { riskyCallsInTurn: int(10), verifyLocked: random() < 0.3 },
    limits: { dailyLimitCents: int(1_000_000) },
    params: { riskyCallThreshold: 1 + int(99) },
  }
}

function realFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of ['bundle.yml', 'rules.yml', 'corpus.yml', 'CHANGELOG.md']) {
    files[name] = readFileSync(join(process.cwd(), DIR, name), 'utf8')
  }
  return files
}

describe('求值器属性（10000 组，种子 0xBA11）', () => {
  const compiled = compileBundle({ dir: DIR, files: realFiles() }, {
    toolNames: TOOLS,
    verifyLock: true,
  }).compiled

  it('单调 / 确定 / 总函数 / 输入不可变 / 规则完备 / 理由合法 / 输出不含金额', () => {
    for (let index = 0; index < 10_000; index += 1) {
      const input: BankTierInput = compiled.validateInput(generate())

      // 输入不可变：冻结后的对象在求值前后 canonical 相等
      const before = canonicalJson(input)
      const first = compiled.evaluate(input)
      expect(canonicalJson(input)).toBe(before)

      // 确定：同输入两次全等（含 ruleIds 顺序）
      const second = compiled.evaluate(input)
      expect(canonicalJson(second)).toBe(canonicalJson(first))

      // 单调：只会加严，不会降级
      expect(RANK[first.level]).toBeGreaterThanOrEqual(RANK[input.action.declared])

      // 理由合法
      expect(compiled.ir.reasons).toContain(first.reason)

      // 规则完备：适用的表至少产生一个 ruleId
      if (first.tables.length > 0) expect(first.ruleIds.length).toBeGreaterThan(0)

      // 输出不含金额（策略不改钱）
      expect(canonicalJson(first)).not.toContain('amountCents')
      expect(canonicalJson(first)).not.toContain('dailyLimitCents')
    }
  })

  it('同一输入在 100 次重复求值下完全稳定（防隐藏状态）', () => {
    const input = compiled.validateInput(generate())
    const baseline = canonicalJson(compiled.evaluate(input))
    for (let index = 0; index < 100; index += 1) {
      expect(canonicalJson(compiled.evaluate(input))).toBe(baseline)
    }
  })
})
