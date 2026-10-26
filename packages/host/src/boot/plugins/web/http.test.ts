/**
 * Web 传输层共享工具：cookie 解析。
 *
 * 这里不测 HTTP 业务，只钉"同名 cookie 取第一个、脏片段不报错、缺失返回 undefined"——
 * CSRF 闸与静态页注入都靠它，一个解析偏差就会把合法请求判成 403。
 */

import { describe, expect, it } from 'vitest'

import { readCookie } from './http.ts'

describe('readCookie', () => {
  it('缺失 header → undefined', () => {
    expect(readCookie(undefined, 'bah_csrf')).toBeUndefined()
  })

  it('取第一个同名项；无 = 的脏片段跳过；键值两侧空白被裁掉', () => {
    expect(readCookie('bah_csrf=tok-1; bah_csrf=tok-2', 'bah_csrf')).toBe('tok-1')
    expect(readCookie('broken; bah_csrf = tok-3 ; other=1', 'bah_csrf')).toBe('tok-3')
  })

  it('没有同名项 → undefined（不能把最后一个 cookie 的值误当目标）', () => {
    expect(readCookie('a=1; b=2', 'bah_csrf')).toBeUndefined()
  })
})
