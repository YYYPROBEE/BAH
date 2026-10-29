# 核心算法：权限分级、失败传播、检索与拒答

> W19 交付件之二。三条算法各配**一条可执行命令与本次真实输出**（不是手写示意）。
> 事实口径见本文 §0 的表（与 [architecture.md](architecture.md)、[security-design.md](security-design.md) 共用同一块）。
> 机制细节不在此重复：工具管线看 `docs/pipeline.md`，编排看 `docs/plan.md`，
> 防护看 `docs/sentry.md`，知识看 `docs/knowledge.md`。

## 0. 事实表（三份文档共用）

<!-- BEGIN GENERATED:facts -->
| 事实 | 值 | 唯一来源（以代码为准，改文档不改代码） |
|---|---|---|
| plan 节点态 | **9 态**（pending、ready、running、succeeded、failed、skipped、blocked、cancelled、incident） | packages/runtime/src/plan/types.ts 的 `PLAN_NODE_STATES` |
| saga 状态 | **11 态**（CREATED、RUNNING、PENDING_RISK_REVIEW、GATE_HOLDING、COMPENSATING、PARTIALLY_COMPENSATED、COMPENSATION_DLQ、SUCCEEDED、ABORTED_CLEAN、COMPENSATED、MANUALLY_CLOSED） | packages/saga/src/state-machine/transitions.ts 的 `SAGA_TRANSITIONS` |
| 票据 TTL / 计划预算 | **120000 ms / 30000 ms**（预算 < TTL） | `PlanSettings.ticketTtlMs` / `planTimeoutMs`（本行由 planPlugin.validate 实算） |
| 工具数 | **16 个** | packages/bank/src/tools/specs.ts 的 `BANK_TOOL_SPECS` |
| 注册表条目（项） | **27** | `HOST_PLUGINS` 计数 |
| 门禁（项） | **50** | `scripts/verify-*.ts` 计数 |
| 覆盖率 | **89.06%（行口径，41749/46877 行，实测 2026-10-29）；16/18（包口径：包级行覆盖 ≥80% 的包数 / 参与统计的包数）** | docs/coverage-baseline.json（含测量命令） |
<!-- END GENERATED:facts -->

## 1. 为什么是这三条

评测与答辩会反复回到三个问题，它们分别对应"钱能不能动"、"错了怎么收"、"说的对不对"：

| # | 问题 | 算法 | 一句话 |
|---|---|---|---|
| ① | 这笔操作凭什么被允许？ | 权限分级：`tier` + 票据 + lease | 三级判定 + 一次性票据；**审批一次 = 扣款一次** |
| ② | 三步里第二步失败了怎么办？ | 失败传播：plan 闭包 + saga 11 态 | 未执行的一律 `blocked`，已执行的才谈补偿 |
| ③ | 模型说的数字从哪来？ | 检索与拒答：claims + 验签 + 断言核验门 | 没有证据的高影响断言**不许落账** |

三条的共同点：**判定在确定性代码里，模型只是提出候选**。下面每节都标出"哪一步是模型、
哪一步是代码"，因为这是最容易被追问的地方。

## 2. ① 权限分级三级判定（`tier` + 票据 + lease）

### 2.1 三级的定义与分布（16 个工具）

| 级别 | 数量 | 判定后果 | 工具 |
|---|---|---|---|
| `green` | 12 | 直接执行，**永不**因风险分/熔断被误伤 | `account_list`、`account_balance`、`txn_query`、`bill_analyze`、`bill_report`、`analysis_calc`、`transfer_preview`、`wealth_list`、`wealth_compare`、`verify_face`、`verify_sms`、`verify_ushield` |
| `yellow` | 2 | 必须审批（一次性票据），金额由 `amountPath` 绑定 | `transfer_create`、`sub_cancel` |
| `red` | 2 | 审批 **+ 强验证挑战**（人脸/短信/U 盾） | `wealth_purchase`、`card_report_lost` |

`tier` 声明写在工具 spec 里（packages/bank/src/tools/specs.ts），**不在 `execute()` 里**——
`verify-tiers` 门禁会扫，写进实现里就红。

### 2.2 判定顺序（顺序本身是安全属性）

```text
tools/pre-execute  waterfall（注册顺序 = 外层顺序）
  a. 危险规则     13 条内置 + 部署追加；参数先归一化（base64 / 全角 / 零宽）
  b. PII 检测     仅审计，不作为拒绝依据
  c. 风险分       会话 riskLevel=high → 非绿工具 deny（reason=risk-score）
  d. 预算         先记账再比对（total_calls / risky_calls / amount）
  e. 熔断/降级    锁存冻结、只绿模式、同 turn 工具数超限（三者只拦非绿）
  f. bank 权限面  黄/红 → 签票据；红 → 追加强验证挑战
```

