import { afterEach, describe, expect, it, vi } from 'vitest'

import { createDialog } from './dialog.js'

describe('帮助弹窗', () => {
  let host
  let dialog

  afterEach(() => {
    dialog?.dispose()
    dialog = null
    host?.remove()
  })

  function open() {
    host = document.createElement('div')
    document.body.append(host)
    dialog = createDialog(host)
    const body = document.createElement('p')
    body.textContent = '服务范围正文'
    dialog.show({ title: '服务与帮助', body })
    return dialog
  }

  it('打开后 role=dialog、标题与正文可见、焦点落在关闭钮', () => {
    open()
    const panel = host.querySelector('[role="dialog"]')
    expect(panel).not.toBeNull()
    expect(panel.textContent).toContain('服务与帮助')
    expect(panel.textContent).toContain('服务范围正文')
    expect(document.activeElement).toBe(host.querySelector('[data-role="dialog-close"]'))
  })

  it('Esc 关闭并把焦点还给打开前的元素', () => {
    const trigger = document.createElement('button')
    trigger.textContent = '打开'
    document.body.append(trigger)
    trigger.focus()

    open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    trigger.remove()
  })

  it('点背景关闭；点弹窗内部不关闭', () => {
    open()
    const backdrop = host.querySelector('[data-role="dialog-backdrop"]')
    host.querySelector('[role="dialog"]').click()
    expect(backdrop.hidden).toBe(false)

    backdrop.click()
    expect(backdrop.hidden).toBe(true)
  })

  it('重复 open 不会叠出两个弹窗', () => {
    open()
    const body = document.createElement('p')
    dialog.show({ title: '第二次', body })
    expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(host.textContent).toContain('第二次')
  })

  it('onClose 只在真正关闭时回调一次', () => {
    const onClose = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    dialog = createDialog(host, { onClose })
    dialog.show({ title: '标题', body: document.createElement('p') })

    dialog.close()
    dialog.close()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
