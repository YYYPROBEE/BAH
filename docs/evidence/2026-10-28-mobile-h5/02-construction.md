# 02 · 移动 H5 壳与交互面 —— 施工记录（2026-10-29）

> 依据：`BAH-移动H5与跨场景施工方案-2026-10-28/00-全局约定.md` + `02-移动H5壳与交互面.md`。
> 基线：HEAD `04de7f1`（01 单复审签收）。本单只动自己的文件面（`apps/web/*` 新增 + `scripts/` 两处 + 台账），
> **共享层与 `packages/**` 一行未改**（理由见 §4.1）。

---

## 0. 结论摘要（全部为 2026-10-29 实测）

| 项 | 实测 | 命令 / 证据 |
|---|---|---|
| `pnpm test:web` | **22 文件 / 333 用例 全绿**（新增 10 文件 / 194 例；桌面 12/139 零回归） | `02-test-web.txt` |
| `pnpm gate` | **45 项，43 绿 / 2 红**（两条均为并行「可观测性」线的继承红） | `02-gate-after.txt` |
| 新门禁 `verify-mobile-shell` | **绿**，11 条不变量；**27 条负控逐条被抓** | `02-gate-negative-controls.txt` |
| `pnpm typecheck` | 通过（host + client + scripts 三套） | §6 |
| `pnpm lint` | 通过 | §6 |
| 共享层改动 | **0 行** | `git status --porcelain apps/web/src/{transport,store,dom,main}.js apps/web/src/views apps/web/styles/app.css` 为空 |

继承基线红项（**不属本单，未修，未替别人 `git add`**）：

| 门禁 | 原因 | 归属 |
|---|---|---|
| `assertions` | `packages/cli/src/cli/observe-http.test.ts` 新增 24 条断言未登记基线 | 并行「可观测性」线 |
| `tracked-sources` | 同一文件未 `git add` | 同上 |

---

## 1. 基线（S1，2026-10-29 开工实测）

```
HEAD            04de7f1  docs(evidence): 01 单对抗式审查报告与证据校验和
工作树          48 项未提交改动，全部属并行「可观测性」线（apps/web/src/{main,store,transport,observability}.js、
                views/*、styles/app.css、docs/*、scripts/verify-{audit-cli,docs-consistency}.ts、新增 cli 观测命令）
门禁数          44（ls scripts/verify-*.ts | wc -l）
pnpm gate       2/44 红：assertions + tracked-sources（均为上面那个未 git add 的 cli 测试文件）
pnpm test:web   12 文件 / 139 用例（方案文档写的 55 早已过时；ci.ts 的 web 地板当时仍是 54）
```

> 完整输出见 `02-baseline.txt`、`02-baseline-testweb.txt`。

---

## 2. 交付清单

### 2.1 新增

| 文件 | 行数 | 职责 |
|---|---|---|
| `apps/web/m.html` | 52 | 移动静态壳：三份外链样式 + 唯一 ESM 入口；无 token 占位 meta（§4.2） |
| `apps/web/src/mobile/shell.js` | 543 | 装配根：能力位读取、帧路由 `dispatchFrame`、重连退避、delta 重放过滤 |
| `apps/web/src/mobile/layout.js` | 146 | 三区骨架、visualViewport 键盘避让、状态与会话文案 |
| `apps/web/src/mobile/approval-sheet.js` | 700 | 底部抽屉审批：字段集对齐 `ApprovalFrame`、状态机、半途关闭零 decision、逾期、提醒条 |
| `apps/web/src/mobile/gesture-confirm.js` | 378 | 滑动确认：`reducePointerEvents` 纯函数 + DOM 翻译层 + 键盘等价 + 播报节流 + D11 三句话 |
| `apps/web/src/mobile/ime-input.js` | 172 | IME 适配层：输入框属性、组合态状态机、一行可关提示 |
| `apps/web/src/mobile/quick-phrases.js` | 51 | 快捷短语 chips（文案由 shell 注入） |
| `apps/web/src/mobile/plan-steps.js` | 350 | DAG → 9 态单列分步清单；blocked 显式；goal/todo 渲染位；复用桌面 `renderTool` |
| `apps/web/src/mobile/choice-card.js` | 130 | 选择题卡片：点选 = 一条用户消息（D6） |
| `apps/web/src/mobile/effects-list.js` | 97 | 只读"已发生操作"清单 |
| `apps/web/src/mobile/composer.js` | 253 | 输入区：发送/中断/自增高/429 倒计时/409 文案 |
| `apps/web/src/mobile/*.test.js` ×10 | 1,948 | TC-MOB-01..30（194 例） |
| `apps/web/styles/mobile.css` | 963 | 页面局部样式（零裸色值、blanket 44×44、安全区、动效三时长、reduced-motion） |
| `apps/web/assets/icons/{microphone,chat,Lock,chevron_down_large,warning-fill}.svg` | — | design 侧逐字节复制（sha256 双向一致） |
| `scripts/verify-mobile-shell.ts` | 468 | 新门禁（I1–I11） |

