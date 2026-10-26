# 施工单 HP-0：sentry 判决件 fail-closed + 人工解冻入口

> 施工单代号：HP-0
> 起草日期：2026-10-22
> 基线：`HEAD 0cd4a5d` + 未提交并发改动（eval / memory-store / saga-bridge）
> 适用范围：`packages/safety`（sentry）、`packages/host`（web 管理路由）、`packages/cli`（sentry 子命令）、文档
> 依据：`审计-2026-10-22/交叉核查/插件交叉核查报告-2026-10-22.md` C-7/C-8、`文档归档/幻觉防护施工集-处置方案-2026-10-22.md` HP-0
> 状态：**已施工**（2026-10-23；HP0-01…15 全部落地，回执见 `PROGRESS.md` §49）
> HP-3（HALT）：**已施工**（2026-10-25，W07）；本文中"HP-3 再做/未实现"的表述是
> HP-0 阶段的**历史边界**，现状见 `docs/security-self-assessment.md` §6.1。

---

## §0 施工前取证：为什么入口不是“单独一个 CLI 命令”

### §0.1 现在的 fail-open 点

`packages/runtime/src/tools/pipeline.ts:257-266`：

```ts
try {
  post = await this.ctx.events.waterfall('tools/post-execute', {
    call,
    content,
    verdict: { kind: 'accept' },
  })
} catch (error) {
  // 后置监听器坏了不等于工具执行坏了：按 accept 继续，落审计。
  this.auditCallbackFailure('post-execute', call.callId, error)
  post = { call, content, verdict: { kind: 'accept' } }
}
```

sentry 的幻觉/诚实性判决正是挂在这个 waterfall 上（`packages/safety/src/sentry/pipeline/index.ts:151`）。它抛错时，结果会原样作为可信内容交给模型。这是本单要堵的第一件事。

### §0.2 断路器是进程内状态，CLI 进程解不了另一个进程

`packages/safety/src/sentry/pipeline/breaker.ts` 的 `SentryBreaker` 持有内核 `Breaker` 实例，状态全在内存；`unfreeze` 只改当前实例：

```ts
unfreeze(by: string, reason: string, at: number): boolean {
  if (!this.kernel.tripped) return false
  this.kernel.tripped = false
  this.kernel.denies.length = 0
  this.record('sentry/unfrozen', { sessionId: this.sessionId, by, reason, at })
  this.trace.append({ session: this.sessionId, kind: 'breaker-unfrozen', by, reason, at })
  return true
}
```

因此 `bah sentry unfreeze` **不能**是“boot 一个新 app 再调 `SENTRY_SERVICE.unfreeze`”：那只解了新进程里的假断路器，正在跑的 web/headless 进程仍然冻结。这是本单最重要的设计约束。

### §0.3 现有 web 宿主已经有真实 HTTP 面，但没有管理路由

`packages/host/src/boot/plugins/web.ts` 已用 `node:http` 起服务，现有路由：

```text
GET  /api/session
GET  /api/health
GET  /api/events
POST /api/turn
POST /api/interrupt
POST /api/approval/:id
POST /api/verify/:id
GET  /...（静态）
```

没有鉴权；`safety:sentry` 在 `HOST_PLUGINS` 里排在 `channel:web` 之前，服务键可用。

### §0.4 结论：入口必须是“运行中宿主的 token 管理路由 + CLI 客户端”

```text
CLI 客户端（新进程） --POST /api/admin/sentry/unfreeze--> 运行中的 web 宿主
                                                         -> ctx.get(SENTRY_SERVICE).unfreeze(by, reason)
                                                         -> breaker 记录 sentry/unfrozen
```

- 管理路由只绑本机回环、只接受 `BAH_ADMIN_TOKEN`、默认关闭（未设 token 时 404）。
- CLI 只是 HTTP 客户端；它不 boot app、不伪造解冻。
- **headless 限制**：headless 没有 HTTP 服务，HP-0 阶段没有远程解冻入口，只能重启进程。这一点必须写进 `docs/sentry.md`，不能假装 CLI 能解。HP-3 再评估控制套接字或审批票据解除（**2026-10-25 已按审批票据路径落地，见 `docs/sentry.md` §5.2**）。

