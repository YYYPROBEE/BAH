/**
 * 门禁自身冒烟（C2）。
 *
 * ## 为什么需要这一层
 *
 * 40 个 `verify-*.ts` 是其他所有断言的"安全网"，但它们自己此前既不在 `typecheck`
 * 里（C2 已补 `tsconfig.scripts.json`）、也没有任何用例覆盖。两个具体失效模式： *
 * 1. **静默少跑**：`verify-foo.ts` 被改名成 `check-foo.ts`（或删掉），`run-gates`
 *    照样打印"全部通过（34/34）"——分母跟着变小，红事变绿。所以这里钉住"数量下限"
 *    与"文件名 ↔ gate.name 一一对应"。
 * 2. **同名覆盖**：两个门禁都 `name: 'web'` 时，人眼在输出里看到两行同名结果，
 *    很难发现其中一行本该是别的检查项。
 *
 * ## 为什么 ci.ts / coverage-summary.ts 用文本断言而不是 import
 *
 * 它们顶层就执行（`rmSync(.ci-artifacts)` / `main()`），`import` 等于跑一遍 CI。
 * 能 import 的只有导出 `gate` 的 `verify-*.ts`——那也是它们被设计的调用方式。
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import type { Gate } from './gate-lib.ts'

const SCRIPTS = import.meta.dirname
const VERIFY_PATTERN = /^verify-[\w-]+\.ts$/
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

const gateFiles = readdirSync(SCRIPTS)
  .filter((name) => VERIFY_PATTERN.test(name))
  .sort()

/** 读脚本源码（文本断言用）。 */
function source(file: string): string {
  return readFileSync(join(SCRIPTS, file), 'utf8')
}

describe('门禁自身冒烟', () => {
  // 超时放宽到 60s：本用例要**逐个 import** 40 个门禁脚本（每个都由 tsx 现场编译），
  // 全量并发跑（`pnpm test` / 覆盖率面）时 5s 默认值不够，会假红成"门禁导入失败"。
  it('每个 verify-*.ts 都能导入并导出 gate；name 是 kebab-case、全局唯一、与文件名对应', async () => {
    // 2026-10-28 实测 40 项（S4 新增 4 条策略门禁）。地板就是当前数：
    // 删掉任何一条都必须同步改这里，不能靠"少 4 条也过线"静默变绿。
    expect(gateFiles.length).toBeGreaterThanOrEqual(40)

    const seen = new Map<string, string>()
    for (const file of gateFiles) {
      const loaded: unknown = await import(pathToFileURL(join(SCRIPTS, file)).href)
      const gate = (loaded as { gate?: Gate }).gate

      expect(gate, `${file} 没有导出 { gate }，run-gates 会把它记成"无法调度"`).toBeDefined()
      if (gate === undefined) continue

      expect(typeof gate.run, `${file} 的 gate.run 不是函数`).toBe('function')
      expect(gate.name, `${file} 的 gate.name 不是 kebab-case`).toMatch(KEBAB)

      // 文件名 ↔ name 一一对应：重命名脚本时忘改 name，会在输出里出现与文件对不上的门禁名，
      // 排障时按名字搜不到实现。
      const expected = file.replace(/^verify-/, '').replace(/\.ts$/, '')
      expect(gate.name, `${file} 的 gate.name 应与文件名一致（期望 ${expected}）`).toBe(expected)

      // 同名门禁会让"通过 N 项"里混进重复项
      const previous = seen.get(gate.name)
      expect(previous, `gate.name 重复：${gate.name}（${String(previous)} 与 ${file}）`).toBeUndefined()
      seen.set(gate.name, file)
    }

    expect(seen.size).toBe(gateFiles.length)
  }, 60_000)

  it('ci.ts 的步骤表：name 唯一、vitest 面有正整数用例地板、三面齐全', () => {
    const text = source('ci.ts')

    // 提取 STEPS 字面量里的每一项（`{ kind: '...', name: '...', ... }`）
    const steps = [...text.matchAll(/kind:\s*'(command|vitest|e2e|rag)',\s*name:\s*'([^']+)'/g)].map(
      (match) => ({ kind: match[1] ?? '', name: match[2] ?? '' }),
    )
    expect(steps.length).toBeGreaterThanOrEqual(8)

    // ① name 唯一：两行同名时输出无法区分是哪一步红的
    const names = steps.map((step) => step.name)
    expect(new Set(names).size).toBe(names.length)

    // ② 三个必跑面：缺任何一个，"CI 等价"就成了半套
    for (const required of ['typecheck', 'gate', 'test (unit)']) {
      expect(names, `ci.ts 少了 ${required} 一步`).toContain(required)
    }

    // ③ vitest 面的地板必须是正整数：删掉 minCases 等于关掉"删测试即红"这条判据
    const floors = [...text.matchAll(/minCases:\s*(\d+)/g)].map((match) => Number(match[1]))
    expect(floors.length).toBeGreaterThanOrEqual(3)
    for (const floor of floors) expect(floor).toBeGreaterThan(0)
  })

  it('coverage-summary.ts 的两个口径阈值与主调用仍在', () => {
    const text = source('coverage-summary.ts')

    // 两个口径必须都在：只判行口径会漏"小包全黑"，只判包口径会把"刚过线"说成覆盖很好
    expect(text).toMatch(/LINE_TARGET_PCT\s*=\s*80/)
    expect(text).toMatch(/PACKAGE_TARGET\s*=\s*14/)
    // 顶层 `main()` 是它的入口；被删掉时脚本会静默成功（退出码 0 但什么都没判）
    expect(text).toMatch(/^main\(\)\s*$/m)
  })

})
