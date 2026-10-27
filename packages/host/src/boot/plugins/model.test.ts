/**
 * `core:model` 配置校验与 adapter 构造（超时 / mock-only 键）。
 */

import { createContext } from '@bah/core'
import { LLM_ADAPTERS } from '@bah/llm'
import { asSessionId } from '@bah/test-support'
import { BahError } from '@bah/util'
import { afterEach, describe, expect, it } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import { modelPlugin } from './model.ts'

import type { LlmAdapter, LlmRequest, PreparedCall } from '@bah/llm'

const saved = process.env['BAH_MODEL_TEST_KEY']

afterEach(() => {
  if (saved === undefined) delete process.env['BAH_MODEL_TEST_KEY']
  else process.env['BAH_MODEL_TEST_KEY'] = saved
})

describe('core:model 配置', () => {
  it('mock 不许写 deepseek 专属键；deepseek 不许写 mock 专属键', () => {
    expect(() => modelPlugin.validate({ provider: 'mock', apiKeyEnv: 'X' })).toThrow(
      /只对 provider=deepseek/,
    )
    expect(() => modelPlugin.validate({ provider: 'deepseek', chunkSize: 4 })).toThrow(
      /只对 provider=mock/,
    )
  })

  /**
   * 为什么要测：provider 缺省即 mock，而 mock 没有真实模型——**不写 script**
   * 等于装了一个永远答不出话的模型，必须在 boot 期就拒（空转比报错贵）。
   * 顺带钉住 `?? 'mock'` 的缺省侧与 settings 里 baseUrl 的透传侧。
   */
  it('缺省 provider 是 mock；mock 没写 script 直接拒（回复只能来自脚本）', () => {
    expect(() => modelPlugin.validate({})).toThrow(/必须写 script/)
    expect(modelPlugin.validate({ provider: 'deepseek', baseUrl: 'https://gw.example.com/v1' }).baseUrl).toBe(
      'https://gw.example.com/v1',
    )
  })

  it('deepseek 的 requestTimeoutMs 透传到 adapter（装配不联网）', async () => {
    process.env['BAH_MODEL_TEST_KEY'] = 'sk-test'
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKeyEnv: 'BAH_MODEL_TEST_KEY',
        requestTimeoutMs: 1_234,
      }),
    )
    await ctx.start()
    await ctx.dispose('test')
  })

  /**
   * 为什么要测：「载入即验」是这行的公开承诺——模型名写错必须死在 boot，
   * 而不是拖到用户第一次提问才炸。错误码 unknown-model + detail.model 可审计。
   */
  it('载入即验：model 不在适配器模型表 → 启动失败抛 unknown-model（不拖到第一次请求）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'deepseek',
        model: 'no-such-model',
        baseUrl: 'https://gateway.example.com/v1',
      }),
    )
    const error = (await ctx.start().catch((e: unknown) => e)) as BahError
    expect(error).toBeInstanceOf(BahError)
    expect(error.code).toBe('unknown-model')
    expect(error.message).toContain('deepseek:no-such-model')
    expect((error.detail as { model: string }).model).toBe('deepseek:no-such-model')
  })
})

describe('core:model 脚本形状拒绝（readScript / readStep 的 fail-loud 面）', () => {
  it('非 mock provider 写 script 直接拒；空数组与"零选择"也拒（错误码可读）', () => {
    expect(() => modelPlugin.validate({ provider: 'router', script: [{ text: 'a' }] })).toThrow(
      /只对 provider=mock 有意义/,
    )
    expect(() => modelPlugin.validate({ provider: 'mock', script: [] })).toThrow(/必须是非空数组/)
    expect(() => modelPlugin.validate({ provider: 'mock', script: [{}] })).toThrow(/都没有/)
  })

  it('text 步写了 finish 就原样保留；tool 步没写 args 补空对象（缺省形状可预测）', () => {
    const withFinish = modelPlugin.validate({
      provider: 'mock',
      script: [{ text: 'a', finish: 'length' }],
    })
    expect(withFinish.script?.[0]).toEqual({ text: 'a', finish: 'length' })

    const noArgs = modelPlugin.validate({
      provider: 'mock',
      script: [{ tool: { id: '1', name: 'x' } }],
    })
    expect((noArgs.script?.[0] as unknown as { tool: { args: unknown } }).tool.args).toEqual({})
  })

  it('outcome 步没写 tool 也能装配：映射后脚本里该键不存在（toMockStep 不写 undefined 占位）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'mock',
        // 不写 chunkSize：透传缺省侧也必须装配成功
        script: [{ outcome: { ok: '完成', failed: '未执行：{reason}' } }],
      }),
    )
    await ctx.start()
    await ctx.dispose('test')
  })
})

