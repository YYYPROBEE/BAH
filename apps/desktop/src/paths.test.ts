/**
 * 路径解析（T-DTB-007）。全部是纯函数，不需要 Electron。
 *
 * 这些断言值钱的原因：dev 与 packaged 的根目录**差一层**，错了的表现是白屏 + 404，
 * 不是崩溃；而白屏在现场会被当成"前端坏了"。
 */

import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  PACKAGED_APP_DIR,
  resolveBahRoot,
  resolveHomeDir,
  resolveSessionsDir,
  resolveUserData,
  resolveWebRoot,
} from './paths.ts'

/** 假装当前在仓库根下的 `apps/desktop`。 */
const APP_DIR = resolve(process.cwd(), 'apps', 'desktop')

describe('resolveBahRoot（T-DTB-007）', () => {
  it('dev：从 apps/desktop 往上两级是仓库根（回代回去能还原 appDir）', () => {
    const root = resolveBahRoot({
      isPackaged: false,
      resourcesPath: 'C:\\ignored\\resources',
      appDir: APP_DIR,
    })
    expect(root).toBe(resolve(APP_DIR, '..', '..'))
    // 回代：<root>/apps/desktop 必须等于 appDir。这一条才是"往上两级"的真正判据
    expect(resolve(root, 'apps', 'desktop')).toBe(APP_DIR)
    expect(root).not.toBe(APP_DIR)
  })

  it('packaged：resources/app（不是 resources 本身）', () => {
    const root = resolveBahRoot({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\BAH\\resources',
      appDir: 'C:\\whatever',
    })
    expect(root).toBe(join('C:\\Program Files\\BAH\\resources', PACKAGED_APP_DIR))
    expect(root.endsWith(join('resources', 'app'))).toBe(true)
  })

  it('packaged 下忽略 appDir（dev 的绝对路径不该影响打包后的结果）', () => {
    const left = resolveBahRoot({ isPackaged: true, resourcesPath: '/r', appDir: '/a' })
    const right = resolveBahRoot({ isPackaged: true, resourcesPath: '/r', appDir: '/b' })
    expect(left).toBe(right)
  })
})

describe('resolveWebRoot', () => {
  it('静态根固定为 <root>/apps/web（与 profile 的 staticRoot 同口径）', () => {
    expect(resolveWebRoot('/x/app')).toBe(join('/x/app', 'apps', 'web'))
  })
})

describe('resolveUserData', () => {
  it('落在 <appData>/bah-desktop，不带作用域名（避免 %APPDATA%\\@bah\\desktop）', () => {
    const userData = resolveUserData('C:\\Users\\u\\AppData\\Roaming')
    expect(userData).toBe(join('C:\\Users\\u\\AppData\\Roaming', 'bah-desktop'))
    expect(userData.includes('@')).toBe(false)
  })

  it('会话目录与 home 目录都在 userData 下（I-DT-08：不写安装目录）', () => {
    const userData = resolveUserData('/home/u/.config')
    expect(resolveSessionsDir(userData)).toBe(join(userData, 'sessions'))
    expect(resolveHomeDir(userData)).toBe(join(userData, 'home'))
    expect(resolveSessionsDir(userData).startsWith(userData)).toBe(true)
    expect(resolveHomeDir(userData).startsWith(userData)).toBe(true)
  })
})
