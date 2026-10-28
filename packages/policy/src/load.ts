/**
 * 从磁盘载入 bundle（施工方案 01 §3 / §9.3）。
 *
 * 这是 `@bah/policy` 里**唯一**碰文件系统的地方：编译与求值本身是纯函数。
 * 载入顺序刻意是"先编译、后验签"：签名覆盖的是两个摘要，摘要得先算出来；
 * 而摘要不合法（lock 不符）本身已经是一次拒绝。
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  compileBundle,
  serializeLock,
  type BundleFiles,
  type CompileOptions,
  type CompileResult,
  type PolicyLock,
} from './compile.ts'
import { policyError } from './errors.ts'
import {
  compileRuleBundle,
  serializeRuleLock,
  type SentryCompileResult,
  type SentryRulesLock,
} from './sentry-rules.ts'
import { assertSigned, parseBundleSignature } from './signature.ts'
import { isRecord } from './schema.ts'
import { parseYaml, toPlain } from './yaml.ts'

/** 载入选项。 */
export interface LoadOptions extends CompileOptions {
  /** bundle 目录（绝对或相对仓库根）。 */
  readonly dir: string
  /** 必须存在合法签名（生产 profile 用）。 */
  readonly requireSignature?: boolean
  /** 验签公钥（PEM）；`requireSignature` 时必填。 */
  readonly publicKeyPem?: string
  /** 允许的密钥版本；空/缺省 = 不限制。 */
  readonly allowedKeyVersions?: readonly number[]
}

/** 载入并编译一个 bundle。 */
export function loadBundle(options: LoadOptions): CompileResult {
  const bundle = readBundleFiles(options.dir)
  const result = compileBundle(bundle, options)

  const signatureText = bundle.files['bundle.sig']
  if (signatureText !== undefined) {
    if (options.publicKeyPem === undefined) {
      throw policyError('policy-signature-invalid', 'bundle 带签名但没有提供验签公钥', {
        file: 'bundle.sig',
      })
    }
    assertSigned(
      result.compiled.ir,
      result.compiled.descriptor,
      parseBundleSignature(signatureText),
      options.publicKeyPem,
      options.allowedKeyVersions ?? [],
    )
    return result
  }

  if (options.requireSignature === true) {
    throw policyError('policy-signature-invalid', 'requireSignature 已开启，但 bundle 没有 bundle.sig', {
      file: 'bundle.sig',
    })
  }
  return result
}

/** 读目录下的全部普通文件（不递归：bundle 目录是平的）。 */
export function readBundleFiles(dir: string): BundleFiles {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    throw policyError('policy-parse-error', `bundle 目录不可读：${dir}`, { file: dir })
  }

  // 目录已列举成功，单个文件读失败属"磁盘在这一瞬间坏了"——让原始错误直接冒出，
  // 不在这里造一个无法被稳定复现的分支（G8：不留不可达防御）。
  const files: Record<string, string> = {}
  for (const name of names) files[name] = readFileSync(join(dir, name), 'utf8')
  return { dir, files }
}

/** 写 `lock.json`（`policy:compile --write` 的唯一副作用）。 */
export function writeLockFile(dir: string, lock: PolicyLock): void {
  writeFileSync(join(dir, 'lock.json'), serializeLock(lock), 'utf8')
}

/** 写 sentry 规则集的 `lock.json`。 */
export function writeRuleLockFile(dir: string, lock: SentryRulesLock): void {
  writeFileSync(join(dir, 'lock.json'), serializeRuleLock(lock), 'utf8')
}

/**
 * 载入并编译一个 `sentry.rules` bundle（签名与 bank.tier 同一套）。
 */
export function loadRuleBundle(options: LoadOptions): SentryCompileResult {
  const bundle = readBundleFiles(options.dir)
  const result = compileRuleBundle(bundle, options)

  const signatureText = bundle.files['bundle.sig']
  if (signatureText !== undefined) {
    if (options.publicKeyPem === undefined) {
      throw policyError('policy-signature-invalid', 'bundle 带签名但没有提供验签公钥', {
        file: 'bundle.sig',
      })
    }
    assertSigned(
      result.compiled.ir,
      result.compiled.descriptor,
      parseBundleSignature(signatureText),
      options.publicKeyPem,
      options.allowedKeyVersions ?? [],
    )
    return result
  }

  if (options.requireSignature === true) {
    throw policyError('policy-signature-invalid', 'requireSignature 已开启，但 bundle 没有 bundle.sig', {
      file: 'bundle.sig',
    })
  }
  return result
}

/** 读 bundle.yml 的 `kind`（门禁按 kind 分派编译器用）。 */
export function peekBundleKind(dir: string): string {
  const files = readBundleFiles(dir)
  const text = files.files['bundle.yml']
  if (text === undefined) {
    throw policyError('policy-parse-error', '缺少文件 `bundle.yml`', { file: 'bundle.yml' })
  }
  const plain = toPlain(parseYaml(text, 'bundle.yml'))
  if (!isRecord(plain)) {
    throw policyError('policy-schema-invalid', 'bundle.yml 根节点必须是对象', { file: 'bundle.yml' })
  }
  return String(plain['kind'])
}
