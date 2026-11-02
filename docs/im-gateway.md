# IM 网关（通用网关 + 微信适配器 + 审批 / 接管）

> 设计/ 03 的对外口径页。数字以 `facts.md` 为准；本文不重复门禁数与用例数。

## 1. 分层

```
微信用户 ──HTTPS──▶ apps/im-gateway（公网 0.0.0.0:8080）
                      │  /healthz                （只给数量）
                      │  /im/:platform/:accountKey
                      │  /a/:token（H5 审批页）  /assets/approve.*
                      │  /seat/*（运营桥；未配 token 一律 404）
                      │  registry（PlatformAdapter）
                      ▼
                   session/supervisor（每用户一子进程）
                      │  spawn: node --import tsx packages/cli/src/main.ts
                      │          --profile im --session <key> --patch <overlay> --jsonl <dir> --serve
                      ▼
                   子进程（channel:im，127.0.0.1:随机端口）
                      │  /api/health（公开）
                      │  /m.html（下发 bah_csrf）
                      │  /api/events（SSE：per-turn + 常驻各一条）
                      │  /api/turn（Bearer + CSRF）
                      │  /api/approval/:id  /api/verify/:id（客户凭证）
                      │  /api/handoff[/claim|message|heartbeat|resume|queue]（客户 / 坐席凭证）
                      ▼
                   宿主（模型 / 工具 / 审批 / 会话日志）
```

硬约束：

- 网关只认 `PlatformAdapter`（`packages/channels/src/im/platform.ts` 是唯一契约定义点，门禁 G13）；
- `server.ts` 不 import 任何平台实现（门禁 G10）；
- 子进程只听 `127.0.0.1`，网关**不**反代 `/api/*`（门禁 G5）；
- 生产注册表只含 `wechat`（门禁 G11），没有任何打开 Mock 的开关（门禁 G12）。
- 审批结论只在子进程：网关只转发与翻译，**不**自行判定过期或代填 `unavailable`。

## 2. 路由

| 路由 | 方法 | 行为 |
|---|---|---|
| `/healthz` | GET/HEAD | `{ ok, platforms, children, uptimeSec }`（只有数量，无账号/用户/票据） |
| `/im/:platform/:accountKey` | GET/POST | 注册表分派；未知平台/账号 → `404 im-unknown-platform` |
| `/a/:token` | GET | H5 审批页（签名 + 过期 + 一次性）；CSP `default-src 'none'` |
| `/a/:token` | POST | `{decision:'allowed-once'|'rejected', reason?}` → 子进程 `/api/approval/:id` |
| `/a/:token/verify` | POST | 转发子进程 `/api/verify/:id`（红级强验证） |
| `/assets/approve.css` / `.js` | GET | H5 自包含资源（白名单两个文件） |
| `/seat/sessions` | GET | 网关内存列表（sessionKey/platform/lastSeen/handoffActive/pendingCount） |
| `/seat/:sessionKey/handoff` | GET | 转发 `GET /api/handoff` |
| `/seat/:sessionKey/handoff/{claim,message,heartbeat,resume}` | POST | 转发同名子进程路由 |
| `/seat/:sessionKey/handoff/queue` | GET | 转发 `GET /api/handoff/queue` |
| 其它 | 任意 | `404 im-not-found` |

`/seat/*` 的顺序：**未配 `BAH_IM_OPERATOR_TOKEN` → 一律 404（先于方法/路径判定）**；
配了但请求头 `x-bah-operator-token` 缺失/不符 → 401（常量时间比较）；对 token 才转发白名单路径。

平台回调的错误形态：

| 场景 | 状态 | 体 |
|---|---|---|
| 验签失败 | 401 | `invalid signature`（不回显期望值） |
| GET 无 `echostr` | 400 | `{ error: { code: 'im-challenge-missing' } }` |
| XML 含 DOCTYPE/ENTITY/stylesheet/script | 400 | `{ error: { code: 'im-xml-rejected' } }` |
| XML 超 16 KiB | 413 | `{ error: { code: 'im-xml-too-large' } }` |
| 请求体超 64 KiB | 413 | `{ error: { code: 'im-body-too-large' } }` |
| 事件/非文本消息 | 200 | `success`（不跑 turn） |

