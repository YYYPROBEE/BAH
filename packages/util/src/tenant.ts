/**
 * 租户标识（租户与鉴权 01 · TA-10）。
 *
 * ## 为什么租户 ID 要有自己的字符集（不复用 `assertSafePathSegment`）
 *
 * 同一个字符串要同时当**目录段**、**sqlite 文件名**、**指标标签**与**环境变量后缀**：
 *
 * | 用途 | 要求 | 满足方式 |
 * |---|---|---|
 * | 目录名 | 不含 `/`、`\`、`..` | 只允许 `[a-z0-9-]` |
 * | sqlite 文件名 | 不含 `:`、`/` | 同上 |
 * | 指标标签 | 不含空格 / 引号 | 同上 |
 * | 环境变量后缀 | 只 `[A-Z0-9_]` | 转大写、`-`→`_`（见 `tenantEnvSuffix`） |
 * | 日志可读 | 不大小写混淆 | 强制小写 |
 *
 * `assertSafePathSegment` 允许大写与下划线 ⇒ `Demo`/`demo` 会落进两个目录，
 * 却在 `BAH_KNOWLEDGE_TOKEN_DEMO` 上撞车；而 `demo_bank` 与 `demo-bank` 会得到
 * **同一个**环境变量后缀。所以租户必须比"路径安全"更严。
 *
 * ## 纪律
 *
 * **租户只来自启动输入**（CLI `--tenant` / `BAH_TENANT` / 字面量常量），
 * 永不来自请求头或查询参数——T3 的授权判定以这条为前提，
 * 门禁 `verify-tenant-scope` 的判据 3 机械检查它。
 */

import type { Branded } from './brand/index.ts'
import { BahError } from './util/errors.ts'

/**
 * 合法租户标识（品牌类型）。
 *
 * 品牌的意义：`TenantId` 与普通 `string` 在类型层不兼容，防止把会话 ID / 用户 ID
 * 误传给租户参数。运行期它就是 `string`。
 */
export type TenantId = Branded<'tenant-id'>

/**
 * 合法租户 ID：小写字母数字与连字符，2–31 字符。
 *
 * 首尾必须是字母数字——`-demo` / `demo-` 这类值在 URL 片段与命令行里会被当成开关。
 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$/

/** 是否是合法租户 ID（不做 trim：`' demo'` 不是合法租户，别把笔误静默吃掉）。 */
export function isTenantId(raw: string): boolean {
  return TENANT_ID_PATTERN.test(raw)
}

/**
 * 解析并校验租户 ID。
 *
 * @throws `BahError('tenant-id-invalid')` 不满足 {@link TENANT_ID_PATTERN}
 */
export function parseTenantId(raw: string): TenantId {
  if (!isTenantId(raw)) {
    throw new BahError(
      'tenant-id-invalid',
      `租户 ID 非法：${JSON.stringify(raw)}（只允许小写字母数字与连字符，2–31 字符，首尾不能是连字符）`,
      { tenantId: raw },
    )
  }
  return raw as TenantId
}

/**
 * 把已经校验过的字符串断言成 `TenantId`（**不校验**）。
 *
 * 只允许两种用法：
 * 1. 值来自 {@link parseTenantId}（或 `DEFAULT_TENANT_ID` 这类编译期常量）；
 * 2. 类型层已经窄化过。
 *
 * 其它场景一律用 `parseTenantId`——运行期输入（argv / 环境变量 / 配置）走这里
 * 会把非法租户放进落盘路径。`normalizePrincipal` 会对它做一次运行期兜底。
 */
export function asTenantId(raw: string): TenantId {
  return raw as TenantId
}

/**
 * 租户 ID → 环境变量后缀（`acme-bank` → `ACME_BANK`）。
 *
 * 与 `toUpperCase().replace(/-/g, '_')` 逐字一致；集中在这里是为了让
 * "按租户取环境变量"只有一处拼法（02/03 也会用）。
 */
export function tenantEnvSuffix(tenantId: TenantId): string {
  return String(tenantId).toUpperCase().replace(/-/g, '_')
}

/**
 * 缺省租户（`demo`）。
 *
 * **唯一的硬编码点**：CLI 的缺省值、测试夹具的 `testRunContext`、数据集零偏移
 * 都引用它，而不是各写一遍 `'demo'`（否则改缺省租户要改十几处）。
 * 数据集盐的"demo 零偏移"判的是**值**等于 `demo`，不判它是不是缺省。
 */
export const DEFAULT_TENANT_ID: TenantId = parseTenantId('demo')