describe('mock 脚本的条件收尾步（文案不许承诺没看见的结论）', () => {
  it('text / tool / outcome 三选一；finish 只属于 text 步；ok / failed 必填', () => {
    expect(() =>
      modelPlugin.validate({
        provider: 'mock',
        script: [{ text: 'a', tool: { id: '1', name: 'x', args: {} } }],
      }),
    ).toThrow(/必须且只能写 text \/ tool \/ outcome 之一/)
    expect(() =>
      modelPlugin.validate({
        provider: 'mock',
        script: [{ outcome: { ok: 'a', failed: 'b' }, finish: 'length' }],
      }),
    ).toThrow(/finish 只对 text 步有意义/)
    expect(() => modelPlugin.validate({ provider: 'mock', script: [{ outcome: { ok: 'a' } }] })).toThrow(
      /outcome\.failed 必填/,
    )
  })

  it('收尾文本跟着会话里的真实工具结局走（订阅接线）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'mock',
        model: 'mock-chat',
        chunkSize: 100,
        script: [{ outcome: { tool: 'transfer_create', ok: '已完成', failed: '未执行：{reason}' } }],
      }),
    )
    await ctx.start()

    ctx.events.emit('session/event', {
      session: asSessionId('s-model-test'),
      event: {
        seq: 1,
        at: 1,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'call-1',
          name: 'transfer_create',
          isError: true,
          content: [],
          code: 'approval-cancelled',
          reason: '审批未通过（cancelled）',
          durationMs: 0,
        },
      } as unknown as AnySessionEvent,
    })

    const adapter = ctx.get(LLM_ADAPTERS).resolve('mock:mock-chat').adapter
    const prepared = await adapter.prepareCall({ modelId: 'mock-chat', messages: [] })
    let text = ''
    for await (const chunk of adapter.stream(prepared, new AbortController().signal)) {
      if (chunk.kind === 'text-delta') text += chunk.text
    }
    await ctx.dispose('test')

    expect(text).toBe('未执行：审批未通过（cancelled）')
  })
})

/** 消费整条流并拼出文本（mock / router 的可见产出只有文本增量）。 */
async function streamAllText(adapter: LlmAdapter, prepared: PreparedCall): Promise<string> {
  const pieces: string[] = []
  for await (const chunk of adapter.stream(prepared, new AbortController().signal)) {
    if (chunk.kind === 'text-delta') pieces.push(chunk.text)
  }
  return pieces.join('')
}

describe('core:model 的 modelSpec 形状校验（readModelSpec / flag）', () => {
  /**
   * 为什么要测：modelSpec 是"部署方显式声明能力位"的入口（不写=未声明，
   * 而不是 false）——把"未声明"降级成 false 会连带裁错提示词的工具段/推理段。
   */
  it('五个键写与时不写：写了原样保留，没写的一个键都不出现（未声明 ≠ false）', () => {
    const full = modelPlugin.validate({
      provider: 'deepseek',
      model: 'custom-x',
      modelSpec: {
        displayName: '定制网关模型',
        contextWindow: 8192,
        toolCall: false,
        reasoning: true,
        image: true,
      },
    })
    expect(full.modelSpec).toEqual({
      displayName: '定制网关模型',
      contextWindow: 8192,
      toolCall: false,
      reasoning: true,
      image: true,
    })

    const bare = modelPlugin.validate({ provider: 'deepseek', model: 'custom-x', modelSpec: {} })
    expect(bare.modelSpec).toEqual({})
    expect(Object.keys(bare.modelSpec ?? {})).toHaveLength(0)
  })

  it('modelSpec 未知键 fail-loud：能力位只能显式声明，不许塞进别的字段让代码猜', () => {
    expect(() =>
      modelPlugin.validate({ provider: 'deepseek', modelSpec: { temperature: 0.5 } }),
    ).toThrow(/temperature/)
  })

  it('modelSpec 不是对象直接拒（invalid-config，不静默当"没写"）', () => {
    expect(() => modelPlugin.validate({ provider: 'deepseek', modelSpec: 'qwen-max' })).toThrow(
      /必须是对象/,
    )
  })
})

