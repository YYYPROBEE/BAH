/**
 * 测试夹具：`RunContext` 工厂（租户与鉴权 01 · TA-11 / 复审 AR-06）。
 *
 * ## 为什么需要它
 *
 * `RunContext.tenantId` 是**必填**字段（租户必须在启动期确定、运行期不可变），
 * 所以 20+ 处测试夹具与 7 个快照场景（snapshots 下每个场景的 scenario.ts）都会编译失败。
 * 逐个手加 `tenantId: 'demo'` 也能过编译，但那样"换一个租户演"要改二十处，
 * 且没人能保证改全——这是"**可以过门禁但做错了**"的典型（AR-06）。
 *
 * 工厂的默认值只有两个来源：`DEFAULT_TENANT_ID`（`@bah/util`）与这里的时间常量。
 *
 * ## 为什么放在 `@bah/host` 而不是 `@bah/test-support`
 *
 * 计划书把工厂写在 `packages/test-support/`。实际不能那样放：`RunContext` 的定义在
 * host，test-support 若 `import type` 反向引 host，`tsc -b` 的 project references 会成环
 * （host → test-support 是 devDependencies 边，供 host 自己的测试用）。
 * 与造出来的类型放在同一个包，也避免 `RunContext` 出现第二份结构定义。
 *
 * 偏差登记见 `docs/evidence/2026-10-28-tenant-auth/01-t1.md` §4（D-3）。
 */

import type { SessionId } from '@bah/core'
import { DEFAULT_TENANT_ID } from '@bah/util'

import type { RunContext } from './boot.ts'
import { createWakeMarkStore } from './wake-marks.ts'

/**
 * 固定钟（2023-11-14T22:13:20Z）。
 *
 * 只保证"同一次运行内稳定"，不保证与真实时间接近——要断言具体时刻的用例
 * 自己传 `now`。**不用 `Date.now()`**：那会让回放与快照抖动（G7）。
 */
const FIXED_NOW = 1_700_000_000_000

/** 缺省会话 ID（与既有夹具的 `s-test` 同口径）。 */
const TEST_SESSION_ID = 's-test' as SessionId

/**
 * 造一个测试用 `RunContext`。
 *
 * @param partial 覆盖字段（`sessionId` / `now` / `jsonlDir` / `probe` …）
 *
 * 用途示例：
 * ```ts
 * const run = testRunContext({ sessionId: asSessionId('s-boot') })
 * const acme = testRunContext({ tenantId: parseTenantId('acme') })
 * ```
 */
export function testRunContext(partial: Partial<RunContext> = {}): RunContext {
  return {
    sessionId: partial.sessionId ?? TEST_SESSION_ID,
    // 租户缺省 demo：与 `--tenant` 的缺省一致，但**不**允许调用方省略后落回字符串字面量
    tenantId: partial.tenantId ?? DEFAULT_TENANT_ID,
    now: partial.now ?? (() => FIXED_NOW),
    ...(partial.jsonlDir === undefined ? {} : { jsonlDir: partial.jsonlDir }),
    ...(partial.sandboxNow === undefined ? {} : { sandboxNow: partial.sandboxNow }),
    ...(partial.mintTicketId === undefined ? {} : { mintTicketId: partial.mintTicketId }),
    ...(partial.warn === undefined ? {} : { warn: partial.warn }),
    ...(partial.probe === undefined ? {} : { probe: partial.probe }),
    ...(partial.restoreSession === undefined ? {} : { restoreSession: partial.restoreSession }),
    ...(partial.restoreEvents === undefined ? {} : { restoreEvents: partial.restoreEvents }),
    // 唤醒标记账本（ADR-0010）：每个夹具一套，避免用例之间共享"在途窗口"
    wakeMarks: partial.wakeMarks ?? createWakeMarkStore(),
  }
}
