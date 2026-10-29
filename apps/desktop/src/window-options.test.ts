/**
 * 窗口安全选项（T-DTB-004）。七个值都是硬值。
 *
 * 这里断言的是"窗口到底拿到了什么"，不是"文档说应该是什么"——两者不一致时，
 * 以本文件为准（生产代码用的是同一份常量）。
 */

import { describe, expect, it } from 'vitest'

import { HARDENED_FLAGS, hardenedWebPreferences, WINDOW_SIZE } from './window-options.ts'

describe('HARDENED_FLAGS（T-DTB-004）', () => {
  it('四个关键项是硬值（G1 逐字比对的就是这四个）', () => {
    expect(HARDENED_FLAGS.contextIsolation).toBe(true)
    expect(HARDENED_FLAGS.nodeIntegration).toBe(false)
    expect(HARDENED_FLAGS.sandbox).toBe(true)
    expect(HARDENED_FLAGS.webSecurity).toBe(true)
  })

  it('另外三项同样不许放宽', () => {
    expect(HARDENED_FLAGS.nodeIntegrationInWorker).toBe(false)
    expect(HARDENED_FLAGS.allowRunningInsecureContent).toBe(false)
    expect(HARDENED_FLAGS.webviewTag).toBe(false)
  })

  it('键集恰为七项（多一项要同批解释它是什么闸）', () => {
    expect(Object.keys(HARDENED_FLAGS).sort()).toEqual([
      'allowRunningInsecureContent',
      'contextIsolation',
      'nodeIntegration',
      'nodeIntegrationInWorker',
      'sandbox',
      'webSecurity',
      'webviewTag',
    ])
  })
})

describe('hardenedWebPreferences', () => {
  it('带上 preload 绝对路径，且七项硬化值原样带出', () => {
    const prefs = hardenedWebPreferences('C:\\app\\dist\\preload.cjs')
    expect(prefs.preload).toBe('C:\\app\\dist\\preload.cjs')
    expect(prefs).toMatchObject(HARDENED_FLAGS)
    expect(Object.keys(prefs).sort()).toEqual(
      [...Object.keys(HARDENED_FLAGS), 'preload'].sort(),
    )
  })

  it('不同路径造出不同对象（preload 在 dev / packaged 下不是同一个绝对路径）', () => {
    const dev = hardenedWebPreferences('/repo/apps/desktop/dist/preload.cjs')
    const packaged = hardenedWebPreferences('/app/resources/app/dist/preload.cjs')
    expect(dev.preload).not.toBe(packaged.preload)
  })
})

describe('WINDOW_SIZE', () => {
  it('单窗口固定尺寸（非目标：不做多窗口与尺寸记忆）', () => {
    expect(WINDOW_SIZE.width).toBeGreaterThanOrEqual(1024)
    expect(WINDOW_SIZE.height).toBeGreaterThanOrEqual(720)
  })
})
