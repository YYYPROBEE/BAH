# 桌面端 01 · 桌面渠道与 profile —— 施工回执 + 对抗式复审

> 施工单：`BAH-桌面端施工方案-2026-10-29/01-桌面渠道与profile.md`（仓库外材料包，不在本仓）
> 总纲：同目录 `00-总施工文档.md` · 分支 `desktop-line` · worktree `BAH/DESKTOP-WT` · 基线 `1c369b3`
> 日期：2026-10-30

---

## 0. 一句话结论

`channel:desktop` + `profiles/desktop` 已落地；**出口 4 条全绿**，门禁 **50/50**，改造后 `channels/desktop/**` 逐文件 **100%**（语句/分支/函数/行）。发现并修正 **8 处缺陷**（含 2 处是门禁自身的判据漏洞、1 处是 facts.md 早已滞后），逐条负控 **8/8 变红**。未闭合项已登记在 §5。

---

## 1. 交付物

### 1.1 新增

| 文件 | 行数 | 职责 |
|---|---|---|
| `packages/channels/src/desktop/adapter.ts` | 38 | 桌面渠道薄工厂（唯一字面量落点 `DESKTOP_CHANNEL_ID`） |
| `packages/channels/src/desktop/adapter.test.ts` | 82 | T-DTB-CH-001/002：id、能力位同引用、差异集、审批六码未分叉 |
| `packages/host/src/boot/plugins/desktop.ts` | 53 | `channel:desktop` 宿主薄壳（≤80 行，只调 `createHttpChannel`） |
| `profiles/desktop/profile.yml` | 17 | 清单：`name/bundles/patch/hmr` |
| `profiles/desktop/patch.yml` | 145 | 与 web 仅四处差异（见 §2.3） |
| `scripts/desktop-channel.test.ts` | 128 | 装配级冒烟：真 boot、真绑端口、真注入 token、真答 `/api/session` |

### 1.2 修改

| 文件 | 改动 |
|---|---|
| `packages/channels/src/index.ts` | 导出 `./desktop/index.ts`；注释从"占位"改为"已落地" |
| `packages/channels/src/desktop/index.ts` | 占位 `export {}` → 真实导出 |
| `packages/host/src/boot/plugins/index.ts` | 登记 `desktopPlugin`（**不进 base bundle**）；导出 `DESKTOP_SERVER` |
| `packages/host/src/boot/index.ts` | 再导出 `DESKTOP_SERVER`（见 §4 D-01-1） |
| `packages/host/src/boot/plugins.test.ts` | 全等数组补 `'channel:desktop'`（见 §3 F-01-08） |
| `scripts/verify-channel-capabilities.ts` | I1/I4/I5/I6/I7/I8/I9 扩展 + 新增 I11（见 §3） |
| `scripts/coverage-allowlist.ts` | `channels: desktop/` 强制 100% |
| `scripts/barrel-excludes.ts` | 登记 `channels/src/desktop/index.ts` 为纯 barrel |
| `scripts/gen-architecture.ts` | 事实表两行拆写（见 §3 F-01-05） |
| `scripts/assertion-baseline.json` | 登记新用例断言 |
| `docs/{architecture,algorithms,security-design}.md` | `gen-architecture` 重生成（注册表 26 → 27） |
| `facts.md` / `docs/facts-sources.md` / `README.md` / `docs/deploy.md` / `docs/testing.md` / `docs/security-self-assessment.md` | 端口表补 desktop 行 + 用例数同步（见 §3 F-01-06） |
| `profiles/desktop/.gitkeep` | 删除（实装后是噪音，见 §3 F-01-07） |

---

## 2. 出口验收（逐条 → 命令 → 实测）

### 2.1 出口 1：适配器 id 与能力位

```bash
npx vitest run packages/channels/src/desktop/adapter.test.ts
```

```
 ✓ packages/channels/src/desktop/adapter.test.ts (7 tests) 4ms
 Test Files  1 passed (1)
      Tests  7 passed (7)
```

钉住的关键断言：`capabilities === CAPABILITIES_BY_CHANNEL.desktop`（**同一引用**，不是深拷贝）；
与 `WEB_CAPABILITIES` 的差异集 `=== ['gestureConfirm']`；`voiceInput === 'none'`；
`sessionId` 透传后跨会话票据判 `foreign-ticket`。

### 2.2 出口 2：薄壳纪律

`packages/host/src/boot/plugins/desktop.ts` = **53 行**（门禁上限 80）。门禁 I9 三条判据：
不含 `createDispatcher`/`matchRoute`/`injectWebToken`/`handleStatic`；**必须**含 `createHttpChannel(`；
**不得**出现 `from 'node:http'`。

