/**
 * 口令目录（租户与鉴权 02 · TA-22）。
 *
 * 六条 boot 期校验各一条用例：**全部 fail-loud**——`mode: password` 没有可用的目录
 * 等于一座空城，必须启动就失败。示例文件 `auth/users.example.yml` 也在这里被验，
 * 免得"示例本身不合法"这类事故（新人第一件事就是 cp 它）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { BahError } from '@bah/util'

import { loadDirectory } from './directory.ts'

const dirs: string[] = []
function tempFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bah-auth-directory-'))
  dirs.push(dir)
  const path = join(dir, 'users.yml')
  writeFileSync(path, content, 'utf8')
  return path
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const HASH = 'scrypt$16384$8$1$AAAA$BBBB'

/** 一份最小合法目录。 */
function yaml(overrides: { readonly tenant?: string; readonly users?: readonly string[] } = {}): string {
  return [
    'version: 1',
    `tenant: ${overrides.tenant ?? 'demo'}`,
    'users:',
    ...(overrides.users ?? [
      `  - userId: u-1`,
      '    phone: "13800000001"',
      '    roles: [customer]',
      `    password: "${HASH}"`,
    ]),
  ].join('\n')
}

/** 取错误码。 */
function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof BahError) return error.code
    throw error
  }
  throw new Error('期望抛错，但没有抛')
}

describe('loadDirectory', () => {
  it('TA-22-0 入库的示例目录本身合法（cp 过来就能用）', () => {
    const directory = loadDirectory('auth/users.example.yml', 'demo', { warn: () => undefined })
    expect(directory.tenant).toBe('demo')
    expect(directory.size).toBe(1)
    expect(directory.findById('u-1')?.roles).toEqual(['customer', 'agent'])
    expect(directory.findByPhone('13800000001')?.userId).toBe('u-1')
  })

  it('TA-22-0b 未注入 warn → 走默认告警出口，不影响加载', () => {
    expect(loadDirectory('auth/users.example.yml', 'demo').size).toBe(1)
  })

  it('TA-22-1 文件缺失 → auth-directory-missing', () => {
    expect(codeOf(() => loadDirectory('auth/no-such-file.yml', 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-missing',
    )
  })

  it('TA-22-2 tenant 不一致 → auth-directory-tenant-mismatch（把 demo 的目录拷给 acme）', () => {
    const path = tempFile(yaml({ tenant: 'demo' }))
    expect(codeOf(() => loadDirectory(path, 'acme', { warn: () => undefined }))).toBe(
      'auth-directory-tenant-mismatch',
    )
  })

  it('TA-22-3 userId 重复 / 含斜杠 → auth-directory-invalid', () => {
    const duplicate = tempFile(
      yaml({
        users: [
          `  - userId: u-1`,
          '    phone: "13800000001"',
          '    roles: [customer]',
          `    password: "${HASH}"`,
          `  - userId: u-1`,
          '    phone: "13800000002"',
          '    roles: [customer]',
          `    password: "${HASH}"`,
        ],
      }),
    )
    expect(codeOf(() => loadDirectory(duplicate, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
    const slash = tempFile(
      yaml({
        users: [
          `  - userId: "u/1"`,
          '    phone: "13800000001"',
          '    roles: [customer]',
          `    password: "${HASH}"`,
        ],
      }),
    )
    expect(codeOf(() => loadDirectory(slash, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-4 未知角色 / 空角色 → auth-directory-invalid', () => {
    const unknown = tempFile(
      yaml({
        users: [
          `  - userId: u-1`,
          '    phone: "13800000001"',
          '    roles: [root]',
          `    password: "${HASH}"`,
        ],
      }),
    )
    expect(codeOf(() => loadDirectory(unknown, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
    const empty = tempFile(
      yaml({
        users: [
          `  - userId: u-1`,
          '    phone: "13800000001"',
          '    roles: []',
          `    password: "${HASH}"`,
        ],
      }),
    )
    expect(codeOf(() => loadDirectory(empty, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-5 userId 不在数据集 → auth-directory-unknown-user（不是等第一次工具调用才炸）', () => {
    const path = tempFile(yaml())
    expect(
      codeOf(() =>
        loadDirectory(path, 'demo', { warn: () => undefined, knownUserIds: () => false }),
      ),
    ).toBe('auth-directory-unknown-user')
  })

  it('TA-22-6 明文口令 / 非 scrypt 编码串 → auth-directory-invalid', () => {
    const plain = tempFile(
      yaml({
        users: [
          `  - userId: u-1`,
          '    phone: "13800000001"',
          '    roles: [customer]',
          '    password: "demo1234"',
        ],
      }),
    )
    expect(codeOf(() => loadDirectory(plain, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-7 坏 YAML → auth-directory-invalid（不冒充"策略文件坏了"）', () => {
    const path = tempFile('version: 1\n  tenant: [unclosed\n')
    expect(codeOf(() => loadDirectory(path, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-8 手机号重复 → auth-directory-invalid（按手机号登录不能二义）', () => {
    const path = tempFile(
      yaml({
        users: [
          `  - userId: u-1`,
          '    phone: "13800000001"',
          '    roles: [customer]',
          `    password: "${HASH}"`,
          `  - userId: u-2`,
          '    phone: "13800000001"',
          '    roles: [customer]',
          `    password: "${HASH}"`,
        ],
      }),
    )
    expect(codeOf(() => loadDirectory(path, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-9 version / 顶层形状 / 空 users → auth-directory-invalid（口径漂移必须启动即失败）', () => {
    const wrongVersion = tempFile('version: 2\ntenant: demo\nusers: []\n')
    expect(codeOf(() => loadDirectory(wrongVersion, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
    const arrayTop = tempFile('- version: 1\n- tenant: demo\n')
    expect(codeOf(() => loadDirectory(arrayTop, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
    const emptyUsers = tempFile('version: 1\ntenant: demo\nusers: []\n')
    expect(codeOf(() => loadDirectory(emptyUsers, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-10 非法租户 ID → auth-directory-invalid（先于 tenant 一致性判定）', () => {
    const path = tempFile(yaml({ tenant: 'Demo!' }))
    expect(codeOf(() => loadDirectory(path, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })

  it('TA-22-11 字段类型不对（tenant 非字符串 / users 元素非对象）→ auth-directory-invalid', () => {
    const badTenant = tempFile('version: 1\ntenant: 123\nusers: []\n')
    expect(codeOf(() => loadDirectory(badTenant, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
    const badEntry = tempFile('version: 1\ntenant: demo\nusers:\n  - 42\n')
    expect(codeOf(() => loadDirectory(badEntry, 'demo', { warn: () => undefined }))).toBe(
      'auth-directory-invalid',
    )
  })
})
