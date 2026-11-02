import { describe, expect, it } from 'vitest'

import { startSecurePasswordPage } from './password.js'

/** 在指定 URL 上挂载安全页根节点。 */
function mount(search) {
  document.body.innerHTML = '<main id="secure-password"></main>'
  window.history.replaceState({}, '', `/secure/password${search}`)
}

describe('安全页：交接票据预填', () => {
  it('?ticket= 预填票据框，并立刻从地址栏抹掉', async () => {
    mount('?ticket=pwd%3Ac-12')
    await startSecurePasswordPage()

    const ticket = document.querySelector('input[name="ticketId"]')
    expect(ticket).not.toBeNull()
    expect(ticket.value).toBe('pwd:c-12')
    expect(window.location.search).toBe('')
  })

  it('没有票据参数时输入框为空（不编一个默认票据）', async () => {
    mount('')
    await startSecurePasswordPage()

    const ticket = document.querySelector('input[name="ticketId"]')
    expect(ticket.value).toBe('')
  })
})
