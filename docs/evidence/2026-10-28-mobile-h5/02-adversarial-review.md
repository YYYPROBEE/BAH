# 02 · 移动 H5 壳与交互面 —— 对抗式复审报告（2026-10-29）

## 0. 审查者与被审者的分离：**未达成**

00 §9.1 要求"审查者：新会话 / 新子任务"。**本轮没有做到**：用户在本会话明令**禁止派任何子智能体（含只读审查）**，
因此复审由**同一会话、同一执行者**完成。

这带来一个必须写在最前面的结论限制：

- 独立的"审查者视角"缺位 ⇒ 我对自己代码的盲区不会被第二双眼睛发现；
- 因此本报告的**通过项**强度**低于**一次独立复审；请把它读作"自审 + 逐条可复算的判据"，
  而不是"第三方背书"；
- 补救：§9 给出**外部复核清单**（6 条，每条都可独立执行），建议由 03/04 单的会话或人工复核。

方法论上是可救的：本报告每一条都给出**命令与期望输出**，任何第三方可以原样重跑并否掉我的结论
（00 §9.4：「复审说红的那条，判据本身成立吗？」——§6 我抓到自己两处判据写错）。

---

## 1. 输入

| 输入 | 说明 |
|---|---|
| 施工单 | `02-移动H5壳与交互面.md` + `00-全局约定.md`（D1–D14） |
| 变更面 | `apps/web/m.html`、`apps/web/src/mobile/**`（10+10 文件）、`apps/web/styles/mobile.css`、5 个图标、`scripts/verify-mobile-shell.ts`、`scripts/verify-web.ts`、`scripts/ci.ts`、`profiles/mobile/patch.yml`、台账 |
| 未变更面（关键） | `apps/web/src/{transport,store,dom,main}.js`、`apps/web/src/views/**`、`apps/web/styles/app.css`、`packages/**` —— **零 diff** |
| 探针原始输出 | `02-review-probes.txt`（A/C 类）、`02-review-probes-d.txt`（D/B 类）、`02-gate-negative-controls.txt`（27 条负控）、`02-gate-after.txt`、`02-test-web.txt`、`02-test-unit.txt` |

---

## 2. A 类探针：绿是不是真的

| # | 判据（命令 / 期望） | 实测 | 判据成立吗 |
|---|---|---|---|
| A1 桩泄漏 | `grep -nE "vi\.\|deps\.api\|deps\.connect\|fakeStorage" apps/web/src/mobile/*.js \| grep -v "\.test\.js"` | 仅 4 处命中，**全是 `shell.js` 的可选注入点**（`const api = deps.api ?? createHttpApi()` / `const connect = deps.connect ?? connectEvents`）；`vi.` 与 `fakeStorage` **零命中** | ✅ 桩只在 `.test.js` 里；生产缺省走真实 transport |
| A2 地板抬了断言松了 | 精确断言（`toBe/toEqual/toHaveBeenCalledTimes/toHaveBeenCalledWith/toContain/toBeNull/toMatch`）占比 vs `toBeTruthy/toBeDefined` | 精确 **536** 条；`toBeTruthy|toBeDefined` **0** 条 | ✅ 100% 精确，无"凑数断言" |
| A3 "零 decision"不是口头化 | `grep -c "toHaveBeenCalledTimes(0)"` 于两个文件 | `approval-sheet.test.js` **13** 处、`gesture-confirm.test.js` **7** 处 | ✅ TC-MOB-05/06/07/10/11/12 全部有 spy 计数断言 |
| A4 去重不是自说自话 | TC-MOB-25 是否断言 **DOM 级** 一份 + `since=lastSeq` | `shell.test.js` 断言 `[data-role="steps"]`/`[data-role="step"]`/`[data-role="sheet"]` 的**节点数**，并断言重连 options 的 `since` 与 `maxRetries` | ✅ 不是只看游标数值 |
| A5 节流不是快照糊弄 | live 文本**变更次数**计次 | `gesture-confirm.test.js:281-300` 逐 move 采样并累加 `changes`，断言 `<= 8` 且 `> 0` | ✅ 计次而非看终值 |
| A6 有没有 `only/skip` 掏空 | `grep -rnE "\.(only\|skip)\(" apps/web/src/mobile/*.test.js` | 零命中 | ✅ |
| A7 地板是不是只增 | 桌面用例文件仍在？ | `apps/web/src/*.test.js` + `views/*.test.js` = **12** 个（与基线一致），`mobile/*.test.js` = 10 个；`test:web` 139 → **333** | ✅ 只增未删 |

