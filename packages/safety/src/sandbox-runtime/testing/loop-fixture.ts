/**
 * 测试用执行体：同步忙循环（T-SBX-003 的硬杀对象）。
 *
 * 必须是**忙**循环：事件循环空了 worker 会自己退出（那是另一条失败路径，见
 * `idle-fixture.ts`），只有持续占用线程才轮到父侧的超时 `terminate()`。
 */

export const SANDBOX_HANDLER = {
  key: 'loop',
  capabilities: [] as const,
  run: (): number => {
    let spins = 0
    for (;;) spins += 1
  },
}
