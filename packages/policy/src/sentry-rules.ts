/**
 * `sentry.rules` bundle：把 13 条内置危险参数规则外置成可编译、可哈希、可灰度的规则集
 * （策略外置 S5 / 03 §6）。
 *
 * 与 `bank.tier` 分开编译，因为风险模型不同：这里执行的是**正则**，不是纯表达式。
 * 安全子集在编译期强制（长度/反向引用/lookbehind/嵌套量词/`.*.*`/字符类长度/flags），
 * 任何一条不合规都抛 `policy-regex-unsafe`，绝不"先编译再看运行期表现"。
 *
 * 运行期仍由 `@bah/safety` 的 `scanToolArgs` 执行（`baseRules` 注入编译出的 RegExp），
 * 这样判决语义只有一份实现；本文件只负责"规则从哪来、是否可信、有没有变"。
 */

import { Buffer } from 'node:buffer'

import { sha256Hex } from '@bah/util'

import {
  descriptorOf,
  normalizeSourceText,
  sourceDigestOf,
  type PolicyDescriptor,
  type SourceFile,
} from './canonical.ts'
import { policyError, type PolicyErrorCode } from './errors.ts'
import { POLICY_ENGINE_VERSION, SENTRY_RULE_LIMITS } from './limits.ts'
import { deepFreeze, isRecord } from './schema.ts'
import { locOf, parseYaml, toPlain, type YamlSource } from './yaml.ts'

/** 规则族（与 `@bah/safety` 的 `RuleFamily` 同集；越界即拒）。 */
export const SENTRY_RULE_FAMILIES = [
  'destructive',
  'privilege',
  'supply',
  'code',
  'exfil',
  'privacy',
] as const

export type SentryRuleFamily = (typeof SENTRY_RULE_FAMILIES)[number]

/** 规则集输入契约（manifest 的 `schema` 字段）。 */
export const SENTRY_RULES_SCHEMA = 'sentry.rules.input/v1'

/** 一条规则的语料（编译期只校验形状；命中由 `policy:test` / 门禁跑）。 */
export interface SentryRuleCases {
  readonly match: readonly string[]
  readonly nonMatch: readonly string[]
}

/** 规范化 IR 的一条规则。 */
export interface SentryRuleIr {
  readonly id: string
  readonly family: SentryRuleFamily
  readonly note: string
  /** 正则源码（已过安全子集）。 */
  readonly pattern: string
  /** 只允许 `i` / `m` / `s` 的组合（排序后的字符串）。 */
  readonly flags: string
  readonly cases: SentryRuleCases
}

/** 规范化 IR：唯一可执行形态，也是语义摘要的输入。 */
export interface SentryRulesIr {
  readonly apiVersion: 'bah.policy/v1'
  readonly kind: 'sentry.rules'
  readonly name: string
  readonly version: string
  readonly schema: typeof SENTRY_RULES_SCHEMA
  readonly engine: { readonly min: string; readonly max: string }
  readonly rules: readonly SentryRuleIr[]
}

/** 编译后的一条可执行规则（与 `@bah/safety` 的 `BuiltinRule` 结构等价）。 */
export interface CompiledSentryRule {
  readonly id: string
  readonly family: string
  readonly note: string
  readonly pattern: RegExp
}

/** 编译产物。 */
export interface CompiledRuleSet {
  readonly ir: SentryRulesIr
  readonly descriptor: PolicyDescriptor
  readonly rules: readonly CompiledSentryRule[]
}

/** `lock.json`（与 bank.tier 同格式，kind 不同）。 */
export interface SentryRulesLock {
  readonly apiVersion: 'bah.policy.lock/v1'
  readonly kind: 'sentry.rules'
  readonly name: string
  readonly version: string
  readonly engineVersion: string
  readonly semanticDigest: string
  readonly sourceDigest: string
  readonly files: readonly { readonly name: string; readonly bytes: number; readonly digest: string }[]
}

/** 编译结果。 */
export interface SentryCompileResult {
  readonly compiled: CompiledRuleSet
  readonly lock: SentryRulesLock
  readonly lockPresent: boolean
}

/** 编译选项（与 bank.tier 对齐：锁校验可关，语料不参与启动路径）。 */
export interface SentryCompileOptions {
  readonly verifyLock?: boolean
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
  'rules',
])

