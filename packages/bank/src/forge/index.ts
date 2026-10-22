/**
 * 造数（施工单 07 §4）：seeded 可复现的仿真银行数据集。
 *
 * 三档：
 * - `demo`：演示用的小数据；**预置王建国为白名单收款人**（首笔早于演示），保证 800 元转账
 *   不会触发"新收款人升红"；
 * - `stress`：压测用的大数据（多用户 / 数百笔交易）；
 * - `adversarial`：安全用例素材（几乎触阈值的金额、新收款人、深夜大额、重复扣费订阅）。
 *
 * 随机源来自 `@bah/util` 的 `seededRandom`（与快照夹具同源）：同 seed 同数据，
 * 答辩、回放与"数据速查表"都能逐字复现。种子由调用方记录（施工单 12 的会话元数据）。
 */

import { assertNever, seededRandom } from '@bah/util'

import type {
  Account,
  AccountId,
  BankLimits,
  Bill,
  Card,
  CardId,
  Holding,
  Payee,
  Subscription,
  Transaction,
  TxnCategory,
  TxnChannel,
  User,
  UserId,
  WealthProduct,
} from '../core/model.ts'
import { bankIds } from '../core/model.ts'
import { DAY_MS, monthKey, previousMonth } from '../core/time.ts'

export * from './risk.ts'

/** 造数档位。 */
export type ForgeTier = 'demo' | 'stress' | 'adversarial'

/** 造数参数。 */
export interface ForgeOptions {
  readonly seed: number
  /** 档位（缺省 `demo`）。 */
  readonly tier?: ForgeTier
  /** 生成基准时刻（缺省 `DEMO_NOW`；测试与回放注入固定钟）。 */
  readonly now?: number
}

/** 造数产物：mock 核心的全部初始状态。 */
export interface BankDataset {
  readonly seed: number
  readonly tier: ForgeTier
  /** 生成基准时刻（epoch ms）。 */
  readonly now: number
  readonly users: readonly User[]
  readonly accounts: readonly Account[]
  readonly cards: readonly Card[]
  readonly transactions: readonly Transaction[]
  /** 历史账期快照（当前账期由 `analyzeBill` 从流水实时计算）。 */
  readonly bills: readonly Bill[]
  readonly wealthProducts: readonly WealthProduct[]
  readonly holdings: readonly Holding[]
  readonly subscriptions: readonly Subscription[]
  readonly payees: readonly Payee[]
  readonly limits: BankLimits
}

/** 默认演示基准时刻：2026-10-19 10:00（东八区）。 */
export const DEMO_NOW = Date.UTC(2026, 9, 19, 2, 0, 0)

/** 默认风控阈值（施工单 07 §4.3；部署时可整体替换）。 */
export const DEFAULT_LIMITS: BankLimits = {
  dailyTransferLimitCents: 500_000,
  nightStartHour: 22,
  nightEndHour: 6,
  nightLargeCents: 100_000,
  velocityWindowMs: 10 * 60 * 1000,
  velocityMaxCount: 5,
  billLargeCents: 200_000,
}

/**
 * 生成一份仿真数据集。
 *
 * 同 `seed` + 同 `tier` + 同 `now` → 逐字段相同（T-BANK-001）。
 */
