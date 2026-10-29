# 03 · 授权平面（AuthZ）—— 对抗式复审（R3）

- 复审对象：`tenant-03-authz` 工作树上的 03 实现（基线 `2285796` = 02 的收工提交），
  对照 `03-授权平面-AuthZ.md` 与 `05-对抗式复审.md`
- 复审立场：**假定它是错的**——先找"看起来有防线、实际不可达"的那一行，再找"文档说 A、代码做 B"
- 结论：**16 条发现（P0×1 / P1×4 / P2×8 / P3×3），9 条在本提交修复，7 条登记不改**；
  另有 4 条"怀疑过、但证伪了"的结论
- 关键事实：**P0 不是在单测里发现的**——`bah sentry unfreeze` 的客户端契约与 TA-44 的新服务端契约相反，
  单测只测了服务端与 CLI 各自的旧期望；靠"把调用链从头到尾读一遍"才抓到（AR-29）

> 编号接 02 的 AR-28，从 **AR-29** 起。

---

## 1 复审方法

| 步 | 做法 | 目的 |
|---|---|---|
| 1 | 读生产 diff（router → authorize → dispatch → handler → adapter/链） | 找**调用链断点**：类型加了、参数没传；字段加了、没人消费 |
| 2 | 对每条"防线"问三个问题：**谁调用它？失败时回什么？有没有用例能证伪？** | 找不可达防线（03 §1.2 的 `foreign-ticket` 就是前车之鉴） |
| 3 | 跑真机：password 模式三次 boot（customer / agent / 客户审批），`curl` 打 15 组 | 单测用冻结时钟与桩，抓不到"契约相反"与"派生值没接上" |
| 4 | 逐条核计划书的收工判据 | 找出计划内部自相矛盾（AR-37） |
| 5 | 每条发现要求三件套：位置（文件+符号）/ 证据（命令或原文）/ 修法 | "我觉得"不进正文 |

**没做**：`pnpm check` / `test:coverage`（逐文件 100% 与全仓覆盖率）。03 的收工闸不含覆盖率，
所以"新增代码的覆盖率"本文件**不声称**。

---

## 2 结论摘要

| ID | 级 | 一句话 | 处置 |
|---|---|---|---|
| **AR-29** | **P0** | `bah sentry unfreeze` 仍向 body 发 `{by}`，而 TA-44 的新契约把 `by` 判 400 ⇒ 运维唯一解冻入口直接坏掉 | 已修：CLI 只发 `reason`、从响应读 `by`；显式拒绝 `--by`；测试/文档同步 |
| AR-30 | P1 | static 模式的**合成主体** `svc:web` 被写成 `approval/actor` ⇒ "人批必有主"假阳性（机器冒充人） | 已修：只有 `kind:'principal'` 才入 actor；服务主体仍过会话层归属 |
| AR-31 | P1 | 任意已认证用户可用随机 `ticketId` 刷长审计链（未知票号先写 actor 再 404） | 已修：只有**当前待答**票据才写 actor（跨会话的待答票仍记，属真实越权尝试） |
| AR-32 | P1 | `bah audit` 联接把链行 `d` 当 JSON 解析；`d` 是 `sha256(data)` ⇒ 所有行退化成"不是 JSON"告警 | 已修：改用信封 `sub`/`subject`/`decision`；文档写清"链上不可反解载荷" |
| AR-33 | P2 | 管理面坏配置的 503 排在回环检查**之前** ⇒ 局域网扫描器可确认管理口存在 | 已修：先判回环（非回环 403），再看配置 |
| AR-34 | P2 | `POST /api/handoff` 只拒 `operator/requestedBy`，其它未知键静默忽略；与 resume 的"全拒"不一致 | 已修：enter 也只接受 `reason` |
| AR-35 | P2 | `scope:'self'` 注释写"留给审计与门禁"，实际两者都没消费（纸面防线） | 已改注释：**声明式、当前无消费者**；执行仍在适配器 |
| AR-36 | P2 | 生成的路由表把 password 模式的路由一律标成 `Bearer` | 已修：标签改 `Web 凭证` + 文档重生成 |
| AR-37 | P1 | 03 收工要求"`web.test.ts` 一字未改"，但 TA-44/45 的契约变更**必然**改写 5 条既有用例——计划自相矛盾 | **登记**：只改受契约影响的 5 条；401/403 顺序与计数用例一字未动；见 D-3 |
| AR-38 | P2 | 票据的**用户层**归属判定在生产不可达：`ApprovalService` 的视图还没有 `userId` | **登记**：参数已接、用例在；安全文档写明"只有会话层始终生效" |
| AR-39 | P2 | HALT / 凭票解除 HALT 的操作员仍未入链（本轮只覆盖解冻的 `by`） | **登记**：写进 `security-design §3` 行 8 的缺口列 |
| AR-40 | P2 | `approval/actor` 记的是"尝试"：待答票据 + 非法 body（如缺拒绝理由）也会先写 actor，再 400 | **登记**：CLI 把无决定的 actor 标"未决"；这是"尝试"而非"结论"，不冒充人批 |
| AR-41 | P2 | 新门禁的自检样本触发 `verify-tenant-scope` 误报（该门禁只跳过自己） | 已修：`verify-tenant-scope` 跳过全部 `scripts/verify-*.ts`（自检样本是字符串常量） |
| AR-42 | P3 | `AuthorizeVerdict` 的 404 分支与 `scope` 一样是**死声明**（当前永不返回） | **登记**：计划要求保留联合类型；注释写明不可达 |
| AR-43 | P3 | 403 `reason` 回显"需要角色：agent / admin" | **接受**：角色矩阵是公开文档，不构成探测面；换成模糊文案反而排障困难 |
| AR-44 | P3 | CLI 报告的 `at` 是链行 `recordedAt`，不是业务时刻（业务 `at` 在 payload 摘要里，链上不可反解） | **接受**：字段注释与文档都写明 |

