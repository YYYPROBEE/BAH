# 02 · 鉴权平面（AuthN）—— 对抗式复审（R3）

- 复审对象：本工作树交付的 02 实现（基线 `dc26952` = 01 的收工提交；02 由上一施工会话铺开、
  本会话补齐并修正），对照 `02-鉴权平面-AuthN.md` 与 `05-对抗式复审.md`
- 复审立场：**假定它是错的**——去找能证伪它的那一行代码、那一条 `curl`
- 结论：**14 条发现（P0×1 / P1×5 / P2×6 / P3×2），12 条已在本提交修复，2 条登记不改**；
  另有 5 条"怀疑过、但证伪了"的结论（它们同样是交付物）
- 关键事实：**P0 是靠真机探针抓到的，单测全绿也抓不到**（见 AR-15）

> 编号接 `05 §9` 的 R1/R2，从 **AR-15** 起（避开 R2 已用的 AR-01…09）。

---

## 1 复审方法

| 步 | 做法 | 目的 |
|---|---|---|
| 1 | 先跑红绿：`npx vitest run packages/host/src/boot/plugins/web` | 开局 5 红（contract×2 / auth×3），按红项反查实现 |
| 2 | 找**恒真判据**：删掉功能后这条用例还会绿吗 | TA-21-6 的 `p50 > 0` 就是 |
| 3 | 找**文档与代码的矛盾**：两份各自自洽、放一起打脸 | logout 的 `auth: web` vs "幂等 200" |
| 4 | 跑**真机探针**：临时把 `profiles/web/patch.yml` 改成 password（脚本可逐字节还原），
用 `curl` 打 15 组断言 | 单测的冻结时钟会掩盖时间相关缺陷（AR-15 就是这样） |
| 5 | 跑**真浏览器**：`browser-use` 驱动登录卡片五步（截图不可用，改用可访问性树 + DOM 断言） | TA-31 的验收本来就是"浏览器手动" |
| 6 | 每条发现要求三件套：位置（文件+符号）/ 证据（命令或原文）/ 修法 | "我觉得"不进正文 |

**没做**：`pnpm check`（含 `test:coverage` 的逐文件 100% 与全仓覆盖率）——它不在 02 的收工闸里，
本机跑一次要另起覆盖率口径。所以"新增代码的覆盖率"本文件**不声称**。

---

## 2 结论摘要

| ID | 级 | 一句话 | 处置 |
|---|---|---|---|
| **AR-15** | **P0** | 退避窗口**拒绝请求**：输错一次后 1 秒内改对，正确口令也被判 401（真机复现）；同时把"允许 5 次失败"压成 3 次 | 已修：只有 `locked()` 回 409；退避只回 `retry-after`；新增 TA-26-10 |
| AR-16 | P1 | TA-30-1 用**无 cookie** 的 `identify()` 调 `logout`，登出空转 ⇒ 用例红，且断言不是它声称的东西 | 已修：用登录返回的 sid 构造 cookie，先断言 `kind === 'principal'` |
| AR-17 | P1 | `logout` 的路由级别自相矛盾：文档写 `auth: web` + "无会话也 200"，两者不可兼得；实现选 `public`，契约用例仍按 2 条公开路由 ⇒ 红 | 已修：契约改 3 条 + 文档表由生成器重建 + 偏差 D-1 |
| AR-18 | P1 | TA-27 的验收用例**整组缺失**（两条 boot 冲突、session-auth 绑定） | 已补：auth-compat 5 例 + TA-27-0 + TA-27-6 |
| AR-19 | P1 | TA-28 的"password 模式首页不含 token"用例缺失 | 已补：`web.test.ts` 追加一例 |
| AR-20 | P1 | TA-31 未落地：没有 401 收敛、没有退出入口、没有登录卡片样式、SSE 401 会重连风暴 | 已修：401 事件 + 登录门 reload + 退出按钮 + CSS + SSE 探测 |
| AR-21 | P2 | A3 零回归被两处破坏：static 模式也注入 `bah-auth-mode`、也在磁盘建 `<租户根>/auth/` | 已修：两处都只在 `password` 生效 |
| AR-22 | P2 | `needsPrincipal()` 是死代码（只有导出，无消费者） | 已删 |
| AR-23 | P2 | `auth.cookie.name` 无字符集校验 ⇒ 配置注入（`bah_sid; Domain=evil` 拼进 `Set-Cookie`） | 已修 + TA-20-6 |
| AR-24 | P2 | TA-21-6 是恒真判据（`p50 > 0`）且名不副实（"千次"实为 5 次） | 已修：改为"真实校验 vs dummy 同量级（5 倍内）" |
| AR-25 | P2 | 文档缺口：`tenant-model.md` 没写合成服务主体、`audit.md` 没列 auth 类型、`security-design.md` 没登记已知限制 | 已补三处 |
| AR-26 | P2 | `snapshot-fresh` 对 `credentials/index.ts`（bindSession 加参）无覆盖声明 ⇒ 红 | 已加**精确路径**豁免（理由 + 背书面） |
| AR-27 | P3 | `/api/auth/me` 比契约多返回 `mode` 字段 | 登记不改（加法且前端要用） |
| AR-28 | P3 | `scripts/auth-hash.ts` 的入口判断含 `argv[1].includes('auth-hash')`（宽松匹配） | 登记不改（脚本级，误触发只会打印用法） |

