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

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

// W06：知识库签名门需要一个密钥。演示用公开的完整性测试密钥并明确警告；
// 生产必须换成独立密钥（npx tsx scripts/sign-knowledge.ts 重签）。
if (process.env.BAH_KNOWLEDGE_KEY === undefined || process.env.BAH_KNOWLEDGE_KEY === '') {
  process.env.BAH_KNOWLEDGE_KEY = 'demo-key-not-for-prod'
  console.warn('[demo:rag] 未设置 BAH_KNOWLEDGE_KEY，使用公开演示密钥（仅完整性校验，不用于生产）')
}
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
    try {
      const response = await fetch(HEALTH)
      if (response.ok) return true
    } catch {
      // sidecar 还没起来
    }
    await sleep(500)
  }
  return false
}

const sidecar = spawn(process.execPath, [resolve(root, 'scripts/rag.mjs'), 'dev'], {
  cwd: root,
  stdio: 'inherit',
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
  const healthy = await waitForHealth(30_000)
  if (!healthy) {
    console.error('rag: sidecar 未在 30s 内就绪（先跑 pnpm rag:dev 看日志）')
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
      { cwd: root, stdio: 'inherit', shell: true },
    )
    process.exitCode = result.status ?? 1
  }
} finally {
  stopSidecar()
}
