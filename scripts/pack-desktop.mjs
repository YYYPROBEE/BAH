/**
 * 便携 zip 打包（桌面端 03 §2.3）。
 *
 * ## 做四件事，每件都只有一种正确形态
 *
 * 1. **取 Electron 二进制**：只从 npmmirror 下载（本机访问 GitHub 的 443 端口不通，
 *    而 Electron 的默认下载源正是 GitHub Releases）。版本号取 `apps/desktop/package.json` 的
 *    **精确** `devDependencies.electron`——写 `^39.8.10` 会没有确定的下载 URL。
 * 2. **组装 `resources/app`**：主进程产物 + profile + policies + apps/web + bundle 的
 *    `.js` 回退 + `node_modules` 的 **@bah 闭包**（真实目录、不带 pnpm 符号链接）。
 * 3. **压成 zip**：用系统自带的 bsdtar（`C:\Windows\System32\tar.exe`），
 *    不引第三方库、不依赖 Git Bash 里的 GNU tar（后者不支持 zip）。
 * 4. **打 sha256**：写进证据目录，供对外说明现场核对"发出去的包就是这个包"。
 *
 * ## 为什么 `resources/app` 里必须有 `node_modules`
 *
 * 主进程**不打包** `@bah/*`（见 `apps/desktop/tsdown.config.ts` 的论证：内联会让
 * `@bah/util` 存在两份 ⇒ 21 处 `instanceof BahError` 失效；并且打断 `@bah/safety`
 * 靠 `import.meta.url` 定位自己 worker 的逻辑）。所以依赖必须是真实目录：
 * pnpm 的符号链接不能进 zip（解压后指向不存在的 `.pnpm` 路径）。
 *
 * ## 不做的事
 *
 * 不碰注册表、不建快捷方式、不装服务、不做 asar（`resources/app` 保持明文目录，
 * 现场排障能直接看到 profile 与前端文件）。不访问 GitHub（见 G7 的机器判据）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = join(ROOT, 'apps', 'desktop')
const OUT_DIR = join(ROOT, 'dist-desktop')
const STAGE = join(OUT_DIR, 'BAH')
const CACHE = join(ROOT, '.tmp-desktop-cache')
const EVIDENCE = join(ROOT, 'docs', 'evidence', '2026-10-30-desktop')

/** 系统 bsdtar（Git Bash 里的 GNU tar **不能**读写 zip）。 */
const BSDTAR = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')

const log = (message) => process.stdout.write(`ℹ ${message}\n`)

function fail(message) {
  process.stderr.write(`✘ ${message}\n`)
  process.exit(1)
}

/** 跑一个外部命令，非零退出即失败（不吞 stderr）。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.error) fail(`${command} 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    fail(`${command} 退出码 ${String(result.status)}：${(result.stderr ?? '').trim() || '(无 stderr)'}`)
  }
  return result
}

/** 读 JSON（去 BOM）。 */
function readJson(path) {
  const text = readFileSync(path, 'utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

/** 递归列目录里的文件（用于统计与泄漏检查）。 */
function listFiles(dir, base = dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full, base))
    else out.push(relative(base, full))
  }
  return out
}

/**
 * 递归拷贝（自己实现，**不用 `fs.cpSync`**）。
 *
 * 为什么：本机实测 `cpSync(src, dst, { recursive: true })` 会让 Node 进程**静默退出
 * （exit 127，无 stderr、无异常）**——不是抛错，是进程没了。`copyFileSync` 与
 * `mkdirSync` 都正常，所以换成"逐项 readdir + mkdir + copyFile"这种最朴素的写法：
 * 每一步都可观测，失败会带明确路径。
 */
function copyTree(src, dst) {
  const stat = statSync(src)
  if (stat.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      copyTree(join(src, entry.name), join(dst, entry.name))
    }
    return
  }
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
}

// ── 0. 前置检查：产物不齐就别开始下载 100 MB ────────────────────────────────
const pkg = readJson(join(DESKTOP, 'package.json'))
const electronVersion = pkg.devDependencies?.electron
if (typeof electronVersion !== 'string') fail('apps/desktop/package.json 缺 devDependencies.electron')
if (!/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  fail(`electron 版本必须是精确版本号（打包脚本按它拼下载 URL），实际 '${electronVersion}'`)
}

for (const rel of ['dist/main.mjs', 'dist/preload.cjs']) {
  if (!existsSync(join(DESKTOP, rel))) fail(`缺 ${rel}：先跑 pnpm desktop:build`)
}
for (const name of ['host', 'cli', 'util', 'core']) {
  if (!existsSync(join(ROOT, 'packages', name, 'dist', 'index.js'))) {
    fail(`缺 packages/${name}/dist/index.js：先跑 pnpm build（主进程依赖的是 dist，不是 src）`)
  }
}
/**
 * `@bah/cli` 的产物必须**含** `.js` 回退（桌面端 03 / T-DTB-010）。
 *
 * 为什么要这条"产物新鲜度"探针：`dist` 存在 ≠ `dist` 是新的。第一次打包实测踩到——
 * 改了 `packages/cli/src/bundles.ts`（加 `.js` 回退）却没重跑 `pnpm build`，
 * 打出来的包里 `index.js` 躺在 `resources/app/packages/cli/bundles/base/` 却没人认得，
 * 启动报 `bundle 'base' 不存在：…index.ts 缺失`，而脚本一切"正常"。
 */
