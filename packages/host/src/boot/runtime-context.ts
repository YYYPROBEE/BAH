/**
 * 运行时上下文解析器：把 profile 的静态画像与银行槽位合并成一个视图。
 *
 * 三层职责（不要混）：
 * - **runtime**（`agent-loop/agent.ts`）只负责 await / abort 检查 / 落 `context/slots` 事件；
 * - **本文件（host 策略层）**负责"静态 + provider 合并、状态、姓名一致性、缺 port 判定"；
 *   它**不读核心**、**不做金额格式化**（那是 bank 适配器的事）；
 * - **bank 适配器**负责"怎么读"。
 *
 * 合并纪律：
 * 1. `slots.source=none`：原样返回静态视图（**同一个对象**、不写 `meta`），旧输出逐字不变；
 * 2. `slots.source=bank`：
 *    - unbound → 只保留静态 notes + `meta(unbound)`；不显示姓名/账户（未验证的姓名 = 主体错位）；
 *    - degraded → 只保留静态 notes + `meta(degraded, code)`；
 *    - ok → 权威姓名 + 静态 `level` + 账户/流水 + (provider notes + 静态 notes)；
 * 3. 静态 `accounts` / `recentTransactions` 与 bank 模式互斥（boot 已校验，这里再兜一次）；
 * 4. 静态 `user.name` 与权威姓名不一致 → `slots-user-mismatch`（fail-loud，不静默）。
 *
 * 错误模型：`slots-source-missing` / `slots-user-mismatch` / `slots-empty-resolution` 是
 * **配置或适配器 bug**，抛出让 turn failed；业务失败（超时/读不到/未绑定/熔断）由适配器
 * 返回 `status`，这里合并成降级视图，**不抛**。
 */

import { BahError } from '@bah/util'

import { logJson } from './plugins/log.ts'

import type {
  RuntimeContextInvocation,
  RuntimeContextSource,
  RuntimeContextView,
} from '@bah/runtime'

/** 解析器装配参数。 */
export interface RuntimeContextResolverOptions {
  /** profile 里的静态画像（`core:agent.runtimeContext`）。 */
  readonly staticView?: RuntimeContextView
  /** 开关：`none` = 只用静态；`bank` = 每 step 现读核心。 */
  readonly slots: { readonly source: 'none' | 'bank' }
  /**
   * 每 step 现取端口：允许 `bank:tools` 排在 `core:agent` 之后 apply。
   *
   * 缺服务是合法的"这一行没装"（返回 undefined）；但**配置说要 bank 却没装**属于装配错误，
   * 必须失败（`slots-source-missing`），不许静默退回静态画像。
   */
  readonly getSource: () => RuntimeContextSource | undefined
}

/** 解析器：每个 step 调一次（可异步）。 */
export type RuntimeContextResolver = (
  invocation: RuntimeContextInvocation,
) => Promise<RuntimeContextView | undefined>

