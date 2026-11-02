/* 门禁自测夹具：正夹具（故意合法），永不被生产代码 import */
// 头注释里提到 Date.now 与 Math.random 不应触发（AST 不被注释骗）

export interface Ctx {
  readonly today: string
}

/** 注入钟 + 带参 new Date(injectedMs) 是合法形态。 */
export function isRecent(ms: number, ctx: Ctx): string {
  const stamp = new Date(ms)
  return `${ctx.today}:${String(stamp.getUTCFullYear())}`
}
