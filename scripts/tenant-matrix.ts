/**
 * 两进程租户隔离矩阵（租户与鉴权 04 · TA-51）。
 *
 * 这是**唯一能说服外部观察者**的证据形态：两个真实进程、两个端口、两个目录，
 * 用 HTTP + 文件系统（不调内部 API）打出 8 条断言。判定与证据同源：
 * "租户 = 进程"是本方案的立场，证据也必须按进程来。
 *
 * 用法：
 *   npx tsx scripts/tenant-matrix.ts [--keep] [--port-base 17331]
 *
 * 退出码：0 = 8/8 PASS；1 = 任一 FAIL / 启动失败 / 端口被占；2 = 用法错误。
 *
 * 纪律（04 §6 的反例）：**每条断言单独 try、单独计数**，最后按失败数定退出码。
 * 不许用一个大 try/catch 包住整段再打印 "matrix ok"（血泪第 10 条）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadSqlite } from '@bah/persistence'

import { hashPassword } from '../packages/host/src/boot/plugins/web/auth/password.ts'

/** 仓库根（与 CLI 的 cwd 一致）。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 两个租户与它们的身份（stress 数据集有三个用户，才可能有不同的 userId）。 */
const TENANTS = {
  demo: { userId: 'u-1', sessionId: 's-matrix-demo', port: 0 },
  acme: { userId: 'u-2', sessionId: 's-matrix-acme', port: 0 },
} as const

/** 两个租户共用的探针口令（脚本内生成哈希，不进仓库）。 */
const PASSWORD = 'matrix-pass-2026'

interface MatrixResult {
  readonly id: string
  readonly expected: string
  readonly actual: string
  readonly pass: boolean
}

interface CliArgs {
  readonly keep: boolean
  readonly portBase: number
  readonly help: boolean
}

function parseArgs(argv: readonly string[]): CliArgs {
  let keep = false
  let portBase = 17_331
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--keep') {
      keep = true
      continue
    }
    if (flag === '--help' || flag === '-h') {
      help = true
      continue
    }
    if (flag === '--port-base') {
      const value = argv[index + 1]
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error('--port-base 需要一个整数端口')
      }
      portBase = Number(value)
      index += 1
      continue
    }
    throw new Error(`未知参数：${flag ?? ''}`)
  }
  return { keep, portBase, help }
}

/** 端口预检：能 bind 才算空闲（用完立即关）。 */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer()
    server.once('error', () => resolvePromise(false))
    server.once('listening', () => server.close(() => resolvePromise(true)))
    server.listen(port, '127.0.0.1')
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

interface ProcessHandle {
  readonly tenant: string
  readonly base: string
  readonly child: ChildProcess
  readonly port: number
  stderr: string
}

/** 等子进程退出（最多 timeoutMs）。 */
async function waitExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null) return
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise())),
    sleep(timeoutMs),
  ])
}

/** 造一份 overlay（JSON 是合法 YAML）。 */
function overlayRows(input: {
  readonly tenant: string
  readonly port: number
  readonly usersPath: string
}): unknown[] {
  const userId = TENANTS[input.tenant as keyof typeof TENANTS].userId
  return [
    {
      id: 'bank:tools',
      config: {
        seed: 7,
        datasetTier: 'stress',
        policy: { engine: 'bundle' },
        contextSlots: {
          accounts: 3,
          transactions: 3,
          windowDays: 30,
          timeoutMs: 250,
          maxChars: 800,
          breakerFailures: 3,
          breakerOpenMs: 10_000,
        },
      },
    },
    {
      id: 'core:agent',
      config: {
        channel: 'web',
        loop: {
          model: 'router:router-chat',
          maxSteps: 8,
          compaction: { maxTurns: 8, keepRecentTurns: 3 },
        },
        slots: { source: 'bank' },
      },
    },
    {
      id: 'channel:web',
      config: {
        port: input.port,
        host: '127.0.0.1',
        staticRoot: 'apps/web',
        heartbeatMs: 15_000,
        auth: {
          mode: 'password',
          cookie: { name: 'bah_sid', secure: false },
          directory: { path: input.usersPath },
        },
      },
    },
    {
      id: 'bah:memory-store',
      config: { dbPath: 'memory.db', userId, sensitivityCeiling: 2 },
    },
  ]
}

