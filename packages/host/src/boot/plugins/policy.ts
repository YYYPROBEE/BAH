/**
 * base bundle · `policy:rules`：策略外置的**载入 / 校验 / 发布**平面（S2/S3）。
 *
 * 它做四件事，顺序不可换：
 * 1. **载入**：读 `registry.json`（已安装清单）与 `runtime-state.json`（灰度覆盖），
 *    解析每个 kind 的 active / canary / shadow 版本；
 * 2. **校验**：编译 bundle（语法/类型/静态分析/参数/工具名），摘要必须与 lock 一致；
 *    任何一项不合法 → 启动失败，**绝不跳过坏规则继续跑**（I9 / I15）；
 * 3. **提供**：`runtime:policy`（判决）+ `runtime:policy-meta`（只读元数据）；
 * 4. **观测**：发 `policy/bundle-loaded`；热重载时发 `policy/bundle-switched` /
 *    `policy/reload-rejected`；影子差异发 `policy/shadow-diff`。
 *
 * 三条边界（为什么这个文件不属于 `@bah/policy`）：
 * - `@bah/policy` 是纯库：不 import runtime，也不认识服务键；
 * - 本文件同时认识 `PolicyEngine` 端口与 `CompiledPolicy`，是唯一能做适配的地方；
 * - 它**不注入** `TOOLS_SERVICE` / `BANK_*` 服务：只 import `BANK_TOOL_NAME_SET` 这个
 *   编译期常量（`appliesTo` 的合法值必须与工具目录同源，否则 `policy-unknown-tool` 形同虚设）。
 *
 * 行序（03 §2.1）：`policy:rules` 必须排在 `bank:tools` **之前**——后者在 `apply()`
 * 里 `findPolicyEngine`，看不到后置的行。`validateComposition` 会把这个顺序做成启动错误。
 */

import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs'
import { join, resolve } from 'node:path'

import { BANK_TOOL_NAME_SET } from '@bah/bank'
import {
  loadBundle,
  type CompiledPolicy,
  type PolicyDescriptor as CompiledDescriptor,
  type TierPolicyResult,
} from '@bah/policy'
import {
  SESSION_SERVICE,
  providePolicyDescriptor,
  providePolicyEngine,
  type PolicyDecision,
  type PolicyDescriptor,
  type PolicyEngine,
} from '@bah/runtime'
import { BahError, sha256Hex } from '@bah/util'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import {
  asRecord,
  bootError,
  readBoolean,
  readPositiveInteger,
  readString,
  rejectUnknownKeys,
} from '../config.ts'
import { logJson } from './log.ts'

/**
 * 策略平面的四个领域事件（02 §4.3）。
 *
 * 为什么声明在**宿主**而不是 `@bah/policy`：它们是"装配/变更"的观测，不是判定语义；
 * `@bah/policy` 是纯库，不认识会话事件。声明机制与 `audit-decisions.ts` 的
 * `audit/chain-broken` 同一条（`declare module '@bah/core'`）。
 *
 * 三个事件进快照（`bundle-loaded` / `bundle-switched` / `reload-rejected`）；
 * `shadow-diff` 默认不进（影子只在演练 profile 打开，见 02 §7.3）。
 */
export interface PolicySessionEventMap {
  /** bundle 载入成功（插件启动或重载后的首次可用）。 */
  'policy/bundle-loaded': {
    readonly kind: string
    readonly handle: string
    readonly version: string
    readonly digest: string
    readonly engineVersion: string
    readonly at: number
  }
  /** 热重载切换成功（`from`/`to` 是 identity，不是 handle）。 */
  'policy/bundle-switched': {
    readonly kind: string
    readonly from: string
    readonly to: string
    readonly percent: number
    readonly epoch: number
    readonly at: number
  }
  /** 重载被拒（旧版继续服务）。 */
  'policy/reload-rejected': {
    readonly kind: string
    readonly code: string
    readonly message: string
    readonly at: number
  }
  /** 影子判决与生效判决不一致（只在 shadow 打开时发）。 */
  'policy/shadow-diff': {
    readonly kind: string
    readonly callId?: string
    readonly from: string
    readonly to: string
    readonly changed: readonly string[]
    readonly at: number
  }
}

declare module '@bah/core' {
  interface SessionEventMap extends PolicySessionEventMap {}
}

/** v1 只认这一种 bundle 类型（S5 才加 `sentry.rules`）。 */
const TIER_KIND = 'bank.tier'

/**
 * base bundle 行的默认部署版本（base 行不写 `config`，靠这里兜底）。
 *
 * 与 03 §4.1 逐字一致：**默认值只在插件里有一份**，profile 想换就整块覆盖 `active`。
 * 这也是为什么 `active` 缺省不算错误——base 的 `{ id: 'policy:rules' }` 是裸行。
 */
