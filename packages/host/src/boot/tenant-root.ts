/**
 * 租户根布局公式（**唯一实现**）。
 *
 * 会话日志、审计链、记忆库、HALT 状态、boot 的会话恢复路径都从这里派生。
 * 做成独立模块的理由：`boot.ts` 需要它（启动前恢复会话），而 `core:persistence`
 * 也需要它；让两边互相 import 会成环（persistence 在模块求值期读 `RUN_SERVICE.id`）。
 *
 * AR-01 的教训是"一处漏拼不会报错，只会让审计跑到租户外"——所以这里必须是
 * 唯一公式，而不是每个调用方自己 `join`。
 */

import { join } from 'node:path'

import { BahError, isTenantId } from '@bah/util'

import type { TenantId } from '@bah/util'

/**
 * 租户根 = 部署根 + 租户段。
 *
 * @param deploymentRoot 部署根（`--jsonl` 覆盖值或 `core:persistence.root`）
 * @param tenantId 启动期确定的租户
 * @throws `BahError('tenant-id-invalid')` 不是合法租户 ID
 */
export function tenantRootOf(deploymentRoot: string, tenantId: TenantId): string {
  const id = String(tenantId)
  // 用**租户字符集**而不是路径白名单：路径白名单会放过 `undefined` / `Demo` / `demo_1`
  // 这类"路径安全但不是租户"的值（复审 AR-03：JS 调用方漏传 tenantId 时会落成
  // `<root>/undefined`，既没有报错也没有意义）。`asTenantId` 是无校验断言，这里是兜底。
  if (!isTenantId(id)) {
    throw new BahError(
      'tenant-id-invalid',
      `租户根解析失败：${JSON.stringify(id)} 不是合法租户 ID（TenantId 必须经 parseTenantId 产出）`,
      { tenantId: id, deploymentRoot },
    )
  }
  return join(deploymentRoot, id)
}
