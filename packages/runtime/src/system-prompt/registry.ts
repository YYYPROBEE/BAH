/**
 * 提示词段注册表。
 *
 * 纪律与工具注册表一致：**注册即可逆**（返回 disposer）、重名即抛（section id 是装配契约，
 * 重名会让"到底装的哪一段"无法解释）。
 *
 * 装配顺序由 `order` 决定（`SECTION_ORDERS` 冻结），同序时按注册顺序（JS 的 `sort` 稳定）。
 */

import { BahError } from '@bah/util'

import type { Disposer } from '@bah/core'

import type { ComposedPrompt, ComposedPromptPart, PromptContext, PromptSection } from './types.ts'

export class PromptRegistry {
  /** section id → 段（插入顺序 = 注册顺序）。 */
  private readonly sections = new Map<string, PromptSection>()

  /**
   * 注册一段提示词。
   *
   * @returns 注销句柄（幂等）
   * @throws `BahError('prompt-section-id-empty')` id 为空
   * @throws `BahError('prompt-section-order')` order 不是非负整数
   * @throws `BahError('prompt-section-duplicate')` id 重复
   */
  register(section: PromptSection): Disposer {
    if (section.id.length === 0) {
      throw new BahError('prompt-section-id-empty', 'prompt: section id 不能为空（装配顺序按它对账）')
    }
    if (!Number.isInteger(section.order) || section.order < 0) {
      throw new BahError(
        'prompt-section-order',
        `prompt: section ${section.id} 的 order 必须是非负整数（收到 ${String(section.order)}）`,
        { id: section.id, order: section.order },
      )
    }
    if (this.sections.has(section.id)) {
      throw new BahError(
        'prompt-section-duplicate',
        `prompt: section ${section.id} 已注册（重名会让装配顺序无法解释）`,
        { id: section.id },
      )
    }
    this.sections.set(section.id, section)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.sections.delete(section.id)
    }
  }

  /**
   * 取一段。
   *
   * @throws `BahError('prompt-section-missing')` 未注册（fail-loud）
   */
  get(id: string): PromptSection {
    const section = this.sections.get(id)
    if (section === undefined) {
      throw new BahError('prompt-section-missing', `prompt: section ${id} 未注册`, { id })
    }
    return section
  }

  /** 是否已注册。 */
  has(id: string): boolean {
    return this.sections.has(id)
  }

  /** 全部 section（按 order 升序；同序保持注册顺序）。 */
  list(): readonly PromptSection[] {
    return [...this.sections.values()].sort((left, right) => left.order - right.order)
  }

  /** 全部 section id（顺序同 `list()`）。 */
  ids(): readonly string[] {
    return this.list().map((section) => section.id)
  }

  /**
   * 装配。
   *
   * 每段只 render 一次，结果按 `target` 分流：
   * `header` 拼成 system 头，`context` 单独返回（由主循环以 user 角色落历史）。
   * `render` 返回 `undefined` 或空白 → 该段不装配（能力位裁剪）。
   */
  compose(context: PromptContext): ComposedPrompt {
    const parts: ComposedPromptPart[] = []
    const header: string[] = []
    const body: string[] = []

    for (const section of this.list()) {
      const rendered = section.render(context)
      if (rendered === undefined) continue
      const text = rendered.trim()
      if (text.length === 0) continue

      parts.push({ id: section.id, order: section.order, text })
      if (section.target === 'context') body.push(text)
      else header.push(text)
    }

    const contextText = body.join('\n\n')
    return {
      header: header.join('\n\n'),
      context: contextText.length === 0 ? undefined : contextText,
      parts,
      sectionIds: parts.map((part) => part.id),
    }
  }
}