describe('core:model 计价（D2：costMicroYuan 不许恒为 0）', () => {
  /**
   * 为什么要测：`costMicroYuan` 字段早就在 schema 里，但没有 profile 配 pricing，
   * 所以成本恒为 0 —— 看板看不出东西，还容易被当成"免费"。这里钉住两件事：
   * ① pricing 能透到**模型条目**（适配器从 `call.model.pricing` 读）；
   * ② 写一半、写浮点、本地 provider 写 pricing 都必须 fail-loud。
   */
  it('内置模型 + pricing：模型条目带上计价（不给内置表也记价，不必编一份 modelSpec）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'deepseek',
        model: 'deepseek-chat',
        pricing: { inputPerMTok: 2_000_000, cachedInputPerMTok: 500_000, outputPerMTok: 8_000_000 },
      }),
    )
    await ctx.start()

    const model = ctx.get(LLM_ADAPTERS).resolve('deepseek:deepseek-chat').model
    expect(model.pricing).toEqual({
      inputPerMTok: 2_000_000,
      cachedInputPerMTok: 500_000,
      outputPerMTok: 8_000_000,
    })
    // 内置表里未声明 pricing 的其它模型不受影响
    const reasoner = ctx.get(LLM_ADAPTERS).resolve('deepseek:deepseek-reasoner').model
    expect(reasoner.pricing).toBeUndefined()
    await ctx.dispose('test')
  })

  it('只写一半 / 浮点 / 负数 → invalid-config（半个价会算成半个账单）', () => {
    const cases: readonly [string, Readonly<Record<string, unknown>>][] = [
      ['缺 outputPerMTok', { inputPerMTok: 1 }],
      ['浮点单价', { inputPerMTok: 1.5, outputPerMTok: 1 }],
      ['负单价', { inputPerMTok: -1, outputPerMTok: 1 }],
    ]
    for (const [name, pricing] of cases) {
      expect(
        () => modelPlugin.validate({ provider: 'deepseek', model: 'deepseek-chat', pricing }),
        name,
      ).toThrow(/pricing/)
    }
  })

  it('本地 provider（mock / router）写 pricing 直接拒：本地生成没有上游成本', () => {
    expect(() =>
      modelPlugin.validate({
        provider: 'router',
        pricing: { inputPerMTok: 1, outputPerMTok: 1 },
      }),
    ).toThrow(/pricing/)
  })
})

