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
 *
 * 鉴权：`/healthz` 匿名，但 `/v1/*` 一律要求 Bearer token（sidecar 无 token 直接拒启）。
 * 因此"探活通过"不等于"能问答"：缺 `tokenEnv` 时启动期额外告警，工具会以
 * `knowledge-denied` 明确拒绝，而不是静默返回空证据。
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
import type { TenantId } from '@bah/util'
import { SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import { BahError, tenantEnvSuffix } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { withKnowledgeSpans } from './knowledge-spans.ts'
import { tryTelemetry } from './telemetry.ts'
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
  /** `false` = 不做签名门（仅限演示回滚；必须在  登记）。 */
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

/**
 * 知识库令牌的**环境变量解析结果**（01 TA-17）。
 *
 * `tenantScoped: false` 表示用的是共享令牌（回退）；非 demo 租户**不许**这样跑，
 * 否则一台机器上两个租户共用一把密钥，任一泄漏即全平台可查。
 */
export interface KnowledgeTokenEnv {
  readonly envName: string
  readonly tenantScoped: boolean
}

/**
 * 按租户选环境变量名（带回退）。
 *
 * 顺序：`<base>_<TENANT>` → `<base>` → 未设置。
 *
 * 为什么**必须**留回退：CI 与本地都只配一个 `BAH_KNOWLEDGE_TOKEN`（`ci-matrix.yml` 就是这么
 * 注入的），删掉回退会让装知识库的那两个 profile 在 CI 里直接起不来——过渡期必须能跑。
 * 代价由调用方兜：非 demo 租户用到回退时是 fail-loud。
 */
export function resolveKnowledgeTokenEnv(
  env: Readonly<Record<string, string | undefined>>,
  tenantId: TenantId,
  baseEnv: string,
): KnowledgeTokenEnv | undefined {
  const perTenant = `${baseEnv}_${tenantEnvSuffix(tenantId)}`
  if ((env[perTenant] ?? '').trim() !== '') return { envName: perTenant, tenantScoped: true }
  if ((env[baseEnv] ?? '').trim() !== '') return { envName: baseEnv, tenantScoped: false }
  return undefined
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
      const tenantId = run.tenantId

      const fixture =
        config.mode === 'fixture' && config.fixturePath !== undefined
          ? loadFixture(config.fixturePath)
          : undefined
      // 空串等同于未设置：带一个空 Bearer 只会把 401 拖到第一次工具调用，
      // 启动期就该按"缺 token"处理（见下方告警）。
      const tokenEnv = resolveKnowledgeTokenEnv(process.env, tenantId, config.tokenEnv)
      const token = tokenEnv === undefined ? undefined : process.env[tokenEnv.envName]
      const hasToken = token !== undefined && token.trim() !== ''
      // 非 demo 租户用共享令牌 = 跨租户共用密钥：**启动期就拒绝**（不是告警）。
      // `--dump-config`（probe=false）只看配置、不启动服务，按告警处理：
      // 它的 stderr 契约（A8 严格为空）不能被一条"部署会失败"的提示破坏。
      if (tokenEnv !== undefined && !tokenEnv.tenantScoped && String(tenantId) !== 'demo') {
        const message =
          `${WHERE} 租户 ${String(tenantId)} 正在回退到共享令牌 ${tokenEnv.envName}；` +
          `多租户部署必须配 per-tenant 变量 ${config.tokenEnv}_${tenantEnvSuffix(tenantId)}（否则任一租户的 token 泄漏 = 全平台可查）`
        if (run.probe === false) {
          run.warn?.(`${message}（--dump-config 只看配置，真正的启动会失败：knowledge-token-shared）`)
        } else {
          throw bootError('knowledge-token-shared', message, {
            tenantId: String(tenantId),
            envName: tokenEnv.envName,
          })
        }
      } else if (tokenEnv !== undefined && !tokenEnv.tenantScoped && run.probe !== false) {
        // demo 用回退：起得来，但必须留痕（演示机与 CI 都靠这条回退）
        run.warn?.(
          `${WHERE} 租户 demo 回退到共享令牌 ${tokenEnv.envName}；` +
            `多租户部署必须为每个租户配 ${config.tokenEnv}_<TENANT>`,
        )
      }
      const port =
        fixture?.port ??
        createHttpKnowledgePort({
          baseUrl: config.baseUrl,
          ...(hasToken ? { token } : {}),
          timeoutMs: config.timeouts,
        })

      // `probe: false`（`--dump-config`）时不打网络：dump 的语义是"只看配置"，
      // 启动期探活会让一次纯静态检查卡在 1s 超时上。真实启动不传，走原路径。
      if (config.mode === 'http' && run.probe !== false) {
        try {
          await port.health()
          // /healthz 是匿名口：能探活不等于能问。缺 token 时工具必然 401，
          // 启动期就要说清，不能等演示现场第一次提问才暴露。
          if (!hasToken) {
            run.warn?.(
              `${WHERE} 未设置 ${config.tokenEnv}（也未设置 ${config.tokenEnv}_${tenantEnvSuffix(tenantId)}；mode=http）：sidecar 的 /v1/* 一律要求 Bearer token；` +
                'knowledge 工具将返回 knowledge-denied（fail-closed）。' +
                '请用 scripts/rag.mjs / pnpm demo:rag 注入同一 token。',
            )
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (config.required) {
            throw bootError(
              'knowledge-unavailable',
              `${WHERE} 健康检查失败（${config.baseUrl}）：${reason}`,
              { baseUrl: config.baseUrl },
            )
          }
          // `required: false` 是"带病启动"，不是"没有这回事"：sidecar 缺席时检索增强会静默变壳，
          // 必须留下可被演示前发现的痕（CLI 把这里接到 `io.err`）。
          run.warn?.(
            `${WHERE} 健康检查失败（${config.baseUrl}，required=false）：${reason}；` +
              '继续启动，knowledge 工具将返回 knowledge-unavailable',
          )
        }
      }

      const activePort = config.signature.enabled
        ? applySignatureGate({ config, fixture, port })
        : port

      // 可观测性 01：`port.answer()` / `port.query()` 的唯一调用方在 `@bah/knowledge` 内部，
      // 宿主看不到那次调用；套在端口上才能把两个工具都覆盖到。未装遥测时原样透传。
      const telemetry = tryTelemetry(ctx)
      const observedPort = telemetry === undefined ? activePort : withKnowledgeSpans(activePort, telemetry)

      ctx.effect(ctx.provide(KNOWLEDGE_SERVICE, observedPort))

      const [answerTool, queryTool] = createKnowledgeTools({
        port: observedPort,
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
