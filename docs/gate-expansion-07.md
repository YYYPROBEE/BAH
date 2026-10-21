# 施工单：新增 7 项门禁

> 施工单代号：门禁扩容 07
> 起草日期：2026-10-21
> 基线：`pnpm gate` 现有 16 项全绿
> 适用范围：`scripts/verify-*.ts`（门禁面）+ 少量 `packages/**/src` 修正
> 依据：`AGENTS.md` 编码纪律、`docs/tech-debt-review-2026-10-20.md`、`PROGRESS.md` 偏差登记

---

## §0 复审结论（起草前的实测，与既有文档不符处已登记）

本单所有结论都经过实跑取证，**其中两条与既有文档冲突，偏差登记在 §6**。

| # | 实测项 | 结果 |
|---|--------|------|
| A | `packages/bank/package.json` 的 `devDependencies` 含 `@bah/runtime` | 属实。`src/tools/testing.ts` 生产源码 import 它 |
| B | `@bah/knowledge` 同类问题 | **不属实**。`knowledge` 的 devDeps 只有 `@bah/test-support`，其 `testing.ts` 未越界 |
| C | 全仓 14 包依赖图 | 46 条边（`dependencies` 口径），零真循环，`@bah/util` 零依赖 |
| D | `errorCodeOf`/`reasonOf` 本地实现 | **5 处确认存在**，与评审一致 |
| E | `docs/*.md` + `AGENTS.md` + `PROGRESS.md` 中的仓库路径引用 | **134 条唯一引用，其中 23 条已失效**（详见 §4） |
| F | 非测试源码 `switch` 收尾情况（TypeScript AST 实测） | **43 处 switch，30 处有 `default` 或 `assertNever`，13 处两者皆无** |
| G | `@bah/host` 导入 `@bah/llm/deepseek`、`@bah/llm/mock` | **不构成违规**。`llm/package.json` 的 `exports` 已声明这两个子路径，门禁须按子路径匹配而非整包名匹配 |

### 复审发现的两处既有文档错误

**R-1：`docs/tech-debt-review-2026-10-20.md` 风险提示 2 的前提不成立。**

评审原文称"`saga` 当前依赖 `persistence`（13 文件），若反向让 `persistence` 依赖 `saga` 会成环"。实测：

- `packages/saga/package.json` 的 `dependencies` 只有 `@bah/core` 与 `@bah/util`；
- `@bah/persistence` 位于 `devDependencies`；
- saga 生产源码对 `@bah/persistence` 的引用**全部位于注释**（`recon/index.ts:6`、`recon/types.ts:8`、`replay/index.ts:8`、`view/index.ts:86` 明确声明"不 import"）；
- 唯一的非测试引用是 `saga/src/coordinator/fixtures/kill-child.ts`——它是被测试 `spawn` 的子进程夹具，属测试设施而非生产装配。

**结论：让 `persistence` 依赖 `saga` 不会成环，P1-2 不必走"中立契约类型"备选方案。** 这降低了 P1-2 的成本，也说明为什么 §3 的包图门禁必须区分 `dependencies` 与 `devDependencies` 两个口径——按整包名一刀切会产生误报。

**R-2：`packages/runtime` 的 `@bah/persistence` 同样是 devDeps。** 评审把"源码依赖 devDependency"的问题只点了 `bank`，实测 `runtime` 也把 `@bah/persistence` 放在 devDependencies。§3 的门禁须按实际越界情况定范围，不限于 bank。

---

## §1 通用约束（7 项全部适用）

1. **形态**：每个门禁一个 `scripts/verify-<name>.ts`，只导出 `gate: { name, run(root) }`，由 `run-gates.ts` 自动发现（正则 `/^verify-[\w-]+\.ts$/`，按文件名排序执行）。不修改 `run-gates.ts`。
2. **可单跑**：文件尾部用 `isMainModule(import.meta.url)` + `runStandalone(gate)`，与现有 16 项一致。
3. **不写 shell**：全部 TypeScript + `tsx` 直跑（`gate-lib.ts` 头部纪律）。
4. **findings 必须可定位**：每条带文件路径，尽量带行号。
5. **AST 优先于词法**：凡是词法能被注释、变量拆分、换行绕过的规则，一律用 TypeScript Compiler API。参照 `verify-event-modes.ts`、`verify-sandbox.ts`。
6. **测试文件默认不构成契约**：`*.test.ts` 不参与扫描（与 `verify-saga-events`、`verify-saga-state` 一致）。例外：§3 明确把夹具纳入。
7. **负控必做**：每个新门禁必须实跑一次"故意注入违规 → 确认变红 → 回滚"。`PROGRESS.md` R20 已把负控定为纪律，本单延续。