function usersYaml(tenant: string, userId: string, passwordHash: string): string {
  return [
    'version: 1',
    `tenant: ${tenant}`,
    'users:',
    `  - userId: ${userId}`,
    '    phone: "13800000001"',
    '    roles: [customer]',
    `    password: "${passwordHash}"`,
    '',
  ].join('\n')
}

/** 启动子进程（CLI 入口，`--patch` 叠加租户 overlay）。 */
function startProcess(input: {
  readonly tenant: string
  readonly port: number
  readonly runRoot: string
  readonly overlayPath: string
}): ProcessHandle {
  const entry = join(REPO_ROOT, 'packages/cli/src/main.ts')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BAH_KNOWLEDGE_KEY: 'demo-key-not-for-prod',
    BAH_KNOWLEDGE_TOKEN: 'matrix-token-not-for-prod',
    [`BAH_KNOWLEDGE_TOKEN_${input.tenant.toUpperCase()}`]: 'matrix-token-not-for-prod',
  }
  delete env['BAH_ADMIN_TOKEN']
  delete env['BAH_ADMIN_OPERATORS']
  delete env['BAH_WEB_TOKEN']
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      entry,
      '--profile',
      'web',
      '--serve',
      '--tenant',
      input.tenant,
      '--jsonl',
      input.runRoot,
      '--patch',
      input.overlayPath,
      '--session',
      TENANTS[input.tenant as keyof typeof TENANTS].sessionId,
    ],
    { cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const handle: ProcessHandle = {
    tenant: input.tenant,
    base: `http://127.0.0.1:${String(input.port)}`,
    child,
    port: input.port,
    stderr: '',
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    handle.stderr += chunk.toString('utf8')
    if (handle.stderr.length > 20_000) handle.stderr = handle.stderr.slice(-20_000)
  })
  child.stdout?.on('data', () => undefined)
  return handle
}

/** 轮询 `/api/health` 直到就绪（15s）。 */
async function waitReady(handle: ProcessHandle): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null) {
      throw new Error(`进程 ${handle.tenant} 提前退出（code=${String(handle.child.exitCode)}）：\n${handle.stderr}`)
    }
    try {
      const response = await fetch(`${handle.base}/api/health`)
      if (response.ok) return
    } catch {
      // 端口还没起来
    }
    await sleep(200)
  }
  throw new Error(`进程 ${handle.tenant} 15s 未就绪：\n${handle.stderr}`)
}

/** 极简 cookie jar（Node fetch 不保存 cookie）。 */
class Jar {
  private readonly cookies = new Map<string, string>()
  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0] ?? ''
      const index = pair.indexOf('=')
      if (index <= 0) continue
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1))
    }
  }
  get(name: string): string | undefined {
    return this.cookies.get(name)
  }
  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

async function request(
  url: string,
  options: {
    readonly method?: string
    readonly jar?: Jar
    readonly headers?: Record<string, string>
    readonly body?: unknown
  } = {},
): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.jar !== undefined && options.jar.header() !== '') headers['cookie'] = options.jar.header()
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  options.jar?.absorb(response)
  return { status: response.status, body: await response.text() }
}

/** 登录（GET / 拿 CSRF → POST /api/auth/login）。 */
async function login(base: string, userId: string): Promise<Jar> {
  const jar = new Jar()
  const index = await request(`${base}/`, { jar })
  if (index.status !== 200) throw new Error(`GET / 返回 ${String(index.status)}`)
  const csrf = jar.get('bah_csrf')
  if (csrf === undefined) throw new Error('GET / 没有下发 bah_csrf cookie')
  const login = await request(`${base}/api/auth/login`, {
    method: 'POST',
    jar,
    headers: { 'x-bah-csrf': csrf },
    body: { userId, password: PASSWORD },
  })
  if (login.status !== 200) throw new Error(`登录 ${userId} 失败（${String(login.status)}）：${login.body}`)
  return jar
}

