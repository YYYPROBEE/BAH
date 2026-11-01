/**
 * `bank:saga-audit` 配置解析的 fail-loud 面（`parseAuditSettings`）。
 *
 * 为什么值得逐条钉：这些键决定**哪些证据行被签名**、密钥版本与锚定节奏。
 * 配错不会报运行期错误，只会让一条本该验签的历史从此"看起来正常但签不了"——
 * 属于审计链最难事后发现的一类回归。默认值正常路径由 `chain.test.ts` 覆盖，
 * 这里只补拒绝分支：未知键、类型错、越界白名单。
 */

import { describe, expect, it } from 'vitest'

import { captureThrown } from '@bah/test-support'

import { SIGNED_TYPES, parseAuditSettings } from './index.ts'

/** 断言一条配置被拒，且理由码是 `invalid-config`。 */
function expectRejected(config: Readonly<Record<string, unknown>>): void {
  expect(captureThrown(() => parseAuditSettings(config)).code).toBe('invalid-config')
}

describe('parseAuditSettings：非法配置必须 fail-loud', () => {
  it('缺省值：密钥路径 / 版本 / 全量签名类型 / 不锚定 / 一天', () => {
    expect(parseAuditSettings({})).toEqual({
      signingKeyPath: 'keys/saga-ed25519.pem',
      keyVersion: 1,
      signedTypes: [...SIGNED_TYPES],
      anchorTargets: [],
      anchorIntervalMs: 86_400_000,
    })
  })

  it('未知配置键 ⇒ 拒绝（不能悄悄忽略一个拼错的键名）', () => {
    expectRejected({ signedType: ['tool/call'] })
  })

  it('signingKeyPath 必须是非空字符串', () => {
    expectRejected({ signingKeyPath: '' })
    expectRejected({ signingKeyPath: 42 })
  })

  it('keyVersion 必须是 ≥ 1 的整数', () => {
    expectRejected({ keyVersion: 0 })
    expectRejected({ keyVersion: 1.5 })
    expectRejected({ keyVersion: '1' })
  })

  it('signedTypes 必须是字符串数组，且只能是白名单子集', () => {
    expectRejected({ signedTypes: 'tool/call' })
    expectRejected({ signedTypes: [42] })
    expectRejected({ signedTypes: ['saga/created'] })
  })

  it('anchorTargets 必须是字符串数组', () => {
    expectRejected({ anchorTargets: [42] })
  })

  it('anchorIntervalMs 必须是 ≥ 1 的整数', () => {
    expectRejected({ anchorIntervalMs: 0 })
    expectRejected({ anchorIntervalMs: 1.5 })
  })
})