把 a–e 放在 f 之前是有意的：**先判断"这次调用危险吗"，再判断"要不要签票"**。
反过来会出现"票据已经发出去，然后才发现会话被冻结"的窗口。

### 2.3 票据：五绑定 + 一次性核销 + lease

`TicketBinding` 五个字段（packages/bank/src/core/ticket.ts）：

| 字段 | 绑住什么 | 不绑会怎样 |
|---|---|---|
| `sessionId` | 会话 | A 会话的批文能在 B 会话用 |
| `tool` | 工具名 | 批准的 `transfer_preview` 能当 `transfer_create` 用 |
| `fingerprint` | 参数指纹（名字+参数规范化后哈希） | 批准 800 元能改成 80000 元执行 |
| `amountCents` | 金额（分，整数） | 金额被改而指纹没变（浮点比较的历史坑） |
| `expiresAt` | 过期时刻 | 昨天的批文今天还能扣款 |

- **一次性**：核销成功即 `redeemed`，第二次拿同一张票会被拒（"审批一次 = 扣款一次"）；
- **lease**：`planTimeoutMs`（30 s）必须 < `ticketTtlMs`（120 s，见事实表）——
  这条不等式是引擎侧唯一能防"排队排过票据有效期、再拿过期票扣款"的闸，
  `validate` 里 fail-loud 校验；
- **强验证**在票据签发**之前**完成：`ApprovalService.handle` 的 `challenge-required` 分支会拒，
  所以"拿到 `allowed-once`"等价于"MFA 已通过"。

### 2.4 可执行例子（本次真实输出）

```bash
npx tsx scripts/demo-plan.ts --only=ok
```

一个 3 节点计划：`account_balance`（绿）→ `transfer_preview`（绿）→ `transfer_create`（黄）。

```text
  plan/node-started    node=preview ordinal=2
  plan/node-result     node=preview status=succeeded digest=dcde203b7e85… durationMs=39
  plan/node-started    node=pay ordinal=3
  plan/node-waiting    node=pay
  plan/node-result     node=pay status=succeeded digest=c9dec6a58041… durationMs=74
  plan/completed       status=succeeded durationMs=179
  汇总：status=succeeded total=3 succeeded=3 failed=0 blocked=0 skipped=0 cancelled=0
  PASS 每节点一条 tool/call（tool/call=3）
  PASS 审批只发生一次（approval/asked=1）
  PASS 计划判成功（status=succeeded）
```

读法：**3 个工具调用、1 次审批**。两个绿级节点直接过，黄级节点先 `plan/node-waiting`
（等票据）再 `succeeded`。这条断言同时也是"plan 与 saga 别混"的证据：
审批发生在**节点内**，不是外层批一次就放行三个节点。

## 3. ② 失败传播与补偿（plan 闭包 + saga 11 态）

### 3.1 plan：blocked 只记**直接上游**，且一次算清

```text
A → {B, C} → D      A 失败
  B.blockedBy = [A]        直接上游
  C.blockedBy = [A]        直接上游
  D.blockedBy = [B, C]     不是 [A]：只记根因会让"谁没等我"无法追溯
```

- **闭包传播**：A 失败后 D 不可能执行，但 `blockedBy` 必须写 `[B, C]`——
  只传一层或只记根因的写法，会在"B 成功 C 失败"的菱形里给出错误的阻塞原因；
- **不进管线**：被 block 的节点一次都不调工具（`tool/call` 只算 A 自己）；
- **计数口径**：`blocked > 0 ⇒ status='failed'`（阻断不是成功），
  且 `counts()` 把 `incident` 记进 `failed` 桶，否则五计数 ≠ total。

### 3.2 dry-run：证明"预览不产生假记录"

`run(plan, { dryRun: true })` 走完校验 + 拓扑，但**不进管线**：

| 计数 | dry-run | 真实执行 |
|---|---|---|
| `tool/call` | **0** | = 节点数 |
| `approval/*` | **0** | 黄/红节点数 |
| `plan/node-result` | = 节点数（3） | = 节点数 |

三个数一起看才有意义：只看 `tool/call=0` 会把"引擎根本没跑"也算成通过。

### 3.3 saga：11 态，补偿有前提

```text
CREATED → RUNNING → SUCCEEDED
                  → ABORTED_CLEAN
                  → COMPENSATING → COMPENSATED | PARTIALLY_COMPENSATED | COMPENSATION_DLQ
                                 → MANUALLY_CLOSED
                  → PENDING_RISK_REVIEW ⇄ RUNNING / COMPENSATING
                  → GATE_HOLDING ⇄ RUNNING / COMPENSATING
                  → COMPENSATION_DLQ → MANUALLY_CLOSED
```

