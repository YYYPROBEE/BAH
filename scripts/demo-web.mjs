/**
 * 起 Web 演示：`pnpm demo:web`。
 *
 * 与 `pnpm web` 的唯一区别：先读仓库根的 `.env.local`，把密钥灌进子进程环境。
 *
 * 为什么不在 profile 里写密钥、也不提供 `--key` 参数：
 * profile 进版本库，`--key` 进进程列表与 shell history。`.env.local` 被
 * `.gitignore` 的 `.env*` 挡住，是这三条路里唯一不会泄漏的。
 *
 * `.env.local` 形如（键值不带引号，`#` 开头为注释）：
 *
 * ```text
 * BAH_MODEL_KEY=<your-key>
 * ```
 *
 * **主演示不需要这个文件**：`profiles/web/patch.yml` 默认 `provider: router`（离线、
 * 确定性；只认查余额 / 转账）。`BAH_MODEL_KEY` 只在手动切 DeepSeek 时使用。
 *
 * 本脚本**不启动** RAG sidecar，也不生成知识 token：需要知识问答时用 `pnpm demo:rag`，
 * 或先按 `docs/knowledge.md` 起 sidecar 并把同一 `BAH_KNOWLEDGE_TOKEN` 注入本进程。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import { existingDemoToken } from './lib/demo-token.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env.local')
const runsRoot = join(root, 'sessions')
mkdirSync(runsRoot, { recursive: true })
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
/**
 * 一次性目录只放**本次运行的密钥与补丁**，不再当会话根。
 *
 * 改这一行的原因（2026-11-02）：会话根原先跟着 `mkdtemp` 跑，每次演示都是新目录，
 * 于是"历史对话"永远只有当前这一条——功能做了也看不见。会话根改为固定的
 * `runsRoot`（= `sessions`），与缺省启动 `pnpm bah --profile web --serve` 落到
 * **同一个**租户根 `sessions/<tenant>`，历史才能跨重启累积。
 *
 * 密钥留在一次性目录是刻意的：`saga-ed25519.pem` 只对本次 run 的链负责，
 * 固定目录会让旧密钥残留、新旧链混签。
 */
const runDir = mkdtempSync(join(runsRoot, `demo-${stamp}-`))

/** 读 `.env.local`（宽松解析：只认 `KEY=VALUE`，空行与 `#` 注释跳过）。 */
function readEnvFile(path) {
  const values = {}
  if (!existsSync(path)) return values
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')
    if (key !== '' && value !== '') values[key] = value
  }
  return values
}

const fromFile = readEnvFile(envFile)
// 已存在的环境变量优先：CI / 临时覆盖不该被本地文件顶掉
const env = { ...fromFile, ...process.env }

// W06：知识库签名门需要密钥。演示用公开的完整性测试密钥并明确警告。
if (env.BAH_KNOWLEDGE_KEY === undefined || env.BAH_KNOWLEDGE_KEY === '') {
  env.BAH_KNOWLEDGE_KEY = 'demo-key-not-for-prod'
  console.warn(
    '[demo:web] 未设置 BAH_KNOWLEDGE_KEY，使用公开演示密钥（仅完整性校验；生产必须换独立密钥并重签）',
  )
}

const keyName = 'BAH_MODEL_KEY'
if (env[keyName] === undefined || env[keyName] === '') {
  console.log('[demo:web] 未设置 BAH_MODEL_KEY：主路径为离线 router，不需要密钥。')
} else {
  console.log(
    `[demo:web] 检测到 ${keyName}；当前 profile 走离线 router，密钥不会被使用` +
      '（切 DeepSeek 时才需要，见 profiles/web/patch.yml 注释）。',
  )
}

if (env.BAH_KNOWLEDGE_TOKEN === undefined || env.BAH_KNOWLEDGE_TOKEN === '') {
  console.log(
    '[demo:web] 未设置 BAH_KNOWLEDGE_TOKEN：若 7801 sidecar 已启动，宿主会告警且知识工具 401；' +
      '需要知识问答时用 pnpm demo:rag，或注入与 sidecar 相同的 token。',
  )
} else {
  // 两个 token 变量都设但不一致时，sidecar 取 BAH_RAG_TOKEN、宿主取 BAH_KNOWLEDGE_TOKEN，
  // 必然 401。这里只做冲突检测（本脚本不启动 sidecar，不生成 token）。
  try {
    existingDemoToken(env)
  } catch (error) {
    console.warn(`[demo:web] ${error.message}`)
  }
}

