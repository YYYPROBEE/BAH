/**
 * 金库（程序性记忆）状态机（施工文档 §6）。
 *
 * ```
 * pending_confirm --确认--> active --变更--> retired + 新 pending(v+1)
 * ```
 *
 * 核心纪律：**程序记忆永不单步直通**。用户说"以后转账前先给我看费率"时，系统记下的是
 * 一条 `pending_confirm`，不是一条生效规则；只有用户在**后续轮次**明确确认，它才变
 * `active`。这条纪律对应用户记忆里的 PMPA 实证：一次性的说服成功率远高于跨会话持续
 * 攻击，所以"跨会话生效"这件事必须有两道人工闸。
 *
 * 事件出口：同步回调注册表（`onProceduralChange`）。没有底座通知通道时降级 console +
 * JSONL 落盘——落盘在 M3 与 AccessLog 一并接入，本轮只保证事件在进程内可观测。
 */

import { BahError } from '@bah/util'

import { proceduralId } from '../ids.ts'

import type { MemoryStore } from '../store/index.ts'
import type {
  ConfirmInput,
  ConfirmationRecord,
  MemoryEvent,
  ProceduralUnit,
  Provenance,
  VaultCandidate,
} from '../types.ts'

/**
 * 确认意图识别。
 *
 * **偏离文档 §6**：文档写「`/^(确认|是的|可以|没问题|我确认)/` 或含"确认"」。只保留前缀
 * 匹配，去掉「含确认」——"含确认"会把「不用确认」判成确认，而那正是 G4 要拦的句子。
 * 宁可让用户多确认一次，也不能把否定句读成肯定句（已在批次汇报中登记）。
 */
const CONFIRM_INTENT = /^(?:确认|是的|可以|没问题|我确认|同意|好的|行)/

export interface VaultContext {
  readonly tenant: string
  readonly userId: string
  readonly sessionId: string
  readonly provenance: Provenance
}

export class ProceduralVault {
  private readonly store: MemoryStore
  private readonly now: () => number
  private readonly listeners = new Set<(event: MemoryEvent) => void>()

  constructor(store: MemoryStore, now: () => number) {
    this.store = store
    this.now = now
  }

  /** 订阅状态迁移事件；返回 disposer（注册即可逆）。 */
  onChange(cb: (event: MemoryEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /**
   * 派发到回调注册表。
   *
   * 方法名刻意**不叫 `emit`**：仓库的 `event-modes` 门禁把 `.emit(` 一律视为事件总线派发，
   * 要求事件名是字面量才能静态校验。这里派发的是本模块自有的 `MemoryEvent` 对象，
   * 与总线无关，叫 `notify` 既准确也不触发误判。
   */
  private notify(event: MemoryEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private transition(unit: ProceduralUnit, to: ProceduralUnit['state']): ProceduralUnit {
    const next: ProceduralUnit = { ...unit, state: to }
    this.store.saveProcedural(next)
    this.notify({
      type: 'procedural_change',
      detail: { procId: unit.procId, from: unit.state, to },
      ts: new Date(this.now()).toISOString(),
    })
    return next
  }

  /**
   * 提交一条程序性候选。
   *
   * @returns 新建或复用的 `proc_id`；语义完全相同的候选不重复建行（否则确认一次会激活多行）
   */
  submit(candidate: VaultCandidate, context: VaultContext): string {
    // 结构防御就放在入口：trigger 或 action 为空的程序性记录，激活后是一句无法执行的话。
    assertVaultCandidate(candidate)
    const units = this.store.listProcedural(context.tenant, context.userId)
    const current = units.find((unit) => unit.state === 'active' || unit.state === 'pending_confirm')
    const ts = new Date(this.now()).toISOString()

    if (current !== undefined) {
      const sameSemantics =
        current.triggerDesc === candidate.triggerDesc && current.actionDesc === candidate.actionDesc
      // 同语义的重复陈述不再建行：它是"用户又提了一次"，不是"规则变了"。
      if (sameSemantics) return current.procId

      // 变更是**先停旧再起新**，顺序不能反：反了会出现两条同时 active 的窗口。
      const retired = this.transition(current, 'retired')
      const next: ProceduralUnit = {
        procId: proceduralId(this.now()),
        tenant: context.tenant,
        userId: context.userId,
        triggerDesc: candidate.triggerDesc,
        actionDesc: candidate.actionDesc,
        state: 'pending_confirm',
        version: retired.version + 1,
        confirmations: [],
        provenance: context.provenance,
        createdAt: ts,
      }
      this.store.insertProcedural(next)
      this.notify({
        type: 'procedural_change',
        detail: { procId: next.procId, from: 'none', to: 'pending_confirm', version: next.version },
        ts,
      })
      return next.procId
    }

    const created: ProceduralUnit = {
      procId: proceduralId(this.now()),
      tenant: context.tenant,
      userId: context.userId,
      triggerDesc: candidate.triggerDesc,
      actionDesc: candidate.actionDesc,
      state: 'pending_confirm',
      version: 1,
      confirmations: [],
      provenance: context.provenance,
      createdAt: ts,
    }
    this.store.insertProcedural(created)
    this.notify({
      type: 'procedural_change',
      detail: { procId: created.procId, from: 'none', to: 'pending_confirm', version: 1 },
      ts,
    })
    return created.procId
  }

  /**
   * 尝试确认本会话内的 pending 记录。
   *
   * 只认**本用户**的 pending：跨用户确认是越权；跨会话确认也允许（跨会话记忆层本就
   * 要跨会话生效），但确认动作必须发生在用户主动说话的那一轮，由 pipeline 传入。
   */
  confirm(input: ConfirmInput): { confirmed: string[] } {
    const matched = input.text.match(CONFIRM_INTENT)
    if (matched === null) return { confirmed: [] }

    const pending = this.store
      .listProcedural(input.tenant, input.user_id)
      .filter((unit) => unit.state === 'pending_confirm')
    if (pending.length === 0) return { confirmed: [] }

    const ts = new Date(this.now()).toISOString()
    const confirmed: string[] = []
    for (const unit of pending) {
      const record: ConfirmationRecord = {
        session_id: input.session_id,
        turn_id: input.turn_id,
        ts,
        matched_phrase: matched[0],
      }
      const next: ProceduralUnit = {
        ...unit,
        state: 'active',
        confirmations: [...unit.confirmations, record],
      }
      this.store.saveProcedural(next)
      this.notify({
        type: 'procedural_change',
        detail: { procId: unit.procId, from: 'pending_confirm', to: 'active', matched, ts },
        ts,
      })
      confirmed.push(unit.procId)
    }
    return { confirmed }
  }

  /**
   * 校验"零静默 active"：任何 active 行必须有 ≥1 条 confirmation。
   *
   * DDL 里写不了这个 CHECK（跨列 + 数组成分），所以由代码在演示前自检。
   */
  auditActiveWithoutConfirmation(tenant: string, userId: string): string[] {
    return this.store
      .listProcedural(tenant, userId)
      .filter((unit) => unit.state === 'active' && unit.confirmations.length === 0)
      .map((unit) => unit.procId)
  }
}

/** 金库写入前的防御：`trigger`/`action` 任一为空都属结构缺陷。 */
export function assertVaultCandidate(candidate: VaultCandidate): void {
  if (candidate.triggerDesc.length === 0 || candidate.actionDesc.length === 0) {
    throw new BahError(
      'vault-candidate-incomplete',
      'bah-memory: vault-candidate-incomplete: 程序性候选缺少 trigger 或 action',
      { trigger: candidate.triggerDesc, action: candidate.actionDesc },
    )
  }
}
