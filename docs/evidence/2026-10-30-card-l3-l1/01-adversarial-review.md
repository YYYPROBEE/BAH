# 卡片 L3 + L1 施工 · 对抗式复审

> 审查对象：`02-施工单-L3-冻结与解冻` 与 `03-施工单-L1-语料与答辩` 的落地实现（分支 `card-01-l2`，基线 `957ce0e`）
> 方法：红队三问——**能不能不做？做了会不会假？做了会不会撞红线？** 外加 17 条负控探针（`07-probe.txt`）
> 结论：**两单可交付**；L3 的 `reason` 字段原样实现会变成"假字段"，已改为事件 `note`；L1 的 C7 在现状分类器下不成立（陈述句会判 explicit 并 proceed），已修分类器。另有施工单未列的两处扩散（`verify-tiers` 嵌套字面量、快照重录）已按门禁要求处理。

---

## 0. 先认三个错（施工单本身）

| # | 施工单原话 | 实际 | 影响 |
|---|---|---|---|
| 1 | L3 §2.1 `reason`「可选，仅落审计」，但 §4.2 事件载荷只有 `from/to/reason(freeze\|unfreeze)` | 原样实现只能读参数后丢弃，模型看到 schema 有 `reason` 却查不到任何结果 | 读者会以为原因被记录；属假字段。已把原因文本落为事件 `note?` |
| 2 | L1 C7「「钱包被偷了」无动作动词 → 不冒充 explicit」 | 分类器默认兜底就是 explicit；卡场景 `REQUIRED_SLOTS.card` 改空后，陈述句会 `proceed` | C7 必红；且不修就是"把陈述当指令"。已加"无动词且无实体 → implicit"守卫 |
| 3 | L1 C1 `expect(...).not.toHaveProperty('challenge')` | `decide()` 对 `ask` 恒定返回 `challenge: boolean`（黄级为 `false`，不是缺字段） | C1 必红。断言改为 `challenge: false` |

---

## 1. Findings 总表

| # | 攻击点 | 严重度 | 处置 |
|---|---|---|---|
| F-L3-01 | `reason` 入参被吞，审计里查不到 | 高 | 事件载荷加 `note?`；测试 T1 钉住 `note: '疑似盗刷'` |
| F-L3-02 | `verify-tiers` 把 `execute` 内嵌套 `return {` 当作工具对象起点，新工厂被判"缺 tier" | 高 | 重构结果为 `Object.assign` 单行；门禁恢复 50/50（未改门禁） |
| F-L3-03 | 工具集 + `paramsDigest` 变化让 8 个快照文件失配 | 高 | 重录 7 场景 + `snapshot:reverify`；39/39 绿 |
| F-L3-04 | 同 turn 内 `ToolGuard` 单调：冻结被拒的同参数转账，解冻后重试仍 deny | 中 | 不修（这是"同 turn 不重试被拒调用"的安全属性）；演示脚本必须跨 turn。探针 P6 第一次失败即此，改参数后通过 |
| F-L3-05 | 加第 20 个事件键是改签冻结契约 | 中 | 按施工单交付 ADR-0006 + event-table v1.0.2；**ADR 未获批前不该合入主线** |
| F-L3-06 | `monthlyLimitCents` 仍无判定读取 | 低 | 按 F-12 只做展示；`dailyLimitOf` 只读 `dailyLimitCents` |
| F-L3-07 | 指定冻结卡时 `dailyLimitOf` 仍取该卡限额 | 低 | 卡状态 block 先行，展示口径不与判决矛盾；保留 |
| F-L3-08 | 卡操作不核销票据 | 低 | 跟随既有口径；靠幂等 + 管线指纹（答辩如实说） |
| F-L3-09 | 卡状态与账户状态是两套真相 | 低 | 只改 `Card.status`；不联动 `Account`（F-08） |
| F-L1-01 | C7 不成立，且空槽位让陈述句 proceed | **高** | 分类器加"无动词且无金额/收款人 → implicit"；C7 绿；TC-INT-08 仍 explicit（纯数值不误判） |
| F-L1-02 | C1 的 `challenge` 断言写错 | 中 | 改 `challenge: false`（黄级 ask 但不挑战） |
| F-L1-03 | 施工单 API 名称漂移：`evidence.rule` 实为 `ruleId`；槽位函数第二参是日期字符串 | 低 | 测试按真实 API 写 |
| F-L1-04 | 22 条语料只有 5 条有工具支撑 | 中 | 不做 eval 新族（F-04）；其余转化为边界话术与七问 |
| F-L1-05 | 状态机 PNG 需外部渲染器 | 低 | 用本地 Edge + mermaid 渲染 `docs/diagrams/card-state-machine.png`（原图在施工单 §1，未另存 .mmd） |
| F-L1-06 | 施工单说"七问"，§4 实际 7 条 + 1 条附加 | 低 | 七问原样进 `judge-walkthrough` §6，附加一条保留 |

---

## 2. 关键论证

### 2.1 F-L3-01：`reason` 要么落审计，要么删掉

