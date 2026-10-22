import { describe, expect, it } from 'vitest'

import { assertNever } from '../src/assertNever.ts'

describe('assertNever', () => {
  it('运行期抛出可读理由（编译期价值更大：漏分支直接编译失败）', () => {
    // 正常代码到不了这里；这是穷尽性兜底的最后一层，必须能证明它真的会炸。
    expect(() => assertNever('unexpected' as never)).toThrow(/未覆盖的判别标签/)
  })
})
