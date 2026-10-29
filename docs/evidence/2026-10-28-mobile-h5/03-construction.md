# 03 单施工记录 · 意图理解与追问平面

> 施工单：`03-意图理解与追问平面.md`（`BAH-移动H5与跨场景施工方案-2026-10-28/`）
> 日期：2026-10-29 · 离线施工（无密钥、无外网、无真实模型）

## 1. 前置核查结论（§1.1 十一条命令）

| # | 项 | 实测 | 与施工单是否一致 |
|---|---|---|---|
| 1 | `packages/runtime/src/intent/` | 不存在 | ✅ |
| 2 | `prompt/index.ts` | 7 行 `export {}` 占位 | ✅ |
| 3 | `interaction/src/index.ts` | 只导出 `approval` | ✅ |
| 4 | `ToolDefinition` | `schema` / `tier:{level}` / `sideEffect?` / `execute(args, ToolExecContext)` | ✅ |
| 5 | 契约服务 | `ToolContract{argsSchema,resultSchema,validateAt}` + `provideToolContracts` | ✅（但见偏差 9） |
| 6 | demo router | 确定性正则；`classifyIntent`/`parseTransfer`/`planFor` | ✅ |
| 7 | memory-store | `retrieveMemory(bankQuery, query)`；`CROSS_SCENE_MIN_CONFIDENCE=0.6` 在导出面 | ✅ |
| 8 | eval ID | `T-01..12` / `Q-01..10`；`T-13..16`、`Q-11/12` 空闲 | ✅ |
| 9 | `SIGNED_TYPES` | 含 `tool/call`、`tool/result` | ✅ |
| 10 | SECTION 文案进快照 | `snapshots/` 目录零命中，但 `system/message` 事件**含提示词全文**并被快照逐条比对 | ⚠ 与「只加一行不影响快照」的假设不同：**注册新工具必然改快照**（见 §3.1） |
| 11 | 门禁数 | 开工日实测 **45**（并行可观测性线已加 3 个） | ✅ 终态 46 |

### 1.1 三项 ⚠待核 的复核结论

| 待核项 | 结论 |
|---|---|
| eval 是否有记忆种子/注入面 | **没有**。headless 不装 `bah:memory-store`，`ScenarioSpec.dataset` 只喂 `bank:tools`。按 §9 偏差 3 走确定性夹具（`intent:plane.demoMemory`） |
| `tool-result` 断言的 `path` 是否支持数组下标 | **支持**（`runner.ts` 的 `resolvePath` 对数组用 `Number(key)`）。但 `tool-result` 原先只认领域事件（`TOOL_EVENT` 映射），`intent_resolve`/`prompt_ask` 没有领域事件 ⇒ 扩展为回落到 `tool/result`（偏差 3b） |
| SECTION 文案是否进快照 | 进的是 `system/message` 事件（不是 `snapshots/` 源文件）。新增工具会改变工具清单 ⇒ 全量重录（§3.1） |

## 2. 交付清单

### 2.1 新增（实现）

| 文件 | 职责 |
|---|---|
| `packages/runtime/src/intent/types.ts` | 封闭联合、槽位模型、`SlotTable`、`IntentResolution`、`SLOT_NAMES` |
| `packages/runtime/src/intent/lexicon.ts` | 规则词表、跨场景权重、场景→提案表、追问话术 |
| `packages/runtime/src/intent/slots.ts` | 元↔分、脱敏三函数、原话抽取、两层合并、冲突/缺失 |
| `packages/runtime/src/intent/evidence.ts` | 证据结构 + `sanitizeSpan`（调用 `maskName`） |
| `packages/runtime/src/intent/recall.ts` | 结构化记忆端口、0.6 闸门、`planRecall`、`routeNeedsAsk` |
| `packages/runtime/src/intent/resolve.ts` | 规则引擎（R-AMB→R-IMP→R-VAGUE→R-ELL→R-EXP）+ 整数评分 |
| `packages/runtime/src/intent/result.ts` / `result-schema.ts` | 出参整形 + `INTENT_RESOLVE_SCHEMA` |
| `packages/runtime/src/intent/deps.ts` / `tool.ts` / `index.ts` | 依赖面、`intent_resolve` 工具、barrel |
| `packages/interaction/src/prompt/{types,candidates,deps,tool,result-schema,index}.ts` | 候选构造（去重/排序/上限 3/手动出口/空候选 fail-loud）+ `prompt_ask` |
| `packages/host/src/boot/plugins/intent.ts` | 插件 `intent:plane`：工具注册、契约合并注册、会话状态、记忆端口选择 |
| `packages/host/src/boot/plugins/prompt-ask.ts` | 插件 `prompt:ask`：注册 `prompt_ask`（复用意图状态） |
| `packages/cli/src/demo/intent.ts` | `pnpm demo:intent` 离线演示（5 条固定输入） |
| `scripts/verify-intent-determinism.ts` | 门禁 I1–I5（AST + 存在性） |
| `scripts/__fixtures__/intent-determinism/*.ts` | 正夹具 1 + 反夹具 4 |

