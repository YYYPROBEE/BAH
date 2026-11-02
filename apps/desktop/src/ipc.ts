/**
 * Node IPC 五条消息（桌面端 02 §2.5 / I-DT-05、I-DT-06）。**纯模块**，不 import electron：
 * 消息名与载荷形状要在单测里逐字断言（T-DTB-002），而 `ipcRenderer` 只有在渲染进程
 * 里才存在。
 *
 * ## 四条生命周期事实 + 一条零载荷重启
 *
 * 前四条各自对应一个**生命周期事实**：注入了什么 / 页面首屏完成 / 启动失败 / 正在关闭。
 * 第五条 `newConversation` 是用户显式请求的**生命周期动作**：桌面端一个进程只服务一个
 * 会话，要真正开新对话只能重启进程（新进程重新生成 sessionId）。它不携带任何载荷、
 * 不触碰审批/票据，也不让页面指定会话或身份——因此不会把桌面壳变成绕过 HTTP 层的旁路。
 * 业务通道（例如"帮我把审批点了"）仍然禁止；门禁 G3 钉死"常量名精确、无表外通道"。
 *
 * ## token 不进 IPC（I-DT-06）
 *
 * `BootInjections` **不含** `BAH_WEB_TOKEN`：token 只存在于主进程环境变量与宿主注入到
 * 页面 `<head>` 里的那个 meta（名字由 `packages/host/src/boot/plugins/web-auth.ts` 定义）。
 * 把它塞进 IPC 等于多开一个"任何能拿到 `window.bahDesktop` 的脚本都能读到"的通道。
 * `BOOT_INJECTION_KEYS` 是这条的机器判据。
 *
 * > 这里刻意**不写**那个 meta 的名字：`verify-mobile-shell` 的 I10 把"token 面"限制在
 * > 少数白名单文件里，桌面端没有理由成为其中之一（写个名字也算扩散）。
 */

/** 五条消息名（唯一落点；preload 与 main 都从这里取）。 */
export const IPC = {
  /** 主 → 渲染：`did-finish-load` 之后下发本次启动的注入信息。 */
  injections: 'bah:boot/injections',
  /** 渲染 → 主：页面首屏完成（preload 的 DOMContentLoaded）。 */
  ready: 'bah:boot/ready',
  /** 主 → 渲染：boot / 窗口失败。 */
  fatal: 'bah:boot/fatal',
  /** 主 → 渲染：`before-quit` dispose 完成后。 */
  shutdown: 'bah:boot/shutdown',
  /** 渲染 → 主：开始新对话（重启桌面进程；新进程重新生成 sessionId）。零载荷。 */
  newConversation: 'bah:app/new-conversation',
} as const

/** 四消息名的联合类型（写错名字在编译期就红）。 */
export type IpcChannelName = (typeof IPC)[keyof typeof IPC]

/**
 * 注入载荷。
 *
 * ⚠ **不得**加入任何凭证字段。`BOOT_INJECTION_KEYS` 与 `verify-desktop-shell` 的 G3
 * 一起把这条钉住。
 */
export interface BootInjections {
  readonly channel: 'desktop'
  readonly sessionId: string
  readonly profile: 'desktop'
  readonly port: number
  readonly version: string
}

/** 启动失败载荷。 */
export interface BootFatal {
  /** 结构化错误码（`desktop-sqlite-unavailable` / `web-listen-failed` / …）。 */
  readonly code: string
  /** 已脱敏的一句话描述（不含 token、不含绝对路径以外的敏感值）。 */
  readonly message: string
}

/** 关闭载荷。 */
export interface BootShutdown {
  readonly reason: string
}

/** `BootInjections` 的键集（机器判据：多一个键就是载荷变了）。 */
export const BOOT_INJECTION_KEYS = [
  'channel',
  'sessionId',
  'profile',
  'port',
  'version',
] as const

/**
 * 载荷里**永远不许**出现的键名（大小写不敏感，子串匹配）。
 *
 * 只列"拿到就能冒充"的东西：token / secret / key / password / cookie。
 */
export const FORBIDDEN_PAYLOAD_KEYS = ['token', 'secret', 'password', 'cookie', 'apikey'] as const

/**
 * 校验渲染进程回传的 `ready` 载荷。
 *
 * 只接受 `{ at: <非负整数> }`：这是个**心跳**，不是数据通道。任何别的形状都说明
 * 有人在往里塞东西（或版本错配），两种都该被当成"不认识"而不是"尽力解析"。
 */
export function parseBootReady(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false
  const keys = Object.keys(payload)
  if (keys.length !== 1 || keys[0] !== 'at') return false
  const at = (payload as { at?: unknown }).at
  return typeof at === 'number' && Number.isInteger(at) && at >= 0
}

/**
 * 断言载荷不含凭证类键（**递归**一层即可：四消息的载荷都是扁平对象）。
 *
 * @throws `Error('boot-payload-forbidden-key:<key>')` 命中禁用键
 */
export function assertNoCredentialKeys(payload: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(payload)) {
    const lower = key.toLowerCase()
    for (const bad of FORBIDDEN_PAYLOAD_KEYS) {
      if (lower.includes(bad)) throw new Error(`boot-payload-forbidden-key:${key}`)
    }
  }
}

/**
 * 把任意抛错翻成 `BootFatal`。
 *
 * 只取 `code` 与 `message`：**不**把 `stack` 塞进渲染进程（栈里有绝对路径与内部模块名，
 * 而渲染进程是"可能被注入脚本"的那一侧）。栈由主进程日志留存。
 */
export function toBootFatal(error: unknown, fallbackCode: string): BootFatal {
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown }
    const code = typeof record.code === 'string' && record.code.length > 0 ? record.code : fallbackCode
    const message =
      typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : '启动失败（无错误信息）'
    return { code, message }
  }
  return { code: fallbackCode, message: String(error) }
}
