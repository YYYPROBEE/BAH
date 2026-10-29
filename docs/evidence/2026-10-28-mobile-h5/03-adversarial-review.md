# 03 单对抗式复审报告 · 意图理解与追问平面

> 协议：`00-全局约定.md` §9（四类探针 · 三档结论 · 复审自身也要被复审）
> 日期：2026-10-29 · 只出报告，不改代码（本文件之外无任何源码改动）

## 0. 前置声明（先说结论的可信度）

**审查者与被审者未分离。** 本报告由施工同一会话、同一模型在主线程完成；本环境的用户明令禁止派任何子智能体
（含只读审查），因此无法满足 00 §9.1「审查者新会话、只读」的要求。

后果，如实写：

1. 我在施工中自己发现并修掉的缺陷（§4 的 D-1～D-9）**已经**不在代码里，所以本报告的探针不会再把它们抓出来——
   这恰恰说明探针的覆盖面是有限的；
2. 「我没抓到」不等于「不存在」。§5 的 K6 把「外部复审」列为交付条件，不是客套话；
3. 为了让复审仍有判别力，本报告的所有判据都是**可执行命令**（原始输出见 `03-review-probes.txt`），
   任何第三方可以逐条复跑，不需要相信我的结论。

## 1. 结论：**有条件通过**

条件（§5）：

- **K1–K5 属遗留边界**（已知、已写入文档、不影响 E1–E12 的达成）；
- **K6 外部复审**必须在 04 单或人工评审时补做（本报告不能替代）；
- **K7 三个门禁红**归并行「可观测性」线，本单不修也不该修（提交后用干净树复核）。

出口标准 E1–E12 的逐条对照见 §3。

## 2. 四类探针（每条给判据与实测）

### 2.A 造假探针（假绿）

| # | 探针 | 判据 | 实测 | 判定 |
|---|---|---|---|---|
| A1 | eval 断言被写松 | 每条 expect 必须有具体 `equals` 或具体 `type`；资金场景保留否定断言 | T-13 三条 `equals`（`vague` / `true`）+ `no-event transfer/created`；T-14 四条；T-15 四条；T-16 五条；Q-11 四条；Q-12 三条——全部是具体值，无 `toBeTruthy` 式断言 | ✅ |
| A2 | MockScript 只覆盖 happy path | Q-12 必须含「答非所问」与 exhausted 步 | Q-12 脚本 9 步：3 次 `prompt_ask`（第 3 次 `candidates: []`）+ 3 次 `intent_resolve`（含「嗯」「啊这个」）+ 最后才 `transfer_preview` | ✅ |
| A3 | 门禁用 grep 被注释骗 | 正夹具注释里写 `Date.now` 不得触发；反夹具必须触发 | `scripts/intent-determinism.test.ts` 11 例全绿：`ok-pure.ts` findings=[]、`bad-clock.ts` 2 条 I1、`bad-new-date.ts` 1 条、`bad-fetch.ts` 1 条、`bad-default-fill.ts` I2 ×2 | ✅ |
| A4 | findings 塞进 notes | `ok` 必须绑定 `findings.length===0` | `verify-intent-determinism.ts:228`：`return { ok: findings.length === 0, findings, notes }`；`notes` 只有扫描统计与口径播报 | ✅ |
| A5 | 抬地板却删用例 / 名单缩容 | `git diff ci.ts coverage-allowlist.ts` 只允许 + | 地板 2829→2989（+160，等于新增用例数）；allowlist 只 +2 条（`runtime/intent/`、`interaction/prompt/`），无删除 | ✅ |
| A6 | 手改 `reverified.json` | 只能由 `snapshot:reverify` 产生，且伴随 `session.jsonl` 改动 | 7 个 case 的 `reverified.json` 都与 `session.jsonl`/`scenario.json` 同批改动（3～5 个文件/case）；重录走 `BAH_SNAPSHOT_RECORD=1`，reverify 写入 7 个 | ✅ |
| A7 | dist 陈旧造成假绿 | `tsc -b` 全量 + 干净跑 | `npx tsc -b` exit 0；`vitest run` 260 文件 / 2990 例全绿 | ✅（附注：`pnpm build` 未在本轮跑，见 K8） |

### 2.B 契约探针（声明 ↔ 发射 ↔ 投影 ↔ 前端消费）

