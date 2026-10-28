/**
 * 演示脚本：`plan:dag` 编排原语的证据面（方案 §7.2「演示路径不直观」的缓解项）。
 *
 * ## 为什么需要它
 *
 * plan 没有模型入口（工具锁 14 个），所以"模型在用 DAG"这件事在对话里**看不到**。
 * 评委能看到的只有事件流。这个脚本把三件事一次演完：
 *
 * 1. **全成功**：3 个节点各走一次七段管线 → 3 条 `tool/call`、**恰好 1 条** `approval/asked`
 *    （审批一次 = 扣款一次，这是 plan 与 saga 最容易被问混的地方）；
 * 2. **菱形失败传播**：`A → {B,C} → D`，A 失败后 D 的 `blockedBy` 必须是 `['B','C']`
 *    ——只传一层或只记直接 failed 上游的写法，在这里会立刻现形；
 * 3. **dry-run**：`tool/call` 与 `approval/*` 都是 0，`plan/node-result` 仍是 3 条
 *    ——"预览一次转账"不会在审计里留下假记录。
 *
 * ## 跑法
 *
 * ```bash
 * npx tsx scripts/demo-plan.ts
 * ```
 *
 * 退出码 0 = 三条断言全过；非 0 = 有断言失败（可直接进 CI）。
 *
 * ## 纪律
 *
 * - 落盘目录固定 `.tmp-plan-demo` 且每次先清（jsonl 后端拒绝覆写已存在的会话）；
 * - **不联网、不读密钥**：profile `plan` 用确定性 router 模型，且 plan 根本不经过模型；
 * - 时钟用真实时间（这是演示，不是快照）：`durationMs` 只能看数量级，逐字节对齐是
 *   `snapshots/plan/` 的职责。
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { PLAN_SERVICE, SESSION_FILES, boot, createCatalog } from '@bah/host'
import { SESSION_SERVICE, type Plan, type PlanRunSummary } from '@bah/runtime'

import { loadBundles } from '../packages/cli/src/bundles.ts'
import { readLayers, readProfile } from '../packages/cli/src/profile.ts'

/** 证据落盘目录（每次重建）。 */
const JSONL_DIR = '.tmp-plan-demo'

/** 会话 ID（固定，便于对照日志）。 */
const SESSION_ID = 's-plan-demo'

const PAYEE = { name: '王建国', phone: '13900002222' } as const

/** 场景 1：演示主链路（查余额 → 试算 → 扣款）。 */
const PLAN_OK: Plan = {
  planId: 'demo-ok',
  meta: { title: '演示：查余额 → 试算 → 扣款' },
  nodes: [
    { id: 'balance', tool: 'account_balance', args: {}, deps: [] },
    {
      id: 'preview',
      tool: 'transfer_preview',
      args: { amount: 800, payee: PAYEE, remark: '房租' },
      deps: ['balance'],
    },
    {
      id: 'pay',
      tool: 'transfer_create',
      args: { amount: 800, payee: PAYEE, remark: '房租' },
      deps: ['preview'],
    },
  ],
}

/**
 * 场景 4（B3 跨场景联动）：一条计划串起四个场景的工具。
 *
 * 流水（txn_query）→ 账单（bill_analyze）；余额（account_balance）独立跑；
 * 取消订阅（sub_cancel，黄级写）同时依赖账单与余额——模拟"月底复盘：
 * 查账 → 汇总 → 看可用 → 处理识别出的自动续费"。
 * **这是外部喂图的模拟联动**：计划由本脚本静态给出，不声称模型自主规划（B1 的
 * plan_propose 才是模型入口）；sub_cancel 的订阅 ID 来自 demo 造数（`s-1`，云存储会员），
 * 不接任何真实商户。
 */
const PLAN_CROSS: Plan = {
  planId: 'demo-cross',
  meta: { title: '跨场景联动：流水 → 账单 →（余额）→ 取消订阅' },
  nodes: [
    { id: 'txns', tool: 'txn_query', args: { limit: 5 }, deps: [] },
    { id: 'bill', tool: 'bill_analyze', args: { period: 'month' }, deps: ['txns'] },
    { id: 'funds', tool: 'account_balance', args: {}, deps: [] },
    {
      id: 'cancel-sub',
      tool: 'sub_cancel',
      args: { subscriptionId: 's-1' },
      deps: ['bill', 'funds'],
    },
  ],
}

