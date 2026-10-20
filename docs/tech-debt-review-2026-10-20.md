# BAH MonoRepo 底座 · 低可维护性评审报告

> 评审代号：技术债探测器
> 评审范围：仅底座（`packages/*`、`scripts/*`、`apps/*`、`services/rag`）
> 评审日期：2026-10-20
> 评审基线：`614aa0f`（工作区含 `services/rag` 未提交改动）
> 评审方式：静态分析 + 工具实跑（`tsc -b` / `vitest` / `vitest --coverage` / `eslint` 全部实跑取证）
> 评审边界：本次**只评审、不改码**；文中所有示例修复均 ≤10 行示意。

---

## 一、项目概览

BAH（Banking Agent Harness）是一个 **pnpm workspace + TypeScript ESM 的 14 包 monorepo**，源码约 3.66 万行（`packages/`+`scripts/`）、测试约 2.6 万行，对外 3 个 app（`web` 为原生 HTML5 骨架，`desktop`/`im-gateway` 仅有 README 占位）另有一个 Python RAG sidecar（`services/rag`）。技术栈是 Node 22 + TypeScript 5.9（`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`）、Vitest 3（v8 覆盖率）、tsdown 打包、ESLint 9（typescript-eslint 类型感知规则）、GitHub Actions CI。架构上是典型的**内核（`core`）+ 运行时（`runtime`）+ 治理平面（`safety`/`saga`）+ 领域适配（`bank`）** 分层，插件线走 `ctx.effect()`/`ctx.events.on()` 注册式扩展，配套 14 个 `verify-*.ts` 门禁脚本、覆盖率强制名单与快照基线机制。**整体工程化水位明显高于一般"AI 智能体底座"项目的平均水平**，本次发现的问题集中在少数几个真实热点，而非系统性腐化。

---

## 二、维度评分表

> 评分口径：0–10 分，**10 = 可维护性最差**（即"债务越重分越高"）。

| # | 维度 | 得分 | 关键证据 |
|---|------|------|----------|
| 1 | 结构混乱度 | **2.0** | 包级依赖仅 1 处自环（`core`→`core` 为同包相对导入，非真循环）；`packages/saga/src/` 14 个子域目录边界清晰 |
| 2 | 重复度 | **4.5** | 跨文件重复 6 行块 **26 组**；`errorCodeOf`/`reasonOf` 在 5 个包各写一份（`governance.ts:467`、`pipeline.ts:467`、`port.ts:134`、`route.ts:138`、`runner.ts:297`） |
| 3 | 函数/文件规模 | **3.0** | 超 80 行函数仅 **7 个**；超大文件仅 1 个（`saga-store/index.ts` 795 行）；cc>15 函数 18 个；`provideBankGovernance` 175 行/cc29 |
| 4 | 命名与可读性 | **1.5** | 命名语义达意（`fail-loud`/`reasonOf`/`assertNever`）；魔法数字集中在 `forge/` 造数（`bank/src/forge/index.ts:139` `30 * DAY_MS`）；单字母变量仅 2 处 |
| 5 | 耦合与依赖 | **4.0** | 模块级可变状态 8 处（`saga/src/alert/index.ts:201` `const sinks = new Set()`、`tick/registry.ts:14` `const jobs = new Map()`）；`bank/src/tools/testing.ts:23` 在 src 内 import devDependency `@bah/runtime` |
| 6 | 错误处理 | **1.5** | 全仓统一 `BahError`（`util/src/util/errors.ts:20`）+ kebab-case 理由码；`catch` 块 100% 有注释说明降级理由；仅 2 处空 catch 且均带理由注释 |
| 7 | 测试覆盖 | **5.5** | 132 文件 / 1159 用例全绿（实跑 5.97s）；但**覆盖率门禁当前是红的**：8 个文件未达阈值（详见下文 D7） |
| 8 | 安全与规范 | **2.0** | 无 `eval`/`new Function`/`child_process`；无硬编码密钥（走 `process.env[config.apiKeyEnv]`）；SQL 全参数化（`saga-store/index.ts:241` `WHERE saga_id = ?`）；但 `eslint.config.mjs:22` 只覆盖 `packages/*/src`，`scripts/` 未纳入 |
| 9 | 可维护性债 | **1.0** | `TODO/FIXME/HACK` 密度 **0**（全仓 grep 命中 0 条）；无死代码块（`channels` 空壳包 35 行全为占位 `export {}`，属已知规划） |
| 10 | 构建与工程化 | **2.5** | CI 完整（`.github/workflows/ci.yml`，10 步门禁含最小用例数断言 + 快照基线）；但 `eslint.config.mjs:5` 注释写"全部为 `warn`"而实际三条规则均为 `'error'`（注释与实现不符） |

