/**
 * `bah plan` 的用法面与端到端退出码。
 *
 * 为什么值得钉：`arm` / `disarm` 是"用户确认一次、到期自动花钱"的运维入口，
 * 绕过工具管线就会让审计看不见窗口；参数解析的每条分支都直接决定退出码
 * （2 = 没启动 / 1 = 启动后失败），运维脚本靠它判断要不要重试。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { PLAN_USAGE, parsePlanArgs, runPlan } from './plan.ts'

import type { CliIo, CliOptions } from './run.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const NOW = 1_700_000_000_000
const DUE_ISO = new Date(NOW - 1_000).toISOString()

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bah-cli-plan-${tag}-`))
  scratch.push(dir)
  return dir
}

interface Captured {
  readonly io: CliIo
  readonly out: string[]
  readonly err: string[]
}

function capture(): Captured {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}

const OPTIONS: CliOptions = { root: repoRoot, now: () => NOW, env: {} }

/** 固定 profile / 会话 / 租户与临时 home+jsonl：不写仓库 `sessions/`，不读开发机 home patch。 */
function common(home: string, jsonl: string): readonly string[] {
  return [
    '--profile',
    'plan',
    '--session',
    's-cli-plan',
    '--tenant',
    'demo',
    '--home',
    home,
    '--jsonl',
    jsonl,
  ]
}

async function run(
  argv: readonly string[],
  options: CliOptions = OPTIONS,
): Promise<{ readonly code: number; readonly out: string[]; readonly err: string[] }> {
  const captured = capture()
  const code = await runPlan(argv, captured.io, options)
  return { code, out: captured.out, err: captured.err }
}

function jsonOf(lines: readonly string[]): unknown {
  return JSON.parse(lines.join('\n')) as unknown
}

describe('parsePlanArgs', () => {
  it('list：空格与 `=` 两种取值写法等价', () => {
    expect(
      parsePlanArgs([
        'list',
        '--profile=plan',
        '--session',
        's-1',
        '--jsonl',
        '/tmp/x',
        '--tenant=acme',
        '--home',
        '/tmp/h',
      ]),
    ).toEqual({
      ok: true,
      command: { kind: 'list' },
      common: { profile: 'plan', session: 's-1', jsonl: '/tmp/x', tenant: 'acme', home: '/tmp/h' },
      help: false,
    })
  })

  it('wake 缺省：不写 at/planId，dryRun=false', () => {
    expect(parsePlanArgs(['wake'])).toEqual({
      ok: true,
      command: { kind: 'wake', dryRun: false },
      common: {},
      help: false,
    })
  })

  it('wake 全量：at/planId/--dry-run 都收进命令', () => {
    expect(parsePlanArgs(['wake', '--at', DUE_ISO, '--plan', 'p-1', '--dry-run'])).toEqual({
      ok: true,
      command: { kind: 'wake', at: DUE_ISO, planId: 'p-1', dryRun: true },
      common: {},
      help: false,
    })
  })

  it('子命令后的 help 优先于必填校验：未知子命令也给帮助而不是报错', () => {
    expect(parsePlanArgs(['daemon', '-h'])).toMatchObject({
      ok: true,
      help: true,
      command: { kind: 'list' },
    })
    expect(parsePlanArgs(['list', '--help'])).toMatchObject({ ok: true, help: true })
    expect(parsePlanArgs(['arm', '--help'])).toMatchObject({ ok: true, help: true })
  })

  it('arm/disarm 的必填参数缺失是用法错误', () => {
    expect(parsePlanArgs(['arm'])).toEqual({ ok: false, error: 'arm 需要 --file <plan.json>' })
    expect(parsePlanArgs(['disarm'])).toEqual({ ok: false, error: 'disarm 需要 --window <windowId>' })
  })

  it('未知参数、未知子命令、--dry-run 带值都是用法错误', () => {
    expect(parsePlanArgs(['wake', '--bogus'])).toEqual({ ok: false, error: '未知参数 --bogus' })
    expect(parsePlanArgs(['daemon'])).toEqual({ ok: false, error: '未知子命令 daemon' })
    expect(parsePlanArgs(['wake', '--dry-run=1'])).toEqual({
      ok: false,
      error: '--dry-run 不接受值',
    })
  })

  it('每个取值参数缺值（末尾无值或 `=` 后为空）都报错，不吞下一个 flag', () => {
    for (const flag of [
      '--profile',
      '--session',
      '--jsonl',
      '--tenant',
      '--home',
      '--at',
      '--plan',
      '--file',
      '--window',
    ]) {
      expect(parsePlanArgs(['wake', flag]), flag).toEqual({ ok: false, error: `${flag} 需要一个值` })
      expect(parsePlanArgs(['wake', `${flag}=`]), flag).toEqual({
        ok: false,
        error: `${flag} 需要一个值`,
      })
    }
  })
})

