# S4 对抗式复审（ES-40 … ES-44 · 快照与确定性）

> 复审时间：2026-10-28 15:24–15:42 +0800
> 基线 HEAD：`6461dc5`（S3 已入库）。复审开始时 S4 的 13 个文件**只在暂存区、未提交**，
> 本报告是它们入库前的最后一道手。
> 本阶段范围：`snapshots/entity-slots/`（新用例）、派生数字（快照 6/23 → **7/28**）、
> `snapshots/README.md` 与 `docs/testing.md` 的口径。
> 结论：**可提交**。`pnpm test:snapshot` **7 文件 / 28 例全绿**；`pnpm gate` **36/36**
> （`snapshot-fresh` **不需要** `BAH_ALLOW_NO_SNAPSHOT`，且明确列出"已重录场景：entity-slots"）；
> 重录**逐字节相同**；5 条负控全部"应红即红"。
> 自检修掉 2 条（F-S4-01 / F-S4-02），登记 4 条残余（§4）。
> **最重要的证据**：用当前源码把整个场景重录一遍，三份产物与仓库里的**逐字节相同**（A-05）。

---

## 1. 改动清单（15 文件 = 13 暂存 + 2 本轮修）

| 文件 | 改动 |
|---|---|
| `snapshots/entity-slots/{session.jsonl,llm.jsonl,scenario.json}`（新） | 录制件：35 事件 / 2 次 provider 调用；`context/slots` ×2、`【账户概览】` ×4 |
| `snapshots/entity-slots/scenario.ts`（新） | 场景：headless 底座 + 层 4 overlay；`coveredSources` 25 条 |
| `snapshots/entity-slots/snapshot.test.ts`（新，5 例） | T-AUD-005（含 3 条附带断言）/ T-AUD-006 / Jsonl 读回 / 通用篡改负控 / **槽位篡改负控** |
| `snapshots/entity-slots/overlay.yml`（新） | `core:agent`（channel / loop / compaction / slots / runtimeContext）+ `bank:tools`（demo / seed / tier / 七键预算）整块抄全 |
| `snapshots/entity-slots/reverified.json`（新） | `snapshot:reverify` 摘要（本轮重跑：6 场景全部"摘要未变"） |
| `README.md` / `facts.md` / `docs/{facts-sources,deploy,testing,security-self-assessment}.md` | 快照面 6 文件 / 23 例 → **7 文件 / 28 例**；`testing.md` 补 §9.1 可选件与 §9.2 负控 |
| `snapshots/README.md` | **本轮修**：目录树补 3 个场景 + 更正 forge 归属（F-S4-01） |
| `docs/evidence/2026-10-28-entity-slots/06-s4-adversarial-review.md` | 本报告 |

---

## 2. A 角度（验收 / 契约）

| # | 判据（04 §1–§9） | 取证 | 结论 |
|---|---|---|---|
| A-01 | 新用例真的进了 CI 面 | `pnpm test:snapshot` → **7 files / 28 tests passed**（含 `entity-slots` 5 例） | ✅ |
| A-02 | 场景输入与设计一致 | `scenario.json`：`profile=headless`、`prompts=['帮我查一下余额']`、`sessionId=s-snapshot-entity-slots`、`clock={1700000000000,1}`、`randomSeed=7` | ✅ |
| A-03 | overlay **整块抄全**（不顺手关掉 compaction / notes） | 录制行 `core:agent` 同时含 `channel` / `loop.model` / `loop.compaction{8,3}` / `slots{source:bank}` / `runtimeContext{user,notes}`；`bank:tools` 含 `contextSlots` **七键** | ✅ |
| A-04 | 事件落点：`context/slots` 在 `request/header` **之前**，每 step **一条** | 2 个 step × 1 条 = 2 条；序列 `step/start → context/slots → request/header → …` | ✅ |
| A-05 | **录制件由当前源码产出，且录制确定** | 重新 `recordSnapshot` 到临时目录：`session.jsonl` 22535 B / `llm.jsonl` 1610 B / `scenario.json` 4490 B **逐字节相同** | ✅ |
| A-06 | 两次回放全等 | T-AUD-006 绿（`second` 与 `first` `toEqual`，且两者都与录制全等） | ✅ |
| A-07 | 槽位文本内容对得上 | `request/context.texts[0]` 以 `【当前用户】` 开头，含 `【账户概览】`（3 账户，`¥12,345.67`）、`【最近交易】`（3 条）、`asOfText=2023-11-15 06:13` | ✅ |
| A-08 | 离线路由仍读"用户原话" | `tool/call` 的名字是 `account_balance`（不是被 `【运行时数据…】` 带偏） | ✅ |
| A-09 | 5 条负控"应红即红" | §3（2 条入用例 + 3 条人工） | ✅ |
| A-10 | `coveredSources` 覆盖 S1–S3 的敏感面 | `runtime/{agent-loop,agent,session,system-prompt,tools,policy}`、`llm/{llm,mock,demo}`、`bank/{core,tools,context,forge}`、`bank/src/index.ts`、`host/src/boot`、`persistence/*`、`safety/*`、`interaction/approval`、`saga/*` | ✅（诚实边界见 F-S4-03） |
| A-11 | 派生数字同批 | `facts-sources.md` 机器块 `snapshot_files=7` / `snapshot_cases=28`；`verify-facts` **重算值 = 声明值**（门禁绿）；README / deploy / testing / security-self-assessment 同步 | ✅ |
| A-12 | 不泄真实数据 | 全为 demo 造数（张三 / 尾号 1234·5678·9012 / 金额均为造），无密钥、无路径、无端口 | ✅ |
| A-13 | `reverified.json` 新鲜 | `pnpm snapshot:reverify`：6 场景**全部"摘要未变"**，写入 0 个 | ✅ |

