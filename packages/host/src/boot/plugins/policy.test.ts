/**
 * `policy:rules` 宿主行（策略外置 S2/S3）。
 *
 * 覆盖五件事：
 * 1. **配置 fail-loud**：未知键、`..` 逃逸、未知 kind、影子自指、签名与上限；
 * 2. **载入与失败矩阵**（02 §13）：registry/state 坏、bundle 缺失、摘要不符、未知 kind；
 * 3. **判决适配**：`CompiledPolicy` → `PolicyEngine` 的四个增量字段；缺 `input` 时抛错；
 * 4. **灰度与影子**：显式名单 / 万分比 / epoch 分桶 / 差异事件；
 * 5. **热重载**：好 state 原子切换、坏 state 保持旧版并落 `reload-rejected`。
 *
 * 真 bundle 从仓库复制，只在临时目录里造坏数据——**不改** `policies/` 的入库内容。
 */

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOST_PLUGINS, boot, createCatalog, type BootedApp, type HostPlugin , testRunContext } from '@bah/host'
import { BANK_TOOL_NAME_SET } from '@bah/bank'
import { loadBundle, loadRuleBundle, writeLockFile, writeRuleLockFile } from '@bah/policy'
import {
  AGENTS_SERVICE,
  SESSION_SERVICE,
  findPolicyDescriptor,
  findPolicyEngine,
  providePolicyParamCheck,
} from '@bah/runtime'
import { BahError } from '@bah/util'
import { asSessionId } from '@bah/test-support'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AnySessionEvent } from '@bah/runtime'

import type { ValidatedRow } from '../../plugin-manager/index.ts'
import {
  findSentryRules,
  policyInternals,
  policyRulesPlugin,
  reloadPolicyNow,
  resetPolicyReloadHandle,
} from './policy.ts'

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const realBundle = join(repoRoot, 'policies', 'bank-tier', '1.0.0')
const realSentryBundle = join(repoRoot, 'policies', 'sentry-rules', '1.0.0')
const demoBundle = join(repoRoot, 'policies', 'demo', 'bank-tier-demo', '1.0.0')
const FIXED_NOW = 1_700_000_000_000

const scratch: string[] = []

