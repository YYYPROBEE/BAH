/**
 * 强验证的测试网关 Provider（W09）。
 *
 * 与 `createMockVerifyProvider` 共用 `VerifyProvider` 接口；**失败计数与锁定仍在
 * `VerifyService`**，本层只做"网关应答"这一跳，便于将来替换成真实短信 / 人脸 / U 盾。
 *
 * 边界：默认客户端是确定性测试网关（第 `successAfter` 次起成功），**没有接任何真实供应商**；
 * 真实渠道只需要实现 `VerifyGatewayClient` 并通过 `client` 注入。
 */

import { BahError } from '@bah/util'

import type { StrongAuth } from './model.ts'
import type { VerifyAttempt, VerifyOutcome, VerifyProvider } from '../verify/index.ts'

/** 网关客户端：一次验证请求 → 一次应答（真实供应商实现这一个接口即可）。 */
export interface VerifyGatewayClient {
  readonly id: string
  verify(attempt: VerifyAttempt): Promise<VerifyOutcome>
}

/** 确定性测试网关的参数。 */
export interface TestGatewayClientOptions {
  /** 第几次尝试起成功（缺省 1 = 首次成功）。 */
  readonly successAfter?: number
  /** 只接受这些渠道（缺省 = 全部；用于模拟"某种渠道未开通"）。 */
  readonly acceptedChannels?: readonly StrongAuth[]
}

/**
 * 造确定性测试网关客户端。
 *
 * @throws `verify-gateway-invalid` `successAfter` 不是 ≥1 的整数
 */
export function createTestGatewayClient(
  options: TestGatewayClientOptions = {},
): VerifyGatewayClient {
  const successAfter = options.successAfter ?? 1
  if (!Number.isInteger(successAfter) || successAfter < 1) {
    throw new BahError(
      'verify-gateway-invalid',
      `bank-tools: 测试网关的 successAfter 必须是 ≥1 的整数（收到 ${String(successAfter)}）`,
      { successAfter },
    )
  }
  const accepted = options.acceptedChannels
  return {
    id: 'test-gateway/v1',
    async verify(attempt) {
      if (accepted !== undefined && !accepted.includes(attempt.channel)) {
        return { success: false }
      }
      return { success: attempt.attempt >= successAfter }
    },
  }
}

/** `createGatewayVerifyProvider` 的参数。 */
export interface GatewayVerifyProviderOptions {
  /** 自定义网关客户端（缺省 = `createTestGatewayClient`）。 */
  readonly client?: VerifyGatewayClient
  /** 缺省客户端的 `successAfter`（仅在未注入 `client` 时生效）。 */
  readonly successAfter?: number
}

/**
 * 造可替换的网关 Provider（接口与 mock 完全一致）。
 *
 * @throws `verify-gateway-invalid` 尝试序号不是 ≥1 的整数（防止 0/负数绕开失败计数）
 */
export function createGatewayVerifyProvider(
  options: GatewayVerifyProviderOptions = {},
): VerifyProvider {
  const client =
    options.client ?? createTestGatewayClient({ successAfter: options.successAfter ?? 1 })
  return {
    async verify(attempt) {
      if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1) {
        throw new BahError(
          'verify-gateway-invalid',
          `bank-tools: 网关收到非法尝试序号 ${String(attempt.attempt)}`,
          { attempt: attempt.attempt },
        )
      }
      const outcome = await client.verify(attempt)
      return { success: outcome.success === true }
    },
  }
}
