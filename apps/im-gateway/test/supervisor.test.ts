/**
 * 监督者（施工单 02 §2.11）：一用户一子进程 / 复用 / 崩溃重启 / 闲置回收 / 上限。
 *
 * 假子进程（`fake-child.ts`）实现 `LaunchedChild`，因此这里测的是真实的
 * `reservePort → overlay → spawn → health → CSRF` 链路，只是把 `node:child_process`
 * 换成了同进程 HTTP server。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { loadConfig, type GatewayConfig } from '../src/config.ts'
import { createImLogger } from '../src/log.ts'
import { awaitChildReady } from '../src/session/ready.ts'
import { createSupervisor, type ChildLauncher, type LaunchedChild, type SupervisorDeps } from '../src/session/supervisor.ts'
import { launchFakeChild, type FakeChildHandle } from './fake-child.ts'

const log = createImLogger('error', () => undefined)
let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bah-im-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 最小配置（不可变；用例用 `configWith` 覆盖）。 */
function baseConfig(): GatewayConfig {
  return loadConfig(
    {
      BAH_IM_SESSION_SALT: 'salt-0123456789abcdef',
      BAH_WECHAT_APPID: 'demo-app',
      BAH_WECHAT_SECRET: 'demo-secret',
      BAH_WECHAT_TOKEN: 'demo-callback-token',
      BAH_IM_ROOT: root,
      BAH_IM_JSONL_BASE: join(root, 'sessions/im'),
    },
    root,
  )
}

/** 覆盖少量字段。 */
function configWith(overrides: Partial<GatewayConfig>): GatewayConfig {
  return { ...baseConfig(), ...overrides }
}

/** 造监督者（注入同进程假子进程 + 快轮询握手）。 */
function supervisorWith(config: GatewayConfig, options: Partial<SupervisorDeps> = {}): {
  supervisor: ReturnType<typeof createSupervisor>
  children: FakeChildHandle[]
  launched: { args: readonly string[]; env: Readonly<Record<string, string>>; port: number }[]
} {
  const children: FakeChildHandle[] = []
  const launched: { args: readonly string[]; env: Readonly<Record<string, string>>; port: number }[] = []
  const launcher: ChildLauncher = (request): LaunchedChild => {
    launched.push({ args: request.args, env: request.env, port: request.port })
    const child = launchFakeChild(request.port, { csrf: `csrf-${String(children.length)}` })
    children.push(child)
    return child
  }
  const supervisor = createSupervisor({
    config,
    log,
    launcher,
    handshake: (port, timeoutMs) => awaitChildReady({ port, timeoutMs: Math.min(timeoutMs, 5000), pollMs: 10 }),
    randomToken: () => 'web-token-fixed',
    terminateGraceMs: 10,
    ...options,
  })
  return { supervisor, children, launched }
}

/** 睡一会儿（等子进程 listen / 握手）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** 等条件成立（最多 `ms`）。 */
async function waitFor(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate() && Date.now() < deadline) await sleep(10)
}

describe('一平台用户一子进程（T-IM-002 / T-IM-003）', () => {
  it('同用户第二次 → 复用同一 sessionKey / 端口 / 子进程', async () => {
    const { supervisor, launched } = supervisorWith(baseConfig())
    const first = await supervisor.ensure('mock', 'u-1')
    const second = await supervisor.ensure('mock', 'u-1')
    expect(second.sessionKey).toBe(first.sessionKey)
    expect(second.port).toBe(first.port)
    expect(launched.length).toBe(1)
    expect(supervisor.spawnCount()).toBe(1)
    await supervisor.dispose()
  })

  it('不同用户 → 两个 sessionKey、两个子进程', async () => {
    const { supervisor, launched } = supervisorWith(baseConfig())
    const a = await supervisor.ensure('mock', 'u-1')
    const b = await supervisor.ensure('mock', 'u-2')
    expect(a.sessionKey).not.toBe(b.sessionKey)
    expect(launched.length).toBe(2)
    expect(supervisor.spawnCount()).toBe(2)
    await supervisor.dispose()
  })

  it('同 userId 跨平台 → 不同 sessionKey（命名空间隔离，T-IM-024）', async () => {
    const { supervisor } = supervisorWith(baseConfig())
    const wechat = await supervisor.ensure('wechat', 'same-user')
    const mock = await supervisor.ensure('mock', 'same-user')
    expect(wechat.sessionKey).not.toBe(mock.sessionKey)
    await supervisor.dispose()
  })

  it('并发两次 ensure 只 spawn 一次（单飞）', async () => {
    const { supervisor, launched } = supervisorWith(baseConfig())
    const [a, b] = await Promise.all([supervisor.ensure('mock', 'u-1'), supervisor.ensure('mock', 'u-1')])
    expect(a.sessionKey).toBe(b.sessionKey)
    expect(launched.length).toBe(1)
    await supervisor.dispose()
  })
})