---

## 3 逐条（证据 → 判定 → 修法）

### AR-29（P0）· 管理面契约改了，命令行客户端没跟上

**证伪链**（代码在读，不靠推测）：

```text
packages/cli/src/cli/sentry.ts:156
  body: JSON.stringify({ by: parsed.by, reason: parsed.reason })
packages/host/src/boot/plugins/web-admin.ts:245
  for (const key of Object.keys(record)) if (key !== 'reason') → 400 "未知字段：by"
```

⇒ `bah sentry unfreeze --by ops-1` 100% 返回 400；这是**唯一的远程解冻入口**。
03 的交付清单没有列 `sentry.ts`（只列了 web-admin/admin-guard/handlers），计划漏了调用方。

**修法**：CLI 删除 `--by`（传了就报"已移除"，不静默忽略）；body 只发 `reason`；
成功文案用服务端响应里的 `by`（`已解冻（by=ops-7）`）。`sentry.test.ts` / `run.test.ts`
的请求体与输出断言同步；`deploy.md` / `hp-0-fail-closed.md` / `web-frontend.md` / `facts.md` 更新。

**验证**：`npx vitest run packages/cli/src/cli/sentry.test.ts packages/cli/src/cli/run.test.ts`
→ 48 例全绿；真机 `POST /api/admin/sentry/unfreeze` + `Bearer tok-li` → `200 {by:"ops-li"}`。

---

### AR-30（P1）· 合成主体被记成"人"

`static` 模式没有登录态，`identify()` 返回 `{kind:'service', principal: svc:web}`。
原实现只要 `principal !== undefined` 就写 `approval/actor` ⇒ CLI 会看到
`审批 t-1 → allow → svc:web`，`人批必有主` 永远满足——**这是假阳性**。

**修法**：`actingPrincipal()` 只接受 `kind === 'principal'`；`TicketOwner` 对服务主体只传
`sessionId`（不带 `userId`）。新增 `TA-46-1b`：static 模式审批 200，但 `appendActor` 调用数为 0。

---

### AR-31（P1）· 未知票号刷链

原顺序是"先 appendActor，再 decide"，而 `decide` 对未知票号返回 404。
任何已认证用户都能用随机 `ticketId` 往 `audit.jsonl` 里塞行（每分钟 120 次上限）。
**修法**：`if (principal && adapter.pendingTickets().includes(ticketId))` 才写；
跨会话的"待答票据"仍会写 actor（那是真实越权尝试）。新增 `TA-46-1c`。

---

### AR-32（P1）· 链行 `d` 不是载荷

首版 `joinApprovalActors` 用 `JSON.parse(row.d)` 取 `ticketId`。实现后测试立刻红：

```text
告警：票据联接：a#1 的 approval/actor 载荷不是 JSON 对象，已跳过
```

`ChainRecord.d = sha256Hex(canonicalJson(data))`（`packages/persistence/src/chain/index.ts:210`），
载荷原文只在 `session.jsonl`。**修法**：改用 v2 信封：
`sub`（= ticketId）、`subject`（actor 行的 `principal:<tenant>/<user>`）、`decision`（allow/deny）、
`recordedAt`。文档 `docs/audit-command-16.md` 与 `docs/audit.md` 同步写明"链上不可反解载荷"。

**真机验证**（password 模式客户 800 元转账）：

```text
q9  approval/actor    sub=ticket:f929…  subject=principal:demo/u-1  decision=allow
q10 approval/decided  sub=ticket:f929…  subject=session:s-mvstw062  decision=allow
$ bah audit --dir sessions --tenant demo --no-signature --no-projection
审批 ticket:f929… → allow → u-1
```

---

### AR-33（P2）· 坏配置的 503 泄漏管理口

原顺序：解析操作员表 → 失败即 503 → 才判回环。非回环扫描器因此看到 503（"这里有个管理口"）。
**修法**：坏配置分支先判回环（403），回环内才 503。新增 dispatch 用例（503 / 403 两态）。

### AR-34（P2）· enter 的未知键

`handleHandoff` 的 enter 分支只拒 `operator/requestedBy`，`{foo:1}` 静默通过；
resume 则全拒。**修法**：enter 也只接受 `reason`。语义统一，客户端自报主体无处可塞。

### AR-35（P2）· `scope` 的纸面承诺

