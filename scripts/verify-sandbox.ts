/**
 * 门禁：模型代码禁入 `none` 档 + 沙箱 worker 加载链零包名依赖（施工单 11 §0 第 4 条、§4 第 6 步）。
 *
 * 两条规则各挡一种"悄悄破功"：
 *
 * 1. **禁入 none**：`none` 档是进程内直调，没有 `resourceLimits` 也没有硬杀。运行期的
 *    拦截在 `sandbox-policy`（有单测），这条静态检查再兜一层——装配代码里出现
 *    "模型来源 + none 档"的组合，即使还没跑到就直接红。
 * 2. **worker 链零包名 import**：`worker.ts` / `language.ts` / `handlers/**` / `testing/**`
 *    由 Node 直接加载（不经 vitest 别名）。一旦它们 import 了 `@bah/*`，真实运行就依赖
 *    `dist/`，"源码即可运行"与"改 src 不用先 build"两条承诺同时失效——而且只在生产暴露。
 *
 * 实现说明：词法扫描（与其余门禁一致，不建 AST）；测试文件不构成契约。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 规则 1 的判据：同一行里同时出现模型来源与 none 档。 */
const MODEL_SOURCE = /codeSource\s*[:=]\s*(['"])model\1/
const NONE_TIER = /(['"])none\1/

/** 规则 2 覆盖的目录前缀（相对 `packages/safety/src/`）。 */
const WORKER_SCOPES = ['sandbox-runtime/worker.ts', 'sandbox-runtime/language.ts', 'sandbox-runtime/handlers/', 'sandbox-runtime/testing/'] as const

/** import / export 的说明符（静态与动态都算）。 */
const SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g

/** 允许的说明符形状：Node 内建，或指向同目录树的相对 `.ts`。 */
function isAllowedSpecifier(specifier: string): boolean {
  if (specifier.startsWith('node:')) return true
  if (!specifier.startsWith('.')) return false
  return specifier.endsWith('.ts') || specifier.endsWith('.js')
}

const gate: Gate = {
  name: 'sandbox',

  async run(root) {
    const findings: string[] = []
    const files = walk(root, ['packages'], (name) =>
      name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts'),
    )

    let scannedWorkerGraph = 0
    for (const file of files) {
      const where = relative(root, file).replace(/\\/g, '/')
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)

      for (const [index, line] of lines.entries()) {
        if (isComment(line)) continue
        if (MODEL_SOURCE.test(line) && NONE_TIER.test(line)) {
          findings.push(
            `${where}:${String(index + 1)} 模型来源的调用与 none 档同现（施工单 11 §2 硬规则：模型代码一律不得进入 none）`,
          )
        }
      }

      const scope = WORKER_SCOPES.find((prefix) => where.includes(`safety/src/${prefix}`))
      if (scope === undefined) continue
      scannedWorkerGraph += 1
      const text = readFileSync(file, 'utf8')
      for (const matched of text.matchAll(SPECIFIER)) {
        const specifier = matched[2] as string
        if (!isAllowedSpecifier(specifier)) {
          findings.push(
            `${where} import "${specifier}" —— worker 加载链只许 node: 与本包相对路径（施工单 11 §3）`,
          )
        }
      }
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [
        `扫描 ${files.length} 个源文件的"模型来源 × none 档"同现`,
        `worker 加载链文件 ${String(scannedWorkerGraph)} 个（零包名 import 校验）`,
      ],
    }
  },
}

/** 注释行不参与契约判定。 */
function isComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
