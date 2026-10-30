/**
 * 审计视图入口（桌面端 02 §2.6 / D-15-07）。**纯常量 + 纯函数**，不 import electron。
 *
 * ## 为什么桌面端不另写一个审计查看器
 *
 * `apps/web` 的审计 tab（固定 `id="tab-audit"`）已经实装：时间线与工具/审批记录同源、
 * 与对话视图共用一次 SSE 投影。桌面端复制一份 = 第二套渲染逻辑 + 第二个会漂的真相源
 * （而且 `apps/web` 一行都不许改，I-DT-09）。
 *
 * ## 为什么单独成文件
 *
 * 这个 id 被**三处**引用：`apps/web/src/main.js`（定义）、`menu.ts`（点击）、
 * `verify-desktop-shell` 的 G8（校验 Web 侧仍存在）。若各写一遍字符串，Web 重构改名时
 * 菜单会**静默失效**——点了没反应，不报错，最难查。放在纯模块里，单测能断言
 * "脚本里用的就是同一个常量"，G8 能断言"Web 侧还有这个 id"。
 */

/** Web 审计 tab 的固定 DOM id（与 `apps/web/src/main.js` 的 `id: 'tab-audit'` 同源）。 */
export const AUDIT_TAB_ID = 'tab-audit'

/**
 * 菜单"视图 → 审计视图"执行的脚本。
 *
 * 返回**布尔**而不是直接 `.click()`：`executeJavaScript` 只回传表达式的值，
 * 而 `click()` 与"元素不存在"都返回 `undefined` —— 那样"命中"与"静默失效"在
 * 主进程日志里长得一模一样。这里显式返回 `true/false`，菜单才能把失败留痕。
 */
export function auditTabClickScript(): string {
  return [
    '(() => {',
    `  const el = document.getElementById(${JSON.stringify(AUDIT_TAB_ID)});`,
    '  if (!el) return false;',
    '  el.click();',
    '  return true;',
    '})()',
  ].join('\n')
}
