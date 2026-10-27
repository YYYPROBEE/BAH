#!/usr/bin/env node
/**
 * services/rag 的命令包装（Windows / Unix 都走同一个入口）。
 *
 *   node scripts/rag.mjs dev       启动 sidecar（127.0.0.1:7801）
 *   node scripts/rag.mjs test      跑 pytest
 *   node scripts/rag.mjs check     pytest（含契约一致性）
 *   node scripts/rag.mjs ingest    重建演示语料
 *   node scripts/rag.mjs contract  导出 knowledge.v1.json
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KNOWLEDGE_TOKEN_ENV,
  RAG_TOKEN_ENV,
  existingDemoToken,
  printTokenHint,
  resolveDemoToken,
} from './lib/demo-token.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const rag = resolve(root, 'services/rag')
const venvPython =
  process.platform === 'win32'
    ? resolve(rag, '.venv/Scripts/python.exe')
    : resolve(rag, '.venv/bin/python')
const python = existsSync(venvPython) ? venvPython : process.env.PYTHON ?? 'python'

const [task = 'dev', ...args] = process.argv.slice(2)

function run(module, extra = [], extraEnv = {}) {
  const result = spawnSync(python, ['-m', module, ...extra], {
    cwd: rag,
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: resolve(rag, 'src'), ...extraEnv },
  })
  if (result.error !== undefined) {
    console.error(`rag: ${result.error.message}`)
    process.exitCode = 1
    return
  }
  process.exitCode = result.status ?? 1
}

switch (task) {
  case 'dev': {
    // sidecar 是 fail-loud：没有任何认证配置就直接拒启。这里统一解析一次，
    // 保证 `pnpm rag:dev` 在干净环境也能起；host 侧要用同一 token（见提示/README）。
    const secret = (process.env.BAH_RAG_TOKEN_SECRET ?? '').trim()
    const demoToken = existingDemoToken(process.env)
    const extraEnv = {}
    if (demoToken !== undefined) extraEnv[KNOWLEDGE_TOKEN_ENV] = demoToken

    if (secret !== '') {
      // 签名模式下 sidecar 只认自签 token；静态 token 一律 401。
      // 这里**不再生成**静态 token —— 生成了也是个用不上的值，打印出来只会误导演示现场。
      console.warn(
        `[rag] 检测到 BAH_RAG_TOKEN_SECRET：sidecar 进入签名模式，` +
          (demoToken === undefined
            ? '本脚本不会生成静态 token（生成了 sidecar 也不认）。'
            : `已注入 ${KNOWLEDGE_TOKEN_ENV}，但签名模式不会接受它。`) +
          ' 宿主 bank:knowledge 目前只能发静态 token（无法自签）；演示请 unset 该变量，' +
          '联调请用签名 token 直连 sidecar。',
      )
    } else if (demoToken === undefined) {
      const { token } = resolveDemoToken(process.env)
      extraEnv[KNOWLEDGE_TOKEN_ENV] = token
      printTokenHint(token)
    } else if (process.env[KNOWLEDGE_TOKEN_ENV] === undefined) {
      console.warn(
        `[rag] 只设置了 ${RAG_TOKEN_ENV}；host 的 bank:knowledge 默认读 ${KNOWLEDGE_TOKEN_ENV}，` +
          '请给 host 也注入同一 token，否则知识工具会 401。',
      )
    }
    run(
      'uvicorn',
      ['banking_rag.main:app', '--host', '127.0.0.1', '--port', '7801', ...args],
      extraEnv,
    )
    break
  }
  case 'test':
  case 'check':
    run('pytest', args)
    break
  case 'ingest':
    run('banking_rag.ingest', args)
    break
  case 'contract':
    run('banking_rag.export_contract', ['--out', 'contract/knowledge.v1.json', ...args])
    break
  default:
    console.error(`未知任务 ${task}（dev / test / check / ingest / contract）`)
    process.exitCode = 2
}
