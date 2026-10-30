/**
 * 审查探针 B：桌面 store.frameKey 与 @bah/channels/web 的 frameKey 逐帧比对。
 * 运行（仓库根）：npx tsx docs/evidence/2026-10-30-web-choice/probes/B-framekey-probe.ts
 */
import { frameKey as serverFrameKey } from '../../../../packages/channels/src/web/frames.ts'
import { frameKey as storeFrameKey } from '../../../../apps/web/src/store.js'

const samples: Array<Record<string, unknown>> = [
  { kind: 'turn', seq: 1, turn: 1, phase: 'start' },
  { kind: 'turn', seq: 2, turn: 1, phase: 'end' },
  { kind: 'message', seq: 3 },
  { kind: 'delta', seq: 4, at: 1 },
  { kind: 'tool', seq: 5, callId: 'call-create' },
  { kind: 'approval', seq: 6, ticketId: 'ticket:1' },
  { kind: 'approval-closed', seq: 7, ticketId: 'ticket:1' },
  { kind: 'notice', seq: 8 },
  { kind: 'audit', seq: 9 },
  { kind: 'dag', seq: 10, turn: 2 },
  { kind: 'choice', seq: 11, callId: 'call-ask' },
  { kind: 'goal', seq: 12 },
  { kind: 'todo', seq: 13, turn: 3, planId: 'p1' },
  { kind: 'effects', seq: 14, turn: 4 },
  { kind: 'handoff', seq: 15 },
  { kind: 'handoff-warn', seq: 16 },
  { kind: 'snapshot', maxSeq: 16 },
]

let mismatches = 0
for (const frame of samples) {
  const server = serverFrameKey(frame as never)
  const store = storeFrameKey(frame as never)
  const ok = server === store
  if (!ok) mismatches += 1
  console.log(`${ok ? 'OK  ' : 'DIFF'} ${String(frame['kind']).padEnd(16)} server=${server} store=${store}`)
}
console.log(`\n样例 ${String(samples.length)} 个，不一致 ${String(mismatches)} 个`)
process.exitCode = mismatches === 0 ? 0 : 1