// B5：给 saga 补偿链生成**一次性** Ed25519 私钥（写进本次 runDir/keys/，0600），
// 并用 --patch 把 `bank:saga-audit.signingKeyPath` 指过去。
// 为什么不提交 key、也不写死路径：sessions/ 与 keys/ 都被 .gitignore 挡住；
// 一次性密钥只对本 run 的链负责，退出即随 runDir 留档（不打印、不上传）。
// 生产必须换 KMS/HSM 托管密钥——这条在 docs/deploy.md §3.1 有明说。
let sagaKeyPath
try {
  sagaKeyPath = join(runDir, 'keys', 'saga-ed25519.pem')
  mkdirSync(dirname(sagaKeyPath), { recursive: true })
  writeFileSync(
    sagaKeyPath,
    generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  )
  const patchPath = join(runDir, 'saga-key.patch.yml')
  // patch 语义是整块替换：bank:saga-audit 基础装配无 config，这里只补 signingKeyPath 一个键
  writeFileSync(
    patchPath,
    [
      '# demo:web 生成的一次性补丁：让 saga 补偿链在本 run 有签名密钥（B5）。',
      '# 密钥只对本 run 有效；不要把这两个路径写进任何对外材料。',
      '- id: bank:saga-audit',
      `  config:`,
      `    signingKeyPath: ${sagaKeyPath.replaceAll('\\', '/')}`,
      '',
    ].join('\n'),
    'utf8',
  )
  console.log(`[demo:web] 已生成一次性 saga 签名密钥：${sagaKeyPath}（0600，不打印内容）`)
} catch (error) {
  // 生成失败不挡演示：退回缺钥行为（补偿 commit-failed: signing-key-missing），但要说明
  sagaKeyPath = undefined
  console.warn(`[demo:web] saga 签名密钥生成失败（${error.message}）；补偿将走缺钥降级路径`)
}

// 租户：01 起 `--tenant` 是部署输入。演示脚本**透传**它（缺省 demo），
// 否则 `pnpm demo:web -- --tenant other` 会静默按 demo 起服务，而操作者以为在为 other 服务。
const tenantArgIndex = process.argv.indexOf('--tenant')
const tenant =
  tenantArgIndex > 0 && process.argv[tenantArgIndex + 1] !== undefined
    ? process.argv[tenantArgIndex + 1]
    : 'demo'

console.log(`[demo:web] 会话根：${join(runsRoot, tenant)}（历次演示累积在同一处）`)
console.log(`[demo:web] 本次密钥目录：${runDir}`)
console.log(
  `[demo:web] 审计（链连续性，无密钥）：pnpm bah audit --dir "${runsRoot}" --tenant ${tenant} --no-signature`,
)
if (sagaKeyPath !== undefined) {
  console.log(
    `[demo:web] 审计（完整验签，用本次一次性密钥）：pnpm bah audit --dir "${runsRoot}" --tenant ${tenant} --key "${sagaKeyPath}"`,
  )
} else {
  console.log(
    `[demo:web] 审计（完整验签，需 keys/saga-ed25519.pem）：pnpm bah audit --dir "${runsRoot}" --tenant ${tenant}`,
  )
}

const child = spawn(
  process.execPath,
  [
    join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    'packages/cli/src/main.ts',
    '--profile',
    'web',
    '--serve',
    '--jsonl',
    runsRoot,
    '--tenant',
    tenant,
    // B5：签名密钥补丁（层序最外）；密钥生成失败时不传，保持缺钥行为
    ...(sagaKeyPath === undefined ? [] : ['--patch', join(runDir, 'saga-key.patch.yml')]),
  ],
  { cwd: root, stdio: 'inherit', env },
)

child.on('error', (error) => {
  console.error(`[demo:web] 无法启动 —— ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[demo:web] 被信号中断（${signal}）`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
