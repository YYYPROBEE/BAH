/**
 * `policy:explain` 的纯读实现（02 §5.2）：按记录里的 digest 找归档并复算。
 *
 * 与脚本分离是为了让测试直接调用，不必起子进程；脚本只负责参数与排版。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadBundle } from '../packages/policy/src/load.ts'
import { ChainFile, createSagaAudit } from '../packages/persistence/src/chain/index.ts'
import { BahError, canonicalJson, sha256Hex } from '../packages/util/src/index.ts'

import { toolNames } from './policy-cli.ts'
import {
  readRegistry,
  readSessionEvents,
  resolveBundleDir,
  type AdminPaths,
  type RegistryEntry,
} from './policy-admin-lib.ts'

/** 解释结果（`--json` 原样输出；人类输出由 `printHuman` 排版）。 */
export interface ExplainResult {
  readonly ok: boolean
  readonly session: string
  readonly callId?: string
  readonly policyVersion?: string
  readonly engineVersion?: string
  readonly paramsDigest?: string
  readonly inputDigest?: string
  readonly decision?: { readonly level: string; readonly reason: string; readonly deny?: string }
  readonly ruleIds?: readonly string[]
  readonly rules?: readonly { readonly id: string; readonly line?: number }[]
  readonly reproduced: boolean
  readonly chain: { readonly status: 'verified' | 'missing' | 'mismatch'; readonly q?: number }
  readonly evidence: 'present' | 'missing'
  readonly diffs: readonly string[]
}

/** 解释一条判决；失败抛 `policy-*`（CLI 统一转退出码 1）。 */
export function explainDecision(input: {
  readonly session: string
  readonly sessionsDir: string
  readonly callId?: string
  readonly seq?: number
  readonly paths: AdminPaths
  readonly requireChain: boolean
  readonly requireEvidence: boolean
}): ExplainResult {
  const events = readSessionEvents(input.sessionsDir, input.session)
  const candidates = events.filter((event) => event['type'] === 'tier/decided')
  const event =
    input.callId !== undefined
      ? candidates.find(
          (candidate) => (candidate['data'] as { callId?: string }).callId === input.callId,
        )
      : candidates.find((candidate) => eventSeq(candidate) === input.seq)
  if (event === undefined) {
    throw new BahError(
      'policy-decision-missing',
      `会话 ${input.session} 里没有匹配的 tier/decided（callId=${input.callId ?? '-'} seq=${String(input.seq ?? '-')}）`,
    )
  }
  const data = event['data'] as {
    readonly callId?: string
    readonly policyVersion?: string
    readonly ruleIds?: readonly string[]
    readonly paramsDigest?: string
    readonly evidence?: { readonly inputDigest: string; readonly input: unknown }
  }
  const base = {
    ok: true,
    session: input.session,
    ...(data.callId === undefined ? {} : { callId: data.callId }),
    ...(data.policyVersion === undefined ? {} : { policyVersion: data.policyVersion }),
    ...(data.paramsDigest === undefined ? {} : { paramsDigest: data.paramsDigest }),
    ruleIds: data.ruleIds ?? [],
    reproduced: false,
    chain: chainOf(input.sessionsDir, input.session, event),
    evidence: data.evidence === undefined ? ('missing' as const) : ('present' as const),
    diffs: [] as string[],
  } satisfies Omit<ExplainResult, 'ok'> & { ok: boolean }

  if (data.evidence === undefined) {
    return {
      ...base,
      ok: !input.requireEvidence && (!input.requireChain || base.chain.status === 'verified'),
      diffs: input.requireEvidence ? ['evidence-missing'] : [],
    }
  }

  const inputDigest = `sha256:${sha256Hex(canonicalJson(data.evidence.input))}`
  if (inputDigest !== data.evidence.inputDigest) {
    return { ...base, ok: false, inputDigest, diffs: ['input-digest-mismatch'] }
  }

  const identity = parseIdentity(data.policyVersion)
  const entry = registryEntry(input.paths.root, identity)
  const dir = resolveBundleDir(input.paths.root, entry.path)
  if (!existsSync(dir)) {
    throw new BahError('policy-archive-missing', `归档 bundle 缺失：${dir}`, {
      handle: identity.handle,
    })
  }
  const compiled = loadBundle({ dir, verifyLock: true, toolNames: toolNames(), withCorpus: false }).compiled
  const result = compiled.evaluate(compiled.validateInput(data.evidence.input))
  const recorded = event['data'] as { level?: string; reason?: string; code?: string }
  const diffs: string[] = []
  if (String(result.level) !== String(recorded.level)) {
    diffs.push(`level ${String(recorded.level)} → ${result.level}`)
  }
  if (String(result.reason) !== String(recorded.reason)) {
    diffs.push(`reason ${String(recorded.reason)} → ${result.reason}`)
  }
  const replayDeny = result.deny?.code
  if (recorded.code !== replayDeny && !(recorded.code === undefined && replayDeny === undefined)) {
    diffs.push(`deny ${recorded.code ?? '-'} → ${replayDeny ?? '-'}`)
  }
  if ((data.ruleIds ?? []).join(',') !== result.ruleIds.join(',')) {
    diffs.push(`ruleIds ${(data.ruleIds ?? []).join(',') || '-'} → ${result.ruleIds.join(',')}`)
  }
  const chainOk =
    base.chain.status !== 'mismatch' &&
    (!input.requireChain || base.chain.status === 'verified')
  return {
    ...base,
    ok: diffs.length === 0 && chainOk,
    inputDigest,
    engineVersion: compiled.descriptor.engineVersion,
    decision: {
      level: result.level,
      reason: result.reason,
      ...(result.deny === undefined ? {} : { deny: result.deny.code }),
    },
    rules: result.ruleIds.map((id) => {
      const line = lineOfRule(dir, id)
      return { id, ...(line === undefined ? {} : { line }) }
    }),
    reproduced: diffs.length === 0,
    diffs,
  }
}

