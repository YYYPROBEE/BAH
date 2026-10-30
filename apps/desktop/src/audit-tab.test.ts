/**
 * 审计视图入口（T-DTB-009）。
 *
 * 这条用例挡的是**最难查的一种失效**：Web 重构把 `tab-audit` 改名，菜单点了没反应、
 * 控制台没有报错、审计视图永远打不开。判据分两层：
 *   ① 脚本里用的 id 与 `AUDIT_TAB_ID` 是同一个常量（本文件）；
 *   ② `apps/web/src/main.js` 里确实存在这个 id（门禁 G8）。
 */

import { describe, expect, it } from 'vitest'

import { auditTabClickScript, AUDIT_TAB_ID } from './audit-tab.ts'

describe('auditTabClickScript（T-DTB-009）', () => {
  it('id 与 Web 侧固定 id 一致（tab-audit）', () => {
    expect(AUDIT_TAB_ID).toBe('tab-audit')
  })

  it('脚本里带的是同一个常量（不是另抄一份字符串）', () => {
    expect(auditTabClickScript()).toContain(JSON.stringify(AUDIT_TAB_ID))
  })

  it('返回布尔而非裸 click()：命中与"静默失效"必须可区分', () => {
    const script = auditTabClickScript()
    // 有 `return false`（元素缺失）与 `return true`（点到了）
    expect(script).toContain('return false')
    expect(script).toContain('return true')
    // 不是 `document.getElementById('x')?.click()` 那种两种结果都返回 undefined 的写法
    expect(script).not.toContain('?.click()')
  })

  it('脚本是自执行表达式（executeJavaScript 只回传表达式的值）', () => {
    const script = auditTabClickScript()
    expect(script.startsWith('(() => {')).toBe(true)
    expect(script.trimEnd().endsWith('})()')).toBe(true)
  })
})