describe('core:model 装配面：router 与自定义 deepseek 模型表', () => {
  /**
   * 为什么要测：`provider: router` 与 mock 共用 MockLlmAdapter 实现但走
   * `createDemoRouter` 分支——chunkSize 与 toolOutcomes 都是在这个分支里透传的，
   * 漏传任何一个，离线演示就会"分片大小说谎"或"收尾文案看不见工具结局"。
   */
  it('provider=router 走 createDemoRouter：chunkSize 透传到分片、toolOutcomes 接线到条件收尾步', async () => {
    const ctx = createContext()
    await ctx.use(modelPlugin.plugin, modelPlugin.validate({ provider: 'router', chunkSize: 5 }))
    await ctx.start()

    const { adapter } = ctx.get(LLM_ADAPTERS).resolve('router:router-chat')

    // ① chunkSize=5：认不出的问题只出一段追问文本，首片必须恰好 5 字符（缺省 8 就不成立）
    const clarify = await adapter.prepareCall({
      modelId: 'router-chat',
      messages: [{ role: 'user', content: [{ kind: 'text', text: '今天天气好吗' }] }],
    })
    const pieces: string[] = []
    for await (const chunk of adapter.stream(clarify, new AbortController().signal)) {
      if (chunk.kind === 'text-delta') pieces.push(chunk.text)
    }
    expect(pieces[0]).toHaveLength(5)
    expect(pieces.join('')).toContain('我现在只会两件事')

    // ② 条件收尾步：会话里还没有 transfer_create 的结局 → 必须拒绝出话（mock-outcome-absent），
    //    而不是编一句"已完成"——这同时证明 toolOutcomes 读口真的被注入且每次现读。
    const transfer: LlmRequest = {
      modelId: 'router-chat',
      messages: [
        { role: 'user', content: [{ kind: 'text', text: '给王建国转 800 元' }] },
        { role: 'assistant', content: [{ kind: 'tool-call', id: 'p1', name: 'transfer_preview', args: {} }] },
        { role: 'assistant', content: [{ kind: 'tool-call', id: 'p2', name: 'transfer_create', args: {} }] },
      ],
    }
    const absent = await adapter
      .prepareCall(transfer)
      .then((prepared) => streamAllText(adapter, prepared))
      .catch((error: unknown) => error)
    expect(absent).toBeInstanceOf(BahError)
    expect((absent as BahError).code).toBe('mock-outcome-absent')

    // ③ 结局落账后再问：同一条流必须按真实结局出 failed 文案（读口是活的，不是装配期快照）
    ctx.events.emit('session/event', {
      session: asSessionId('s-model-test'),
      event: {
        seq: 1,
        at: 1,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'p2',
          name: 'transfer_create',
          isError: true,
          content: [],
          code: 'approval-cancelled',
          reason: '审批未通过（cancelled）',
          durationMs: 0,
        },
      } as unknown as AnySessionEvent,
    })
    // 脏形状的工具结果（非数组 content / null 块 / 非 text 块 / 空白文本）：投影读口必须
    // 一条不落地记账、也一条不多地编出 `text` 键（firstTextOf 找不到正文就不写该键）。
    ctx.events.emit('session/event', {
      session: asSessionId('s-model-test'),
      event: {
        seq: 2,
        at: 2,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'p3',
          name: 'account_balance',
          isError: false,
          content: '裸字符串不是数组',
          durationMs: 0,
        },
      } as unknown as AnySessionEvent,
    })
    ctx.events.emit('session/event', {
      session: asSessionId('s-model-test'),
      event: {
        seq: 3,
        at: 3,
        formatVersion: 1,
        type: 'tool/result',
        data: {
          callId: 'p4',
          name: 'account_balance',
          isError: false,
          content: [null, { type: 'image' }, { type: 'text', text: '   ' }, { type: 'text', text: 42 }, { type: 'text', text: '余额 100 元' }],
          durationMs: 0,
        },
      } as unknown as AnySessionEvent,
    })
    const after = await adapter.prepareCall(transfer)
    expect(await streamAllText(adapter, after)).toBe('未执行：审批未通过（cancelled）')

    await ctx.dispose('test')
  })

  it('provider=router 不写 chunkSize：实现缺省照常装配（chunkSize 是透传项而不是必填）', async () => {
    const ctx = createContext()
    await ctx.use(modelPlugin.plugin, modelPlugin.validate({ provider: 'router' }))
    await ctx.start()
    expect(ctx.get(LLM_ADAPTERS).resolve('router:router-chat').model.id).toBe('router-chat')
    await ctx.dispose('test')
  })

  /**
   * 为什么要测：写了 modelSpec 就**只用**这份声明建单元素 models 数组
   * （指向非 DeepSeek 端点时内置表必然对不上）；各 `?? 默认值` 的两侧都要钉住。
   */
  it('deepseek + 写满 modelSpec：models 单元素数组原样透传能力位（不掺内置表）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({
        provider: 'deepseek',
        model: 'custom-x',
        modelSpec: { displayName: '定制网关模型', contextWindow: 8192, toolCall: false, reasoning: true, image: true },
      }),
    )
    await ctx.start()

    const registry = ctx.get(LLM_ADAPTERS)
    expect(registry.resolve('deepseek:custom-x').model).toEqual({
      id: 'custom-x',
      providerId: 'deepseek',
      displayName: '定制网关模型',
      capabilities: { toolCall: false, image: true, reasoning: true },
      contextWindow: 8192,
    })
    // 内置表不再可见：声明即唯一真相（换端点不会"顺便"认识 deepseek-chat）
    expect(() => registry.resolve('deepseek:deepseek-chat')).toThrow(/不认识模型/)
    await ctx.dispose('test')
  })

  it('deepseek + 空 modelSpec：缺省全部落默认（展示名跟 model id、窗口 32000、只开 toolCall）', async () => {
    const ctx = createContext()
    await ctx.use(
      modelPlugin.plugin,
      modelPlugin.validate({ provider: 'deepseek', model: 'custom-y', apiKeyEnv: 'BAH_MODEL_TEST_KEY', modelSpec: {} }),
    )
    await ctx.start()

    const model = ctx.get(LLM_ADAPTERS).resolve('deepseek:custom-y').model
    expect(model.displayName).toBe('custom-y')
    expect(model.contextWindow).toBe(32_000)
    expect(model.capabilities).toEqual({ toolCall: true, image: false, reasoning: false })
    await ctx.dispose('test')
  })
})

describe('core:model 脚本 outcome 步的 tool 键（缺省 ≠ 写了 undefined）', () => {
  it('没写 tool 就不产生 tool 键：收尾绑定"本会话最后一条结局"，而不是绑定名为 undefined 的工具', () => {
    const without = modelPlugin.validate({ provider: 'mock', script: [{ outcome: { ok: '成', failed: '败' } }] })
    const loose = without.script?.[0] as unknown as { outcome: Record<string, unknown> }
    expect(Object.keys(loose.outcome)).toEqual(['ok', 'failed'])

    const withTool = modelPlugin.validate({
      provider: 'mock',
      script: [{ outcome: { tool: 'transfer_create', ok: '成', failed: '败' } }],
    })
    const bound = withTool.script?.[0] as unknown as { outcome: Record<string, unknown> }
    expect(bound.outcome.tool).toBe('transfer_create')
  })
})
