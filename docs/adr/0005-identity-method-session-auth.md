# ADR-0005 · `IdentityMethod` 追加 `session-auth`

- 状态：**已采纳**（2026-10-29）
- 关联：`02-鉴权平面-AuthN.md` TA-27、`docs/contracts/tenant-model.md`、`docs/contracts/event-table.md`

---

## 1 背景

02 之前，"会话绑定到哪个银行客户"只有三种来源（`IdentityMethod`）：
`demo-config`（profile 写死）、`mock-login`（短信验证码）、`im-map`（IM 用户映射）。

02 增加了第四种：**Web 登录**（口令 + 会话 cookie）。它必须能被区分出来，否则审计上
"这个身份是怎么来的"会把登录与演示档配置混成一谈——而这两者的可信度完全不同。

## 2 决策

在**两个同值集的类型**上追加一个枚举值：

| 类型 | 位置 |
|---|---|
| `IdentityMethod` | `packages/bank/src/tools/identity.ts` |
| `IdentityBindingMethod` | `packages/persistence/src/credentials/index.ts` |

```ts
'demo-config' | 'mock-login' | 'im-map' | 'session-auth'
```

`CredentialsService.bindSession(sessionId, userId, method = 'mock-login')` 增加可选第三参，
Web 登录时传 `'session-auth'`。**只加枚举值，不改字段名 / 类型 / 事件键。**

## 3 为什么是"加值"而不是"加字段"

- 会话事件表冻结在 19 键（G2/R2）。`identity/bound` **已在表内**，加一个枚举值是
  payload 语义的扩展，不是新键——不需要动 ADR-0003 的"唯一一次改签"名额。
- 旧日志仍可读：`method` 是同一个字符串字段，未知值只影响"人读的解释"，不影响回放
  （回放只取 `userId` 与当前租户，见 01 的 D-2）。

## 4 后果

1. 审计链上的 `auth/login`（02 TA-30）与 `identity/bound` 的 `method` 能对上：
   "登录来的身份"与"演示配置的身份"在证据上可区分；
2. 两处同值集必须**同批改**（类型不匹配会在 `pnpm typecheck` 直接红，不会静默漂）；
3. 若将来还要加来源（OIDC、企业微信扫码），继续加值即可——但每加一个都要问
   "这个来源的可信度与另外几个相同吗"。

## 5 复核

```bash
grep -rn "session-auth" packages/bank/src/tools/identity.ts packages/persistence/src/credentials/index.ts
grep -c "'" docs/contracts/event-table.md   # 键集合不变（19 键）
```