---

## §1 目标与非目标

### 目标

1. sentry 的 `tools/post-execute` 判决件自身异常时，**不再静默 accept**：返回 `block`，让结果不进入模型可信上下文，并落 `sentry/verifier-failed` 审计事件。
2. 给运行中的 web 宿主提供**唯一的、带本机 token 鉴权的人工解冻入口**；CLI 提供客户端命令。
3. 把 headless 的限制如实写进文档，避免“命令能跑但解不了”的假能力。

### 非目标

- 不改 `packages/runtime` 的通用 catch；不把七段管线改成“所有监听器异常都 block”。本单只修 sentry 这个带 `block` 权限的判决件。
- 不建 HALT 状态机、不做 S0–S7、不做冷静期；那是 HP-3。
- 不持久化 breaker；不跨进程共享状态。
- 不做 Web UI 按钮；管理路由只给 CLI/运维使用。
- 不引入新的鉴权系统；只接受环境变量 token + 本机回环。
- 不改审批票据、不动 `interaction/approval`。

---

## §2 文件落点

### 新增

```text
packages/safety/src/sentry/pipeline/fail-closed.ts
packages/safety/src/sentry/pipeline/fail-closed.test.ts
packages/host/src/boot/plugins/web-admin.ts
packages/host/src/boot/plugins/web-admin.test.ts
packages/cli/src/cli/sentry.ts
packages/cli/src/cli/sentry.test.ts
```

### 修改

```text
packages/safety/src/sentry/pipeline/index.ts       # 用包装器注册 post-execute
packages/safety/src/sentry/pipeline/events.ts      # 新增 sentry/verifier-failed
packages/host/src/boot/plugins/web.ts              # 挂管理路由
packages/cli/src/cli/command.ts                    # 增加 sentry 子命令
packages/cli/src/cli/run.ts                        # 分流 + HELP
packages/cli/src/cli/index.ts                      # 导出
packages/cli/src/cli/command.test.ts               # 路由用例
docs/sentry.md                                     # 解冻入口与 headless 限制
docs/web-frontend.md                               # 管理路由契约
PROGRESS.md                                        # 施工回执（按当时最新编号，不预设 §号）
```

---

## §3 接口契约

### §3.1 fail-closed 包装器

`fail-closed.ts` 导出：

```ts
import type { TraceLog } from '../kernel/index.ts'
import type { SentrySessionEventType } from './events.ts'

export interface FailClosedOptions {
  readonly sessionId: string
  readonly trace: TraceLog
  readonly record: (type: SentrySessionEventType, data: unknown) => void
  readonly now: () => number
}

/** 把任意 post-execute 监听器包成 fail-closed。 */
export function failClosedPostExecute(
  listener: (payload: unknown, next: (value: unknown) => Promise<unknown>) => Promise<unknown>,
  options: FailClosedOptions,
): (payload: unknown, next: (value: unknown) => Promise<unknown>) => Promise<unknown>

/** sentry 自己的 post-execute 监听器：数值对账 + fail-closed。 */
export function createSentryPostExecuteListener(
  options: SentryHonestyOptions,
): (payload: unknown, next: (value: unknown) => Promise<unknown>) => Promise<unknown>
```

行为：

1. 正常路径：原样返回 `listener(payload, next)`。
2. 监听器抛错：不向上抛；落 `sentry/verifier-failed`；`trace.append` 一条 `honesty-verifier-failed`；返回：

```ts
{
  ...(payload as object),
  verdict: {
    kind: 'block',
    code: 'verifier-unavailable',
    reason: '【幻觉防护】结果核验组件异常，本次工具结果未经核验，已阻断。请重试或联系运维。',
  },
}
```

