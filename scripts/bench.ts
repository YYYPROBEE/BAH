/**
 * 性能基线（D1）。**不是必过门禁**——数字会随机器抖动，进 CI 必过面只会训练人忽略红灯。
 *
 * 跑法：
 *
 * ```bash
 * npx tsx scripts/bench.ts              # 全量
 * npx tsx scripts/bench.ts --only=boot  # 单项：boot|turn|session|sse|log
 * ```
 *
 * 五项各自回答一个问题：
 *
 * | 项 | 问题 | 口径 |
 * |---|---|---|
 * | boot | 冷启动多久 | 真实 `boot()`（headless profile），不含进程启动 |
 * | turn | 单轮多久 | 真实 `agent.send` + `agent.run()`（router 离线模型） |
 * | session | 长会话是否退化 | 同一会话 100 轮，看 p50/p95 是否随轮次爬升 |
 * | sse | 广播扇出成本 | 10 条连接 × 200 帧，纯内存桩，不含网络 |
 * | log | 大日志读取成本 | 合成 jsonl 的 `readFileSync + 逐行 JSON.parse`（**代理指标**，不是真实会话回放） |
 *
 * 纪律：不写"高并发"结论。单机演示的定位决定了这些数字只用来抓**退化**，
 * 不用来对外承诺吞吐。数据落到 `docs/performance.md`，本脚本只打印。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SESSION_FILES, boot, createCatalog } from '@bah/host'
import type { WebFrame, WebProjector } from '@bah/channels'
import { AGENTS_SERVICE, SESSION_SERVICE } from '@bah/runtime'

import { createSseHub } from '../packages/host/src/boot/plugins/web/sse.ts'
import { loadBundles } from '../packages/cli/src/bundles.ts'
import { readLayers, readProfile } from '../packages/cli/src/profile.ts'

/** 单项开关（`--only=boot`）。 */
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)

/** 是否要跑某一项。 */
function enabled(name: string): boolean {
  return only === undefined || only === name
}

/** 分位数（`values` 会被原地排序；p 取 0–1）。 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index] as number
}

/** 毫秒格式化（保留两位小数，避免 0.00 看起来像没测）。 */
function ms(value: number): string {
  return `${value.toFixed(2)}ms`
}

/** 一行的统计摘要。 */
function summarize(label: string, samples: readonly number[]): string {
  const list = [...samples]
  return [
    label.padEnd(18),
    `n=${String(list.length).padStart(3)}`,
    `p50=${ms(percentile(list, 0.5))}`.padEnd(14),
    `p95=${ms(percentile(list, 0.95))}`.padEnd(14),
    `max=${ms(Math.max(...list)).padEnd(12)}`,
  ].join(' ')
}

/** 堆内存增量（MB，一位小数）。 */
function heapDeltaMb(before: number): string {
  const delta = (process.memoryUsage().heapUsed - before) / 1024 / 1024
  return `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}MB`
}

const root = process.cwd()
const profile = readProfile(root, 'headless')
const bundles = await loadBundles(root, profile.bundles)

/** 造一个临时运行目录并启动一次应用。 */
async function bootOnce(sessionId: string, dir: string): Promise<Awaited<ReturnType<typeof boot>>> {
  const { layers } = readLayers(root, profile, { home: join(dir, '.no-home'), overlays: [] })
  return boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    // 会话 id 在 boot 里是 branded 类型；脚本按 demo-compaction 的同一写法转一下
    run: { sessionId: sessionId as never, now: () => Date.now(), jsonlDir: dir },
  })
}

console.log('BAH 性能基线（D1）—— 单机演示定位，数字用于抓退化，不是吞吐承诺')
console.log(`node ${process.version} · ${process.platform} · ${process.arch}`)
console.log('')

/* ───────────────────────────── 1. 冷启动 ───────────────────────────── */

