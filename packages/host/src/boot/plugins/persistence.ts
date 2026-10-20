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
import type { SessionHandle, JsonlOptions } from '@bah/persistence'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { readBoolean, readString, rejectUnknownKeys } from '../config.ts'

/** 会话文件定位服务（宿主打印"落盘在哪"用，避免宿主自己拼路径）。 */
export interface SessionFiles {
  /** 某会话的 JSONL 文件路径（会话尚未创建时返回**将要**写入的路径）。 */
  fileOf(sessionId: SessionId): string
}

/** 服务键：跨包只认这个。 */
export const SESSION_FILES = defineService<SessionFiles>('bah:session-files')

/** `core:persistence` 的配置。 */
export interface PersistenceSettings {
  /** 会话根目录（每个会话一个子目录）。 */
  readonly root: string
  /** 每次 append 后是否 `fsync`（默认 true；演示/测试可关）。 */
  readonly fsync: boolean
}

/** 默认会话根目录（相对进程 cwd）。 */
const DEFAULT_ROOT = 'sessions'

export const persistencePlugin: HostPlugin<PersistenceSettings> = {
  id: 'core:persistence',

  plugin: {
    name: 'core:persistence',
    inject: [RUN_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const root = run.jsonlDir ?? config.root
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

      ctx.provide<SessionFiles>(SESSION_FILES, { fileOf: (sessionId) => join(dirOf(sessionId), 'session.jsonl') })

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
