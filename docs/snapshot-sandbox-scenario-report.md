# 施工回执 · 快照场景 sandbox-compute（方案 A）

> 本文件是 `docs/snapshot-sandbox-scenario-brief.md` 要求的施工报告落点。
> 状态：**施工完成，停在可复核态**（2026-10-21；未提交）。
> 纪律：每条判定附 `文件路径:行号` 或「命令 + 输出片段」；与施工单冲突的以实物为准，单列「纠正主线程」。

## 0. 决策记录（用户已拍板）

| 决策点 | 选择 | 理由 / 影响 |
|---|---|---|
| `datasetTier` | **stress** | 3 用户、数据量更大；用于尝试满足 `vitest.config.ts` 中 `packages/bank/src/forge/index.ts` 覆盖率豁免的移除条件。实测**不能**直接撤（见 §7）。 |
| 沙箱审计时钟 | **独立计数钟** | 会话时钟 `RunContext.now` 保持不变；新增可选 `RunContext.sandboxNow`，`sandbox/done.elapsedMs` 为固定值 5。 |
| 收尾提交 | **停在可复核态** | 完成改动、验证、只 `git add` 本单文件；不提交。 |

> 独立计数钟相对施工单 T3「一行 `now: run.now`」是**设计偏差**：多改 `boot.ts` 的 `RunContext`（可选字段）与场景的 `sandboxNow` 传参。这是用户明确选择，不是实现自作主张。

## 1. 主线程取证逐条复核

开工基线（12:04–12:05，`HEAD=3836030`）：

```text
$ pnpm test
 Test Files  143 passed (143)
      Tests  1266 passed (1266)

$ pnpm gate
BAH 门禁 · 共 23 项
✘ snapshot-fresh
    · packages/bank/src/forge/index.ts: 没有快照场景在 scenario.json 的 coveredSources 里声明覆盖该路径
    · packages/bank/src/verify/port.ts: 没有快照场景 ... 覆盖该路径
    · packages/safety/src/sandbox-runtime/language.ts: ...
    · packages/safety/src/sandbox-runtime/runner.ts: ...
    · packages/safety/src/sandbox-runtime/worker.ts: ...
    ℹ 基线：HEAD（本地工作树）；改动 830 个文件（含未跟踪）
    ℹ 已重录场景：web-channel
阻断合并：1/23 项未通过
```

