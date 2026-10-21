# 施工提示词 · 新增快照场景为沙箱与红级链路补背书（方案 A）

> 交接对象：接手这条单的 agent / 工程师。
> 仓库：`D:\项目集\微众杯银行ai智能体\BAH\MonoRepo`（代号 BAH，包前缀 `@bah/`）。
> 背景取证时间：2026-10-21 10:46（`pnpm gate` 实跑日志：`D:\项目集\微众杯银行ai智能体\temp\gate-20261021-1046.log`）。
> 纪律沿用施工单 00（不写 shell、一次一阶段、验收通过才推进、`BAH_ALLOW_NO_SNAPSHOT=1` **不算通过**）。

---

## 0. 纪律 0：你的第一动作

开工前先用 Write 在 `docs/snapshot-sandbox-scenario-report.md` 写下标题 + 一行「施工中 · 尚未取证」，之后再开始核对与编码。
每完成一节就把结论**覆盖落盘**。最终报告必须能自证：每条判定附 `文件路径:行号` 或「命令 + 输出片段」。

**本文里所有事实都是我在 10:46 实跑/实读得到的。若与你查到的实物冲突，以实物为准，并在报告里单列「纠正主线程」条目** —— 不要迁就本文措辞。

---

## 1. 这条单要解决什么（一句话）

`pnpm gate` 现在 **22 绿 / 1 红**，唯一的红是 `snapshot-fresh`：5 个治理平面文件被改动，但没有任何快照场景为它们背书。
**不要用放行变量绕过**，改成给这些代码补一个**真会执行它们**的快照场景。

### 1.1 触发这条红的 5 个文件（是「无人声明」的那 5 个，不是「被改动」的全部）

> **口径先钉住**（11:19 复跑取证）：本轮改动触及的 SENSITIVE 源文件**远不止这 5 个** —— `packages/runtime/src/agent-loop/agent.ts`、`tools/pipeline.ts`、`packages/llm/src/llm/{assemble,route}.ts`、`packages/host/src/boot/plugins/{approval,index}.ts`、`packages/core/src/errors.ts` 等都在改（暂存集里 30+ 个源文件），但它们的路径都被 `headless-basic` + `web-channel` 声明覆盖，且 `web-channel` 的产物本身是**未入库新文件** → 判据 ② 由它满足。只有这 5 个因为**没有任何场景声明**而红。别把这 5 个当「改动全集」去反推范围。

| 文件 | 改动性质 | 快照场景是否真会执行 |
|---|---|---|
| `packages/bank/src/forge/index.ts` | 加 `default: assertNever(tier, 'forge-tier')`（不可达路径收尾） | ✅ boot 期真跑：`packages/host/src/boot/plugins/bank-tools.ts:108` 调 `buildBankDataset` |
| `packages/bank/src/verify/port.ts` | 删本地 `errorCodeOf`，改用 `@bah/util`（唯一语义差：`code:''` 现在回落 `verify-failed`） | ⚠️ 端口在 boot 期构造（`bank-tools.ts:26`），但红级强验证分支现有场景不触发 |
| `packages/safety/src/sandbox-runtime/language.ts` | 自带 `assertNever` + 给求值器加 `default`（把不可达节点从静默 NaN 改成抛 `program-invalid`） | ❌ 两个场景 0 条 `sandbox/*` 事件 |
| `packages/safety/src/sandbox-runtime/runner.ts` | 两处 `default: assertNever(outcome)` | ❌ 同上 |
| `packages/safety/src/sandbox-runtime/worker.ts` | **只加注释** | ❌ 同上 |

### 1.2 决定性取证

两个现存场景 `snapshots/headless-basic`、`snapshots/web-channel` 的 `session.jsonl` 里**只有一个工具调用 `transfer_create`，`sandbox` 字样 0 条**。
所以「沙箱运行时没有任何快照背书」不是这次改出来的回归，是**一直存在的盲区第一次被照出来**。这条要写进 PROGRESS.md，别写成「修了个 bug」。

### 1.3 为什么「重录现有场景」这条路走不通（重要）

`snapshot-fresh` 的判据（`scripts/verify-snapshot-fresh.ts`）是两段：

1. 每个改动的 SENSITIVE 文件必须被某个场景的 `coveredSources` 声明覆盖（`loadCases` 扫 `snapshots/*/scenario.json`，第 244–262 行；前缀匹配 `covers()` 第 285–289 行）；
2. 覆盖它的那个场景，**本次必须有 `snapshots/<name>/session.jsonl` 或 `llm.jsonl` 的字节变化**（第 110–125 行）。

