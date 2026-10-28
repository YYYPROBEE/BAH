/**
 * 策略外置快照回放（策略外置 S4 / PE-44；施工单 12 §3 / §5 的 T-AUD-005、T-AUD-006）。
 *
 * **CI 永远只读**：默认 `replay` 模式，不写任何文件；要重录得显式设 `BAH_SNAPSHOT_RECORD=1`
 * （Windows PowerShell：`$env:BAH_SNAPSHOT_RECORD='1'; pnpm test:snapshot`）。
 *
 * 本场景比 headless-basic 多回答一个问题：**判决是不是真的来自外置文件**。
 * 同一份 800 元白名单转账，legacy `tier.ts` 是黄级，演示 bundle 的 `TR-004-single-large`
 * 是红级；快照里必须同时留下"红 + 规则 ID + demo 版本"三件套。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { decide } from '@bah/bank'
import { JsonlPersistence } from '@bah/persistence'
import { compareEvents, loadSnapshot, recordSnapshot } from '@bah/test-support'
import { canonicalJson, sha256Hex } from '@bah/util'
import { describe, expect, it } from 'vitest'

import { CASE, runRecord, runReplay } from './scenario.ts'

/** 本用例快照目录（`snapshots/<case>/`）。 */
const DIR = join(fileURLToPath(new URL('../', import.meta.url)), CASE.name)

/** 录制开关：只有显式设置才写文件（CI 不设 → 只读回放）。 */
const RECORDING = process.env['BAH_SNAPSHOT_RECORD'] === '1'

/**
 * 复制一份快照产物。
 *
 * 为什么不用 `fs.cpSync`：本机 Node 22.17 在 Windows 上对含非 ASCII 的源目录调
 * `cpSync(..., { recursive: true })` 会直接 abort 进程（`STATUS_STACK_BUFFER_OVERRUN`）。
 * 这里只复制三份产物，逐个 read/write 既明确又不会碰到那个坑。
 */
function copyArtifacts(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const file of ['session.jsonl', 'llm.jsonl', 'scenario.json']) {
    writeFileSync(join(to, file), readFileSync(join(from, file)))
  }
}

