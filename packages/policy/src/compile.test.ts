/**
 * 编译流水线、内容寻址、签名与磁盘载入（01 §3、§6、§9）。
 *
 * 大部分错误用例都从**真实 bundle** 出发做一处变形（改一个字段/删一个文件），
 * 这样测的是生产件而不是另一份手写样例。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import {
  compileBundle,
  serializeLock,
  type BundleFiles,
  type CompileOptions,
  type PolicyLock,
} from './compile.ts'
import {
  descriptorOf,
  normalizeSourceText,
  policyVersionOf,
  semanticDigestOf,
  sourceDigestOf,
} from './canonical.ts'
import { describePolicyError, POLICY_ERROR_CODES, policyError } from './errors.ts'
import { loadBundle, readBundleFiles, writeLockFile } from './load.ts'
import { assertSigned, parseBundleSignature, signPayload, signingPayload, verifySignature } from './signature.ts'

const DIR = 'policies/bank-tier/1.0.0'
const REAL_DIR = join(process.cwd(), DIR)
const TOOLS = ['transfer_create', 'wealth_purchase', 'sub_cancel', 'card_report_lost']
const OPTIONS: CompileOptions = { toolNames: TOOLS, verifyLock: false }

/** 读真实 bundle 的文件内容。 */
function realFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  for (const name of readdirSync(REAL_DIR)) {
    files[name] = readFileSync(join(REAL_DIR, name), 'utf8')
  }
  return files
}

/** 在真实 bundle 上做变形（`undefined` = 删文件）。 */
function bundle(patch: Record<string, string | undefined> = {}): BundleFiles {
  const files = realFiles()
  for (const [name, content] of Object.entries(patch)) {
    if (content === undefined) delete files[name]
    else files[name] = content
  }
  return { dir: DIR, files }
}

