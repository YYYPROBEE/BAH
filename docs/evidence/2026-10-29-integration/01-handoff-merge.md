# 01 · 人机升级（接管 01+02）合流证据

> 施工单：[BAH-施工单-01-人机升级合流-2026-10-29.md](../../../BAH-施工单-01-人机升级合流-2026-10-29.md)
> 日期：2026-10-29
> 分支：`integration/handoff-tenant`
> 状态：**完成**；`main` 未动、未推送

## 1. 基线与备份

| 项 | 值 |
|---|---|
| `main` | `11f0eb3b56a6b90eb5a0f2ce6142d9415671c4b0`（工作树 clean） |
| 备份 tag | `pre-merge-2026-10-29` → `11f0eb3` |
| 备份 bundle | `../bah-pre-merge-2026-10-29.bundle`（5,608,777 字节，`--all`） |
| `origin/main`（缓存） | `ad9dc539ae8d3e9391ec3bdb8c1579892b7d5bbd` |
| 被合并分支 | `handoff-02-workbench` = `965900658827f5206485459c0029de95c4c140b9`（含 01 `7806e51`） |
| merge base | `bbb7a803d0a76d910bcb5b98a200c91f6c801048` |
| 合并方式 | `git merge --no-ff --no-commit handoff-02-workbench` |

## 2. 冲突面（22 个，与施工单预期一致）

原始清单：[conflict-files.txt](conflict-files.txt)。

| # | 文件 | 处理 |
|---:|---|---|
| 1 | `packages/host/src/boot/plugins/web.ts` | **整文件取 main**（60 行）；handoff 增量搬进 `web/channel.ts` |
| 2 | `web/config.ts` | 并集：`entry`/`entries` + `handoff.slaMs`，键白名单 9 项 |
| 3 | `web/deps.ts` | 并集：`defaultEntry`/`tokenEntries` + `operatorToken`/`operatorName`/`operatorEntry`/`seatEnabled`；保留 `tryTelemetry`/`trySlo` |
| 4 | `web/dispatch.ts` | 并集：`startHttpSpan` + `presentedPrincipal`；HANDLERS 同时含 `fork` 与 4 条 handoff |
| 5 | `web/router.ts` | `RouteHandler` 并集（`fork` + 4 条 handoff） |
| 6 | `web/contract.test.ts` | 23 条指纹；turn/interrupt/approval/verify 为 `user` |
| 7 | `web/dispatch.test.ts` | deps 夹具补 `operatorEntry`/`seatEnabled` |
| 8 | `web/handlers/static.test.ts` | add/add：保留 main 的白名单用例 + 补 4 条坐席入口用例 |
| 9 | `apps/web/src/main.js` | 两个 import 并集（`createObservability` + `formatWaited`） |
| 10 | `apps/web/src/views/conversation.test.js` | add/add：两套 describe 拼接（对话流 + 坐席/交接） |
| 11 | `packages/channels/src/web/frames.ts` | 并集：choice/goal/todo/effects + handoff/handoff-warn |
| 12 | `packages/channels/src/web/project.test.ts` | 并集：projectTodo/projectEffects 用例 + handoff 投影用例 |
| 13 | `scripts/verify-web.ts` | 按 H-08 重写（逐入口样式 + 未登记入口判红） |
| 14 | `scripts/assertion-baseline.json` | 取 main 版后按新用例重算（`--update`，只增不减） |
| 15 | `PROGRESS.md` | main 版 + 本小节（§96.39） |
| 16 | `README.md` / `docs/deploy.md` / `docs/facts-sources.md` / `docs/security-self-assessment.md` / `docs/testing.md` / `docs/web-frontend.md` / `facts.md` | 取 main 版；只有 `docs/web-frontend.md` §7 路由表按生成器重写 |

## 3. 代码面改动（超出"纯合并"的部分）

1. **`web/channel.ts`（H-05）**：`readOperatorConfig` → `operatorToken`/`operatorName`；`createHandoff` 传 `files: tryService(ctx, SESSION_FILES)` 与 `slaMs`；`operatorEntry`、`seatEnabled = channelId==='web' && token!==undefined`。
2. **`handoff-store.ts`（H-06）**：构造参数从 `root`+`sessionId` 改为 `file`；`handoffStateFileOf` 保留**只给单测**并注明"root 已是租户根"。
3. **`handoff.ts`（H-06）**：`store.file = join(dirname(files.fileOf(session.sessionId)), 'handoff.json')`——不再自己拼 `root/sessionId`。
4. **`handlers/static.ts`（H-07）**：坐席判定改用 `deps.seatEnabled`；`operator.html` 是 token 注入的**第二层硬排除**（即便误配进 `entries` 也不注入）。
5. **`scripts/verify-web.ts`（H-08）**：`REQUIRED_STYLES` 按入口声明（index/operator → app.css；m → mobile.css）；未登记 `.html` 判红；保留 .icon--name 与图标文件检查。
6. **`scripts/demo-handoff.ts`（H-09）**：`session.jsonl` 路径改由 `app.ctx.get(SESSION_FILES).fileOf(...)` 推导。
7. **`handlers/metrics-handoff.ts`（新文件）**：把接管指标派生从 `metrics.ts` 拆出，`metrics.ts` 221 → 187 行，满足"handler < 200 行"结构预算。
8. **测试夹具**：`mobile.test.ts` / `channel.test.ts` 补 `provide(SESSION_FILES, ...)`（真 profile 里 `core:persistence` 必装）；`metrics.test.ts` 补 `handoff` 桩。
9. **`docs/web-frontend.md` §7**：用 `npx tsx scripts/web-routes.ts` 重生成（23 条）。