---

## 3. B 角度（反向攻击：这套快照能证明什么、不能证明什么）

| # | 攻击 | 实测 | 结论 |
|---|---|---|---|
| B-01 | 「录制件是人手改的」 | 重录逐字节相同（A-05） | 否证 |
| B-02 | 「槽位事件录了但不进比对面」 | 负控：`context/slots.accounts` 3→2 → 比对红，且差异点名 `context/slots` | 否证 |
| B-03 | 「时钟没被真用，改 clock 也不红」 | 负控：`clock.start` +1 → 回放 `at` 全部 = `1700000000001`，第 1 条差异（`identity/bound`）即红 | 否证 |
| B-04 | 「槽位本来就在，overlay 没起作用」 | `profiles/headless/patch.yml` **没有** `slots` 键；负控：生效行 `slots.source=none` → `context/slots` **0 条**、`request/context` 退回静态画像（只剩 `【当前用户】` + `【补充说明】`）、比对红 | 否证 |
| B-05 | 「靠逃生口过的闸」 | 未设 `BAH_ALLOW_NO_SNAPSHOT`；`pnpm gate` 36/36，`snapshot-fresh` notes 里出现「已重录场景：entity-slots」 | 否证 |
| B-06 | 「新用例把旧场景搅了」 | 28 例全绿；`git status` 里 `snapshots/` 只有 `entity-slots/` 新文件，5 个旧场景**零 diff** | 否证 |
| B-07 | 「`llm.jsonl` 里搜不到账户概览，说明槽位没进模型」 | `llm.jsonl` 只存**请求标识 + 响应分片**，提示词正文本就不在其中。证据在 `session.jsonl` 的 `request/context.texts` 与 `user/message(source=runtime-context)` | 否证（登记 F-S4-04） |
| B-08 | 「`coveredSources` 是整表抄的，随便就能背书」 | 部分成立：本对话 18 种事件里**没有** `approval/*` 与 `saga/*`，所以 `interaction/approval`、`persistence/saga-store`、`saga/recovery`、`saga/tick` 四个目录在本场景**无可观测行为** | **成立**（登记 F-S4-03） |
| B-09 | 「04 §6 说每个事件 +1ms」 | 实测 35 事件 + 1 条 header 共用 `at=1700000000000`；`fixedClock.now()` 幂等、全仓无 `Clock.tick()` 调用 ⇒ `clock.step` 不作用于会话事件 | 文档表述与事实不符（登记 F-S4-05） |
| B-10 | 「docs 里还有 6 文件 / 23 例」 | 只剩 `docs/drill-*.md` 4 份；它们被 `verify-docs-consistency` 明确列为**历史件**（"改它们等于篡改证据"，不在扫描面） | 不改（登记 F-S4-06） |
| B-11 | 「`snapshots/README.md` 与事实一致吗」 | **不一致**：目录树只有 3 个场景（缺 `compaction` / `plan` / `entity-slots`），且"`sandbox-compute` 背书 forge"在 `448f061` 之后已成假陈述（forge 已归属 5 个 demo 档场景，`sandbox-compute` 跑 stress 档） | **成立**，已修（F-S4-01） |
| B-12 | 「`testing.md` §9.2 的位置与口径」 | §9.2 被插在 §9 的三条通用纪律**之前**，把"回放 / 录制 / 纪律"挤到了负控小节名下；且原文写"重录到临时目录"，实测是**改生效行回放** | **成立**，已修（F-S4-02） |

### 3.1 三条人工负控的原始输出（本轮亲跑）

```text
[负控3] 删 context/slots：行数 36 → 34；equal=false；
        首条差异=#5: 录制 {"type":"context/slots",...} ⟶ 回放 {"type":"request/header",...}
[负控4] clock.start 1700000000000 → 1700000000001；回放 at 取值=1700000000001；equal=false；
        首条差异=#1: 录制 {...,"at":1700000000000,...} ⟶ 回放 {...,"at":1700000000001,...}
[负控5] slots.source=none：context/slots 条数=0；request/context 含【账户概览】=false；
        首段="【当前用户】姓名：张三；等级：金卡\n【补充说明】\n- 本对话运行在仿真数据集（demo 档）…"；equal=false
[对照] 原样回放：equal=true
```