3. 错误消息只进审计，不进模型可见的 `reason`；`message` 截断到 200 字符，不拼接 `payload` / `args` / 工具结果。
4. `next` 最多被调用一次；若监听器在 `next` 之后抛错，仍以 `block` 覆盖下游判决（fail-closed 优先）。

事件声明（`events.ts`）：

```ts
'sentry/verifier-failed': {
  readonly listener: 'tools/post-execute'
  readonly code: 'verifier-unavailable'
  readonly message: string
  readonly at: number
}
```

并加入 `SENTRY_SESSION_EVENT_TYPES`；`session.appendDomain(..., { ignorable: true })` 由宿主 `record` 落账。

`pipeline/index.ts` 把：

```ts
ctx.effect(ctx.events.on('tools/post-execute', createNumericListener({ ...shared, nudge: ports.nudge })))
```

换成：

```ts
ctx.effect(ctx.events.on('tools/post-execute', createSentryPostExecuteListener({ ...shared, nudge: ports.nudge })))
```

`createNumericListener` 保留导出与现有测试不动，避免破坏已冻结接口。

### §3.2 Web 管理路由

路由：`POST /api/admin/sentry/unfreeze`

鉴权与环境：

- `BAH_ADMIN_TOKEN` 必须存在且非空；未设置时路由返回 **404**（不暴露存在性）。
- 仅接受本机回环：`req.socket.remoteAddress` ∈ `127.0.0.0/8`、`::1`、`::ffff:127.0.0.1`；否则 **403**。
- `Authorization: Bearer <token>`；缺失/错误 → **401**；比较用 `timingSafeEqual`，长度先判。
- 不读配置文件里的 token；不把 token 写入日志、错误体、审计事件。

请求体：

```json
{ "by": "ops-7", "reason": "客服复核：误报" }
```

- `by`：必填，非空，≤64 字符。
- `reason`：可选，≤200 字符；缺省用 `operator-unfreeze`。
- 未知键拒绝；非法 → **400** `web-admin-invalid-body`。

响应：

```json
{ "ok": true, "unfrozen": true }
```

- 已冻结并解除：200，`unfrozen: true`。
- 未冻结：200，`unfrozen: false`（幂等 no-op）。
- sentry 服务不存在：**503** `sentry-absent`（web 仍能启动；路由不硬依赖 sentry）。
- 非 POST：**405** `web-method-not-allowed`。

实现要点：

- `web.ts` 用 `try { ctx.get(SENTRY_SERVICE) } catch { undefined }` 惰性取服务；**不要**把 `SENTRY_SERVICE.id` 加进 `webPlugin.plugin.inject`，否则没有 sentry 的 profile 会起不来。
- `web-admin.ts` 只放纯函数：`readAdminToken` / `isLoopbackAddress` / `tokenMatches` / `parseUnfreezeBody`；路由只做编排与 `sendJson` / `sendError`。
- 不加 CORS 头；浏览器跨源调用会被自然挡住，管理面只服务本机 CLI。
- 不记录访问日志中的 Authorization。

### §3.3 CLI 客户端

命令：

```text
bah sentry unfreeze [--url http://127.0.0.1:7331] --by <operator> [--reason <text>]
```

- `--url`：缺省 `http://127.0.0.1:7331`；只允许 http/https；末尾斜杠去掉。
- `--by`：必填，≤64 字符。
- `--reason`：可选，≤200 字符；缺省 `operator-unfreeze`。
- token：只从环境变量 `BAH_ADMIN_TOKEN` 读取；**不提供 `--token`**，避免进程列表/shell history 泄漏。
- 请求：`POST <url>/api/admin/sentry/unfreeze`，`authorization: Bearer <token>`，`content-type: application/json`。
- 输出：
  - `unfrozen: true` → `已解冻（by=<by>）`，退出 0。
  - `unfrozen: false` → `当前未处于冻结状态`，退出 0。
  - 401/403 → 打印结构化错误，退出 1。
  - 404 → `管理路由未启用：请确认 profile 是 web 且已设置 BAH_ADMIN_TOKEN`，退出 1。
  - 网络失败 → `无法连接 web 宿主：<reason>`，退出 1。
  - 缺 token / 缺 `--by` / 未知参数 → 退出 2。
