/**
 * JSONL 后端单测。
 *
 * 所有用例都在系统临时目录里真读写文件（不留夹具、不留残渣）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SessionEvent } from '@bah/core'
import { asSessionId, captureThrown } from '@bah/test-support'

import { JSONL_FORMAT_VERSION, JsonlPersistence } from './backend.ts'

let root = ''
let warnings: string[] = []

/** 默认实例（关掉 fsync 换测试速度；告警进收集器）。 */
const persistence = (): JsonlPersistence =>
  new JsonlPersistence({ fsync: false, warn: (message) => warnings.push(message) })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bah-jsonl-'))
  warnings = []
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一条事件。 */
function event(seq: number, type = 'user/message'): SessionEvent {
  return { seq, at: seq, formatVersion: JSONL_FORMAT_VERSION, type, data: { content: `第 ${seq} 条` } }
}

/** 手工写一个会话文件（用于旧格式 / 半写 / 损坏等场景）。 */
function writeSession(
  dir: string,
  file: string,
  options: { formatVersion?: number; header?: boolean; lines?: string[] } = {},
): void {
  mkdirSync(dir, { recursive: true })
  const body = options.lines ?? []
  if (options.header === false) {
    writeFileSync(join(dir, file), body.join('\n'), 'utf8')
    return
  }
  const header = JSON.stringify({
    kind: 'bah-session-header',
    sessionId: 's-legacy',
    formatVersion: options.formatVersion ?? JSONL_FORMAT_VERSION,
    createdAt: 1,
  })
  writeFileSync(join(dir, file), `${[header, ...body].join('\n')}\n`, 'utf8')
}

describe('create / append / open', () => {
  it('create 写第 0 代 header；append 落盘；open 读回（只读句柄）', async () => {
    const api = persistence()
    const dir = join(root, 's-1')

    const handle = api.create(dir, asSessionId('s-1'), { now: 123, meta: { channel: 'web' } })
    expect(handle.generation).toBe(0)
    expect(handle.path).toBe(join(dir, 'session.jsonl'))
    expect(handle.header).toMatchObject({
      sessionId: 's-1',
      formatVersion: JSONL_FORMAT_VERSION,
      createdAt: 123,
      meta: { channel: 'web' },
    })

    handle.append(event(1))
    handle.append(event(2))
    await handle.flush()
    expect(handle.events()).toHaveLength(2)

    const reopened = api.open(dir)
    expect(reopened.writable).toBe(false)
    expect(reopened.events()).toEqual([event(1), event(2)])
  })

  it('重复 create 拒绝覆写；只读句柄不能 append', () => {
    const api = persistence()
    const dir = join(root, 's-2')
    api.create(dir, asSessionId('s-2'))

    expect(captureThrown(() => api.create(dir, asSessionId('s-2'))).code).toBe('session-exists')

    const readonly = api.open(dir)
    expect(captureThrown(() => readonly.append(event(1))).code).toBe('session-readonly')
  })

  it('落盘前掩码 PII：结构化姓名/手机/自由文本都不可逆', () => {
    const api = persistence()
    const dir = join(root, 's-redact')
    const handle = api.create(dir, asSessionId('s-redact'), {
      meta: { userName: '王建国', phone: '13900002222' },
    })
    const raw: SessionEvent = {
      seq: 1,
      at: 1,
      formatVersion: JSONL_FORMAT_VERSION,
      type: 'tool/call',
      data: {
        callId: 'c1',
        name: 'transfer_create',
        args: {
          payee: { name: '王建国', phone: '13900002222' },
          remark: '联系 13812345678',
        },
        at: 1,
      },
    }
    handle.append(raw)

    const reopened = api.open(dir)
    expect(reopened.header.meta).toMatchObject({ userName: '王**', phone: '139****2222' })
    expect(reopened.events()[0]?.data).toMatchObject({
      name: 'transfer_create',
      args: {
        payee: { name: '王**', phone: '139****2222' },
        remark: '联系 138****5678',
      },
    })
    // 落盘文件里没有原文
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).not.toContain('王建国')
  })

  it('header 超过 4KB 仍可打开（按行读到换行）', () => {
    const api = new JsonlPersistence({ fsync: false, warn: () => {}, redact: false })
    const dir = join(root, 's-long-header')
    const note = 'x'.repeat(5_000)
    api.create(dir, asSessionId('s-long-header'), { meta: { note } })

    expect(api.open(dir).header.meta?.['note']).toBe(note)
  })

  it('header 超过 1MB → session-header-invalid（不把损坏文件读进内存）', () => {
    const api = new JsonlPersistence({ fsync: false, warn: () => {}, redact: false })
    const dir = join(root, 's-huge-header')
    api.create(dir, asSessionId('s-huge-header'), { meta: { note: 'x'.repeat(1024 * 1024 + 1) } })

    expect(captureThrown(() => api.open(dir)).code).toBe('session-header-invalid')
  })

  it('目录里没有规范分代文件 → session-missing', () => {
    mkdirSync(join(root, 'empty'), { recursive: true })
    expect(captureThrown(() => persistence().open(join(root, 'empty'))).code).toBe('session-missing')
  })
})

