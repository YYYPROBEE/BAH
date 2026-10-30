/**
 * 银行实体槽位读取适配器（实体槽位的唯一数据源）。
 *
 * 它只做"读 + 选 + 格式化 + 脱敏"，不做 prompt 排版（排版在 runtime），
 * 也不做权限判断（身份由 `SessionIdentityStore` 提供；未绑定就不读）。
 *
 * 五条纪律：
 * 1. **快照不是权威**：这里产出的是展示字符串，金额结论仍必须引用工具结果；
 * 2. **不放自由文本**：只有枚举文案、`formatYuan` 金额、`formatCnMinute` 时刻、脱敏尾号、
 *    净化后的姓名；收款人/备注/渠道一律不进槽位。订阅商户名是唯一例外：只以
 *    `sanitizeMerchantForPrompt` 净化后的单行进入【即将扣款】（仍需过"非指令"声明）；
 * 3. **失败是值**：超时/读失败/熔断/取消都返回 `status` + `code`，**绝不 throw 业务错误**
 *    （异常会把核心错误原文带进 `assistant/attempt.reason`，那是 PII 落盘点）；
 * 4. **任一读失败不返回半张图**：模型会把"只有账户没有流水"误读成"最近没有交易"；
 * 5. **确定性**：时钟注入、固定 +8、显式排序、不用 locale API。
 *
 * 依赖方向：本文件**不 import `@bah/runtime`**（那只是 bank 的 devDependency，
 * `verify-no-dev-dep-in-src` 会判红）。这里定义结构等价的本地类型，由 host 赋值时
 * 做编译期结构校验（`const source: RuntimeContextSource = createBankContextSource(...)`）；
 * 字段漂移会直接 `typecheck` 红。
 */

import type { SessionId } from '@bah/core'

import { bankIds, formatYuan, PAGE_LIMIT_MAX } from '../core/model.ts'
import { DAY_MS, formatCnMinute } from '../core/time.ts'
import {
  ACCOUNT_STATUS_LABEL,
  ACCOUNT_TYPE_LABEL,
  CATEGORY_LABEL,
  CYCLE_LABEL,
} from '../tools/presenters.ts'
import { sanitizeMerchantForPrompt } from '../tools/subscriptions.ts'

import type { Account, Transaction, TxnStatus, UserId } from '../core/model.ts'
import type { BankCoreProvider, UpcomingCharge } from '../core/provider.ts'

/* ────────────────────────────────────────────────────────────────────────────
 * 1. 配置（host 校验边界；这里只给默认值与使用）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 槽位预算与熔断参数（`bank:tools.contextSlots` 校验后传入）。 */
export interface ContextSlotSettings {
  /** 最多展示账户数（1..10）。 */
  readonly accounts: number
  /** 最多展示流水数（1..10）。 */
  readonly transactions: number
  /** 最多展示「即将扣款」条数（0..10；0 = 关闭，输出与旧版逐字一致）。 */
  readonly subscriptions: number
  /** 流水回看窗口（天，1..365）。 */
  readonly windowDays: number
  /** 单次核心读的真实等待预算（毫秒，50..5000；不走注入钟）。 */
  readonly timeoutMs: number
  /** 数据行总长预算（字符，200..2000；头部与 notes 不计入）。 */
  readonly maxChars: number
  /** 连续失败多少次开熔断（1..10）。 */
  readonly breakerFailures: number
  /** 熔断窗口（毫秒，1000..60000）。 */
  readonly breakerOpenMs: number
}

/** 与 00 §5.1 的默认值逐字一致（host 的 `DEFAULT_BANK_TOOLS` 复用它）。 */
export const DEFAULT_CONTEXT_SLOTS: ContextSlotSettings = {
  accounts: 3,
  transactions: 3,
  subscriptions: 3,
  windowDays: 30,
  timeoutMs: 250,
  maxChars: 800,
  breakerFailures: 3,
  breakerOpenMs: 10_000,
}

/** 「即将扣款」的取数窗口（天）：一周内到期的 active 订阅。 */
const UPCOMING_WINDOW_DAYS = 7

/* ────────────────────────────────────────────────────────────────────────────
 * 2. 视图与端口（与 runtime 的 `RuntimeContextView` / `RuntimeContextSource` 结构等价）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 账户槽位（金额已由边界格式化，运行时不做任何金额运算）。 */