实测：`headless-basic` 在 10:34 被重录过一次，产物与 HEAD **逐字节相同**（`git diff --stat HEAD -- snapshots/headless-basic/session.jsonl` 空输出）。这就是 §44.3-1 记的互斥：**行为等价的重构，永远无法满足第 2 段**。

而 `changedFiles()`（第 192–216 行）= `git diff --name-only <base>` ∪ `git status --porcelain=v1 -z`，**包含未跟踪文件**。
所以新建一个场景目录，它的 `session.jsonl`/`llm.jsonl` 天然是「本次变化的产物」→ 两段判据同时满足，且**不需要动 SENSITIVE 清单、不需要放行变量、不需要谎报覆盖**。这是方案 A 成立的机制。

---

## 2. 两个技术前置（S1 已于 11:06 实测清掉；S2 必须修，不修回放必随机红）

### S1 · worker 加载链能不能在 snapshot 面跑起来 —— **已实测通过（11:06），降级为冒烟断言**

`packages/safety/src/sandbox-runtime/modules.ts:48-59`：`sandboxModuleUrl()` 按「importer 路径是否以 `.ts` 结尾」决定加载 `src/*.ts` 还是 `dist/*.js`；`packageRoot()`（`modules.ts:29-41`）向上走到 `package.json` 的 `name === @bah/safety` 才认包根，所以从 host 的 importer 也能正确落到 `packages/safety/src/`。
snapshot 面 importer 是 `packages/host/src/boot/plugins/sandbox.ts`（`.ts`）→ worker 会去加载 **`.ts`**。

**这条风险我在 11:06 实测排掉了**（推翻本单前一版「机制可用但待验」的说法）：

```
$ npx vitest run packages/host/src/boot/plugins/sandbox.test.ts
✓ packages/host/src/boot/plugins/sandbox.test.ts (4 tests) 94ms
(node:26548) ExperimentalWarning: Type Stripping is an experimental feature …
```

那条 `Type Stripping` 警告就是证据：**真起了 Node worker thread，用原生类型擦除加载了 `.ts`**，且 `code: '1 + 2 * 3'` 求值得到 `7`（`sandbox.test.ts:38-42`）—— 不是桩。

三条随之确定的前提，写进报告：
1. **`pnpm build` 不是录制前置**（worker 走 `src/*.ts`，不经 `dist/*.js`）；
2. worker 链「零包名 import」是这套机制成立的条件（`verify-sandbox` 正在按 `WORKER_SCOPES` 逐文件校验，`verify-sandbox.ts:77-83`）—— 所以本单**不得**在 worker 链上加 `@bah/*` import；
3. 依赖 Node 的原生 type-stripping：本机 `22.17.0` 可用（带警告），`engines` 钉的是 `^22.19 || >=24`（§4 R1）。若将来升 Node 24，这条要复验一次。

你要做的只剩一条冒烟：录制后在 `session.jsonl` 里确认 `sandbox/done` 存在、且 `value` 是你写的那个表达式该得的数（证明真执行了，不是回落进程内 seam）。若这条不成立再停下报告。


### S2 · 沙箱审计的 `elapsedMs` 是真实墙钟，必须先修否则回放必红

- `packages/safety/src/sandbox-runtime/runner.ts:75`：`this.now = options.now ?? (() => Date.now())`，第 94/132 行用它算 `elapsedMs`，第 256 行把 `elapsedMs` 塞进 `sandbox/done` 的审计载荷。
- `packages/host/src/boot/plugins/sandbox.ts:84-88` 构造 `SandboxRunner` 时**没有传 `now`** → 用真 `Date.now()`。
- 快照比对 `packages/test-support/src/session-snapshot/harness.ts:194-218` 是**逐条 `JSON.stringify` 整行比对，没有字段豁免**；`ignorable: true`（`sandbox.ts:85-87`）只让旧 reader 与模型历史跳过（`runtime/src/session/derive.ts:67`、`compaction/summarize.ts:151`），**不影响快照比对**。

结论：不修这条，T-AUD-005（record→replay 全等）和 T-AUD-006（两次回放全等）**必红**，而且是随机红。

修法（一行）：在 `sandbox.ts` 的 `new SandboxRunner({...})` 里加 `now: run.now`。
`RunContext.now` 已存在（`packages/host/src/boot/boot.ts:41-42`），插件里也已经 `const run = ctx.get(RUN_SERVICE)`（`sandbox.ts:59`，构造点在 `:84-88`）；`SandboxRunnerOptions.now` 的注释本身就写着「测试与回放注入固定钟」（`runner.ts:51-52`）—— 这是**补上原本就该接的线**，不是新发明。