---

## §2 门禁清单

### 2-1 `verify-assert-never.ts` — 判别标签 switch 收尾

**纪律来源**：`AGENTS.md` 编码纪律第 6 条"判别标签 switch：封闭联合以 assertNever 收尾"。

**现状**：AST 实测 43 处 `switch`（非测试源码），30 处已有 `default` 或 `assertNever`，**13 处两者皆无**：

```
packages/bank/src/forge/index.ts:93
packages/bank/src/tools/governance.ts:358
packages/bank/src/tools/tier.ts:84
packages/channels/src/web/frames.ts:243
packages/channels/src/web/project.ts:64
packages/channels/src/web/project.ts:79
packages/channels/src/web/project.ts:405
packages/host/src/boot/plugins/approval.ts:125
packages/host/src/boot/plugins/sandbox.ts:127
packages/llm/src/llm/assemble.ts:179
packages/safety/src/sandbox-runtime/language.ts:330
packages/safety/src/sandbox-runtime/runner.ts:252
packages/safety/src/sandbox-runtime/runner.ts:272
```

**规则**：
1. 遍历 `packages/*/src/**/*.ts`（排除 `.test.`）的全部 `SwitchStatement`；
2. `caseBlock.clauses` 必须含 `DefaultClause`，或含以 `assertNever(...)` 为表达式的语句，二者至少其一；
3. 两者皆无 → 违规。

**已知的粒度限制（必须显式登记）**：TypeScript 的 AST 无法可靠区分"封闭联合上的 switch"与"对 `string`/`number` 等开放类型做穷举分支"。本门禁**按"凡 switch 皆须收尾"的严口径执行**——若后续实测某处需要无收尾的穷举，走 `scripts/` 下的显式例外名单 + 理由，不放宽规则。

**例外名单**：新建 `scripts/assert-never-excludes.ts`，结构参照 `scripts/barrel-excludes.ts`（含 `path` + `why` 两个字段）。

**验收**：上述 13 处逐个人工裁定——要么补 `assertNever`，要么进例外名单并写明"为什么这不是封闭联合"。门禁实跑 EXIT=0；人为删掉某处 `assertNever` 后必须变红。

---

### 2-2 `verify-package-graph.ts` — 包依赖零循环 + 方向不反转

**为什么必须做**：`tech-debt-review` 风险提示 2 明确要求"必须先在纸面验证无环再动手，用 `pnpm gate` 中的依赖检查项验证"——**但该检查项至今不存在**。§0 的 R-1 已证明纸面推断会出错（评审误判了 saga→persistence 方向），因此这条门禁是 P1-2 的前置条件，不是可选项。

**规则**：
1. 读 `packages/*/package.json`，构建 `dependencies` 口径的有向图；
2. DFS 检环，报出完整环路（`a → b → c → a`），而非仅"存在环"；
3. **子路径口径**：`@bah/llm/deepseek` 归一化为 `@bah/llm` 后查边（§0 实测 G：`llm/exports` 已声明子路径，属合法导入，不得误报）；
4. **自环豁免**：`@bah/core` 内部对 `@bah/core` 的相对导入不算环（评审 D1 已确认此为唯一自环）；
5. **分层断言**：`@bah/util` 的 `dependencies` 必须为空（零依赖原语包）；
6. **方向断言**：`@bah/{bank,knowledge,llm,persistence,saga,safety,interaction}` 不得依赖 `@bah/{host,cli}`（防止把装配层拖进领域层）。

**双口径只检第一层**：`devDependencies` 不参与检环（§0 R-1：`saga → persistence` 是 devDeps 边，是测试设施，不是运行时耦合）。但 devDeps 的越界另由 2-3 负责。

**验收**：实跑报告 46 条边、零环；人为在任一 `package.json` 加一条回边后必须报出完整环路。

---

### 2-3 `verify-no-dev-dep-in-src.ts` — 生产源码不得 import devDependency

**为什么必须做**：`tech-debt-review` Top 10 第 4 条给了两条修法（移出 src / 改依赖声明），但**没有制度防止第三次发生**。这类问题的本质是"发布面污染"，一次性修复挡不住复发。