**A 类结论：通过。**

---

## 3. B 类探针：门禁绕得过吗 / 四点闭环通了吗

### 3.1 门禁负控（B1–B5 + 扩展，27 条）

判据：`.tmp-mobile-shell-drill/drill.ts` 在**独立夹具树**上逐条注入违规、跑门禁、断言不变量编号命中、还原。
原始输出 `02-gate-negative-controls.txt`。

```
夹具基线：✔ 绿
负控 27 条：27/27 被抓住
还原后夹具：✔ 绿（还原干净）
```

| 探针 | 注入 | 抓到的不变量 |
|---|---|---|
| B1 fallback 藏裸值 | `color: var(--text-default, #fff)` | `I4 mobile.css:964 出现裸色值（含 fallback 形态）` |
| B2 第二份实现藏子目录 | `src/mobile/lib/net.js` 里 `fetch(` | `I5 ... 出现 'fetch('` |
| B3 图标换皮 / 越界 | Lock.svg 末尾加一行；`url('../../design/...')` | `I9 ... sha256 不一致（换皮了）` / `I9 ... 不在白名单内` |
| B4 theme-color 漂移 | `#FFFFFF` → `#000000` | `I4b ... 与 DS 令牌 --bg-base-default 不一致` |
| B5 豁免清单膨胀 | 本门禁 `TOUCH_EXEMPT` **长度为 0**（`verify-mobile-shell.ts:90`）| 无需豁免：blanket 规则一次覆盖全部可点元素；另有一条负控"抽掉 blanket 规则"也被抓 |
| + | `import 'vue'` / `eval(` / 远程 css / 协议相对 url / `<style>` / 内联 style / 无 src 脚本 / 引 app.css / 改 DS 副本 / 32px 按钮 / 去 safe-area / 去 viewport-fit / icon('send',20) / icon('nope') / 白名单外 bah-web-token / `__BAH_WEB_TOKEN__` / 拼错令牌名 | 全部抓到 |

**门禁自身是否绕过**：`grep -n "notes.push" scripts/verify-mobile-shell.ts` → 6 处，**全是统计与例外说明**，
没有任何一条"违规"被降级成 notes（`I7` 的豁免分支写 notes，但豁免表为空且负控证明它不为空时会被抓… 见 §6 的自我更正）。

### 3.2 四点闭环：声明 ↔ 发射 ↔ 投影 ↔ 前端消费

| 能力面 | 声明 | 发射 | 投影 | 消费 | 结论 |
|---|---|---|---|---|---|
| `approval` | `frames.ts:135-162` | ✅ `project.ts`/适配器（既有） | ✅ | ✅ `approval-sheet.js`（字段集逐项对齐，TC-MOB-01） | **闭环** |
| `dag` | `frames.ts:239-248` | ✅ 既有 | ✅ | ✅ `plan-steps.js`（9 态实名 + blocked 显式） | **闭环** |
| `tool` | `frames.ts:115-132` | ✅ 既有 | ✅ | ✅ 有 DAG 挂步骤、无 DAG 进会话流（`shell.js:118` 的 `dispatchFrame`） | **闭环** |
| `choice` | `frames.ts:265-287` | ❌ **不存在**（`prompt_ask` 属 03） | ❌ | ✅ `choice-card.js` | **只声明 + 只消费，无发射** |
| `goal` | `frames.ts:293-305` | ❌ 属 04 | ❌ | ✅ `plan-steps.setGoal` | 同上 |
| `todo` | `frames.ts:312-343` | ❌ 属 04（派生） | ❌ | ✅ `plan-steps.setTodos`（只读） | 同上 |
| `effects` | `frames.ts:349-374` | ❌ 属 04 | ❌ | ✅ `effects-list.js` | 同上 |
| 能力位 `gestureConfirm:true` | ✅ `capabilities.ts` | ✅ `/api/session` | — | ✅ 抽屉里挂手势条（`shell.test.js` 断言 `[data-role="thumb"]` 存在） | **闭环** |
| 能力位 `voiceInput:'ime'` | ✅ | ✅ | — | ✅ chips + IME 层；`'none'` 时不渲染（用例双分支） | **闭环** |
| 能力位 `layout/approvalSurface/dagView` | ✅ | ✅ | — | ✅ 不符时 fail-loud 提示（`shell.js:540-542`） | **闭环** |