### 2.2 修改

| 文件 | 改动 |
|---|---|
| `packages/runtime/src/tools/contracts.ts` | `provideToolContracts` 改为**可叠加**（同一 Context 多来源聚合）——见偏差 9 |
| `packages/runtime/src/index.ts` | 导出 `./intent/index.ts` |
| `packages/interaction/src/index.ts` | 追加 `export * from './prompt/index.ts'` |
| `packages/host/src/boot/plugins/index.ts` | 登记两插件 + 导出 `INTENT_STATE_SERVICE` |
| `packages/cli/bundles/base/index.ts` | base bundle 加 `intent:plane`、`prompt:ask` 两行（顺序固定） |
| `packages/channels/src/web/project.ts` | `prompt_ask` 的 `tool/result` → `choice` 帧投影 |
| `packages/llm/src/demo/router.ts` | 四条意图路由 + 诚实口径头注释；slotGap 改道 |
| `packages/eval/src/scenario/runner.ts` | T/Q 族注入 `demoMemory`；`tool-result` 支持非领域事件工具 |
| `packages/eval/src/scenarios/{t,q}/index.ts` | T-13…T-16、Q-11/Q-12 |
| `packages/eval/src/scenario/{spec.ts,validate.ts}`、`scenarios/index.ts` | 计数 60→66 |
| `snapshots/headless-basic/scenario.ts` | 加一个 `recall` turn + `coveredSources` 声明 intent/prompt |
| `scripts/{ci.ts,coverage-allowlist.ts,barrel-excludes.ts,assertion-baseline.json}` | 地板/名单/基线同批 |

### 2.3 测试

| 面 | 数量 |
|---|---|
| `packages/runtime/src/intent/*.test.ts` | 5 文件 / 170 例 |
| `packages/interaction/src/prompt/*.test.ts` | 2 文件 / 15 例（去重·排序·上限·空候选·防死循环） |
| `packages/host/src/boot/plugins/intent.test.ts` | 20 例（装配面·契约·真实记忆适配·点选回路） |
| `packages/channels/src/web/project.choice.test.ts` | 9 例（帧字段逐一映射·askExhausted 不进帧） |
| `scripts/intent-determinism.test.ts` | 11 例（正反夹具 + 两个负控 root） |
| `packages/llm/src/demo/router.test.ts` | +6 例（四条路由） |
| eval | T-13…16 / Q-11·12（真实管线 + 真契约） |

## 3. 验证输出

### 3.1 快照重录（为什么必须重录）

`system/message` 事件包含提示词装配全文；注册两个新工具改变了 `bank.capabilities` 段的工具清单。
按 00 §7.4：`BAH_SNAPSHOT_RECORD=1` 重录全部 7 个 case + `snapshot:reverify`，属「内容增补，非顺序改签」。

另外给 `headless-basic` **加了一个 turn**（「上次那个转账再来一次」）：它真的走
`router(recall)` → `intent_resolve` → 空记忆追问，让 `coveredSources` 里的
`packages/runtime/src/intent/` 有实物背书，而不是一句声明。

### 3.2 命令实测（2026-10-29）

| 命令 | 结果 |
|---|---|
| `npx tsc -b` | 通过 |
| `npx eslint <新增/修改文件>` | 通过 |
| `pnpm test`（= `vitest run`） | **260 文件 / 2990 例全绿** |
| `pnpm eval:unit` | **22 文件 / 158 例全绿** |
| `pnpm test:web` | 22 文件 / 333 例全绿（本单未动前端） |
| `pnpm test:snapshot` | 8 文件 / 34 例全绿（重录后） |
| `pnpm eval --filter=T` / `--filter=Q-11` / `--filter=Q-12` | T 族 16/16、Q-11/Q-12 各 1/1 |
| `pnpm gate` | **42/46**（红的 4 项见 §3.3） |
| 覆盖率（perFile 100% 名单） | 全绿（新增 intent/ 与 prompt/ 进名单后逐文件达标） |
| `npx tsx scripts/verify-facts.ts` | 通过（门禁 46 · 场景 66 · 工具 16） |