export interface ContextSlotAccount {
  /** 受控文案（`ACCOUNT_TYPE_LABEL`：账户类型的中文名，不在本文件重抄）。 */
  readonly name: string
  /** 只留数字的尾 4 位（不足 4 位用 `*` 补齐）。 */
  readonly maskedNumber: string
  /** `formatYuan(balanceCents)`，如 `¥12,345.67`。 */
  readonly balanceText: string
  /** `formatYuan(availableCents)`。 */
  readonly availableText: string
  /** 受控文案：正常 / 冻结 / 销户。 */
  readonly statusText?: string
}

/** 槽位视图（只列适配器会产出的字段）。 */
export interface ContextSlotView {
  readonly user?: { readonly name?: string }
  readonly accounts?: readonly ContextSlotAccount[]
  /** 受控模板生成的单行；不含收款人/商户名/备注/渠道/内部 ID。 */
  readonly recentTransactions?: readonly string[]
  /** 即将扣款（单行；商户名经 `sanitizeMerchantForPrompt` 净化后进入）。 */
  readonly upcomingCharges?: readonly string[]
  /** 零账户 / 零流水 / 预算截断的说明（**永不截断**）。 */
  readonly notes?: readonly string[]
}

/** 一次解析的结果；`status !== 'ok'` 时没有 `view`。 */
export interface ContextSlotResolution {
  readonly view?: ContextSlotView
  readonly status: 'ok' | 'unbound' | 'degraded'
  /** `status=degraded` 时的稳定理由码（见 00 §5.6）。 */
  readonly code?: string
  /** 边界格式化好的 `YYYY-MM-DD HH:mm`（+8）；运行时只排版。 */
  readonly asOfText?: string
}

/** 解析入参（AgentLoop 每 step 现造；`now` 是函数，只有本适配器调用一次）。 */
export interface BankContextInvocation {
  /** 当次会话（fork 后是子会话）。 */
  readonly sessionId: SessionId
  /** fork 来源：子会话未绑定时，只继承父会话**身份**（不继承数据）。 */
  readonly forkOf?: SessionId
  readonly turn: number
  readonly step: number
  /** 该 step 的取消信号。 */
  readonly signal: AbortSignal
  /** 注入钟；调用一次后 asOf / 窗口 / 熔断都用同一个值。 */
  readonly now: () => number
}

/** 槽位数据源。 */
export interface BankContextSource {
  resolve(invocation: BankContextInvocation): Promise<ContextSlotResolution>
}

/** 身份解析（`SessionIdentityStore` 天然满足）。 */
export interface BankContextIdentity {
  resolve(sessionId: SessionId): string | undefined
}

