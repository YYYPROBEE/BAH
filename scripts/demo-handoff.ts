/**
 * 人机接管闭环演练：`pnpm handoff:demo`（人机接管 02 · B7）。
 *
 * 全部动作走**真实 HTTP**（只有断言读内存事件与 session.jsonl）：
 *   客户转人工 → 坐席说 3 句 → 客户在等待期间说 2 句 → 坐席交回（带交接语）
 * 然后断言：人工发言不进模型历史、交接语进模型历史、等待期消息落账但不驱动模型。
 *
 * `--keep`：跑完断言后保持服务，打印 URL 与两个 token，供人工截图 / 手工复核。
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadBundles } from '../packages/cli/src/bundles.ts'
import { readLayers, readProfile } from '../packages/cli/src/profile.ts'
import { boot, createCatalog, SESSION_FILES } from '../packages/host/src/index.ts'
import { WEB_SERVER } from '../packages/host/src/boot/plugins/web.ts'
import { SESSION_SERVICE, type SessionApi } from '../packages/runtime/src/index.ts'
import { asSessionId } from '../packages/test-support/src/index.ts'
import { DEFAULT_TENANT_ID } from '../packages/util/src/index.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')

const WEB_TOKEN = 'dev-web'
const OPERATOR_TOKEN = 'dev-op'
const OPERATOR_NAME = '坐席小周'
const SESSION = 's-handoff-demo'
const CUSTOMER_SAYS = ['给王建国转 800 元', '我要问转账', '在吗？']
const OPERATOR_SAYS = ['您好，我是人工坐席', '正在核对收款人，请稍等', '已核对完成，马上为您处理']
const HANDOVER = '已核对收款人，继续转账'
const REASON = '客户要求人工复核'

process.env['BAH_WEB_TOKEN'] = WEB_TOKEN
process.env['BAH_OPERATOR_TOKEN'] = OPERATOR_TOKEN
process.env['BAH_OPERATOR_NAME'] = OPERATOR_NAME
if (process.env['BAH_KNOWLEDGE_KEY'] === undefined || process.env['BAH_KNOWLEDGE_KEY'] === '') {
  process.env['BAH_KNOWLEDGE_KEY'] = 'demo-key-not-for-prod'
}

const sessionsRoot = join(root, 'sessions')
mkdirSync(sessionsRoot, { recursive: true })
const runDir = mkdtempSync(join(sessionsRoot, 'handoff-demo-'))
const home = join(runDir, 'home')

/** 演示 overlay：随机端口 + 自动审批（否则首轮会卡在弹窗上，deriveMessages 出现日志空洞）。 */
const overlay = join(runDir, 'demo.patch.yml')
writeFileSync(
  overlay,
  [
    '- id: channel:web',
    '  config:',
    '    port: 0',
    '    host: 127.0.0.1',
    '    staticRoot: apps/web',
    '    heartbeatMs: 15000',
    '    handoff:',
    '      slaMs: 180000',
    '- id: interaction:approval',
    '  config:',
    '    responder: headless',
    '    autoDecision: allow',
    '    autoVerify: true',
    '',
  ].join('\n'),
  'utf8',
)

interface Reply {
  readonly status: number
  readonly body: string
}

async function call(
  base: string,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    origin: new URL(base).origin,
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const target = `${base.replace(/\/$/, '')}${path}`
  const response = await fetch(target, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: await response.text() }
}

function show(label: string, reply: Reply): void {
  // 原文照录：演练证据不写"成功 / 失败"，让读者自己看状态码与响应体
  console.log(`[demo] ${label} → ${String(reply.status)} ${reply.body}`)
}