const DEFAULT_ACTIVE: Readonly<Record<string, string>> = { [TIER_KIND]: 'bank-tier/1.0.0' }

/** 万分比基数（`percent: 500` = 5%）。 */
const PERCENT_BASE = 10_000

/** registry 的 schema 标识。 */
const REGISTRY_API = 'bah.policy.registry/v1'

/** runtime-state 的 schema 标识。 */
const STATE_API = 'bah.policy.runtime-state/v1'

/**
 * 配置里 `limits.*` 的硬上限（超过 = 启动挂起的风险）。
 *
 * **诚实登记**：v1 的 `limits` 只做"配置自身是否越界"的校验；真正生效的上限来自
 * `@bah/policy` 的 `POLICY_LIMITS`（编译期 `policy-limit-exceeded`）。两处不一致时
 * 以编译期为准——因为 bundle 的结构上限是语言性质，不是部署参数。
 */
const HARD_LIMITS = {
  maxBundleBytes: 1_048_576,
  maxTables: 64,
  maxRowsPerTable: 256,
  maxExprDepth: 64,
} as const

/** `policy:rules` 的配置（03 §2.3）。 */
export interface PolicyRulesSettings {
  /** bundle 根目录（相对仓库根或绝对路径）。 */
  readonly root: string
  /** 部署默认版本（kind → handle，如 `bank.tier: bank-tier/1.0.0`）。 */
  readonly active: Readonly<Record<string, string>>
  /** 运行时覆盖文件（不存在 = 用 `active`）。 */
  readonly statePath: string
  /** 是否监听 state 文件（headless/CI 必须 false）。 */
  readonly hotReload: boolean
  /** 是否强制签名（生产 true；演示 false）。 */
  readonly requireSignature: boolean
  readonly signature: {
    readonly publicKeyPath?: string
    readonly allowedKeyVersions: readonly number[]
  }
  /** 影子候选（kind → handle；`null` = 显式关闭）。 */
  readonly shadow: Readonly<Record<string, string | null>>
}

/** registry 里的一个版本条目。 */
interface RegistryEntry {
  readonly path: string
  readonly semanticDigest: string
  readonly sourceDigest: string
  readonly engine: string
  readonly installedAt: number
  readonly demo?: boolean
}

/** `registry.json`：只回答"装了哪些版本"，不回答"现在用哪个"。 */
interface PolicyRegistry {
  readonly apiVersion: string
  readonly kinds: Readonly<
    Record<string, { readonly versions: Readonly<Record<string, RegistryEntry>> }>
  >
}

/** 金丝雀分配（`percent` 是万分比整数）。 */
interface CanaryAssignment {
  readonly version: string
  readonly percent: number
  readonly sessions?: readonly string[]
  readonly epoch: number
}

/** `runtime-state.json`：运行时覆盖（gitignore；可无）。 */
interface PolicyRuntimeState {
  readonly apiVersion: string
  readonly updatedAt: number
  readonly assignments: Readonly<
    Record<string, { readonly active: string; readonly canary?: CanaryAssignment }>
  >
}

/** 一个 kind 的运行期快照（冻结；热重载只替换引用）。 */
interface KindRuntime {
  readonly kind: string
  readonly active: CompiledPolicy
  readonly canary?: {
    readonly compiled: CompiledPolicy
    readonly percent: number
    readonly sessions: readonly string[]
    readonly epoch: number
  }
  readonly shadow?: CompiledPolicy
}

/** 全量快照。 */
interface PolicySnapshot {
  readonly kinds: ReadonlyMap<string, KindRuntime>
  readonly descriptors: readonly PolicyDescriptor[]
  readonly loadedAt: number
}

/** 影子差异的输出口（宿主闭包；engine 本身不碰事件）。 */
type ShadowSink = (diff: {
  readonly kind: string
  readonly callId: string | undefined
  readonly from: string
  readonly to: string
  readonly changed: readonly string[]
}) => void