### 2.2 修改

| 文件 | 改动 | 理由 |
|---|---|---|
| `scripts/verify-web.ts` | 第 ④ 条扫描面 `app.css` → `styles/*.css`（排除 `ds/`），判定正则未改 | E10 |
| `scripts/ci.ts` | `test:web` 的 `minCases` 54 → **332**（实测 333） | 00 §6.2 地板铁律 |
| `profiles/mobile/patch.yml` | `entry: index.html` → **`m.html`**；`entries: [m.html, index.html]` | 兑 01 单留的显式待办 |
| `facts.md` | 门禁 `44/44` → `45/45`；`test:web` 12/139 → 22/333；§3 新增"入口 ↔ 渠道"表 | 00 §8 |
| `docs/facts-sources.md` | 机器块 `gates=44` → `45`；门禁演进史追加本门禁 | 00 §8（先改来源） |
| `docs/architecture.md`、`docs/algorithms.md`、`docs/security-design.md` | **只由 `gen-architecture.ts` 重写生成块**（44 项 → 45 项），手改 0 行 | 00 §6.1 |
| `docs/testing.md` | 前端 12/139 → 22/333；新增 §1.1「移动壳」测试面与桩纪律 | 00 §8 |
| `README.md` | 门禁 45/45；前端 22/333；新增「移动 H5 的能力边界（如实口径）」节 | E6 / D10 / D11 |
| `docs/security-self-assessment.md` | 最后核实行：44/44 → 45/45、前端 139 → 333 例 | 口径一致 |
| `PROGRESS.md` | 追加 §96.36（只追加，不改历史数字） | 00 §8 |

---

## 3. 逐条回填：方案文档的 7 处「待核」

方案文档末尾自列 7 处待核，要求"全部必须在 S1 处置并回填"。逐条结论如下（每条都给了代码出处）。