`card_freeze` 的 schema 有 `reason`，描述"仅落审计"。但事件表 payload 只有 `reason: 'freeze' | 'unfreeze'`（枚举，不是文本）。
原样实现只能 `readOptionalString` 后丢弃——模型看到 schema 会以为原因被记录，审计里却查不到。

**处置**：`card/state-changed` 载荷加可选 `note?: string`；工具把参数写进 `note`（空/未传则省略，不写空串）。
ADR-0006、event-table、`docs/bank-tools.md` 同步；T1 用例钉住 `note: '疑似盗刷'`。

### 2.2 F-L3-02：门禁的词法启发式与新工厂写法相撞

`scripts/verify-tiers.ts` 从 `satisfies ToolDefinition` 行向前找最近的 `return {` / `const x = {` 作为"工具对象起点"。
新工厂在 `execute` 里写了多行 `return { ... }`，于是最近的对象是执行结果，里面当然没有 `tier` → 门禁红。

**处置**（不改门禁）：结果改用 `Object.assign({}, changed, { at })`，避免在 `satisfies` 前出现第二个对象字面量起点。
门禁回到 50/50；这条也说明"工具工厂内不要写多行对象 return"是隐性编码约束，施工单没写。

### 2.3 F-L3-04：同 turn 的单调 guard 不是 bug

探针第一次跑 P6 失败：冻结 → 同参数转账被 `card-unavailable` 拒 → 解冻 → **同参数**转账仍被拒。
原因是管线 `ToolGuard` 在本 turn 内维持"已判 deny 的调用"。这是既有安全属性（模型不能靠"再试一次"绕过拒绝）。

**结论**：不改。演示脚本里"冻结 → 转账被拒 → 解冻 → 再转账"必须发生在不同用户轮次；同一 turn 的 plan 若重复同参数调用，应视为新决策而非重试。
写进残余风险，答辩不宣称"同 turn 内解冻后立即可用"。

### 2.4 F-L3-03：快照重录不是形式

新工具进入注册表会改 `llm.jsonl` 的工具 schema 列表；`riskyOps` 默认值变化会改 `tier/decided` 的 `paramsDigest`。
实测 8 文件 / 16 测试红，重录 7 个场景后 39/39 绿；`snapshot:reverify` 写入 7 个。
施工单 §6/§7 都没写快照面，这是第二单里最容易被漏的一步（L2 已踩过一次）。

### 2.5 F-L1-01：空槽位把"陈述"变成"指令"

`REQUIRED_SLOTS.card = []` 是计划内的正确修复（卡场景不该追问账户），但分类器的默认分支是 explicit：

- `"钱包被偷了"` 无动词、无金额、无收款人 → 落到 `R-EXP-1` 之后的兜底 → `explicit` + `proceed`；
- 在 `transfer` 场景同样的句子因缺槽位会被追问，所以问题只在"空槽位场景"暴露。

**处置**：兜底前加守卫——`无动作动词 && 无金额 && 无收款人 ⇒ implicit`（propose，永不 proceed）。
`"500"`（纯数值）保留 explicit 基线，因此 TC-INT-08 不回归；resolve 全量 33 条绿。

### 2.6 L1 的 eval 裁决：不做新族（沿用 F-04）

22 条语料里只有 5 条有工具支撑；其余 15 条是能力边界。把它们塞进 eval 要动族联合、族计数、总数、ID 正则与基线（boot 8 次），
收益是 4 条治理判决——而治理判决已由 C1–C4 单测精确到 `level` 与拒绝码。**本轮不做**，答辩用"边界地图"讲。

---

## 3. 负控探针（17/17 通过）

脚本：`07-probe.txt`（临时文件已删，输出保留）。

| # | 探针 | 期望 | 结果 |
|---|---|---|---|
| P1 | 正文可提取 cardId | `c-1` | PASS |
| P2 | 冻结正常卡 | 成功 | PASS |
| P3 | 冻结卡同卡转账 | `card-unavailable` | PASS |
| P4 | 早拒发生在签票前 | `approval/asked` 中无 `transfer_create` | PASS |
| P5 | 解冻（红档 + 强验证） | 成功 | PASS |
| P6 | 解冻后同卡转账（换参数避开同 turn guard） | 成功 | PASS |
| P7 | 冻结/解冻各一条迁移事件 | 2 条 | PASS |
| P8 | `from→to` 与 `note` | 正确 | PASS |
| P9 | 重复冻结不污染事件链 | 1 条 | PASS |
| P10 | 冻结已挂失卡 | `card-lost` | PASS |
| P11 | 解冻已挂失卡 | `card-lost` | PASS |
| P12 | 尾号当 cardId | `card-unknown` | PASS |
| P13 | 卡场景冻结判 explicit 且不追问 | 是 | PASS |
| P14 | 挂失话术 explicit + R-EXP-1 | 是 | PASS |
| P15 | 陈述句不冒充 explicit | `implicit` | PASS |
| P16 | 卡场景金额槽位可抽取 | 是 | PASS |
| P17 | 默认 `riskyOps` 含两新工具 | 是 | PASS |

---

## 4. 验收矩阵

