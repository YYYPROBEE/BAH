/**
 * 每子进程的 overlay YAML。
 *
 * WHY 生成文件而不是 `--set`：CLI 的四层层序里 overlay 是**整块替换**语义
 * （每一行的 `config` 一出现就完全取代 base 的值）。用 `--set` 逐个改字段会
 * 变成"部分覆盖"，而部分覆盖的默认值回落是**隐式变配**——漏写一个字段就等于
 * 悄悄换了业务口径（例如 `heartbeatMs` 回落会把 SSE 心跳改成别的值）。
 *
 * 因此这里**重复 profile 里 `channel:im` 行的全部字段**（漏写即回落，属隐式变配）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CHILD_BIND_HOST } from './port.ts'

/** overlay 目录名（相对仓库根；`.tmp-im` 已在 .gitignore 的代表性位置之外，不入版本控制）。 */
export const OVERLAY_DIR = '.tmp-im'

/** 子进程入口页（与 profile 一致：IM 子进程不提供 Web UI）。 */
const STATIC_ROOT = 'apps/web'
const ENTRY = 'm.html'
const HEARTBEAT_MS = 15_000
const HANDOFF_SLA_MS = 180_000

/** overlay 入参（全部来自 profile 的 `channel:im` 行 + 本次分配的端口）。 */
export interface OverlayInput {
  readonly port: number
}

/**
 * 渲染 overlay YAML。
 *
 * 字段顺序固定（便于快照与人工 diff）；`host` 是常量 `127.0.0.1`，不接受注入。
 */
export function renderOverlay(input: OverlayInput): string {
  if (!Number.isInteger(input.port) || input.port <= 0) {
    throw new Error(`im-gateway: overlay 端口非法（${String(input.port)}）`)
  }
  return [
    '- id: channel:im',
    '  use: channel:im',
    '  config:',
    `    port: ${String(input.port)}`,
    `    host: ${CHILD_BIND_HOST}`,
    `    staticRoot: ${STATIC_ROOT}`,
    `    heartbeatMs: ${String(HEARTBEAT_MS)}`,
    `    entry: ${ENTRY}`,
    '    entries:',
    `      - ${ENTRY}`,
    '    handoff:',
    `      slaMs: ${String(HANDOFF_SLA_MS)}`,
    '',
  ].join('\n')
}

/** overlay 文件路径。 */
export function overlayPath(root: string, sessionKey: string): string {
  return join(root, OVERLAY_DIR, `${sessionKey}.yml`)
}

/**
 * 写一个 overlay 文件（返回绝对路径）。
 *
 * 文件名只用 `sessionKey`（`im-<16hex>`，已过 `assertImSessionId`）：
 * userId 不进路径（I-IM-05）。
 */
export async function writeOverlay(root: string, sessionKey: string, content: string): Promise<string> {
  const directory = join(root, OVERLAY_DIR)
  await mkdir(directory, { recursive: true })
  const path = overlayPath(root, sessionKey)
  await writeFile(path, content, 'utf8')
  return path
}
