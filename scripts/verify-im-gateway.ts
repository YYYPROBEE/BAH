/**
 * 门禁：IM 网关的十三条安全不变量。
 *
 * 为什么这些必须是门禁而不是"复审时看一眼"：
 * 1. 验签常量时间、XML DTD 拒绝、host 固定 loopback 都是**安全判决**，
 *    它们在代码里只是一两行，删掉不会有任何测试失败（除非专门写了负控）；
 * 2. "Mock 不进生产"这种事，唯一的失效方式是某次调试把它 import 进 `main.ts`——
 *    人眼复审挡不住，机器扫描能。
 *
 * 判据一律**正向断言**（只认唯一合法形态），不做禁用词清单：禁用词写进脚本，
 * 脚本自身就是一次命中（`verify-visual-line.ts` 的教训）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 网关源码面。 */
const APP_DIR = 'apps/im-gateway'
const APP_SRC = 'apps/im-gateway/src'
/** 渠道协议面（微信实现住在这里）。 */
const CHANNEL_SRC = 'packages/channels/src/im'
/** 唯一允许定义 `PlatformAdapter` 的文件。 */
const ADAPTER_CONTRACT = 'packages/channels/src/im/platform.ts'
/** 微信配置文档（G8）。 */
const WECHAT_DOC = 'docs/wechat-setup.md'

/** 只扫源码（不扫测试与声明）。 */
const isSource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts')

/** 读文件（相对仓库根）。 */
function read(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    return ''
  }
}

/** 收集源码文件并返回 `相对路径 → 内容`。 */
function sources(root: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const dir of [APP_SRC, CHANNEL_SRC]) {
    for (const file of walk(root, [dir], isSource)) {
      result.set(relative(root, file).split('\\').join('/'), readFileSync(file, 'utf8'))
    }
  }
  return result
}

/** 提取 import / re-export 的模块说明符（只认真实依赖，不认注释里的名字）。 */
function importsOf(text: string): readonly string[] {
  return [...text.matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] ?? '')
}

/** 非注释行（行首 `//`、`/*`、`*` 的行不算代码）。 */
function codeLines(text: string): readonly { readonly line: string; readonly number: number }[] {
  return text
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')
    })
}

/**
 * 提取 `log.<level>(...)` 的完整参数片段（跨行也算一次调用）。
 *
 * 为什么不能按行查：日志调用常常跨行写（`{ reason, ... }` 在下一行），
 * 按行扫描会把"参数里带 userId"的跨行调用漏掉——这正是负控抓到的盲区。
 */
function logCalls(text: string): readonly { readonly line: number; readonly snippet: string }[] {
  const result: { line: number; snippet: string }[] = []
  const pattern = /\blog\.[a-z]+\(/g
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0
    let depth = 1
    let index = start + match[0].length
    while (index < text.length && depth > 0) {
      const char = text[index]
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      index += 1
    }
    result.push({ line: text.slice(0, start).split('\n').length, snippet: text.slice(start, index) })
  }
  return result
}

/** 所有网关文件（含测试与文档），G9/G12 用。 */
function allAppFiles(root: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const file of walk(root, [APP_DIR], (name) => !name.endsWith('.d.ts'))) {
    result.set(relative(root, file).split('\\').join('/'), readFileSync(file, 'utf8'))
  }
  return result
}