/** 把 bundle.yml 的一行替换掉。 */
function manifestWith(from: string, to: string): BundleFiles {
  const files = realFiles()
  const text = files['bundle.yml'] as string
  expect(text).toContain(from)
  files['bundle.yml'] = text.replace(from, to)
  return { dir: DIR, files }
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

describe('canonical · 摘要与身份', () => {
  it('normalizeSourceText 去 BOM、统一换行', () => {
    expect(normalizeSourceText('\uFEFFa\r\nb\rc')).toBe('a\nb\nc')
  })

  it('语义摘要只覆盖行为：注释/缩进/键序/CRLF 都不变', () => {
    const base = compileBundle(bundle(), OPTIONS).compiled
    const files = realFiles()
    const rules = files['rules.yml'] as string
    files['rules.yml'] = `# 顶部加一行注释\r\n${rules.replaceAll('\n', '\r\n')}`
    const changed = compileBundle({ dir: DIR, files }, OPTIONS).compiled
    expect(changed.descriptor.semanticDigest).toBe(base.descriptor.semanticDigest)
    expect(changed.descriptor.sourceDigest).not.toBe(base.descriptor.sourceDigest)
  })

  it('改一条规则 → 语义摘要变，版本身份跟着变', () => {
    const base = compileBundle(bundle(), OPTIONS).compiled
    const files = realFiles()
    files['rules.yml'] = (files['rules.yml'] as string).replace('raise: red', 'raise: yellow')
    const changed = compileBundle({ dir: DIR, files }, OPTIONS).compiled
    expect(changed.descriptor.semanticDigest).not.toBe(base.descriptor.semanticDigest)
    expect(changed.descriptor.policyVersion).not.toBe(base.descriptor.policyVersion)
  })

  it('源摘要与文件顺序无关，与文件名有关', () => {
    const files = [
      { name: 'a.yml', content: 'a' },
      { name: 'b.yml', content: 'b' },
    ]
    expect(sourceDigestOf(files)).toBe(sourceDigestOf([...files].reverse()))
    expect(sourceDigestOf(files)).not.toBe(sourceDigestOf([{ name: 'c.yml', content: 'a' }, files[1] as { name: string; content: string }]))
  })

  it('身份串格式：name/version+sha256:16', () => {
    expect(policyVersionOf('bank-tier', '1.0.0', 'abcdef0123456789rest')).toBe(
      'bank-tier/1.0.0+sha256:abcdef0123456789',
    )
  })

  it('descriptor 字段齐全且 owners 排序', () => {
    const compiled = compileBundle(bundle(), OPTIONS).compiled
    const descriptor = descriptorOf(
      compiled.ir,
      ['zeta', 'alpha'],
      compiled.descriptor.sourceDigest,
      '1.0.0',
    )
    expect(descriptor.handle).toBe('bank-tier/1.0.0')
    expect(descriptor.owners).toEqual(['alpha', 'zeta'])
    expect(descriptor.semanticDigest).toBe(semanticDigestOf(compiled.ir))
    expect(descriptor.policyVersion.startsWith('bank-tier/1.0.0+sha256:')).toBe(true)
  })
})

describe('compileBundle · manifest', () => {
  it('合法的 1.0.0 编译通过，规则数与语料数符合预期', () => {
    const result = compileBundle(bundle(), OPTIONS)
    expect(result.compiled.ir.tables).toHaveLength(2)
    expect(result.cases.length).toBeGreaterThanOrEqual(18)
    expect(result.compiled.warnings).toEqual([])
    expect(result.lock.apiVersion).toBe('bah.policy.lock/v1')
    expect(result.lockPresent).toBe(true)

    // 运行期入口：输入校验 + 求值（治理平面只会用这两个方法）
    const input = result.compiled.validateInput({
      subject: { userId: 'u-1', sessionId: 's-1' },
      action: { name: 'transfer_create', declared: 'yellow' },
      preview: { amountCents: 80000, dailyUsedCents: 0, dailyLimitCents: 500000, payee: { binding: 'whitelist' } },
      state: { riskyCallsInTurn: 0, verifyLocked: false },
      limits: { dailyLimitCents: 500000 },
      params: { riskyCallThreshold: 3 },
    })
    expect(result.compiled.evaluate(input)).toEqual({
      level: 'yellow',
      reason: 'declared',
      ruleIds: ['TR-003-default', 'RC-002-default'],
      tables: ['transfer-escalation', 'risky-calls-reason'],
    })
    expect(() => result.compiled.validateInput({})).toThrow()
    expect(Object.isFrozen(result.compiled.parameters)).toBe(true)
    expect(Object.isFrozen(result.compiled.parameters['riskyCallThreshold'])).toBe(true)
  })

  it('bundle.yml 缺失/根节点非对象/未知键', () => {
    expect(codeOf(() => compileBundle(bundle({ 'bundle.yml': undefined }), OPTIONS))).toBe(
      'policy-parse-error',
    )
    expect(codeOf(() => compileBundle(bundle({ 'bundle.yml': '- a\n' }), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(
      codeOf(() =>
        compileBundle(bundle({ 'bundle.yml': `${realFiles()['bundle.yml'] as string}extra: 1\n` }), OPTIONS),
      ),
    ).toBe('policy-unknown-key')
  })

  it('apiVersion / kind / schema 只认固定值', () => {
    expect(codeOf(() => compileBundle(manifestWith('bah.policy/v1', 'bah.policy/v2'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => compileBundle(manifestWith('kind: bank.tier', 'kind: other'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(
      codeOf(() => compileBundle(manifestWith('bank.tier.input/v1', 'bank.tier.input/v2'), OPTIONS)),
    ).toBe('policy-schema-invalid')
  })

  it('版本必须是 semver，且与目录一致', () => {
    expect(codeOf(() => compileBundle(manifestWith('version: 1.0.0', 'version: 1.0'), OPTIONS))).toBe(
      'policy-bad-semver',
    )
    const mismatch = detailOf(() =>
      compileBundle(manifestWith('version: 1.0.0', 'version: 1.0.1'), OPTIONS),
    )
    expect(mismatch['code']).toBeUndefined()
    expect(codeOf(() => compileBundle(manifestWith('version: 1.0.0', 'version: 1.0.1'), OPTIONS))).toBe(
      'policy-version-mismatch',
    )
    expect(codeOf(() => compileBundle(manifestWith('name: bank-tier', 'name: other'), OPTIONS))).toBe(
      'policy-version-mismatch',
    )
    expect(
      codeOf(() => compileBundle({ dir: 'policies/bank-tier', files: realFiles() }, OPTIONS)),
    ).toBe('policy-version-mismatch')
  })

  it('name/description 必须是非空字符串', () => {
    expect(codeOf(() => compileBundle(manifestWith('name: bank-tier', 'name: ""'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    const empty = (realFiles()['bundle.yml'] as string).replace(/description: .*/, 'description: ""')
    expect(codeOf(() => compileBundle(bundle({ 'bundle.yml': empty }), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
  })

  it('description 长度 8..200', () => {
    const short = (realFiles()['bundle.yml'] as string).replace(
      /description: .*/,
      'description: short',
    )
    expect(codeOf(() => compileBundle(bundle({ 'bundle.yml': short }), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    const long = (realFiles()['bundle.yml'] as string).replace(/description: .*/, `description: ${'x'.repeat(201)}`)
    expect(codeOf(() => compileBundle(bundle({ 'bundle.yml': long }), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
  })

  it('owners 必填且非空', () => {
    expect(codeOf(() => compileBundle(manifestWith('owners: [risk-platform]', 'owners: []'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(
      codeOf(() => compileBundle(manifestWith('owners: [risk-platform]', 'owners: risk'), OPTIONS)),
    ).toBe('policy-schema-invalid')
  })

  it('engine 范围必须覆盖当前引擎', () => {
    expect(codeOf(() => compileBundle(manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: 1'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(
      codeOf(() =>
        compileBundle(manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 1.0.0, max: 1.x, extra: 1 }'), OPTIONS),
      ),
    ).toBe('policy-unknown-key')
    expect(
      codeOf(() => compileBundle(manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: v1, max: 1.x }'), OPTIONS)),
    ).toBe('policy-bad-semver')
    expect(
      codeOf(() => compileBundle(manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 1.0.0, max: 1.0 }'), OPTIONS)),
    ).toBe('policy-bad-semver')
    expect(
      codeOf(() => compileBundle(manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 9.0.0, max: 9.x }'), OPTIONS)),
    ).toBe('policy-engine-incompatible')
    expect(
      codeOf(() =>
        compileBundle(manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 1.0.0, max: 0.9.0 }'), OPTIONS),
      ),
    ).toBe('policy-engine-incompatible')
    expect(() =>
      compileBundle(
        manifestWith('engine: { min: 1.0.0, max: 1.x }', 'engine: { min: 1.0.0, max: 1.0.0 }'),
        OPTIONS,
      ),
    ).not.toThrow()
  })

  it('parameters 的形状与边界', () => {
    const replaceParams = (value: string): BundleFiles =>
      bundle({
        'bundle.yml': (realFiles()['bundle.yml'] as string).replace(
          /parameters:\n {2}riskyCallThreshold: .*\n/,
          `parameters: ${value}\n`,
        ),
      })
    expect(codeOf(() => compileBundle(replaceParams('1'), OPTIONS))).toBe('policy-schema-invalid')
    expect(codeOf(() => compileBundle(replaceParams('{ a: 1 }'), OPTIONS))).toBe('policy-schema-invalid')
    expect(codeOf(() => compileBundle(replaceParams('{ a: { type: integer, min: 1, max: 2, x: 1 } }'), OPTIONS))).toBe(
      'policy-unknown-key',
    )
    expect(codeOf(() => compileBundle(replaceParams('{ a: { type: number, min: 1, max: 2 } }'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => compileBundle(replaceParams('{ a: { type: integer, min: 1.5, max: 2 } }'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
    expect(codeOf(() => compileBundle(replaceParams('{ a: { type: integer, min: 3, max: 2 } }'), OPTIONS))).toBe(
      'policy-schema-invalid',
    )
  })

  it('reasons 必须与代码词表相等', () => {
    expect(
      codeOf(() =>
        compileBundle(manifestWith('reasons: [declared, new-payee, daily-limit, risky-calls]', 'reasons: [declared]'), OPTIONS),
      ),
    ).toBe('policy-schema-invalid')
    expect(
      codeOf(() =>
        compileBundle(
          manifestWith(
            'reasons: [declared, new-payee, daily-limit, risky-calls]',
            'reasons: [declared, new-payee, daily-limit, risky-calls, other]',
          ),
          OPTIONS,
        ),
      ),
    ).toBe('policy-schema-invalid')
    expect(
      codeOf(() => compileBundle(manifestWith('reasons: [declared, new-payee, daily-limit, risky-calls]', 'reasons: x'), OPTIONS)),
    ).toBe('policy-schema-invalid')
  })

  it('denyCodes 可选，但格式必须合规', () => {
    expect(codeOf(() => compileBundle(manifestWith('denyCodes: [policy-denied]', 'denyCodes: [nope]'), OPTIONS))).toBe(
      'policy-bad-deny-code',
    )
    expect(
      compileBundle(manifestWith('denyCodes: [policy-denied]', 'denyCodes: []'), OPTIONS).compiled.ir.denyCodes,
    ).toEqual([])
  })

  it('rulesFile/corpusFile 必须是简单文件名（防路径穿越）', () => {
    expect(
      codeOf(() => compileBundle(manifestWith('rulesFile: rules.yml', 'rulesFile: ../x.yml'), OPTIONS)),
    ).toBe('policy-parse-error')
    expect(
      codeOf(() => compileBundle(manifestWith('corpusFile: corpus.yml', 'corpusFile: /etc/passwd'), OPTIONS)),
    ).toBe('policy-parse-error')
  })

  it('缺规则/语料/CHANGELOG 分别报码', () => {
    expect(codeOf(() => compileBundle(bundle({ 'rules.yml': undefined }), OPTIONS))).toBe('policy-parse-error')
    expect(codeOf(() => compileBundle(bundle({ 'corpus.yml': undefined }), OPTIONS))).toBe('policy-corpus-missing')
    expect(codeOf(() => compileBundle(bundle({ 'CHANGELOG.md': undefined }), OPTIONS))).toBe('policy-corpus-missing')
  })

  it('总字节预算 256 KiB', () => {
    expect(codeOf(() => compileBundle(bundle({ 'CHANGELOG.md': 'x'.repeat(262_145) }), OPTIONS))).toBe(
      'policy-limit-exceeded',
    )
  })
})

describe('compileBundle · lock', () => {
  it('lock 一致时通过；改写行为后不一致', () => {
    const files = realFiles()
    const first = compileBundle({ dir: DIR, files }, OPTIONS)
    files['lock.json'] = serializeLock(first.lock)
    expect(() => compileBundle({ dir: DIR, files }, { toolNames: TOOLS })).not.toThrow()

    const tampered = {
      ...files,
      'rules.yml': (files['rules.yml'] as string).replace('raise: red', 'raise: yellow'),
    }
    expect(codeOf(() => compileBundle({ dir: DIR, files: tampered }, { toolNames: TOOLS }))).toBe(
      'policy-digest-mismatch',
    )
  })

  it('只改注释 → 源摘要不符（bundle 不可变）', () => {
    const files = realFiles()
    files['lock.json'] = serializeLock(compileBundle({ dir: DIR, files }, OPTIONS).lock)
    files['rules.yml'] = `# comment\n${files['rules.yml'] as string}`
    const detail = detailOf(() => compileBundle({ dir: DIR, files }, { toolNames: TOOLS }))
    expect(detail['expected']).toBeDefined()
    expect(codeOf(() => compileBundle({ dir: DIR, files }, { toolNames: TOOLS }))).toBe('policy-digest-mismatch')
  })

  it('lock 不是合法 JSON / 形状不对', () => {
    const files = realFiles()
    expect(
      codeOf(() => compileBundle({ dir: DIR, files: { ...files, 'lock.json': '{' } }, { toolNames: TOOLS })),
    ).toBe('policy-parse-error')
    expect(
      codeOf(() => compileBundle({ dir: DIR, files: { ...files, 'lock.json': '[]' } }, { toolNames: TOOLS })),
    ).toBe('policy-digest-mismatch')
  })

  it('serializeLock 输出稳定且文件排序', () => {
    const lock: PolicyLock = {
      apiVersion: 'bah.policy.lock/v1',
      kind: 'bank.tier',
      name: 'bank-tier',
      version: '1.0.0',
      engineVersion: '1.0.0',
      semanticDigest: 'a',
      sourceDigest: 'b',
      files: [
        { name: 'z.yml', bytes: 1, digest: 'z' },
        { name: 'a.yml', bytes: 1, digest: 'a' },
      ],
    }
    const text = serializeLock(lock)
    expect(text.endsWith('\n')).toBe(true)
    expect((JSON.parse(text) as PolicyLock).files.map((file) => file.name)).toEqual(['a.yml', 'z.yml'])
    expect(text).toBe(serializeLock(lock))
  })
})

describe('签名与载入', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

  const tempDirs: string[] = []

  /** 把一组文件写进临时目录。 */
  function tempBundle(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'bah-policy-'))
    tempDirs.push(root)
    // 目录名必须与 manifest 一致：`<root>/bank-tier/1.0.0`
    const dir = join(root, 'bank-tier', '1.0.0')
    mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, 'utf8')
    return dir
  }

  afterAll(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  })

  it('签名/验签；篡改内容或换密钥都验不过', () => {
    const compiled = compileBundle(bundle(), OPTIONS).compiled
    const payload = signingPayload(compiled.ir, compiled.descriptor)
    const signature = signPayload(privatePem, payload)
    expect(verifySignature(publicPem, payload, signature)).toBe(true)
    expect(verifySignature(publicPem, `${payload} `, signature)).toBe(false)
    expect(verifySignature('not-a-pem', payload, signature)).toBe(false)
  })

  it('bundle.sig 形状校验', () => {
    expect(codeOf(() => parseBundleSignature('{'))).toBe('policy-signature-invalid')
    expect(codeOf(() => parseBundleSignature('{"keyVersion":1}'))).toBe('policy-signature-invalid')
    expect(codeOf(() => parseBundleSignature('{"keyVersion":0,"value":"x"}'))).toBe('policy-signature-invalid')
    expect(codeOf(() => parseBundleSignature('{"keyVersion":1,"value":""}'))).toBe('policy-signature-invalid')
    expect(parseBundleSignature('{"keyVersion":2,"value":"abc"}')).toEqual({ keyVersion: 2, value: 'abc' })
  })

  it('assertSigned 校验密钥版本', () => {
    const compiled = compileBundle(bundle(), OPTIONS).compiled
    const payload = signingPayload(compiled.ir, compiled.descriptor)
    const signature = { keyVersion: 2, value: signPayload(privatePem, payload) }
    expect(() => assertSigned(compiled.ir, compiled.descriptor, signature, publicPem, [2])).not.toThrow()
    expect(codeOf(() => assertSigned(compiled.ir, compiled.descriptor, signature, publicPem, [1]))).toBe(
      'policy-signature-invalid',
    )
    expect(
      codeOf(() => assertSigned(compiled.ir, compiled.descriptor, { ...signature, value: 'x' }, publicPem, [2])),
    ).toBe('policy-signature-invalid')
  })

  it('loadBundle：无签名可载入；requireSignature 拒绝', () => {
    const dir = tempBundle(realFiles())
    expect(() => loadBundle({ dir, toolNames: TOOLS })).not.toThrow()
    expect(codeOf(() => loadBundle({ dir, toolNames: TOOLS, requireSignature: true }))).toBe(
      'policy-signature-invalid',
    )
  })

  it('loadBundle：签名 + 公钥通过；缺公钥/错公钥/未授权版本都拒绝', () => {
    const files = realFiles()
    const compiled = compileBundle({ dir: DIR, files }, OPTIONS).compiled
    const value = signPayload(privatePem, signingPayload(compiled.ir, compiled.descriptor))
    files['bundle.sig'] = JSON.stringify({ keyVersion: 1, value })

    expect(() => loadBundle({ dir: tempBundle(files), toolNames: TOOLS, publicKeyPem: publicPem })).not.toThrow()
    expect(codeOf(() => loadBundle({ dir: tempBundle(files), toolNames: TOOLS }))).toBe(
      'policy-signature-invalid',
    )
    expect(
      codeOf(() => loadBundle({ dir: tempBundle(files), toolNames: TOOLS, publicKeyPem: 'not-a-pem' })),
    ).toBe('policy-signature-invalid')
    expect(
      codeOf(() =>
        loadBundle({
          dir: tempBundle(files),
          toolNames: TOOLS,
          publicKeyPem: publicPem,
          allowedKeyVersions: [2],
        }),
      ),
    ).toBe('policy-signature-invalid')

    const tampered = { ...files, 'bundle.sig': JSON.stringify({ keyVersion: 1, value: 'x' }) }
    expect(
      codeOf(() => loadBundle({ dir: tempBundle(tampered), toolNames: TOOLS, publicKeyPem: publicPem })),
    ).toBe('policy-signature-invalid')
  })

  it('目录不可读 → parse-error', () => {
    expect(codeOf(() => readBundleFiles(join(tmpdir(), 'bah-policy-does-not-exist')))).toBe('policy-parse-error')
  })

  it('writeLockFile 写出的内容可被 compile --check 读回', () => {
    const files = realFiles()
    delete files['lock.json']
    const dir = tempBundle(files)
    const result = loadBundle({ dir, toolNames: TOOLS })
    writeLockFile(dir, result.lock)
    expect(() => loadBundle({ dir, toolNames: TOOLS })).not.toThrow()
    expect(readFileSync(join(dir, 'lock.json'), 'utf8')).toBe(serializeLock(result.lock))
  })
})

describe('errors', () => {
  it('每个稳定错误码都在码表里', () => {
    const error = policyError('policy-parse-error', 'boom', { file: 'x.yml', line: 3, ruleId: 'R-1' })
    expect(error.message).toBe('x.yml:3: R-1: boom')
    expect(POLICY_ERROR_CODES).toContain(error.code)
    expect(new Set(POLICY_ERROR_CODES).size).toBe(POLICY_ERROR_CODES.length)
  })

  it('无定位信息时消息不带前缀', () => {
    expect(policyError('policy-eval-invalid', 'boom').message).toBe('boom')
  })

  it('describePolicyError 收敛 BahError / Error / 非 Error', () => {
    expect(describePolicyError(policyError('policy-limit-exceeded', 'big'))).toEqual({
      code: 'policy-limit-exceeded',
      message: 'big',
    })
    expect(describePolicyError(new Error('plain'))).toEqual({ code: 'policy-unknown-error', message: 'plain' })
    expect(describePolicyError('text')).toEqual({ code: 'policy-unknown-error', message: 'text' })
  })

  it('码表覆盖方案 §6.4 的全部编译期错误码', () => {
    const required = [
      'policy-parse-error',
      'policy-schema-invalid',
      'policy-unknown-key',
      'policy-unknown-field',
      'policy-type-mismatch',
      'policy-unknown-param',
      'policy-param-unused',
      'policy-unknown-tool',
      'policy-duplicate-rule',
      'policy-missing-default',
      'policy-unreachable-row',
      'policy-unsatisfiable-row',
      'policy-lower-tier',
      'policy-bad-reason',
      'policy-bad-deny-code',
      'policy-row-action-conflict',
      'policy-deny-order',
      'policy-bad-semver',
      'policy-version-mismatch',
      'policy-digest-mismatch',
      'policy-signature-invalid',
      'policy-corpus-missing',
      'policy-limit-exceeded',
      'policy-engine-incompatible',
    ]
    for (const code of required) expect(POLICY_ERROR_CODES).toContain(code)
  })
})