if (enabled('boot')) {
  const samples: number[] = []
  for (let index = 0; index < 3; index += 1) {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bench-boot-'))
    const started = performance.now()
    const app = await bootOnce(`s-bench-boot-${String(index)}`, dir)
    samples.push(performance.now() - started)
    await app.dispose('bench')
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(summarize('boot（冷启动）', samples))
}

/* ──────────────────────── 2/3. 单轮与 100 轮会话 ──────────────────────── */

if (enabled('turn') || enabled('session')) {
  const dir = mkdtempSync(join(tmpdir(), 'bah-bench-turn-'))
  const heapBefore = process.memoryUsage().heapUsed
  const app = await bootOnce('s-bench-turn', dir)
  try {
    const agent = app.ctx.get(AGENTS_SERVICE).list()[0]
    if (agent === undefined) throw new Error('bench: profile 里没有 core:agent 行')

    const oneTurn = async (): Promise<number> => {
      const started = performance.now()
      agent.send('这个月账单能帮我汇总一下吗')
      await agent.run()
      return performance.now() - started
    }

    // 首轮单独计：它包含提示词装配与首个 turn 的一次性成本
    const first = await oneTurn()
    if (enabled('turn')) console.log(summarize('turn（首轮）', [first]))

    if (enabled('session')) {
      const samples: number[] = []
      for (let index = 1; index < 100; index += 1) samples.push(await oneTurn())
      console.log(summarize('session（100 轮）', samples))
      console.log(
        `${''.padEnd(18)} 前 10 轮 p50=${ms(percentile(samples.slice(0, 10), 0.5))}` +
          ` / 后 10 轮 p50=${ms(percentile(samples.slice(-10), 0.5))}` +
          ` · 堆增量 ${heapDeltaMb(heapBefore)}`,
      )
      const events = app.ctx.get(SESSION_SERVICE).events().length
      console.log(
        `${''.padEnd(18)} 事件数 ${String(events)} · 日志 ${String(app.ctx.get(SESSION_FILES).fileOf('s-bench-turn' as never))}`,
      )
    }
  } finally {
    await app.dispose('bench')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ──────────────────────────── 4. SSE 扇出 10 连接 ──────────────────────────── */

if (enabled('sse')) {
  const CHANNELS = 10
  const ROUNDS = 200
  const projector = {
    snapshot: (): WebFrame => ({ kind: 'snapshot', sessionId: 's-bench-sse', maxSeq: 0, frames: [] }),
  } as unknown as WebProjector
  const hub = createSseHub({
    projector,
    sessionId: () => 's-bench-sse',
    heartbeatMs: 60_000,
    now: () => Date.now(),
  })
  const written: number[] = []
  for (let index = 0; index < CHANNELS; index += 1) {
    const res = {
      destroyed: false,
      writableLength: 0,
      writeHead: () => res,
      write: () => {
        written.push(1)
        return true
      },
      end: () => res,
      destroy: () => res,
    }
    const req = { on: () => req }
    hub.attach(req as never, res as never, 0)
  }
  const samples: number[] = []
  const frame = { kind: 'delta', seq: 1 } as unknown as WebFrame
  for (let index = 0; index < ROUNDS; index += 1) {
    const started = performance.now()
    hub.publish(frame)
    samples.push(performance.now() - started)
  }
  hub.dispose()
  console.log(summarize(`sse（${String(CHANNELS)} 连接）`, samples))
  console.log(`${''.padEnd(18)} 累计写帧 ${String(written.length)}（含建连快照）`)
}

/* ───────────────────────────── 5. 大日志读取 ───────────────────────────── */

if (enabled('log')) {
  for (const mb of [1, 10]) {
    const dir = mkdtempSync(join(tmpdir(), 'bah-bench-log-'))
    const file = join(dir, 'session.jsonl')
    // 合成行：形状贴近真实会话事件（type + data），一行约 200B
    const line = JSON.stringify({
      seq: 1,
      at: 1_700_000_000_000,
      type: 'tool/result',
      data: { callId: 'c-1', name: 'account_balance', isError: false, durationMs: 3 },
    })
    const rows = Math.ceil((mb * 1024 * 1024) / (line.length + 1))
    writeFileSync(file, `${Array.from({ length: rows }, () => line).join('\n')}\n`)

    const samples: number[] = []
    for (let index = 0; index < 5; index += 1) {
      const started = performance.now()
      const text = readFileSync(file, 'utf8')
      let count = 0
      for (const row of text.split('\n')) {
        if (row.length === 0) continue
        JSON.parse(row)
        count += 1
      }
      samples.push(performance.now() - started)
      if (index === 0 && count !== rows) throw new Error('bench: 行数对不上')
    }
    console.log(summarize(`log（${String(mb)}MB）`, samples))
    rmSync(dir, { recursive: true, force: true })
  }
  console.log(`${''.padEnd(18)} 口径：readFileSync + split + 逐行 JSON.parse，代理指标`)
}
