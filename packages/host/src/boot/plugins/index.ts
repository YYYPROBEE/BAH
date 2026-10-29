/**
 * 依赖清单（施工单 06 §2 的 `bah` 字段在代码里的对应物）。
 *
 * bundle 里的行只写 `use: '<id>'`；**实现**在这里。两者分开的好处：
 * patch 文件永远不 import 任何代码（纯数据），而"这一行到底装了什么"由这份清单唯一定义。
 */

import type { HostPlugin, PluginCatalog, ValidatedRow } from '../../plugin-manager/index.ts'
import { toAnyHostPlugin, type AnyHostPlugin, type AnyHostPluginInput } from '../../plugin-manager/index.ts'
import { bootError } from '../config.ts'

import { agentPlugin } from './agent.ts'
import { approvalPlugin } from './approval.ts'
import { auditDecisionsPlugin } from './audit-decisions.ts'
import { bankToolsPlugin } from './bank-tools.ts'
import { echoPlugin } from './echo.ts'
import { knowledgePlugin } from './knowledge.ts'
import { modelPlugin } from './model.ts'
import { persistencePlugin } from './persistence.ts'
import { planPlugin } from './plan.ts'
// 策略外置 S2：外置规则 bundle 的载入/校验/灰度/热重载
import { policyRulesPlugin } from './policy.ts'
import { promptPlugin } from './prompt.ts'
import { sagaPlugin } from './saga.ts'
import { sagaAuditPlugin } from './saga-audit.ts'
import { sagaBridgePlugin } from './saga-bridge.ts'
import { sagaStorePlugin } from './saga-store.ts'
import { sandboxPlugin } from './sandbox.ts'
import { sentryPlugin } from './sentry.ts'
import { sessionPlugin } from './session.ts'
// 可观测性 01：遥测内核（只读旁路，不产生会话事件）
import { telemetryPlugin } from './telemetry.ts'
import { toolsPlugin } from './tools.ts'
// W05：断言核验门（监听 `agent/reply`）
import { verifyPlugin } from './verify.ts'
// C4：跨会话记忆（`turn/end` 写入、`agent/pre-step` 召回、提示词段注入）
import { memoryPlugin } from './memory.ts'
// 施工单 01：移动 H5 渠道（`channel:mobile`）。与 web 共用 `createHttpChannel`，薄壳。
import { mobilePlugin } from './mobile.ts'
import { webPlugin } from './web.ts'

/** base bundle 的插件集（施工单 06 §3：内核 + 主循环 + 模型层 + 工具管线 + 持久化）。 */
export const HOST_PLUGINS: readonly AnyHostPlugin[] = [
  sessionPlugin,
  // 可观测性 01：`obs:telemetry` 只 inject `bah:run` 与 `runtime:session`，
  // 所以紧跟在 `core:session` 之后即可；越早越能包住后续插件的包裹点。
  telemetryPlugin,
  toolsPlugin,
  promptPlugin,
  modelPlugin,
  agentPlugin,
  persistencePlugin,
  // W08：会话级证据链（tool/call + sentry/decision + approval/decided）
  auditDecisionsPlugin,
  echoPlugin,
  bankToolsPlugin,
  // 策略外置 S2：登记 ≠ 装配。真正是否装配由 bundle 行决定；
  // **行序**上 base bundle 把它排在 `bank:tools` 之前（后者 apply 时要找引擎）
  policyRulesPlugin,
  knowledgePlugin,
  approvalPlugin,
  sentryPlugin,
  // W05：断言核验门。必须排在其它 `agent/reply` 监听者之前（waterfall 注册顺序 = 外层顺序）
  verifyPlugin,
  sandboxPlugin,
  sagaStorePlugin,
  sagaPlugin,
  sagaAuditPlugin,
  // 接线层：必须排在 saga 三行之后（要 saga 的服务键就绪才可能真正跑起来）
  sagaBridgePlugin,
  // 编排原语（plan:dag）：只在新 profile `plan` 里被 patch 显式启用。
  // 登记在这里 = "可以被 use 引用"，**不等于**会被装配（`enabled: true` 必须写在 patch 里）
  planPlugin,
  // C4：跨会话记忆。登记 = 可被 use 引用；真正装配由 profile 的 patch 决定
  // （默认不装：记忆会改变模型输入，不做静默开启）
  memoryPlugin,
  // 渠道（施工单 13）：前端作为插件模块接入；不写进 base bundle，由 web profile 的 patch 加行
  webPlugin,
  // 渠道（施工单 01）：移动 H5；同样只由 profiles/mobile 的 patch 显式装配
  mobilePlugin,
].map(toAnyHostPlugin)

export {
  agentPlugin,
  approvalPlugin,
  auditDecisionsPlugin,
  bankToolsPlugin,
  echoPlugin,
  knowledgePlugin,
  memoryPlugin,
  modelPlugin,
  mobilePlugin,
  persistencePlugin,
  planPlugin,
  policyRulesPlugin,
  promptPlugin,
  sagaPlugin,
  sagaAuditPlugin,
  sagaBridgePlugin,
  sagaStorePlugin,
  sandboxPlugin,
  sentryPlugin,
  sessionPlugin,
  telemetryPlugin,
  toolsPlugin,
  verifyPlugin,
  webPlugin,
}

// 编排原语的服务键（`bah:plan`）：消费方按 key 取 `PlanApi`，不 import 插件实现
export { PLAN_SERVICE } from './plan.ts'

// W13：eval 的 S 族需要按场景替换编排配方（失败注入），供评测 harness 引用。
// 生产代码不使用这个导出；它是测试接缝，不是配置面。
export { SAGA_BRIDGE_RECIPES } from './saga-bridge.ts'

// W08：会话级证据链接缝（sentry 宿主行按它写 `sentry/decision`）
export { DECISION_AUDIT } from './audit-decisions.ts'
export type { ChainBreak, DecisionAudit, DecisionChainEntry } from './audit-decisions.ts'

/**
 * 造依赖清单。
 *
 * @throws `BahError('duplicate-plugin')` 清单内 id 重复（会让"use 指向谁"依赖声明顺序）
 */
export function createCatalog(plugins?: readonly AnyHostPlugin[]): PluginCatalog
export function createCatalog(plugins: readonly HostPluginLike[]): PluginCatalog
export function createCatalog(plugins: readonly HostPluginLike[] = HOST_PLUGINS): PluginCatalog {
  const catalog: Record<string, AnyHostPlugin> = {}
  for (const item of plugins) {
    const erased = toAnyHostPlugin(item as AnyHostPluginInput)
    if (catalog[erased.id] !== undefined) {
      throw bootError('duplicate-plugin', `依赖清单里插件 id ${erased.id} 重复`, { id: erased.id })
    }
    catalog[erased.id] = erased
  }
  return catalog
}

/** 结构化的插件清单输入（接受任意配置类型的 `HostPlugin<P>`）。 */
export interface HostPluginLike {
  readonly id: string
  readonly plugin: unknown
  readonly validate: (config: Readonly<Record<string, unknown>>) => unknown
  readonly validateComposition?: (rows: readonly ValidatedRow[]) => void
}