export const policyRulesPlugin: HostPlugin<PolicyRulesSettings> = {
  id: 'policy:rules',

  plugin: {
    name: 'policy:rules',
    // 只注入"会话"与"运行"：策略平面不认识银行工具，也不写工具注册表。
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE)
      const sessionId = String(run.sessionId)
      /**
       * `--dump-config` 的 stderr 是**契约**（A8 要求严格为空）。
       *
       * 与 `audit:decisions` 的缺钥告警同一条纪律：真实启动（`--serve` / `--prompt`）
       * 必须打一行版本，dump 一个字都不能打。
       */
      const quiet = run.probe === false

      /** 当前快照。热重载只替换这个引用；在途判决持有旧引用（I11）。 */
      let current = loadSnapshot(config, run.now)

      const emit = (type: string, data: unknown): void => {
        try {
          session.appendDomain(type, data, { ignorable: true })
        } catch (error) {
          // 观测失败不改判决（I17 的同一条纪律）：策略已经算完了。
          console.warn(`[policy:rules] 会话事件 ${type} 写入失败：${String(error)}`)
        }
      }

      const shadowSink: ShadowSink = (diff) => {
        emit('policy/shadow-diff', { ...diff, at: run.now() })
      }

      ctx.effect(providePolicyEngine(ctx, engineOf(() => current, sessionId, shadowSink)))
      /**
       * 描述符是**活引用**：热重载后 `version/canary/parameters` 必须立即反映新快照。
       *
       * 如果这里捕获 `current.descriptors[0]` 的快照值，早拒路径（sentry/no-identity/预检）
       * 会一直写旧版本——那正是"每条判决有身份"要避免的假账（I12）。
       */
      ctx.effect(
        providePolicyDescriptor(ctx, {
          // `loadSnapshot` 保证每个 active kind 一个描述符，且 active 至少一行；
          // 这里不做 `??` 兜底——没有描述符是装配 bug，不该被一个假版本号掩盖。
          get kind() {
            return current.descriptors[0]!.kind
          },
          get handle() {
            return current.descriptors[0]!.handle
          },
          get version() {
            return current.descriptors[0]!.version
          },
          get semanticDigest() {
            return current.descriptors[0]!.semanticDigest
          },
          get engineVersion() {
            return current.descriptors[0]!.engineVersion
          },
          get loadedAt() {
            return current.loadedAt
          },
          get parameters() {
            return current.descriptors[0]!.parameters
          },
          get canary() {
            return current.descriptors[0]!.canary
          },
        }),
      )

      // 启动证据：**一行 stderr + 一条会话事件**（演示现场要看得到版本）
      for (const descriptor of current.descriptors) {
        if (!quiet) {
          logJson('info', 'policy.loaded', {
            kind: descriptor.kind,
            version: descriptor.version,
            digest: descriptor.semanticDigest,
            engine: descriptor.engineVersion,
          })
        }
        emit('policy/bundle-loaded', {
          kind: descriptor.kind,
          handle: descriptor.handle,
          version: descriptor.version,
          digest: descriptor.semanticDigest,
          engineVersion: descriptor.engineVersion,
          at: current.loadedAt,
        })
      }

      if (!config.hotReload) return

      /**
       * 重载流水线（02 §8.2）：读 → 校验 → 编译 → 原子替换 → 事件。
       *
       * 失败**不部分应用**：`current` 保持旧快照，只发 `policy/reload-rejected`（I10）。
       */
      const reload = (): void => {
        let next: PolicySnapshot
        try {
          next = loadSnapshot(config, run.now)
        } catch (error) {
          const code = (error as { code?: string }).code ?? 'policy-reload-failed'
          logJson('warn', 'policy.reloadRejected', {
            kind: TIER_KIND,
            code,
            message: error instanceof Error ? error.message : String(error),
          })
          emit('policy/reload-rejected', {
            kind: TIER_KIND,
            code,
            message: error instanceof Error ? error.message : String(error),
            at: run.now(),
          })
          return
        }
        const previous = current
        // 版本没变（state 内容无关变化 / watcher 重复触发）→ 只换引用，不发"切换"事件。
        // 这样重载事件的数量只跟**真实版本变化**有关，metrics 的 reloads 才可信。
        if (sameDescriptors(previous.descriptors, next.descriptors)) {
          current = next
          return
        }
        current = next
        for (const descriptor of next.descriptors) {
          const before = previous.descriptors.find((item) => item.kind === descriptor.kind)
          if (before !== undefined && descriptorKey(before) === descriptorKey(descriptor)) continue
          logJson('info', 'policy.switched', {
            kind: descriptor.kind,
            from: before?.version ?? 'none',
            to: descriptor.version,
            percent: descriptor.canary?.percent ?? PERCENT_BASE,
            epoch: descriptor.canary?.epoch ?? 0,
          })
          // `from`/`to` 是 identity（02 §4.3）：只写 handle 无法回答"切到的是不是同一份内容"。
          emit('policy/bundle-switched', {
            kind: descriptor.kind,
            from: before?.version ?? 'none',
            to: descriptor.version,
            percent: descriptor.canary?.percent ?? PERCENT_BASE,
            epoch: descriptor.canary?.epoch ?? 0,
            at: next.loadedAt,
          })
        }
      }

      const statePath = resolve(config.statePath)
      // `fs.watchFile` 是轮询实现：Windows 上比 `fs.watch` 稳（沿用 `hmr.ts` 的结论）。
      // `persistent: false` 让 watcher 不拖住进程退出。
      watchFile(statePath, { interval: 250, persistent: false }, reload)
      ctx.effect(() => {
        unwatchFile(statePath, reload)
      })

      /**
       * 暴露给测试的一次手动重载（不依赖真实文件时序）。
       *
       * 与 watcher 走**同一条**流水线：如果这里和 watcher 各写一份，测的就不是生产路径。
       */
      reloadNow = reload
    },
  },

  validate(config) {
    rejectUnknownKeys(
      config,
      [
        'root',
        'active',
        'statePath',
        'hotReload',
        'requireSignature',
        'signature',
        'limits',
        'shadow',
      ],
      'policy:rules',
    )
    const root = readString(config, 'root', 'policy:rules') ?? 'policies'
    if (root.includes('..')) {
      throw bootError('invalid-config', `policy:rules.root 不得包含 ..（收到 ${root}）`, { root })
    }
    const activeRecord = asRecord(config['active'] ?? {}, 'policy:rules.active')
    const active =
      config['active'] === undefined
        ? DEFAULT_ACTIVE
        : readVersionMap(activeRecord, 'policy:rules.active')
    if (Object.keys(active).length === 0) {
      throw bootError(
        'invalid-config',
        'policy:rules.active 至少要有 bank.tier 一行（显式空映射不是"用默认"）',
      )
    }
    for (const kind of Object.keys(active)) {
      if (kind !== TIER_KIND) {
        throw bootError(
          'invalid-config',
          `policy:rules.active 含未知 kind ${kind}（v1 只认 bank.tier）`,
          { kind },
        )
      }
    }
    const shadowRecord =
      config['shadow'] === undefined ? {} : asRecord(config['shadow'], 'policy:rules.shadow')
    const shadow = readShadowMap(shadowRecord, new Set(Object.keys(active)))
    for (const [kind, handle] of Object.entries(shadow)) {
      if (handle !== null && handle === active[kind]) {
        throw bootError(
          'policy-shadow-self',
          `policy:rules.shadow.${kind} 与 active 是同一版本（${handle}）：影子必须指向另一个版本`,
        )
      }
    }
    const signature =
      config['signature'] === undefined
        ? {}
        : asRecord(config['signature'], 'policy:rules.signature')
    rejectUnknownKeys(signature, ['publicKeyPath', 'allowedKeyVersions'], 'policy:rules.signature')
    const requireSignature = readBoolean(config, 'requireSignature', 'policy:rules', false)
    const publicKeyPath = readString(signature, 'publicKeyPath', 'policy:rules.signature')
    if (requireSignature && publicKeyPath === undefined) {
      throw bootError(
        'invalid-config',
        'policy:rules.requireSignature=true 时必须给 signature.publicKeyPath',
      )
    }
    readLimits(config['limits'])

    return {
      root,
      active,
      statePath: readString(config, 'statePath', 'policy:rules') ?? join(root, 'runtime-state.json'),
      hotReload: readBoolean(config, 'hotReload', 'policy:rules', false),
      requireSignature,
      signature: {
        ...(publicKeyPath === undefined ? {} : { publicKeyPath }),
        allowedKeyVersions: readKeyVersions(signature['allowedKeyVersions']),
      },
      shadow,
    }
  },

  /**
   * 组合校验（03 §2.4）：行序 + 服务一致性。
   *
   * 这两条都**不能**等到运行期：`policy/bundle-loaded` 与描述符必须在第一次工具调用前
   * 就绪，顺序错会让"首条判决没有版本"。
   */
  validateComposition(rows) {
    const policyRow = rows.find((row) => row.id === 'policy:rules')
    const bankRow = rows.find((row) => row.id === 'bank:tools')
    if (policyRow === undefined || bankRow === undefined) return

    const bank = asRecord(bankRow.settings, 'bank:tools')
    const policy = bank['policy'] === undefined ? {} : asRecord(bank['policy'], 'bank:tools.policy')
    const engine = typeof policy['engine'] === 'string' ? policy['engine'] : 'legacy'
    if (engine !== 'bundle') return

    const policyIndex = rows.indexOf(policyRow)
    const bankIndex = rows.indexOf(bankRow)
    if (policyIndex > bankIndex) {
      throw bootError(
        'policy-row-order',
        `policy:rules 必须排在 bank:tools 之前（当前 ${String(policyIndex)} > ${String(bankIndex)}）：` +
          'bank:tools 在 apply() 里查找策略引擎，后置的行它看不到',
        { policyIndex, bankIndex },
      )
    }

    const active = asRecord(policyRow.settings, 'policy:rules')['active']
    if (active === undefined || asRecord(active, 'policy:rules.active')[TIER_KIND] === undefined) {
      throw bootError(
        'policy-service-missing',
        'bank:tools.policy.engine=bundle 但 policy:rules.active 没有 bank.tier',
      )
    }
  },
}

