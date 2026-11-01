/**
 * 编译流水线（设计方案 01 §6）。
 *
 * `compileBundle` 是**纯函数**：输入是"bundle 目录名 + 文件内容表"，不读磁盘。
 * 读盘与签名验证在 `load.ts`，这样单测可以造任意坏 bundle 而不碰文件系统。
 *
 * 顺序不可调换：manifest → 表达式 → 表 → 静态分析 → 规范化 IR → 摘要 → lock 比对。
 * 任何一步失败都抛 `policy-*`，绝不"跳过坏规则继续跑"（I9 / 不变式 2）。
 */

import { Buffer } from 'node:buffer'

import { sha256Hex } from '@bah/util'

import { analyzeTables, type PolicyWarning } from './analyze.ts'
import {
  descriptorOf,
  normalizeSourceText,
  sourceDigestOf,
  type PolicyDescriptor,
  type PolicyKind,
  type SourceFile,
} from './canonical.ts'
import { readCorpus, type CorpusCase } from './corpus.ts'
import { policyError, type PolicyErrorCode } from './errors.ts'
import { POLICY_ENGINE_VERSION, POLICY_LIMITS } from './limits.ts'
import {
  BANK_TIER_SCHEMA,
  deepFreeze,
  isRecord,
  TIER_REASONS,
  validateInput,
  type BankTierInput,
  type ParamSpec,
  type TierPolicyResult,
} from './schema.ts'
import { evaluateIr, readTables, type IrParameter, type IrTable, type PolicyIr } from './table.ts'
import { locOf, parseYaml, toPlain, type YamlSource } from './yaml.ts'

/** 一个 bundle 的输入：目录名 + 文件内容（键是 bundle 内相对路径）。 */
export interface BundleFiles {
  /** posix 路径，如 `policies/bank-tier/1.0.0`；只用它校验 name/version 与报错定位。 */
  readonly dir: string
  readonly files: Readonly<Record<string, string>>
}

/** 编译选项。 */
export interface CompileOptions {
  /** 工具目录（`appliesTo` 的合法值）。由调用方注入：`@bah/policy` 不认识银行。 */
  readonly toolNames: readonly string[]
  /** 是否与 `lock.json` 比对（默认 true；`--write` 时传 false）。 */
  readonly verifyLock?: boolean
  /**
   * 是否解析并返回语料（默认 true）。
   *
   * 宿主启动只需要可执行 IR；语料校验由 `policy:test` / 门禁负责。跳过它能把
   * 启动编译压回预算内，同时**不改变** lock/source 摘要（摘要仍覆盖 corpus.yml）。
   */
  readonly withCorpus?: boolean
}

/** `lock.json` 里的一个文件条目。 */
export interface LockedFile {
  readonly name: string
  readonly bytes: number
  readonly digest: string
}

/** `lock.json`。 */
export interface PolicyLock {
  readonly apiVersion: 'bah.policy.lock/v1'
  readonly kind: PolicyKind
  readonly name: string
  readonly version: string
  readonly engineVersion: string
  readonly semanticDigest: string
  readonly sourceDigest: string
  readonly files: readonly LockedFile[]
}

/** 编译产物：运行期只认这个接口（`descriptor` + `validateInput` + `evaluate`）。 */
export interface CompiledPolicy {
  readonly ir: PolicyIr
  readonly descriptor: PolicyDescriptor
  readonly warnings: readonly PolicyWarning[]
  readonly parameters: Readonly<Record<string, ParamSpec>>
  validateInput(value: unknown): BankTierInput
  evaluate(input: BankTierInput): TierPolicyResult
}

/** 编译结果。 */
export interface CompileResult {
  readonly compiled: CompiledPolicy
  /** 语料（编译期已校验形状；`policy:test` 复用它，避免二次解析）。 */
  readonly cases: readonly CorpusCase[]
  readonly lock: PolicyLock
  /** 输入里是否带了 `lock.json`（`--check` 要区分"一致"与"没得比"）。 */
  readonly lockPresent: boolean
}

/** manifest 里需要留到编译后使用的字段。 */
interface Manifest {
  readonly name: string
  readonly version: string
  readonly owners: readonly string[]
  readonly parameters: Readonly<Record<string, ParamSpec>>
  readonly reasons: readonly string[]
  readonly denyCodes: readonly string[]
  readonly engine: { readonly min: string; readonly max: string }
  readonly rulesFile: string
  readonly corpusFile: string
}

