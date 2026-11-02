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
import { SESSION_FILES } from './persistence.ts'

export const sagaAuditPlugin: HostPlugin<AuditSettings> = {
  id: 'bank:saga-audit',

  plugin: {
    name: 'bank:saga-audit',
    inject: [SAGA_CLOCK.id, SESSION_FILES.id],
    apply(ctx, settings) {
      const clock = ctx.get(SAGA_CLOCK)
      const files = ctx.get(SESSION_FILES)
      // 与 persistence 的生效会话根同源：部署改 root / 加 --jsonl 时链路不分裂。
      // `files.root` 已经含租户段（01 TA-12），所以编排链也落在租户目录下。
      const chainRoot = resolve(files.root)
      ctx.provide(
        SAGA_AUDIT,
        createSagaAudit({
          ctx,
          now: () => clock.now(),
          keyVersion: settings.keyVersion,
          signedTypes: settings.signedTypes,
          signingKeyPath: settings.signingKeyPath,
          anchorTargets: settings.anchorTargets,
          rootDir: chainRoot,
          // 编排链的每条记录也带租户（与 audit:decisions 同一口径）
          tenant: String(files.tenantId),
        }),
      )
    },
  },

  validate: parseAuditSettings,
}
