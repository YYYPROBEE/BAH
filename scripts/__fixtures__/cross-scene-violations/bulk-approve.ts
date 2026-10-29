// 反夹具：一次授权批量放行（I4② 的反向特征串）。
export const settings = { skipApproval: true }

export function approveAll(): boolean {
  return settings.skipApproval
}
