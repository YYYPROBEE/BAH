/**
 * 内容寻址：语义摘要 / 源摘要 / 版本身份（施工方案 01 §6.3）。
 *
 * 两个摘要的分工是刻意的：
 * - **semanticDigest** 只覆盖规范化 IR（行为）。改注释、缩进、键序、换行 → 不变；
 * - **sourceDigest** 覆盖规范化源字节（文本）。改一个字符就变，用于"bundle 不可变"。
 *
 * 所以"版本代表行为"和"文件不许就地改"两条不冲突：前者看 semantic，后者看 source。
 */

import { canonicalJson, sha256Hex } from '@bah/util'


/** bundle 里的一个源文件（名字是 bundle 内相对路径）。 */
export interface SourceFile {
  readonly name: string
  readonly content: string
}

/** bundle 类型（v1 两种：银行三级判决 / sentry 正则规则集）。 */
export type PolicyKind = 'bank.tier' | 'sentry.rules'

/** 参与身份计算的最小 IR 形状（两种 kind 都满足）。 */
export interface IrIdentity {
  readonly kind: string
  readonly name: string
  readonly version: string
}

/** 审计口径的身份信息（`policyVersion` 就是 D3 的 identity 串）。 */
export interface PolicyDescriptor {
  readonly kind: PolicyKind
  readonly name: string
  /** semver（人读，也是目录名）。 */
  readonly version: string
  /** `name/version`：registry 键与 CLI 参数。 */
  readonly handle: string
  /** `name/version+sha256:<16>`：判决/审计里的 `policyVersion`。 */
  readonly policyVersion: string
  /** 64 位小写 hex。 */
  readonly semanticDigest: string
  /** 64 位小写 hex。 */
  readonly sourceDigest: string
  /** DSL 能力版本。 */
  readonly engineVersion: string
  readonly owners: readonly string[]
}

/** 规范化源文本：去 BOM、CRLF/CR → LF（Windows 检出不能改变摘要）。 */
export function normalizeSourceText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 语义摘要：`sha256("bah.policy.semantic.v1\n" + kind + "\n" + canonicalJson(ir))`。 */
export function semanticDigestOf(ir: IrIdentity): string {
  return sha256Hex(`bah.policy.semantic.v1\n${ir.kind}\n${canonicalJson(ir)}`)
}

/**
 * 源摘要：覆盖全部源文件的**规范化字节与文件名**。
 *
 * 文件名参与摘要：把 `rules.yml` 改名成 `corpus.yml` 必须换摘要，否则"哪个文件是规则"
 * 就成了未受保护的元数据。
 */
export function sourceDigestOf(files: readonly SourceFile[]): string {
  const records = [...files]
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .map((file) => canonicalJson({ name: file.name, content: normalizeSourceText(file.content) }))
  return sha256Hex(`bah.policy.source.v1\n${records.join('\n')}`)
}

/** 审计口径的身份串：`name/version+sha256:<前 16 位>`。 */
export function policyVersionOf(name: string, version: string, semanticDigest: string): string {
  return `${name}/${version}+sha256:${semanticDigest.slice(0, 16)}`
}

/** 组装描述符。 */
export function descriptorOf(
  ir: IrIdentity,
  owners: readonly string[],
  sourceDigest: string,
  engineVersion: string,
): PolicyDescriptor {
  const semanticDigest = semanticDigestOf(ir)
  return {
    kind: ir.kind as PolicyKind,
    name: ir.name,
    version: ir.version,
    handle: `${ir.name}/${ir.version}`,
    policyVersion: policyVersionOf(ir.name, ir.version, semanticDigest),
    semanticDigest,
    sourceDigest,
    engineVersion,
    owners: [...owners].sort(),
  }
}
