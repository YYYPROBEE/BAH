/**
 * `sentry.rules` 编译器（策略外置 S5 / 03 §6）。
 *
 * 所有用例都从**仓库里的真实 bundle** 出发做一处变形：测的是生产件，不是另一份手写样例。
 * 重点三块：正则安全子集、语料形状（2 正 + 2 反）、lock/目录一致性。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  checkRuleCases,
  compileRuleBundle,
  type SentryCompileOptions,
} from './sentry-rules.ts'
import { SENTRY_RULE_LIMITS } from './limits.ts'
import { loadRuleBundle, peekBundleKind, readBundleFiles, writeRuleLockFile } from './load.ts'
import { signPayload, signingPayload } from './signature.ts'
import { POLICY_ERROR_CODES } from './errors.ts'

const DIR = 'policies/sentry-rules/1.0.0'
const REAL_DIR = join(process.cwd(), DIR)
const OPTIONS: SentryCompileOptions = { verifyLock: false }

/** 读真实 bundle 的文件内容。 */
function realFiles(): Record<string, string> {
  return { ...readBundleFiles(REAL_DIR).files }
}

/** 在真实 bundle 上改一处。 */
function mutate(file: string, change: (text: string) => string): Record<string, string> {
  const files = realFiles()
  const before = files[file]
  if (before === undefined) throw new Error(`missing ${file}`)
  files[file] = change(before)
  return files
}

function codeOf(read: () => unknown): string {
  try {
    read()
    return 'no-throw'
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown'
  }
}

function compile(files: Record<string, string>): ReturnType<typeof compileRuleBundle> {
  return compileRuleBundle({ dir: DIR, files }, OPTIONS)
}

describe('sentry.rules · 编译与身份', () => {
  it('真实 bundle：13 条规则、身份串与语料全通过', () => {
    const result = compile(realFiles())
    expect(result.compiled.descriptor.kind).toBe('sentry.rules')
    expect(result.compiled.descriptor.handle).toBe('sentry-rules/1.0.0')
    expect(result.compiled.descriptor.policyVersion).toMatch(/^sentry-rules\/1\.0\.0\+sha256:[0-9a-f]{16}$/)
    expect(result.compiled.rules).toHaveLength(13)
    expect(new Set(result.compiled.rules.map((rule) => rule.id)).size).toBe(13)
    expect(checkRuleCases(result.compiled)).toEqual([])
    expect(result.lock.kind).toBe('sentry.rules')
    expect(result.lock.semanticDigest).toBe(result.compiled.descriptor.semanticDigest)
  })

  it('目录/版本不一致 → policy-version-mismatch', () => {
    const files = mutate('bundle.yml', (text) => text.replace('version: 1.0.0', 'version: 1.0.1'))
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-version-mismatch')
  })

  it('引擎范围不覆盖当前版本 → policy-engine-incompatible', () => {
    const files = mutate('bundle.yml', (text) =>
      text.replace('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 9.0.0, max: 9.x }'),
    )
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe(
      'policy-engine-incompatible',
    )
  })

  it('lock 摘要不符 → policy-digest-mismatch', () => {
    const files = realFiles()
    files['lock.json'] = JSON.stringify({ semanticDigest: 'deadbeef', sourceDigest: 'deadbeef' })
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, { verifyLock: true }))).toBe(
      'policy-digest-mismatch',
    )
  })

  it('总字节超 128 KiB → policy-limit-exceeded', () => {
    const files = mutate('CHANGELOG.md', () => 'x'.repeat(SENTRY_RULE_LIMITS.maxBundleBytes + 1))
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe(
      'policy-limit-exceeded',
    )
  })
})

describe('sentry.rules · 正则安全子集', () => {
  const unsafe: readonly [string, (text: string) => string][] = [
    ['反向引用', (text) => text.replace("pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'", "pattern: '(a)\\1'")],
    ['lookbehind', (text) => text.replace("pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'", "pattern: '(?<=x)y'")],
    ['嵌套量词', (text) => text.replace("pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'", "pattern: '(a+)+'")],
    ['多段通配', (text) => text.replace("pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'", "pattern: '.*.*'")],
    ['非法正则', (text) => text.replace("pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'", "pattern: '('")],
    [
      '超长正则',
      (text) =>
        text.replace("pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'", `pattern: '${'a'.repeat(300)}'`),
    ],
    [
      '超长字符类',
      (text) =>
        text.replace(
          "pattern: '\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)'",
          `pattern: '[${'a'.repeat(SENTRY_RULE_LIMITS.maxCharClassChars + 1)}]'`,
        ),
    ],
  ]

  for (const [name, change] of unsafe) {
    it(`${name} → policy-regex-unsafe`, () => {
      const files = mutate('bundle.yml', change)
      expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe(
        'policy-regex-unsafe',
      )
    })
  }

  it('不允许的 flag（g/y/u/d）→ policy-regex-unsafe', () => {
    const files = mutate('bundle.yml', (text) => text.replace('    flags: i\n', '    flags: g\n'))
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe(
      'policy-regex-unsafe',
    )
  })

  it('内置规则的"字面量锚定重复"形态仍放行（CMD-001 的 (-x{1,2}\\s*)+）', () => {
    const result = compile(realFiles())
    const cmd = result.compiled.rules.find((rule) => rule.id === 'CMD-001')
    expect(cmd?.pattern.source).toBe('\\brm\\s+(-[rfRF]{1,2}\\s*)+(\\S+)')
  })
})