describe('spawn 形状与 overlay（§2.11）', () => {
  it('参数带 --profile/--session/--patch/--jsonl；env 只注入 BAH_WEB_TOKEN', async () => {
    const { supervisor, launched } = supervisorWith(baseConfig())
    const handle = await supervisor.ensure('mock', 'u-1')
    const launch = launched[0]
    if (launch === undefined) throw new Error('没有 spawn')
    expect(launch.args).toContain('--profile')
    expect(launch.args).toContain('im')
    expect(launch.args).toContain('--session')
    expect(launch.args).toContain(handle.sessionKey)
    expect(launch.args).toContain('--patch')
    expect(launch.args).toContain('--jsonl')
    expect(launch.env).toEqual({ BAH_WEB_TOKEN: 'web-token-fixed' })
    expect(launch.port).toBe(handle.port)
    await supervisor.dispose()
  })

  it('overlay 文件写全字段，host 固定 127.0.0.1（门禁 G5）', async () => {
    const { supervisor } = supervisorWith(baseConfig())
    const handle = await supervisor.ensure('mock', 'u-1')
    const content = await readFile(join(root, '.tmp-im', `${handle.sessionKey}.yml`), 'utf8')
    expect(content).toContain(`port: ${String(handle.port)}`)
    expect(content).toContain('host: 127.0.0.1')
    expect(content).toContain('staticRoot: apps/web')
    expect(content).toContain('entry: m.html')
    expect(content).toContain('heartbeatMs: 15000')
    expect(content).toContain('slaMs: 180000')
    expect(content).not.toContain('0.0.0.0')
    await supervisor.dispose()
  })
})

describe('崩溃重启（T-IM-013）', () => {
  it('非预期退出 → 自动重启（新端口、同 sessionKey）', async () => {
    const { supervisor, children } = supervisorWith(baseConfig())
    const handle = await supervisor.ensure('mock', 'u-1')
    expect(children.length).toBe(1)
    children[0]?.crash()
    await waitFor(() => supervisor.spawnCount() === 2)
    expect(supervisor.spawnCount()).toBe(2)
    await waitFor(() => supervisor.get(handle.sessionKey)?.status === 'ready')
    expect(supervisor.get(handle.sessionKey)?.status).toBe('ready')
    await supervisor.dispose()
  })

  it('重启次数有上限（不在 10 分钟内无限重启）', async () => {
    const { supervisor, children } = supervisorWith(baseConfig())
    await supervisor.ensure('mock', 'u-1')
    // 连撞 4 次：第 4 次超过上限，不应再 spawn
    for (let index = 0; index < 4; index += 1) {
      children[index]?.crash()
      await sleep(120)
    }
    expect(supervisor.spawnCount()).toBeLessThanOrEqual(4)
    expect(supervisor.children()).toBe(0)
    await supervisor.dispose()
  })

  it('主动 stop 不触发重启', async () => {
    const { supervisor, children } = supervisorWith(baseConfig())
    const handle = await supervisor.ensure('mock', 'u-1')
    await supervisor.stop(handle.sessionKey, 'idle')
    await sleep(50)
    expect(supervisor.spawnCount()).toBe(1)
    expect(children.length).toBe(1)
    await supervisor.dispose()
  })
})

describe('闲置回收与上限（T-IM-014 / T-IM-018）', () => {
  it('闲置超过 TTL → 回收；再次消息可重启', async () => {
    let now = 0
    const config = configWith({ idleTtlMs: 1_000 })
    const { supervisor } = supervisorWith(config, { nowMs: () => now })
    const handle = await supervisor.ensure('mock', 'u-1')
    now = 2_000
    expect(supervisor.reapIdle()).toBe(1)
    await waitFor(() => supervisor.children() === 0)
    expect(supervisor.children()).toBe(0)
    const again = await supervisor.ensure('mock', 'u-1')
    expect(again.sessionKey).toBe(handle.sessionKey)
    expect(supervisor.spawnCount()).toBe(2)
    await supervisor.dispose()
  })

  it('达到上限且无可回收 → im-children-full（不静默排队）', async () => {
    let now = 0
    const config = configWith({ maxChildren: 1, idleTtlMs: 10_000 })
    const { supervisor } = supervisorWith(config, { nowMs: () => now })
    await supervisor.ensure('mock', 'u-1')
    now = 1_000
    await expect(supervisor.ensure('mock', 'u-2')).rejects.toMatchObject({ code: 'im-children-full' })
    await supervisor.dispose()
  })

  it('达到上限但有闲置 → 回收后继续（不拒绝）', async () => {
    let now = 0
    const config = configWith({ maxChildren: 1, idleTtlMs: 1_000 })
    const { supervisor } = supervisorWith(config, { nowMs: () => now })
    await supervisor.ensure('mock', 'u-1')
    now = 2_000
    const second = await supervisor.ensure('mock', 'u-2')
    expect(second.sessionKey.length).toBeGreaterThan(0)
    expect(supervisor.spawnCount()).toBe(2)
    await supervisor.dispose()
  })

  it('并发 ensure 不突破 maxChildren（TOCTOU）', async () => {
    const config = configWith({ maxChildren: 1, idleTtlMs: 10_000 })
    const { supervisor } = supervisorWith(config)
    const results = await Promise.allSettled([
      supervisor.ensure('mock', 'u-1'),
      supervisor.ensure('mock', 'u-2'),
    ])
    expect(results.filter((item) => item.status === 'fulfilled').length).toBe(1)
    expect(supervisor.children()).toBeLessThanOrEqual(1)
    await supervisor.dispose()
  })

  it('dispose 停掉全部子进程', async () => {
    const { supervisor } = supervisorWith(baseConfig())
    await supervisor.ensure('mock', 'u-1')
    await supervisor.ensure('mock', 'u-2')
    expect(supervisor.children()).toBe(2)
    await supervisor.dispose()
    expect(supervisor.children()).toBe(0)
  })
})

describe('启动失败', () => {
  it('握手失败 → 抛错且不留下幽灵记录', async () => {
    const { supervisor } = supervisorWith(baseConfig(), {
      handshake: async () => {
        throw new BahError('im-child-timeout', 'fake timeout')
      },
    })
    await expect(supervisor.ensure('mock', 'u-1')).rejects.toMatchObject({ code: 'im-child-timeout' })
    expect(supervisor.children()).toBe(0)
    await supervisor.dispose()
  })
})