/**
 * 场景 2：菱形图 + 根节点失败。
 *
 * A 用负数金额：治理平面在 `tools/pre-execute` 就拒（不签发票据），所以它是**确定性失败**，
 * 不依赖余额或随机数据。B 与 C 被 block，D 的 `blockedBy` 必须同时出现 B 和 C。
 */
const PLAN_DIAMOND: Plan = {
  planId: 'demo-diamond',
  meta: { title: '演示：菱形图 A→{B,C}→D，A 失败' },
  nodes: [
    { id: 'A', tool: 'transfer_create', args: { amount: -1, payee: { name: 'x' } }, deps: [] },
    { id: 'B', tool: 'transfer_preview', args: { amount: 800, payee: PAYEE }, deps: ['A'] },
    { id: 'C', tool: 'account_list', args: {}, deps: ['A'] },
    { id: 'D', tool: 'transfer_preview', args: { amount: 800, payee: PAYEE }, deps: ['B', 'C'] },
  ],
}

/** 扁平化事件（演示只读 `type` 与几个字段）。 */
interface FlatEvent {
  readonly type: string
  readonly data: Record<string, unknown>
}

/** 断言计数（不做测试框架的软断言：演示脚本失败要能被 CI 看见）。 */
let failures = 0

/** 实际执行过的断言条数（`--only` 时收尾结论要知道到底跑了几条）。 */
let asserted = 0

function check(label: string, ok: boolean, detail: string): void {
  asserted += 1
  if (ok) {
    console.log(`  PASS ${label}（${detail}）`)
    return
  }
  failures += 1
  console.error(`  FAIL ${label}（期望 ${detail}）`)
}

function countOf(events: readonly FlatEvent[], type: string): number {
  return events.filter((event) => event.type === type).length
}

/** 某条事件里某个字段（演示脚本不引 zod，直接读）。 */
function field(event: FlatEvent | undefined, key: string): unknown {
  return event === undefined ? undefined : event.data[key]
}

/** 只打印 `plan/*` 的事件表：`tool/call` 与审计事件另有计数断言，不必逐条刷屏。 */
const PRINTED = /^plan\//

/** 打印一批 `plan/*` 事件（调用方已按 `PRINTED` 过滤）。 */
async function printPlanEvents(events: readonly FlatEvent[]): Promise<void> {
  for (const event of events) {
    const data = event.data
    const bits: string[] = []
    if (typeof data['nodeId'] === 'string') bits.push(`node=${data['nodeId']}`)
    if (typeof data['status'] === 'string') bits.push(`status=${data['status']}`)
    if (typeof data['code'] === 'string') bits.push(`code=${data['code']}`)
    if (typeof data['reason'] === 'string') bits.push(`reason=${data['reason']}`)
    if (typeof data['ordinal'] === 'number') bits.push(`ordinal=${String(data['ordinal'])}`)
    if (Array.isArray(data['blockedBy'])) bits.push(`blockedBy=[${(data['blockedBy'] as string[]).join(',')}]`)
    if (typeof data['digest'] === 'string') bits.push(`digest=${data['digest'].slice(0, 12)}…`)
    if (typeof data['durationMs'] === 'number') bits.push(`durationMs=${String(data['durationMs'])}`)
    console.log(`  ${event.type.padEnd(20)} ${bits.join(' ')}`)
    await nap(options.paceMs)
  }
}

function printSummary(summary: PlanRunSummary): void {
  console.log(
    `  汇总：status=${summary.status} total=${String(summary.total)} ` +
      `succeeded=${String(summary.succeeded)} failed=${String(summary.failed)} ` +
      `blocked=${String(summary.blocked)} skipped=${String(summary.skipped)} ` +
      `cancelled=${String(summary.cancelled)}`,
  )
}

/**
 * 演示开关（只影响**打印节奏**与**跑哪几个场景**，不改任何断言、计数与落账）。
 *
 * 为什么需要：四场景一次跑完只要 1 s，录屏时在屏幕上一闪而过，评委根本看不清断言；
 * 而 CI 需要的是"立刻跑完"。所以节奏是**显式参数**、默认 0（CI 行为一字不变）。
 *
 * - `--pace=<ms>`：每打一行等 ms 再打下一行。
 * - `--only=<ok|diamond|dry>`：只跑一个场景。**没跑的场景连断言都不执行**，
 *   收尾结论会按实际跑过的条数收窄——绝不把没跑的算成通过。
 */
