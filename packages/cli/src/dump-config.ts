/**
 * `--dump-config`：打印实际生效的插件树（施工单 06 §0 第 2 条 / §4 最后一条）。
 *
 * 三列是刻意的：**行 id**（patch 的定位键）、**来源层**（谁最后改的它）、**最终配置**
 * （整块替换后的样子，默认值已补齐）。答辩时任何一行都能指着说"这一行可被上层 patch 替换"。
 *
 * 输出必须是确定性的（列宽按内容算、配置按插件校验器的写入顺序序列化），否则文档示例会腐。
 */

import type { ProfileSummary, ValidatedRow } from '@bah/host'

/** 表头。 */
const HEADER = ['id', '来源层', '配置'] as const

/**
 * 渲染生效树。
 *
 * 只吃"profile 摘要 + 行快照"两样东西（不依赖已启动的 app），这样它能被单独测。
 *
 * @returns 多行文本（末尾**不带**换行，交给调用方决定）
 */
export function renderDumpConfig(
  profile: ProfileSummary,
  rows: readonly ValidatedRow[],
): string {
  const lines = [
    `bah: profile ${profile.name}（bundles: ${profile.bundles.join(' + ')}；config HMR: ${profile.hmr ? '开' : '关'}）`,
    'bah: 层序 bundle → profile patch → home patch → overlay（整块替换，不深合并；未写字段走插件默认值）',
    '',
  ]

  const table = rows.map((row) => [row.id, sourceOf(row), JSON.stringify(row.settings) ?? 'undefined'])
  const widths = HEADER.map((title, index) =>
    Math.max(title.length, ...table.map((cells) => cells[index]!.length)),
  )
  const format = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ').trimEnd()

  lines.push(format(HEADER))
  lines.push(widths.map((width) => '-'.repeat(width)).join('  '))
  for (const cells of table) lines.push(format(cells))
  lines.push('', `bah: 共 ${rows.length} 行`)

  return lines.join('\n')
}

/** 来源层标注：`<层>:<来源>`（层名与施工单 06 §4 的四个词一一对应）。 */
function sourceOf(row: ValidatedRow): string {
  return `${row.layer}:${row.from}`
}
