// 反夹具：计划变成可变（D8）。
export interface PlanApi {
  run(planId: string): Promise<void>
  addNode(planId: string, nodeId: string): void
}

export function mutate(api: PlanApi): void {
  api.addNode('p-1', 'n-1')
}