const OPTION_USAGE = '用法：npx tsx scripts/demo-plan.ts [--pace=<ms>] [--only=ok|diamond|dry|cross]'

interface DemoOptions {
  readonly paceMs: number
  readonly only?: 'ok' | 'diamond' | 'dry' | 'cross'
}

function parseOptions(argv: readonly string[]): DemoOptions {
  let paceMs = 0
  let only: DemoOptions['only']
  for (const arg of argv) {
    if (arg.startsWith('--pace=')) {
      const raw = arg.slice('--pace='.length)
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`--pace 需要非负毫秒数（收到 ${raw}）\n${OPTION_USAGE}`)
      }
      paceMs = value
      continue
    }
    if (arg.startsWith('--only=')) {
      const raw = arg.slice('--only='.length)
      if (raw !== 'ok' && raw !== 'diamond' && raw !== 'dry') {
        throw new Error(`--only 只接受 ok / diamond / dry / cross（收到 ${raw}）\n${OPTION_USAGE}`)
      }
      only = raw
      continue
    }
    throw new Error(`未知参数 ${arg}\n${OPTION_USAGE}`)
  }
  return { paceMs, ...(only === undefined ? {} : { only }) }
}

const options = parseOptions(process.argv.slice(2))

/** 是否要跑某个场景（`--only` 缺省时全跑）。 */
const wants = (name: 'ok' | 'diamond' | 'dry' | 'cross'): boolean =>
  options.only === undefined || options.only === name

/** 打印节奏（`--pace` 未给时是 no-op；声明在 printPlanEvents 之后会触发 TDZ）。 */
const nap = (ms: number): Promise<void> =>
  ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

const root = process.cwd()
const profile = readProfile(root, 'plan')
const bundles = await loadBundles(root, profile.bundles)
const { layers } = readLayers(root, profile, { home: join(root, '.tmp-no-home'), overlays: [] })

rmSync(join(root, JSONL_DIR), { recursive: true, force: true })

const app = await boot({
  profile,
  bundles,
  layers,
  catalog: createCatalog(),
  run: { sessionId: SESSION_ID as never, now: () => Date.now(), jsonlDir: JSONL_DIR },
})