---

## 3 逐条（证据 → 判定 → 修法）

### AR-15（P0）· 退避拒人：正确口令被判 401

**起始实现**（上一会话）：

```ts
const waits = [throttle.check(userKey, at), throttle.check(ipKey, at)].filter(...)
if (waits.length > 0) { … return { ok: false, code: 'web-login-locked', retryAfterSec } }
```

`check()` 在**退避窗口**（第 1 次失败后 1 s）里也返回非 null ⇒ 任何重试都被拒。后果有三层：

1. **正确口令被拒**：错一次 → 1 秒内改对 → 401（用户以为密码错）；
2. **"允许 5 次失败"失效**：脉冲式重试每次都被拒但仍计失败 ⇒ 第 3 次就 409；
3. `TA-26-2 / TA-26-3` 因此红（开局 5 红里的 3 条）。

**真机证据**（第一轮探针，旧代码）：

```
===== 6 登录成功 → 200 + 两个 Set-Cookie =====
HTTP/1.1 401 Unauthorized
{"error":{"code":"web-login-failed","reason":"账号或口令不正确"}}     ← 用 demo1234 登录失败
===== 14 连续 5 次错口令 =====
attempt1=401 attempt2=401 attempt3=409 attempt4=409 attempt5=409     ← 退避被当成锁定
```

**判定**：这是"照文档做也做错"的一类——文档只写了"锁定 → 409"，没写退避该回什么；
实现把两者混成一个分支。

**修法（已落地）**：

- `login` 只用 `throttle.locked()` 决定 409；**退避不再拒绝**，只在失败响应里回
  `retry-after`（"下次失败要多等一会儿"的提示）。
- 防爆破的牙齿改由两件事提供：`maxFailures=5` 的锁定，以及每次尝试都要付一次 scrypt。
  连续重试不再被"拒"，而是**继续计数**——5 次之后才 409。
- 新增 `TA-26-10 输错一次后立刻用正确口令 → 200`，把这条 P0 钉成回归用例。

**修后真机**（第二轮探针）：

```
===== 6 登录成功 ===== HTTP/1.1 200 OK（Set-Cookie ×2）
===== 14 ===== attempt1..5=401，attempt6=409，retry-after: 900
```

### AR-16（P1）· TA-30-1 的登出是空转

用例用 `runtime.identify(makeReq('GET','/api/session'), NOW)` 取身份——请求里**没有 cookie**，
所以 `identity.kind === 'anonymous'`，`logout()` 直接 `return false`，链上不会出现 `auth/logout`；
用例断言 3 条链条目 ⇒ 红。修好后这条用例才真的在验"登出落链"。

**修法**：用 `login()` 返回的 `session.sid` 构造 `cookie` 再 `identify`，并先断言
`identity.kind === 'principal'`、`logout()` 返回 `true`——把"空转"变成不可能通过。

### AR-17（P1）· `logout` 的路由级别与幂等要求打架

