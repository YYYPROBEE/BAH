/**
 * 路径段白名单（`isSafePathSegment` / `assertSafePathSegment`）。
 *
 * 它是所有「把标识符拼进文件路径」的入口上唯一的拦截点，实际守住了 6 处写路径：
 * 会话目录（`persistence/jsonl/backend.ts`）、租户目录、运营交接存储
 * （`web/handoff-store.ts`）、宿主插件的 sessionId 校验，以及 CLI 的 `--session` 参数解析。
 * 文件头写得很直白：`join(root, id)` 对 `../` **不做任何拦截**。
 *
 * 这类缺口的后果不是抛错，而是在根目录之外静默建目录写文件；
 * 而输入里有一部分来自模型或外部参数，所以拒绝侧的取值矩阵必须逐个钉住。
 * 现有的唯一引用（`apps/desktop/src/session-id.test.ts`）只验了「合法 id 能通过」，
 * 没有任何用例验「越界的必须被拦住」。
 */

import { describe, expect, it } from 'vitest'

import { BahError } from './errors.ts'
import { SAFE_PATH_SEGMENT, assertSafePathSegment, isSafePathSegment } from './safe-path.ts'

/** 取错误码（非 BahError 直接让用例红）。 */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof BahError) return error.code
    throw error
  }
  throw new Error('期望抛错，但没有抛')
}

/** 取抛错时携带的结构化 detail。 */
function detailOf(run: () => unknown): Record<string, unknown> {
  try {
    run()
  } catch (error) {
    return (error as { detail?: Record<string, unknown> }).detail ?? {}
  }
  throw new Error('期望抛错，但没有抛')
}

describe('isSafePathSegment：合法标识符', () => {
  it('字母数字开头，后续允许 . _ -（真实会话 id 的形状）', () => {
    for (const ok of [
      's-1',
      'desktop-20261030-020509',
      'a_b-c.d9',
      '0',
      'T000000000000000000000000000000000000000000000000000000000000000',
    ]) {
      expect(isSafePathSegment(ok), ok).toBe(true)
    }
  })

  it('点号只允许出现在中间（`a..b` 合法，`..a` 因非字母数字开头被拒）', () => {
    expect(isSafePathSegment('a..b')).toBe(true)
  })
})

describe('isSafePathSegment：越界取值必须被拦住', () => {
  const rejected: readonly { readonly value: string; readonly why: string }[] = [
    { value: '', why: '空串会退化成根目录本身' },
    { value: '.', why: '当前目录' },
    { value: '..', why: '上跳一级——join 后写出根目录之外' },
    { value: '../evil', why: '相对逃逸' },
    { value: '/etc/passwd', why: '绝对路径' },
    { value: 'C:\\Windows\\system32', why: 'Windows 绝对路径与反斜杠' },
    { value: 'a/b', why: 'POSIX 分隔符' },
    { value: 'a\\b', why: 'Windows 分隔符' },
    { value: 'a\0b', why: 'NUL 截断' },
    { value: 'a b', why: '空格（shell 与日志都会重新分词）' },
    { value: ' a', why: '前导空格' },
    { value: '-x', why: '非字母数字开头' },
    { value: '.hidden', why: '点开头（会被当隐藏文件与相对段）' },
    { value: '_x', why: '下划线开头同样不合法' },
    { value: '%2e%2e%2fx', why: 'URL 编码的分隔符（% 不在白名单）' },
    { value: '中文会话', why: '非 ASCII 目录名不进白名单' },
  ]

  for (const { value, why } of rejected) {
    it(`拒绝 ${JSON.stringify(value)}：${why}`, () => {
      expect(isSafePathSegment(value)).toBe(false)
    })
  }

  it('白名单常量本身可复用（导出的是同一份判定，不是各写一遍）', () => {
    expect(SAFE_PATH_SEGMENT.test('..')).toBe(false)
    expect(SAFE_PATH_SEGMENT.source.startsWith('^[A-Za-z0-9]')).toBe(true)
  })
})

describe('assertSafePathSegment：结构化的拒绝', () => {
  it('合法值直接返回，不抛', () => {
    expect(() => assertSafePathSegment('s-1', 'sessionId')).not.toThrow()
  })

  it('非法值抛 `invalid-path-segment`，消息里同时给出是哪一项', () => {
    expect(codeOf(() => assertSafePathSegment('../evil', 'sessionId'))).toBe('invalid-path-segment')
    expect(() => assertSafePathSegment('..', 'tenantId')).toThrow(/tenantId/)
  })

  it('detail 带 what 与原始 value（审计里要能还原被拒的输入）', () => {
    const detail = detailOf(() => assertSafePathSegment('a/b', 'sessionId'))
    expect(detail).toMatchObject({ what: 'sessionId', value: 'a/b' })
  })
})