| # | 文档原假设 | 代码实测 | 处置 |
|---|---|---|---|
| 1 | 能力位从 `GET /api/session` 下发，**响应字段名待核** | `handlers/session.ts:43` 返回 `{ sessionId, lastSeq, capabilities }`，`capabilities` 是 10 字段全量 | `shell.js` 的 `loadSession()` 直接读 `data.capabilities`；**`TODO(01)` 已删除**（不再是待办） |
| 2 | m.html 要写 `<meta name="bah-web-token">` 占位，**占位符名待核** | `web-auth.ts` 的 `injectWebToken` 是"先剥离同名 meta 再在 `</head>` 前插入"，**不用占位符**；`index.html` 也没有占位 meta；开工时全仓该占位符串命中 **0** | **m.html 不写占位 meta**，与 index.html 逐字同构；门禁 I10 反向钉死"可执行/配置面（HTML/JS/配置）里该占位符必须零命中"（写了就等于把假 token 字面量交出去；`.md` 里引用这条规则本身不算违规） |
| 3 | `choice` 帧附加字段名待核 | `frames.ts:265-287` 已定义：`{ callId, prompt, options[{id,label,hint?}], allowFreeText: true }`，刻意无 `ticketId` | `choice-card.js` 按此消费；`submit(选项文本)` 走 `POST /api/turn` |
| 4 | `todo` 帧 items 字段名待核 | `frames.ts:312-343`：`{ turn, planId, items[{id,text,done,code?,blockedBy?,tone}], openCount }` | `plan-steps.setTodos()` 只读渲染；勾选交互留给 04 |
| 5 | n/m 计数口径与 04 对齐，待核 | 文档口径 = `succeeded + skipped + cancelled`，但帧里没有 `succeeded` | 实现为 `countSettled()` = `ok + skipped + cancelled`（**实名修正**）；`denied/failed/incident` 不计入"已了结推进"，并在函数注释标明这是与 04 的对齐点 |
| 6 | S15 真机可得性待核 | 本机为无头施工环境（无可见浏览器/真机） | 走查 15 条按方案 §7 的「无头验收」路径处置：有 TC 对应的 12 条以 TC 全绿替代，①②③（纯视觉/视口）延后到 04 彩排前，见 §8 |
| 7 | `verify-no-hardcoded-config` 是否扫 `apps/web`，UI 常量 0.85/600ms 是否豁免 | 该门禁 `SCAN_DIRS = ['packages/safety/src']`，**不扫前端** | 即便不受门禁管，阈值仍收进 `GESTURE_DEFAULTS` 缺省值表（可覆盖），不让 0.85/600 散落在逻辑里 |

---

## 4. 偏差登记（方案文档 §9 之外的补充；§9.1–§9.5 的既有条目照办）

### 4.1 共享层零改动：`transport.js` / `store.js` 的预判扩展都没做

方案 §3.0 预判两处"只增不改"的共享层扩展：`connectEvents` 加 `onReconnect`/`reconnect`，`store.frameKey` 加四个新帧 case。**两处都没做**，理由：

1. 这两个文件正被并行「可观测性」线改写（`M` 状态）。只要我 `git add` 它们，就会把别人未完成的活一起提交——00 §10 明令禁止，且这是共享工作树里最危险的一类事故（`verify-tracked-sources` 会把它判成"未跟踪源码"，一次报 8 条假红）。
2. 不改也能满足需求：
   - **重连**改由 shell 层调度（`backoffDelayMs` + `scheduleReconnect`）。这不是第二份传输实现——它只调用共享的 `connectEvents` 工厂并决定"什么时候再连一次"。`maxRetries: 0` 把重连权收归 shell（该字段在 HEAD 版本里被忽略，此时 shell 的 close-then-open 依然只留一条连接，两种版本都已核过）。
   - **四新帧的键控替换**没有实现，但也不缺：本单对 goal/todo/effects/choice 一律"取最新一帧"（与桌面 `main.js` 对 `dag` 的处理同款），不依赖 store 的替换语义。`dag`/`approval` 的替换语义沿用既有 `frameKey`，TC-MOB-25 因此仍然成立。
3. 交接：`store.js` 的四新帧 case 留给 03/04 单，与并行线对齐后统一加（已写进 handoff）。

### 4.2 m.html 不写 token 占位 meta（E1 的"占位"作废）

见 §3 第 2 条。E1 原文要求"`<meta name="bah-web-token">` 占位"，与注入器实现冲突；照 §3 的"以注入器为准"回填为**不写**。对外可验判据升级为门禁 I10 的反向断言：`__BAH_WEB_TOKEN__` 全仓零命中。

### 4.3 `handlers.decide/verify` 的签名：直接接 `api.decide(ticketId, decision, reason)`

方案 §3.4 写的是 `handlers.decide(ticketId, {type:'approve'}|{type:'reject',reason})`。实现改为与 `transport.js` **同一套 decision 字面量**（`allowed-once` / `rejected`），由 shell 的 `uiErrorOf()` 把 `{ok,status,code,reason}` 归一化成 `{ok,code,message,retryAfterSeconds?}`。

