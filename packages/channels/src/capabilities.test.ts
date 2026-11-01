/**
 * 能力位单一实现点的用例。
 *
 * 重点不在"值是多少"，而在**结构约束**：六渠道穷尽、字段集一致、mobile 与 web 的差异面
 * 恰好是 D4 规定的那五项。差异面多一项或少一项，都说明有人偷偷改了渠道口径。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  CAPABILITIES_BY_CHANNEL,
  DESKTOP_CAPABILITIES,
  HEADLESS_CAPABILITIES,
  IM_CAPABILITIES,
  MOBILE_CAPABILITIES,
  SDK_CAPABILITIES,
  WEB_CAPABILITIES,
  capabilitiesOf,
  type ChannelCapabilities,
} from './capabilities.ts'

/** 能力位的 10 个字段（00 D4 原文顺序）。 */
const FIELDS = [
  'richCards',
  'buttons',
  'forms',
  'images',
  'streaming',
  'layout',
  'approvalSurface',
  'gestureConfirm',
  'voiceInput',
  'dagView',
] as const

/** 包根（`packages/channels`）：本文件位于 `src/` 下一层。 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 递归收集 `.ts`（跳过 `.test.ts`），结果排序保证确定性。 */
function sourceFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-types') continue
      found.push(...sourceFiles(join(dir, entry.name)))
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(join(dir, entry.name))
    }
  }
  return found.sort()
}

/** 差异面（字段 → 两个值），只列"不同"的字段。 */
function diffFields(a: ChannelCapabilities, b: ChannelCapabilities): string[] {
  return FIELDS.filter((field) => a[field] !== b[field])
}

describe('能力位 · 六渠道穷尽（TC-MCH-01）', () => {
  it('CAPABILITIES_BY_CHANNEL 的键集恰为六渠道（集合比较，不依赖顺序）', () => {
    expect(new Set(Object.keys(CAPABILITIES_BY_CHANNEL))).toEqual(
      new Set(['web', 'mobile', 'im', 'desktop', 'headless', 'sdk']),
    )
    expect(Object.keys(CAPABILITIES_BY_CHANNEL)).toHaveLength(6)
  })

  it('capabilitiesOf 与常量表是同一引用（不允许运行期造第二份）', () => {
    expect(capabilitiesOf('mobile')).toBe(MOBILE_CAPABILITIES)
    expect(capabilitiesOf('web')).toBe(WEB_CAPABILITIES)
  })
})

describe('能力位 · 十字段一致（TC-MCH-02）', () => {
  it.each([
    ['web', WEB_CAPABILITIES],
    ['mobile', MOBILE_CAPABILITIES],
    ['im', IM_CAPABILITIES],
    ['desktop', DESKTOP_CAPABILITIES],
    ['headless', HEADLESS_CAPABILITIES],
    ['sdk', SDK_CAPABILITIES],
  ] as const)('%s 的键集等于 10 字段', (_name, caps) => {
    expect(Object.keys(caps).sort()).toEqual([...FIELDS].sort())
    expect(Object.keys(caps)).toHaveLength(10)
  })
})

describe('能力位 · mobile 与 web 的差异面恰五项（TC-MCH-03）', () => {
  it('差异字段集合恰为 layout/approvalSurface/gestureConfirm/voiceInput/dagView', () => {
    expect(diffFields(WEB_CAPABILITIES, MOBILE_CAPABILITIES).sort()).toEqual(
      ['approvalSurface', 'dagView', 'gestureConfirm', 'layout', 'voiceInput'].sort(),
    )
  })

  it('五项差异的方向与 D4 原文逐字一致；前五个布尔字段完全相同', () => {
    expect(MOBILE_CAPABILITIES.layout).toBe('narrow')
    expect(WEB_CAPABILITIES.layout).toBe('wide')
    expect(MOBILE_CAPABILITIES.approvalSurface).toBe('bottom-sheet')
    expect(WEB_CAPABILITIES.approvalSurface).toBe('dialog')
    expect(MOBILE_CAPABILITIES.gestureConfirm).toBe(true)
    expect(WEB_CAPABILITIES.gestureConfirm).toBe(false)
    // D10：移动走系统输入法听写；桌面壳不提供语音入口
    expect(MOBILE_CAPABILITIES.voiceInput).toBe('ime')
    expect(WEB_CAPABILITIES.voiceInput).toBe('none')
    expect(MOBILE_CAPABILITIES.dagView).toBe('steps')
    expect(WEB_CAPABILITIES.dagView).toBe('graph')

    for (const field of ['richCards', 'buttons', 'forms', 'images', 'streaming'] as const) {
      expect(MOBILE_CAPABILITIES[field]).toBe(WEB_CAPABILITIES[field])
    }
  })
})

describe('能力位 · headless 全关 + 单一实现点（TC-MCH-04）', () => {
  it('headless 的五个呈现位全 false（无人在回路）', () => {
    expect(HEADLESS_CAPABILITIES.richCards).toBe(false)
    expect(HEADLESS_CAPABILITIES.buttons).toBe(false)
    expect(HEADLESS_CAPABILITIES.forms).toBe(false)
    expect(HEADLESS_CAPABILITIES.images).toBe(false)
    expect(HEADLESS_CAPABILITIES.streaming).toBe(false)
  })

  it('interface ChannelCapabilities 在全包源码里恰有一处定义，且是 capabilities.ts', () => {
    const files = sourceFiles(PACKAGE_ROOT)
      .filter((file) => /^\s*(?:export\s+)?interface\s+ChannelCapabilities\b/m.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PACKAGE_ROOT, file).split(/[\\/]/).join('/'))
    expect(files).toEqual(['src/capabilities.ts'])
  })
})
