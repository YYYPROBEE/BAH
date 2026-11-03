/**
 * 门禁：生产源码不得 import 自己的 devDependency。
 *
 * 为什么必须有制度：同类问题在这里反复发生过，只写修法挡不住第三次。这类问题的本质是
 * **发布面污染**——入口可达的代码 import 一个只在
 * `devDependencies` 声明的包，部署时装不上，而 `pnpm test` 本地永远绿。
 *
 * 判据（AST + 入口可达性，避免被注释、换行与"看起来像测试文件"的命名绕过）：
 * 1. 从包入口 `src/index.ts` 出发，沿相对导入做可达性分析（`@bah/*` 视为包外终点）；
 * 2. 扫 `src` 下的非测试源码里的全部 `@bah/*` 导入；
 * 3. 命中"在该包 devDependencies、但不在 dependencies"时，分三种情况：
 *    - **仅类型导入** → 不算违规，只记 note。原因：`emitDeclarationOnly` + `verbatimModuleSyntax`
 *      下类型导入在运行期被完全擦除，部署侧不会缺依赖；而把它判成违规会逼出两种更坏的结果
 *      ——要么给领域包加一条到装配层的真依赖（正是 2-2 方向断言要防的），要么复制一份契约类型
 *      （正是 2-6 要防的）。
 *    - **入口不可达 + 测试设施约定**（`testing.ts` 或 `fixtures/` 下）→ 不算违规，只记 note。
 *    - 其余（入口可达，或不可达但不在约定位置）→ 违规。
 * 4. 子路径先归一（`@bah/llm/deepseek` → `@bah/llm`）。
 *
 * 为什么不用静态例外名单：名单是手工维护的，无法区分"测试设施"与
 * "被错放进 src 的生产代码"，而每加一个同类夹具都要改名单。可达性 + 约定是机械判据，
 * 新增夹具不必改门禁；把测试代码接进入口反而会立刻变红。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import ts from 'typescript'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 只扫包内源码：排除测试与声明产物。 */
const isSource = (fileName: string): boolean =>
  fileName.endsWith('.ts') && !fileName.endsWith('.d.ts') && !fileName.endsWith('.test.ts')

/** 一处裸包导入。 */
interface BareImport {
  readonly line: number
  readonly specifier: string
  readonly typeOnly: boolean
}

/** 一个源文件的解析结果。 */
interface FileFacts {
  /** 相对仓库根的 posix 路径。 */
  readonly file: string
  readonly imports: readonly BareImport[]
  /** 相对导入指向的包内文件（posix）。 */
  readonly localEdges: readonly string[]
}

/** 一个包的事实面。 */
interface PackageFacts {
  readonly dir: string
  readonly name: string
  readonly deps: ReadonlySet<string>
  readonly devDeps: ReadonlySet<string>
  /** 相对仓库根 posix 的入口路径。 */
  readonly entry: string
}

const gate: Gate = {
  name: 'no-dev-dep-in-src',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    let scanned = 0
    let bareImports = 0
    let typeOnlySkips = 0
    let testOnlySkips = 0

    for (const facts of readPackages(root)) {
      const srcDir = join(root, 'packages', facts.dir, 'src')
      if (!existsSync(srcDir)) continue

      const files = new Map<string, FileFacts>()
      for (const file of walk(root, [join('packages', facts.dir, 'src')], isSource)) {
        const parsed = parseFile(root, file, facts.dir)
        files.set(parsed.file, parsed)
        scanned += 1
      }

      const reachable = reachableFrom(facts.entry, files)
      if (!reachable.has(facts.entry)) {
        findings.push(`${facts.entry}: 包入口不存在或无法解析（可达性分析失效）`)
        continue
      }

      for (const parsed of files.values()) {
        for (const site of parsed.imports) {
          bareImports += 1
          const name = normalize(site.specifier)
          if (!facts.devDeps.has(name) || facts.deps.has(name)) continue

          if (site.typeOnly) {
            typeOnlySkips += 1
            notes.push(`类型导入放行：${parsed.file}:${site.line} ${site.specifier}（运行期擦除）`)
            continue
          }

          if (!reachable.has(parsed.file) && isTestOnlyPath(parsed.file)) {
            testOnlySkips += 1
            notes.push(
              `测试设施放行：${parsed.file}:${site.line} ${site.specifier}（入口不可达，且属测试设施约定）`,
            )
            continue
          }

          const where = reachable.has(parsed.file)
            ? '入口可达'
            : '入口不可达，但不在 testing.ts / fixtures 约定位置'
          findings.push(
            `${parsed.file}:${site.line} 值导入 ${site.specifier} —— 该包在 ${facts.name} 的 devDependencies 里，不在 dependencies（${where}）`,
          )
        }
      }
    }

    notes.push(
      `扫描 ${scanned} 个源文件、${bareImports} 处 @bah/* 导入；类型导入放行 ${typeOnlySkips} 处，测试设施放行 ${testOnlySkips} 处`,
    )

    return { ok: findings.length === 0, findings, notes }
  },
}

