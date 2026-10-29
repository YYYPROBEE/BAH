# 02 · 租户与鉴权 01–04 合入集成分支（2026-10-29）

> 施工单 02 · T-02。基线：`tenant-04-delivery = 44f552e`（含 05 回归审查提交）。
> 命令：`git merge --no-ff --no-commit tenant-04-delivery`（在 `integration/handoff-tenant`，HEAD 为 01 的 merge commit `bdb0f99`）。

## 1 冲突清单（17 个，逐条处理）

| # | 文件 | 处理 |
|---:|---|---|
| 1 | `apps/web/src/transport.js` | 并集：401 探测 + 观测接口 + handoff 帧订阅 |
| 2 | `apps/web/src/transport.test.js` | 并集：两套用例都保留 |
| 3 | `packages/host/src/boot/plugins/audit-decisions.ts` | 取 tenant（租户入链 + `appendActor`），并把 `verifyAll` 租户对账的 `warn` 恢复成结构化日志（否则截断告警静默） |
| 4 | `packages/host/src/boot/plugins/persistence.ts` | 取 tenant（租户根 + `baseRoot`），保留 main 的观测改动 |
| 5 | `packages/host/src/boot/plugins/web.test.ts` | 并集：`SESSION_FILES` + `ADMIN_OPERATORS_ENV` 两个 import；resume 断言改为"操作者来自主体（`svc:operator`）+ 显示名 `BAH_OPERATOR_NAME`" |
| 6 | `packages/host/src/boot/plugins/web/config.ts` | 并集：`entry` / `entries` / `handoff.slaMs` + `auth` 块 |
| 7 | `web/contract.test.ts` | 从最终 `ROUTES` 重建：**26 条**，CSRF 列表 12 条 |
| 8 | `web/deps.ts` | 并集：`tenantId` / `auth` / `tryAudit` + main 的 `tryTelemetry` / `trySlo` / `entry` / `entries` |
| 9 | `web/dispatch.test.ts` | 并集：`tryAudit` + `TelemetryHandle`；注释按新口径 |
| 10 | `web/dispatch.ts` | 以 tenant 的 auth 流水线为主，补 `seatEnabled` 404（在身份解析之前）与反派生的 `startHttpSpan` |
| 11 | `web/handlers/handoff.ts` | 只接受 `reason` / `handover`；操作者从 `request.identity` 派生 |
| 12 | `web/handlers/static.ts` | 新入口规则：token 入口（password 去 token 注入 mode）/ 坐席入口（零注入） / 普通资源；入口页统一 `no-store` |
| 13 | `web/handoff.ts` | 状态机字段扩到 `requestedBy` / `operatorId` / `operatorLabel`；`resume(operatorId, handover?, operatorLabel?)` |
| 14 | `web/router.ts` | 以 tenant 的 `RouteSpec + roles` 为主，保留 main 的 `trace` / `fork` 与 5 条接管路由：**26 条** |
| 15 | `web/routes-markdown.ts` | 取 tenant（按 `roles` 渲染鉴权列） |
| 16 | `packages/util/src/index.ts` | 并集：`tenant` / `principal` 与 main 的新工具 |
| 17 | `scripts/verify-docs-consistency.ts` | 取 tenant（19 份扫描面），保留 main 的失效口径规则 |

另外：`snapshots/*/reverified.json`（6 个）与 `scripts/assertion-baseline.json` 不手合——先取 main，再由 `snapshot:reverify`（写入 7 个、未变 1 个）与 `verify-assertions --update`（306 文件 / 9549 条）重算。

## 2 auto-merged 但需要人看的文件（逐个核过）

| 文件 | 核对方式 | 结果 |
|---|---|---|
| `profiles/web/patch.yml` | `pnpm test` 的 profile 载入用例 + `handoff:demo` | `handoff.slaMs` / `auth` / `memory.dbPath` 三项都在 |
| `profiles/mobile/patch.yml` | `verify-channel-capabilities` I8 | 记忆配置改为租户根单段文件名（与 web 一致） |
| `package.json` | `handoff:demo` 存在且可跑 | 闭环通过 |
| `apps/web/src/main.js` / `store.js` / `styles/app.css` | `pnpm test:web` 27 文件 / 365 例 | 全绿 |
| `apps/web/src/transport.js` | 同上（401 探测 / 观测接口用例） | 全绿 |
| `web/handlers/session.ts` | `web.test.ts` "接管期 turn 202 落账不驱动" | 绿 |
| `web/handlers/metrics.ts` | 指标 36 个 + `tenant` 字段用例 | 绿 |
| `docs/evidence/2026-10-28-tenant-auth/*` | 文件在、索引 `00-index.md` 指向 05 | 在 |

## 3 可编译检查

- `pnpm typecheck` 0 错；`pnpm lint` 0 错；`pnpm build` 0 错。
- `web.ts` 保持"声明 + 调工厂"（60 行），装配全部在 `web/channel.ts`，没有回到 200+ 行。