- `parseCommand` 增加：

```ts
| { readonly kind: 'sentry' }
```

`argv[0] === 'sentry'` 即进入子命令；`runSentryUnfreeze(argv.slice(1), io, options)` 自己要求 `argv[0] === 'unfreeze'`，否则用法错误。
- `HELP` 增加“子命令”两行：`bah audit ...`、`bah sentry unfreeze ...`。
- `runSentryUnfreeze` 的 options 允许注入 `fetchImpl` 与 `env`，测试不真连网络。

---

## §4 实施步骤

1. **fail-closed 包装器**：新增 `fail-closed.ts`；写 direct 单测；在 `pipeline/index.ts` 换注册；新增事件声明。
2. **sentry 集成**：在 sentry 测试装置里注册一个**故意抛错的 downstream `tools/post-execute` 监听器**，断言 sentry 的包装器把它转成 `block`，并落 `sentry/verifier-failed`。
3. **web 管理路由**：新增 `web-admin.ts` 纯函数与单测；`web.ts` 挂路由；用 fake `SENTRY_SERVICE` 覆盖 200/400/401/403/404/503/405。
4. **CLI 客户端**：新增 `sentry.ts`；改 `command.ts` / `run.ts` / `index.ts`；用本地 `http.createServer` 或注入 `fetchImpl` 覆盖请求与退出码。
5. **文档与回执**：更新 `docs/sentry.md`、`docs/web-frontend.md`、`HELP`；在 `PROGRESS.md` 追加施工回执（含 headless 限制与偏差）。
6. **快照与门禁**：改到 `packages/safety` / `packages/host/src/boot`（SENSITIVE 名单），重录快照、跑 web/snapshot 测试；全量 gate 在并发工作区收口后复跑。

---

## §5 测试用例表

| ID | 层 | 断言 |
|---|---|---|
| HP0-01 | fail-closed | 监听器抛错 → 返回 `block` + `code=verifier-unavailable` |
| HP0-02 | fail-closed | 监听器正常 → 原样返回，不改判决 |
| HP0-03 | fail-closed | 抛错 → 落 `sentry/verifier-failed` + trace，消息截断 200 字 |
| HP0-04 | sentry 集成 | downstream 抛错 → sentry 包装器返回 block，结果不进入模型可信内容 |
| HP0-05 | web-admin | 未设 `BAH_ADMIN_TOKEN` → 404 |
| HP0-06 | web-admin | 缺/错 token → 401；长度不同也不抛时序异常 |
| HP0-07 | web-admin | 非回环地址 → 403（helper 单测 + 路由分支） |
| HP0-08 | web-admin | 正确 token + 冻结 → 200 `unfrozen:true`，fake 收到 by/reason |
| HP0-09 | web-admin | 正确 token + 未冻结 → 200 `unfrozen:false` |
| HP0-10 | web-admin | body 缺 by / 超长 / 未知键 → 400 |
| HP0-11 | web-admin | sentry 服务缺失 → 503，web 仍可启动 |
| HP0-12 | CLI | 缺 `--by` / 缺 token / 未知参数 → 退出 2 |
| HP0-13 | CLI | 正确请求 → POST 路径/头/body 正确，200 true → 退出 0 |
| HP0-14 | CLI | 404 / 网络失败 → 退出 1，错误可读且不泄漏 token |
| HP0-15 | CLI | `HELP` 含 `bah sentry unfreeze`；`parseCommand` 不误吞 `--profile sentry` |

---

## §6 出口标准

### 必跑

```bash
pnpm test -- packages/safety packages/host packages/cli
pnpm typecheck
pnpm lint
pnpm test:web
```

### 快照

```bash
pnpm snapshot:record
pnpm test:snapshot
git diff --stat snapshots/
```