**B 类结论：门禁侧通过；契约侧有条件通过。**
四个新帧在 **02 收口时是"只声明 + 只消费、无发射"** —— 这是 02 单范围（"只渲染"）内的正常状态，
但**对外材料不得据此宣称"移动端支持追问 / 目标 / 待办 / 影响面"**，只能写"呈现层已就位，语义层待 03/04"。
`02-construction.md` §2、`PROGRESS.md` §96.36 与 handoff §3 都按此写法。

---

## 4. C 类探针：移动端有没有变成绕过面

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| C1 手势能否替代红级强验证 | `tier=red + challenge` 的票：点批准 ⇒ `verify` 恰一次；verify 失败 ⇒ `decide` 零调用；手势只解锁按钮 | `approval-sheet.test.js` 两条用例 | ✅ 手势 ≠ verify。**但两者都只是 UI 约束**（见下方 C1-b） |
| **C1-b（本单最重要的口径发现）** | 服务端是否强制"先 verify 再 decide"？ | `packages/channels/src/http-adapter.ts:170` 的 `decide()` 只校验：票据存在 / 归属 / 结论合法性 / 拒绝理由必填与长度（`:177-192`），**没有任何 verify 状态校验**；`:194` 直接 `view.answer(...)` | ❌ **不强制**。方案文档 C1 探针写的"服务端强制（adapter.ts:213-228）"**不成立** |
| C2 脚本直接 POST 批准 | `curl -X POST /api/approval/:id -d '{"decision":"allowed-once"}'`（带 Bearer + CSRF） | 服务端会接受（预期行为） | ✅ README 已逐字写 D11 三句话，未把滑动说成防线 |
| C3 m.html 之外拿 token | 门禁 I10 白名单 + `__BAH_WEB_TOKEN__` 零命中 | `I10 token 面命中 11 个文件，占位符命中 0 个`；“白名单外出现 bah-web-token”负控被抓 | ✅ |
| C4 IME 零权限面 | ①生产源码 grep 五个字面量；②运行时 spy；③chips 不绕过审批；④组合期零请求 | ①零命中；②`getUserMedia`/识别器调用次数 0；③`choice-card`/chips 都只发 `POST /api/turn`；④TC-MOB-17 三条 | ✅ |
| C5 CSP 被内联样式破坏 | m.html 零 `style=`/`<style>`/内联脚本（I3 三条负控）；源码零 `setAttribute('style'` | 门禁 I3 负控 3 条全被抓；grep 零命中 | ✅ |
| C6 SW 缓存旧 token | `grep -rnE "serviceWorker\|manifest\.json\|workbox" apps/web` | 零命中 | ✅ |
| C7 CSRF/Origin 在移动端仍生效 | mobile 源码里有没有自己的鉴权分支？`grep -nE "authorization\|Bearer\|x-bah-csrf\|bah_csrf" apps/web/src/mobile/*.js`（排除测试） | **零命中** —— token 与 CSRF 的读取/回填全在共享层 `transport.js:17-27,50,56` | ✅ 移动端不可能"简化鉴权" |
| C8 安全头未动 | `git status --porcelain packages/` | 只有并行线的文件；`packages/host/**` 里没有我的改动；`http.ts` 的 `permissions-policy` 逐字未变 | ✅ |

**C 类结论：通过（含一条口径收紧项 C1-b）。**
C1-b 的处置：①代码照旧在界面层拦（与桌面一致）；②`gesture-confirm.js` 头注释、README「移动 H5 的能力边界」、
handoff §5 都如实写明"强验证不是服务端强制"；③修它要动 `packages/**`（02 禁改面），列为后续独立项。

---

## 5. D 类探针：文档说的与代码做的是否一致

