# 契约：租户模型（tenant-model）v1.0.0

> 本文件是**租户这一维度**的契约。与 `event-table.md` / `tool-contract.md` / `scenario-dsl.md`
> 同级：入库、参与 `verify-docs-consistency`，改动要走本文 §8 的流程。
>
> 权威序（`00-全局约定.md` §0）：代码现状 > `PROGRESS.md` > 本契约 > 施工单。
> 也就是说：**本契约与代码不一致时，以代码为准，然后回来改本契约**。
>
> 生效：2026-10-28（租户与鉴权施工单 01 落地）。当时点事实：见
> `docs/evidence/2026-10-28-tenant-auth/01-t1.md`。

---

## 1 一句话模型

> **租户 = 部署边界。一个进程只服务一个租户。**
>
> 多租户 = 同一套代码、同一台机器上并存 N 个这样的进程，
> 靠"**目录 / 端口 / 令牌 / 密钥**"四道物理隔离分开。

进程内多租户**不做**，理由与替代方案见 `docs/adr/0004-tenant-as-deployment-boundary.md`。
这一条不是实现细节，是判定"隔离成立"的前提：任何"一个进程里按请求头分租户"的方案
在本仓的内核上都不成立（`Context.isolate()` 只做键屏蔽、`runtime:session` 是单例、
事件总线是全进程的），硬做会得到一个**看起来隔离、实际互相收事件**的系统。

---

## 2 标识（`TenantId`）

### 2.1 形状

```ts
export type TenantId = Branded<'tenant-id'>          // @bah/util · tenant.ts
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}[a-z0-9]$/
export function parseTenantId(raw: string): TenantId // 非法 → BahError('tenant-id-invalid')
export function asTenantId(raw: string): TenantId    // 无校验断言（只用于编译期常量）
export function isTenantId(raw: string): boolean
export function tenantEnvSuffix(tenantId: TenantId): string
export const DEFAULT_TENANT_ID: TenantId             // 'demo'
```

**长度 2–31，只允许 `[a-z0-9-]`，首尾必须是字母数字。**

### 2.2 为什么是这个字符集（每条都有下游事故）

