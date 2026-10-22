/**
 * 重放核验并写入 `reverified.json`（`pnpm snapshot:reverify`）。
 *
 * 三步：
 * 1. 以**回放模式**跑一遍 snapshot 面——不通过就退出，绝不写入任何核验记录；
 * 2. 为每个场景计算 `coveredSources` 的源码摘要；
 * 3. 摘要与已记录的不同才写盘。
 *
 * 产物 `snapshots/<case>/reverified.json` **不含时间戳**：时间戳会让每次运行都产生
 * diff，"没变化也变"会训练人忽略 diff，反而降低门禁可信度。摘要本身已经足够
 * 表达"我为这份源码核验过"。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { digestOfScopes } from './snapshot-digest.ts'

/** 仓库根：本文件位于 `<root>/scripts/`。 */
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

console.log('BAH · snapshot:reverify —— 先以回放模式验证快照仍然匹配当前源码\n')

const replay = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--config', 'vitest.snapshot.config.ts'],
  { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, BAH_SNAPSHOT_RECORD: '0' } },
)

if (replay.status !== 0) {
  console.error('\nsnapshot:reverify: 回放未通过，不写入任何核验记录')
  process.exit(1)
}

const snapshotsDir = join(root, 'snapshots')
let written = 0
let unchanged = 0

for (const entry of readdirSync(snapshotsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const scenarioPath = join(snapshotsDir, entry.name, 'scenario.json')
  if (!existsSync(scenarioPath)) continue

  let scopes: readonly string[] = []
  try {
    const parsed = JSON.parse(readFileSync(scenarioPath, 'utf8')) as { coveredSources?: unknown }
    if (Array.isArray(parsed.coveredSources)) {
      scopes = parsed.coveredSources.filter((item): item is string => typeof item === 'string')
    }
  } catch {
    console.error(`snapshot:reverify: ${entry.name}/scenario.json 不是合法 JSON，跳过`)
    continue
  }

  const digest = digestOfScopes(root, scopes)
  const target = join(snapshotsDir, entry.name, 'reverified.json')

  let previousDigest: string | undefined
  if (existsSync(target)) {
    try {
      const previous = JSON.parse(readFileSync(target, 'utf8')) as { sourceDigest?: unknown }
      if (typeof previous.sourceDigest === 'string') previousDigest = previous.sourceDigest
    } catch {
      // 坏文件当作未核验处理
    }
  }

  if (previousDigest === digest) {
    unchanged += 1
    console.log(`= ${entry.name}: 摘要未变，保持原记录`)
    continue
  }

  const record = {
    sourceDigest: digest,
    note: '回放通过。本文件只声明「这份源码已被核验」，不代表快照内容发生变化。',
  }
  writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  written += 1
  console.log(`+ ${entry.name}: 已写入核验记录`)
}

console.log(`\nsnapshot:reverify 完成：写入 ${written} 个，未变 ${unchanged} 个`)
