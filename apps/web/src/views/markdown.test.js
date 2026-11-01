/**
 * 助手正文 Markdown 用例（`conversation.js` 的 `renderBlock` 依赖）。
 *
 * 正文来自模型 = 不可信输入，因此这里同时钉两件事：
 * 1. 结构识别正确（表格不会被压成一行竖线文本、列表/代码块不吞相邻段落）；
 * 2. 任何 HTML 都只作文本节点，不生成元素（XSS 面为零）。
 */

import { describe, expect, it } from 'vitest'

import { renderMarkdown } from './markdown.js'

/** 渲染结果挂进容器，便于用 querySelector 断言结构。 */
function mount(text) {
  const host = document.createElement('div')
  host.append(...renderMarkdown(text))
  return host
}

describe('renderMarkdown · 段落与标题', () => {
  it('空文本 / null / 纯空白都不产生节点', () => {
    expect(renderMarkdown('')).toEqual([])
    expect(renderMarkdown(null)).toEqual([])
    expect(renderMarkdown(' \n\t ')).toEqual([])
  })

  it('段落按空行分组，段内单行换行保留（CRLF 归一化）', () => {
    const host = mount('第一行\r\n第二行\r\n\r\n第二段')
    const paragraphs = host.querySelectorAll('p.bubble__text')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].textContent).toBe('第一行\n第二行')
    expect(paragraphs[1].textContent).toBe('第二段')
  })

  it('标题按层级标记，正文不丢', () => {
    const host = mount('# 一级标题\n### 三级标题')
    const headings = host.querySelectorAll('.bubble__heading')
    expect(headings).toHaveLength(2)
    expect(headings[0].dataset.level).toBe('1')
    expect(headings[0].className).toContain('bubble__heading--1')
    expect(headings[0].textContent).toBe('一级标题')
    expect(headings[1].dataset.level).toBe('3')
  })

  it('段落遇到块级语法就收口（不把列表吞进正文）', () => {
    const host = mount('说明\n- 第一项\n- 第二项')
    expect(host.querySelectorAll('p.bubble__text')).toHaveLength(1)
    expect(host.querySelectorAll('ul.bubble__list li')).toHaveLength(2)
  })
})

describe('renderMarkdown · 列表', () => {
  it('无序与有序列表分开渲染，缩进续行并进同一项', () => {
    const host = mount('- 第一项\n  续行\n* 第二项\n\n1. 甲\n2) 乙')
    const lists = host.querySelectorAll('.bubble__list')
    expect(lists).toHaveLength(2)
    expect(lists[0].tagName).toBe('UL')
    expect(lists[0].querySelectorAll('li')).toHaveLength(2)
    expect(lists[0].querySelectorAll('li')[0].textContent).toBe('第一项 续行')
    expect(lists[1].tagName).toBe('OL')
    expect(lists[1].className).toContain('bubble__list--ordered')
    expect(lists[1].querySelectorAll('li')).toHaveLength(2)
  })
})

describe('renderMarkdown · 表格', () => {
  it('管道表格：对齐 class、转义竖线留格内、列数补齐/截断', () => {
    const host = mount(
      [
        '| 账户 | 余额 | 可用 |',
        '|:---|:---:|---:|',
        '| 活期 | ¥1.00 | ¥1.00 |',
        '| 定期 \\| 备注 | ¥2.00 |',
      ].join('\n'),
    )
    const table = host.querySelector('table.md-table')
    expect(table).not.toBeNull()

    const headers = [...table.querySelectorAll('th')]
    expect(headers.map((th) => th.textContent)).toEqual(['账户', '余额', '可用'])
    expect(headers[0].className).not.toContain('md-table__cell--center')
    expect(headers[0].className).not.toContain('md-table__cell--right')
    expect(headers[1].className).toContain('md-table__cell--center')
    expect(headers[2].className).toContain('md-table__cell--right')

    const rows = [...table.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(2)
    expect([...rows[0].querySelectorAll('td')].map((td) => td.textContent)).toEqual(['活期', '¥1.00', '¥1.00'])
    // 转义竖线不拆列；缺的列补空，保持与表头对齐
    const second = [...rows[1].querySelectorAll('td')]
    expect(second).toHaveLength(3)
    expect(second[0].textContent).toBe('定期 | 备注')
    expect(second[2].textContent).toBe('')
  })

  it('缺分隔行 / 列数不一致 / 单列表头都按段落处理（不误判成表格）', () => {
    for (const text of [
      '| 只有一行 | 没有分隔行 |',
      '| 甲 | 乙 |\n|:---|:---:|---:|',
      '| 仅一列 |\n| --- |',
    ]) {
      const host = mount(text)
      expect(host.querySelector('table')).toBeNull()
      expect(host.querySelectorAll('p.bubble__text')).toHaveLength(1)
    }
  })
})

describe('renderMarkdown · 代码块与行内强调', () => {
  it('围栏代码块保留语言标记；未闭合时把余下内容收进代码块', () => {
    const host = mount('```json\n{"a":1}\n```\n尾段')
    const pre = host.querySelector('pre.bubble__pre')
    expect(pre.dataset.language).toBe('json')
    expect(pre.querySelector('code.bubble__code-block').textContent).toBe('{"a":1}')
    expect(host.querySelectorAll('p.bubble__text')).toHaveLength(1)

    const unclosed = mount('```\nline1\nline2')
    const fallback = unclosed.querySelector('pre.bubble__pre')
    expect(fallback).not.toBeNull()
    expect(fallback.dataset.language).toBeUndefined()
    expect(fallback.querySelector('code').textContent).toBe('line1\nline2')
  })

  it('行内粗体与内联代码渲染成节点，其余字符原样保留', () => {
    const host = mount('请**确认**后点 `提交`，金额 ¥800.00')
    const paragraph = host.querySelector('p.bubble__text')
    expect(paragraph.querySelector('strong').textContent).toBe('确认')
    expect(paragraph.querySelector('code.bubble__inline-code').textContent).toBe('提交')
    expect(paragraph.textContent).toBe('请确认后点 提交，金额 ¥800.00')
  })

  it('标题与表格单元格里的强调同样生效（语法只在块级不同）', () => {
    const host = mount('## 带 **重点** 的标题\n\n| 项 | 值 |\n|---|---|\n| **余额** | `123` |')
    expect(host.querySelector('.bubble__heading strong').textContent).toBe('重点')
    expect(host.querySelector('td strong').textContent).toBe('余额')
    expect(host.querySelector('td code').textContent).toBe('123')
  })
})

describe('renderMarkdown · 不可信输入', () => {
  it('HTML 只作文本节点，不生成元素', () => {
    const host = mount('<img src=x onerror="window.__pwned=1">')
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toBe('<img src=x onerror="window.__pwned=1">')
  })
})
