/**
 * base bundle · `bank:knowledge`：知识平面 sidecar 的宿主接线。
 *
 * 装配四样东西：
 * 1. 端口（http / fixture）与启动健康检查；
 * 2. 两个知识工具（`knowledge_answer` / `knowledge_query`）；
 * 3. principal 组装：会话身份 → claims → 六元组（模型不可见）；
 * 4. `knowledge/answered` / `knowledge/queried` 审计事件。
 *
 * 失败策略：`required: true` 时健康检查失败即拒绝启动；`false` 时只告警，
 * 工具调用会返回 `knowledge-unavailable`，主循环与账户工具不受影响（fail-closed）。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { BANK_IDENTITY } from '@bah/bank'
import {
  KNOWLEDGE_SERVICE,
  collectFixtureEntries,
  createFixtureKnowledgePort,
  createHttpKnowledgePort,
  createKnowledgeTools,
  createVerifiedKnowledgePort,
  loadManifest,
  missingEntryFor,
  parseCorpus,
  requireKnowledgeKey,
  verifyManifest,
} from '@bah/knowledge'
import type { FixtureKnowledgeOptions, KnowledgePort } from '@bah/knowledge'
import { SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import { BahError } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import {
  asRecord,
  bootError,
  readBoolean,
  readEnum,
  readPositiveInteger,
  readRequiredString,
  readString,
  rejectUnknownKeys,
} from '../config.ts'

/** 权限声明（演示档按 userId 映射；生产应由登录凭证绑定）。 */
export interface KnowledgeClaims {
  readonly role: string
  readonly audience: string
  readonly region: string
}

export interface KnowledgeSignatureSettings {
  /** `false` = 不做签名门（仅限演示回滚；必须在 PROGRESS 登记）。 */
  readonly enabled: boolean
  /** 签名清单（相对仓库根）。 */
  readonly manifestPath: string
  /** 语料索引（相对仓库根；10 篇 demo 的全文）。 */
  readonly corpusPath: string
}

export interface KnowledgeSettings {
  readonly mode: 'http' | 'fixture'
  readonly baseUrl: string
  readonly tokenEnv: string
  readonly required: boolean
  readonly channel: string
  readonly claims: {
    readonly default: KnowledgeClaims
    readonly users: Readonly<Record<string, KnowledgeClaims>>
  }
  readonly timeouts: {
    readonly answer: number
    readonly query: number
    readonly health: number
  }
  readonly fixturePath?: string
  readonly signature: KnowledgeSignatureSettings
}

const WHERE = 'bank:knowledge'
const MODES = ['http', 'fixture'] as const
const CLAIM_KEYS = ['role', 'audience', 'region'] as const
const SIGNATURE_DEFAULTS: KnowledgeSignatureSettings = {
  enabled: true,
  manifestPath: 'packages/knowledge/fixtures/knowledge.manifest.json',
  corpusPath: 'packages/knowledge/fixtures/corpus.json',
}

const DEFAULT_CLAIMS: KnowledgeClaims = {
  role: 'retail',
  audience: 'standard',
  region: 'CN-SH',
}

const DEFAULT_SETTINGS: Omit<KnowledgeSettings, 'fixturePath'> = {
  mode: 'http',
  baseUrl: 'http://127.0.0.1:7801',
  tokenEnv: 'BAH_KNOWLEDGE_TOKEN',
  required: false,
  channel: 'headless',
  claims: { default: DEFAULT_CLAIMS, users: {} },
  timeouts: { answer: 8_000, query: 1_500, health: 1_000 },
  signature: SIGNATURE_DEFAULTS,
}

function parseClaims(value: unknown, where: string, fallback?: KnowledgeClaims): KnowledgeClaims {
  if (value === undefined) {
    if (fallback === undefined) throw bootError('invalid-config', `${where} 必填（未写）`, { where })
    return fallback
  }
  const record = asRecord(value, where)
  rejectUnknownKeys(record, CLAIM_KEYS, where)
  return {
    role: readRequiredString(record, 'role', where),
    audience: readRequiredString(record, 'audience', where),
    region: readRequiredString(record, 'region', where),
  }
}

function parseUsers(value: unknown): Readonly<Record<string, KnowledgeClaims>> {
  if (value === undefined) return {}
  const record = asRecord(value, `${WHERE}.claims.users`)
  const users: Record<string, KnowledgeClaims> = {}
  for (const [userId, claims] of Object.entries(record)) {
    users[userId] = parseClaims(claims, `${WHERE}.claims.users.${userId}`)
  }
  return users
}

