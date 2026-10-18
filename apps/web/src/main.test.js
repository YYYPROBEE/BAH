/**
 * Web 入口的 jsdom 冒烟（施工单 01 §5 的 web 面）。
 *
 * 纯原生 JS：只验证「入口模块能在浏览器环境加载、按挂载点契约写 DOM、没有挂载点不炸」，
 * 交互与卡片渲染在施工单 13 展开。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('apps/web 入口', () => {
  beforeEach(() => {
    // 模块级副作用（写 DOM）不可重复触发：每个用例重置模块缓存与 DOM
    vi.resetModules()
    document.body.innerHTML = ''
  })

  it('有挂载点时写入占位文案', async () => {
    document.body.innerHTML = '<div id="app"></div>'

    await import('./main.js')

    expect(document.querySelector('#app')?.textContent).toContain('BAH')
  })

  it('没有挂载点时不抛错（骨架容错）', async () => {
    await expect(import('./main.js')).resolves.toBeDefined()
    expect(document.body.innerHTML).toBe('')
  })
})
