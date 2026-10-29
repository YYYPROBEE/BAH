/**
 * `apps/desktop` 的构建（桌面端 02 / 03 §2.1）。
 *
 * ## 为什么 main 是 ESM、preload 必须是 CJS
 *
 * Electron 39 的**沙箱化 preload** 只支持 CJS（没有 ESM preload loader）。
 * 写成 `.mjs` 的结果不是"报错"，而是 preload 静默不执行 → `window.bahDesktop` 是
 * `undefined`，页面看起来正常、四消息一条都没有。所以 preload 那一份强制 `cjs`，
 * 且有门禁 G2 钉住它的形状。
 *
 * ## 为什么 `@bah/*` **不**打进 bundle（与 03 §2.1 原文相反，见 D-02-2）
 *
 * 原文要求 `noExternal: [/^@bah\//]`，理由是"避免 pnpm 符号链接进 zip"。实测两条硬伤：
 *
 * 1. **同一模块会存在两份**：`main.mjs` 里内联一份 `@bah/util`，而外部包
 *    （`@bah/safety` 的 `dist/index.js`）又 `import '@bah/util'` 一份。全仓 21 处
 *    `error instanceof BahError` 会因跨副本而恒为 `false`——错误码静默退化成兜底码，
 *    表现是"能跑、但错误分类全错"，比崩溃更难查。
 * 2. **打散 `@bah/safety` 的文件定位**：`sandbox-runtime/modules.ts` 的
 *    `packageRoot()` 从 `import.meta.url` 向上找 `@bah/safety` 的 `package.json`
 *    来决定 worker 文件在哪。内联后 `import.meta.url` 变成 `dist/main.mjs`，
 *    一路走到盘根也找不到该包 → 启动直接失败（`package-root-missing`）。
 *
 * 结论：主进程只产"接线"，依赖靠 `node_modules` 的真实目录树（03 用扁平化拷贝，
 * 不带符号链接）。`electron` 必须 external（由运行时提供）。
 */

import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: { main: 'src/main.ts' },
    format: ['esm'],
    outDir: 'dist',
    outExtensions: () => ({ js: '.mjs' }),
    platform: 'node',
    target: 'node22',
    // electron 由运行时提供；tsx 只在 dev 分支被**动态** import，保留为外部依赖。
    // ⚠ `tsx` 必须写成 `/^tsx(\/|$)/` 而不是字面量 'tsx'：dev 分支 import 的是
    // **子路径** `tsx/esm/api`，字面量只匹配裸名，子路径会被打进 bundle
    // （第一次构建就中了：多出 api-*.mjs / lexer-*.mjs 两个分片，而那两个分片
    //  在便携 zip 里没人管）。
    external: ['electron', /^tsx(\/|$)/],
    dts: false,
    clean: false,
  },
  {
    entry: { preload: 'src/preload.ts' },
    format: ['cjs'],
    outDir: 'dist',
    outExtensions: () => ({ js: '.cjs' }),
    platform: 'node',
    target: 'node22',
    external: ['electron'],
    dts: false,
    clean: false,
  },
])