describe('sentry.rules · 语料与规则形状', () => {
  it('每条规则少于 2 正例 → policy-schema-invalid', () => {
    const files = mutate('bundle.yml', (text) =>
      text.replace("      match: ['rm -rf /tmp/data', 'sudo rm -RF ~']", "      match: ['rm -rf /tmp/data']"),
    )
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-schema-invalid')
  })

  it('规则 ID 重复 → policy-duplicate-rule', () => {
    const files = mutate('bundle.yml', (text) => text.replace('  - id: CMD-002', '  - id: CMD-001'))
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-duplicate-rule')
  })

  it('未知族 → policy-schema-invalid', () => {
    const files = mutate('bundle.yml', (text) =>
      text.replace('    family: destructive\n    note: 递归强删', '    family: unknown-family\n    note: 递归强删'),
    )
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-schema-invalid')
  })

  it('checkRuleCases 能抓出语料与正则不一致（编译期不假装执行）', () => {
    const files = mutate('bundle.yml', (text) =>
      text.replace("      match: ['rm -rf /tmp/data', 'sudo rm -RF ~']", "      match: ['rm file.txt', 'sudo rm -RF ~']"),
    )
    const result = compile(files)
    expect(checkRuleCases(result.compiled)).toEqual(['CMD-001: 正例未命中：rm file.txt'])
  })
})

describe('sentry.rules · 错误码表', () => {
  it('policy-regex-unsafe 已登记（错误码是契约，只增不改名）', () => {
    expect(POLICY_ERROR_CODES).toContain('policy-regex-unsafe')
  })
})

/** 最小合法规则集（结构错误用例从这里改一行，避免和真实 bundle 的字段互相牵制）。 */
function minimalBundle(ruleLines: string[], manifestEdits: Record<string, string> = {}): Record<string, string> {
  const merged = {
    'apiVersion: bah.policy/v1': 'bah.policy/v1',
    'kind: sentry.rules': 'sentry.rules',
    'name: sentry-rules': 'sentry-rules',
    'version: 1.0.0': '1.0.0',
    'description: 最小规则集（测试夹具）': '最小规则集（测试夹具）',
    'owners: [test]': '[test]',
    'schema: sentry.rules.input/v1': 'sentry.rules.input/v1',
    'engine: { min: 1.0.0, max: 1.x }': '{ min: 1.0.0, max: 1.x }',
    ...manifestEdits,
  }
  const lines = [
    `apiVersion: ${merged['apiVersion: bah.policy/v1']}`,
    `kind: ${merged['kind: sentry.rules']}`,
    `name: ${merged['name: sentry-rules']}`,
    `version: ${merged['version: 1.0.0']}`,
    `description: ${merged['description: 最小规则集（测试夹具）']}`,
    `owners: ${merged['owners: [test]']}`,
    `schema: ${merged['schema: sentry.rules.input/v1']}`,
    `engine: ${merged['engine: { min: 1.0.0, max: 1.x }']}`,
    'rules:',
    ...ruleLines,
  ]
  return { 'bundle.yml': lines.join('\n'), 'CHANGELOG.md': '# test\n' }
}

const VALID_RULE = [
  '  - id: CMD-001',
  '    family: destructive',
  '    note: 测试规则',
  "    pattern: 'rm -rf'",
  '    cases:',
  "      match: ['rm -rf /', 'rm -rf x']",
  "      nonMatch: ['rm x', 'ls']",
]

