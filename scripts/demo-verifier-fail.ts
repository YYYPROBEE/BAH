/**
 * fail-injection 演示（HP-0 / R-HP0-01 的处置）。
 *
 * 目的：证明"判决件自己崩了"时，未经核验的工具结果**不会**进入模型可见内容——
 * 不是靠单测里的一个返回值，而是走真实七段管线的 block 分支。
 *
 * 做法：
 * - 真装配：`createContext` + 会话服务 + `ToolRegistry` + `ToolGuard` + `ToolPipeline`
 *   （与生产同一套类，不 mock 管线）；
 * - 真包装：用 `failClosedPostExecute` 包监听器（与 sentry 生产注册的是同一个函数）；
 * - 注入失败：场景 A 让"判决件"自己抛错；场景 B 让下游监听器抛错，验证 `next()` 抛错
 *   也会被兜住（fail-closed 优先于下游判决）。
 *
 * 不联网、不读密钥、不写库；跑完只打印证据。
 *
 * 用法：`pnpm demo:verifier-fail`
 */

import { createContext, type SessionId, type ToolDefinition } from '@bah/core'
import {
  SESSION_SERVICE,
  ToolGuard,
  ToolPipeline,
  ToolRegistry,
  provideSession,
  provideTools,
} from '@bah/runtime'
import {
  TraceLog,
  VERIFIER_UNAVAILABLE,
  failClosedPostExecute,
  type FailClosedOptions,
} from '@bah/safety'

/** 会话 ID（品牌类型在脚本里只能断言；不引入 test-support）。 */
const SESSION_ID = 's-demo-verifier-fail' as unknown as SessionId

const CALL_ID = 'c-demo-verifier-fail'
const TOOL_NAME = 'demo_read_balance'

/** 工具结果里的原始文本：block 之后它**不得**出现在模型可见内容里。 */
const RAW_RESULT = '余额 12345.67 元'

/** 固定步进时钟（让输出可复现，不读真实时间）。 */
function clock(start = 1_700_000_000_000): () => number {
  let value = start
  return () => {
    value += 1
    return value
  }
}

/** 一个最小的只读工具：绿级、无副作用。 */
const toolDefinition: ToolDefinition = {
  name: TOOL_NAME,
  description: '演示用：读余额（真实管线，假工具体）',
  schema: { type: 'object', properties: {} },
  tier: { level: 'green' },
  execute: () => Promise.resolve(RAW_RESULT),
}

interface Evidence {
  /** 工具体执行次数：block 发生在执行之后，所以应为 1。 */
  readonly executed: number
  readonly isError: boolean
  readonly code: string | undefined
  readonly contentText: string
  readonly additionalContexts: readonly string[]
  readonly eventTypes: readonly string[]
  readonly verifierEvent: { readonly code?: string; readonly listener?: string } | undefined
  readonly traceKinds: readonly string[]
}

interface Scenario {
  readonly label: string
  readonly inject: (ctx: ReturnType<typeof createContext>, options: FailClosedOptions) => void
}

/**
 * 跑一个场景：真管线 + 注入。
 *
 * 注意：每个场景都新建 ctx，避免监听器串场。
 */
async function runScenario(scenario: Scenario): Promise<Evidence> {
  const ctx = createContext()
  const now = clock()
  provideSession(ctx, { sessionId: SESSION_ID, now })
  const session = ctx.get(SESSION_SERVICE)
  const registry = new ToolRegistry()
  provideTools(ctx, registry)

  const trace = new TraceLog({ now })
  const options: FailClosedOptions = {
    sessionId: SESSION_ID,
    trace,
    record: (type, data) => {
      session.appendDomain(type, data, { ignorable: true })
    },
    now,
  }

  scenario.inject(ctx, options)

  let executed = 0
  const counted: ToolDefinition = {
    ...toolDefinition,
    execute: () => {
      executed += 1
      return Promise.resolve(RAW_RESULT)
    },
  }
  registry.register(counted)

  const pipeline = new ToolPipeline({
    ctx,
    registry,
    session,
    guard: new ToolGuard(),
    sessionId: SESSION_ID,
    now,
  })

  const execution = await pipeline.execute({ callId: CALL_ID, name: TOOL_NAME, args: {} })
  const contentText = execution.result.content
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join('\n')

  const events = session.events()
  const verifier = events.find((event) => event.type === 'sentry/verifier-failed')

  const evidence: Evidence = {
    executed,
    isError: execution.result.isError,
    code: execution.result.code,
    contentText,
    additionalContexts: execution.additionalContexts,
    eventTypes: events.map((event) => event.type),
    verifierEvent: verifier?.data as Evidence['verifierEvent'],
    traceKinds: (trace.rings.get(SESSION_ID) ?? []).map((record) => record.kind),
  }

  await ctx.dispose('demo-done')
  return evidence
}