| 施工单条目 | 实物证据 | 判定 |
|---|---|---|
| 5 个文件改动性质 | `git diff HEAD`：`forge/index.ts` 加 `default: assertNever`；`verify/port.ts` 改用 `@bah/util` 的 `errorCodeOf`；`language.ts` 自带 `assertNever` + `default`；`runner.ts` 两处 `default: assertNever`；`worker.ts` 只改注释 | 一致 |
| 两个老场景只有 `transfer_create`、0 条 sandbox | `grep -c sandbox snapshots/{headless-basic,web-channel}/session.jsonl` 均为 0；两文件都只有 `transfer_create` | 一致 |
| `snapshot-fresh` 两段判据 | `scripts/verify-snapshot-fresh.ts:110-125`（fresh）、`:244-262`（loadCases）、`:285-289`（covers）、`:192-241`（changedFiles，含 `git status --porcelain`） | 一致 |
| S1 worker 加载链可跑 | `npx vitest run packages/host/src/boot/plugins/sandbox.test.ts` → 4 passed（12:05），日志有 `ExperimentalWarning: Type Stripping`；`1 + 2 * 3` 求值 7 | 一致（实测） |
| S2 `elapsedMs` 用真墙钟 | `runner.ts:75` 默认 `Date.now()`；`:94`/`:132` 算 elapsed；`sandbox.ts:84-90` 原先未传 `now`；`harness.ts:194-218` 逐条 `JSON.stringify` 整行比对 | 一致 |
| 硬杀不走 `this.now` | `runner.ts:172-177` 用真 `setTimeout` + `limits.timeoutMs` | 一致 |
| 「注入 `run.now` 会让后续事件 ts 后移」 | `fixedClock()` 的 `now()` 是常量，只有 `tick()` 推进（`packages/test-support/src/fixtures/index.ts:41-54`）；`headless-basic/scenario.ts:118` 传的是 `clock.now`；`session.jsonl` 所有 `at` 都是 `1700000000000` | **推翻** → C-1 |
| `analysis_calc` 规格/链路 | `specs.ts:150-169`（tier green，event `read/analysis`）；`queries.ts:258` createAnalysisTool、`:483` runBoundedCompute；DSL 函数表 `language.ts:88-114` | 一致 |
| 红级新收款人 | `tier.ts:114-131`（new → red）、`:134-136`（red 必须挑战）、`:189`（ask + challenge）；`governance.ts:346/413` 自动喂 preview；`tier.test.ts:212-238` 已有 100 元新收款人断言 | 一致 |
| headless 自动过挑战 | `headless-responder.ts:44` 缺省 `verifyChallenge=true`；`:54-55` 真调 `challenge.verify()`；`service.ts:125` 签发 | 一致 |
| `verify/port.ts` 的 catch 进不了快照 | `verify/index.ts:69-74` 缺省 `successAfter=1`，首次即成功；`port.ts:98-107` catch 分支未执行 | 一致，如实登记未背书 |
| 日限额 | `forge/index.ts:80` = 100_000 分（¥1000）；`bank-tools.ts:146` 用 Config 收紧；实测 u-1 基准日无转出 | 一致 |
| C1/C2/C3 | `vitest.config.ts:59-65` 的 forge 豁免；`scripts/coverage-allowlist.ts` 的 `host/boot/` 100% 与 `safety/sentry/`+`sandbox-policy/`（无 `sandbox-runtime/`） | 一致 |
| 「复制 headless-basic 改 name/prompts」 | mock 脚本写死在 `profiles/headless/patch.yml:14`；`web-channel` 已用场景内 `overlay.yml`（`snapshots/web-channel/scenario.ts:70`、`:100`） | **部分推翻** → C-2 |
| `PROGRESS.md` 接 `## 46.` | 现文件已有 `## 46.`（`PROGRESS.md:1180`（2026-10-29 瘦身后现落 `docs/progress-archive-2026-10-18_28.md` §46），门禁扩容 07） | **推翻** → C-3 |

## 2. 沙箱审计时钟（T3）与 T4 不变量用例

### 2.1 实现

| 文件 | 改动 | 证据 |
|---|---|---|
| `packages/host/src/boot/boot.ts:43-48` | `RunContext` 新增可选 `sandboxNow?: () => number`；缺省跟随 `now` | `grep -n sandboxNow` → `:48` |
| `packages/host/src/boot/plugins/sandbox.ts:84-91` | `new SandboxRunner({ ..., now: run.sandboxNow ?? run.now })` | `grep -n "now: run"` → `:90` |
| `packages/host/src/boot/plugins/sandbox.test.ts:54-80` | 新增 T4：`fixedClock({ start: 1_000, step: 4_096 })` 的 `tick` 作为 `sandboxNow`，断言 `sandbox/done.data.elapsedMs === 4_096` | `grep -n 沙箱审计钟` → `:54` |

为什么用 4096：无注入时真实墙钟耗时不可能恰好等于 4096ms（且档位 `timeoutMs=2000`，成功 `sandbox/done` 的墙钟必然 <2000），负控不会被巧合掩盖。

### 2.2 负控 1（T4 真会响）

临时删掉 `now: run.sandboxNow ?? run.now`，再跑同一用例：

```text
$ npx vitest run packages/host/src/boot/plugins/sandbox.test.ts
 FAIL  ... > 沙箱审计钟可独立注入：elapsedMs 等于注入钟的步长（不读墙钟）
AssertionError: expected 71 to be 4096 // Object.is equality
- Expected
+ Received
- 4096
+ 71
EXIT=1
```

恢复注入后：

