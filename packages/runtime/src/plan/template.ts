/**
 * 动态 args 的模板层（W11）：`"${node.<id>.<path>}"` 的识别与替换。
 *
 * ## 三条边界（施工单 §1.1 + §3）
 *
 * 1. **只认整串**：`"${node.a.txnId}"` 是模板；`"前缀-${node.a.txnId}"` 是字面量。
 *    只在整串上替换，args 的**类型**才不会从 number 变成 string（`"${node.a.amount}"` 若做
 *    字符串插值，会把 800 变成 "800"，然后被金额校验按字符串处理）。
 * 2. **不做表达式**：`"${a + b}"` / `"${env.X}"` 都不是模板（连 `node.` 前缀都没有），
 *    按字面字符串原样传下去，不报错也不执行。理由：求值器会让 digest 与执行结果脱钩。
 * 3. **只读、不落盘**：解析结果只存在于本次 dispatch 的 args 里，
 *    `planDigest()` 始终对**模板原样**字符串取哈希（身份不随上游输出漂移）。
 *
 * ## 为什么单独一个文件
 *
 * `validate.ts`（静态判定引用闭包）与 `engine.ts`（执行期替换）必须用**同一套**解析规则，
 * 否则会出现"校验说没问题、执行期解析不出来"。抄两份 = 第二真相源，这是本仓反复踩过的坑。
 */

/** 整串模板：`${node.<id>.<path>}`。`path` 由点分段，段内不许出现 `${}`（防嵌套模板）。 */
const WHOLE_TEMPLATE = /^\$\{node\.([A-Za-z0-9_-]{1,64})\.([^${}]+)\}$/

/** 一次模板引用（解析出来的静态形状）。 */
export interface PlanTemplateRef {
  /** 上游节点 id（已按 `PLAN_NODE_ID_PATTERN` 同规则校验过字符集）。 */
  readonly nodeId: string
  /** 点分路径；纯数字段按数组下标解释（`content.0.text`）。 */
  readonly path: readonly string[]
  /** 展示用原文（`a.txnId`），报错时用它，不要用对象 JSON——那会把 args 泄进日志。 */
  readonly raw: string
}

/**
 * 识别单个值。
 *
 * @returns 模板引用；`undefined` = 不是模板（按字面量处理，**不报错**）
 */
export function templateRefOf(value: unknown): PlanTemplateRef | undefined {
  if (typeof value !== 'string') return undefined
  const matched = WHOLE_TEMPLATE.exec(value)
  if (matched === null) return undefined
  const nodeId = matched[1] as string
  const text = matched[2] as string
  const path = text.split('.')
  // `a..b` / `a.` 这类空段不是合法路径：退回字面量，而不是猜一个下标
  if (path.some((segment) => segment.length === 0)) return undefined
  return { nodeId, path, raw: `${nodeId}.${text}` }
}

/**
 * 收集 `args` 里的全部模板引用（递归进对象与数组，只认字符串叶子）。
 *
 * 键按字典序遍历：校验问题的**顺序**要稳定，否则同一张计划两次 `validate()` 的
 * `detail.issues` 顺序不同，门禁与快照都会闪。
 */
export function collectTemplateRefs(args: Readonly<Record<string, unknown>>): readonly PlanTemplateRef[] {
  const refs: PlanTemplateRef[] = []
  walk(args, (value) => {
    const ref = templateRefOf(value)
    if (ref !== undefined) refs.push(ref)
  })
  return refs
}

/** 一次替换的结果。 */
export interface PlanTemplateResolution {
  /** 是否全部解析成功。 */
  readonly ok: boolean
  /** 解析后的入参（`ok === false` 时是**部分解析**的结果，调用方不该用它执行）。 */
  readonly args: Readonly<Record<string, unknown>>
  /** 解析失败的引用（上游被跳过、字段不存在、路径穿过了原始值）。 */
  readonly unresolved: readonly PlanTemplateRef[]
}

/**
 * 用上游 output 替换模板。
 *
 * 语义：值**整体**被替换（不是字符串插值）；路径穿不过去就是失败，不返回 `undefined`
 * ——"缺字段"与"字段值恰好是 undefined"在 JSON 里分不开，一起算失败更安全。
 */
export function resolveTemplateArgs(
  args: Readonly<Record<string, unknown>>,
  outputs: ReadonlyMap<string, unknown>,
): PlanTemplateResolution {
  const unresolved: PlanTemplateRef[] = []
  let changed = false

  const convert = (value: unknown): unknown => {
    const ref = templateRefOf(value)
    if (ref !== undefined) {
      const found = readPath(outputs.get(ref.nodeId), ref.path)
      if (found.ok) {
        changed = true
        return found.value
      }
      unresolved.push(ref)
      return value
    }
    if (Array.isArray(value)) {
      let touched = false
      const list = value.map((item) => {
        const next = convert(item)
        if (next !== item) touched = true
        return next
      })
      if (touched) changed = true
      return touched ? list : value
    }
    if (typeof value === 'object' && value !== null) {
      const source = value as Record<string, unknown>
      // ★ 用 `{...source}` 而不是 `Object.keys(source).sort()` 重建：这里产出的是**执行期入参**，
      // 键序一变，`tool/call.args` 落账的字节序就变，快照回放（逐字节相等）会红。
      // 排序只属于 `walk()`（校验问题的顺序要稳定），两者不是一件事。
      const next: Record<string, unknown> = { ...source }
      let touched = false
      for (const key of Object.keys(source)) {
        const before = source[key]
        const after = convert(before)
        if (after !== before) {
          touched = true
          next[key] = after
        }
      }
      if (touched) changed = true
      return touched ? next : value
    }
    return value
  }

  const resolved = convert(args) as Readonly<Record<string, unknown>>
  return { ok: unresolved.length === 0, args: changed ? resolved : args, unresolved }
}

/* ── 内部 ─────────────────────────────────────────────────────────── */

/** 深度优先遍历（键排序），把字符串叶子交给回调。 */
function walk(value: unknown, visit: (leaf: string) => void): void {
  if (typeof value === 'string') {
    visit(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    for (const key of Object.keys(source).sort()) walk(source[key], visit)
  }
}

/** 按下标访问：`undefined` 视为"没找到"（JSON 里不存在的字段就是 undefined）。 */
function readPath(root: unknown, path: readonly string[]): { ok: boolean; value?: unknown } {
  let current: unknown = root
  for (const segment of path) {
    if (current === undefined || current === null) return { ok: false }
    if (Array.isArray(current)) {
      // 只认规范的十进制下标：`01` / `-1` / `x` 一律不猜
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return { ok: false }
      const index = Number(segment)
      if (index >= current.length) return { ok: false }
      current = current[index]
      continue
    }
    if (typeof current !== 'object') return { ok: false }
    const record = current as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return { ok: false }
    current = record[segment]
  }
  return current === undefined ? { ok: false } : { ok: true, value: current }
}