- 改到 `packages/safety/src`、`packages/host/src/boot` 属于 `verify-snapshot-fresh` 的 SENSITIVE 面；必须重录并复核 diff。
- 如果新路由没有被三个既有场景触发，快照数据可能不变，但 freshness 记录仍要更新；以门禁结果为准，不以“看起来没变”为准。

### 门禁

```bash
pnpm gate
```

- 当前工作区有并发未提交项（eval / memory-store / saga-bridge），基线存在 `verify-saga-wiring`、`tracked-sources`、`snapshot-fresh` 红；本单出口要求**不新增红**，并在并发收口后复跑全量。
- `docs/hp-0-fail-closed.md` 本身会被 `verify-docs-paths` 扫描：新增路径只放在围栏代码块里，正文用短文件名，避免“规划路径”判红。

### 覆盖率

- 新增文件行覆盖 100%；若某分支是防御性不可达，按既有口径加 `/* v8 ignore next */` 并在回执登记，不得沉默。
- 全仓覆盖率的历史红不算到本单，但本单新增文件不得低于 100%。

---

## §7 硬约束

1. **只改 sentry 的 fail-closed，不改 runtime 通用 catch**：避免主循环破坏性变更；若未来加第二个带 `block` 权限的监听器，必须同样自包 fail-closed。
2. **管理路由默认关闭**：无 `BAH_ADMIN_TOKEN` 时 404；不得提供无鉴权解冻口。
3. **只绑本机回环**：非回环来源一律 403；不得加 CORS。
4. **token 不进 argv、不进日志、不进错误体、不进审计**；只从环境变量读。
5. **CLI 不 boot app**：它只是 HTTP 客户端；不得写成“新进程解冻新进程”的假功能。
6. **headless 限制如实写**：HP-0 阶段 headless 没有远程解冻，重启是唯一路径；不得在 README/答辩里说“CLI 可解 headless”。
7. **错误消息去敏**：`sentry/verifier-failed.message` 不拼接工具参数/结果；只留错误类型与 200 字内的消息。
8. **事件可跳过**：`sentry/verifier-failed` 必须 `ignorable: true`，否则旧 reader 会把领域事件当缺失。
9. **零新增运行时依赖**：只用 `node:http` / `node:crypto` / 全局 `fetch`。
10. **一次只开一份**：本单不碰 HALT、不碰 HP-1/2/4 的文件。

---

## §8 需要登记的偏差

实施时若出现以下情况，必须在回执里登记，不得静默改口径：

- 如果 `web` profile 没有 `safety:sentry`，管理路由只能 503；需要明确该 profile 是否算“可运维”。
- 如果 `SENTRY_SERVICE.unfreeze` 的现有签名与本文不一致，以代码为准并登记。
- 如果 `BAH_ADMIN_TOKEN` 在本机已经被其他服务使用，复用它还是新开变量，需在回执说明。
- 如果快照重录产生非预期 diff，先停下查原因，不得直接接受新基线。

---

## §9 汇报格式

完成后按五项汇报：

1. 完成出口条目号（HP0-01～15）。
2. 测试结果表（ID 级，含失败/跳过）。
3. 快照 diff 摘要与门禁结果（本单相关项 / 全量基线）。
4. 未决偏差与风险（尤其 headless 限制、token 本机信任边界）。
5. 下一步前置确认（是否进入 HP-1）。

---

## §10 禁止事项

- 禁止把 `SENTRY_SERVICE.id` 加进 `webPlugin.plugin.inject` 导致无 sentry 的 profile 起不来。
- 禁止在 URL query 里传 token。
- 禁止用 `--token` 命令行参数。
- 禁止把管理路由绑到 `0.0.0.0` 还只靠 token；回环检查必须保留。
- 禁止在 `sentry/verifier-failed` 里记录工具参数、账户号、金额、用户原话。
- 禁止用“监听器坏了继续 accept”作为降级理由；这是本单要修的反模式。
- 禁止把本单扩成 HALT/审批解除；HP-3 再做（**已于 2026-10-25 由 W07 施工**）。
