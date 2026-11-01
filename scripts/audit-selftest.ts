/**
 * `bah audit` 端到端自证（施工单 16 §4 步骤 4）。
 *
 * 临时目录造一条 42 事件的签名链 → 跑 `runAudit` → 断言通过 → 校验源目录零新增 → 清理。
 * 不触碰仓库 `sessions/`。
 */

import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runAudit } from '../packages/cli/src/cli/audit.ts'
import { SIGNED_TYPES, createSagaAudit } from '../packages/persistence/src/index.ts'

const EVENTS = 42
const TYPES = [
  'saga/created',
  'saga/step-planned',
  'saga/comp-issued',
  'saga/comp-result',
  'approval/decided',
] as const

function list(dir: string): string[] {
  const entries: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    entries.push(entry.name)
    if (entry.isDirectory()) {
      entries.push(...list(join(dir, entry.name)).map((name) => join(entry.name, name)))
    }
  }
  return entries.sort()
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'bah-audit-selftest-'))
  try {
    const chains = join(root, 'chains')
    mkdirSync(chains, { recursive: true })
    const { privateKey } = generateKeyPairSync('ed25519')
    const keyPath = join(root, 'saga-ed25519.pem')
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

    // 租户化后链目录是 `<部署根>/<tenant>/<saga>`；`--dir` 传部署根，CLI 自己拼 tenant。
    const tenantRoot = join(chains, 'demo')
    const writer = createSagaAudit({
      now: () => 1_700_000_000_000,
      rootDir: tenantRoot,
      tenant: 'demo',
      signingKeyPath: keyPath,
      signedTypes: [...SIGNED_TYPES],
      fsync: false,
      warn: (message) => console.error(message),
    })
    for (let index = 0; index < EVENTS; index += 1) {
      writer.append('selftest', TYPES[index % TYPES.length] as string, {
        sagaId: 'selftest',
        stepId: `s${index}`,
        compId: `c${index}`,
      })
    }

    const before = list(root)
    const out: string[] = []
    const err: string[] = []
    const code = await runAudit(
      [
        '--dir', chains,
        '--tenant', 'demo',
        '--saga', 'selftest',
        '--key', keyPath,
        '--no-projection',
        '--format', 'json',
      ],
      { out: (line) => out.push(line), err: (line) => err.push(line) },
      { root, now: () => 1_700_000_000_000 },
    )
    const after = list(root)

    // 空输出时 JSON.parse("") 只会抛 SyntaxError，把真正的退出码/错误行吞掉。
    const output = out.join('\n').trim()
    if (output === '') {
      console.error(
        `audit-selftest: 审计没有输出（exit=${String(code)}）：${err.join('; ') || 'stderr 为空'}`,
      )
      process.exitCode = 1
      return
    }
    let report: {
      ok: boolean
      chains: Array<{ events: number; signatureState: string; chainOk: boolean }>
    }
    try {
      report = JSON.parse(output) as typeof report
    } catch (error) {
      console.error(
        `audit-selftest: 审计输出不是 JSON（exit=${String(code)}）：${output.slice(0, 500)}；${String(error)}`,
      )
      process.exitCode = 1
      return
    }
    const failures: string[] = []
    if (code !== 0) failures.push(`退出码 ${code}`)
    if (!report.ok) failures.push('ok=false')
    if (report.chains.length !== 1) failures.push(`链数 ${report.chains.length}`)
    const chain = report.chains[0]
    if (chain === undefined) {
      failures.push('缺少链报告')
    } else {
      if (chain.events !== EVENTS) failures.push(`事件数 ${chain.events} != ${EVENTS}`)
      if (!chain.chainOk) failures.push('链不连续')
      if (chain.signatureState !== 'verified') failures.push(`签名态 ${chain.signatureState}`)
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) failures.push('审计在源目录新增了文件')
    if (err.length > 0) failures.push(`stderr: ${err.join('; ')}`)

    if (failures.length > 0) {
      console.error(`audit-selftest: 失败 —— ${failures.join('；')}`)
      process.exitCode = 1
      return
    }
    console.log(`audit-selftest: 造链 ${EVENTS} 事件 → 审计通过（源目录零新增）`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await main()
