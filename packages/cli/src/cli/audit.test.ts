import { generateKeyPairSync } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SIGNED_TYPES,
  createSagaAudit,
  loadSqlite,
  merkleRootOf,
  periodOf,
} from '@bah/persistence'
import { afterEach, describe, expect, it } from 'vitest'

import { parseAuditArgs, runAudit } from './audit.ts'

import type { ChainRecord } from '@bah/persistence'
import type { CliIo } from './run.ts'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-audit-cli-'))
  cleanup.push(dir)
  return dir
}

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, io: { out: (line) => out.push(line), err: (line) => err.push(line) } }
}

async function run(
  dir: string,
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const captured = capture()
  const code = await runAudit(args, captured.io, {
    root: dir,
    now: () => 1_700_000_000_000,
  })
  return { code, out: captured.out.join('\n'), err: captured.err.join('\n') }
}

function keyFile(dir: string): { path: string } {
  const { privateKey } = generateKeyPairSync('ed25519')
  const path = join(dir, 'saga-ed25519.pem')
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { path }
}

function makeChain(
  dir: string,
  sagaId: string,
  types: readonly string[],
  signedKey?: string,
): void {
  const writer = createSagaAudit({
    now: () => 1_700_000_000_000,
    rootDir: join(dir, 'demo'),
    fsync: false,
    warn: () => undefined,
    signedTypes: signedKey === undefined ? [] : [...SIGNED_TYPES],
    ...(signedKey === undefined ? {} : { signingKeyPath: signedKey }),
  })
  for (const type of types) writer.append(sagaId, type, { sagaId, stepId: 's1', compId: 'c1' })
}

function chainRows(dir: string, sagaId: string): ChainRecord[] {
  return readFileSync(join(dir, 'demo', sagaId, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChainRecord)
}

function anchorOf(dir: string, sagaIds: readonly string[]): { period: string; root: string } {
  const rows = sagaIds
    .flatMap((sagaId) => chainRows(dir, sagaId))
    .sort((left, right) => (left.s === right.s ? left.q - right.q : left.s < right.s ? -1 : 1))
  const period = periodOf(rows[0]!.recordedAt)
  const leaves = rows.filter((row) => periodOf(row.recordedAt) === period).map((row) => row.r)
  return { period, root: merkleRootOf(leaves) }
}

function writeAnchors(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'demo', 'anchors.json'), JSON.stringify(value), 'utf8')
}

function makeDb(dir: string, rows: ReadonlyArray<readonly [string, string]>, name = 'saga.sqlite'): void {
  const Database = loadSqlite().DatabaseSync
  const db = new Database(join(dir, name))
  db.exec('CREATE TABLE saga_transaction (saga_id TEXT PRIMARY KEY, state TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO saga_transaction (saga_id, state) VALUES (?, ?)')
  for (const [sagaId, state] of rows) insert.run(sagaId, state)
  db.close()
}