const MANIFEST_KEYS = new Set([
  'apiVersion',
  'kind',
  'name',
  'version',
  'description',
  'owners',
  'schema',
  'engine',
  'parameters',
  'reasons',
  'denyCodes',
  'rulesFile',
  'corpusFile',
])

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const DENY_CODE_PATTERN = /^policy-[a-z][a-z0-9-]{1,40}$/

/**
 * 编译一个 bundle。
 *
 * @throws `policy-*` 任意编译期错误（带 `file:line` / `ruleId`）
 */
export function compileBundle(bundle: BundleFiles, options: CompileOptions): CompileResult {
  const dir = normalizeDir(bundle.dir)
  const dirVersion = lastSegment(dir)
  const dirName = secondLastSegment(dir)
  const files = normalizeFiles(bundle.files)

  const manifestText = requireFile(files, 'bundle.yml', 'policy-parse-error')
  const source = parseYaml(manifestText, 'bundle.yml')
  assertBundleSize(files)

  const manifest = readManifest(source, dirName, dirVersion)
  const rulesText = requireFile(files, manifest.rulesFile, 'policy-parse-error')
  const corpusText = requireFile(files, manifest.corpusFile, 'policy-corpus-missing')
  requireFile(files, 'CHANGELOG.md', 'policy-corpus-missing')

  const rulesSource = parseYaml(rulesText, manifest.rulesFile)
  const parsed = readTables({
    source: rulesSource,
    params: manifest.parameters,
    reasons: manifest.reasons,
    denyCodes: manifest.denyCodes,
    toolNames: options.toolNames,
  })
  const warnings = analyzeTables(parsed.parsed, {
    source: rulesSource,
    params: manifest.parameters,
  })

  const ir = buildIr(manifest, parsed.tables)
  const descriptor = descriptorOf(
    ir,
    manifest.owners,
    sourceDigestOf(sourceFiles(files, manifest)),
    POLICY_ENGINE_VERSION,
  )

  const lock = buildLock(ir, descriptor, sourceFiles(files, manifest))
  if (options.verifyLock !== false) {
    verifyLock(files['lock.json'], lock)
  }

  const cases =
    options.withCorpus === false
      ? []
      : readCorpus(parseYaml(corpusText, manifest.corpusFile), manifest.parameters, manifest.reasons)

  const frozen = deepFreeze(ir)
  // 参数边界也冻结：`compiled.parameters` 是公开字段，宿主改一个 min/max 就会改变
  // `validateInput` 的行为——运行期不该存在这种"改配即改语义"的暗门。
  const parameters = deepFreeze({ ...manifest.parameters })
  return {
    compiled: {
      ir: frozen,
      descriptor,
      warnings,
      parameters,
      validateInput: (value: unknown) => validateInput(value, parameters),
      evaluate: (input: BankTierInput) => evaluateIr(frozen, input),
    },
    cases,
    lock,
    lockPresent: files['lock.json'] !== undefined,
  }
}

/** 序列化 `lock.json`（2 空格缩进 + 末尾换行：给人读，也给 git diff 看）。 */
export function serializeLock(lock: PolicyLock): string {
  const sorted: PolicyLock = {
    ...lock,
    files: [...lock.files].sort((left, right) => (left.name < right.name ? -1 : 1)),
  }
  return `${JSON.stringify(sorted, null, 2)}\n`
}

