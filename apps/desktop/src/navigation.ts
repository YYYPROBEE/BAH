/**
 * 导航白名单（桌面端 02 §2.4 / I-DT-04）。**纯函数**：只吃字符串与端口，不碰 Electron。
 *
 * 攻击面：页面里任何一段可注入的文本（模型输出、审计回放内容、卡片富文本）都可能
 * 变成 `location.href = …` 或 `window.open(…)`。桌面壳的窗口带 `preload` 与同源 token，
 * 一旦导航到外部页面，等于把 token 所在的**同源上下文**交给第三方脚本。
 *
 * 所以判据只有一条：**目标 origin 必须逐字等于 `http://127.0.0.1:<本次启动端口>`**。
 * 不做"允许 localhost"（DNS rebinding 之外还有大小写与尾点变体）、不做"允许 127.0.0.1
 * 任意端口"（别的本机服务也可能是攻击面）。
 */

/** 桌面宿主的固定主机名（与 profile 的 `host: 127.0.0.1` 同源）。 */
export const LOOPBACK_HOST = '127.0.0.1'

/** 本机回环源：`http://127.0.0.1:<port>`（不含尾斜杠，便于与 `URL.origin` 直接比）。 */
export function loopbackOrigin(port: number): string {
  return `http://${LOOPBACK_HOST}:${String(port)}`
}

/**
 * 目标地址是否允许导航。
 *
 * @param target 目标 URL（可能是相对 URL、`javascript:`、`file:`、`data:` 等任意串）
 * @param port 本次启动的实际端口
 * @returns 只有"同源 loopback、且 http 协议"才为 `true`
 */
export function isAllowedNavigation(target: string, port: number): boolean {
  // 空串显式拒绝：`new URL('', base)` 会**返回 base 本身**（等价于"重载当前页"），
  // 若不在这里挡掉，`will-navigate` 收到空 URL 时会被判成"同源放行"。
  // 重载有专门的菜单项，不需要走导航通道。
  if (target.trim() === '') return false
  let parsed: URL
  try {
    // 相对 URL 需要一个 base：用回环源当 base，这样 `/foo` 会被判成同源放行，
    // 而 `//evil.example/x`（协议相对）会解析成 `http://evil.example/x` 被拒。
    parsed = new URL(target, loopbackOrigin(port))
  } catch {
    // `javascript:` / `data:` 之类在 `new URL` 阶段就可能抛（取决于实现），一律拒
    return false
  }
  if (parsed.protocol !== 'http:') return false
  if (parsed.hostname !== LOOPBACK_HOST) return false
  // `URL.port` 对默认端口（80）会返回空串；本端口永远由 OS 分配（>1024），不会命中
  return parsed.port === String(port)
}

/**
 * 允许导航的唯一前缀（供 `will-navigate` 做快速初筛与日志）。
 *
 * ⚠ 前缀比较**不能**替代 `isAllowedNavigation`：`http://127.0.0.1:73311/` 也以
 * `http://127.0.0.1:7331` 开头。真正的判据是上面那个解析 + 端口全等。
 */
export function loopbackPrefix(port: number): string {
  return `${loopbackOrigin(port)}/`
}