/** 断言 + 打印；返回失败条数。 */
function check(scenario: string, evidence: Evidence): number {
  const failures: string[] = []
  const expect = (ok: boolean, message: string): void => {
    if (!ok) failures.push(message)
  }

  expect(evidence.executed === 1, '工具体应执行 1 次（block 发生在执行之后）')
  expect(evidence.isError, '结果应标记为 isError')
  expect(evidence.code === VERIFIER_UNAVAILABLE, `理由码应为 ${VERIFIER_UNAVAILABLE}`)
  expect(evidence.contentText.includes('【幻觉防护】'), '模型可见内容应为固定话术')
  expect(evidence.contentText.includes('已阻断'), '固定话术应说明已阻断')
  expect(!evidence.contentText.includes(RAW_RESULT), '原始结果不得出现在模型可见内容里')
  expect(
    evidence.additionalContexts.some((text) => text.includes('已阻断')),
    '应追加纠正上下文（模型下一次能看到"刚才被拦了"）',
  )
  expect(evidence.eventTypes.includes('sentry/verifier-failed'), '应落 sentry/verifier-failed')
  expect(evidence.verifierEvent?.code === VERIFIER_UNAVAILABLE, '事件应带 verifier-unavailable')
  expect(
    evidence.traceKinds.includes('honesty-verifier-failed'),
    'TraceLog 应记 honesty-verifier-failed',
  )

  console.log(`\n== ${scenario} ==`)
  console.log(`  工具体执行     : ${String(evidence.executed)} 次`)
  console.log(`  isError / code : ${String(evidence.isError)} / ${evidence.code ?? '(none)'}`)
  console.log(`  模型可见内容   : ${evidence.contentText.replaceAll('\n', ' ⏎ ')}`)
  console.log(`  原始结果泄漏   : ${evidence.contentText.includes(RAW_RESULT) ? '是（失败）' : '否'}`)
  console.log(
    `  追加纠正上下文 : ${evidence.additionalContexts.length === 0 ? '(none)' : evidence.additionalContexts.join(' ⏎ ')}`,
  )
  console.log(`  落账事件       : ${evidence.eventTypes.join(' → ')}`)
  console.log(
    `  verifier-failed: listener=${evidence.verifierEvent?.listener ?? '(none)'} code=${evidence.verifierEvent?.code ?? '(none)'}`,
  )
  console.log(`  TraceLog       : ${evidence.traceKinds.join(' / ')}`)

  if (failures.length > 0) {
    console.log(`  ✘ 失败 ${String(failures.length)} 条：`)
    for (const failure of failures) console.log(`    - ${failure}`)
  } else {
    console.log('  ✔ 全部断言通过')
  }
  return failures.length
}

/** 场景 A：判决件自己抛错。 */
const scenarioA: Scenario = {
  label: 'A · 判决件自身异常（sentry 包装器内层抛错）',
  inject: (ctx, options) => {
    const exploding = (): Promise<never> => {
      throw new Error('模拟注入：数值对账器读到了损坏的配置')
    }
    ctx.effect(ctx.events.on('tools/post-execute', failClosedPostExecute(exploding, options)))
  },
}

/** 场景 B：下游监听器抛错（`next()` reject，包装器同样兜住）。 */
const scenarioB: Scenario = {
  label: 'B · 下游监听器异常（next() 抛错，包装器兜底）',
  inject: (ctx, options) => {
    const passThrough = (payload: unknown, next: (value: unknown) => Promise<unknown>) =>
      next(payload)
    ctx.effect(
      ctx.events.on('tools/post-execute', failClosedPostExecute(passThrough, options)),
    )
    const downstream = (): Promise<never> => {
      throw new Error('模拟注入：下游审计监听器崩溃')
    }
    ctx.effect(ctx.events.on('tools/post-execute', downstream))
  },
}

async function main(): Promise<void> {
  console.log('fail-injection 演示：判决件异常 → 结果被挡在模型之外')
  console.log('装配：createContext + 会话服务 + ToolRegistry + ToolGuard + ToolPipeline（真实管线）')
  console.log('包装：failClosedPostExecute（与 sentry 生产注册同一函数）')

  let failures = 0
  for (const scenario of [scenarioA, scenarioB]) {
    const evidence = await runScenario(scenario)
    failures += check(scenario.label, evidence)
  }

  console.log('\n—— 结论 ——')
  if (failures === 0) {
    console.log('两条路径都证明：判决件异常时，原始结果没有进入模型可见内容，且证据已落账。')
    console.log('答辩口径：这不是"规则命中"，是"核验组件失效时仍然不放行"。')
  } else {
    console.log(`共 ${String(failures)} 条断言失败——演示不成立，别拿去讲。`)
  }
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