| # | 探针 | 判据 | 实测 | 判定 |
|---|---|---|---|---|
| B1 | 工具注册了但没人调 | `--dump-config` 三个 profile 都列出两工具 | `pnpm bah --profile headless --dump-config`：**21 行**，含 `intent:plane` / `prompt:ask`（两行在 `core:tools` 之后、base bundle 内） | ✅ |
| B2 | `choice` 帧有 projector 没前端消费 | `project.ts` 有分支 + 02 单 `choice-card.js` 有渲染 | `project.ts` 的 `tool/result` 分支产 `choiceFrame`；`project.choice.test.ts` 9 例；`apps/web/src/mobile/choice-card.js` 已有 `frame.prompt` / `frame.options` 渲染（02 单单测覆盖） | ✅ |
| B3 | 只声明没发射 | `IntentProposal` 必须有构造点 | `resolve.ts:380 buildProposals` 构造两处（R-IMP-1/R-IMP-2）；TC-INT-09/10 断言非空；eval T-16 断言 `decision=propose` | ✅ |
| B4 | barrel 忘了导出 | `interaction/src/index.ts` 命中 `prompt` | `index.ts:8 export * from './prompt/index.ts'`；`import { buildChoices } from '@bah/interaction'` 在 typecheck 面通过 | ✅ |
| B5 | schema 声明了没注册 | 删字段的出参必须被 ⑤e 拦成 `tool-result-invalid` | `intent.test.ts` 用 `checkToolResult` 直接验：缺 `kind` ⇒ `required` 违规；真实管线里 `intent_resolve` 出参过校验（T-13 的 `tool-result` 断言依赖它） | ✅ |
| B6 | `askLedger` 每次新建 | 台账不跨 turn ⇒ Q-12 必红 | Q-12 通过；`intent.test.ts` 连续三次 `prompt_ask`，第三次 `askExhausted=true` 且 `askCount==2` | ✅ |
| B7 | `choice` 帧字段编造 | 每个帧字段能追到 `tool/call` 的 args | 9 例逐字段等值：`prompt←args.question`、`options[].id←args.candidates[].value`、`label←label`、`callId←data.callId`；`degraded`/`askExhausted` 明确**不在帧里**（测试反向断言） | ✅ |

### 2.C 安全探针

| # | 探针 | 判据 | 实测 | 判定 |
|---|---|---|---|---|
| C1 | 诱导「直接执行」 | R-IMP 恒 propose，TC-INT-12 属性式穷举 | `SCENE_HINTS` 9 词 × 4 模板 = 36 组全部 `propose`、永不 `proceed`；「爱人生日快到了，直接给张三转520」判 `explicit`（动词优先） | ✅ |
| C2 | confidence 被话语污染 | 只来自静态词表；无 utterance→数字路径 | `crossSceneConfidence` 只有 `weights[word]` 累加 + `Math.min(…,100)`；`recall.ts` 无 `parseFloat`/`Number(` | ✅ |
| C3 | 追问死循环 | 上限 2 + 降级 + 计数不因换话头清零 | `MAX_ASK_PER_SLOT=2`；TC-INT-29/30；Q-12 端到端；askCount 存在会话 Map 里，只有 `commit` 更新 pendingAsk，不清计数 | ✅ |
| C4 | PII 进日志/证据/快照 | 证据与 transcript 零 11 位以上数字 | `grep -E "[0-9]{11,}" 03-demo-transcript.txt` **零命中**；`sanitizeSpan` 先手机号后账号（顺序反了会错标 `[redacted:account]`） | ✅ |
| C5 | 点选被当审批 | `choice-card.js` 无 `/api/approval` | **零命中**；点选只 `POST /api/turn`（一条普通 `user/message`）；`prompt_ask` 绿级 + `sideEffect:'none'` + 不触票据 | ✅ |
| C6 | 候选 label 注入 | `validateLabel` fail-loud + 前端 textContent | 21 字/含 `\n`/含 `<` 各抛 `prompt-choice-invalid`；`choice-card.js` 的 `innerHTML` **零命中** | ✅ |
| C7 | `prompt_ask` 被当闲聊工具刷 | description 限定 + 上限 | description 明写「仅在 decision=ask 且存在候选时调用」；第 3 次自动降级为开放式 | ✅ |

### 2.D 口径探针（文档说的 = 代码做的）

