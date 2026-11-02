# 租户部署形态（tenant as deployment boundary）

> 本文是**运维直接抄**的那一份：边界、目录、环境变量、反代、常见事故。
> 立场一句话：**租户 = 进程**。同一套代码、同一台机器并存 N 个租户，靠目录 / 端口 / 令牌 / 密钥
> 四道物理边界隔开；**一进程 N 租户明确不做**（ADR-0004）。

---

## 1 四道物理边界

| 边界 | demo | acme | 配错会怎样 |
|---|---|---|---|
| 目录 | `runs/demo/demo/` | `runs/acme/acme/` | 共用目录 = 会话与审计串在一起 |
| 端口 | 7331 | 7341 | 撞端口 → 启动失败（**故意不自动换端口**） |
| 令牌 | `BAH_WEB_TOKEN`（static）或会话 | 各自独立 | 共用 token = 02 白做 |
| 知识密钥 | `BAH_KNOWLEDGE_TOKEN_DEMO` | `BAH_KNOWLEDGE_TOKEN_ACME` | 共用 = 知识库串租户 |

> 表里的 `runs/<部署根>/<tenant>/` 是因为每个租户用了**不同的 `--jsonl`**（见 §2 的 saga 说明）。
> 如果两个租户共用一个部署根，`core:persistence` 仍会各自落到 `<部署根>/<tenant>/`；
> 但 `saga.sqlite` 不按租户分库，必须分开部署根。

---

## 2 目录树（`--jsonl <deploy-root>`）

```
<deploy-root>/
  saga.sqlite                    saga 事务库（**不按租户分库**，部署根上）
  saga.tenant                    创建者标记（04 新增；内容 = 租户 ID）
  demo/                          ← SessionFiles.root（租户根，由 --tenant 决定）
    auth/sessions.jsonl          认证会话（02；含 sid/csrf，按凭据面保护）
    memory.db                    记忆库（01；一租户一文件）
    <sessionId>/
      session.jsonl
      audit.jsonl
  acme/
    …同构
```

**`saga.sqlite` 是进程级状态**：它落在部署根、不在租户根。
两个租户共用同一个部署根时，它们会写同一个 sqlite。04 起启动期会读同目录的
`saga.tenant` 标记：

- 标记存在且租户一致 → 静默；
- 标记存在但租户不一致 → 启动 `warn` 一行（不阻断）；
- 库存在但标记缺失（旧部署）→ `warn` 一行（无法判断创建者）。

**部署纪律**：每个租户使用**不同的 `--jsonl`（或不同工作目录）**。这是唯一被支持的形态；
要让 `saga.sqlite` 按租户分库，需要与 saga 单合并立项。

**旧平铺目录迁移**：租户化前会话直接平铺在部署根下一层（`<sessionId>/`），新代码不会读它。迁移用
`npx tsx scripts/migrate-tenant-layout.ts`（默认 dry-run；`--apply` 才动，幂等，不覆盖）：

```bash
npx tsx scripts/migrate-tenant-layout.ts --root sessions --tenant demo           # 计划
npx tsx scripts/migrate-tenant-layout.ts --root sessions --tenant demo --apply   # 执行
```

只搬"目录里直接有 `session.jsonl` 或 `audit.jsonl`"的会话目录；`saga.sqlite` / `memory.db` /
`anchors.json` 是文件，不在迁移面内。

---

## 3 环境变量

| 变量 | 作用 | 缺省 | 必须 |
|---|---|---|---|
| `BAH_TENANT` | 租户（`--tenant` 优先） | `demo` | 生产必写 |
| `BAH_WEB_TOKEN` | `static` 模式的**客户**共享令牌（`svc:web` / `customer`） | 随机生成 | `static` 模式必写 |
| `BAH_OPERATOR_TOKEN` | `static` 模式的**坐席**令牌（`svc:operator` / `agent`）；未配置 = 坐席面整体 404 | 无 | 要坐席台就必写；**不得与 `BAH_WEB_TOKEN` 相同** |
| `BAH_OPERATOR_NAME` | 坐席显示名（只进气泡与审计标签，**不是身份**） | `坐席` | 可选（≤64 字符） |
| `BAH_ADMIN_TOKEN` | 单操作员管理令牌 | 未配置时回落到 `BAH_ADMIN_OPERATORS`；两者都不配 = 管理面 404 | 要管理面就至少配一个 |
| `BAH_ADMIN_OPERATORS` | 多操作员 JSON `[{id,token}]` | 无 | 需要"谁操作"就必写 |
| `BAH_KNOWLEDGE_TOKEN_<TENANT>` | 按租户知识库令牌 | 回退到 `BAH_KNOWLEDGE_TOKEN` | 非 `demo` 必写 |
| `BAH_KNOWLEDGE_KEY` | 知识清单 HMAC 密钥 | 无（不配就起不来） | 装配 `bank:knowledge` 时必写 |
| `BAH_MODEL_KEY` | 上游模型密钥 | 无（router 离线） | 接真模型时必写 |

启动示例（两个租户、两个目录、两个端口）：

```bash
# demo：--profile web 的 patch 里 port=7331
BAH_TENANT=demo  BAH_WEB_TOKEN=... \
  pnpm bah --profile web --serve --tenant demo --jsonl runs/demo

# acme：用一层 overlay 把 port 改成 7341（--patch 的层序最外）
BAH_TENANT=acme  BAH_WEB_TOKEN=... \
  pnpm bah --profile web --serve --tenant acme --jsonl runs/acme --patch deploy/acme.yml
```