理由：`{type:'approve'}` 这层包装在 shell 里要再翻译回 transport 的字面量，等于在前端维持第二份结论方言；`decision` 是**冻结语义**（`ApprovalDecision` 四值），多一层映射只会漂。

`verify` 同理只传 `ticketId`：挑战渠道由服务端按票据决定，前端只呈现 `frame.challenge`，传 challenge 反而给了前端"指定验证方式"的假权力。

### 4.4 `needsChallenge` 的判据是 `frame.challenge !== undefined`，不是 `tier === 'red'`

TC-MOB-07 写的是"tier=red ⇒ 先 verify"。实现按 **`challenge` 是否存在**判（与桌面 `views/approval.js` 同口径）：`tier` 是风险级别，`challenge` 才是"这张票要不要强验证"的载荷。红级票据若没有 challenge，逼前端去 verify 只会拿到 `no-challenge` 400。

TC-MOB-07 的夹具因此用 `{tier:'red', challenge:'ushield'}`（既有红级、又有挑战），断言语义不变。

### 4.5 不做"下滑关闭抽屉"

方案 §3.4 状态机列了"ESC / 背景点击 / **下滑关闭**"。实现只做前两个 + 关闭钮：下滑关闭要引入第二套手势判定（纵向位移阈值），与 `reducePointerEvents` 的横向行程语义不同，会让"半途关闭零 decision"这条不变量出现两个实现。三个显式出口已覆盖该不变量的全部测试面（TC-MOB-05 三分支）。

### 4.6 `setSendBlocked(seconds, …)` 而不是 `(ms, …)`

HTTP `retry-after` 与界面文案（"请 N 秒后再试"）都以秒为单位；转成毫秒再除回来只是噪音。参数语义已在函数注释与用例里固定。

### 4.7 抽屉入场用 200ms 定时器驱动 `opening → open`，不用 `transitionend`

方案 R5 已预警"reduced-motion 下 `transitionend` 不触发会卡死在 opening"。实现统一用一个可注入时长的定时器（默认 `OPEN_MS = 200`，与 CSS transition 同值；reduced-motion 分支 `openMs <= 0` **同步**置 `open`）。好处：状态机与过渡事件彻底解耦，jsdom 里也能确定性推进。

### 4.8 delta 重放按 `at` 过滤（不是按 `seq`）

方案 §3.2 写"丢弃 `seq ≤ lastSeq` 的 delta"，但 `DeltaFrame` 只有 `kind/at/text`（`frames.ts:108-112`），**没有 `seq`**。实现改为按 `at` 单调过滤（`at <= lastDeltaAt` 即丢）。副作用如实说明：同一毫秒内的两个增量会丢后者——终态由 `message`/`snapshot` 帧保证，打字机效果允许这种损失。

### 4.9 9 态实名修正：`ok` / `denied`，不是 `succeeded` / `ready`

方案 §3.7 的表格用的是 `pending/ready/running/succeeded/failed/skipped/blocked/cancelled/incident`；帧契约（`frames.ts:216-229`）是 `pending/ok/denied/blocked/running/failed/skipped/incident/cancelled`。**`ready` 不存在，`denied` 存在**。照文档写会渲染出没有样式的 `m-step--undefined`。

### 4.10 `.ds-drawer__title` 不是 DS 已有类

方案 §3.4 的 DOM 骨架用了它；`components.css` 只有 `.ds-drawer` / `__head` / `__body`。实现改用页面局部类 `.m-sheet__title`（样式在 mobile.css），不引用不存在的 DS 类。

### 4.11 强验证**不是**服务端强制（实测，收紧对外口径）

方案 C1 探针写"verify 由服务端强制（`adapter.ts:213-228`）"。实测：`http-adapter.ts` 的 `decide()` 只校验票据归属 / 结论合法性 / 拒绝理由与长度，**完全不校验 `verify()` 是否已通过**。所以"红级必须先强验证"与滑动确认同档，都是 **UI 约束**。