### 各维度逐项说明

**D1 结构混乱度 — 2.0**
包级依赖图实测 46 条边、**零真循环**（唯一命中的 `core → core` 是同包内 `./api.ts` 相对导入，非跨包回边）。`saga` 拆 14 个子域（`compensation`/`gates`/`recon`/`replay`/`janitor`…），`runtime` 拆 12 个，`persistence` 拆 14 个——边界按"一个目录一个变更理由"切分，可维护性良好。
扣分项：`packages/channels/src/` 四个子目录（`desktop`/`im`/`mobile`/`web`）全是 7 行 `export {}` 占位，虽有注释标注"施工单 13/14/15"，但当前对构建产物是零信息量。

**D2 重复度 — 4.5**
最实质的问题是**错误归一化工具函数被复制了 5 份**，且语义已漂移（这是真实债，不是风格）：

```ts
// packages/bank/src/tools/governance.ts:467
function errorCodeOf(error: unknown): string {
  return error instanceof BahError ? error.code : 'tool-failed'
}
// packages/bank/src/verify/port.ts:134  ← 同一函数名，兜底码却是 'verify-failed'
// packages/safety/src/sandbox-runtime/runner.ts:297  ← 第三种实现，鸭子类型取 code
```
三份实现兜底码不同（`tool-failed` / `verify-failed` / 鸭子类型），调用方无法统一判别。第二类是**类型契约重复**：`packages/persistence/src/saga-store/types.ts`（210 行）与 `packages/saga/src/types.ts`（308 行）重叠 68 个 6 行块——`SideEffectClass`、`CompKind` 等 Saga 领域联合类型在两个包各定义一份，持久层与领域层存在"同名不同源"的结构性风险。第三类是工具注册样板（`bank/src/tools/queries.ts` / `transfers.ts` / `verification.ts` / `wealth.ts` 四文件共享 `name/description/schema/tier/execute` 6 行骨架）。

**D3 函数/文件规模 — 3.0**
静态扫描（brace-depth 配平 + 分支关键字计数）结果：全仓仅 **7 个**函数超 80 行、**18 个**函数 cc>15，最大文件 `packages/persistence/src/saga-store/index.ts` 795 行（未破 800 阈值）。这在 3.6 万行规模下属优秀水平。
扣分项集中在 3 处：

| 位置 | 行数 | cc | 性质 |
|------|------|----|------|
| `packages/bank/src/tools/governance.ts:121` `provideBankGovernance` | 175 | 29 | 4 段 `ctx.effect` 事件桥接 + 2 段审批流 + 账本降级混在一个函数 |
| `packages/persistence/src/chain/index.ts:129` `createSagaAudit` | 128 | 35 | 审计链写入 + 哈希 + 引用解析交织 |
| `packages/cli/src/cli/run.ts:199` `parseArgs` | 89 | 30 | 命令行解析（30 个分支） |

**D4 命名与可读性 — 1.5**
命名达意程度高：理由码统一 kebab-case（`inject-deadlock`/`ticket-expired`/`no-identity`），领域术语（`CompKind`/`SideEffectClass`/`SagaState`）自洽。注释采用"**为什么**"而非"**是什么**"的写法，例如 `packages/bank/src/tools/governance.ts:225`：
```ts
// 票据过期等：宁可拒绝，也不带着无效票据去执行
```
魔法数字 115 处，主要在 `bank/src/forge/index.ts`（造数数据，如 `:139` `now - 30 * DAY_MS`）——`forge` 是模拟数据生成器，数字即数据，**不算真实债务**。真实可改进项：`packages/bank/src/core/model.ts:20` 已导出 `PAGE_LIMIT_MAX = 100`，但 `packages/bank/src/core/mock.ts:374` 仍直接写 `req.amountCents / 100`（分转元），元/分换算系数在两处各写一次。

