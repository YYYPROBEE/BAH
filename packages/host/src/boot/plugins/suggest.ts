/**
 * 追问建议（模型生成）。
 *
 * 答后那两颗按钮过去是规则表按关键词推的，遇到"助手正在问哪一张卡"这类
 * 上下文就会给出不匹配的下一步。这里改由同一个模型基于最近一轮对话生成两条
 * 用户可原样发送的短句；模型不可用（router / mock / 超时）时返回空数组，
 * 前端回退到规则表，不把"没有建议"渲染成空白按钮。
 *
 * 纪律：
 * - 只读：不 append 会话事件、不写审计、不创建 turn；
 * - 不碰工具：没有 tools 字段，模型只能产出文本；
 * - 失败静默降级：建议是辅助件，不能因为它让主对话报错。
 */

import { defineService } from '@bah/core'

import type { LlmAdapterRegistry, LlmMessage, LlmRequest } from '@bah/llm'

/** 建议生成入参（只取最近一轮，避免把整段会话塞进上下文）。 */
export interface SuggestInput {
  readonly user: string
  readonly assistant: string
}

/** 建议端口：永远 resolve，失败返回空数组。 */
export interface SuggestPort {
  suggest(input: SuggestInput): Promise<readonly string[]>
}

export const SUGGEST_SERVICE = defineService<SuggestPort>('bah:suggest')

/** 单条建议最大长度（超过就不是"按钮"，是一句话）。 */
const MAX_SUGGESTION_CHARS = 40
/** 送进模型的单段文本上限（防止超长会话把建议请求撑爆）。 */
const MAX_CONTEXT_CHARS = 1500

const SYSTEM_PROMPT = `你是银行 App 的追问建议生成器。根据最近一轮用户与助手的对话，给出 2 条用户可以原样发送的中文短句，帮助用户继续办理当前业务。
要求：
1. 每条不超过 20 个汉字，用户口吻；不要编号、不要引号、不要解释；
2. 只能建议本 App 能办理的事：查余额/流水/账单、转账、理财、卡片（查状态/冻结/挂失/限额）、订阅、资金锁定、生日计划；
3. 如果助手正在问用户问题，优先给两个回答该问题的选项；
4. 不要建议查询密码、验证码、完整卡号等敏感信息。
只输出两行。`

/** 去掉模型常见的编号 / 引号 / "建议：" 前缀。 */
function cleanLine(line: string): string {
  return String(line)
    .replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '')
    .replace(/^\s*建议[：:]\s*/, '')
    .replace(/^["“”'‘’「」『』]+|["“”'‘’「」『』]+$/g, '')
    .trim()
}

/** 从模型输出里抽最多两条建议；解析不出来就给空数组。 */
export function parseSuggestions(text: string): string[] {
  const raw = String(text ?? '').trim()
  if (raw === '') return []

  let lines = raw
    .split(/\r?\n/)
    .map(cleanLine)
    .filter((line) => line !== '')

  // 有些模型会把两条压成一行："1. xxx 2. yyy"
  if (lines.length < 2) {
    const split = raw
      .split(/(?=\d+[.、])/)
      .map(cleanLine)
      .filter((line) => line !== '')
    if (split.length > lines.length) lines = split
  }

  const picked: string[] = []
  for (const line of lines) {
    if (line.length < 2 || line.length > MAX_SUGGESTION_CHARS) continue
    if (picked.includes(line)) continue
    picked.push(line)
    if (picked.length === 2) break
  }
  return picked
}

/** 去掉前后空白并截断（按字符，不按字节）。 */
function clip(text: string): string {
  const value = String(text ?? '').trim()
  return value.length <= MAX_CONTEXT_CHARS ? value : `${value.slice(0, MAX_CONTEXT_CHARS)}…`
}

/**
 * 建一个建议服务。
 *
 * @param {{ registry: LlmAdapterRegistry, modelId: string }} options
 */
export function createSuggestService(options: {
  registry: LlmAdapterRegistry
  modelId: string
}): SuggestPort {
  return {
    async suggest(input: SuggestInput) {
      const modelId = options.modelId
      // 本地 provider 没有"生成新句子"的能力：router 是确定性意图路由，mock 是脚本。
      if (modelId.startsWith('router:') || modelId.startsWith('mock:')) return []

      const user = clip(input?.user ?? '')
      const assistant = clip(input?.assistant ?? '')
      if (assistant === '') return []

      const messages: LlmMessage[] = [
        { role: 'system', content: [{ kind: 'text', text: SYSTEM_PROMPT }] },
        { role: 'user', content: [{ kind: 'text', text: `用户：${user}\n助手：${assistant}` }] },
      ]
      const request: LlmRequest = {
        modelId,
        messages,
        params: { temperature: 0.4, maxTokens: 120 },
      }

      try {
        const { adapter } = options.registry.resolve(modelId)
        const call = await adapter.prepareCall(request)
        let text = ''
        for await (const chunk of adapter.stream(call, AbortSignal.timeout(8_000))) {
          if (chunk.kind === 'text-delta') text += chunk.text
        }
        return parseSuggestions(text)
      } catch {
        return []
      }
    },
  }
}