```text
$ npx vitest run packages/host/src/boot/plugins/sandbox.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

### 2.3 `fixedClock` 纠正（C-1）

`fixedClock` 返回的 `now()` 只读 `current`；只有 `tick()` 才 `current += step`（`packages/test-support/src/fixtures/index.ts:41-54`）。所以：

- 场景传 `now: clock.now` 时，事件 `at` 恒为 `clock.start`；`grep -o '"at":[0-9]*' snapshots/headless-basic/session.jsonl | sort -u` 只有一个值；
- 独立沙箱钟必须用 `tick` 或自增函数；用 `fixedClock({step:5}).now` 会得到 elapsed 0，不是 5；
- 施工单 §2 的「后续事件 ts 整体后移」不成立。共享 `run.now` 本身是安全的；本单仍按你的选择用独立钟，以让 `elapsedMs` 是非零固定值。

## 3. 场景三面与两级覆盖证据

### 3.1 场景文件

| 文件 | 作用 |
|---|---|
| `snapshots/sandbox-compute/scenario.ts` | 录制/回放共用；`CASE.prompts` 三条；`sandboxClock={start:1_000_000, step:5}`；`coveredSources` 20 条 |
| `snapshots/sandbox-compute/overlay.yml` | 层 4：覆盖 `core:model` 三面脚本 + `bank:tools` 的 `datasetTier: stress` |
| `snapshots/sandbox-compute/snapshot.test.ts` | 与 `headless-basic` 逐字节相同（`cmp` exit 0，4409 bytes） |
| `snapshots/sandbox-compute/{session.jsonl,llm.jsonl,scenario.json}` | 录制产物；已 `git add`（A） |

三面脚本（`overlay.yml`）：

1. `analysis_calc`：`round(data.dining / (data.dining + data.transport) * 100)`，`data={dining:620, transport:180}` → 78；
2. `transfer_create`：`amount:120`，`payee={name:李小雨, phone:'13700003333'}`（stress 档 u-1 无此收款人）；
3. `account_balance`。

`bank:tools` 用 `{demoUserId:'u-1', seed:7, datasetTier:'stress'}`；`safety:sandbox` 保持 `{}`；`interaction:approval` 保持 `{responder:'headless', autoDecision:'allow', autoVerify:true}`。

### 3.2 录制与回放

```text
$ BAH_SNAPSHOT_RECORD=1 npx vitest run --config vitest.snapshot.config.ts snapshots/sandbox-compute/snapshot.test.ts
 ✓ snapshots/sandbox-compute/snapshot.test.ts (4 tests) 1032ms
EXIT=0
```

回放（全量快照面，含老场景）：

```text
$ pnpm test:snapshot    # 12:07:23（清空 sessions/saga.sqlite 后）
 Test Files  4 passed (4)
      Tests  14 passed (14)

$ pnpm test:snapshot    # 12:07:31（不清空，接着跑）
 Test Files  4 passed (4)
      Tests  14 passed (14)

$ pnpm test:snapshot    # 12:07:36（第三次）
 Test Files  4 passed (4)
      Tests  14 passed (14)
```

清空/不清空的残留探针结果一致；没有发现场景间状态泄漏。`fileParallelism:false` 未改。

### 3.3 事件级证据（`session.jsonl` 原文）

```text
# seq 12
{"seq":12,"at":1700000000000,...,"type":"sandbox/done","data":{"tool":"analysis_calc","handler":"compute","tier":"compute-bounded","elapsedMs":5},"ignorable":true}

# seq 13
{"seq":13,...,"type":"read/analysis","data":{"result":{"code":"round(data.dining / (data.dining + data.transport) * 100)","value":78,"operations":8,"elapsedMs":0}},"ignorable":true}