/** 读 manifest 并校验（§3.2 的字段表）。 */
function readManifest(source: YamlSource, dirName: string, dirVersion: string): Manifest {
  const plain = toPlain(source)
  if (!isRecord(plain)) {
    throw manifestError(source, [], 'policy-schema-invalid', 'bundle.yml 根节点必须是对象')
  }
  rejectUnknown(source, plain, MANIFEST_KEYS, [])

  const apiVersion = requireString(source, plain['apiVersion'], ['apiVersion'], 'apiVersion')
  if (apiVersion !== 'bah.policy/v1') {
    throw manifestError(source, ['apiVersion'], 'policy-schema-invalid', `只认 bah.policy/v1，实际 ${apiVersion}`, {
      field: 'apiVersion',
      actual: apiVersion,
    })
  }

  const kind = requireString(source, plain['kind'], ['kind'], 'kind')
  if (kind !== 'bank.tier') {
    throw manifestError(source, ['kind'], 'policy-schema-invalid', `v1 只认 bank.tier，实际 ${kind}`, {
      field: 'kind',
      actual: kind,
    })
  }

  const name = requireString(source, plain['name'], ['name'], 'name')
  // `version: 1.0` 在 YAML 里会被解析成数字 1——这不是"字段类型错"，是"版本号写得不像版本"。
  const rawVersion = plain['version']
  const version = typeof rawVersion === 'string' ? rawVersion : String(rawVersion)
  if (!SEMVER.test(version)) {
    throw manifestError(source, ['version'], 'policy-bad-semver', `版本必须是 semver：${version}`, {
      version,
    })
  }
  if (name !== dirName || version !== dirVersion) {
    throw manifestError(
      source,
      ['version'],
      'policy-version-mismatch',
      `目录与 manifest 不一致：目录 ${dirName}/${dirVersion}，声明 ${name}/${version}`,
      { dir: `${dirName}/${dirVersion}`, declared: `${name}/${version}` },
    )
  }

  const description = requireString(source, plain['description'], ['description'], 'description')
  if (description.length < 8 || description.length > POLICY_LIMITS.maxDescription) {
    throw manifestError(
      source,
      ['description'],
      'policy-schema-invalid',
      `description 长度必须在 8..${String(POLICY_LIMITS.maxDescription)}`,
      { field: 'description', actual: description.length },
    )
  }

  const owners = requireStringArray(source, plain['owners'], ['owners'], 'owners')
  if (owners.length === 0) {
    throw manifestError(source, ['owners'], 'policy-schema-invalid', 'owners 不能为空', {
      field: 'owners',
    })
  }

  const schema = requireString(source, plain['schema'], ['schema'], 'schema')
  if (schema !== BANK_TIER_SCHEMA) {
    throw manifestError(source, ['schema'], 'policy-schema-invalid', `只认 ${BANK_TIER_SCHEMA}`, {
      field: 'schema',
      actual: schema,
    })
  }

  const engine = readEngineRange(source, plain['engine'])

  const parameters = readParameters(source, plain['parameters'])
  const reasons = readReasons(source, plain['reasons'])
  const denyCodes = readDenyCodes(source, plain['denyCodes'])

  return {
    name,
    version,
    owners,
    parameters,
    reasons,
    denyCodes,
    engine,
    rulesFile: readFileName(source, plain['rulesFile'], 'rulesFile', 'rules.yml'),
    corpusFile: readFileName(source, plain['corpusFile'], 'corpusFile', 'corpus.yml'),
  }
}

/** `engine` 必须是字符串 min/max，且覆盖当前引擎版本。 */
function readEngineRange(
  source: YamlSource,
  value: unknown,
): { readonly min: string; readonly max: string } {
  if (!isRecord(value)) {
    throw manifestError(source, ['engine'], 'policy-schema-invalid', 'engine 必须是 { min, max }')
  }
  rejectUnknown(source, value, new Set(['min', 'max']), ['engine'])

  const rawMin = value['min']
  const rawMax = value['max']
  const min = typeof rawMin === 'string' ? rawMin : String(rawMin)
  const max = typeof rawMax === 'string' ? rawMax : String(rawMax)
  if (parseSemver(min) === undefined) {
    throw manifestError(source, ['engine', 'min'], 'policy-bad-semver', `engine.min 不是 semver：${min}`, {
      version: min,
    })
  }
  if (parseSemver(max) === undefined && !/^\d+\.x$/.test(max)) {
    throw manifestError(source, ['engine', 'max'], 'policy-bad-semver', `engine.max 不是 semver/通配：${max}`, {
      version: max,
    })
  }
  if (!satisfiesEngine(POLICY_ENGINE_VERSION, min, max)) {
    throw manifestError(
      source,
      ['engine'],
      'policy-engine-incompatible',
      `引擎 ${POLICY_ENGINE_VERSION} 不在 [${min}, ${max}] 内`,
      { file: source.file, min, max, engine: POLICY_ENGINE_VERSION },
    )
  }
  return { min, max }
}

/** `parameters`：只声明名字/类型/边界，不持有值。 */
function readParameters(source: YamlSource, value: unknown): Record<string, ParamSpec> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw manifestError(source, ['parameters'], 'policy-schema-invalid', 'parameters 必须是对象')
  }

  const result: Record<string, ParamSpec> = {}
  for (const [name, spec] of Object.entries(value)) {
    const path = ['parameters', name]
    if (!isRecord(spec)) {
      throw manifestError(source, path, 'policy-schema-invalid', `参数 ${name} 必须是对象`)
    }
    rejectUnknown(source, spec, new Set(['type', 'min', 'max']), path)
    if (spec['type'] !== 'integer') {
      throw manifestError(source, [...path, 'type'], 'policy-schema-invalid', 'v1 参数只支持 integer', {
        name,
      })
    }
    const min = requireInt(source, spec['min'], [...path, 'min'], 'min')
    const max = requireInt(source, spec['max'], [...path, 'max'], 'max')
    if (min > max) {
      throw manifestError(source, [...path, 'min'], 'policy-schema-invalid', `参数 ${name} 的 min > max`, {
        name,
      })
    }
    result[name] = { min, max }
  }
  return result
}