**D5 耦合与依赖 — 4.0**
依赖方向健康：`util`（零依赖）← `core` ← 各业务包，`host` 作为最上层装配包反向依赖 9 个包——**无反向依赖违规**。
扣分项有三类：
1. **模块级可变状态**（8 处），其中两处是进程级单例且带可变计数器：
```ts
// packages/saga/src/alert/index.ts:201-206
const sinks = new Set<AlertEventSink>()
let sinkErrors = 0
let chainVerifyErrors = 0
```
2. **测试夹具混入源码树**：`packages/bank/src/tools/testing.ts`（只服务单测、不从包入口导出）import 了 `@bah/runtime`，而 `@bah/runtime` 在 `packages/bank/package.json` 中被声明为 **devDependencies**。`tsc -b` 实跑通过（EXIT=0），但发布面上出现"源码依赖 devDependency"的隐性契约，`packages/knowledge/src/testing.ts` 同类问题。
3. **本地结构类型复制接缝形状**：`packages/bank/src/tools/governance.ts:30` 与 `:48` 自定义了 `PreExecuteLike`/`ApprovalLike`/`ToolResultLike`，注释明确写"避免把 `@bah/runtime` 拖进本包"——这是**有意识的解耦决策**，但代价是接缝形状在两处各维护一份。

**D6 错误处理 — 1.5**
全仓统一 `BahError`（`packages/util/src/util/errors.ts:20`），`code`（kebab-case 理由码）+ `message`（面向开发者）+ `detail`（结构化上下文）三段式，调用方按 `code` 分支而非解析 message 文本。`catch` 块 100% 命中且**全部带降级理由注释**，例如：
```ts
// packages/bank/src/tools/governance.ts:511-513
} catch {
  // 审计出口也失联：放弃记录，但绝不把异常抛回资金路径
}
```
2 处空 catch（`governance.ts:242` 已关闭票据不改写状态、`governance.ts:511` 审计出口失联）均有注释解释，属**有意识的降级而非吞错**——不计入债务。

**D7 测试覆盖 — 5.5（本次最严重维度）**
`vitest run` 实跑：**132 个测试文件 / 1159 用例全通过**，耗时 5.97s，无 skip。覆盖率机制设计相当讲究：`scripts/coverage-allowlist.ts` 显式登记 11 个包/27 条强制 100% 名单，并配 `scripts/verify-coverage-allowlist.ts` 校验名单合理性；`scripts/barrel-excludes.ts` 逐条登记纯 barrel 白名单，注释明确指出"旧配置用 `**/index.ts` 全局排除，把实现文件也一起排除了……覆盖率因此长期假绿"——**这是一个已经识别并修复过的假绿问题**。
但 `vitest run --coverage` 实跑**门禁当前为红**，8 个文件未达阈值：

```
ERROR: Coverage for lines (99.39%) ... for packages/bank/src/forge/index.ts
ERROR: Coverage for functions (81.25%) ... for packages/cli/src/cli/run.ts
ERROR: Coverage for functions (80%) ... for packages/host/src/boot/plugins/persistence.ts
ERROR: Coverage for branches (71.42%) ... for packages/host/src/boot/plugins/saga-store.ts
ERROR: Coverage for functions (91.66%) ... for packages/llm/src/deepseek/adapter.ts
ERROR: Coverage for functions (92.3%) ... for packages/safety/src/sandbox-policy/policy.ts
ERROR: Coverage for functions (0%) ... for packages/saga/src/alert/sink.ts
ERROR: Coverage for branches (71.42%) ... for packages/saga/src/coordinator/commit.ts
ERROR: Coverage for lines (78.78%) ... for packages/saga/src/state-machine/index.ts
```
根因是 `a182cc7 test: make coverage/gates/CI real` 把覆盖率做实后，**名单扩容快于测试补充**。典型：
```ts
// packages/saga/src/alert/sink.ts:18 —— 被列入 100% 名单，但函数覆盖率 0%
export const noopAlertSink: AlertSink = () => {}
```
空函数体在 v8 下计为"未覆盖函数"，而 `scripts/coverage-allowlist.ts:139` 把它登记为强制 100% 对象。
`packages/saga/src/state-machine/index.ts:55-61`（CAS 冲突抛错分支）行覆盖 78.78%，是真实的**未测分支**。
另：`packages/host/src/boot/plugins/saga.ts` 被显式排除在覆盖率外，`vitest.config.ts:56-60` 注释写明"先排除以保持门禁可运行，待 saga 线补一条 tick 触发用例后移除"——**这是一张明确的欠账票据**。

