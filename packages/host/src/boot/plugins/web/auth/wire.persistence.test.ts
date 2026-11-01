/**
 * 认证面装配（`wire.ts`，租户与鉴权 02 · TA-24）的三条接线。
 *
 * `handlers/auth.test.ts` 的 TA-30 只喂了 `DECISION_AUDIT`，所以这里补的是**另外三个
 * "取不到就降级"的服务被真正接上**的那一侧：
 *
 * 1. `SESSION_FILES` 在场 ⇒ 会话日志落 `<租户根>/auth/sessions.jsonl`，重启后旧 cookie
 *    仍然有效（少了这一步，"重启即全员重新登录"是静默发生的）；
 * 2. `BANK_USER_DIRECTORY` 在场 ⇒ 口令目录里每个 `userId` 都要过银行数据集（TA-22 校验 5）。
 *    这道桥断了，症状是"登录成功、第一次工具调用才炸"；
 * 3. `static` 模式 ⇒ 即使 persistence 在场也不许在磁盘上留 `auth/`（A3 零回归）。
 *
 * 只用临时目录与入库的示例目录（`auth/users.example.yml`，口令 `demo1234`），不碰真实网络。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createContext } from '@bah/core'
import { captureThrown } from '@bah/test-support'
import { parseTenantId } from '@bah/util'

import type { IncomingMessage } from 'node:http'

import { DEFAULT_WEB } from '../config.ts'
import { BANK_USER_DIRECTORY } from '../../bank-tools.ts'
import { SESSION_FILES, type SessionFiles } from '../../persistence.ts'
import { createWebAuthRuntime } from './wire.ts'

const TENANT = 'demo'
const WEB_TOKEN = 'tok-web'
const SERVER_CSRF = 'process-csrf'
const NOW = 1_700_000_000_000
const EXAMPLE_DIRECTORY = 'auth/users.example.yml'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一套 `<部署根>/<租户>` 的会话文件桩（与 `core:persistence` 的布局同式）。 */
function sessionFiles(): SessionFiles {
  const baseRoot = mkdtempSync(join(tmpdir(), 'bah-auth-wire-'))
  dirs.push(baseRoot)
  const root = join(baseRoot, TENANT)
  return {
    root,
    baseRoot,
    tenantId: parseTenantId(TENANT),
    fileOf: (id) => join(root, String(id), 'session.jsonl'),
  }
}

/**
 * 装一个认证运行期。
 *
 * `run` / `config` 用 `as never` 是因为 `RunContext` 的必填字段远多于装配实际读到的
 * 三个（tenantId/now/sessionId）——与 `handlers/auth.test.ts` TA-30 同一口径。
 */
function wireOf(
  files: SessionFiles,
  options: { readonly mode?: 'password' | 'static'; readonly knownUserIds?: (userId: string) => boolean } = {},
): { readonly runtime: ReturnType<typeof createWebAuthRuntime>; readonly warnings: readonly string[] } {
  const ctx = createContext()
  ctx.provide(SESSION_FILES, files)
  if (options.knownUserIds !== undefined) {
    ctx.provide(BANK_USER_DIRECTORY, { has: options.knownUserIds, list: () => [] })
  }
  const warnings: string[] = []
  const runtime = createWebAuthRuntime({
    ctx,
    run: { sessionId: 's-wire', tenantId: parseTenantId(TENANT), now: () => NOW },
    config: {
      ...DEFAULT_WEB,
      auth: {
        ...DEFAULT_WEB.auth,
        mode: options.mode ?? 'password',
        directory: { path: EXAMPLE_DIRECTORY },
      },
    },
    webToken: WEB_TOKEN,
    serverCsrf: SERVER_CSRF,
    warn: (message: string) => warnings.push(message),
  } as never)
  return { runtime, warnings }
}

/** 只带 cookie 的最小请求（`identify` 的 password 分支只读 headers）。 */
function reqWithCookie(cookie: string): IncomingMessage {
  return { headers: { cookie }, method: 'GET', url: '/api/session' } as unknown as IncomingMessage
}

describe('TA-24 · 认证会话日志的落盘接线', () => {
  it('TA-24-8 password + persistence → issue 落 <租户根>/auth/sessions.jsonl，重启后 cookie 仍有效', async () => {
    const files = sessionFiles()
    const { runtime, warnings } = wireOf(files)

    const login = await runtime.login({ userId: 'u-1', password: 'demo1234', ip: '10.0.0.1' })
    expect(login.ok).toBe(true)
    if (!login.ok) return

    expect(existsSync(join(files.root, 'auth', 'sessions.jsonl'))).toBe(true)
    // 与会话目录**同级**：塞进 `<sessionId>/` 会让审计回放读到认证流水
    expect(existsSync(join(files.root, 's-wire'))).toBe(false)
    // persistence 在场就不该出现"只存内存"的降级告警
    expect(warnings.filter((line) => line.includes('只存内存'))).toEqual([])

    const lines = readFileSync(join(files.root, 'auth', 'sessions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines[0]).toMatchObject({
      type: 'issue',
      tenantId: TENANT,
      userId: 'u-1',
      sid: login.session.sid,
    })

    // 换一套装配 = 进程重启：同一个 sid 仍解析出主体（纯内存版在这里会变成 anonymous）
    expect(wireOf(files).runtime.identify(reqWithCookie(`bah_sid=${login.session.sid}`), NOW).kind).toBe(
      'principal',
    )
  })

  it('TA-24-9 static 模式即使 persistence 在场也不在磁盘留 auth/（A3 零回归），静态凭证照旧可用', () => {
    const files = sessionFiles()
    const { runtime, warnings } = wireOf(files, { mode: 'static' })

    expect(existsSync(join(files.root, 'auth'))).toBe(false)
    expect(warnings.filter((line) => line.includes('只存内存'))).toEqual([])
    const identity = runtime.identify(
      {
        headers: { authorization: `Bearer ${WEB_TOKEN}` },
        method: 'GET',
        url: '/api/session',
      } as unknown as IncomingMessage,
      NOW,
    )
    expect(identity.kind).toBe('service')
  })
})

describe('TA-22 校验 5 · 口令目录与银行数据集之间的桥', () => {
  it('TA-22-12 userId 不在银行数据集里 → boot 期 auth-directory-unknown-user（不带病登录）', () => {
    const files = sessionFiles()
    const asked: string[] = []

    const error = captureThrown(() =>
      wireOf(files, {
        knownUserIds: (userId) => {
          asked.push(userId)
          return false
        },
      }),
    )
    expect((error as { code?: string }).code).toBe('auth-directory-unknown-user')
    // 桥是逐个问过去的，不是"服务在场就放行"
    expect(asked).toContain('u-1')
  })

  it('TA-22-13 数据集里有这个人 → 装配成功（同一条桥不误伤）', () => {
    const files = sessionFiles()
    expect(() => wireOf(files, { knownUserIds: () => true })).not.toThrow()
  })
})
