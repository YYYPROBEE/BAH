/**
 * 封闭联合的穷尽性收尾（AGENTS.md 编码纪律 6）。
 *
 * 作用有两层：运行期在「新增了标签却忘了处理」时立刻炸；编译期在 `value` 不是 `never`
 * 时直接报错——后者才是主要价值，它把「漏一个分支」从线上事故变成编译失败。
 */

/** 走到这里说明判别标签已被穷尽；调用点一旦漏分支，编译期就会报错。 */
export function assertNever(value: never): never {
  throw new Error(`未覆盖的判别标签：${JSON.stringify(value)}`)
}