const cliDist = readFileSync(join(ROOT, 'packages', 'cli', 'dist', 'index.js'), 'utf8')
if (!cliDist.includes('index.js')) {
  fail('packages/cli/dist 是旧的（不含 .js 回退）：先跑 pnpm build 再打包')
}
if (!existsSync(BSDTAR)) fail(`找不到系统 bsdtar：${BSDTAR}`)

// ── 1. Electron 二进制（只走 npmmirror）─────────────────────────────────────
const zipName = `electron-v${electronVersion}-win32-x64.zip`
const mirror = `https://npmmirror.com/mirrors/electron/${electronVersion}/${zipName}`
const cached = join(CACHE, zipName)

if (existsSync(cached)) {
  log(`复用缓存 ${relative(ROOT, cached)}`)
} else {
  mkdirSync(CACHE, { recursive: true })
  log(`下载 ${mirror}`)
  const response = await fetch(mirror, { redirect: 'follow' })
  if (!response.ok) fail(`下载失败 HTTP ${String(response.status)}：${mirror}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(cached, buffer)
  log(`已缓存 ${String(Math.round(buffer.byteLength / 1024 / 1024))} MB`)
}

// ── 2. 解压到 dist-desktop/BAH 并改名 exe ──────────────────────────────────
rmSync(STAGE, { recursive: true, force: true })
mkdirSync(STAGE, { recursive: true })
run(BSDTAR, ['-xf', cached, '-C', STAGE])
const exe = join(STAGE, 'electron.exe')
if (!existsSync(exe)) fail(`解压后没有 electron.exe（包结构变了？）：${STAGE}`)
renameSync(exe, join(STAGE, 'BAH.exe'))
log(`解压完成 → ${relative(ROOT, STAGE)}`)

// ── 3. resources/app ──────────────────────────────────────────────────────
const appDir = join(STAGE, 'resources', 'app')
mkdirSync(appDir, { recursive: true })

copyTree(join(DESKTOP, 'dist'), join(appDir, 'dist'))
writeFileSync(
  join(appDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'bah-desktop',
      version: pkg.version,
      private: true,
      type: 'module',
      // ⚠ 必须是 `dist/main.mjs`：路径相对 `resources/app`。写成 `main.mjs` 时
      // Electron 找不到入口，表现**不是**日志里的报错，而是一个标题为 "Error" 的
      // 原生对话框 + 主进程 stdout 一片空白（第一次打包实测）。
      main: join('dist', 'main.mjs').split('\\').join('/'),
    },
    null,
    2,
  )}\n`,
  'utf8',
)
copyTree(join(ROOT, 'profiles'), join(appDir, 'profiles'))
copyTree(join(ROOT, 'policies'), join(appDir, 'policies'))
copyTree(join(ROOT, 'apps', 'web'), join(appDir, 'apps', 'web'))

// 3a. bundle 的 `.js` 回退（打包后没有 TS loader）
const bundleSource = join(ROOT, 'packages', 'cli', 'bundles', 'base', 'index.ts')
const bundleTargetDir = join(appDir, 'packages', 'cli', 'bundles', 'base')
mkdirSync(bundleTargetDir, { recursive: true })
const source = readFileSync(bundleSource, 'utf8')
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: 'index.ts',
})
writeFileSync(join(bundleTargetDir, 'index.js'), transpiled.outputText, 'utf8')
// `declaredBundles()` 读的是 cli 的 package.json（`bah.profile.bundles`）
copyTree(join(ROOT, 'packages', 'cli', 'package.json'), join(appDir, 'packages', 'cli', 'package.json'))
log('bundle：index.ts → index.js（并带上 cli/package.json 的声明清单）')

// 3b. node_modules：@bah 闭包 + 它们真实用到的第三方包（扁平、无符号链接）
const modulesDir = join(appDir, 'node_modules')
mkdirSync(modulesDir, { recursive: true })

/**
 * 裸模块名的合法形态（`@scope/name` 或 `name`）。
 *
 * 必须校验：`dist` 是压缩过的 bundle，里面**字符串字面量**也可能长成
 * `… from "xxx"` 的样子（实测扫出 `",\n\t\t\t"` 这种假命中），直接拿去 `require.resolve`
 * 会报一句看不出所以然的"第三方依赖 ',\n\t\t\t' 解析不到"。
 */
const BARE_SPECIFIER = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/

