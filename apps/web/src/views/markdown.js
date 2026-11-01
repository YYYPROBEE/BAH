/**
 * 助手正文的轻量 Markdown 渲染（表格 / 列表 / 代码块 / 标题 / 行内强调）。
 *
 * 只产 DOM，不拼 HTML 字符串：正文来自模型，属于不可信输入；表格单元格、
 * 列表项与行内强调全部走 textContent，反引号与竖线不会变成注入面。
 *
 * 支持的是模型实际会用的最小集；表格只认 GFM 管道表格（表头 + 分隔行），
 * 避免把正文里偶然出现的 `|` 误判成表格。窄屏由 `.md-table-wrap` 横向滚动兜底。
 */

import { el } from '../dom.js'

const DELIMITER_CELL = /^:?-{3,}:?$/
const FENCE = /^\s*```/
const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/
const UL_ITEM = /^\s{0,3}[-*+]\s+(.+)$/
const OL_ITEM = /^\s{0,3}\d+[.)]\s+(.+)$/

/**
 * 文本 → 节点数组。
 *
 * @param {string} text
 * @returns {HTMLElement[]}
 */
export function renderMarkdown(text) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  if (source.trim() === '') return []
  const lines = source.split('\n')
  const nodes = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    if (FENCE.test(line)) {
      const block = readFence(lines, index)
      nodes.push(block.node)
      index = block.next
      continue
    }

    if (isTableAt(lines, index)) {
      const block = readTable(lines, index)
      nodes.push(block.node)
      index = block.next
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = heading[1]?.length ?? 1
      nodes.push(
        el('p', { class: `bubble__heading bubble__heading--${String(level)}`, dataset: { level: String(level) } }, renderInline(heading[2] ?? '')),
      )
      index += 1
      continue
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const block = readList(lines, index)
      nodes.push(block.node)
      index = block.next
      continue
    }

    const block = readParagraph(lines, index)
    nodes.push(block.node)
    index = block.next
  }

  return nodes
}

/** 段落：连续非空行，遇到下一种块级语法就让位。 */
function readParagraph(lines, start) {
  const parts = []
  let index = start
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') break
    if (index > start && startsBlock(lines, index)) break
    parts.push(line)
    index += 1
  }
  return { node: el('p', { class: 'bubble__text' }, renderInline(parts.join('\n'))), next: index }
}

/** 当前行是否会开启一个非段落块（表格需要看下一行，单独处理）。 */
function startsBlock(lines, index) {
  const line = lines[index] ?? ''
  return FENCE.test(line) || HEADING.test(line) || UL_ITEM.test(line) || OL_ITEM.test(line) || isTableAt(lines, index)
}

/** 表格判定：本行有竖线，下一行是列数一致的分隔行。 */
function isTableAt(lines, index) {
  const header = lines[index] ?? ''
  const delimiter = lines[index + 1] ?? ''
  if (!header.includes('|') || !delimiter.includes('|')) return false
  const headerCells = splitRow(header)
  if (headerCells.length < 2) return false
  const delimiterCells = splitRow(delimiter)
  if (delimiterCells.length !== headerCells.length) return false
  return delimiterCells.every((cell) => DELIMITER_CELL.test(cell))
}

/** 读一张管道表格；正文行必须继续带竖线，空行或新表格就收口。 */
function readTable(lines, start) {
  const headerCells = splitRow(lines[start] ?? '')
  const alignments = splitRow(lines[start + 1] ?? '').map(alignmentOf)
  const rows = []
  let index = start + 2

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || !line.includes('|') || isTableAt(lines, index)) break
    rows.push(normalizeRow(splitRow(line), headerCells.length))
    index += 1
  }

  const head = el('thead', {}, [
    el(
      'tr',
      {},
      headerCells.map((cell, column) => el('th', { scope: 'col', class: alignments[column] ?? '' }, renderInline(cell))),
    ),
  ])
  const body = el(
    'tbody',
    {},
    rows.map((row) =>
      el(
        'tr',
        {},
        row.map((cell, column) => el('td', { class: alignments[column] ?? '' }, renderInline(cell))),
      ),
    ),
  )

  return {
    node: el('div', { class: 'md-table-wrap' }, [el('table', { class: 'md-table' }, [head, body])]),
    next: index,
  }
}

/** 拆一行单元格：支持 `\|` 转义，去掉首尾装饰竖线。 */
function splitRow(line) {
  let text = String(line ?? '').trim()
  if (text.startsWith('|')) text = text.slice(1)
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1)

  const cells = []
  let current = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\\' && text[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (char === '|') {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  cells.push(current.trim())
  return cells
}

/** 分隔行 → 单元格对齐 class。 */
function alignmentOf(cell) {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  if (left && right) return 'md-table__cell--center'
  if (right) return 'md-table__cell--right'
  return ''
}

/** 数据行补齐/截断到表头列数，避免单元格错位。 */
function normalizeRow(cells, columns) {
  const row = cells.slice(0, columns)
  while (row.length < columns) row.push('')
  return row
}

/** 无序 / 有序列表；缩进续行并进同一项，不让一句话被拆成段落。 */
function readList(lines, start) {
  const ordered = OL_ITEM.test(lines[start] ?? '')
  const pattern = ordered ? OL_ITEM : UL_ITEM
  const items = []
  let index = start

  while (index < lines.length) {
    const match = pattern.exec(lines[index] ?? '')
    if (match === null) break
    let text = match[1] ?? ''
    let cursor = index + 1
    while (cursor < lines.length) {
      const line = lines[cursor] ?? ''
      if (line.trim() === '' || pattern.test(line) || startsBlock(lines, cursor)) break
      if (!/^\s{2,}/.test(line)) break
      text += ` ${line.trim()}`
      cursor += 1
    }
    items.push(el('li', {}, renderInline(text)))
    index = cursor
  }

  return {
    node: el(ordered ? 'ol' : 'ul', { class: `bubble__list${ordered ? ' bubble__list--ordered' : ''}` }, items),
    next: index,
  }
}

/** 围栏代码块；没有闭合围栏时把余下内容收进代码块而不是整段丢掉。 */
function readFence(lines, start) {
  const language = (lines[start] ?? '').trim().slice(3).trim()
  const body = []
  let index = start + 1
  while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
    body.push(lines[index] ?? '')
    index += 1
  }
  if (index < lines.length) index += 1

  return {
    node: el('pre', { class: 'bubble__pre', dataset: language === '' ? {} : { language } }, [
      el('code', { class: 'bubble__code-block', text: body.join('\n') }),
    ]),
    next: index,
  }
}

/** 行内 `**粗体**` 与 `` `代码` ``；其余字符原样成为文本节点。 */
function renderInline(text) {
  const nodes = []
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g
  let last = 0

  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) nodes.push(el('strong', {}, [token.slice(2, -2)]))
    else nodes.push(el('code', { class: 'bubble__inline-code', text: token.slice(1, -1) }))
    last = match.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}