function parseTimeouts(value: unknown): KnowledgeSettings['timeouts'] {
  if (value === undefined) return DEFAULT_SETTINGS.timeouts
  const where = `${WHERE}.timeouts`
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ['answer', 'query', 'health'], where)
  return {
    answer: readPositiveInteger(record, 'answer', where) ?? DEFAULT_SETTINGS.timeouts.answer,
    query: readPositiveInteger(record, 'query', where) ?? DEFAULT_SETTINGS.timeouts.query,
    health: readPositiveInteger(record, 'health', where) ?? DEFAULT_SETTINGS.timeouts.health,
  }
}

function parseSignature(value: unknown): KnowledgeSignatureSettings {
  if (value === undefined) return SIGNATURE_DEFAULTS
  const where = `${WHERE}.signature`
  const record = asRecord(value, where)
  rejectUnknownKeys(record, ['enabled', 'manifestPath', 'corpusPath'], where)
  return {
    enabled: readBoolean(record, 'enabled', where, SIGNATURE_DEFAULTS.enabled),
    manifestPath: readString(record, 'manifestPath', where) ?? SIGNATURE_DEFAULTS.manifestPath,
    corpusPath: readString(record, 'corpusPath', where) ?? SIGNATURE_DEFAULTS.corpusPath,
  }
}

/** 校验并补默认值（fail-loud；未知键直接拒绝）。 */
export function parseKnowledgeSettings(
  config: Readonly<Record<string, unknown>>,
): KnowledgeSettings {
  rejectUnknownKeys(
    config,
    [
      'mode',
      'baseUrl',
      'tokenEnv',
      'required',
      'channel',
      'claims',
      'timeouts',
      'fixturePath',
      'signature',
    ],
    WHERE,
  )
  const claims = config['claims'] === undefined
    ? DEFAULT_SETTINGS.claims
    : (() => {
        const record = asRecord(config['claims'], `${WHERE}.claims`)
        rejectUnknownKeys(record, ['default', 'users'], `${WHERE}.claims`)
        return {
          default: parseClaims(record['default'], `${WHERE}.claims.default`, DEFAULT_CLAIMS),
          users: parseUsers(record['users']),
        }
      })()
  const mode = readEnum(config, 'mode', WHERE, MODES) ?? DEFAULT_SETTINGS.mode
  const fixturePath = readString(config, 'fixturePath', WHERE)
  if (mode === 'fixture' && fixturePath === undefined) {
    throw bootError('invalid-config', `${WHERE}.fixturePath 在 mode=fixture 时必填`, { where: WHERE })
  }
  return {
    mode,
    baseUrl: readString(config, 'baseUrl', WHERE) ?? DEFAULT_SETTINGS.baseUrl,
    tokenEnv: readString(config, 'tokenEnv', WHERE) ?? DEFAULT_SETTINGS.tokenEnv,
    required: readBoolean(config, 'required', WHERE, DEFAULT_SETTINGS.required),
    channel: readString(config, 'channel', WHERE) ?? DEFAULT_SETTINGS.channel,
    claims,
    timeouts: parseTimeouts(config['timeouts']),
    signature: parseSignature(config['signature']),
    ...(fixturePath === undefined ? {} : { fixturePath }),
  }
}

interface LoadedFixture {
  readonly port: KnowledgePort
  readonly raw: unknown
  readonly fullPath: string
}

function loadFixture(path: string): LoadedFixture {
  const full = resolve(process.cwd(), path)
  try {
    const raw = JSON.parse(readFileSync(full, 'utf8')) as FixtureKnowledgeOptions
    return { port: createFixtureKnowledgePort(raw), raw, fullPath: full }
  } catch {
    throw bootError('invalid-config', `${WHERE}.fixturePath 读取失败：${full}`, { path: full })
  }
}

/**
 * 装配签名门（W06）：密钥 → 清单 → 文件摘要 → 条目 HMAC → 可验证端口。
 *
 * 任何一步失败都 `invalid-config`（不是告警）：没有签名清单的权威库等于没有权威库。
 * 错误信息必须点名出问题的文件（TC-W06-04）。
 */
