# ADR-0014：交易密码修改 = 交办（安全页交接），不是代改

> 状态：已接受（2026-11-01）
> 关闭项：赛题"红档典型操作（强验证 + 确认）"里的**交易密码修改**
> 关联：ADR-0003（票据授权）、ADR-0009（服务端问卷与只读动作豁免）、ADR-0012（账本事实型载荷）
> 事件表：v1.0.2 → **v1.0.3**（新增 2 个键，代码口径 34 → 36）

## 1. 问题

赛题把"密码修改"列为红档典型操作。银行语境下还有一条更硬的约束：

**Agent 不得接触密码明文。** 一旦明文进入工具参数，`tool/call` 的 `args` 会被**全量**写进
`sessions/<sessionId>/session.jsonl`——等于把用户密码写进了审计日志。再多的"我们不会记录密码"
声明也抵不过一条日志里的字面量。

所以本单要解决的不是"怎么让模型改密码"，而是"**怎么让模型发起改密而永远拿不到密码**"。

## 2. 决策

### 2.1 形态：交办（handoff）

```
用户说"我要改交易密码"
  → 工具 password_change(action="request")     ← 红档：强验证 + 审批票据
  → 核心签一次性交接票据 pwd:<callId>（TTL 120s），返回 { handoffPath: '/secure/password' }
  → 用户打开安全页，在表单里提交 旧密码 / 新密码
  → POST /api/secure/password { ticketId, oldPassword, newPassword }
  → 核心校验票据 → 校验并改密 → 核销票据 → 落 security/password-changed
```

模型与工具**只经手票据与状态**，不经手密码。

### 2.2 工具契约

`password_change`（`packages/bank/src/tools/specs.ts`）：

| 字段 | 值 |
|---|---|
| `tier` | `{ level: 'red' }`（挑战由治理面签发，工具内**不做** MFA） |
| `schema.properties` | **只有 `action`**（枚举 `request` / `status`）——没有任何密码字段 |
| `event` | `security/password-changed` |
| `readEvent` | `read/password-status`（`status` 分支登记进 `READ_ONLY_ACTIONS`） |
| `SIDE_EFFECTS` | `write`（理由同 `fund_lock`：`status` 只读，但工具级不许并发） |

**为什么 schema 里没有密码字段是"结构性"保证**：模型能填的参数只有 `action`，
它想"顺手把密码传进来"也没有位置。评审要查的"密码会不会进 `tool/call.args`"，答案是
**这条路径上没有那个字段**，不是"我们约定不传"。

`request` 是写操作：先按纪律 9 走 `ticketRefForCall(…, 'password_change', args, 0)`
核销治理面签发的审批票据（金额 0——本工具不动资金），核销成功才签交接票。
没有审批票据 → `ticket-missing`，**连交接票都不给**。

### 2.3 核心契约（`packages/bank/src/core/provider.ts`）

除本单点名的两个方法外，还多了票据生命周期三条——理由写在这里，不留给读者猜：

| 方法 | 读写 | 说明 |
|---|---|---|
| `requestPasswordChange(userId, { ticketId, ttlMs }, approval)` | 写 | 先 `tickets.redeem(approval)`，再登记交接票 |
| `checkPasswordHandoff(ticketId, userId)` | 读 | 未知 / 已用 / 过期 / 他人 各给独立理由码 |
| `consumePasswordHandoff(ticketId)` | 写 | **成功之后**才核销：失败可重试是同一纪律的另一面 |
| `changeTxnPassword(userId, old, new)` | 写 | 校验顺序 + 失败计数 + 锁定 |
| `checkTxnPassword(userId, password)` | 读 | **不**计数、**不**锁定（否则任何能调它的代码都能把用户锁死） |
| `passwordStatus(userId)` | 读 | 上次改密时刻 + 剩余尝试次数 |

票据为什么放在 provider 而不是工具里：真实对接时"发起改密"是**行方接口**（短信/APP 内唤起），
工具不该知道票据存在哪。交接票的 Map 与盐一样**只在内存**。

### 2.4 校验顺序（固定，先便宜后贵）

1. 长度 8–20 → 2. 同时含字母与数字 → 3. 新 ≠ 旧 → 4. 旧密码比对

- 前三步抛 `password-invalid`（都不读账本）；
- 第四步抛 `password-mismatch`（最贵：要算一次哈希）；
- **只有第四步计入失败次数**。格式错说明申请还没成形，拿它计数会让用户打错一次格式
  就把自己逼近锁定。
- 连续 3 次不匹配 → `password-locked`，窗口 15 分钟（`TXN_PASSWORD_LOCK_MS`）；
  窗口过后计数归零。
- 文案只描述规则（"8–20 位、含字母与数字""旧交易密码不正确"），**不指认哪一位错**。

### 2.5 HTTP 端点（只此一个）

`POST /api/secure/password`，body `{ ticketId, oldPassword, newPassword }`。

- 路由声明在 `packages/host/src/boot/plugins/web/router.ts`（`auth: 'web'`、`csrf: true`、
  `roles: ['customer']`、`scope: 'self'`）；**闸一条都没新增**——限流 → 身份 401 →
  角色 403 → CSRF 403 全部在 `dispatch.ts`。handler 里没有任何判权代码。