| # | 判据 | 实测 | 结论 |
|---|---|---|---|
| D1 桌面/移动字段集漂移 | 并排 `views/approval.js` 渲染字段 vs `approval-sheet.js` vs `frames.ts:135-162` | 桌面：操作类型/金额/收款人/收款手机/手续费/风险级别/等待时长；移动：同上 7 项（"等待时长"在有条 `expiresAt` 时呈现为倒计时）；`name/callId/ticketId` 两边都只进 `dataset` | ✅ 字段集相等，容器不同 |
| D2 blocked 被折叠 | 3 连续 blocked 夹具 | `plan-steps.test.js` 断言 3 行独立可见、`closest('[data-role="step-body"]')` 全为 `null` | ✅ |
| D3 44px 与密集信息冲突 | 只读行零点击副作用；可交互行独立成行 | `effects-list.test.js` 断言零 button/a/input；`plan-steps` 的只读 todo 也断言零勾选控件 | ✅ |
| D4 reduced-motion 半降级 | 开 reduce 后倒计时/状态机/手势 aborted 语义是否都在 | TC-MOB-30（抽屉与手势各一条）；`mobile.css` 的 reduce 块只把 `transition/animation-duration` 归零 | ✅ 动效降级 ≠ 功能降级 |
| D5 数字口径 | 自己复算：门禁数 / 工具数 / `test:web` | `ls scripts/verify-*.ts \| wc -l` = **45**，`facts.md` = `**45/45**`；`grep -c "name: '" specs.ts` = **16**；`02-test-web.txt` = **333** | ✅ 一致 |
| D6 反向失真（把已实现写成未实现） | `grep -rn "apps 下无 mobile\|无 mobile\|m.html 不存在\|移动壳未" docs/*.md README.md facts.md` | 零命中 | ✅ |
| D7 把降级/预演写成真实 | `grep -rn "定时任务已实现\|真定时\|识别准确率 [0-9]"` | 零命中；README 明写"不承诺识别准确率"、chips 是桌面模拟的兜底 | ✅ |
| D8 把手势/强验证写成安全控制项 | `grep -rn "手势.*控制项\|强验证.*服务端强制"` | 2 处命中，**都是否定句**（README:59 的 D11 第三句、handoff 的"不是服务端强制"） | ✅ 口径正确 |
| D9 台账同批 | 门禁 45/45 出现在 `facts.md`;`facts-sources.md` `gates=45`;`README`/`security-self-assessment`/`testing.md` 均已改；三份生成块由 `gen-architecture.ts` 重写 | `verify-facts`、`docs-consistency`、`architecture` 三个门禁在 `02-gate-after.txt` 里**全绿** | ✅ |

**D 类结论：通过。**

---

## 6. 复审自身的复审（00 §9.4）：我抓到自己两处判据写错

历史教训是"一审抓对了 4 条阻断，但它给的处置建议里有 2 条无效/错误"。本轮我自己的探针错了两处：

1. **快照文件数**：第一版探针用 `ls snapshots/*/*.test.ts | wc -l` 得到 **7**，与 facts 的 8 不符，差点报成"口径失真"。
   真相：第 8 个是根级的 `snapshots/fixtures.test.ts`，被我的 glob 漏掉。改用 `ls snapshots/*.test.ts snapshots/*/*.test.ts` 得 **8**，与 `facts-sources.md:14` 一致。
   ⇒ **判据本身不成立时，"红"是我的脚本红，不是代码红。**
2. **快照用例数**：用 `grep -h "it(" | wc -l` 得 **43**，与 facts 的 34 不符。真相：`verify-facts.ts:307` 用的是词法扫描
   `countItBlocks()`（`verify-assertions.ts` 有同款告警："必须是词法扫描，不能用正则"），正则会把字符串/注释里的 `it(` 算进来。
   ⇒ 权威值是 34（`verify-facts` 绿即证明 declared == computed），我的 43 是**假红**。

两处都记为"复审工具缺陷，不是代码缺陷"。这也说明 §9.2 的"每单必查"里，**判据本身要先验**。

3. **门禁 I10 把自己的证据文档判成违规**（首次全量跑 `pnpm gate` 时 `mobile-shell` 报红）：
   本单的 `02-construction.md` / 本报告为了讲清"不许用占位符"这条不变量，**引用了那个占位符串本身**，
   而 I10 的占位符检查当时扫全部 `.md`。处置：把占位符检查收窄到**可执行 / 配置面**（排除 `.md`）——
   占位符要生效只能经 HTML / JS / 配置，文档不构成注入面；同时 **m.html 注入占位符的负控仍然被抓**（`I10-b`），
   所以这不是"为了绿而放宽"，而是把判据的适用范围说对了。收窄后 `pnpm gate` 回到 43/45（只剩两条继承红），负控 27/27 不变。

---

## 7. 结论

### **有条件通过**

四类探针里 A / C / D 全绿，B 的门禁侧全绿（27/27 负控）、契约侧有 4 条能力面"只声明+只消费、无发射"（属 03/04 范围，已在材料里如实标注）。

