/**
 * 运行位置相关的模块定位（施工单 11 §3）。
 *
 * 沙箱的 worker 入口与执行体是**按文件路径加载**的，而这个仓库有三种运行位置：
 * vitest（别名指向 `src/`）、`tsx`（`pnpm bah`，同样是 `src/`）、以及跨包真实运行时
 * （`node_modules/@bah/safety` → `dist/`）。因此路径必须跟着"调用者自己在哪"走：
 * 调用者是 `.ts` 就用 `src/*.ts`，是 `.js` 就用 `dist/*.js`。
 *
 * 文件不存在一律抛错——"加载不到沙箱入口"是装配缺陷，不许降级成进程内执行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { sandboxError } from '../sandbox-policy/policy.ts'

/** 本包 `package.json` 的名字（向上找包根的判据）。 */
const PACKAGE_NAME = '@bah/safety'

/** 向上找目录的安全上限（防止文件系统异常时死循环）。 */
const MAX_HOPS = 24

/**
 * 由调用者的 `import.meta.url` 定位本包根目录。
 *
 * @throws `bah-sandbox: package-root-missing` 一路走到盘根也没找到 `@bah/safety` 的 package.json
 */
export function packageRoot(importerUrl: string = import.meta.url): string {
  let current = dirname(fileURLToPath(importerUrl))
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest) && readName(manifest) === PACKAGE_NAME) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw sandboxError('package-root-missing', `无法从 ${importerUrl} 定位 ${PACKAGE_NAME} 包根`, {
    importerUrl,
  })
}

/**
 * 解析一个包内模块的 file:// href（`relative` 形如 `sandbox-runtime/worker`，不带扩展名）。
 *
 * @throws `bah-sandbox: module-missing` 目标文件不存在
 */
export function sandboxModuleUrl(relative: string, importerUrl: string = import.meta.url): string {
  const fromSource = fileURLToPath(importerUrl).endsWith('.ts')
  const path = join(
    packageRoot(importerUrl),
    fromSource ? 'src' : 'dist',
    `${relative}.${fromSource ? 'ts' : 'js'}`,
  )
  if (!existsSync(path)) {
    throw sandboxError('module-missing', `沙箱模块文件不存在：${path}`, { path, fromSource })
  }
  return pathToFileURL(path).href
}

/** 读 package.json 的 `name`（读不动或不是对象都算"这一层不是包根"）。 */
function readName(manifest: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const name = (parsed as { name?: unknown }).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}