注释写"留给审计与门禁用"，实际 `authorize()` 不读、审计不读、门禁不读。
**修法**：改注释为"声明式、当前没有执行者"，把执行点指向适配器（403 `foreign-ticket`）。

### AR-36（P2）· 路由表鉴权标签

`routes-markdown.ts` 把 `web` 一律渲染成 `Bearer`。password 模式没有 Bearer，读者会被误导。
**修法**：标签改 `Web 凭证`，重生成 `docs/web-frontend.md` §7。

---

### AR-37（P1，登记）· "web.test.ts 一字未改"与 TA-44/45 不可兼得

03 收工判据写"`foreign-ticket` 仍是 403，且 `web.test.ts` 一字未改（`git diff --stat` 为空）"。
但 TA-44 要求"body 带 `by` → 400、`by` 从 token 派生"，TA-45 要求"resume 的 operator 从主体派生"。
`web.test.ts` 里 5 条既有用例**正好钉着旧契约**：

- HP0-08：`post({ by:'ops-7' })` → 期望 `unfreezeCalls=[{by:'ops-7'}]`；
- HP0-09：`post({ by:'ops-7' })`；
- HP0-10：`{reason:'x'}` → 期望 400（新契约里是合法请求）；
- HP0-11：`{by}` → 期望 503（新契约里先 400）；
- C5：`resume({operator:'坐席-A'})` → 期望响应 `operator:'坐席-A'`。

两条要求不能同时满足。**处置**：只改这 5 条（输入字段与派生值），
`TC-W04-02/03` 的两处 `toBe(403)`、401/403 顺序、53 例基线计数全部未动；
在证据 D-3 里逐条列出。**这不是"把断言改绿"**——是把断言改成计划另一条要求（TA-44/45）的形状。

### AR-38（P2，登记）· 用户层归属不可达

`ApprovalViewLike.userId` 已加、适配器已判、`actor.userId` 已从登录主体传入；
但 `ApprovalService.viewFor()` 还没有 `userId`（它不知道票据是哪个登录用户签发的）。
⇒ 生产路径上用户层判定**跳过**，只有会话层生效。安全文档 §3 行 3 已写明。
**修法（后续）**：让审批服务在签票时带 `userId`，或由宿主在 `attachApproval` 前补字段。

### AR-39（P2，登记）· HALT 操作员仍未入链

解冻解冻（`sentry/unfreeze`）的 `by` 已经从 token 派生；但 `safety/halt` 的载荷只有
`reason:'manual'`，没有 operator。`bah halt` 的"谁按的"仍不可查。
**登记**：`security-design §3` 行 8 的缺口列已写；改 `halt.halt` 签名属于 10 号单的契约面，不在 03。

### AR-40（P2，登记）· actor 记的是"尝试"

待答票据 + 非法 body（例如 `decision:'rejected'` 缺理由）会先写 actor，再 400；
CLI 联接显示"未决"。这是有意的：actor=尝试、decided=结论。**不声称**"链上有 actor 就一定批了"。

### AR-41（P2）· 门禁互相误伤

`verify-tenant-scope` 的 `isGateFile` 只跳过自己；新门禁 `verify-authz-coverage.ts` 的
自检样本里写着 `req.headers['x-tenant']`（字符串常量），被它扫成判据 3 红。
**修法**：`isGateFile` 改为跳过全部 `scripts/verify-*.ts`——门禁的自检样本不是运行时路径。
这一点在 03 的偏差 D-7 里登记。

### AR-42 / AR-43 / AR-44（P3）

- 404 分支与 `scope` 一样是死声明（计划要求保留联合类型）；注释已写明。
- 403 `reason` 回显所需角色：接受（角色矩阵是公开契约）。
- CLI 的 `at` 是链行 `recordedAt`：接受（业务时刻只在 payload 摘要里）。

---

## 4 怀疑过、但证伪了

| 怀疑 | 证伪方式 | 结论 |
|---|---|---|
| `authorize` 的 static+`/api/*` 会放行匿名 | `TA-41-8`：static + `isApi` + anonymous → 401 | 不是漏洞 |
| 未知的非 API 路径会被授权闸误伤成 401 | `TA-42-3`：`POST /foo` → 405（合成 static spec） | 不是回归 |
| 管理面 `authorize` 放行等于绕过 token | `guardAdmin` 在 handler 入口仍判 token+回环；`GET` 405、无 token 404 用例全绿 | 两道闸各管一段 |
| `roles` 顺序断言是洁癖 | 主体要进审计链哈希；`['agent','customer']` 与 `['customer','agent']` 字节不同 | 保留 |

---

## 5 不声称（答辩时别说）

- **不声称"用户级票据归属已生效"**：参数已接，但上游视图还没 `userId`（AR-38）。
- **不声称"跨租户 404"**：跨租户在认证层就是 401，走不到资源层（03 §Z2 的诚实边界）。
- **不声称"HALT 的操作员可查"**：只覆盖了解冻（AR-39）。
- **不声称"`approval/actor` 等于放行"**：actor 是尝试，decided 才是结论（AR-40）。
- **不声称"新增代码覆盖率 100%"**：没跑 `pnpm check` / `test:coverage`。