**已排除的风险（不用再查）**：硬杀定时器用的是真 `setTimeout`（`runner.ts:172`），**不经过 `this.now`**。所以注入固定钟只改审计数字，不会废掉超时执行。请你自己复核这句话（看 94/132/172 三行），并在报告里确认或推翻。

**要写进报告的一个副作用**：`run.now` 与场景的 `fixedClock({start, step:1})` 是同一个钟，沙箱每跑一次会多消耗 2 次 `now()` 调用 → 之后事件的 `ts` 会整体后移。这仍然确定（调用次数由脚本决定），但意味着**时间戳取决于 `now()` 调用次数**：流程一旦改动就要重录。若你认为后移不可接受，可以改用场景内的独立计数钟（`elapsedMs` 恒为固定值），二选一都要在报告里写理由。

---

## 3. 场景设计（照抄现有模板，别自创结构）

模板文件：`snapshots/headless-basic/{scenario.ts,snapshot.test.ts}`（`snapshot.test.ts` 两份是逐字节相同的副本，直接复制即可）。
`vitest.snapshot.config.ts` 按 `snapshots/**/*.test.ts` 自动发现；`verify-snapshot-fresh` 按 `snapshots/*/scenario.json` 自动发现。**都不用改任何注册表**。
（用例数账：现在 `fixtures.test.ts` 2 + 每场景 4 → 10/10；加一个场景应到 **14/14**。）

### 3.1 CASE 要点

| 字段 | 取值 | 理由 |
|---|---|---|
| `name` | `sandbox-compute` | 目录名 = 用例名 |
| `profile` | `headless` | 复用 `headless` bundle，不引渠道噪声 |
| `sessionId` | `s-snapshot-sandbox-compute` | 必须固定 |
| `clock` | `{ start: 1_700_000_000_000, step: 1 }` | 与前两场景同源，便于对照 |
| `randomSeed` | `7` | seeded 造数，`forge` 走 `seededRandom` |
| prompts / 模型脚本 | 见 3.2 | 三条都要覆盖到 5 个文件 |

### 3.2 模型脚本必须真正踩到这三面（`core:model` 的 `script`）

工具目录里可选的 14 个 P0 工具之一，规格取证如下：

1. **沙箱面** —— `analysis_calc`（`packages/bank/src/tools/specs.ts:150-169`）：`tier: green`（**不触发审批，链路最短**）、`event: 'read/analysis'`、schema `{ code: string 必填, data?: object }`。
   DSL 支持面（`language.ts:15`、函数表 `language.ts:88-114`）：数字、`+ - * / %`、括号、一元正负、`data.<path>` / `data['key']` 只读引用、`sum/avg/min/max/round/abs`。**没有循环、没有函数定义、没有 IO** —— 别写 `for`/`while`，会被判 `program-invalid`。
   建议 `code`：`round(data.dining / (data.dining + data.transport) * 100)`，`data: { dining: 620, transport: 180 }`（值你定，定完就别改，改了要重录）。
   走通链路：`queries.ts:258-282 createAnalysisTool` → `runBoundedCompute`（`queries.ts:483-534`，`elapsedMs` 用 `clockOf(deps)`，**已是注入钟，无需改**）→ `BANK_COMPUTE` seam（`sandbox.ts:96-104`）→ `SandboxRunner.run` → worker → `sandbox/done` 落账。
2. **红级强验证面** —— 转给**新收款人**。`tier.ts:114-131 escalateTransferTier`：`preview.payee.binding === 'new'` → 直接升 **red**（`reason: 'new-payee'`）；`tier.ts:134-136 requiresChallenge('red') === true`；`tier.ts:189` 返回 `kind:'ask'` 且带 `challenge`。
   治理平面会自己喂 preview：`governance.ts:346 decide({…})`、`governance.ts:413 deps.core.previewTransfer`、`governance.ts:370 challenge: deps.config.redChallenge`（默认 `'sms'`，`host/src/boot/plugins/bank-tools.ts:87`）—— **单次 `transfer_create` 就能升红**，不需要先调 `transfer_preview`。
   已有实物背书：`packages/bank/src/tools/tier.test.ts:212-238` 断言 100 元转给新收款人 → `{kind:'ask', level:'red', reason:'new-payee', challenge:true}`。
   headless 能自动过：`packages/interaction/src/approval/headless-responder.ts:44` 缺省 `verifyChallenge = true`，`:54-55` 真调 `view.challenge.verify()`；审批服务在 `service.ts:125 issueChallenge` 处签发 → **`bank/src/verify/port.ts` 的 `issue`/`verify` 真被执行**。
   ⚠️ **但我前一版说错了一句，别照着写**：port 的 `catch` 分支**不会**进快照。缺省 provider 是 `createMockVerifyProvider`（`packages/bank/src/verify/index.ts:69-76`，`successAfter ?? 1` → 第一次尝试即成功），不抛错。要覆盖 `catch` 得把 `verifyProvider` 换成失败替身 —— 那是**另一条单**（会牵动档位与审批事件表），本单只声明到「目录被执行」，并在报告里如实写「catch 分支未背书」。
   注意别撞日限额把理由搞混：生效上限 = `min(账本卡限额, Config.dailyTransferLimitCents)`（`tier.ts:110-122`），`forge/index.ts:74` 的 `dailyTransferLimitCents: 500_000`（=¥5 000）。用「新收款人 + 小额（如 ¥120）」拿到的 `reason` 才是 `new-payee`，不是 `daily-limit`。

