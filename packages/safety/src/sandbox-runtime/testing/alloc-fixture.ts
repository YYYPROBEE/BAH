/**
 * 测试用执行体：把堆吃光（T-SBX-004，验证 `resourceLimits` 真的生效）。
 */

export const SANDBOX_HANDLER = {
  key: 'alloc',
  capabilities: [] as const,
  run: (): number => {
    const held: number[][] = []
    for (;;) held.push(new Array(1_000_000).fill(1))
  },
}
