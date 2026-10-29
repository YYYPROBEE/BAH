/**
 * 子进程监督者（施工单 02 §2.11 / §2.11 的崩溃与回收）。
 *
 * 一次"确保某用户有子进程"的流程：
 * `sessionKey → 查表 → 预分配端口 → 写 overlay → spawn → health 轮询 → /m.html 取 CSRF → 就绪`。
 *
 * 三条纪律：
 * 1. **一平台用户一子进程**（T-IM-002/003）：同 `(platform,userId)` 复用，不同用户互不串话；
 *     同 userId 跨平台因 `sessionKey` 带 platform 而天然分开（T-IM-024）；
 * 2. **崩溃重启有上限**：10 分钟内最多 3 次，超限 `disabled` 并回"系统繁忙"——
 *     不设上限的自动重启会把"配置错误"变成"CPU 打满"；
 * 3. **子进程 env 要清洗**：`BAH_WECHAT_*` / `BAH_IM_*` 一律不继承
 *     （AppSecret、会话盐、运营令牌都不该出现在子进程的 `process.env` 里）。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

import { deriveImSessionId } from '@bah/channels'
import { BahError } from '@bah/util'

import type { GatewayConfig } from '../config.ts'
import type { ImLogger } from '../log.ts'
import type { ChildClient } from './client.ts'
import { createChildClient } from './client.ts'
import { awaitChildReady } from './ready.ts'
import { renderOverlay, writeOverlay } from './overlay.ts'
import { reservePortWithRetry } from './port.ts'
import { createChildRegistry, type ChildRecord, type ChildRegistry } from './registry.ts'

/** 一次 spawn 的请求（launcher 只认这些；便于测试替换成同进程假子进程）。 */
export interface LaunchRequest {
  readonly port: number
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/** 已拉起的子进程句柄。 */
export interface LaunchedChild {
  readonly pid: number
  kill(signal: 'SIGTERM' | 'SIGKILL'): void
  onExit(listener: (code: number | null) => void): void
}

/** 拉起子进程（生产 = `node:child_process`；测试 = 同进程假子进程）。 */
export type ChildLauncher = (request: LaunchRequest) => LaunchedChild

/** 监督者依赖。 */
export interface SupervisorDeps {
  readonly config: GatewayConfig
  readonly log: ImLogger
  readonly launcher?: ChildLauncher
  readonly reserve?: () => Promise<number>
  readonly handshake?: (port: number, timeoutMs: number) => Promise<{ csrf: string }>
  readonly client?: (input: { port: number; token: string; csrf: string }) => ChildClient
  readonly nowMs?: () => number
  readonly randomToken?: () => string
  /** SIGTERM → SIGKILL 的宽限期（毫秒；测试用小值）。 */
  readonly terminateGraceMs?: number
}

/** 对外的子进程句柄（`client` 与 `sessionKey` 是调用方唯一需要的两项）。 */
export interface ChildHandle {
  readonly sessionKey: string
  readonly port: number
  readonly client: ChildClient
}

/** 监督者。 */
export interface Supervisor {
  /** 确保 `(platform,userId)` 有就绪子进程（复用或新建）。 */
  ensure(platform: string, userId: string): Promise<ChildHandle>
  get(sessionKey: string): ChildRecord | undefined
  /** 累计 spawn 次数（T-IM-002：第二条消息不得再 spawn）。 */
  spawnCount(): number
  /** 当前存活记录数。 */
  children(): number
  /** 刷新活跃时刻（收到消息时调用）。 */
  touch(sessionKey: string): void
  /** 回收闲置子进程，返回回收数量。 */
  reapIdle(): number
  /** 主动停止（`auth` = 凭证失效需重建；`idle` = 闲置；`dispose` = 退出）。 */
  stop(sessionKey: string, reason: 'idle' | 'auth' | 'dispose'): Promise<void>
  /** 停全部（进程退出）。 */
  dispose(): Promise<void>
}

/** 重启窗口（10 分钟）与次数上限（3 次）。 */
const RESTART_WINDOW_MS = 10 * 60 * 1000
const RESTART_LIMIT = 3
/** 闲置扫描间隔（§2.11："每 60s 扫描"）。由 `main.ts` 定时调 `reapIdle()`。 */
export const REAP_INTERVAL_MS = 60_000
/** 子进程 env 里必须清洗的前缀（平台密钥与会话盐不进子进程）。 */
const SCRUBBED_ENV = /^(BAH_WECHAT_|BAH_IM_)/

/** 造一个随机的子进程 Web token（32 字节 hex；不落日志）。 */
function defaultRandomToken(): string {
  return randomBytes(24).toString('hex')
}

/** 从 `process.env` 里清洗掉平台密钥与会话盐。 */
function scrubbedEnv(): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (SCRUBBED_ENV.test(key)) continue
    result[key] = value
  }
  return result
}

