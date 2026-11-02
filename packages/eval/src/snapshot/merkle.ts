/**
 * Merkle 包含证明（W15）：给"抽样 10% 可离线验证"一条纯函数实现。
 *
 * 设计口径：
 * - 叶子 = `sha256(JSON.stringify(value))`（调用方给值，本模块不解释业务语义）；
 * - 内部节点 = `sha256(left + right)`；奇数层把最后一个节点复制一份（Bitcoin 风格）；
 * - 证明只带 `{index, leaf, root, siblings[]}`，验证不需要任何进程内状态。
 */

import { createHash } from 'node:crypto'

/** 一个兄弟节点（在证明路径上的位置）。 */
export interface MerkleSibling {
  readonly hash: string
  readonly side: 'left' | 'right'
}

/** 包含证明。 */
export interface MerkleProof {
  readonly index: number
  readonly total: number
  readonly leaf: string
  readonly root: string
  readonly siblings: readonly MerkleSibling[]
}

/** sha256（hex）。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 叶子哈希（对象按 JSON 序列化；调用方负责稳定键序）。 */
export function leafHash(value: unknown): string {
  return sha256Hex(JSON.stringify(value))
}

/** 计算 Merkle 根（空数组返回空串根，调用方应拒绝空集）。 */
export function merkleRoot(leaves: readonly string[]): string {
  if (leaves.length === 0) return ''
  return buildLevels(leaves).at(-1)?.[0] ?? ''
}

/** 生成第 `index` 个叶子的包含证明。 */
export function merkleProof(leaves: readonly string[], index: number): MerkleProof {
  if (leaves.length === 0) throw new Error('merkle: 空集合没有包含证明')
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`merkle: 下标越界 ${String(index)}（共 ${String(leaves.length)} 个叶子）`)
  }
  const levels = buildLevels(leaves)
  const siblings: MerkleSibling[] = []
  let cursor = index
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level] ?? []
    const isRight = cursor % 2 === 1
    const siblingIndex = isRight ? cursor - 1 : cursor + 1
    const sibling = nodes[siblingIndex] ?? nodes[cursor]
    if (sibling === undefined) throw new Error('merkle: 层级构造异常')
    siblings.push({ hash: sibling, side: isRight ? 'left' : 'right' })
    cursor = Math.floor(cursor / 2)
  }
  return {
    index,
    total: leaves.length,
    leaf: leaves[index] as string,
    root: levels.at(-1)?.[0] ?? '',
    siblings,
  }
}

/** 验证包含证明（只依赖证明本身，不需要原数组/类实例）。 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  let current = proof.leaf
  for (const sibling of proof.siblings) {
    current =
      sibling.side === 'left'
        ? sha256Hex(`${sibling.hash}${current}`)
        : sha256Hex(`${current}${sibling.hash}`)
  }
  return current === proof.root
}

/**
 * 确定性抽样：按步长 10 取一个（10%）；至少返回 1 个。
 *
 * 为什么不用随机：CI 里"这次抽到坏样本、下次没抽到"会让门禁闪烁；
 * 抽样证明的价值在于"任意抽样可独立验证"，不在于随机性本身。
 */
export function sampleProofs(leaves: readonly string[], ratio = 0.1): readonly MerkleProof[] {
  if (leaves.length === 0) return []
  const safeRatio = Math.min(1, Math.max(0.01, ratio))
  const step = Math.max(1, Math.ceil(1 / safeRatio))
  const indices: number[] = []
  for (let index = 0; index < leaves.length; index += step) indices.push(index)
  if (indices.length === 0) indices.push(0)
  return indices.map((index) => merkleProof(leaves, index))
}

function buildLevels(leaves: readonly string[]): string[][] {
  const levels: string[][] = [[...leaves]]
  let current = [...leaves]
  while (current.length > 1) {
    const next: string[] = []
    for (let index = 0; index < current.length; index += 2) {
      const left = current[index] as string
      const right = current[index + 1] ?? left
      next.push(sha256Hex(`${left}${right}`))
    }
    levels.push(next)
    current = next
  }
  return levels
}