function applySignatureGate(options: {
  readonly config: KnowledgeSettings
  readonly fixture: LoadedFixture | undefined
  readonly port: KnowledgePort
}): KnowledgePort {
  const { config, fixture, port } = options
  const root = process.cwd()
  try {
    const key = requireKnowledgeKey()
    const manifest = loadManifest(root, config.signature.manifestPath)
    const requiredFiles = [
      config.signature.corpusPath,
      ...(fixture === undefined || config.fixturePath === undefined ? [] : [config.fixturePath]),
    ]
    verifyManifest({ root, manifest, key, requiredFiles })

    if (fixture !== undefined) {
      const entries = manifest.entries.filter((entry) => entry.source === 'fixture')
      const actual = collectFixtureEntries(fixture.raw)
      const missing = missingEntryFor(entries, actual)
      if (missing !== undefined) {
        throw new BahError(
          'knowledge-signature-entry-missing',
          `签名清单缺少 fixture 条目：${missing.docId}#${String(missing.chunkId)}`,
          { docId: missing.docId, chunkId: missing.chunkId },
        )
      }
      return createVerifiedKnowledgePort({ port, entries, key })
    }

    const corpus = parseCorpus(
      readFileSync(resolve(root, config.signature.corpusPath), 'utf8'),
      config.signature.corpusPath,
    )
    const entries = manifest.entries.filter((entry) => entry.source === 'corpus')
    const missing = missingEntryFor(entries, corpus.docs)
    if (missing !== undefined) {
      throw new BahError(
        'knowledge-signature-entry-missing',
        `签名清单缺少语料条目：${missing.docId}#${String(missing.chunkId)}；请运行 pnpm knowledge:sign`,
        { docId: missing.docId, chunkId: missing.chunkId },
      )
    }
    return createVerifiedKnowledgePort({ port, entries, key })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw bootError('invalid-config', `${WHERE}.signature: ${reason}`, {
      code: error instanceof BahError ? error.code : 'knowledge-signature-failed',
    })
  }
}

export const knowledgePlugin: HostPlugin<KnowledgeSettings> = {
  id: 'bank:knowledge',

  plugin: {
    name: 'bank:knowledge',
    inject: [RUN_SERVICE.id, TOOLS_SERVICE.id, SESSION_SERVICE.id, BANK_IDENTITY.id],
    async apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const tools = ctx.get(TOOLS_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const identity = ctx.get(BANK_IDENTITY)

      const fixture =
        config.mode === 'fixture' && config.fixturePath !== undefined
          ? loadFixture(config.fixturePath)
          : undefined
      const port =
        fixture?.port ??
        createHttpKnowledgePort({
          baseUrl: config.baseUrl,
          ...(process.env[config.tokenEnv] === undefined
            ? {}
            : { token: process.env[config.tokenEnv] as string }),
          timeoutMs: config.timeouts,
        })

      if (config.mode === 'http') {
        try {
          await port.health()
        } catch (error) {
          if (config.required) {
            const reason = error instanceof Error ? error.message : String(error)
            throw bootError(
              'knowledge-unavailable',
              `${WHERE} 健康检查失败（${config.baseUrl}）：${reason}`,
              { baseUrl: config.baseUrl },
            )
          }
        }
      }

      const activePort = config.signature.enabled
        ? applySignatureGate({ config, fixture, port })
        : port

      ctx.effect(ctx.provide(KNOWLEDGE_SERVICE, activePort))

      const [answerTool, queryTool] = createKnowledgeTools({
        port: activePort,
        principalOf: (sessionId) => {
          const userId = identity.resolve(sessionId)
          if (userId === undefined) {
            throw new BahError(
              'knowledge-identity-missing',
              '当前会话未绑定银行用户，无法确定知识权限',
              { sessionId },
            )
          }
          const claims = config.claims.users[userId] ?? config.claims.default
          return {
            role: claims.role,
            audience: claims.audience,
            channel: config.channel,
            region: claims.region,
            productId: null,
            now: new Date(run.now()).toISOString(),
          }
        },
        onAnswered: ({ response }) => {
          session.appendDomain('knowledge/answered', {
            traceId: response.traceId,
            kind: response.kind,
            verdict: response.verdict,
            reasonCode: response.reasonCode ?? null,
            citationCount: response.citations.length,
            answerChars: response.answer.length,
            at: run.now(),
          }, { ignorable: true })
        },
        onQueried: ({ response }) => {
          session.appendDomain('knowledge/queried', {
            traceId: response.traceId,
            kind: response.kind,
            visibleCount: response.visibleCount,
            verdict: response.verdict,
            reasonCode: response.reasonCode ?? null,
            citationCount: response.evidence.length,
            at: run.now(),
          }, { ignorable: true })
        },
      })

      ctx.effect(tools.register(answerTool))
      ctx.effect(tools.register(queryTool))
    },
  },

  validate: parseKnowledgeSettings,
}
