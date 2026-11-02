/**
 * 快照覆盖面的稳定摘要（门禁与 `snapshot:reverify` 共用）。
 *
 * 为什么需要它：快照是**确定性录制**的（scenario.json 固定 clock.start 与 randomSeed），
 * 所以对"行为等价"的改动重录后内容逐字节相同、git 里没有 diff。门禁若只认
 * 「快照文件出现在改动集」，遇到这类改动就只会红、不会绿——是死锁。
 *
 * `reverified.json` 用本摘要记录「我为这份源码重放并核验过」：
 * 摘要一变就必须重新核验，因此既不放过真实改动，也不惩罚等价改动。
 * 与 `/* v8 ignore *\/` 那类纯注释豁免不同，这条覆盖**重命名与等价重写**。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 递归时跳过的目录（产物与依赖都不属于行为面）。 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-types', 'coverage'])

/** 测试文件不算行为面。 */
const TEST_FILE = /\.test\.ts$/

/** 目录前缀或单文件精确匹配（与 verify-snapshot-fresh 的语义保持一致）。 */
export function covers(scope: string, file: string): boolean {
  const normalized = scope.replace(/\\/g, '/')
  if (normalized.endsWith('/')) return file.startsWith(normalized)
  return file === normalized || file.startsWith(`${normalized}/`)
}

/** 递归收集目录下的 `.ts` 源码（相对 root，统一用正斜杠）。 */
function walk(root: string, relDir: string, out: Set<string>): void {
  let entries
  try {
    entries = readdirSync(join(root, relDir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const rel = `${relDir}${entry.name}`
    if (entry.isDirectory()) {
      walk(root, `${rel}/`, out)
    } else if (entry.name.endsWith('.ts') && !TEST_FILE.test(entry.name)) {
      out.add(rel)
    }
  }
}

/**
 * 收集被 scopes 覆盖的源码文件（排序后返回，保证摘要稳定）。
 *
 * scope 以 `/` 结尾视为目录，否则视为单文件；不存在的 scope 静默跳过
 * （场景可能声明了尚未创建的目录）。
 */
export function collectCovered(root: string, scopes: readonly string[]): string[] {
  const files = new Set<string>()
  for (const scope of scopes) {
    const normalized = scope.replace(/\\/g, '/')
    if (normalized.endsWith('/')) {
      walk(root, normalized, files)
      continue
    }
    try {
      readFileSync(join(root, normalized))
      files.add(normalized)
    } catch {
      // 不存在的单文件 scope：跳过
    }
  }
  return [...files].sort()
}

/**
 * 源码摘要：按路径排序后逐个喂入「路径 + 规范化内容」。
 *
 * 换行统一成 `LF` 再入摘要，避免 Windows 的 CRLF 让同一份源码算出两个摘要。
 */
export function digestOf(root: string, files: readonly string[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file)
    hash.update('\0')
    hash.update(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

/** 场景的覆盖面摘要（读 scenario.json 的 coveredSources）。 */
export function digestOfScopes(root: string, scopes: readonly string[]): string {
  return digestOf(root, collectCovered(root, scopes))
}
