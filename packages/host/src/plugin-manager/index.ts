/**
 * 插件管理器（施工单 06 §5 第 3 步）。
 *
 * 职责只有"把行变成可安装的插件"这一段：
 * 1. 按 `use` 在**依赖清单**（catalog）里找插件实现，找不到即抛；
 * 2. 逐行校验配置并补默认值（fail-loud，`bah-boot: ` 前缀）；
 * 3. 拒绝重复的行 id 与重复挂载同一插件（后者会让"谁在写这个服务"不可解释）。
 *
 * `inject` 依赖排序不在这里：内核的 `installAll` 已经按 `inject` 逐轮激活并在成环时打印环路径
 * （施工单 02 §5）。再排一次序会让"启动顺序"有两个真相。
 */

import { describeThrown } from '@bah/core'

import type { PluginV2 } from '@bah/core'

import { BOOT_PREFIX, bootError } from '../boot/config.ts'
import type { ResolvedRow } from '../boot/profile-plugins.ts'

/**
 * 依赖清单里的一项：插件实现 + 它的配置校验器。
 *
 * `validate` 拿到的永远是对象（`{}` 表示这一行没写 config），返回值是该插件的**最终配置**
 * （默认值已补齐）——插件的 `apply` 不再二次校验，避免"校验有两份"。
 */
export interface HostPlugin<P = unknown> {
  /** 依赖清单里的名字（patch 行的 `use` 指向它）。 */
  readonly id: string
  /** 内核插件实现。 */
  readonly plugin: PluginV2<P>
  /**
   * 校验并补默认值。
   *
   * @throws `BahError`（`bah-boot: ` 前缀）配置非法
   */
  readonly validate: (config: Readonly<Record<string, unknown>>) => P
}

/** 依赖清单：`use` → 插件项。 */
export type PluginCatalog = Readonly<Record<string, HostPlugin<any>>>

/** 校验通过、可以 `ctx.use()` 的一行。 */
export interface ValidatedRow extends ResolvedRow {
  readonly plugin: PluginV2<any>
  readonly settings: unknown
}

/** 插件管理器。 */
export class PluginManager {
  constructor(private readonly catalog: PluginCatalog) {}

  /** 依赖清单里的全部插件 id（顺序 = 声明顺序，报错与 dump 用）。 */
  ids(): readonly string[] {
    return Object.keys(this.catalog)
  }

  /** 依赖清单里是否有该插件。 */
  has(use: string): boolean {
    return Object.hasOwn(this.catalog, use)
  }

  /**
   * 按 `use` 取插件。
   *
   * @throws `BahError('unknown-plugin')` 依赖清单里没有这个插件
   */
  get(use: string): HostPlugin<any> {
    const found = this.catalog[use]
    if (found === undefined) {
      throw bootError(
        'unknown-plugin',
        `依赖清单里没有插件 ${use}（已声明：${this.ids().join('、') || '无'}）`,
        { use, catalog: this.ids() },
      )
    }
    return found
  }

  /**
   * 校验整组行：id 唯一、插件已声明、配置合法。
   *
   * @throws `BahError('duplicate-row')` 行 id 重复
   * @throws `BahError('duplicate-plugin')` 同一插件被挂载两次
   * @throws `BahError('unknown-plugin')` 引用了依赖清单外的插件
   * @throws `BahError` 配置非法（原样透传校验器抛出的 `bah-boot: ` 错误）
   */
  validate(rows: readonly ResolvedRow[]): ValidatedRow[] {
    const seenIds = new Set<string>()
    const seenPlugins = new Set<string>()
    const validated: ValidatedRow[] = []

    for (const row of rows) {
      if (seenIds.has(row.id)) {
        throw bootError('duplicate-row', `行 id ${row.id} 重复（patch 靠 id 定位，必须唯一）`, {
          id: row.id,
        })
      }
      seenIds.add(row.id)

      if (seenPlugins.has(row.use)) {
        throw bootError(
          'duplicate-plugin',
          `插件 ${row.use} 被挂载了两次（行 ${row.id}）；同一插件只能挂一次`,
          { id: row.id, use: row.use },
        )
      }
      seenPlugins.add(row.use)

      const host = this.get(row.use)
      validated.push({ ...row, plugin: host.plugin, settings: this.validateConfig(row, host) })
    }

    return validated
  }

  /** 单个插件的配置校验：`bah-boot: ` 错误原样上抛，其余包一层可读理由。 */
  private validateConfig(row: ResolvedRow, host: HostPlugin<any>): unknown {
    try {
      return host.validate(row.config)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(BOOT_PREFIX)) throw error
      throw bootError(
        'invalid-config',
        `插件 ${row.id} 的配置非法：${describeThrown(error)}`,
        { id: row.id, use: row.use, cause: error },
      )
    }
  }
}
