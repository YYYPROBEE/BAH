/**
 * 门禁：knowledge.v1 契约 ↔ TS 守卫 ↔ fixture 三方一致。
 *
 * 1. `services/rag/contract/knowledge.v1.json` 必须存在且覆盖全部公开模型；
 * 2. `packages/knowledge/fixtures/*.json` 的每个响应必须通过 TS 运行时守卫；
 * 3. fixture 的 schemaVersion 只允许 `knowledge.v1`。
 *
 * 只读 JSON + 纯函数守卫，不启动 Python、不联网。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import {
  asKnowledgeAnswer,
  asKnowledgeHealth,
  asKnowledgeQuery,
} from '../packages/knowledge/src/contract.ts'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

const CONTRACT = 'services/rag/contract/knowledge.v1.json'
const REQUIRED_MODELS = [
  'AnswerRequest',
  'AnswerResponse',
  'QueryRequest',
  'QueryResponse',
  'VerifyRequest',
  'VerifyResponse',
  'HealthResponse',
] as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const gate: Gate = {
  name: 'knowledge-contract',

  async run(root) {
    const findings: string[] = []
    const notes: string[] = []

    const contractPath = `${root}/${CONTRACT}`
    try {
      const contract = asRecord(JSON.parse(readFileSync(contractPath, 'utf8')))
      if (contract === undefined) {
        findings.push(`${CONTRACT} 顶层必须是对象`)
      } else {
        if (contract['title'] !== 'knowledge.v1') {
          findings.push(`${CONTRACT} title 必须是 knowledge.v1`)
        }
        const definitions = asRecord(contract['definitions']) ?? {}
        for (const model of REQUIRED_MODELS) {
          if (definitions[model] === undefined) {
            findings.push(`${CONTRACT} 缺少 definitions.${model}（跑 pnpm rag:contract）`)
          }
        }
        notes.push(`契约模型 ${Object.keys(definitions).length} 个（要求 ${REQUIRED_MODELS.length} 个）`)
      }
    } catch (error) {
      findings.push(`${CONTRACT} 读取失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const fixtures = walk(root, ['packages/knowledge/fixtures'], (name) => name.endsWith('.json'))
    for (const file of fixtures) {
      const where = relative(root, file).replaceAll('\\', '/')
      try {
        const fixture = asRecord(JSON.parse(readFileSync(file, 'utf8')))
        if (fixture === undefined) {
          findings.push(`${where} 顶层必须是对象`)
          continue
        }
        const answers = fixture['answers']
        if (answers !== undefined) {
          if (!Array.isArray(answers)) findings.push(`${where}.answers 必须是数组`)
          else
            answers.forEach((entry, index) => {
              const item = asRecord(entry)
              try {
                asKnowledgeAnswer(item?.['response'])
              } catch (error) {
                findings.push(`${where}.answers[${index}]: ${(error as Error).message}`)
              }
            })
        }
        const queries = fixture['queries']
        if (queries !== undefined) {
          if (!Array.isArray(queries)) findings.push(`${where}.queries 必须是数组`)
          else
            queries.forEach((entry, index) => {
              const item = asRecord(entry)
              try {
                asKnowledgeQuery(item?.['response'])
              } catch (error) {
                findings.push(`${where}.queries[${index}]: ${(error as Error).message}`)
              }
            })
        }
        if (fixture['health'] !== undefined) {
          try {
            asKnowledgeHealth(fixture['health'])
          } catch (error) {
            findings.push(`${where}.health: ${(error as Error).message}`)
          }
        }
      } catch (error) {
        findings.push(`${where} 读取/解析失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    notes.push(`fixture ${fixtures.length} 个`)

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
