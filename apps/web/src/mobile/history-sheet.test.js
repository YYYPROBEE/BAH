/**
 * 移动壳历史面板（2026-11-02）。
 *
 * 只测本文件的三件事：容器开合、请求结果如何落到面板、以及**异步回来时容器已经关了**
 * 不能炸（用户点了关闭就走的场景，jsdom 里也会走到）。
 * 列表与只读帧的渲染口径在 `views/history.test.js` 里已经钉死，不在这里重复。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { el } from '../dom.js'
import { createHistorySheet, HISTORY_CLOSE_LABEL } from './history-sheet.js'

const ITEM = {
  sessionId: 's-a',
  title: '转 500 给他',
  startedAt: 1_700_000_000_000,
  lastAt: 1_700_000_060_000,
  events: 42,
  turns: 3,
  current: false,
}

function view(text) {
  return el('div', { class: 'stub', text })
}

describe('移动端历史面板', () => {
  let host

  afterEach(() => {
    host?.remove()
    host = null
  })

  function mount(overrides = {}) {
    host = el('div', { class: 'm-shell' })
    document.body.append(host)
    const deps = {
      loadList: vi.fn(async () => ({ ok: true, data: { sessions: [ITEM], total: 1 } })),
      loadSession: vi.fn(async () => ({
        ok: true,
        data: { title: '转 500 给他', snapshot: { frames: [{ kind: 'message' }] } },
      })),
      renderFrame: vi.fn((frame) => view(String(frame.kind))),
      ...overrides,
    }
    return { sheet: createHistorySheet(host, deps), deps }
  }

  it('打开后是 dialog、标题为历史对话、关闭钮有无障碍名', async () => {
    const { sheet } = mount()
    await sheet.open()
    const backdrop = host.querySelector('.m-history-backdrop')
    expect(backdrop).not.toBeNull()
    expect(backdrop.getAttribute('role')).toBe('dialog')
    expect(backdrop.getAttribute('aria-modal')).toBe('true')
    expect(host.querySelector('.m-history__title').textContent).toBe('历史对话')
    expect(host.querySelector('[data-role="m-history-close"]').getAttribute('aria-label')).toBe(
      HISTORY_CLOSE_LABEL,
    )
    expect(sheet.isOpen()).toBe(true)
  })

  it('列表加载成功后渲染条目，点条目进只读回放', async () => {
    const { sheet, deps } = mount()
    await sheet.open()
    const item = host.querySelector('[data-role="history-item"]')
    expect(item).not.toBeNull()
    expect(item.textContent).toContain('转 500 给他')

    item.click()
    await vi.waitFor(() => expect(deps.loadSession).toHaveBeenCalledWith('s-a'))
    await vi.waitFor(() =>
      expect(host.querySelector('[data-role="history-readonly"]')).not.toBeNull(),
    )
    expect(host.querySelector('[data-role="history-banner"]').textContent).toContain('只读历史')
    expect(deps.renderFrame).toHaveBeenCalled()
  })

  it('从回放点"返回当前会话"回到列表（重新拉一次，不缓存）', async () => {
    const { sheet, deps } = mount()
    await sheet.open()
    host.querySelector('[data-role="history-item"]').click()
    await vi.waitFor(() => expect(host.querySelector('[data-role="history-readonly"]')).not.toBeNull())

    host.querySelector('[data-role="history-back"]').click()
    await vi.waitFor(() => expect(deps.loadList).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(host.querySelector('[data-role="history-item"]')).not.toBeNull())
  })

  it('列表失败时给错误面板，并把服务端理由原样带出来', async () => {
    const { sheet } = mount({ loadList: vi.fn(async () => ({ ok: false, reason: '没装持久化' })) })
    await sheet.open()
    expect(host.querySelector('[data-role="history-error"]').textContent).toContain('没装持久化')
  })

  it('列表失败且没有理由时用兜底文案', async () => {
    const { sheet } = mount({ loadList: vi.fn(async () => ({ ok: false })) })
    await sheet.open()
    expect(host.querySelector('[data-role="history-error"]').textContent).toContain('读取历史失败')
  })

  it('后端返回的 sessions 不是数组时按空列表处理，不崩', async () => {
    const { sheet } = mount({ loadList: vi.fn(async () => ({ ok: true, data: {} })) })
    await sheet.open()
    expect(host.querySelector('[data-role="history-empty"]')).not.toBeNull()
  })

  it('回放失败时退回错误面板', async () => {
    const { sheet } = mount({ loadSession: vi.fn(async () => ({ ok: false, reason: '会话太大' })) })
    await sheet.open()
    host.querySelector('[data-role="history-item"]').click()
    await vi.waitFor(() =>
      expect(host.querySelector('[data-role="history-error"]').textContent).toContain('会话太大'),
    )
  })

  it('回放没有 frames 时只出横幅，不崩', async () => {
    const { sheet } = mount({
      loadSession: vi.fn(async () => ({ ok: true, data: { title: '空会话' } })),
    })
    await sheet.open()
    host.querySelector('[data-role="history-item"]').click()
    await vi.waitFor(() =>
      expect(host.querySelector('[data-role="history-readonly"]')).not.toBeNull(),
    )
    expect(host.querySelector('[data-role="history-feed"]').children).toHaveLength(0)
  })

  it('关闭时移除节点并把焦点还给触发按钮', async () => {
    const { sheet } = mount()
    const trigger = el('button', { type: 'button', text: '历史' })
    host.append(trigger)
    trigger.focus()

    await sheet.open()
    expect(sheet.isOpen()).toBe(true)
    host.querySelector('[data-role="m-history-close"]').click()
    expect(sheet.isOpen()).toBe(false)
    expect(host.querySelector('.m-history-backdrop')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('Esc 关闭；关闭后再按 Esc 不抛', async () => {
    const { sheet } = mount()
    await sheet.open()
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(sheet.isOpen()).toBe(false)
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
  })

  it('Esc 之外的键不关闭', async () => {
    const { sheet } = mount()
    await sheet.open()
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }))
    expect(sheet.isOpen()).toBe(true)
  })

  it('重复 open 是刷新，不叠第二层', async () => {
    const { sheet, deps } = mount()
    await sheet.open()
    await sheet.open()
    expect(host.querySelectorAll('.m-history-backdrop')).toHaveLength(1)
    expect(deps.loadList).toHaveBeenCalledTimes(2)
  })

  it('请求还没回来就关闭：回来时不往已卸掉的容器里写', async () => {
    let resolveList
    const { sheet } = mount({
      loadList: () => new Promise((resolve) => {
        resolveList = resolve
      }),
    })
    const pending = sheet.open()
    sheet.close()
    resolveList({ ok: true, data: { sessions: [ITEM] } })
    await pending
    expect(host.querySelector('.m-history-backdrop')).toBeNull()
  })

  it('close 可重复调用（第二次是空操作）', () => {
    const { sheet } = mount()
    sheet.close()
    sheet.close()
    expect(sheet.isOpen()).toBe(false)
  })
})
