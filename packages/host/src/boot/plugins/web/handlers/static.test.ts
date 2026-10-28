/**
 * 坐席入口的静态面（人机接管 02 · B1）。
 *
 * 钉住三条安全性质：
 * 1. 未配 `BAH_OPERATOR_TOKEN` ⇒ `/operator` 与 `/operator.html` 都 404（不暴露存在性）；
 * 2. 两个入口都**零注入**：响应体不含 web token / 坐席 token / `bah-web-token` meta；
 * 3. 客户首页仍然照旧注入 token + CSRF cookie（回归，不许被 B1 带坏）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { WebDeps, WebRequest } from '../deps.ts'
import { handleStatic } from './static.ts'

const WEB_TOKEN = 'web-token-secret'
const OPERATOR_TOKEN = 'operator-token-secret'

const dirs: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bah-static-'))
  dirs.push(root)
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>INDEX</title></head><body>INDEX</body></html>',
    'utf8',
  )
  writeFileSync(
    join(root, 'operator.html'),
    '<!doctype html><html><head><title>SEAT</title></head><body>SEAT</body></html>',
    'utf8',
  )
  return root
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRes(): {
  readonly res: ServerResponse
  read(): { status: number; headers: Record<string, string>; body: string }
} {
  const chunks: Buffer[] = []
  const headers: Record<string, string> = {}
  let status = 0
  const res = {
    headersSent: false,
    writeHead(code: number, extra: Record<string, string>) {
      status = code
      Object.assign(headers, extra)
      return this
    },
    end(body?: Buffer | string) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
  } as unknown as ServerResponse
  return {
    res,
    read: () => ({ status, headers, body: Buffer.concat(chunks).toString('utf8') }),
  }
}

function makeDeps(root: string, operatorToken: string | undefined): WebDeps {
  return {
    staticRoot: root,
    indexPath: join(root, 'index.html'),
    operatorIndexPath: join(root, 'operator.html'),
    webToken: WEB_TOKEN,
    operatorToken,
    csrfToken: 'csrf-token-secret',
    // handleStatic 只用上面六个字段；其余用空桩满足类型
  } as unknown as WebDeps
}

function request(path: string, method = 'GET'): WebRequest {
  return { method, url: new URL(`http://127.0.0.1${path}`), path, rest: '' }
}

async function get(
  root: string,
  operatorToken: string | undefined,
  path: string,
  method = 'GET',
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const { res, read } = makeRes()
  await handleStatic({} as never, res, request(path, method), makeDeps(root, operatorToken))
  return read()
}

describe('B1 坐席入口（零注入）', () => {
  it('B1-01 未配坐席凭证 → /operator 404', async () => {
    const root = makeRoot()
    const response = await get(root, undefined, '/operator')
    expect(response.status).toBe(404)
    expect(response.body).toContain('web-not-found')
  })

  it('未配坐席凭证 → /operator.html 也 404（存在性同样不白给）', async () => {
    const root = makeRoot()
    expect((await get(root, undefined, '/operator.html')).status).toBe(404)
  })

  it('B1-02 配了 → /operator 200 text/html，且 B1-03/04/05 零凭证', async () => {
    const root = makeRoot()
    const response = await get(root, OPERATOR_TOKEN, '/operator')
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('SEAT')
    expect(response.body).not.toContain(OPERATOR_TOKEN)
    expect(response.body).not.toContain(WEB_TOKEN)
    expect(response.body).not.toContain('bah-web-token')
    // 不是 index ⇒ 不写 CSRF cookie、可缓存
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['cache-control']).toBe('no-cache')
  })

  it('B1-06 /operator.html 直接访问同样零注入', async () => {
    const root = makeRoot()
    const response = await get(root, OPERATOR_TOKEN, '/operator.html')
    expect(response.status).toBe(200)
    expect(response.body).toContain('SEAT')
    expect(response.body).not.toContain('bah-web-token')
    expect(response.body).not.toContain(WEB_TOKEN)
  })

  it('客户首页仍注入 token 与 CSRF cookie（回归）', async () => {
    const root = makeRoot()
    const response = await get(root, OPERATOR_TOKEN, '/')
    expect(response.status).toBe(200)
    expect(response.body).toContain('<meta name="bah-web-token"')
    expect(response.body).toContain(WEB_TOKEN)
    expect(response.headers['set-cookie']).toContain('bah_csrf=csrf-token-secret')
    expect(response.headers['cache-control']).toBe('no-store')
  })
})