/** 写请求的 CSRF 头（登录后 csrf 已轮换）。 */
function csrfOf(jar: Jar): string {
  const csrf = jar.get('bah_csrf')
  if (csrf === undefined) throw new Error('jar 里没有 bah_csrf')
  return csrf
}

/** 递归把目录下所有文件读成 utf8 文本（跳过二进制读失败）。 */
function allText(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
        continue
      }
      try {
        out.push(readFileSync(full, 'utf8'))
      } catch {
        // 二进制读不了就跳过：M6 单独用 sqlite 判
      }
    }
  }
  walk(dir)
  return out
}

/** 文本里出现次数（逐字，不做正则）。 */
function occurrences(texts: readonly string[], needle: string): number {
  let count = 0
  for (const text of texts) {
    let index = 0
    while ((index = text.indexOf(needle, index)) >= 0) {
      count += 1
      index += needle.length
    }
  }
  return count
}

/** 从 session.jsonl 里找第一张待答票据。 */
function firstPendingTicket(sessionFile: string): string | undefined {
  if (!existsSync(sessionFile)) return undefined
  for (const line of readFileSync(sessionFile, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    let event: { type?: unknown; data?: { ticketId?: unknown } }
    try {
      event = JSON.parse(line) as typeof event
    } catch {
      continue
    }
    if (event.type === 'approval/asked' && typeof event.data?.ticketId === 'string') {
      return event.data.ticketId
    }
  }
  return undefined
}

/** 读 health 的 pendingTicketCount。 */
async function pendingCount(base: string): Promise<number> {
  const response = await fetch(`${base}/api/health`)
  const body = (await response.json()) as { pendingTicketCount?: unknown }
  return typeof body.pendingTicketCount === 'number' ? body.pendingTicketCount : 0
}

/** 等待票据挂起（15s）。 */
async function waitPending(base: string, ticket: () => string | undefined): Promise<string> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const found = ticket()
    if (found !== undefined) return found
    if ((await pendingCount(base)) > 0) {
      const again = ticket()
      if (again !== undefined) return again
    }
    await sleep(200)
  }
  throw new Error('15s 内没有等到 approval/asked')
}

/** 跑一条断言（单独 try，单独计数）。 */
async function check(
  id: string,
  expected: string,
  fn: () => Promise<{ readonly actual: string; readonly pass: boolean }>,
): Promise<MatrixResult> {
  try {
    const result = await fn()
    return { id, expected, actual: result.actual, pass: result.pass }
  } catch (error) {
    return {
      id,
      expected,
      actual: `ERROR: ${error instanceof Error ? error.message : String(error)}`,
      pass: false,
    }
  }
}

function printTable(results: readonly MatrixResult[]): void {
  const header = ['#', '期望', '实测', '结果']
  const rows = results.map((result) => [result.id, result.expected, result.actual, result.pass ? 'PASS' : 'FAIL'])
  const widths = header.map((title, index) =>
    Math.max(...[title, ...rows.map((row) => row[index] ?? '')].map((cell) => [...cell].length)),
  )
  const render = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell + ' '.repeat((widths[index] ?? 0) - [...cell].length)).join(' | ')
  console.log(render(header))
  console.log(widths.map((width) => '-'.repeat(width)).join('-+-'))
  for (const row of rows) console.log(render(row))
}