/** 测试设施约定：文件名 `testing.ts`，或位于 `fixtures/` 目录下。 */
function isTestOnlyPath(file: string): boolean {
  const posix = file.replace(/\\/g, '/')
  return /(^|\/)testing\.ts$/.test(posix) || posix.includes('/fixtures/')
}

/** 从入口做 BFS，返回可达文件集合。 */
function reachableFrom(entry: string, files: ReadonlyMap<string, FileFacts>): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const current = queue.pop()
    if (current === undefined || seen.has(current)) continue
    seen.add(current)
    const facts = files.get(current)
    if (facts === undefined) continue
    for (const edge of facts.localEdges) {
      if (!seen.has(edge)) queue.push(edge)
    }
  }
  return seen
}

/** 解析一个源文件的导入面。 */
function parseFile(root: string, file: string, packageDir: string): FileFacts {
  const posix = relative(root, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const imports: BareImport[] = []
  const localEdges: string[] = []

  const record = (node: ts.Node, specifier: string, typeOnly: boolean): void => {
    if (specifier.startsWith('@bah/')) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      imports.push({ line, specifier, typeOnly })
      return
    }
    if (!specifier.startsWith('.')) return
    const target = resolvePackageLocal(root, file, specifier, packageDir)
    if (target !== undefined) localEdges.push(target)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (ts.isStringLiteral(specifier)) {
        record(node, specifier.text, node.importClause?.isTypeOnly === true)
      }
    } else if (ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        record(node, specifier.text, node.isTypeOnly)
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference
      if (ts.isExternalModuleReference(reference) && ts.isStringLiteral(reference.expression)) {
        record(node, reference.expression.text, false)
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      if (argument !== undefined && ts.isStringLiteral(argument)) record(node, argument.text, false)
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        record(node, argument.literal.text, true)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return { file: posix, imports, localEdges }
}

/**
 * 相对导入 → 包内文件（相对仓库根的 posix）。
 *
 * 本仓相对导入一律带 `.ts`（`allowImportingTsExtensions`）；目录导入按 `index.ts` 兜底，
 * 解析不到、或跳出 `src/` 边界时返回 undefined（跨包/产物路径不属本门禁的扫描面）。
 */
function resolvePackageLocal(
  root: string,
  fromFile: string,
  specifier: string,
  packageDir: string,
): string | undefined {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = specifier.endsWith('.ts') ? [base] : [base, join(base, 'index.ts')]
  const boundary = relative(root, join(root, 'packages', packageDir, 'src')).replace(/\\/g, '/')

  for (const candidate of candidates) {
    if (!existsSync(candidate) || statSync(candidate).isDirectory()) continue
    const posix = relative(root, candidate).replace(/\\/g, '/')
    if (!posix.startsWith(boundary)) continue
    return posix
  }
  return undefined
}

/** 读 packages 下每个包的依赖面与入口。 */
function readPackages(root: string): PackageFacts[] {
  const base = join(root, 'packages')
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((dir): PackageFacts[] => {
      const manifest = join(base, dir, 'package.json')
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(manifest, 'utf8'))
      } catch {
        return [] // 解析失败由 verify-package-graph 负责报错，本门禁不重复
      }
      if (typeof raw !== 'object' || raw === null) return []
      const record = raw as Record<string, unknown>
      const name = typeof record['name'] === 'string' ? record['name'] : `@bah/${dir}`
      return [
        {
          dir,
          name,
          deps: bahSet(record['dependencies']),
          devDeps: bahSet(record['devDependencies']),
          entry: `packages/${dir}/src/index.ts`,
        },
      ]
    })
}

/** 依赖对象里的 `@bah/*` 键（归一化后）。 */
function bahSet(value: unknown): ReadonlySet<string> {
  if (typeof value !== 'object' || value === null) return new Set()
  return new Set(
    Object.keys(value)
      .filter((key) => key.startsWith('@bah/'))
      .map((key) => normalize(key)),
  )
}

/** `@bah/llm/deepseek` → `@bah/llm`。 */
function normalize(specifier: string): string {
  const parts = specifier.split('/')
  return parts.length > 1 ? `${parts[0]}/${parts[1]}` : specifier
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