3. **管线基线** —— 保留一次普通读（如「帮我查一下余额」），让 turn/step/tool 事件结构与前两场景同形，比对时好定位。

`interaction:approval` 行沿用 headless-basic 的 `{ responder:'headless', autoDecision:'allow', autoVerify:true }`；`safety:sandbox` 行保留 `{}`（走 `DEFAULT_SANDBOX_SETTINGS`，`sandbox.ts:40-46`）。

### 3.3 `coveredSources` 只写「这条对话真跑到了」的

以 headless-basic 的清单为底（`snapshots/headless-basic/scenario.ts` 里那段有逐条注释，写法照它），**新增且只新增**：

```
packages/safety/src/sandbox-runtime/
packages/bank/src/forge/
packages/bank/src/verify/
```

每加一条，都要在 `scenario.ts` 的注释里写清「凭哪条事件/哪个调用点说它被执行」。
**新清单必须是 headless-basic 清单的超集**（含 `packages/host/src/boot/`）—— 因为你还要改 `sandbox.ts`（属 `host/src/boot/`，也是 SENSITIVE），老两场景的产物字节不许变（第 7 节禁区），所以那处改动只能由**新场景**的产物来背书。漏一条 = 门禁继续红。

**覆盖证据分两级（前一版只写了事件级，会让 `forge` 无法声明而卡死）**：

| 级 | 判据 | 适用于 |
|---|---|---|
| 事件级 | `session.jsonl` 里能 grep 到该路径产出的事件 | `sandbox-runtime/`（`sandbox/done`）、`verify/`（`approval/challenge-issued` / `approval/decided`，事件名见 `interaction/src/approval/events.ts:131-153`） |
| 装配级 | 该路径只在 boot 期执行、不落自己的事件，但其**产物被后续事件引用** | `bank/forge/`：证据 = `scenario.json` 的 `bank:tools` 行 `{demoUserId:'u-1', seed:7, datasetTier:'demo'}` + 快照里余额/流水/收款人取自 seeded 造数（如 `transfer/created` 的 `balanceCents`、`account_balance` 的账户尾号） |

声明粒度是**目录**，不是分支：一条 `demo` 分支就足以如实声明 `packages/bank/src/forge/`。**不要**为了「把 demo/stress/adversarial 三分支都跑一遍」再加场景 —— 那是本单之外的范围。
两级证据都给不出的声明一律删掉，并在报告里点名是哪一个。


### 3.4 覆盖率侧的三条联动（本单会碰到，别当成无关噪声）

| # | 实物 | 对本单的意义 | 必须做的处置 |
|---|---|---|---|
| C1 | `vitest.config.ts:62-65` 把 `packages/bank/src/forge/index.ts` 放进 `coverage.exclude`，**注释里写的移除条件正是**「新增 `stress` 档快照场景覆盖 forge，或 snapshot-fresh 支持「纯重构」声明」；同一段还承认「纯重构在 CI 下过不了该门禁」 | 这条覆盖率债是 `snapshot-fresh` 自己造成的，而本单就是去还它的机会 | 见下面的 `datasetTier` 决策点。默认：**本单不撤豁免**，但在报告里写「债的条件已被本单部分满足 / 还差什么」 |
| C2 | `scripts/coverage-allowlist.ts:63-64` 强制 `package: host, scope: boot/` 逐文件行/语句/函数 100%（`perFile: true`） | 你 T3 改的 `sandbox.ts` **在这张名单里** —— 新加的那行必须真被用例执行到，否则 `test:coverage` 立刻红 | T4 的用例必须走 `ctx.use(sandboxPlugin.plugin, …)` 的真 `apply()` 路径（现有 `sandbox.test.ts:32-38` 就是这么做的，照它） |
| C3 | 同一份名单里 `safety` 只有 `sentry/` 与 `sandbox-policy/`（`:93-99`），**`sandbox-runtime/` 不在 100% 强制名单** | 本单给沙箱运行时补的是**快照背书**，不是行覆盖强制；两者别混为一谈 | 报告里如实写「`sandbox-runtime/` 仍无逐文件覆盖强制」，并把扩容建议交给下一轮；⚠️ 扩容前要先验 `worker_threads` 里的执行能否回流覆盖率统计（`worker.ts` 运行在独立线程），否则加了名单也只会得到假 0% |

