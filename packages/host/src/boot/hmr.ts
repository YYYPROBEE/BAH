/**
 * config-only HMR。
 *
 * 能热重载的只有**配置**：改 patch 文件 → 重新读层 → 重新校验 → 应用 + 通知。
 * 插件**代码**、插件行的增删都不热重载（银行场景没有运行时自我修改的需求，
 * 收益低而风险高）——后者由 `boot.reload` 返回 `requiresRestart` 并打印提示。
 *
 * 实现取舍：用 `fs.watchFile`（轮询）而不是 `fs.watch`——Windows 上更稳，
 * 且 `persistent: false` 不会拖住进程退出。`watch` 可注入，测试不必依赖真实时序。
 */

import { unwatchFile, watchFile } from 'node:fs'

import { describeThrown } from '@bah/core'

import type { Stats } from 'node:fs'

import type { ProfileSummary, ReloadResult } from './boot.ts'

/** 轮询间隔（毫秒）：足够快，又不至于打满 CPU。 */
const FAST_INTERVAL_MS = 25

/** 一个监听句柄。 */
export interface WatchStop {
  stop(): void
}

/** 注入点：给某个文件挂"变了"的回调（默认实现走 `fs.watchFile`）。 */
export type WatchHandler = (file: string, listener: () => void) => WatchStop

/** `startConfigHmr` 的选项。 */
export interface ConfigHmrOptions {
  readonly profile: ProfileSummary
  /** 要监听的 patch 文件（已存在的那些；不存在的不监听）。 */
  readonly files: readonly string[]
  /** 一次重载动作：重新读层 → 校验 → 应用。抛错表示新配置非法（保持旧配置）。 */
  readonly reload: () => ReloadResult
  /** 非致命提示出口（校验失败、重载结果）。 */
  readonly warn?: (message: string) => void
  /** 注入 watcher（测试用）。 */
  readonly watch?: WatchHandler
}

/** 跑着的 config HMR。 */
export interface ConfigHmr {
  /** 正在监听的文件。 */
  readonly files: readonly string[]
  /** 手动触发一次重载（与文件变化走同一条路径）。 */
  reloadNow(): ReloadResult | undefined
  /** 停止全部监听（幂等）。 */
  stop(): void
}

/**
 * 启动 config HMR。
 *
 * @returns `undefined` = 该 profile 关闭了 HMR（headless / sdk）或没有可监听的文件；
 *   调用方据此决定是否打印"HMR 已开启"
 */
export function startConfigHmr(options: ConfigHmrOptions): ConfigHmr | undefined {
  if (!options.profile.hmr) return undefined
  if (options.files.length === 0) return undefined

  const watch = options.watch ?? defaultWatch
  const stops: WatchStop[] = []
  let stopped = false

  const reloadNow = (): ReloadResult | undefined => {
    if (stopped) return undefined
    try {
      return options.reload()
    } catch (error) {
      // 配置改坏了：**保持旧配置**继续跑，并把原因说清楚（不能静默吞错）
      options.warn?.(`配置重载失败，继续使用旧配置：${describeThrown(error)}`)
      return undefined
    }
  }

  for (const file of options.files) {
    stops.push(
      watch(file, () => {
        reloadNow()
      }),
    )
  }

  return {
    files: [...options.files],
    reloadNow,
    stop() {
      if (stopped) return
      stopped = true
      for (const handle of stops.reverse()) handle.stop()
    },
  }
}

/** 默认 watcher：`fs.watchFile` 轮询（mtime 未变则忽略重复事件）。 */
function defaultWatch(file: string, listener: () => void): WatchStop {
  let last = 0
  const watcher = (current: Stats): void => {
    if (current.mtimeMs === last) return
    last = current.mtimeMs
    listener()
  }
  watchFile(file, { interval: FAST_INTERVAL_MS, persistent: false }, watcher)
  return {
    stop() {
      unwatchFile(file, watcher)
    },
  }
}
