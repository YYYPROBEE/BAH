/**
 * 生成 saga 审计链的 Ed25519 私钥（开发/演示用）。
 *
 * 为什么需要它：`saga/comp-issued` 与 `saga/comp-result` 在签名白名单里（SA-11），
 * W12 打开真冲正后，补偿提交会写这两类事件；缺私钥时 `commitSegment` 会
 * `commit-failed: signing-key-missing`，补偿无法落账。
 *
 * 用法：
 *   npx tsx scripts/gen-saga-key.ts            # 写 keys/saga-ed25519.pem（已存在则拒绝）
 *   npx tsx scripts/gen-saga-key.ts --force    # 覆盖（旧链将无法再验签，慎用）
 *
 * 私钥不得进仓库：`keys/` 已写进 .gitignore。生产应改用 KMS/HSM 托管（当前未做）。
 */

import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_PATH = 'keys/saga-ed25519.pem'

const args = process.argv.slice(2)
const force = args.includes('--force')
const target = resolve(args.find((arg) => !arg.startsWith('--')) ?? DEFAULT_PATH)

if (existsSync(target) && !force) {
  console.error(`gen-saga-key: ${target} 已存在。覆盖会让旧链无法再验签；确需覆盖请加 --force。`)
  process.exit(1)
}

mkdirSync(dirname(target), { recursive: true })
writeFileSync(
  target,
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { mode: 0o600 },
)
console.log(`gen-saga-key: 已生成 ${target}（0600）；不要提交，keys/ 已被 .gitignore 忽略。`)