/**
 * 最近一次 `policy:rules` 装配暴露的手动重载句柄（测试用）。
 *
 * 为什么放模块级而不是服务键：它是**测试夹具**，不是产品接口；服务键会被
 * `verify-package-graph` 当成跨包契约，为一个测试开后门不划算。
 */
let reloadNow: (() => void) | undefined

/** 触发一次重载（无装配时返回 `false`）。 */
export function reloadPolicyNow(): boolean {
  if (reloadNow === undefined) return false
  reloadNow()
  return true
}

/** 清空手动句柄（测试清理；生产路径不会调用）。 */
export function resetPolicyReloadHandle(): void {
  reloadNow = undefined
}

/**
 * 载入一份完整快照（纯读；失败抛 `policy-*`）。
 *
 * 顺序：registry → state → 逐 kind 解析版本 → 编译 → 影子编译。
 * **任何一步失败都整体失败**：不存在"半个快照"。
 */
function loadSnapshot(settings: PolicyRulesSettings, now: () => number): PolicySnapshot {
  const root = resolve(settings.root)
  const registry = readRegistry(root)
  const state = readState(resolve(settings.statePath))
  const toolNames = [...BANK_TOOL_NAME_SET]
  const kinds = new Map<string, KindRuntime>()
  const descriptors: PolicyDescriptor[] = []

  for (const [kind, fallback] of Object.entries(settings.active)) {
    const assignment = state?.assignments[kind]
    const activeHandle = assignment?.active ?? fallback
    const active = compileAt(root, kind, activeHandle, registry, settings, toolNames)

    const canaryHandle = assignment?.canary?.version
    const canary =
      canaryHandle === undefined
        ? undefined
        : {
            compiled: compileAt(root, kind, canaryHandle, registry, settings, toolNames),
            percent: assignment?.canary?.percent ?? 0,
            sessions: assignment?.canary?.sessions ?? [],
            epoch: assignment?.canary?.epoch ?? 0,
          }

    const shadowHandle = settings.shadow[kind] ?? null
    if (shadowHandle !== null && shadowHandle === activeHandle) {
      throw new BahError(
        'policy-shadow-self',
        `runtime-state 把 ${kind} 的 active 与 shadow 指向了同一版本（${shadowHandle}）`,
        { kind, handle: shadowHandle },
      )
    }
    const shadow =
      shadowHandle === null
        ? undefined
        : compileAt(root, kind, shadowHandle, registry, settings, toolNames)

    kinds.set(kind, {
      kind,
      active,
      ...(canary === undefined ? {} : { canary }),
      ...(shadow === undefined ? {} : { shadow }),
    })
    descriptors.push(descriptorOf(active, canary, now()))
  }

  // 未知 kind 的 state 条目是**配置漂移**：不静默忽略（否则"以为切了版本"）。
  for (const kind of Object.keys(state?.assignments ?? {})) {
    if (!Object.hasOwn(settings.active, kind)) {
      throw new BahError(
        'policy-state-invalid',
        `runtime-state.json 里的 kind ${kind} 未在 policy:rules.active 声明`,
        { kind },
      )
    }
  }

  return { kinds, descriptors, loadedAt: now() }
}

