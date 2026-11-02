/**
 * 银行工具目录的**唯一元数据来源**。
 *
 * 这里只放模型可见的静态契约：名字、描述、参数 schema、tier、落账事件。
 * 执行体与 presenter 在各自模块里按 `name` 取本表（`specOf`），因此：
 * - 目录生成器（`docs/tool-catalog.md`）只读本文件，不需要装配 Provider；
 * - `verify-tool-catalog` 能把「文档 ↔ 源码」逐行比对；
 * - `tier` 声明不会散落到 `execute()` 里（`verify-tiers` 门禁 + 评审双保险）。
 *
 * 数量上限 28：新增先删旧的，`verify-tool-catalog` 强制。
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
  /**
   * 只读分支额外落的领域事件（可选）。
   *
   * 动作式工具（`action=…`）会有两条路径，只有一条是写：`risk_assess` 的 `questions`
   * 分支只下发问卷却会更新「用户看到了什么」，必须落账；但把它塞进 `event` 会让目录
   * 把「取问卷」误写成「改等级」。这里**显式**写出来，目录与门禁一起核对。
   */
  readonly readEvent?: BankSessionEventType
  /** 批次（08 只做 P0）。 */
  readonly batch: 'P0'
  /** 场景分组（目录展示用）。 */
  readonly scenario: '账户/账单' | '转账' | '理财' | '强验证' | '卡片'
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
      '列出当前用户名下全部账户与卡片（账户尾号/类型/余额；卡尾号/类型/状态/日限额）。用户问“我有几张卡/哪些账户/卡什么状态”时用；不要用它查单笔流水或账单分析。',
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
      '按月度/季度/年度汇总收支、分类占比、环比与异常（大额 / 夜间 / 重复扣费）。用户问“这个月钱花哪了/帮我分析账单”时用；要看历史某个月或某个自然年时用 month / year 指定；不要用它列单笔明细（用 txn_query）。',
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
        month: {
          type: 'string',
          description:
            '指定历史月份（YYYY-MM，如 2026-09）。用户说“上个月/9 月的账单”时用；给定时按 month 口径算那个月。与 year 互斥。',
        },
        year: {
          type: 'string',
          description:
            '指定自然年（YYYY，如 2025）。用户说“2025 年花了多少”时用；给定时按 year 口径算该年 12 个账期。与 month 互斥。',
        },
        monthOffset: {
          type: 'integer',
          description:
            '相对当前月的偏移（0 = 本月，-1 = 上个月，-3 = 三个月前）。脚本/无法换算日期时用；与 month / year 互斥。',
        },
        monthOfYear: {
          type: 'integer',
          description:
            '只给月份（1–12）：如“9 月的账单”。年份由系统按“不晚于当前月”补齐；与 month / year 互斥。',
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
        month: {
          type: 'string',
          description:
            '指定历史月份（YYYY-MM，如 2026-09）。用户说“上个月/9 月的报告”时用；与 year 互斥。',
        },
        year: {
          type: 'string',
          description:
            '指定自然年（YYYY，如 2025）。用户说“2025 年度报告”时用；与 month 互斥。',
        },
        monthOffset: {
          type: 'integer',
          description:
            '相对当前月的偏移（0 = 本月，-1 = 上个月）。脚本/无法换算日期时用；与 month / year 互斥。',
        },
        monthOfYear: {
          type: 'integer',
          description: '只给月份（1–12）：如“9 月的报告”；与 month / year 互斥。',
        },
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
        viaCardId: {
          type: 'string',
          description: '用哪张卡支付（可选；仅当用户点名“用这张卡”时填，不要默认填）',
        },
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
        viaCardId: {
          type: 'string',
          description: '用哪张卡支付（可选；仅当用户点名“用这张卡”时填，不要默认填）',
        },
      },
      required: ['amount', 'payee'],
    },
    tier: { level: 'yellow', amountPath: 'amount' },
    event: 'transfer/created',
    batch: 'P0',
    scenario: '转账',
  },
  {
    name: 'aa_create',
    description:
      'AA 拆分收款（动作式）：`action="create"` 按人数均分或自定义份额建组（黄档写操作）；' +
      '`action="status"` 按 groupId 查询（只读查询，不签票）；' +
      '`action="collect"` 是**模拟代收**（demo 口径，本进程替某位参与人把份额记进组织者账户并写入账流水，黄档写操作）；' +
      '`action="decline"` 记录某位参与人明确拒绝（黄档写操作）；' +
      '`action="close"` 由组织者提前结束收款（剩余未付转过期并按收口规则定组状态，黄档写操作）。' +
      '用户说“我们 AA/一共多少钱几个人分”时用；有人拒付用 decline，组织者不想再等用 close。' +
      '不要用它直接扣款或伪造真实到账——跨人真实收款需要行内清算接口。',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description:
            'create（缺省，建组）/ status（按 groupId 查询）/ collect（模拟代收某一位）/ ' +
            'decline（某位参与人拒绝）/ close（提前结束，剩余未付转过期）',
        },
        groupId: { type: 'string', description: 'action=status / collect / decline / close 时的 AA 组 ID' },
        participant: {
          type: 'string',
          description:
            'action=collect / decline 时的参与人：姓名，或序号（0 起，写成 “0”/“1”）；不接受手机号',
        },
        expiresInHours: {
          type: 'number',
          description: '收款窗口（小时，1–168；create 可选，缺省 72）。到期未付自动转 expired',
        },
        title: { type: 'string', description: 'AA 标题（如“周末聚餐”）' },
        totalYuan: { type: 'number', description: 'AA 总额（元；create 必填）' },
        split: { type: 'string', description: 'equal（缺省，均分）/ custom（按 shareYuan 自定义）' },
        participants: {
          type: 'array',
          description: '参与人（2–20 人；create 必填）',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '姓名' },
              phone: { type: 'string', description: '手机号（可选）' },
              shareYuan: { type: 'number', description: 'custom 时的份额（元）' },
            },
            required: ['name'],
          },
        },
      },
    },
    tier: { level: 'yellow' },
    event: 'aa/created',
    readEvent: 'read/aa',
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
  {
    name: 'risk_assess',
    description:
      '风险测评（服务端问卷）：先 `action="questions"` 取服务端问卷，把题目原样交给用户逐题作答，再由用户确认后用 `action="submit"` 提交。' +
      '用户明确要做风险测评 / 更新风险等级时用；**不得替用户作答或推测选项**，不提交合法问卷 ID 就落不了档，也不要用它直接指定等级或购买产品。',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['questions', 'submit'],
          description:
            'questions=只取问卷（不改等级、不落档）；submit=提交用户逐题作答（需 questionnaireId + 5 条 answers）',
        },
        questionnaireId: {
          type: 'string',
          description: 'action="submit" 必填：questions 分支下发的问卷 ID（服务端签发，过期/跨用户一律拒绝）',
        },
        answers: {
          type: 'array',
          description:
            'action="submit" 必填：5 条 {index, key}，必须是用户本人在问卷上选择的项（不是模型推测）',
          items: {
            type: 'object',
            properties: {
              index: { type: 'integer', minimum: 1, maximum: 5, description: '题号（1–5）' },
              key: {
                type: 'string',
                enum: ['conservative', 'middle', 'aggressive'],
                description: '所选项的键（每题的选项文本由问卷给出）',
              },
            },
            required: ['index', 'key'],
          },
          minItems: 5,
          maxItems: 5,
        },
      },
      required: ['action'],
    },
    tier: { level: 'yellow' },
    event: 'risk/assessed',
    // 只读分支（action=questions）落的是这条：目录里必须两个都写，
    // 否则文档会让读者以为取问卷也会改等级。
    readEvent: 'read/risk-questions',
    batch: 'P0',
    scenario: '理财',
  },
  {
    name: 'wealth_positions',
    description:
      '列出当前用户的理财持仓（份额/成本/市值/盈亏与合计）。用户问“我买了什么理财/持仓收益多少”时用；不要用它申购或赎回（申购用 wealth_purchase，赎回用 wealth_redeem）。',
    schema: { type: 'object', properties: {} },
    tier: { level: 'green' },
    event: 'read/wealth-positions',
    batch: 'P0',
    scenario: '理财',
  },
  {
    name: 'wealth_redeem',
    description:
      '赎回理财产品（红色写操作：必须强验证 + 审批后执行）。用户明确说“赎回/卖掉某笔理财”时用；holdingId 与 productId 二选一，amount 缺省=全部赎回；不要用它购买产品或查询持仓。',
    schema: {
      type: 'object',
      properties: {
        holdingId: { type: 'string', description: '持仓 ID（从 wealth_positions 取）' },
        productId: { type: 'string', description: '产品 ID（按产品赎回时用；与 holdingId 二选一）' },
        amountYuan: {
          type: 'number',
          description: '赎回金额（元；缺省=该持仓全部市值）',
          exclusiveMinimum: 0,
          multipleOf: 0.01,
        },
      },
    },
    tier: { level: 'red' },
    event: 'wealth/redeemed',
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
        cardId: { type: 'string', description: '要挂失的卡片 ID（从 account_list 结果里每张卡的「卡ID」取，不要猜）' },
      },
      required: ['cardId'],
    },
    tier: { level: 'red' },
    event: 'card/reported-lost',
    batch: 'P0',
    scenario: '账户/账单',
  },
  {
    name: 'fund_lock',
    description:
      '锁定 / 释放活期资金（写操作）：锁定 = 把活期余额划到**本人锁定账户**（earmark：可用余额减少、总资产不变）；' +
      '释放 = 从锁定账户划回活期。用户说“先锁定 1000 元活期/这笔钱留着别花/解除锁定”时用；' +
      '不要用它给他人转账（用 transfer_create），也不要把它当挂失（用 card_report_lost）。',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['lock', 'release', 'status'],
          description: 'lock=锁定 / release=释放 / status=只查当前锁定金额（只读，不签票）',
        },
        amountYuan: {
          type: 'number',
          description: '金额（元，最多两位小数；lock / release 必填）',
          exclusiveMinimum: 0,
          multipleOf: 0.01,
        },
      },
      required: ['action'],
    },
    tier: { level: 'yellow' },
    event: 'transfer/created',
    readEvent: 'read/balance',
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
  {
    name: 'card_freeze',
    description:
      '冻结银行卡（黄档写操作，可逆：随时可解冻）。用户怀疑盗刷、卡暂时找不到、或想停用某张卡时用；卡已确认丢失请用 card_report_lost（红档、不可逆），不要用本工具代替挂失。',
    schema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: '要冻结的卡片 ID（从 account_list 结果里每张卡的「卡ID」取，不要猜）' },
        reason: { type: 'string', description: '冻结原因（可选，仅落审计，不影响判定）' },
      },
      required: ['cardId'],
    },
    tier: { level: 'yellow' },
    event: 'card/state-changed',
    batch: 'P0',
    scenario: '卡片',
  },
  {
    name: 'card_unfreeze',
    description:
      '解冻银行卡（红档写操作：必须强验证 + 审批）。用户明确要求恢复用卡、并已确认卡在本人手中时用；卡已挂失请走补发流程，不要用本工具解挂。',
    schema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: '要解冻的卡片 ID（从 account_list 结果里每张卡的「卡ID」取）' },
      },
      required: ['cardId'],
    },
    tier: { level: 'red' },
    event: 'card/state-changed',
    batch: 'P0',
    scenario: '卡片',
  },
  {
    name: 'card_apply',
    description:
      '申请一张新卡（黄档写操作，缺省虚拟借记卡）。用户明确说“办一张虚拟卡/新卡”时用；说“信用卡/信用额度/授信额度”时传 kind=credit 并给 creditLimitYuan（此时两个限额缺省等于授信额度）；挂失后要补一张时用 replacesCardId 指定原卡（原卡必须已挂失）；不要用它挂失、冻结或调整已有卡额度。注意区分两种“额度”：creditLimitYuan 是**信用卡授信额度**（支付时真判"已用 + 本笔 ≤ 授信"），dailyLimitYuan/monthlyLimitYuan 是**交易限额**（防单日/近 30 天大额，按 min(卡日限额, Config 日限额) 与同卡滚动窗口判定）。',
    schema: {
      type: 'object',
      properties: {
        accountId: { type: 'string', description: '挂到哪个账户（缺省主活期账户）' },
        type: { type: 'string', description: '卡类型（介质）：virtual（缺省）/ physical' },
        kind: {
          type: 'string',
          description:
            '卡产品：debit（缺省，借记卡）/ credit（信用卡）。credit 时必须同时给 creditLimitYuan；借记卡传 creditLimitYuan 会被拒（tool-args-invalid）。',
        },
        creditLimitYuan: {
          type: 'number',
          description:
            '授信额度（元；仅 kind=credit 必填）：信用卡的总额度，支付时按"已用 + 本笔 ≤ 授信"硬判定。借记卡不要传。',
        },
        dailyLimitYuan: { type: 'number', description: '交易日限额（元；缺省 2000/1000，信用卡缺省 = 授信额度）' },
        monthlyLimitYuan: { type: 'number', description: '交易月限额（元；缺省 8000/20000，信用卡缺省 = 授信额度）' },
        replacesCardId: {
          type: 'string',
          description:
            '补发场景填原卡 ID：该卡必须已挂失，新卡自动挂到同一账户。用户说“挂失了给我补一张/补卡”时用；普通新开卡不要填。',
        },
      },
    },
    tier: { level: 'yellow' },
    event: 'card/issued',
    batch: 'P0',
    scenario: '卡片',
  },
  {
    name: 'card_limit_set',
    description:
      '调整银行卡额度（红档写操作：必须强验证 + 审批）。两种额度都从这里调，但语义不同：creditLimitYuan 是**信用卡授信额度**（仅 kind=credit 的卡接受；降额不得低于已用，否则报 credit-in-use），dailyLimitYuan/monthlyLimitYuan 是**交易限额**（日限额生效值取 min(卡日限额, Config 日限额)；月限额按同卡近 30 天滚动窗口判定，不是自然月）。三项可同时给，均校验；日限额不得高于月限额。不要用它冻结/挂失卡片。',
    schema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: '要调整的卡片 ID（从 account_list 取）' },
        creditLimitYuan: {
          type: 'number',
          description:
            '新的授信额度（元；仅信用卡）：降额不得低于已用额度（已用多少见 account_list 的「已用」）。不传 = 不动授信额度。',
        },
        dailyLimitYuan: { type: 'number', description: '新的交易日限额（元；至少给一项额度）' },
        monthlyLimitYuan: { type: 'number', description: '新的交易月限额（元；至少给一项额度）' },
      },
      required: ['cardId'],
    },
    tier: { level: 'red' },
    event: 'card/limits-changed',
    batch: 'P0',
    scenario: '卡片',
  },
  {
    name: 'card_restriction',
    description:
      '设置或解除卡片的交易限制（黄档写操作）：online=线上交易、overseas=境外交易、category=指定商户品类。online/overseas 对以卡转账硬阻断；category 在本系统的 mock 卡消费通道上拦截对应品类（品类值必须是已知键：dining/coffee/grocery/transit/shopping/digital/other）。用户说“关掉这张卡的线上支付/境外支付/某类消费”或“恢复”时用；整卡停用请用 card_freeze，不要用本工具代替冻结/挂失。',
    schema: {
      type: 'object',
      properties: {
        cardId: { type: 'string', description: '卡片 ID（从 account_list 取）' },
        mode: { type: 'string', description: 'set=设置限制 / clear=解除限制（必填）' },
        kind: {
          type: 'string',
          description: '限制范围：online / overseas / category（set 必填；clear 缺省=清空全部）',
        },
        value: {
          type: 'string',
          description: 'category 时的品类键（dining / coffee / grocery / transit / shopping / digital / other）',
        },
        note: { type: 'string', description: '备注（仅落审计）' },
      },
      required: ['cardId', 'mode'],
    },
    tier: { level: 'yellow' },
    event: 'card/restrictions-changed',
    batch: 'P0',
    scenario: '卡片',
  },
  {
    name: 'password_change',
    description:
      '发起/查询交易密码修改（红档写操作，ADR-0014）：action=request 签一张一次性交接票据并给出安全页路径，action=status 只读上次改密时刻与剩余尝试次数。用户说“改交易密码/忘记交易密码想重设/看看密码还能试几次”时用；不要用它接收或转述任何密码明文（本工具的参数里只有 action，密码只能在安全页表单里填），也不要用它改登录密码（登录密码走登录页）。',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'request=发起改密（签发安全页交接票据）/ status=只读查询（不签票）',
        },
      },
      required: ['action'],
    },
    tier: { level: 'red' },
    event: 'security/password-changed',
    readEvent: 'read/password-status',
    batch: 'P0',
    scenario: '强验证',
  },
] as const satisfies readonly BankToolSpec[]

/** 工具名联合（18 个字面量）。 */
export type BankToolName = (typeof BANK_TOOL_SPECS)[number]['name']

/**
 * 工具数量上限。
 *
 * 2026-11-01 由 28 提到 30：新增 `fund_lock`（资金锁定/释放）与
 * `password_change`（密码修改）——两者都是权限谱系点名、但**不能**用既有工具
 * 表达的动作（`transfer_create` 表达不了 earmark 的回收，`card_*` 表达不了凭据变更）。
 * 上限仍是硬约束：再新增必须先删旧或先改本节。
 *
 * 2026-11-01（ADR-0014 同批）30 → **31**：`password_change` 立项时占用第 30 个名额，
 * 落地时目录确实是 30 个；按"新增先改本节"的纪律把上限同步到 31，留一个空位给
 * 下一单（若先到的是删旧，就把本节改回去——常量只跟着目录走）。
 */
export const BANK_TOOL_LIMIT = 31

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
