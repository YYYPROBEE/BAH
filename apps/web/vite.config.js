/**
 * Vite 配置（M0 骨架，阶段 1）。
 *
 * 为什么是纯对象而不是 `import { defineConfig } from 'vite'`：
 * 阶段 1 的依赖白名单不含 vite（M0 只建目录 + vite.config.js），
 * 因此这里不引入 vite 的运行时依赖；待 接入 dev server 时再加 devDependency。
 *
 * @type {import('vite').UserConfig}
 */
export default {
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
}
