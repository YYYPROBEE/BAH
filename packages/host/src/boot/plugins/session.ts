/**
 * base bundle · `core:session`：会话日志。
 *
 * 会话 ID 与时钟来自 **boot injection**（`bah:run`），不是配置：
 * 一次运行的会话身份是"输入"，写进 patch 文件反而会让两次运行撞同一个会话。
 *
 * 本行没有可调项：`formatVersion` 是**格式事实**，由 JSONL 后端与 reader 版本策略共同拥有
 * ，不随部署变化，因此不该出现在配置里。
 */

import { provideSession } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { rejectUnknownKeys } from '../config.ts'

/** `core:session` 的配置（无字段；写任何键都是配置错误）。 */
export type SessionSettings = Record<string, never>

export const sessionPlugin: HostPlugin<SessionSettings> = {
  id: 'core:session',

  plugin: {
    name: 'core:session',
    inject: [RUN_SERVICE.id],
    apply(ctx) {
      const run = ctx.get(RUN_SERVICE)
      provideSession(ctx, {
        sessionId: run.sessionId,
        now: run.now,
        ...(run.restoreEvents === undefined ? {} : { restore: run.restoreEvents }),
      })
    },
  },

  validate(config) {
    rejectUnknownKeys(config, [], 'core:session')
    return {}
  },
}
