/**
 * 桌面渠道的**装配级**冒烟（桌面端 01 §3 步 6 / T-DTB-CH-003）。
 *
 * ## 这条用例比 `--dump-config` 多证明了什么
 *
 * `--dump-config` 只证明"配置能被解析"。它不证明：
 *   ① `port: 0` 真的由内核分配到一个可用端口（不是 0、不是 Fetch 禁用端口）；
 *   ② 真的只绑 loopback（`WebServerInfo.url` 的 host 段）；
 *   ③ `channel:desktop` 取到的是**桌面适配器**（`/api/session` 上报的 `channel`）；
 *   ④ token 注入链路对桌面壳同样成立（`index.html` 里的 meta）。
 * 这四件事恰好是 01 出口标准 1/3 的实质内容，所以必须走一次真 boot 真 HTTP。
 *
 * ## 为什么放在 `scripts/` 而不是包里
 *
 * 它需要同时 `import` `@bah/cli`（profile 三层读取）与 `@bah/host`（boot）。
 * 放进 `packages/host` 会让 host 的测试反向依赖 cli（project references 成环），
 * 放进 `packages/cli` 则要把 HTTP 断言写进 CLI 的测试面。`scripts/` 是两者之上的
 * 装配层，与 `scripts/policy-explain.test.ts` 同一位置与同一理由。
 *
 * ## 边界（如实登记）
 *
 * 不需要 `BAH_WEB_TOKEN` 外部注入：本用例自己设，跑完还原。`bank:knowledge` 的
 * sidecar 缺席只会 warn（`required: false`），本用例不断言知识面。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { loadBundles, readLayers, readProfile } from '../packages/cli/src/index.ts'
import {
  boot,
  createCatalog,
  DESKTOP_SERVER,
  SESSION_FILES,
  type BootedApp,
} from '../packages/host/src/index.ts'
import { testRunContext } from '../packages/host/src/boot/test-run-context.ts'
import { asSessionId } from '../packages/test-support/src/index.ts'

/** 仓库根（`scripts/` 的上一级）。 */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 本用例自设的 token（跑完还原，避免与同批其它用例串味）。 */
const TOKEN = 'desktop-01-smoke-token'

interface Harness {
  readonly app: BootedApp
  readonly url: string
  readonly port: number
  readonly userData: string
  readonly previousToken: string | undefined
}

let harness: Harness | undefined

beforeAll(async () => {
  const previousToken = process.env['BAH_WEB_TOKEN']
  process.env['BAH_WEB_TOKEN'] = TOKEN

  const userData = mkdtempSync(join(tmpdir(), 'bah-desktop-01-'))
  const profile = readProfile(ROOT, 'desktop')
  const bundles = await loadBundles(ROOT, profile.bundles)
  // home 层指向临时目录：本机若存在 `~/.bah/bah.patch.yml`，不该影响这条断言
  const { layers } = readLayers(ROOT, profile, { home: join(userData, 'home'), overlays: [] })
  const app = await boot({
    profile,
    bundles,
    layers,
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('desktop-01-smoke'),
      jsonlDir: join(userData, 'sessions'),
    }),
  })
  const info = app.ctx.get(DESKTOP_SERVER)
  harness = { app, url: info.url, port: info.port, userData, previousToken }
}, 60_000)

afterAll(async () => {
  if (harness === undefined) return
  await harness.app.dispose()
  rmSync(harness.userData, { recursive: true, force: true })
  if (harness.previousToken === undefined) delete process.env['BAH_WEB_TOKEN']
  else process.env['BAH_WEB_TOKEN'] = harness.previousToken
  harness = undefined
})

describe('profiles/desktop 装配（T-DTB-CH-003）', () => {
  it('port:0 由内核分配出真实端口（不是 0，也不是配置写死的值）', () => {
    expect(harness?.port).toBeGreaterThan(0)
    expect(harness?.port).not.toBe(7331)
    expect(harness?.port).not.toBe(7551)
  })

  it('URL 只绑 loopback（私有宿主，不是 0.0.0.0）', () => {
    expect(harness?.url.startsWith('http://127.0.0.1:')).toBe(true)
  })

  it('`/` 返回 200 且注入了桌面 token（index.html 在 entries 白名单里）', async () => {
    const response = await fetch(harness?.url ?? '', { redirect: 'manual' })
    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html).toContain(`<meta name="bah-web-token" content="${TOKEN}"`)
    // 桌面壳就是 Web 壳：同一份 index.html，没有第二套桌面布局（00 D-DT-02）
    expect(html.toLowerCase()).toContain('<title>')
  })

  it('`/api/session` 的能力位是桌面那一组（不是 web、也不是 mobile）', async () => {
    const response = await fetch(new URL('/api/session', harness?.url), {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      capabilities?: { gestureConfirm?: boolean; voiceInput?: string; layout?: string }
    }
    // `/api/session` 只回能力位、**不回渠道名**（见 handlers/session.ts）⇒
    // 唯一能证伪"装配到别的渠道"的判据就是能力位三元组：
    //   web    = gestureConfirm:false, voiceInput:none,  layout:wide
    //   mobile = gestureConfirm:true,  voiceInput:ime,   layout:narrow
    //   desktop= gestureConfirm:true,  voiceInput:none,  layout:wide  ← 只有这一组三元组唯一
    expect(body.capabilities?.gestureConfirm).toBe(true)
    expect(body.capabilities?.voiceInput).toBe('none')
    expect(body.capabilities?.layout).toBe('wide')
  })

  it('会话文件路径落在 run.jsonlDir 之下，不写进仓库（I-DT-08 的 01 侧证据）', () => {
    const sessionId = harness?.app.ctx.get(DESKTOP_SERVER).sessionId ?? ''
    expect(sessionId).toBe('desktop-01-smoke')
    const file = harness?.app.ctx.get(SESSION_FILES).fileOf(asSessionId('desktop-01-smoke'))
    expect(file?.startsWith(harness?.userData ?? '\u0000')).toBe(true)
    expect(file?.includes(ROOT)).toBe(false)
  })
})
