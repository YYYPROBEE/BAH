/**
 * 子进程环境的密钥清洗。
 *
 * 现有监督者用例都注入自定义 `launcher`，绕过了生产路径里的 `scrubbedEnv()`；
 * 这里把 `node:child_process` 换成探针，调到真实的默认 launcher，钉住：
 * - `BAH_WECHAT_*` / `BAH_IM_*` 不继承（AppSecret、会话盐、公网运营令牌不进子进程）；
 * - 普通环境变量照常继承；
 * - 本会话的两把凭证仍由监督者显式注入；
 * - `shell:false` 且参数走数组（不把平台输入拼进命令行）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { loadConfig, type Env } from '../src/config.ts'
import { createImLogger } from '../src/log.ts'
import { createSupervisor } from '../src/session/supervisor.ts'
import { fakeChild } from './harness-03.ts'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

const log = createImLogger('error', () => undefined)
let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bah-im-env-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 最小合法环境（与 gateway-core 同口径）。 */
function configForTest(): ReturnType<typeof loadConfig> {
  const env: Env = {
    BAH_IM_SESSION_SALT: 'salt-0123456789abcdef',
    BAH_IM_LINK_SECRET: 'link-secret-0123456789abcdefghij',
    BAH_WECHAT_APPID: 'demo-app',
    BAH_WECHAT_SECRET: 'demo-secret',
    BAH_WECHAT_TOKEN: 'demo-callback-token',
    BAH_IM_ROOT: root,
    BAH_IM_JSONL_BASE: join(root, 'sessions/im'),
  }
  return loadConfig(env, root)
}

describe('默认 launcher 的环境清洗', () => {
  it('平台密钥 / 会话盐 / 公网运营令牌不继承；普通变量保留；shell:false', async () => {
    const child = { pid: 4242, kill: vi.fn(), once: vi.fn() }
    spawnMock.mockReturnValue(child)

    const saved = new Map<string, string | undefined>()
    const overrides: Readonly<Record<string, string>> = {
      BAH_WECHAT_APPID: 'secret-appid',
      BAH_WECHAT_SECRET: 'secret-appsecret',
      BAH_IM_SESSION_SALT: 'secret-salt',
      BAH_IM_OPERATOR_TOKEN: 'secret-operator-token',
      BAH_TEST_CANARY: 'keep-me',
    }
    for (const [key, value] of Object.entries(overrides)) {
      saved.set(key, process.env[key])
      process.env[key] = value
    }

    try {
      const supervisor = createSupervisor({
        config: configForTest(),
        log,
        reserve: async () => 4567,
        handshake: async () => ({ csrf: 'csrf-1' }),
        client: () => fakeChild(),
        randomToken: () => 'child-web-token',
        randomOperatorToken: () => 'child-operator-token',
        terminateGraceMs: 10,
      })
      const handle = await supervisor.ensure('mock', 'u-1')
      expect(handle.port).toBe(4567)

      const call = spawnMock.mock.calls[0]
      if (call === undefined) throw new Error('默认 launcher 没有调用 spawn')
      const [command, args, options] = call as [
        string,
        readonly string[],
        { readonly env: Readonly<Record<string, string>>; readonly shell: boolean },
      ]
      expect(command).toBe(process.execPath)
      expect(Array.isArray(args)).toBe(true)
      expect(options.shell).toBe(false)

      expect(options.env['BAH_WECHAT_APPID']).toBeUndefined()
      expect(options.env['BAH_WECHAT_SECRET']).toBeUndefined()
      expect(options.env['BAH_IM_SESSION_SALT']).toBeUndefined()
      expect(options.env['BAH_IM_OPERATOR_TOKEN']).toBeUndefined()
      expect(options.env['BAH_TEST_CANARY']).toBe('keep-me')
      expect(options.env['BAH_WEB_TOKEN']).toBe('child-web-token')
      expect(options.env['BAH_OPERATOR_TOKEN']).toBe('child-operator-token')

      await supervisor.dispose()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
