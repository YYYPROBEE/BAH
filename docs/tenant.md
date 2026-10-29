# 租户部署形态（tenant as deployment boundary）

> 租户与鉴权 04 · TA-53。本文是**运维直接抄**的那一份：边界、目录、环境变量、反代、常见事故。
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
  demo/                          ← SessionFiles.root（租户根，由 --tenant 决定）
    auth/sessions.jsonl          认证会话（02；含 sid/csrf，按凭据面保护）
    memory.db                    记忆库（01；一租户一文件）
    saga.sqlite                  saga 事务库（**不按租户分库**，见下）
    saga.tenant                  创建者标记（04 新增；内容 = 租户 ID）
    <sessionId>/
      session.jsonl
      audit.jsonl
  acme/
    …同构
```

**`saga.sqlite` 是进程级状态**（01 §5 的裁剪决策）：它落在部署根、不在租户根。
两个租户共用同一个部署根时，它们会写同一个 sqlite。04 起启动期会读同目录的
`saga.tenant` 标记：

- 标记存在且租户一致 → 静默；
- 标记存在但租户不一致 → 启动 `warn` 一行（不阻断）；
- 库存在但标记缺失（旧部署）→ `warn` 一行（无法判断创建者）。

**部署纪律**：每个租户使用**不同的 `--jsonl`（或不同工作目录）**。这是唯一被支持的形态；
要让 `saga.sqlite` 按租户分库，需要与 saga 单合并立项。

---

## 3 环境变量

| 变量 | 作用 | 缺省 | 必须 |
|---|---|---|---|
| `BAH_TENANT` | 租户（`--tenant` 优先） | `demo` | 生产必写 |
| `BAH_WEB_TOKEN` | `static` 模式的共享令牌 | 随机生成 | `static` 模式必写 |
| `BAH_ADMIN_TOKEN` | 单操作员管理令牌 | 未配置 = 管理面 404 | 要管理面就必写 |
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

# 6 条攻击剧本（答辩逐条念）
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
