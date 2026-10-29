/**
 * 独立重放 CLI（W15）。
 *
 * ```bash
 * npx tsx scripts/replay.ts --session s-xxx --dir sessions --tenant demo --verify
 * npx tsx scripts/replay.ts --session s-xxx --dir sessions --tenant demo --pack .ci-artifacts/evidence/s-xxx
 * npx tsx scripts/replay.ts --check-pack .ci-artifacts/evidence/s-xxx
 * npx tsx scripts/replay.ts --snapshots snapshots/headless-basic/session.jsonl
 * ```
 *
 * 隔离纪律：本脚本的 import 传递闭包只允许 `@bah/persistence` / `@bah/eval` / `@bah/util` / `node:*`；
 * 门禁 `verify-replay-isolation` 会逐文件检查（相对 import 也跟进去）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildSessionEvidencePack, verifySessionEvidencePack } from '../packages/eval/src/evidence/SessionEvidencePack.ts'
import { leafHash, sampleProofs, verifyMerkleProof } from '../packages/eval/src/snapshot/merkle.ts'
import { replaySession } from '../packages/persistence/src/replay/index.ts'
import { isTenantId } from '../packages/util/src/index.ts'

import { projectRoot } from './gate-lib.ts'

const args = process.argv.slice(2)
const root = projectRoot()
const json = args.includes('--json')

const session = readFlag('--session')
// 04：与 `bah audit` 同口径——`--dir` 是部署根，真正的会话根是 `<dir>/<tenant>`。
// 不拼租户会在 `<dir>/<session>` 找文件（session-missing），多租户时更可能读错租户。
const tenant = readFlag('--tenant') ?? 'demo'
// 租户是路径段：非法值必须在任何拼路径之前拒掉（与 `bah audit replay` 同判据）。
if (!isTenantId(tenant)) {
  process.stderr.write(`replay: --tenant 的值不是合法租户 ID：${tenant}\n`)
  process.exit(2)
}
const dir = resolve(root, readFlag('--dir') ?? 'sessions', tenant)
const key = readFlag('--key')
const packDir = readFlag('--pack')
const checkPack = readFlag('--check-pack')
const snapshotsPath = readFlag('--snapshots')

let failed = false

if (checkPack !== undefined) {
  const verified = verifySessionEvidencePack(resolve(root, checkPack))
  failed = !verified.ok
  if (json) {
    process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`)
  } else if (verified.ok) {
    process.stdout.write(`✔ 证据包离线校验通过：${checkPack}\n`)
  } else {
    process.stderr.write(`✘ 证据包校验失败：\n${verified.findings.map((line) => `  - ${line}`).join('\n')}\n`)
  }
}

if (snapshotsPath !== undefined) {
  const file = resolve(root, snapshotsPath)
  const { values, error } = readLeafValues(file)
  if (error !== undefined) {
    failed = true
    process.stderr.write(`✘ --snapshots：${error}\n`)
  } else if (values.length === 0) {
    failed = true
    process.stderr.write(`✘ ${snapshotsPath}：零条目，抽样无意义\n`)
  } else {
    const leaves = values.map((value) => leafHash(value))
    const proofs = sampleProofs(leaves, 0.1)
    const bad = proofs.filter((proof) => !verifyMerkleProof(proof))
    if (bad.length > 0) {
      failed = true
      process.stderr.write(`✘ Merkle 包含证明失败：${String(bad.length)}/${String(proofs.length)}\n`)
    } else {
      process.stdout.write(
        `✔ Merkle 抽样 10%：${String(proofs.length)}/${String(leaves.length)} 条证明离线验证通过（${snapshotsPath}）\n`,
      )
    }
  }
}

if (session !== undefined) {
  const result = replaySession({
    root: dir,
    sessionId: session,
    ...(key === undefined ? {} : { keyPath: resolve(root, key) }),
  })
  failed = failed || !result.ok
  const summary = {
    sessionId: result.sessionId,
    ok: result.ok,
    events: result.events.length,
    decisions: result.decisions.length,
    tickets: result.tickets.length,
    chain: result.chain,
    seqOk: result.seqOk,
    diffs: result.diffs,
    warnings: result.warnings,
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    const status = result.ok ? '✔' : '✘'
    process.stdout.write(
      `${status} replay session=${result.sessionId} events=${String(result.events.length)} ` +
        `decisions=${String(result.decisions.length)} tickets=${String(result.tickets.length)} ` +
        `chain=${result.chain.ok ? 'ok' : `broken@${String(result.chain.brokenAt ?? 0)}`} ` +
        `seq=${result.seqOk ? 'ok' : 'gap'} diff=${String(result.diffs.length)}\n`,
    )
    if (result.diffs.length > 0) {
      for (const diff of result.diffs) process.stderr.write(`  - ${diff}\n`)
    }
  }

  if (packDir !== undefined) {
    const pack = buildSessionEvidencePack({ replay: result, outDir: resolve(root, packDir) })
    const verified = verifySessionEvidencePack(pack.dir)
    failed = failed || !verified.ok
    process.stdout.write(
      `${verified.ok ? '✔' : '✘'} evidence-pack: ${pack.paths.join(' / ')}（${packDir}）\n`,
    )
    if (!verified.ok) {
      for (const finding of verified.findings) process.stderr.write(`  - ${finding}\n`)
    }
  }
}

if (session === undefined && checkPack === undefined && snapshotsPath === undefined) {
  process.stderr.write(
    '用法：npx tsx scripts/replay.ts --session <id> [--dir sessions] [--verify] [--pack <dir>]\n' +
      '      npx tsx scripts/replay.ts --check-pack <dir>\n' +
      '      npx tsx scripts/replay.ts --snapshots <file.jsonl|file.json>\n',
  )
  failed = true
}

if (!existsSync(dir) && session !== undefined) {
  process.stderr.write(`✘ 目录不存在：${dir}\n`)
  failed = true
}

process.exitCode = failed ? 1 : 0

function readFlag(name: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  return undefined
}

/**
 * 读取抽样叶子：`.jsonl` 每行一条（真实会话与判决链就是这种形态），
 * `.json` 取顶层数组或 `snapshots` 数组字段。
 *
 * 形状不符时返回 `error` 而不是抛栈：这条命令是给监管方与评委手敲的，
 * 输出必须是一句能照着改的话。
 */
function readLeafValues(file: string): { readonly values: unknown[]; readonly error?: string } {
  if (!existsSync(file)) return { values: [], error: `文件不存在：${file}` }
  const text = readFileSync(file, 'utf8')

  if (file.endsWith('.jsonl')) {
    const lines = text.split('\n').filter((line) => line.trim() !== '')
    const values: unknown[] = []
    for (const [index, line] of lines.entries()) {
      try {
        values.push(JSON.parse(line))
      } catch {
        return { values: [], error: `${file} 第 ${String(index + 1)} 行不是合法 JSON` }
      }
    }
    return { values }
  }

  try {
    const parsed = JSON.parse(text) as unknown
    if (Array.isArray(parsed)) return { values: parsed }
    const snapshots = (parsed as { snapshots?: unknown }).snapshots
    if (Array.isArray(snapshots)) return { values: snapshots }
    return { values: [], error: `${file} 既不是数组，也没有 snapshots 数组字段` }
  } catch {
    return { values: [], error: `${file} 不是合法 JSON` }
  }
}