## 3. 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `BAH_IM_SESSION_SALT` | 是 | — | ≥16 字符；`(platform,userId) → sessionKey` 的 HMAC 盐 |
| `BAH_IM_HOST` | 否 | `0.0.0.0` | 公网监听地址（反代后可改 `127.0.0.1`） |
| `BAH_IM_PORT` | 否 | `8080` | 公网监听端口 |
| `BAH_IM_PUBLIC_BASE_URL` | 否 | — | H5 审批链接前缀；设了就必须是 `https://`（本地联调允许 `http://127.0.0.1`），未设则省略 H5 行、文本指令仍可用 |
| `BAH_IM_ROOT` | 否 | `process.cwd()` | 仓库根（子进程、profiles、sessions 的定位） |
| `BAH_IM_PROFILE` | 否 | `im` | 子进程 profile |
| `BAH_IM_CHILD_ENTRY` | 否 | `packages/cli/src/main.ts` | 子进程入口 |
| `BAH_IM_CHILD_NODE` | 否 | `process.execPath` | 子进程 Node |
| `BAH_IM_CHILD_LOADER` | 否 | `tsx` | `tsx` = `node --import tsx`；`none` = 跑已编译入口 |
| `BAH_IM_JSONL_BASE` | 否 | `<root>/sessions/im` | 每用户 `--jsonl` 目录的父目录 |
| `BAH_IM_MAX_CHILDREN` | 否 | `8` | 同时存活子进程上限 |
| `BAH_IM_IDLE_TTL_MS` | 否 | `1800000` | 闲置回收阈值 |
| `BAH_IM_CHILD_TIMEOUT_MS` | 否 | `15000` | health 就绪超时 |
| `BAH_IM_PUSH_MODE` | 否 | `auto` | `auto` / `passive` / `push` / `pull` |
| `BAH_IM_PASSIVE_WAIT_MS` | 否 | `4000` | 等首个消息的上限（必须 < 5 秒窗口） |
| `BAH_IM_UNTRUSTED_USERS` | 否 | 空 | 逗号分隔 `platform:userId`；非法元素启动失败 |
| `BAH_IM_LOG` | 否 | `info` | `debug|info|warn|error` |
| `BAH_WECHAT_APPID` | 是 | — | 测试号 AppID |
| `BAH_WECHAT_SECRET` | 是 | — | AppSecret（只用于换 `access_token`） |
| `BAH_WECHAT_TOKEN` | 是 | — | 回调验签 token |
| `BAH_WECHAT_ACCOUNT_KEY` | 否 | `default` | 路由里的 `:accountKey` |
| `BAH_WECHAT_API_BASE` | 否 | `https://api.weixin.qq.com` | 测试注入假 API |
| `BAH_IM_LINK_SECRET` | 是 | — | H5 链接 HMAC 密钥（≥32 字符） |
| `BAH_IM_OPERATOR_TOKEN` | 否 | — | 公网运营桥 token；未配 → `/seat/*` 一律 404 |
| `BAH_OPERATOR_NAME` | 否 | `坐席` | 网关注入子进程的坐席显示名（进审计与气泡，不是凭证） |

## 4. 一轮消息的生命周期

1. **限流**（每用户 20/分钟 + 全局 200/分钟，固定窗口）；
2. **去重**（`platform + accountKey + msgId`；无 msgId 用 `sha256(userId|at|text)`；LRU 10k / TTL 10 分钟）；
3. **文本指令**（`parseImCommand`，命中才走指令面）：
   - `0` → 拉取缓存最新一条（不启动子进程）；
   - `1 [票号]` / `2 [票号] 理由` / `3 [票号]` / `4 [票号]` → 审批（见 §4.1）；
   - `转人工 [理由]` → 子进程 `POST /api/handoff`；
4. **untrusted**：命中 `platform:userId` 名单或 `【转发】` 开头 → 加 `⟦UNTRUSTED:im⟧` 前缀；
5. **确保子进程**（`supervisor.ensure`；同用户复用；超过上限且无可回收 → 503 语义回「当前咨询人数较多」）；
6. **订阅 SSE** → `POST /api/turn`（Bearer + `x-bah-csrf` + cookie）；
7. **投递**（`deliverTurn`，能力驱动）：

