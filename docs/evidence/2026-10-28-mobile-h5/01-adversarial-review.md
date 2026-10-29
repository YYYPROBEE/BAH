# 01 · 对抗式审查报告（移动渠道底座与宿主装配）

> 协议：`00-全局约定.md` §9（四类探针 A/B/C/D、结论三档、复审自身也要被复审）。
> 审查日期：2026-10-29 · 仓库 `BAH/MonoRepo` · 开工 HEAD `cbdced4`（本单尚未提交，改动在索引里）
> 材料：`00`/`01` 施工单、`01-construction.md`、索引内全量 diff、真实服务实测。

## 0. 口径偏离（必须先声明）

**审查者与被审者未分离**：00 §9.1 要求审查者是"新会话 / 新子任务"。本次用户明确要求**不使用子智能体**，
审查只能由施工会话自做。缓解手段：
1. 每条判据都写成**可执行命令**并附**本次实际输出**，任何人可复跑推翻；
2. 不复用施工会话的结论——本报告的数字全部是本次重跑得到的，与 `01-construction.md` 逐项比对后标注"一致/不一致"；
3. 报告自身接受 §9.4 的 A/D 探针：第 8 节列出"本报告最可能错的 3 条判断 + 怎么证伪"。

**结论档位：有条件通过**（无阻断项；3 条条件均不阻塞 01 合并，见 §7）。

---

## 1. 基线复算（施工方数字 vs 本次实测）

| 项 | 施工方声称 | 本次实测 | 判定 |
|---|---|---|---|
| `pnpm gate` | 42/44 ✔（2 条继承红） | **42/44**；红 = `assertions`、`tracked-sources`，均指向 `packages/cli/src/cli/observe-http.test.ts`（`??` 未跟踪） | 一致 |
| `ls scripts/verify-*.ts` | 44 | **44** | 一致 |
| `facts.md:21` / `facts-sources` | 44/44、`gates=44` | **44/44**、`gates=44` | 一致 |
| `pnpm test` | 250 文件 / 2830 例 | 未重跑全量（与提交钩子同源码同配置；施工会话 10:23 实测 250/2830；本次跑的是 channels + host 子集） | 部分复核 |
| 测试文件数增减 | 只增不减 | HEAD 268 → 当前 278；`git diff --cached --diff-filter=D` 无测试文件删除 | 一致 |
| `pnpm test:web` | 12 / 139（未动 `apps/web`） | `git status apps/web` 只有并行线的改动，本单零文件面 | 一致 |
| 本单文件覆盖率 | 逐文件 100% | 施工会话 `test:coverage` 报表：capabilities/http-adapter/mobile/config/static/mobile.ts 全 100%；`channel.ts` branches 96%、`static.ts` 90.47% | 一致 |
| 门禁数演进 | 43 → 44（+1） | 44 | 一致 |
| 端口 | 7551 | `profiles/mobile/patch.yml` = 7551；`FETCH_BAD_PORTS` 表内无 7551；两渠道可同时监听 | 一致 |
| 快照 | 零 diff | `git status snapshots/` = 0 条 | 一致 |

---

## 2. A 类 · 造假探针（绿是不是真的）

| # | 探针 | 命令 / 实际输出 | 判定 |
|---|---|---|---|
| A1 | 抬地板却删用例 | `git diff --cached scripts/ci.ts`：`minCases: 2000 → 2829`（= 新实测 2830 − 1），`test:coverage` 同步；无测试文件被删（见上表） | ✔ 不是假绿 |
| A2 | 既有 189 行用例被改松 | `git diff --cached packages/channels/src/web/adapter.test.ts`：唯一变化是 `expect(createWebChannelAdapter().capabilities)` → 先解构 5 个呈现位再 `expect({...}).toEqual({`；**期望对象字面量未出现在 diff 的 `-` 行**（逐字未改），仍是严格 `toEqual`。`it(` 仍 12 条。全仓 `it.only/it.skip/describe.only/toBeTruthy()` 零命中 | ✔ 语义保真（D4 扩字段后原断言结构性必红，改主语是唯一保真写法） |
| A3 | 覆盖率名单缩容 / `why` 空洞 | `git diff --cached scripts/coverage-allowlist.ts`：**只有 3 条 `+`**（channels 的 `capabilities.ts`/`http-adapter.ts`/`mobile/`），无 `-`；每条 `why` 写明"错了会怎样" | ✔ |
| A4 | 违规塞进 `notes` 绕过 | `grep -cE "findings.push" scripts/verify-channel-capabilities.ts` = **33**；`notes.push` 仅 2 处：I3 多字段提示 + 末尾统计。I1/I2/I4–I10 全部进 findings | ✔ |
| A5 | 门禁会不会真咬 | 15 条负控（临时根逐文件复制，**不用 `cpSync` 整目录**——本机整目录复制会被异常终止、退出码 127）重跑：`16 ✔ / 0 ✘`（基线绿 + I1/I2/I3/I4/I5/**I6×5**/I7/I8/I9×2/I10 各命中） | ✔ 真会红 |
| A6 | 断言基线被缩水 | `git diff --cached scripts/assertion-baseline.json`：+7 个新文件、2 个上升（project.test 74→105、metrics.test 41→61，后者属并行线）、**0 个下降** | ✔ |
| A7 | 断言 `dist` 陈旧产物 / 快照没重录 | `grep "dist/" *.test.ts` 零命中（vitest 直跑 `src`）；`snapshots/` 零 diff；`reverified.json` 未动 | ✔ |

