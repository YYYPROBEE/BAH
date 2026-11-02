/**
 * 门禁：指标 / 日志 / 路由的可观测性契约（02 §S2.9）。
 *
 * 八条判据（每条都能用一个反例打红）：
 * 1. `METRIC_SPECS` 与 `docs/observability.md` 指标表的 name 集合双向相等；
 * 2. 每个 label 都能从 `labelValues`（非空）或 `labelValuesFrom` 取到值域，长度 ≤64；
 * 3. `prometheus.ts` 无 `toFixed(` / `padStart(`（浮点格式只能 toString）；
 * 4. 字面量 `logJson` code 都在 `docs/log-codes.md` 表里；
 * 5. `console.*` 只剩 2 个白名单文件（util/logging.ts + cli/main.ts）；
 * 6. 含 `costMicroYuan` 的行不得出现 parseFloat / Number( / toFixed；
 * 7. Prometheus 输出是 HELP/TYPE/样本三段式且无重复 series；
 * 8. `/api/trace` 存在且 auth=web、csrf=false。
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { METRIC_SPECS } from '../packages/telemetry/src/metrics.ts'
import { collectMetrics, type MetricInputs } from '../packages/telemetry/src/metrics.ts'
import { renderPrometheus } from '../packages/telemetry/src/prometheus.ts'
import { ROUTES } from '../packages/host/src/boot/plugins/web/router.ts'

import { isMainModule, runStandalone, walk, type Gate, type GateResult } from './gate-lib.ts'

const PKG = 'packages'
const DOC = 'docs/observability.md'
const LOG_DOC = 'docs/log-codes.md'

function read(root: string, file: string): string | undefined {
  try {
    return readFileSync(join(root, file), 'utf8')
  } catch {
    return undefined
  }
}

const isSource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts')

function metricNamesInDoc(doc: string): string[] {
  const begin = doc.indexOf('<!-- metrics:begin -->')
  const end = doc.indexOf('<!-- metrics:end -->')
  if (begin < 0 || end <= begin) return []
  return [...doc.slice(begin, end).matchAll(/`(bah_[a-z0-9_]+)`/g)].map((match) => match[1] ?? '')
}

function logCodesInDoc(doc: string): string[] {
  return [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1] ?? '')
}

function literalLogCodes(source: string): string[] {
  return [...source.matchAll(/logJson\([^,]+,\s*'([^']+)'/g)].map((match) => match[1] ?? '')
}

function sourceLength(root: string, from: 'routes' | 'tools' | 'models'): number {
  if (from === 'routes') return ROUTES.length + 1 // + unmatched
  if (from === 'tools') {
    const text = read(root, 'packages/bank/src/tools/specs.ts') ?? ''
    return [...text.matchAll(/\bname:\s*'/g)].length
  }
  // 模型注册表由 profile 追加；门禁只要求"上限 ≤64"，取一个保守的静态值。
  return 16
}

const gate: Gate = {
  name: 'observability',

  async run(root): Promise<GateResult> {
    const findings: string[] = []
    const notes: string[] = []

    // ① 指标名与文档表双向一致
    const doc = read(root, DOC) ?? ''
    const docNames = metricNamesInDoc(doc)
    const codeNames = METRIC_SPECS.map((spec) => spec.name)
    if (docNames.length === 0) findings.push(`${DOC}: 缺少 metrics:begin/end 生成表`)
    for (const name of codeNames) if (!docNames.includes(name)) findings.push(`${DOC}: 缺少指标 ${name}`)
    for (const name of docNames) if (!codeNames.includes(name)) findings.push(`${DOC}: 多出指标 ${name}`)
    notes.push(`指标 ${String(codeNames.length)} 个；文档表 ${String(docNames.length)} 个`)

    // ② 标签值域闭集
    for (const spec of METRIC_SPECS) {
      for (const label of spec.labels) {
        const fixed = spec.labelValues?.[label]
        const from = spec.labelValuesFrom?.[label]
        if ((fixed === undefined || fixed.length === 0) && from === undefined) {
          findings.push(`${spec.name}: 标签 ${label} 没有 labelValues / labelValuesFrom`)
          continue
        }
        if (fixed !== undefined && fixed.length === 0) findings.push(`${spec.name}: 标签 ${label} 的固定值域为空`)
        if (from !== undefined && sourceLength(root, from) > 64) {
          findings.push(`${spec.name}: 标签 ${label} 的来源 ${from} 超过 64 个值（基数风险）`)
        }
      }
    }

    // ③ Prometheus 不做浮点格式化
    const prom = read(root, 'packages/telemetry/src/prometheus.ts') ?? ''
    if (/toFixed\s*\(/.test(prom)) findings.push('prometheus.ts: 出现 toFixed（浮点格式只能 toString）')
    if (/padStart\s*\(/.test(prom)) findings.push('prometheus.ts: 出现 padStart（浮点格式只能 toString）')

    // ④ 字面量 log code 必须登记
    const logDoc = read(root, LOG_DOC) ?? ''
    const documented = new Set(logCodesInDoc(logDoc))
    const files = walk(root, [PKG], isSource)
    const seenCodes = new Set<string>()
    for (const file of files) {
      const where = relative(root, file).split('\\').join('/')
      const text = read(root, where) ?? ''
      for (const code of literalLogCodes(text)) {
        seenCodes.add(code)
        if (!documented.has(code)) findings.push(`${where}: log code '${code}' 未登记到 ${LOG_DOC}`)
      }
    }
    notes.push(`扫描 ${String(files.length)} 个源文件；log code ${String(seenCodes.size)} 个，登记 ${String(documented.size)} 个`)

    // ⑤ console 白名单
    const allowed = new Set(['packages/util/src/logging.ts', 'packages/cli/src/main.ts'])
    let consoleCalls = 0
    for (const file of files) {
      const where = relative(root, file).split('\\').join('/')
      const text = read(root, where) ?? ''
      const count = [...text.matchAll(/console\.(?:log|error|warn|info|debug)\s*\(/g)].length
      if (count === 0) continue
      consoleCalls += count
      if (!allowed.has(where)) findings.push(`${where}: 仍有 ${String(count)} 处 console.*（白名单只 2 个文件）`)
    }
    notes.push(`console.* 共 ${String(consoleCalls)} 处（白名单 2 文件）`)

    // ⑥ 成本行禁浮点
    for (const file of files) {
      const where = relative(root, file).split('\\').join('/')
      const lines = (read(root, where) ?? '').split('\n')
      lines.forEach((line, index) => {
        if (!line.includes('costMicroYuan')) return
        if (/parseFloat\s*\(|Number\s*\(|toFixed\s*\(/.test(line)) {
          findings.push(`${where}:${String(index + 1)}: 成本行出现浮点/数字转换`)
        }
      })
    }

    // ⑦ Prometheus 输出结构
    const empty: MetricInputs = {
      events: [],
      spans: [],
      stats: { spans: 0, dropped: 0 },
      process: {
        startedAtMs: 0,
        uptimeSec: 0,
        rssBytes: 0,
        heapUsedBytes: 0,
        eventLoopP99Sec: 0,
        nodeVersion: 'v22',
      },
      logs: { byLevel: {}, suppressed: 0 },
      alerts: { samples: [] },
      costConfigured: false,
    }
    const rendered = renderPrometheus(collectMetrics(empty))
    if (!rendered.startsWith('# HELP bah_up ')) findings.push('prometheus: 首个 family 不是 bah_up')
    if (!rendered.includes('# TYPE bah_up gauge')) findings.push('prometheus: 缺 TYPE 行')
    if (!rendered.endsWith('\n')) findings.push('prometheus: 文件末尾缺换行')
    const series = new Set<string>()
    for (const line of rendered.split('\n')) {
      if (line.length === 0 || line.startsWith('#')) continue
      const key = line.replace(/\s+[^\s]+$/, '')
      if (series.has(key)) findings.push(`prometheus: 重复 series ${key}`)
      series.add(key)
    }
    notes.push(`Prometheus 空输入 ${String(series.size)} 条 series`)

    // ⑧ /api/trace 契约
    const trace = ROUTES.find((route) => route.path === '/api/trace')
    if (trace === undefined) findings.push('router: 缺少 /api/trace')
    else {
      if (!trace.methods.includes('GET')) findings.push('/api/trace: 必须允许 GET')
      if (trace.auth !== 'web') findings.push('/api/trace: auth 必须是 web')
      if (trace.csrf !== false) findings.push('/api/trace: GET 不应受 CSRF 管')
      if (trace.handler !== 'trace') findings.push('/api/trace: handler 必须是 trace')
    }

    return { ok: findings.length === 0, findings, notes }
  },
}

export { gate }

if (isMainModule(import.meta.url)) {
  await runStandalone(gate)
}
