# 跨租户攻击剧本（6 条，答辩逐条念）

> 租户与鉴权 04 · TA-53 / TA-55。前提：两个真实进程（`tenant-matrix.ts` 的 demo:17331 / acme:17341），
> 或按 `docs/tenant.md` 起的任意两租户。每条都可用 `curl` 复现；"实测"列是本轮真机输出。
>
> **读法**：先说期望，再说实测，最后说"失败说明什么"。不要背实现细节。

---

## 1 六条剧本

| # | 剧本 | 动作 | 期望 | 实测（2026-10-29） | 失败说明什么 |
|---|---|---|---|---|---|
| A1 | 凭证搬运 | 把 demo 的 `bah_sid` cookie 发给 acme 端口 `/api/session` | 401 `web-unauthorized` | **401**（matrix M1） | 会话存储没有按租户隔离键（或 cookie 被当成了全局会话） |
| A2 | 票据搬运 | demo 的 `ticketId` 在 acme 提交 `allowed-once` | 404 `unknown-ticket` | **404 unknown-ticket**（matrix M3） | 票据归属判的是会话不是租户；或两进程共用了 pending 表 |
| A3 | 租户头注入 | demo cookie + `X-Tenant: demo` / `?tenant=demo` 打 acme `/api/auth/me` | 401，且 body 不含 `acme` | **401 不含 acme**（matrix M8） | 有代码从请求里取租户（03 Z3 被违反） |
| A4 | 旧路径复用 | `GET /api/events?token=<任意>` 打 password 模式的 acme | 401 | **401** `{"code":"web-unauthorized"}` | `password` 模式下 `?token=` 分支没删干净（static 的旧捷径还在） |
| A5 | 目录穿越 | `GET /../demo/session.jsonl`、`GET /%2e%2e/demo/` | 404 | **404** `web-not-found`（两条） | 静态 handler 的规范化有洞（今天已防，属回归验证） |
| A6 | 启动注入 | `--tenant ../demo` 启动 acme | 退出码 2 | **exit 2** `tenant-id-invalid` | `parseTenantId` 没在 CLI 层拦（租户被当成运行期参数） |

复现命令（A1-A3 最省事：直接跑 matrix；A4-A6 需要一台 password 模式的 Web）：

```bash
# A1 / A2 / A3
npx tsx scripts/tenant-matrix.ts

# A4（password 模式，不登录直接带 token）
curl -si 'http://127.0.0.1:17441/api/events?token=whatever' | head -1

# A5（--path-as-is 阻止 curl 自己规范化）
curl -s --path-as-is -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:17441/../demo/session.jsonl'
curl -s --path-as-is -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:17441/%2e%2e/demo/'

# A6
npx tsx packages/cli/src/main.ts --profile web --tenant ../demo --dump-config; echo "exit=$?"
```

### A2 到底证明了什么（别夸大）

acme 进程的 `pending` 表里根本没有 demo 的 `ticketId`，所以它必然走 `unknown-ticket → 404`。
这条断言**证明的是"两个进程的内存不共享"**，不是"票据归属判定正确"——后者在单会话形态下
不可达（03 AR-38）。若跑出来是 `foreign-ticket`，说明两个进程共用了一份 pending 表：那才是事故。

### A6 的意义

它是唯一一条"还没起来就被拦"的剧本：租户是**启动输入**（`--tenant` / `BAH_TENANT`），
不是运行期参数；非法值在 CLI 层退出 2，进程根本没机会服务请求。

---

## 2 答辩口径卡（10 问 10 答）

> 规则：**先一句话说完，再展开**。答不上来的准备见 §3。

| # | 问 | 一句话答案 |
|---|---|---|
| 1 | 赛题没要求多租户，为什么做？ | 因为"越权"是赛题 §2 安全机制的必答项，而越权的第一层是跨客户；我们把跨租户做成**不可达**，不是靠 `if` 挡住 |
| 2 | 一个进程一个租户，算多租户吗？ | 算**部署级**多租户：同一套代码、同一台机器并存 N 个租户，靠目录/端口/令牌/密钥四道物理边界；进程内多租户明确不做，理由是内核没有事件作用域（`packages/core/src/api.ts` 原文"只做键屏蔽，不做多 realm 隔离"） |
| 3 | 怎么证明隔离？ | 两个真实进程 + 8 条断言 + 6 条攻击剧本 + 3 条门禁，一条命令复跑（`tenant-matrix.ts`） |
| 4 | 为什么不用 JWT？ | 撤销。员工离职、手机丢失要立刻失效，无状态令牌做不到 |
| 5 | 为什么不用 bcrypt / argon2？ | 零运行时依赖是宪法；scrypt 是 Node 内置（RFC 7914），参数 N=16384 是登录场景的合理代价 |
| 6 | 还留着静态 token，是不是没做完？ | 是**降级通道**：`static` 是默认模式，保证 8 个 profile 与 7 个快照零变化；对外演示切 `password`。风险已被限定在 `static` 模式内 |
| 7 | 审批"谁批的"怎么证明？ | `approval/actor` 链条目 + "人批必有主"不变量：链上 `approval/decided` 前若没有 actor，报告标 `machine`（超时/无人值守） |
| 8 | 管理面的 `by` 还能伪造吗？ | 不能。从 token 派生（每操作员一 token），body 里出现 `by` 直接 400 |
| 9 | 挂反向代理后还安全吗？ | 业务面可以，管理面不行——同机代理会让"只接受回环"退化为只剩 token，所以管理面独立端口且只绑回环，boot 期有 warn |
| 10 | 角色能被绕过吗？ | 判定只有一处（`authorize()`），handler 里禁判角色（门禁扫），44 格矩阵用例 + 双向覆盖判据 |

**答不上来的准备**：如果有人问"多个客户同时用一个进程怎么办"——答案是
"当前形态不支持，这是 ADR-0004 明确记录的边界；要支持必须给内核加事件作用域，
那是另一份立项"。**不要说成借口，要说成取舍。**

---

## 3 不声称（面试官一追问就露的几句）

- 不声称"跨租户返回 404"：跨租户在认证层就是 401，走不到资源层。
- 不声称"票据归属校验拦住了跨租户"：A2 证明的是进程内存不共享。
- 不声称"用户级票据归属已生效"：视图还没有 `userId`（03 AR-38）。
- 不声称"HALT 操作员可查"：只覆盖了 sentry 解冻（03 AR-39）。
- 不声称"一进程多租户"：ADR-0004 明确不做。
