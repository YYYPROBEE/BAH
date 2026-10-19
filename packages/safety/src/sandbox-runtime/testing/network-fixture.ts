/**
 * 测试用执行体：声明了 `network` 能力（T-SBX-005 的"想触网"样本）。
 *
 * 隔离档位必须在父侧就把它挡下（连 worker 都不起）；父侧漏检时 worker 侧的二次复核
 * 也要拒——所以这个夹具同时是两条防线的靶子。
 */

export const SANDBOX_HANDLER = {
  key: 'needs-network',
  capabilities: ['network'] as const,
  run: (): string => '绝不该被执行',
}
