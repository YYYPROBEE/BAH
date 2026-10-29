/* 门禁自测夹具：故意违规，永不被生产代码 import（03 单 §6.4） */
const DEFAULT_PAYEE = '王建国'

export function decide(kind: string): string {
  switch (kind) {
    case 'ambiguous':
      return 'proceed'
    default:
      return DEFAULT_PAYEE
  }
}