/** `reasons` 必须与代码的词表逐字相等（顺序无关，集合相等）。 */
function readReasons(source: YamlSource, value: unknown): string[] {
  const reasons = requireStringArray(source, value, ['reasons'], 'reasons')
  const expected = [...TIER_REASONS].sort()
  const actual = [...new Set(reasons)].sort()
  if (expected.length !== actual.length || expected.some((reason, index) => reason !== actual[index])) {
    throw manifestError(
      source,
      ['reasons'],
      'policy-schema-invalid',
      `reasons 必须与代码词表相等：[${expected.join(', ')}]`,
      { field: 'reasons', expected: expected.join(','), actual: actual.join(',') },
    )
  }
  return reasons
}

/** `denyCodes` 可选；每个都要合规。 */
function readDenyCodes(source: YamlSource, value: unknown): string[] {
  if (value === undefined) return []
  const codes = requireStringArray(source, value, ['denyCodes'], 'denyCodes')
  for (const [index, code] of codes.entries()) {
    if (!DENY_CODE_PATTERN.test(code)) {
      throw manifestError(
        source,
        ['denyCodes', index],
        'policy-bad-deny-code',
        `拒绝码必须匹配 ${DENY_CODE_PATTERN.source}`,
        { code },
      )
    }
  }
  return codes
}

/** 文件名必须是 bundle 内的简单文件名（防 `../` 路径穿越）。 */
function readFileName(
  source: YamlSource,
  value: unknown,
  field: string,
  fallback: string,
): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw manifestError(
      source,
      [field],
      'policy-parse-error',
      `${field} 必须是 bundle 内的简单文件名（禁止路径分隔符）`,
      { field, actual: String(value) },
    )
  }
  return value
}

/** 组装规范化 IR（`parameters`/`reasons`/`denyCodes` 先排序，摘要才稳定）。 */
function buildIr(manifest: Manifest, tables: readonly IrTable[]): PolicyIr {
  const parameters: Record<string, IrParameter> = {}
  for (const name of Object.keys(manifest.parameters).sort()) {
    const spec = manifest.parameters[name] as ParamSpec
    parameters[name] = { type: 'integer', min: spec.min, max: spec.max }
  }
  return {
    apiVersion: 'bah.policy/v1',
    kind: 'bank.tier',
    name: manifest.name,
    version: manifest.version,
    schema: BANK_TIER_SCHEMA,
    engine: manifest.engine,
    parameters,
    reasons: [...manifest.reasons].sort(),
    denyCodes: [...manifest.denyCodes].sort(),
    tables,
  }
}

/** 参与源摘要的文件：manifest / 规则 / 语料 / CHANGELOG（不含 lock 与签名）。 */
function sourceFiles(
  files: Readonly<Record<string, string>>,
  manifest: Manifest,
): SourceFile[] {
  return [
    { name: 'bundle.yml', content: files['bundle.yml'] as string },
    { name: manifest.rulesFile, content: files[manifest.rulesFile] as string },
    { name: manifest.corpusFile, content: files[manifest.corpusFile] as string },
    { name: 'CHANGELOG.md', content: files['CHANGELOG.md'] as string },
  ]
}

/** 生成 `lock.json`。 */
function buildLock(
  ir: PolicyIr,
  descriptor: PolicyDescriptor,
  sources: readonly SourceFile[],
): PolicyLock {
  return {
    apiVersion: 'bah.policy.lock/v1',
    kind: ir.kind,
    name: ir.name,
    version: ir.version,
    engineVersion: descriptor.engineVersion,
    semanticDigest: descriptor.semanticDigest,
    sourceDigest: descriptor.sourceDigest,
    files: sources
      .map((file) => {
        const content = normalizeSourceText(file.content)
        return { name: file.name, bytes: Buffer.byteLength(content, 'utf8'), digest: sha256Hex(content) }
      })
      .sort((left, right) => (left.name < right.name ? -1 : 1)),
  }
}