async function waitFor(session: SessionApi, type: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (session.events().some((event) => String(event.type) === type)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待事件超时：${type}`)
}

/** 断言（失败即非零退出，不静默）。 */
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`断言失败：${message}`)
}

const profile = readProfile(root, 'web')
const bundles = await loadBundles(root, profile.bundles)
const { layers } = readLayers(root, profile, { home, overlays: [overlay] })
const app = await boot({
  profile,
  bundles,
  layers,
  catalog: createCatalog(),
  run: {
    sessionId: asSessionId(SESSION),
    tenantId: DEFAULT_TENANT_ID,
    now: () => Date.now(),
    probe: true,
    jsonlDir: runDir,
  },
  warn: (message) => console.warn(`[demo] ${message}`),
})

let url = ''
try {
  url = app.ctx.get(WEB_SERVER).url
  const session = app.ctx.get(SESSION_SERVICE)
  // 会话目录布局由 core:persistence 决定（`--jsonl` 生效值 + 将来的租户段），脚本不自己拼
  const jsonl = app.ctx.get(SESSION_FILES).fileOf(asSessionId(SESSION))
  console.log(`[demo] 服务：${url}`)
  console.log(`[demo] 会话：${dirname(jsonl)}`)
  console.log(`[demo] 审计根：${runDir}`)
  console.log(`[demo] 客户 token：${WEB_TOKEN} · 坐席 token：${OPERATOR_TOKEN}（${OPERATOR_NAME}）`)

  // ① 客户先正常说一句，触发黄级审批票据（自动放行，保证日志完整可派生）
  const first = await call(url, 'POST', '/api/turn', WEB_TOKEN, { text: CUSTOMER_SAYS[0]! })
  show('客户 /api/turn', first)
  assert(first.status === 202, '首轮应 202')
  await waitFor(session, 'turn/end')
  assert(
    session.events().some((event) => String(event.type) === 'approval/asked'),
    '首轮应产生 approval/asked（否则演示没有审批票据）',
  )

  // ② 客户请求转人工
  const entered = await call(url, 'POST', '/api/handoff', WEB_TOKEN, { reason: REASON })
  show('客户 /api/handoff', entered)
  assert(entered.status === 200, '转人工应 200')
  assert(entered.body.includes('"active":true'), '摘要应 active:true')

  // ③ 坐席说三句
  for (const text of OPERATOR_SAYS) {
    const said = await call(url, 'POST', '/api/handoff/message', OPERATOR_TOKEN, { text })
    show(`坐席发言「${text}」`, said)
    assert(said.status === 200, '坐席发言应 200')
  }

  // ④ 客户在等待期间再发两条：202 落账但不驱动模型
  for (const text of CUSTOMER_SAYS.slice(1)) {
    const waiting = await call(url, 'POST', '/api/turn', WEB_TOKEN, { text })
    show(`客户等待中发言「${text}」`, waiting)
    assert(waiting.status === 202, '接管期间客户消息应 202')
    assert(waiting.body.includes('queued-for-operator'), '接管期间应返回 accepted=queued-for-operator')
  }

  // ⑤ 坐席交回（交接语进模型历史）
  const resumed = await call(url, 'POST', '/api/handoff/resume', OPERATOR_TOKEN, { handover: HANDOVER })
  show('坐席交回', resumed)
  assert(resumed.status === 200, '交回应 200')
  assert(resumed.body.includes('"active":false'), '交回后应 active:false')

  // ⑥ 断言会话日志
  const events = session.events()
  const types = events.map((event) => String(event.type))
  const at = (type: string): number => types.indexOf(type)
  assert(at('approval/asked') >= 0, '缺少 approval/asked')
  assert(at('handoff/requested') > at('approval/asked'), 'handoff/requested 应在审批之后')
  assert(at('handoff/resumed') > at('handoff/requested'), 'handoff/resumed 应在接管之后')
  assert(
    types.filter((type) => type === 'handoff/operator-message').length === OPERATOR_SAYS.length,
    `应有 ${String(OPERATOR_SAYS.length)} 条 handoff/operator-message`,
  )
  const waitingMessages = events.filter(
    (event) => String(event.type) === 'user/message' && (event.data as { source?: string }).source === 'handoff-waiting',
  )
  assert(waitingMessages.length === 2, '应有 2 条 handoff-waiting 用户消息')
  const handovers = events.filter(
    (event) => String(event.type) === 'user/message' && (event.data as { source?: string }).source === 'handoff-handover',
  )
  assert(handovers.length === 1, '应有 1 条 handoff-handover 交接语')

  const derived = session.deriveMessages()
  const derivedText = derived.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
  for (const text of OPERATOR_SAYS) assert(!derivedText.includes(text), `模型历史不应含人工发言「${text}」`)
  assert(derivedText.includes(HANDOVER), '模型历史应含交接语')

  const lines = readFileSync(jsonl, 'utf8').split('\n').filter((line) => line.trim() !== '')
  const fileText = lines.join('\n')
  assert(fileText.includes('handoff/operator-message'), 'session.jsonl 里应有人工发言事件')
  assert(fileText.includes('handoff/resumed'), 'session.jsonl 里应有交回事件')

  console.log('')
  console.log('[demo] ✔ 闭环断言全部通过')
  console.log(`[demo] 审计：pnpm bah audit --dir "${runDir}" --no-signature`)
  console.log(`[demo] 事件序列：${types.filter((type) => type.startsWith('handoff/')).join(' → ')}`)
  if (keep) {
    console.log('[demo] --keep：服务保持运行，Ctrl+C 退出')
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
} catch (error) {
  console.error(`[demo] ✘ ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await app.ctx.dispose('demo')
}