**`datasetTier` 决策点（要你选，并把理由写进报告）**：

| 选项 | 收益 | 代价 |
|---|---|---|
| `demo`（推荐默认） | 数据集最小、事件最短、与老两场景同形，比对时噪声最小 | C1 那条债还不掉，只能登记 |
| `stress`（3 用户） | 一次改动同时满足 C1 的移除条件，可直接把 `forge/index.ts` 从 `coverage.exclude` 撤掉 | 造数量级上去，快照行数变长；且 3 用户与 §43.2 未决项「同一会话会不会换人」贴得很近，容易被卷进那条待裁定问题 |

两个选项都算完成本单；**不要**为了「覆盖 forge 三个分支」再开第四个场景 —— 声明粒度是目录，不是分支。

---

## 4. 施工顺序（一次一步，每步带验收）

| # | 动作 | 验收命令 / 判据 |
|---|---|---|
| T1 | 建报告占位文件（纪律 0） | 文件存在 |
| T2 | 复核第 1、2 节每条取证（含 S2 的 172 行） | 报告里逐条「一致 / 推翻 + 证据」 |
| T3 | 改 `packages/host/src/boot/plugins/sandbox.ts`：`new SandboxRunner({..., now: run.now})` + 注释「为何必须注入：快照面逐条整行比对」 | `pnpm typecheck` 0 错；`pnpm test packages/host/src/boot/plugins/sandbox.test.ts` 绿 |
| T4 | 给这行改动补一条**可判真伪**的不变量用例（放 `sandbox.test.ts`）：注入一个刻度已知的钟（如 `fixedClock({ start: 1_000, step: 5 })` 或 `now: () => 递增`），断言 `sandbox/done` 的 `elapsedMs` **等于注入钟的刻度**，而不是「两次相等」。<br>⚠️ 前一版写的「两次执行 elapsedMs 相等」是**弱判据**：撤掉注入后 `Date.now()` 在快路径上可能两次都给同一个整数（差值 <1ms），负控会**不响**——那等于没护栏。 | `pnpm test` 该文件全绿；把 T3 的 `now` 撤掉 → **必红**（真墙钟值 ≫ 5，必然不等）。若撤掉后仍绿，判据无效，重写。<br>硬杀语义不用你新写：`packages/safety/src/sandbox-runtime/runner.test.ts:74` 已断言 `sandbox/timeout`；你只需确认 `runner.ts` 的 `this.now` 仅出现在 `:94`/`:132`（算 `elapsedMs`），超时走 `setTimeout`（`:172`、`:177` 用 `limits.timeoutMs`） |
| T5 | 直接建正式场景（S1 已实测，不必再单独 spike），录制后做冒烟确认 | `pnpm snapshot:record` 后 `session.jsonl` 里有 `sandbox/done`，且 `read/analysis` 的 `value` 与你写的表达式对得上（证明真进 worker，不是回落 `defaultCompute`） |
| T6 | 按 `snapshots/README.md:69` 给的官方流程新增场景（复制 `headless-basic` 改 `CASE.name` 与 prompts），定稿 `snapshots/sandbox-compute/{scenario.ts,snapshot.test.ts}`（三节 3.1–3.3） | `pnpm snapshot:record` 成功；`pnpm test:snapshot` 老 10 例 + 新 4 例全绿；连跑 3 次结果一致 |
| T6b | 把新场景登记进 `snapshots/README.md` 的场景树（`:21` 一带），并按 §9 的口径补一句「本场景背书哪些此前无背书的目录」 | `pnpm gate` 的 `docs-paths` 绿；README 与目录实物一致 |
| T7 | 按 3.3 的两级证据定稿 `coveredSources`，`git add` 新目录与 T3 改动 | `git add snapshots packages/host/src/boot/plugins/sandbox.ts`；`pnpm gate` **23/23 且不带任何放行变量**，`exit 0`。<br>⚠️ **取数必须在 commit 之前**：暂存（`A`）仍算「本次变化」，但一旦提交，工作树相对基线就没有改动了，`snapshot-fresh` 会反过来红在「无法证明快照与当前代码一致」（`verify-snapshot-fresh.ts:65-77`，本机无 `origin/main` 时基线退到 HEAD）。提交后要复证，就显式给开工前那个提交：`BAH_SNAPSHOT_BASE=<开工前 HEAD> pnpm gate` —— 这是**基线锚点**，不是放行变量，与禁区第 1 条不冲突 |
| T8 | 全量复验 + 登记偏差 + 写 PROGRESS.md 新节 | 见第 5、6 节 |