### 2.3 出口 3：`--dump-config` 正确

```bash
BAH_KNOWLEDGE_KEY=demo-key-not-for-prod pnpm bah --profile desktop --dump-config
```

实测（节选，逐字）：

```
core:agent            profile-patch:profiles/desktop/patch.yml  {…,"channel":"desktop",…}
bank:knowledge        profile-patch:profiles/desktop/patch.yml  {…,"channel":"desktop",…}
demo:echo             profile-patch:profiles/desktop/patch.yml  {"prefix":"[desktop] "}
channel:desktop       profile-patch:profiles/desktop/patch.yml  {"port":0,"host":"127.0.0.1",
                      "staticRoot":"apps/web","heartbeatMs":15000,"rateLimit":{…},"csrf":{"enabled":true},
                      "entry":"index.html","entries":["index.html"],"handoff":{"slaMs":180000},"auth":{…}}
bah: 共 24 行
```

`port:0`、`entry:index.html`、`entries:["index.html"]`、`channel:desktop` 四项与方案一致。
与 web 的差异恰为四处：渠道行、`core:agent.channel`、`bank:knowledge.channel`、`demo:echo.prefix`。

### 2.4 出口 4：装配级实跑（比 dump 更强）

```bash
npx vitest run scripts/desktop-channel.test.ts
```

```
 ✓ scripts/desktop-channel.test.ts (5 tests) 250ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

证明四件 dump 证明不了的事：

1. `port:0` 由内核分配到**真实**端口（`>0`，且 `≠7331/7551`）；
2. URL 前缀 `http://127.0.0.1:` —— 私有宿主只绑 loopback；
3. `GET /` → 200，响应里含 `<meta name="bah-web-token" content="desktop-01-smoke-token"`；
4. `GET /api/session` 的能力位三元组 = `gestureConfirm:true` / `voiceInput:'none'` / `layout:'wide'`
   —— 这组三元组在三种 HTTP 渠道里**唯一**指向 desktop（web 的 gestureConfirm 是 false，
   mobile 的 voiceInput 是 `ime`、layout 是 `narrow`）。

> `/api/session` **不回渠道名**（`web/handlers/session.ts` 只回 `sessionId/lastSeq/capabilities`），
> 所以"装配到别的渠道"只能靠能力位证伪——这条断言就是这么写的。

### 2.5 覆盖率（逐文件 100%）

```bash
npx vitest run --coverage --coverage.include='packages/channels/src/desktop/**/*.ts' packages/channels
```

```
 % Coverage report from v8
File        | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
All files   |     100 |      100 |     100 |     100 |
 adapter.ts |     100 |      100 |     100 |     100 |
```

`desktop/index.ts` 不在统计里：它已登记为纯 barrel（`scripts/barrel-excludes.ts`），
由 `verify-index-barrels` 逐条校验"只 re-export"。

### 2.6 门禁

```bash
pnpm gate
```

```
全部通过（50/50）
```

---

## 3. 对抗式审查：发现的缺陷与修正

> 纪律：每条都是**真跑出来的**，不是设想。改完都重跑了对应命令。