/** 人类可读输出（02 §5.2 的字段顺序）。 */
export function printExplain(result: ExplainResult): string {
  const lines: string[] = []
  lines.push(`policy        ${result.policyVersion ?? '-'}`)
  lines.push(`engine        ${result.engineVersion ?? '-'}`)
  lines.push(`paramsDigest  ${result.paramsDigest ?? '-'}`)
  lines.push(`inputDigest   ${result.inputDigest ?? '-'}`)
  lines.push(
    `decision      ${result.decision?.level ?? '-'} / ${result.decision?.reason ?? '-'}${result.decision?.deny === undefined ? '' : ` / deny=${result.decision.deny}`}`,
  )
  for (const rule of result.rules ?? []) {
    lines.push(
      `rules         ${rule.id}${rule.line === undefined ? '' : ` (rules.yml:${String(rule.line)})`}`,
    )
  }
  lines.push(
    `reproduced    ${result.reproduced ? 'yes' : `no (${result.diffs.join('; ') || 'evidence-missing'})`}`,
  )
  lines.push(
    `chain         policy/decision ${result.chain.status === 'verified' ? `q=${String(result.chain.q)} d=... verified` : result.chain.status}`,
  )
  lines.push(
    `evidence      ${result.evidence === 'present' ? 'present' : 'missing (policy not consulted)'}`,
  )
  return `${lines.join('\n')}\n`
}

/** 链上 `policy/decision` 与 `d` 的对应关系。 */
function chainOf(
  sessionsDir: string,
  session: string,
  event: Record<string, unknown>,
): ExplainResult['chain'] {
  const path = join(sessionsDir, session, 'audit.jsonl')
  if (!existsSync(path)) return { status: 'missing' }
  const rows = new ChainFile({ rootDir: sessionsDir, fsync: false }).read(session)
  const expected = sha256Hex(canonicalJson(event['data']))
  const row = rows.find((candidate) => candidate.t === 'policy/decision' && candidate.d === expected)
  if (row === undefined) return { status: 'missing' }
  const continuity = createSagaAudit({
    now: () => 0,
    rootDir: sessionsDir,
    fsync: false,
  }).verifyContinuity(session)
  if (!continuity.ok) return { status: 'mismatch' }
  return { status: 'verified', q: row.q }
}

/** `session.jsonl` 行里的序号字段（JsonlPersistence 写 `seq`）。 */
function eventSeq(event: Record<string, unknown>): number | undefined {
  const value = event['seq']
  return typeof value === 'number' ? value : undefined
}

/** 解析 identity：`bank-tier/1.0.0+sha256:<16>`。 */
function parseIdentity(version: string | undefined): { handle: string; digestPrefix: string } {
  if (version === undefined) {
    throw new BahError('policy-archive-missing', 'tier/decided 没有 policyVersion，无法定位归档')
  }
  const match = /^(.+)\+sha256:([0-9a-f]{16})$/.exec(version)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new BahError('policy-archive-missing', `policyVersion 不是内容寻址身份：${version}`)
  }
  return { handle: match[1], digestPrefix: match[2] }
}

/** registry 里找 identity 对应的归档；摘要前缀不符 = 归档缺失（内容已变）。 */
function registryEntry(
  root: string,
  identity: { handle: string; digestPrefix: string },
): RegistryEntry {
  const registry = readRegistry(root)
  for (const group of Object.values(registry.kinds)) {
    const entry = group.versions[identity.handle]
    if (entry !== undefined) {
      if (!entry.semanticDigest.startsWith(identity.digestPrefix)) {
        throw new BahError(
          'policy-archive-missing',
          `registry 里的 ${identity.handle} 摘要与判决记录不符（期望前缀 ${identity.digestPrefix}）`,
        )
      }
      return entry
    }
  }
  throw new BahError('policy-archive-missing', `registry 里没有归档版本 ${identity.handle}`)
}

/** `rules.yml` 里某条规则的行号（IR 不保留行号，这里只做人类可读定位）。 */
function lineOfRule(dir: string, ruleId: string): number | undefined {
  const path = join(dir, 'rules.yml')
  if (!existsSync(path)) return undefined
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const pattern = new RegExp(`\\bid:\\s*['"]?${escapeRegExp(ruleId)}['"]?\\s*$`)
  const index = lines.findIndex((line) => pattern.test(line))
  return index < 0 ? undefined : index + 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