/** `CompiledPolicy` → `PolicyDescriptor`（runtime 端口的只读视图）。 */
function descriptorOf(
  active: CompiledPolicy,
  canary:
    | { readonly compiled: CompiledPolicy; readonly percent: number; readonly epoch: number }
    | undefined,
  loadedAt: number,
): PolicyDescriptor {
  const descriptor: CompiledDescriptor = active.descriptor
  const parameters = active.parameters
  return {
    kind: descriptor.kind,
    handle: descriptor.handle,
    version: descriptor.policyVersion,
    semanticDigest: descriptor.semanticDigest,
    engineVersion: descriptor.engineVersion,
    loadedAt,
    // 参数边界随描述符走：`bank:tools` 用它校验自己的部署参数（02 §3.1）
    ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
    ...(canary === undefined
      ? {}
      : {
          canary: {
            handle: canary.compiled.descriptor.handle,
            version: canary.compiled.descriptor.policyVersion,
            percent: canary.percent,
            epoch: canary.epoch,
          },
        }),
  }
}

/** 描述符的"版本身份"键（不含 loadedAt；重载时间不是切换）。 */
function descriptorKey(descriptor: PolicyDescriptor): string {
  return [
    descriptor.kind,
    descriptor.version,
    descriptor.canary?.handle ?? '',
    descriptor.canary?.percent ?? '',
    descriptor.canary?.epoch ?? '',
  ].join('|')
}