| 模式 | 行为 |
|---|---|
| `auto` | 等首个 `assistant/message` 最多 `BAH_IM_PASSIVE_WAIT_MS`；等到 → 被动回复；等不到 → ack + 后台 push |
| `passive` | 只用被动回复；结果未就绪 → ack + 缓存，用户发 `0` 取回 |
| `push` | ack 走被动回复；结果只走客服消息 |
| `pull` | 全部「回复 0 获取最新结果」，不调 push |

能力降级：`asyncPush=false` → `auto/push` 退化为 `passive` + 拉取；`passiveReply=false` →
只能 push（两者都为 false 时启动期 fail-loud）。

### 4.1 审批与接管

- 每条会话有一条**常驻 SSE**（与 per-turn 订阅并行）：快照重建待审批与接管状态，
  增量 `approval` / `approval-closed` / `handoff` / 坐席 `message` 由它主动推送；
  助手消息在 turn 进行中交给 per-turn 投递，turn 结束后由常驻订阅补发（避免重复）。
- 待审批：`approval` 入表（同票更新、`verified` 保留）；`approval-closed` 出表并推送结果；
  `unavailable` 按**拒绝**处理（文案明确写"已过期"）。
- 文本指令：多于一张票必须带票号；红级未验证先提示 `4`（防误触；最终裁决仍在子进程）；
  **没有待审批时 `1`/`2`/`4` 不作为审批指令**，按普通消息交还给对话
  （`1` 也可能是在回答模型的 `prompt_ask` 选择题；D0 真机实测踩到过）。
- H5：`/a/:token` = `base64url(JSON) + '.' + HMAC-SHA256`；`e = min(票据 TTL, now+5min)`；
  POST 合法提交才消费（空理由 / 红级拦截不烧链接）；一次性记录 TTL 10 分钟。
- 运营桥：`/seat/*` 用**子进程自己的** operator token + CSRF 转发，公网 token 不下发子进程；
  未配公网 token 一律 404；错 token 401；响应原样回传状态码与 JSON。
- 日志：审批/运营面只记 sessionKey / ticketId / code / 理由长度，**不记理由原文**（门禁 G15）。

## 5. 与设计的偏差（如实登记）

| # | 偏差 | 理由 |
|---|---|---|
| 1 | `createRegistry(adapters, accounts?)` 增加第二参数 | `PlatformAdapter` 契约里没有 `accountKey`（契约平台无关）；账号清单由装配注入，缺省 `default` |
| 2 | `2` / `拒绝` 只给票号、不给理由时**不识别为指令** | 01 的 `parseImCommand` 明确"宁可不识别，也不默认拒绝"；网关不写第二份解析器（H5 的空理由仍回 400 `reason-required`） |
| 3 | D0 真机探针**未执行** | Q1 的测试号凭据与公网域名尚未提供；Mock + 假微信 API 已自动化验证（见 `docs/wechat-setup.md` §D0.5） |
| 4 | `apps/im-gateway` 不进覆盖率强制名单 | `COVERAGE_ALLOWLIST` 只认 `packages/*`；网关的判决密集面在 `channels/im/**`（已逐文件 100%），apps 面由 `apps/im-gateway/{src,test}` 用例守 |
| 5 | 新增日志码 `im-gateway-start` | §2.15 的表没有"网关启动"事件；没有它，部署排障只能靠进程退出码 |
| 6 | 订阅 SSE 后最多等 500ms 连接建立 | turn 一入队就可能产帧；先 turn 后订阅会丢第一条回复。500ms 远小于 5 秒窗口 |
| 7 | 崩溃重启上限按"首次启动后 10 分钟内 ≤3 次" | §2.11 的原文；重启窗口以 `firstStartAt` 为起点，不随重启重置 |
| 8 | 就绪探针文件名是 `ready.ts`（原设计写 `handshake.ts`） | 说明符 `'./handshake.ts'` 含子串 `dsh`，会被既有门禁 `verify-no-upstream-imports` 的正则误判为"指向上游源码"；改名是零语义的规避，接口名仍叫 `HandshakeDeps` |
| 9 | 宿主 `WebDeps` 拆出 `seatApiEnabled` | 原 `seatEnabled` 同时管 `/operator` 页面与 5 条坐席 API，且只对 `channel:web` 为真；IM 子进程没有坐席 UI，但运营桥必须转发坐席动作——绑成一个布尔会让"没页面就不能有 API" |
| 10 | 03 新增 `session/hub.ts` / `handoff/bridge.ts` / `approval/texts.ts`（设计文件清单未列） | 审批/接管需要**常驻 SSE**与跨轮状态；塞进 `bridge/outbound.ts` 会把"一轮投递"与"会话运行态"混成一份闭包，测试也无法只测其中一半 |
| 11 | 两条门禁编号顺延为 **G14 / G15** | 既有门禁已占用 G10–G13（server import / Mock / Mock 开关 / 契约定义点）；复用编号会让负控表指向两条不同的判据 |
| 12 | 新增 `BAH_OPERATOR_NAME`（设计文件未列） | 网关注入子进程的坐席显示名是部署项；写死"坐席"会让多坐席部署在 IM 气泡里无法区分（显示名不是凭证） |
| 13 | H5 一次性在"解析成功且通过红级前置"之后才 claim | 先 claim 会让"空理由 / 红级未验证"这类可修正的提交烧掉链接（T-H5-002 会变成 409）；claim 放在转发前仍能挡住并发双击 |
| 14 | 无待审批时裸 `1`/`2`/`4` 不拦截，按普通消息送模型 | D0 真机发现：转账缺收款人时模型用 `prompt_ask` 给候选，用户回 `1` 被网关当成审批指令，回"当前没有待审批"，选择题答不下去。有票时审批优先；无票时交还对话题 |
| 15 | `choice` 帧投影为文本（问题 + 候选，**不编号**） | 01 的投影层把 `choice` 当"表外帧"丢弃，IM 用户只看到模型另发的一句「请选择一下」，**看不到候选**（D0 真机实测）。不编号是因为宿主回填走 label 而非序号，给序号会制造"回复 1 就能选中"的假承诺 |

