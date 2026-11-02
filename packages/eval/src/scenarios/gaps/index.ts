/**
 * 补齐场景（六场景旅程证据）：21 条，**不并入 `ALL_SCENARIOS`**。
 *
 * 为什么单独一组：官方评测面冻结在 91 例（`validate.ts` 把七族例数与总数写死），
 * 这里的场景是对赛题子能力的端到端补证，经 `pnpm eval:gaps` 手动复跑，
 * 不进 CI 的 14 步、不计入 91 口径。引用时必须写 `gaps:<ID>`，不能写 `eval:<ID>`。
 *
 * 落点顺序即执行顺序（同 boot 组内按数组下标跑）。四条链各自相邻：
 * 限制 set→clear、冻结→解冻、挂失→补发、AA create→collect→decline。
 *
 * 断言纪律（逐条自检）：
 * - 每条至少有一条会失败的断言；`no-event … where{…}` 与同 `type` 的 `event` 成对；
 * - 金额入参是「元」、核心与事件是「分」；
 * - 动态 ID（`rq-<seq>`／`aa-new-<seq>`／`c-new-<seq>`）只钉本 boot 内可解释的值，
 *   不钉新卡 ID/尾号（随 boot 内已发卡数漂移）；
 * - 不写 `it.only`/`test.only`，不碰 `ALL_SCENARIOS`。
 *
 * 事件与 `tool-result` 的映射见 `scenario/runner.ts` 的 `TOOL_EVENT`：
 * 理财持仓/赎回、风险测评、AA 建组的结果走领域事件的 `result`；
 * 卡片状态类事件没有 `result` 包装，因此用 `event … where{…}` 钉事件载荷字段。
 */

import { outcomeStep, toolCallStep } from '@bah/llm/mock'

import { scenario, readSteps, writeSteps } from '../helpers.ts'
import type { EvalScenario } from '../../scenario/types.ts'

