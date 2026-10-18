/**
 * 门禁：全仓不得出现上游 Harness（dsh）的依赖、源码路径或说明符。
 *
 * 依据：施工单 00 §3 合规底线第 1、2 条；施工单 01 §6。
 * 本门禁是 M0 完整实现（非骨架），任何命中即阻断合并。
 *
 * 扫描面：`packages/` 与 `apps/` 下的源码文本 + 全部 `package.json` 清单。
 * 说明：`scripts/` 自身不在扫描面内——本脚本的规则表里就含有被禁字面量，
 * 自扫会误报；如需覆盖脚本目录，应改为"规则表外部化"后另行扩展。
 */

import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

import { isMainModule, runStandalone, walk, type Gate } from './gate-lib.ts'

/** 参与文本扫描的源码后缀。 */
const TEXT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

interface Rule {
  readonly id: string
  readonly test: RegExp
  readonly why: string
}

const RULES: readonly Rule[] = [
  {
    id: 'upstream-scope',
    test: /@deepseek-ai\//,
    why: '不得引用 @deepseek-ai/*（施工单 00 §3 第 1 条）',
  },
  {
    id: 'upstream-specifier',
    test: /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"][^'"]*dsh[^'"]*['"]/,
    why: '模块说明符指向 dsh 源码（施工单 00 §3 第 1 条）',
  },
  {
    id: 'upstream-checkout',
    test: /(?:from\s*|require\s*\(\s*|import\s*\(\s*)['"][^'"]*[Dd]eepseek[-_ ]?[Hh]arness[^'"]*['"]/,
    why: '模块说明符指向 dsh 本地检出目录（施工单 00 §3 第 1、3 条）',
  },
]

const isTextSource = (fileName: string): boolean =>
  TEXT_EXTENSIONS.some((ext) => fileName.endsWith(ext))

const isManifest = (fileName: string): boolean => fileName === 'package.json'

const gate: Gate = {
  name: 'no-upstream-imports',

  async run(root) {
    const findings: string[] = []
    const sources = walk(root, ['packages', 'apps'], isTextSource)
    const manifests = walk(root, ['packages', 'apps'], isManifest)

    for (const file of sources) {
      scanFile(root, file, RULES, findings)
    }
    // 清单只查依赖坐标：@deepseek-ai/* 出现在 dependencies/devDependencies 里即违规
    for (const file of manifests) {
      scanFile(root, file, RULES.filter((rule) => rule.id === 'upstream-scope'), findings)
    }

    return {
      ok: findings.length === 0,
      findings,
      notes: [`扫描 ${sources.length} 个源码文件 + ${manifests.length} 个清单`],
    }
  },
}

function scanFile(root: string, file: string, rules: readonly Rule[], findings: string[]): void {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    findings.push(`${relative(root, file)}: 无法读取（权限或编码问题）`)
    return
  }

  const lines = text.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    for (const rule of rules) {
      if (rule.test.test(line)) {
        findings.push(`${relative(root, file)}:${index + 1} [${rule.id}] ${rule.why}`)
      }
    }
  }
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
