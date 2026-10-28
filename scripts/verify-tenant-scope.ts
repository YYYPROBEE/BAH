/**
 * 门禁：租户作用域（租户与鉴权 01 · TA-19）。
 *
 * ## 为什么需要它
 *
 * 租户化最典型的坏法不是"崩"，是**某一处忘了带租户**：代码照样编译、用例照样绿，
 * 只有那一处的数据悄悄落到所有租户共享的地方。本门禁把"忘带租户"变成一次文本检查。
 *
 * ## 四条判据（每条都配一个"能红"的样本，见 `--self-test`）
 *
 * | # | 判据 | 反例 |
 * |---|---|---|
 * | 1 | 记忆 API 的租户实参必须是 `tenant*` | `store.listUnits(userId)` |
 * | 2 | `packages/host/src/**` 里拼 `sessionId` 路径的文件必须出现 `tenant` | 新写一个只拼 sessionId 的落盘点 |
 * | 3 | 全仓不许从请求里取租户 | `req.headers['x-tenant']` / `searchParams.get('tenant')` |
 * | 4 | 门禁自检（`--self-test`） | 上面两条坏样本都必须被抓到 |
 *
 * ## 与计划书的一处差异（判据 1 的实参下标）
 *
 * 计划书写"第一个实参必须包含 tenant"。但 `readScoped` 的签名是
 * `readScoped(store, tenant, userId, ...)`——租户在**第二个**实参。按字面实现会
 * 让 `readScoped` 永远红（或按"任一实参"放宽到永远绿）。这里按符号登记租户实参下标，
 * 见 `MEMORY_APIS`。这是**按代码事实修正判据**，已登记在证据的偏差表。
 */

import { readFileSync } from 'node:fs'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 记忆层那几个"必须有租户"的 API，以及租户在第几个实参（0 基）。 */
const MEMORY_APIS: readonly { readonly name: string; readonly tenantArg: number; readonly why: string }[] = [
  { name: 'listUnits', tenantArg: 0, why: 'listUnits(tenant, userId, limit?)' },
  { name: 'findUnitByHash', tenantArg: 0, why: 'findUnitByHash(tenant, userId, hash)' },
  { name: 'listProcedural', tenantArg: 0, why: 'listProcedural(tenant, userId)' },
  // 与上面三个不同：它的第一个参数是 store
  { name: 'readScoped', tenantArg: 1, why: 'readScoped(store, tenant, userId, options)' },
]