| ID | 缺陷（严重度） | 现场 | 修正 |
|---|---|---|---|
| **F-01-01** | 方案表述与事实不符（中） | 01 §2.1 与 T-DTB-CH-001 写"与 web 全等，仅 `gestureConfirm:true`、`voiceInput:'none'`"。实跑断言"差异两项"**第一次就红**：`WEB_CAPABILITIES.voiceInput` 本来就是 `'none'`，桌面那行是同值重复声明 ⇒ 真实差异**只有一项** | 断言改为按事实钉：差异集 `=== ['gestureConfirm']`；另**单独**钉 `desktop.voiceInput==='none'` 与 `WEB_CAPABILITIES.voiceInput==='none'`。这样"Web 哪天开了语音"会立刻变红，而不是被"两项差异"的措辞掩盖 |
| **F-01-02** | 门禁判据漏洞（高） | I1 只查 `interface ChannelCapabilities` 的定义点。适配器里**就地写**一份 10 键全对的 `capabilities: {…}` 字面量，**没有任何门禁能拦**（只有 `===` 单测能抓） | I1 增加判据：web/mobile/desktop 三个适配器**不得出现** `capabilities:\s*\{`。负控 B 证明可红 |
| **F-01-03** | 门禁覆盖面漏白（高） | I4–I9 把渠道写死成 `mobile`；I6 的 token 入口白名单只扫 `channel:web`/`channel:mobile` 两行 ⇒ **新增渠道自动逃出白名单校验**（等于名单越加越漏） | 改成表驱动 `HTTP_CHANNELS = [mobile, desktop]`；I6 判据改为"任何 `channel:*` 行" |
| **F-01-04** | 端口冲突表会假红（中） | `port:0` 参与端口冲突表 ⇒ 两个内嵌渠道都写 0 会被判"端口冲突"，而 0 是"让 OS 选"，永不冲突 | `port === 0` 不进冲突表，并写明理由 |
| **F-01-05** | 新数字撞历史黑名单（中） | 注册表变 27 项后，`gen-architecture` 生成的 `注册表 / 门禁 ‖ **27 项 / 50 项**` 同时命中 `verify-docs-consistency` 两条判据：`/27\s*项/`（门禁数曾是 27）与 `门禁 … N/M`（读成"门禁 27/50"） | **不削弱门禁**，改生成器：两个数**分行写**、单位上表头（`注册表条目（项）‖27`、`门禁（项）‖50`） |
| **F-01-06** | facts.md 早已滞后（中） | `facts.md` 记 294 文件 / 3333 用例；HEAD 实测 3337（本单加 5 条后 3342，加装配冒烟 5 条后 3347）。差 4 条源于 handoff 线合入后未刷新——`verify-facts` 只比 `facts.md ↔ facts-sources.md`，抓不到"两边一起旧" | 按实测同步到 **296 文件 / 3347 例**，并把"1 例既有超时抖动"如实写进 `docs/facts-sources.md` 备注 |
| **F-01-07** | 实装后残留占位（低） | `profiles/desktop/.gitkeep` 在 profile 实装后是噪音，且会让人以为目录还是空的 | 删除 |
| **F-01-08** | 清单全等断言未同步（低） | `plugins.test.ts` 用**全等数组**钉 `HOST_PLUGINS`，登记 `desktopPlugin` 后 1 条用例红 | 补一行 `'channel:desktop'`。**不放宽**成全等之外的写法——"登记 ≠ 装配"这条正需要被钉死 |

### 3.1 负控（逐条注入违规 → 门禁必须变红）

执行：`bash .tmp-neg-01.sh`（一次性脚本，不入库）。结果 **8/8 全部变红**：

| # | 注入 | 期望 | 实测命中 |
|---|---|---|---|
| A | `use: channel:desktop` → `channel:web` | I4 红 | `I4 channel:desktop 行的 use 必须是 'channel:desktop'（实际 channel:web）` |
| B | 适配器里就地写 10 键全对的 capabilities 字面量 | I1 红 | `I1 …adapter.ts 就地写了 capabilities 对象字面量` |
| C | 薄壳里加 `const createDispatcher = 1` | I9 红 | `I9 …desktop.ts 含分发符号 'createDispatcher'` |
| D | `port: 0` → `port: 7331` | I6 + I11 红 | `I6 …端口 7331 与 profiles/desktop/patch.yml 冲突` ＋ `I11 …port 必须是 0（OS 分配），实际 7331` |
| E | `entries` 加 `m.html` | I11 红 | `I11 …entries 必须恰为 ['index.html']，实际 ["index.html","m.html"]` |
| F | `bank:tools.contextSlots.accounts` 3 → 5 | I8 红 | `I8 bank:tools 的 config 在 desktop 与 web patch 里不一致` |
| G | 删 `profiles/desktop/profile.yml` | I4 红 | `I4 缺文件 profiles/desktop/profile.yml` |
| H | 薄壳 `import { createServer } from 'node:http'` | I9 红 | `I9 …desktop.ts 引入了 node:http（自建 HTTP 服务 = 第二份装配）` |

负控后工作树已逐条 `git checkout` 还原，`git diff` 仅剩本单**预期新增**的门禁代码。

### 3.2 未做负控的一条（如实登记）

"把 `DESKTOP_CAPABILITIES` 常量整体复制进 adapter 再传入"这条**不会**被门禁拦住（键集与单一实现点
判据都不适用），但会被 `adapter.test.ts` 的 `capabilities === CAPABILITIES_BY_CHANNEL.desktop`
（同一引用）当场判红。已实测：把 `capabilities: DESKTOP_CAPABILITIES` 改成同值深拷贝后该用例红。
—— 也就是说，这条防线在**单测**层级，不在门禁层级；写在这里以免被误认为"门禁全覆盖"。

---

## 4. 与施工单的偏差登记