describe('sentry.rules · manifest 字段', () => {
  const manifestCases: readonly [string, Record<string, string>, string][] = [
    ['apiVersion 错', { 'apiVersion: bah.policy/v1': 'bah.policy/v2' }, 'policy-schema-invalid'],
    ['kind 错', { 'kind: sentry.rules': 'sentry.other' }, 'policy-schema-invalid'],
    ['version 非 semver', { 'version: 1.0.0': 'v1' }, 'policy-bad-semver'],
    ['description 过短', { 'description: 最小规则集（测试夹具）': 'x' }, 'policy-schema-invalid'],
    ['owners 为空', { 'owners: [test]': '[]' }, 'policy-schema-invalid'],
    ['schema 错', { 'schema: sentry.rules.input/v1': 'x/v1' }, 'policy-schema-invalid'],
    ['owners 非字符串数组', { 'owners: [test]': '[1]' }, 'policy-schema-invalid'],
    ['engine 非对象', { 'engine: { min: 1.0.0, max: 1.x }': '1' }, 'policy-schema-invalid'],
    ['engine.min 非 semver', { 'engine: { min: 1.0.0, max: 1.x }': '{ min: x, max: 1.x }' }, 'policy-bad-semver'],
    ['engine.max 非法', { 'engine: { min: 1.0.0, max: 1.x }': '{ min: 1.0.0, max: bad }' }, 'policy-bad-semver'],
    ['未知 manifest 键', { 'kind: sentry.rules': 'sentry.rules\nnope: 1' }, 'policy-unknown-key'],
  ]

  for (const [name, edits, expected] of manifestCases) {
    it(`${name} → ${expected}`, () => {
      const files = minimalBundle(VALID_RULE, edits)
      expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe(expected)
    })
  }

  it('engine.max 精确版本（非通配）也走比较分支', () => {
    const files = minimalBundle(VALID_RULE, { 'engine: { min: 1.0.0, max: 1.x }': '{ min: 1.0.0, max: 1.0.0 }' })
    expect(compileRuleBundle({ dir: DIR, files }, OPTIONS).compiled.rules).toHaveLength(1)
  })

  it('缺 bundle.yml → policy-parse-error', () => {
    expect(
      codeOf(() => compileRuleBundle({ dir: DIR, files: { 'CHANGELOG.md': '# x\n' } }, OPTIONS)),
    ).toBe('policy-parse-error')
  })

  it('bundle.yml 根节点非对象 → policy-schema-invalid', () => {
    expect(
      codeOf(() =>
        compileRuleBundle({ dir: DIR, files: { 'bundle.yml': '- a\n', 'CHANGELOG.md': '# x\n' } }, OPTIONS),
      ),
    ).toBe('policy-schema-invalid')
  })

  it('rules 不是数组 → policy-schema-invalid', () => {
    const files = minimalBundle(VALID_RULE, { 'kind: sentry.rules': 'sentry.rules' })
    const manifest = files['bundle.yml'] ?? ''
    files['bundle.yml'] = manifest.replace(/^rules:[\s\S]*$/m, 'rules: {}')
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-schema-invalid')
  })

  it('缺 CHANGELOG.md → policy-corpus-missing', () => {
    const files = minimalBundle(VALID_RULE)
    delete files['CHANGELOG.md']
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-corpus-missing')
  })
})

describe('sentry.rules · 规则字段（逐条 fail-loud）', () => {
  const ruleCases: readonly [string, string[], string][] = [
    ['规则不是对象', ['  - 1'], 'policy-schema-invalid'],
    ['ID 形状非法', ['  - id: BAD', ...VALID_RULE.slice(1)], 'policy-schema-invalid'],
    ['note 过短', [...VALID_RULE.slice(0, 2), '    note: x', ...VALID_RULE.slice(3)], 'policy-schema-invalid'],
    ['flags 非字符串', [...VALID_RULE.slice(0, 4), '    flags: 1', ...VALID_RULE.slice(4)], 'policy-schema-invalid'],
    ['cases 非对象', [...VALID_RULE.slice(0, 4), '    cases: 1'], 'policy-schema-invalid'],
    ['cases 未知键', [...VALID_RULE.slice(0, 6), '      nope: 1', ...VALID_RULE.slice(6)], 'policy-unknown-key'],
    ['match 少于 2', [...VALID_RULE.slice(0, 5), "      match: ['rm -rf /']", ...VALID_RULE.slice(6)], 'policy-schema-invalid'],
    ['nonMatch 少于 2', [...VALID_RULE.slice(0, 6), "      nonMatch: ['rm x']"], 'policy-schema-invalid'],
    ['pattern 缺失', [...VALID_RULE.slice(0, 3), ...VALID_RULE.slice(4)], 'policy-schema-invalid'],
    ['规则未知键', [...VALID_RULE.slice(0, 2), '    nope: 1', ...VALID_RULE.slice(2)], 'policy-unknown-key'],
  ]

  for (const [name, ruleLines, expected] of ruleCases) {
    it(`${name} → ${expected}`, () => {
      const files = minimalBundle(ruleLines)
      expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe(expected)
    })
  }

  it('规则数超过 64 → policy-limit-exceeded', () => {
    const generated: string[] = []
    for (let index = 1; index <= 65; index += 1) {
      const id = `CMD-${String(index).padStart(3, '0')}`
      generated.push(
        `  - id: ${id}`,
        '    family: destructive',
        '    note: 批量生成',
        "    pattern: 'x'",
        '    cases:',
        "      match: ['x', 'xx']",
        "      nonMatch: ['y', 'yy']",
      )
    }
    const files = minimalBundle(generated)
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files }, OPTIONS))).toBe('policy-limit-exceeded')
  })

  it('lock.json 不是 JSON / 根节点非对象 → 各自错误码', () => {
    const base = minimalBundle(VALID_RULE)
    const brokenJson = { ...base, 'lock.json': '{ bad' }
    const arrayRoot = { ...base, 'lock.json': '[]' }
    const options = { verifyLock: true }
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files: brokenJson }, options))).toBe(
      'policy-parse-error',
    )
    expect(codeOf(() => compileRuleBundle({ dir: DIR, files: arrayRoot }, options))).toBe(
      'policy-digest-mismatch',
    )
  })
})

