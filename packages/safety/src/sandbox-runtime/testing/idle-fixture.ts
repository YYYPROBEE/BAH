/**
 * 测试用执行体：返回一个永不落定的 promise（"worker 没交回结论就退了"）。
 *
 * 这条路径与忙循环相反：事件循环空了，Node 直接把 worker 收走，父侧收不到 message。
 * 沙箱必须把它当成失败（而不是"没有结果 = 成功"），否则模型侧会看到一次凭空消失的计算。
 */

export const SANDBOX_HANDLER = {
  key: 'idle',
  capabilities: [] as const,
  run: (): Promise<never> => new Promise<never>(() => {}),
}
