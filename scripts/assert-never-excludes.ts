/**
 * `verify-assert-never` 的例外名单（门禁扩容 07 §2-1）。
 *
 * 纪律：
 * - 只收**开放类型**上的 switch（对 `string` / `number` 等无法穷尽的判别值做分支），
 *   这类 switch 加 `assertNever` 在类型上不成立（值域不是 `never`），加 `default` 又会
 *   把"未识别的输入"静默吞成默认分支。
 * - 不收"我懒得补"的封闭联合。封闭联合补 `assertNever` 是零成本且能防新增成员漏分支。
 * - 每条必须写 `line` 与 `why`：`line` 是 switch 关键字所在行（行号漂移即失效，门禁会
 *   把该处重新判为违规——名单宁可失效也不许静默失配）。
 */

export interface AssertNeverExclusion {
  /** 相对仓库根的 posix 路径。 */
  readonly path: string
  /** switch 关键字所在行（从 1 开始）。 */
  readonly line: number
  /** 为什么这不是封闭联合。 */
  readonly why: string
}

export const ASSERT_NEVER_EXCLUSIONS: readonly AssertNeverExclusion[] = []