const RULE_KEYS = new Set(['id', 'family', 'note', 'pattern', 'flags', 'cases'])
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/
const RULE_ID = /^[A-Z]{3}-\d{3}$/
const PATTERN_WHITELIST_FLAGS = new Set(['i', 'm', 's'])

/**
 * 正则安全子集（保守版；放行的形状必须能证明"无可灾难回溯的嵌套量词"）。
 *
 * 只拦四类经典形态：
 * 1. 反向引用 `\1`；
 * 2. lookbehind `(?<=` / `(?<!`；
 * 3. 量词直接套在"以无界量词开头的分组"上：`(a+)+`、`(.*)*`、`(?:x*)+`；
 * 4. 连续 `.*.*` / `.+.*` 这类多段通配。
 *
 * 已知不入子集的形态（靠语料 + 影子兜底）：`(-[a-z]{1,2}\s*)+` 这类"组内以字面量锚定"的
 * 有界重复——13 条内置规则里 CMD-001 就是这种写法，误报会直接把合法规则拒之门外。
 */
const FORBIDDEN_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\\[1-9]/, why: '禁止反向引用（\\1..\\9）' },
  { pattern: /\(\?<[=!]/, why: '禁止 lookbehind（(?<= / (?<!）' },
  { pattern: /\((?:\?:)?(?:\\?[^\\]|\\.)[+*]\)[+*]/, why: '禁止嵌套量词（(a+)+ / (.*)*）' },
  { pattern: /\.\*\.\*|\.\+\.\*/, why: '禁止多段通配（.*.*）' },
]

/** 安全校验：不通过即抛 `policy-regex-unsafe`（带 file:line 与 ruleId）。 */
export function assertSafePattern(source: YamlSource, ruleId: string, pattern: string): void {
  if (pattern.length > SENTRY_RULE_LIMITS.maxPatternChars) {
    throw ruleError(
      source,
      ruleId,
      'policy-regex-unsafe',
      `正则长度 ${String(pattern.length)} 超过 ${String(SENTRY_RULE_LIMITS.maxPatternChars)}`,
      { ruleId, limit: 'maxPatternChars' },
    )
  }
  for (const rule of FORBIDDEN_PATTERNS) {
    if (rule.pattern.test(pattern)) {
      throw ruleError(source, ruleId, 'policy-regex-unsafe', rule.why, { ruleId })
    }
  }
  for (const match of pattern.matchAll(/\[[^\]]*\]/g)) {
    if (match[0].length > SENTRY_RULE_LIMITS.maxCharClassChars) {
      throw ruleError(
        source,
        ruleId,
        'policy-regex-unsafe',
        `字符类长度 ${String(match[0].length)} 超过 ${String(SENTRY_RULE_LIMITS.maxCharClassChars)}`,
        { ruleId, limit: 'maxCharClassChars' },
      )
    }
  }
}

/** 读 manifest 里的规则集并编译（纯函数，不碰磁盘）。 */
export function compileRuleBundle(bundle: {
  readonly dir: string
  readonly files: Readonly<Record<string, string>>
}, options: SentryCompileOptions = {}): SentryCompileResult {
  const dir = bundle.dir.replace(/\\/g, '/').replace(/\/+$/g, '')
  const parts = dir.split('/').filter((part) => part.length > 0)
  const dirVersion = parts[parts.length - 1] ?? ''
  const dirName = parts[parts.length - 2] ?? ''

  const files = normalizeFiles(bundle.files)
  const manifestText = files['bundle.yml']
  if (manifestText === undefined) {
    throw policyError('policy-parse-error', '缺少文件 `bundle.yml`', { file: 'bundle.yml' })
  }
  const totalBytes = Object.values(files).reduce(
    (sum, content) => sum + Buffer.byteLength(content, 'utf8'),
    0,
  )
  if (totalBytes > SENTRY_RULE_LIMITS.maxBundleBytes) {
    throw policyError(
      'policy-limit-exceeded',
      `bundle 总字节超过 ${String(SENTRY_RULE_LIMITS.maxBundleBytes)}`,
      { limit: 'maxBundleBytes', max: SENTRY_RULE_LIMITS.maxBundleBytes, size: totalBytes },
    )
  }

  const source = parseYaml(manifestText, 'bundle.yml')
  const manifest = readManifest(source, dirName, dirVersion)
  const rules = manifest.rules
  const ir: SentryRulesIr = {
    apiVersion: 'bah.policy/v1',
    kind: 'sentry.rules',
    name: manifest.name,
    version: manifest.version,
    schema: SENTRY_RULES_SCHEMA,
    engine: manifest.engine,
    rules,
  }
  const sources = sourceFiles(files)
  const descriptor = descriptorOf(
    ir,
    manifest.owners,
    sourceDigestOf(sources),
    POLICY_ENGINE_VERSION,
  )
  const lock = buildLock(ir, descriptor, sources)
  if (options.verifyLock !== false) verifyLock(files['lock.json'], lock)

  const compiledRules = deepFreeze(
    ir.rules.map((rule) => ({
      id: rule.id,
      family: rule.family,
      note: rule.note,
      pattern: buildRegExp(rule),
    })),
  )
  return {
    compiled: { ir: deepFreeze(ir), descriptor, rules: compiledRules },
    lock,
    lockPresent: files['lock.json'] !== undefined,
  }
}