> `--tenant` 在 CLI 层就校验（`tenant-id-invalid`，退出码 2）；`../demo`、`Demo`、`demo_1`
> 这类"路径安全但不是租户"的值会在启动前被拒——租户是**启动输入**，不是运行期参数。

### 3.1 认证模式（02）

`channel:web.auth.mode` 缺省 `static`（不写 auth 块 = 改动前行为）。对外演示或真实用户
必须切 `password`：

```yaml
- id: channel:web
  config:
    auth:
      mode: password
      cookie: { name: bah_sid, secure: true }   # HTTPS 必须 true；本机 http 才设 false
      session: { idleMs: 1800000, absoluteMs: 28800000 }
      directory: { path: auth/users.yml }
      login: { maxFailures: 5, lockMs: 900000, backoffBaseMs: 1000, backoffMaxMs: 60000 }
```

开启前必须做三件事（缺一步 boot 期 fail-loud，细节见 `profiles/web/patch.yml` 注释）：
① 复制 `auth/users.example.yml` 为 `auth/users.yml` 并换口令（哈希用
`npx tsx scripts/auth-hash.ts --stdin`；该文件被 `.gitignore` 挡住，**不要入库**）；
② 去掉 `bank:tools` 的 `demoUserId`；③ 去掉 `core:agent` 的 `runtimeContext.user`。
`auth/users.yml` 里的 `tenant` 必须等于本进程租户，否则启动报
`auth-directory-tenant-mismatch`。`directory.path` 相对**进程 cwd**（不是租户根）：
同机两租户要用两份目录文件（如 `auth/demo-users.yml` / `auth/acme-users.yml`），不要共用。

- `static`：双凭证。`BAH_WEB_TOKEN` 的 Bearer = `svc:web`（`customer`）；
  `BAH_OPERATOR_TOKEN` 的 Bearer = `svc:operator`（`agent`）。SSE 可用 `?token=`；页面 meta 注入 token。
  **不是登录**；两把 token 相同会在 boot 期拒绝（`web-operator-token-conflict`）。
- `password`：HttpOnly `bah_sid` 会话 cookie；`/api/auth/me` 自查；登录 / 登出 / 撤销落
  `auth/*` 审计；`?token=` 不再被接受；口令失败同形（不区分"用户不存在"）。

> 坐席台的边界（合流 2026-10-29）：坐席前端只在 `static` 模式下开放（`/operator` 与 5 条坐席
> API）；`password` 模式下坐席登录卡片尚未实现，`seatEnabled=false` ⇒ 整条 404（**不是** 401，
> 401 会暴露存在性）。坐席凭证与客户凭证必须分离：同一串 token 启动即失败。
- `none`：不验凭证，只用于内网测试装置。

角色来自用户目录（customer / agent / auditor / admin），路由级判定在 `authorize()`；
未认证 401、角色不足 403。管理面（`/api/admin/*`）**不**走这套角色，仍要求独立 admin token
+ 回环来源。

> `bah sentry unfreeze` 只从 `BAH_ADMIN_TOKEN` 读 token；宿主用 `BAH_ADMIN_OPERATORS` 时，
> 把 CLI 的 `BAH_ADMIN_TOKEN` 设为该操作员的 token（服务端按 operators 列表校验），
> 不要试图传 `--by`（03 起 body 带 `by` 一律 400）。

---

## 4 反向代理（三条踩点）

1. **SSE 必须关缓冲**：`proxy_buffering off; proxy_read_timeout 3600s;`
   否则前端"发一句等十秒才出气泡"。
2. **管理面不要挂反代**：`admin-guard` 的 `isLoopbackAddress(req.socket.remoteAddress)` 是管理面的
   第二道防线；同机 nginx/caddy 会让它恒为 `127.0.0.1`，防线退化为只剩 token。
   管理面必须独立端口且只绑 `127.0.0.1`。若 `channel:web.host !== '127.0.0.1'` 且配置了
   管理凭据，boot 期会 `warn` 一行。**不实现** `X-Forwarded-For` 解析：它需要可信代理列表，
   而配错的方向永远是"更宽松"。
3. **`Host` 与 HTTPS**：04 起 CSRF 的同源判定只比 **host 段**（端口参与比较），
   协议由 `auth.cookie.secure` 决定：`secure=false` 只接受 `http://` Origin，
   `secure=true` 只接受 `https://` Origin。反代必须 `proxy_set_header Host $host;`；
   外层是 HTTPS 时同时把 `auth.cookie.secure` 设为 `true`，否则写请求会 403
   `web-csrf-forbidden`（这是部署配置，不是代码 bug）。

---

## 5 验证命令

```bash
# 8 条跨进程断言（两个真实进程、两个端口）
npx tsx scripts/tenant-matrix.ts

# 布局门禁（毫秒级；host 之外的路径拼接 + fileOf 倒数第三段 + 两租户前缀不交叉）
npx tsx scripts/verify-tenant-isolation.ts
npx tsx scripts/verify-tenant-isolation.ts --self-test

# 6 条攻击剧本（对外说明逐条念）
# 见 docs/drill-tenant-6.md
```

---

## 6 明确不做

| 不做 | 为什么 |
|---|---|
| 一进程 N 租户 | 内核没有事件作用域（`packages/core/src/api.ts` 原文"只做键屏蔽，不做多 realm 隔离"）；要支持是另一份立项（ADR-0004） |
| `X-Forwarded-For` 可信代理 | 需要可信代理列表配置，配错会"更宽松"；单机形态不需要 |
| `saga.sqlite` 按租户分库 | 与 saga 单合并立项；当前用不同部署根隔离 |
| 租户级配额 / 限流 / KMS | 需要计费与密钥托管，属于生产化阶段 |
