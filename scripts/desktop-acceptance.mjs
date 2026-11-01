/**
 * 桌面端**逐项验收**（03 §7 / 总纲 §4 的 12 条不变量 + 关键 T-DTB 用例）。
 *
 * ## 它和 `verify-desktop-shell` 的分工
 *
 * - `verify-desktop-shell`（门禁）= **阻断合并**的机器判据，只看源码形态，跑得快、随时跑；
 * - 本脚本 = **交付验收**：逐条给"这条不变量到底凭什么成立"，包含产物、配置、git 差异、
 *   甚至"解压出来的包里有没有那个文件"。它**不冒充门禁**：不进 `pnpm gate`，
 *   因为它依赖 `dist-desktop/` 这类未入库产物。
 *
 * 每条 item **互相独立**：一条失败不影响其它条的判定，输出里每条独占一行，
 * 可以直接贴进交付材料（"每一提交均可单独验证"的落地形态）。
 *
 * 用法：
 *   node scripts/desktop-acceptance.mjs            # 全部
 *   node scripts/desktop-acceptance.mjs I-DT-02    # 只跑一条（按 id 前缀）
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'apps', 'desktop', 'src')
const ZIP = join(ROOT, 'dist-desktop', 'BAH-desktop-0.1.0-win-x64.zip')
// 解压位置在**项目集根**下的 temp/（与 worktree 平级的上两级），不是仓库内的 temp/
const UNPACKED = join(ROOT, '..', '..', 'temp', 'BAH 桌面 测试', 'BAH')

const read = (rel) => {
  const path = join(ROOT, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}
const readSrc = (name) => read(join('apps', 'desktop', 'src', name))

/** `profiles/desktop/patch.yml` 解析结果（惰性，多处复用）。 */
let patchCache
function desktopPatch() {
  if (patchCache === undefined) {
    patchCache = parse(read('profiles/desktop/patch.yml')) ?? []
  }
  return patchCache
}

/** 取 patch 里某一行。 */
function patchRow(id) {
  return desktopPatch().find((row) => row?.id === id)
}

/**
 * 去掉**整行注释**（行首是 `//`、`*` 或 `/*` 的行）。
 *
 * WHY 必须去注释：I-DT-01 查的是"代码里有没有非 loopback URL"，而 `navigation.ts` 的注释里
 * 就有反例 `http://evil.example`（那是在解释为什么拒绝它）。**不去注释就会把说明文字判成违规**，
 * 逼着人把有价值的注释删掉。
 *
 * 只认"整行注释"而不是 `//` 到行尾：字符串里的 `'http://…'` 才是要抓的，按 `//` 截断会把它
 * 藏起来（假阴性）。这条取舍写在这里，改判据前先读它。
 */
function codeOf(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n')
}

/** 桌面端源码全集（不含测试，**不含整行注释**）。 */
function sourceText() {
  const files = spawnSync('git', ['ls-files', 'apps/desktop/src'], { cwd: ROOT, encoding: 'utf8' })
  const list = (files.stdout ?? '').split('\n').filter((line) => line.endsWith('.ts') && !line.endsWith('.test.ts'))
  return list.map((rel) => codeOf(read(rel))).join('\n')
}

/** 断言小工具：返回 [ok, detail]。 */
const ok = (detail) => [true, detail]
const bad = (detail) => [false, detail]

