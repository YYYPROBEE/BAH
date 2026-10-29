# 结构化日志 code 表（可观测性 02）

> 本表是 `logJson(level, code, fields)` 的 **code 闭集**：代码里出现的字面量 code 必须在这里有一行，
> 由 `scripts/verify-observability.ts` 逐条比对（新 code 不登记 = 门禁红）。
>
> 纪律：`code` 是**事件名**（`域.事件`，kebab-case），不是错误原文；字段只放标量上下文，
> `key|apiKey|token|secret|password|authorization|cookie` 一律整条丢弃。

| code | 级别 | 出处 | 含义 |
|---|---|---|---|
| `core.rollback-listener-failed` | error | `packages/core/src/context.ts` | 回滚失败上报的监听器自己抛错 |
| `core.rollback-report-failed` | error | `packages/core/src/context.ts` | 连「上报回滚失败」都失败 |
| `runtime.session-listener-failed` | error | `packages/runtime/src/session/service.ts` | `session/event` 监听器被隔离后留痕 |
| `runtime.callback-audit-failed` | error | `packages/runtime/src/tools/pipeline.ts` | `tool/callback-failed` 审计落账也失败 |
| `runtime.result-broadcast-failed` | error | `packages/runtime/src/agent-loop/agent.ts` | `tools/result` 广播失败且补审计失败 |
| `bank.tier-persist-failed` | warn | `packages/bank/src/tools/governance.ts` | `tier/decided` 写入失败（判决不变） |
| `persistence.jsonl-tail-dropped` | warn | `packages/persistence/src/jsonl/backend.ts` | 会话 JSONL 尾行半写被丢弃 |
| `persistence.chain-tail-dropped` | warn | `packages/persistence/src/chain/chain-file.ts` | 审计链尾行半写被丢弃 |
| `host.persistence-warn` | warn | `packages/host/src/boot/plugins/persistence.ts` | 持久化后端的兜底告警 |
| `host.audit-key-missing` | warn | `packages/host/src/boot/plugins/audit-decisions.ts` | 缺少签名私钥，会话链以 unsigned 运行 |
| `host.audit-write-failed` | warn | `packages/host/src/boot/plugins/audit-decisions.ts` | 审计链写入失败（判决不变） |
| `host.policy-event-persist-failed` | warn | `packages/host/src/boot/plugins/policy.ts` | 策略领域事件写不进会话日志 |
| `host.policy-shadow-eval-failed` | warn | `packages/host/src/boot/plugins/policy.ts` | 影子策略求值失败（不影响生效判决） |
| `host.saga-tick-failed` | error | `packages/host/src/boot/plugins/saga-bridge.ts` | saga tick 定时器抛错 |
| `host.saga-recovery-audit-failed` | error | `packages/host/src/boot/plugins/saga.ts` | 启动恢复失败连审计都写不进去 |
| `saga-alert` | warn / error | `packages/host/src/boot/plugins/saga.ts` | saga 告警汇的 stderr 出口（P0 → error） |
| `bank.saga-store-tenant-unmarked` | warn | `packages/host/src/boot/plugins/saga-store.ts` | 已存在 sqlite 但缺创建者标记，无法判断租户 |
| `bank.saga-store-tenant-mismatch` | warn | `packages/host/src/boot/plugins/saga-store.ts` | sqlite 由别的租户创建（共用会把两租户事务混一起） |
| `bank.saga-store-tenant-race` | warn | `packages/host/src/boot/plugins/saga-store.ts` | 并发启动时标记被另一租户先写入 |
| `web.admin-config-invalid` | error | `packages/host/src/boot/plugins/web/admin-guard.ts` | 管理面操作员配置坏，fail-closed 503 |
| `web.auth-directory-warn` | warn | `packages/host/src/boot/plugins/web/auth/directory.ts` | 口令目录加载的兜底告警（未注入 warn 出口时） |
| `web.auth-session-store-warn` | warn | `packages/host/src/boot/plugins/web/auth/session-store.ts` | 认证会话存储的兜底告警（未注入 warn 出口时） |
| `web.auth-password-hash-invalid` | warn | `packages/host/src/boot/plugins/web/auth/password.ts` | 口令编码串非法，该账户无法登录 |
| `web.auth-audit-write-failed` | warn | `packages/host/src/boot/plugins/web/auth/identity.ts` | 认证审计写入失败（不影响登录结果） |
| `web.approval-actor-write-failed` | warn | `packages/host/src/boot/plugins/web/handlers/approval.ts` | `approval/actor` 写链失败（审批照常处理） |
| `web.channel-warn` | warn | `packages/host/src/boot/plugins/web/channel.ts` | 渠道装配的兜底告警（未注入 `RunContext.warn` 时） |
| `saga-alert-file-failed` | warn | `packages/host/src/boot/plugins/saga.ts` | 可选告警文件出口写失败 |
| `saga-recovery-failed` | error | `packages/host/src/boot/plugins/saga.ts` | 启动恢复失败 |
| `model-retry` | warn | `packages/host/src/boot/plugins/model.ts` | 上游 429 / 5xx 退避重试 |
| `policy.loaded` | info | `packages/host/src/boot/plugins/policy.ts` | 策略 bundle 载入 |
| `policy.reloadRejected` | warn | `packages/host/src/boot/plugins/policy.ts` | 热重载被拒绝，旧版本继续服务 |
| `policy.switched` | info | `packages/host/src/boot/plugins/policy.ts` | 灰度/切换后的生效版本变化 |
| `context/slots-degraded` | warn | `packages/host/src/boot/runtime-context.ts` | 实体槽位读取降级 |
| `telemetry.span-log-unavailable` | warn | `packages/host/src/boot/plugins/telemetry.ts` | `span.jsonl` 目录建不出来 |
| `telemetry.span-log-enabled` | info | `packages/host/src/boot/plugins/telemetry.ts` | `span.jsonl` 已启用及实际路径 |
| `telemetry.span-log-relative` | warn | `packages/host/src/boot/plugins/telemetry.ts` | 相对路径的实际落点 |
| `telemetry.env-invalid` | warn | `packages/host/src/boot/plugins/telemetry.ts` | 遥测环境变量非法被忽略 |
| `logging.env-invalid` | warn | `packages/util/src/logging.ts` | 日志级别环境变量非法，回落 info |
| `im-gateway-start` | info | `apps/im-gateway/src/main.ts` | 网关开始监听（只打端口与平台数量） |
| `im-platform-unknown` | warn | `apps/im-gateway/src/server.ts` | 未知 platform/account（404） |
| `im-sig-invalid` | warn | `apps/im-gateway/src/server.ts` | 微信验签失败（只给细分 code，不含期望值） |
| `im-xml-rejected` | warn | `apps/im-gateway/src/server.ts` | DTD/超长/缺字段等报文拒绝 |
| `im-duplicate` | info | `apps/im-gateway/src/bridge/turn.ts` | platform+msgId 去重命中 |
| `im-child-start` | info | `apps/im-gateway/src/session/supervisor.ts` | spawn 子进程（只打 sessionKey/pid/port） |
| `im-child-ready` | info | `apps/im-gateway/src/session/supervisor.ts` | health 200 + CSRF 握手成功 |
| `im-child-exit` | warn | `apps/im-gateway/src/session/supervisor.ts` | 非预期退出 / 重启耗尽 |
| `im-child-reap` | info | `apps/im-gateway/src/session/supervisor.ts` | 闲置回收 / 主动停止 |
| `im-turn-failed` | warn | `apps/im-gateway/src/bridge/turn.ts` | `/api/turn` 非 202（含 `inbox-full` / `auth` / `halted`） |
| `im-push-fallback` | warn | `apps/im-gateway/src/bridge/outbound.ts` | 适配器 push 不可用 → 拉取式 |
| `im-push-failed` | warn | `apps/im-gateway/src/platform/wechat/transport.ts` | 客服消息失败（含 errcode，只在日志） |
| `im-ratelimited` | info | `apps/im-gateway/src/bridge/turn.ts` | 用户/全局限流命中 |
| `im-untrusted` | info | `apps/im-gateway/src/bridge/turn.ts` | untrusted 命中（reason=user/marker） |
| `im-config-invalid` | error | `apps/im-gateway/src/config.ts` | 配置非法导致启动失败 |

> 动态 code：`packages/host/src/boot/plugins/bank-tools.ts` 的 `warnContextSlots(code, …)`
> 会把 bank 适配器给的 `bank.slots-*` 族直接透传；这些值来自闭集枚举，不是自由文本。
> 门禁只校验**字面量** code；动态 code 由适配器自己的测试守值域。