/** 生产 launcher（`shell: false` + 逐参数数组，§2.11 硬约束）。 */
const defaultLauncher: ChildLauncher = (request) => {
  const [node, ...rest] = request.args
  if (node === undefined) throw new Error('im-gateway: spawn 参数为空')
  const child = spawn(node, rest, {
    env: { ...scrubbedEnv(), ...request.env },
    shell: false,
    stdio: 'inherit',
  })
  return {
    pid: child.pid ?? 0,
    kill: (signal) => child.kill(signal),
    onExit: (listener) => {
      child.once('exit', (code) => listener(code))
    },
  }
}

/**
 * 造一个监督者。
 *
 * @param deps 见 {@link SupervisorDeps}
 */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const config = deps.config
  const log = deps.log
  const launcher = deps.launcher ?? defaultLauncher
  const reserve = deps.reserve ?? ((): Promise<number> => reservePortWithRetry())
  const nowMs = deps.nowMs ?? ((): number => Date.now())
  const randomToken = deps.randomToken ?? defaultRandomToken
  const terminateGraceMs = deps.terminateGraceMs ?? 5_000
  const handshake =
    deps.handshake ?? ((port: number, timeoutMs: number) => awaitChildReady({ port, timeoutMs }))
  const makeClient =
    deps.client ?? ((input: { port: number; token: string; csrf: string }) => createChildClient(input))

  const registry: ChildRegistry = createChildRegistry()
  /** 正在启动中的用户（并发第二条消息等同一个 Promise，避免双 spawn）。 */
  const starting = new Map<string, Promise<ChildHandle>>()
  let spawns = 0
  let disposed = false

  /** 子进程参数（§2.11 的 spawn 形状；端口只经 overlay 传入，不进 argv）。 */
  const argsFor = (sessionKey: string, overlay: string, jsonl: string): readonly string[] => {
    const entry = join(config.root, config.childEntry)
    const loader = config.childLoader === 'tsx' ? ['--import', 'tsx'] : []
    return [
      config.childNode,
      ...loader,
      entry,
      '--profile',
      config.profile,
      '--session',
      sessionKey,
      '--patch',
      overlay,
      '--jsonl',
      jsonl,
      // CLI 只有带 `--serve` 才常驻；缺它会在 boot 期要求 `--prompt`（真机部署才发现，
      // 施工单 §2.11 的 spawn 形状漏写了这一项）
      '--serve',
    ]
  }

  const stop = async (sessionKey: string, reason: 'idle' | 'auth' | 'dispose'): Promise<void> => {
    const record = registry.get(sessionKey)
    if (record === undefined) return
    registry.delete(sessionKey)
    record.status = 'disabled'
    record.kill?.('SIGTERM')
    // 宽限期后 SIGKILL：不等待会让"停不掉的子进程"在退出时把网关一起挂住
    const timer = setTimeout(() => {
      record.kill?.('SIGKILL')
    }, terminateGraceMs)
    timer.unref()
    if (reason !== 'dispose') {
      log.info('im-child-reap', { sessionKey, reason, pid: record.pid })
    }
  }

  const terminateAll = async (): Promise<void> => {
    for (const record of registry.values()) {
      registry.delete(record.sessionKey)
      record.kill?.('SIGKILL')
    }
  }

  /**
   * 准备子进程的 `--jsonl` 根，并归档上一次的会话目录。
   *
   * WHY：宿主 `core:persistence` 对同一 `sessionId` 是**一次 create 排他**
   * （`jsonl: 会话已存在，拒绝覆写`）。同一 sessionKey 重启时若不归档，
   * 子进程的每个 `session/event` 都会失败（真机部署实测：11 条 error 后仍能对话，
   * 但会话不落盘）。归档保留旧文件（审计可查），新进程从空会话开始——
   * 跨进程上下文延续需要宿主持久化插件支持 append/open，已登记为边界。
   */
  const prepareJsonlRoot = (sessionKey: string): string => {
    const base = join(config.jsonlBase, sessionKey)
    mkdirSync(base, { recursive: true })
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const sessionDir = join(base, entry.name, sessionKey)
      if (!existsSync(join(sessionDir, 'session.jsonl'))) continue
      renameSync(sessionDir, `${sessionDir}-prev-${String(nowMs())}`)
    }
    return base
  }

  const launch = async (
    platform: string,
    userId: string,
    sessionKey: string,
    restarts: number,
    firstStartAt: number,
  ): Promise<ChildHandle> => {
    const port = await reserve()
    const overlay = await writeOverlay(config.root, sessionKey, renderOverlay({ port }))
    const jsonl = prepareJsonlRoot(sessionKey)
    const token = randomToken()
    const started = launcher({
      port,
      args: argsFor(sessionKey, overlay, jsonl),
      env: { BAH_WEB_TOKEN: token },
    })
    spawns += 1

    const record: ChildRecord = {
      platform,
      userId,
      sessionKey,
      pid: started.pid,
      port,
      token,
      csrf: '',
      lastSeen: nowMs(),
      restarts,
      firstStartAt,
      status: 'starting',
      kill: started.kill,
    }
    registry.set(record)

    let ready
    try {
      ready = await handshake(port, config.childTimeoutMs)
    } catch (error) {
      registry.delete(sessionKey)
      started.kill('SIGKILL')
      log.warn('im-child-exit', { sessionKey, reason: 'handshake-failed', pid: started.pid })
      throw error instanceof BahError
        ? error
        : new BahError('im-child-start-failed', `im: 子进程启动失败（${String(error)}）`, { sessionKey })
    }

    record.csrf = ready.csrf
    record.client = makeClient({ port, token, csrf: ready.csrf })
    record.status = 'ready'
    log.info('im-child-start', { sessionKey, pid: started.pid, port })
    log.info('im-child-ready', { sessionKey, pid: started.pid, port })

    started.onExit((code) => {
      const current = registry.get(sessionKey)
      if (current === undefined || current.status === 'disabled') return
      // 主动 stop 已把记录删掉；走不到这里。剩下的都是非预期退出。
      log.warn('im-child-exit', { sessionKey, pid: current.pid, code })
      registry.delete(sessionKey)
      current.status = 'disabled'
      const withinWindow = nowMs() - current.firstStartAt <= RESTART_WINDOW_MS
      if (disposed || !withinWindow || current.restarts >= RESTART_LIMIT - 1) {
        log.warn('im-child-exit', { sessionKey, reason: 'restart-exhausted' })
        return
      }
      void launch(platform, userId, sessionKey, current.restarts + 1, current.firstStartAt).catch(
        (error: unknown) => {
          log.warn('im-child-exit', {
            sessionKey,
            reason: 'restart-failed',
            detail: error instanceof Error ? error.message : 'unknown',
          })
        },
      )
    })

    return { sessionKey, port, client: record.client }
  }

  const ensure = async (platform: string, userId: string): Promise<ChildHandle> => {
    if (disposed) throw new BahError('im-gateway-disposed', 'im: 网关正在退出，不再接受消息')
    const sessionKey = deriveImSessionId(platform, userId, config.sessionSalt)
    const existing = registry.get(sessionKey)
    if (existing !== undefined && existing.status === 'ready' && existing.client !== undefined) {
      existing.lastSeen = nowMs()
      return { sessionKey, port: existing.port, client: existing.client }
    }

    const inflight = starting.get(sessionKey)
    if (inflight !== undefined) return inflight

    // 上限：先回收最久闲置；回收不出空间才拒绝（不静默排队）。
    // 必须把 `starting` 也算进去：两个并发 ensure 都只看 registry.size() 会同时通过
    // （记录要等 launch 进入 handshake 才落地），也就是 TOCTOU。
    if (registry.size() + starting.size >= config.maxChildren) {
      const idle = registry
        .values()
        .filter((record) => nowMs() - record.lastSeen > config.idleTtlMs)
        .sort((a, b) => a.lastSeen - b.lastSeen)
      const victim = idle[0]
      if (victim === undefined) {
        throw new BahError('im-children-full', 'im: 同时在线会话已达上限（请稍后重试）')
      }
      await stop(victim.sessionKey, 'idle')
    }

    const task = launch(platform, userId, sessionKey, 0, nowMs()).finally(() => {
      starting.delete(sessionKey)
    })
    starting.set(sessionKey, task)
    return task
  }

  const reapIdle = (): number => {
    const ttl = config.idleTtlMs
    let reaped = 0
    for (const record of registry.values()) {
      if (record.status !== 'ready') continue
      if (nowMs() - record.lastSeen <= ttl) continue
      void stop(record.sessionKey, 'idle')
      reaped += 1
    }
    return reaped
  }

  return {
    ensure,
    get: (sessionKey) => registry.get(sessionKey),
    spawnCount: () => spawns,
    children: () => registry.size(),

    touch(sessionKey: string): void {
      const record = registry.get(sessionKey)
      if (record !== undefined) record.lastSeen = nowMs()
    },

    reapIdle,

    stop,

    async dispose(): Promise<void> {
      disposed = true
      await terminateAll()
    },
  }
}