## 6. 验收命令

```bash
pnpm typecheck                                   # 0 error
pnpm test -- apps/im-gateway packages/channels   # 网关 + 渠道
pnpm test:coverage                               # channels/im 逐文件 100%
pnpm gate                                        # 含 verify-im-gateway（G1–G15）
```

负控（逐条实跑并还原）：

| # | 注入 | 期望 |
|---|---|---|
| G1 | 在 `config.ts` 写一个形如真实 AppID 的字面量 | `verify-im-gateway` 红 |
| G2 | 把 `timingSafeEqual` 改成 `===` | 红 |
| G3 | 删掉 `DOCTYPE` 拒绝分支 | 红 |
| G5 | overlay 的 `host` 改成 `0.0.0.0` | 红 |
| G6 | 删掉 `server.ts` 的 `seatEnabled` 404 分支 | 红 |
| G7 | 在 `log.warn` 里带 `userId` | 红 |
| G9 | 在 `approve.html` 加一个 `<script>…</script>` 内联脚本 | 红 |
| G10 | `server.ts` import 微信 XML 解析 | 红 |
| G11 | `main.ts` 注册 mock | 红 |
| G13 | 在 apps 里复制 `PlatformAdapter` 接口 | 红 |
| G14 | 把 `link-token.ts` 的 `timingSafeEqual` 改成 `===` | 红 |
| G15 | 在 `approval/*` 的日志调用里加 `reason:` | 红 |

## 7. 已知边界

- 去重窗口在进程内，网关重启即丢（微信只重试 3 次，不承诺跨重启幂等）；
- 子进程崩溃 10 分钟内 3 次后 `disabled`，用户收到「系统繁忙」；
- 单账号部署（`accountKey` 只有 `default`）；多账号属同一适配器的不同实例，本期不做；
- 不做公众号安全模式（AES）、模板消息、图文素材、菜单、支付、群聊、图片/语音；
- 不做第二个真机平台（飞书/企业微信/钉钉）；`PlatformAdapter` 已为其留好缝。
- 待审批与接管状态在**网关内存**：子进程被回收时状态随之清掉；网关重启不补发历史，
  未决票据在子进程仍存活且用户发指令时仍可操作。
- 常驻 SSE 断开后不自动重连：下一次入站会重新 attach 并按快照重建；断线窗口内的
  `approval-closed` / 坐席发言可能丢推送（审计仍在子进程）。
- H5 页面只渲染网关内存里的票据摘要；票据已处理 / 状态未知时只显示提示，不再给按钮。
- 运营桥不提供 CORS、不反代任意 `/api/*`；`/seat/sessions` 不含平台用户标识。