**规则**：
1. 扫 `packages/*/src/**/*.ts` 的所有裸包名导入（`from 'xxx'` / `import('xxx')`）；
2. 若 `xxx` 是 `workspace:*` 的 `@bah/*` 包，且该包名出现在所属包的 `devDependencies` 而**不在** `dependencies` → 违规；
3. **子路径归一**：先剥去 `/deepseek`、`/mock` 这类子路径再比对；
4. **夹具白名单**：`packages/saga/src/coordinator/fixtures/**` 是被测试 `spawn` 的子进程夹具（§0 R-1 取证），其对 `@bah/persistence` 的引用合法。需登记在显式例外名单里，理由写"子进程夹具，与生产装配同构但由测试 spawn"。

**当前实况**：修复后应为绿。修复前的越界项见 §3。

**验收**：实跑 EXIT=0；人为把一个 `dependencies` 包挪到 `devDependencies` 后必须变红。

---

### 2-4 `verify-docs-paths.ts` — 文档里的仓库路径必须存在

**为什么必须做**：`verify-tool-catalog.ts` 已对 `docs/tool-catalog.md` 做了逐字比对，但另外 11 份 `docs/*.md` 完全无保护。而本项目的工程取证高度依赖文档里的路径引用——`tech-debt-review` 里大量证据是 `packages/xxx/src/yyy.ts:123` 这种带行号的引用。

**现状（§0 实测 E）**：134 条唯一路径引用，**23 条已失效**：

```
packages/boot                    packages/sandbox
packages/client                  packages/sdk
packages/compaction              packages/session-query
packages/context/agent-instructions  packages/session-title
packages/core/scope              packages/settings
packages/feedback                packages/spill
packages/goal                    packages/storage
packages/guard                   packages/todo
packages/host/.../sentry.test.ts packages/web
packages/identity                snapshots/tsconfig.json
packages/interaction/tool-ask-user
packages/plan/plan-mode
packages/runtime/src/tier/decide.ts
```

**注意**：这 23 条里大部分**不是笔误，而是"规划中的包"**——`migrations`/`todo`/`spill`/`goal` 等正是 `tech-debt-review` D1 提到的"空壳或未实装"能力域，在文档里以规划路径出现是合理的。

**因此本门禁必须分两类处理，不能一刀切**：
- **已实装包的失效引用** = 真 bug，立即修文档（如 `packages/runtime/src/tier/decide.ts` 需核实是改名还是未实装）；
- **规划中包的引用** = 合法的，登记进显式例外名单，理由统一写"规划中包，尚未实装（见 docs/dsh-comparison.md §能力面）"。

**规则**：
1. 抽取 `docs/*.md`、`AGENTS.md`、`PROGRESS.md` 中形如 `` `packages|scripts|services|apps|snapshots|design/...` `` 的反引号路径引用；
2. 剥掉 `:行号` 后缀；
3. 排除含 `...` 的省略写法（`packages/host/.../sentry.test.ts` 无法静态判定）与纯示意路径；
4. 存在性检查；不在例外名单里的失效引用 → 违规。

**验收**：例外名单登记完毕后实跑 EXIT=0；人为删掉一个真实存在的源文件路径后必须变红。

---

### 2-5 `verify-single-error-normalization.ts` — 错误归一化只允许一份实现

**背景**：`errorCodeOf`/`reasonOf` 有 5 份重复实现，是评审性价比最高的债（★★★★★）。

**已确认的 5 处**（§0 实测 D）：

| 位置 | 兜底码 |
|------|--------|
| `packages/bank/src/tools/governance.ts:467` `errorCodeOf` | `tool-failed` |
| `packages/bank/src/tools/governance.ts:472` `reasonOf` | — |
| `packages/bank/src/verify/port.ts:134` `errorCodeOf` | `verify-failed` |
| `packages/llm/src/llm/route.ts:138` `reasonOf` | — |
| `packages/runtime/src/tools/pipeline.ts:467` `errorCodeOf` | — |

**规则**：
1. AST 扫描全部非测试源码的 `FunctionDeclaration` / `VariableStatement`；
2. 函数名 ∈ {`errorCodeOf`, `reasonOf`} 的定义**只允许出现在 `@bah/util` 一处**；
3. 其他包内出现同名定义 → 违规。

**⚠️ 关键约束（必须写进门禁文件头部注释）**：

`tech-debt-review` 风险提示 3 明确指出——`tool-failed` 与 `verify-failed` 的差异是**有意的**，调用方按 code 分支决定是否重试，强行统一会丢失可判别性。

**因此本门禁锁的是"不许重新复制实现"，不是"不许有多个兜底码"。** 收敛后的 `@bah/util` 实现应把兜底码作为显式参数（`errorCodeOf(e, 'verify-failed')`），门禁不得检查"全仓兜底码唯一"。这条写错方向就会把 P1-1 的成果变成新的债。