### L3（施工单 §9）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| T1–T10 | 全绿 | ✅ | `mock.test.ts` / `account-ops.test.ts` / `transfers.test.ts` / `05` 摘要 |
| B2 | 演示闭环（查卡→冻结→被拒→解冻→成功） | ⚠️ 管线级闭环 ✅（探针 P1–P6）；真实模型 + 浏览器未实点 | `07-probe.txt` |
| B3 | typecheck / lint / test 绿 | ✅ | `03-test-after.txt` |
| B4 | tool-catalog 18 行，architecture 工具数 18 | ✅ | `pnpm tool-catalog` / `gen-architecture` 输出 |
| B5 | gate 全绿 | ✅ | `04-gate-after.txt`（50/50） |
| B6 | ADR-0006 + event-table 20 键 | ✅ | `docs/adr/0006-card-state-event.md`、`docs/contracts/event-table.md` |

### L1（施工单 §7）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| D1 | C1–C8 全绿 | ✅ | `resolve.test.ts` 33 用例 / `account-ops.test.ts` 12 用例 |
| D2 | 用例数同步 facts | ✅ | 294 文件 / 3360 用例（`facts.md`、`facts-sources.md`） |
| D3 | 七问进 `judge-walkthrough` §6 | ✅ | 第 4–10 条 |
| D4 | 演示脚本按 §5 实走 | ⚠️ 未走真实 UI（离线 router 不识别卡片问法） | 残余 R-L1-1 |
| D5 | 状态机图与 mock 分支一致 | ✅ | `docs/diagrams/card-state-machine.png`；`mock.ts` 四个迁移分支 |

---

## 5. 执行结果（命令与数字）

| 命令 | 结果 | 日志 |
|---|---|---|
| `pnpm typecheck` | 通过 | — |
| `pnpm lint` | 通过 | — |
| `pnpm test` | **294 文件 / 3360 用例** | `03-test-after.txt` |
| `pnpm test:web` | **27 文件 / 375 用例** | `05-test-web.txt` |
| `pnpm test:snapshot` | **9 文件 / 39 用例**（L3 重录后） | `06-test-snapshot.txt` |
| `pnpm eval:unit` | **22 文件 / 158 用例** | `10-eval-unit.txt` |
| `pnpm gate` | **50/50** | `04-gate-after.txt` |
| 负控探针 | 17/17 | `07-probe.txt` |

基线（L3 开工前，`957ce0e`）：294 文件 / 3337 用例、gate 50/50。

---

## 6. 残余风险

| # | 风险 | 为什么要留着 | 答辩怎么说 |
|---|---|---|---|
| R-L3-1 | ADR-0006 改签未获评审批准 | 冻结契约只能由 ADR 改签 | 先亮 ADR；不批则 L3 整单回滚（保留 L1/L2） |
| R-L3-2 | 卡操作不核销票据 | 与 `card_report_lost` 同口径；幂等 + 管线指纹兜底 | 「有资金动作的写操作核销票据；卡状态变更靠幂等」 |
| R-L3-3 | 无跨 turn 冻解熔断 | bank core 无跨 turn 存储 | 「turn 级已有 riskyOps；小时级锁在路线图」 |
| R-L3-4 | 同 turn guard 会拒绝同参数重试 | 既有安全属性 | 「一次拒绝不等于可重试；换参数/换轮次」 |
| R-L3-5 | `viaCardId` 是演示语义 | Mock 无卡消费通道 | 「为让卡状态可验证补的最小通道，不是产品语义」 |
| R-L3-6 | 解挂未实现 | 需要"卡在本人手中"核验链 | 「不可逆链路只做单向，补发替代解挂」 |
| R-L1-1 | 演示脚本未在真实 UI 走通 | 离线 router 不识别卡片问法 | 「管线级闭环已验；模型选卡在演示轮实测」 |
| R-L1-2 | 状态机 PNG 依赖本机 Edge 渲染，不可一键复现 | 仓库零外部运行时依赖 | 图与 `mock.ts` 分支逐边对照；重渲染方法见 §7 |

---

## 7. 复现状态机图

原图（mermaid）见 `02-施工单-L3-冻结与解冻.md` §1。本仓用一次性的本地渲染（Edge 无头 + mermaid UMD）：

```bash
# 前置：下载 mermaid@11 UMD 到临时目录（不提交）
# 用 Edge --headless --screenshot 渲染 620×820 → docs/diagrams/card-state-machine.png
```

产物已提交；脚本属一次性工具，未入库——与 `scripts/render-diagrams.ts` 的"按需准备 mermaid.min.js"同一口径。

---

## 8. 总体判定

| 项 | 判定 |
|---|---|
| L3 目标（卡状态有产生点与后果） | **达成**：冻结/解冻工具 + `viaCardId` 资金路径 + `card-unavailable` 早拒 |
| 工具数 / 事件表 | 16 → 18 / 19 → 20（ADR-0006） |
| 门禁 | 50/50；测试 3360；web 375；snapshot 39 |
| 施工单质量 | L3 方向正确，但漏了 `reason` 落点与快照面；L1 的 C1/C7 断言与现状不符 |
| 合并建议 | **可提交**；合入主线前先确认 ADR-0006 获批（这是本方案唯一动冻结契约的地方） |