/** 语料体检：每条规则的 match 全命中、nonMatch 全不命中（门禁/`policy:test` 用）。 */
export function checkRuleCases(compiled: CompiledRuleSet): readonly string[] {
  const failures: string[] = []
  for (const rule of compiled.rules) {
    const ir = compiled.ir.rules.find((candidate) => candidate.id === rule.id)
    if (ir === undefined) continue
    for (const text of ir.cases.match) {
      if (!rule.pattern.test(text)) failures.push(`${rule.id}: 正例未命中：${text}`)
    }
    for (const text of ir.cases.nonMatch) {
      if (rule.pattern.test(text)) failures.push(`${rule.id}: 反例被命中：${text}`)
    }
  }
  return failures
}

/** 序列化 lock（2 空格 + 末尾换行，与 bank.tier 一致）。 */
export function serializeRuleLock(lock: SentryRulesLock): string {
  return `${JSON.stringify({ ...lock, files: [...lock.files].sort((a, b) => (a.name < b.name ? -1 : 1)) }, null, 2)}\n`
}

/** 规则集 manifest（只留编译需要的字段）。 */
interface SentryManifest {
  readonly name: string
  readonly version: string
  readonly owners: readonly string[]
  readonly engine: { readonly min: string; readonly max: string }
  readonly rules: readonly SentryRuleIr[]
}

function readManifest(source: YamlSource, dirName: string, dirVersion: string): SentryManifest {
  const plain = toPlainRecord(source)
  rejectUnknown(source, plain, MANIFEST_KEYS, [])

  if (plain['apiVersion'] !== 'bah.policy/v1') {
    throw manifestError(source, ['apiVersion'], 'policy-schema-invalid', '只认 bah.policy/v1')
  }
  if (plain['kind'] !== 'sentry.rules') {
    throw manifestError(source, ['kind'], 'policy-schema-invalid', 'sentry 规则集 kind 必须是 sentry.rules')
  }
  const name = requireString(source, plain['name'], ['name'], 'name')
  const version = String(plain['version'])
  if (!SEMVER.test(version)) {
    throw manifestError(source, ['version'], 'policy-bad-semver', `版本必须是 semver：${version}`)
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
  if (description.length < 8 || description.length > 200) {
    throw manifestError(source, ['description'], 'policy-schema-invalid', 'description 长度必须在 8..200')
  }
  const owners = requireStringArray(source, plain['owners'], ['owners'], 'owners')
  if (owners.length === 0) {
    throw manifestError(source, ['owners'], 'policy-schema-invalid', 'owners 不能为空')
  }
  if (plain['schema'] !== SENTRY_RULES_SCHEMA) {
    throw manifestError(source, ['schema'], 'policy-schema-invalid', `只认 ${SENTRY_RULES_SCHEMA}`)
  }
  const engine = readEngineRange(source, plain['engine'])
  const rulesValue = plain['rules']
  if (!Array.isArray(rulesValue)) {
    throw manifestError(source, ['rules'], 'policy-schema-invalid', 'rules 必须是数组')
  }
  if (rulesValue.length === 0 || rulesValue.length > SENTRY_RULE_LIMITS.maxRules) {
    throw manifestError(
      source,
      ['rules'],
      'policy-limit-exceeded',
      `规则数必须在 1..${String(SENTRY_RULE_LIMITS.maxRules)}`,
      { limit: 'maxRules', max: SENTRY_RULE_LIMITS.maxRules, size: rulesValue.length },
    )
  }
  const rules = rulesValue.map((value, index) => readRule(source, value, index))
  const ids = new Set<string>()
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw ruleError(source, rule.id, 'policy-duplicate-rule', `规则 ID 重复：${rule.id}`, {
        ruleId: rule.id,
        id: rule.id,
      })
    }
    ids.add(rule.id)
  }

  return { name, version, owners, engine, rules }
}