# seq 34–41（红级转账）
{"seq":34,...,"type":"tier/decided","data":{"callId":"call-2","name":"transfer_create","level":"red","reason":"new-payee","verdict":"ask","at":1700000000000},...}
{"seq":35,...,"type":"approval/asked","data":{"ticketId":"ticket:call-2","callId":"call-2","name":"transfer_create","amount":120,"challenge":"sms"}}
{"seq":36,...,"type":"ticket/issued","data":{"ticketId":"ticket:call-2","amountCents":12000,...}}
{"seq":37,...,"type":"approval/challenge-issued","data":{"challengeId":"vc-1","channel":"sms",...}}
{"seq":38,...,"type":"verify/sms","data":{"result":{"channel":"sms","challengeId":"vc-1","success":true,"attempts":1,"remainingAttempts":2}}}
{"seq":40,...,"type":"approval/decided","data":{"ticketId":"ticket:call-2","decision":"allowed-once"}}
{"seq":41,...,"type":"transfer/created","data":{"result":{"txnId":"t-new-301","amountCents":12000,"payeeName":"李小雨","balanceCents":788000,"dailyUsedCents":12000,"dailyLimitCents":1000000,...}}}
```

### 3.4 装配级证据（`forge`）

`scenario.json` 的 `bank:tools` 行：

```json
{ "id": "bank:tools", "use": "bank:tools", "config": { "demoUserId": "u-1", "seed": 7, "datasetTier": "stress" } }
```

`buildBankDataset` 在 boot 期执行（`bank-tools.ts:108-112`；`forge/index.ts:88-99` 按 tier 分派）。stress 档 u-1 的当前账户尾号是 `0001`、初始余额 `800000` 分；场景最后 `read/balance` 返回 `tail:"0001"`、`balanceCents:788000`（转账 12000 分后），与 seeded 造数一致。demo 档 u-1 的当前账户尾号是 `1234`，可排除误用 demo 分支。

### 3.5 声明边界（如实登记）

- `packages/bank/src/verify/`：`issue` / `verify` 真执行（事件 seq 37–40）；但 `port.ts` 的 `catch` 分支**未背书**——缺省 provider `successAfter=1` 首次成功，不抛错。要覆盖 catch 需换失败替身，属另一条单。
- `packages/safety/src/sandbox-runtime/`：`compute-bounded` 走 `runInWorker`（`runner.ts:128-132`），`language.ts` 求值出 78；`worker.ts` 被 Node 以 type-stripping 加载。`sandbox/done` 的 `tier=compute-bounded` 排除了进程内 `none` 回落。
- `packages/bank/src/forge/`：只跑 `stress` 分支；`demo` / `adversarial` 分支不在本场景。声明粒度是目录，不声称三个分支都跑过。

## 4. `coveredSources` 定稿

`snapshots/sandbox-compute/scenario.json` 的 20 条（与 `scenario.ts` 的 `CASE.coveredSources` 一致）：

```text
packages/runtime/src/agent-loop/
packages/runtime/src/session/
packages/runtime/src/system-prompt/
packages/runtime/src/tools/
packages/runtime/src/seams.ts
packages/llm/src/llm/
packages/llm/src/mock/
packages/bank/src/core/
packages/bank/src/tools/
packages/host/src/boot/
packages/persistence/src/jsonl/
packages/persistence/src/saga-store/
packages/safety/src/sentry/
packages/interaction/src/approval/
packages/saga/src/recovery/
packages/saga/src/index.ts
packages/saga/src/tick/
packages/safety/src/sandbox-runtime/   ← 本单新增（事件级）
packages/bank/src/forge/               ← 本单新增（装配级）
packages/bank/src/verify/              ← 本单新增（事件级；catch 未背书）
```

前 17 条是 `headless-basic` 清单的超集（含 `packages/host/src/boot/`）。新增三条的依据：

| 目录 | 级 | 依据 |
|---|---|---|
| `safety/src/sandbox-runtime/` | 事件级 | `sandbox/done`（tier compute-bounded，elapsedMs 5）+ `read/analysis.value=78` |
| `bank/src/verify/` | 事件级 | `approval/challenge-issued`（seq 37）、`verify/sms`（seq 38）、`approval/decided`（seq 40） |
| `bank/src/forge/` | 装配级 | `scenario.json` 的 `bank:tools` 行 + `read/balance` 的 `tail=0001` / `788000` 与 stress 造数一致 |

`packages/safety/src/sandbox-policy/` 也实际执行（policy.resolve），但按施工单 §3.3「新增且只新增」三条，未声明；它是 C3 的既有盲区，登记给下一轮。

## 5. 出口标准实测

| 项 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 门禁 | 全绿、未设 `BAH_ALLOW_NO_SNAPSHOT` | `pnpm gate`：23 项，`EXIT=0`；`snapshot-fresh` note：已重录 `sandbox-compute`、`web-channel` | ✅ |
| 快照面 | 老 10 例 + 新 4 例全绿，连跑 3 次稳定 | 4 文件 / 14 passed × 3（12:07:23 / :31 / :36）；清空/不清空 sqlite 结果一致 | ✅ |
| 单测 | ≥ 基线 + 新增用例数，0 skipped 增加 | 基线 143/1266；收工 144/1272（含本单 T4 +1；其余来自工作树既有改动） | ✅ |
| 类型 | 0 | `pnpm typecheck` `EXIT=0` | ✅ |
| Lint | 0 | `pnpm lint` `EXIT=0` | ✅ |
| 构建 | 0 | `pnpm build` `EXIT=0` | ✅ |
| 覆盖率 | 0 ERROR | **未达成**：即使保留 forge 豁免也红在 5 条**开工前已暂存的不可达 `assertNever` 行**（见 §7）；本单新增的 `sandbox.ts:90` 被 T4 覆盖，未新增未覆盖行 | ❌（非本单引入） |
| 老场景字节 | 与 HEAD/暂存一致 | `git diff --stat HEAD -- snapshots/headless-basic` 空；`git diff --stat -- snapshots/web-channel` 空 | ✅ |
| 负控 1 | 撤注入 → T4 必红 | `expected 71 to be 4096`，EXIT=1；恢复后 5/5 绿 | ✅ |
| 负控 2 | 删 `sandbox-runtime/` → gate 红 | EXIT=1，3 个 sandbox-runtime 文件报「没有快照场景声明」 | ✅ |
| 负控 3 | 挪 `scenario.json` → gate 红 | EXIT=1，5 个文件全部报「没有快照场景声明」 | ✅ |
| 负控 4 | 改名场景目录 → gate 红 | EXIT=1，5 个文件报「由场景 `_off-sandbox-compute` 覆盖，但本次没有重录」 | ✅ |

> **取数时间说明（如实）**：上表门禁的 23/23 在 **12:08** 与 **12:13:42** 两次取到。
> 12:13 中途曾因并发出现的**未跟踪** `packages/persistence/src/chain/audit-report.ts` 与
> `packages/persistence/src/chain/audit-report.test.ts`（不是本单文件，未动）出现
> `snapshot-fresh` / `tracked-sources` 2 红；该文件随后由另一会话入库，最终复跑恢复 23/23。

## 6. 负控输出摘要

| # | 操作 | 结果 | 恢复后 |
|---|---|---|---|
| 1 | 删 `sandbox.ts` 的 `now: run.sandboxNow ?? run.now` | T4 红：真墙钟 71 ≠ 4096 | 5/5 绿 |
| 2 | 从 `scenario.json` 删 `packages/safety/src/sandbox-runtime/` | `snapshot-fresh` 红，3 文件无声明 | `cp` 回备份，`git diff` 空 |
| 3 | `mv scenario.json scenario.json.bak` | `snapshot-fresh` 红，5 文件无声明 | `mv` 回，`git status` = `A` |
| 4 | `mv sandbox-compute _off-sandbox-compute` | `snapshot-fresh` 红，5 文件「覆盖但未重录」 | `mv` 回，6 个文件仍 `A` |

负控 4 的一个附带发现：`loadCases` 按**目录名**扫描任意 `snapshots/*/scenario.json`，所以改名后的 `_off-sandbox-compute` 仍被当作场景读取；它之所以红，是因为 `fresh` 检查按原名 `snapshots/<name>/session.jsonl` 找不到改名后的产物。这与施工单「改名整个目录 → 必须红」的预期一致，但红的原因不是「场景消失」，而是「覆盖了但没重录」。

## 7. 覆盖率债处置

### 7.1 `forge/index.ts` 豁免（C1）

按你的选择加了 stress 场景，但**不能**直接撤豁免。实测：

```text
$ # 临时删掉 vitest.config.ts:65 的 'packages/bank/src/forge/index.ts'
$ npx vitest run --coverage --coverage.reportsDirectory=../temp/coverage-sandbox-20261021 \
    --pool=forks --poolOptions.forks.singleFork=true
ERROR: Coverage for lines (99.09%) ... for packages/bank/src/forge/index.ts
ERROR: ... governance.ts (99.7%) / tier.ts (98.55%) / approval.ts (98.85%) / sandbox.ts (99.21%) / assemble.ts (99.35%)
EXIT=1
```

- `forge/index.ts` 的剩余缺口是 `pick()` 的「候选集不能为空」防御性 throw；stress 场景只覆盖 `buildStress`，触达不到它。施工单 C1 的「stress 场景可直接撤豁免」**不成立**（C-5）。
- 更关键的是：**即使保留 forge 豁免**，同一命令仍红在 5 个文件：

| 文件:行 | 未覆盖行 | 来源 |
|---|---|---|
| `packages/bank/src/tools/governance.ts:383` | `return assertNever(decision, 'governance-decision')` | 开工前已暂存的 assertNever 收尾 |
| `packages/bank/src/tools/tier.ts:94` | `return assertNever(level, 'tool-tier-level')` | 同上 |
| `packages/host/src/boot/plugins/approval.ts:134` | `return assertNever(value, 'approval-auto-decision')` | 同上 |
| `packages/host/src/boot/plugins/sandbox.ts:146` | `return assertNever(outcome, 'sandbox-outcome')` | 同上 |
| `packages/llm/src/llm/assemble.ts:196` | `return assertNever(slot.kind, 'stream-slot')` | 同上 |

这 5 条都是**运行期不可达**的封闭联合收尾；它们被 `assert-never` 门禁要求存在，但与 coverage 的 100% 行阈值天然冲突。本单没有新增未覆盖行：`sandbox.ts:90`（`now: run.sandboxNow ?? run.now`）被 T4 执行。**结论：覆盖率出口项未达成，原因是开工前工作树（同一批 assertNever 改动）已有红，不是本单引入。** 处置建议（下一轮，任选一）：

1. 对 5 条不可达收尾加 `/* v8 ignore next */`（最小、行为不变；需确认团队是否接受 coverage 注解）；
2. 为每个 `assertNever` 收尾补一条「强转非法值」的防御性单测（能真执行 throw，但会引入类型强转）；
3. 把不可达收尾从 line coverage 中排除（改覆盖率口径，需单独评审）。

### 7.2 `host/boot` 100% 强制（C2）

`scripts/coverage-allowlist.ts` 对 `package: host, scope: boot/` 强制逐文件 100%。T4 用例走 `ctx.use(sandboxPlugin.plugin, ...)` 真 `apply()` 路径，覆盖了本单新增的 `now` 行；`sandbox.ts` 仍因 §7.1 的 `:146` assertNever 行差 0.79%。这不是本单新增的缺口。

### 7.3 `sandbox-runtime/` 不在 100% 名单（C3）

`coverage-allowlist.ts` 的 safety 条目只有 `sentry/` 与 `sandbox-policy/`；`sandbox-runtime/` 仍无逐文件覆盖强制。本单补的是**快照背书**，不是行覆盖强制。扩容前需先验 worker_threads 执行能否回流覆盖率统计（`worker.ts` 在独立线程），否则只会得到假 0%。

## 8. 盲区台账现状

按施工单 §9.1 的同一脚本重跑（`D:/项目集/微众杯银行ai智能体/temp/blind-ledger2.cjs`，2026-10-21 12:12）：

```text
声明条目：20 个不同 scope
SENSITIVE 源文件：204；无场景声明：63（30.9%）；有声明：141