| ID | 01 文档原文 | 实际做法 | 原因 |
|---|---|---|---|
| **D-01-1** | 01 的"修改"清单只列 `packages/host/src/boot/plugins/index.ts` | 另改 `packages/host/src/boot/index.ts`（再导出 `DESKTOP_SERVER`） | 02 单的主进程只能从 `@bah/host` 的公开面取服务键；`boot/index.ts` 是纯 barrel，加一行 re-export 不改变行为。放在 01 与插件同批，避免 02 再动一次 barrel |
| **D-01-2** | 未列 | 改 `packages/host/src/boot/plugins.test.ts` | 该用例用全等数组钉 `HOST_PLUGINS`；登记新插件必须同批更新（F-01-08） |
| **D-01-3** | 未列 | 改 `scripts/gen-architecture.ts` | 注册表跨过 27 触发两条文档门禁的撞词（F-01-05） |
| **D-01-4** | 01 §3 步 6「用**一次性脚本** boot … 冒烟」 | 固化为 `scripts/desktop-channel.test.ts`（入库） | "一次性脚本"不可重复验证；固化后 01 的出口 1/3/4 可在任何机器上一条命令复现。放在 `scripts/` 是因为它要同时 import `@bah/cli`（三层 profile 读取）与 `@bah/host`（boot），放进任一包都会让 project references 成环 |
| **D-01-5** | 01 §3 步 7「刷新 `facts.md` 与 `PROGRESS.md`」 | `facts.md` 已刷新；**`PROGRESS.md` 未改** | `PROGRESS.md` 自 2026-10-29 起有追加协议：**分支与并行会话不得自增 §编号**，收口正文先写 `docs/evidence/<日期>-<slug>/`，合入 main 时再领索引行。本回执即按该协议落在这里（两条规则的冲突按较新者执行） |

---

## 5. 残留风险（未闭合，交接 02/03）

| ID | 风险 | 现状 | 02/03 必须做什么 |
|---|---|---|---|
| **R-01-01** | `core:persistence.root: sessions` 仍相对 `process.cwd()` 解析 | 01 侧靠 `run.jsonlDir` 兜底（§2.4 第 5 条已证明会话文件落在 `run.jsonlDir` 下、不含仓库路径） | 02 的 `boot.ts` **必须**把 `jsonlDir` 指到 `app.getPath('userData')/sessions`；漏传就会写进 `resources/app/sessions`。03 的 T-DTB-012 要钉住这点 |
| **R-01-02** | 桌面端没有坐席面，但 patch 里仍配 `handoff.slaMs:180000` | `createHttpChannel` 的 `seatEnabled` 要求 `channelId==='web'`，所以桌面端 `/operator` 与 5 条坐席 API 恒 404；SLA 只会落 `handoff/timeout-warned` 事件 | 02 的离线演示不承诺坐席接管（已写进 patch 注释） |
| **R-01-03** | `bank:knowledge.baseUrl` 固定 `http://127.0.0.1:7801` | 桌面端离线不起 sidecar ⇒ 每次 boot 有一次探活失败（`required:false`，只 warn 不阻塞；§2.4 的运行里可见 `host.audit-key-missing` 与 policy 载入日志，无 knowledge 报错） | 03 的离线演示口径要写明"不承诺 RAG 检索" |
| **R-01-04** | **pre-existing**：本机全量 `pnpm test` 在负载下会命中 5s/60s 超时抖动，且超时后 vitest worker **不退出**（须 `timeout` 兜底才结束） | 三次实测：①全量 → 296 文件 / 3347 例，`scripts/policy-explain.test.ts` 超时 5006ms 失败，进程不退出；②排除该文件 → **295 文件 / 3339 例全绿**，进程仍不退出；③排除该文件 + `scripts/desktop-channel.test.ts` → 294 文件 / 3334 例，`packages/cli/src/main.smoke.test.ts` 子进程被 60s 超时杀掉（`status: null`）⇒ **抖动与桌面端代码无关**（既排除桌面用例仍抖）。两条抖动用例**放在一起隔离复跑 13/13 全绿** | 不是本线修复范围（动它们等于改别人的测试预算）；已登记，答辩前应单开一条"测试超时与 worker 退出"的修复 |
| **R-01-05** | **pre-existing**：`verify-assertions` 只扫 `packages/` 与 `tests/`，**不扫 `scripts/**/*.test.ts`** | 本单新增的 `scripts/desktop-channel.test.ts` 因此不在断言基线里——理论上可以写成空壳而不被拦 | 已用真跑覆盖（§2.4）。若要补，需同批把既有 `scripts/` 用例的断言一次性登记进基线，属独立单 |

---

## 6. 提交

```
feat(desktop): 01 桌面渠道与 profile（channel:desktop）
```

只 add 本单文件；派生文件（`facts.md` / `facts-sources.md` / `README` / `deploy` / `testing` /
`security-self-assessment` / 三份生成文档 / 断言基线）同批提交。
