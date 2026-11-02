/**
 * `bah:memory-store`：跨会话记忆的**产品接线**（C4）。
 *
 * ## 为什么接线放在 host，而不是 `@bah/memory-store/plugin.ts`
 *
 * `@bah/memory-store` 的纪律是"零底座依赖"（不 import `@bah/core` / `@bah/runtime`），
 * 这样它能在任何宿主里跑单测。而接线必须拿到服务键、系统提示注册表与事件总线——
 * 那些都是底座概念。所以：**能力在包里，接线在宿主**，与 `core:persistence`
 * 暴露 `SESSION_FILES` 是同一个分工。
 *
 * ## 三条接线（缺一条都等于没接）
 *
 * | 方向 | 挂点 | 为什么是这个挂点 |
 * |---|---|---|
 * | 写入 | `session/event` 的 `turn/end`（emit） | turn 边界是"这一轮说完了"的唯一确定信号；`assistant/message` 逐条写会把同一轮切碎。运行时只广播 `session/event`，没有独立的 `turn/end` 主题 |
 * | 读取 | `agent/pre-step`（waterfall，`step === 1`） | 只在**本轮第一步**检索：多步里同一段记忆会重复注入，而且 step 中途的用户意图还没成型 |
 * | 注入 | `PromptSection`（`target: 'context'`，order 35） | 记忆是**运行时上下文**，按不许拼进 system 头；35 落在 `runtime.context`(30) 与 `policy.approval`(40) 之间 |
 *
 * ## 诚实边界（写进文档，也写进这里）
 *
 * - **租户来自 `RunContext.tenantId`**（01 TA-13）：不再有 `tenant` 配置键。
 *   库文件是**租户根下的单段文件名**（`<config.root>/<tenant>/memory.db`），
 *   跨租户隔离靠目录 + `WHERE tenant = ?` 两道；一个进程只服务一个租户。
 * - **影子核验未实现**：检索时传的是 `@bah/memory-store` 的 `NULL_BANK_QUERY`
 *   （永远返回 null；`layer.ts` 里 `void bankQuery`），所以记忆**不会**被银行权威状态覆盖。
 *   这正是要显式声明的：不覆盖意味着"记忆说什么就是什么"，`state`/`valid_to`/保留期三道过滤仍在。
 * - **场景判不出来就不检索**（`unknown` → `planRoute` 返回空域）：记忆层刻意禁止
 *   "匹配不上就全查"，接线不替它放宽。
 */

import { mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { defineService } from '@bah/core'
import { MEMORY_CONTEXT_DECLARATION, NULL_BANK_QUERY, createMemoryLayer } from '@bah/memory-store'
import { SESSION_SERVICE, SYSTEM_PROMPT_SERVICE } from '@bah/runtime'
import { reasonOf } from '@bah/util'

import type { Listener, ServiceKey } from '@bah/core'
import type {
  IngestResult,
  MemoryLayer,
  Scene,
} from '@bah/memory-store'
import type { SessionApi } from '@bah/runtime'

import type { HostPlugin } from '../../plugin-manager/index.ts'
import { RUN_SERVICE } from '../boot.ts'
import { bootError, readString, rejectUnknownKeys } from '../config.ts'
import { SESSION_FILES } from './persistence.ts'

/** 本插件认的配置键。 */
const KEYS = ['dbPath', 'userId', 'sensitivityCeiling', 'maxK', 'sectionOrder'] as const

/** 记忆段在提示词装配里的序（`runtime.context`=30 与 `policy.approval`=40 之间）。 */
const DEFAULT_SECTION_ORDER = 35

/** 默认召回上限（与 `@bah/memory-store` 的 `DEFAULT_MAX_K` 同值，独立写死便于宿主调）。 */
const DEFAULT_MAX_K = 8

/** 个人客户权限矩阵上限。 */
const DEFAULT_CEILING = 2

export interface MemoryPluginSettings {
  /**
   * 记忆库文件名（**必须是单段文件名**，相对租户根解析）。
   *
   * 不许写 `sessions/memory.db` 或绝对路径：那是"相对谁"说不清的东西，
   * 两个租户配置同一个路径就会共库，而且**不会报错**（AR-08 的教训）。
   * 实际落点是 `<config.root>/<tenantId>/<dbPath>`。
   */
  readonly dbPath: string
  /** 记忆归属用户（与 `bank:tools.demoUserId` 同口径）。 */
  readonly userId: string
  readonly sensitivityCeiling?: number
  readonly maxK?: number
  readonly sectionOrder?: number
}

/** 记忆服务面（诊断 / 测试 / 后续模型可见工具都按它取用）。 */
export interface MemoryHandle {
  /** 最近一次检索渲染出的 `<memory>` 正文；未检索或零命中为 `undefined`。 */
  recall(): string | undefined
  /** 最近一次检索的路由码（`ROUTE_OK` / `EMPTY_UNKNOWN_SCENE` / `CROSS_SCENE_REFUSED`）。 */
  routeCode(): string | undefined
  /** 立刻把指定 turn 写完（演示与测试用；正常路径由 `turn/end` 触发）。 */
  ingestTurn(turn: number): Promise<IngestResult | undefined>
  /** 已写入的记忆条数（诊断用）。 */
  readonly layer: MemoryLayer
}

export const MEMORY_SERVICE: ServiceKey<MemoryHandle> = defineService<MemoryHandle>(
  'bah:memory',
)

/**
 * 场景粗判（关键词 → `Scene`）。
 *
 * 判不出来返回 `'unknown'`，`planRoute` 因此**不检索**——这是刻意的：
 * 记忆层的纪律是"不确定就不查"，用通配兜底会把错配以最高置信度呈现。
 *
 * **两级匹配**：先扫"强关键词"（动作/状态词），再扫"弱关键词"（`卡` 这类名词）。
 * 只做一级会出一个很蠢的错：「以后转账都用尾号8888的卡」同时含"转账"与"卡"，
 * 顺序稍偏就判成 `card`，于是这条偏好永远只在卡片场景被召回——而它明明是转账偏好。
 */
const STRONG_HINTS: readonly (readonly [Scene, RegExp])[] = [
  ['transfer', /转账|汇款|收款|打款|转给/],
  ['card', /挂失|解挂|销户|额度|积分|年费|丢了|丢失/],
  ['subscription', /订阅|续费|会员|自动扣款|自动扣费/],
  ['investment', /理财|基金|申购|赎回|净值|收益/],
  ['bills', /账单|缴费|水电|话费|还款日/],
]

/** 弱关键词：只在没有任何强关键词命中时才用。 */
const WEAK_HINTS: readonly (readonly [Scene, RegExp])[] = [['card', /卡/]]

export function sceneOf(text: string): Scene | 'unknown' {
  for (const [scene, pattern] of STRONG_HINTS) {
    if (pattern.test(text)) return scene
  }
  for (const [scene, pattern] of WEAK_HINTS) {
    if (pattern.test(text)) return scene
  }
  return 'unknown'
}

export const memoryPlugin: HostPlugin<MemoryPluginSettings> = {
  id: 'bah:memory-store',

  plugin: {
    name: 'bah:memory-store',
    inject: [RUN_SERVICE.id, SESSION_SERVICE.id, SYSTEM_PROMPT_SERVICE.id, SESSION_FILES.id],
    apply(ctx, config) {
      const run = ctx.get(RUN_SERVICE)
      const session = ctx.get(SESSION_SERVICE) as SessionApi
      const prompts = ctx.get(SYSTEM_PROMPT_SERVICE)
      const files = ctx.get(SESSION_FILES)
      // 租户唯一注入点：`RunContext.tenantId`。库文件 = 租户根 + 单段文件名，
      // 于是"这个租户的全部痕迹"是一次 `ls <config.root>/<tenant>` 就能列全的东西。
      const tenant = String(run.tenantId)
      // 租户根可能是第一次创建（persistence 是懒建目录的）：sqlite 不会替你 mkdir，
      // 不建就是 `unable to open database file`——新租户第一次启动必红。
      mkdirSync(files.root, { recursive: true })
      const dbPath = resolve(files.root, config.dbPath)

      const layer = createMemoryLayer({
        dbPath,
        now: run.now,
        ...(config.sensitivityCeiling === undefined
          ? {}
          : { sensitivityCeiling: config.sensitivityCeiling }),
      })
      // 注册即可逆：卸载插件即关连接，不留悬挂 sqlite 句柄
      ctx.effect(() => {
        layer.close()
      })

      const maxK = config.maxK ?? DEFAULT_MAX_K
      const sessionId = String(run.sessionId)
      const query = { tenant, user_id: config.userId, session_id: sessionId }

      let cached: string | undefined
      let cachedRoute: string | undefined

      // 影子核验端口：**未实现**，用包里共享的"永远 null"实现显式声明
      // "端口在、实现没在"（M3 接真实账本时换成 `createBankQuery`，本文件签名不变）。

      const handle: MemoryHandle = {
        recall: () => cached,
        routeCode: () => cachedRoute,
        ingestTurn: (turn) => ingestTurnOf(turn),
        layer,
      }
      ctx.provide(MEMORY_SERVICE, handle)

      /** 把某一轮的用户/助手文本写进记忆（返回 user 那条的结果，便于诊断）。 */
      async function ingestTurnOf(turn: number): Promise<IngestResult | undefined> {
        const events = session.events()
        const texts: { speaker: 'user' | 'agent'; text: string }[] = []
        let current = 0
        for (const event of events) {
          if (event.type === 'turn/start') {
            current = (event.data as { turn?: number }).turn ?? current
            continue
          }
          if (current !== turn) continue
          if (event.type === 'user/message') {
            // `runtime-context` 是我们自己注入的上下文，不是用户说的话
            if (event.data.source === 'runtime-context') continue
            texts.push({ speaker: 'user', text: textOf(event.data.content) })
          }
          if (event.type === 'assistant/message') {
            texts.push({ speaker: 'agent', text: textOf(event.data.content) })
          }
        }

        let first: IngestResult | undefined
        for (const item of texts) {
          if (item.text.trim().length === 0) continue
          const scene = sceneOf(item.text)
          const result = await layer.ingestTurn({
            ...query,
            turn_id: turn,
            // 写入面不能用 `unknown`（`Scene` 不含它）：判不出场景时落到主演示场景
            // `transfer`，代价是跨场景偏好会被打上 transfer 标签——读取面按场景路由，
            // 所以错的标签只会让它在别的场景里不被召回，不会造成错配。
            scene: scene === 'unknown' ? 'transfer' : scene,
            speaker: item.speaker,
            text: item.text,
          })
          first ??= result
        }
        return first
      }

      // ── 写入：turn 边界 ─────────────────────────────────────────────
      // 运行时只广播 `session/event`（`session/service.ts`），没有独立的 `turn/end` 主题；
      // 订错主题会让自动写入静默失效（只剩显式 `ingestTurn` 在写）。
      ctx.effect(
        ctx.events.on('session/event', (envelope) => {
          // 总线是全进程的：别的会话的 turn 号在这里没有意义（`session.events()` 只看本会话）
          if (String(envelope.session) !== String(session.sessionId)) return
          if (envelope.event.type !== 'turn/end') return
          const turn = envelope.event.data.turn
          // emit 监听器不能 await：失败必须落一条告警，不能变成静默的 unhandled rejection
          void ingestTurnOf(turn).catch((error: unknown) => {
            run.warn?.(`bah-memory: 第 ${String(turn)} 轮写入失败：${reasonOf(error)}`)
          })
        }),
      )

      // ── 读取：本轮第一步之前 ────────────────────────────────────────
      const recallListener: Listener<'agent/pre-step'> = async (payload, next) => {
        const input = payload as {
          messages?: readonly { source?: string; text?: string }[]
          step?: number
        }
        // `step !== 1` 直接放行：多步里重复注入会让同一段记忆在上下文里出现多次
        if (input.step !== undefined && input.step !== 1) return next(payload)

        // 只认 `source === 'user'`：`context`（工具纠正）与 `runtime-context`（上一轮注入的记忆本身）
        // 都不是用户这句话，拿它们判场景会把记忆越滚越偏。
        const lastUser = [...(input.messages ?? [])]
          .reverse()
          .find((message) => message.source === 'user')
        const scene = sceneOf(lastUser?.text ?? '')
        if (scene === 'unknown') {
          cached = undefined
          cachedRoute = 'EMPTY_UNKNOWN_SCENE'
          return next(payload)
        }

        try {
          const result = await layer.retrieveMemory(NULL_BANK_QUERY, { ...query, scene, maxK })
          cachedRoute = result.routeCode
          // 每行自带模板渲染（`renderedText`）+ 场景标签：模型看到的是"这条记忆属于哪个域"，
          // 而不是一坨没有出处的句子。
          const lines = result.memories.map((item) => `- [${item.sceneTag}] ${item.renderedText}`)
          cached = lines.length === 0 ? undefined : lines.join('\n')
        } catch (error) {
          // 记忆读失败不能拦住对话：清空缓存并告警（下一轮还会再试）
          cached = undefined
          cachedRoute = 'RECALL_FAILED'
          run.warn?.(`bah-memory: 召回失败：${reasonOf(error)}`)
        }
        return next(payload)
      }
      ctx.effect(ctx.events.on('agent/pre-step', recallListener))

      // ── 注入：提示词段（`target: 'context'`，按 reconcile 回收） ────
      ctx.effect(
        prompts.register({
          id: 'memory.context',
          order: config.sectionOrder ?? DEFAULT_SECTION_ORDER,
          target: 'context',
          render: () => {
            if (cached === undefined) return undefined
            // 声明放在块前：`<memory>` 永远是数据，不是指令（模型把记忆当命令执行就是违约）
            return `${MEMORY_CONTEXT_DECLARATION}\n\n<memory>\n${cached}\n</memory>`
          },
        }),
      )
    },
  },

  validate(config) {
    rejectUnknownKeys(config, [...KEYS], 'bah-memory')
    // dbPath / userId 两项**必填**：dbPath 缺省会让两个部署悄悄共用一个库；
    // userId 缺省会让所有人的记忆落进同一个桶——都是最难查的那类事故。
    // `tenant` 已从配置面删除：租户只来自 `--tenant` / `BAH_TENANT`（写了就是未知键，fail-loud）。
    const dbPath = requireString(config, 'dbPath')
    const userId = requireString(config, 'userId')
    if (dbPath.includes('/') || dbPath.includes('\\') || isAbsolute(dbPath)) {
      // 半开放（"有斜杠就当相对 cwd"）必然落成 sessions/sessions/demo/memory.db 这种既错又不报错的落点
      throw bootError(
        'invalid-config',
        `bah-memory: dbPath 必须是单段文件名（相对租户根解析），收到 ${JSON.stringify(dbPath)}`,
        { dbPath },
      )
    }
    if (dbPath === '.' || dbPath === '..') {
      throw bootError('invalid-config', `bah-memory: dbPath 不能是 ${JSON.stringify(dbPath)}`, { dbPath })
    }
    const ceiling = config['sensitivityCeiling']
    if (ceiling !== undefined && (typeof ceiling !== 'number' || ceiling < 0 || ceiling > 3)) {
      throw new Error('bah-memory: sensitivityCeiling 必须是 0–3 的数字')
    }
    const maxK = readPositiveInt(config['maxK'], 'maxK')
    const sectionOrder = readPositiveInt(config['sectionOrder'], 'sectionOrder')
    return {
      dbPath,
      userId,
      ...(ceiling === undefined ? {} : { sensitivityCeiling: ceiling }),
      ...(maxK === undefined ? {} : { maxK }),
      ...(sectionOrder === undefined ? {} : { sectionOrder }),
    }
  },
}

/** 必填字符串（`readString` 把"未写"与"空串"都归为 undefined，这里把未写变成错误）。 */
function requireString(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = readString(config, key, 'bah-memory')
  if (value === undefined) throw new Error(`bah-memory: ${key} 必填（无安全缺省值）`)
  return value
}

/** 可选正整数配置（缺省 undefined；非整数 / < 1 一律 fail-loud）。 */
function readPositiveInt(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`bah-memory: ${key} 必须是 ≥1 的整数（收到 ${JSON.stringify(value)}）`)
  }
  return value
}

/** 内容块数组 → 纯文本（记忆只吃文本；图片/文件块跳过）。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return ''
      if (!('type' in block) || block.type !== 'text') return ''
      return 'text' in block && typeof block.text === 'string' ? block.text : ''
    })
    .filter((text) => text.length > 0)
    .join('\n')
}