> 负控 3 行数 36 → 34 是因为**两个 step 各一条**，一次删掉两条；
> 负控 5 只改**生效行**、不动录制件——回放本来就只读 `scenario.json` 的 rows，
> "层 4 合并后的行"是开关的唯一真相，因此不需要"重录到临时目录"也能证明开关有效。
> 负控全部在临时目录里做，仓库无残留（`git status` 已复核）。

---

## 4. 残余风险

| # | 级别 | 问题 | 处置 |
|---|---|---|---|
| F-S4-01 | P2 | `snapshots/README.md` 目录树停在 3 个场景，且把 `packages/bank/src/forge/` 的覆盖归给 `sandbox-compute`（stress 档不执行 `buildDemo`） | **已修**：补 6 个场景 + 更正归属（5 个 demo 档场景背书 forge，`sandbox-compute` 背书 `safety/sandbox-runtime` 与 `bank/verify`） |
| F-S4-02 | P2 | `docs/testing.md` §9.2 插错位置（把 §9 的三条通用纪律挤到它名下）；"重录到临时目录"与实测方法不符 | **已修**：§9.2 移到 §9 末尾并改为实测口径 |
| F-S4-03 | P2（跨场景） | `coveredSources` 从 `headless-basic` **整表抄来**，其中 `interaction/approval`、`persistence/saga-store`、`saga/recovery`、`saga/tick` 在本对话里**没有任何事件**（18 种事件里无 `approval/*`、无 `saga/*`）。改这些目录时，本场景会被门禁接受为"已重录"，但它证明不了这些面 | 不在 S4 单方面收紧：6 个场景共用同一份清单，单独裁剪会让"改 runtime 该由谁背书"的映射在多场景间不一致。**裁决点放在 S5**：要么给场景加"覆盖面=真实 trace"的自动判据，要么在每个场景的 `scenario.ts` 里显式标注"本节为继承声明" |
| F-S4-04 | P3 | `llm.jsonl` **不含提示词正文**（只有请求标识 + 响应分片）。用 `grep 【账户概览】 snapshots/*/llm.jsonl` 会搜不到，容易被误读成"槽位没进模型" | 已在 `docs/testing.md` §9.2 写明证据位置（`session.jsonl` 的 `request/context.texts`） |
| F-S4-05 | P3 | 施工单 04 §6 写"`clock.step`：每个事件 +1ms"与事实不符：`fixedClock.now()` 幂等、全仓无 `Clock.tick()` 调用，会话事件的 `at` 恒为 `clock.start`（`headless-basic` 34 事件同值，同样如此）。确定性不受影响（回放照抄同一时钟），但表述会误导下一个人"改 step 能造出时间差" | 施工单不改（历史件）；事实记在此处。若要事件间有毫秒差，得让 `SessionStore` 走 `tick()`，那是行为改动，不在 S4 |
| F-S4-06 | P3 | `docs/drill-*.md` 4 份仍写"快照 6 文件 / 23 例" | **不改**：`verify-docs-consistency` 明确把 `drill-*` 列为历史件（记录当时输出，改=篡改证据）。对外口径以 `facts.md` / `docs/facts-sources.md` 为准 |

**P0：0。P1：0。**

---

## 5. 对外口径（本阶段只能这样讲）

可以讲：

- 「实体槽位有一条**无网络、无密钥**的专门回放用例：3 个账户 + 3 条流水真的进了
  `request/context`（`【账户概览】` / `【最近交易】`），离线路由仍按**用户原话**调
  `account_balance`，两次回放逐条全等。」
- 「把当前源码重录一遍，三份产物与仓库**逐字节相同**——快照不是手改的，也没有隐性不确定性。」
- 「5 条负控应红即红：改回复、改槽位计数、删槽位事件、动时钟、关开关。」
- 「快照面 **7 文件 / 28 例**，`pnpm gate` **36/36**，`snapshot-fresh` 不需要逃生口。」

不许讲：

1. 不许讲「槽位让模型答得更准」——快照只证明"进了输入"，不证明效果；效果在 eval 面；
2. 不许讲「所有治理面都被这条快照覆盖」——`approval` / `saga` 在这条对话里没有事件（F-S4-03）；
3. 不许讲「llm.jsonl 里有账户明细」——那里只有响应分片（F-S4-04）；
4. 不许讲「`clock.step` 让每个事件差 1ms」——实际没有（F-S4-05）；
5. 不许再讲「快照 6 文件 / 23 例」——现为 **7 文件 / 28 例**。