function readRule(source: YamlSource, value: unknown, index: number): SentryRuleIr {
  const path = ['rules', index]
  if (!isRecord(value)) {
    throw manifestError(source, path, 'policy-schema-invalid', 'rule 必须是对象')
  }
  rejectUnknown(source, value, RULE_KEYS, path)
  const id = requireString(source, value['id'], [...path, 'id'], 'id')
  if (!RULE_ID.test(id)) {
    throw manifestError(source, path, 'policy-schema-invalid', `规则 ID 必须匹配 ${RULE_ID.source}`, {
      ruleId: id,
    })
  }
  const family = requireString(source, value['family'], [...path, 'family'], 'family')
  if (!(SENTRY_RULE_FAMILIES as readonly string[]).includes(family)) {
    throw manifestError(
      source,
      [...path, 'family'],
      'policy-schema-invalid',
      `family 必须是 ${SENTRY_RULE_FAMILIES.join(' | ')}`,
      { ruleId: id },
    )
  }
  const note = requireString(source, value['note'], [...path, 'note'], 'note')
  if (note.length < 4 || note.length > 200) {
    throw manifestError(source, [...path, 'note'], 'policy-schema-invalid', 'note 长度必须在 4..200', {
      ruleId: id,
    })
  }
  const pattern = requireString(source, value['pattern'], [...path, 'pattern'], 'pattern')
  assertSafePattern(source, id, pattern)
  const flags = readFlags(source, value['flags'], id)
  assertRegExpCompiles(source, id, pattern, flags)
  const cases = readCases(source, value['cases'], id)

  return { id, family: family as SentryRuleFamily, note, pattern, flags, cases }
}

function readFlags(source: YamlSource, value: unknown, ruleId: string): string {
  if (value === undefined) return ''
  if (typeof value !== 'string') {
    throw ruleError(source, ruleId, 'policy-schema-invalid', 'flags 必须是字符串', { ruleId })
  }
  const flags = [...new Set(value.split(''))].sort().join('')
  for (const flag of flags) {
    if (!PATTERN_WHITELIST_FLAGS.has(flag)) {
      throw ruleError(source, ruleId, 'policy-regex-unsafe', `不允许的正则 flag：${flag}`, { ruleId })
    }
  }
  return flags
}

function assertRegExpCompiles(source: YamlSource, ruleId: string, pattern: string, flags: string): void {
  try {
    void new RegExp(pattern, flags)
  } catch (error) {
    throw ruleError(
      source,
      ruleId,
      'policy-regex-unsafe',
      `正则无法编译：${error instanceof Error ? error.message : String(error)}`,
      { ruleId },
    )
  }
}

function readCases(source: YamlSource, value: unknown, ruleId: string): SentryRuleCases {
  if (!isRecord(value)) {
    throw ruleError(source, ruleId, 'policy-schema-invalid', 'cases 必须是 { match, nonMatch }', {
      ruleId,
    })
  }
  rejectUnknown(source, value, new Set(['match', 'nonMatch']), ['cases'])
  const match = requireStringArray(source, value['match'], ['cases', 'match'], 'match')
  const nonMatch = requireStringArray(source, value['nonMatch'], ['cases', 'nonMatch'], 'nonMatch')
  if (match.length < 2 || nonMatch.length < 2) {
    throw ruleError(
      source,
      ruleId,
      'policy-schema-invalid',
      `每条规则至少 2 正例 + 2 反例（收到 ${String(match.length)}+${String(nonMatch.length)}）`,
      { ruleId },
    )
  }
  return { match, nonMatch }
}

function buildRegExp(rule: SentryRuleIr): RegExp {
  try {
    return new RegExp(rule.pattern, rule.flags)
  } catch (error) {
    // 不可达：同一 pattern/flags 已在 `readRule` 的 `assertRegExpCompiles` 里编译成功
    /* v8 ignore next 6 */
    throw policyError(
      'policy-eval-invalid',
      `编译后的规则 ${rule.id} 无法构造 RegExp：${error instanceof Error ? error.message : String(error)}`,
      { ruleId: rule.id },
    )
  }
}