按二级目录汇总（未被覆盖的文件数）：
  ✗ packages/saga/src/                    28
  ✗ packages/persistence/src/             14
  ✗ packages/runtime/src/                 12
  ✗ packages/llm/src/                     4
  ✗ packages/safety/src/                  4
  ✗ packages/bank/src/                    1
```

对比施工单 11:15 的 81（39.7%）：本单把盲区降到 63，**减少 18 个文件**，不是施工单预估的 5 个——因为 `coveredSources` 的声明粒度是**目录**，`sandbox-runtime/`、`forge/`、`verify/` 下的其他文件也被一并覆盖。这仍然只是 204 个敏感文件里的 18 个；**不能**把本单写成「快照覆盖问题已解决」。下一轮顺序仍建议 `saga/`（28）→ `persistence/`（14）→ `runtime/`（12）；`llm/src/deepseek/` 归入「e2e-only」名单。

## 9. 纠正主线程

| # | 施工单说法 | 实物 | 处置 |
|---|---|---|---|
| C-1 | 注入 `run.now` 会让之后事件 `ts` 整体后移；T4 可用 `fixedClock({step:5})` | `fixedClock.now()` 是常量，`tick()` 才推进；老快照所有 `at` 都等于 `clock.start` | 报告按实物写；T4 用自增 `tick`/4096；独立钟改用 `sandboxNow` |
| C-2 | 复制 `headless-basic`、改 `CASE.name` 与 prompts 即可 | mock 脚本在 `profiles/headless/patch.yml:14`；`web-channel` 用场景内 `overlay.yml` | 新场景加 `overlay.yml` 覆盖 `core:model` + `bank:tools` |
| C-3 | `PROGRESS.md` 现 45 节，接 `## 46.` | 已有 `## 46.`（`PROGRESS.md:1180`（2026-10-29 瘦身后现落 `docs/progress-archive-2026-10-18_28.md` §46）） | 新节用 `## 47.` |
| C-4 | 新建场景的 `session.jsonl`/`llm.jsonl` 天然是「本次变化的产物」 | `git status --porcelain` 对未跟踪目录只报 `snapshots/sandbox-compute/`，不展开文件；不 `git add` 时 `snapshot-fresh` 报「覆盖但未重录」 | 必须先 `git add snapshots/sandbox-compute` 再取门禁数（施工单 T7 已写，但 §1.3 的机制描述不完整） |
| C-5 | stress 档「可直接把 `forge/index.ts` 从 `coverage.exclude` 撤掉」 | 撤掉后 `forge/index.ts` 99.09%（`pick()` 不可达 throw）；且全局另有 5 条 assertNever 未覆盖 | 恢复豁免；把 C1 记为「stress 场景已补，但覆盖率条件仍未满足」 |
| C-6 | T3 一行 `now: run.now` | 你选了独立计数钟；需要 `RunContext.sandboxNow` 可选字段 | 已按选择实现，并在 §2 说明设计偏差 |
| C-7 | 本单只把 81 个盲区里的 5 个变为有背书 | 目录级声明实际覆盖 18 个，盲区 81→63 | 报告按 63 写；不夸大也不低估 |

