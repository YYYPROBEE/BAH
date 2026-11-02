/**
 * 插件装配：配置校验 + `inject` 等待图。
 *
 * - **配置校验在 `apply` 之前执行**：未知键、类型错误、阈值越界、正则编译失败一律
 *   `bah-core: invalid config for <name>: ...` 载入即抛，绝不静默回退；
 * - **`inject` 等待图**：依赖未就绪的插件挂起在 waiting 队列，依赖就绪后继续；
 *   整轮无人可推进即视为死锁，成环时把环路径打进错误。
 */

import type { BahError } from '@bah/util'

import type { ConfigSchema, ErasedPlugin, ErasedPluginConfigSchema, PluginV2 } from './api.ts'
import { coreError, describeThrown } from './errors.ts'
import type { PluginRecord } from './types.ts'

/**
 * 擦除插件配置类型（存在类型的唯一转换点）。
 *
 * 这里是全仓唯一允许把 `unknown` 还原成具体 `Config` 的地方：调用方已经在
 * `ctx.use(plugin, config)` 上保证了类型，擦除只发生在"异构插件集合"的存储层。
 */
export function erasePlugin<Config>(plugin: PluginV2<Config>): ErasedPlugin {
  const schema =
    plugin.config === undefined
      ? undefined
      : eraseConfigSchema(plugin.config)
  return {
    name: plugin.name,
    ...(plugin.inject === undefined ? {} : { inject: plugin.inject }),
    ...(schema === undefined ? {} : { config: schema }),
    apply: (ctx, config) => plugin.apply(ctx, config as Config),
  }
}

function eraseConfigSchema<Config>(schema: ConfigSchema<Config>): ErasedPlugin['config'] {
  const validate = schema as unknown as (input: unknown) => unknown
  return {
    ...(schema.dict === undefined ? {} : { dict: schema.dict }),
    validate,
  }
}

/**
 * 校验并补默认值。
 *
 * `schemastery` 实例本身**可调用**：`schema(data)` 即校验 + 补默认值，失败抛 `ValidationError`。
 * 内核不 import schemastery（零运行时依赖：只认 api.ts 给的 `ConfigSchema` 类型），
 * 因此这里只依赖「可调用」这一结构事实。
 *
 * @param plugin 插件（取 `name` 与 `config`）
 * @param config 调用方传入的原始配置
 * @returns 校验通过、默认值已补齐的配置
 * @throws `bah-core: invalid config for <name>: ...`
 */
export function resolveConfig(
  plugin: PluginV2<unknown> | ErasedPlugin,
  config: unknown,
): unknown {
  const erased = isErasedPlugin(plugin) ? plugin : erasePlugin(plugin)
  const schema = erased.config
  if (!schema) return config ?? {}
  const input = config ?? {}
  const unknownKeys = findUnknownKeys(schema, input)
  if (unknownKeys.length > 0) {
    throw invalidConfig(erased.name, `未知配置键：${unknownKeys.join(', ')}`, { keys: unknownKeys })
  }
  try {
    return schema.validate(input)
  } catch (error) {
    throw invalidConfig(erased.name, describeThrown(error), { cause: error })
  }
}

function isErasedPlugin(plugin: PluginV2<unknown> | ErasedPlugin): plugin is ErasedPlugin {
  const schema = plugin.config as { validate?: unknown } | undefined
  return typeof schema?.validate === 'function'
}

/**
 * 找出配置里 schema 未声明的**顶层**键。
 *
 * `schemastery` 对未知键是「原样保留」而非报错，而要求未知配置键载入即抛：
 * 这里用 schema 自带的 `dict`（对象类 schema 的公开字段）做顶层键比对，补上这一层严格性。
 * 非对象类 schema（`union` / `transform` / 标量）没有 `dict`，交给 schema 自己判定。
 */
export function findUnknownKeys(
  schema: Pick<ErasedPluginConfigSchema, 'dict'> | undefined,
  input: unknown,
): string[] {
  const dict = schema?.dict
  if (!dict) return []
  if (typeof input !== 'object' || input === null) return []
  return Object.keys(input).filter((key) => !(key in dict))
}

/** 装上 `bah-core: ` 前缀的配置错误（模板取自）。 */
function invalidConfig(pluginName: string, reason: string, detail?: unknown): BahError {
  return coreError('invalid-config', `invalid config for ${pluginName}: ${reason}`, detail)
}

/**
 * 在等待中的插件里找 `inject` 环，返回环路径（首尾同名），无环返回 `undefined`。
 *
 * 依赖边的判据：插件名即它提供的服务名（`ServiceKey.id` 与插件名同属一个命名空间，
 * 见 api.ts「插件名，全仓唯一，形如 `bank:tools`」与的 `inject: ['bah:model']`）。
 *
 * @param records 本轮无法推进的插件
 */
export function findInjectCycle(records: readonly PluginRecord[]): string[] | undefined {
  const byName = new Map(records.map((record) => [record.name, record]))
  const path: string[] = []
  const visiting = new Set<string>()
  const settled = new Set<string>()

  const visit = (name: string): string[] | undefined => {
    if (visiting.has(name)) return [...path.slice(path.indexOf(name)), name]
    const record = byName.get(name)
    if (!record || settled.has(name)) return undefined
    visiting.add(name)
    path.push(name)
    for (const dependency of record.inject) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    path.pop()
    visiting.delete(name)
    settled.add(name)
    return undefined
  }

  for (const record of records) {
    const cycle = visit(record.name)
    if (cycle) return cycle
  }
  return undefined
}

/** 把等待中的插件渲染成可读清单：`插件名 ← [未就绪服务]`。 */
export function describeUnresolved(
  records: readonly PluginRecord[],
  isReady: (serviceId: string) => boolean,
): string {
  return records
    .map((record) => {
      const missing = record.inject.filter((id) => !isReady(id))
      return `${record.name} ← [${missing.join(', ')}]`
    })
    .join('；')
}
