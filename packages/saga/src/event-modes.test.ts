/**
 * T-SA10-013：`saga/comp-decided` 是本层唯一 waterfall，其余补偿事件一律 emit。
 *
 * 这是契约断言，不是行为断言：`verify-event-modes` 门禁负责全仓比对，
 * 本用例把 SA-10 的局部纪律钉在测试里（防止后续把 comp-issued 改成 waterfall）。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('.', import.meta.url))
const read = (relative: string): string => readFileSync(join(SRC, relative), 'utf8')

/** 取某个事件键声明前若干行内的 `@mode`。 */
function modeOf(source: string, event: string): string | undefined {
  const lines = source.split(/\r?\n/)
  const index = lines.findIndex((line) => line.includes(`'${event}':`))
  if (index < 0) return undefined
  for (let cursor = index; cursor >= Math.max(0, index - 3); cursor -= 1) {
    const matched = /@mode\s+(emit|serial|parallel|waterfall|bail)\b/.exec(lines[cursor] ?? '')
    if (matched) return matched[1]
  }
  return undefined
}

describe('SA-10 事件模式契约', () => {
  it('T-SA10-013：comp-decided 唯一 waterfall；comp-issued / comp-result / dlq 均 emit', () => {
    const seams = read('seams.ts')
    expect(modeOf(seams, 'saga/comp-decided')).toBe('waterfall')

    for (const event of ['saga/comp-issued', 'saga/comp-result', 'saga/dlq-escalated']) {
      expect(modeOf(seams, event)).toBe('emit')
    }

    // 派发点：补偿实现只能 emit，不得把发射/结果改成 waterfall（判决挂点只有一处）。
    const compensation = read('compensation/index.ts')
    expect(compensation).toMatch(/\.emit\(\s*'saga\/comp-issued'/)
    expect(compensation).toMatch(/\.emit\(\s*'saga\/comp-result'/)
    expect(compensation).not.toMatch(/\.waterfall\(\s*'saga\/comp-issued'/)
    expect(compensation).not.toMatch(/\.waterfall\(\s*'saga\/comp-result'/)
  })
})
