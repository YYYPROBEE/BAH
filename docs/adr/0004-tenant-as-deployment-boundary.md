# ADR-0004 · 租户 = 部署边界（进程内多租户不做）

- 状态：**已采纳**（2026-10-28）
- 决策者：架构组
- 关联：`docs/contracts/tenant-model.md`

---

## 1 背景

评测意见是"仍单租户"。取证后发现**代码里确实有 `tenant` 这个字段，但它只活在一个包的一层里**：

| 证据 | 位置 |
|---|---|
| `tenant` 只出现在记忆库的 4 个类型字段 + SQL 列，别处没有 | `packages/memory-store/src/types.ts`、`store/migrations/v0_init.ts` |
| 模块注释自己写着"单租户：tenant 是配置项，默认 demo" | `packages/host/src/boot/plugins/memory.ts` |
| 落盘路径没有租户段：`sessions/<sessionId>/…` | `packages/host/src/boot/plugins/persistence.ts` |
| 审计链扫描口径写死一层，链也不带租户 | `packages/host/src/boot/plugins/audit-decisions.ts` |
| 指标返回体没有租户；知识库是**一个** `BAH_KNOWLEDGE_TOKEN` | `web/handlers/metrics.ts`、`knowledge.ts` |
| 数据集只吃 `seed`：同 seed 两个租户逐字段相同 | `packages/bank/src/forge/index.ts` |

于是要决定：**"多租户"到底该做成什么形态**。

---

## 2 决策

> **租户 = 部署边界。一个进程只服务一个租户。**
>
> 多租户 = 同一套代码、同一台机器上并存 N 个这样的进程，
> 靠"目录 / 端口 / 令牌 / 密钥"四道**物理**隔离分开。

判据只有一句：**能不能用一条命令把这个租户的全部持久痕迹列出来**。
本决策下答案是 `ls <config.root>/<tenant>`。

---

## 3 为什么不选"进程内多租户"

直觉方案是"一个进程跑 N 个租户，按请求头分派"。**本仓的内核做不到**，证据可查：

| 事实 | 位置 |
|---|---|
| `Context.isolate()` 的原文注释："收敛版 isolate——**只做键屏蔽，不做多 realm 隔离**" | `packages/core/src/api.ts` |
| `isolate()` 的实现只是 `ServiceKey` 屏蔽代理 | `packages/core/src/context.ts` |
| 断言钉死了"隔离后事件总线**是同一个**"：`expect(isolated.events).toBe(app.events)` | `packages/core/src/scope.test.ts` |
| `runtime:session` 是**单例服务**，构造时绑定一个 `sessionId` | `packages/runtime/src/session/service.ts` |
| 渠道取 agent 用 `agents.list()[0]` | `packages/host/src/boot/plugins/web.ts` |
| HALT / sentry 风险累加是**进程级** | `packages/safety/src/sentry/` |

⇒ 进程内两个租户会**互相收到对方的 `session/event`**。要做对必须给内核加事件作用域，
那是改 `packages/core/src/api.ts` 的契约面（`00-全局约定.md` 的 G1/R1），会连锁 5 个包的编译面，
且不在本方案范围。

**这是本方案最重要的一次判断**：不是"省事"，是"在不动内核契约的前提下，
唯一能**证明**隔离的形态"。

---

## 4 被否掉的替代方案

| 方案 | 为什么否 |
|---|---|
| 进程内多租户（按请求头/查询参数分派） | 内核无事件作用域（§3 六条证据）。硬做得到的系统"看起来隔离、实际互相收事件"，而且**没有任何一条门禁能证明它错了** |
| 一库多租户（一个 sqlite 里所有租户的行，靠 `WHERE tenant = ?`） | 只隔离了**行**：文件、进程、HALT、票据、令牌、指标仍然共享；一处 SQL 漏写 tenant 就是全量泄漏，而"漏写"不会报错（这正是 `verify-tenant-scope` 判据 1 存在的原因） |
| 只加 `tenant` 列（最小改动） | 同上，且拿不到"把这个租户的全部痕迹一次搬走/销毁"的能力（数据驻留、销户、迁移是租户隔离最实际的诉求） |
| 一个进程多租户 + 每租户一个子上下文（`isolate`） | `isolate` 只屏蔽服务键，事件总线与单例服务不变（§3 前三条） |

---

## 5 后果（如实登记）

**代价**

1. N 个租户 = N 个进程：内存、端口、启动时间都按租户数线性增长；
2. 运维面变成"多实例"：端口分配、健康检查、密钥分发都要按实例做（本方案只做了**目录/令牌**两道自动隔离，端口是部署面）；
3. `saga.sqlite` **没有**按租户分库（见 §6），它是这条边界上唯一一处"共享"。

**收益**

1. 隔离**可证明**：`ls sessions/<tenant>/` 就是全部痕迹；跨租户在**认证层**就断了（不是靠资源层 404）；
2. 不动内核契约：没有第二真相源，`verify-tenant-scope` 能机械检查"有没有哪处忘了带租户"；
3. 与银行核心系统的常规形态一致（一家法人一套部署）。

---

## 6 本决策的边界（不声称）

| 不声称 | 实际是什么 |
|---|---|
| 一进程多租户 | 不支持。一个进程一个租户（本 ADR 的全部内容） |
| 租户级配额 / 限流 | 不做：单进程只有本租户，配额没有对照物（网关层的事） |
| 租户级加密密钥（KMS） | 不做：无外部依赖可用；演示档无真实 PII |
| `saga.sqlite` 按租户分库 | **不做**：单库单进程 + `verify-saga-wiring` 以固定路径为基线；要改与 saga 单合并立项 |
| 知识库 sidecar 侧的租户校验 | 只做宿主侧按租户取令牌；sidecar（`services/rag`）是独立部署面 |
| 跨实例指标汇聚 | 不做：本进程只报本租户（`/api/metrics` 的 `tenant` 字段） |

---

## 7 复核方式

```bash
# ① 内核确实没有事件作用域（本 ADR 的立论基础）
grep -n "只做键屏蔽" packages/core/src/api.ts
grep -n "expect(isolated.events).toBe(app.events)" packages/core/src/scope.test.ts

# ② 端到端：两个租户 → 两个目录、两套库
npx tsx packages/cli/src/main.ts run --profile web --serve --tenant demo
npx tsx packages/cli/src/main.ts run --profile web --serve --tenant acme   # 另一个端口/终端
ls sessions/demo sessions/acme

# ③ 审计按租户（跨租户的链不会被混进来）
npx tsx packages/cli/src/main.ts audit --dir sessions --tenant demo --no-signature

# ④ 门禁：没有哪个平面漏了租户
npx tsx scripts/verify-tenant-scope.ts --self-test
```
