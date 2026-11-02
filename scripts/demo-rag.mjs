#!/usr/bin/env node
/**
 * 一条命令的 headless 知识演示：
 *   1. 启动 services/rag sidecar；
 *   2. 轮询 /healthz；
 *   3. 跑 CLI（patch-knowledge overlay）；
 *   4. 无论成败都杀掉 sidecar 进程树。
 */

import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KNOWLEDGE_TOKEN_ENV, resolveDemoToken } from './lib/demo-token.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

// A3：sidecar 与 host 必须用同一 token。这里解析一次，两边都注入；
// token 不落盘、不打印明文（demo:rag 是自包含的，用户不需要看到它）。
// 注意：childEnv 必须在下面补完 BAH_KNOWLEDGE_KEY 之后再快照，否则 CLI 拿不到演示密钥。
// 签名模式（BAH_RAG_TOKEN_SECRET）下 sidecar 只认签名 token；当前宿主只能发静态
// demo token。demo:rag 的目的就是演示，遇到这种配置直接说清并退出，避免现场 401。
if (process.env.BAH_RAG_TOKEN_SECRET !== undefined && process.env.BAH_RAG_TOKEN_SECRET !== '') {
  console.error(
    '[demo:rag] 检测到 BAH_RAG_TOKEN_SECRET：sidecar 会进入签名模式，而宿主 bank:knowledge ' +
      '只支持静态演示 token（无法自签），本脚本退出。演示请 unset 该变量；' +
      '签名模式需另行接入宿主侧签发（见 docs/knowledge.md）。',
  )
  process.exit(1)
}

const { token, generated } = resolveDemoToken(process.env)

// W06：知识库签名门需要一个密钥。演示用公开的完整性测试密钥并明确警告；
// 生产必须换成独立密钥（npx tsx scripts/sign-knowledge.ts 重签）。
if (process.env.BAH_KNOWLEDGE_KEY === undefined || process.env.BAH_KNOWLEDGE_KEY === '') {
  process.env.BAH_KNOWLEDGE_KEY = 'demo-key-not-for-prod'
  console.warn('[demo:rag] 未设置 BAH_KNOWLEDGE_KEY，使用公开演示密钥（仅完整性校验，不用于生产）')
}

/** sidecar 与 host 共用的环境：同一 token + 上面补好的演示密钥。 */
const childEnv = { ...process.env, [KNOWLEDGE_TOKEN_ENV]: token }
const PROMPT = '稳盈90天持有不满7天赎回费率是多少？'
const SESSION = process.env.DEMO_SESSION ?? `s-rag-demo-${Date.now()}`
const PATCH = process.env.DEMO_PATCH ?? 'profiles/headless/patch-knowledge.yml'
const HEALTH = 'http://127.0.0.1:7801/healthz'

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitForHealth(timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    // 早退：认证/依赖错误会让 sidecar 立刻退出；不要空等 30s 再说"未就绪"。
    if (sidecar.exitCode !== null) return 'exited'
    try {
      const response = await fetch(HEALTH)
      if (response.ok) return 'ok'
    } catch {
      // sidecar 还没起来
    }
    await sleep(500)
  }
  return 'timeout'
}

if (generated) {
  console.log('[demo:rag] 未配置 token：已生成本次一次性演示 token（不落盘），sidecar 与 host 共用')
}

const sidecar = spawn(process.execPath, [resolve(root, 'scripts/rag.mjs'), 'dev'], {
  cwd: root,
  stdio: 'inherit',
  env: childEnv,
})

function stopSidecar() {
  if (sidecar.exitCode !== null || sidecar.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(sidecar.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    sidecar.kill('SIGTERM')
  }
}

try {
  const health = await waitForHealth(30_000)
  if (health !== 'ok') {
    if (health === 'exited') {
      console.error(
        `rag: sidecar 提前退出（退出码 ${String(sidecar.exitCode)}）；检查 services/rag 的依赖与认证配置`,
      )
    } else {
      console.error('rag: sidecar 未在 30s 内就绪（先跑 pnpm rag:dev 看日志）')
    }
    process.exitCode = 1
  } else {
    const result = spawnSync(
      'pnpm',
      [
        'bah',
        '--profile',
        'headless',
        '--patch',
        PATCH,
        '--prompt',
        PROMPT,
        '--session',
        SESSION,
        '--jsonl',
        '.tmp-rag',
      ],
      { cwd: root, stdio: 'inherit', shell: true, env: childEnv },
    )
    process.exitCode = result.status ?? 1
  }
} finally {
  stopSidecar()
}
