/**
 * base bundle · `core:persistence`：JSONL 落盘（施工单 03 §1.5）。
 *
 * 挂点是 `session/event`（`emit`，append 之后同步广播）：不包裹 `SessionApi.append`，
 * 也不认识主循环——"日志写在哪里"和"日志怎么产生"因此各自可替换。
 *
 * 懒创建：第一条事件到达时才建会话目录与 header，这样 `--dump-config` 之类"只看不跑"的
 * 命令不会留下空会话文件。`create()` 对已存在的会话是排他失败（不覆写）。
 */

import { join } from 'node:path'

import { defineService } from '@bah/core'
import { JsonlPersistence } from '@bah/persistence'
import { assertSafePathSegment } from '@bah/util'

import type { SessionEvent, SessionId } from '@bah/core'
import type { TenantId } from '@bah/util'
import type { SessionHandle, JsonlOptions } from '@bah/persistence'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, readString, rejectUnknownKeys } from '../config.ts'

/**
 * 会话文件定位服务（宿主打印"落盘在哪"用，避免宿主自己拼路径）。
 *
 * ## 租户化之后（01 TA-12）`root` 的语义
 *
 * `root` 是**租户根** `<config.root>/<tenantId>`，不是部署根。所有拿 `root` 的调用方
 * 直接得到"已经拼好租户的目录"，**不要再自己拼一次**——那正是 AR-01 的形态
 * （一处漏拼 = 审计在租户外，而且不会报错）。
 *
 * 唯一的例外是 `baseRoot`：`bank:saga-store` 的 sqlite 按 01 §5 的裁剪决策
 * **不按租户分库**（单库单进程 + `verify-saga-wiring` 以固定路径为基线），
 * 所以它显式取 `baseRoot`。**别在别处用 `baseRoot`**。
 */
export interface SessionFiles {
  /** 本租户的根目录：`<config.root>/<tenantId>`（会话目录 / 审计链 / 停机状态都在它下面）。 */
  readonly root: string
  /** 部署根（未拼租户）。只给"按设计单文件共享"的 saga 库用，见上。 */
  readonly baseRoot: string
  /** 本进程服务的租户（与 `RunContext.tenantId` 同源）。 */
  readonly tenantId: TenantId
  /** 某会话的 JSONL 文件路径（会话尚未创建时返回**将要**写入的路径）。 */
  fileOf(sessionId: SessionId): string
}

/** 服务键：跨包只认这个。 */
export const SESSION_FILES = defineService<SessionFiles>('bah:session-files')

/** `core:persistence` 的配置。 */
export interface PersistenceSettings {
  /** 部署根（每个租户一段、每个会话再一段；见 `tenantRootOf`）。 */
  readonly root: string
  /** 每次 append 后是否 `fsync`（默认 true；演示/测试可关）。 */
  readonly fsync: boolean
}

/**
 * 默认会话根目录（相对进程 cwd）。
 *
 * 导出给 `safety:sentry` 用：HALT 停机状态与会话日志同根（租户根下的 `halt.json`），
 * 这样"停机证据跟着部署目录走"，而不是跟着进程或某个会话 ID 走。
 */
export const DEFAULT_ROOT = 'sessions'

/**
 * 租户根 = 部署根 + 租户段（**布局公式的唯一实现**）。
 *
 * 会话日志、审计链、记忆库、HALT 状态都从这里派生。之所以做成函数、而不是让每个
 * 调用方自己 `join`：AR-01 的教训是"一处漏拼不会报错，只会让审计跑到租户外"。
 *
 * @param baseRoot 部署根（`--jsonl` 覆盖值或 `core:persistence.root`）
 * @param tenantId 启动期确定的租户
 */
export function tenantRootOf(baseRoot: string, tenantId: TenantId): string {
  const id = String(tenantId)
  // 租户 ID 已过 `parseTenantId`（字符集 [a-z0-9-]）；这里再挡一道，
  // 因为 `asTenantId` 是无校验断言，而它下面紧跟的就是 mkdir -p
  assertSafePathSegment(id, 'tenantId')
  return join(baseRoot, id)
}

export const persistencePlugin: HostPlugin<PersistenceSettings> = {
  id: 'core:persistence',

  plugin: {
    name: 'core:persistence',
    inject: [RUN_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      // 部署根（`--jsonl` 优先）；租户根是它下面的一段，见 `tenantRootOf`
      const baseRoot = run.jsonlDir ?? config.root
      const root = tenantRootOf(baseRoot, run.tenantId)
      const backend = new JsonlPersistence({
        fsync: config.fsync,
        // 尾行截断是**可容忍**的损坏（半写），告警但继续；中间行损坏仍抛错
        warn: (message) => console.warn(message),
      } satisfies JsonlOptions)

      const dirOf = (sessionId: SessionId): string => {
        // 最后一道防线：会话 ID 来自 CLI / 恢复流程，拼路径前必须过白名单
        const id = String(sessionId)
        assertSafePathSegment(id, 'sessionId')
        return join(root, id)
      }
      const handles = new Map<string, SessionHandle>()

      // 会话关闭 / 插件 dispose 时释放常驻 fd 与内存索引
      ctx.effect(() => {
        for (const handle of handles.values()) handle.close?.()
        handles.clear()
      })

      ctx.provide<SessionFiles>(SESSION_FILES, {
        root,
        baseRoot,
        tenantId: run.tenantId,
        fileOf: (sessionId) => join(dirOf(sessionId), 'session.jsonl'),
      })

      ctx.events.on('session/event', (envelope) => {
        const key = String(envelope.session)
        let handle = handles.get(key)
        if (handle === undefined) {
          handle = backend.create(dirOf(envelope.session), envelope.session, {
            now: envelope.event.at,
          })
          handles.set(key, handle)
        }
        handle.append(envelope.event as SessionEvent)
      })
    },
  },

  validate(config) {
    rejectUnknownKeys(config, ['root', 'fsync'], 'core:persistence')
    const root = readString(config, 'root', 'core:persistence') ?? DEFAULT_ROOT
    const fsync = readBoolean(config, 'fsync', 'core:persistence', true)
    return { root, fsync }
  },
}