## 10. 收尾状态

- 已 `git add`：`snapshots/sandbox-compute/**`（6 个文件）、`packages/host/src/boot/boot.ts`、`packages/host/src/boot/plugins/sandbox.ts`（含开工前已暂存的 assertNever 改动）、`packages/host/src/boot/plugins/sandbox.test.ts`、`snapshots/README.md`、`PROGRESS.md`、本报告与施工单。
- 未提交；按用户选择停在可复核态。
- **未触碰**并发出现的 `packages/persistence/src/chain/audit-report.ts` 与 `packages/persistence/src/chain/audit-report.test.ts`（中途曾造成 2 红，随后由另一会话入库，最终 gate 恢复 23/23）。
- 建议的 pathspec 提交命令（仅本单路径，其他 800+ 暂存项不动）：

```text
git add packages/host/src/boot/boot.ts \
  packages/host/src/boot/plugins/sandbox.ts \
  packages/host/src/boot/plugins/sandbox.test.ts \
  snapshots/sandbox-compute snapshots/README.md \
  PROGRESS.md docs/snapshot-sandbox-scenario-report.md docs/snapshot-sandbox-scenario-brief.md
git commit -- \
  packages/host/src/boot/boot.ts \
  packages/host/src/boot/plugins/sandbox.ts \
  packages/host/src/boot/plugins/sandbox.test.ts \
  snapshots/sandbox-compute snapshots/README.md \
  PROGRESS.md docs/snapshot-sandbox-scenario-report.md docs/snapshot-sandbox-scenario-brief.md
```

提交后复证用 `BAH_SNAPSHOT_BASE=3836030 pnpm gate`（开工前 HEAD 是基线锚点，不是放行变量）。