/** 判据 3 的检查面：所有源码（含 apps / services 的宿主侧）。 */
const CLIENT_TENANT_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /headers\s*\[\s*['"]x-tenant['"]\s*\]/i, why: "从请求头取租户（req.headers['x-tenant']）" },
  { pattern: /headers\s*\.\s*get\s*\(\s*['"]x-tenant['"]\s*\)/i, why: "从请求头取租户（headers.get('x-tenant')）" },
  { pattern: /searchParams\s*\.\s*get\s*\(\s*['"]tenant['"]\s*\)/, why: "从查询参数取租户（searchParams.get('tenant')）" },
]

/**
 * 判据 2 的"拼路径"形态。
 *
 * 为什么不写成"任何 `${sessionId}`"：`policy.ts` 用 `${sessionId}#${epoch}` 做**canary 分桶**，
 * 那是哈希输入不是路径。只会误报的判据，第二次就会被加白名单绕过（判据自身的纪律）。
 * 所以只认两种形态：`join(..., sessionId)`，以及**同一个模板串里既有 sessionId 又有分隔符**。
 */
const SESSION_PATH_PATTERNS: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /join\s*\([^)]*sessionId/i, why: 'join(..., sessionId)' },
  {
    pattern: /`[^`]*\$\{\s*(?:String\s*\(\s*)?sessionId\s*\)?\s*\}[^`]*[/\\][^`]*`/,
    why: '模板串里把 sessionId 拼进路径（`${sessionId}/...`）',
  },
]

/** 只扫这些目录（`walk` 会跳过 node_modules / dist / sessions 等）。 */
const SCAN_DIRS = ['packages', 'scripts', 'apps', 'services'] as const

/** 记忆层的实现与测试不受判据 1 约束（它就是实现；测试里有合法的构造）。 */
const isMemoryImplementation = (path: string): boolean =>
  path.replaceAll('\\', '/').startsWith('packages/memory-store/src/')

/** 测试文件不参与判据 1/2（它们常常故意造"缺字段"的样本）。 */
const isTest = (path: string): boolean => path.endsWith('.test.ts')

/** 门禁自身不参与判据 3（它的检查模式就是那些字符串）。 */
const isGateFile = (path: string): boolean => path.endsWith('verify-tenant-scope.ts')

/** 去注释（本仓注释里**故意**写着反例，不剥会把纪律本身判成违规）。 */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', index)
      index = nl < 0 ? source.length : nl
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      out += ch
      index += 1
      while (index < source.length) {
        if (source[index] === '\\') {
          out += source.slice(index, index + 2)
          index += 2
          continue
        }
        out += source[index]
        if (source[index] === quote) break
        index += 1
      }
      index += 1
      continue
    }
    out += ch
    index += 1
  }
  return out
}

/** 行号（1 基）——finding 必须能定位。 */
function lineOf(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/**
 * 取某次调用的第 N 个实参文本（顶层逗号切分，尊重括号与字符串）。
 *
 * @returns 找不到（实参不足）时 `undefined`
 */
export function argumentAt(
  source: string,
  openParenIndex: number,
  argIndex: number,
): { readonly text: string; readonly offset: number } | undefined {
  let depth = 0
  let current = ''
  let currentStart = openParenIndex + 1
  let argNo = 0
  for (let index = openParenIndex; index < source.length; index += 1) {
    const ch = source[index]
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      current += ch
      index += 1
      while (index < source.length) {
        current += source[index]
        if (source[index] === '\\') {
          index += 1
          current += source[index] ?? ''
        } else if (source[index] === quote) {
          break
        }
        index += 1
      }
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1
      if (depth === 0) {
        if (argNo === argIndex) return { text: current, offset: currentStart }
        return undefined
      }
    }
    if (ch === ',' && depth === 1) {
      if (argNo === argIndex) return { text: current, offset: currentStart }
      argNo += 1
      current = ''
      currentStart = index + 1
      continue
    }
    if (index > openParenIndex) current += ch
  }
  return undefined
}

/** 判据 1：记忆 API 的租户实参。 */
export function judgeMemoryArgs(path: string, source: string): string[] {
  const findings: string[] = []
  for (const api of MEMORY_APIS) {
    const pattern = new RegExp(`(?<![\\w$])${api.name}\\s*\\(`, 'g')
    for (const match of source.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1
      const arg = argumentAt(source, open, api.tenantArg)
      const line = lineOf(source, match.index ?? 0)
      if (arg === undefined) {
        findings.push(
          `${path}:${String(line)} ${api.name}(...) 少了租户实参（期望第 ${String(api.tenantArg + 1)} 个实参含 tenant；${api.why}）`,
        )
        continue
      }
      if (!/tenant/i.test(arg.text)) {
        findings.push(
          `${path}:${String(line)} ${api.name}(...) 的第 ${String(api.tenantArg + 1)} 个实参不含 tenant：${arg.text.trim().slice(0, 60)}（${api.why}）`,
        )
      }
    }
  }
  return findings
}

/** 判据 2：`packages/host/src/**` 里拼 sessionId 路径的文件必须出现 tenant。 */
export function judgeSessionPathJoin(path: string, source: string): string[] {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized.startsWith('packages/host/src/')) return []
  if (/tenant/i.test(source)) return []
  const findings: string[] = []
  for (const { pattern, why } of SESSION_PATH_PATTERNS) {
    const match = pattern.exec(source)
    if (match === null) continue
    findings.push(
      `${path}:${String(lineOf(source, match.index))} 在拼会话路径（${why}）但整份文件没有出现 tenant：落盘位置属于哪个租户无法从代码看出`,
    )
  }
  return findings
}

/** 判据 3：不许从请求里取租户。 */
export function judgeClientTenant(path: string, source: string): string[] {
  const findings: string[] = []
  for (const { pattern, why } of CLIENT_TENANT_PATTERNS) {
    const match = pattern.exec(source)
    if (match === null) continue
    findings.push(
      `${path}:${String(lineOf(source, match.index))} ${why}——租户只能来自启动输入（--tenant / BAH_TENANT），永不信任客户端声明`,
    )
  }
  return findings
}

/** 对一个文件跑全部判据（自检与 run 共用，避免两套实现）。 */
function judgeFile(path: string, raw: string): string[] {
  // 门禁自身不参与任何判据：它的自检样本里**故意**写着坏代码（字符串常量）
  if (isGateFile(path)) return []
  const source = stripComments(raw)
  const findings: string[] = []
  if (!isTest(path) && !isMemoryImplementation(path)) findings.push(...judgeMemoryArgs(path, source))
  if (!isTest(path)) findings.push(...judgeSessionPathJoin(path, source))
  // 测试文件不扫判据 3：门禁自己的反例样本就住在 *.test.ts 里（写死"被禁的字符串"）
  if (!isTest(path)) findings.push(...judgeClientTenant(path, source))
  return findings
}

const gate: Gate = {
  name: 'tenant-scope',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []
    const files = walk(root, [...SCAN_DIRS], (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    for (const path of files) {
      const relativePath = path.slice(root.length + 1).replaceAll('\\', '/')
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      findings.push(...judgeFile(relativePath, raw))
    }
    notes.push(
      `扫描 ${String(files.length)} 个 .ts；判据 1（记忆 API 租户实参，登记 ${String(MEMORY_APIS.length)} 个符号）、判据 2（host 拼会话路径）、判据 3（禁止客户端声明租户）`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

/**
 * 自检：用两段**内联坏样本**证明判据会红（R12：判据脚本 100% 静默失败过一次）。
 *
 * @returns 未被抓到的样本数（0 = 自检通过）
 */
export function selfTest(): number {
  const samples: readonly { readonly name: string; readonly path: string; readonly text: string; readonly judge: (path: string, source: string) => string[] }[] = [
    {
      name: '记忆 API 缺租户实参',
      path: 'packages/host/src/boot/plugins/fake-memory.ts',
      text: 'const rows = store.listUnits(userId)\n',
      judge: judgeMemoryArgs,
    },
    {
      name: '记忆 API 租户实参写错位',
      path: 'packages/host/src/boot/plugins/fake-memory.ts',
      text: 'const rows = readScoped(store, store.listUnits(store, userId))\n',
      judge: judgeMemoryArgs,
    },
    {
      name: 'host 拼会话路径但没有 tenant',
      path: 'packages/host/src/boot/plugins/fake-store.ts',
      text: 'const path = join(root, String(sessionId), "session.jsonl")\n',
      judge: judgeSessionPathJoin,
    },
    {
      name: '从请求头取租户',
      path: 'packages/host/src/boot/plugins/fake-web.ts',
      text: "const t = req.headers['x-tenant']\n",
      judge: judgeClientTenant,
    },
    {
      name: '从查询参数取租户',
      path: 'apps/web/src/fake.js',
      text: "const t = url.searchParams.get('tenant')\n",
      judge: judgeClientTenant,
    },
  ]

  let missed = 0
  for (const sample of samples) {
    const findings = sample.judge(sample.path, stripComments(sample.text))
    if (findings.length === 0) {
      missed += 1
      console.error(`✘ 自检失败：坏样本未被抓到 —— ${sample.name}`)
    } else {
      console.log(`✔ 抓到（${String(findings.length)} 条）：${sample.name}`)
    }
  }

  // 反向：合法样本必须**不**被误报（只会误报的门禁，第二次就会被加白名单绕过）
  const goodSamples: readonly { readonly name: string; readonly path: string; readonly text: string; readonly judge: (path: string, source: string) => string[] }[] = [
    {
      name: '合法 listUnits',
      path: 'packages/memory-store/src/read/filter.ts',
      text: 'store.listUnits(tenant, userId)\n',
      judge: judgeMemoryArgs,
    },
    {
      name: '合法 readScoped',
      path: 'packages/memory-store/src/layer.ts',
      text: 'readScoped(store, query.tenant, query.user_id, {})\n',
      judge: judgeMemoryArgs,
    },
    {
      name: '带 tenant 的 host 路径拼接',
      path: 'packages/host/src/boot/plugins/persistence.ts',
      text: 'const tenant = String(run.tenantId)\nconst path = join(root, String(sessionId))\n',
      judge: judgeSessionPathJoin,
    },
  ]
  for (const sample of goodSamples) {
    const findings = sample.judge(sample.path, stripComments(sample.text))
    if (findings.length > 0) {
      missed += 1
      console.error(`✘ 自检失败：合法样本被误报 —— ${sample.name}`)
    } else {
      console.log(`✔ 未误报：${sample.name}`)
    }
  }

  console.log(
    missed === 0
      ? `自检通过：${String(samples.length)} 条坏样本全部被抓、${String(goodSamples.length)} 条合法样本未被误报`
      : `自检失败：${String(missed)} 项不符`,
  )
  return missed
}

export { gate }

if (isMainModule(import.meta.url)) {
  if (process.argv.includes('--self-test')) {
    process.exitCode = selfTest() === 0 ? 0 : 1
  } else {
    await runStandalone(gate)
  }
}