---

## 5. 出口标准（全绿才算完，缺一不许声称完成）

| 项 | 要求 | 命令 |
|---|---|---|
| 门禁 | **首行报出的全部项全绿，未设 `BAH_ALLOW_NO_SNAPSHOT`**。⚠️ **别把总数当常量**：`run-gates.ts` 按 `verify-*.ts` 自动发现，今天从 16 → 21 → 23 涨过两次，别的会话随时可能再加。报告要记实测总数 + 与开工时的差值 | `pnpm gate` |
| 快照面 | 老两场景 10/10 **保持绿** + 新场景 4 例全绿（用相对判据，别钉死「14/14」这种会漂的绝对数），**连跑 3 次稳定**；配置已 `fileParallelism:false`，别改回并行（会抢 `sessions/saga.sqlite`）。<br>耗时余量已实测（11:18）：`Duration 2.78s`，单场景 4 例 260–278ms，`testTimeout: 30_000` 余量充足 —— 不要为「怕超时」去减场景内容 | `pnpm test:snapshot` |
| 单测 | **开工前先跑一次 `pnpm test` 记下基线数**（10:21 记录是 1 266 passed / 143 文件，但工作树一直在动，别拿它当基准）；收工必须 ≥ 基线 + 你新增的用例数，且 0 skipped 增加 | `pnpm test` |
| 类型 / Lint / 构建 | 各 0 | `pnpm typecheck` / `pnpm lint` / `pnpm build` |
| 覆盖率 | 0 ERROR（本机 `node-safe-delete` shim 会拦 `coverage/` 清理；用 `npx vitest run --coverage --coverage.reportsDirectory=<temp目录> --pool=forks --poolOptions.forks.singleFork=true` 取 exit 0） | 同上 |
| 负控 1 | 撤 `now: run.now` → **T4 用例必红**（唯一确定信号）。`pnpm test:snapshot` 是否同时红不作要求：真墙钟差值可能巧合相等，把它当判据会制造假警 | 手动改后跑 |
| 负控 2 | 从 `coveredSources` 删掉 `packages/safety/src/sandbox-runtime/` → `pnpm gate` 的 `snapshot-fresh` 必须红 | 手动改后跑 |
| 负控 3 | **把新场景的声明文件挪走**：`mv snapshots/sandbox-compute/scenario.json{,.bak}` → `snapshot-fresh` 必须红（`loadCases` 只认 `scenario.json`，见 `verify-snapshot-fresh.ts:254-262`） | 手动改后跑 |
| 负控 4 | **临时改名整个场景目录**：`mv snapshots/sandbox-compute snapshots/_off-sandbox-compute` → `pnpm gate` 必须红（`loadCases` 与 vitest 都按目录扫描）。<br>⛔ **禁止用无路径限定的 `git stash push -u`**：本机工作树有 800+ 项未提交（含 `design/bah-ds` 728 个文件 + web 端源码），全库 stash 会一并卷走，恢复只靠一次 `pop` 成功 —— 在 Windows + 非 ASCII 路径上是真实的人身伤害。<br>顺带记住：**「忘 `git add`」不是负控**。`changedFiles()` 走 `git status --porcelain`，未跟踪也算数（第 192–216 行 + 解析体第 224–241 行），不 `git add` 本地照样绿；但 CI 上未入库 = 场景不存在 = CI 红。所以「产物 + `scenario.ts` + `snapshot.test.ts` 全部入库」要单独核 | 手动改后跑 |


**任一条该响而不响 = 护栏是假的**，这条单不算完成（负控 1 的判据只看 T4，别拿快照面的巧合当响应）。

---

## 6. 收尾要落的两份文字

