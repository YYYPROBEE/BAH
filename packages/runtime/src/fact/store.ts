/**
 * 生活事实账本的确定性实现。
 *
 * 不读时钟（`at` 注入）、不读随机（`nextId` 注入）、无 I/O。
 * 版本号是授权窗口 `fact-unchanged` 条件的唯一依据：**每次写入 +1**，
 * 包括"再确认"（确认也是一次写入，也要让窗口知道事实变过）。
 */

import { BahError } from '@bah/util'

import {
  FACT_FORGET_TOOL,
  FACT_REMEMBER_TOOL,
  MAX_FACT_NOTE_LENGTH,
  MAX_FACTS,
  type FactKind,
  type FactRememberInput,
  type FactRelation,
  type FactStore,
  type LifeFact,
} from './types.ts'

import type { AnySessionEvent } from '../session/types.ts'

/** id 分配器（确定性：`f-1`、`f-2`…）。 */
export interface FactStoreDeps {
  readonly nextId: () => string
}

/** 去重键：同一个人 + 关系 + 种类 + 日期 = 同一条事实。 */
function identityOf(input: FactRememberInput): string {
  return [input.person, input.relation, input.kind, input.date ?? ''].join('\u0000')
}

const RELATIONS: ReadonlySet<string> = new Set(['self', 'spouse', 'parent', 'child', 'other'])
const KINDS: ReadonlySet<string> = new Set(['birthday', 'anniversary', 'obligation', 'preference'])

function validate(input: FactRememberInput): void {
  if (input.person.trim().length === 0) {
    throw new BahError('fact-invalid', 'fact_remember: person 不能为空', {})
  }
  if (!RELATIONS.has(input.relation)) {
    throw new BahError('fact-invalid', `fact_remember: 关系取值非法：${String(input.relation)}`, {})
  }
  if (!KINDS.has(input.kind)) {
    throw new BahError('fact-invalid', `fact_remember: 种类取值非法：${String(input.kind)}`, {})
  }
  if (input.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new BahError('fact-invalid', `fact_remember: 日期必须是 YYYY-MM-DD：${input.date}`, {})
  }
  if (input.note !== undefined && input.note.length > MAX_FACT_NOTE_LENGTH) {
    throw new BahError('fact-invalid', `fact_remember: note 超过 ${String(MAX_FACT_NOTE_LENGTH)} 字`, {})
  }
}

interface Internals {
  readonly store: FactStore
  readonly load: (fact: LifeFact) => void
  readonly remove: (factId: string) => void
}

function makeStore(deps: FactStoreDeps): Internals {
  const facts = new Map<string, LifeFact>()
  const byIdentity = new Map<string, string>()

  const mustGet = (factId: string): LifeFact => {
    const fact = facts.get(factId)
    if (fact === undefined) {
      throw new BahError('fact-unknown', `fact: ${factId} 不存在`, { factId })
    }
    return fact
  }

  const store: FactStore = {
    remember: (input, at, sourceTurn) => {
      validate(input)
      const key = identityOf(input)
      const existingId = byIdentity.get(key)
      if (existingId !== undefined) {
        const previous = mustGet(existingId)
        const next: LifeFact = {
          ...previous,
          ...(input.note === undefined ? {} : { note: input.note }),
          confirmed: input.confirmed ?? previous.confirmed,
          version: previous.version + 1,
          sourceTurn,
          updatedAt: at,
        }
        facts.set(next.factId, next)
        return next
      }
      if (facts.size >= MAX_FACTS) {
        throw new BahError('fact-limit-exceeded', `fact: 事实条数已达上限 ${String(MAX_FACTS)}`, {})
      }
      const fact: LifeFact = {
        factId: deps.nextId(),
        person: input.person,
        relation: input.relation,
        kind: input.kind,
        ...(input.date === undefined ? {} : { date: input.date }),
        ...(input.note === undefined ? {} : { note: input.note }),
        sourceTurn,
        confirmed: input.confirmed ?? false,
        version: 1,
        updatedAt: at,
      }
      facts.set(fact.factId, fact)
      byIdentity.set(key, fact.factId)
      return fact
    },
    list: (filter) =>
      [...facts.values()].filter((fact) => {
        if (filter?.person !== undefined && fact.person !== filter.person) return false
        if (filter?.kind !== undefined && fact.kind !== filter.kind) return false
        return true
      }),
    get: (factId) => facts.get(factId),
    forget: (factId) => {
      const fact = mustGet(factId)
      facts.delete(factId)
      byIdentity.delete(identityOf(fact))
      return fact
    },
    versions: () => Object.fromEntries([...facts.values()].map((fact) => [fact.factId, fact.version])),
  }

  return {
    store,
    load: (fact) => {
      facts.set(fact.factId, fact)
      byIdentity.set(identityOf(fact), fact.factId)
    },
    remove: (factId) => {
      const fact = facts.get(factId)
      if (fact !== undefined) byIdentity.delete(identityOf(fact))
      facts.delete(factId)
    },
  }
}

