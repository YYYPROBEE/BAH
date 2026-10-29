/**
 * todo 平面（04 单 §3.3.2）：plan 事件的**投影**，不是第二个真相源。
 *
 * 如果 todo 有自己的事件键，就出现了两个账本：plan 说节点 `succeeded`、todo 说条目还
 * `running`，两者必然在某个时序下打架。所以本模块只做派生：同一事件序列，任何时候
 * 重放都得到同一清单。
 */

import type { PlanNodeState } from '../plan/types.ts'

/** 与 `@bah/channels` 的 `FrameTone` 同值域（这里不 import 渠道包，凭结构同构）。 */
export type TodoTone = 'default' | 'muted' | 'success' | 'warning' | 'danger'

/** 条目来源：plan 派生 vs 模型侧 `todo_write` 写入。 */
export type TodoSource = 'plan' | 'model'

export interface TodoEntry {
  /** plan 节点 id（派生 todo 必填）。 */
  readonly nodeId: string
  readonly source: TodoSource
  /** 可见文案；v1 派生条目只带节点 id，美化由投影层结合节点工具名生成。 */
  readonly text: string
  readonly state: PlanNodeState
  /** 同屏排序用（plan 来源 = 拓扑序号；model 来源 = 写入序 + 1000 偏移，见 §3.3.3 合并规则）。 */
  readonly ordinal: number
}

/**
 * 9 态 → 文案 / 色调 / 是否完成（**唯一映射表**，投影层不再各写一份）。
 *
 * `ready` 是引擎运行时的内部态、事件流无痕：派生清单不该出现它，映射仍给一条
 * 保守值（与 pending 同档），避免回放遇到它时崩——但不为了好看把它往帧上写。
 */
export const TODO_STATE_VIEW: Readonly<
  Record<PlanNodeState, { readonly text: string; readonly tone: TodoTone; readonly done: boolean }>
> = {
  pending: { text: '排队中', tone: 'default', done: false },
  ready: { text: '待执行', tone: 'default', done: false },
  running: { text: '执行中', tone: 'default', done: false },
  succeeded: { text: '已完成', tone: 'success', done: true },
  failed: { text: '失败', tone: 'danger', done: false },
  skipped: { text: '已跳过（可选）', tone: 'muted', done: true },
  blocked: { text: '被上游阻塞', tone: 'warning', done: false },
  cancelled: { text: '已取消', tone: 'muted', done: true },
  incident: { text: '上游不可用', tone: 'danger', done: false },
}

export const TODO_WRITE_TOOL = 'todo_write'

/** 模型侧清单：**全量覆写**（每次传完整清单），产出即现状，重放即重建。 */
export interface TodoWriteItem {
  readonly text: string
  readonly done?: boolean
}

export interface TodoWriteArgs {
  readonly items: readonly TodoWriteItem[]
}

export interface TodoWriteEntry {
  readonly text: string
  readonly done: boolean
  readonly writtenAt: number
}

export interface TodoWriteResult {
  readonly items: readonly TodoWriteEntry[]
}