| # | 探针 | 判据 | 实测 | 判定 |
|---|---|---|---|---|
| D1 | router 被写成 NLU | 头注释保留「不是自然语言理解」 | `router.ts` 头注新增「与意图平面的分工」段，明写「仍是确定性正则/关键词路由」「不得塞槽位解析逻辑」 | ✅ |
| D2 | 提案/预演/降级写成已执行 | 材料如实标注 | `03-demo-transcript.txt` 里 implicit 回复是「我只提建议，不会直接操作」；T-16 断言 `no-event transfer/created`；`facts.md` 新增口径三句（propose/preview/askExhausted） | ✅ |
| D3 | facts 数字与代码失配 | `verify-facts` + 自己复算 | `verify-facts` 通过：门禁 46 · 工具 16 · plan 2246 行 · 快照 8/34 · 覆盖率口径不变；场景 66 由 `eval-scenarios` 门禁复核（D=10 K=10 P=10 Q=12 S=8 T=16） | ✅ |
| D4 | 宣称确定性但偷读时钟 | 门禁 I1 + grep | `grep -rnE "Date.now\|Math.random\|new Date\(\)\|fetch\(" packages/runtime/src/intent packages/interaction/src/prompt`（非测试）**零命中**；`today` 来自 `RUN_SERVICE.now()` | ✅ |
| D5 | `scenario-dsl.md` 只改数字行 | diff 只有 §2 数字 | **不完全符合**：除了 Q10→12 / T12→16 / 60→66，我还改了 Q/T 两行的「覆盖」列描述（加括注说明 03 单新增内容）。属超出授权范围，见 §5 K9 | ⚠ |
| D6 | 「追问 ≤2」口径三处同文 | facts / 代码 / 记录 | `facts.md:123`、`tool.ts:17 MAX_ASK_PER_SLOT = 2`、`03-construction.md §5` 三处同文 | ✅ |

## 3. 出口标准对照（E1–E12）

| # | 标准 | 证据 | 判定 |
|---|---|---|---|
| E1 | 四类意图 + explicit 各有可演示样例，离线可跑 | `03-demo-transcript.txt` 五条输入（vague / vague·缺槽 / implicit / ambiguous / 跨场景拒借）+ 一条 explicit（单测与 T-13 的 preview 路径） | ✅ |
| E2 | `resolveIntent` 纯函数 | TC-INT-31（1000 次逐字节相等）、TC-INT-32（注入钟）；门禁 I1 全绿 | ✅ |
| E3 | 两工具有真实注册点与发射点 | dump-config 21 行；发射点各 3 处（router + T 族 + Q 族）；门禁 I3 | ✅ |
| E4 | 落账在冻结键上、进签名链 | 落账只有 `tool/call`+`tool/result`；两者 ∈ `SIGNED_TYPES`；会话事件类型测试断言「只有这两种」 | ✅ |
| E5 | 复现绝不直接执行 | `requiresPreview` 对 `vague` 恒 true；T-13 序列含 `transfer_preview` 且 `no-event transfer/created` | ✅ |
| E6 | 0.59/0.60/0.61 三点边界 | TC-INT-22/23 + recall.test.ts 三条；Q-11 端到端（0.59 拒借） | ✅ |
| E7 | 追问不死循环 | TC-INT-29/30；Q-12（第 3 次 `askExhausted=true`） | ✅ |
| E8 | 候选去重/排序/≤3/恒含手动/空候选 fail-loud | TC-INT-25～28（15 例） | ✅ |
| E9 | PII 纪律 | TC-INT-19～21；门禁 I5；C4 探针零命中 | ✅ |
| E10 | 出参/入参契约进 `runtime:tool-contracts` | 两 schema 注册（`intent.ts` 合并 source）；`checkToolResult` 负控；真实管线校验 | ✅ |
| E11 | eval ≥6 条进既有族、ID 唯一、断言具体 | T-13～16、Q-11～12；`eval-scenarios` 门禁 66 个全绿 | ✅ |
| E12 | 全量门禁绿、门禁数 +1 | 46/46 目标；实测 42/46（四红归因见 §4） | ⚠ 见 K7 |

## 4. 施工中自查发现并已修的缺陷（D-1～D-9）

这些**不在最终代码里**，列出来是为了让复审看到探针的盲区：

