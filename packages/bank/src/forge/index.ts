/**
 * 造数（施工单 07 §4）：seeded 可复现的仿真银行数据集。
 *
 * 四档：
 * - `demo`：演示用的小数据；**预置王建国为白名单收款人**（首笔早于演示），保证 800 元转账
 *   不会触发"新收款人升红"；
 * - `stress`：压测用的大数据（多用户 / 数百笔交易）；
 * - `adversarial`：安全用例素材（几乎触阈值的金额、新收款人、深夜大额、重复扣费订阅）；
 * - `recurring`：场景 5 的订阅/代扣数据集（6 个月周期序列、脏商户名、断供失败样本）。
 *   固定脚本（不用随机源），`demo` 档因此保持字节不变。
 *
 * 随机源来自 `@bah/util` 的 `seededRandom`（与快照夹具同源）：同 seed 同数据，
 * 答辩、回放与"数据速查表"都能逐字复现。种子由调用方记录（施工单 12 的会话元数据）。
 */

import { assertNever, seededRandom, sha256Hex } from '@bah/util'

import type {
  Account,
  AccountId,
  BankLimits,
  Bill,
  CancelRequest,
  Card,
  CardId,
  Holding,
  MerchantAuthorization,
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
export type ForgeTier = 'demo' | 'stress' | 'adversarial' | 'recurring'

/** 造数参数。 */
export interface ForgeOptions {
  readonly seed: number
  /** 档位（缺省 `demo`）。 */
  readonly tier?: ForgeTier
  /** 生成基准时刻（缺省 `DEMO_NOW`；测试与回放注入固定钟）。 */
  readonly now?: number
  /**
   * 租户盐（01 TA-14；缺省 0 = 无偏移）。
   *
   * 只有 `stress` / `adversarial` 档用随机源，所以**盐只对这两档生效**；
   * `demo` 档是固定脚本（王建国 + 预置收款人 + 近 12 个月纯算术历史），盐对它没有作用。
   * 快照不读流水，只依赖静态字段（用户名 / 账户尾号 / 余额）；流水由
   * `mock.test.ts` 的自洽式断言与账单测试兜住（见账单场景收口 01 · T-05）。
   */
  readonly tenantSalt?: number
}

/** 造数产物：mock 核心的全部初始状态。 */
export interface BankDataset {
  readonly seed: number
  readonly tier: ForgeTier
  /** 生成基准时刻（epoch ms）。 */
  readonly now: number
  /** 本数据集用的租户盐（0 = demo / 未分租户）。 */
  readonly tenantSalt: number
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
  /** 代扣协议（场景 5；demo 档缺省）。 */
  readonly authorizations?: readonly MerchantAuthorization[]
  /** 取消请求（场景 5；demo 档缺省）。 */
  readonly cancelRequests?: readonly CancelRequest[]
  readonly limits: BankLimits
}

/** 默认演示基准时刻：2026-10-19 10:00（东八区）。 */
export const DEMO_NOW = Date.UTC(2026, 9, 19, 2, 0, 0)

/**
 * 默认风控阈值（施工单 07 §4.3；部署时可整体替换）。
 *
 * 日累计转账限额与赛题分级线的示例值对齐：**1000 元（100,000 分）**。
 * 旧值 5000 元（500,000 分）与 `bank:tools.dailyTransferLimit` 的默认 1000 元并存，
 * 造成「种子数据说 5000、生效口径说 1000」的双口径，2026-10-27 对齐。
 */
export const DEFAULT_LIMITS: BankLimits = {
  dailyTransferLimitCents: 100_000,
  nightStartHour: 22,
  nightEndHour: 6,
  nightLargeCents: 100_000,
  velocityWindowMs: 10 * 60 * 1000,
  velocityMaxCount: 5,
  billLargeCents: 200_000,
}

/**
 * 租户盐（01 TA-14）：**加法 + 大质数乘子**，不用异或。
 *
 * 为什么不是 `seed ^ salt`：异或会把 seed 7 变成 `7 ^ salt`，盐相邻时随机序列高度相关
 * （同一种子的低比特差异），造出来的"不同租户"数据会长得很像。
 *
 * 为什么 `& 0x0fffff`（20 位）：`seededRandom` 内部是 32 位运算，而 `salt * 7919` 会放大到
 * 8e9 量级；20 位保证 `|Δsalt| * 7919 < 2^32`（不会因取模折回而让两个租户撞同一个序列）。
 *
 * `demo` 零偏移是**硬编码**的：7 个快照与 profiles 下各 patch.yml 的静态画像都依赖
 * demo 档数据逐字节不变。
 */
export function tenantSaltOf(tenantId: string): number {
  if (tenantId === 'demo') return 0
  return parseInt(sha256Hex(`tenant:${tenantId}`).slice(0, 6), 16) & 0x0fffff
}

/**
 * 生成一份仿真数据集。
 *
 * 同 `seed` + 同 `tier` + 同 `now` + 同 `tenantSalt` → 逐字段相同（T-BANK-001）。
 */
export function buildBankDataset(options: ForgeOptions): BankDataset {
  const tier = options.tier ?? 'demo'
  const now = options.now ?? DEMO_NOW
  const tenantSalt = options.tenantSalt ?? 0
  // 盐只影响随机源入口：`buildDemo` / `buildStress` / `buildAdversarial` 内部逻辑不动
  const random = seededRandom(options.seed + tenantSalt * 7919)
  const header = { seed: options.seed, tier, now, tenantSalt, limits: DEFAULT_LIMITS }

  switch (tier) {
    case 'demo':
      return { ...header, ...buildDemo(now) }
    case 'stress':
      return { ...header, ...buildStress(now, random) }
    case 'adversarial':
      return { ...header, ...buildAdversarial(now) }
    case 'recurring':
      return { ...header, ...buildRecurring(now) }
    default:
      return assertNever(tier, 'forge-tier')
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * demo 档
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * demo 档的近 12 个月历史（账单场景收口 01 · T-05）。
 *
 * 区间：`now` 所在月 **-11 … -2**。不进入当前月与上月——那两个月由 8 笔固定脚本
 * 决定，`mock.test.ts` 的月度断言、`queries.test.ts` 的咖啡 68 元、Q-04 的
 * `totalOutCents=9_800` 都钉在上面。
 *
 * 每月 6 笔固定角色；金额按月份序号做**纯算术**微扰，不引入 `seededRandom`：
 * demo 档的契约是"不用随机源"（见文件头），用 PRNG 等于破约。
 */
function buildDemoHistory(now: number): Transaction[] {
  const current = bankIds.account('a-1')
  const thisMonth = monthKey(now)
  const history: Transaction[] = []

  for (let offset = 11; offset >= 2; offset -= 1) {
    const period = monthsBefore(thisMonth, offset)
    const i = 12 - offset
    const at = (day: number): number =>
      Date.parse(`${period}-${String(day).padStart(2, '0')}T02:00:00.000Z`)

    history.push(
      txn(`th-${offset}-salary`, current, at(3), 1_500_000 + ((i * 37) % 900), 'in', '工资代发', 'salary', 'app'),
      txn(`th-${offset}-rent`, current, at(6), 300_000 + ((i * 37) % 900), 'out', '房东', 'transfer', 'app'),
      txn(`th-${offset}-coffee`, current, at(8), 6_800 + ((i * 37) % 900), 'out', '瑞幸咖啡', 'consumption', 'app'),
      txn(`th-${offset}-takeout`, current, at(12), 4_200 + ((i * 53) % 700), 'out', '美团外卖', 'consumption', 'app'),
      txn(`th-${offset}-metro`, current, at(15), 1_250 + ((i * 17) % 300), 'out', '地铁出行', 'consumption', 'app'),
      txn(`th-${offset}-membership`, current, at(18), 3_000 + ((i * 11) % 200), 'out', '视频会员', 'subscription', 'app'),
    )
  }

  return history
}

/** `YYYY-MM` 往前数 `count` 个账期（不引 `tools/time.ts`：forge 不向上依赖工具层）。 */
function monthsBefore(period: string, count: number): string {
  let result = period
  for (let index = 0; index < count; index += 1) result = previousMonth(result)
  return result
}

function buildDemo(now: number): DatasetParts {
  const user: User = {
    id: bankIds.user('u-1'),
    // 主体姓名必须与 profiles/*/patch.yml 的静态画像一致（张三）：
    // 槽位接上权威姓名后，两处不一致会直接触发 `slots-user-mismatch`。
    name: '张三',
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
    card(bankIds.card('c-1'), current, '1234', 'physical', 100_000, 2_000_000),
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

  // 生日案例（04 单）的两个商户收款人：常往商户，登记早已超过 30 天。
  // 刻意用 `whitelist`：升红规则本身不动——"新收款人升红"是对的，
  // 靠改规则让它不红才是造假；这里只是让演示数据具备"常往商户"的合理历史。
  const flowerShop: Payee = {
    id: bankIds.payee('p-2'),
    userId: user.id,
    name: '馨香花艺',
    phone: '13900004444',
    binding: 'whitelist',
    firstSeenAt: now - 60 * DAY_MS,
  }
  const cakeShop: Payee = {
    id: bankIds.payee('p-3'),
    userId: user.id,
    name: '甜心蛋糕坊',
    phone: '13900006666',
    binding: 'whitelist',
    firstSeenAt: now - 60 * DAY_MS,
  }

  const transactions: Transaction[] = [
    // 近 12 个月的账单历史（T-05）。当前月与上月**绝不进入**：
    // 那两个月由下面 8 笔固定脚本决定，`queries.test` / `mock.test` 与
    // Q-04 的月度断言都钉在上面。
    ...buildDemoHistory(now),
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
    payees: [payee, flowerShop, cakeShop],
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
  const cards: Card[] = [card(bankIds.card('c-1'), accountId, '3333', 'physical', 100_000, 2_000_000)]

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
  // 1) 99,000 / 100,000：几乎触发日限额（差 1,000 分）
  // 2) 夜间 100,000：夜间大额（阈值 nightLargeCents = 100,000 分）
  // 3) 10 分钟窗口内 5 笔：短时高频（velocityWindowMs = 10min、velocityMaxCount = 5）
  // 4) 订阅同额重复扣费两次：账单"重复扣费"异常
  // 5) 装修 250,000：账单"大额支出"异常（阈值 billLargeCents = 200,000 分）
  const transactions: Transaction[] = [
    txn('t-1', accountId, now - 2 * 60 * 60 * 1000, 99_000, 'out', '租房', 'transfer', 'app'),
    txn('t-2', accountId, now - 10 * 60 * 60 * 1000, 100_000, 'out', '夜间商户', 'consumption', 'app'),
    txn('t-3', accountId, now - 9 * 60 * 1000, 10_000, 'out', '高频 1', 'transfer', 'app'),
    txn('t-4', accountId, now - 8 * 60 * 1000, 10_000, 'out', '高频 2', 'transfer', 'app'),
    txn('t-5', accountId, now - 7 * 60 * 1000, 10_000, 'out', '高频 3', 'transfer', 'app'),
    txn('t-6', accountId, now - 6 * 60 * 1000, 10_000, 'out', '高频 4', 'transfer', 'app'),
    txn('t-7', accountId, now - 5 * 60 * 1000, 10_000, 'out', '高频 5', 'transfer', 'app'),
    txn('t-8', accountId, now - 3 * DAY_MS, 3_000, 'out', '云音乐', 'subscription', 'app'),
    txn('t-9', accountId, now - 3 * DAY_MS + 60_000, 3_000, 'out', '云音乐', 'subscription', 'app'),
    txn('t-10', accountId, now - 5 * DAY_MS, 250_000, 'out', '装修', 'consumption', 'app'),
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
 * recurring 档（场景 5：订阅 / 代扣）
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 订阅 / 代扣数据集：11 条周期序列（8 订阅 + 2 账单 + 1 分期）。
 *
 * 固定脚本（不用随机源）：租户盐对它零作用，与 `demo` 同构；`demo` 档保持字节不变。
 * 脏商户名、重复扣款、预置 revoked 后仍扣款，都是演示要用的对照样本。
 */
function buildRecurring(now: number): DatasetParts {
  const user: User = {
    id: bankIds.user('u-1'),
    // 与 profiles/subscription/patch.yml 的静态画像一致（张三）
    name: '张三',
    phone: '13800001111',
    riskGrade: 'R2',
    verified: true,
    strongAuth: 'sms',
  }
  const current = bankIds.account('a-1')
  const savings = bankIds.account('a-2')
  const accounts: Account[] = [
    account(current, user.id, '6222 0202 0000 1234', 'current', 2_000_000, 2_000_000),
    account(savings, user.id, '6222 0202 0000 5678', 'fixed', 8_000_000, 0),
  ]
  const cards: Card[] = [card(bankIds.card('c-1'), current, '1234', 'physical', 100_000, 2_000_000)]

  const transactions: Transaction[] = []
  let sequence = 0
  const charge = (
    name: string,
    at: number,
    amountCents: number,
    category: TxnCategory = 'subscription',
  ): void => {
    sequence += 1
    transactions.push(txn(`t-r-${sequence}`, current, at, amountCents, 'out', name, category, 'app'))
  }
  const monthly = (
    name: string,
    amounts: readonly number[],
    options: { category?: TxnCategory; names?: (index: number) => string } = {},
  ): void => {
    for (const [index, amount] of amounts.entries()) {
      const at = now - (amounts.length - 1 - index) * 30 * DAY_MS
      charge(options.names?.(index) ?? name, at, amount, options.category ?? 'subscription')
    }
  }

  // 订阅 8 个（视频：第 4 期涨价；云音乐仅 3 期 → 中置信；云存储标 idle）
  monthly('视频会员', [3000, 3000, 3000, 3500, 3500, 3500], {
    names: (index) => (index < 3 ? 'STM*VIDEO' : '视频会员'),
  })
  charge('支付宝-云音乐', now - 61 * DAY_MS, 1200)
  charge('支付宝-云音乐', now - 31 * DAY_MS, 1200)
  charge('支付宝-云音乐', now - DAY_MS, 1200)
  // 同额同日重复扣款（演示 duplicate）
  charge('云音乐', now, 1200)
  monthly('财付通-云存储', [1800, 1800, 1800, 1800, 1800, 1800, 1800])
  monthly('财付通-某某健身(朝阳店)', [19_900, 19_900, 19_900, 19_900, 19_900, 19_900])
  for (let index = 0; index < 24; index += 1) {
    charge('新闻会员', now - (23 - index) * 7 * DAY_MS, 600)
  }
  // 季度扣款：最老一笔放在 -178 天（不是恰好 -180），否则进程启动几十秒后
  // 滑动窗口就把第一期甩出去，演示变成「开机越久越少一条」
  for (let index = 0; index < 3; index += 1) {
    charge('网盘超级会员', now - (2 - index) * 89 * DAY_MS, 4500)
  }
  monthly('阅读包月', [900, 900, 900, 900, 900, 900])
  monthly('XX软件订阅', [6800, 6800, 6800, 6800])

  // 账单 2 个（房租进账单不进订阅清单；水电金额波动 → low）
  monthly('房租-王房东', [450_000, 450_000, 450_000, 450_000, 450_000, 450_000], {
    category: 'consumption',
  })
  monthly('国网电力', [15_500, 20_500, 16_000, 20_000, 15_200, 20_700], {
    category: 'consumption',
  })

  // 分期 1 个：12 期递减（899 → 800），窗口内可见 7 期
  for (let index = 0; index < 12; index += 1) {
    charge('XX商城分期', now - (11 - index) * 30 * DAY_MS, 89_900 - index * 900, 'consumption')
  }

  // 非周期消费（不可成 series 的对照样本）
  charge('盒马鲜生', now - 12 * DAY_MS, 32_800, 'consumption')
  charge('海底捞', now - 22 * DAY_MS, 45_600, 'consumption')
  charge('地铁出行', now - 8 * DAY_MS, 12_500, 'consumption')
  sequence += 1
  transactions.push(txn(`t-r-${sequence}`, current, now - 40 * DAY_MS, 1_500_000, 'in', '工资代发', 'salary', 'app'))

  const subscriptions: Subscription[] = [
    {
      id: bankIds.subscription('s-video'),
      userId: user.id,
      merchant: '视频会员',
      merchantKey: '视频会员',
      cycle: 'monthly',
      nextChargeAt: now + 5 * DAY_MS,
      amountCents: 3500,
      status: 'active',
      // 合约期内退订是硬拦（演示第⑤步）；到期即断需要显式确认
      contractEndAt: now + 90 * DAY_MS,
      authorizationId: bankIds.authorization('auth-video'),
    },
    {
      id: bankIds.subscription('s-music'),
      userId: user.id,
      merchant: '支付宝-云音乐',
      merchantKey: '云音乐',
      cycle: 'monthly',
      nextChargeAt: now + 9 * DAY_MS,
      amountCents: 1200,
      status: 'active',
      authorizationId: bankIds.authorization('auth-music'),
    },
    {
      id: bankIds.subscription('s-storage'),
      userId: user.id,
      merchant: '财付通-云存储',
      merchantKey: '云存储',
      cycle: 'monthly',
      nextChargeAt: now + 12 * DAY_MS,
      amountCents: 1800,
      status: 'active',
      note: 'idle',
      authorizationId: bankIds.authorization('auth-storage'),
    },
    {
      id: bankIds.subscription('s-gym'),
      userId: user.id,
      merchant: '财付通-某某健身(朝阳店)',
      merchantKey: '某某健身',
      cycle: 'monthly',
      nextChargeAt: now - 10 * DAY_MS,
      pauseUntil: now - 10 * DAY_MS,
      amountCents: 19_900,
      status: 'paused',
      contractEndAt: now + 90 * DAY_MS,
      authorizationId: bankIds.authorization('auth-gym'),
    },
    {
      id: bankIds.subscription('s-news'),
      userId: user.id,
      merchant: '新闻会员',
      merchantKey: '新闻会员',
      cycle: 'weekly',
      nextChargeAt: now + 3 * DAY_MS,
      amountCents: 600,
      status: 'active',
      authorizationId: bankIds.authorization('auth-news'),
    },
    {
      id: bankIds.subscription('s-netdisk'),
      userId: user.id,
      merchant: '网盘超级会员',
      merchantKey: '网盘超级会员',
      cycle: 'quarterly',
      nextChargeAt: now + 30 * DAY_MS,
      amountCents: 4500,
      status: 'active',
      authorizationId: bankIds.authorization('auth-netdisk'),
    },
    {
      id: bankIds.subscription('s-reading'),
      userId: user.id,
      merchant: '阅读包月',
      merchantKey: '阅读包月',
      cycle: 'monthly',
      nextChargeAt: now + 6 * DAY_MS,
      amountCents: 900,
      status: 'active',
      authorizationId: bankIds.authorization('auth-reading'),
    },
    {
      id: bankIds.subscription('s-software'),
      userId: user.id,
      merchant: 'XX软件订阅',
      merchantKey: 'xx软件订阅',
      cycle: 'monthly',
      nextChargeAt: now + 15 * DAY_MS,
      amountCents: 6800,
      status: 'active',
      authorizationId: bankIds.authorization('auth-software'),
    },
  ]

  const authorizations: MerchantAuthorization[] = subscriptions.map((subscription, index) => ({
    id: subscription.authorizationId ?? bankIds.authorization(`auth-${index + 1}`),
    userId: user.id,
    merchant: subscription.merchant,
    merchantKey: subscription.merchantKey ?? subscription.merchant,
    agreementNo: `AG-2026-${String(index + 1).padStart(4, '0')}`,
    accountId: current,
    // 健身房：协议已关，但之后仍有一笔扣款（断供失败样本）
    status: subscription.id === bankIds.subscription('s-gym') ? 'revoked' : 'active',
    signedAt: now - 365 * DAY_MS,
    ...(subscription.id === bankIds.subscription('s-gym') ? { revokedAt: now - 10 * DAY_MS } : {}),
  }))

  return {
    users: [user],
    accounts,
    cards,
    transactions,
    bills: [buildBill(previousMonth(monthKey(now)), transactions)],
    wealthProducts: defaultProducts(),
    holdings: [],
    subscriptions,
    authorizations,
    payees: [],
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
  readonly authorizations?: readonly MerchantAuthorization[]
  readonly cancelRequests?: readonly CancelRequest[]
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
    // R4/R5 是适当性演示的刚需：客户 C2 买 R4 必须被拦。产品数量不是目标，
    // "每个风险等级至少一只"才是（见 02 裁决 §6）。
    {
      id: bankIds.product('w-4'),
      name: '进取优选 365 天',
      kind: 'fund',
      termDays: 365,
      expectedYieldPct: 6.8,
      riskGrade: 'R4',
      minAmountCents: 100_000,
    },
    {
      id: bankIds.product('w-5'),
      name: '量化增强 720 天',
      kind: 'fund',
      termDays: 720,
      // 不取 9.9：对抗集 H-08 的编造值就是 9.9%，产品库里出现同值会把「编造」判成「有据」。
      expectedYieldPct: 8.8,
      riskGrade: 'R5',
      minAmountCents: 200_000,
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

// 商户域（跨场景主动能力 G4）：mock 商户种子 + 搜索 + 下单（资金腿仍走 transfer_create）
export * from './merchants.ts'
