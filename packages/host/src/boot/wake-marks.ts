/**
 * 唤醒执行器的**一次性标记**（ADR-0010）。
 *
 * ## 它解决什么问题
 *
 * 票据上的 `authorization: {kind:'window', ref, digest}` 只是一张**声明**。
 * 若代签只看这个字段，那么任何能往 `tools/pre-execute` 的 ask 判决里塞一份
 * `authorization` 的路径（多加一个监听器、多写一个内置工具）都能让系统"代签"。
 *
 * 所以真正的判据是：**这次 run 是不是唤醒执行器开的**。
 * 唤醒时在 `bah:run` 的标记账本上开一个条目（`windowId + planId + digest + 预算`），
 * run 结束即撤销；核验端口必须同时看到「条目在」与「票据 ref 指向它」才放行。
 *
 * ## 为什么放在 `RunContext` 而不是插件私有变量
 *
 * 判据必须**跨插件可见**：写标记的是 `plan:dag`，读标记的是 `interaction:approval`
 * 创建的窗口应答者（经 `plan:window-signer`）。放在 `RunContext` 上，
 * 一次进程一套标记，随 `boot()` 的生命周期生灭，不需要额外服务键或全局单例。
 *
 * ## 为什么不是"可写的布尔开关"
 *
 * `open()` 只接受完整凭据（含摘要与预算），`get()` 只返回只读视图 + 一个
 * 「扣预算」的动作。没有任何 API 能把标记改成"放行"：判定规则在
 * `@bah/runtime` 的 `decideWindowSign`，这里只负责记账。
 *
 * 纪律：只由唤醒执行器 `open()`；不读时钟、不读随机（时间由调用方给）。
 */

import { BahError } from '@bah/util'

/** 一次唤醒 run 的凭据（只增不改）。 */
export interface WakeGrant {
  /** 窗口 id（= 票据 `authorization.ref`）。 */
  readonly windowId: string
  /** 计划 id（与窗口条目、票据摘要三者必须一致）。 */
  readonly planId: string
  /** 唤醒时刻算出的判决摘要（= 票据 `authorization.digest`）。 */
  readonly digest: string
  /** 本次 run 的预算硬顶（分）。 */
  readonly budgetCents: number
  /** 武装时刻的强验证时刻（红级代签的必要条件）。 */
  readonly verifiedAt?: number
  /** 窗口过期时刻（红级预授权必须落在它之内）。 */
  readonly expiresAt?: number
}

/** 标记的只读视图 + 唯一的记账动作。 */
export interface WakeMark extends WakeGrant {
  /** 本次 run 已被代签的金额（分）。 */
  readonly spentCents: number
  /**
   * 扣减预算（同步原子）。
   *
   * @returns `false` = 余额不足，**调用方必须不放行**（这里不抛错：
   *   "超额"是正常判定结果，不是程序错误）
   */
  take(cents: number): boolean
}

/** `RunContext.wakeMarks` 的形状。 */
export interface WakeMarkStore {
  /**
   * 开一个标记；返回撤销句柄（`finally` 里必须调用）。
   *
   * @throws `BahError('wake-mark-duplicate')` 同一窗口已有一个在途 run
   *   （同一窗口并发唤醒 = 两笔扣款抢同一份预算，必须炸而不是排队）
   */
  open(grant: WakeGrant): () => void
  /** 取当前在途标记（没有 = 这次 run 不是唤醒执行器开的）。 */
  get(windowId: string): WakeMark | undefined
}

interface Entry {
  readonly grant: WakeGrant
  spentCents: number
  readonly mark: WakeMark
}

/** 造一个空的标记账本（CLI 与测试夹具各造一个，不共享全局状态）。 */
export function createWakeMarkStore(): WakeMarkStore {
  const entries = new Map<string, Entry>()

  return {
    open(grant) {
      if (entries.has(grant.windowId)) {
        throw new BahError(
          'wake-mark-duplicate',
          `授权窗口 ${grant.windowId} 已有在途唤醒（同一窗口不许并发执行）`,
          { windowId: grant.windowId, planId: grant.planId },
        )
      }
      const entry: Entry = {
        grant,
        spentCents: 0,
        mark: {
          ...grant,
          get spentCents() {
            return entry.spentCents
          },
          take(cents) {
            if (!Number.isInteger(cents) || cents < 0) return false
            if (entry.spentCents + cents > grant.budgetCents) return false
            entry.spentCents += cents
            return true
          },
        },
      }
      entries.set(grant.windowId, entry)
      return () => {
        if (entries.get(grant.windowId) === entry) entries.delete(grant.windowId)
      }
    },
    get(windowId) {
      return entries.get(windowId)?.mark
    },
  }
}
