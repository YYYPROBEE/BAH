/**
 * 适配器注册表（施工单 05 §2「注册：返回 disposer；重复注册需显式 replace 语义」）。
 *
 * 纪律：
 * - **注册即可逆**：`register` 返回 disposer（幂等），注销后该 provider 立即不可解析；
 * - 重名**默认抛错**（fail-loud），要覆盖必须显式 `{ replace: true }`——静默覆盖会让
 *   "谁最后装的谁生效"变成隐藏行为，排障时无从下手；
 * - 跨包只认服务键 `llm:adapters`（施工单 00 §9 补充纪律「按键寻址」）。
 */

import { defineService } from '@bah/core'
import { BahError } from '@bah/util'

import type { Context, Disposer, ServiceKey } from '@bah/core'

import type { LlmAdapter, ModelSpec } from './types.ts'

/** 注册选项。 */
export interface RegisterAdapterOptions {
  /** `true` 时静默替换同名 provider（否则重名即抛）。 */
  readonly replace?: boolean
}

/** `resolve` 的结果：命中的适配器 + 它给出的模型规格。 */
export interface ResolvedModel {
  readonly adapter: LlmAdapter
  readonly model: ModelSpec
}

/** provider id 分隔符：`<providerId>:<modelId>`。 */
const PROVIDER_SEPARATOR = ':'

export class LlmAdapterRegistry {
  /** provider id → 适配器（插入顺序 = 注册顺序）。 */
  private readonly adapters = new Map<string, LlmAdapter>()

  /**
   * 注册一个 provider。
   *
   * @returns 注销句柄（幂等；注销后 `resolve` 不再命中它）
   * @throws `BahError('llm-adapter-conflict')` 同名 provider 已存在且未声明 `replace`
   * @throws `BahError('llm-adapter-id-empty')` provider id 为空
   */
  register(adapter: LlmAdapter, options: RegisterAdapterOptions = {}): Disposer {
    const id = adapter.providerInfo().id
    if (id.length === 0) {
      throw new BahError('llm-adapter-id-empty', 'llm: provider id 不能为空（它是注册表的键）')
    }
    if (this.adapters.has(id) && options.replace !== true) {
      throw new BahError(
        'llm-adapter-conflict',
        `llm: provider ${id} 已注册；覆盖必须显式声明 { replace: true }`,
        { provider: id },
      )
    }
    this.adapters.set(id, adapter)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      // 只有"仍是我"时才删：否则会误删后来 replace 上去的那个
      if (this.adapters.get(id) === adapter) this.adapters.delete(id)
    }
  }

  /**
   * 取适配器。
   *
   * @throws `BahError('llm-adapter-missing')` 未注册（fail-loud，不返回 `undefined`）
   */
  get(providerId: string): LlmAdapter {
    const adapter = this.adapters.get(providerId)
    if (!adapter) {
      throw new BahError('llm-adapter-missing', `llm: provider ${providerId} 未注册`, {
        provider: providerId,
        registered: this.ids(),
      })
    }
    return adapter
  }

  /** 是否已注册。 */
  has(providerId: string): boolean {
    return this.adapters.has(providerId)
  }

  /** 全部已注册适配器（顺序 = 注册顺序）。 */
  list(): readonly LlmAdapter[] {
    return [...this.adapters.values()]
  }

  /** 全部已注册 provider id（顺序 = 注册顺序）。 */
  ids(): readonly string[] {
    return [...this.adapters.keys()]
  }

  /**
   * 按 `modelId` 解析出「适配器 + 模型规格」。
   *
   * 两种写法：
   * - `provider:model`（推荐，零歧义）——直接命中该 provider；
   * - 裸 `model`——按注册顺序问每个 provider，首个 `resolveModel` 成功者胜。
   *
   * @throws `BahError('llm-model-unresolved')` 没有任何 provider 认识这个 modelId
   */
  resolve(modelId: string): ResolvedModel {
    const separator = modelId.indexOf(PROVIDER_SEPARATOR)
    if (separator > 0) {
      const adapter = this.get(modelId.slice(0, separator))
      return { adapter, model: adapter.resolveModel(modelId.slice(separator + 1)) }
    }

    for (const adapter of this.adapters.values()) {
      try {
        return { adapter, model: adapter.resolveModel(modelId) }
      } catch {
        // 这个 provider 不认识它，继续问下一个；全部失败时下面统一抛错。
      }
    }

    throw new BahError(
      'llm-model-unresolved',
      `llm: 没有 provider 认识 modelId ${modelId}（可用 provider：${this.ids().join('、') || '无'}）`,
      { modelId, providers: this.ids() },
    )
  }
}

/** 服务键：跨包只认这个。 */
export const LLM_ADAPTERS: ServiceKey<LlmAdapterRegistry> = defineService<LlmAdapterRegistry>(
  'llm:adapters',
)

/**
 * 注册 `llm:adapters` 服务。
 *
 * 施工单 05 §2 原文写的是 `ctx.llm.registerAdapter(...)`：本仓 `api.ts` 已冻结、
 * `Context` 上没有也不会长出 `llm` 成员，故按施工单 00 §9「按键寻址」用服务键落地
 * （语义等价：注册返回 disposer、重名需显式 replace）。偏离已在施工台账 §11 记录（台账已撤下）。
 */
export function provideLlm(ctx: Context, registry = new LlmAdapterRegistry()): Disposer {
  return ctx.provide(LLM_ADAPTERS, registry)
}