| 用途 | 要求 | 违反后的真实事故 |
|---|---|---|
| 目录段 | 不含 `/`、`\`、`..` | `../etc` 把会话写到部署根之外 |
| sqlite 库文件名 | 不含 `:`、`/` | Windows 上冒号非法；斜杠变成子目录 |
| 指标标签 | 不含空格 / 引号 | 指标端点与日志字段被破坏 |
| 环境变量后缀 | 只 `[A-Z0-9_]` | `acme-bank` → `BAH_KNOWLEDGE_TOKEN_ACME_BANK` |
| 日志可读 | 强制小写 | `Demo` 与 `demo` 落进两个目录，环境变量后缀却撞车 |

**不复用 `assertSafePathSegment`**：它允许大写与下划线。`demo_bank` 与 `demo-bank`
会得到**同一个**环境变量后缀，而 `Demo`/`demo` 会在两个目录里各有一份数据——
两者都是"看起来对、审计时对不上"的事故。

**`asTenantId` 的边界**：它是无校验断言，只允许两种用法——值来自 `parseTenantId`，
或来自编译期常量（`DEFAULT_TENANT_ID`）。运行期输入（argv / 环境变量 / 配置）一律
走 `parseTenantId`。下游还有两道兜底：`tenantRootOf` 过 `assertSafePathSegment`，
`normalizePrincipal` 再过 `isTenantId`。

---

## 3 主体与角色

```ts
export type Role = 'customer' | 'agent' | 'auditor' | 'admin'
export const ROLES: readonly Role[] = ['customer', 'agent', 'auditor', 'admin']  // 固定序
export type IdentitySource = 'demo-config' | 'mock-login' | 'im-map' | 'session-auth'
export interface Principal {
  readonly tenantId: TenantId
  readonly userId: string
  readonly roles: readonly Role[]   // 非空、去重、按 ROLES 序
  readonly source: IdentitySource
}
export function normalizePrincipal(input: PrincipalInput): Principal
```

**三条不变量（由测试钉，不由注释钉）**：

1. `roles.length >= 1`——空集是**构造错误**，不是"无权限"（`principal-roles-empty`）；
2. 去重 + 按 `ROLES` 固定序 ⇒ 两个逻辑相同的主体序列化出**同一串字节**（审计链要对它算哈希）；
3. 返回**新对象且冻结**（`Object.freeze`）——调用方 `push` 一下，链上的主体哈希就漂了。

**`SessionIdentity.tenantId` 的判定点**（复审 AR-07 / 03 TA-47）：01 只负责把它记录正确；
真正的跨租户判定在**业务工具闸** `evaluateCall()`（`packages/bank/src/tools/governance.ts`）：
会话身份租户与当前进程租户不一致 → `wrong-tenant`，**早于** `no-identity`。
HTTP 路由级 `authorize()` 只判"身份有无 + 角色"，不判租户——跨租户请求在认证层
（别的租户的 cookie 查不到）就已经 401。**不要**把它讲成"authorize() 在判租户"。

**角色不是业务权限**：角色是**渠道**身份（谁在操作），业务权限仍是绿/黄/红三级分级。
两个平面正交，混起来就无法解释"同一笔转账换个角色级别为什么变红"。

**合成服务主体**（合流 2026-10-29）——**两把凭证、两个主体、互斥角色**：

| 模式 | 凭证 | 主体 | 角色 |
|---|---|---|---|
| `none` | 无 | `svc:web` | `['customer']`（不含 agent：否则无凭证请求能打坐席 API） |
| `static` | `BAH_WEB_TOKEN` | `svc:web` | `['customer']` |
| `static` | `BAH_OPERATOR_TOKEN` | `svc:operator` | `['agent']` |

两个 `static` 主体**都不含 `admin`**——管理面（`/api/admin/*`）仍要独立的 `BAH_ADMIN_TOKEN`
+ 回环来源，那是双因子；把 `admin` 塞进服务主体等于让一个 Web 口令就能管理停机开关。
代码在 `packages/host/src/boot/plugins/web/auth/{identity,static}.ts`
（`NONE_PRINCIPAL_ROLES` / `createStaticIdentifier`）。

---

## 4 隔离边界（谁能看见谁）

| 资源 | 归属 | 跨租户可见 | 落地证据 |
|---|---|---|---|
| 会话事件（`session.jsonl`） | 租户 | 否 | 目录不可达（`<root>/<tenant>/<session>/`） |
| 审计链（`audit.jsonl`） | 租户 | 否 | 链在租户根下一层 + 链行 `tenant` 字段 |
| 记忆单元（`memory_unit`） | 租户 × 用户 | 否 | 库文件在租户根 + SQL 全路径带 tenant |
| 仿真账本（进程内存） | 租户（进程） | 否 | 进程边界；数据集盐只影响 `stress`/`adversarial` 档 |
| 知识条目 | 租户 | 否 | 宿主按租户取令牌（`<BASE_ENV>_<TENANT>`） |
| 指标（`/api/metrics`） | 租户 | 否 | 返回体第一层 `tenant`；只算本进程事件 |
| 票据（ticket） | 租户 × 会话 | 否 | 适配器绑定 `sessionId`；跨租户根本到不了资源层（认证层先 401） |
| HALT 停机状态 | 租户 | 否 | `<root>/<tenant>/halt.json`（共享一份 = 跨租户 DoS） |
| 令牌 / Cookie | 租户 × 用户 | 否 | 进程边界 + 会话级凭证 |

**"跨租户一律 404，不 403"**（T3 落地）：403 等于确认"这个对象存在，只是你没权限"。
银行场景下"存在性"本身就是信息（某客户号是否在本行）。本单只把这条写进契约；
实现层当前的等价防线是**认证层 401**（别的租户的 cookie 在本地会话存储里查不到），
比 404 更强：连"有没有这张票"都不知道。

---

## 5 六个注入点（每个平面**唯一**）

| 平面 | 唯一注入点 | 代码位置 | 说明 |
|---|---|---|---|
| 会话目录 | `RunContext.tenantId` → `SessionFiles.root` | `packages/host/src/boot/plugins/persistence.ts` | `root = <config.root>/<tenant>`；`fileOf` 的首段是租户 |
| 记忆库 | `RunContext.tenantId` | `packages/host/src/boot/plugins/memory.ts` | `dbPath` 是**单段文件名**，相对租户根；配置里的 `tenant` 键已删除 |
| 审计链 | 链句柄的 `tenant` | `packages/host/src/boot/plugins/audit-decisions.ts` | 建链时给一次，四类 append 天然全带 |
| 指标 | `WebDeps.tenantId` | `packages/host/src/boot/plugins/web.ts` | 只读；不从请求头/查询参数取 |
| 知识库令牌 | `BAH_KNOWLEDGE_TOKEN_<TENANT>` → 回退 `BAH_KNOWLEDGE_TOKEN` | `packages/host/src/boot/plugins/knowledge.ts` | 非 `demo` 租户用回退 = 启动失败 `knowledge-token-shared` |
| 仿真数据集 | `tenantSaltOf(tenantId)` | `packages/bank/src/forge/index.ts` | 加法 + 大质数乘子；`demo` 零偏移 |

**`SessionFiles` 的两个根**：

- `root` = 租户根（`<config.root>/<tenant>`）——**默认用这个**；
- `baseRoot` = 部署根（未拼租户）——**只有** `bank:saga-store` 用（见 §7）。

### 5.1 目录布局

```
<config.root>/                      ← 部署根（core:persistence.root，或 --jsonl 覆盖值）
  <tenant>/                         ← 租户根（SessionFiles.root）
    <sessionId>/session.jsonl
    <sessionId>/audit.jsonl
    memory.db
    halt.json
    anchors.json
    saga-<uuid>/audit.jsonl         ← 编排链（也按租户）
  saga.sqlite                       ← 部署根上：**不按租户分库**（§7）
```

`--jsonl` 覆盖的是**部署根**，租户段仍然在它下面：换目录时整个租户跟着走。

### 5.2 历史会话迁移

平铺的旧目录（`<root>/<sessionId>/`）不会被新代码读到。迁移用
`scripts/migrate-tenant-layout.ts`（默认 dry-run，`--apply` 才动，幂等，不覆盖）：

- 只搬"目录里直接有 `session.jsonl` 或 `audit.jsonl`"的目录；
- `saga.sqlite` / `anchors.json` / `memory.db` 是文件、且按设计留在部署根（或已在租户根），不在迁移面内；
- 目标已存在 → 跳过并报出来（不猜"哪个才对"）。

---

## 6 审计链的租户字段

链行新增**可选**字段 `tenant`（`ChainRecord.tenant`）。三条规则：

1. **有则入哈希**：`canonicalOf` 只在字段存在时把它纳入 `recordHash` 投影。
   无条件纳入会让**所有历史链**重算哈希不匹配（等于把已有证据判成"被篡改"）；
   完全不纳入则改租户字段不断链，这一列就成了没人校验的注释。
2. **可选**：`isChainRecord` 不要求它（v2 键集里没有它）。历史 v1/v2 行照常可读。
3. **可对账**：`bah audit --tenant <id>` 会把"链行自述的租户"与目录租户比对，
   不一致即报错（整目录被搬到别的租户下时，哈希链仍然连续，只有这一条能发现）。

**扫描口径不变**：`chainIds(root)` 仍只扫租户根**下一层**（= `<sessionId>/`）。
把它改成两层会去找 `<tenant>/<session>/<x>/audit.jsonl`，结果**一个链都扫不到**，
`audit/chain-broken` 永不再触发——那是"扫不到 = 没问题"的经典静默失败。

---

## 7 明确不做（引用 `00` §"明确不声称"的纪律）

| 不做 | 理由 |
|---|---|
| 进程内多租户（一进程 N 租户） | 内核无事件作用域：`Context.isolate()` 只做键屏蔽、事件总线全进程共享、`runtime:session` 是单例 |
| `saga.sqlite` 按租户分库 | 单库单进程；`verify-saga-wiring` 以固定路径 `sessions/saga.sqlite` 为基线。要改与 saga 单合并立项 |
| 租户级配额 / 限流 | 单进程只有本租户，配额没有对照物（属平台网关层） |
| 租户级加密密钥（KMS） | 无外部依赖可用；演示档无真实 PII |
| 知识库 sidecar 侧的租户隔离 | 本单只做宿主侧取令牌；sidecar（`services/rag`）是独立部署面 |
| `demo` 档仿真数据按租户变化 | `demo` 是固定脚本（王建国 + 预置收款人），7 个快照与 `profiles/*` 的静态画像都依赖它逐字节不变。租户差异化只对 `stress` / `adversarial` 档成立 |

---

## 8 变更流程

1. **改契约之前先改代码事实**——本契约描述的是已落地行为，不是愿望清单；
2. 改 `TenantId` 字符集 / `ROLES` 顺序 / 六个注入点之一 / 链行 `tenant` 语义，
   必须同时：升 `v1.x.y`（语义变更升 minor，破坏兼容升 major）、跑
   `pnpm typecheck` + `pnpm test` + `pnpm gate` + `pnpm test:snapshot`、
   并在 `PROGRESS.md` 记一条"为什么改"；
3. 新增第七个注入点 = 契约变更：先在本表加一行，再加门禁判据
   （`scripts/verify-tenant-scope.ts`），最后才写代码；
4. **不许**为本契约加 `BAH_ALLOW_*` 逃生口（`00` §5）。

---

## 9 门禁

`scripts/verify-tenant-scope.ts`（`--self-test` 必须绿）：

| # | 判据 | 反例 |
|---|---|---|
| 1 | 记忆 API 的租户实参必须是 `tenant*`（`readScoped` 是第 2 个实参） | `store.listUnits(userId)` |
| 2 | `packages/host/src/**` 里拼会话路径的文件必须出现 `tenant` | 新写一个只拼 sessionId 的落盘点 |
| 3 | 全仓不许从请求里取租户 | `req.headers['x-tenant']` / `searchParams.get('tenant')` |
| 4 | `SessionFiles.baseRoot` 只许 `bank:saga-store` 用（部署根是唯一的官方豁口） | 新插件 `ctx.get(SESSION_FILES).baseRoot` |
| 5 | 判据自身有反例（`--self-test`） | 加一个"恒绿"的判据 |

**这条门禁的局限**（如实写）：判据 1/2 是文本检查，不是类型检查。绕过它仍然可能
（例如把租户拼进一个变量名不含 tenant 的字符串）。它挡的是**疏忽**，不是恶意；
类型层面真正的防线是 `TenantId` 品牌类型与 `RunContext.tenantId` 必填。