function buildLock(
  ir: SentryRulesIr,
  descriptor: PolicyDescriptor,
  sources: readonly SourceFile[],
): SentryRulesLock {
  return {
    apiVersion: 'bah.policy.lock/v1',
    kind: 'sentry.rules',
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

function verifyLock(raw: string | undefined, computed: SentryRulesLock): void {
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
  for (const key of ['semanticDigest', 'sourceDigest'] as const) {
    if (parsed[key] !== computed[key]) {
      throw policyError('policy-digest-mismatch', `${key} 不符：bundle 被就地改动`, {
        file: 'lock.json',
        expected: String(parsed[key]),
        actual: computed[key],
      })
    }
  }
}

/** 参与源摘要的文件：manifest + CHANGELOG（sentry 规则与语料都在 manifest 里）。 */
function sourceFiles(files: Readonly<Record<string, string>>): SourceFile[] {
  const changelog = files['CHANGELOG.md']
  if (changelog === undefined) {
    throw policyError('policy-corpus-missing', '缺少文件 `CHANGELOG.md`', { file: 'CHANGELOG.md' })
  }
  return [
    { name: 'bundle.yml', content: files['bundle.yml'] as string },
    { name: 'CHANGELOG.md', content: changelog },
  ]
}

function readEngineRange(
  source: YamlSource,
  value: unknown,
): { readonly min: string; readonly max: string } {
  if (!isRecord(value)) {
    throw manifestError(source, ['engine'], 'policy-schema-invalid', 'engine 必须是 { min, max }')
  }
  rejectUnknown(source, value, new Set(['min', 'max']), ['engine'])
  const min = stringOf(value['min'])
  const max = stringOf(value['max'])
  if (!SEMVER.test(min)) {
    throw manifestError(source, ['engine', 'min'], 'policy-bad-semver', `engine.min 不是 semver：${min}`)
  }
  if (!SEMVER.test(max) && !/^\d+\.x$/.test(max)) {
    throw manifestError(source, ['engine', 'max'], 'policy-bad-semver', `engine.max 不是 semver/通配：${max}`)
  }
  if (!engineSatisfies(POLICY_ENGINE_VERSION, min, max)) {
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

function engineSatisfies(version: string, min: string, max: string): boolean {
  const current = version.split('.').map(Number)
  const lower = min.split('.').map(Number)
  if (compareTriple(current, lower) < 0) return false
  if (/^\d+\.x$/.test(max)) return current[0] === Number(max.slice(0, max.indexOf('.')))
  return compareTriple(current, max.split('.').map(Number)) <= 0
}

function compareTriple(left: readonly number[], right: readonly number[]): number {
  for (const index of [0, 1, 2] as const) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta
  }
  return 0
}

function normalizeFiles(files: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, content] of Object.entries(files)) {
    result[name] = normalizeSourceText(content)
  }
  return result
}

function toPlainRecord(source: YamlSource): Record<string, unknown> {
  const plain = toPlain(source)
  if (!isRecord(plain)) {
    throw manifestError(source, [], 'policy-schema-invalid', 'bundle.yml 根节点必须是对象')
  }
  return plain
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value)
}

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

function requireStringArray(
  source: YamlSource,
  value: unknown,
  path: readonly (string | number)[],
  field: string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw manifestError(source, path, 'policy-schema-invalid', `${field} 必须是非空字符串数组`, { field })
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

function manifestError(
  source: YamlSource,
  path: readonly (string | number)[],
  code: PolicyErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const loc = locOf(source, path)
  return policyError(code, message, { file: source.file, line: loc.line, column: loc.column, ...extra })
}

function ruleError(
  source: YamlSource,
  ruleId: string,
  code: PolicyErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): Error {
  const index = findRuleIndex(source, ruleId)
  const path = index === undefined ? ['rules'] : ['rules', index]
  const loc = locOf(source, path)
  return policyError(code, message, {
    file: source.file,
    line: loc.line,
    column: loc.column,
    ruleId,
    ...extra,
  })
}

function findRuleIndex(source: YamlSource, ruleId: string): number | undefined {
  const plain = toPlain(source)
  if (!isRecord(plain) || !Array.isArray(plain['rules'])) return undefined
  const index = plain['rules'].findIndex(
    (rule) => isRecord(rule) && rule['id'] === ruleId,
  )
  return index < 0 ? undefined : index
}