**前置**：本门禁在 P1-1 收敛完成前会红。**先收敛，再启用门禁**，不要把红灯挂进 `pnpm gate`。

**验收**：收敛后全仓 `function errorCodeOf|function reasonOf` 仅命中 `@bah/util` 1 处；在任一包内重新定义同名函数后必须变红。

---

### 2-6 `verify-single-saga-types.ts` — Saga 领域类型只允许一份真源

**背景**：`saga/src/types.ts`(308 行) 与 `persistence/src/saga-store/types.ts`(210 行) 重叠 68 个 6 行块，`SideEffectClass`、`CompKind` 等联合类型各定义一份（评审 Top 10 第 3 条，★★★★☆）。

**规则**：
1. 断言 `SideEffectClass`、`CompKind`（及裁定后确定的其他领域联合类型）的**唯一**定义点在 `packages/saga/src/types.ts`；
2. `packages/persistence/src/saga-store/types.ts` 中出现这些类型的 `type`/`interface` 声明 → 违规；
3. 该文件只允许 `import type { ... } from '@bah/saga'`。

**为什么不会成环**：§0 R-1 已证明 `persistence → saga` 不构成循环（saga 的 deps 里没有 persistence）。P1-2 走这条路即可，不需要"中立契约类型"备选。

**前置**：同 2-5，须在裁定落地后启用。若裁定选择"中立契约类型"方案（`packages/core` 承载），本门禁改为断言"两个包均不得本地定义，真源在 core"。

**验收**：`persistence/src/saga-store/types.ts` 不再本地定义领域联合类型；在其中重新加一个 `type CompKind = ...` 后必须变红。

---

### 2-7 `verify-no-hardcoded-config.ts` — 部署相关取值不得硬编码

**背景**：`PROGRESS.md` R43 登记着"`verify-no-hardcoded-limits` 门禁（施单 05 §5 提到）未实现，用等价约束替代，门禁留到阶段 6（配置落 `bah.yml`）"。

**为什么现在能做**：R43 说"配置落 `bah.yml` 时才有静态扫描面"，而根 `bah.yml` 与 `profiles/`（desktop/headless/im/mobile/sdk/web 六份）现已就位，**扫描面已具备**。这是一张被正式登记、到期可兑的欠账票据。

**规则**：
1. 扫 `packages/bank/src/tools/**`、`packages/safety/src/**`；
2. 命中 `dailyTransferLimit` / `riskyCallThreshold` 等阈值标识符却直接赋数字字面量 → 违规；
3. 阈值必须来自 `resolveCompensationConfig` / `resolveSandboxConfig` 一类的入参（编译期不可知，故此项**只做词法**：标识符同行出现数字字面量即失败）。

**与 `verify-tiers` 第 4 条的分工**：`verify-tiers` 已覆盖 `bank/src/tools/**` 的两个阈值，本门禁**扩到 `safety/src/**` 并改为可扩展名单**。为避免规则重复，`verify-tiers` 的第 4 条保留，本门禁只管 `tiers` 未覆盖的目录。二者不得同时失败——修一处即可。

**验收**：`safety/src/**` 内无阈值硬编码；人为在 safety 包写入 `const x = 5000` 形式的阈值后必须变红。

---

## §3 与既有整改项的衔接

| 本单门禁 | 关联既有整改项 | 关系 |
|----------|----------------|------|
| 2-3 | `tech-debt-review` **P1-3**（bank 的 devDep 声明） | 门禁是 P1-3 的**制度化**，不是替代。P1-3 仍需人工裁定"移出 src"或"改依赖声明" |
| 2-2 | `tech-debt-review` **P1-2**（Saga 类型裁定前置） | 门禁是 P1-2 的**前置检查**，P1-2 本身仍需出裁定文档 |
| 2-5 | `tech-debt-review` **P1-1**（错误归一化收敛） | 门禁是 P1-1 的**成果保护**，须在收敛后启用 |
| 2-6 | `tech-debt-review` **P1-2** | 同上 |
| 2-7 | `PROGRESS.md` **R43** | 本门禁即 R43 的正式落地，落地后需回填 PROGRESS 的偏差表 |

**§0 R-2 的额外修复项**：`@bah/runtime` 也把 `@bah/persistence` 放在 devDependencies（`runtime/package.json`）。若 2-3 实跑发现 runtime 的生产源码确实 import 了它，需一并纳入 P1-3 的裁定范围。

---

## §4 实施顺序（依赖不可乱）

