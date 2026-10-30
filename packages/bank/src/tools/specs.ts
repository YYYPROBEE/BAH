/**
 * 银行工具目录的**唯一元数据来源**（施工单 08 §2 / §3）。
 *
 * 这里只放模型可见的静态契约：名字、描述、参数 schema、tier、落账事件。
 * 执行体与 presenter 在各自模块里按 `name` 取本表（`specOf`），因此：
 * - 目录生成器（`docs/tool-catalog.md`）只读本文件，不需要装配 Provider；
 * - `verify-tool-catalog` 能把「文档 ↔ 源码」逐行比对；
 * - `tier` 声明不会散落到 `execute()` 里（`verify-tiers` 门禁 + 评审双保险）。
 *
 * 数量上限 28（施工单 08 §2）：新增先删旧的，`verify-tool-catalog` 强制。
 */

import type { ToolSchema, ToolTier } from '@bah/core'

import type { BankSessionEventType } from './events.ts'

/** 工具目录的一项。 */
export interface BankToolSpec {
  /** 全局唯一、模型可见的名字（点分命名服务银行领域语义）。 */
  readonly name: string
  /** 面向模型的用途说明（必须写「何时用 / 何时不用」两句）。 */
  readonly description: string
  /** 参数 JSON Schema（object 根）。 */
  readonly schema: ToolSchema
  /** 定义处声明的权限级别（治理平面解释；工具内不许自带阈值）。 */
  readonly tier: ToolTier
  /** 该工具成功执行时落账的领域事件。 */
  readonly event: BankSessionEventType
  /** 批次（08 只做 P0）。 */
  readonly batch: 'P0'
  /** 场景分组（目录展示用）。 */
  readonly scenario: '账户/账单' | '转账' | '理财' | '强验证'
}

/** 收款人参数（转账 / 试算共用）。 */
const PAYEE_SCHEMA = {
  type: 'object',
  description: '收款人信息（name 必填）',
  properties: {
    name: { type: 'string', description: '收款人姓名（必填）' },
    phone: { type: 'string', description: '收款人手机号（可选，用于区分同名收款人）' },
    payeeId: { type: 'string', description: '已绑定收款人的 ID（可选；不确定就不要填）' },
    memo: { type: 'string', description: '转账附言（可选）' },
  },
  required: ['name'],
} as const

/** 时间区间参数。 */
const RANGE_SCHEMA = {
  type: 'object',
  description: '时间区间；日期用 ISO（YYYY-MM-DD 或完整 ISO 8601），缺省为最近 30 天',
  properties: {
    from: { type: 'string', description: '起始时刻（含）' },
    to: { type: 'string', description: '结束时刻（含）' },
  },
  required: ['from', 'to'],
} as const

/** 账户 ID 参数（缺省 = 主账户）。 */
const ACCOUNT_ID_FIELD = {
  type: 'string',
  description: '账户 ID；缺省使用主账户（活期）',
} as const