try {
  const api = app.ctx.get(PLAN_SERVICE)
  const session = app.ctx.get(SESSION_SERVICE)

  /**
   * 取"本次 run 产生的事件"：**按事件流长度切片**，不按 `planId` 过滤。
   *
   * 为什么不能按 `planId` 过滤：`tool/call` 的载荷里没有 `planId`（只有 `callId`），
   * 审批事件更是与 plan 无关。按 `planId` 过滤会得到"tool/call 恒为 0"的假绿——
   * 那正好是演示要证明的东西，用错口径等于自证清白。
   */
  const since = (offset: number): FlatEvent[] =>
    session
      .events()
      .slice(offset)
      .map((event) => ({ type: event.type, data: event.data as unknown as Record<string, unknown> }))

  const scopeText =
    options.only === undefined
      ? '四场景（含 B3 跨场景联动）'
      : `单场景 ${options.only}（其余场景本次未运行）`
  console.log(`== demo-plan：${scopeText}${options.paceMs > 0 ? ` · 打印节奏 ${String(options.paceMs)} ms/行` : ''} ==`)

  if (wants('ok')) {
    console.log('== 场景 1：3 节点全成功（查余额 → 试算 → 扣款）==')
    const beforeOk = session.events().length
    const ok = await api.run(PLAN_OK)
    const okEvents = since(beforeOk)
    await printPlanEvents(okEvents.filter((event) => PRINTED.test(event.type)))
    printSummary(ok)
    const okCalls = countOf(okEvents, 'tool/call')
    const okAsked = countOf(okEvents, 'approval/asked')
    check('每节点一条 tool/call', okCalls === 3, `tool/call=${String(okCalls)}`)
    check('审批只发生一次', okAsked === 1, `approval/asked=${String(okAsked)}`)
    check('计划判成功', ok.status === 'succeeded', `status=${ok.status}`)
    await nap(options.paceMs * 6)
  }

  if (wants('diamond')) {
    console.log('\n== 场景 2：菱形图 A→{B,C}→D，A 失败 ==')
    const beforeDiamond = session.events().length
    const diamond = await api.run(PLAN_DIAMOND)
    const diamondEvents = since(beforeDiamond)
    await printPlanEvents(diamondEvents.filter((event) => PRINTED.test(event.type)))
    printSummary(diamond)
    const blockedD = diamondEvents.find(
      (event) => event.type === 'plan/node-blocked' && event.data['nodeId'] === 'D',
    )
    const blockedBy = field(blockedD, 'blockedBy')
    check(
      'D 的 blockedBy 记录两条上游（不是只记根因 A）',
      Array.isArray(blockedBy) && blockedBy.length === 2 && blockedBy.join(',') === 'B,C',
      `blockedBy=${JSON.stringify(blockedBy)}`,
    )
    // A 失败 → B、C 被 block → D 被 block：只有 1 条 tool/call（A 自己）
    const diamondCalls = countOf(diamondEvents, 'tool/call')
    check('被 block 的节点一次都没进管线', diamondCalls === 1, `tool/call=${String(diamondCalls)}`)
    check('计划判失败（blocked 计入失败）', diamond.status === 'failed', `status=${diamond.status}`)
    await nap(options.paceMs * 6)
  }

  if (wants('dry')) {
    console.log('\n== 场景 3：dry-run（只校验 + 拓扑，不进管线）==')
    const dryRunPlan: Plan = { ...PLAN_OK, planId: 'demo-dry-run' }
    const beforeDry = session.events().length
    const dry = await api.run(dryRunPlan, { dryRun: true })
    const dryEvents = since(beforeDry)
    await printPlanEvents(dryEvents.filter((event) => PRINTED.test(event.type)))
    printSummary(dry)
    check('没有任何 tool/call', countOf(dryEvents, 'tool/call') === 0, 'tool/call=0')
    const dryApprovals = dryEvents.filter((event) => event.type.startsWith('approval/')).length
    check('没有任何 approval/*', dryApprovals === 0, 'approval/*=0')
    const dryResults = countOf(dryEvents, 'plan/node-result')
    check('每个节点仍落一条 node-result', dryResults === 3, 'plan/node-result=3')
    check('dry-run 不留快照', api.snapshot(dryRunPlan.planId) === undefined, 'snapshot=undefined')
  }

  if (wants('cross')) {
    console.log('\n== 场景 4（B3）：跨场景联动 流水→账单→(余额)→取消订阅 ==')
    const beforeCross = session.events().length
    const cross = await api.run(PLAN_CROSS)
    const crossEvents = since(beforeCross)
    await printPlanEvents(crossEvents.filter((event) => PRINTED.test(event.type)))
    printSummary(cross)
    const crossCalls = countOf(crossEvents, 'tool/call')
    const crossAsked = countOf(crossEvents, 'approval/asked')
    const crossResults = countOf(crossEvents, 'tool/result')
    check('四个节点全部进过管线（跨四个场景）', crossCalls === 4, `tool/call=${String(crossCalls)}`)
    check('每个节点都有结果', crossResults === 4, `tool/result=${String(crossResults)}`)
    check('只有黄级的取消订阅触发一次审批', crossAsked === 1, `approval/asked=${String(crossAsked)}`)
    check('计划判成功', cross.status === 'succeeded', `status=${cross.status}`)
    // 跨场景的审计证据：写节点的治理判决在 sentry/trace（sink: session）里，这里数审计族事件
    const auditEvents = crossEvents.filter((event) => event.type.startsWith('sentry/')).length
    check('sentry 审计事件已落会话（trace sink=session）', auditEvents > 0, `sentry/*=${String(auditEvents)}`)
    await nap(options.paceMs * 6)
  }

  console.log(`\n日志：${app.ctx.get(SESSION_FILES).fileOf(SESSION_ID as never)}`)
  if (failures > 0) {
    console.error(`\nFAIL：${String(failures)} 条断言未通过 —— plan:dag 的接线或语义已偏离方案`)
    process.exitCode = 1
  } else {
    const conclusion =
      options.only === undefined
        ? '审批不绕过、blocked 传递闭包、dry-run 零假记录、跨场景联动四节点全过，四条都成立'
        : `${options.only} 场景成立（其余场景本次未运行，不作结论）`
    console.log(`\nPASS：${String(asserted)} 条断言全过 —— ${conclusion}`)
  }
} finally {
  await app.dispose('demo-plan-done')
}
