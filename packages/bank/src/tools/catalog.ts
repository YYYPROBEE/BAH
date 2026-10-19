/**
 * 工具工厂装配（施工单 08 §5 第 1–5 步）。
 *
 * `specs.ts` 是元数据唯一来源；本文件按 `BankToolName` 建一个**穷尽**的工厂表
 * （`Record<BankToolName, …>` 会在漏实现时编译失败）。`createBankTools` 按目录顺序返回，
 * 模型侧 schema 与目录文档因此永远同序。
 */

import type { ToolDefinition } from '@bah/core'

import { createAccountBalanceTool, createAccountListTool, createAnalysisTool, createBillAnalyzeTool, createBillReportTool, createTxnQueryTool } from './queries.ts'
import { BANK_TOOL_SPECS, type BankToolName } from './specs.ts'
import { createTransferCreateTool, createTransferPreviewTool } from './transfers.ts'
import type { BankToolDeps } from './types.ts'
import { createVerifyTool } from './verification.ts'
import { createWealthCompareTool, createWealthListTool, createWealthPurchaseTool } from './wealth.ts'

/** 名字 → 工厂（穷尽表：漏一个工具就编译失败）。 */
const FACTORIES: Readonly<Record<BankToolName, (deps: BankToolDeps) => ToolDefinition<any, any>>> = {
  'account_list': createAccountListTool,
  'account_balance': createAccountBalanceTool,
  'txn_query': createTxnQueryTool,
  'bill_analyze': createBillAnalyzeTool,
  'bill_report': createBillReportTool,
  'analysis_calc': createAnalysisTool,
  'transfer_preview': createTransferPreviewTool,
  'transfer_create': createTransferCreateTool,
  'wealth_list': createWealthListTool,
  'wealth_compare': createWealthCompareTool,
  'wealth_purchase': createWealthPurchaseTool,
  'verify_face': (deps) => createVerifyTool(deps, 'face'),
  'verify_sms': (deps) => createVerifyTool(deps, 'sms'),
  'verify_ushield': (deps) => createVerifyTool(deps, 'ushield'),
}

/** 工厂表里的名字（门禁核对目录完整性用）。 */
export const BANK_TOOL_FACTORY_NAMES: readonly BankToolName[] = Object.keys(
  FACTORIES,
) as BankToolName[]

/**
 * 造出全部 P0 工具（14 个，顺序 = 目录顺序）。
 *
 * 工具定义是闭包：依赖在创建时注入，`execute` 不再读取全局单例。
 */
export function createBankTools(deps: BankToolDeps): readonly ToolDefinition<any, any>[] {
  return BANK_TOOL_SPECS.map((spec) => FACTORIES[spec.name](deps))
}
