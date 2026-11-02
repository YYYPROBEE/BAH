/**
 * 门禁：渠道能力位与移动渠道装配的自研不变量。
 *
 * 为什么不做「禁用词清单」：清单要把被禁字面量写进脚本，脚本自身永远是一次命中
 * （`verify-visual-line.ts:1-13` 已把这条论证写死）。本门禁一律**正向断言**——
 * 只认"唯一合法的定义位形态"与"键集合相等"，任何别的形状即红。
 *
 * I1  能力位单一实现点（`interface ChannelCapabilities` 只许出现在 capabilities.ts）
 * I2  6 渠道穷尽（`ChannelKind` ↔ `CAPABILITIES_BY_CHANNEL` 键集合相等）
 * I3  10 字段（少字段即红，多字段记 notes）
 * I4  各 HTTP 渠道 profile 存在、清单合法、渠道行 id/use 一致且排在审批行之后
 * I5  profile ↔ adapter ↔ 提示词三方一致（mobile / desktop / im 各一条）
 * I6  token 入口白名单（所有 profile 的**任何** `channel:*` 行）：非空、无通配、无分隔符、
 *     .html 结尾、无重复、entry ∈ entries；非 0 端口不重复（`port:0` = OS 分配，不参与冲突表）
 * I7  各渠道配置面不含表外键（键集 ⊆ `WEB_SETTING_KEYS`）
 * I8  mobile / desktop / im 与 web 的业务段规范化序列化相等（"两套账"的早期信号）
 * I9  薄壳纪律（plugins/{mobile,desktop,im}.ts ≤80 行、不含分发符号、不自建 HTTP 服务）+ 闸序关键词按序
 * I10 安全头最小权限姿态逐字钉死（`permissions-policy` 等式比对，任何改动即红）
 * I11 桌面端 profile 三条硬值：`port:0`、`host:127.0.0.1`、`entries:['index.html']`
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { parse } from 'yaml'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

/** 能力位的唯一定义处（相对仓库根的 posix 路径）。 */
const SINGLE_SOURCE = 'packages/channels/src/capabilities.ts'
/** D4 的 10 个字段（顺序无关；少字段即红，多字段记 notes）。 */
const EXPECTED_FIELDS = [
  'richCards',
  'buttons',
  'forms',
  'images',
  'streaming',
  'layout',
  'approvalSurface',
  'gestureConfirm',
  'voiceInput',
  'dagView',
] as const
/** 入口白名单里不许出现的字符（通配与路径分隔符）。 */
const FORBIDDEN_ENTRY_CHARS = ['*', '?', '{', '}', '..', '/', '\\'] as const
/**
 * I10 钉死的 `permissions-policy` 固定串（00 D10 二次定稿：语音走系统输入法 IME，
 * 页面不申请麦克风权限 ⇒ 安全头一寸不改；本门禁把这条姿态钉成机器可验的等式）。
 */
const PERMISSIONS_POLICY_FIXED = 'camera=(), microphone=(), geolocation=()'
/** I8 比较的业务段（与渠道呈现无关、必须两边逐字一致的行）。 */
const BUSINESS_ROWS = [
  'core:model',
  'policy:rules',
  'core:persistence',
  'bank:tools',
  'interaction:approval',
  'safety:sentry',
  'bah:memory-store',
] as const

/**
 * 本门禁覆盖的 HTTP 渠道（`channel:*` 里除 web 之外、在本仓库内有 profile 的那些）。
 *
 * WHAT 列 mobile / desktop / im：web 自身是基准（I8 的被比对方）。三者都是在本仓库内有
 * profile 的 `channel:*` 行，一律走 `createHttpChannel`。WHY 用表而不是逐个 `if`：新增渠道时
 * 漏改门禁不会报错，只会让新渠道悄悄逃出校验——表驱动让"少一行"变成一次可见的编辑。
 */
interface HttpChannelSpec {
  /** profile 目录名、`CAPABILITIES_BY_CHANNEL` 键、`core:agent.channel` 值三者同源。 */
  readonly id: 'mobile' | 'desktop' | 'im'
  /** 宿主薄壳（I9 判据的对象）。 */
  readonly shell: string
  /** 适配器实现（I5 渠道 id 唯一落点的对象）。 */
  readonly adapter: string
  /** 适配器里的 id 常量名（I5）。 */
  readonly idConstant: string
}

