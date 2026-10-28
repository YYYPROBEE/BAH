/**
 * `pnpm policy:sign <bundle-dir> --key <private.pem> [--key-version <n>]`：
 * 给一个已锁定的 bundle 生成 `bundle.sig`（Ed25519）。
 *
 * 为什么先要求 lock 一致：签名覆盖的是**两个摘要**。lock 过期时签出来的
 * 是"旧内容 + 新文件"的混合体，验签能过但语义已经变了——所以这里先 `--check`
 * 式的编译（`verifyLock: true`），锁不上就直接拒绝。
 *
 * 私钥只从命令行/环境变量读路径，**不读仓库内文件**（脚本不做路径白名单之外的事）；
 * 生成密钥用 `pnpm policy:keygen`。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { readBundleFiles } from '../packages/policy/src/load.ts'
import { compileBundle } from '../packages/policy/src/compile.ts'
import { compileRuleBundle } from '../packages/policy/src/sentry-rules.ts'
import { signPayload, signingPayload } from '../packages/policy/src/signature.ts'
import { fail, parseArgs, toolNames, usage } from './policy-cli.ts'

const args = parseArgs(process.argv.slice(2))
const dir = args.positional[0]
const keyPath = flagValue('--key')
const keyVersionRaw = flagValue('--key-version')
const keyVersion = keyVersionRaw === undefined ? 1 : Number(keyVersionRaw)

if (dir === undefined || keyPath === undefined) {
  process.exitCode = usage(
    '用法：pnpm policy:sign <bundle-dir> --key <private.pem> [--key-version N] [--json]',
  )
} else if (!Number.isInteger(keyVersion) || keyVersion < 1) {
  process.exitCode = usage('--key-version 必须是正整数')
} else {
  try {
    // 直接编译、跳过"已有签名的验签"：重签就是要覆盖旧 bundle.sig
    const files = readBundleFiles(dir)
    const kind = /^kind:\s*([A-Za-z0-9._-]+)\s*$/m.exec(files.files['bundle.yml'] ?? '')?.[1]
    const result =
      kind === 'sentry.rules'
        ? compileRuleBundle(files, { verifyLock: true })
        : compileBundle(files, { toolNames: toolNames(), verifyLock: true, withCorpus: false })
    const payload = signingPayload(result.compiled.ir, result.compiled.descriptor)
    const value = signPayload(readFileSync(keyPath, 'utf8'), payload)
    writeFileSync(join(dir, 'bundle.sig'), `${JSON.stringify({ keyVersion, value }, null, 2)}\n`, 'utf8')
    if (args.flags.has('json')) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            bundle: result.compiled.descriptor.policyVersion,
            keyVersion,
            signature: join(dir, 'bundle.sig'),
          },
          null,
          2,
        ),
      )
    } else {
      console.log(`✔ 已签名 ${result.compiled.descriptor.policyVersion}（keyVersion=${String(keyVersion)}）`)
      console.log(`  bundle.sig  ${join(dir, 'bundle.sig')}`)
    }
  } catch (error) {
    process.exitCode = fail(error)
  }
}

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline !== undefined) return inline.slice(name.length + 1)
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}
