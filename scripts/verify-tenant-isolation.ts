/**
 * 门禁：租户隔离布局（租户与鉴权 04 · TA-50）。
 *
 * 本门禁**不跑两进程**（那是 `scripts/tenant-matrix.ts` 的活）：这里只做毫秒级的三条判据，
 * 防止"布局在代码里被改回平铺"而没人发现。
 *
 * | # | 判据 | 反例 |
 * |---|---|---|
 * | 1 | host 之外的源码不许把 `sessionId` 拼进路径而不带租户段（与 01 判据 2 互补） | `join(root, String(sessionId), 'session.jsonl')` |
 * | 2 | `SessionFiles.fileOf` 的路径段里，**倒数第三段**必须是租户 | `root/s-1/session.jsonl` |
 * | 3 | 同 baseRoot、不同租户的两条 `fileOf` 公共前缀只到 baseRoot | 两条都在 `root/demo/` |
 * | 4 | `--self-test` 用坏样本证明前三条都能红 | 见 `selfTest` |
 *
 * 判据 2/3 直接 `boot()` 两次（只装 `core:persistence`）拿**真实** `fileOf`，
 * 不用公式复刻——公式与实现分叉时，门禁会跟着一起错。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { asSessionId } from '@bah/test-support'
import { parseTenantId } from '@bah/util'

import { boot } from '../packages/host/src/boot/boot.ts'
import { createCatalog } from '../packages/host/src/boot/plugins/index.ts'
import { SESSION_FILES } from '../packages/host/src/boot/plugins/persistence.ts'
import { testRunContext } from '../packages/host/src/boot/test-run-context.ts'
import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 判据 1 的扫描面（host 由 01 的 `verify-tenant-scope` 负责，这里查其余）。 */
const SCAN_DIRS = ['packages', 'scripts', 'apps', 'services'] as const

/** 判据 2/3 的样品租户（与 docs/tenant.md 的部署形态一致）。 */
const KNOWN_TENANTS = ['demo', 'acme'] as const