export function buildBankDataset(options: ForgeOptions): BankDataset {
  const tier = options.tier ?? 'demo'
  const now = options.now ?? DEMO_NOW
  const random = seededRandom(options.seed)

  switch (tier) {
    case 'demo':
      return { seed: options.seed, tier, now, limits: DEFAULT_LIMITS, ...buildDemo(now) }
    case 'stress':
      return { seed: options.seed, tier, now, limits: DEFAULT_LIMITS, ...buildStress(now, random) }
    case 'adversarial':
      return { seed: options.seed, tier, now, limits: DEFAULT_LIMITS, ...buildAdversarial(now) }
    default:
      return assertNever(tier, 'forge-tier')
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * demo 档
 * ──────────────────────────────────────────────────────────────────────────── */

function buildDemo(now: number): DatasetParts {
  const user: User = {
    id: bankIds.user('u-1'),
    name: '王建国',
    phone: '13800001111',
    riskGrade: 'R2',
    verified: true,
    strongAuth: 'sms',
  }

  const current = bankIds.account('a-1')
  const fixed = bankIds.account('a-2')
  const locked = bankIds.account('a-3')

  const accounts: Account[] = [
    account(current, user.id, '6222 0202 0000 1234', 'current', 1_234_567, 1_234_567),
    account(fixed, user.id, '6222 0202 0000 5678', 'fixed', 5_000_000, 0),
    account(locked, user.id, '6222 0202 0000 9012', 'locked', 88_888, 88_888),
  ]

  const cards: Card[] = [
    card(bankIds.card('c-1'), current, '1234', 'physical', 500_000, 2_000_000),
    card(bankIds.card('c-2'), current, '5678', 'virtual', 200_000, 800_000),
  ]

  // 王建国：已绑定白名单，首笔 30 天前（演示幕 3 的 800 元转账靠它走黄级流程）
  const payee: Payee = {
    id: bankIds.payee('p-1'),
    userId: user.id,
    name: '王建国',
    phone: '13900002222',
    binding: 'whitelist',
    firstSeenAt: now - 30 * DAY_MS,
  }

  const transactions: Transaction[] = [
    txn('t-1', current, now - 45 * DAY_MS, 1_500_000, 'in', '工资代发', 'salary', 'app'),
    txn('t-2', current, now - 40 * DAY_MS, 32_800, 'out', '盒马鲜生', 'consumption', 'app'),
    txn('t-3', current, now - 35 * DAY_MS, 12_500, 'out', '地铁出行', 'consumption', 'app'),
    txn('t-4', current, now - 30 * DAY_MS, 268_000, 'out', '国美电器', 'consumption', 'web'),
    txn('t-5', current, now - 20 * DAY_MS, 80_000, 'out', '王建国', 'transfer', 'app'),
    txn('t-6', current, now - 15 * DAY_MS, 45_600, 'out', '海底捞', 'consumption', 'app'),
    txn('t-7', current, now - 10 * DAY_MS, 3_000, 'out', '视频会员', 'subscription', 'app'),
    txn('t-8', current, now - 5 * DAY_MS, 6_800, 'out', '瑞幸咖啡', 'consumption', 'app'),
  ]

  return {
    users: [user],
    accounts,
    cards,
    transactions,
    bills: [buildBill(previousMonth(monthKey(now)), transactions)],
    wealthProducts: defaultProducts(),
    holdings: [
      {
        id: bankIds.holding('h-1'),
        userId: user.id,
        productId: bankIds.product('w-1'),
        shares: 500,
        costCents: 50_000,
        marketValueCents: 50_800,
        profitCents: 800,
      },
    ],
    subscriptions: [
      {
        id: bankIds.subscription('s-1'),
        userId: user.id,
        merchant: '视频会员',
        cycle: 'monthly',
        nextChargeAt: now + 5 * DAY_MS,
        amountCents: 3_000,
        status: 'active',
      },
    ],
    payees: [payee],
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * stress 档
 * ──────────────────────────────────────────────────────────────────────────── */

function buildStress(now: number, random: () => number): DatasetParts {
  const names = ['张伟', '王芳', '李强']
  const users: User[] = names.map((name, index) => ({
    id: bankIds.user(`u-${index + 1}`),
    name,
    phone: `1380000${String(index + 1).padStart(4, '0')}`,
    riskGrade: (['R1', 'R2', 'R3'] as const)[index] ?? 'R2',
    verified: true,
    strongAuth: 'sms',
  }))

  const accounts: Account[] = []
  const cards: Card[] = []
  const payees: Payee[] = []
  const transactions: Transaction[] = []
  const subscriptions: Subscription[] = []

  for (const [index, user] of users.entries()) {
    const currentId = bankIds.account(`a-${index * 2 + 1}`)
    const fixedId = bankIds.account(`a-${index * 2 + 2}`)
    accounts.push(
      account(
        currentId,
        user.id,
        `6222 0202 0000 ${String(index + 1).padStart(4, '0')}`,
        'current',
        800_000 + index * 120_000,
        800_000 + index * 120_000,
      ),
      account(fixedId, user.id, `6222 0202 0001 ${String(index + 1).padStart(4, '0')}`, 'fixed', 3_000_000, 0),
    )
    cards.push(card(bankIds.card(`c-${index + 1}`), currentId, String(4000 + index + 1), 'physical', 1_000_000, 4_000_000))
    for (let p = 0; p < 2; p += 1) {
      payees.push({
        id: bankIds.payee(`p-${index * 2 + p + 1}`),
        userId: user.id,
        name: `${names[(index + p + 1) % names.length] ?? '收款人'}`,
        binding: 'whitelist',
        firstSeenAt: now - 60 * DAY_MS,
      })
    }
    subscriptions.push({
      id: bankIds.subscription(`s-${index + 1}`),
      userId: user.id,
      merchant: '云存储会员',
      cycle: 'monthly',
      nextChargeAt: now + 10 * DAY_MS,
      amountCents: 1_800,
      status: 'active',
    })
    // 每个用户 100 笔流水：时间、金额、分类、渠道全部由 seed 决定
    for (let n = 0; n < 100; n += 1) {
      const category = pick(random, ['transfer', 'consumption', 'salary', 'subscription'] as const)
      const at = now - randomInt(random, 0, 180) * DAY_MS - randomInt(random, 0, DAY_MS - 1)
      transactions.push(
        txn(
          `t-${index + 1}-${n + 1}`,
          currentId,
          at,
          randomInt(random, 1_000, 500_000),
          category === 'salary' ? 'in' : 'out',
          pick(random, ['商户', '代发', '转账'] as const),
          category,
          pick(random, ['app', 'web', 'counter', 'atm'] as const),
        ),
      )
    }
  }

  return {
    users,
    accounts,
    cards,
    transactions,
    bills: [
      buildBill(previousMonth(monthKey(now)), transactions),
      buildBill(monthKey(now - 31 * DAY_MS), transactions),
    ],
    wealthProducts: defaultProducts(),
    holdings: [],
    subscriptions,
    payees,
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * adversarial 档
 * ──────────────────────────────────────────────────────────────────────────── */

function buildAdversarial(now: number): DatasetParts {
  const user: User = {
    id: bankIds.user('u-1'),
    name: '李雷',
    phone: '13800003333',
    riskGrade: 'R3',
    verified: true,
    strongAuth: 'face',
  }
  const accountId = bankIds.account('a-1')
  const accounts: Account[] = [account(accountId, user.id, '6222 0202 0000 3333', 'current', 2_000_000, 2_000_000)]
  const cards: Card[] = [card(bankIds.card('c-1'), accountId, '3333', 'physical', 500_000, 2_000_000)]

  const payee: Payee = {
    id: bankIds.payee('p-1'),
    userId: user.id,
    name: '韩梅梅',
    phone: '13700005555',
    // 刻意构造：登记过但仍是新收款人（升红素材）
    binding: 'new',
    firstSeenAt: now - 1_000,
  }

  // 对抗素材：
  // 1) 490,000 / 500,000：几乎触发日限额（差 10,000 分）
  // 2) 夜间 120,000：夜间大额（analyzeBill 的 late-night 素材）
  // 3) 10 分钟窗口内 5 笔：短时高频（velocityWindowMs = 10min、velocityMaxCount = 5）
  // 4) 订阅同额重复扣费两次：账单"重复扣费"异常
  const transactions: Transaction[] = [
    txn('t-1', accountId, now - 2 * 60 * 60 * 1000, 490_000, 'out', '租房', 'transfer', 'app'),
    txn('t-2', accountId, now - 10 * 60 * 60 * 1000, 120_000, 'out', '夜间商户', 'consumption', 'app'),
    txn('t-3', accountId, now - 9 * 60 * 1000, 10_000, 'out', '高频 1', 'transfer', 'app'),
    txn('t-4', accountId, now - 8 * 60 * 1000, 10_000, 'out', '高频 2', 'transfer', 'app'),
    txn('t-5', accountId, now - 7 * 60 * 1000, 10_000, 'out', '高频 3', 'transfer', 'app'),
    txn('t-6', accountId, now - 6 * 60 * 1000, 10_000, 'out', '高频 4', 'transfer', 'app'),
    txn('t-7', accountId, now - 5 * 60 * 1000, 10_000, 'out', '高频 5', 'transfer', 'app'),
    txn('t-8', accountId, now - 3 * DAY_MS, 3_000, 'out', '云音乐', 'subscription', 'app'),
    txn('t-9', accountId, now - 3 * DAY_MS + 60_000, 3_000, 'out', '云音乐', 'subscription', 'app'),
  ]

  return {
    users: [user],
    accounts,
    cards,
    transactions,
    bills: [buildBill(previousMonth(monthKey(now)), transactions)],
    wealthProducts: defaultProducts(),
    holdings: [],
    subscriptions: [
      {
        id: bankIds.subscription('s-1'),
        userId: user.id,
        merchant: '云音乐',
        cycle: 'monthly',
        nextChargeAt: now + 3 * DAY_MS,
        amountCents: 3_000,
        status: 'active',
      },
    ],
    payees: [payee],
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 共用零件
 * ──────────────────────────────────────────────────────────────────────────── */

interface DatasetParts {
  readonly users: readonly User[]
  readonly accounts: readonly Account[]
  readonly cards: readonly Card[]
  readonly transactions: readonly Transaction[]
  readonly bills: readonly Bill[]
  readonly wealthProducts: readonly WealthProduct[]
  readonly holdings: readonly Holding[]
  readonly subscriptions: readonly Subscription[]
  readonly payees: readonly Payee[]
}

function account(
  id: AccountId,
  userId: UserId,
  number: string,
  type: Account['type'],
  balanceCents: number,
  availableCents: number,
): Account {
  return { id, userId, number, type, balanceCents, availableCents, status: 'active' }
}

function card(
  id: CardId,
  accountId: AccountId,
  tail: string,
  type: Card['type'],
  dailyLimitCents: number,
  monthlyLimitCents: number,
): Card {
  return { id, accountId, tail, type, status: 'normal', dailyLimitCents, monthlyLimitCents }
}

function txn(
  id: string,
  accountId: AccountId,
  at: number,
  amountCents: number,
  direction: Transaction['direction'],
  name: string,
  category: TxnCategory,
  channel: TxnChannel,
): Transaction {
  return {
    id: bankIds.txn(id),
    accountId,
    at,
    amountCents,
    direction,
    counterparty: { name },
    category,
    channel,
    status: 'success',
  }
}

function defaultProducts(): readonly WealthProduct[] {
  return [
    {
      id: bankIds.product('w-1'),
      name: '稳盈 90 天',
      kind: 'fixed',
      termDays: 90,
      expectedYieldPct: 2.8,
      riskGrade: 'R1',
      minAmountCents: 10_000,
    },
    {
      id: bankIds.product('w-2'),
      name: '稳健债券 180 天',
      kind: 'fixed',
      termDays: 180,
      expectedYieldPct: 3.6,
      riskGrade: 'R2',
      minAmountCents: 50_000,
    },
    {
      id: bankIds.product('w-3'),
      name: '混合优选一年',
      kind: 'fund',
      termDays: 365,
      expectedYieldPct: 5.2,
      riskGrade: 'R3',
      minAmountCents: 100_000,
    },
  ]
}

/** 汇总某一账期的历史账单快照（施工单 07 §1 的 Bill 实体）。 */
function buildBill(period: string, transactions: readonly Transaction[]): Bill {
  const byCategory: Partial<Record<TxnCategory, number>> = {}
  let totalInCents = 0
  let totalOutCents = 0
  for (const transaction of transactions) {
    if (monthKey(transaction.at) !== period || transaction.status !== 'success') continue
    if (transaction.direction === 'in') {
      totalInCents += transaction.amountCents
    } else {
      totalOutCents += transaction.amountCents
      byCategory[transaction.category] = (byCategory[transaction.category] ?? 0) + transaction.amountCents
    }
  }
  return { period, totalInCents, totalOutCents, byCategory, anomalies: [] }
}

/** 闭区间随机整数。 */
function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

/** 从固定候选中取一个（PRNG 决定）。 */
function pick<T>(random: () => number, items: readonly T[]): T {
  const value = items[Math.floor(random() * items.length)]
  if (value === undefined) {
    throw new Error('bank: pick 的候选集不能为空')
  }
  return value
}