处置：①实现里照旧在界面层拦（与桌面同款）；②`gesture-confirm.js` 头注释与 README 都写清这条；③修它要动 `packages/**`（本单禁改面），登记为后续单独立项。

### 4.12 回显只属于选择题卡片，chips 不回显

方案没写 chips 是否回显。实现遵循 `views/conversation.js` 头注释的既有纪律："没有'输入框回显'这类平行状态——用户消息一律等 `user/message` 帧"。只有 D6 的点选做了本地回显（§3.8 明文），并在服务端回流同文本 `message` 帧时撤掉（`shell.sync` 的去重）。

### 4.13 `todo` 帧只留只读渲染位 + 列表

方案 §3.7 说"本单只留渲染位 `data-role="todo-slot"`"。实现渲染了完整的只读条目（文本 / done / code / blockedBy），但**零勾选控件**（用例断言 `todo-slot` 内 button/input 数为 0）。勾选语义归 04，这里不假装可点。

### 4.14 `inputmode='decimal'` 分支暂无生产调用点

D10 要求"金额类内联输入另给 `inputmode='decimal'`"。本单 UI 里没有金额内联输入（输入区是自由文本，审批抽屉是只读金额 + 理由框），所以 `applyImeAttributes(input, 'amount')` 只有测试覆盖。**如实登记，不谎称已接线**；03/04 单出现金额内联输入时直接复用该函数。

---

## 5. 安全面自查（C 类探针的施工期前置核对）

