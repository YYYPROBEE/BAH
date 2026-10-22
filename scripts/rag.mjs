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

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const rag = resolve(root, 'services/rag')
const venvPython =
  process.platform === 'win32'
    ? resolve(rag, '.venv/Scripts/python.exe')
    : resolve(rag, '.venv/bin/python')
const python = existsSync(venvPython) ? venvPython : process.env.PYTHON ?? 'python'

const [task = 'dev', ...args] = process.argv.slice(2)

function run(module, extra = []) {
  const result = spawnSync(python, ['-m', module, ...extra], {
    cwd: rag,
    stdio: 'inherit',
    env: { ...process.env, PYTHONPATH: resolve(rag, 'src') },
  })
  if (result.error !== undefined) {
    console.error(`rag: ${result.error.message}`)
    process.exitCode = 1
    return
  }
  process.exitCode = result.status ?? 1
}

switch (task) {
  case 'dev':
    run('uvicorn', ['banking_rag.main:app', '--host', '127.0.0.1', '--port', '7801', ...args])
    break
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