1. `docs/snapshot-sandbox-scenario-report.md`：取证复核结论（含「纠正主线程」条目）、T1–T8 每步命令与输出片段、三面覆盖的两级证据（事件级贴 `session.jsonl` 原文；装配级贴 `scenario.json` 的 `bank:tools` 行与被引用的 seeded 数值）、四条负控的红/绿对照、出口标准逐项打勾。
2. `PROGRESS.md` 追加一节（现文件 45 节，接 `## 46.`）：写清三件事，**不许写成"顺手修了个 bug"**：
   - 新增快照场景 `sandbox-compute`，把 `sandbox-runtime/`、`bank/forge/`、`bank/verify/` 从「无背书」变成「有逐条整行背书」；
   - 顺带补上 `safety:sandbox` 缺失的固定钟注入（这是录制能成立的前提，不是可选优化）；
   - 沙箱面此前在快照面无背书这一事实及其成因（两场景只调 `transfer_create`），登记偏差 `R-SNAP-01…`（沿用 §45.2 的表格式：编号 / 偏差 / 影响 / 回收条件）。
   - 若沙箱的 4 个 `sandbox/*` 事件名（真源：`packages/safety/src/sandbox-runtime/protocol.ts:58-61`）仍未进平台事件表，如实记为遗留：现在 `verify-session-events`/`verify-event-modes` 不强制它们（这次 22 绿里有它们未声明也不红，已实测），并写清要不要纳入下一轮门禁扩容。
3. **提交策略**（本单只出**一个**提交，内容 = `packages/host/src/boot/plugins/sandbox.ts` + T4 用例 + `snapshots/sandbox-compute/**` + `snapshots/README.md` + PROGRESS 新节 + 本单两份 docs）：
   - 仓库是 conventional commits 风格（`fix(saga):` / `test(web,cli):` …），建议 `test(snapshot): add sandbox-compute scenario backing sandbox-runtime, forge and verify`。
   - **禁止拆出「中间态红提交」**：源码改动与它的快照背书必须在同一个提交里落地。坏先例是 `614aa0f`——修了顺序却在 message 里写「headless-basic 快照逐字节不变」，那句断言是错的（§44.1 已经点过名）。
   - message 里只写**能被复算**的断言（门禁实测总数、快照用例数、命令），不写「行为不变」这类无法验证的话。若你确实认为行为不变，可复算的证据是「撤掉 `now` 注入后 T4 用例红」。
   - 提交前按 T7 取完数；提交后用 `BAH_SNAPSHOT_BASE=<父提交>` 复证一次并把输出贴进报告。

---

## 7. 禁区（动了就要重来）

- 不用 `BAH_ALLOW_NO_SNAPSHOT=1` 把红藏起来（§0.2 口径：放行不算通过）；也不许用 `BAH_SNAPSHOT_BASE` **替代**本次应有的变化来蒙过判据。唯一允许的情形：提交之后按 T7 把它指向**开工前那个提交**复证一次，且报告里写明这是基线锚点。
- 不改 `verify-snapshot-fresh.ts` 的 `SENSITIVE` 清单，也不改门禁判据来「适应」新场景。
- 不重录、不修改 `snapshots/headless-basic` 与 `snapshots/web-channel`（它们的字节必须保持与 HEAD 一致，这是「本次是纯新增」的证据）。
- 不碰 `packages/runtime/src` 七段管线（改它属破坏性变更，须同步架构文档 + 全量重录，超出本单范围）。
- 不改 `modules.ts` 的 src/dist 解析规则；不改沙箱档位/硬杀/三态失败语义（`verify-sandbox`、`verify-tiers` 在守）。
- 不引入 `analysis_calc` 之外的新工具、不给 DSL 加构造、不动 `QuickJS`（§43 已决议延后）。
- 金额单位口径（§45.2 R-WEB-D9）**本单不动全仓**，只在报告里记你看到的实际单位。
- 不跑 `pnpm check`（会重建 `coverage/` 撞本机删除保护），按第 5 节分步跑。

## 8. 交接时容易踩的坑（第 4–6 条是 11:06 复审补进来的）

