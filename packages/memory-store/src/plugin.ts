/**
 * 插件形状（为 M4 的 host 挂接预留）。
 *
 * **刻意不 import `@bah/host`**：挂接方向是 `host → memory-store`，反向 import 会成环。
 * 这里用结构类型复刻 `HostPlugin` 的最小形状——字段名与语义必须与 host 侧一致，
 * 但类型来源不同。M4 真正注册时，`toAnyHostPlugin()` 的结构判据（`id` / `plugin` /
 * `validate` 三件套）会直接吃下这个对象，不需要改这里。
 *
 * 本轮**只交付形状，不注册**：写进 boot 注册表要跑全量快照（AGENTS.md 第 3 条），
 * 那是 M4 的活，现在做等于提前碰主循环红线。
 */

import { createMemoryLayer } from './layer.ts'

import type { MemoryLayer } from './layer.ts'

/** 与 `bah.yml` 的 profile 行配置对应。 */
export interface MemoryStoreSettings {
  /** sqlite 文件路径；相对 cwd 由调用方解析。 */
  readonly dbPath: string
  /** 权限矩阵上限；省略 = S2（个人客户）。 */
  readonly sensitivityCeiling?: number
}

/**
 * 插件上下文的最小结构面。
 *
 * 只声明用得到的两个方法：`effect()` 是唯一必需项（注册即可逆），`provide()` 留到
 * M4 真正注册服务键时再加——现在加上却没人调用，就是一段无覆盖的死代码。
 */
export interface PluginContextLike {
  effect(dispose: () => void): void
}

export interface MemoryStorePluginShape {
  readonly id: string
  readonly plugin: {
    readonly name: string
    readonly apply: (ctx: PluginContextLike, config: MemoryStoreSettings) => void
  }
  readonly validate: (config: Readonly<Record<string, unknown>>) => MemoryStoreSettings
}

export const MEMORY_STORE_PLUGIN_ID = 'bah:memory-store'

/** 本插件认的配置键。未知键一律拒绝——静默忽略会让"我配了却没生效"变成幽灵故障。 */
const KNOWN_KEYS: ReadonlySet<string> = new Set(['dbPath', 'sensitivityCeiling'])

function rejectUnknownKeys(config: Readonly<Record<string, unknown>>): void {
  const unknown = Object.keys(config).filter((key) => !KNOWN_KEYS.has(key))
  if (unknown.length > 0) {
    throw new Error(
      `bah-memory: invalid config for ${MEMORY_STORE_PLUGIN_ID}: 未知配置键 ${unknown.join(', ')}`,
    )
  }
}

function readDbPath(config: Readonly<Record<string, unknown>>): string {
  const raw = config['dbPath']
  if (typeof raw !== 'string' || raw.length === 0) {
    // fail-loud：默认值会让两个部署悄悄共用一个库，是最难查的那类事故。
    throw new Error(`bah-memory: invalid config for ${MEMORY_STORE_PLUGIN_ID}: dbPath 必须是非空字符串`)
  }
  return raw
}

export const memoryStorePlugin: MemoryStorePluginShape = {
  id: MEMORY_STORE_PLUGIN_ID,

  plugin: {
    name: MEMORY_STORE_PLUGIN_ID,
    apply(ctx, config) {
      const layer: MemoryLayer = createMemoryLayer({
        dbPath: config.dbPath,
        ...(config.sensitivityCeiling === undefined
          ? {}
          : { sensitivityCeiling: config.sensitivityCeiling }),
      })
      // 注册即可逆：卸载插件即关闭连接，不留悬挂文件句柄。
      ctx.effect(() => {
        layer.close()
      })
    },
  },

  validate(config) {
    rejectUnknownKeys(config)
    const dbPath = readDbPath(config)
    const ceiling = config['sensitivityCeiling']
    if (ceiling !== undefined && (typeof ceiling !== 'number' || ceiling < 0 || ceiling > 3)) {
      throw new Error(
        `bah-memory: invalid config for ${MEMORY_STORE_PLUGIN_ID}: sensitivityCeiling 必须是 0–3 的数字`,
      )
    }
    return {
      dbPath,
      ...(ceiling === undefined ? {} : { sensitivityCeiling: ceiling }),
    }
  },
}