describe('T-SESS-005 写入式 open 与分代', () => {
  it('旧格式 + 写入式 open → 以新代号排他发布后继，源文件不动', async () => {
    const api = persistence()
    const dir = join(root, 'legacy')
    writeSession(dir, 'session.jsonl', {
      formatVersion: 0,
      lines: [JSON.stringify({ ...event(1), formatVersion: 0 })],
    })
    const source = readFileSync(join(dir, 'session.jsonl'), 'utf8')

    const handle = api.open(dir, { mode: 'write' })

    expect(handle.generation).toBe(1)
    expect(handle.path).toBe(join(dir, 'session.v1.jsonl'))
    expect(handle.header.formatVersion).toBe(JSONL_FORMAT_VERSION)
    // 升级只改文件 header：事件行原样保留（不改写历史）
    expect(handle.events()).toEqual([{ ...event(1), formatVersion: 0 }])
    // 源文件一个字节都不能变
    expect(readFileSync(join(dir, 'session.jsonl'), 'utf8')).toBe(source)

    // 后继可继续追加，且下次 open 直接读到后继
    handle.append(event(2))
    expect(api.open(dir).events()).toEqual([{ ...event(1), formatVersion: 0 }, event(2)])
  })

  it('已是当前格式 + 写入式 open → 原地追加，不发布新代', () => {
    const api = persistence()
    const dir = join(root, 'current')
    const created = api.create(dir, asSessionId('current'))
    created.append(event(1))

    const writable = api.open(dir, { mode: 'write' })
    writeSyncAppend(api, writable, event(2))

    expect(writable.generation).toBe(0)
    expect(existsSync(join(dir, 'session.v1.jsonl'))).toBe(false)
    expect(api.open(dir).events()).toEqual([event(1), event(2)])
  })
})

/** 追一条并落盘（测试内小工具，避免重复三行）。 */
function writeSyncAppend(api: JsonlPersistence, handle: ReturnType<JsonlPersistence['open']>, item: SessionEvent): void {
  handle.append(item)
  void api.flush(handle)
}

describe('T-SESS-006 stat / list', () => {
  it('stat 只扫 header 取元数据；list 每个会话只报最高规范代', () => {
    const api = persistence()
    const dirA = join(root, 'a')
    const dirB = join(root, 'b')
    api.create(dirA, asSessionId('a'))
    // a 有一条更高的代
    writeSession(dirA, 'session.v2.jsonl', { lines: [JSON.stringify(event(1))] })
    // b 只有分代文件（没有 session.jsonl）
    writeSession(dirB, 'session.v1.jsonl', { lines: [] })
    // 非会话目录 / 普通文件都不参与
    mkdirSync(join(root, 'not-a-session'), { recursive: true })
    writeFileSync(join(root, 'README.md'), 'x')

    const stat = api.stat(dirA)
    expect(stat.generation).toBe(2)
    expect(stat.path).toBe(join(dirA, 'session.v2.jsonl'))
    expect(stat.sessionId).toBe('s-legacy')
    expect(stat.bytes).toBeGreaterThan(0)

    const listed = api.list(root)
    expect(listed.map((item) => basename(item.dir))).toEqual(['a', 'b'])
    expect(listed.map((item) => item.generation)).toEqual([2, 1])
  })
})

describe('T-SESS-007 版本与读取容错', () => {
  it('header 版本高于 reader → 拒绝打开（不做静默降级）', () => {
    const dir = join(root, 'future')
    writeSession(dir, 'session.jsonl', { formatVersion: JSONL_FORMAT_VERSION + 1 })

    const error = captureThrown(() => persistence().open(dir))
    expect(error.code).toBe('session-format-too-new')
    expect(error.message).toContain('拒绝打开')
  })

  it('尾行半写 → 丢弃并告警；中间行损坏 → 直接抛错', () => {
    const good = JSON.stringify(event(1))
    const dir = join(root, 'tail')
    writeSession(dir, 'session.jsonl', { lines: [good, '{"seq":2,"at":'] })

    // 默认实例：走默认 console.warn 出口
    const opened = new JsonlPersistence({ fsync: false }).open(dir)
    expect(opened.events()).toEqual([event(1)])

    const corrupt = join(root, 'corrupt')
    writeSession(corrupt, 'session.jsonl', { lines: ['{"broken":', good] })
    expect(captureThrown(() => persistence().open(corrupt)).code).toBe('session-line-invalid')
  })

  it('首行不是 header → session-header-invalid', () => {
    const dir = join(root, 'no-header')
    writeSession(dir, 'session.jsonl', { header: false, lines: ['{"seq":1}'] })

    expect(captureThrown(() => persistence().open(dir)).code).toBe('session-header-invalid')
  })

  it('容错告警会带上被丢弃的行号', () => {
    const api = persistence()
    const dir = join(root, 'warn')
    writeSession(dir, 'session.jsonl', { lines: [JSON.stringify(event(1)), '{"seq":2'] })

    api.open(dir)

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('第 3 行')
  })
})

describe('T-SESS-008 append-only 的 API 面', () => {
  it('持久化接口与句柄都不提供改名 / 删除 / 改写能力', () => {
    const api = persistence() as unknown as Record<string, unknown>
    const handle = (api['create'] as JsonlPersistence['create']).call(
      api,
      join(root, 's'),
      asSessionId('s'),
    ) as unknown as Record<string, unknown>

    for (const forbidden of ['rename', 'delete', 'remove', 'truncate', 'update']) {
      expect(api[forbidden]).toBeUndefined()
      expect(handle[forbidden]).toBeUndefined()
    }
    // 但 flush 是有的（落盘不是改写）
    expect(typeof (handle as { flush?: unknown }).flush).toBe('function')
  })
})
