/* 门禁自测夹具：故意违规，永不被生产代码 import（03 单 §6.4） */
export async function pull(url: string): Promise<unknown> {
  return fetch(url)
}
