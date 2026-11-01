/**
 * 私有 host 的启动编排（桌面端 02 §2.3）。
 *
 * `boot.ts` 不 import electron，启动顺序本身就是安全/正确性约束：
 * token 必须在 `boot()` 前注入、chdir 必须先于相对路径解析、会话只能写 userData、
 * `probe:true` 才能拿到真实端口。现有验收脚本只做源码字符串比对，这里把
 * 真实调用顺序与传给 host 的 run 上下文钉住。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { BootOptions, BootedApp } from '@bah/host'
import { DEFAULT_TENANT_ID } from '@bah/util'

import { sessionsDirOf, startDesktopHost } from './boot.ts'
import { desktopSessionId } from './session-id.ts'

const bootMock = vi.hoisted(() => vi.fn())
const loadBundlesMock = vi.hoisted(() => vi.fn())
const readLayersMock = vi.hoisted(() => vi.fn())
const readProfileMock = vi.hoisted(() => vi.fn())

vi.mock('@bah/host', () => ({
  boot: bootMock,
  createCatalog: vi.fn(() => ({})),
  DESKTOP_SERVER: 'bah:desktop-server',
}))

vi.mock('@bah/cli', () => ({
  loadBundles: loadBundlesMock,
  readLayers: readLayersMock,
  readProfile: readProfileMock,
}))

const NOW = 1_793_000_000_000
const SESSION_ID = desktopSessionId(new Date(NOW))
let root = ''
let userData = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bah-desktop-root-'))
  userData = await mkdtemp(join(tmpdir(), 'bah-desktop-user-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true })
})

/** 假 host：只提供 `startDesktopHost` 需要的端口/URL 与 dispose。 */
function fakeApp(): BootedApp {
  return {
    ctx: {
      get: () => ({ port: 4321, url: 'http://127.0.0.1:4321/', sessionId: SESSION_ID }),
    },
    dispose: vi.fn(async () => undefined),
  } as unknown as BootedApp
}

/** 两个用例共用的 mock 复位。 */
function resetMocks(calls: string[] = []): void {
  bootMock.mockReset()
  bootMock.mockImplementation(async () => {
    calls.push('boot')
    return fakeApp()
  })
  loadBundlesMock.mockReset()
  loadBundlesMock.mockResolvedValue([])
  readLayersMock.mockReset()
  readLayersMock.mockReturnValue({ layers: [] })
  readProfileMock.mockReset()
  readProfileMock.mockReturnValue({ bundles: ['base'] })
}

describe('startDesktopHost 的启动顺序与运行上下文', () => {
  it('chdir 先于 boot；token 在 boot 前注入；会话只写 userData 且 probe=true', async () => {
    const calls: string[] = []
    resetMocks(calls)

    const env: NodeJS.ProcessEnv = {}
    const chdir = vi.fn((dir: string) => {
      expect(dir).toBe(root)
      calls.push('chdir')
    })

    const result = await startDesktopHost({
      root,
      userData,
      isPackaged: true,
      now: () => NOW,
      env,
      chdir,
    })

    // 顺序：相对路径（staticRoot / policy root / persistence root）依赖 chdir
    expect(calls).toEqual(['chdir', 'boot'])
    // token 必须已写入主进程环境，页面 meta 与请求头才会一致
    expect(env['BAH_WEB_TOKEN']).toMatch(/^[A-Za-z0-9_-]{32}$/)

    const options = bootMock.mock.calls[0]?.[0] as BootOptions | undefined
    if (options === undefined) throw new Error('没有调用 host boot')
    expect(options.run.sessionId).toBe(desktopSessionId(new Date(NOW)))
    expect(options.run.tenantId).toBe(DEFAULT_TENANT_ID)
    expect(options.run.jsonlDir).toBe(sessionsDirOf(userData))
    // 桌面端写 port:0；probe:false 会让端口恒为 0（窗口打不开）
    expect(options.run.probe).toBe(true)
    expect(options.run.now).toBeTypeOf('function')
    expect(options.run.warn).toBeTypeOf('function')

    expect(result).toMatchObject({
      port: 4321,
      url: 'http://127.0.0.1:4321/',
      sessionId: SESSION_ID,
    })
  })

  it('已有非空 token 时沿用，不生成第二个（否则页面与请求头 401）', async () => {
    resetMocks()
    const env: NodeJS.ProcessEnv = { BAH_WEB_TOKEN: 'fixed-token' }
    await startDesktopHost({
      root,
      userData,
      isPackaged: true,
      now: () => NOW,
      env,
      chdir: () => undefined,
    })
    expect(env['BAH_WEB_TOKEN']).toBe('fixed-token')
  })

  it('空白 token 视为未配置，重新生成（防复制来的空串穿透）', async () => {
    resetMocks()
    const env: NodeJS.ProcessEnv = { BAH_WEB_TOKEN: '   ' }
    await startDesktopHost({
      root,
      userData,
      isPackaged: true,
      now: () => NOW,
      env,
      chdir: () => undefined,
    })
    expect(env['BAH_WEB_TOKEN']).not.toBe('   ')
    expect(env['BAH_WEB_TOKEN']).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })
})