### 3.3 四红归属（逐条归因，不含糊）

| 门禁 | finding | 归属 |
|---|---|---|
| `assertions` | `packages/cli/src/cli/observe-http.test.ts` 新增 24 条断言未登记 | **并行「可观测性」线**：该文件未入库。基线里我**没有**替它登记（只登记本单 8 个文件） |
| `docs-paths` | `PROGRESS.md` 引用 `docs/demo/` 不存在 | **并行线**：该行是 `git diff PROGRESS.md` 里他们新加的（+39 行），本单未改 PROGRESS.md |
| `snapshot-fresh` | `packages/saga/src/gates/index.ts` 无场景覆盖 | **并行线**：该文件最后一次改动是 `6af6d64`（可观测性 01），在 merge-base 之后；本单未碰 saga |
| `tracked-sources` | 本单 29 个源码未入库 | **本单**：提交后自愈（`git add` 之后该门禁即绿） |

## 4. 偏差登记（§9 三条 + 施工中新发现八条）

| # | 偏差 | 理由与处置 |
|---|---|---|
| 1 | `intent/resolved` 新事件键 → 内置工具形态 | 00 D5 预授权；落账复用 `tool/call`+`tool/result`（∈`SIGNED_TYPES`）。**按单执行** |
| 2 | `scenario-dsl.md` §2 数字行 Q10/T12→Q12/T16、60→66 | 只改数字行；DSL 条款/断言 kind 封闭集/族联合零改动。**按单执行** |
| 3a | eval 记忆注入面：改用 `intent:plane.demoMemory` 配置夹具 | eval 无记忆注入面（§1.1）。夹具带 `match`（按话语过滤）：三条夹具（王建国历史 / 两个张伟）互不污染，否则 T-13 会把两条张伟也算进候选、直接变歧义 |
| 3b | `tool-result` 断言扩展到「无领域事件的工具」 | 原实现只认 `TOOL_EVENT` 映射；`intent_resolve`/`prompt_ask` 零新键（D5）⇒ 无领域事件。改为回落到 `tool/result` 并从默认 JSON 正文解析出参。**这是增强（能断言更多工具），不是放松** |
| 4 | R-ELL-1 判据：从「句长≤6 且无动词」改为「短句且无完整新指令 / 修改动词，且上一轮确有在办的事」 | 施工单原文与 TC-INT-05（「就转给他」是 elliptical）**不可同时成立**——它含动词「转」。按 TC 为准，并保留「无可继承则不判省略」的安全边界（TC-INT-08） |
| 5 | R-IMP 的动词判定：先剥离场景词再判动作动词 | 否则「买车」「孩子上学」里的动词会把隐含意图永远判成 explicit（TC-INT-12 的属性式穷举会红） |
| 6 | TC-INT-08 的「missing 全量」理解为「除已抽取金额外」 | 「800」本身抽出了 `amountCents`，缺的只有 `payee`。逐字理解「全量」会要求一个已填的槽位出现在 missing 里 |
| 7 | runtime **不** import `@bah/memory-store` | 底座反向依赖能力层会把 sqlite 拖进每个使用者。改为结构化端口 `IntentMemoryPort` + 宿主注入；0.6 仍只有一个真值来源（host 从 memory-store 具名导入） |
| 8 | `ChoiceFrame` 字段以 01 单为准：`prompt` / `options[].{id,label,hint}` / `allowFreeText:true` | §3.12 映射表写的是 `question/options[].text/options[].kind`。01 单的帧没有 `style`/`degraded` 字段 ⇒ `degraded`、`askExhausted` **不进帧**；`prompt_ask` 空候选时 `options` 为空，前端据此只渲染输入出口 |
| 9 | `provideToolContracts` 改为可叠加（同一 Context 多来源聚合） | 两个插件各注册契约会撞 `service-conflict`（服务单实例）。契约天然是多来源并集；聚合后「谁是唯一提供者」不再依赖装配顺序。既有调用方行为不变（`contracts.test.ts` 53 例全绿） |
| 10 | `prompt_ask` **不**声明 `projectContent`（走默认 JSON 渲染） | 声明了就会把出参渲染成人类文本，eval 的 `tool-result` 断言与回放就取不到逐字段原值。人类可读由前端 `choice` 帧负责，不在工具层重复 |
| 11 | 不在 `bank.capabilities` 段加静态文案 | 该段是**自动汇入工具清单**（无静态文案）。`intent_resolve` 的 description 已写明能力与约束 ⇒ 再写一行等于两处维护同一句话。注册工具本身就会让模型看到它 |
| 12 | 门禁自测文件命名 `scripts/intent-determinism.test.ts` | `verify-*.ts` 的 glob 会把 `verify-intent-determinism.test.ts` 算进「门禁数」（47 ≠ 46），而 `run-gates` 的发现正则不认它。改名后 `ls scripts/verify-*.ts \| wc -l` 与门禁实际数一致 |

