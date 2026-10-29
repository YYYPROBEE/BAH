import { describe, expect, it, vi } from 'vitest'

import type { SessionId, ToolExecContext } from '@bah/core'
import { BahError, validateAgainstSchema } from '@bah/util'

import { EMPTY_SLOT_TABLE, type IntentKind, type IntentResolution, type SlotName, type SlotTable } from './types.ts'
import { INTENT_RESOLVE_SCHEMA } from './result.ts'
import { createIntentResolveTool, INTENT_RESOLVE_TOOL } from './tool.ts'
import type { IntentToolDeps } from './deps.ts'
import type { IntentRecallResult } from './recall.ts'

const TODAY = '2026-10-28'

function ctx(): ToolExecContext {
  return {
    sessionId: 's-1' as SessionId,
    callId: 'call-1',
    signal: new AbortController().signal,
  }
}

interface FakeState {
  readonly deps: IntentToolDeps['state']
  readonly commits: IntentResolution[]
  readonly increments: SlotName[]
}

function fakeState(table: SlotTable = EMPTY_SLOT_TABLE, lastKind: IntentKind | null = null): FakeState {
  const commits: IntentResolution[] = []
  const increments: SlotName[] = []
  const counts = new Map<SlotName, number>()
  return {
    commits,
    increments,
    deps: {
      slotTable: () => table,
      lastTurnKind: () => lastKind,
      commit: (_sessionId, resolution) => {
        commits.push(resolution)
      },
      askCount: (_sessionId, slot) => counts.get(slot) ?? 0,
      incrementAsk: (_sessionId, slot) => {
        increments.push(slot)
        counts.set(slot, (counts.get(slot) ?? 0) + 1)
      },
    },
  }
}

function deps(
  retrieve: (query: unknown) => Promise<IntentRecallResult>,
  state: IntentToolDeps['state'] = fakeState().deps,
): IntentToolDeps {
  return {
    memory: { retrieve: retrieve as IntentToolDeps['memory']['retrieve'] },
    clock: { today: () => TODAY },
    state,
    minCrossSceneConfidence: 0.6,
  }
}

