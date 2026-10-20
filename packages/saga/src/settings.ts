/**
 * `bank:saga` 配置校验（SA-00 §10 逐字实现；不引入 schemastery）。
 *
 * 为什么不用 host 的校验原语：`@bah/saga` 不得反向依赖 `@bah/host`（会形成包环），
 * 因此这里保留一份**行为一致**的手写实现。错误前缀固定为 `bah-saga: `。
 */

import {
  BahError,
  readConfigPositiveInteger,
  rejectUnknownConfigKeys,
} from '@bah/util'

import type { CompBackoffSettings, SagaFeatureFlags, SagaSettings } from './types.ts'

const PREFIX = 'bah-saga: '

const configFail = (message: string, detail: Readonly<Record<string, unknown>>): never => {
  fail(message, detail)
}

const ALLOWED = [
  'dbPath',
  'maxParallelBranches',
  'maxAttempts',
  'probeTimeoutMs',
  'probeLagFactor',
  'compBackoff',
  'softSlaMs',
  'hardSlaMs',
  'forceCloseMs',
  'reconBatchSize',
  'dlqAlertDepth',
  'dlqPhoneDepth',
  'signingKeyPath',
  'keyVersion',
  'anchorIntervalMs',
  'features',
] as const

/**
 * 校验并补齐 `bank:saga` 配置。
 *
 * @throws `BahError('invalid-config')` 未知键 / 类型错误 / 不变量不成立，消息带 `bah-saga: `
 */
export function parseSagaSettings(config: Readonly<Record<string, unknown>>): SagaSettings {
  rejectUnknownKeys(config, ALLOWED, 'bank:saga')

  const settings: SagaSettings = {
    dbPath: readString(config, 'dbPath', 'saga.sqlite'),
    maxParallelBranches: readPositiveInteger(config, 'maxParallelBranches', 4),
    maxAttempts: readPositiveInteger(config, 'maxAttempts', 3),
    probeTimeoutMs: readPositiveInteger(config, 'probeTimeoutMs', 5000),
    probeLagFactor: readPositiveNumber(config, 'probeLagFactor', 2),
    compBackoff: readCompBackoff(config['compBackoff']),
    softSlaMs: readPositiveInteger(config, 'softSlaMs', 86_400_000),
    hardSlaMs: readPositiveInteger(config, 'hardSlaMs', 259_200_000),
    forceCloseMs: readPositiveInteger(config, 'forceCloseMs', 604_800_000),
    reconBatchSize: readPositiveInteger(config, 'reconBatchSize', 200),
    dlqAlertDepth: readPositiveInteger(config, 'dlqAlertDepth', 10),
    dlqPhoneDepth: readPositiveInteger(config, 'dlqPhoneDepth', 50),
    signingKeyPath: readString(config, 'signingKeyPath', 'keys/saga-ed25519.pem'),
    keyVersion: readPositiveInteger(config, 'keyVersion', 1),
    anchorIntervalMs: readPositiveInteger(config, 'anchorIntervalMs', 86_400_000),
    features: readFeatures(config['features']),
  }

  assertOrder('softSlaMs', settings.softSlaMs, 'hardSlaMs', settings.hardSlaMs)
  assertOrder('hardSlaMs', settings.hardSlaMs, 'forceCloseMs', settings.forceCloseMs)
  assertOrder('dlqAlertDepth', settings.dlqAlertDepth, 'dlqPhoneDepth', settings.dlqPhoneDepth)
  if (settings.compBackoff.baseMs > settings.compBackoff.maxMs) {
    fail('compBackoff.baseMs 必须 ≤ compBackoff.maxMs', { compBackoff: settings.compBackoff })
  }

  return settings
}

function rejectUnknownKeys(
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  where: string,
): void {
  rejectUnknownConfigKeys(record, allowed, where, configFail)
}

function readString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fallback: string,
): string {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${key} 必须是非空字符串`, { key, value })
  }
  return value
}

function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  return readConfigPositiveInteger(record, key, '', fallback, configFail) ?? fallback
}

function readPositiveNumber(
  record: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = record[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    fail(`${key} 必须是 > 0 的有限数`, { key, value })
  }
  return value
}

function readCompBackoff(value: unknown): CompBackoffSettings {
  const record = asObject(value, 'compBackoff')
  const allowed = ['baseMs', 'maxMs', 'jitter']
  if (record !== undefined) {
    const unknown = Object.keys(record).filter((key) => !allowed.includes(key))
    if (unknown.length > 0) {
      fail(`compBackoff 出现未知配置键：${unknown.join(', ')}（可写：baseMs / maxMs / jitter）`, {
        unknown,
      })
    }
  }

  const baseMs = readNestedPositiveInteger(record, 'baseMs', 30_000, 'compBackoff')
  const maxMs = readNestedPositiveInteger(record, 'maxMs', 3_600_000, 'compBackoff')
  const jitter = readNestedNumber(record, 'jitter', 0.3, 'compBackoff')
  if (jitter < 0 || jitter > 1) {
    fail('compBackoff.jitter 必须落在 [0, 1]', { jitter })
  }
  return { baseMs, maxMs, jitter }
}

function readFeatures(value: unknown): SagaFeatureFlags {
  const record = asObject(value, 'features')
  const allowed = ['b1', 'b2', 'b3', 'b4'] as const
  if (record !== undefined) {
    const unknown = Object.keys(record).filter((key) => !(allowed as readonly string[]).includes(key))
    if (unknown.length > 0) {
      fail(`features 出现未知配置键：${unknown.join(', ')}（可写：b1 / b2 / b3 / b4）`, { unknown })
    }
  }
  return {
    b1: readNestedBoolean(record, 'b1', true, 'features'),
    b2: readNestedBoolean(record, 'b2', true, 'features'),
    b3: readNestedBoolean(record, 'b3', true, 'features'),
    b4: readNestedBoolean(record, 'b4', true, 'features'),
  }
}

function asObject(value: unknown, key: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${key} 必须是对象`, { key, value })
  }
  return value as Readonly<Record<string, unknown>>
}

function readNestedPositiveInteger(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
  parent: string,
): number {
  const value = record?.[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail(`${parent}.${key} 必须是 ≥ 1 的整数`, { key: `${parent}.${key}`, value })
  }
  return value
}

function readNestedNumber(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
  parent: string,
): number {
  const value = record?.[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${parent}.${key} 必须是有限数`, { key: `${parent}.${key}`, value })
  }
  return value
}

function readNestedBoolean(
  record: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: boolean,
  parent: string,
): boolean {
  const value = record?.[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    fail(`${parent}.${key} 必须是布尔`, { key: `${parent}.${key}`, value })
  }
  return value
}

function assertOrder(leftKey: string, left: number, rightKey: string, right: number): void {
  if (left < right) return
  fail(`${leftKey} 必须小于 ${rightKey}`, { leftKey, left, rightKey, right })
}

function fail(message: string, detail?: unknown): never {
  throw new BahError('invalid-config', `${PREFIX}invalid-config: ${message}`, detail)
}