- handler 在 `packages/host/src/boot/plugins/web/handlers/password.ts`：读 body →
  `PasswordHandoffPort.submit(sessionId, …)` → 翻译状态码。
- 响应只有 `{ ok: true, changedAt }` 或 `{ error: { code, reason } }`；**绝不回显**密码字段。
- 身份**只从会话解析**（`bank:password-handoff` 端口拿 `sessionId`，内部走 `BANK_IDENTITY`）。
  原因：`static` 鉴权模式下 HTTP 主体是合成主体 `svc:web`，它不是客户号；会话绑定的 `u-1`
  才是"这笔密码属于谁"的唯一答案。这也从结构上堵掉"拿别人的票 + 自己的 userId"。

状态码：400（新密码不合规 / 旧密码不对）、404（票据未知或不属于本会话——403 会暴露存在性）、
409（已用 / 已过期）、423（锁定中）、501（该部署没装 `bank:tools`）。

**"无票据 → 401/403"的口径（复审 P2-2 登记）**：任务书 01 §3.7 的这句话指**认证/CSRF 缺失**，
由 `dispatch.ts` 的闸返回 401/403，handler 不自己写 403。交接票据（`ticketId`）是**请求体字段**：
缺字段是 400 `web-invalid-ticket` / `web-invalid-body`，未知票是 404。把"body 少一个字段"
回成 401 会让客户端以为该重新登录，反而误导排障。

### 2.6 事件（新增 2 键，v1.0.3）

| 键 | 载荷（冻结） |
|---|---|
| `security/password-changed` | `{ userId: string; method: 'secure-page'; at: number }` |
| `read/password-status` | `{ lastChangedAt: number \| null; remainingAttempts: number; at: number }` |

**载荷里禁止出现**旧密码、新密码、密码哈希、盐、明文的任何变形。发射点：
`packages/bank/src/tools/password.ts` 的 `createPasswordHandoffPort().submit()`
（`audit.append('security/password-changed', …)`，字面量）与
`readPasswordStatus()`（`audit.append('read/password-status', …)`）。

为什么落账点放在端口里而不是工具里：改密发生在 HTTP 端点，**不在**工具调用里。
把事件放在端口里，工具族的审计出口（`BankAudit`）就是唯一写法——否则同一条事实会有两条。

### 2.7 安全页

`apps/web/password.html` + `apps/web/src/password.js`，登记进
`packages/host/src/boot/plugins/web/config.ts` 的 `DEFAULT_WEB.entries`（否则 password 模式
拿不到 CSRF cookie、static 模式拿不到 Web token，表单永远 401/403）。

页面纪律：不写 `localStorage`/`sessionStorage`/cookie、不 `console.*`、成功后立刻清空
两个密码框；票据号可以从 `?ticket=` 读入，但读完立刻 `history.replaceState` 抹掉。

**URL 别名（复审 P0-1）**：落盘文件是 `apps/web/password.html`，对外的语义地址仍是
`/secure/password`。`packages/host/src/boot/plugins/web/handlers/static.ts` 在 decode 之前
把它映射到 `password.html`（与 `/operator` → `/operator.html` 同一条路径），再走原有的
解码/规范化/越界判定。没有这条映射，工具返回的交接地址实测 404。

**演示话术引用工具结果（复审 P0-2）**：`password_change` 的工具正文包含
`/secure/password?ticket=<已编码票据>`；离线 router 的收尾用 `outcome.okFromResult`
原样引用这段正文，不再手写路径，也不会丢掉票据号。`password.js` 的 `?ticket=` 预填
因此可以直接用——用户不必从工具卡里手抄 `pwd:` 号。

## 3. 不声称

1. **不是真实改密**：`MockBankCore` 的凭据表在内存里，进程重启即回到演示口令。
2. **盐不是安全控制**：`deriveTxnPasswordSalt` 按 `userId` 确定性派生（同口令不同用户
   → 不同摘要）。它不离开进程、不参与任何输出，换来的是单测与回放不依赖熵。真实实现
   必须换成 CSPRNG + 持久化盐。
3. **演示口令是公开的**：`bank1234` 写进本 ADR 与 `docs/security-self-assessment.md`
   的"已知风险"。演示仓如此；真实部署由 `credentials` 面注入，不由本仓给默认口令。
4. **不做登录密码**：`auth/` 的登录口令与交易密码是两套凭据，本单**不**合并、不复用。
5. **锁定是进程级的**：`MockBankCore` 每个进程一份状态；多实例部署时各算各的。
6. **没有"忘记交易密码"的自助重置**：那要走柜面/视频面核身，本仓不提供。

## 4. 后果

- 正向：密码明文这条路在**结构上**不存在——工具参数没有该字段，事件载荷只有
  `{ userId, method, at }`，安全页不从对话里收密码。`grep -r "bank1234\|newPassword\|oldPassword" sessions/`
  零命中是可复现的、而不是靠自觉。
- 正向：红档三件套（强验证 + 审批 + 一次性票据）在"改密"这条路上是完整的：
  审批票据核销 → 交接票签发 → 安全页提交 → 交接票核销。
- 负向：用户多一次跳页（这是刻意的，见 §1）；端到端演示多一个 HTTP 端点。
- 中性：工具目录 29 → 30，上限 `BANK_TOOL_LIMIT` 30 → 31（同批留一个空位）。