**D8 安全与规范 — 2.0**
全仓无 `eval`/`new Function`/`child_process`/`execSync`/`spawn`（grep 零命中）。无硬编码密钥/令牌；`packages/llm/src/deepseek/adapter.ts:281` 签名默认 `env: Record<string, string|undefined> = process.env` 且可注入，测试友好。SQLite 全部参数化查询（`packages/persistence/src/saga-store/index.ts:241` `WHERE saga_id = ?`），无字符串拼接。`packages/host/src/boot/plugins/model.ts:155` 走 `process.env[config.apiKeyEnv ?? 'DEEPSEEK_API_KEY']`，环境变量名本身是配置项。
扣分项：`eslint.config.mjs:22` `files: ['packages/*/src/**/*.ts']`——`scripts/`（25 个文件，含 14 个门禁脚本）与 `apps/` 不在 lint 覆盖范围，而门禁脚本恰恰是"防退化"的最后一道防线。

**D9 可维护性债 — 1.0**
`TODO|FIXME|HACK|XXX` 全仓 grep **命中 0 条**（唯一 4 处命中均为中文正常词，如"临时变量"）。无死代码块、无废弃 API。`packages/saga/src/alert/index.ts:17` 有一处 `import type { AlertSink as LegacyAlertSink }` 别名导入——是唯一带"legacy"意味的痕迹，但已核实 `AlertSink` 仍被 `packages/saga/src/index.ts:20` 正常导出使用，不构成废弃。

**D10 构建与工程化 — 2.5**
CI 质量高：`.github/workflows/ci.yml` 从干净 clone 跑全链，Node 固定 22.19.0、pnpm 固定 10.34.7、Python 固定 3.11、`--frozen-lockfile` 安装；`scripts/ci.ts:62-79` 定义 10 步门禁（typecheck → lint → build → unit → coverage → gate → e2e → snapshot → web → rag），每步带**最小用例数断言**（unit 1100 / coverage 1100 / snapshot 6 / web 2 / rag 65）与 **0 skip 断言**（`ci.ts:195`），删测试即红。
扣分项：
1. `eslint.config.mjs:5-8` 注释与实现矛盾——注释写"先只开三条…全部为 `warn`…清债完成后把 `warn` 升为 `error`"，但 `:32-34` 三条规则**已全部是 `'error'`**。这是**过期注释**，属真实债（会误导后续维护者以为 lint 是软约束）。
2. `packages/bank/package.json` 把 `@bah/runtime` 放 devDependencies，但 `packages/bank/src/tools/testing.ts:23` 在 src 内 import 它——依赖声明与实际用法不一致。
3. 根目录 8 个 `.tmp-*.log` 文件（约 57KB）虽已被 `.gitignore` 覆盖（`.tmp-*`），但物理残留说明本地门禁日志无统一落盘目录。

---

## 三、低可维护性指数与结论

**加权公式**（结构/耦合/可维护性 ×1.5，其余 ×1.0）：

```
指数 = (2.0×1.5 + 4.5 + 3.0 + 1.5 + 4.0×1.5 + 1.5 + 5.5 + 2.0 + 1.0×1.5 + 2.5) / (1.5+1+1+1+1.5+1+1+1+1.5+1)
     = (3.0 + 4.5 + 3.0 + 1.5 + 6.0 + 1.5 + 5.5 + 2.0 + 1.5 + 2.5) / 11.5
     = 31.0 / 11.5
     = 2.70
```

### **低可维护性指数 = 2.70 / 10**

**结论：底座处于「良好但有一处真实红灯」的状态。**