export const GAP_SCENARIOS: readonly EvalScenario[] = [
  /* ── 卡片（P-31…P-38，GAP-CAP-06/07/08/09） ─────────────────────────── */
  scenario({
    id: 'P-31',
    family: 'P',
    title: '黄档申请虚拟借记卡：审批后发卡，不要求强验证',
    turns: ['办一张虚拟卡'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_apply'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      // 黄档不该出现强验证挑战；与上一条 approval/asked 成对才有效（C9）。
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      // 事件载荷直接钉介质与缺省限额（虚拟借记卡：日 200,000 分 / 月 800,000 分）。
      {
        kind: 'event',
        type: 'card/issued',
        where: { type: 'virtual', dailyLimitCents: 200_000, monthlyLimitCents: 800_000 },
      },
    ],
    action: { kind: 'script', steps: writeSteps('card_apply', { type: 'virtual' }) },
  }),
  scenario({
    id: 'P-32',
    family: 'P',
    title: '红档挂失：审批 + 强验证后卡进入 lost（不可逆）',
    turns: ['我要挂失卡 c-2'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_report_lost'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'card/reported-lost', where: { cardId: 'c-2', status: 'lost' } },
    ],
    action: { kind: 'script', steps: writeSteps('card_report_lost', { cardId: 'c-2' }) },
  }),
  scenario({
    id: 'P-33',
    family: 'P',
    title: '挂失后补发：原卡保持 lost，新卡挂回同一账户',
    turns: ['挂失了，给我补一张卡'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_apply', 'account_list'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      // 补发也走 card/issued；若原卡未挂失，工具会拒，事件不会出现。
      // 事件载荷不含 replacedCardId（见 events.ts），因此在这里不钉该字段；
      // 用 account_list 回读「原卡 c-2 仍为 lost」，补上标题里的那半句承诺。
      { kind: 'event', type: 'card/issued', where: { accountId: 'a-1', type: 'virtual' } },
      { kind: 'tool-result', tool: 'account_list', path: 'cards.1.cardId', equals: 'c-2' },
      { kind: 'tool-result', tool: 'account_list', path: 'cards.1.status', equals: 'lost' },
      { kind: 'no-event', type: 'card/reported-lost' },
    ],
    action: {
      kind: 'script',
      steps: [
        // 同一步里先补发、再回读；`writeSteps` 的收尾文本会结束 turn，不能直接拼读步骤。
        toolCallStep('eval-write', 'card_apply', { replacesCardId: 'c-2' }),
        toolCallStep('eval-read', 'account_list', {}),
        outcomeStep({ tool: 'card_apply', ok: '已受理。', failed: '未执行：{reason}' }),
      ],
    },
  }),
  scenario({
    id: 'P-34',
    family: 'P',
    title: '黄档设置线上交易限制：审批后落 restrictions-changed(set)',
    turns: ['把这张卡的线上支付关掉'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_restriction'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'card/restrictions-changed', where: { cardId: 'c-1', mode: 'set' } },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('card_restriction', {
        cardId: 'c-1',
        mode: 'set',
        kind: 'online',
        note: '疑似线上盗刷',
      }),
    },
  }),
  scenario({
    id: 'P-35',
    family: 'P',
    title: '交易限制解锁：clear 指定 online，不动其它限制',
    turns: ['恢复这张卡的线上支付'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_restriction'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      {
        kind: 'event',
        type: 'card/restrictions-changed',
        where: { cardId: 'c-1', mode: 'clear', restrictions: [] },
      },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('card_restriction', { cardId: 'c-1', mode: 'clear', kind: 'online' }),
    },
  }),
  scenario({
    id: 'P-36',
    family: 'P',
    title: '黄档冻结（可逆止损）：审批但无强验证，状态 normal→frozen',
    turns: ['这张卡疑似被盗刷，先冻结'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_freeze'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      {
        kind: 'event',
        type: 'card/state-changed',
        where: { cardId: 'c-1', reason: 'freeze', from: 'normal', to: 'frozen' },
      },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('card_freeze', { cardId: 'c-1', reason: '怀疑盗刷' }),
    },
  }),
  scenario({
    id: 'P-37',
    family: 'P',
    title: '红档解冻：必须强验证，状态 frozen→normal',
    turns: ['卡找到了，解冻'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_unfreeze'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      {
        kind: 'event',
        type: 'card/state-changed',
        where: { cardId: 'c-1', reason: 'unfreeze', from: 'frozen', to: 'normal' },
      },
    ],
    action: { kind: 'script', steps: writeSteps('card_unfreeze', { cardId: 'c-1' }) },
  }),
  scenario({
    id: 'P-38',
    family: 'P',
    title: '红档额度调整：信用卡授信 5,000→3,000 元（入参元、事件分）',
    turns: ['把我的信用卡额度降到 3000'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['card_limit_set'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      {
        kind: 'event',
        type: 'card/limits-changed',
        where: { cardId: 'c-3', creditLimitCents: 300_000 },
      },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('card_limit_set', {
        cardId: 'c-3',
        creditLimitYuan: 3_000,
        dailyLimitYuan: 3_000,
        monthlyLimitYuan: 3_000,
      }),
    },
  }),

  /* ── 理财后半（P-39、Q-31，GAP-CAP-04/05） ───────────────────────────── */
  scenario({
    id: 'P-39',
    family: 'P',
    title: '红档一键赎回：全额赎回 h-1（市值 508 元 / 508 份）',
    turns: ['把稳盈 90 天全部赎回'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['wealth_redeem'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'wealth/redeemed' },
      // 缺省 amountYuan = 全部市值（50,800 分）；份额按 1 元/份 = 508。
      { kind: 'tool-result', tool: 'wealth_redeem', path: 'amountCents', equals: 50_800 },
      { kind: 'tool-result', tool: 'wealth_redeem', path: 'shares', equals: 508 },
    ],
    action: { kind: 'script', steps: writeSteps('wealth_redeem', { holdingId: 'h-1' }) },
  }),
  scenario({
    id: 'Q-31',
    family: 'Q',
    title: '绿档理财持仓收益：h-1 成本 500 元、市值 508 元、盈亏 8 元',
    turns: ['我买的理财赚了多少'],
    // 绿档只读；Q 族不能声明 approval（validate.ts:70-72）。
    expect: [
      { kind: 'tool-sequence', tools: ['wealth_positions'], mode: 'exact' },
      { kind: 'no-event', type: 'approval/asked' },
      { kind: 'event', type: 'read/wealth-positions' },
      { kind: 'tool-result', tool: 'wealth_positions', path: 'totalProfitCents', equals: 800 },
      { kind: 'tool-result', tool: 'wealth_positions', path: 'holdings.0.holdingId', equals: 'h-1' },
    ],
    action: { kind: 'script', steps: readSteps('wealth_positions', {}) },
  }),

  /* ── 风险测评（Q-32 + P-40，GAP-CAP-03） ─────────────────────────────── */
  scenario({
    id: 'Q-32',
    family: 'Q',
    title: '绿档取风险问卷：只下发不落档（rq-1 为本 boot 第一张卷）',
    turns: ['我要做风险测评'],
    // 取卷是 READ_ONLY_ACTIONS 登记过的只读分支：不签票、不改等级。
    // 这里把 `rq-1` 当撞号探针：若同 boot 前面有人先取过卷，本场景会红而不是假绿。
    expect: [
      { kind: 'tool-sequence', tools: ['risk_assess'], mode: 'exact' },
      { kind: 'no-event', type: 'approval/asked' },
      { kind: 'event', type: 'read/risk-questions', where: { questionnaireId: 'rq-1' } },
      { kind: 'no-event', type: 'risk/assessed' },
    ],
    action: { kind: 'script', steps: readSteps('risk_assess', { action: 'questions' }) },
  }),
  scenario({
    id: 'P-40',
    family: 'P',
    title: 'risk_assess 提交（夹具代答＝演示应答者点选题项，非模型推断选项）',
    turns: ['五题都选中档，提交'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['risk_assess', 'risk_assess'], mode: 'exact' },
      // 提交是黄档：要审批，但不要求强验证。
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'risk/assessed' },
      // 5 题 × middle=3 分 = 15；分数段 ≤16 落 R3（model.ts 的 riskGradeOfScore）。
      { kind: 'tool-result', tool: 'risk_assess', path: 'score', equals: 15 },
      { kind: 'tool-result', tool: 'risk_assess', path: 'to', equals: 'R3' },
    ],
    action: {
      kind: 'script',
      steps: [
        // 必须先取卷、再把题原样交给用户作答：本仓的 submit 只认本实例签发的卷。
        toolCallStep('eval-q', 'risk_assess', { action: 'questions' }),
        toolCallStep('eval-s', 'risk_assess', {
          action: 'submit',
          questionnaireId: 'rq-1',
          answers: [
            { index: 1, key: 'middle' },
            { index: 2, key: 'middle' },
            { index: 3, key: 'middle' },
            { index: 4, key: 'middle' },
            { index: 5, key: 'middle' },
          ],
        }),
        outcomeStep({ tool: 'risk_assess', ok: '已受理。', failed: '未执行：{reason}' }),
      ],
    },
  }),

  /* ── AA（P-41/42/43，GAP-CAP-01） ─────────────────────────────────────── */
  scenario({
    id: 'P-41',
    family: 'P',
    title: 'AA 建组：300 元 3 人均分，每人待收 100 元（aa-new-1 为本 boot 第一组）',
    turns: ['周末聚餐 300 元，我们三个人 AA'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['aa_create'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'aa/created' },
      // 前提要当断言写出来：后两条 collect/decline 引用的就是本实例第一个组。
      { kind: 'tool-result', tool: 'aa_create', path: 'groupId', equals: 'aa-new-1' },
      { kind: 'tool-result', tool: 'aa_create', path: 'totalCents', equals: 30_000 },
      { kind: 'tool-result', tool: 'aa_create', path: 'pendingCents', equals: 30_000 },
      { kind: 'tool-result', tool: 'aa_create', path: 'status', equals: 'collecting' },
      { kind: 'tool-result', tool: 'aa_create', path: 'participants.0.status', equals: 'pending' },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('aa_create', {
        action: 'create',
        title: '周末聚餐',
        totalYuan: 300,
        split: 'equal',
        participants: [{ name: '王建国' }, { name: '李雷' }, { name: '韩梅梅' }],
      }),
    },
  }),
  scenario({
    id: 'P-42',
    family: 'P',
    title: 'AA 模拟代收第一位：本进程记入组织者账户，不是真实到账',
    turns: ['王建国那份先记上'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['aa_create'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      {
        kind: 'event',
        type: 'aa/collected',
        where: { groupId: 'aa-new-1', participantIndex: 0, collectedCents: 10_000 },
      },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('aa_create', {
        action: 'collect',
        groupId: 'aa-new-1',
        participant: '王建国',
      }),
    },
  }),
  scenario({
    id: 'P-43',
    family: 'P',
    title: 'AA 参与人拒绝：状态 pending→declined，钱不动',
    turns: ['李雷说他那份不参加'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['aa_create'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked' },
      { kind: 'no-event', type: 'approval/asked', where: { challenge: 'sms' } },
      {
        kind: 'event',
        type: 'aa/participant-updated',
        where: { groupId: 'aa-new-1', participantIndex: 1, from: 'pending', to: 'declined' },
      },
      { kind: 'no-event', type: 'aa/collected' },
    ],
    action: {
      kind: 'script',
      steps: writeSteps('aa_create', {
        action: 'decline',
        groupId: 'aa-new-1',
        participant: '李雷',
      }),
    },
  }),

  /* ── 密码（P-44、P-48，GAP-CAP-10） ──────────────────────────────────── */
  scenario({
    id: 'P-44',
    family: 'P',
    title: '红档改密发起：审批+强验证签一次性交接票，会话内不改密码',
    turns: ['我要改交易密码'],
    approval: 'allow',
    expect: [
      { kind: 'tool-sequence', tools: ['password_change'], mode: 'exact' },
      { kind: 'event', type: 'approval/asked', where: { challenge: 'sms' } },
      { kind: 'event', type: 'tool/result', where: { name: 'password_change', isError: false } },
      // 例外（§5 第 2 条）：改密这一腿本就不该在会话内完成；同场景另有 approval/asked
      // 与 tool/result 两条会失败的断言。票据与 handoffPath 的字面值**不**落断言。
      { kind: 'no-event', type: 'security/password-changed' },
    ],
    action: { kind: 'script', steps: writeSteps('password_change', { action: 'request' }) },
  }),
  scenario({
    id: 'P-48',
    family: 'P',
    title: '红档改密 + 人工驳回：拒绝且无改密事件',
    turns: ['我要改交易密码'],
    approval: 'reject',
    expect: [
      { kind: 'tool-denied', tool: 'password_change', code: 'approval-rejected' },
      { kind: 'no-event', type: 'security/password-changed' },
    ],
    action: { kind: 'script', steps: writeSteps('password_change', { action: 'request' }) },
  }),

  /* ── 拒绝侧补齐（P-45…P-47，均在 P:reject boot 组） ─────────────────── */
  scenario({
    id: 'P-45',
    family: 'P',
    title: '黄档申请卡 + 人工驳回：拒绝且无发卡事件',
    turns: ['办一张虚拟卡'],
    approval: 'reject',
    expect: [
      { kind: 'tool-denied', tool: 'card_apply', code: 'approval-rejected' },
      { kind: 'no-event', type: 'card/issued' },
    ],
    action: { kind: 'script', steps: writeSteps('card_apply', { type: 'virtual' }) },
  }),
  scenario({
    id: 'P-46',
    family: 'P',
    title: '红档赎回 + 人工驳回：拒绝且无赎回事件',
    turns: ['把稳盈 90 天全部赎回'],
    approval: 'reject',
    expect: [
      { kind: 'tool-denied', tool: 'wealth_redeem', code: 'approval-rejected' },
      { kind: 'no-event', type: 'wealth/redeemed' },
    ],
    action: { kind: 'script', steps: writeSteps('wealth_redeem', { holdingId: 'h-1' }) },
  }),
  scenario({
    id: 'P-47',
    family: 'P',
    title: '红档解冻 + 人工驳回：拒绝且卡状态不变',
    turns: ['卡找到了，解冻'],
    approval: 'reject',
    expect: [
      { kind: 'tool-denied', tool: 'card_unfreeze', code: 'approval-rejected' },
      { kind: 'no-event', type: 'card/state-changed' },
    ],
    action: { kind: 'script', steps: writeSteps('card_unfreeze', { cardId: 'c-1' }) },
  }),

  /* ── 账单异常（Q-33，GAP-CAP-02） ───────────────────────────────────── */
  scenario({
    id: 'Q-33',
    family: 'Q',
    title: '绿档异常交易识别：季度账期首条异常为大额支出',
    turns: ['帮我看看有没有异常交易'],
    // 当前月（2023-11，固定钟）只有 68 元咖啡与 30 元会员两笔，没有异常；
    // 季度窗口含 9 月历史账期（房东 3,003.70 元 = th-2-rent > billLargeCents 200,000 分），
    // 按流水时间升序的第一条异常即 `large`（txnId 一并钉住）。不为了造异常去改种子（C7）。
    expect: [
      { kind: 'tool-sequence', tools: ['bill_analyze'], mode: 'exact' },
      { kind: 'no-event', type: 'approval/asked' },
      { kind: 'tool-result', tool: 'bill_analyze', path: 'period', equals: 'quarter' },
      { kind: 'tool-result', tool: 'bill_analyze', path: 'anomalies.0.kind', equals: 'large' },
      { kind: 'tool-result', tool: 'bill_analyze', path: 'anomalies.0.txnId', equals: 'th-2-rent' },
    ],
    action: { kind: 'script', steps: readSteps('bill_analyze', { period: 'quarter' }) },
  }),
]