describe('parseAuditArgs', () => {
  it('默认值', () => {
    expect(parseAuditArgs([])).toEqual({
      ok: true,
      args: {
        dir: 'sessions',
        tenant: 'demo',
        db: join('sessions', 'saga.sqlite'),
        key: 'keys/saga-ed25519.pem',
        format: 'text',
        noProjection: false,
        noSignature: false,
        help: false,
      },
    })
  })

  it('全部 flag（= 形式）', () => {
    expect(
      parseAuditArgs([
        '--dir=x',
        '--saga=s',
        '--db=d.sqlite',
        '--key=k.pem',
        '--format=json',
        '--no-projection',
        '--no-signature',
      ]),
    ).toEqual({
      ok: true,
      args: {
        dir: 'x',
        tenant: 'demo',
        saga: 's',
        db: 'd.sqlite',
        key: 'k.pem',
        format: 'json',
        noProjection: true,
        noSignature: true,
        help: false,
      },
    })
  })

  it('独立取值形式与 --dir 派生的默认库', () => {
    const parsed = parseAuditArgs(['--dir', 'x', '--format', 'text'])
    expect(parsed.ok && parsed.args.db).toBe(join('x', 'saga.sqlite'))
    expect(parsed.ok && parsed.args.format).toBe('text')
  })

  it('缺值 → 用法错误', () => {
    for (const flag of ['--dir', '--saga', '--db', '--key', '--format']) {
      expect(parseAuditArgs([flag]).ok).toBe(false)
    }
  })

  it('非法 format / 未知 flag → 用法错误', () => {
    expect(parseAuditArgs(['--format', 'xml']).ok).toBe(false)
    expect(parseAuditArgs(['--bogus']).ok).toBe(false)
  })

  it('布尔开关不接受值', () => {
    for (const raw of ['--no-projection=1', '--no-signature=1', '--help=1']) {
      expect(parseAuditArgs([raw]).ok).toBe(false)
    }
  })

  it('-h / --help', () => {
    expect(parseAuditArgs(['-h']).ok && parseAuditArgs(['-h'])).toMatchObject({ args: { help: true } })
    expect(parseAuditArgs(['--help']).ok && parseAuditArgs(['--help'])).toMatchObject({
      args: { help: true },
    })
  })
})