- 2.70 分意味着**八成的可维护性维度都在健康区**（≤4 分），架构分层、依赖方向、错误结构、测试机制、CI 门禁均达到可交付水位。
- **唯一的真红灯在 D7（5.5 分）**：覆盖率门禁当前实跑为红，且 `a182cc7` 引入的机制本身没有 bug——是**名单扩容与测试补充的节奏错配**。这是"债在账上、但可在一周内还清"的状态，不是结构性问题。
- 与 3.6 万行 / 14 包的规模相比，**D2 重复度（4.5）与 D5 耦合（4.0）是唯二需要动手的维度**，且两者根因同源：Saga 领域契约（类型 + 错误归一化）在"领域层"与"持久层"各存一份。

**风格偏好（单列，不计入主分）**：全仓使用中文注释与中文标识符文档、`'single quote'` + 无分号风格、`let p`/`let n` 单字母变量（仅 `bank/src/forge/index.ts:222,241` 两处，且在造数循环内语义清晰）——**这些是团队既定风格，不构成债务，不建议改动**。

---

## 四、Top 10 问题清单

> 排序口径：**影响面 × 修复成本**（性价比优先，不按严重度排序）。

| # | 问题 | 证据 | 影响面 | 修复成本 | 性价比 |
|---|------|------|--------|----------|--------|
| 1 | **覆盖率门禁当前为红**：8 个文件未达阈值，`pnpm test:coverage` 必然失败 | `vitest --coverage` 实跑 9 条 ERROR；`saga/src/alert/sink.ts:18`、`saga/src/state-machine/index.ts:55-61` | 高（阻断 CI 合并） | 低（补 8 处测试） | ★★★★★ |
| 2 | **`errorCodeOf`/`reasonOf` 等 5 份重复实现且兜底码语义漂移** | `bank/src/tools/governance.ts:467`、`bank/src/verify/port.ts:134`、`runtime/src/tools/pipeline.ts:467`、`llm/src/llm/route.ts:138`、`safety/src/sandbox-runtime/runner.ts:297` | 中高（跨 5 包判别口径不一） | 低（提 `@bah/util` 1 个函数） | ★★★★★ |
| 3 | **Saga 领域类型双份定义**：`saga/src/types.ts`(308行) 与 `persistence/src/saga-store/types.ts`(210行) 重叠 68 块 | diff 显示 68 个 6 行块重复；`SideEffectClass`/`CompKind` 两处定义 | 中高（领域层改一处，持久层漏改） | 中（需定"谁是真源"） | ★★★★☆ |
| 4 | **测试夹具混入发布源码树**：`bank/src/tools/testing.ts` 在 src 内且 import devDependency | `packages/bank/src/tools/testing.ts:23` import `@bah/runtime`；`packages/bank/package.json` 将其列为 devDependencies | 中（发布面污染 + 依赖声明不一致） | 中（需调整包边界或依赖声明） | ★★★★☆ |
| 5 | **`provideBankGovernance` 175 行 / cc29**：4 类事件桥接 + 审批流 + 账本降级混在一个函数 | `packages/bank/src/tools/governance.ts:121-295` | 中高（资金治理核心，改动风险大） | 中高（需拆 4 段） | ★★★☆☆ |
| 6 | **`packages/host/src/boot/plugins/saga.ts` 被排除在覆盖率外**——一张已写明的欠账票据 | `vitest.config.ts:56-60` 注释"待 saga 线补一条 tick 触发用例后移除" | 中（启动恢复接线无覆盖） | 低（补 1 条 tick 用例） | ★★★★☆ |
| 7 | **进程级可变单例 + 计数器**：`alert` 的 `sinks`/`sinkErrors`/`chainVerifyErrors`；`tick` 的 `jobs` Map | `packages/saga/src/alert/index.ts:201-206`、`packages/saga/src/tick/registry.ts:14` | 中（测试间状态串扰风险） | 中（需改为 ctx 作用域） | ★★★☆☆ |
| 8 | **`eslint.config.mjs` 注释与实现矛盾**：注释称规则为 `warn` 待升级，实际已全为 `error` | `eslint.config.mjs:5-8` vs `:32-34` | 低中（误导维护者） | 极低（改 4 行注释） | ★★★★☆ |
| 9 | **`scripts/` 25 个文件（含 14 个门禁脚本）不在 ESLint 覆盖范围** | `eslint.config.mjs:22` 仅 `packages/*/src/**/*.ts` | 中（门禁脚本本身可能腐化） | 低（加一行 files glob） | ★★★☆☆ |
| 10 | **`createSagaAudit` 128 行 / cc35** + `parseArgs` 89 行 / cc30 | `packages/persistence/src/chain/index.ts:129`、`packages/cli/src/cli/run.ts:199` | 中 | 中 | ★★★☆☆ |