/** 建解析器（纯装配，无 I/O）。 */
export function createRuntimeContextResolver(
  options: RuntimeContextResolverOptions,
): RuntimeContextResolver {
  return async (invocation) => {
    // 1. 开关关着：原样返回静态视图（同一对象；不写 meta —— 旧快照的根据）
    if (options.slots.source === 'none') return options.staticView

    const staticView = options.staticView
    // 2. 兜底互斥：boot 已挡一次，这里挡"绕过 validate 直接构造"的路径
    if (staticView?.accounts !== undefined || staticView?.recentTransactions !== undefined) {
      throw new BahError(
        'invalid-config',
        'runtime-context: slots.source=bank 时不得再写静态 accounts / recentTransactions（invalid-config；两个真相源）',
      )
    }
    const staticNotes = staticView?.notes ?? []

    // 3. 懒取端口（每 step）：没有 bank:tools 的 profile 也能起，但配置说 bank 就必须有
    const source = options.getSource()
    if (source === undefined) {
      throw new BahError(
        'slots-source-missing',
        'runtime-context: slots.source=bank 但没有装配 runtime:context-source（slots-source-missing；缺 bank:tools？）',
      )
    }

    // 4. 解析（业务失败是值，不抛）
    const resolution = await source.resolve(invocation)
    // 5. await 之后复查取消：端口可能忽略 abort 直接返回
    if (invocation.signal.aborted) return undefined

    if (resolution.status === 'unbound') {
      return {
        ...(staticNotes.length === 0 ? {} : { notes: staticNotes }),
        meta: { source: 'bank', status: 'unbound' },
      }
    }

    if (resolution.status === 'degraded') {
      // 熔断由 bank 侧记（带 failures）；aborted 是正常取消不记；
      // 其余降级在这里记一条结构化 warn（只有理由码与 source，不带姓名/尾号/错误原文）。
      //
      // 字段名用 `reason` 而不是 `code`：`logJson` 的 `code` 是**事件名**
      // （`context/slots-degraded`），同名字段会被后面的 spread 覆盖，等于把事件名写丢。
      if (resolution.code !== 'slots-aborted' && resolution.code !== 'slots-circuit-open') {
        logJson('warn', 'context/slots-degraded', {
          reason: resolution.code ?? 'unknown',
          source: 'bank',
        })
      }
      return {
        ...(staticNotes.length === 0 ? {} : { notes: staticNotes }),
        meta: {
          source: 'bank',
          status: 'degraded',
          ...(resolution.code === undefined ? {} : { code: resolution.code }),
        },
      }
    }

    // 6. ok 必须带视图；空视图是适配器 bug（会渲染出"姓名未提供 + 非指令头"两行噪音）
    const view = resolution.view
    if (view === undefined) {
      throw new BahError(
        'slots-empty-resolution',
        'runtime-context: 解析器返回 ok 但没有 view（slots-empty-resolution；适配器 bug）',
      )
    }
    const accountCount = view.accounts?.length ?? 0
    const transactionCount = view.recentTransactions?.length ?? 0
    const noteCount = view.notes?.length ?? 0
    if (view.user?.name === undefined && accountCount === 0 && transactionCount === 0 && noteCount === 0) {
      throw new BahError(
        'slots-empty-resolution',
        'runtime-context: 解析器返回 ok 但没有任何可展示内容（slots-empty-resolution；适配器 bug）',
      )
    }

    // 7. 姓名一致性：静态写死了"张三"、账本主体是"李四" → 主体错位，宁可红
    const providerName = view.user?.name
    const staticName = staticView?.user?.name?.trim()
    if (providerName !== undefined && staticName !== undefined && providerName !== staticName) {
      // 错误信息不带姓名（会进日志/会话日志）；只给会话与字段名
      throw new BahError(
        'slots-user-mismatch',
        'runtime-context: 静态画像姓名与权威姓名不一致（slots-user-mismatch；提示词主体会错位，拒绝启动该 turn）',
        { sessionId: invocation.sessionId },
      )
    }

    // 8. 合并：姓名取权威，等级取静态（展示标签）
    const level = staticView?.user?.level
    const user =
      providerName === undefined && level === undefined
        ? undefined
        : {
            ...(providerName === undefined ? {} : { name: providerName }),
            ...(level === undefined ? {} : { level }),
          }

    return {
      ...(user === undefined ? {} : { user }),
      ...(view.accounts === undefined ? {} : { accounts: view.accounts }),
      ...(view.recentTransactions === undefined
        ? {}
        : { recentTransactions: view.recentTransactions }),
      // 顺序是语义：provider 的 notes 在前，静态 disclaimer 永远是最后一条
      ...(view.notes === undefined && staticNotes.length === 0
        ? {}
        : { notes: [...(view.notes ?? []), ...staticNotes] }),
      meta: {
        source: 'bank',
        status: 'ok',
        ...(resolution.asOfText === undefined ? {} : { asOfText: resolution.asOfText }),
      },
    }
  }
}
