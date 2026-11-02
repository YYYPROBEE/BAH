#!/usr/bin/env tsx
/**
 * 门禁：帧闭合（声明—发射—投影—消费四点闭环）。
 *
 * 起因：计划卡（G7）在方案里"画出来了"，但帧联合里根本没有承载点，`project.ts` 也不产帧——
 * 按宪法 §3.2「只声明不发射 = 未完成」，这类断点必须变成**机械判据**：
 *
 * | 判据 | 内容 | 典型坏样本 |
 * |---|---|---|
 * | I-F1 | `frames.ts` 联合里的每个 kind 在 `project.ts` 有产出 | 只加类型不加投影 |
 * | I-F2 | 每个 kind 在桌面端 `apps/web/src`（非 mobile、非测试）有消费者 | 桌面端静默丢弃 |
 * | I-F3 | 每个 kind 在移动端有消费者，或在下面的 `MOBILE_IGNORES` 里显式登记理由 | 移动端白屏 |
 * | I-F4 | `docs/contracts/frame-table.md` 逐条列出该 kind | 契约文档与代码脱节 |
 *
 * 反例自测：`scripts/verify-frame-closure.test.ts` 用坏样本证明每条都能红。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 移动端**显式**不消费的帧（每条必须给理由；"忘了"不是理由）。 */
const MOBILE_IGNORES: Readonly<Record<string, string>> = {
  'handoff-warn': '移动端不展示 SLA 预警条（接管操作在桌面/坐席端）；未知帧兜底可，不是静默丢弃',
}

/** 一次检查的输入（纯数据；单测直接构造坏样本）。 */
export interface FrameClosureInput {
  /** `frames.ts` 的全文。 */
  readonly framesSource: string
  /** `project.ts` 的全文（投影层）。 */
  readonly projectSource: string
  /** 桌面端消费面：相对路径 → 全文。 */
  readonly desktopSources: Readonly<Record<string, string>>
  /** 移动端消费面：相对路径 → 全文。 */
  readonly mobileSources: Readonly<Record<string, string>>
  /** `docs/contracts/frame-table.md` 的全文（不存在传空串 → I-F4 全红）。 */
  readonly docSource: string
}

/** 取出 `WebFrame` 联合里的帧 kind（只认联合成员，`DagNode.kind='step'` 不在内）。 */
export function frameKindsOf(framesSource: string): string[] {
  // 行尾归一：仓库入库是 LF，但 `core.autocrlf=true` 的 Windows 工作树是 CRLF。
  // 下面两条正则都含 `\n\n` / `\n\}` 这类**跨行**锚点，CRLF 下必然匹配失败 →
  // 解析出 0 个 kind → 门禁把"环境行尾"误报成"帧联合消失"。
  // 这里只归一换行，不动任何内容语义。
  const source = framesSource.replace(/\r\n/g, '\n')
  const union = /export type WebFrame =([\s\S]*?)\n\n/.exec(source)
  if (union === null) return []
  const members = [...(union[1] ?? '').matchAll(/\|\s*([A-Za-z0-9_]+)/g)].map((match) => match[1] as string)
  const kinds: string[] = []
  for (const member of members) {
    const body = new RegExp(`export interface ${member} \\{([\\s\\S]*?)\\n\\}`).exec(source)
    if (body === null) continue
    const kind = /readonly kind: '([a-z-]+)'/.exec(body[1] ?? '')
    if (kind !== null) kinds.push(kind[1] as string)
  }
  return [...new Set(kinds)]
}

function containsKind(sources: Readonly<Record<string, string>>, kind: string): boolean {
  const needle = `'${kind}'`
  return Object.values(sources).some((text) => text.includes(needle))
}

/**
 * 纯检查：把四条判据跑在一个数据快照上（不做任何文件 IO）。
 *
 * @returns 违规项（每条带 kind 与判据号）
 */
export function checkFrameClosure(input: FrameClosureInput): GateResult {
  const kinds = frameKindsOf(input.framesSource)
  const findings: string[] = []
  if (kinds.length === 0) {
    findings.push('frames.ts 里解析不到任何帧 kind —— "没扫到"不能当"通过"')
    return { ok: false, findings, notes: [] }
  }

  for (const kind of kinds) {
    if (!input.projectSource.includes(`kind: '${kind}'`)) {
      findings.push(`I-F1 frames.ts 声明了 '${kind}'，但 project.ts 没有产出分支`)
    }
    if (!containsKind(input.desktopSources, kind)) {
      findings.push(`I-F2 '${kind}' 在桌面端没有消费者（会被渲染成未知帧/静默丢弃）`)
    }
    if (!containsKind(input.mobileSources, kind) && MOBILE_IGNORES[kind] === undefined) {
      findings.push(`I-F3 '${kind}' 在移动端没有消费者，也没有在 MOBILE_IGNORES 里登记理由`)
    }
    if (!input.docSource.includes(`\`${kind}\``)) {
      findings.push(`I-F4 docs/contracts/frame-table.md 没有列出 '${kind}'`)
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    notes: [`帧 kind ${String(kinds.length)} 个：${kinds.join(' / ')}`],
  }
}

function readSources(root: string, subdirs: readonly string[]): Record<string, string> {
  const sources: Record<string, string> = {}
  for (const file of walk(root, subdirs, (name) => /\.(?:js|ts)$/.test(name) && !name.endsWith('.test.js') && !name.endsWith('.test.ts'))) {
    sources[file] = readFileSync(file, 'utf8')
  }
  return sources
}

const gate: Gate = {
  name: 'frame-closure',

  async run(root): Promise<GateResult> {
    const read = (path: string): string => {
      try {
        return readFileSync(join(root, path), 'utf8')
      } catch {
        return ''
      }
    }
    return checkFrameClosure({
      framesSource: read('packages/channels/src/web/frames.ts'),
      // 投影层有两个文件：主体在 project.ts，`audit` 帧由 audit.ts 产出后由 apply() 并入
      projectSource:
        read('packages/channels/src/web/project.ts') + read('packages/channels/src/web/audit.ts'),
      desktopSources: readSources(root, ['apps/web/src/views', 'apps/web/src']),
      mobileSources: readSources(root, ['apps/web/src/mobile']),
      docSource: read('docs/contracts/frame-table.md'),
    })
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