/** 两组描述符是否等价（kind 集合 + 身份键）。 */
function sameDescriptors(
  left: readonly PolicyDescriptor[],
  right: readonly PolicyDescriptor[],
): boolean {
  if (left.length !== right.length) return false
  const keys = new Set(left.map(descriptorKey))
  return right.every((descriptor) => keys.has(descriptorKey(descriptor)))
}

/**
 * 读 registry；不存在 = `undefined`（S2 允许无 registry，S3 由门禁要求它存在）。
 *
 * 存在就必须**形状完整**：`kinds` 是对象、每个版本条目带 `path`/`semanticDigest`/
 * `sourceDigest`。半截 registry 比没有 registry 更危险（会静默回落到目录推断）。
 */
function readRegistry(root: string): PolicyRegistry | undefined {
  const path = join(root, 'registry.json')
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new BahError(
      'policy-registry-invalid',
      `registry.json 不是合法 JSON：${String(error)}`,
      { file: path },
    )
  }
  const record = policyRecord(parsed, 'registry.json', 'policy-registry-invalid')
  if (record['apiVersion'] !== REGISTRY_API) {
    throw new BahError(
      'policy-registry-invalid',
      `registry.json 的 apiVersion 必须是 ${REGISTRY_API}`,
      { file: path, actual: String(record['apiVersion']) },
    )
  }
  const kinds = policyRecord(record['kinds'], 'registry.json.kinds', 'policy-registry-invalid')
  for (const [kind, value] of Object.entries(kinds)) {
    const versions = policyRecord(
      policyRecord(value, `registry.json.kinds.${kind}`, 'policy-registry-invalid')['versions'],
      `registry.json.kinds.${kind}.versions`,
      'policy-registry-invalid',
    )
    for (const [handle, entryValue] of Object.entries(versions)) {
      const entry = policyRecord(
        entryValue,
        `registry.json.kinds.${kind}.versions.${handle}`,
        'policy-registry-invalid',
      )
      for (const key of ['path', 'semanticDigest', 'sourceDigest', 'engine'] as const) {
        if (typeof entry[key] !== 'string' || entry[key].length === 0) {
          throw new BahError(
            'policy-registry-invalid',
            `registry.json 的 ${kind}/${handle} 缺少字符串字段 ${key}`,
            { file: path, kind, handle, key },
          )
        }
      }
    }
  }
  return parsed as PolicyRegistry
}

/** 带策略错误码的对象断言（registry/state 各自有稳定码，不能退化成 `invalid-config`）。 */
function policyRecord(
  value: unknown,
  where: string,
  code: 'policy-registry-invalid' | 'policy-state-invalid',
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BahError(code, `${where} 必须是对象`)
  }
  return value as Readonly<Record<string, unknown>>
}

/** 读 runtime-state；不存在 = `undefined`（用部署默认）。 */
function readState(path: string): PolicyRuntimeState | undefined {
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new BahError(
      'policy-state-invalid',
      `runtime-state.json 不是合法 JSON：${String(error)}`,
      { file: path },
    )
  }
  const record = policyRecord(parsed, 'runtime-state.json', 'policy-state-invalid')
  if (record['apiVersion'] !== STATE_API) {
    throw new BahError(
      'policy-state-invalid',
      `runtime-state.json 的 apiVersion 必须是 ${STATE_API}`,
      { file: path, actual: String(record['apiVersion']) },
    )
  }
  const assignments = policyRecord(
    record['assignments'],
    'runtime-state.json.assignments',
    'policy-state-invalid',
  )
  for (const [kind, value] of Object.entries(assignments)) {
    const assignment = policyRecord(
      value,
      `runtime-state.json.assignments.${kind}`,
      'policy-state-invalid',
    )
    requireStateString(assignment['active'], `assignments.${kind}.active`, path)
    if (assignment['canary'] === undefined) continue
    const canary = policyRecord(
      assignment['canary'],
      `runtime-state.json.assignments.${kind}.canary`,
      'policy-state-invalid',
    )
    requireStateString(canary['version'], `assignments.${kind}.canary.version`, path)
    requireStateInt(canary['percent'], `assignments.${kind}.canary.percent`, path, 0, PERCENT_BASE)
    if (canary['epoch'] !== undefined) {
      requireStateInt(canary['epoch'], `assignments.${kind}.canary.epoch`, path, 0, Number.MAX_SAFE_INTEGER)
    }
    if (canary['sessions'] !== undefined) {
      if (!Array.isArray(canary['sessions'])) {
        throw new BahError(
          'policy-state-invalid',
          `runtime-state.json 的 ${kind}.canary.sessions 必须是字符串数组`,
          { file: path, kind },
        )
      }
      for (const session of canary['sessions']) {
        if (typeof session !== 'string' || session.length === 0) {
          throw new BahError(
            'policy-state-invalid',
            `runtime-state.json 的 ${kind}.canary.sessions 含非字符串项`,
            { file: path, kind },
          )
        }
      }
    }
  }
  return parsed as PolicyRuntimeState
}