describe('runAudit：用法与环境', () => {
  it('--help 退出 0', async () => {
    const result = await run(root(), ['--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('bah audit')
  })

  it('解析失败退出 2', async () => {
    const result = await run(root(), ['--bogus'])
    expect(result.code).toBe(2)
    expect(result.err).toContain('未知参数')
  })

  it('目录不存在 / 不是目录 / 无链 / 指定链不存在 → 2', async () => {
    const dir = root()
    expect((await run(dir, ['--dir', join(dir, 'nope')])).code).toBe(2)

    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x', 'utf8')
    expect((await run(dir, ['--dir', 'file.txt'])).code).toBe(2)

    expect((await run(dir, ['--dir', '.'])).code).toBe(2)

    makeChain(dir, 'a', ['saga/created'])
    expect((await run(dir, ['--dir', '.', '--saga', 'nope'])).code).toBe(2)
    expect((await run(dir, ['--dir', '.', '--saga', '../x'])).code).toBe(2)
  })
})

describe('runAudit：链与签名', () => {
  it('无签名链 + 无库 + --no-projection：JSON 通过', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    const result = await run(dir, [
      '--dir',
      '.',
      '--no-projection',
      '--no-signature',
      '--format',
      'json',
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.out) as {
      chains: Array<Record<string, unknown>>
      anchors: Array<Record<string, unknown>>
      ok: boolean
      exitCode: number
      dbState: string
    }
    expect(report.ok).toBe(true)
    expect(report.exitCode).toBe(0)
    expect(report.dbState).toBe('disabled')
    expect(report.chains[0]).toMatchObject({
      sagaId: 'a',
      events: 1,
      chainOk: true,
      signatureState: 'skipped-disabled',
      projectionState: 'skipped-disabled',
    })
    expect(report.anchors[0]).toMatchObject({ state: 'ledger-missing' })
  })

  it('库不存在：skipped-no-db，文本显示通过', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    const result = await run(dir, ['--dir', '.', '--no-signature'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('skipped-no-db')
    expect(result.out).toContain('结论：通过')
  })

  it('库状态 RUNNING：diff=0；CREATED：diff≠0 → 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])

    makeDb(dir, [['a', 'RUNNING']])
    const zero = await run(dir, ['--dir', '.', '--no-signature'])
    expect(zero.code).toBe(0)
    expect(zero.out).toContain('diff=0')

    rmSync(join(dir, 'saga.sqlite'))
    makeDb(dir, [['a', 'CREATED']])
    const drift = await run(dir, ['--dir', '.', '--no-signature', '--format', 'json'])
    expect(drift.code).toBe(1)
    expect(JSON.parse(drift.out).chains[0].projectionState).toBe('diff-nonzero')
  })

  it('库里有链上没有的事务 → 反向缺口，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    makeDb(dir, [
      ['a', 'RUNNING'],
      ['extra', 'RUNNING'],
    ])
    const json = await run(dir, ['--dir', '.', '--no-signature', '--format', 'json'])
    expect(json.code).toBe(1)
    expect(JSON.parse(json.out).reverseGaps).toEqual(['extra'])

    const text = await run(dir, ['--dir', '.', '--no-signature'])
    expect(text.out).toContain('反向缺口：extra')
  })

  it('截断尾行：warn 出口被调用，链仍通过', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    appendFileSync(join(dir, 'demo', 'a', 'audit.jsonl'), '{"truncated":', 'utf8')

    const result = await run(dir, ['--dir', '.', '--no-projection', '--no-signature'])
    expect(result.code).toBe(0)
    expect(result.err).toContain('丢弃截断的链尾行')
  })

  it('库不可读 → db-invalid，退出 2', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    const Database = loadSqlite().DatabaseSync
    const db = new Database(join(dir, 'saga.sqlite'))
    db.exec('CREATE TABLE saga_transaction (saga_id TEXT PRIMARY KEY, state TEXT NOT NULL)')
    db.exec('DROP TABLE saga_transaction')
    db.close()

    const result = await run(dir, ['--dir', '.', '--no-signature', '--format', 'json'])
    expect(result.code).toBe(2)
    const report = JSON.parse(result.out)
    expect(report.dbState).toBe('invalid')
    expect(report.chains[0].projectionState).toBe('db-invalid')
  })

  it('篡改链 → 链断，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    const path = join(dir, 'demo', 'a', 'audit.jsonl')
    const row = JSON.parse(readFileSync(path, 'utf8').trim()) as ChainRecord
    writeFileSync(path, `${JSON.stringify({ ...row, d: 'tampered' })}\n`, 'utf8')

    const result = await run(dir, ['--dir', '.', '--no-signature'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('链断于 1')
    expect(result.out).toContain('结论：发现异常')
    // W08 TC-04：断链告警必须点名事件与条目（stderr）
    expect(result.err).toContain('audit/chain-broken a brokenAt=1')
  })

  it('链文件中间行损坏 → errors，退出 1', async () => {
    const dir = root()
    mkdirSync(join(dir, 'demo', 'bad'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'bad', 'audit.jsonl'), '{"bad":1}\n{"bad":2}\n', 'utf8')

    const result = await run(dir, ['--dir', '.', '--no-projection', '--no-signature'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('错误：')
    expect(result.out).toContain('结论：发现异常')
  })

  it('签名链：缺密钥 → skipped-no-key、退出 2；有效密钥 → 通过', async () => {
    const dir = root()
    const key = keyFile(dir)
    makeChain(dir, 's', ['saga/comp-issued'], key.path)

    const missing = await run(dir, [
      '--dir',
      '.',
      '--key',
      join(dir, 'missing.pem'),
      '--no-projection',
      '--format',
      'json',
    ])
    expect(missing.code).toBe(2)
    expect(JSON.parse(missing.out).chains[0].signatureState).toBe('skipped-no-key')

    const ok = await run(dir, [
      '--dir',
      '.',
      '--key',
      key.path,
      '--no-projection',
      '--format',
      'json',
    ])
    expect(ok.code).toBe(0)
    expect(JSON.parse(ok.out).chains[0].signatureState).toBe('verified')
  })

  it('伪造签名 → invalid，退出 1', async () => {
    const dir = root()
    const key = keyFile(dir)
    makeChain(dir, 's', ['saga/comp-issued'], key.path)
    const path = join(dir, 'demo', 's', 'audit.jsonl')
    const row = JSON.parse(readFileSync(path, 'utf8').trim()) as ChainRecord
    writeFileSync(
      path,
      `${JSON.stringify({ ...row, sig: Buffer.from('forged').toString('base64') })}\n`,
      'utf8',
    )

    const result = await run(dir, ['--dir', '.', '--key', key.path, '--no-projection'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('invalid')
  })

  it('类型内缺签名（2 应签、1 实签）→ 退出 1', async () => {
    const dir = root()
    const key = keyFile(dir)
    makeChain(dir, 's', ['saga/comp-issued', 'saga/comp-issued'], key.path)
    const path = join(dir, 'demo', 's', 'audit.jsonl')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    const first = JSON.parse(lines[0] as string) as ChainRecord
    const { sig: _sig, ...unsigned } = first
    lines[0] = JSON.stringify(unsigned)
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')

    const result = await run(dir, [
      '--dir',
      '.',
      '--key',
      key.path,
      '--no-projection',
      '--format',
      'json',
    ])
    expect(result.code).toBe(1)
    const chain = JSON.parse(result.out).chains[0]
    expect(chain.signatureState).toBe('verified')
    expect(chain.signedExpected).toBe(2)
    expect(chain.signedPresent).toBe(1)
  })
})

describe('runAudit：锚定', () => {
  it('根一致 → matches', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    const anchor = anchorOf(dir, ['a'])
    writeAnchors(dir, { [anchor.period]: anchor.root })

    const result = await run(dir, [
      '--dir',
      '.',
      '--no-projection',
      '--no-signature',
      '--format',
      'json',
    ])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out).anchors[0].state).toBe('matches')
  })

  it('根不符 → mismatch，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    const anchor = anchorOf(dir, ['a'])
    writeAnchors(dir, { [anchor.period]: 'wrong' })

    const result = await run(dir, ['--dir', '.', '--no-projection', '--no-signature'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('mismatch')
  })

  it('台账损坏 → ledger-invalid，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    writeFileSync(join(dir, 'demo', 'anchors.json'), '{', 'utf8')

    const result = await run(dir, ['--dir', '.', '--no-projection', '--no-signature'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('ledger-invalid')
  })

  it('台账有 period、链上无叶子 → orphan-ledger，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    writeAnchors(dir, { '2024-01': 'orphan' })

    const result = await run(dir, ['--dir', '.', '--no-projection', '--no-signature'])
    expect(result.code).toBe(1)
    expect(result.out).toContain('orphan-ledger')
  })

  it('--saga 时其他链损坏：记入 errors，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    mkdirSync(join(dir, 'demo', 'bad'), { recursive: true })
    writeFileSync(join(dir, 'demo', 'bad', 'audit.jsonl'), '{"bad":1}\n{"bad":2}\n', 'utf8')

    const result = await run(dir, [
      '--dir',
      '.',
      '--saga',
      'a',
      '--no-projection',
      '--no-signature',
      '--format',
      'json',
    ])
    expect(result.code).toBe(1)
    const report = JSON.parse(result.out)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toContain('bad')
  })

  it('--saga 过滤链时，锚定仍按目录全部链计算', async () => {
    const dir = root()
    makeChain(dir, 'a', ['saga/created'])
    makeChain(dir, 'b', ['saga/created'])
    const anchor = anchorOf(dir, ['a', 'b'])
    writeAnchors(dir, { [anchor.period]: anchor.root })

    const result = await run(dir, [
      '--dir',
      '.',
      '--saga',
      'a',
      '--no-projection',
      '--no-signature',
      '--format',
      'json',
    ])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.out)
    expect(report.chains).toHaveLength(1)
    expect(report.anchors[0].state).toBe('matches')
  })
})

describe('runAudit：diff-error', () => {
  it('目录名与链内 sagaId 不一致 → reduceSaga 抛错 → diff-error，退出 1', async () => {
    const dir = root()
    makeChain(dir, 'x', ['saga/created'])
    mkdirSync(join(dir, 'demo', 'y'), { recursive: true })
    copyFileSync(join(dir, 'demo', 'x', 'audit.jsonl'), join(dir, 'demo', 'y', 'audit.jsonl'))
    makeDb(dir, [['y', 'RUNNING']])

    const result = await run(dir, ['--dir', '.', '--saga', 'y', '--no-signature', '--format', 'json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out).chains[0].projectionState).toBe('diff-error')
  })
})