> **未进 Top 10 但已记录**：`channels` 空壳包（35 行占位，规划内，不建议现在动）；根目录 8 个 `.tmp-*.log` 残留（已被 gitignore，零成本清理）；`bank/src/core/mock.ts:374` 硬编码 `/100` 分转元（应复用 `model.ts` 常量）。

---

## 五、整改路线图（P0/P1/P2）

### P0 — 1 周内（只做"让门禁恢复真绿 + 消除误导"，零架构改动）

| 动作 | 具体步骤 | 验收标准 |
|------|----------|----------|
| **P0-1 补齐 8 处覆盖率缺口** | ① `saga/src/alert/sink.ts`：给 `noopAlertSink` 加 1 条调用断言（覆盖率名单要求 100% 函数覆盖，空箭头函数体需被调用）② `saga/src/state-machine/index.ts:55-61`：补 1 条 CAS 冲突抛 `version-conflict` 的用例 ③ `saga/src/coordinator/commit.ts:34-37` + `host/src/boot/plugins/saga-store.ts`：各补 1 条分支用例 ④ `bank/src/forge/index.ts`、`cli/src/cli/run.ts`、`host/src/boot/plugins/persistence.ts`、`llm/src/deepseek/adapter.ts`、`safety/src/sandbox-policy/policy.ts`：按未覆盖函数补最小断言 | `npx vitest run --coverage` 退出码 0，9 条 ERROR 全部消除；`pnpm check` 全绿 |
| **P0-2 移除 `saga.ts` 覆盖率排除** | 在 `packages/host/src/boot/plugins/saga.ts` 补 1 条 tick 触发用例后，删除 `vitest.config.ts:56-60` 的 exclude 条目 | `vitest.config.ts` 中不再出现 `plugins/saga.ts`；覆盖率名单无"预存缺口"注释 |
| **P0-3 修正 eslint 过期注释** | 把 `eslint.config.mjs:5-8` 改为反映现状：三条规则已为 `error`，已接入 `scripts/ci.ts` | 注释与 `:32-34` 一致；`npx eslint "packages/*/src/**/*.ts"` 仍 EXIT=0 |
| **P0-4 清理临时日志落点** | 根目录 8 个 `.tmp-*.log` 移入 `.ci-artifacts/`（已 gitignore），并确认本地门禁日志统一写入该目录 | 根目录无 `.tmp-*.log`；`.gitignore` 无需改动 |

> **P0 不做的事**：不调低任何阈值、不缩减 allowlist、不删测试、不放宽分支覆盖率。**这四条是本项目防止"覆盖率假绿"的制度设计，动它们等于把债变成暗债。**

### P1 — 1 月内（消除真实重复与隐性契约，不动架构）

| 动作 | 具体步骤 | 验收标准 |
|------|----------|----------|
| **P1-1 收敛错误归一化函数到 `@bah/util`** | 新增 `packages/util/src/util/errors.ts` 的 `errorCodeOf`/`reasonOf`（或统一为现有 `describeThrown` + `codeOf`），5 处调用点改为 import。**注意兜底码差异要显式参数化**（`tool-failed` vs `verify-failed`），不要强行统一为一个码 | 5 处本地实现删除，全仓 `grep "function errorCodeOf\|function reasonOf"` 仅命中 `@bah/util` 1 处；`pnpm check` 全绿 |
| **P1-2 裁定 Saga 类型的唯一真源** | 建议以 `packages/saga/src/types.ts` 为领域真源，`persistence/src/saga-store/types.ts` 改为 `import type { ... } from '@bah/saga'`（persistence 依赖 saga 会形成新边，需先确认无环；若无环则可行，否则反向让 saga 依赖 persistence 的 seam）。**先出裁定文档再动代码** | 两个文件不再重复定义 `SideEffectClass`/`CompKind`；`tsc -b` 通过；包依赖图仍无环（用 `pnpm gate` 中的依赖检查项验证） |
| **P1-3 修正 `bank` 的依赖声明** | 二选一：① 把 `packages/bank/src/tools/testing.ts` 移出 src（迁至 `packages/test-support/` 或改为 `*.test-helper.ts` 并从构建排除）；② 若保留现状，把 `@bah/runtime` 从 devDependencies 移入 dependencies。**推荐 ①** | `packages/bank/package.json` 的 deps/devDeps 与实际 import 严格一致；`pnpm build` 产物不含测试夹具 |
| **P1-4 把 `scripts/` 纳入 ESLint** | `eslint.config.mjs:22` 的 files 改为 `['packages/*/src/**/*.ts', 'scripts/**/*.ts']`，`apps/web` 的 `.js` 视需要单列 | 14 个门禁脚本进入 lint 覆盖；`npx eslint "packages/*/src/**/*.ts" "scripts/**/*.ts"` EXIT=0 |
| **P1-5 拆分 `provideBankGovernance`** | 按现有 ①②③④ 四段注释边界拆为 4 个私有函数（`bridgePreExecute` / `bridgeApproval` / `bridgePostExecute` / `bridgeLedger`），外部签名与行为**完全不变** | `governance.ts` 中 `provideBankGovernance` ≤ 40 行；`packages/bank/src/tools/governance.ts` 仍在覆盖率 100% 名单内且覆盖率不降；`governance.test.ts` + `governance-cases.test.ts` 全绿 |

