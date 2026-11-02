/**
 * 工具目录渲染。
 *
 * 纯函数：输入 `BANK_TOOL_SPECS`，输出 `docs/tool-catalog.md` 的全文。
 * 生成器 `scripts/build-tool-catalog.ts` 与门禁 `scripts/verify-tool-catalog.ts` 共用，
 * 保证「文档 = 源码」只有一个渲染实现（否则两边各写一份必然漂移）。
 */

import type { ToolJsonSchema, ToolSchema } from '@bah/core'

import type { BankToolSpec } from './specs.ts'

/**
 * 渲染完整目录文档。
 *
 * @param specs 目录（顺序即文档顺序）
 * @param limit 数量上限（28）
 */
export function renderToolCatalog(specs: readonly BankToolSpec[], limit: number): string {
  const lines: string[] = [
    '# 银行工具目录',
    '',
    '> 本文件由 `pnpm tool-catalog` 从 `packages/bank/src/tools/specs.ts` 生成，**不要手改**。',
    '> 门禁 `verify-tool-catalog` 会逐字比对；改工具定义后请重新生成。',
    '',
    `共 **${specs.length}** 个工具（上限 ${limit}）。级别由工具定义处声明，治理平面统一解释。`,
    '',
    '| # | 工具 | 级别 | 场景 | 参数 | 落账事件 | 说明 |',
    '|---|---|---|---|---|---|---|',
  ]

  specs.forEach((spec, index) => {
    // 动作式工具有两条落账路径：只读分支（`readEvent`）必须与写分支并列显示，
    // 否则目录会把「取问卷」说成「改等级」。
    const events =
      spec.readEvent === undefined
        ? `\`${spec.event}\``
        : `\`${spec.event}\`（读分支：\`${spec.readEvent}\`）`
    lines.push(
      `| ${index + 1} | \`${spec.name}\` | ${spec.tier.level} | ${spec.scenario} | ${describeParams(
        spec.schema,
      )} | ${events} | ${escapeCell(spec.description)} |`,
    )
  })

  lines.push(
    '',
    '## 说明',
    '',
    '- **tier**：`green` 自动执行；`yellow` 展示详情 + 确认（签发票据）；`red` 强验证 + 确认。',
    '- **落账事件**：成功执行后写入会话日志的领域事件；卡片由事件 + 持久化结果派生。',
    '- **金额单位**：模型参数是「元」，核心与事件是「分」（字段名带 `Cents`）。',
    '- **上限**：新增工具先删旧的（28 上限由门禁强制）。',
  )

  return lines.join('\n')
}

/** 参数摘要：`a*, b?`；嵌套对象显示为 `payee{...}`。 */
function describeParams(schema: ToolSchema): string {
  const properties = schema.properties ?? {}
  const required = new Set(schema.required ?? [])
  const names = Object.keys(properties)
  if (names.length === 0) return '无'
  return names
    .map((name) => {
      const field = properties[name]
      const mark = required.has(name) ? '*' : '?'
      if (field?.type === 'object' && field.properties !== undefined) {
        return `${name}{${describeNested(field)}}${mark}`
      }
      return `${name}${mark}`
    })
    .join(', ')
}

/** 嵌套对象参数摘要（只展开一层）。 */
function describeNested(field: ToolJsonSchema): string {
  const properties = (field['properties'] ?? {}) as Readonly<Record<string, unknown>>
  const rawRequired = field['required']
  const required = new Set(Array.isArray(rawRequired) ? rawRequired.map(String) : [])
  return Object.keys(properties)
    .map((name) => `${name}${required.has(name) ? '*' : '?'}`)
    .join(', ')
}

/** Markdown 单元格转义（竖线与换行会破坏表格）。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}
