/**
 * 测试用执行体：故意**不**导出 `SANDBOX_HANDLER`（装配错误的靶子）。
 *
 * 沙箱取用执行体前先验形状：形状不符就是装配缺陷，必须以结构化失败暴露出来，
 * 而不是"没有 handler 就当这次没发生"。
 */

export const NOT_A_HANDLER = { thisIsNot: 'a sandbox handler' }