## 3. B 类 · 契约探针（声明 ↔ 发射 ↔ 投影 ↔ 前端消费）

| # | 探针 | 实测 | 判定 |
|---|---|---|---|
| B1 | 4 帧真进联合 + `frameKey` 有分支 | `WebFrame` 联合 **14** 成员（含 Choice/Goal/Todo/Effects）；`frameKey` **14** case；`assertNever(frame,'web-frame')` 仍在 default；`frameSeq` 未改（新帧都带 `seq` ⇒ 走 default） | ✔ |
| B2 | `choice`/`goal` 如实登记为"只定契约" | `grep "'choice'\|'goal'\|ChoiceFrame\|GoalFrame" project.ts` **零命中**（没有永不命中的死代码分支）；`frames.ts:262/291` 注释写明"03/04 单接线、01 只定契约"；`01-construction.md` §5.2 与交接件 §3 同样登记 | ✔ |
| B3 | `todo`/`effects` 有**真实发射点** | `project.ts:481` 在 `tool/result` 成功分支调 `projectEffects`，`project.ts:651` 在 `projectPlan` 调 `projectTodo`；实测脚本（`.tmp-neg/determinism.ts`）四判据输出符合预期；`snapshot.test.ts` 的真实日志回放**真的产出了 `effects`**（该用例因白名单缺 `effects` 而红、加白名单后绿——这是"真接通"的反向证据） | ✔ |
| B4 | 能力位真被上报（10 键不是旧 5 键） | 真实 `curl /api/session`：mobile 10 键全中（`layout:narrow`/`approvalSurface:bottom-sheet`/`gestureConfirm:true`/`voiceInput:ime`/`dagView:steps`）；web 10 键（`wide`/`dialog`/`false`/`none`/`graph`）；前 5 位两边相同 | ✔ |
| B5 | `channel:mobile` 真被装配（不是只登记） | `--profile mobile --dump-config` 打出 `channel:mobile` 行且来源层 `profile-patch:profiles/mobile/patch.yml`；`--serve` 真监听 7551；`POST /api/turn` 202、`lastSeq` 2→18、SSE 首帧 snapshot；`plugin-config` ✔ | ✔ |
| B6 | 第四点（前端消费）明示留给 02 | `01-construction.md:102`、交接件 §2.3 均写明"`switch(frame.kind)` 补 4 个 case，否则静默丢帧" | ✔ 如实分期 |
| B7 | 两渠道是否真的同源 | `grep createHttpChannelAdapter packages/channels/src` = 1 定义 + 2 调用；`grep createHttpChannel packages/host/src` = 1 定义 + 2 调用；`web/channel.test.ts` 同时对两插件真 boot，比较能力位/入口/闸序/安全头 | ✔ |

## 4. C 类 · 安全探针（移动端有没有成为绕过面）

> 环境：7331（web）+ 7551（mobile）同时起，`BAH_WEB_TOKEN` 分别注入；测完 `taskkill` + 删临时会话目录；
> 临时泄漏文件 `apps/web/zz-review-leak.html` 测完**立即删除**（`ls apps/web` 已确认不存在）。