describe('runPlan · 用法错误不启动宿主', () => {
  it('未知参数：退出码 2 + stderr 带用法，stdout 为空', async () => {
    const result = await run(['wake', '--bogus'])
    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('未知参数 --bogus')
    expect(result.err.join('\n')).toContain(PLAN_USAGE)
    expect(result.out).toEqual([])
  })

  it('list --help：退出码 0，只打用法', async () => {
    const result = await run(['list', '--help'])
    expect(result.code).toBe(0)
    expect(result.out.join('\n')).toBe(PLAN_USAGE)
    expect(result.err).toEqual([])
  })

  it('arm 缺 --file：退出码 2（不 boot）', async () => {
    const result = await run(['arm'])
    expect(result.code).toBe(2)
    expect(result.err.join('\n')).toContain('arm 需要 --file')
  })
})

describe('runPlan · plan profile 端到端', () => {
  it('list：空账本输出 JSON 空数组', async () => {
    const result = await run(['list', ...common(tempDir('home'), tempDir('jsonl'))])
    expect(result.code).toBe(0)
    expect(jsonOf(result.out)).toEqual([])
  })

  it('不传 --session / options.now：会话名用进程时钟派生，仍能读空账本', async () => {
    const result = await run(
      ['list', '--profile', 'plan', '--tenant', 'demo', '--home', tempDir('home'), '--jsonl', tempDir('jsonl')],
      { root: repoRoot, env: {} },
    )
    expect(result.code).toBe(0)
    expect(jsonOf(result.out)).toEqual([])
  })

  it('wake --dry-run：报告带判定时刻与 cli 来源，空账本不执行任何条目', async () => {
    const result = await run([
      'wake',
      '--dry-run',
      '--at',
      DUE_ISO,
      ...common(tempDir('home'), tempDir('jsonl')),
    ])
    expect(result.code).toBe(0)
    expect(jsonOf(result.out)).toMatchObject({
      at: Date.parse(DUE_ISO),
      now: NOW,
      source: 'cli',
      ok: true,
      entries: [],
      notified: [],
    })
  })

  it('wake --at 非法：退出码 2，且不输出报告', async () => {
    const result = await run([
      'wake',
      '--at',
      '明天',
      ...common(tempDir('home'), tempDir('jsonl')),
    ])
    expect(result.code).toBe(2)
    expect(result.out).toEqual([])
    expect(result.err.join('\n')).toContain('--at 不是合法时间')
  })

  it('wake --at 超前于本机时钟：报告 window-clock-ahead，退出码 1（不把未来计划提前花）', async () => {
    const future = new Date(NOW + 10 * 60 * 1000).toISOString()
    const result = await run([
      'wake',
      '--at',
      future,
      ...common(tempDir('home'), tempDir('jsonl')),
    ])
    expect(result.code).toBe(1)
    expect(jsonOf(result.out)).toMatchObject({
      at: Date.parse(future),
      now: NOW,
      source: 'cli',
      ok: false,
      code: 'window-clock-ahead',
      entries: [],
    })
  })

  it('arm → list → disarm → list：窗口走工具管线落账，撤销后仍是同一窗口（cancelled）', async () => {
    const home = tempDir('home')
    const jsonl = tempDir('jsonl')
    const planFile = join(tempDir('plan'), 'plan.json')
    writeFileSync(
      planFile,
      JSON.stringify({
        title: '查余额',
        planId: 'p-cli-arm',
        nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
        budgetYuan: 100,
        dueAt: DUE_ISO,
      }),
      'utf8',
    )

    const armed = await run(['arm', '--file', planFile, ...common(home, jsonl)])
    expect(armed.code).toBe(0)
    const armedPayload = jsonOf(armed.out) as { windowId?: unknown; state?: unknown; budgetCents?: unknown }
    expect(armedPayload).toMatchObject({
      planId: 'p-cli-arm',
      windowId: `w-cli-${String(NOW)}`,
      state: 'armed',
      budgetCents: 10_000,
    })
    const windowId = String(armedPayload.windowId)

    const listed = await run(['list', ...common(home, jsonl)])
    expect(listed.code).toBe(0)
    const rows = jsonOf(listed.out) as { windowId: string; state: string }[]
    expect(rows.find((row) => row.windowId === windowId)).toMatchObject({ state: 'armed' })

    const disarmed = await run(['disarm', '--window', windowId, ...common(home, jsonl)])
    expect(disarmed.code).toBe(0)

    const after = await run(['list', ...common(home, jsonl)])
    expect(after.code).toBe(0)
    const cancelled = jsonOf(after.out) as { windowId: string; state: string }[]
    expect(cancelled.find((row) => row.windowId === windowId)).toMatchObject({ state: 'cancelled' })
  })

  /**
   * 周期臂（`recurrence`）：`daily` 与 `yearly` 两条臂此前没有被任何用例走过。
   *
   * 值得单独跑一次端到端而不是单测纯函数：`plan_arm` 的出参是**落账的 ArmedPlan JSON**，
   * `replayArmedPlans` 与计划卡都按它读。周期规则一旦被静默丢掉，表现为
   * "用户说每天提醒，实际只发生一次"——而工具回包看起来完全正常。
   */
  it('arm --file 带 recurrence=daily / yearly：周期原样落账（不塌成 once）', async () => {
    async function arm(name: string, recurrence: Record<string, unknown>): Promise<unknown> {
      // 每个臂各用自己的一份 home/jsonl：窗口 ID 由 callId 派生，同一目录里两次 arm 会撞 window-duplicate
      const home = tempDir(`home-${name}`)
      const jsonl = tempDir(`jsonl-${name}`)
      const planFile = join(tempDir(name), 'plan.json')
      writeFileSync(
        planFile,
        JSON.stringify({
          title: '查余额',
          planId: `p-cli-${name}`,
          nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
          budgetYuan: 100,
          dueAt: DUE_ISO,
          recurrence,
        }),
        'utf8',
      )
      const result = await run(['arm', '--file', planFile, ...common(home, jsonl)])
      expect(result.code, name).toBe(0)
      return jsonOf(result.out)
    }

    expect(await arm('daily', { every: 'daily', at: '09:00' })).toMatchObject({
      recurrence: { every: 'daily', at: '09:00' },
    })
    expect(await arm('yearly', { every: 'yearly', month: 12, day: 25, at: '09:00' })).toMatchObject({
      recurrence: { every: 'yearly', month: 12, day: 25, at: '09:00' },
    })
  })

  it('arm yearly 缺 day / 越界 ⇒ 退出码 1 且回包带 plan-arm-invalid（不降级成 monthly）', async () => {
    const home = tempDir('home-yearly-bad')
    const jsonl = tempDir('jsonl-yearly-bad')

    for (const recurrence of [
      { every: 'yearly', month: 12, at: '09:00' },
      { every: 'yearly', month: 13, day: 1, at: '09:00' },
      { every: 'yearly', month: 12, day: 32, at: '09:00' },
      { every: 'yearly', month: 12, day: 1 },
    ]) {
      const planFile = join(tempDir('yearly-bad'), 'plan.json')
      writeFileSync(
        planFile,
        JSON.stringify({
          title: '查余额',
          planId: 'p-cli-yearly-bad',
          nodes: [{ id: 'bal', tool: 'account_balance', args: {}, deps: [] }],
          budgetYuan: 100,
          dueAt: DUE_ISO,
          recurrence,
        }),
        'utf8',
      )
      const result = await run(['arm', '--file', planFile, ...common(home, jsonl)])
      expect(result.code, JSON.stringify(recurrence)).toBe(1)
      expect((result.out.join('\n') + result.err.join('\n')), JSON.stringify(recurrence)).toContain(
        'plan-arm-invalid',
      )
    }
  })

  it('arm --file 不存在 / 不是 JSON：退出码 1（运行期失败，不是用法错误）', async () => {
    const home = tempDir('home')
    const jsonl = tempDir('jsonl')
    const missing = await run([
      'arm',
      '--file',
      join(tempDir('missing'), 'nope.json'),
      ...common(home, jsonl),
    ])
    expect(missing.code).toBe(1)
    expect(missing.err.join('\n')).toContain('bah plan:')

    const broken = join(tempDir('broken'), 'bad.json')
    writeFileSync(broken, '{ not json', 'utf8')
    const malformed = await run(['arm', '--file', broken, ...common(home, jsonl)])
    expect(malformed.code).toBe(1)
    expect(malformed.err.join('\n')).toContain('bah plan:')
  })

  it('arm --file 是合法 JSON 但顶层不是对象：按空参数走管线，工具拒绝 → 退出码 1', async () => {
    const file = join(tempDir('array'), 'array.json')
    writeFileSync(file, '[1,2]', 'utf8')
    const result = await run([
      'arm',
      '--file',
      file,
      ...common(tempDir('home'), tempDir('jsonl')),
    ])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('bah plan: plan_arm 失败')
  })

  it('disarm 未知窗口：工具返回 isError，CLI 退出码 1', async () => {
    const result = await run([
      'disarm',
      '--window',
      'w-not-armed',
      ...common(tempDir('home'), tempDir('jsonl')),
    ])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('plan_disarm')
  })

  it('没有 profile 也没有 bah.yml：退出码 1，提示缺 --profile', async () => {
    const emptyRoot = tempDir('empty-root')
    const result = await run(
      ['list', '--jsonl', tempDir('jsonl'), '--home', tempDir('home')],
      { root: emptyRoot, now: () => NOW, env: {} },
    )
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('未指定 --profile')
  })

  it('--session 不是合法路径段：退出码 1，不落盘', async () => {
    const result = await run([
      'list',
      '--profile',
      'plan',
      '--session',
      '../escape',
      '--jsonl',
      tempDir('jsonl'),
      '--home',
      tempDir('home'),
    ])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('--session 不是合法的路径段')
  })
})