- 全量 11 态见事实表；`SAGA_TRANSITIONS` 是唯一转移真相（`canTransition` 读它）；
- **补偿不是自动的**：只有注入了补偿依赖，`COMPENSATING` 才会走到 `COMPENSATED`；
  没注入时最远到 `COMPENSATING` 并停在 DLQ 侧，需要人工闭环——
  答辩口径是"**有补偿状态机，不等于是全自动冲正**"；
- `maxAttempts` 必须为 1：幂等键没有传给银行核心，重试 = 真的多扣一次钱。

### 3.4 可执行例子（本次真实输出）

```bash
npx tsx scripts/demo-plan.ts --only=diamond
```

```text
  plan/node-started    node=A ordinal=1
  plan/node-result     node=A status=failed code=tool-args-invalid durationMs=20
  plan/node-blocked    node=B reason=upstream-failed blockedBy=[A]
  plan/node-blocked    node=C reason=upstream-failed blockedBy=[A]
  plan/node-blocked    node=D reason=upstream-blocked blockedBy=[B,C]
  plan/completed       status=failed durationMs=36
  汇总：status=failed total=4 succeeded=0 failed=1 blocked=3 skipped=0 cancelled=0
  PASS D 的 blockedBy 记录两条上游（不是只记根因 A）（blockedBy=["B","C"]）
  PASS 被 block 的节点一次都没进管线（tool/call=1）
  PASS 计划判失败（blocked 计入失败）（status=failed）
```

注意 A 的失败码是 `tool-args-invalid`（负数金额在治理面就被拒，不签票）——
这是**确定性失败**，不依赖余额或随机数据，所以这个例子在任何机器上都一样。

## 4. ③ 检索与拒答（claims + 验签 + 断言核验门）

### 4.1 一条回复要过三道

```text
模型产出文本
  ├─ ① 断言抽取    packages/safety/src/verify/extract.ts   金额/余额/费率/日期/账号尾号
  ├─ ② 证据核验    与 tool/result、知识条目逐条比对
  │      verified ⇒ 放行
  │      needs-evidence ⇒ 加前缀【未核实】
  │      reject ⇒ 整条拒答【拒答】…（reasonCode: reply-hook-failed 兜底）
  └─ ③ 门本身异常   捕获后拒答，绝不"核验失败就放行"
```

三道里**第三道最容易被忽略**：核验组件自己抛错时，正确行为是拒答而不是放行
（`scripts/demo-verifier-fail.ts` 专门演这个：模型可见内容被替换为阻断文案，原始结果不泄漏）。

### 4.2 知识侧：验签不过就拒答

- 双层 HMAC-SHA256：**文件级**（整份语料）+ **条目级**（每条切片），缺一层就能"整体替换 + 局部改动"；
- 校验不过时不返回"低置信答案"，而是 `knowledge/answered{kind:'refusal', reasonCode:'signature-invalid'}`
  ——拒答也是一种答复，且**可审计**；
- 密钥只从环境变量取（`BAH_KNOWLEDGE_KEY`），`profiles/*.yml` 里绝不写密钥；
  入库清单用公开完整性密钥签名，生产必须重签。

### 4.3 可执行例子（本次真实输出）

```bash
npx tsx scripts/sign-knowledge.ts --check
npx vitest run packages/safety/src/verify
```

```text
✔ 知识库签名一致：10 条语料、1 条 fixture 证据（keyId=kid-82d6dbbf47e2）

 ✓ packages/safety/src/verify/verify.test.ts (13 tests) 7ms

 Test Files  1 passed (1)
      Tests  13 passed (13)
```

端到端的检索能力另有两处证据（不在这条命令里）：评测平面 **K 族 10/10**
（`.ci-artifacts/eval/summary.md`），对抗集幻觉族 **12/15**（3 条未拦，见
[security-design.md](security-design.md) §4 的未实现清单——不藏）。

## 5. 三条算法的共同边界（讲清楚比讲漂亮重要）

| 边界 | 现状 | 影响 |
|---|---|---|
| 强验证 provider | 默认是**测试网关适配器**（`verify.provider: mock`） | "红级已过 MFA"只在仿真环境成立；接真实渠道是配置项，不是代码缺口 |
| plan 内的 `transfer_create` | `saga-bridge` 在 plan 关闭 ⇒ **无补偿** | 需要"第 3 步失败退第 2 步"时，应让 plan 编排一整笔 saga，而不是指望节点内补偿 |
| plan 的动态 args | 跨不了 `resume`（output 只在内存） | 续跑要重做已扣款的一笔，只能换新 `planId` + 冲正原笔 |
| 断言核验的覆盖面 | 只覆盖**高影响断言**（金额/余额/费率/日期/尾号） | 定性描述不做事实核验——那是检索质量的问题，不是断言核验的问题 |
| 知识响应信封 | HP-2 未签名 | 检索结果在传输层没有完整性证明（见安全设计缺口表） |
