/**
 * `verify-single-error-normalization` 的例外名单（门禁扩容 07 §2-5）。
 *
 * 只收**结构性例外**：worker 加载链上的文件（`safety/src/sandbox-runtime/worker.ts` 等）
 * 有"零包名 import"硬约束，物理上无法 import `@bah/util`，因此本地保留同名辅助函数。
 *
 * 纪律：
 * - 按"路径 + 函数名"精确匹配，不做目录级放行——放行一个目录，下一份复制就藏进去了。
 * - 每条必须写 why，且 why 必须指向那条硬约束（不是"暂时没空改"）。
 * - 非 worker 链的文件一律走修法（import 真源），不许进名单。
 */

export interface ErrorNormalizationExclusion {
  /** 相对仓库根的 posix 路径。 */
  readonly path: string
  /** 函数名（`errorCodeOf` / `reasonOf` / `messageOf`）。 */
  readonly name: string
  /** 为什么这里可以本地实现。 */
  readonly why: string
}

export const ERROR_NORMALIZATION_EXCLUSIONS: readonly ErrorNormalizationExclusion[] = [
  {
    path: 'packages/safety/src/sandbox-runtime/worker.ts',
    name: 'messageOf',
    why: 'worker 加载链零包名 import（Node 直载，不经 dist），无法 import @bah/util',
  },
]