async function main(): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`tenant-matrix: ${error instanceof Error ? error.message : String(error)}`)
    console.error('用法：npx tsx scripts/tenant-matrix.ts [--keep] [--port-base 17331]')
    return 2
  }
  if (args.help) {
    console.log('用法：npx tsx scripts/tenant-matrix.ts [--keep] [--port-base 17331]')
    console.log('  8 条断言：凭证/票据/租户头不跨进程；目录与记忆库字节不交叉；metrics 租户正确')
    return 0
  }

  const ports = { demo: args.portBase, acme: args.portBase + 10 }
  for (const [tenant, port] of Object.entries(ports)) {
    if (!(await portFree(port))) {
      console.error(
        `tenant-matrix: 端口 ${String(port)} 已被占用（${tenant}）。` +
          `对外说明现场常开着 7331，本脚本用 173xx；可用 --port-base <n> 换一段`,
      )
      return 1
    }
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'bah-tenant-matrix-'))
  const runRoots = {
    demo: join(tempRoot, 'run-demo'),
    acme: join(tempRoot, 'run-acme'),
  }
  const authDirs = {
    demo: join(tempRoot, 'auth-demo'),
    acme: join(tempRoot, 'auth-acme'),
  }
  const overlays = {
    demo: join(tempRoot, 'overlay-demo.yml'),
    acme: join(tempRoot, 'overlay-acme.yml'),
  }
  const handles: ProcessHandle[] = []
  const results: MatrixResult[] = []
  // Ctrl+C 不能留下两个孤儿进程（Windows 下父进程退出不会自动杀子进程）
  const shutdown = (): void => {
    for (const handle of handles) {
      if (handle.child.exitCode === null) handle.child.kill('SIGTERM')
    }
    process.exit(130)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  try {
    const passwordHash = await hashPassword(PASSWORD)
    for (const tenant of ['demo', 'acme'] as const) {
      mkdirSync(runRoots[tenant], { recursive: true })
      mkdirSync(authDirs[tenant], { recursive: true })
      const usersPath = join(authDirs[tenant], 'users.yml')
      writeFileSync(usersPath, usersYaml(tenant, TENANTS[tenant].userId, passwordHash), 'utf8')
      writeFileSync(
        overlays[tenant],
        `${JSON.stringify(overlayRows({ tenant, port: ports[tenant], usersPath }), null, 2)}\n`,
        'utf8',
      )
    }

    for (const tenant of ['demo', 'acme'] as const) {
      const handle = startProcess({
        tenant,
        port: ports[tenant],
        runRoot: runRoots[tenant],
        overlayPath: overlays[tenant],
      })
      handles.push(handle)
    }
    for (const handle of handles) await waitReady(handle)

    const demoBase = handles[0]!.base
    const acmeBase = handles[1]!.base
    const demoJar = await login(demoBase, TENANTS.demo.userId)
    const acmeJar = await login(acmeBase, TENANTS.acme.userId)
    const demoTenantDir = join(runRoots.demo, 'demo')
    const acmeTenantDir = join(runRoots.acme, 'acme')

    const demoSession = await request(`${demoBase}/api/session`, { jar: demoJar })
    const acmeSession = await request(`${acmeBase}/api/session`, { jar: acmeJar })
    const demoSessionId = (JSON.parse(demoSession.body) as { sessionId?: string }).sessionId ?? ''
    const acmeSessionId = (JSON.parse(acmeSession.body) as { sessionId?: string }).sessionId ?? ''

    results.push(
      await check('M1 凭证搬运', '401', async () => {
        const response = await request(`${acmeBase}/api/session`, { jar: demoJar })
        return { actual: String(response.status), pass: response.status === 401 }
      }),
    )

    results.push(
      await check('M2 凭证→/me', '401 且不含 demo', async () => {
        const response = await request(`${acmeBase}/api/auth/me`, { jar: demoJar })
        return {
          actual: `${String(response.status)} ${response.body.includes('demo') ? '含 demo' : '不含 demo'}`,
          pass: response.status === 401 && !response.body.includes('demo'),
        }
      }),
    )

    results.push(
      await check('M3 票据搬运', '404 unknown-ticket', async () => {
        const turn = await request(`${demoBase}/api/turn`, {
          method: 'POST',
          jar: demoJar,
          headers: { 'x-bah-csrf': csrfOf(demoJar) },
          body: { text: '给王芳转 800 元' },
        })
        if (turn.status !== 202) throw new Error(`demo turn 返回 ${String(turn.status)}：${turn.body}`)
        const sessionFile = join(demoTenantDir, demoSessionId, 'session.jsonl')
        const ticketId = await waitPending(demoBase, () => firstPendingTicket(sessionFile))
        const response = await request(`${acmeBase}/api/approval/${encodeURIComponent(ticketId)}`, {
          method: 'POST',
          jar: acmeJar,
          headers: { 'x-bah-csrf': csrfOf(acmeJar) },
          body: { decision: 'allowed-once' },
        })
        const code = (() => {
          try {
            return (JSON.parse(response.body) as { error?: { code?: string } }).error?.code ?? ''
          } catch {
            return ''
          }
        })()
        return { actual: `${String(response.status)} ${code}`, pass: response.status === 404 && code === 'unknown-ticket' }
      }),
    )

    results.push(
      await check('M4 demo 目录无 acme 标识', '0 命中', async () => {
        const texts = allText(demoTenantDir)
        const hits =
          occurrences(texts, TENANTS.acme.userId) +
          occurrences(texts, acmeSessionId) +
          occurrences(texts, 'acme')
        return { actual: `${String(hits)} 命中`, pass: hits === 0 }
      }),
    )

    results.push(
      await check('M5 acme 目录无 demo 标识', '0 命中', async () => {
        const texts = allText(acmeTenantDir)
        const hits =
          occurrences(texts, TENANTS.demo.userId) +
          occurrences(texts, demoSessionId) +
          occurrences(texts, 'demo')
        return { actual: `${String(hits)} 命中`, pass: hits === 0 }
      }),
    )

    results.push(
      await check('M6 demo 记忆库无 acme user', '0 行', async () => {
        const dbPath = join(demoTenantDir, 'memory.db')
        if (!existsSync(dbPath)) return { actual: 'memory.db 不存在', pass: false }
        const { DatabaseSync } = loadSqlite()
        const db = new DatabaseSync(dbPath, { readOnly: true })
        try {
          const row = db
            .prepare('SELECT count(*) AS n FROM memory_unit WHERE user_id = ?')
            .get(TENANTS.acme.userId) as { n?: number } | undefined
          const count = typeof row?.n === 'number' ? row.n : -1
          return { actual: `${String(count)} 行`, pass: count === 0 }
        } finally {
          db.close()
        }
      }),
    )

    results.push(
      await check('M7 metrics 租户', 'demo / acme', async () => {
        const demo = await request(`${demoBase}/api/metrics`, { jar: demoJar })
        const acme = await request(`${acmeBase}/api/metrics`, { jar: acmeJar })
        const demoTenant = (JSON.parse(demo.body) as { tenant?: string }).tenant ?? ''
        const acmeTenant = (JSON.parse(acme.body) as { tenant?: string }).tenant ?? ''
        return {
          actual: `${demoTenant} / ${acmeTenant}`,
          pass: demoTenant === 'demo' && acmeTenant === 'acme',
        }
      }),
    )

    results.push(
      await check('M8 租户头注入', '401', async () => {
        const response = await request(`${acmeBase}/api/auth/me?tenant=demo`, {
          jar: demoJar,
          headers: { 'x-tenant': 'demo' },
        })
        return {
          actual: `${String(response.status)} ${response.body.includes('acme') ? '含 acme' : '不含 acme'}`,
          pass: response.status === 401 && !response.body.includes('acme'),
        }
      }),
    )

    printTable(results)
    const failed = results.filter((result) => !result.pass).length
    console.log(`\n${String(results.length - failed)}/${String(results.length)} PASS`)
    if (args.keep) {
      console.log(`保留目录：${tempRoot}`)
      console.log(`  demo: ${demoBase}  acme: ${acmeBase}`)
      console.log('（--keep 时进程在脚本退出时仍会关闭；目录保留供人工检查）')
    }
    return failed === 0 ? 0 : 1
  } catch (error) {
    console.error(`tenant-matrix: ${error instanceof Error ? error.message : String(error)}`)
    for (const handle of handles) {
      if (handle.stderr.trim() !== '') console.error(`--- ${handle.tenant} stderr ---\n${handle.stderr.slice(-4000)}`)
    }
    return 1
  } finally {
    for (const handle of handles) {
      if (handle.child.exitCode === null) handle.child.kill('SIGTERM')
    }
    for (const handle of handles) await waitExit(handle.child)
    if (!args.keep) rmSync(tempRoot, { recursive: true, force: true })
  }
}

process.exitCode = await main()