/** state 里的非空字符串字段。 */
function requireStateString(value: unknown, field: string, file: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BahError('policy-state-invalid', `runtime-state.json 的 ${field} 必须是非空字符串`, {
      file,
      field,
    })
  }
  return value
}

/** state 里的整数区间字段（闭合 `[min, max]`）。 */
function requireStateInt(
  value: unknown,
  field: string,
  file: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BahError(
      'policy-state-invalid',
      `runtime-state.json 的 ${field} 必须是 [${String(min)}, ${String(max)}] 内的整数`,
      { file, field, value },
    )
  }
  return value
}

/**
 * 解析 handle → 目录并编译。
 *
 * 目录来源：有 registry 时**必须**在 registry 里（`policy-version-missing`）；
 * 没有 registry 时才按 `${root}/${name}/${version}` 推断——S2 的仓库里可能还没有
 * registry，S3 由门禁要求它存在。绝不"registry 里没有但目录在，就静默用目录"。
 */
function compileAt(
  root: string,
  kind: string,
  handle: string,
  registry: PolicyRegistry | undefined,
  settings: PolicyRulesSettings,
  toolNames: readonly string[],
): CompiledPolicy {
  const entry = registry?.kinds[kind]?.versions[handle]
  if (registry !== undefined && entry === undefined) {
    throw new BahError(
      'policy-version-missing',
      `registry.json 里没有 ${kind} 的版本 ${handle}`,
      { kind, handle },
    )
  }
  const dir = entry === undefined ? join(root, ...handle.split('/')) : resolve(entry.path)
  if (!existsSync(dir)) {
    throw new BahError('policy-bundle-missing', `bundle 目录不存在：${dir}`, {
      dir,
      handle,
      kind,
    })
  }
  const keyPath = settings.signature.publicKeyPath
  const result = loadBundle({
    dir,
    toolNames,
    verifyLock: true,
    withCorpus: false,
    requireSignature: settings.requireSignature,
    ...(keyPath === undefined ? {} : { publicKeyPem: readFileSync(resolve(keyPath), 'utf8') }),
    ...(settings.signature.allowedKeyVersions.length === 0
      ? {}
      : { allowedKeyVersions: settings.signature.allowedKeyVersions }),
  })
  if (entry !== undefined && entry.semanticDigest !== result.compiled.descriptor.semanticDigest) {
    throw new BahError(
      'policy-digest-mismatch',
      `registry 里的 semanticDigest 与现场不符（${handle}）`,
      {
        handle,
        expected: entry.semanticDigest,
        actual: result.compiled.descriptor.semanticDigest,
      },
    )
  }
  return result.compiled
}

/**
 * `CompiledPolicy` → `PolicyEngine` 适配器。
 *
 * **不 catch** 求值与校验异常：治理平面统一收敛成 `policy-engine-error` /
 * `policy-input-invalid`（03 §2.5 的"避免两处兜底不一致"）。
 */
function engineOf(
  snapshotOf: () => PolicySnapshot,
  defaultSessionId: string,
  shadowSink: ShadowSink,
): PolicyEngine {
  return {
    decide(subject, action, context) {
      const snapshot = snapshotOf()
      const kind = action.kind ?? TIER_KIND
      const runtime = snapshot.kinds.get(kind)
      if (runtime === undefined) {
        throw new BahError('policy-unavailable', `没有 kind=${kind} 的策略快照`)
      }
      const sessionId = subject.sessionId ?? defaultSessionId
      const compiled = pick(runtime, sessionId)
      const result = evaluate(compiled, context.input, kind, sessionId)

      if (runtime.shadow !== undefined && compiled !== runtime.shadow) {
        const shadowed = evaluate(runtime.shadow, context.input, kind, sessionId)
        const changed = diffOf(result, shadowed)
        if (changed.length > 0) {
          shadowSink({
            kind,
            callId: action.callId,
            from: compiled.descriptor.policyVersion,
            to: runtime.shadow.descriptor.policyVersion,
            changed,
          })
        }
      }

      return toDecision(compiled, result)
    },
  }
}

/** 按会话选版本：显式金丝雀名单优先，其次万分比分桶（纯函数、跨重启稳定）。 */
function pick(runtime: KindRuntime, sessionId: string): CompiledPolicy {
  const canary = runtime.canary
  if (canary === undefined) return runtime.active
  if (canary.sessions.includes(sessionId)) return canary.compiled
  const bucket =
    Number.parseInt(sha256Hex(`${sessionId}#${String(canary.epoch)}`).slice(0, 8), 16) %
    PERCENT_BASE
  return bucket < canary.percent ? canary.compiled : runtime.active
}