describe(`快照回放 · ${CASE.name}`, () => {
  it('T-AUD-005 record → replay：无密钥回放，事件流逐条全等', async () => {
    if (RECORDING) {
      const summary = await recordSnapshot({ dir: DIR, run: runRecord })
      expect(summary.events).toBeGreaterThan(0)
      // 一个 turn 至少一次模型调用；带工具调用的 step 会有第二次
      expect(summary.exchanges).toBeGreaterThanOrEqual(CASE.prompts.length)
    }

    const snapshot = loadSnapshot(DIR)
    const replayed = await runReplay(snapshot)
    const comparison = compareEvents(snapshot.events, replayed)

    // 报错时把差异打出来（而不是只说"不一样"）
    expect(comparison.diffs).toEqual([])
    expect(comparison.equal).toBe(true)
  })

  it('T-AUD-006 同一快照两次回放全等（确定性时钟 + 无网络）', async () => {
    const snapshot = loadSnapshot(DIR)
    const first = await runReplay(snapshot)
    const second = await runReplay(snapshot)

    expect(second).toEqual(first)
    expect(compareEvents(first, second).equal).toBe(true)
    // 两次回放也都必须与录制全等，否则"确定性"只证明了两头错得一样
    expect(compareEvents(snapshot.events, second).equal).toBe(true)
  })

  it('录制产物就是真会话日志：运行时的 JsonlPersistence 能原样读回（格式不漂移）', () => {
    const snapshot = loadSnapshot(DIR)
    const handle = new JsonlPersistence({ fsync: false, warn: () => {} }).open(DIR)

    expect(String(handle.header.sessionId)).toBe(snapshot.meta.sessionId)
    expect(handle.events()).toEqual(snapshot.events)
  })

  it('T-PE-001 判决来自外置 bundle：demo 版本 + TR-004，而同一输入 legacy 是黄级', () => {
    const snapshot = loadSnapshot(DIR)
    const events = snapshot.events as unknown as readonly {
      readonly type: string
      readonly data: {
        readonly name?: string
        readonly handle?: string
        readonly version?: string
        readonly level?: string
        readonly reason?: string
        readonly policyVersion?: string
        readonly engineSource?: string
        readonly ruleIds?: readonly string[]
        readonly evidence?: {
          readonly inputDigest?: string
          readonly input: {
            readonly subject: { readonly userId: string }
            readonly action: { readonly declared: 'green' | 'yellow' | 'red' }
            readonly preview: {
              readonly amountCents: number
              readonly dailyUsedCents: number
              readonly dailyLimitCents: number
              readonly payee: { readonly binding: 'new' | 'whitelist' }
            }
            readonly state: { readonly riskyCallsInTurn: number; readonly verifyLocked: boolean }
            readonly limits: { readonly dailyLimitCents: number }
            readonly params: { readonly riskyCallThreshold: number }
          }
        }
      }
    }[]

    const loaded = events.find((event) => event.type === 'policy/bundle-loaded')
    expect(loaded?.data.handle).toBe('bank-tier-demo/1.1.0')
    expect(loaded?.data.version).toContain('bank-tier-demo/1.1.0+sha256:')

    const decided = events.find(
      (event) => event.type === 'tier/decided' && event.data.name === 'transfer_create',
    )
    expect(decided, '快照里必须有一条 transfer_create 的 tier/decided').toBeDefined()
    expect(decided?.data).toMatchObject({
      level: 'red',
      reason: 'daily-limit',
      engineSource: 'bundle',
    })
    expect(decided?.data.policyVersion).toContain('bank-tier-demo/1.1.0+sha256:')
    expect(decided?.data.ruleIds).toContain('TR-004-single-large')

    // 对照：把证据里的输入原样喂给 legacy `tier.ts`，它必须判黄——否则"判决来自外置文件"
    // 这句话就不成立（只是两套实现碰巧都判红）。
    const input = decided?.data.evidence?.input
    expect(input, 'bundle 判决必须带 evidence.input').toBeDefined()
    if (input === undefined) return
    // 证据必须自洽：inputDigest = sha256(canonicalJson(input))。只比对"事件里有 input"
    // 不够——把 evidence 改一个字段，T-PE-001 仍可能拿被改过的输入自证。
    expect(decided?.data.evidence?.inputDigest).toBe(`sha256:${sha256Hex(canonicalJson(input))}`)
    const legacy = decide({
      name: 'transfer_create',
      declared: input.action.declared,
      config: {
        dailyTransferLimitCents: input.limits.dailyLimitCents,
        riskyOps: [],
        riskyCallThreshold: input.params.riskyCallThreshold,
      },
      state: {
        userId: input.subject.userId,
        riskyCallsInTurn: input.state.riskyCallsInTurn,
        verifyLocked: input.state.verifyLocked,
      },
      preview: {
        amountCents: input.preview.amountCents,
        dailyUsedCents: input.preview.dailyUsedCents,
        dailyLimitCents: input.preview.dailyLimitCents,
        payee: { name: '王建国', binding: input.preview.payee.binding },
      },
    })
    expect(legacy).toMatchObject({ kind: 'ask', level: 'yellow', reason: 'declared' })
  })

  it('负控：篡改 tier/decided.evidence 一个字段 → 比对必须红', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-policy-evidence-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex(
        (line) => line.includes('"type":"tier/decided"') && line.includes('"name":"transfer_create"'),
      )
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as {
        data: { evidence: { input: { preview: { amountCents: number } } } }
      }
      tampered.data.evidence.input.preview.amountCents = 1
      lines[index] = JSON.stringify(tampered)
      writeFileSync(path, lines.join('\n'), 'utf8')

      const comparison = compareEvents(loadSnapshot(DIR).events, loadSnapshot(copy).events)
      expect(comparison.equal).toBe(false)
      expect(comparison.diffs[0]).toBeDefined()
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  it('负控：篡改录制里的一条事件 → 比对必须红（护栏真的会响）', () => {
    const copy = mkdtempSync(join(tmpdir(), 'bah-snapshot-tamper-'))
    try {
      copyArtifacts(DIR, copy)
      const path = join(copy, 'session.jsonl')
      const lines = readFileSync(path, 'utf8').split('\n')
      const index = lines.findIndex((line) => line.includes('"type":"assistant/message"'))
      expect(index).toBeGreaterThan(0)

      const tampered = JSON.parse(lines[index]!) as { data: { content: unknown } }
      tampered.data.content = [{ type: 'text', text: '被人改过的回复' }]
      lines[index] = JSON.stringify(tampered)
      writeFileSync(path, lines.join('\n'), 'utf8')

      const comparison = compareEvents(loadSnapshot(DIR).events, loadSnapshot(copy).events)
      expect(comparison.equal).toBe(false)
      expect(comparison.diffs[0]).toBeDefined()
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
})
