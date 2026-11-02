/**
 * `auth.mode: password` 与 profile 静态身份/静态画像的冲突校验（租户与鉴权 02 · TA-27）。
 *
 * ## 为什么必须是 boot 期错误
 *
 * | 冲突 | 后果（如果放过） |
 * |---|---|
 * | `demoUserId` + `password` 模式 | 两处绑身份（profile 写死 + 登录），后写的赢；重启后行为与登录态不一致，且没有任何报错 |
 * | `runtimeContext.user` + `password` 模式 | 静态画像写死"张三"（u-1），一旦用 u-9 登录，`slots-user-mismatch` 会让**每个 turn 直接失败**（复审 AR-10） |
 *
 * 这两条都只影响"演示档"的便利配置，正确做法是 `password` 模式下去掉它们
 * （姓名由实体槽位现算、身份由登录绑定）。**fail-loud 比"演示现场突然炸"便宜。**
 *
 * 为什么放在 `boot()` 而不是 web 插件里：这是**跨行**约束（web 的 mode 与 bank/agent 的配置），
 * 只有 boot 拿得到整张解析后的行表。
 */

import type { ValidatedRow } from '../plugin-manager/index.ts'

import { bootError } from './config.ts'

/** 从某一行取一个嵌套字段（配置是 `unknown` 形状，这里逐层判型）。 */
function field(row: ValidatedRow | undefined, path: readonly string[]): unknown {
  let current: unknown = row?.settings
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * 断言认证配置与其它行的兼容性。
 *
 * @throws `BahError('auth-demo-user-conflict')` / `BahError('auth-static-user-conflict')`
 */
export function assertAuthCompatibility(rows: readonly ValidatedRow[]): void {
  const web = rows.find((row) => row.id === 'channel:web')
  const mode = field(web, ['auth', 'mode'])
  if (mode !== 'password') return

  const bank = rows.find((row) => row.id === 'bank:tools')
  if (field(bank, ['demoUserId']) !== undefined) {
    throw bootError(
      'auth-demo-user-conflict',
      'channel:web.auth.mode=password 时 bank:tools.demoUserId 不许写（两处绑身份，后写的赢）；去掉它，身份由登录绑定',
      { row: 'bank:tools' },
    )
  }

  const agent = rows.find((row) => row.id === 'core:agent')
  if (field(agent, ['runtimeContext', 'user']) !== undefined) {
    throw bootError(
      'auth-static-user-conflict',
      'channel:web.auth.mode=password 时 core:agent.runtimeContext.user 不许写（静态画像写死的姓名会与登录用户不一致，' +
        'first turn 即 slots-user-mismatch）；去掉 user，姓名由实体槽位现算',
      { row: 'core:agent' },
    )
  }
}