| 探针 | 实测判据 | 结果 |
|---|---|---|
| C1 手势能否替代强验证 | `tier=red + challenge` 的票据：点批准 ⇒ `verify` 恰一次；verify 失败 ⇒ `decide` 零调用（`approval-sheet.test.js`） | 手势 ≠ verify；**但两者都是 UI 约束**（§4.11） |
| C2 脚本直接 POST 批准 | 不经任何 UI 的 `POST /api/approval/:ticketId` 会被服务端接受（预期行为） | README 已如实写 D11 三句话 |
| C3 m.html 之外拿 token | 门禁 I10：`bah-web-token` 命中面 ⊆ {transport.js, index.html, m.html, host/plugins/**, docs/, *.test.*}；`__BAH_WEB_TOKEN__` 在**可执行/配置面**（HTML/JS/TS/配置，排除 `.md` 引用）零命中 | 白名单成立 |
| C4 IME 零权限面 | ①生产源码 grep `getUserMedia`/`SpeechRecognition`/`webkitSpeechRecognition`/`mediaDevices`/`AudioContext` **零命中**；②运行时挂 spy 跑完整交互，`getUserMedia`/识别器零调用；③chips 只发消息、不绕过审批；④组合态期间 `POST /api/turn` 零调用 | 四条全绿 |
| C5 CSP 被内联样式破坏 | m.html 零 `style=`/`<style>`/内联 script（门禁 I3 逐条）；JS 侧全部 CSSOM（`el()` 的 `Object.assign(node.style,…)`、`style.setProperty`），源码无 `setAttribute('style'` | 全绿 |
| C6 SW 缓存旧 token | `apps/web` 下 `serviceWorker`/`manifest`/`workbox` 零命中；m.html 无 manifest link；静态响应 `no-store` 由 `tokenEntries` 判定 | 零命中 |
| C7 CSRF/Origin 在移动端仍生效 | 移动端零鉴权分支：`shell.js` 只用 `createHttpApi`/`connectEvents`，token 与 CSRF 的读取全在共享层（`transport.js:19-27,50,56`） | 同一份代码路径 |
| 安全头 | `packages/host/**` **零 diff**（`permissions-policy: camera=(), microphone=(), geolocation=()` 逐字未动） | 见 `git status` |

---

## 6. 命令输出摘要

```
$ pnpm typecheck
tsc -b tsconfig.host.json && tsc -b tsconfig.client.json && tsc -p tsconfig.scripts.json
→ exit 0

$ pnpm lint
eslint "packages/*/src/**/*.ts" "scripts/**/*.ts"
→ exit 0

$ pnpm test:web
Test Files  22 passed (22)
     Tests  333 passed (333)

$ pnpm gate
阻断合并：2/45 项未通过      ← assertions + tracked-sources，均属并行线

$ npx tsx scripts/verify-mobile-shell.ts
✔ mobile-shell
    ℹ I1 框架判据打在 import/src 说明符上（裸文本匹配会被 'split' 里的 'lit' 之类假阳拖垮）
    ℹ I9 图标：mobile.css 引用 20 个，映射名 20 个
    ℹ I10 token 面命中 11 个文件，占位符命中 0 个
    ℹ I11 令牌：定义处 442 个、未定义引用 0 个；运行期变量例外 3 个（逐条带出处）
    ℹ 扫描面：mobile 生产源码 10 个文件、页面局部 css 2 个
```

`pnpm test`（主仓面）实测 **251 文件 / 2848 用例 全绿**，见 `02-test-unit.txt`。

⚠ 这两个数**刻意没有回填 `facts.md`**（该文件仍写 250 / 2830）。原因：多出来的 1 文件 / 18 例**全部来自并行「可观测性」线的未提交测试**
（`packages/cli/src/cli/observe-http.test.ts` 等）。本单提交时不会带上它们，若此刻把 `facts.md` 改成 251/2848，
**在本单自己的提交树里就是错的**（干净 clone 跑出来还是 250/2830）。主仓用例面归并行线收口时一并回填。

逐文件覆盖率面未重跑：本单没有新增或修改 `packages/*/src` 下的任何文件，覆盖率分母与 `docs/coverage-baseline.json` 均未变
（该面在并行线未提交的 cli 观测文件上会红，属继承项）。

---

## 7. DoD 12 条逐条自查（00 §12）

| # | 条目 | 结论 | 证据 |
|---|---|---|---|
| 1 | 出口标准 E1–E12 逐条核对 | E1–E12 全部落实；E1 的"占位 meta"与 E6 的 `getUserMedia` 口径按 §3/§4 回填 | §3、§4 |
| 2 | `pnpm typecheck` 绿 | ✔ 三套配置 exit 0 | §6 |
| 3 | `pnpm lint` 绿 | ✔ exit 0 | §6 |
| 4 | `pnpm gate` 本单相关项全绿 + 门禁数递增 | ✔ 45 项（44→45），`verify-mobile-shell` 绿；2 条继承红已逐条归因 | §0、`02-gate-after.txt` |
| 5 | `pnpm test` 绿且用例数 ≥ 上次 | 本单未触 `packages/**`，主仓用例面不变（250/2830）；`apps/web` 面 139 → **333** | `02-test-web.txt` |
| 6 | 新增实现文件进 `coverage-allowlist` 且逐文件 100% | **不适用**：本单无 `packages/*/src` 新实现文件（00 §6.1 明文：前端 jsdom 用例不在覆盖率面） | — |
| 7 | `test:coverage:all` 两口径达标 + baseline 更新 | 未变（无 `packages/*/src` 改动）；不做虚假更新 | — |
| 8 | `pnpm test:web` 绿 + `minCases` 已抬 | ✔ 333 绿；地板 54 → **332** | `scripts/ci.ts` |
| 9 | 治理平面/plan ⇒ `test:snapshot` 绿 | 未触治理平面；`verify-snapshot-fresh` 在 gate 里为绿 | `02-gate-after.txt` |
| 10 | 涉及 eval ⇒ 三步绿 + 场景数同批改 | 本单未动 eval | — |
| 11 | 新增 `.ts` 全部 `git add` + 提交信息合规 + 未推送 | `scripts/verify-mobile-shell.ts` 已 `git add`；未推送 | `git status` |
| 12 | 证据落盘（construction + adversarial-review + 交接件） | 本文件 + `02-adversarial-review.md` + handoff 追加节 | — |

---

## 8. 走查记录（无头施工机口径）

方案 §7 的 15 条走查里，12 条有 TC 对应，按"无头验收 → TC 全绿"替代截图；①②③ 是纯视觉/视口行为，本机无可见浏览器，**延后**到 04 单演示彩排前补真机走查（责任人：04 收口会话；到期动作：真机走查 ①②③ 并回填截图到 `walkthrough/`）。

| # | 场景 | 无头验收判据 | 结果 |
|---|---|---|---|
| ① | 首屏安全区上下留白 | `env(safe-area-inset-top/bottom)` 各 ≥1 + `viewport-fit=cover`（门禁 I8） | 机器判据绿；真机视觉延后 |
| ② | 键盘弹起 dock 避让 | `layout.test.js`（visualViewport 100→"translateY(-300px)"） | TC 绿；真机视觉延后 |
| ③ | 横屏重排不重建 | `layout.test.js`（resize 后四区节点引用相等） | TC 绿；真机视觉延后 |
| ④ | 抽屉 opening（opacity + ≤4px，无大位移） | TC-MOB-02 / TC-MOB-30；`mobile.css` 只写 `opacity` 与 `translateY(4px)` | TC 绿 |
| ⑤ | 抽屉六要素齐全 | TC-MOB-01（字段集逐项断言） | TC 绿 |
| ⑥ | 拒绝理由 501 字截断与计数 | TC-MOB-04 | TC 绿 |
| ⑦ | 手势半途松手归位 | TC-MOB-10 / TC-MOB-12 | TC 绿 |
| ⑧ | 手势到位松手确认 | TC-MOB-09 / TC-MOB-13 | TC 绿 |
| ⑨ | 键盘长按 Enter 等价 + kb-confirm | TC-MOB-13 | TC 绿 |
| ⑩ | IME 面：提示可关、偏好只在本地、chips 发一条、组合期 Enter 不发 | TC-MOB-16..20 / TC-MOB-19 | TC 绿 |
| ⑪ | offline 3s 恢复 ⇒ SSE 重连且无重复渲染 | TC-MOB-25 / shell 重连用例 | TC 绿 |
| ⑫ | 429 倒计时 | TC-MOB-28 | TC 绿 |
| ⑬ | 409 接管文案（含抽屉内） | TC-MOB-28 / composer 409 | TC 绿 |
| ⑭ | blocked 步骤显式可见（3 连续） | TC-MOB-23 | TC 绿 |
| ⑮ | prefers-reduced-motion ⇒ 抽屉无位移、功能不减 | TC-MOB-30 + `mobile.css` 的 `@media (prefers-reduced-motion: reduce)` | TC 绿 |

---

## 9. 未做 / 延后清单（照 §9.6 与 §4 汇总，不升格）

| 不做 | 依据 | 备注 |
|---|---|---|
| Service Worker / PWA / manifest / 任何缓存壳 | D12 | `apps/web` 零命中 |
| 暗色模式 | 00 §11 | DS 是 Light-only |
| 框架 / 组件库 / 构建器 / 图标库 / CDN | 00 §11 + I1/I2 | 零依赖（`apps/web/package.json` 仍无 deps） |
| 新增会话事件键 / 改冻结键载荷 | D5 | 本单只消费帧 |
| 页面内语音识别 / 放开 microphone / 录音上传 | D10 二次定稿 | C4 四条判据 |
| 真定时（生日案例的"到点唤醒"） | 00 §11 | 归 04 的预演卡片 |
| goal/todo 编排、生日案例、incident 处置 | 04 单 | 本单只渲染 |
| choice 帧后端语义（`prompt_ask`）、意图平面 | 03 单 | 本单只渲染 |
| 修改 `packages/host/**` | 02 §1.2-R | 零 diff |
| 响应式变形 index.html | §9.1 | 双壳 |
| 真机农场 / 云测 | §7 | 走查 ①②③ 延后 |
| 抽屉"下滑关闭" | §4.5 | 只用 ESC / 背景 / 关闭钮 |
