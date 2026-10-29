# 卡片 L2 施工 · 对抗式复审

> 审查对象：`01-施工单-L2-卡清单出口` 的落地实现（分支 `card-01-l2`，基线 `1c369b3`）
> 方法：红队三问——**能不能不做？做了会不会假？做了会不会撞红线？** 外加 9 条负控探针（`07-probe.txt`）
> 结论：**实现可交付，但施工单原文有 1 处会让目标落空**（projectContent 缺 cardId），已修；另有 2 处计划外扩散（快照、文档口径），已按门禁要求补齐。

---

## 0. 先认三个错（施工单本身）

| # | 施工单原话 | 实际 | 影响 |
|---|---|---|---|
| 1 | §2.4 的 `projectContent` 文案只有「卡尾号/状态/日限」，无 `cardId` | 模型**只**读 `tool/result.content`；`ToolExecution.value` 不进模型历史（`packages/runtime/src/tools/pipeline.ts:304`、`session/derive.ts:190-191`、`agent-loop/request.ts:84-91`） | 按原文施工，A2「尾号 1234 → c-1」不可达，L2 目标落空 |
| 2 | §3 A4 只提「工具数仍 16 / verify-facts 绿」，§2 只列 2 份文档 | 改用例数会触发 `docs-consistency` 对 PUBLIC_DOCS 的硬比对：README×2、deploy、testing、security-self-assessment×2 全部要改（`scripts/verify-docs-consistency.ts:212-225`） | 不改则 `pnpm gate` 1/50 红，且施工单没说要改 |
| 3 | §2 未提快照面 | `read/accounts` 事件载荷新增 `cards[]` → 7 个场景 `session.jsonl` 逐条失配，`pnpm test:snapshot` 14/39 红 | 不重录则录制的「事实」与代码不一致 |

三条均已在本单修复，并写进 §2 的偏差表。

---

## 1. Findings 总表

| # | 攻击点 | 严重度 | 处置 |
|---|---|---|---|
| F-L2-01 | 模型看不到 `cards[].cardId`，L2 目标不可达 | **阻断** | 正文补「卡ID c-1」；schema 描述改「取结果里每张卡的「卡ID」」；单测钉住（§2.1） |
| F-L2-02 | 快照面随行为变化失配 | 高 | 重录 7 个场景 + `snapshot:reverify`；39/39 绿（§2.2） |
| F-L2-03 | 用例数是跨文档机器键，不止 facts.md | 高 | 6 处 PUBLIC_DOCS + facts/sources 按实测改 3337（§2.3） |
| F-L2-04 | `listAccounts` 并不返回副本，施工单注释「同纪律」失实 | 中 | `listCards` 仍返回副本；注释不再宣称与 `listAccounts` 一致（`mock.ts:167-171` 为既有瑕疵，不改） |
| F-L2-05 | 账户尾号与卡尾号同号（1234/5678） | 中 | 正文一律「实体卡尾号/虚拟卡尾号」，且并列「卡ID」；尾号不能当 ID（探针 P6 证明） |
| F-L2-06 | `TOOL_TITLE` 同时缺 `card_report_lost` 与 `sub_cancel` | 低 | 两条都补（施工单写「补两行」但示例只给一行） |
| F-L2-07 | `docs/bank-tools.md:294` 仍写「Provider 方法未加」 | 低 | 顺手纠正（施工单 05 排给 L3，但本单已让该行更假） |
| F-L2-08 | `facts.md` 工具行 1 仍写「只列账户」 | 低 | 改为「列出账户与卡片」 |
| F-L2-09 | 基线数字本身漂移：facts 3333/365、README 门禁 45 项 | 中 | 实测 3337/375/50，按真值改；README §7 日期同步 2026-10-30 |
| F-L2-10 | `monthlyLimitCents` 有出口、无判定 | 低 | 按 F-12 只做展示；正文不渲染，避免诱导做额度调整 |
| F-L2-11 | 快照 `web-channel/scenario.json` 与 `scenario.ts` 覆盖声明漂移 | 中 | 重录把 `saga/src/gates/` 覆盖丢掉 → `snapshot-fresh` 红；已补回 `scenario.ts`，让生成物可复现 |
| F-L2-12 | 挂失后卡清单状态是否可见 | 低 | 无需改：`listCards` 读账本实时状态；探针 P5 证明挂失落账 |

---

## 2. 关键论证

### 2.1 F-L2-01：唯一一处「按原文做就会假」的地方

