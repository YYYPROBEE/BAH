/**
 * boot：把"解析好的行"变成"跑起来的应用"（施工单 06 §4 / §5 第 3 步）。
 *
 * 顺序是刻意的：
 * 1. **先合并、再校验、最后才建 ctx** —— 配置错误必须在任何副作用（服务注册、文件写入）之前抛出；
 * 2. 建 ctx → 注入运行时上下文（`bah:run`）→ 逐行 `use` → `start`（`inject` 在这里按依赖激活）；
 * 3. 启动失败一律 dispose 回滚，并把错误统一成 `bah-boot: ` 前缀。
 *
 * 本函数**不碰文件系统**：patch 文件的读取在 CLI 侧（`cli/src/profile.ts`），
 * HMR 的重载也把"重新读出来的层"传进来。这样 boot 的每条分支都能在内存里测。
 */

import { createContext, defineService, describeThrown } from '@bah/core'
import { BahError } from '@bah/util'

import type { BahContext, SessionId, TicketId } from '@bah/core'

import { PluginManager } from '../plugin-manager/index.ts'
import type { PluginCatalog, ValidatedRow } from '../plugin-manager/index.ts'

import { BOOT_PREFIX, bootError } from './config.ts'
import {
  diffRows,
  mergeLayers,
  sameStructure,
  type Bundle,
  type ConfigLayer,
} from './profile-plugins.ts'

/**
 * 一次运行的输入（boot injection，不是配置）。
 *
 * 为什么这些值不进 patch 文件：会话 ID / 输出目录 / 时钟是**每次进程启动的输入**，
 * 写进 YAML 会让两次运行撞同一个会话，也让测试无法注入确定性时钟。
 */
export interface RunContext {
  /** 本次运行的会话 ID。 */
  readonly sessionId: SessionId
  /** 会话目录覆盖（`--jsonl`）；缺省时用 `core:persistence` 的 `root`。 */
  readonly jsonlDir?: string
  /** 时钟（落账时间戳与落盘 header 都用它）。 */
  readonly now: () => number
  /**
   * 沙箱审计时钟（缺省跟随 `now`）。
   *
   * 快照/回放可注入独立计数钟，让 `sandbox/done` 的 `elapsedMs` 与会话事件时间戳解耦。
   */
  readonly sandboxNow?: () => number
  /**
   * 票据 ID 生成器（验收/快照面注入；生产不传）。
   *
   * 不传时管线用 `ticket:<randomUUID>`——票号会出现在审批 URL 与审计里，必须不可预测。
   * 快照回放注入按 `callId` 派生的确定性 ID，才能断言"两次回放逐条全等"。
   */
  readonly mintTicketId?: (callId: string) => TicketId
  /**
   * 非致命告警出口（插件用）。
   *
   * 缺省由 `BootOptions.warn` 兜底（CLI 注入 `io.err`）；两者都没传时不告警。
   * 典型场景：`required: false` 的外部依赖健康检查失败——启动继续，但必须留痕。
   */
  readonly warn?: (message: string) => void
  /**
   * 是否允许启动期做外部探活（缺省 `true`）。
   *
   * `--dump-config` 是"只看不跑"，必须零网络：CLI 传 `false` 后 `bank:knowledge`
   * 跳过 `/healthz`，也不再产生"sidecar 缺席"告警。真实启动（`--serve` / `--prompt`）不传，
   * 行为与改前一致。
   */
  readonly probe?: boolean
}

/** 服务键：`bah:run`（插件以 `inject: ['bah:run']` 声明依赖）。 */
export const RUN_SERVICE = defineService<RunContext>('bah:run')

/** profile 的摘要（dump 与 HMR 只关心这些）。 */
export interface ProfileSummary {
  /** profile 名（`headless` / `web` / …）。 */
  readonly name: string
  /** 叠加的 bundle 名（按声明顺序）。 */
  readonly bundles: readonly string[]
  /** 是否开启 config-only HMR（base 开，headless/ sdk 关）。 */
  readonly hmr: boolean
}

/** boot 选项。 */
export interface BootOptions {
  readonly profile: ProfileSummary
  /** 已加载的 bundle（顺序 = profile 声明顺序）。 */
  readonly bundles: readonly Bundle[]
  /** 已解析的四层 patch 中除 bundle 之外的三层（profile patch → home patch → overlay）。 */
  readonly layers: readonly ConfigLayer[]
  /** 依赖清单（插件实现）。 */
  readonly catalog: PluginCatalog
  readonly run: RunContext
  /** 非致命提示出口（行增删需重启等）。 */
  readonly warn?: (message: string) => void
}

/** 一次 config 重载的结果。 */
export interface ReloadResult {
  /** 配置真的变了的行 id（空数组 = 无变化或需重启）。 */
  readonly changed: readonly string[]
  /** 结构（行集合 / use 指向）变了：需要重启进程，本次不做任何改动。 */
  readonly requiresRestart: boolean
  /** 重载后的行快照。 */
  readonly rows: readonly ValidatedRow[]
}

/** 跑起来的应用。 */
export interface BootedApp {
  readonly ctx: BahContext
  readonly profile: ProfileSummary
  readonly run: RunContext
  /** 当前生效的行（HMR 后会换成新快照）。 */
  rows(): readonly ValidatedRow[]
  /**
   * 用新的层内容重载配置。
   *
   * @throws `BahError` 新层配置非法（调用方应保持旧配置并告警）
   */
  reload(layers: readonly ConfigLayer[]): ReloadResult
  /** 逆序回滚全部贡献（`reason` 透传，审计用）。 */
  dispose(reason?: string): Promise<void>
}

/**
 * 启动一个 profile。
 *
 * @throws `BahError`（`bah-boot: ` 前缀）合并 / 校验 / 启动任一环节失败
 */
export async function boot(options: BootOptions): Promise<BootedApp> {
  const manager = new PluginManager(options.catalog)
  let rows = manager.validate(mergeLayers(options.bundles, options.layers))

  const ctx = createContext()
  // 插件只能按键取 `bah:run`，所以告警出口必须随 run 上下文下发：
  // 调用方（CLI）传的是 BootOptions.warn（→ io.err），插件侧不必再认识 CLI。
  const notify = options.warn ?? options.run.warn
  try {
    ctx.provide(RUN_SERVICE, notify === undefined ? options.run : { ...options.run, warn: notify })
    for (const row of rows) await ctx.useErased(row.plugin, row.settings)
    await ctx.start()
  } catch (error) {
    await ctx.dispose('boot-failed')
    throw asBootError(error)
  }

  return {
    ctx,
    profile: options.profile,
    run: options.run,
    rows: () => rows,
    reload(layers) {
      const next = manager.validate(mergeLayers(options.bundles, layers))
      if (!sameStructure(rows, next)) {
        notify?.('patch 里有插件行的增删（或 use 指向变了）；config-only HMR 不处理这些，需要重启进程')
        return { changed: [], requiresRestart: true, rows }
      }
      const changed = diffRows(rows, next)
      rows = next
      if (changed.length > 0) {
        ctx.events.emit('bah/config-reload', { profile: options.profile.name, changed })
      }
      return { changed, requiresRestart: false, rows }
    },
    async dispose(reason = 'dispose') {
      await ctx.dispose(reason)
    },
  }
}

/** 把启动期错误统一成 `bah-boot: `（已带前缀的原样上抛，保留精确理由码）。 */
function asBootError(error: unknown): BahError {
  if (error instanceof BahError && error.message.startsWith(BOOT_PREFIX)) return error
  return bootError('boot-failed', `启动失败：${describeThrown(error)}`, { cause: error })
}
