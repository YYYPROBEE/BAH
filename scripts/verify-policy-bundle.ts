/**
 * 门禁：策略 bundle 编译、内容寻址与负例自检（03 §7.1）。
 *
 * 七条判据（与 03 §7.1 一一对应）：
 * 1. 发现 `policies/**\/bundle.yml`（排除 `fixtures/`），逐个编译；
 * 2. `lock.json` 必须存在，且**整份**（摘要 + 文件清单 + 字节数）与现场一致；
 * 3. manifest 必填字段 / semver / 目录一致 / 引擎范围由编译器校验；
 * 4. `rulesFile` / `corpusFile` 只能是 bundle 内简单文件名（编译器拒绝路径穿越）；
 * 5. 大小 / 表 / 行 / 深度上限由编译器校验；
 * 6. `policies/fixtures/invalid/expected.json` 的每个负例必须**恰好**失败在声明的错误码上；
 * 7. `demo: true` 的 bundle 只要求编译/语料通过，**不要求**与 legacy 等价（由 registry 标记）。
 *
 * 为什么还要比整份 lock：`compileBundle` 的 `verifyLock` 只比两个摘要，
 * 有人把 `files` 数组删掉、字节数改掉，摘要仍然对得上——那不是"摘要覆盖"，
 * 是"摘要覆盖了一部分"。门禁把 lock 的完整形状也钉住。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

import { BANK_TOOL_NAME_SET } from '../packages/bank/src/tools/specs.ts'
import { canonicalJson } from '../packages/util/src/index.ts'
import { compileBundle } from '../packages/policy/src/compile.ts'
import { describePolicyError } from '../packages/policy/src/errors.ts'
import { loadBundle, loadRuleBundle, readBundleFiles } from '../packages/policy/src/load.ts'
import { checkRuleCases } from '../packages/policy/src/sentry-rules.ts'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 负例清单（每一行是一个"应红即红"的证明）。 */
const FIXTURE_MANIFEST = 'policies/fixtures/invalid/expected.json'

/** 负例数量下限：就是当前数；删负例必须同步改这里，不能静默变少。 */
const MIN_FIXTURES = 27