| # | 缺陷 | 后果 | 修法 |
|---|---|---|---|
| D-1 | R-ELL-1 的「有无具名实体」用了 `filled`（含会话层继承值） | 「就转给他」永远判 explicit，TC-INT-05 失败 | 改用本轮 `utteranceSlots` |
| D-2 | 「比较」在 `ACTION_VERBS` 里 | 「这钱怎么理财比较划算吗」被当 explicit，咨询式隐含意图永不触发 | 删「比较」，保留「对比」 |
| D-3 | R-IMP 直接看 `hasVerb` | 「买车」被判 explicit（"买"是动作动词） | 先剥离场景词再判动词 |
| D-4 | `crossScene` 闸门只改 decision 不改 kind | 「把那边的事接着办」落进 elliptical，继承上一轮转账参数 | 有 crossGate 即判 `vague` |
| D-5 | 会话层槽位沿用原始 `source` | 非省略句也继承上一轮金额（implicit 的 filled 里出现 500.00） | `commit` 时把并入值标成 `source:'session'`；只有 elliptical 继承 |
| D-6 | 歧义状态下仍取记忆值 | 「把转账卡的钱还上」的 filled 带着无关的 payee/amount | 歧义时不取 memory；implicit 清空 filled |
| D-7 | `prompt_ask` 声明了 `projectContent` | 出参被渲染成人类文本，eval 的 `tool-result` 取不到逐字段值（T-14/T-15 假失败） | 不声明，走默认 JSON |
| D-8 | 两个插件各自 `provideToolContracts` | 启动即 `service-conflict`（服务单实例） | 契约服务改为可叠加聚合 |
| D-9 | 门禁 I2 的黑名单/分支检查过宽 | 误伤 `DEFAULT_MAX_K` 与 `scoreOf` 的 `case 'ambiguous'`（它返回分数） | 黑名单限定槽位名；只查 `decide/decideFor` 内部的 case |

## 5. 遗留条件（不构成阻断，但必须写进材料）

| # | 条件 | 影响 | 处置 |
|---|---|---|---|
| K1 | **真实记忆层不填槽位**（`RetrievedMemory` 无结构化字段） | 装配 `bah:memory-store` 时，复现类意图只能追问、不能自动填值 | 已写入插件头注「诚实边界」；映射代码用 `v8 ignore` 标注并说明「空库下恒不执行」；后续单补 |
| K2 | `degraded` / `askExhausted` 不进 `choice` 帧 | 第 3 次追问在前端仍会显示候选（若模型仍传了候选） | 01 单的 `ChoiceFrame` 无此字段；`askExhausted` 本就不该给前端做判断（D7）；记入 02 单 K4 |
| K3 | router 的 `slotGap` 静态候选与 `askHint` 可能不一致 | 只在「金额已给、缺收款人」这一形态发选择题，其余不发 | 已在 router 注释写明；`DEMO_PAYEE_CHOICES` 与 `demoMemory` 同源，改一处要改两处 |
| K4 | 桌面壳 `store.js` 对 `choice` 帧的处置未在本单验证 | 桌面端可能出现「未处理帧」 | 属 02 单 K4（`frameKey` 已在 channels 侧支持 `choice`）；本单只验投影层 |
| K5 | 追问台账在进程内存 | 进程重启后追问上限重置 | 会话级语义；重启即新会话，可接受；不宣称持久 |
| K6 | **审查者与被审者未分离**（本文档 §0） | 本报告的独立性打折 | 04 单或人工评审补做外部复审 |
| K7 | 三个门禁红属并行线：`assertions`（`observe-http.test.ts` 未登记）、`docs-paths`（`PROGRESS.md` 的 `docs/demo/`）、`snapshot-fresh`（`saga/src/gates` 由 `6af6d64` 改动） | 本地 `pnpm gate` 42/46 | 本单不替并行线登记断言基线、不改他们的文档、不碰 saga；提交后用干净树复核本单贡献面 |
| K8 | `pnpm build` 未在本轮跑 | `dist/` 可能落后于源码 | `tsc -b` 已全量通过；`pnpm check` 的 build 步留给收口会话 |
| K9 | `scenario-dsl.md` 除了数字还改了 Q/T 两行的描述列 | 超出「只改数字行」的授权 | 如实登记；若评审裁定 contracts 整册冻结，回滚这两行描述、只留数字 |

## 6. 复审自身的复审（00 §9.4）

| 项 | 自查 |
|---|---|
| 探针是否只跑「容易过的」 | 反向补了 C1/C2/C7/D3/D6/A3/A7 七条；D5 的结论是**不符合**，没有为了全绿而改判 |
| 判据是否可执行 | 全部命令与原始输出在 `03-review-probes.txt`，第三方可复跑 |
| 是否偷偷改了代码 | 本报告之外，本轮只改了 `facts.md`（加三句口径）与 `03-construction.md`（补口径三处同文）——都是文档，不涉及行为 |
| 结论是否与证据一致 | 12 条出口标准：10 ✅、1 ⚠（E12，因并行线红）、1 ⚠（D5 口径偏差）；因此**不能**判「通过」 |

## 7. 判据原文与归档

- 探针命令与原始输出：`03-review-probes.txt`
- 施工记录（含偏差登记 13 条）：`03-construction.md`
- 演示 transcript：`03-demo-transcript.txt`
- 校验和：`SHA256SUMS`