/** 判据 1 的坏形态：`join(...)` 里有 sessionId、没有 tenant。 */
const JOIN_CALL = /\bjoin\s*\(/g

/** 判据 1 的第二种坏形态：模板串里把 sessionId 拼进路径且整句没有 tenant。 */
const TEMPLATE_JOIN = /`[^`]*\$\{\s*(?:String\s*\(\s*)?sessionId\s*\)?\s*\}[^`]*[/\\][^`]*`/

/**
 * 判据 1 的精确豁免（逐条带理由，不通配）。
 *
 * 这两个文件的 `root`/`sessionsDir` **按契约就是会话根**（调用方负责拼租户）：
 * - `ReplayOptions.root` 的文档如此；`bah audit replay` 已在 04 补上 `--tenant`；
 * - `policy:explain --dir` 的 `<sessions>` 也按租户目录解释。
 * 给"已经拼好租户的 API"强加 tenant 实参只会制造第二份拼接。
 */
const JOIN_EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'packages/persistence/src/replay/index.ts',
    'ReplayOptions.root 已是会话根（调用方拼租户）；CLI 已加 --tenant',
  ],
  [
    'scripts/policy-admin-lib.ts',
    'sessionsDir 按契约是租户目录（policy:explain --dir <tenant-sessions>）',
  ],
])

/** 去掉注释（注释里故意写着反例）。 */
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

/** 行号（1 基）。 */
function lineOf(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === '\n') line += 1
  }
  return line
}

/** 取一次 `join(...)` 的完整实参文本（括号配对；字符串里的括号不计数）。 */
export function joinCalls(source: string): { readonly args: string; readonly offset: number }[] {
  const out: { args: string; offset: number }[] = []
  for (const match of source.matchAll(JOIN_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1
    let depth = 0
    for (let index = open; index < source.length; index += 1) {
      const ch = source[index]
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        index += 1
        while (index < source.length) {
          if (source[index] === '\\') index += 2
          else if (source[index] === quote) break
          else index += 1
        }
        continue
      }
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          out.push({ args: source.slice(open + 1, index), offset: match.index ?? 0 })
          break
        }
      }
    }
  }
  return out
}

/** 判据 1：host 之外的路径拼接必须带租户。 */
export function judgeJoinSource(path: string, source: string): string[] {
  const normalized = path.replaceAll('\\', '/')
  if (!normalized.startsWith('packages/') && !normalized.startsWith('scripts/') &&
      !normalized.startsWith('apps/') && !normalized.startsWith('services/')) {
    return []
  }
  if (normalized.startsWith('packages/host/')) return []
  if (normalized.endsWith('.test.ts') || normalized.includes('.test.')) return []
  if (normalized.startsWith('scripts/verify-')) return []
  if (JOIN_EXEMPT.has(normalized)) return []
  if (/tenant/i.test(source)) return []

  const findings: string[] = []
  for (const call of joinCalls(source)) {
    if (!/\bsessionId\b/.test(call.args)) continue
    findings.push(
      `${path}:${String(lineOf(source, call.offset))} join(...) 把 sessionId 拼进路径但不含 tenant：` +
        '两租户会落到同一目录（04 判据 1）',
    )
  }
  const template = TEMPLATE_JOIN.exec(source)
  if (template !== null) {
    findings.push(
      `${path}:${String(lineOf(source, template.index))} 模板串把 sessionId 拼进路径但整份文件没有 tenant：` +
        '两租户会落到同一目录（04 判据 1）',
    )
  }
  return findings
}

/** 判据 2：`fileOf` 的倒数第三段必须是租户。 */
export function judgeLayout(filePath: string, tenant: string): string[] {
  const parts = filePath.replaceAll('\\', '/').split('/').filter((part) => part !== '')
  if (parts.length < 3) {
    return [`${filePath} 段数不足（期望 <root>/<tenant>/<sessionId>/session.jsonl）`]
  }
  const actual = parts[parts.length - 3]
  if (actual !== tenant) {
    return [`${filePath} 的倒数第三段是 ${String(actual)}，期望租户 ${tenant}（04 判据 2）`]
  }
  return []
}

/** 判据 3：两个租户的 `fileOf` 公共前缀只到 baseRoot。 */
export function judgeDisjoint(demoPath: string, acmePath: string, baseRoot: string): string[] {
  const demo = resolve(demoPath).replaceAll('\\', '/')
  const acme = resolve(acmePath).replaceAll('\\', '/')
  const base = resolve(baseRoot).replaceAll('\\', '/')
  const demoParts = demo.split('/')
  const acmeParts = acme.split('/')
  let common = 0
  while (common < demoParts.length && common < acmeParts.length && demoParts[common] === acmeParts[common]) {
    common += 1
  }
  const commonPath = demoParts.slice(0, common).join('/')
  if (commonPath !== base) {
    return [
      `两租户路径公共前缀是 ${commonPath || '(无)'}，期望只到 ${base}（04 判据 3）`,
    ]
  }
  if (demo.includes('/acme/') || acme.includes('/demo/')) {
    return ['两租户路径互相包含对方的租户段（04 判据 3）']
  }
  return []
}

/** 只装持久化一行，拿真实 `SessionFiles.fileOf`。 */
async function fileOfFor(baseRoot: string, tenant: string): Promise<string> {
  const app = await boot({
    profile: { name: 'fx-isolation', bundles: ['fx-isolation'], hmr: false },
    bundles: [{ name: 'fx-isolation', rows: [{ id: 'core:persistence', config: { root: baseRoot } }] }],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({ tenantId: parseTenantId(tenant), jsonlDir: baseRoot }),
  })
  try {
    return app.ctx.get(SESSION_FILES).fileOf(asSessionId('s-isolation'))
  } finally {
    await app.dispose('test')
  }
}

const gate: Gate = {
  name: 'tenant-isolation',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []

    const files = walk(root, [...SCAN_DIRS], (name) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    for (const path of files) {
      const relativePath = path.slice(root.length + 1).replaceAll('\\', '/')
      if (relativePath === 'scripts/verify-tenant-isolation.ts') continue
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      findings.push(...judgeJoinSource(relativePath, stripComments(raw)))
    }

    const dir = mkdtempSync(join(tmpdir(), 'bah-tenant-isolation-'))
    try {
      for (const tenant of KNOWN_TENANTS) {
        let filePath: string
        try {
          filePath = await fileOfFor(dir, tenant)
        } catch (error) {
          findings.push(`boot(${tenant}) 失败，判据 2 失明：${String(error)}`)
          continue
        }
        findings.push(...judgeLayout(filePath, tenant))
      }
      const demoPath = await fileOfFor(dir, 'demo')
      const acmePath = await fileOfFor(dir, 'acme')
      findings.push(...judgeDisjoint(demoPath, acmePath, dir))
      notes.push(`布局样品：${relative(dir, demoPath)} / ${relative(dir, acmePath)}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }

    notes.push(
      `扫描 ${String(files.length)} 个源码文件（判据 1，host 除外）；判据 2/3 用真实 SessionFiles.fileOf（${KNOWN_TENANTS.join(', ')}）`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

/**
 * 自检：三条判据各用一段坏样本证明能红；合法样本不许误报。
 *
 * @returns 不符项数（0 = 自检通过）
 */
export function selfTest(): number {
  const bad: readonly { readonly name: string; readonly judge: () => string[] }[] = [
    {
      name: 'join 缺租户段',
      judge: () => judgeJoinSource('scripts/fake.ts', `join(root, String(sessionId), 'session.jsonl')`),
    },
    {
      name: '模板串缺租户段',
      judge: () => judgeJoinSource('apps/fake.js', 'const p = `${root}/${sessionId}/session.jsonl`'),
    },
    {
      name: 'fileOf 倒数第三段不是租户',
      judge: () => judgeLayout(join('root', 's-1', 'session.jsonl'), 'demo'),
    },
    {
      name: '两租户同目录',
      judge: () => judgeDisjoint(join('root', 'demo', 's-1'), join('root', 'demo', 's-2'), 'root'),
    },
  ]
  let missed = 0
  for (const sample of bad) {
    const findings = sample.judge()
    if (findings.length === 0) {
      missed += 1
      console.error(`✘ 自检失败：坏样本未被抓到 —— ${sample.name}`)
    } else {
      console.log(`✔ 抓到（${String(findings.length)} 条）：${sample.name}`)
    }
  }

  const good: readonly { readonly name: string; readonly judge: () => string[] }[] = [
    {
      name: '带 tenant 的 join',
      judge: () =>
        judgeJoinSource('scripts/fake.ts', `join(root, tenant, String(sessionId), 'session.jsonl')`),
    },
    {
      name: '合规布局',
      judge: () => judgeLayout(join('root', 'demo', 's-1', 'session.jsonl'), 'demo'),
    },
    {
      name: '不同租户目录',
      judge: () => judgeDisjoint(join('root', 'demo', 's-1'), join('root', 'acme', 's-2'), 'root'),
    },
  ]
  for (const sample of good) {
    const findings = sample.judge()
    if (findings.length > 0) {
      missed += 1
      console.error(`✘ 自检失败：合法样本被误报 —— ${sample.name}`)
    } else {
      console.log(`✔ 未误报：${sample.name}`)
    }
  }
  console.log(
    missed === 0
      ? `自检通过：${String(bad.length)} 条坏样本全部被抓、${String(good.length)} 条合法样本未被误报`
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