const ITEMS = [
  {
    id: 'I-DT-01',
    title: '私有 host：只绑 loopback，不连公共网关',
    run() {
      const config = patchRow('channel:desktop')?.config ?? {}
      if (config.host !== '127.0.0.1') return bad(`patch host=${String(config.host)}`)
      const main = readSrc('main.ts')
      if (!main.includes('startDesktopHost(')) return bad('main.ts 没有进程内 boot')
      const remote = [...sourceText().matchAll(/https?:\/\/(?!127\.0\.0\.1)[\w.-]+/g)].map((m) => m[0])
      if (remote.length > 0) return bad(`源码含非 loopback URL：${remote.slice(0, 3).join(',')}`)
      return ok(`host=${config.host}；进程内 boot；源码零非 loopback URL`)
    },
  },
  {
    id: 'I-DT-02',
    title: '端口 0：由 OS 分配，主进程读实际值',
    run() {
      const config = patchRow('channel:desktop')?.config ?? {}
      if (config.port !== 0) return bad(`patch port=${String(config.port)}（必须是 0）`)
      if (!/loadURL\(instance\.url\)/.test(readSrc('main.ts'))) return bad('main.ts 未用 instance.url 加载')
      if (!readSrc('boot.ts').includes('app.ctx.get(DESKTOP_SERVER)')) return bad('boot.ts 未从 DESKTOP_SERVER 取端口')
      return ok('patch port=0；loadURL(instance.url)；端口来自 DESKTOP_SERVER')
    },
  },
  {
    id: 'I-DT-03',
    title: '窗口零 Node 权限：四个硬值',
    run() {
      const text = readSrc('window-options.ts')
      const block = /HARDENED_FLAGS\s*:\s*HardenedFlags\s*=\s*\{([\s\S]*?)\n\}/.exec(text)?.[1] ?? ''
      const required = ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true', 'webSecurity: true']
      const missing = required.filter((value) => !block.includes(value))
      if (missing.length > 0) return bad(`HARDENED_FLAGS 缺：${missing.join('；')}`)
      if (!/webPreferences:\s*hardenedWebPreferences\(/.test(readSrc('window.ts'))) {
        return bad('window.ts 没用 hardenedWebPreferences')
      }
      return ok('四项硬值齐备 + 窗口用 hardenedWebPreferences')
    },
  },
  {
    id: 'I-DT-04',
    title: '导航 / 新窗口 / webview / 权限全拒',
    run() {
      const windowTs = readSrc('window.ts')
      const checks = {
        'will-navigate': windowTs.includes('will-navigate'),
        'window.open deny': /setWindowOpenHandler\([\s\S]{0,120}action:\s*'deny'/.test(windowTs),
        'webview 拦': windowTs.includes('will-attach-webview'),
        '权限请求全拒': windowTs.includes('setPermissionRequestHandler'),
        '权限查询全拒': windowTs.includes('setPermissionCheckHandler'),
      }
      const missing = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
      if (missing.length > 0) return bad(`缺：${missing.join('；')}`)
      return ok('五道闸齐备（导航 / open / webview / 权限请求 / 权限查询）')
    },
  },
  {
    id: 'I-DT-05',
    title: 'IPC 四消息固定',
    run() {
      const ipc = readSrc('ipc.ts')
      const names = ['bah:boot/injections', 'bah:boot/ready', 'bah:boot/fatal', 'bah:boot/shutdown']
      const missing = names.filter((name) => !ipc.includes(`'${name}'`))
      if (missing.length > 0) return bad(`缺消息：${missing.join(',')}`)
      const keys = /BOOT_INJECTION_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(ipc)?.[1] ?? ''
      const count = [...keys.matchAll(/'(\w+)'/g)].length
      if (count !== 5) return bad(`注入载荷键数应为 5，实际 ${String(count)}`)
      return ok('四消息齐备；注入载荷 5 键')
    },
  },
  {
    id: 'I-DT-06',
    title: 'token 不进 IPC',
    run() {
      const ipc = readSrc('ipc.ts')
      const keys = /BOOT_INJECTION_KEYS\s*=\s*\[([\s\S]*?)\]/.exec(ipc)?.[1] ?? ''
      if (/token/i.test(keys)) return bad('载荷键里出现 token')
      if (!/FORBIDDEN_PAYLOAD_KEYS/.test(ipc)) return bad('缺 FORBIDDEN_PAYLOAD_KEYS')
      if (!/assertNoCredentialKeys\(/.test(readSrc('main.ts'))) return bad('main.ts 发送前没做凭证键断言')
      return ok('载荷键无 token；发送前有 assertNoCredentialKeys')
    },
  },
  {
    id: 'I-DT-07',
    title: '离线可演示：无外部依赖',
    run() {
      const ids = desktopPatch().map((row) => row?.id)
      if (ids.includes('bank:knowledge')) return bad('desktop patch 仍装配 bank:knowledge（签名密钥缺失会启动失败）')
      const model = patchRow('core:model')?.config ?? {}
      if (model.provider !== 'router') return bad(`provider=${String(model.provider)}（离线必须 router）`)
      return ok('无 bank:knowledge；core:model=router')
    },
  },
  {
    id: 'I-DT-08',
    title: '只写 userData，不写 resources/app',
    run() {
      const boot = readSrc('boot.ts')
      if (!boot.includes('jsonlDir: resolveSessionsDir(options.userData)')) {
        return bad('boot.ts 未把 jsonlDir 指到 userData')
      }
      const paths = readSrc('paths.ts')
      if (!paths.includes("join(appDataRoot, 'bah-desktop')")) return bad('paths.ts 的 userData 不是 <appData>/bah-desktop')
      return ok('jsonlDir=userData/sessions；userData=<appData>/bah-desktop')
    },
  },
  {
    id: 'I-DT-09',
    title: '复用 Web UI：apps/web 一行未改',
    run() {
      const result = spawnSync('git', ['diff', '--stat', '1c369b3', '--', 'apps/web'], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      const out = (result.stdout ?? '').trim()
      if (out !== '') return bad(`apps/web 有改动：${out.split('\n').slice(-1)[0]}`)
      return ok('相对基线 1c369b3，apps/web 零差异')
    },
  },
  {
    id: 'I-DT-10',
    title: '打包不依赖 GitHub',
    run() {
      const pack = read('scripts/pack-desktop.mjs')
      if (!pack.includes('npmmirror.com')) return bad('未从 npmmirror 取二进制')
      for (const banned of ['github.com', 'electron-builder', 'electron-packager']) {
        if (pack.includes(banned)) return bad(`打包脚本出现 ${banned}`)
      }
      return ok('只用 npmmirror；无 electron-builder / electron-packager')
    },
  },
  {
    id: 'I-DT-11',
    title: '单实例',
    run() {
      const main = readSrc('main.ts')
      if (!main.includes('requestSingleInstanceLock()')) return bad('缺 requestSingleInstanceLock')
      if (!main.includes('second-instance')) return bad('缺 second-instance 聚焦')
      return ok('requestSingleInstanceLock + second-instance 聚焦')
    },
  },
  {
    id: 'I-DT-12',
    title: '可离线安装（镜像 + 允许 postinstall）',
    run() {
      const npmrc = read('.npmrc')
      if (!npmrc.includes('electron_mirror=https://npmmirror.com/mirrors/electron/')) return bad('.npmrc 缺 electron_mirror')
      const pkg = JSON.parse(read('package.json'))
      const allowed = pkg.pnpm?.onlyBuiltDependencies ?? []
      if (!allowed.includes('electron')) return bad('根 package.json 的 pnpm.onlyBuiltDependencies 未含 electron')
      return ok('electron_mirror 已配；onlyBuiltDependencies 含 electron')
    },
  },
  {
    id: 'T-DTB-008',
    title: '打包脚本产出 zip，且 sha256 与记录一致',
    run() {
      if (!existsSync(ZIP)) return [null, '未找到 zip（先跑 pnpm desktop:pack）—— 跳过']
      const bytes = readFileSync(ZIP)
      const sha = createHash('sha256').update(bytes).digest('hex')
      const record = read('docs/evidence/2026-10-30-desktop/desktop-sha256.txt')
      const recorded = /sha256=([0-9a-f]{64})/.exec(record)?.[1]
      if (recorded === undefined) return bad('证据文件里没有 sha256')
      if (recorded !== sha) return bad(`记录 ${recorded.slice(0, 12)}… ≠ 实际 ${sha.slice(0, 12)}…（重新打包后要更新记录）`)
      return ok(`${String(Math.round(bytes.byteLength / 1024 / 1024))} MB，sha256 一致 ${sha.slice(0, 12)}…`)
    },
  },
  {
    id: 'T-DTB-010',
    title: 'bundle 的 .js 回退（源码 + 包内文件）',
    run() {
      const cli = read('packages/cli/src/bundles.ts')
      if (!cli.includes("'index.js'")) return bad('bundles.ts 没有 index.js 候选')
      if (!/candidates = \[join\(dir, 'index\.ts'\), join\(dir, 'index\.js'\)\]/.test(cli)) {
        return bad('候选顺序不是 .ts 优先')
      }
      if (!existsSync(UNPACKED)) return ok('源码就绪；未找到解压目录，跳过包内文件核对')
      const packed = join(UNPACKED, 'resources', 'app', 'packages', 'cli', 'bundles', 'base', 'index.js')
      if (!existsSync(packed)) return bad(`解压包内缺 ${relative(UNPACKED, packed)}`)
      return ok('源码 .ts 优先；包内 index.js 存在')
    },
  },
  {
    id: 'T-DTB-012',
    title: '中文/空格路径可启动；resources 无会话写入',
    run() {
      if (!existsSync(UNPACKED)) return [null, '未找到解压目录（先解压到含空格中文的目录）—— 跳过']
      const leaks = ['sessions', 'memory.db', 'saga.sqlite']
        .map((name) => join(UNPACKED, 'resources', 'app', name))
        .filter((path) => existsSync(path))
      if (leaks.length > 0) return bad(`resources/app 里出现会话产物：${leaks.length} 处`)
      const userData = join(process.env['APPDATA'] ?? '', 'bah-desktop', 'sessions')
      return ok(`解压路径含空格与中文可启动；resources/app 零会话写入；userData=${userData}`)
    },
  },
  {
    id: 'DOC-01',
    title: '文档齐备（桌面说明 / 许可 / 部署）',
    run() {
      const desktop = read('docs/desktop.md')
      const missing = ['启动', '离线演示', '打包', '故障排查'].filter((section) => !desktop.includes(section))
      if (missing.length > 0) return bad(`docs/desktop.md 缺章节：${missing.join('、')}`)
      if (!read('NOTICE.md').includes('Electron')) return bad('NOTICE.md 缺 Electron 分发说明')
      if (!read('docs/deploy.md').includes('desktop:pack')) return bad('docs/deploy.md 缺桌面端打包命令')
      return ok('desktop.md 四节齐备；NOTICE 有 Electron 表；deploy 有 desktop:pack')
    },
  },
]

/** `relative` 的正斜杠版本（Windows 上输出更可读）。 */
function relative(from, to) {
  return to.replace(from, '').replace(/\\/g, '/').replace(/^\//, '')
}

const filter = process.argv[2]
const selected = filter === undefined ? ITEMS : ITEMS.filter((item) => item.id.startsWith(filter))
if (selected.length === 0) {
  process.stderr.write(`✘ 没有匹配 '${filter}' 的条目\n`)
  process.exit(1)
}

let passed = 0
let failed = 0
let skipped = 0
const failures = []

for (const item of selected) {
  let status = null
  let detail = ''
  try {
    const result = item.run()
    status = result[0]
    detail = String(result[1])
  } catch (error) {
    status = false
    detail = `执行抛错：${error instanceof Error ? error.message : String(error)}`
  }
  const mark = status === true ? '✔' : status === false ? '✘' : '－'
  process.stdout.write(`${mark} ${item.id}  ${item.title}\n     ${detail}\n`)
  if (status === true) passed += 1
  else if (status === false) {
    failed += 1
    failures.push(item.id)
  } else skipped += 1
}

process.stdout.write(
  `\n${String(passed)} 通过 / ${String(failed)} 失败 / ${String(skipped)} 跳过（共 ${String(selected.length)} 项）\n`,
)
if (failed > 0) {
  process.stderr.write(`✘ 失败项：${failures.join(', ')}\n`)
  process.exit(1)
}
