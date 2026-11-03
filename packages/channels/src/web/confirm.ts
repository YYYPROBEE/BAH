/**
 * 危险审批的"打字确认"规则（ADR-0008 配套的安全项）。
 *
 * 为什么不是可选点选：`ChoiceFrame` 的契约写明"追问不走审批通道，没有票据、没有 responder"，
 * 拿它做删除确认等于用一个聊天问答冒充审批闸门。删除/撤销类操作必须在**审批通道**上，
 * 且要求逐字输入确认词——注入文本可以推动用户点"确认"，但推不动用户打出一个指定的词。
 *
 * 单一真相源：帧渲染（`project.ts`）与服务端校验（`http-adapter.ts` 的 `decide`）都读本表。
 * 前端校验等于没校验，所以**判定只在服务端**；这里导出的是"要求什么词"，不是"是否放行"。
 */

/** 工具名 → 必须逐字输入的确认词。 */
const CONFIRM_TEXT_BY_TOOL: Readonly<Record<string, string>> = {
  fact_forget: '删除',
  plan_disarm: '撤销',
}

/** 该工具是否要求打字确认；返回确认词（否则 `undefined`）。 */
export function requiredConfirmText(name: string): string | undefined {
  return CONFIRM_TEXT_BY_TOOL[name]
}
