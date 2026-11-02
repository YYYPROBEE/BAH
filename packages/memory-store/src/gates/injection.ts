/**
 * G4 注入门（设计文档 §4.3）：7 条黑名单，中英各半。
 *
 * 判据不是"这句话像不像攻击"，而是"**这句话是否试图改写系统的判决权**"。
 * 用户的偏好可以记（"以后转账先给我看费率"），用户的**授权变更**不能记
 * （"以后转账免确认"）——后者是安全策略，属于人审流程，不属于记忆。
 *
 * 命中即拒并抛 `injection_rejected` 事件：这是攻击信号，要能被审计数出来，
 * 而不是安静地丢掉。
 */

import type { GateResult, MemoryEvent } from '../types.ts'

export interface InjectionPattern {
  readonly id: string
  readonly pattern: RegExp
  /** 这条模式在防什么。 */
  readonly guard: string
}

export const INJECTION_PATTERNS: readonly InjectionPattern[] = [
  {
    id: 'INJ-1',
    pattern: /免确认|不用确认|无需确认|不再询问|别再问我/,
    guard: '直接索取免确认授权',
  },
  {
    id: 'INJ-2',
    pattern: /忽略(?:之前|以上|先前)的?(?:指令|规则|设置)/,
    guard: '指令覆盖（中文）',
  },
  {
    id: 'INJ-3',
    pattern: /无视.{0,6}(?:指令|规则|限制)/,
    guard: '规则无效化（中文）',
  },
  {
    id: 'INJ-4',
    pattern: /记住.{0,10}(?:并且|然后|之后).{0,10}(?:执行|自动)/,
    guard: '记忆夹带执行（PMPA 典型载荷）',
  },
  {
    id: 'INJ-5',
    pattern: /disregard|ignore\s+(?:previous|prior|above)/i,
    guard: '指令覆盖（英文）',
  },
  {
    id: 'INJ-6',
    pattern: /转账.{0,8}(?:免|跳过)(?:二次)?确认/,
    guard: '转账免二次确认',
  },
  {
    id: 'INJ-7',
    pattern: /以后.{0,12}不用.{0,8}(?:验证|校验|确认)/,
    guard: '长期关闭校验',
  },
  {
    id: 'INJ-8',
    // 黑名单的固有弱点：穷举说法总能被同义改写绕过。这一条把判据从"具体词"抬到
    // "**否定 + 确认/验证**"这个语义结构上——「别确认」「不必验证」「跳过核对」
    // 都落进来，不再依赖是否恰好写成「免确认」。
    pattern:
      /(?:别|不用|不必|无需|不需要|免去|免掉|免除|省掉|省去|跳过|取消).{0,4}(?:确认|验证|校验|核对)/,
    guard: '取消确认环节（同义改写）',
  },
]

/**
 * 审计面的 PII 脱敏。
 *
 * 注入事件的 `detail` 要留原文才能复盘，但原文里可能夹着身份证号——**审计日志本身
 * 不能成为 PII 的第二个落点**。顺序有讲究：先身份证（18 位）再卡号（16–19 位），
 * 否则 18 位身份证会被卡号规则先吃掉，留下一串看似无害的数字。
 */
export function redactPii(text: string): string {
  return text
    .replace(/\b\d{17}[\dXx]\b/g, '[证件号已脱敏]')
    .replace(/\b\d{16,19}\b/g, '[卡号已脱敏]')
    .replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
}

/**
 * @param text 用户原话（只看 user 通道，见 pipeline 前置拒绝）
 * @param ts 事件时间戳（由调用方注入，保证测试可复现）
 */
export function checkInjection(text: string, ts: string): GateResult {
  for (const item of INJECTION_PATTERNS) {
    const match = text.match(item.pattern)
    if (match !== null) {
      const event: MemoryEvent = {
        type: 'injection_rejected',
        // 原文要留（否则没法复盘），但必须先脱敏——审计日志不能成为 PII 的第二落点。
        detail: { patternId: item.id, guard: item.guard, span: redactPii(match[0]), text: redactPii(text) },
        ts,
      }
      return {
        code: 'GATE_INJECTION',
        reason: `命中注入黑名单 ${item.id}（${item.guard}）`,
        event,
      }
    }
  }
  return { code: 'PASS' }
}
