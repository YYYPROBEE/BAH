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
  modelPlugin,
  persistencePlugin,
  promptPlugin,
  sessionPlugin,
  toolsPlugin,
} from './plugins/index.ts'
export { SESSION_FILES, type SessionFiles } from './plugins/persistence.ts'
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