```
第 1 批（无前置，立刻可做）
  └─ 2-2 verify-package-graph      ← P1-2 的前置，必须最先
  └─ 2-3 verify-no-dev-dep-in-src ← P1-3 的制度化
  └─ 2-7 verify-no-hardcoded-config ← R43 兑票

第 2 批（需先改代码，再启用门禁）
  └─ 人工裁定并修正 2-1 的 13 处 switch
  └─ 清理 2-4 的 23 条失效引用 / 登记例外名单
  └─ 完成 P1-1 → 启用 2-5
  └─ 完成 P1-2 → 启用 2-6
```

**为什么分两批**：`run-gates.ts` 里任一 `ok=false` 即退出码 1 阻断合并。把需要人工裁定的门禁和零成本的门禁一起上，会让红灯淹没真实回归信号——这与 `tech-debt-review` P0 段落"不挤占信任预算"的判断一致。

---

## §5 明确不做的事

| 事项 | 原因 |
|------|------|
| 修改 `run-gates.ts` | 现有调度器自动发现，7 项新门禁零改动接入。改调度器会引入不必要的风险 |
| 把 `scripts/` 纳入 ESLint 做成门禁 | 评审 P1-4 只需改 `eslint.config.mjs:22` 一行 glob，`pnpm lint` 即覆盖。做成 `verify-*.ts` 反而绕路 |
| cc / 行数上限门禁 | `provideBankGovernance`(175行/cc29)、`createSagaAudit`(128行/cc35) 是 P1/P2 的**待重构对象**，不是待门禁对象。现在加只会立刻变红 |
| 提升覆盖率阈值 | P0-1 的 8 处缺口未补。评审禁区写明"阈值一旦下调制度即失效"，同理现在上调只会红 |
| 门禁检查测试文件 | 除 2-3 的夹具白名单外，一律排除。测试文件不构成契约 |
| 把 2-5 写成"兜底码全局唯一" | 会破坏 P1-1 的可判别性设计。见 §2-5 的关键约束 |

---

## §6 偏差登记（本单起草过程中的新发现）

| 编号 | 内容 | 处理 |
|------|------|------|
| R-1 | `tech-debt-review` 风险提示 2 称"saga 依赖 persistence（13 文件）"，实测不成立：persistence 在 saga 的 devDeps，生产源码的 9 处引用全在注释内，唯一的非测试引用是测试夹具 `kill-child.ts` | 已在本单 §0 登记。**建议同步更新 `tech-debt-review` 的该条风险提示**，否则后续读者会据此做错决策 |
| R-2 | 评审只点了 bank 的 devDep 越界，实测 `@bah/runtime` 同样把 `@bah/persistence` 放在 devDeps | §0 登记，§3 要求 P1-3 扩大范围 |
| R-3 | `docs/*.md` 中 23 条路径失效，其中多数是"规划中包"而非笔误 | §2-4 强制区分"真 bug"与"合法规划引用"，后者进例外名单 |
| R-4 | `@bah/knowledge/src/testing.ts` 并未越界（评审隐含其与 bank 同类） | §0 实测 B 排除，避免 2-3 误报 |

---

## §7 验收总表

| 门禁 | 文件 | 正控（实跑绿） | 负控（注入违规变红） | 依赖前置 |
|------|------|----------------|--------------------|----------|
| 包图 | `scripts/verify-package-graph.ts` | 46 边零环 | 加一条回边 → 报出完整环路 | 无 |
| devDep | `scripts/verify-no-dev-dep-in-src.ts` | EXIT=0 | 挪一个 dep 到 devDeps → 红 | 无 |
| 硬编码配置 | `scripts/verify-no-hardcoded-config.ts` | EXIT=0 | safety 包写阈值数字 → 红 | 无 |
| switch 收尾 | `scripts/verify-assert-never.ts` | 13 处裁定后 EXIT=0 | 删一处 `assertNever` → 红 | 需先裁定 13 处 |
| 文档路径 | `scripts/verify-docs-paths.ts` | 例外名单登记后 EXIT=0 | 删一处真实源文件引用 → 红 | 需先清理 23 条 |
| 错误归一化 | `scripts/verify-single-error-normalization.ts` | 收敛后仅 util 1 处 | 重新定义同名函数 → 红 | **依赖 P1-1** |
| Saga 类型 | `scripts/verify-single-saga-types.ts` | persistence 不再本地定义 | 加回 `type CompKind` → 红 | **依赖 P1-2** |

全部完成后 `pnpm gate` 从 16 项变为 23 项，且全绿。