/** 求值 + 形状校验（`validateInput` 抛错即 `policy-input-invalid`）。 */
function evaluate(
  compiled: CompiledPolicy,
  input: unknown,
  kind: string,
  sessionId: string,
): TierPolicyResult {
  if (input === undefined) {
    throw new BahError(
      'policy-input-invalid',
      `engine=bundle 但治理平面没有传 context.input（kind=${kind}, session=${sessionId}）`,
    )
  }
  return compiled.evaluate(compiled.validateInput(input))
}

/** 逐字段比较（只有这些字段算"判决差异"；`tables` 不参与）。 */
function diffOf(left: TierPolicyResult, right: TierPolicyResult): readonly string[] {
  const changed: string[] = []
  if (left.level !== right.level) changed.push('level')
  if (left.reason !== right.reason) changed.push('reason')
  if (left.deny?.code !== right.deny?.code) changed.push('deny')
  if (left.ruleIds.join(',') !== right.ruleIds.join(',')) changed.push('ruleIds')
  return changed
}

/** `TierPolicyResult` → `PolicyDecision`（把四项增量一起带出去）。 */
function toDecision(compiled: CompiledPolicy, result: TierPolicyResult): PolicyDecision {
  const meta = {
    level: result.level,
    tierReason: result.reason,
    ruleIds: result.ruleIds,
    policyVersion: compiled.descriptor.policyVersion,
  }
  if (result.deny !== undefined) {
    return { verdict: 'deny', reason: result.deny.reason, code: result.deny.code, ...meta }
  }
  return { verdict: 'allow', reason: 'bundle-evaluated', ...meta }
}

/** 读 `kind → handle` 映射（值必须是字符串）。 */
function readVersionMap(
  record: Readonly<Record<string, unknown>>,
  where: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [kind, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw bootError('invalid-config', `${where}.${kind} 必须是非空字符串`)
    }
    result[kind] = value
  }
  return result
}

/** 读 `kind → handle|null` 映射（`null` = 显式关闭影子）。 */
function readShadowMap(
  record: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  for (const [kind, value] of Object.entries(record)) {
    if (!allowed.has(kind)) {
      throw bootError('invalid-config', `policy:rules.shadow 含未在 active 声明的 kind ${kind}`)
    }
    if (value === null) {
      result[kind] = null
      continue
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw bootError('invalid-config', `policy:rules.shadow.${kind} 必须是非空字符串或 null`)
    }
    result[kind] = value
  }
  return result
}

/** 密钥版本列表：非空、升序、唯一。 */
function readKeyVersions(value: unknown): readonly number[] {
  if (value === undefined) return [1]
  if (!Array.isArray(value) || value.length === 0) {
    throw bootError('invalid-config', 'policy:rules.signature.allowedKeyVersions 必须是非空数组')
  }
  const versions = value.map((item) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0) {
      throw bootError('invalid-config', 'policy:rules.signature.allowedKeyVersions 必须是正整数')
    }
    return item
  })
  for (let index = 1; index < versions.length; index += 1) {
    const previous = versions[index - 1]
    const current = versions[index]
    if (previous === undefined || current === undefined || current <= previous) {
      throw bootError('invalid-config', 'policy:rules.signature.allowedKeyVersions 必须升序且唯一')
    }
  }
  return versions
}

/** `limits.*` 的边界校验：超过硬上限会让启动挂起（02 §11）。 */
function readLimits(value: unknown): void {
  if (value === undefined) return
  const record = asRecord(value, 'policy:rules.limits')
  rejectUnknownKeys(
    record,
    ['maxBundleBytes', 'maxTables', 'maxRowsPerTable', 'maxExprDepth'],
    'policy:rules.limits',
  )
  for (const [key, hard] of Object.entries(HARD_LIMITS)) {
    const read = readPositiveInteger(record, key, 'policy:rules.limits')
    if (read !== undefined && read > hard) {
      throw bootError(
        'invalid-config',
        `policy:rules.limits.${key}（${String(read)}）超过硬上限 ${String(hard)}`,
        { key, value: read, hard },
      )
    }
  }
}

/** 供测试复用的纯函数（不参与装配）。 */
export const policyInternals = {
  /** 万分比分桶：`sha256(`${sessionId}#${epoch}`)` 前 8 位 hex 取模。 */
  bucketOf: (sessionId: string, epoch: number): number =>
    Number.parseInt(sha256Hex(`${sessionId}#${String(epoch)}`).slice(0, 8), 16) % PERCENT_BASE,
  pick,
} as const
