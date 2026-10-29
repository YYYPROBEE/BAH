/* 门禁自测夹具：故意违规，永不被生产代码 import（03 单 §6.4） */
export function now(): number {
  return Date.now()
}

export function roll(): number {
  return Math.random()
}