describe('sentry.rules · 磁盘载入与签名', () => {
  /** 把真实 bundle 落到临时目录（可选追加 bundle.sig）。 */
  function installTmp(sig?: string): string {
    const root = mkdtempSync(join(tmpdir(), 'bah-sentry-load-'))
    const dir = join(root, 'sentry-rules', '1.0.0')
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(realFiles())) {
      writeFileSync(join(dir, name), content, 'utf8')
    }
    if (sig !== undefined) writeFileSync(join(dir, 'bundle.sig'), sig, 'utf8')
    return dir
  }

  /** installTmp 的清理（临时根是 bundle 目录的上两级）。 */
  function cleanup(dir: string): void {
    rmSync(join(dir, '..', '..'), { recursive: true, force: true })
  }

  it('writeRuleLockFile + loadRuleBundle：lock 一致、peekBundleKind 正确', () => {
    const dir = installTmp()
    try {
      const first = loadRuleBundle({ dir, toolNames: [], verifyLock: false })
      writeRuleLockFile(dir, first.lock)
      const second = loadRuleBundle({ dir, toolNames: [], verifyLock: true })
      expect(second.lock.semanticDigest).toBe(first.lock.semanticDigest)
      expect(peekBundleKind(dir)).toBe('sentry.rules')
    } finally {
      cleanup(dir)
    }
  })

  it('签名 bundle：公钥正确时载入通过；缺公钥/强制签名无 sig 各自拒绝', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const dir = installTmp()
    try {
      const compiled = loadRuleBundle({ dir, toolNames: [], verifyLock: false })
      const payload = signingPayload(compiled.compiled.ir, compiled.compiled.descriptor)
      const signature = signPayload(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), payload)
      writeFileSync(join(dir, 'bundle.sig'), JSON.stringify({ keyVersion: 1, value: signature }), 'utf8')

      const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
      const signed = loadRuleBundle({ dir, toolNames: [], verifyLock: false, publicKeyPem: pem })
      expect(signed.compiled.descriptor.handle).toBe('sentry-rules/1.0.0')

      expect(
        codeOf(() => loadRuleBundle({ dir, toolNames: [], verifyLock: false })),
      ).toBe('policy-signature-invalid')
      expect(
        codeOf(() =>
          loadRuleBundle({ dir, toolNames: [], verifyLock: false, requireSignature: true, publicKeyPem: pem }),
        ),
      ).toBe('no-throw')
      expect(
        codeOf(() =>
          loadRuleBundle({
            dir: installTmp(),
            toolNames: [],
            verifyLock: false,
            requireSignature: true,
            publicKeyPem: pem,
          }),
        ),
      ).toBe('policy-signature-invalid')
    } finally {
      cleanup(dir)
    }
  })

  it('peekBundleKind：缺 bundle.yml / 根节点非对象 → 各自错误码', () => {
    const missing = mkdtempSync(join(tmpdir(), 'bah-sentry-peek-'))
    try {
      expect(codeOf(() => peekBundleKind(missing))).toBe('policy-parse-error')
      writeFileSync(join(missing, 'bundle.yml'), '- a\n', 'utf8')
      expect(codeOf(() => peekBundleKind(missing))).toBe('policy-schema-invalid')
    } finally {
      rmSync(missing, { recursive: true, force: true })
    }
  })

  it('bundle.yml 字节与 lock 覆盖：lock.files 只有 manifest 与 CHANGELOG', () => {
    const result = compile(realFiles())
    expect(result.lock.files.map((file) => file.name)).toEqual(['CHANGELOG.md', 'bundle.yml'])
    expect(readFileSync(join(REAL_DIR, 'lock.json'), 'utf8')).toContain('"kind": "sentry.rules"')
  })
})
