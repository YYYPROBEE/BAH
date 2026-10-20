/**
 * 会话持久化抽象接口（施工单 03 §1.5）。
 *
 * 纪律：**接口不承诺任何"改写历史"的能力**——append-only 是不变量，
 * 所以这里没有 update / delete / rename（T-SESS-008 用编译期 + 单测双重保证）。
 *
 * 分代命名：`session.jsonl`（第 0 代）→ 后续 `session.vN.jsonl`（N 为代数）。
 * 提交后的分代文件**永不改名 / 替换 / 删除**；写入式 open 只会以新代号"排他发布后继"。
 */

import type { SessionEvent, SessionId } from '@bah/core'

/** 文件头（会话元数据；第一个 JSONL 行）。 */
export interface SessionHeader {
  readonly sessionId: SessionId
  /** 逻辑格式版本；reader 遇到比自己新的版本必须拒绝打开。 */
  readonly formatVersion: number
  /** 创建时刻（epoch ms）。 */
  readonly createdAt: number
  /** 业务元数据（渠道、场景、父会话等，落账后不可改）。 */
  readonly meta?: Readonly<Record<string, unknown>>
}

/** `stat` 的结果：只来自 header（不解码 body）。 */
export interface StatInfo {
  /** 命中的分代文件路径。 */
  readonly path: string
  readonly sessionId: SessionId
  readonly formatVersion: number
  /** 代数（`session.jsonl` = 0）。 */
  readonly generation: number
  /** 文件字节数。 */
  readonly bytes: number
}

/** `list` 的单项：每个会话只报最高规范代。 */
export interface SessionInfo extends StatInfo {
  /** 会话目录（`list(root)` 扫描到的子目录）。 */
  readonly dir: string
}

/** 打开模式：读取式不发布后继；写入式在格式升级时排他发布新代。 */
export type OpenMode = 'read' | 'write'

/** `open` 的选项。 */
export interface OpenOptions {
  readonly mode?: OpenMode
}

/** 一次打开的文件句柄。 */
export interface SessionHandle {
  readonly header: SessionHeader
  readonly path: string
  readonly generation: number
  /** 是否可追加（读取式 open 为 `false`）。 */
  readonly writable: boolean
  /** 已读到/写入的全部事件（只读视图）。 */
  events(): readonly SessionEvent[]
  /** 追加一条已分配 `seq` 的事件（不写头、不分配 seq——那是会话层的事）。 */
  append(event: SessionEvent): void
  /** 落盘（fsync）。 */
  flush(): Promise<void>
  /** 释放底层句柄（可选：读取式 / 无 fd 的实现可不提供）。 */
  close?(): void
}

/** 会话持久化后端。 */
export interface SessionPersistence {
  /** 新建一个会话（写第 0 代文件 + header）。 */
  create(dir: string, sessionId: SessionId, options?: { readonly meta?: Readonly<Record<string, unknown>>; readonly now?: number }): SessionHandle
  /** 打开目录里最高规范代的会话。 */
  open(dir: string, options?: OpenOptions): SessionHandle
  /** 只扫 header 取元数据（不解码 body）。 */
  stat(dir: string): StatInfo
  /** 列出根目录下每个会话的最高规范代。 */
  list(root: string): SessionInfo[]
  /** 显式落盘。 */
  flush(handle: SessionHandle): Promise<void>
}