## 5. 安全自检

| 项 | 结论 |
|---|---|
| 新增事件键 | **0**（`SESSION_EVENT_TYPES` 18 键未动，`event-table.md` 未改） |
| 新增接缝 | **0**（`seams.ts` 未动） |
| 新增银行工具 | **0**（16 个不变，D9） |
| `approval/decided` 载荷 | 未改；`prompt_ask` 不认票据（`sideEffect:'none'`、绿级） |
| PII | 证据 span 过 `sanitizeSpan`（手机号/账号整段替换、姓名保留姓）；出参 `account` 只出尾号；`checkPiiSanitizers` 门禁锁「定义了且被调用」 |
| 注释/默认值填充 | 歧义分支强制 `ask`（AST 门禁 I2 + TC-INT-15）；`DEFAULT_*` 黑名单限定槽位名（避免误伤 `DEFAULT_MAX_K`） |
| 时钟/随机/网络 | 纯函数面零调用（AST I1，含 `new Date()` 无参）；`today` 来自注入钟 |
| 失败姿态 | 记忆检索失败 ⇒ `intent-recall-failed` 抛错（不假装无历史）；候选为空 ⇒ `prompt-no-candidates` ⇒ 降级为开放式并标 `degraded`；无法构造时 fail-loud |
| 口径三处同文 | 「选择题式追问 ≤2 次，第 3 次降级为开放式」：`facts.md` §6、`MAX_ASK_PER_SLOT = 2`（tool.ts:17）、本记录 §5 |

## 6. 已知边界（不夸大）

1. **真实记忆层不填槽位**：`RetrievedMemory` 没有结构化字段，本单不解析 `renderedText` 去猜。
   真实记忆只贡献 `routeCode`（该不该追问）；结构化回填需 memory-store 侧提供字段，属后续单。
   该映射代码用 `/* v8 ignore */` 标注并写明理由（空库下恒不执行）。
2. **router 不是 NLU**：四条新路由是确定性正则；`slotGap` 只在「金额已给、缺收款人」时静态发选择题
   （其余缺参只发 `intent_resolve` + 文案）——router 不知道 `askHint` 指向哪个槽位，硬发就会与意图工具打架。
3. **`degraded` 不进帧**：01 单的 `ChoiceFrame` 没有该字段；前端以 `options` 是否为空判断开放式提问。
4. **`prompt_ask` 的第 3 次降级靠台账**：台账在 host 插件内存里（随进程），跨进程重启会重置。
5. **`DEFAULT_*` 黑名单是形状约束**：挡不住换个名字写默认值；语义由 TC-INT-15 与 eval T-15/Q-12 锁。

## 7. 证据文件

| 文件 | 内容 |
|---|---|
| `03-baseline.txt` | 开工核查（§1.1 十一条） |
| `03-demo-transcript.txt` | `pnpm demo:intent` 五条输入的完整 transcript |
| `03-gate-after.txt` | 施工后 `run-gates` 全量输出（含四红归因） |
| `03-test-unit.txt` | `vitest run` 全量输出 |
| `03-test-eval-unit.txt` | `vitest run --config vitest.eval.config.ts` 输出 |
| `03-review-probes.txt` | 对抗式审查的探针命令与输出（见 `03-adversarial-review.md`） |
| `03-adversarial-review.md` | 对抗式复审报告（只出报告，不改码） |