## 4. 验证（原始日志同目录）

| 检查 | 结果 | 日志 |
|---|---|---|
| `pnpm typecheck` | EXIT 0 | — |
| `pnpm lint` | EXIT 0 | — |
| `pnpm test` | **266 文件 / 3100 例全绿** | [test-3100.log](test-3100.log) |
| `pnpm test:web` | **27 文件 / 361 例全绿** | [test-web-361.log](test-web-361.log) |
| `pnpm gate` | **47/47 全绿** | [gate-47.log](gate-47.log) |
| `pnpm handoff:demo` | **闭环断言全部通过** | [handoff-demo.log](handoff-demo.log) |
| `verify-web` 自检 | **5/5**（基线绿；m 缺 mobile.css 红；operator 缺 app.css 红；未登记入口红；复原回绿） | [verify-web-selfcheck.log](verify-web-selfcheck.log) |
| `handoff.json` 接线探针 | **7/7**（构造不落盘；enter 后出现在 `fileOf` 同目录；resume 后清除） | [handoff-store-wiring.log](handoff-store-wiring.log) |

**提交时门禁状态（如实）**：`gate-47.log` 是 18:19 的 47/47。此后 18:20:11 / 18:20:28，工作树出现两份
**非本单产出**的未跟踪测试（`handlers/handoff-message.test.ts`、`handlers/metrics-handoff.test.ts`，
本轮未创建、内容与当前代码一致、19 例全过）。它们使 `tracked-sources`（未跟踪源码）与 `assertions`
（+29 条未登记）在**当前工作树**判红。按用户 2026-10-29 决定：**不替其作者提交**，本次提交用
`git commit --no-verify` 跳过 pre-commit。

这不污染提交树：提交里不含这两个文件，断言基线 280 文件 / 9033 条与已入库测试逐一对齐
（`assertions` 在干净 clone 上为绿）；`tracked-sources` 在干净 clone 上无未跟踪源码，同样为绿。
两份文件仍以未跟踪状态留在工作树，等其作者自行入库并 `--update` 断言基线。

`handoff:demo` 事件序列：`handoff/requested → operator-message ×3 → handoff/resumed`；
首轮审批 `approval/asked` 在接管之前；等待期两条客户消息返回 `202 queued-for-operator`；
模型历史含交接语、不含坐席三句话。

## 5. 施工单判据对照（DoD）

| # | 判据 | 结果 |
|---:|---|---|
| 1 | `main` 未改动；集成分支含 merge | ✅ `main` 仍 `11f0eb3` |
| 2 | `web.ts` 仍 60 行，`channel.ts` 承担装配 | ✅ `60` / `216` |
| 3 | 路由 23 条 | ✅ `contract.test.ts` + `docs/web-frontend.md` §7 |
| 4 | 22 个冲突逐条处理 | ✅ 本文 §2 |
| 5 | `verify-web` 按入口判样式 | ✅ 5/5 自检 |
| 6 | 非测试代码无 `join(root, sessionId)` | ✅ 仅 `handoffStateFileOf`（单测用，已注明） |
| 7 | `handoff:demo` 闭环 | ✅ |
| 8 | typecheck/lint/test/test:web/gate 全绿 | ✅ |
| 9 | 工作树 clean（提交后） | ✅ |
| 10 | 证据入库 | ✅ 本目录 |

## 6. 边界与未解问题（交接给施工单 02）

1. **鉴权仍是临时的 `user`/`operator` 模型**：路由表里 `auth: 'user' | 'operator'`，不是 tenant 的 `Principal`/roles。客户 token 打坐席 API 是 **401**（不是 403）——施工单 02 统一身份后改判。
2. **password 模式未涉及**：本单只保证 static 模式下 `/operator` 零注入；password 模式的多入口注入规则在施工单 02 §7.4.1。
3. **`seatEnabled` 只对 web 渠道为真**：移动渠道即便配了 `BAH_OPERATOR_TOKEN` 也不开 `/operator`。
4. **移动渠道也开始要求 `core:persistence`**：`createHandoff` 缺 `SESSION_FILES` 即抛 `handoff-store-unavailable`（不静默退化内存态）。真 profile 已装，测试夹具已补。
5. **`facts.md` / `docs/facts-sources.md` 未动**：测试数已从 3047 → 3100、门禁仍 47，统一重算留给施工单 02（`verify-docs-consistency` 当前绿）。
6. **未做真实浏览器截图**：本单的门禁自检与 HTTP 测试覆盖了 `/operator` 200/404 与零注入，但施工单 02 的 6 张人工截图仍未做。
7. **未推送、未移动 tag**：`main` 与 `v1.0-submit` 均未动。
8. **工作树里有两份非本单文件**：`handlers/handoff-message.test.ts`、`handlers/metrics-handoff.test.ts`（18:20 出现，未跟踪，19 例全过）。本单未提交它们；作者入库后需跑一次 `npx tsx scripts/verify-assertions.ts --update` 登记其 29 条断言，否则 `assertions` 会红。
