/**
 * 四个测试面共用的解析配置（施工单 01 §5 的 unit / e2e / snapshot / web）。
 *
 * **为什么要 alias**：各包 `exports` 指向 `dist/`（发布面）。测试若按包名解析，就会跑到
 * **构建产物**上——改了 `src` 忘了 `pnpm build` 时，用例会静默跑旧代码（阶段 2 就踩过这个隐患）。
 * 测试面因此统一指向各包的 `src/index.ts`：与 `tsc -b`（project references）看到的是同一份源码。
 *
 * 边界：这只是**测试面**规则；包与包之间的真实运行时依赖仍走包名 + `dist/`
 * （施工单 02 §8 第 1 条：任何环境裸 Node 可加载）。
 */

import { fileURLToPath } from 'node:url'

/** 12 个物理包（施工单 00 §6）。 */
const PACKAGE_DIRS = [
  'core',
  'runtime',
  'llm',
  'interaction',
  'safety',
  'bank',
  'persistence',
  'saga',
  'host',
  'channels',
  'cli',
  'test-support',
  'util',
] as const

/** 包内 `src/` 目录的绝对路径（带结尾分隔符，便于拼子路径）。 */
const sourceDir = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/`, import.meta.url))

/**
 * `@bah/<pkg>` → `packages/<pkg>/src/index.ts`；
 * `@bah/<pkg>/<sub>` → `packages/<pkg>/src/<sub>/index.ts`（如 `@bah/llm/mock`）。
 */
export const bahSourceAlias = PACKAGE_DIRS.flatMap((name) => [
  {
    find: new RegExp(`^@bah/${name}$`),
    replacement: `${sourceDir(name)}index.ts`,
  },
  {
    find: new RegExp(`^@bah/${name}/(.+)$`),
    replacement: `${sourceDir(name)}$1/index.ts`,
  },
])
