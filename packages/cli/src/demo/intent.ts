/**
 * `pnpm demo:intent`：意图平面的离线演示（§7.3 / E1 的验收面）。
 *
 * 不配任何密钥、不联网：`provider: router` 读消息做确定性路由，
 * 意图判定全部发生在 `intent_resolve` 的纯函数里。
 *
 * **诚实口径**：router 不是自然语言理解，它只把「该发射意图工具的话语形态」认出来；
 * 演示里的历史参数来自 `demoMemory` 夹具（确定性假记忆），不是真实记忆库。
 *
 * 会话目录固定 `.tmp-demo-intent/`（不入库），每次运行前清空。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { boot, createCatalog } from '@bah/host'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'
import { DEFAULT_TENANT_ID } from '@bah/util'

import type { SessionId } from '@bah/core'
import { loadBundles } from '../bundles.ts'
import { readLayers, readProfile } from '../profile.ts'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SCRATCH = join(REPO_ROOT, '.tmp-demo-intent')

/** 演示输入：四类意图各一例 + 槽位缺失一例。 */
const PROMPTS = [
  '上次那个转账再来一次',
  '转500给他',
  '我爱人生日快到了',
  '把转账卡的钱还上',
  '把那边的事接着办',
] as const

/**
 * 演示夹具（确定性假记忆）。
 *
 * 与 `packages/llm/src/demo/router.ts` 的 `recall` 分支同源：
 * 改这里的收款人/金额，必须同步改 router 的 `transfer_preview` 参数。
 */
const DEMO_MEMORY = [
  {
    unitId: 'demo-transfer-1',
    scene: 'transfer',
    confidence: 0.8,
    fields: { payee: '王建国', amountCents: 80000 },
  },
] as const

const OVERLAY = `
- id: intent:plane
  config:
    demoMemory:
${DEMO_MEMORY.map(
  (entry) => `      - unitId: ${entry.unitId}
        scene: ${entry.scene}
        confidence: ${String(entry.confidence)}
        fields:
${Object.entries(entry.fields)
  .map(([name, value]) => `          ${name}: ${String(value)}`)
  .join('\n')}`,
).join('\n')}
`

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : ''))
    .join('')
}

async function main(): Promise<void> {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  const overlayPath = join(SCRATCH, 'overlay.yml')
  writeFileSync(overlayPath, OVERLAY, 'utf8')

  const profile = readProfile(REPO_ROOT, 'headless')
  const bundles = await loadBundles(REPO_ROOT, profile.bundles)
  const { layers } = readLayers(REPO_ROOT, profile, {
    home: join(SCRATCH, 'no-home'),
    overlays: [overlayPath],
  })

  // 固定钟：演示 transcript 要可复现；每次读取 +1ms（与快照同源的口径）
  let tick = 1_700_000_000_000
  const now = (): number => {
    const value = tick
    tick += 1
    return value
  }
  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: {
      sessionId: 's-demo-intent' as SessionId,
      tenantId: DEFAULT_TENANT_ID,
      now,
      jsonlDir: SCRATCH,
    },
  })

  try {
    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
    if (agent === undefined) throw new Error('demo:intent：profile 里没有活体 agent')
    const session = app.ctx.get(SESSION_SERVICE)

    let cursor = 0
    for (const [index, prompt] of PROMPTS.entries()) {
      process.stdout.write(`\n[${String(index + 1)}] input> ${prompt}\n`)
      agent.send(prompt)
      await agent.run()
      const events = session.events().slice(cursor)
      cursor = session.events().length
      for (const event of events) {
        if (event.type === 'tool/call') {
          const data = event.data as { name: string; args: unknown }
          process.stdout.write(`    tool/call  ${data.name} ${JSON.stringify(data.args)}\n`)
        } else if (event.type === 'tool/result') {
          const data = event.data as { name: string; isError: boolean; content?: unknown }
          const text = textOf(data.content).replace(/\s+/g, ' ').slice(0, 260)
          process.stdout.write(`    tool/result ${data.name}${data.isError ? '（失败）' : ''} ${text}\n`)
        } else if (event.type === 'assistant/message') {
          const data = event.data as { content?: unknown }
          const text = textOf(data.content).trim()
          if (text.length > 0) process.stdout.write(`    assistant  ${text}\n`)
        }
      }
    }
    process.stdout.write(`\n（会话目录 ${SCRATCH}；确定性正则路由，不是 URL/模型调用）\n`)
  } finally {
    await app.dispose('demo-finished')
  }
}

await main()