#### 条件清单（每条给到期动作与责任，不允许写"建议后续优化"这类无主句）

| # | 条件 | 到期动作 | 责任 | 到期 |
|---|---|---|---|---|
| K1 | **强验证不是服务端强制**（C1-b）：`http-adapter.ts:170` 的 `decide()` 不校验 `verify()` | 在服务端 `decide()` 里加"红级票据必须有已通过的 challenge"校验，并补一条"跳过 verify 直接 decide 应被拒"的用例 | 后续独立单（要动 `packages/**`，02 禁改面） | 03/04 之前或并行另开 |
| K2 | **choice/goal/todo/effects 四个能力面无发射端** | 03 单接 `prompt_ask`（choice）、04 单接 `goal_set`/`todo` 派生/`effects` 派生；接完重跑本报告的 B.3.2 表 | 03 / 04 单 | 各自收口时 |
| K3 | **`retry-after` 响应头未透出**（`transport.js` 的 `request()` 只回 `{ok,status,code,reason}`） | 给返回对象加 `retryAfterSeconds`（纯增量），`shell.js` 的 `RATE_LIMIT_FALLBACK_SECONDS` 从 60 降为真正的兜底 | 共享层属主（并行「可观测性」线）或 03 单 | 03 收口前 |
| K4 | **`store.js` 的 `frameKey` 缺四新帧 case**（前端那份；后端 `frames.ts:414-425` 已有） | 与并行线对齐后统一加，并同批跑 `test:web` | 03 / 04 单 | 需要键控替换语义时 |
| K5 | **真机走查 ①②③**（首屏安全区 / 键盘避让 / 横屏重排） | 真机走查并回填 `walkthrough/` 截图 | 04 收口会话 | 04 彩排前 |
| K6 | **本报告独立性不足**（§0） | 按 §9 的外部复核清单抽 6 条独立复跑 | 03/04 会话或人工 | 下一次复审 |

---

## 8. 复审过程中发现并已修的三项（修在施工提交内，不在本报告提交内）

复审探针顺带发现三处**未使用面**（B 类"声明不发射"的同类问题），已在施工提交前修掉：

| # | 问题 | 修法 | 复验 |
|---|---|---|---|
| 1 | `composer.setSendBlocked(seconds, message)` 的 `message` 参数生产路径从不传（死参数） | 删掉第二参，函数内固定文案 | `composer.test.js` 15 例仍绿 |
| 2 | `approval-sheet.js` 导出 `URGENT_SECONDS` / `COUNTDOWN_ANNOUNCE_SECONDS`，但用例直接用行为断言、并不 import 它们 | 降级为模块内常量（不留无人使用的导出） | `approval-sheet.test.js` 36 例仍绿 |
| 3 | `shell.js` 的 `reconnectNow()` 是对外暴露的测试/联调接口，但**没有任何调用点** | 删除（`visibilitychange` 的立即重连路径已有用例覆盖） | `shell.test.js` 44 例仍绿 |

修后：`npx vitest run --config vitest.web.config.ts apps/web/src/mobile` → **10 文件 / 194 例全绿**。

---

## 9. 外部复核清单（给下一位审查者的 6 条，逐条可独立执行）

1. `pnpm gate` —— 期望 **43 绿 / 2 红**（`assertions` + `tracked-sources`，均属并行「可观测性」线；若已归零则更好）。
2. `npx tsx scripts/verify-mobile-shell.ts` —— 期望 `✔ mobile-shell`；再把 `TOUCH_EXEMPT` 临时改成 `['.m-chip']` 并删掉 blanket 规则，确认它仍能抓到"触控纪律没有落点"。
3. `npx tsx .tmp-mobile-shell-drill/drill.ts` —— 期望 `27/27 条负控被抓住`、`还原后夹具 ✔ 绿`。
4. `pnpm test:web` —— 期望 **22 文件 / 333 用例**；再 `grep -c "it(" apps/web/src/mobile/*.test.js` 与报告交叉核对。
5. 逐条复算 §5 的 D1（字段集三方差分）与 §4 的 C7（mobile 源码零鉴权分支）。
6. 抽读 `apps/web/src/mobile/approval-sheet.js` 的 `closeByUser` 与 `submit`，确认"半途关闭零 decision"与"在飞锁"**不是注释而是代码**（关键行：`631` / `395`）。