### P2 — 季度内（结构性改善，需独立排期与快照验证）

| 动作 | 具体步骤 | 验收标准 |
|------|----------|----------|
| **P2-1 消除 `saga` 的进程级可变单例** | `alert` 的 `sinks` 与计数器、`tick` 的 `jobs` Map 改为 `Context` 作用域（参照既有 `tick/registry.ts:17` 的 `WeakMap<Context, Map<...>>` 模式，已有现成范式） | `grep "^const sinks\|^let sinkErrors\|^const jobs"` 在 `packages/saga/src` 命中 0；saga 全量测试无偶发失败 |
| **P2-2 补齐 `createSagaAudit` / `parseArgs` 的复杂度** | `chain/index.ts:129` 拆分哈希计算与引用解析；`cli/run.ts:199` 改用查表/子解析器拆分 | 两处 cc ≤ 15；各自新增针对性测试 |
| **P2-3 覆盖率名单扩容至全域 + 分支阈值提升** | 现有分支阈值 80%，`vitest.config.ts:70` 注释已写"清债后升 95/100"——在 P0/P1 完成后按包分批扩容 allowlist（`channels`/`util`/`test-support` 尚未进名单），并把分支阈值逐步提到 95 | 名单覆盖 14/14 包；分支阈值 ≥95% 且门禁全绿 |
| **P2-4 补 `apps/web` 与 `services/rag` 的工程化收口** | `apps/web` 目前仅 1 个 `main.js`（10 行）+ `index.html`；`services/rag` 是 Python 独立栈（有 pytest + JUnit 报告接入 `ci.ts:231`）。**在施工单 13/14/15 落地前不做实质动作**，仅确保纳入 lint/format 统一策略 | `apps/web` 进入 lint 覆盖；RAG 侧与 TS 侧门禁口径在文档中对齐 |

---

## 六、风险与不建议改动项

> **过度重构是这个项目当前最大的风险**——因为它看起来"哪里都挺整齐"，很容易诱发"再整理一下"的冲动。以下是明确的禁区。

### ❌ 不建议现在动