/** 与 `lock.json` 比对：任一项不符即拒绝载入（I9）。 */
function verifyLock(raw: string | undefined, computed: PolicyLock): void {
  if (raw === undefined) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw policyError('policy-parse-error', 'lock.json 不是合法 JSON', { file: 'lock.json' })
  }
  if (!isRecord(parsed)) {
    throw policyError('policy-digest-mismatch', 'lock.json 形状非法', { file: 'lock.json' })
  }

  if (parsed['semanticDigest'] !== computed.semanticDigest) {
    throw policyError(
      'policy-digest-mismatch',
      `语义摘要不符：lock ${String(parsed['semanticDigest'])}，实际 ${computed.semanticDigest}`,
      { file: 'lock.json', expected: String(parsed['semanticDigest']), actual: computed.semanticDigest },
    )
  }
  if (parsed['sourceDigest'] !== computed.sourceDigest) {
    throw policyError(
      'policy-digest-mismatch',
      `源摘要不符：bundle 被就地改动（lock ${String(parsed['sourceDigest'])}，实际 ${computed.sourceDigest}）`,
      { file: 'lock.json', expected: String(parsed['sourceDigest']), actual: computed.sourceDigest },
    )
  }
}

/** 总字节预算（防"一个 bundle 拖垮编译"）。 */
function assertBundleSize(files: Readonly<Record<string, string>>): void {
  const total = Object.values(files).reduce(
    (sum, content) => sum + Buffer.byteLength(normalizeSourceText(content), 'utf8'),
    0,
  )
  if (total > POLICY_LIMITS.maxBundleBytes) {
    throw policyError('policy-limit-exceeded', `bundle 总字节超过 ${String(POLICY_LIMITS.maxBundleBytes)}`, {
      limit: 'maxBundleBytes',
      max: POLICY_LIMITS.maxBundleBytes,
      size: total,
    })
  }
}

/** 取文件内容；缺失按调用方给的码报错。 */
function requireFile(
  files: Readonly<Record<string, string>>,
  name: string,
  code: PolicyErrorCode,
): string {
  const content = files[name]
  if (content === undefined) {
    throw policyError(code, `缺少文件 \`${name}\``, { file: name })
  }
  return content
}

/** 去 BOM / 统一 LF（源摘要与字节预算都按规范化文本算）。 */
function normalizeFiles(files: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, content] of Object.entries(files)) {
    result[name] = normalizeSourceText(content)
  }
  return result
}

function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/\\/g, '/').replace(/\/+$/g, '')
  return trimmed.length === 0 ? '/' : trimmed
}

function lastSegment(dir: string): string {
  const parts = dir.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? ''
}

function secondLastSegment(dir: string): string {
  const parts = dir.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 2] ?? ''
}

/** semver → 三元组；非法返回 undefined。 */
function parseSemver(version: string): [number, number, number] | undefined {
  const matched = SEMVER.exec(version)
  if (matched === null) return undefined
  return [Number(matched[1]), Number(matched[2]), Number(matched[3])]
}

/** 引擎版本是否在 `[min, max]` 内（`max` 支持 `N.x`）。 */
function satisfiesEngine(version: string, min: string, max: string): boolean {
  const current = parseSemver(version)
  const lower = parseSemver(min)
  if (current === undefined || lower === undefined) return false
  if (compareSemver(current, lower) < 0) return false

  if (/^\d+\.x$/.test(max)) {
    return current[0] === Number(max.slice(0, max.indexOf('.')))
  }
  const upper = parseSemver(max)
  if (upper === undefined) return false
  return compareSemver(current, upper) <= 0
}

function compareSemver(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (const index of [0, 1, 2] as const) {
    const delta = left[index] - right[index]
    if (delta !== 0) return delta
  }
  return 0
}

/** manifest 里的字符串字段。 */
function requireString(
  source: YamlSource,
  value: unknown,
  path: readonly (string | number)[],
  field: string,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw manifestError(source, path, 'policy-schema-invalid', `${field} 必须是非空字符串`, { field })
  }
  return value
}

/** manifest 里的整数（参数边界）。 */
function requireInt(
  source: YamlSource,
  value: unknown,
  path: readonly (string | number)[],
  field: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw manifestError(source, path, 'policy-schema-invalid', `${field} 必须是整数`, { field })
  }
  return value
}

function requireStringArray(
  source: YamlSource,
  value: unknown,
  path: readonly (string | number)[],
  field: string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw manifestError(source, path, 'policy-schema-invalid', `${field} 必须是字符串数组`, { field })
  }
  return value as string[]
}

function rejectUnknown(
  source: YamlSource,
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: readonly (string | number)[],
): void {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue
    throw manifestError(source, [...path, key], 'policy-unknown-key', `未知字段 \`${key}\``, { key })
  }
}

/** 以 YAML 路径定位并抛错。 */
function manifestError(
  source: YamlSource,
  path: readonly (string | number)[],
  code: PolicyErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const loc = locOf(source, path)
  return policyError(code, message, {
    file: source.file,
    line: loc.line,
    column: loc.column,
    ...extra,
  })
}