const gate: Gate = {
  name: 'policy-bundle',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    const toolNames = [...BANK_TOOL_NAME_SET]

    const bundleDirs = walk(root, ['policies'], (name) => name === 'bundle.yml')
      .map((file) => dirname(file))
      .filter((dir) => !relative(root, dir).replace(/\\/g, '/').includes('/fixtures/'))
      .sort()

    let compiled = 0
    for (const dir of bundleDirs) {
      const rel = relative(root, dir).replace(/\\/g, '/')
      if (!existsSync(join(dir, 'lock.json'))) {
        findings.push(`${rel}: 缺 lock.json（生产 bundle 必须内容寻址）`)
        continue
      }
      try {
        const kind = peekKind(join(dir, 'bundle.yml'))
        const result =
          kind === 'sentry.rules'
            ? loadRuleBundle({ dir, toolNames: [], verifyLock: true })
            : loadBundle({ dir, toolNames, verifyLock: true, withCorpus: true })
        compiled += 1
        verifyFullLock(root, dir, rel, result.lock, findings)
        if (kind === 'sentry.rules') {
          const ruleset = result as ReturnType<typeof loadRuleBundle>
          const failures = checkRuleCases(ruleset.compiled)
          for (const failure of failures) findings.push(`${rel}: ${failure}`)
          notes.push(
            `${rel}: sentry 规则集 ${String(ruleset.compiled.rules.length)} 条，语料 ${
              String(ruleset.compiled.ir.rules.reduce((sum, rule) => sum + rule.cases.match.length + rule.cases.nonMatch.length, 0))
            } 例`,
          )
        } else if ((result as ReturnType<typeof loadBundle>).compiled.warnings.length > 0) {
          notes.push(
            `${rel}: ${String((result as ReturnType<typeof loadBundle>).compiled.warnings.length)} 条非阻断告警（deny 顺序）`,
          )
        }
      } catch (error) {
        const described = describePolicyError(error)
        findings.push(`${rel}: 编译失败 ${described.code} —— ${described.message}`)
      }
    }
    notes.push(`编译通过 ${String(compiled)}/${String(bundleDirs.length)} 个生产/演示 bundle`)

    // 签名路径的负例：`requireSignature: true` 时，无签名的 bundle 必须拒绝。
    if (bundleDirs[0] !== undefined) {
      try {
        loadBundle({
          dir: bundleDirs[0],
          toolNames,
          verifyLock: true,
          withCorpus: false,
          requireSignature: true,
        })
        findings.push('负例自检失败：requireSignature=true 但无 bundle.sig 仍被载入')
      } catch (error) {
        const code = describePolicyError(error).code
        if (code !== 'policy-signature-invalid') {
          findings.push(`负例自检失败：requireSignature 的错误码是 ${code}，期望 policy-signature-invalid`)
        }
      }
    }

    const fixtureCount = checkFixtures(root, toolNames, findings, notes)
    if (fixtureCount < MIN_FIXTURES) {
      findings.push(`${FIXTURE_MANIFEST}: 负例只有 ${String(fixtureCount)} 个，少于下限 ${String(MIN_FIXTURES)}`)
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 读 bundle.yml 的 kind（分派编译器；读不出来就让后面编译报错）。 */
function peekKind(manifestPath: string): string {
  const text = readFileSync(manifestPath, 'utf8')
  const matched = /^kind:\s*([A-Za-z0-9._-]+)\s*$/m.exec(text)
  return matched?.[1] ?? 'unknown'
}

/** `lock.json` 必须与编译产物**逐字段**一致（不只两个摘要）。 */
function verifyFullLock(
  root: string,
  dir: string,
  rel: string,
  computed: unknown,
  findings: string[],
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8'))
  } catch {
    findings.push(`${rel}/lock.json: 不是合法 JSON`)
    return
  }
  const expected = canonicalJson(computed)
  const actual = canonicalJson(parsed)
  if (actual !== expected) {
    findings.push(`${rel}/lock.json: 与编译产物不一致（文件清单/字节数/摘要任一不符都要重编译）`)
  }
  void root
}

/** 编译全部负例；返回夹具数量。 */
function checkFixtures(
  root: string,
  toolNames: readonly string[],
  findings: string[],
  notes: string[],
): number {
  const manifestPath = join(root, FIXTURE_MANIFEST)
  if (!existsSync(manifestPath)) {
    findings.push(`缺 ${FIXTURE_MANIFEST}（负例自检没有清单，等于没有负例）`)
    return 0
  }
  let manifest: { cases?: unknown }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { cases?: unknown }
  } catch {
    findings.push(`${FIXTURE_MANIFEST}: 不是合法 JSON`)
    return 0
  }
  if (typeof manifest.cases !== 'object' || manifest.cases === null) {
    findings.push(`${FIXTURE_MANIFEST}: cases 必须是对象`)
    return 0
  }
  const cases = manifest.cases as Record<string, unknown>
  let count = 0
  for (const [fixture, expectedCode] of Object.entries(cases)) {
    count += 1
    if (typeof expectedCode !== 'string') {
      findings.push(`${FIXTURE_MANIFEST}: ${fixture} 的期望错误码不是字符串`)
      continue
    }
    const dir = join(root, 'policies', 'fixtures', 'invalid', ...fixture.split('/'))
    if (!existsSync(dir)) {
      findings.push(`负例 ${fixture}: 目录不存在`)
      continue
    }
    try {
      compileBundle(
        { dir: relative(root, dir).replace(/\\/g, '/'), files: readBundleFiles(dir).files },
        { toolNames, verifyLock: true },
      )
      findings.push(`负例 ${fixture}: 意外编译成功（期望 ${expectedCode}）`)
    } catch (error) {
      const actual = describePolicyError(error).code
      if (actual !== expectedCode) {
        findings.push(`负例 ${fixture}: 错误码是 ${actual}，期望 ${expectedCode}`)
      }
    }
  }
  notes.push(`负例 ${String(count)} 个：逐条断言错误码（含降级/重复/不可达/缺默认/未知工具/浮点/正则/时钟）`)
  return count
}

if (isMainModule(import.meta.url)) await runStandalone(gate)

export { gate }
