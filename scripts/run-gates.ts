/**
 * 门禁调度器（施工单 01 §6）。
 *
 * 顺序执行 `scripts/` 下存在的全部 `verify-*.ts`，任一失败即退出码 1。
 * 全部 TypeScript + tsx 直跑，不写 shell（施工单 00 §10）。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { printResult, projectRoot, type Gate } from './gate-lib.ts'

const VERIFY_PATTERN = /^verify-[\w-]+\.ts$/

const root = projectRoot()
const scriptDir = join(root, 'scripts')

const gateFiles = readdirSync(scriptDir)
  .filter((name) => VERIFY_PATTERN.test(name))
  .sort()

if (gateFiles.length === 0) {
  console.error(`✘ 未找到任何门禁脚本（${scriptDir}/verify-*.ts）`)
  process.exitCode = 1
} else {
  console.log(`BAH 门禁 · 共 ${gateFiles.length} 项\n`)

  let failed = 0
  for (const file of gateFiles) {
    const moduleUrl = pathToFileURL(join(scriptDir, file)).href
    try {
      const loaded: unknown = await import(moduleUrl)
      const gate = readGate(loaded)
      if (gate === undefined) {
        failed += 1
        console.error(`✘ ${file}: 未导出 { gate }，无法调度`)
        continue
      }
      const result = await gate.run(root)
      printResult(gate.name, result)
      if (!result.ok) failed += 1
    } catch (error) {
      failed += 1
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`✘ ${file}: 执行抛错 —— ${reason}`)
    }
  }

  console.log('')
  if (failed === 0) {
    console.log(`全部通过（${gateFiles.length}/${gateFiles.length}）`)
  } else {
    console.error(`阻断合并：${failed}/${gateFiles.length} 项未通过`)
    process.exitCode = 1
  }
}

/** 从动态 import 结果里取出 gate（不信任模块形状）。 */
function readGate(loaded: unknown): Gate | undefined {
  if (!isRecord(loaded)) return undefined
  const candidate = loaded['gate']
  return isGate(candidate) ? candidate : undefined
}

function isGate(value: unknown): value is Gate {
  if (!isRecord(value)) return false
  return typeof value['name'] === 'string' && typeof value['run'] === 'function'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