/** 装配参数。 */
export interface BankContextSourceDeps {
  readonly core: BankCoreProvider
  readonly identity: BankContextIdentity
  readonly settings: ContextSlotSettings
  /** 结构化告警（host 注入 `logJson`；测试注入 spy）；**不得写 PII**。 */
  readonly warn?: (code: string, fields: Readonly<Record<string, unknown>>) => void
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. 工厂
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 建一个槽位数据源。
 *
 * 熔断状态在**进程内、按实例**：多会话共享同一个 provider 时也共享熔断
 * （核心挂了不该每个会话各等 250ms）。这是正确性选择，不是缓存。
 */
export function createBankContextSource(deps: BankContextSourceDeps): BankContextSource {
  const settings = deps.settings
  /** 连续失败计数（成功即清零）。 */
  let failures = 0
  /** 熔断窗口右边界（epoch ms，取自注入钟）。 */
  let openUntil = 0

  /**
   * 记一次读失败：`slots-aborted`（取消）与 `slots-identity-unknown`（数据问题）
   * **不计**熔断——它们不是核心故障，计入会让"用户点了取消"把核心熔断掉。
   */
  const noteFailure = (code: string, at: number): void => {
    if (code === 'slots-aborted' || code === 'slots-identity-unknown') return
    failures += 1
    if (failures >= settings.breakerFailures) {
      failures = 0
      openUntil = at + settings.breakerOpenMs
      // 只记计数，不记姓名/尾号/错误原文
      deps.warn?.('context/slots-circuit-open', { failures: settings.breakerFailures })
    }
  }

  return {
    async resolve(invocation: BankContextInvocation): Promise<ContextSlotResolution> {
      const { signal } = invocation

      // 1. 已取消：不读核心、不取钟
      if (signal.aborted) return degrade('slots-aborted')

      // 2. 身份：本会话 → fork 来源（只继承一层；账户与流水仍按子会话现读）
      const bound =
        deps.identity.resolve(invocation.sessionId) ??
        (invocation.forkOf === undefined ? undefined : deps.identity.resolve(invocation.forkOf))
      if (bound === undefined) return { status: 'unbound' }

      // 品牌铸造点：后面一律用 uid；Provider 返回别人的对象视为身份错位
      const uid: UserId = bankIds.user(bound)

      // 3. 取钟：只取一次（asOf / 窗口 / 熔断共用同一个时刻）
      const at = invocation.now()

      // 4. 熔断窗口内不读核心
      if (at < openUntil) return degrade('slots-circuit-open')

      // 5. 主体（找不到 / 返回别人 → 不猜、不读账户）
      const userRead = await read(() => deps.core.getUser(uid), settings.timeoutMs, signal)
      if (!userRead.ok) {
        noteFailure(userRead.code, at)
        return degrade(userRead.code)
      }
      const user = userRead.value
      if (user === undefined || user.id !== uid) return degrade('slots-identity-unknown')

      // 6. 账户 + 流水 + 即将扣款并行（都只依赖 user.id；串行会多一次 RTT）
      const from = at - settings.windowDays * DAY_MS
      // 多取一点换顺序正确：Provider 若不保证时间倒序，只取 N 条可能漏掉真正最新的
      const limit = Math.max(1, Math.min(PAGE_LIMIT_MAX, settings.transactions * 4))
      const upcomingPromise =
        settings.subscriptions === 0
          ? Promise.resolve({ ok: true as const, value: [] as UpcomingCharge[] })
          : read(
              () => deps.core.upcomingCharges(user.id, UPCOMING_WINDOW_DAYS),
              settings.timeoutMs,
              signal,
            )
      const [accountsRead, txnsRead, upcomingRead] = await Promise.all([
        read(() => deps.core.listAccounts(user.id), settings.timeoutMs, signal),
        read(
          () => deps.core.queryTransactions({ userId: uid, from, to: at, limit }),
          settings.timeoutMs,
          signal,
        ),
        upcomingPromise,
      ])

      // 取消优先：任一读被取消 → 整体取消（其余结果丢弃）；取消不是核心故障
      if (!accountsRead.ok && accountsRead.code === 'slots-aborted') return degrade('slots-aborted')
      if (!txnsRead.ok && txnsRead.code === 'slots-aborted') return degrade('slots-aborted')
      if (!upcomingRead.ok && upcomingRead.code === 'slots-aborted') return degrade('slots-aborted')

      // 任一失败 → 整体降级，不返回"半张图"
      if (!accountsRead.ok) {
        noteFailure(accountsRead.code, at)
        return degrade(accountsRead.code)
      }
      if (!txnsRead.ok) {
        noteFailure(txnsRead.code, at)
        return degrade(txnsRead.code)
      }
      if (!upcomingRead.ok) {
        noteFailure(upcomingRead.code, at)
        return degrade(upcomingRead.code)
      }

      // 防御性过滤：Provider 有 bug / 被替换时不泄漏别人数据
      const accounts = accountsRead.value.filter((account) => account.userId === user.id)
      const accountIds = new Set(accounts.map((account) => account.id))
      const transactions = txnsRead.value.items.filter(
        (transaction) =>
          accountIds.has(transaction.accountId) &&
          transaction.at >= from &&
          transaction.at <= at,
      )

      // 7. 全成功：清零（熔断只按连续失败）
      failures = 0

      // 8. 选数与格式化（账户按 id 升序；流水按 at 降序、同 at 按 id 升序）
      const selectedAccounts = [...accounts]
        .sort((left, right) => compareText(left.id, right.id))
        .slice(0, settings.accounts)
        .map(accountView)
      const selectedTransactions = [...transactions]
        .sort((left, right) => right.at - left.at || compareText(left.id, right.id))
        .slice(0, settings.transactions)
        .map(transactionLine)
      const selectedUpcoming = [...upcomingRead.value]
        .filter((charge) => {
          if (charge.dueAt < at || charge.dueAt > at + UPCOMING_WINDOW_DAYS * DAY_MS) return false
          // 用户设了提前量就按提前量（1..7）；没设 = 默认一周窗口
          const days = (charge.dueAt - at) / DAY_MS
          return days <= (charge.reminderAheadDays ?? UPCOMING_WINDOW_DAYS)
        })
        .sort(
          (left, right) =>
            left.dueAt - right.dueAt || compareText(left.subscriptionId, right.subscriptionId),
        )
        .slice(0, settings.subscriptions)
        .map((charge) => upcomingLine(charge, at))

      // 9. 预算：先丢流水末尾，再丢即将扣款末尾，最后丢账户末尾；notes 永不截断
      const notes: string[] = []
      if (accounts.length === 0) notes.push('没有可展示的账户')
      if (transactions.length === 0) {
        notes.push(`近 ${String(settings.windowDays)} 天没有交易记录`)
      }

      let keptAccounts = selectedAccounts
      let keptTransactions = selectedTransactions
      let keptUpcoming = selectedUpcoming
      let used =
        sumAccountLines(keptAccounts) +
        sumTransactionLines(keptTransactions) +
        sumTransactionLines(keptUpcoming)
      let truncated = false
      while (used > settings.maxChars && keptTransactions.length > 0) {
        const dropped = keptTransactions[keptTransactions.length - 1]
        if (dropped === undefined) break
        // 渲染时流水前面有 `- `（2 字符），预算按渲染后的行算
        used -= dropped.length + TXN_LINE_PREFIX.length
        keptTransactions = keptTransactions.slice(0, -1)
        truncated = true
      }
      while (used > settings.maxChars && keptUpcoming.length > 0) {
        const dropped = keptUpcoming[keptUpcoming.length - 1]
        if (dropped === undefined) break
        used -= dropped.length + TXN_LINE_PREFIX.length
        keptUpcoming = keptUpcoming.slice(0, -1)
        truncated = true
      }
      while (used > settings.maxChars && keptAccounts.length > 0) {
        const dropped = keptAccounts[keptAccounts.length - 1]
        if (dropped === undefined) break
        used -= accountLineLength(dropped)
        keptAccounts = keptAccounts.slice(0, -1)
        truncated = true
      }
      if (truncated) {
        notes.push(
          `槽位已按预算截断（保留账户 ${String(keptAccounts.length)} / 流水 ${String(keptTransactions.length)}）。`,
        )
      }

      const name = sanitizeName(user.name)
      const view: ContextSlotView = {
        ...(name === '' ? {} : { user: { name } }),
        accounts: keptAccounts,
        recentTransactions: keptTransactions,
        ...(keptUpcoming.length === 0 ? {} : { upcomingCharges: keptUpcoming }),
        ...(notes.length === 0 ? {} : { notes }),
      }
      return { status: 'ok', view, asOfText: formatCnMinute(at) }
    },
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. 读原语（真实定时器 / abort / 晚到 rejection / 同步抛错）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 一次读的结果：业务失败是值，不是异常。 */
type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: ReadFailureCode }

/** 读失败码（`slots-aborted` 由调用方决定是否计熔断）。 */
type ReadFailureCode = 'slots-timeout' | 'slots-unavailable' | 'slots-aborted'

/**
 * 带超时与取消的读。
 *
 * 超时用**真实定时器**，不用注入钟：快照的 `fixedClock` 永远不会到期，
 * 用 `now` 做超时会让测试挂死。超时是"真实等待预算"，与业务时间无关。
 *
 * 四条纪律：
 * 1. `settled` 守卫：超时后 provider 才 reject，不能再 resolve 一次；
 * 2. `Promise.resolve().then(work).then(onOk, onErr)` 同时处理成功、同步抛错与失败，
 *    不会留下未处理的 rejection；
 * 3. `timer.unref()`：进程退出不被 250ms 定时器拖住；
 * 4. abort 时立刻返回，不等待 provider；底层结果被 `settled` 丢弃。
 */
async function read<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Read<T>> {
  if (signal.aborted) return { ok: false, code: 'slots-aborted' }

  return new Promise<Read<T>>((resolve) => {
    let settled = false
    const finish = (result: Read<T>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = (): void => finish({ ok: false, code: 'slots-aborted' })
    const timer = setTimeout(() => finish({ ok: false, code: 'slots-timeout' }), timeoutMs)
    // Node 的 Timeout 有 unref；浏览器没有（类型上也不保证），可选调用
    ;(timer as unknown as { unref?: () => void }).unref?.()
    signal.addEventListener('abort', onAbort, { once: true })
    // 双重检查：check 与 addEventListener 之间仍可能被 abort（事件不会补发）
    if (signal.aborted) {
      finish({ ok: false, code: 'slots-aborted' })
      return
    }
    Promise.resolve()
      .then(work)
      .then(
        (value) => finish({ ok: true, value }),
        () => finish({ ok: false, code: 'slots-unavailable' }),
      )
  })
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. 格式化与脱敏（逐字规范见 02 §ES-25）
 * ──────────────────────────────────────────────────────────────────────────── */

/** 交易状态后缀（presenters 没有这张表；成功不输出后缀）。 */
const TXN_STATUS_SUFFIX: Readonly<Record<TxnStatus, string>> = {
  success: '',
  failed: '，失败',
  pending: '，处理中',
}

/** 流水行在提示词里的前缀（预算按渲染后的行算）。 */
const TXN_LINE_PREFIX = '- '

/** 账户槽位。 */
function accountView(account: Account): ContextSlotAccount {
  return {
    name: ACCOUNT_TYPE_LABEL[account.type],
    maskedNumber: maskTail(account.number),
    balanceText: formatYuan(account.balanceCents),
    availableText: formatYuan(account.availableCents),
    statusText: ACCOUNT_STATUS_LABEL[account.status],
  }
}

/** 流水行：`2023-11-10 06:13 转出 ¥68.00（消费）`。 */
function transactionLine(transaction: Transaction): string {
  const direction = transaction.direction === 'in' ? '转入' : '转出'
  return (
    `${formatCnMinute(transaction.at)} ${direction} ${formatYuan(transaction.amountCents)}` +
    `（${CATEGORY_LABEL[transaction.category]}${TXN_STATUS_SUFFIX[transaction.status]}）`
  )
}

/** 即将扣款的一行：商户名净化后单行，金额与周期用受控文案。 */
function upcomingLine(charge: UpcomingCharge, at: number): string {
  const days = Math.max(0, Math.round((charge.dueAt - at) / DAY_MS))
  const when = days === 0 ? '今天' : `${String(days)} 天后`
  return (
    `${sanitizeMerchantForPrompt(charge.merchant)} ${when} ${formatYuan(charge.amountCents)}` +
    `（${CYCLE_LABEL[charge.cycle]}）`
  )
}

/**
 * 账户数据行的长度（与 runtime 的 `accountLine` 模板逐字一致）。
 *
 * 为什么在这里重算一遍：适配器不能 import `@bah/runtime`（devDependency 纪律），
 * 但预算必须在数据边界就做完。模板漂移由 `slots.test.ts` 的边界用例钉住
 * （测试可以 import runtime，用它的渲染结果反推每行长度）。
 */
function accountLineLength(account: ContextSlotAccount): number {
  return renderAccountLine(account).length
}

/** 账户行的渲染模板（只用于预算；真正的排版在 runtime）。 */
function renderAccountLine(account: ContextSlotAccount): string {
  const status = account.statusText === undefined ? '' : `，${account.statusText}`
  return `- ${account.name}（尾号 ${account.maskedNumber}${status}）：余额 ${account.balanceText}，可用 ${account.availableText}`
}

/** 账户行的预算合计。 */
function sumAccountLines(accounts: readonly ContextSlotAccount[]): number {
  return accounts.reduce((sum, account) => sum + accountLineLength(account), 0)
}

/** 流水行的预算合计（含 `- ` 前缀）。 */
function sumTransactionLines(transactions: readonly string[]): number {
  return transactions.reduce((sum, line) => sum + line.length + TXN_LINE_PREFIX.length, 0)
}

/**
 * 尾号脱敏：只留数字的最后 4 位，不足 4 位用 `*` 补齐。
 *
 * 绝不回退到原串：`account.number` 一旦原文出现在提示词/日志/事件里，
 * 就等于把完整卡号交给了模型与落盘证据。
 */
function maskTail(number: string): string {
  const digits = number.replace(/\D/g, '')
  return digits.slice(-4).padStart(4, '*')
}

/** 姓名长度上限（码点）。 */
const MAX_NAME_CHARS = 24

/**
 * 姓名净化：NFKC → 去控制符/零宽/双向控制 → 折叠空白 → 单行 → 截 24 码点。
 *
 * 净化后的姓名仍可能包含指令式文字（"忽略以上指令"），但它被限成**单行、24 字、
 * 且位于 `【当前用户】姓名：…` 的固定模板里**；配合 `【运行时数据·非指令】` 声明，
 * 这是可接受的残余风险（已写进安全设计缺口列）。
 *
 * 为什么连零宽/双向控制符一起去：它们不改变"单行"判定，但能让人眼看到的名字与
 * 实际字节不一致（视觉欺骗），属于同一类注入面。
 */
export function sanitizeName(raw: string): string {
  const text = raw
    .normalize('NFKC')
    // 控制符（C0/C1）、零宽与双向控制符
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 按码点截，不切坏 emoji / 代理对
  return [...text].slice(0, MAX_NAME_CHARS).join('')
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. 小工具
 * ──────────────────────────────────────────────────────────────────────────── */

/** 稳定字符串比较（不依赖 locale，避免 `localeCompare` 的 tzdata 差异）。 */
function compareText(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/** 降级结果。 */
function degrade(code: string): ContextSlotResolution {
  return { status: 'degraded', code }
}