afterEach(() => {
  resetPolicyReloadHandle()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bah-policy-${tag}-`))
  scratch.push(dir)
  mkdirSync(join(dir, 'policies'), { recursive: true })
  return join(dir, 'policies')
}

/**
 * 递归复制目录（**不用 `fs.cpSync`**）。
 *
 * 本机 Node 22.17 在中文路径下执行 `cpSync(..., { recursive: true })` 会让进程
 * 无输出退出（exit 127，无异常、无 fatal report）；`readdirSync` + `copyFileSync`
 * 走同一套 Win32 路径 API 却稳定。测试夹具因此显式实现，避免把环境缺陷当成用例失败。
 */
function copyTree(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) copyTree(from, to)
    else copyFileSync(from, to)
  }
}

/** 把仓库里的真 bundle 复制进临时策略根（`handle` 是 `<name>/<version>`）。 */
function install(root: string, handle: string, source = realBundle): string {
  const target = join(root, ...handle.split('/'))
  copyTree(source, target)
  return target
}

/**
 * 复制真 bundle → 按需改 manifest/rules → 重算 lock（只作用于临时目录）。
 *
 * 用来造"参数集不同/带 deny 行"的合法变体；不改 `policies/` 的入库内容。
 */
function installMutated(
  root: string,
  handle: string,
  mutate: {
    readonly manifest?: (text: string) => string
    readonly rules?: (text: string) => string
    readonly corpus?: (text: string) => string
  },
): string {
  const dir = install(root, handle)
  const edit = (file: string, transform: ((text: string) => string) | undefined): void => {
    if (transform === undefined) return
    const path = join(dir, file)
    writeFileSync(path, transform(readFileSync(path, 'utf8')), 'utf8')
  }
  edit('bundle.yml', mutate.manifest)
  edit('rules.yml', mutate.rules)
  edit('corpus.yml', mutate.corpus)
  const recompiled = loadBundle({ dir, toolNames: [...BANK_TOOL_NAME_SET], verifyLock: false })
  writeLockFile(dir, recompiled.lock)
  return dir
}

/** registry 条目：`path` 用**临时目录的绝对路径**，确保测的是复制出来的 bundle。 */
function entryOf(handle: string, dir: string): Record<string, unknown> {
  const lock = JSON.parse(readFileSync(join(dir, 'lock.json'), 'utf8')) as {
    semanticDigest: string
    sourceDigest: string
    engineVersion: string
  }
  return {
    path: dir,
    semanticDigest: lock.semanticDigest,
    sourceDigest: lock.sourceDigest,
    engine: lock.engineVersion,
    installedAt: FIXED_NOW,
  }
}

function writeRegistry(
  root: string,
  versions: Readonly<Record<string, Record<string, unknown>>>,
  kind = 'bank.tier',
): void {
  writeFileSync(
    join(root, 'registry.json'),
    JSON.stringify({ apiVersion: 'bah.policy.registry/v1', kinds: { [kind]: { versions } } }, null, 2),
    'utf8',
  )
}

function writeState(root: string, assignments: unknown): string {
  const path = join(root, 'runtime-state.json')
  writeFileSync(
    path,
    JSON.stringify(
      { apiVersion: 'bah.policy.runtime-state/v1', updatedAt: FIXED_NOW, assignments },
      null,
      2,
    ),
    'utf8',
  )
  return path
}

interface BootArgs {
  readonly root: string
  readonly config?: Readonly<Record<string, unknown>>
  readonly probe?: boolean
}

async function bootPolicy(args: BootArgs): Promise<BootedApp> {
  return boot({
    profile: { name: 'policy-test', bundles: ['policy-test'], hmr: false },
    bundles: [
      {
        name: 'policy-test',
        rows: [
          { id: 'core:session' },
          { id: 'policy:rules', config: { root: args.root, ...(args.config ?? {}) } },
        ],
      },
    ],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('s-policy-test'),
      now: () => FIXED_NOW,
      probe: args.probe ?? true,
    }),
  })
}

/** 会话里某类事件的载荷（`appendDomain` 落的就是这个）。 */
function eventsOf(app: BootedApp, type: string): Record<string, unknown>[] {
  const session = app.ctx.get(SESSION_SERVICE)
  return session
    .events()
    .filter((event: AnySessionEvent) => String(event.type) === type)
    .map((event: AnySessionEvent) => event.data as Record<string, unknown>)
}

/** 一次判决的输入（`bank.tier.input/v1` 的最小合法形状）。 */
function tierInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: { userId: 'u-1', sessionId: 's-policy-test' },
    action: { name: 'transfer_create', declared: 'yellow' },
    preview: {
      amountCents: 500_000,
      dailyUsedCents: 0,
      dailyLimitCents: 1_000_000,
      payee: { binding: 'whitelist' },
    },
    state: { riskyCallsInTurn: 0, verifyLocked: false },
    limits: { dailyLimitCents: 1_000_000 },
    params: { riskyCallThreshold: 3 },
    ...overrides,
  }
}

describe('policy:rules · validate', () => {
  it('空配置 → base 行的默认值（root=policies，active=bank-tier/1.0.0）', () => {
    const settings = policyRulesPlugin.validate({})
    expect(settings.root).toBe('policies')
    expect(settings.active).toEqual({ 'bank.tier': 'bank-tier/1.0.0' })
    expect(settings.statePath).toBe(join('policies', 'runtime-state.json'))
    expect(settings.hotReload).toBe(false)
    expect(settings.requireSignature).toBe(false)
    expect(settings.shadow).toEqual({})
    expect(settings.signature.allowedKeyVersions).toEqual([1])
  })

  it('未知键 / .. 逃逸 / 未知 kind / 影子未声明 kind / 影子空串 → 全部拒绝', () => {
    const code = (config: Record<string, unknown>): string => {
      try {
        policyRulesPlugin.validate(config)
        return 'no-throw'
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown'
      }
    }
    expect(code({ nope: 1 })).toBe('unknown-config-key')
    expect(code({ root: '../etc' })).toBe('invalid-config')
    expect(code({ active: { 'other.rules': 'x/1.0.0' } })).toBe('invalid-config')
    expect(code({ active: { 'bank.tier': '' } })).toBe('invalid-config')
    expect(code({ active: { 'bank.tier': 'a/1' }, shadow: { 'sentry.rules': 'b/1' } })).toBe(
      'invalid-config',
    )
    expect(code({ active: { 'bank.tier': 'a/1' }, shadow: { 'bank.tier': '' } })).toBe(
      'invalid-config',
    )
    expect(code({ active: { 'bank.tier': 'a/1' }, shadow: { 'bank.tier': 'a/1' } })).toBe(
      'policy-shadow-self',
    )
    expect(code({ active: {} })).toBe('invalid-config')
  })

  it('签名：未知键 / 强制签名缺公钥 / allowedKeyVersions 非空升序唯一', () => {
    const code = (config: Record<string, unknown>): string => {
      try {
        policyRulesPlugin.validate(config)
        return 'no-throw'
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown'
      }
    }
    expect(code({ signature: { nope: 1 } })).toBe('unknown-config-key')
    expect(code({ requireSignature: true })).toBe('invalid-config')
    expect(code({ signature: { allowedKeyVersions: [] } })).toBe('invalid-config')
    expect(code({ signature: { allowedKeyVersions: ['1'] } })).toBe('invalid-config')
    expect(code({ signature: { allowedKeyVersions: [2, 1] } })).toBe('invalid-config')
    expect(code({ signature: { allowedKeyVersions: [1, 1] } })).toBe('invalid-config')
    expect(
      policyRulesPlugin.validate({ signature: { allowedKeyVersions: [1, 2] } }).signature
        .allowedKeyVersions,
    ).toEqual([1, 2])
  })

  it('limits：未知键 / 超硬上限拒绝，合法值放行', () => {
    const code = (config: Record<string, unknown>): string => {
      try {
        policyRulesPlugin.validate(config)
        return 'no-throw'
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown'
      }
    }
    expect(code({ limits: { nope: 1 } })).toBe('unknown-config-key')
    expect(code({ limits: { maxTables: 999 } })).toBe('invalid-config')
    expect(code({ limits: { maxTables: 8 } })).toBe('no-throw')
  })
})

describe('policy:rules · validateComposition', () => {
  const row = (id: string, settings: Record<string, unknown>): ValidatedRow =>
    ({ id, settings }) as unknown as ValidatedRow

  it('缺行 / engine=legacy → 不校验（不是 bundle 模式就没有行序要求）', () => {
    expect(() =>
      policyRulesPlugin.validateComposition?.([row('policy:rules', { active: { 'bank.tier': 'a' } })]),
    ).not.toThrow()
    expect(() =>
      policyRulesPlugin.validateComposition?.([
        row('policy:rules', { active: { 'bank.tier': 'a' } }),
        row('bank:tools', { policy: { engine: 'legacy' } }),
      ]),
    ).not.toThrow()
  })

  it('engine=bundle + policy 行在后 → policy-row-order', () => {
    expect(() =>
      policyRulesPlugin.validateComposition?.([
        row('bank:tools', { policy: { engine: 'bundle' } }),
        row('policy:rules', { active: { 'bank.tier': 'a' } }),
      ]),
    ).toThrowError(/policy:rules 必须排在 bank:tools 之前/)
  })

  it('engine=bundle + active 缺 bank.tier → policy-service-missing', () => {
    expect(() =>
      policyRulesPlugin.validateComposition?.([
        row('policy:rules', { active: {} }),
        row('bank:tools', { policy: { engine: 'bundle' } }),
      ]),
    ).toThrowError(/policy:service-missing|active 没有 bank.tier/)
  })
})

describe('policy:rules · 载入与判决', () => {
  it('正常载入：发 policy/bundle-loaded，引擎给出 level/reason/ruleIds/policyVersion', async () => {
    const root = tempRoot('load')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root })
    try {
      const loaded = eventsOf(app, 'policy/bundle-loaded')
      expect(loaded).toHaveLength(1)
      expect(loaded[0]?.['handle']).toBe('bank-tier/1.0.0')
      expect(String(loaded[0]?.['version'])).toMatch(/^bank-tier\/1\.0\.0\+sha256:[0-9a-f]{16}$/)

      const engine = findPolicyEngine(app.ctx)
      expect(engine).toBeDefined()
      const decision = engine?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        { name: 'transfer_create', declared: 'yellow' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      expect(decision?.verdict).toBe('allow')
      expect(decision?.level).toBe('yellow')
      expect(decision?.tierReason).toBe('declared')
      expect(decision?.ruleIds).toEqual(['TR-003-default', 'RC-002-default'])
      expect(String(decision?.policyVersion)).toMatch(/^bank-tier\/1\.0\.0\+sha256:/)

      // 描述符同时可读（早拒路径要靠它写"当前生效版本"）
      const descriptor = findPolicyDescriptor(app.ctx)
      expect(descriptor?.parameters).toEqual({ riskyCallThreshold: { min: 1, max: 100 } })
      expect(descriptor?.canary).toBeUndefined()
    } finally {
      await app.dispose('test')
    }
  })

  it('缺 context.input → 抛 policy-input-invalid（绝不静默求值）', async () => {
    const root = tempRoot('no-input')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root })
    try {
      const engine = findPolicyEngine(app.ctx)
      expect(() =>
        engine?.decide(
          { userId: 'u-1' },
          { name: 'transfer_create', declared: 'yellow' },
          { riskyCallsInTurn: 0, verifyLocked: false },
        ),
      ).toThrowError(/policy-input-invalid|context\.input/)
    } finally {
      await app.dispose('test')
    }
  })

  it('未知 kind → 抛 policy-unavailable', async () => {
    const root = tempRoot('kind')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root })
    try {
      const engine = findPolicyEngine(app.ctx)
      expect(() =>
        engine?.decide(
          { userId: 'u-1' },
          { name: 'transfer_create', declared: 'yellow', kind: 'sentry.rules' },
          { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
        ),
      ).toThrowError(/没有 kind=sentry\.rules 的策略快照/)
    } finally {
      await app.dispose('test')
    }
  })

  it('会话事件写入失败只告警：bundle 仍载入、描述符可用（I17 同一条纪律）', async () => {
    const root = tempRoot('emit-fail')
    install(root, 'bank-tier/1.0.0')
    const brokenSession: HostPlugin<Record<string, never>> = {
      id: 'fx:session-broken',
      plugin: {
        name: 'fx:session-broken',
        apply(ctx) {
          ctx.provide(SESSION_SERVICE, {
            appendDomain() {
              throw new Error('disk-full')
            },
          } as never)
        },
      },
      validate() {
        return {}
      },
    }
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = await boot({
        profile: { name: 'emit-fail', bundles: ['emit-fail'], hmr: false },
        bundles: [
          {
            name: 'emit-fail',
            rows: [{ id: 'fx:session-broken' }, { id: 'policy:rules', config: { root } }],
          },
        ],
        layers: [],
        catalog: createCatalog([...HOST_PLUGINS, brokenSession]),
        run: testRunContext({ sessionId: asSessionId('s-policy-emit'), now: () => FIXED_NOW, probe: true }),
      })
      try {
        // 观测失败不改判决：快照照常建立，`policy/bundle-loaded` 的写入失败只落 stderr
        expect(findPolicyDescriptor(app.ctx)?.handle).toBe('bank-tier/1.0.0')
        expect(
          warn.mock.calls.some(
            (args) =>
              String(args[0]).includes('host.policy-event-persist-failed') &&
              String(args[0]).includes('policy/bundle-loaded'),
          ),
        ).toBe(true)
      } finally {
        await app.dispose('test')
      }
    } finally {
      warn.mockRestore()
    }
  })

  it('bundle 规则 deny → 判决 deny（code/reason 与四字段一起带出）', async () => {
    const root = tempRoot('deny')
    installMutated(root, 'bank-tier-deny/1.0.0', {
      manifest: (text) => text.replace('name: bank-tier', 'name: bank-tier-deny'),
      rules: (text) =>
        text.replace(
          '      - id: TR-003-default',
          [
            '      - id: TR-004-deny',
            '        when: preview.amountCents >= 100',
            '        deny: policy-denied',
            '        reason: daily-limit',
            '      - id: TR-003-default',
          ].join('\n'),
        ),
    })
    const app = await bootPolicy({ root, config: { active: { 'bank.tier': 'bank-tier-deny/1.0.0' } } })
    try {
      const decision = findPolicyEngine(app.ctx)?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        { name: 'transfer_create', declared: 'yellow' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      expect(decision?.verdict).toBe('deny')
      expect(decision?.code).toBe('policy-denied')
      expect(decision?.reason).toBe('daily-limit')
      // 判决身份与级别照旧带出（deny 不是"只给一句拒绝"）
      expect(decision?.level).toBe('yellow')
      // deny 命中即短路：后续表不再演进（规则 ID 只到命中行）
      expect(decision?.ruleIds).toEqual(['TR-004-deny'])
      expect(String(decision?.policyVersion)).toMatch(/^bank-tier-deny\/1\.0\.0\+sha256:/)
    } finally {
      await app.dispose('test')
    }
  })

  it('registry 缺省时按 root/<name>/<version> 推断目录（S2 的兼容路径）', async () => {
    const root = tempRoot('no-registry')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root })
    try {
      expect(findPolicyDescriptor(app.ctx)?.handle).toBe('bank-tier/1.0.0')
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · 灰度与影子', () => {
  it('显式名单命中候选版本；未命中的会话留在 active', async () => {
    const root = tempRoot('canary')
    const stable = install(root, 'bank-tier/1.0.0')
    const demo = install(root, 'bank-tier-demo/1.0.0', demoBundle)
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier-demo/1.0.0': entryOf('bank-tier-demo/1.0.0', demo),
    })
    writeState(root, {
      'bank.tier': {
        active: 'bank-tier/1.0.0',
        canary: {
          version: 'bank-tier-demo/1.0.0',
          percent: 0,
          sessions: ['s-canary'],
          epoch: 1,
        },
      },
    })
    const app = await bootPolicy({ root })
    try {
      const engine = findPolicyEngine(app.ctx)
      const inCanary = engine?.decide(
        { userId: 'u-1', sessionId: 's-canary' },
        { name: 'transfer_create', declared: 'yellow' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      // demo 规则：单笔 500000 分直接升红
      expect(inCanary?.level).toBe('red')
      expect(inCanary?.ruleIds).toEqual(['TR-004-single-large', 'RC-002-default'])

      const stayed = engine?.decide(
        { userId: 'u-1', sessionId: 's-other' },
        { name: 'transfer_create', declared: 'yellow' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      expect(stayed?.level).toBe('yellow')
      expect(findPolicyDescriptor(app.ctx)?.canary?.handle).toBe('bank-tier-demo/1.0.0')
    } finally {
      await app.dispose('test')
    }
  })

  it('万分比 10000 → 全部命中候选；0 → 全部留在 active；分桶纯函数稳定', async () => {
    const root = tempRoot('percent')
    const stable = install(root, 'bank-tier/1.0.0')
    const demo = install(root, 'bank-tier-demo/1.0.0', demoBundle)
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier-demo/1.0.0': entryOf('bank-tier-demo/1.0.0', demo),
    })
    const run = async (percent: number, sessionId: string): Promise<string | undefined> => {
      writeState(root, {
        'bank.tier': {
          active: 'bank-tier/1.0.0',
          canary: { version: 'bank-tier-demo/1.0.0', percent, epoch: 2 },
        },
      })
      const app = await bootPolicy({ root })
      try {
        return findPolicyEngine(app.ctx)?.decide(
          { userId: 'u-1', sessionId },
          { name: 'transfer_create', declared: 'yellow' },
          { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
        )?.policyVersion
      } finally {
        await app.dispose('test')
      }
    }
    expect(String(await run(10_000, 's-any'))).toMatch(/^bank-tier-demo\//)
    expect(String(await run(0, 's-any'))).toMatch(/^bank-tier\//)

    // 分桶：同一 (sessionId, epoch) 永远同一桶；0 <= bucket < 10000
    const once = policyInternals.bucketOf('s-stable', 3)
    expect(policyInternals.bucketOf('s-stable', 3)).toBe(once)
    expect(once).toBeGreaterThanOrEqual(0)
    expect(once).toBeLessThan(10_000)
    // epoch 变 → 桶可能变（不是"会话固定在同一版本"）
    expect(policyInternals.bucketOf('s-stable', 4)).not.toBe(Number.NaN)
  })

  it('影子：候选与生效不同 → 发 policy/shadow-diff，判决仍是生效版本', async () => {
    const root = tempRoot('shadow')
    install(root, 'bank-tier/1.0.0')
    install(root, 'bank-tier-demo/1.0.0', demoBundle)
    const app = await bootPolicy({
      root,
      config: { shadow: { 'bank.tier': 'bank-tier-demo/1.0.0' } },
    })
    try {
      const decision = findPolicyEngine(app.ctx)?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        { name: 'transfer_create', declared: 'yellow', callId: 'call-1' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      expect(decision?.level).toBe('yellow')
      const diffs = eventsOf(app, 'policy/shadow-diff')
      expect(diffs).toHaveLength(1)
      expect(diffs[0]?.['callId']).toBe('call-1')
      expect(diffs[0]?.['changed']).toEqual(['level', 'reason', 'ruleIds'])
    } finally {
      await app.dispose('test')
    }
  })

  it('影子与生效一致 → 不发事件（差异为零不是"没有影子"）', async () => {
    const root = tempRoot('shadow-same')
    install(root, 'bank-tier/1.0.0')
    install(root, 'bank-tier-demo/1.0.0', demoBundle)
    const app = await bootPolicy({
      root,
      config: { shadow: { 'bank.tier': 'bank-tier-demo/1.0.0' } },
    })
    try {
      const decision = findPolicyEngine(app.ctx)?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        // 80000 分：1.0.0 与 demo 1.0.0（阈值 500000）都判黄，无差异
        { name: 'transfer_create', declared: 'yellow' },
        {
          riskyCallsInTurn: 0,
          verifyLocked: false,
          input: tierInput({
            preview: {
              amountCents: 80_000,
              dailyUsedCents: 0,
              dailyLimitCents: 500_000,
              payee: { binding: 'whitelist' },
            },
          }),
        },
      )
      expect(decision?.level).toBe('yellow')
      expect(eventsOf(app, 'policy/shadow-diff')).toHaveLength(0)
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · 热重载', () => {
  it('state 变更 → policy/bundle-switched，后续判决走新版本', async () => {
    const root = tempRoot('reload-ok')
    const stable = install(root, 'bank-tier/1.0.0')
    const demo = install(root, 'bank-tier-demo/1.0.0', demoBundle)
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier-demo/1.0.0': entryOf('bank-tier-demo/1.0.0', demo),
    })
    const app = await bootPolicy({ root, config: { hotReload: true } })
    try {
      writeState(root, { 'bank.tier': { active: 'bank-tier-demo/1.0.0' } })
      expect(reloadPolicyNow()).toBe(true)
      const switched = eventsOf(app, 'policy/bundle-switched')
      expect(switched).toHaveLength(1)
      // `from/to` 是 identity（02 §4.3），不是 handle
      expect(String(switched[0]?.['to'])).toMatch(/^bank-tier-demo\/1\.0\.0\+sha256:[0-9a-f]{16}$/)

      const decision = findPolicyEngine(app.ctx)?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        { name: 'transfer_create', declared: 'yellow' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      expect(String(decision?.policyVersion)).toMatch(/^bank-tier-demo\//)
    } finally {
      await app.dispose('test')
    }
  })

  it('坏 state → policy/reload-rejected，旧版本继续服务（I10）', async () => {
    const root = tempRoot('reload-bad')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root, config: { hotReload: true } })
    try {
      writeFileSync(join(root, 'runtime-state.json'), '{ not json', 'utf8')
      expect(reloadPolicyNow()).toBe(true)
      const rejected = eventsOf(app, 'policy/reload-rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0]?.['code']).toBe('policy-state-invalid')

      // 旧版本仍在服务
      const decision = findPolicyEngine(app.ctx)?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        { name: 'transfer_create', declared: 'yellow' },
        { riskyCallsInTurn: 0, verifyLocked: false, input: tierInput() },
      )
      expect(String(decision?.policyVersion)).toMatch(/^bank-tier\/1\.0\.0/)
    } finally {
      await app.dispose('test')
    }
  })

  it('hotReload=false → 不暴露手动重载句柄（生产默认不热换）', async () => {
    const root = tempRoot('reload-off')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root })
    try {
      expect(reloadPolicyNow()).toBe(false)
    } finally {
      await app.dispose('test')
    }
  })

  it('state 没变 → 重载不产生 bundle-switched（事件只跟真实版本变化）', async () => {
    const root = tempRoot('reload-same')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root, config: { hotReload: true } })
    try {
      expect(reloadPolicyNow()).toBe(true)
      expect(eventsOf(app, 'policy/bundle-switched')).toHaveLength(0)
      expect(eventsOf(app, 'policy/reload-rejected')).toHaveLength(0)
    } finally {
      await app.dispose('test')
    }
  })

  it('描述符是活引用：重载后 version/canary 立即反映新版本', async () => {
    const root = tempRoot('reload-live')
    const stable = install(root, 'bank-tier/1.0.0')
    const demo = install(root, 'bank-tier-demo/1.0.0', demoBundle)
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier-demo/1.0.0': entryOf('bank-tier-demo/1.0.0', demo),
    })
    const app = await bootPolicy({ root, config: { hotReload: true } })
    try {
      expect(findPolicyDescriptor(app.ctx)?.handle).toBe('bank-tier/1.0.0')
      writeState(root, { 'bank.tier': { active: 'bank-tier-demo/1.0.0' } })
      expect(reloadPolicyNow()).toBe(true)
      const descriptor = findPolicyDescriptor(app.ctx)
      expect(descriptor?.handle).toBe('bank-tier-demo/1.0.0')
      expect(String(descriptor?.version)).toMatch(/^bank-tier-demo\/1\.0\.0\+sha256:/)
      // 描述符的其余活字段也要跟着换（早拒路径/前端/运维面板都按它读）
      expect(descriptor?.kind).toBe('bank.tier')
      expect(descriptor?.semanticDigest).toMatch(/^[0-9a-f]{64}$/)
      expect(descriptor?.engineVersion).toMatch(/^\d+\.\d+\.\d+$/)
      expect(descriptor?.loadedAt).toBe(FIXED_NOW)
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · 启动失败矩阵（02 §13）', () => {
  /**
   * 启动期错误会被 `boot()` 统一包成 `boot-failed`（原始错误放在 `detail.cause`）。
   * 断言策略错误码时必须剥到 cause，否则所有负例都只会看到同一个外层码。
   */
  const codeOf = (error: unknown): string => {
    const shaped = error as {
      code?: string
      detail?: { cause?: unknown }
      cause?: unknown
    }
    if (shaped.code === 'boot-failed') {
      const cause = shaped.detail?.cause ?? shaped.cause
      if (cause !== undefined) return codeOf(cause)
    }
    return typeof shaped.code === 'string' ? shaped.code : 'unknown'
  }

  const bootCode = async (root: string, config?: Record<string, unknown>): Promise<string> => {
    try {
      const app = await bootPolicy({ root, ...(config === undefined ? {} : { config }) })
      await app.dispose('cleanup')
      return 'no-throw'
    } catch (error) {
      return codeOf(error)
    }
  }

  it('bundle 目录缺失 → policy-bundle-missing', async () => {
    const root = tempRoot('missing')
    expect(await bootCode(root)).toBe('policy-bundle-missing')
  })

  it('registry 坏 JSON / apiVersion 错 → policy-registry-invalid', async () => {
    const root = tempRoot('registry')
    install(root, 'bank-tier/1.0.0')
    writeFileSync(join(root, 'registry.json'), '{ bad', 'utf8')
    expect(await bootCode(root)).toBe('policy-registry-invalid')

    writeFileSync(join(root, 'registry.json'), JSON.stringify({ apiVersion: 'v0' }), 'utf8')
    expect(await bootCode(root)).toBe('policy-registry-invalid')
  })

  it('registry 摘要与现场不符 → policy-digest-mismatch', async () => {
    const root = tempRoot('digest')
    const stable = install(root, 'bank-tier/1.0.0')
    writeRegistry(root, {
      'bank-tier/1.0.0': { ...entryOf('bank-tier/1.0.0', stable), semanticDigest: 'deadbeef' },
    })
    expect(await bootCode(root)).toBe('policy-digest-mismatch')
  })

  it('state 坏 JSON / apiVersion 错 → policy-state-invalid', async () => {
    const root = tempRoot('state')
    install(root, 'bank-tier/1.0.0')
    writeFileSync(join(root, 'runtime-state.json'), '{ bad', 'utf8')
    expect(await bootCode(root)).toBe('policy-state-invalid')

    writeFileSync(join(root, 'runtime-state.json'), JSON.stringify({ apiVersion: 'v0' }), 'utf8')
    expect(await bootCode(root)).toBe('policy-state-invalid')
  })

  it('state 指向未声明的 kind → policy-state-invalid（配置漂移不静默）', async () => {
    const root = tempRoot('drift')
    install(root, 'bank-tier/1.0.0')
    writeState(root, { 'bank.tier': { active: 'bank-tier/1.0.0' }, 'sentry.rules': { active: 'x/1' } })
    expect(await bootCode(root)).toBe('policy-state-invalid')
  })

  it('state 指向未安装版本 → policy-bundle-missing（无 registry 时按目录推断）', async () => {
    const root = tempRoot('state-missing')
    install(root, 'bank-tier/1.0.0')
    writeState(root, { 'bank.tier': { active: 'bank-tier/9.9.9' } })
    expect(await bootCode(root)).toBe('policy-bundle-missing')
  })

  it('有 registry 时 state 指向未登记版本 → policy-version-missing（不静默用目录）', async () => {
    const root = tempRoot('state-unregistered')
    const stable = install(root, 'bank-tier/1.0.0')
    const extra = install(root, 'bank-tier/9.9.9')
    writeRegistry(root, { 'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable) })
    writeState(root, { 'bank.tier': { active: 'bank-tier/9.9.9' } })
    // 目录确实存在，但 registry 没登记：必须拒绝，而不是"有目录就用"
    expect(extra).toContain('9.9.9')
    expect(await bootCode(root)).toBe('policy-version-missing')
  })

  it('registry 形状不完整 → policy-registry-invalid（半截清单比没有更危险）', async () => {
    const root = tempRoot('registry-shape')
    install(root, 'bank-tier/1.0.0')
    writeFileSync(join(root, 'registry.json'), JSON.stringify({ apiVersion: 'bah.policy.registry/v1' }), 'utf8')
    expect(await bootCode(root)).toBe('policy-registry-invalid')
  })

  it('state 的 canary.percent 越界 / sessions 非数组 → policy-state-invalid', async () => {
    const root = tempRoot('state-shape')
    install(root, 'bank-tier/1.0.0')
    writeState(root, {
      'bank.tier': {
        active: 'bank-tier/1.0.0',
        canary: { version: 'bank-tier/1.0.0', percent: 10001, epoch: 1 },
      },
    })
    expect(await bootCode(root)).toBe('policy-state-invalid')

    writeState(root, {
      'bank.tier': {
        active: 'bank-tier/1.0.0',
        canary: { version: 'bank-tier/1.0.0', percent: 0, sessions: 's-1', epoch: 1 },
      },
    })
    expect(await bootCode(root)).toBe('policy-state-invalid')
  })

  it('灰度版本声明了不同参数集 → policy-param-mismatch（同 kind 参数集必须同构）', async () => {
    const root = tempRoot('canary-params')
    const stable = install(root, 'bank-tier/1.0.0')
    const variant = installMutated(root, 'bank-tier/1.0.2', {
      manifest: (text) =>
        text
          .replace('version: 1.0.0', 'version: 1.0.2')
          .replace('riskyCallThreshold:', 'riskyCallThresholdV2:'),
      rules: (text) => text.replaceAll('params.riskyCallThreshold', 'params.riskyCallThresholdV2'),
      corpus: (text) => text.replaceAll('riskyCallThreshold: 3', 'riskyCallThresholdV2: 3'),
    })
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier/1.0.2': entryOf('bank-tier/1.0.2', variant),
    })
    writeState(root, {
      'bank.tier': {
        active: 'bank-tier/1.0.0',
        canary: { version: 'bank-tier/1.0.2', percent: 0, sessions: ['s-canary'], epoch: 1 },
      },
    })
    expect(await bootCode(root)).toBe('policy-param-mismatch')
  })

  it('requireSignature 且无 bundle.sig → policy-signature-invalid', async () => {
    const root = tempRoot('sig')
    install(root, 'bank-tier/1.0.0')
    const keyPath = join(root, 'policy.pub.pem')
    writeFileSync(keyPath, 'not-a-real-key', 'utf8')
    expect(
      await bootCode(root, { requireSignature: true, signature: { publicKeyPath: keyPath } }),
    ).toBe('policy-signature-invalid')
  })

  it('--dump-config（probe=false）不打 stderr，但事件照常落账', async () => {
    const root = tempRoot('probe')
    install(root, 'bank-tier/1.0.0')
    const lines: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '))
    }
    try {
      const app = await bootPolicy({ root, probe: false })
      try {
        expect(lines).toEqual([])
        expect(eventsOf(app, 'policy/bundle-loaded')).toHaveLength(1)
      } finally {
        await app.dispose('test')
      }
    } finally {
      console.error = original
    }
  })
})

/** 真实底座 + 外置策略：`policy:rules` 必须排在 `bank:tools` 之前。 */
async function bootBank(
  root: string,
  bankConfig: Readonly<Record<string, unknown>>,
  rows?: readonly { id: string; config?: Readonly<Record<string, unknown>> }[],
): Promise<BootedApp> {
  return boot({
    profile: { name: 'policy-bank-test', bundles: ['policy-bank-test'], hmr: false },
    bundles: [
      {
        name: 'policy-bank-test',
        rows:
          rows ??
          ([
            { id: 'core:session' },
            { id: 'core:tools' },
            { id: 'core:prompt' },
            {
              id: 'core:model',
              config: {
                provider: 'mock',
                model: 'mock-chat',
                script: [
                  {
                    tool: {
                      id: 'call-transfer',
                      name: 'transfer_create',
                      args: {
                        amount: 800,
                        payee: { name: '王建国', phone: '13900002222' },
                        remark: '房租',
                      },
                    },
                  },
                  { text: '已发起转账。' },
                ],
              },
            },
            {
              id: 'core:agent',
              config: { channel: 'headless', loop: { model: 'mock:mock-chat' } },
            },
            { id: 'policy:rules', config: { root } },
            { id: 'bank:tools', config: bankConfig },
          ] as const),
      },
    ],
    layers: [],
    catalog: createCatalog(),
    run: testRunContext({
      sessionId: asSessionId('s-policy-bank'),
      now: () => FIXED_NOW,
      probe: true,
    }),
  })
}

describe('policy:rules × bank:tools（S2 端到端）', () => {

  it('真实 bundle 判决：tier/decided 带版本/规则/参数摘要/证据，行为与等价基线一致', async () => {
    const root = tempRoot('bank-e2e')
    install(root, 'bank-tier/1.0.0')
    const app = await bootBank(root, {
      demoUserId: 'u-1',
      seed: 7,
      datasetTier: 'demo',
      policy: { engine: 'bundle' },
    })
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('转账 800 元给王建国')
      await agent.run()

      const decided = eventsOf(app, 'tier/decided')[0]!
      expect(decided).toMatchObject({
        name: 'transfer_create',
        level: 'yellow',
        reason: 'declared',
        verdict: 'ask',
        engineSource: 'bundle',
        ruleIds: ['TR-003-default', 'RC-002-default'],
      })
      expect(String(decided['policyVersion'])).toMatch(/^bank-tier\/1\.0\.0\+sha256:[0-9a-f]{16}$/)
      expect(String(decided['paramsDigest'])).toMatch(/^sha256:[0-9a-f]{64}$/)
      const evidence = decided['evidence'] as { inputDigest: string; input: Record<string, unknown> }
      expect(evidence.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(evidence.input).toMatchObject({
        subject: { userId: 'u-1', sessionId: 's-policy-bank' },
        limits: { dailyLimitCents: 100_000 },
      })
      // 没有 approval 行：ask 之后审批不可用是预期的（不是策略错误）
      const result = eventsOf(app, 'tool/result')[0] as { code?: string }
      expect(result.code).toBe('approval-unavailable')
    } finally {
      await app.dispose('test')
    }
  })

  it('engine=bundle 但缺 policy:rules 行 → 启动失败 policy-service-missing', async () => {
    const root = tempRoot('bank-no-policy')
    install(root, 'bank-tier/1.0.0')
    let code = 'no-throw'
    try {
      const app = await bootBank(
        root,
        { demoUserId: 'u-1', seed: 7, datasetTier: 'demo', policy: { engine: 'bundle' } },
        [
          { id: 'core:session' },
          { id: 'core:tools' },
          { id: 'bank:tools', config: { demoUserId: 'u-1', policy: { engine: 'bundle' } } },
        ],
      )
      await app.dispose('test')
    } catch (error) {
      const shaped = error as { code?: string; detail?: { cause?: { code?: string } } }
      code = shaped.detail?.cause?.code ?? shaped.code ?? 'unknown'
    }
    expect(code).toBe('policy-service-missing')
  })

  it('policy:rules 排在 bank:tools 之后 → 启动失败 policy-row-order', async () => {
    const root = tempRoot('bank-order')
    install(root, 'bank-tier/1.0.0')
    let code = 'no-throw'
    try {
      const app = await bootBank(
        root,
        { demoUserId: 'u-1', seed: 7, datasetTier: 'demo', policy: { engine: 'bundle' } },
        [
          { id: 'core:session' },
          { id: 'core:tools' },
          { id: 'bank:tools', config: { demoUserId: 'u-1', policy: { engine: 'bundle' } } },
          { id: 'policy:rules', config: { root } },
        ],
      )
      await app.dispose('test')
    } catch (error) {
      const shaped = error as { code?: string; detail?: { cause?: { code?: string } } }
      code = shaped.detail?.cause?.code ?? shaped.code ?? 'unknown'
    }
    expect(code).toBe('policy-row-order')
  })

  it('部署参数越过 bundle 声明的区间 → 启动失败 policy-param-mismatch', async () => {
    const root = tempRoot('bank-param')
    install(root, 'bank-tier/1.0.0')
    let code = 'no-throw'
    try {
      const app = await bootBank(root, {
        demoUserId: 'u-1',
        seed: 7,
        datasetTier: 'demo',
        riskyCallThreshold: 101,
        policy: { engine: 'bundle' },
      })
      await app.dispose('test')
    } catch (error) {
      const shaped = error as { code?: string; detail?: { cause?: { code?: string } } }
      code = shaped.detail?.cause?.code ?? shaped.code ?? 'unknown'
    }
    expect(code).toBe('policy-param-mismatch')
  })
})

describe('policy:rules · 链上身份（S3）', () => {
  it('bundle 判决写入 policy/decision：信封的 policyVersion 是内容寻址身份', async () => {
    const root = tempRoot('chain')
    install(root, 'bank-tier/1.0.0')
    const sessions = mkdtempSync(join(tmpdir(), 'bah-policy-chain-'))
    scratch.push(sessions)
    const app = await bootBank(
      root,
      {
        demoUserId: 'u-1',
        seed: 7,
        datasetTier: 'demo',
        policy: { engine: 'bundle' },
      },
      [
        { id: 'core:session' },
        { id: 'core:tools' },
        { id: 'core:prompt' },
        {
          id: 'core:model',
          config: {
            provider: 'mock',
            model: 'mock-chat',
            script: [
              {
                tool: {
                  id: 'call-transfer',
                  name: 'transfer_create',
                  args: {
                    amount: 800,
                    payee: { name: '王建国', phone: '13900002222' },
                    remark: '房租',
                  },
                },
              },
              { text: '已发起转账。' },
            ],
          },
        },
        {
          id: 'core:agent',
          config: { channel: 'headless', loop: { model: 'mock:mock-chat' } },
        },
        { id: 'core:persistence', config: { root: sessions, fsync: false } },
        { id: 'audit:decisions' },
        { id: 'policy:rules', config: { root } },
        { id: 'bank:tools', config: { demoUserId: 'u-1', policy: { engine: 'bundle' } } },
        {
          id: 'interaction:approval',
          config: { responder: 'headless', autoDecision: 'allow', autoVerify: true },
        },
      ],
    )
    try {
      const agent = app.ctx.get(AGENTS_SERVICE).list()[0]!
      agent.send('转账 800 元给王建国')
      await agent.run()

      const chain = readFileSync(join(sessions, 'demo', 's-policy-bank', 'audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const policyRows = chain.filter((row) => row['t'] === 'policy/decision')
      expect(policyRows).toHaveLength(1)
      expect(policyRows[0]?.['decision']).toBe('ask')
      expect(String(policyRows[0]?.['policyVersion'])).toMatch(
        /^bank-tier\/1\.0\.0\+sha256:[0-9a-f]{16}$/,
      )
      expect(policyRows[0]?.['version']).toBe(2)
      expect(policyRows[0]?.['subject']).toBe('session:s-policy-bank')
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · 形状负例（S3）', () => {
  const bootCode = async (root: string, config?: Record<string, unknown>): Promise<string> => {
    const codeOf = (error: unknown): string => {
      const shaped = error as { code?: string; detail?: { cause?: unknown } }
      if (shaped.code === 'boot-failed' && shaped.detail?.cause !== undefined) {
        return codeOf(shaped.detail.cause)
      }
      return typeof shaped.code === 'string' ? shaped.code : 'unknown'
    }
    try {
      const app = await bootPolicy({ root, ...(config === undefined ? {} : { config }) })
      await app.dispose('cleanup')
      return 'no-throw'
    } catch (error) {
      return codeOf(error)
    }
  }

  it('runtime-state 把 active 指向 shadow 同版本 → policy-shadow-self', async () => {
    const root = tempRoot('shadow-self')
    const stable = install(root, 'bank-tier/1.0.0')
    const demo = install(root, 'bank-tier-demo/1.0.0', demoBundle)
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier-demo/1.0.0': entryOf('bank-tier-demo/1.0.0', demo),
    })
    writeState(root, { 'bank.tier': { active: 'bank-tier-demo/1.0.0' } })
    expect(
      await bootCode(root, { shadow: { 'bank.tier': 'bank-tier-demo/1.0.0' } }),
    ).toBe('policy-shadow-self')
  })

  it('registry 条目缺字段 → policy-registry-invalid', async () => {
    const root = tempRoot('registry-field')
    const stable = install(root, 'bank-tier/1.0.0')
    writeFileSync(
      join(root, 'registry.json'),
      JSON.stringify({
        apiVersion: 'bah.policy.registry/v1',
        kinds: { 'bank.tier': { versions: { 'bank-tier/1.0.0': { path: stable } } } },
      }),
      'utf8',
    )
    expect(await bootCode(root)).toBe('policy-registry-invalid')
  })

  it('canary.sessions 含空串 / active 空串 → policy-state-invalid', async () => {
    const root = tempRoot('state-strings')
    install(root, 'bank-tier/1.0.0')
    writeState(root, {
      'bank.tier': {
        active: 'bank-tier/1.0.0',
        canary: { version: 'bank-tier/1.0.0', percent: 0, sessions: [''], epoch: 1 },
      },
    })
    expect(await bootCode(root)).toBe('policy-state-invalid')

    writeState(root, { 'bank.tier': { active: '' } })
    expect(await bootCode(root)).toBe('policy-state-invalid')
  })

  it('显式 allowedKeyVersions 会传给编译（不被默认值吞掉）', async () => {
    const root = tempRoot('key-version')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root, config: { signature: { allowedKeyVersions: [1, 2] } } })
    try {
      expect(findPolicyDescriptor(app.ctx)?.handle).toBe('bank-tier/1.0.0')
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · 重载参数绑定（S3）', () => {
  it('候选 bundle 与部署参数不兼容 → reload-rejected，旧版继续服务', async () => {
    const root = tempRoot('reload-param')
    const stable = install(root, 'bank-tier/1.0.0')
    const demo = install(root, 'bank-tier-demo/1.0.0', demoBundle)
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier-demo/1.0.0': entryOf('bank-tier-demo/1.0.0', demo),
    })
    const guard: HostPlugin<Record<string, never>> = {
      id: 'fx:policy-param-check',
      plugin: {
        name: 'fx:policy-param-check',
        apply(ctx) {
          ctx.effect(
            providePolicyParamCheck(ctx, (descriptor) => {
              if (descriptor.handle === 'bank-tier-demo/1.0.0') {
                throw new BahError('policy-param-mismatch', '模拟：部署参数不兼容')
              }
            }),
          )
        },
      },
      validate() {
        return {}
      },
    }
    const app = await boot({
      profile: { name: 'param-check', bundles: ['param-check'], hmr: false },
      bundles: [
        {
          name: 'param-check',
          rows: [
            { id: 'core:session' },
            { id: 'policy:rules', config: { root, hotReload: true } },
            { id: 'fx:policy-param-check' },
          ],
        },
      ],
      layers: [],
      catalog: createCatalog([...HOST_PLUGINS, guard]),
      run: testRunContext({ sessionId: asSessionId('s-policy-test'), now: () => FIXED_NOW, probe: true }),
    })
    try {
      writeState(root, { 'bank.tier': { active: 'bank-tier-demo/1.0.0' } })
      expect(reloadPolicyNow()).toBe(true)
      expect(eventsOf(app, 'policy/reload-rejected')[0]?.['code']).toBe('policy-param-mismatch')
      expect(findPolicyDescriptor(app.ctx)?.handle).toBe('bank-tier/1.0.0')
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · 影子隔离（S3）', () => {
  it('影子候选求值抛错 → 只落 shadow-error，生效判决仍是 active', async () => {
    const root = tempRoot('shadow-error')
    install(root, 'bank-tier/1.0.0')
    const boom = install(root, 'bank-tier/1.0.1')
    const bundleYml = join(boom, 'bundle.yml')
    writeFileSync(
      bundleYml,
      readFileSync(bundleYml, 'utf8').replace('version: 1.0.0', 'version: 1.0.1'),
      'utf8',
    )
    const rulesPath = join(boom, 'rules.yml')
    writeFileSync(
      rulesPath,
      readFileSync(rulesPath, 'utf8').replace(
        `      - id: TR-003-default`,
        `      - id: BOOM-001-overflow
        when: preview.amountCents * preview.amountCents > 0
        keep: true
      - id: TR-003-default`,
      ),
      'utf8',
    )
    const recompiled = loadBundle({
      dir: boom,
      toolNames: [...BANK_TOOL_NAME_SET],
      verifyLock: false,
    })
    writeLockFile(boom, recompiled.lock)
    const lock = JSON.parse(readFileSync(join(boom, 'lock.json'), 'utf8')) as {
      semanticDigest: string
      sourceDigest: string
      engineVersion: string
    }
    const stable = install(root, 'bank-tier/1.0.0')
    writeRegistry(root, {
      'bank-tier/1.0.0': entryOf('bank-tier/1.0.0', stable),
      'bank-tier/1.0.1': {
        path: boom,
        semanticDigest: lock.semanticDigest,
        sourceDigest: lock.sourceDigest,
        engine: lock.engineVersion,
        installedAt: FIXED_NOW,
      },
    })
    const app = await bootPolicy({
      root,
      config: { shadow: { 'bank.tier': 'bank-tier/1.0.1' } },
    })
    try {
      const engine = findPolicyEngine(app.ctx)
      const decision = engine?.decide(
        { userId: 'u-1', sessionId: 's-policy-test' },
        { name: 'transfer_create', declared: 'yellow', callId: 'call-boom' },
        {
          riskyCallsInTurn: 0,
          verifyLocked: false,
          input: tierInput({
            preview: {
              amountCents: 1_000_000_000_000,
              dailyUsedCents: 0,
              dailyLimitCents: 1_000_000_000_000,
              payee: { binding: 'whitelist' },
            },
            limits: { dailyLimitCents: 1_000_000_000_000 },
          }),
        },
      )
      expect(decision?.level).toBe('yellow')
      const diff = eventsOf(app, 'policy/shadow-diff')[0]!
      expect(diff['changed']).toEqual(['shadow-error'])
    } finally {
      await app.dispose('test')
    }
  })
})

describe('policy:rules · sentry.rules 第二类 bundle（S5）', () => {
  /** 把真实 sentry 规则集装进临时策略根。 */
  function installSentry(root: string, handle = 'sentry-rules/1.0.0'): string {
    const dir = join(root, ...handle.split('/'))
    copyTree(realSentryBundle, dir)
    return dir
  }

  /** 造一个"版本更高、规则相同"的候选（只改 manifest version 再重算 lock）。 */
  function installSentryVariant(root: string, handle: string, version: string): string {
    const dir = installSentry(root, handle)
    const manifest = join(dir, 'bundle.yml')
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8').replace('version: 1.0.0', `version: ${version}`),
      'utf8',
    )
    const recompiled = loadRuleBundle({ dir, toolNames: [], verifyLock: false })
    writeRuleLockFile(dir, recompiled.lock)
    return dir
  }

  it('载入后服务给出 13 条规则与 sentry 身份串（描述符 kind 正确）', async () => {
    const root = tempRoot('sentry-load')
    installSentry(root)
    const app = await bootPolicy({
      root,
      config: { active: { 'sentry.rules': 'sentry-rules/1.0.0' } },
    })
    try {
      const view = findSentryRules(app.ctx)
      expect(view?.descriptor.kind).toBe('sentry.rules')
      const current = view?.rulesFor('s-any')
      expect(current?.handle).toBe('sentry-rules/1.0.0')
      expect(current?.rules).toHaveLength(13)
      expect(current?.version).toMatch(/^sentry-rules\/1\.0\.0\+sha256:[0-9a-f]{16}$/)
      expect(current?.rules.find((rule) => rule.id === 'CMD-001')?.pattern.source).toBe(
        String.raw`\brm\s+(-[rfRF]{1,2}\s*)+(\S+)`,
      )
    } finally {
      await app.dispose('test')
    }
  })

  it('灰度：canary 会话拿到候选版本，其他会话留在 active', async () => {
    const root = tempRoot('sentry-canary')
    const stable = installSentry(root)
    const variant = installSentryVariant(root, 'sentry-rules/1.0.1', '1.0.1')
    writeRegistry(
      root,
      {
        'sentry-rules/1.0.0': entryOf('sentry-rules/1.0.0', stable),
        'sentry-rules/1.0.1': entryOf('sentry-rules/1.0.1', variant),
      },
      'sentry.rules',
    )
    writeState(root, {
      'sentry.rules': {
        active: 'sentry-rules/1.0.0',
        canary: { version: 'sentry-rules/1.0.1', percent: 0, sessions: ['s-canary'], epoch: 1 },
      },
    })
    const app = await bootPolicy({
      root,
      config: { active: { 'sentry.rules': 'sentry-rules/1.0.0' } },
    })
    try {
      const view = findSentryRules(app.ctx)
      expect(view?.rulesFor('s-canary')?.handle).toBe('sentry-rules/1.0.1')
      expect(view?.rulesFor('s-other')?.handle).toBe('sentry-rules/1.0.0')
      expect(view?.descriptor.canary?.handle).toBe('sentry-rules/1.0.1')
    } finally {
      await app.dispose('test')
    }
  })

  it('只装 sentry 时银行描述符读取失败（fail-loud，不做假版本兜底）', async () => {
    const root = tempRoot('sentry-only')
    installSentry(root)
    const app = await bootPolicy({
      root,
      config: { active: { 'sentry.rules': 'sentry-rules/1.0.0' } },
    })
    try {
      expect(() => findPolicyDescriptor(app.ctx)?.kind).toThrowError(/没有 bank\.tier/)
    } finally {
      await app.dispose('test')
    }
  })

  it('只装银行时 sentry 视图读取失败 / rulesFor 返回 undefined（不伪造规则集）', async () => {
    const root = tempRoot('bank-only')
    install(root, 'bank-tier/1.0.0')
    const app = await bootPolicy({ root })
    try {
      expect(() => findSentryRules(app.ctx)?.descriptor).toThrowError(/没有 sentry\.rules/)
      expect(findSentryRules(app.ctx)?.rulesFor('s-any')).toBeUndefined()
    } finally {
      await app.dispose('test')
    }
  })

  it('sentry 影子与 active 同版本 → policy-shadow-self', async () => {
    const root = tempRoot('sentry-shadow-self')
    installSentry(root)
    const code = await bootPolicy({
      root,
      config: {
        active: { 'sentry.rules': 'sentry-rules/1.0.0' },
        shadow: { 'sentry.rules': 'sentry-rules/1.0.0' },
      },
    }).then(
      () => 'no-throw',
      (error: unknown) => {
        const shaped = error as { code?: string; detail?: { cause?: { code?: string } } }
        return shaped.detail?.cause?.code ?? shaped.code
      },
    )
    expect(code).toBe('policy-shadow-self')
  })

  it('runtime-state 把 sentry 的 active 改成与 shadow 同版本 → 启动失败 policy-shadow-self', async () => {
    const root = tempRoot('sentry-shadow-state-self')
    const stable = installSentry(root)
    const variant = installSentryVariant(root, 'sentry-rules/1.0.1', '1.0.1')
    writeRegistry(
      root,
      {
        'sentry-rules/1.0.0': entryOf('sentry-rules/1.0.0', stable),
        'sentry-rules/1.0.1': entryOf('sentry-rules/1.0.1', variant),
      },
      'sentry.rules',
    )
    writeState(root, { 'sentry.rules': { active: 'sentry-rules/1.0.1' } })
    const code = await bootPolicy({
      root,
      config: {
        active: { 'sentry.rules': 'sentry-rules/1.0.0' },
        shadow: { 'sentry.rules': 'sentry-rules/1.0.1' },
      },
    }).then(
      () => 'no-throw',
      (error: unknown) => {
        const shaped = error as { code?: string; detail?: { cause?: { code?: string } } }
        return shaped.detail?.cause?.code ?? shaped.code
      },
    )
    expect(code).toBe('policy-shadow-self')
  })

  it('sentry 影子指向另一版本 → 正常编译（与灰度同一平面）', async () => {
    const root = tempRoot('sentry-shadow')
    const stable = installSentry(root)
    const variant = installSentryVariant(root, 'sentry-rules/1.0.1', '1.0.1')
    writeRegistry(
      root,
      {
        'sentry-rules/1.0.0': entryOf('sentry-rules/1.0.0', stable),
        'sentry-rules/1.0.1': entryOf('sentry-rules/1.0.1', variant),
      },
      'sentry.rules',
    )
    const app = await bootPolicy({
      root,
      config: {
        active: { 'sentry.rules': 'sentry-rules/1.0.0' },
        shadow: { 'sentry.rules': 'sentry-rules/1.0.1' },
      },
    })
    try {
      expect(findSentryRules(app.ctx)?.rulesFor('s-any')?.handle).toBe('sentry-rules/1.0.0')
    } finally {
      await app.dispose('test')
    }
  })

  it('findSentryRules：非 service-missing 的异常原样上抛', () => {
    const boom = Object.assign(new Error('boom'), { code: 'boom' })
    const ctx = {
      get() {
        throw boom
      },
    }
    expect(() => findSentryRules(ctx as never)).toThrow('boom')
  })

  it('active 指向不存在的 sentry 版本 → 启动失败 policy-bundle-missing', async () => {
    const root = tempRoot('sentry-missing')
    const code = await bootPolicy({
      root,
      config: { active: { 'sentry.rules': 'sentry-rules/9.9.9' } },
    }).then(
      () => 'no-throw',
      (error: unknown) => {
        const shaped = error as { code?: string; detail?: { cause?: { code?: string } } }
        return shaped.detail?.cause?.code ?? shaped.code
      },
    )
    expect(code).toBe('policy-bundle-missing')
  })
})