**攻击**：施工单说「`account_list` 的 JSON 含 `cards[]`，模型就能拿到 cardId」。但模型历史是**冻结结果的渲染投影**：

- 工具体只返回结构化值；管线在 `pipeline.ts:304` 调 `projectContent(payload)`，之后 `tool/result` 落账的只有 `content` 块；
- `session/derive.ts:186-191` 把 `tool/result` 投影成 `role: 'tool'` 消息时只带 `content`；
- `agent-loop/request.ts:84-91` 再把 `content` 原样转成模型消息。

`ToolExecution.value`（`runtime/src/tools/types.ts:57`）明确「不进任何事件」，plan 的动态 args 才会读它，模型不读。

**结论**：`cardId` 必须进正文。实现为：

```text
实体卡尾号 1234（卡ID c-1，正常，日限 ¥1,000.00）
虚拟卡尾号 5678（卡ID c-2，正常，日限 ¥2,000.00）
```

探针 P1–P4 证明：从正文正则提取 `c-1` → 直接调用 `card_report_lost` → 成功、落 `card/reported-lost`。这条链路不依赖 `execution.value`，与模型看到的输入同构。

**残余**：未接真实模型做端到端话术验证；离线 router 不识别「我有几张卡」，浏览器实点只能验证正文排版，不能验证模型选卡。A2 按「输入可达性」验收，不按「模型一定选对」验收。

### 2.2 F-L2-02：快照不是可选项

`read/accounts` 事件载荷从 `{accounts, availableTotalCents}` 变成 `{accounts, cards, availableTotalCents}`。7 个场景的 `session.jsonl` 与回放逐条比对，14 条断言红（`02` 之前的一次跑批）。

重录后 9 文件 / 39 例全绿（`06-test-snapshot.txt`）。重录同时让 `web-channel/scenario.json` 按 `scenario.ts` 重新生成，暴露出覆盖声明漂移（F-L2-11）：`scenario.json` 原有 `packages/saga/src/gates/`，`scenario.ts` 没有。若只提交生成物，`snapshot-fresh` 会因「改了 saga/gates 却无场景覆盖」而红。处置：把该 scope 补回 `scenario.ts`（与历史 `scenario.json` 对齐），生成物恢复可复现。

### 2.3 F-L2-03：机器键的扩散面比施工单写的大

施工单 §3 只提醒 `facts.md` 的 `tests_main_*`。实际 `verify-docs-consistency` 会扫 PUBLIC_DOCS 里的「N 文件 / M 用例」并逐字比对 facts：

- `README.md:30`、`README.md:256`
- `docs/deploy.md:191`
- `docs/testing.md:10`
- `docs/security-self-assessment.md:6`、`:365`

一次全改后 `pnpm gate` 恢复 50/50（`04-gate-after.txt`）。

同时发现**基线数字已漂移**（不是本单造成）：`pnpm test` 实测 3335 而 facts 写 3333；`pnpm test:web` 实测 375 而 facts 写 365；README 写「门禁 45 项」而 facts 是 50。已按实测校正，并在 §0 记录。

### 2.4 F-L2-04：别把「同纪律」写进注释

施工单说 `listCards` 副本纪律「与 `listAccounts` 同纪律」，但 `listAccounts`（`mock.ts:167-171`）是 `filter().sort()`，返回的是账本对象引用，改字段会污染账本。本单：

1. `listCards` 按计划 `map` 复制（探针 P8：改返回对象 status，重读仍 `normal`）；
2. 注释改成陈述本方法的三条纪律，不再声称与 `listAccounts` 一致；
3. **不顺手修 `listAccounts`**——那是另一个读路径的行为变化，超出本单；登记为既有瑕疵（`docs/evidence/2026-10-30-card-l2/01-adversarial-review.md` 本节）。

### 2.5 F-L2-05：尾号撞车的可证伪点

账户尾号 `1234/5678/9012`（`forge/index.ts:162-164`）与卡尾号 `1234/5678`（`:167-170`）同号。正文用「**卡尾号**」并给出 `卡ID`，避免用户/评委把账户当卡。

探针 P6：把账户尾号 `1234` 直接当 `cardId` → `card-unknown`。证明工具层没有偷偷做字符串匹配，ID 纪律仍成立。

### 2.6 F-L2-10：`monthlyLimitCents` 只出现在结构化结果里

`CardView.monthlyLimitCents` 有值，但正文不渲染，避免模型拿它去做「额度调整」的话术。账本零判定（`core/model.ts:168`），与 04 卷 F-12 的裁决一致。

