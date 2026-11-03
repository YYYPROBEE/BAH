/**
 * 子进程 overlay 生成的 fail-loud 边界。
 *
 * overlay 是整块替换语义：字段漏写会回落默认值，等于隐式变配。合法路径已由
 * supervisor 用例覆盖；这里只钉住**非法端口不得写进 YAML**——一个 0 / NaN
 * 落进文件，子进程会以"端口被占"的面目失败，排查会跑到完全错误的方向。
 */

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { OVERLAY_DIR, overlayPath, renderOverlay } from '../src/session/overlay.ts'

describe('renderOverlay：端口校验', () => {
  it('合法端口写入 host 固定 127.0.0.1 的单行字段', () => {
    const yaml = renderOverlay({ port: 4100 })
    expect(yaml).toContain('port: 4100')
    expect(yaml).toContain('host: 127.0.0.1')
  })

  it('0 / 负数 / 小数 / NaN → 抛错，不生成半截配置', () => {
    for (const port of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderOverlay({ port }), String(port)).toThrow(/overlay 端口非法/)
    }
  })
})

describe('overlayPath：文件名只由 sessionKey 决定', () => {
  it('落到 .tmp-im/<sessionKey>.yml', () => {
    const path = overlayPath('/repo', 'im-0123456789abcdef')
    expect(path).toBe(join('/repo', OVERLAY_DIR, 'im-0123456789abcdef.yml'))
  })
})