/** 14 个 P0 工具（6 查询 + 2 转账 + 3 理财 + 3 强验证）。 */
export const BANK_TOOL_SPECS = [
  /* ── 账户 / 账单（6） ─────────────────────────────────────────────────── */
  {
    name: 'account_list',
    description:
      '列出当前用户名下全部银行账户（尾号、类型、状态、余额）。用户问“我有几张卡/哪些账户”时用；不要用它查单笔流水或账单分析。',
    schema: { type: 'object', properties: {} },
    tier: { level: 'green' },
    event: 'read/accounts',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'account_balance',
    description:
      '查询某个账户的余额与可用余额（含冻结金额说明）。用户问“我还有多少钱/余额多少”时用；不要用它做转账或查询历史交易。',
    schema: {
      type: 'object',
      properties: { accountId: ACCOUNT_ID_FIELD },
    },
    tier: { level: 'green' },
    event: 'read/balance',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'txn_query',
    description:
      '按时间区间、分类、收支方向分页查询交易流水。用户问“最近花了什么/某笔转账到了吗”时用；不要用它做汇总分析（用 bill_analyze）。',
    schema: {
      type: 'object',
      properties: {
        accountId: ACCOUNT_ID_FIELD,
        range: RANGE_SCHEMA,
        category: {
          type: 'string',
          description: '分类：transfer / salary / consumption / subscription / wealth / fee / refund',
        },
        direction: { type: 'string', description: '收支方向：in（收入）/ out（支出）' },
        page: { type: 'integer', description: '页码，从 1 开始（缺省 1）' },
        cursor: { type: 'string', description: '游标（上一页返回的 nextCursor；与 page 二选一）' },
        limit: { type: 'integer', description: '每页条数（缺省 20，上限 100）' },
      },
    },
    tier: { level: 'green' },
    event: 'read/txns',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'bill_analyze',
    description:
      '按月度/季度/年度汇总收支、分类占比、环比与异常（大额 / 夜间 / 重复扣费）。用户问“这个月钱花哪了/帮我分析账单”时用；不要用它列单笔明细（用 txn_query）。',
    schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: '统计口径：month（本月）/ quarter（近三个月）/ year（近十二个月，不做同比）',
        },
        groupBy: {
          type: 'string',
          description:
            '汇总维度：category（账务分类，缺省）/ payee（收款人）/ merchant（商户品类：餐饮/咖啡/通勤等）',
        },
      },
      required: ['period'],
    },
    tier: { level: 'green' },
    event: 'read/bill-analyzed',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'bill_report',
    description:
      '按月度/季度/年度生成一段可读的账单报告（摘要或明细）。用户要“出一份账单报告/发给我的报告”时用；不要用它做单笔交易查询。',
    schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: '统计口径：month（本月）/ quarter（近三个月）/ year（近十二个月）',
        },
        format: { type: 'string', description: '报告形态：summary（摘要，缺省）/ detail（含异常与收款人明细）' },
      },
      required: ['period'],
    },
    tier: { level: 'green' },
    event: 'read/bill-report',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'analysis_calc',
    description:
      '在受限算术语言里对已给数据做算术/占比计算：无网络、无文件、无循环，受运算预算与时限双重约束。用户说“帮我算占比/算一下这个数”且数据已由上一步工具给出时用；不要用它访问账户或发起任何写操作。',
    schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description:
            '表达式（如 data.dining / (data.dining + data.transport) * 100）；支持 + - * / %、括号与 sum/avg/min/max/round/abs',
        },
        data: { type: 'object', description: '只读输入数据（通常来自上一步工具结果）', additionalProperties: true },
      },
      required: ['code'],
    },
    tier: { level: 'green' },
    event: 'read/analysis',
    batch: 'P0',
    scenario: '账户/账单',
  },

  /* ── 转账（2） ───────────────────────────────────────────────────────── */
  {
    name: 'transfer_preview',
    description:
      '转账试算 + 风控预检：金额、收款人、到账时间、当日已用/剩余额度与风险结论。用户表达“给某人转多少钱/上次那个转账再来一次”但还没确认执行时**先用它**；不要用它真正扣款（用 transfer_create）。',
    schema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: '金额（元，最多两位小数，必须 > 0）',
          exclusiveMinimum: 0,
          multipleOf: 0.01,
        },
        payee: PAYEE_SCHEMA,
        remark: { type: 'string', description: '转账附言（可选）' },
      },
      required: ['amount', 'payee'],
    },
    tier: { level: 'green' },
    event: 'transfer/preview',
    batch: 'P0',
    scenario: '转账',
  },
  {
    name: 'transfer_create',
    description:
      '发起一笔转账（写操作，必然进入审批；超过日累计或新收款人会升为红色强验证）。用户**明确确认**“就转/确认转账”后才用；只做试算请用 transfer_preview，不要用它绕过审批。',
    schema: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: '金额（元，最多两位小数，必须 > 0）',
          exclusiveMinimum: 0,
          multipleOf: 0.01,
        },
        payee: PAYEE_SCHEMA,
        remark: { type: 'string', description: '转账附言（可选）' },
        when: { type: 'string', description: '执行时间：now（缺省）/ ISO 时间（定时转账属 P1，当前会拒绝）' },
        idempotencyKey: {
          type: 'string',
          description: '可选幂等键：网络重试/重复提交时复用同一键，10 分钟内同参数只扣款一次',
        },
      },
      required: ['amount', 'payee'],
    },
    tier: { level: 'yellow', amountPath: 'amount' },
    event: 'transfer/created',
    batch: 'P0',
    scenario: '转账',
  },

  /* ── 理财（3） ───────────────────────────────────────────────────────── */
  {
    name: 'wealth_list',
    description:
      '按风险等级、产品类型、期限筛选理财产品（结果必带风险提示 disclaimerId）。用户问“有什么稳健理财/推荐产品”时用；不要用它购买产品（用 wealth_purchase）。',
    schema: {
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: '筛选条件（可全部省略）',
          properties: {
            riskGrade: { type: 'string', description: '风险等级 R1–R5' },
            kind: { type: 'string', description: '产品类型：deposit / fixed / fund' },
            maxTermDays: { type: 'integer', description: '最长期限（天）' },
          },
        },
      },
    },
    tier: { level: 'green' },
    event: 'read/wealth',
    batch: 'P0',
    scenario: '理财',
  },
  {
    name: 'wealth_compare',
    description:
      '把 2–4 个指定理财产品放在一起对比（期限、风险等级、预期收益、起投额）。用户已经点名几个产品、要求“对比一下”时用；不知道产品 ID 时不要硬猜，先用 wealth_list，也不要把它当购买入口（购买用 wealth_purchase）。',
    schema: {
      type: 'object',
      properties: {
        ids: { type: 'array', description: '产品 ID 列表（2–4 个）', items: { type: 'string' } },
      },
      required: ['ids'],
    },
    tier: { level: 'green' },
    event: 'read/wealth',
    batch: 'P0',
    scenario: '理财',
  },
  {
    name: 'wealth_purchase',
    description:
      '购买理财产品（红色写操作：必须强验证 + 审批后执行）。用户明确选定产品、金额并确认购买时用；只查询或对比请用 wealth_list / wealth_compare，不要在未确认前替用户下单。',
    schema: {
      type: 'object',
      properties: {
        productId: { type: 'string', description: '理财产品 ID（必填）' },
        amount: {
          type: 'number',
          description: '购买金额（元，最多两位小数，必须 ≥ 起投额）',
          exclusiveMinimum: 0,
          multipleOf: 0.01,
        },
        accountId: ACCOUNT_ID_FIELD,
      },
      required: ['productId', 'amount'],
    },
    tier: { level: 'red' },
    event: 'wealth/purchased',
    batch: 'P0',
    scenario: '理财',
  },

  /* ── 强验证（3） ─────────────────────────────────────────────────────── */
  {
    name: 'verify_face',
    description:
      '红色操作的挑战链要求人脸验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。',
    schema: {
      type: 'object',
      properties: { challengeId: { type: 'string', description: '挑战 ID（由红色操作签发）' } },
      required: ['challengeId'],
    },
    tier: { level: 'green' },
    event: 'verify/face',
    batch: 'P0',
    scenario: '强验证',
  },
  {
    name: 'verify_sms',
    description:
      '红色操作的挑战链要求短信验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。',
    schema: {
      type: 'object',
      properties: { challengeId: { type: 'string', description: '挑战 ID（由红色操作签发）' } },
      required: ['challengeId'],
    },
    tier: { level: 'green' },
    event: 'verify/sms',
    batch: 'P0',
    scenario: '强验证',
  },
  {
    name: 'verify_ushield',
    description:
      '红色操作的挑战链要求 U 盾验证时用；没有挑战 ID 时不要调用，独立调用会返回 no-challenge。',
    schema: {
      type: 'object',
      properties: { challengeId: { type: 'string', description: '挑战 ID（由红色操作签发）' } },
      required: ['challengeId'],
    },
    tier: { level: 'green' },
    event: 'verify/ushield',
    batch: 'P0',
    scenario: '强验证',
  },
  {
    name: 'card_report_lost',
    description:
      '挂失银行卡（红档写操作，不可逆：挂失后该卡即刻不可用），必然进入审批并触发强验证。用户**明确说要挂失**后才用；只是询问卡状态请用 account_list，不要用它试探。',
    schema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: '要挂失的银行卡 ID（从 account_list 的卡片信息里取）' },
      },
      required: ['cardId'],
    },
    tier: { level: 'red' },
    event: 'card/reported-lost',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'sub_cancel',
    description:
      '取消自动扣款订阅（黄档写操作）。用户明确要求“取消/退订某个自动续费”后用；合约期内需显式确认（confirmContract），只想停一个订阅用本工具，要关整个商户的代扣协议用 sub_authorize。不要用它代替订阅查询；不要在用户未确认合约后果时取消。',
    schema: {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', description: '要取消的订阅 ID（从 sub_list 取）' },
        confirmContract: {
          type: 'boolean',
          description: '合约期内取消必须显式置 true（用户已确认违约金/后果）',
        },
        mode: {
          type: 'string',
          description: 'now（立即取消，缺省）/ at-next-cycle（到期即断）',
        },
      },
      required: ['subscriptionId'],
    },
    tier: { level: 'yellow' },
    event: 'sub/cancelled',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'sub_list',
    description:
      '列出订阅并识别周期扣款：三分法汇总（订阅/账单/分期）、涨价、闲置、断供核验，以及单条订阅详情。用户问“我有哪些订阅/每月固定扣多少/这项为什么多了”时用；不要用它取消订阅（用 sub_cancel）或关闭代扣协议（用 sub_authorize）。',
    schema: {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', description: '只看某条订阅时传入（从本工具结果里取）' },
        limit: { type: 'integer', description: '最多返回多少条检测结果（1..30，缺省 10）' },
      },
    },
    tier: { level: 'green' },
    event: 'read/subscriptions',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'sub_watch',
    description:
      '设置订阅提醒或标注（黄档写操作）：remind=到期提醒、idle=我不用了、none=清除。用户说“到期提醒我/这个我不用了”时用；不要用它改订阅状态或关闭代扣（取消用 sub_cancel，关协议用 sub_authorize）。',
    schema: {
      type: 'object',
      properties: {
        subscriptionId: { type: 'string', description: '订阅 ID（从 sub_list 取）' },
        watch: { type: 'string', description: 'remind / idle / none（必填）' },
        aheadDays: { type: 'integer', description: '提前几天提醒（1..7；仅 remind 有效）' },
      },
      required: ['subscriptionId', 'watch'],
    },
    tier: { level: 'yellow' },
    event: 'sub/watch-updated',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'sub_authorize',
    description:
      '关闭某商户的代扣协议（黄档写操作，只关不开，影响该商户全部订阅）。用户要求“彻底停掉这家扣款”时用；不要用它停单个订阅（用 sub_cancel）。恢复扣款需在商户侧重新签约，本工具不提供恢复。',
    schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: '商户名或归一化键（从 sub_list 的商户名取）' },
      },
      required: ['merchant'],
    },
    tier: { level: 'yellow' },
    event: 'sub/authorization-revoked',
    batch: 'P0',
    scenario: '账户/账单',
  },
] as const satisfies readonly BankToolSpec[]

/** 工具名联合（16 个字面量）。 */
export type BankToolName = (typeof BANK_TOOL_SPECS)[number]['name']

/** 工具数量上限（施工单 08 §2）。 */
export const BANK_TOOL_LIMIT = 28

/** 按名字取 spec（工厂与门禁共用；名字只来自上面的联合，不会 miss）。 */
export function specOf(name: BankToolName): BankToolSpec {
  const found = BANK_TOOL_SPECS.find((spec) => spec.name === name)
  if (found === undefined) {
    // 类型上不可达；保留 fail-loud 以防将来放宽名字类型
    throw new Error(`bank-tools: 工具目录缺少 ${name}`)
  }
  return found
}

/** 全部工具名（顺序 = 目录顺序）。 */
export const BANK_TOOL_NAMES: readonly BankToolName[] = BANK_TOOL_SPECS.map((spec) => spec.name)

/** 模型可见工具名集合（治理平面判断"是否本族工具"用）。 */
export const BANK_TOOL_NAME_SET: ReadonlySet<string> = new Set(BANK_TOOL_NAMES)