const HTTP_CHANNELS: readonly HttpChannelSpec[] = [
  {
    id: 'mobile',
    shell: 'packages/host/src/boot/plugins/mobile.ts',
    adapter: 'packages/channels/src/mobile/adapter.ts',
    idConstant: 'MOBILE_CHANNEL_ID',
  },
  {
    id: 'desktop',
    shell: 'packages/host/src/boot/plugins/desktop.ts',
    adapter: 'packages/channels/src/desktop/adapter.ts',
    idConstant: 'DESKTOP_CHANNEL_ID',
  },
  {
    id: 'im',
    shell: 'packages/host/src/boot/plugins/im.ts',
    adapter: 'packages/channels/src/im/adapter.ts',
    idConstant: 'IM_CHANNEL_ID',
  },
]
/** 入口白名单的默认值（与 `web/config.ts` 的 `DEFAULT_WEB` 同口径；profile 未写时套用）。 */
const DEFAULT_ENTRY = 'index.html'
const DEFAULT_ENTRIES: readonly string[] = ['index.html']

/** patch 行（与 `cli/src/profile.ts` 同款形状）。 */
interface Row {
  readonly id?: unknown
  readonly use?: unknown
  readonly config?: unknown
}

/** 读文件；不存在返回空串（缺文件本身由调用方判为 finding）。 */
function readIfExists(root: string, rel: string): string {
  const path = join(root, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** 读 YAML（失败返回 undefined，由调用方记 finding）。 */
function readYaml(root: string, rel: string): unknown {
  const text = readIfExists(root, rel)
  if (text.length === 0) return undefined
  try {
    return parse(text) as unknown
  } catch {
    return undefined
  }
}

/** 断言对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取 `id === <id>` 的 patch 行。 */
function rowOf(rows: readonly Row[], id: string): Row | undefined {
  return rows.find((row) => row.id === id)
}

/** 深排序后的规范化序列化（对象键序无关；数组保持顺序）。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** 列出一个目录下所有 profile 的 patch 路径（相对根）。 */
function profilePatches(root: string): string[] {
  const dir = join(root, 'profiles')
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const name of walk(root, [join('profiles')], (file) => file === 'patch.yml')) {
    found.push(relative(root, name).split(/[\\/]/).join('/'))
  }
  void dir
  return found.sort()
}

/** 校验单个入口名（与 `web/config.ts` 的 `assertSafeEntryName` 同判据）。 */
function entryProblem(name: unknown): string | undefined {
  if (typeof name !== 'string') return `必须是字符串（收到 ${typeof name}）`
  if (!name.endsWith('.html')) return `必须以 .html 结尾（收到 '${name}'）`
  for (const bad of FORBIDDEN_ENTRY_CHARS) {
    if (name.includes(bad)) return `不得含 '${bad}'（收到 '${name}'）`
  }
  return undefined
}

const gate: Gate = {
  name: 'channel-capabilities',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // ── I1 单一实现点：只认 interface 定义位，不认字面量出现次数 ────────────
    const defs = walk(
      root,
      [join('packages', 'channels', 'src')],
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )
      .filter((file) => /^\s*(?:export\s+)?interface\s+ChannelCapabilities\b/m.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).split(/[\\/]/).join('/'))
    if (defs.length !== 1 || defs[0] !== SINGLE_SOURCE) {
      findings.push(`I1 能力位定义点应恰为 ${SINGLE_SOURCE}，实际 ${JSON.stringify(defs)}`)
    }
    // I1 的第二个洞：适配器里**就地写** capabilities 字面量。
    // 键集全对也没用——那是一份会独立漂的副本，`===` 语义（同一引用）当场破掉。
    for (const rel of [
      'packages/channels/src/web/adapter.ts',
      ...HTTP_CHANNELS.map((spec) => spec.adapter),
    ]) {
      if (/capabilities:\s*\{/.test(readIfExists(root, rel))) {
        findings.push(
          `I1 ${rel} 就地写了 capabilities 对象字面量（能力位只能引用 CAPABILITIES_BY_CHANNEL 的常量）`,
        )
      }
    }

    // ── I2 六渠道穷尽：ChannelKind（权威）↔ CAPABILITIES_BY_CHANNEL（实现）──
    const kinds = [
      ...readIfExists(root, 'packages/runtime/src/system-prompt/types.ts').matchAll(
        /export type ChannelKind = ([^\n]+)/g,
      ),
    ].flatMap((match) => [...(match[1] ?? '').matchAll(/'(\w+)'/g)].map((item) => item[1] ?? ''))
    const capText = readIfExists(root, SINGLE_SOURCE)
    const mapped = [
      ...(/CAPABILITIES_BY_CHANNEL:[^=]*=\s*\{([\s\S]*?)\n\}/.exec(capText)?.[1] ?? '').matchAll(
        /^\s{2}(\w+):/gm,
      ),
    ].map((match) => match[1] ?? '')
    if (kinds.length !== 6) {
      findings.push(`I2 ChannelKind 应恰有 6 个成员，实际 ${String(kinds.length)}：${kinds.join(',')}`)
    }
    for (const kind of kinds) {
      if (!mapped.includes(kind)) findings.push(`I2 CAPABILITIES_BY_CHANNEL 缺渠道 '${kind}'`)
    }
    for (const kind of mapped) {
      if (!kinds.includes(kind)) findings.push(`I2 CAPABILITIES_BY_CHANNEL 多出渠道 '${kind}'（不在 ChannelKind 里）`)
    }

    // ── I3 十字段：少字段即红，多字段记 notes ─────────────────────────────
    const fields = [
      ...(/interface ChannelCapabilities \{([\s\S]*?)\n\}/.exec(capText)?.[1] ?? '').matchAll(/readonly (\w+):/g),
    ].map((match) => match[1] ?? '')
    for (const field of EXPECTED_FIELDS) {
      if (!fields.includes(field)) findings.push(`I3 能力位缺字段 '${field}'（00 D4）`)
    }
    const extra = fields.filter((field) => !(EXPECTED_FIELDS as readonly string[]).includes(field))
    if (extra.length > 0) notes.push(`I3 新增字段 ${extra.join(',')}：请同批改 00 D4 与本门禁名单`)
    // 消费点：`capabilities: { … }` 的对象字面量必须与 10 键一致（防止就地写第二份字段集）
    for (const file of walk(
      root,
      [join('packages', 'channels', 'src')],
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/capabilities:\s*\{([\s\S]*?)\n\s*\}/g)) {
        const keys = [...(match[1] ?? '').matchAll(/^\s*(\w+):/gm)].map((item) => item[1] ?? '')
        if (keys.length === 0) continue
        const sameSet =
          keys.length === EXPECTED_FIELDS.length && keys.every((key) => (EXPECTED_FIELDS as readonly string[]).includes(key))
        if (!sameSet) {
          findings.push(
            `I3 ${relative(root, file).split(/[\\/]/).join('/')} 的 capabilities 字面量键集与 00 D4 的 10 字段不一致：${keys.join(',')}`,
          )
        }
      }
    }

    // ── I4 每个 HTTP 渠道 profile 存在且装配自己的渠道行 ──────────────────
    // 行集合由 `HTTP_CHANNELS` 唯一给出：新增渠道必须同时补门禁判据，
    // 否则"新渠道没被校验"这件事本身不会被任何地方发现（这正是本设计要堵的洞）。
    const channelRows = new Map<string, readonly Row[]>()
    for (const spec of HTTP_CHANNELS) {
      const profileRel = `profiles/${spec.id}/profile.yml`
      const patchRel = `profiles/${spec.id}/patch.yml`
      for (const rel of [profileRel, patchRel]) {
        if (!existsSync(join(root, rel))) findings.push(`I4 缺文件 ${rel}（${spec.id} 渠道 profile 未落地）`)
      }
      const manifest = readYaml(root, profileRel)
      if (!isRecord(manifest)) {
        findings.push(`I4 ${profileRel} 不是合法的 YAML 对象`)
      } else {
        if (manifest['name'] !== spec.id) {
          findings.push(`I4 ${profileRel} 的 name 必须是 '${spec.id}'（实际 ${String(manifest['name'])}）`)
        }
        const bundles = manifest['bundles']
        if (!Array.isArray(bundles) || !bundles.includes('base')) {
          findings.push(`I4 ${profileRel} 的 bundles 必须含 base`)
        }
        if (manifest['patch'] !== './patch.yml') {
          findings.push(`I4 ${profileRel} 的 patch 必须指向 './patch.yml'（实际 ${String(manifest['patch'])}）`)
        }
        if (manifest['hmr'] !== false) findings.push(`I4 ${profileRel} 的 hmr 必须是 false（与 web 同理）`)
      }
      const patchRows = readYaml(root, patchRel)
      const rows: readonly Row[] = Array.isArray(patchRows) ? (patchRows as Row[]) : []
      channelRows.set(spec.id, rows)
      if (!Array.isArray(patchRows)) {
        findings.push(`I4 ${patchRel} 必须是行数组`)
        continue
      }
      const pluginId = `channel:${spec.id}`
      const channelRow = rowOf(rows, pluginId)
      if (channelRow === undefined) {
        findings.push(`I4 ${patchRel} 缺 id === ${pluginId} 的行`)
      } else if (channelRow.use !== pluginId) {
        findings.push(`I4 ${pluginId} 行的 use 必须是 '${pluginId}'（实际 ${String(channelRow.use)}）`)
      }
      // 渠道行必须排在 interaction:approval 之后：本行 inject 审批服务，
      // 顺序反了就是"注册应答者时服务还没就绪"的启动期挂起。
      const approvalAt = rows.findIndex((row) => row.id === 'interaction:approval')
      const channelAt = rows.findIndex((row) => row.id === pluginId)
      if (approvalAt !== -1 && channelAt !== -1 && channelAt < approvalAt) {
        findings.push(`I4 ${patchRel} 的 ${pluginId} 排在 interaction:approval 之前（inject 会挂起）`)
      }
    }

    // ── I5 profile ↔ adapter ↔ 提示词三方一致 ────────────────────────────
    const hints = readIfExists(root, 'packages/runtime/src/system-prompt/sections.ts')
    for (const spec of HTTP_CHANNELS) {
      const rows = channelRows.get(spec.id) ?? []
      const agentConfig = isRecord(rowOf(rows, 'core:agent')?.config)
        ? (rowOf(rows, 'core:agent')?.config as Record<string, unknown>)
        : undefined
      if (agentConfig?.['channel'] !== spec.id) {
        findings.push(
          `I5 profiles/${spec.id}/patch.yml 的 core:agent.config.channel 必须是 '${spec.id}'（实际 ${String(agentConfig?.['channel'])}）`,
        )
      }
      if (!readIfExists(root, spec.adapter).includes(spec.idConstant)) {
        findings.push(`I5 ${spec.adapter} 缺 ${spec.idConstant}（渠道 id 的唯一落点）`)
      }
      // 提示词口径：`CHANNEL_HINTS` 必须有同名键，否则该渠道会落到通用语气
      if (!new RegExp(`CHANNEL_HINTS[^=]*=\\s*\\{[\\s\\S]*?\\b${spec.id}:`).test(hints)) {
        findings.push(`I5 CHANNEL_HINTS 缺 ${spec.id} 键（sections.ts）——提示词口径与渠道不一致`)
      }
    }

    // ── I6 所有 profile 的 token 入口白名单 + 端口不重复 ──────────────────
    // 判据从"写死 channel:web / channel:mobile"改成"任何 channel:* 行"：
    // 原来新增一个渠道就自动逃出本门禁，等于白名单越加越漏。
    const ports = new Map<number, string>()
    for (const rel of profilePatches(root)) {
      const doc = readYaml(root, rel)
      if (!Array.isArray(doc)) continue
      for (const row of doc as Row[]) {
        if (typeof row.use !== 'string' || !row.use.startsWith('channel:')) continue
        const config = isRecord(row.config) ? row.config : {}
        const entries = config['entries'] ?? DEFAULT_ENTRIES
        const entry = config['entry'] ?? DEFAULT_ENTRY
        if (!Array.isArray(entries) || entries.length === 0) {
          findings.push(`I6 ${rel} 的 ${String(row.use)}.entries 必须是非空数组`)
          continue
        }
        const seen = new Set<string>()
        for (const item of entries) {
          const problem = entryProblem(item)
          if (problem !== undefined) findings.push(`I6 ${rel} 的 entries 项${problem}`)
          if (typeof item === 'string') {
            if (seen.has(item)) findings.push(`I6 ${rel} 的 entries 重复：${item}`)
            seen.add(item)
          }
        }
        const entryProblemText = entryProblem(entry)
        if (entryProblemText !== undefined) findings.push(`I6 ${rel} 的 entry ${entryProblemText}`)
        if (typeof entry === 'string' && Array.isArray(entries) && !entries.includes(entry)) {
          findings.push(`I6 ${rel} 的 entry '${entry}' 不在 entries 里`)
        }
        const port = config['port']
        // `port: 0` 是"让 OS 分配"，**永远不与别人冲突**——把它算进冲突表会让
        // "两个内嵌渠道都写 0" 变成假红，也会让人误以为 0 是个固定端口。
        if (typeof port === 'number' && port !== 0) {
          const previous = ports.get(port)
          if (previous !== undefined) {
            findings.push(`I6 ${rel} 的端口 ${String(port)} 与 ${previous} 冲突（端口占用不自动换端口）`)
          } else {
            ports.set(port, rel)
          }
        }
      }
    }

    // ── I7 各渠道配置面不含表外键（键集 ⊆ WEB_SETTING_KEYS）───────────────
    const configText = readIfExists(root, 'packages/host/src/boot/plugins/web/config.ts')
    const settingKeys = [
      ...(/WEB_SETTING_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(configText)?.[1] ?? '').matchAll(/'(\w+)'/g),
    ].map((match) => match[1] ?? '')
    if (settingKeys.length === 0) {
      findings.push('I7 未能从 web/config.ts 提取 WEB_SETTING_KEYS（结构已变，门禁判据需同步）')
    }
    for (const spec of HTTP_CHANNELS) {
      const channelRow = rowOf(channelRows.get(spec.id) ?? [], `channel:${spec.id}`)
      const channelConfig = isRecord(channelRow?.config) ? channelRow.config : {}
      for (const key of Object.keys(channelConfig)) {
        if (!settingKeys.includes(key)) {
          findings.push(
            `I7 profiles/${spec.id} 的 channel:${spec.id} 出现表外键 '${key}'（WebSettings 不认，boot 期会被拒）`,
          )
        }
      }
    }

    // ── I8 各渠道与 web 的业务段规范化序列化相等 ──────────────────────────
    const webRowsRaw = readYaml(root, 'profiles/web/patch.yml')
    const webRows: readonly Row[] = Array.isArray(webRowsRaw) ? (webRowsRaw as Row[]) : []
    for (const spec of HTTP_CHANNELS) {
      const rows = channelRows.get(spec.id) ?? []
      for (const id of BUSINESS_ROWS) {
        const left = rowOf(rows, id)
        const right = rowOf(webRows, id)
        if (left === undefined || right === undefined) {
          findings.push(`I8 ${id} 行在 ${left === undefined ? spec.id : 'web'} patch 里缺失（业务段必须两边都在）`)
          continue
        }
        if (canonical(left.config) !== canonical(right.config)) {
          findings.push(
            `I8 ${id} 的 config 在 ${spec.id} 与 web patch 里不一致（两套业务口径的早期信号）：${spec.id}=${canonical(left.config)} web=${canonical(right.config)}`,
          )
        }
      }
    }

    // ── I9 薄壳纪律 + 闸序未被改写 ───────────────────────────────────────
    for (const spec of HTTP_CHANNELS) {
      const thinShell = readIfExists(root, spec.shell)
      const shellLines = thinShell.length === 0 ? 0 : thinShell.split('\n').length
      if (shellLines === 0) findings.push(`I9 ${spec.shell} 不存在`)
      if (shellLines > 80) {
        findings.push(`I9 ${spec.shell} 应 ≤80 行（实际 ${String(shellLines)}）——薄壳，路由/闸门一律不在这里`)
      }
      for (const symbol of ['createDispatcher', 'matchRoute', 'injectWebToken', 'handleStatic']) {
        if (thinShell.includes(symbol)) {
          findings.push(`I9 ${spec.shell} 含分发符号 '${symbol}'（第二份 dispatch = 口径分叉点）`)
        }
      }
      // 正向判据（比"禁用词清单"更硬）：薄壳必须调 `createHttpChannel`，且**不得自建 HTTP 服务**
      // ——`from 'node:http'` 一出现就说明它在自己 listen，绕过了唯一装配点。
      if (!thinShell.includes('createHttpChannel(')) {
        findings.push(`I9 ${spec.shell} 未调用 createHttpChannel（渠道装配只能走唯一实现）`)
      }
      if (/from\s+'node:http'/.test(thinShell)) {
        findings.push(`I9 ${spec.shell} 引入了 node:http（自建 HTTP 服务 = 第二份装配）`)
      }
    }
    const dispatchText = readIfExists(root, 'packages/host/src/boot/plugins/web/dispatch.ts')
    const gateOrder = ['限流', '管理面', 'Bearer', 'CSRF', '业务', '静态', '405']
    let cursor = -1
    for (const keyword of gateOrder) {
      const at = dispatchText.indexOf(keyword, cursor + 1)
      if (at === -1) {
        findings.push(`I9 web/dispatch.ts 的闸序关键词 '${keyword}' 缺失或顺序被打乱（闸序一条不许改）`)
        break
      }
      cursor = at
    }

    // ── I10 安全头最小权限姿态逐字钉死 ──────────────────────────────────
    const httpText = readIfExists(root, 'packages/host/src/boot/plugins/web/http.ts')
    const permissions = /['"]permissions-policy['"]\s*:\s*'([^']*)'/.exec(httpText)?.[1]
    if (permissions !== PERMISSIONS_POLICY_FIXED) {
      const line = permissions === undefined ? 0 : httpText.slice(0, httpText.indexOf("'permissions-policy'")).split('\n').length
      findings.push(
        `I10 packages/host/src/boot/plugins/web/http.ts:${String(line)} 的 permissions-policy 必须逐字等于 '${PERMISSIONS_POLICY_FIXED}'（00 D10 二次定稿：安全头一寸不改），实际值 '${String(permissions)}'`,
      )
    }

    // ── I11 桌面端 profile 的端口 / 绑定 / 入口白名单（I-DT-01/02/04）────────
    // 这三条是**桌面私有宿主**的定义，不是可调参数：写死端口会与 Web 演示撞车；
    // 绑 0.0.0.0 等于把带 token 的 UI 露到局域网；把 m.html 放进白名单等于给桌面进程
    // 多发一份凭证入口（桌面窗只加载 `/`，没有任何移动 UI 消费者）。
    const desktopRow = rowOf(channelRows.get('desktop') ?? [], 'channel:desktop')
    const desktopConfig = isRecord(desktopRow?.config) ? desktopRow.config : {}
    if (desktopConfig['port'] !== 0) {
      findings.push(
        `I11 profiles/desktop 的 channel:desktop.port 必须是 0（OS 分配），实际 ${String(desktopConfig['port'])}`,
      )
    }
    if (desktopConfig['host'] !== '127.0.0.1') {
      findings.push(
        `I11 profiles/desktop 的 channel:desktop.host 必须是 127.0.0.1（私有宿主只绑 loopback），实际 ${String(desktopConfig['host'])}`,
      )
    }
    const desktopEntries = desktopConfig['entries']
    const desktopEntryList = Array.isArray(desktopEntries) ? desktopEntries : DEFAULT_ENTRIES
    if (desktopEntryList.length !== 1 || desktopEntryList[0] !== DEFAULT_ENTRY) {
      findings.push(
        `I11 profiles/desktop 的 channel:desktop.entries 必须恰为 ['${DEFAULT_ENTRY}']，实际 ${JSON.stringify(desktopEntryList)}`,
      )
    }

    notes.push(
      `已扫描定义点 ${String(defs.length)} 处、渠道 ${String(mapped.length)} 个、字段 ${String(fields.length)} 个、profile patch ${String(profilePatches(root).length)} 个`,
    )
    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