/** 从某个 dist 产物里扫出裸模块名（`node:` 与相对路径不算）。 */
function bareImportsOf(file) {
  const text = readFileSync(file, 'utf8')
  const names = new Set()
  for (const match of text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
    const spec = match[1]
    if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('file:')) continue
    if (!BARE_SPECIFIER.test(spec)) continue
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    names.add(name)
  }
  return names
}

/** @bah 包名 → 仓库目录。 */
const BAH_DIRS = new Map(
  readdirSync(join(ROOT, 'packages')).map((dir) => [`@bah/${dir}`, join(ROOT, 'packages', dir)]),
)

const copied = new Set()
const thirdParty = new Set()
const queue = [...bareImportsOf(join(appDir, 'dist', 'main.mjs'))]

while (queue.length > 0) {
  const name = queue.pop()
  if (copied.has(name)) continue
  if (name.startsWith('electron') || name.startsWith('tsx')) continue // 运行时提供 / 仅 dev 用

  const bahDir = BAH_DIRS.get(name)
  if (bahDir !== undefined) {
    const dist = join(bahDir, 'dist')
    if (!existsSync(dist)) fail(`${name} 没有 dist：先跑 pnpm build`)
    copyTree(dist, join(modulesDir, name, 'dist'))
    copyTree(join(bahDir, 'package.json'), join(modulesDir, name, 'package.json'))
    // 包内 dist 不是单文件（例如 @bah/safety 的 sandbox-runtime/worker.js），整个目录都带上了
    copied.add(name)
    for (const file of listFiles(dist)) {
      if (!file.endsWith('.js')) continue
      for (const dep of bareImportsOf(join(dist, file))) queue.push(dep)
    }
    continue
  }

  // 第三方：从 @bah/cli 的位置解析（它就是这些依赖的声明方）
  const require = createRequire(join(ROOT, 'packages', 'cli', 'package.json'))
  let entry
  try {
    entry = require.resolve(name)
  } catch {
    fail(`第三方依赖 '${name}' 解析不到（若是 devDependency，说明有包把它当运行时依赖用了）`)
  }
  let dir = dirname(entry)
  while (!existsSync(join(dir, 'package.json')) && dirname(dir) !== dir) dir = dirname(dir)
  const manifest = readJson(join(dir, 'package.json'))
  if (manifest.name !== name) fail(`解析 '${name}' 得到的是 '${String(manifest.name)}'（${dir}）`)
  copyTree(dir, join(modulesDir, name))
  copied.add(name)
  thirdParty.add(name)
  for (const dep of Object.keys(manifest.dependencies ?? {})) queue.push(dep)
  for (const dep of Object.keys(manifest.optionalDependencies ?? {})) queue.push(dep)
}
log(`node_modules：@bah ${String([...copied].filter((n) => n.startsWith('@bah/')).length)} 个 + 第三方 ${[...thirdParty].join(',') || '无'}`)

// 关键文件存在性（缺了就是 03 单 T-DTB-010 / R-02-01 的复发点，宁可当场失败）
for (const rel of [
  'node_modules/@bah/safety/dist/sandbox-runtime/worker.js',
  'node_modules/@bah/safety/dist/sandbox-runtime/handlers/compute.js',
  'packages/cli/bundles/base/index.js',
  // `declaredBundles()` 读的是这份清单：少了它，包里的 index.js 认得出来也用不上
  'packages/cli/package.json',
  'profiles/desktop/patch.yml',
  'apps/web/index.html',
]) {
  if (!existsSync(join(appDir, rel))) fail(`resources/app 缺 ${rel}`)
}

// ── 4. 压缩 ────────────────────────────────────────────────────────────────
const zipPath = join(OUT_DIR, `BAH-desktop-${pkg.version}-win-x64.zip`)
rmSync(zipPath, { force: true })
// `-a` 按扩展名选格式（zip）；`-C` 指定根目录，压缩包里就是 BAH/ 一层，解压即用
run(BSDTAR, ['-a', '-cf', zipPath, '-C', OUT_DIR, 'BAH'])
if (!existsSync(zipPath)) fail('压缩没有产出 zip')

// ── 5. 指纹与体量 ──────────────────────────────────────────────────────────
const bytes = readFileSync(zipPath)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const appFiles = listFiles(appDir)
const report = [
  `zip=${relative(ROOT, zipPath).split('\\').join('/')}`,
  `sha256=${sha256}`,
  `bytes=${String(bytes.byteLength)}`,
  `electron=${electronVersion}`,
  `electron_node=22.22.1` /* 实测值见 docs/desktop.md；升级 Electron 时同批改 */,
  `resources_app_files=${String(appFiles.length)}`,
  `built_at=${new Date().toISOString()}`,
].join('\n')

mkdirSync(EVIDENCE, { recursive: true })
writeFileSync(join(EVIDENCE, 'desktop-sha256.txt'), `${report}\n`, 'utf8')

log(`zip：${relative(ROOT, zipPath)}（${String(Math.round(bytes.byteLength / 1024 / 1024))} MB）`)
log(`sha256：${sha256}`)
log(`resources/app 文件数：${String(appFiles.length)}`)