const gate: Gate = {
  name: 'im-gateway',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []
    const files = sources(root)
    const appFiles = allAppFiles(root)

    /** 取某个相对路径的源码。 */
    const src = (rel: string): string => files.get(rel) ?? read(root, rel)

    // ── G1：仓库内无真实 AppID / Secret / 回调 token 字面量 ────────────────
    const APPID = /\bwx[0-9a-f]{16}\b/gi
    const SECRET_LITERAL = /(?:appSecret|app_secret|secret)\s*[:=]\s*['"][A-Za-z0-9_-]{16,}['"]/i
    const scanG1 = [
      ...files.entries(),
      ['.env.example', read(root, '.env.example')] as [string, string],
      ['docs/wechat-setup.md', read(root, WECHAT_DOC)] as [string, string],
    ]
    for (const [rel, text] of scanG1) {
      if (APPID.test(text)) findings.push(`G1: ${rel} 出现形如真实 AppID 的字面量（只许用占位符）`)
      if (SECRET_LITERAL.test(text)) findings.push(`G1: ${rel} 出现形如真实 AppSecret 的字面量`)
      APPID.lastIndex = 0
    }
    notes.push(`G1 扫描 ${String(scanG1.length)} 个文件（源码 + .env.example + 微信文档）`)

    // ── G2：验签必须常量时间，且没有 `===` 比签名 ──────────────────────────
    const signature = src('packages/channels/src/im/protocol/signature.ts')
    if (!signature.includes('timingSafeEqual')) findings.push('G2: signature.ts 必须使用 timingSafeEqual')
    // 只查"用 `===` 比较签名值"的形态（长度判断不算）
    if (/presented\s*(===|!==)\s*expected|expected\s*(===|!==)\s*presented/.test(signature)) {
      findings.push('G2: signature.ts 用 `===` 比较签名（计时侧信道）')
    }

    // ── G3：XML 必须拒绝 DTD，且有 16 KiB 上限 ────────────────────────────
    const xml = src('packages/channels/src/im/protocol/xml.ts')
    for (const needle of ['DOCTYPE', 'ENTITY', 'WECHAT_XML_MAX_BYTES', 'im-xml-too-large']) {
      if (!xml.includes(needle)) findings.push(`G3: xml.ts 缺少 ${needle}`)
    }

    // ── G4：会话键 HMAC 输入含 platform；userId 不拼路径 ──────────────────
    const session = src('packages/channels/src/im/session.ts')
    if (!session.includes('${platform}')) findings.push('G4: session.ts 的 HMAC 输入必须含 platform（命名空间隔离）')
    for (const [rel, text] of files.entries()) {
      for (const [index, line] of text.split('\n').entries()) {
        if (!/\bjoin\(/.test(line)) continue
        if (/\buserId\b/.test(line)) findings.push(`G4: ${rel}:${String(index + 1)} 把 userId 拼进路径`)
      }
    }

    // ── G5：子进程 host 固定 loopback；网关不反代 /api/* ──────────────────
    const port = src('apps/im-gateway/src/session/port.ts')
    const overlay = src('apps/im-gateway/src/session/overlay.ts')
    if (!port.includes("'127.0.0.1'")) findings.push("G5: port.ts 的 CHILD_BIND_HOST 必须是 '127.0.0.1'")
    if (!overlay.includes('host: ${CHILD_BIND_HOST}')) findings.push('G5: overlay.ts 的 host 必须来自 CHILD_BIND_HOST')
    const server = src('apps/im-gateway/src/server.ts')
    if (server.includes("'/api/")) findings.push('G5: server.ts 出现 /api/ 路由（网关不反代子进程 API）')
    if (server.includes('0.0.0.0')) findings.push('G5: server.ts 出现 0.0.0.0（监听地址只许来自 Config）')

    // ── G6：运营桥必须存在，且"未配 token → 404 / 常量时间比较" ─────────────
    const operator = src('apps/im-gateway/src/handoff/operator.ts')
    for (const needle of ['/seat/', 'x-bah-operator-token', 'timingSafeEqual', 'operatorToken']) {
      if (!operator.includes(needle)) findings.push(`G6: handoff/operator.ts 缺少 ${needle}`)
    }
    if (!server.includes('SEAT_PREFIX') || !server.includes('im-not-found')) {
      findings.push('G6: server.ts 缺少"/seat/* 未启用即 404"的分支')
    }
    if (!server.includes('deps.seatEnabled !== true')) {
      findings.push('G6: server.ts 未按 seatEnabled 判定 /seat/*')
    }
    notes.push('G6: 运营桥已落地（未配 token 404 / 错 token 401 / 常量时间比较）')

    // ── G7：日志不打平台用户标识原文 ─────────────────────────────────────
    const log = src('apps/im-gateway/src/log.ts')
    if (!log.includes('FORBIDDEN_FIELDS')) findings.push('G7: log.ts 必须含丢弃 userId/openid 的字段黑名单')
    for (const [rel, text] of files.entries()) {
      if (rel === 'apps/im-gateway/src/log.ts') continue
      for (const call of logCalls(text)) {
        if (/\buserId\b|\bopenid\b|\bfromUser\b|\btoUser\b/.test(call.snippet)) {
          findings.push(`G7: ${rel}:${String(call.line)} 日志调用出现平台用户标识原文`)
        }
      }
    }

    // ── G8：微信配置文档存在且含三节 ─────────────────────────────────────
    if (!existsSync(join(root, WECHAT_DOC))) {
      findings.push(`G8: 缺少 ${WECHAT_DOC}`)
    } else {
      const doc = read(root, WECHAT_DOC)
      for (const section of ['## D0', '## 回调', '## 故障排查']) {
        if (!doc.includes(section)) findings.push(`G8: ${WECHAT_DOC} 缺少「${section}」一节`)
      }
    }

    // ── G9：H5 资源零远程 + CSP 固定串 + 无内联脚本 + 无框架 ─────────────────
    const REMOTE = /(?:cdn\.|unpkg\.com|jsdelivr\.net|cdnjs\.)/i
    for (const [rel, text] of appFiles.entries()) {
      if (REMOTE.test(text)) findings.push(`G9: ${rel} 引用远程资源（网关资源必须自包含）`)
    }
    const page = src('apps/im-gateway/src/approval/page.ts')
    for (const needle of [
      "default-src 'none'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      'cache-control',
      'referrer-policy',
    ]) {
      if (!page.includes(needle)) findings.push(`G9: page.ts 缺少 H5 安全头 ${needle}`)
    }
    for (const name of ['approve.html', 'approve.css', 'approve.js']) {
      const rel = `${APP_DIR}/assets/${name}`
      const text = read(root, rel)
      if (text.length === 0) {
        findings.push(`G9: 缺少 H5 资源 ${rel}`)
        continue
      }
      if (/https?:\/\//iu.test(text)) findings.push(`G9: ${rel} 出现远程 URL`)
      if (/(?:import\s+[^;]*from\s+['"]react|from\s+['"]vue)/u.test(text)) {
        findings.push(`G9: ${rel} 引入前端框架`)
      }
    }
    const html = read(root, `${APP_DIR}/assets/approve.html`)
    if (/<script(?![^>]*\bsrc=)[^>]*>/iu.test(html)) {
      findings.push('G9: approve.html 出现内联脚本（CSP 只允许外链同源脚本）')
    }
    notes.push('G9: H5 资源零远程、CSP 固定串、无内联脚本')

    // ── G10：server.ts 只依赖 PlatformAdapter，不 import 平台实现 ──────────
    const serverImports = importsOf(server)
    for (const specifier of serverImports) {
      if (specifier.includes('platform/wechat') || specifier.includes('protocol/')) {
        findings.push(`G10: server.ts import 了平台实现 ${specifier}`)
      }
    }

    // ── G14（03 §6 的"G10"）：链接 token 必须是 HMAC + 常量时间 + exp ──────
    const linkToken = src('packages/channels/src/im/protocol/link-token.ts')
    for (const needle of ['createHmac', 'timingSafeEqual', 'expired', 'APPROVAL_LINK_VERSION']) {
      if (!linkToken.includes(needle)) findings.push(`G14: link-token.ts 缺少 ${needle}`)
    }
    if (/presented\s*(===|!==)\s*expected|expected\s*(===|!==)\s*presented/u.test(linkToken)) {
      findings.push('G14: link-token.ts 用 `===` 比较签名（计时侧信道）')
    }

    // ── G15（03 §6 的"G11"）：审批 / 运营面日志不记录拒绝理由原文 ──────────
    for (const [rel, text] of files.entries()) {
      if (!rel.startsWith(`${APP_SRC}/approval`) && !rel.startsWith(`${APP_SRC}/handoff`)) continue
      for (const call of logCalls(text)) {
        // 只认对象键 `reason:`；`reasonLength` 与 `body.reason.length` 不是"理由原文"
        if (/(?:^|[{,\s])reason\s*:/u.test(call.snippet)) {
          findings.push(`G15: ${rel}:${String(call.line)} 日志出现拒绝理由字段（只许 reasonLength / code）`)
        }
      }
    }

    // ── G11：生产只注册 wechat；Mock 只在 test/ ───────────────────────────
    const main = src('apps/im-gateway/src/main.ts')
    const mainImports = importsOf(main)
    if (mainImports.some((specifier) => specifier.includes('mock'))) {
      findings.push('G11: main.ts import 了 Mock 适配器（Mock 只许存在于 test/）')
    }
    for (const [rel, text] of files.entries()) {
      if (!rel.startsWith(APP_SRC)) continue
      for (const specifier of importsOf(text)) {
        if (specifier.includes('mock-platform') || specifier.includes('mock-adapter')) {
          findings.push(`G11: ${rel} import 了 Mock 适配器`)
        }
      }
    }
    if (!/createRegistry\(\s*\[wechat\]/.test(main)) {
      findings.push('G11: main.ts 的生产注册表必须只含 [wechat]')
    }

    // ── G12：没有生产开关能打开 Mock ─────────────────────────────────────
    const MOCK_SWITCH = /BAH_IM_ENABLE_MOCK|BAH_IM_MOCK/u
    for (const [rel, text] of appFiles.entries()) {
      for (const { line, number } of codeLines(text)) {
        if (MOCK_SWITCH.test(line)) findings.push(`G12: ${rel}:${String(number)} 出现 Mock 生产开关`)
      }
    }

    // ── G13：PlatformAdapter 只在 channels/im/platform.ts 定义 ────────────
    const declarations = [...files.entries()]
      .filter(([, text]) => /interface\s+PlatformAdapter\b/.test(text))
      .map(([rel]) => rel)
    if (!declarations.includes(ADAPTER_CONTRACT)) {
      findings.push(`G13: ${ADAPTER_CONTRACT} 里没有 PlatformAdapter 定义`)
    }
    for (const rel of declarations) {
      if (rel !== ADAPTER_CONTRACT) findings.push(`G13: ${rel} 复制了 PlatformAdapter 接口（唯一实现点被破坏）`)
    }

    notes.push(`扫描网关源码 ${String(files.size)} 个文件（apps/im-gateway/src + channels/im）`)
    notes.push('G2–G5、G10–G13 逐条正向断言；G6/G9 已按 03 单转为强制；G14/G15 为 03 §6 的两条（编号顺延）')

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