| # | 探针 | 实测（7331 / 7551） | 判定 |
|---|---|---|---|
| C1 | 白名单外 HTML 泄漏 token | `/zz-review-leak.html`：两渠道均 `200`、`token=0`、`set-cookie=0`、`cache-control: no-cache` | ✔ 无泄漏 |
| C2 | 白名单绕过变形（`--path-as-is`） | `/index.html.bak`→404/token=0；`//index.html`→200/**token=1**；`/./index.html`→200/**token=1**；`/index.html/`→200/**token=1**；`/INDEX.HTML`→200/**token=0**；`/index.html%2f`→200/**token=1**；`/index.html?x=1`→200/token=1；`/../package.json`→200/token=0；`/%2e%2e%2fpackage.json`→404；`/%E0%A4%A`→400。**没有任何响应出现别的文件** | ✔ 见 §5 的辨析 |
| C3 | 路径穿越 / 畸形编码 | `/%2e%2e%2fpackage.json` → 404 `web-not-found`；`/%E0%A4%A` → **400** `web-invalid-path`（不回显） | ✔ |
| C4 | 移动端是否放宽 Bearer/CSRF/限流 | 两端口逐条相同：`noauth=401`、`nocsrf=403`、`wrongmethod=405` | ✔ 一字未放宽 |
| C5 | admin 端点 | 未设 `BAH_ADMIN_TOKEN`：两端口 `POST /api/admin/halt` → **404**（不暴露路由存在性） | ✔ |
| C6 | 安全头与 cookie 属性 | 两渠道 5 头**逐字节相同**：CSP（`script-src 'self'`）/ XCTO nosniff / XFO DENY / referrer no-referrer / `permissions-policy: camera=(), microphone=(), geolocation=()`；`set-cookie: bah_csrf=…; Path=/; SameSite=Strict`（**无 HttpOnly**，double-submit 设计要求） | ✔ 安全头一寸未改 |
| C7 | 归属校验在平移中丢失 | `http-adapter.test.ts` 参数化两渠道跑 `foreign-ticket`（且不触达 `answer`）、`reason-required` 500/501 边界、`invalid-decision`、`already-decided`、`expired`；`mobile/adapter.test.ts` 另证 `sessionId` 透传后移动端同样 `foreign-ticket` | ✔ |
| C8 | 凭证落盘 | `.tmp-review-{web,mobile}` 会话目录与 `docs/evidence` 内 `grep -rl "review-web-token\|review-mobile-token"` = **0**；证据里的 token 一律 `<masked>` | ✔ |

## 5. D 类 · 口径探针 + 对施工方 6 条新增偏差的表态

| # | 判据 | 实测 | 判定 |
|---|---|---|---|
| D1 | 逐条复算 facts | `npx tsx scripts/verify-facts.ts` ✔（门禁 44 / 工具 16 / plan 2246 / 快照 8·34） | ✔ |
| D2 | 有没有把"分期/占位/降级"写成"已实现" | `effects` 对 `verify_*` 的缺口、`choice`/`goal` 只定契约、前端未补 case、`entry` 仍是 `index.html` 四处均在 `01-construction.md` §5 与交接件 §3 明示 | ✔ |
| D3 | 派生帧确定性 | `projectTodo` 正序/逆序/再正序 `a===b===c`（逐字节）；`openCount=2` 与手工计数一致；`projectEffects` ③④ 返回 `null` | ✔ |
| D4 | 门禁自身确定性 | 连跑两次 `verify-channel-capabilities.ts`，输出**逐字节相同**（依赖 `walk` 的 `.sort()`） | ✔ |
| D5 | 冻结面零改动 | `git diff --cached --name-only` 无 `docs/contracts/*`、`docs/adr/*`、`snapshots/*`；工具数仍 16；`myUI/` 未被引入 | ✔ |
| D6 | 7551 不在禁用表 | `FETCH_BAD_PORTS` 实测表内含 6665–6697 等，**不含 7551**；`port` 显式给出 ⇒ 占用即 `web-listen-failed`，不换端口 | ✔ |

**对 V8–V13 逐条表态**

| 偏差 | 表态 | 依据 |
|---|---|---|
| V8 `effects` 对 `tier:'unknown'` 不产出（施工单字面是 `tier !== 'green'`） | **成立**。`unknown` 的口径是"事件里没带"，把"不知道"当"写"就是编造一条"已发生操作"（D7 禁止编造字段）。收紧为 `yellow\|red` 后用例与取证脚本都钉住 | `frames.ts:19` 的 `FrameTier` 注释 + `project.test.ts` "tier 为 unknown 不产出" |
| V9 `HttpChannelOptions` 多一个 `adapter` 工厂参数 | **成立**。不传工厂只能在 host `switch(channelId)` 或让 `channel.ts` 直接调 `createHttpChannelAdapter`（那会变成第三处调用、E3 当场破） | `grep createHttpChannelAdapter` = 1 定义 + 2 调用 |
| V10 施工单 §3.8 / 00 §8 C2 把 `//index.html`、`/./index.html` 列为"不得注入"是事实错误 | **成立**（本次独立证明）：`normalize(strip('//index.html'))='index.html'`、`resolve` 后与 `tokenEntries[0]` **同一绝对路径**；`/index.html/` 经 `resolve` 也折叠成同一路径；`/INDEX.HTML` 解析到**不同**绝对路径 ⇒ 不命中。`new URL('/../package.json')` 在 HTTP 层已归一为 `/package.json`，穿越分支只能靠 `%2e%2e%2f` 走到（实测 404）。安全的真判据是"**有没有别的文件**拿到 token"——C1 已证否 | `node -e` 归一化取证 + C1/C2 实测 |
| V11 E4「diff 只有 import 行」不可满足 | **成立**。D4 扩字段后原 `toEqual({5 字段})` 对整对象断言必红；现写法期望字面量未改、仍严格 `toEqual`，12 例不变 | A2 |
| V12 `gen-architecture.ts` 的 `PROFILES` 加 `mobile` | **成立且必要**。不加则装配矩阵把可运行的 `channel:mobile` 写成"全未装配"，属 D 类失真；改动在生成器输入侧，未手改生成块 | `docs/architecture.md` 生成块由脚本产出（gate `architecture` ✔，组件覆盖 24/24） |
| V13 `snapshot.test.ts` 白名单加 `effects` | **成立**。该用例本意是"未知领域事件不得变成未知帧"，`effects` 是已知帧且由真实回放产出；加白名单是语义保真 | B3 |

## 6. 施工方未登记、本次审查发现的两点（非缺陷，但应记录）

1. **TC-MCH-20/21 的落点与施工单不同**：施工单说"复用 `dispatch.test.ts` 参数化两渠道"，实际落在新增的
   `web/channel.test.ts`（真 boot 两个插件、真 HTTP 请求），`dispatch.test.ts` 只改了 `deps` 夹具字段名。
   判定：**证据更强**（真装配 vs 夹具），但施工方未在偏差表里写明 ⇒ 记入本报告，后续单按"channel.test.ts 覆盖 TC-MCH-20/21"取用。
2. **`projectEffects` 的 `ticketId` 语义是"最后一个带票的条目"**：累积时后写覆盖前写。当前每 turn 至多一张票的场景下无歧义；
   多票同 turn（如两笔转账都过审批）时帧上只会显示最后一张。施工单未定义该语义 ⇒ 建议 04 单接线时补注释或改成 `readonly ticketIds`。

## 7. 条件（不阻塞 01 合并，但必须在指定时点闭合）

| # | 条件 | 到期动作 | 负责人 |
|---|---|---|---|
| C-1 | 00 §8 C2 / 01 §3.8 的「`//index.html` 不得注入」判据是错的，若下游单照抄会把正确实现判红 | 在 **02/03/04 各自的"偏差登记"**里写明本报告 §5 V10 的结论（**不要改 00/01 原文**——那是当时输出）；02 单的安全探针按"别的文件有没有拿到 token"写 | 02 单施工会话 |
| C-2 | `coverage-baseline.json` 未更新（本机 Windows 无法复现 CI/Ubuntu 口径，`verify-facts` 明示跳过新鲜度比对） | CI/Ubuntu 首跑后，用该口径的数同批更新 `coverage-baseline.json` + `gen-architecture` 重生成 | 下一次 CI 收口会话 |
| C-3 | `assertions` / `tracked-sources` 两条继承红（并行「可观测性」线未跟踪的 `packages/cli/src/cli/observe-http.test.ts`） | 并行线收口后复跑 `pnpm gate`，确认 44/44；**不得**由 01 单替它 `git add` | 并行「可观测性」会话 |

## 8. 本报告自身最可能错的 3 条（§9.4：复审也要被复审）

1. **"`//index.html` 注入是安全的"** —— 若有人能构造出"归一化后落到白名单绝对路径、但读取的是**另一个文件**"的输入，这条就错。
   证伪方式：在 POSIX 上复跑 C2（Windows 的大小写/尾随分隔符行为不同），并检查 `readFile(target)` 的 `target` 与 `tokenEntries[i]` 是否逐一相等（当前实现是 `includes` 精确等值，理论上不可能错）。
2. **"15 条负控覆盖了 I1–I10"** —— 初稿只有 12 条且 I6 仅两种变体；本报告定稿前补了"`entry` 不在 `entries` 里""`entries` 重复""不以 `.html` 结尾"三条，
   现已 15 条全命中。仍存的空白：I1/I2/I3/I5/I7/I8/I10 **各只有一种**违规形态（例如 I10 只试了 `microphone=(self)`，
   没试"整行删掉"与"末尾多一个空格"）；I9 的行数上限（>80 行）没有负控。
   证伪方式：对这 3 条各补一个变体；若某条不咬，A5 结论按该条降级。
3. **"`effects`/`todo` 真接通"** —— 我的证据是"真实日志回放产出了 `effects`"+"plan 事件产出 `todo`"，但**没有**验证"前端拿到后会显示"（那是 02 单）。
   证伪方式：在浏览器里喂一条 plan 事件看 UI；当前结论只到"服务端投影层已产出"，`01-construction.md` §5.3 已如实写明前端未消费。