describe('intent_resolve 工具', () => {
  it('正常路径：先 recall 再纯函数，出参过契约 schema', async () => {
    const tool = createIntentResolveTool(
      deps(async () => ({ memories: [], routeCode: 'ROUTE_OK' })),
    )
    expect(tool.name).toBe(INTENT_RESOLVE_TOOL)
    expect(tool.tier.level).toBe('green')
    expect(tool.sideEffect).toBe('none')

    const result = await tool.execute({ utterance: '给张三转500元', scene: 'transfer' }, ctx())
    expect(result.kind).toBe('explicit')
    expect(result.decision).toBe('proceed')
    expect(validateAgainstSchema(INTENT_RESOLVE_SCHEMA, result, 'result')).toBeUndefined()
  })

  it('出参缺字段会被契约拦下（负控：证明 schema 真的在管）', () => {
    const broken = { kind: 'explicit', decision: 'proceed' }
    const violation = validateAgainstSchema(INTENT_RESOLVE_SCHEMA, broken, 'result')
    expect(violation?.code).toBe('required')
  })

  it('检索失败 fail-loud：不降级成「假装没有历史」', async () => {
    const tool = createIntentResolveTool(
      deps(async () => {
        throw new BahError('memory-store-unavailable', 'sqlite 打不开')
      }),
    )
    await expect(
      tool.execute({ utterance: '上次那个转账再来一次', scene: 'transfer' }, ctx()),
    ).rejects.toMatchObject({ code: 'intent-recall-failed' })
  })

  it('检索失败时带上非 BahError 的 cause 兜底码', async () => {
    const tool = createIntentResolveTool(
      deps(async () => {
        throw new Error('boom')
      }),
    )
    try {
      await tool.execute({ utterance: '上次那个转账', scene: 'transfer' }, ctx())
      throw new Error('期望抛错')
    } catch (error) {
      expect((error as BahError).code).toBe('intent-recall-failed')
      expect((error as BahError).detail).toMatchObject({ cause: 'memory-store-unavailable' })
    }
  })

  it('commit 在返回前被调用一次（会话槽位表可跨 turn 继承）', async () => {
    const state = fakeState()
    const tool = createIntentResolveTool(
      deps(async () => ({ memories: [], routeCode: 'ROUTE_OK' }), state.deps),
    )
    await tool.execute({ utterance: '给张三转500元', scene: 'transfer' }, ctx())
    expect(state.commits).toHaveLength(1)
    expect(state.commits[0]?.kind).toBe('explicit')
  })

  it('检索参数由 planRecall 产生（跨场景带 crossSceneRef）', async () => {
    const retrieve = vi.fn(async () => ({ memories: [], routeCode: 'ROUTE_OK' as const }))
    const tool = createIntentResolveTool(deps(retrieve))
    await tool.execute({ utterance: '把那边的事接着办', scene: 'cross_scene' }, ctx())
    expect(retrieve).toHaveBeenCalledWith({
      scene: 'cross_scene',
      maxK: 8,
      utterance: '把那边的事接着办',
      crossSceneRef: { target: 'transfer', confidence: 0.59 },
    })
  })

  it('阈值由 deps 注入：0.59 在 0.6 下拒借，在 0.5 下放行', async () => {
    const result: IntentRecallResult = {
      memories: [],
      routeCode: 'ROUTE_OK',
      crossSceneRef: { target: 'transfer', confidence: 0.59, accepted: false },
    }
    const strict = createIntentResolveTool(deps(async () => result))
    const strictOut = await strict.execute({ utterance: '把那边的事接着办', scene: 'cross_scene' }, ctx())
    expect(strictOut.decision).toBe('ask')

    const loose = createIntentResolveTool({
      ...deps(async () => result),
      minCrossSceneConfidence: 0.5,
    })
    const looseOut = await loose.execute({ utterance: '把那边的事接着办', scene: 'cross_scene' }, ctx())
    expect(looseOut.evidence.some((item) => item.ruleId === 'R-XS-1')).toBe(false)
  })

  it('一个名字对两个实体：出参保留 conflicts 候选，且不默认填 payee', async () => {
    const tool = createIntentResolveTool(
      deps(async () => ({
        routeCode: 'ROUTE_OK',
        memories: [
          {
            unitId: 'm1',
            sceneTag: 'transfer',
            confidence: 0.8,
            renderedText: '张伟（同事）',
            fields: [{ name: 'payee', value: '张伟（同事）' }],
          },
          {
            unitId: 'm2',
            sceneTag: 'transfer',
            confidence: 0.7,
            renderedText: '张伟（房东）',
            fields: [{ name: 'payee', value: '张伟（房东）' }],
          },
        ],
      })),
    )
    const result = await tool.execute({ utterance: '给张伟转200', scene: 'transfer' }, ctx())
    expect(result.kind).toBe('ambiguous')
    expect(result.decision).toBe('ask')
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.name).toBe('payee')
    expect(result.conflicts[0]?.candidates.map((candidate) => candidate.value)).toEqual([
      '张伟（同事）',
      '张伟（房东）',
    ])
    // 安全口径：歧义槽位不得被默认值填充（否则可能转错人）
    expect(result.filled.some((slot) => slot.name === 'payee')).toBe(false)
    expect(validateAgainstSchema(INTENT_RESOLVE_SCHEMA, result, 'result')).toBeUndefined()
  })

  it('记忆回放：source=memory ⇒ requiresPreview=true 且进 filled', async () => {
    const tool = createIntentResolveTool(
      deps(async () => ({
        routeCode: 'ROUTE_OK',
        memories: [
          {
            unitId: 'm1',
            sceneTag: 'transfer',
            confidence: 0.9,
            renderedText: '上次给王建国转 800 元',
            fields: [
              { name: 'payee', value: '王建国' },
              { name: 'amountCents', value: 80000 },
            ],
          },
        ],
      })),
    )
    const result = await tool.execute({ utterance: '上次那个转账再来一次', scene: 'transfer' }, ctx())
    expect(result.kind).toBe('vague')
    expect(result.requiresPreview).toBe(true)
    expect(result.filled).toContainEqual({
      name: 'amountCents',
      value: 80000,
      source: 'memory',
      confidence: 0.9,
    })
  })
})