| 事项 | 原因 |
|------|------|
| **拆分 `packages/saga`（14 个子目录、1.1 万行）** | 已按"一个目录一个变更理由"切分，包级依赖零循环。saga 是业务复杂度最高的域，**当前结构不是复杂度来源，领域本身才是**。此时拆包只会制造大量移动 diff，掩盖真实变更。 |
| **重构 `AgentLoop` 主循环（`runtime/src/agent-loop/agent.ts` 791 行）** | `AGENTS.md` 明确"改主循环 = 破坏性变更：必须同步更新架构文档并跑全量快照"。当前 791 行是 **20 个私有方法的类**，每个方法职责单一（`step`/`turn`/`runToolCalls`/`runParallelBatch`/`prepareCall`/`pipeline`…），已是合理粒度。文件行数高≠不可维护。 |
| **清理 `packages/channels/` 空壳包** | 4 个子目录虽为空，但**是施工单 13/14/15 的施工锚点**，删掉会导致后续实现时重新规划目录。空壳 + 明确注释 = 有意的占位，不是死代码。 |
| **为 `provideBankGovernance` 做"彻底解耦"** | 它是资金治理的核心判决点，4 段 `ctx.effect` 桥接是**有意的事件编排**（AGENTS.md"注册即可逆"纪律的体现）。P1-5 的"纯函数拆分、签名不变"已足够；进一步抽象出独立治理框架属于过度设计。 |
| **调整 `apps/web` 技术栈（引入 Vue/React）** | `apps/web/package.json` 注释已定决策 D3："纯原生 HTML5 + CSS3 + JavaScript，Vite 仅作 dev server / 打包器"。改技术栈是产品决策，不是技术债修复。 |
| **统一"中文注释"为英文** | 全仓 12 份 `docs/*.md` + 中文注释是团队既定规范，`AGENTS.md` 与各文件头部注释均以中文书写决策依据。语言风格不计入可维护性分数。 |
| **收敛 `saga` 的 `alert`/`tick` 单例（若 P2 排期未到）** | 现有 `WeakMap<Context, ...>` 已提供隔离范式，`registerAlertSink`/`registerTickJob` 返回 disposer 符合"注册即可逆"。**风险低于收益**，可推迟到 P2 窗口。 |
| **扩大 `channels`/`util`/`test-support` 的覆盖率名单（早于 P2-3）** | 这三个包目前分别是空壳包、零依赖原语包、测试支撑包——进名单会立刻产生大量红灯，挤占 P0 的信任预算。 |

### ⚠️ 风险提示

1. **覆盖率阈值一旦下调，制度即失效**。本项目历史上已出现过"用 `**/index.ts` 全局排除导致长期假绿"的问题（见 `scripts/barrel-excludes.ts:8-11` 注释），并在 `a182cc7` 修复。当前 8 个文件的缺口应**用测试补齐，不可用阈值掩盖**——否则第二次假绿将难以发现。
2. **P1-2（Saga 类型裁定）有引入包级环的风险**。`saga` 当前依赖 `persistence`（13 文件），若反向让 `persistence` 依赖 `saga` 会成环。**必须先在纸面验证无环再动手**，且要跑 `pnpm gate` 的依赖检查项。无法确认无环时，备选方案是在 `packages/core` 放一份中立契约类型，由两侧共同引用。
3. **P1-1 收敛错误函数时，别把兜底码差异"顺手统一"**。`tool-failed` 与 `verify-failed` 的差异是**有意的**——调用方按 code 分支来决定是否重试。强行统一为单一码会丢失可判别性。
4. **本次评审未覆盖 `services/rag`（Python）的内部质量**。该目录有 33 个 `.py`、40 个 `.md`，工作区当前有未提交改动（`git status` 显示 8 个 `.py` 被修改 + `auth.py` 未跟踪）。其 pytest 门禁已接入 `ci.ts:231` 且 `minCases: 65`，但**代码级评审不在本次范围**，建议单独立项。

---

## 附：本次评审的取证方式与可复现命令

```bash
# 规模与结构
find packages -name "*.ts" -not -path "*/node_modules/*" -exec wc -l {} + | sort -rn
# 依赖图与循环检测
#   解析各 package.json 的 name，扫描 from/import 构造包级有向图，找回边
# 函数规模与圈复杂度
#   brace-depth 配平求函数边界；cc ≈ 1 + 分支关键字 + && || + 三元 + ??
# 实跑验证（全部在本次评审中执行）
npx tsc -b                                    # EXIT=0
npx vitest run                                # 132 files / 1159 tests passed, 5.97s
npx vitest run --coverage                     # 9 条阈值 ERROR（门禁为红）
npx eslint "packages/*/src/**/*.ts"           # EXIT=0
# 债务标记
grep -rn "TODO\|FIXME\|HACK\|XXX" packages/*/src --include="*.ts" | grep -v test   # 0 条
```

> **说明**：`vitest --coverage` 在本机受沙箱删除保护限制（无法清空旧 `coverage/` 目录），故改用 `--coverage.reportsDirectory=.ci-artifacts/cov-verify` 完成实跑，阈值判定结果与默认配置一致。