`02` 的表写 `POST /api/auth/logout | web | csrf | 200,401,403 | 幂等：无会话也 200`。
但 `web` 级别在 `dispatch` 里就是"匿名 → 401"，第二次登出永远到不了 200。实现选了
`public + CSRF`（防"跨站强制登出"靠 CSRF），于是：

- `contract.test.ts` 的"公开路由只有探活与登录"（2 条）红；
- `docs/web-frontend.md` 是**手改**的（`Bearer + CSRF` / `200,401,403`），与生成器输出不一致 ⇒ 红。

**修法**：保留 `public`（幂等的唯一自洽解），契约改 3 条并改用例名；文档表用
`scripts/web-routes.ts` 的输出**逐字**替换标记之间；偏差登记 D-1。

### AR-18 / AR-19（P1）· 两组验收用例根本没写

- TA-27 的 4 条验收（boot 冲突 ×2、session-auth 载荷、数据集校验）里，只有最后一条在
  `directory.test.ts`；**冲突校验与绑定用例全缺**。
- TA-28 的"password 首页不含 token"缺；`web.test.ts` 只有 static 模式的旧断言。

**修法**：新增 `packages/host/src/boot/auth-compat.test.ts`（5 例）、`handlers/auth.test.ts`
的 TA-27-0（onLogin → `bindSession(…, 'session-auth')`，失败不绑）、`bank-tools.test.ts` 的
TA-27-6（真实 `bindSession` → `identity/bound` 载荷 `method: session-auth` 且工具放行）、
`web.test.ts` 的 password 模式首页用例（不含 token、含 `bah-auth-mode`、下发 CSRF cookie）。

### AR-20（P1）· TA-31 只有"启动时门"，没有"运行中收敛"

起始实现只有 `bootstrapPasswordGate` 的启动判断。缺三样：

1. **任何 API 401 回登录卡片**——`createHttpApi` 把 401 当普通失败，界面只会弹一条 toast；
2. **退出登录入口**——`auth.js` 有 `logout()`，但没有任何按钮调用它（"退出"这一步做不出来）；
3. **SSE 401 重连风暴**——`EventSource` 拿不到状态码，会每几秒自动重连一次。

**修法**：`transport.js` 对 401 派发 `bah:unauthorized`；`bootstrapPasswordGate` 监听并
`location.reload()`（挂载后的 SSE/定时器都持有匿名闭包，原地换 DOM 会留下"假登录卡片"）；
`connectEvents` 在 error 时用一次 `/api/auth/me` 探测，401 就 `close()` 再派发；
`main.js` 在 password 模式加"退出"按钮；`app.css` 补登录卡片样式（全部用 DS 令牌，零十六进制色值）。

**真浏览器证据**（`browser-use`，面板不可见故无截图，用可访问性树 + DOM）：

```
登录卡片：textbox 客户号 / textbox 口令 / button 登录（截图：NATIVE_BROWSER_VIEWPORT_UNAVAILABLE 0x0）
错口令 → {"message":"账号或口令不正确","userIdValue":"u-1","passwordValue":"wrong","stillLoginCard":true}
对的口令 → {"hasComposer":true,"hasLoginCard":false,"statusDot":"app-header__status is-online","logoutButton":["退出"]}
撤销会话后发消息 → 页面自动 reload → {"hasLoginCard":true,"hasComposer":false}
退出按钮 → 登录卡片；刷新 → {"afterReloadLoginCard":true,"metaToken":false,"metaMode":"password"}
```

### AR-21（P2）· A3 零回归被两处悄悄破坏

A3 的硬门槛是"不写 auth 配置时一字不变"。起始实现有两处副作用：

1. `handlers/static.ts` 对所有模式都注入 `<meta name="bah-auth-mode" content="static">`
   ⇒ static 模式的 `index.html` 字节变了；
2. `auth/wire.ts` 对所有模式都构造 `logPath` ⇒ `createSessionStore` 在 static 启动时
   就 `mkdir <租户根>/auth/`（空目录落盘）。

**修法**：meta 只在 `password` 注入；`logPath` 只在 `password` 传。static/none 的前端启动路径
与磁盘行为与改动前逐字一致。

### AR-22 / AR-23 / AR-24（P2）

