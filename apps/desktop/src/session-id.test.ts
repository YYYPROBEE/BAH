/**
 * 会话 ID 生成（桌面端 02 · 修订）。
 *
 * 判据只有两条，但都很硬：**必须能当目录名**（否则 `create()` 直接抛
 * `invalid-path-segment`），且**两次启动不能撞**（撞了就是"持久化静默全丢"）。
 */

import { isSafePathSegment } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { desktopSessionId } from './session-id.ts'

describe('desktopSessionId', () => {
  it('格式固定：desktop-yyyyMMdd-HHmmss', () => {
    expect(desktopSessionId(new Date(2026, 9, 30, 2, 5, 9))).toBe('desktop-20261030-020509')
  })

  it('个位数月/日/时/分/秒都补零（否则排序会乱、同日不同秒可能撞名）', () => {
    expect(desktopSessionId(new Date(2026, 0, 1, 0, 0, 0))).toBe('desktop-20260101-000000')
  })

  it('落在 SAFE_PATH_SEGMENT 内（能直接当会话目录名）', () => {
    for (const now of [
      new Date(2026, 0, 1, 0, 0, 0),
      new Date(2026, 11, 31, 23, 59, 59),
      new Date(2026, 9, 30, 2, 5, 9),
    ]) {
      const id = desktopSessionId(now)
      expect(isSafePathSegment(id), id).toBe(true)
      expect(id).not.toBe('.')
      expect(id).not.toBe('..')
    }
  })

  it('不同时刻产出不同 ID（同一秒内由单实例锁保证唯一）', () => {
    const a = desktopSessionId(new Date(2026, 9, 30, 2, 5, 9))
    const b = desktopSessionId(new Date(2026, 9, 30, 2, 5, 10))
    expect(a).not.toBe(b)
  })
})
