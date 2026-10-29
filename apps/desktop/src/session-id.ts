/**
 * 桌面端会话 ID（桌面端 02 · 修订）。**纯函数**，可单测。
 *
 * ## 为什么不是方案里写的固定 `desktop-demo`
 *
 * 02 §2.3 要求固定会话 ID，"同一台机器每次启动续写同一会话，关闭再打开能看到历史"。
 * 实测这条路在当前平台上**不存在**：
 *
 * - `packages/persistence/src/jsonl/backend.ts:create()` 对已存在的会话是**排他失败**
 *   （`jsonl: 会话已存在，拒绝覆写`），且没有任何调用方使用 `open(dir,{mode:'write'})`；
 * - `packages/host/src/boot/plugins/persistence.ts` 在首个 `session/event` 时懒 `create()`；
 * - `provideSession()` 只建**空的**内存缓冲，**不从 JSONL 回放**。
 *
 * 于是固定 ID 的真实后果是：**第二次启动起，每一条事件都写不进磁盘**
 * （只留 `runtime.session-listener-failed` 错误日志），而界面照样能用、审计视图照样
 * 显示本次内存里的事件——"看起来正常、持久化全丢"，比启动失败糟得多。
 *
 * 所以改为**每次启动一个带时间戳的会话**：持久化永远成立，会话目录按时间留存，
 * 跨启动回放由 `pnpm bah audit --dir <会话目录>` 承担（那是已有能力）。
 * 方案里的"演示幕 4：重开看历史"据此改写为"重开是新会话；历史用审计 CLI 回放"，
 * 已登记在回执的偏差表（D-02-4）。真正的 session resume 属平台能力，需另开单。
 */

/**
 * 造本次启动的会话 ID：`desktop-<yyyyMMdd>-<HHmmss>`（本地时间）。
 *
 * 字符集落在 `SAFE_PATH_SEGMENT`（`^[A-Za-z0-9][A-Za-z0-9._-]*$`）内，可直接当目录名。
 * 秒级精度足够：单实例锁保证同一时刻不会有两个桌面进程。
 */
export function desktopSessionId(now: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const date = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `desktop-${date}-${time}`
}