export function createFactStore(deps: FactStoreDeps): FactStore {
  return makeStore(deps).store
}

/** 从 `tool/result` 正文取结构化出参。 */
function resultOf(event: AnySessionEvent): Readonly<Record<string, unknown>> | undefined {
  if (event.type !== 'tool/result') return undefined
  const data = event.data
  if (data.isError) return undefined
  if (data.name !== FACT_REMEMBER_TOOL && data.name !== FACT_FORGET_TOOL) return undefined
  const text = data.content.find((block) => block.type === 'text')
  if (text === undefined || text.type !== 'text') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.text)
  } catch {
    throw new BahError('fact-replay-invalid', `${data.name}: 结果不是 JSON`, { callId: data.callId })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BahError('fact-replay-invalid', `${data.name}: 结果不是对象`, { callId: data.callId })
  }
  return parsed as Readonly<Record<string, unknown>>
}

/**
 * 从会话事件重放重建事实库。
 *
 * `fact_remember` 的到参是事实本体（同 id 后写覆盖先写）；`fact_forget` 的到参是 `{factId}`。
 * 校验最小形状：`factId` / `version` / `relation` / `kind` 缺一即断代（不许猜）。
 */
export function replayFacts(sessionEvents: readonly AnySessionEvent[], deps: FactStoreDeps): FactStore {
  const internals = makeStore(deps)
  for (const event of sessionEvents) {
    const record = resultOf(event)
    if (record === undefined) continue
    if (event.type !== 'tool/result') continue
    const factId = record['factId']
    if (typeof factId !== 'string') {
      throw new BahError('fact-replay-invalid', '事实结果缺 factId', { callId: event.data.callId })
    }
    if (event.data.name === FACT_FORGET_TOOL) {
      internals.remove(factId)
      continue
    }
    const version = record['version']
    const relation = record['relation']
    const kind = record['kind']
    if (
      typeof version !== 'number' ||
      typeof relation !== 'string' ||
      !RELATIONS.has(relation) ||
      typeof kind !== 'string' ||
      !KINDS.has(kind)
    ) {
      throw new BahError('fact-replay-invalid', '事实结果缺 version/relation/kind', {
        callId: event.data.callId,
      })
    }
    internals.load(record as unknown as LifeFact)
  }
  return internals.store
}

/** 供窗口条件构造：事实版本表（`fact-unchanged` 的 expected 侧）。 */
export function factVersionOf(store: FactStore, factId: string): number | undefined {
  return store.get(factId)?.version
}

/** 供外部构造输入：把关系 / 种类字符串收窄（不可信入参用）。 */
export function asRelation(value: string): FactRelation | undefined {
  return RELATIONS.has(value) ? (value as FactRelation) : undefined
}

export function asKind(value: string): FactKind | undefined {
  return KINDS.has(value) ? (value as FactKind) : undefined
}