1. `analysis_calc` 的投影文本里带 `elapsedMs`（`queries.ts:277`）—— 它走 `clockOf(deps)` 是注入钟、没问题，但**别误判成第二个不确定源**；真正的不确定源只有一个：S2 那个 runner 的 `Date.now()`。
2. 场景文件 `scenario.ts` **不是**用例文件（`vitest.snapshot.config.ts` 的注释里写明了），别指望它被自动跑；要跑的是同目录的 `snapshot.test.ts`。
3. `recordSnapshot` 之后必须立刻用 replay 自证（`snapshot.test.ts` 第一条就是 record→replay 全等）；录制「成功」不等于可回放。
4. **第三个场景会共享仓库级 sqlite**：`bank:saga-store` 的 `dbPath` 是 `sessions/saga.sqlite`（相对 cwd，非每场景独占，见 `vitest.snapshot.config.ts` 的注释与 `headless-basic/scenario.json` 的该行）。加场景前先做一次残留探针：**清空 `sessions/saga.sqlite` 跑一次、不清空再跑一次**，两次的 `pnpm test:snapshot` 结果必须一致。不一致 = 场景之间存在状态泄漏（这是真缺陷，别用「每次跑前删文件」糊过去），如实登记并给出每场景独立 `dbPath` 的方案供上层裁定。
5. **DSL 预算与载荷都有硬上限，别让场景恰好卡在边上**：`compute-bounded` 档位 = `timeoutMs 5_000 / maxOperations 100_000 / maxOldGenMb 128 / maxPayloadBytes 1 MiB`（`packages/safety/src/sandbox-policy/tier.ts:57-62`）；超载荷走 `admit()` 拒绝（`runner.ts:141-154`）会落 `sandbox/refused` 而不是 `sandbox/done`。注意 `runBoundedCompute` 在请求里还带了一份 `limits:{ timeoutMs, maxOperations: 10_000 }`（`packages/bank/src/tools/queries.ts:520`），**执行侧真正生效的额度由档位规格决定**（`runner.ts:96/117/131` 传的是 `decision.limits`）—— 别把这两处当成同一个数去写断言。
6. **`verify-sandbox` 门禁不会因为 `now:` 而红**（我复核过）：它只做 AST 校验 `SandboxPolicy` 构造与 `runner.run(...)` 调用点（`scripts/verify-sandbox.ts:62-95`）+ worker 作用域的零包名 import（`:77-83`），不检查 `SandboxRunner` 的构造参数表。

---

## 9. 本单不做、但必须写进报告的结构问题（11:15 整体复审补）

### 9.1 盲区台账：这条单是「开头」，不是「收尾」

`snapshot-fresh` 只在**文件被改动时**才要求背书（`verify-snapshot-fresh.ts:78`：`sensitive = changed.files.filter(...)`）—— 对没被改动的 SENSITIVE 文件，它从来不看有没有场景声明。
我用一次性只读脚本按同一套前缀匹配做了全量对账（脚本落在仓库外：`D:\项目集\微众杯银行ai智能体\temp\blind-ledger2.cjs`）：

| 口径 | 实测（11:15） |
|---|---|
| SENSITIVE 面非测试源文件 | 204 |
| 被至少一个场景声明覆盖 | 123 |
| **无任何场景声明** | **81（39.7%）** |
| 分布 | `saga/src` 28 · `safety/src` 18 · `persistence/src` 14 · `runtime/src` 12 · `bank/src` 5 · `llm/src` 4 |

结论直说：**本单只把 81 个里的 5 个（`sandbox-runtime/` 三个 + `forge/index.ts` + `verify/port.ts`）从盲区变成有背书，剩下 76 个仍然无人声明**；而只要没人改它们，门禁永远不会追问。所以：

1. 报告里必须贴这张台账的**当时现状**（重跑上面那个脚本即可复算），**不许**把本单写成「快照覆盖问题已解决」。
2. 把结构修法登记给下一轮门禁扩容（作为 `docs/gate-expansion-07.md` 的第 8 项）：加一条**与 diff 无关的无条件不变量** —— 每个 SENSITIVE 单元要么被某场景声明，要么进一份显式「已知盲区」名单，名单每项要写理由（例如 `llm/src/deepseek/` 需要 API key，永不进无密钥快照）。
3. **这条不要在本单实现**：一落地就红 76 项，会把真实回归的信号淹掉（§44.3 已经为此记过教训）。建议的补背书排序：先 `saga/`（28 个，资金补偿面）与 `safety/`（18 个，防护面），`llm/src/deepseek/` 归入「e2e-only」名单。

### 9.2 新增文档会自咬门禁（11:19 实测，我自己刚中招）

`verify-docs-paths` 扫 `docs/` 里的路径引用并要求目标存在：本提示词初版因为引用了当时还不存在的报告文件，**自己把门禁从 1 红变成 2 红**（复跑 `pnpm gate` 抓到的）。
两条规矩：写 docs 前先把它引用的文件建出来（哪怕只是占位，见 `docs/snapshot-sandbox-scenario-report.md`）；引用仓库外的东西就写**绝对路径**，别让门禁按仓库根去解析。改完 docs 只核一条即可：`pnpm gate` 里 `docs-paths` 是否绿。

