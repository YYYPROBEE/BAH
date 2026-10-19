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
import { KNOWLEDGE_SERVICE, createFixtureKnowledgePort, createHttpKnowledgePort, createKnowledgeTools } from '@bah/knowledge'
import type { FixtureKnowledgeOptions, KnowledgePort } from '@bah/knowledge'
import { SESSION_SERVICE, TOOLS_SERVICE } from '@bah/runtime'
import type { SessionApi } from '@bah/runtime'
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
}

const WHERE = 'bank:knowledge'
const MODES = ['http', 'fixture'] as const
const CLAIM_KEYS = ['role', 'audience', 'region'] as const

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

/** 校验并补默认值（fail-loud；未知键直接拒绝）。 */
export function parseKnowledgeSettings(
  config: Readonly<Record<string, unknown>>,
): KnowledgeSettings {
  rejectUnknownKeys(
    config,
    ['mode', 'baseUrl', 'tokenEnv', 'required', 'channel', 'claims', 'timeouts', 'fixturePath'],
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
    ...(fixturePath === undefined ? {} : { fixturePath }),
  }
}

function loadFixture(path: string): KnowledgePort {
  const full = resolve(process.cwd(), path)
  try {
    const raw = JSON.parse(readFileSync(full, 'utf8')) as FixtureKnowledgeOptions
    return createFixtureKnowledgePort(raw)
  } catch {
    throw bootError('invalid-config', `${WHERE}.fixturePath 读取失败：${full}`, { path: full })
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

      const port =
        config.mode === 'fixture' && config.fixturePath !== undefined
          ? loadFixture(config.fixturePath)
          : createHttpKnowledgePort({
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

      ctx.effect(ctx.provide(KNOWLEDGE_SERVICE, port))

      const [answerTool, queryTool] = createKnowledgeTools({
        port,
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
          appendIgnorable(session, 'knowledge/answered', {
            traceId: response.traceId,
            kind: response.kind,
            verdict: response.verdict,
            reasonCode: response.reasonCode ?? null,
            citationCount: response.citations.length,
            answerChars: response.answer.length,
            at: run.now(),
          })
        },
        onQueried: ({ response }) => {
          appendIgnorable(session, 'knowledge/queried', {
            traceId: response.traceId,
            kind: response.kind,
            visibleCount: response.visibleCount,
            verdict: response.verdict,
            reasonCode: response.reasonCode ?? null,
            citationCount: response.evidence.length,
            at: run.now(),
          })
        },
      })

      ctx.effect(tools.register(answerTool))
      ctx.effect(tools.register(queryTool))
    },
  },

  validate: parseKnowledgeSettings,
}

/** 领域事件落账：`SessionApi.append` 的公开键是平台族，领域事件用同一增强机制追加。 */
function appendIgnorable(session: SessionApi, type: string, data: unknown): void {
  const append = session.append as unknown as (
    type: string,
    data: unknown,
    options: { ignorable: boolean },
  ) => unknown
  append(type, data, { ignorable: true })
}