| ID | 证据 | 修法 |
|---|---|---|
| AR-22 | `grep -rn "needsPrincipal" packages/*/src` 只有定义与 re-export | 删函数与导出行 |
| AR-23 | `resolveAuthSettings` 只要求 `cookie.name` 非空；`Set-Cookie` 直接拼接 ⇒ 配置注入 | 加 `^[A-Za-z0-9_-]{1,64}$` + TA-20-6（分号/空格/`=`/空串） |
| AR-24 | `expect(p50).toBeGreaterThan(0)` 在计时器坏掉时也绿；用例名"千次"实为 5 次 | 改为真实 vs dummy **同量级**（比值 < 5），并断言下界 > 1ms、上界 < 2s；改名 |

### AR-25 / AR-26（P2）· 文档与派生面

- `docs/contracts/tenant-model.md` §3 补"合成服务主体不含 admin"（02 §2.1 要求）；
- `docs/audit.md` 的会话链条目补四类 `auth/*`（并注明失败条目只存 `userIdHash`）；
- `docs/security-design.md` §4 补充登记：idle 从签发时刻重算、节流不落盘、
  会话日志是凭据面且无轮转、cookie 未用 `__Host-` 前缀；
- `verify-snapshot-fresh.ts` 的 `EXEMPT` 加一条**精确路径**：`credentials/index.ts`
  （只给 `bindSession` 加可选参；快照场景走 `demoUserId` 直绑，永远不调用它），
  背书面是 `bank-tools.test.ts` 的 T-IDN-002 / TA-27-6。

### AR-27 / AR-28（P3，登记不改）

- `/api/auth/me` 返回 `{ tenant, userId, roles, expiresAt, mode }`——契约只写前四个。
  多出的 `mode` 是加法，且前端要靠它区分"static 的合成主体"与"真实登录"；
- `scripts/auth-hash.ts` 的入口判断包含 `argv[1].includes('auth-hash')`：宽松，但脚本误触发
  只会打印用法并以 2 退出，不会写任何东西。

---

## 4 怀疑过、但证伪了（同样是交付物）

| # | 怀疑 | 怎么证伪 |
|---|---|---|
| 1 | password 模式仍接受 `?token=`（缺口 3 没堵） | 真机 `GET /api/events?token=xxx` → **401**；`TA-28-1` 同结论 |
| 2 | 认证事实被写进会话事件表（撞 19 键冻结） | 登录后 `session.jsonl` 里只有 `identity/bound`；四类 `auth/*` 在 `audit.jsonl`（链） |
| 3 | 明文口令进审计链 / 日志 / 回包 | `grep -c 'demo1234' audit.jsonl` = **0**；`grep 'password'` 链 0；登录回包无 `sid`/口令 |
| 4 | `identify()` 遇畸形 cookie 会抛 ⇒ 500 可被探测 | 实现 `try/catch` 全包，`TA-24-3` 坏 cookie → `anonymous`；真机 `?token=`、坏 cookie 均 401 不是 500 |
| 5 | 会话日志会被当成会话事件重放给模型 | 日志在 `<租户根>/auth/sessions.jsonl`，与 `<sessionId>/` 同级；`JsonlPersistence.list` 跳过
没有 `session.*.jsonl` 的目录（01 已核）；真机 `bah audit` 把 `auth/` 与会话链分开扫 |

---

## 5 "明确不声称"（02 部分，接 05 §5）

1. 不声称"渠道级 MFA"——强验证仍在票据级（`verify-gateway`）；
2. 不声称"角色权限矩阵已生效"——`roles` 落进了 `Principal`，但判定在 03；
3. 不声称"防住子域 cookie tossing"——默认名没有 `__Host-` 前缀（已登记为生产项）；
4. 不声称"节流不可绕过"——重启清零（可用性事件，代价不对等）；
5. 不声称"覆盖了 OIDC/SSO"——只留了能力位。

---

## 6 一句话结论

02 的 `DONE-WITH-DEVIATION`：五道闸全绿、真机 15 组探针与浏览器 5 步全过、偏差 13 条已登记；
但**"单测全绿"没能发现 P0**——退避拒人是被真机 `curl` 抓到的。这正是 05 §3 第 3 条
（"找不可达/错位的防线"）在 02 上的对应物：**冻结时钟的测试不能替代带时间的真机探针**。
