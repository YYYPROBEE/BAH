/**
 * 工具名通配编译。
 *
 * 按 `*` 把模式切成字面段，逐段转义后再用 `.*` 连接——转义只作用于段内，
 * 不依赖对整串做二次替换，因此 `*` 与正则元字符的处理互不干扰。
 */

/** 需要转义的正则元字符（`*` 单独处理，不在这里）。 */
const REGEXP_METACHARACTERS = /[|\\{}()[\]^$+?.]/g

/** 转义单个字面段。 */
const escapeSegment = (segment: string): string =>
  segment.replace(REGEXP_METACHARACTERS, (character) => `\\${character}`)

/**
 * 编译一个 `*` 通配模式为锚定正则。
 *
 * 语义：`*` 匹配任意长度（含空串）；其余正则元字符按字面量；整串锚定；大小写敏感
 * （工具名本来就是精确标识符，大小写不敏感会让 `Pay` 与 `pay` 混为一谈）。
 *
 * @param pattern - 形如 `transfer*`、`mcp_*`、`a*b*c` 的模式。
 * @returns 锚定正则。
 *
 * @example
 * compileToolGlob('transfer*') // /^transfer.*$/
 * compileToolGlob('a.b')       // /^a\.b$/（点号是字面量）
 */
export function compileToolGlob(pattern: string): RegExp {
  const segments = pattern.split('*').map(escapeSegment)
  return new RegExp(`^${segments.join('.*')}$`)
}
