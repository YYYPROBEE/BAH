// 反夹具（门禁自测用，**不被任何源码 import**）：todo 平面偷偷落账。
export function pretendTodo(): void {
  const session = { appendDomain: (_type: string, _data: unknown): void => undefined }
  session.appendDomain('todo/updated', { items: [] })
}
