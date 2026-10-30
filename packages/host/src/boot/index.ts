/**
 * @bah/host · 逻辑模块 boot（施工单 06）。
 *
 * 对外只暴露"组合系统"这一层：命令式启动（`boot`）、层序合并（`mergeLayers`）、
 * 依赖清单（`createCatalog` / `HOST_PLUGINS`）、config HMR（`startConfigHmr`）。
 * 具体文件读取（profile.yml / patch.yml）在 `@bah/cli`，boot 本身不碰文件系统。
 */

export {
  RUN_SERVICE,
  boot,
  type BootOptions,
  type BootedApp,
  type ProfileSummary,
  type ReloadResult,
  type RunContext,
} from './boot.ts'
export { BOOT_PREFIX, bootError } from './config.ts'
export { PluginManager, type HostPlugin, type PluginCatalog, type ValidatedRow } from '../plugin-manager/index.ts'
export {
  startConfigHmr,
  type ConfigHmr,
  type ConfigHmrOptions,
  type WatchHandler,
  type WatchStop,
} from './hmr.ts'
export {
  HOST_PLUGINS,
  createCatalog,
  agentPlugin,
  echoPlugin,
  factPlugin,
  merchantPlugin,
  modelPlugin,
  persistencePlugin,
  planPlugin,
  promptPlugin,
  schedulerPlugin,
  sessionPlugin,
  toolsPlugin,
} from './plugins/index.ts'
// 编排原语的服务键：消费方（快照场景 / 上层插件）按键取 `PlanApi`，不碰插件实现
export {
  PLAN_ARMED_SERVICE,
  PLAN_SERVICE,
  PLAN_WAKE_SERVICE,
  SAGA_BRIDGE_RECIPES,
  type ArmedPlansView,
  type PlanWakeEntry,
  type PlanWakeReport,
  type PlanWakeRunner,
  type PlanWakeSource,
} from './plugins/index.ts'
export { FACT_SERVICE, type FactSettings } from './plugins/fact.ts'
export { MERCHANT_SERVICE, type MerchantFulfilment, type MerchantService } from './plugins/merchant.ts'
export { schedulerPlugin as planSchedulerPlugin } from './plugins/scheduler.ts'
// 桌面渠道的服务键：桌面主进程按键取实际端口（`port:0` ⇒ 端口随启动变化）
export { DESKTOP_SERVER } from './plugins/index.ts'
export { DEFAULT_ROOT, SESSION_FILES, tenantRootOf, type SessionFiles } from './plugins/persistence.ts'
// 测试夹具：`RunContext` 工厂（租户与鉴权 01 TA-11）。与 `RunContext` 类型同包，
// 避免 @bah/test-support 反向依赖 host 造成 project references 成环。
export { testRunContext } from './test-run-context.ts'
// 管理面的两个常量给 `bah sentry unfreeze` 用：环境变量名与缺省理由只能有一份，
// 各写一份迟早会漂（改了 host 忘了 cli，命令就静默读错变量）
export { ADMIN_TOKEN_ENV, DEFAULT_UNFREEZE_REASON } from './plugins/web-admin.ts'
export {
  diffRows,
  mergeLayers,
  normalizeRow,
  sameStructure,
  type Bundle,
  type BundleRow,
  type ConfigLayer,
  type PluginRow,
  type ResolvedRow,
  type SourceLayer,
} from './profile-plugins.ts'
