/**
 * base bundle · `bank:saga-audit`：审计链接线（SA-07 §7.2 / SA-11）。
 *
 * 时钟由 `bank:saga` 提供，本插件合法地 `inject` 等待它；链实现归 `@bah/persistence/chain`，
 * host 只做服务键桥接（persistence 不反向 import `@bah/saga`）。
 *
 * 链记录根目录：`<cwd>/sessions`（与 base bundle 的 `sessions/saga.sqlite` 同工作区）。
 */

import { resolve } from 'node:path'

import { createSagaAudit, parseAuditSettings } from '@bah/persistence'
import { SAGA_AUDIT, SAGA_CLOCK } from '@bah/saga'

import type { AuditSettings } from '@bah/persistence'

import type { HostPlugin } from '../../plugin-manager/index.ts'

export const sagaAuditPlugin: HostPlugin<AuditSettings> = {
  id: 'bank:saga-audit',

  plugin: {
    name: 'bank:saga-audit',
    inject: [SAGA_CLOCK.id],
    apply(ctx, settings) {
      const clock = ctx.get(SAGA_CLOCK)
      ctx.provide(
        SAGA_AUDIT,
        createSagaAudit({
          ctx,
          now: () => clock.now(),
          keyVersion: settings.keyVersion,
          signedTypes: settings.signedTypes,
          signingKeyPath: settings.signingKeyPath,
          anchorTargets: settings.anchorTargets,
          rootDir: resolve(process.cwd(), 'sessions'),
        }),
      )
    },
  },

  validate: parseAuditSettings,
}