---

## 3. 负控探针（9/9 通过）

脚本：`07-probe.txt`（临时文件已删，输出保留）。

| # | 探针 | 期望 | 结果 |
|---|---|---|---|
| P1 | 模型可见正文含 `卡ID c-1` | 含 | PASS |
| P2 | 账户与卡片并列且区分「卡尾号」 | 含「名下 2 张卡」「实体卡尾号 1234」 | PASS |
| P3 | 正文可提取 cardId | `c-1` | PASS |
| P4 | 正文提取的 cardId 可完成挂失 | 无错 | PASS |
| P5 | 挂失落账 `card/reported-lost` | 有 | PASS |
| P6 | 尾号 `1234` 当 cardId | `card-unknown` | PASS |
| P7 | 未知用户 `listCards` | `[]`，不抛 | PASS |
| P8 | 改返回卡片的 status | 账本仍 `normal`（副本语义） | PASS |
| P9 | 无卡时正文 | 不出现「名下 0 张卡」 | PASS |

---

## 4. 验收矩阵（施工单 §3）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| A1 | `account_list` JSON 含 `cards[]` 且每项有 `cardId` | ✅ | `queries.test.ts` 新用例；探针 P3 |
| A2 | 模型能按尾号选中卡 | ⚠️ 输入侧达成（正文含 ID），未接真实模型 | 探针 P1–P4；§2.1 残余 |
| A3 | 挂失链路端到端 | ✅ | `account-ops.test.ts` 新用例（查询→红档→审批→强验证→lost） |
| A4 | 工具数仍 16，`verify-facts` 绿 | ✅ | `03-test-after.txt`、`04-gate-after.txt` |
| A5 | `verify-docs-consistency` 绿 | ✅ | gate 50/50 |
| A6 | Web 卡片正文出现「名下 2 张卡」 | ⚠️ 正文层 ✅ + `test:web` 375/375；未浏览器实点 | `05-test-web.txt`；原因同 A2 |

---

## 5. 执行结果（命令与数字）

| 命令 | 结果 | 日志 |
|---|---|---|
| `pnpm typecheck` | 通过 | — |
| `pnpm lint` | 通过 | — |
| `pnpm test` | **294 文件 / 3337 用例**（基线 3335 + 本单 2） | `03-test-after.txt` |
| `pnpm test:web` | **27 文件 / 375 用例** | `05-test-web.txt` |
| `pnpm test:snapshot` | **9 文件 / 39 用例**（重录后） | `06-test-snapshot.txt` |
| `pnpm gate` | **50/50** | `04-gate-after.txt` |
| 负控探针 | 9/9 | `07-probe.txt` |

基线（改码前，`1c369b3`）：294 文件 / 3335 用例全绿，gate 50/50（`02-baseline-test.txt`、`01-baseline-note.txt`）。

---

## 6. 残余风险（做完也还在）

| # | 风险 | 为什么要留着 | 答辩怎么说 |
|---|---|---|---|
| R-L2-1 | A2/A6 未经真实模型 + 浏览器实点 | 离线 router 不识别卡片问法；接真模型属演示环境，不在单测面 | 「输入可达性已用正文正则→挂失链路证明；模型选卡在演示轮实测」 |
| R-L2-2 | 卡状态尚未进资金路径 | 属 L3 | 「L2 只让 `cardId` 可达；冻结/资金拒绝在 L3」 |
| R-L2-3 | `Card.status='frozen'` 仍无产生点 | 属 L3 | 同上 |
| R-L2-4 | `listAccounts` 返回账本引用（既有） | 改动会波及所有账户读路径 | 主动承认，登记在案 |
| R-L2-5 | `sub_cancel` 仍拿不到 subscriptionId | 场景 5，施工单 F-13 明确不碰 | 「同病不同单，场景 5 收口」 |

---

## 7. 总体判定

| 项 | 判定 |
|---|---|
| L2 目标（cardId 可达） | **达成**（正文层可提取，端到端挂失通过） |
| 工具数 / 事件表 | 16 / 19，均未动 |
| 门禁 | 50/50，快照 39/39，web 375/375 |
| 施工单质量 | 目标方向正确；§2.4 正文缺 ID 是硬伤，§2/§3 低估快照与文档扩散面 |
| 合并建议 | **可提交**；若只允许一件事，先把 projectContent 的「卡ID」保留住——删掉它，L2 就回到不可达 |
