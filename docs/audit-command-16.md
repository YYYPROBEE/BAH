# 施工单：把 `bah audit` 接入 monorepo

> 施工单代号：施工单 16
> 起草日期：2026-10-21
> 基线：`pnpm gate` **23/23 全绿**（实测，`BAH_ALLOW_NO_SNAPSHOT=1` 放行 snapshot-fresh）
> 适用范围：`packages/cli`（新增子命令面）、`packages/persistence`（审计只读面）、新增 1 项门禁
> 依据：`AGENTS.md` 工程纪律、`docs/tech-debt-review-2026-10-20.md`、`PROGRESS.md` §46 偏差登记
> 状态：**施工中**（第三轮复审裁决见 §10；本文只出方案，不含代码）

---

## §0 起草前的实测取证（本单所有结论都可复跑）

本单不从"想当然的审计命令"出发，而是先把**现状盘清楚**。下面每条都有实跑证据。

### §0.1 现有 `bah` CLI 是**纯 flag 解析器，没有子命令概念**

`packages/cli/src/cli/run.ts:226` 的 `parseArgs` 是一个逐项 `switch` 的 flag 扫描器：命中 `--profile` / `--prompt` / `--serve` 等已知 flag 就赋值，落到 `default` 分支就 `未知参数`（退出码 2）。

**结论**：仓库里目前**不存在**任何子命令路由机制。`bah audit` 里的 `audit` 现在会被 `parseArgs` 当成未知参数直接拒掉。因此本单的**第一个结构性工作不是"写审计逻辑"，而是"把 CLI 从 flag 解析器升级成子命令路由器"**。这是先决条件，不能跳过。

### §0.2 审计链的**读侧**能力已经完备，**写侧**也完备，但**生产路径无人调用**

`packages/persistence/src/chain/` 已经实现了完整的证据链：

| 能力 | 位置 | 状态 |
|---|---|---|
| 链文件读写 `<root>/<sagaId>/audit.jsonl` | `packages/persistence/src/chain/chain-file.ts` | 已实装 |
| 哈希链 + Ed25519 签名 + Merkle 锚定 | `packages/persistence/src/chain/index.ts:129` | 已实装 |
| 投影重算（`projectionDiff`） | `packages/persistence/src/projection/index.ts:81` | 已实装 |
| 链健康检查（`checkChainHealth`） | `packages/saga/src/alert/index.ts:301` | 已实装 |
| 因果 DAG 导出（`causalDag` / `isAcyclic`） | `packages/saga/src/view/causality.ts` | 已实装 |
| 时间旅行回放（`replay` / `replayDiff`） | `packages/saga/src/replay/index.ts` | 已实装 |
| 门禁级自检（三类断言） | `scripts/verify-audit-chain.ts` | 已实装 |

**但生产链是空的。** 实测证据：

```
$ find sessions -name "audit.jsonl" | head -5
（无输出）

$ find sessions -name "session.jsonl" | wc -l
163
```

`sessions/` 下有 163 个会话目录、**0 个 `audit.jsonl`**。根因取证：`planSaga` / `runSaga` 在**生产源码里没有任何调用方**——

```
$ grep -rn "planSaga\|runSaga" packages --include=*.ts | grep -v "\.test\.ts" | grep -v "packages/saga/src"
（无输出）
```

只有 `packages/saga/src/recon/amendment.ts`（对账修订建单）和 `packages/saga/src/coordinator/fixtures/kill-child.ts`（测试夹具）调用它们。`bank:tools` 的转账走的是**工具族七段管线**，根本没接 saga 协调器。

再补一次端到端实测佐证（`.tmp-audit-probe`）：

```
$ npx tsx packages/cli/src/main.ts --profile headless --prompt "给王建国转 800 元" \
    --session s-audit-probe --jsonl .tmp-audit-probe
bah: profile headless · 会话 s-audit-probe
bah: 回复 已为你在模拟环境完成 800 元转账（黄色级别，已审批并核销）。
bah: 已落盘 .tmp-audit-probe\s-audit-probe\session.jsonl（29 条事件）

$ find .tmp-audit-probe -type f
.tmp-audit-probe/s-audit-probe/session.jsonl     ← 只有 session.jsonl，没有 audit.jsonl
```

**结论（对本单形状的决定性影响）**：

1. `bah audit` 若只做"读链 → 打印"，在当前仓库**永远读到空**（0 条链）。所以本单**必须自带数据产生路径**，否则交付的是一个"永远输出空"的命令。
2. 更重要的：`bah audit` 的**真正价值不是"打印审计链"**，而是**对任意落盘目录做一次独立的、可重放的证据链核验**——即把现在只存在于门禁 `scripts/verify-audit-chain.ts` 里的那三类断言，**产品化为一个运维可用的命令**。门禁验证的是"自己写的链对不对"，`bah audit` 要验证的是"**这个目录里的链**对不对"。

### §0.3 签名密钥在仓库中**不存在**，验签会抛 `signing-key-missing`

`packages/persistence/src/chain/sign.ts:28` 的 `loadSigningKeys` 在文件不存在时抛 `BahError('signing-key-missing')`（抛错点 `sign.ts:38`）。而默认路径 `keys/saga-ed25519.pem`：

```
$ ls -la keys
ls: cannot access 'keys': No such file or directory
```

同时 `packages/persistence/src/chain/index.ts:196` 对验签失败抛的是 `signature-invalid`（**不吞错**）。另有一个对审计命令**致命**的实现顺序：`verify()` 的密钥加载发生在验链循环**之前**（`chain/index.ts:183`，`signedCount > 0` 即读密钥）——**缺密钥时连"链断"结论都拿不到**，先抛 `signing-key-missing`。

**结论**：`bah audit` 遇到**有签名但验签失败**的链必须**结构化报错并给退出码**，不能静默跳过；遇到**密钥缺失**则必须明确报"无法验签（缺密钥）"并与"验签失败"**区分开**——这是两种完全不同的故障。当前 `createSagaAudit.verify()` 把两者都归到"抛异常"，所以命令层必须自己做区分。

### §0.4 `SIGNED_TYPES` 白名单里有两类事件，**生产上从来没人写**

`packages/persistence/src/chain/index.ts:31` 的白名单含 `tool/call` / `tool/result`，但：

```
$ grep -rn "append(" packages/saga/src packages/host/src packages/runtime/src packages/bank/src \
    --include=*.ts | grep -v "\.test\.ts" | grep -oP "append\([^,]+, '[^']+'" | sort -u
append(RECOVERY_CHAIN_ID, 'saga/recovery-failed'
append(anchorSagaId, 'saga/reconciled'
append(input.sagaId, 'saga/dlq-escalated'
append(input.sagaId, 'saga/residual-recorded'
append(plan.sagaId, 'saga/created'
append(plan.sagaId, 'saga/step-planned'
append(ref.sagaId, 'saga/unknown-probe'
append(row.sagaId, 'saga/comp-result'
append(sagaId, 'approval/decided'
append(sagaId, 'saga/call-result'
append(sagaId, 'saga/comp-decided'
append(sagaId, 'saga/comp-issued'
append(sagaId, 'saga/manually-closed'
append(sagaId, 'saga/recovered'
```

链上实际写入的 14 类事件里，有 **5 类**在签名白名单内：`saga/comp-issued` / `saga/comp-result` / `saga/residual-recorded` / `saga/manually-closed` / `approval/decided`（R170）；`tool/call` / `tool/result` 写在**会话流**里，从不进审计链。

**结论**：`bah audit` 的"签名覆盖率"检查**不能**按白名单全集断言（会误报"缺签名"）。正确口径是：**对链上实际存在的白名单事件逐条查签名**。

### §0.5 包依赖方向：`cli` 可以依赖 `persistence` 和 `saga`，反之不行

`scripts/verify-package-graph.ts:29` 定义了领域层（`persistence` / `saga` 在 `DOMAIN_PACKAGES`）与装配层（`host` / `cli` 在 `ASSEMBLY_PACKAGES`），规则是**领域层不得反向依赖装配层**。

- `cli → persistence`：合法（`cli` 是装配层）。
- `cli → saga`：合法。
- `persistence → saga`：**不合法**，且 `packages/saga/tsconfig.json` 已 reference `persistence`，反向 reference 会触发 `TS6202` 环（`PROGRESS.md` R139 已登记）。

**结论**：审计的**判定逻辑**必须放在 `saga`（或 `persistence` 自己的只读面）里，**不能**新建一个"审计包"再让 `persistence` 依赖 `saga`。本单的包边界见 §3.2。

### §0.6 `verify-docs-paths` 会把施工单里"待创建的文件路径"判红

`scripts/verify-docs-paths.ts` 扫描 `docs/*.md` 里反引号包裹的仓库路径，不存在即红（除非进 `scripts/docs-path-excludes.ts` 例外名单）。

**结论**：本单文档里提到的**尚未创建**的源文件路径，要么
(a) 写成**不含 `packages/` 前缀的形式**（如 "`audit.ts`"），要么
(b) 在 `scripts/docs-path-excludes.ts` 里登记例外。
**推荐 (a)**：不污染例外名单（该名单纪律明确写着"实装之后必须删掉对应条目，否则门禁就成了规划永动机的挡箭牌"）。

### §0.7 小结：本单的形状

| 事实 | 对方案的影响 |
|---|---|
| CLI 无子命令机制（§0.1） | 必须先做子命令路由，这是第 1 步 |
| 读侧能力完备、生产链为空（§0.2） | 命令必须自带数据产生路径；价值定位是"独立核验任意目录" |
| 密钥不存在、验签抛错（§0.3） | 缺密钥 vs 验签失败必须区分，退出码要分开 |
| 白名单事件生产上无人写（§0.4） | 签名检查按"链上实际存在"逐条查，不按全集断言 |
| `persistence` 不能依赖 `saga`（§0.5） | 判定逻辑放 `saga`，只读面放 `persistence` |
| 文档路径门禁（§0.6） | 待建文件路径不写 `packages/` 前缀 |

---

## §1 目标与非目标

### §1.1 目标

1. `bah audit` 成为 `bah` 的**第一个子命令**，且**不破坏**现有 flag 用法（`pnpm bah --profile headless --prompt ...` 原样可用）。
2. 对**给定目录**做一次**独立于运行时**的证据链核验，输出结构化结论：
   - 链连续性（`prevHash` / `recordHash` 重算）
   - 签名覆盖与验签
   - 投影重算 diff（对 saga 库）
   - 锚定台账（Merkle 根）比对
3. **零外部调用、零 LLM、零写**（沿用 `packages/persistence/src/projection/index.ts:8` 的既有纪律）。
   **"零写"要按最强口径验收**：跑完一遍 `bah audit`，被审计目录**不允许出现任何新文件**（含 sqlite 库本体、`-wal`、`-shm`、anchors、临时文件）。理由见 R159——这条不只是洁癖，`createSagaStore` 的默认行为会凭空建库并把"投影全跳过"报成通过。
4. 可重放：同一目录重复跑，结论一致。

### §1.2 非目标（本单**不做**，避免范围蔓延）

| 不做 | 理由 |
|---|---|
| 把 `bank:tools` 的转账接进 saga 协调器 | 那是**生产写路径**的改造，影响面是整个工具族，属独立施工单；本单只做读侧命令 |
| 让 `bah audit` 修复被破坏的链 | 审计命令**只读**。发现链损坏必须**报告**而不是**修复**——修复即掩盖证据 |
| 改 `verify-audit-chain.ts` 门禁 | 门禁验的是"本仓代码写的链"，命令验的是"任意目录的链"，两者目的不同，保持独立 |
| Web 端的审计视图改造 | `packages/channels/src/web/audit.ts` 已实装五视图的审计帧，与本单无关 |
| 引入新依赖 | 全部用 `node:crypto` / `node:fs` 既有能力 |

---

## §2 命令面设计

### §2.1 子命令路由：`bah [子命令] [flag]`

**关键设计约束**：`parseArgs` 现有的 flag 语义（`--flag value` 与 `--flag=value` 两种写法、未知参数退出码 2、布尔开关不接受值）**必须原样保留**。`packages/cli/src/cli/run.test.ts` 有 565 行断言这些行为，改坏即红。

路由规则（**第一参数是子命令名时才进子命令模式**）：

```
bah audit ...                → 子命令模式
bah --profile headless ...   → 现有 flag 模式（完全不变）
bah                          → 现有 flag 模式（无参数 → 现有行为）
```

实现上引入一个**结果联合**（封闭联合 + `assertNever` 收尾，沿用 `packages/cli/src/cli/run.ts:443` 的既有写法）：

```ts
type Command =
  | { readonly kind: 'run' }        // 现有 flag 模式
  | { readonly kind: 'audit' }      // 新子命令
```

`parseArgs` 保持原样不动；**新增**一个 `parseCommand(argv)` 负责分流。这样现有 565 行测试一行不用改。

> 为什么不用「子命令 + 子参数」两级路由：本单只有一个子命令，两级路由会引入第二套参数解析器（第二套 = 第二份 bug 面）。一级路由 + 子命令自有 flag 表，足够且更小。

### §2.2 `bah audit` 的 flag

| flag | 取值 | 缺省 | 语义 |
|---|---|---|---|
| `--dir <path>` | 目录 | `sessions/` | 待审计的落盘根（链在 `<dir>/<sagaId>/audit.jsonl`） |
| `--saga <id>` | saga id | 全部 | 只审一条链；不给则审目录下全部 |
| `--db <path>` | 文件 | `<dir>/saga.sqlite` | 投影重算用的 saga 库；**文件不存在则整段跳过投影**（`skipped-no-db`，绝不新建，R159） |
| `--no-projection` | 布尔 | 关 | 跳过投影重算（纯离线审计 / 只有链没有库时用） |
| `--key <path>` | 文件 | `keys/saga-ed25519.pem` | 验签用私钥 |
| `--format <fmt>` | `text` \| `json` | `text` | 输出格式 |
| `--no-signature` | 布尔 | 关 | 跳过验签（只验链连续性） |
| `-h` / `--help` | 布尔 | — | 打印 `bah audit` 自己的帮助 |

**退出码语义**（沿用现有 0/1/2 三档；`audit` 对三档的含义做**子命令级细化**）：

| 码 | 含义 | 判定 |
|---|---|---|
| `0` | 审计通过 | 链连续 + 签名全过 + 投影 diff=0 + 锚定一致（或明确"未锚定"） |
| `1` | **审计发现异常** | 链断裂 / 验签失败 / 投影漂移 / 锚定不符 |
| `2` | 用法或**环境**错误 | 未知 flag、缺值、非法取值、`--dir` 不存在、**缺密钥且未 `--no-signature`** |

**关键点 1**：退出码 `1` 的语义必须是"**审计发现了问题**"（审计有结论、结论是坏），而不是"审计跑不起来"（工具/环境故障）。混在一起会让门禁无法区分"代码有 bug"和"数据被篡改"。

**关键点 2（缺密钥归属 2 的依据）**：`verify()` 的密钥加载在验链**之前**（§0.3），缺密钥时连"链断"结论都拿不到——此时审计**整体无法完成**，属环境不完整。

**关键点 3（"用户降级"与"环境没配"必须区分）**：同样是"没验签"，来源不同处置也不同：

| `signatureState` | 触发 | 退出码贡献 |
|---|---|---|
| `verified` | 验签通过 | 无 |
| `invalid` | 验签失败（**数据被改**） | **1** |
| `skipped-no-key` | 未配密钥、也未显式降级（`--key` 路径不存在） | **2**（环境不完整，审计未完成） |
| `skipped-disabled` | 用户显式 `--no-signature` | 无（已知降级，不算未完成） |

把这两种"跳过"合成一个状态，会让使用者分不清"我没配好"和"我自己选择不信这道检查"。

### §2.3 输出格式

`--format text`（人读；示例按 §0.2 的真实现状——有链、无锚定台账——绘制）：

```
bah audit · 目录 sessions · 链 2 条 · 事件 148 条

✔ saga-gate-001        42 事件  链连续  签名 7/7  投影 diff=0
✔ saga-gate-002        38 事件  链连续  签名 5/5  库中无此事务（跳过投影）
  锚定 2026-10  台账无此 period（未锚定，anchor job 未运行）
  签名  密钥缺失，跳过验签（--key 指向 keys/saga-ed25519.pem 不存在）

结论：2 条链连续性通过；签名未验证（缺密钥）；投影 1 过 1 跳过；锚定未运行
```

`--format json`（机器读；**字段即契约**，由步骤 5 的门禁锁住）：

```json
{
  "dir": "sessions",
  "chains": [
    {
      "sagaId": "saga-gate-001",
      "events": 42,
      "chainOk": true,
      "brokenAt": null,
      "signedExpected": 7,
      "signedPresent": 7,
      "signatureState": "verified",
      "signatureError": null,
      "projectionState": "diff-zero",
      "projectionDiff": 0
    },
    {
      "sagaId": "saga-gate-002",
      "events": 38,
      "chainOk": true,
      "brokenAt": null,
      "signedExpected": 5,
      "signedPresent": 5,
      "signatureState": "skipped-no-key",
      "signatureError": "signing-key-missing",
      "projectionState": "runtime-missing",
      "projectionDiff": null
    }
  ],
  "anchors": [{ "period": "2026-10", "merkleRoot": "a3f9…", "state": "ledger-missing" }],
  "ok": true
}
```

契约要点（每条都是实测踩出来的）：

- `signatureState` **四态**：`verified` / `invalid` / `skipped-no-key` / `skipped-disabled`（§2.2 关键点 3）。核心是"**没验**与"验了但失败"必须分字段——缺密钥 = 环境没配好（退出码 2），用户显式降级 = 已知取舍（退出码 0），invalid = 数据被改（退出码 1）。三者处置完全不同，合并成一个布尔会把审计结论抹平。
- `projectionState` **四态**：`diff-zero` / `diff-nonzero` / `runtime-missing` / `skipped-no-db`。
  - `runtime-missing` = 链存在但 saga 库没有该事务：`projectionDiff` 对这种情况返回 diff=1（`loadTransaction` 返回 `undefined` 参与 `===` 比较必然不等），**直接报 diff=1 是误报**；
  - `skipped-no-db` = **库文件整个不存在**（R159）：此时不打开任何数据库，全链跳过投影。绝不能走到 `createSagaStore`——它会新建空库，把所有链判成 `runtime-missing`，得到"全部通过"的**假绿**。
- `anchors[].state` 三态：`matches` / `mismatch` / `ledger-missing`。台账（`anchors.json`）里没有该 period 是"**锚定从未运行**"（anchor job 属 `features.b4`，不跑就没台账），不是"锚定不符"——把"没跑过"报成"被篡改"是审计器的诬告。

---

## §3 包边界与文件落点

### §3.1 落点总表

| 文件 | 性质 | 说明 |
|---|---|---|
| `packages/cli/src/cli/command.ts` | 新增 | 子命令分流（`parseCommand`）+ 路由表 |
| `packages/cli/src/cli/audit.ts` | 新增 | `bah audit` 的参数解析与执行 |
| `packages/cli/src/cli/audit.test.ts` | 新增 | 子命令面单测 |
| `packages/persistence/src/chain/audit-report.ts` | 新增 | **只读**审计报告构造（链连续性 + 签名覆盖 + 锚定比对） |
| `packages/persistence/src/chain/audit-report.test.ts` | 新增 | 对应单测 |
| `scripts/audit-selftest.ts` | 新增 | 造链 → 审计 → 清理的自证脚本（§4 步骤 4） |
| `packages/cli/src/cli/index.ts` | 修改 | 导出新增符号，**含 `AUDIT_HELP` / `AUDIT_USAGE`**（纯 barrel，不进覆盖率；不可复用主命令的 `HELP`/`USAGE`，R162） |
| `packages/cli/package.json` | 修改 | `dependencies` 增 `@bah/persistence` **和** `@bah/saga`（§8-1） |
| `packages/cli/tsconfig.json` | 修改 | `references` 增 `../persistence`、`../saga`（现为仅 `../host`，实测） |
| `scripts/verify-audit-cli.ts` | 新增 | 门禁：`bah audit` 的 flag 契约不得被静默改掉 |
| `docs/audit.md` | 新增 | 命令面文档（面向使用者） |
| `PROGRESS.md` | 修改 | 追加施工回执与偏差登记 |

### §3.2 分层纪律（对应 §0.5）

```
@bah/cli  (装配层)
   ├── @bah/persistence   ← 只读审计面（链读取、链校验复用 verify()、签名覆盖统计、锚定比对）
   └── @bah/saga          ← 判定语义（reduceSaga 转移函数、投影重算）
```

- **禁止** `@bah/persistence → @bah/saga`（会成环 + TS6202）。
- 因此 `persistence` 侧的 `audit-report.ts` **只做与 saga 语义无关的核验**：链连续性 + 验签（**复用 `createSagaAudit().verify()`，见 §8-2**）、签名覆盖统计、锚定 Merkle 根比对。
- **投影重算**（需要 saga 的状态转移语义）走 `saga` 侧已有的 `projectionDiff(ctx, chain, sagaId, reduceSaga)`，由 **CLI 装配层**注入 `reduceSaga`——这正是 `packages/host/src/boot/plugins/saga.ts:83-87` 已有的现成模式，照抄即可，不发明新写法。
- **依赖落点（§8-1）**：CLI 同时需要两包——`projectionDiff` / `PROJECTION_STORE` / `ChainFile` / `createSagaAudit` 来自 `@bah/persistence`，`reduceSaga` / `createContext` 补齐来自 `@bah/saga` 与 `@bah/core`（core 已在依赖里）。所以 `packages/cli/package.json` 的 `dependencies` 要**同时**加 `@bah/persistence` 和 `@bah/saga`，`packages/cli/tsconfig.json` 的 `references` 同步加 `../persistence`、`../saga`（现仅 `../host`，实测确认）。漏掉 `@bah/saga` 会在 `tsc -b` 时类型解析失败；漏声明依赖则触发 `verify-no-dev-dep-in-src` 的同族问题（值导入必须在 `dependencies`）。

### §3.3 为什么不新建独立的审计包

新建包要付出：新增 `package.json` / `tsconfig.json` / barrel、动 `pnpm-workspace.yaml`、在 `scripts/verify-package-graph.ts` 的 `DOMAIN_PACKAGES` 登记、在 `scripts/coverage-allowlist.ts` 决定纳不纳强制名单。而本单要的"只读核验"逻辑**本质就是 `persistence/src/chain/` 已有的能力的外壳**——放进去零新包、零新依赖图边。

**代价要说清**：`persistence` 包会新增"面向运维的呈现"职责，略微偏离它"只做持久化原语"的定位。接受这个代价，理由是：新建包的**治理成本**（5 处门禁/配置要同步）**大于**这点定位偏移。若后续 `audit` 演进出独立生命周期（策略配置、多种报告格式、增量审计），再拆包——届时迁移成本远低于现在就引入一个只有一个文件的小包。

---

## §4 分步施工（每步可独立验收、独立提交）

### 步骤 1 · 子命令路由骨架（不写任何审计逻辑）

**产出**：`packages/cli/src/cli/command.ts` + 测试。

- 定义 `Command` 封闭联合（`run` / `audit`），`assertNever` 收尾。
- `parseCommand(argv)`：首参命中路由表 → 子命令模式；否则 → `run` 模式。
- `runCli` 里分流：`audit` → 委托给 `runAudit`；`run` → 现有逻辑**一行不改**。
- `runAudit` 先只打印一行占位并返回 0。

**验收**：
- `pnpm test` 全绿，**现有 565 行 CLI 测试零修改**（这是本步的核心断言——用 `git diff --stat` 自证）。
- 新增用例：`bah --profile x` 仍走 run 模式；`bah audit` 走 audit 模式；`bah --bad-flag` 仍退出码 2。

**风险**：`parseArgs` 现有行为是本步最大的回归面。**约束**：不改 `parseArgs` 的任何一行。

### 步骤 2 · `bah audit` 只读核验（链连续性 + 签名）

**产出**：`packages/persistence/src/chain/audit-report.ts` + `packages/cli/src/cli/audit.ts`。

- `persistence` 侧：实现 `buildChainAudit(rows, options)`，纯函数，输入链记录数组，输出 `{ events, chainOk, brokenAt, signedExpected, signedPresent, signatureState, signatureError }`。
  - **链连续性 + 验签：复用 `createSagaAudit().verify()`，不重写哈希算法**（§8-2 的裁定）。`verify()` 的三态结果靠异常归一拿到：
    - 返回 `{ ok: false, brokenAt }` → 链断裂（且此时未做验签——`verify()` 链断即返回）；
    - 抛 `signature-invalid` → 链连续但验签失败（`signatureState: 'invalid'`）；
    - 抛 `signing-key-missing` → 无法验签（`signatureState: 'skipped-no-key'`，退出码走 2）。
  - **签名覆盖统计**（`signedExpected`/`signedPresent`）仍由 `audit-report` 自算：读行数出"链上实际存在的白名单事件"与其中带 `sig` 的条数（§0.4 口径）。这是纯计数，无算法分叉风险。
- `cli` 侧：解析 §2.2 的 flag，调 `buildChainAudit`，按 §2.3 渲染。

**验收**：
- 覆盖率：`packages/persistence/src/chain/audit-report.ts` 纳入 `scripts/coverage-allowlist.ts` 强制名单，**scope 必须是单文件 `'chain/audit-report.ts'`**（§8-3）。
- 单测覆盖：链断裂（改中间行 `p`）、签名缺失、签名错误、密钥缺失、正常链、末行截断容忍。

**风险**：验签是**唯一会读私钥**的路径。`loadSigningKeys` 在 POSIX 上要求 600 权限，Windows 豁免（`sign.ts:43`）。测试必须在临时目录造密钥并显式 `chmod 0o600`（Windows 上该调用无害）。

### 步骤 3 · 投影重算与锚定比对

**产出**：CLI 侧接 `projectionDiff` 与锚定台账。

**铁律：投影重算不得调用 `createSagaStore`（R159，第二轮复审实测）。**

`packages/persistence/src/saga-store/index.ts:170` 的构造函数是 `new DatabaseSync(options.dbPath)`（Node 内置 `node:sqlite`），随后立刻 `PRAGMA journal_mode = WAL` + `migrate(db)`。实测三条：

```
1) 默认打开不存在的文件  → 创建该文件            true
2) readOnly:true 打开已存在库                    OK
3) readOnly:true 打开不存在的文件                抛 ERR_SQLITE_ERROR
```

由此得到两个推导：(a) 库不存在时 `createSagaStore` 会**凭空建一个空库**；(b) 即使库已存在，`migrate` + `journal_mode=WAL` 仍会**写盘**。两者都违反 §1.1 目标 3 的"零写"，且 (a) 更致命——空库让所有链变成 `runtime-missing` 全部跳过，产出**"全部通过"的假绿**，而审计命令假绿比不上线更危险。

正确做法：

1. 先 `existsSync(dbPath)`；**不存在 → 全链 `projectionState: 'skipped-no-db'`，显式标注，不打开任何数据库**。
2. 存在 → 用 `loadSqlite()`（`packages/persistence/src/saga-store/sqlite.ts:18`，它已封装好"加载时过滤 `SQLite is an experimental feature` 警告"）以 **`{ readOnly: true }`** 直连。
   **选项名是 `readOnly`（Node 拼写），不是 better-sqlite3 的 `readonly`**——写错会静默失效（未知选项被忽略，照样可写）。
3. 造一个只实现 `loadTransaction` 的最小结构化对象，`provide` 给 `PROJECTION_STORE`，然后**复用 `projectionDiff`**（`packages/persistence/src/projection/index.ts:81`）——不另写一份 diff 比对。
   只读面只碰两列：`saga_transaction.saga_id`、`saga_transaction.state`。这是 schema 契约（有 `v0_init.ts` 迁移落库），不是业务逻辑复制。

**注意 Mechanical**：链 id ≠ 事务 id 的**反向缺口**（库里有事务、但 `<dir>/<sagaId>/audit.jsonl` 不存在或为空）必须单列并判退出码 **1**——运行时状态失去证据链背书，比链断裂更严重。这一步的 id 集合来自 `SELECT saga_id FROM saga_transaction`。

- 锚定比对：读 `<dir>/anchors.json`（`packages/persistence/src/chain/index.ts:354` 的 `anchorsPath` 口径），用 `merkleRootOf` 重算同 period 叶子集比对——与 `packages/persistence/src/chain/index.ts:207-221` 的 `anchor()` 完全同口径。**三态必须分开**（§8-5）：台账有该 period 且根一致 → `matches`；根不一致 → `mismatch`（计退出码 1）；**台账没有该 period → `ledger-missing`（未锚定）**，不算异常——anchor job 属 `features.b4` 观测面，从未运行过的部署台账为空是常态，把"没跑过"报成"被篡改"是审计器诬告。

**验收**：
- 投影 diff ≠ 0 的链必须被判为退出码 1；`runtime-missing` 不计异常但必须显式标注。
- "库有事务、链缺失"必须判退出码 1（运行时状态失去证据链背书，比链断裂更严重）。
- 锚定 `mismatch` 判退出码 1；`ledger-missing` 不计异常但必须显式标注。三态互不混淆。

### 步骤 4 · 数据产生路径（解决 §0.2 的"空盘"）

**产出**：`bah audit --selftest` 或独立脚本，二选一（**推荐独立脚本** `scripts/audit-selftest.ts`）。

理由：把"造数据"和"审数据"放进同一个命令会让 `bah audit` 变成"既当运动员又当裁判"。独立脚本更干净，且能复用 `scripts/verify-audit-chain.ts` 已有的 `plan → run` 造链配方（该文件第 100-160 行已给出完整可跑的 plan/run 代码）。

- 脚本在**临时目录**造一条真链（含签名），调 `bah audit` 核验，断言通过后清理。
- **不碰**仓库的 `sessions/`。

**验收**：`pnpm audit:selftest` 一条命令跑通，输出"造链 42 事件 → 审计通过"。

**命名红线（§8-6）**：script 名**必须带冒号后缀**（`audit:selftest`）。pnpm 内置 `pnpm audit` 是依赖漏洞审计命令——若把 script 命名成裸 `audit`，`pnpm audit` 会被 pnpm 内置命令截胡，script 永远无法通过 `pnpm audit` 调到。CLI 子命令 `bah audit` 不受影响（入口是 `pnpm bah`）。

### 步骤 5 · 门禁 + 文档 + 回执

**产出**：`scripts/verify-audit-cli.ts`、`docs/audit.md`、`PROGRESS.md` 回执。

门禁 `verify-audit-cli` 的五条断言（**AST 优先**，参照 `scripts/verify-event-modes.ts`）：

1. `bah audit` 的 flag 集合与 `docs/audit.md` 里列的**逐字一致**（文档改了没改代码 → 红）。⚠️ **必须与命令实现、文档同批落地**（R161），否则先上门禁会因文档缺失恒红。
2. `packages/cli/src/cli/command.ts` 的 `Command` 联合成员封闭且有 `assertNever` 收尾。
3. `packages/cli/src/cli/audit.ts` 的退出码只用 0/1/2。
4. `audit-report.ts` **不 import** `@bah/saga`（分层纪律的自动化守护，对应 §3.2）。
5. `audit.ts` / `audit-report.ts` 内**不得出现** `createSagaStore` 标识符（R159 的编译防线——把"审计不许建库"这条纪律变成门禁，而不是靠施工人记住）。

**验收**：`pnpm gate` 从 23 → **24/24** 全绿。

---

## §5 负控（每条门禁/断言都必须实跑一次"注入违规 → 确认变红 → 回滚"）

`PROGRESS.md` R20 已把负控定为纪律。本单的负控清单：

| # | 注入 | 期望 |
|---|---|---|
| 1 | 改 `packages/persistence/src/chain/index.ts:188` 的哈希算法（如去掉 `prevHash` 拼接） | `verify-audit-chain` 门禁红 **且** `audit-report` 单测红——证明审计器复用同一算法（单一真源），不存在"改了链实现、审计器还在用旧算法"的失真窗口 |
| 2 | 把 `audit.ts` 的退出码改成 `0`（无论是否发现异常） | 步骤 3 的"投影 diff≠0 判退出码 1"用例红 |
| 3 | 在 `audit-report.ts` 里 `import { reduceSaga } from '@bah/saga'` | 门禁 `verify-audit-cli` 第 4 条红 |
| 4 | 在 `docs/audit.md` 里加一个代码里没有的 flag | 门禁第 1 条红 |
| 5 | 删掉 `command.ts` 的 `assertNever` 收尾 | 门禁第 2 条红 |
| 6 | 把 `parseArgs` 的未知参数分支从退出码 2 改成 1 | 现有 CLI 测试红（证明步骤 1 没偷改） |
| 7 | 删掉投影重算的 `runtime-missing` 分支（对库中不存在的 saga 直接 diff） | 步骤 3 的"runtime-missing 不计异常"用例红（§8-4） |
| 8 | 把 `readOnly: true` 改回默认打开（或删掉 `existsSync` 前置检查） | 临时目录跑完出现新 sqlite 文件（含 `-wal`） → 步骤 3 的"零写"用例红。这是本单**唯一可能偷偷造成假绿**的分支，必须单独盯（R159） |

---

## §6 偏差登记（起草时即知、本单不掩盖的既有问题）

| 编号 | 内容 | 本单处置 |
|---|---|---|
| R145 | **生产链为空**：`planSaga`/`runSaga` 无生产调用方，`bank:tools` 未接 saga 协调器（§0.2 实测） | 本单**不修**（属独立施工单）。`bah audit` 的价值定位因此是"核验任意目录的链"，不是"核验本仓生产链"。**必须在 `docs/audit.md` 显著位置写明**——否则使用者会以为命令坏了 |
| R146 | **签名私钥不在仓库**：`keys/saga-ed25519.pem` 不存在（§0.3） | 验签在默认配置下**必然报"缺密钥"**。命令必须区分"缺密钥"（环境问题）与"验签失败"（数据问题），并在文档里说明如何生成密钥 |
| R147 | **`SIGNED_TYPES` 含生产上无人写的事件**（`tool/call` / `tool/result`，§0.4） | 签名检查按"链上实际存在"逐条查，不按白名单全集断言。**不修改** `SIGNED_TYPES`（那是 SA-07 冻结面，改它要回写 SA-07） |
| R148 | **`query/` 是空壳**：`packages/persistence/src/query/index.ts` 只有 `export {}`，注释写"实装见施工单 03、12" | 本单**不填**这个坑。审计只读面放 `chain/audit-report.ts`（与链同源），`query/` 留给通用查询面 |
| R149 | `parseArgs` 复杂度 cc30、`createSagaAudit` cc35（`docs/tech-debt-review-2026-10-20.md` P2-2） | 本单**顺带缓解** `parseArgs`（分流后 `parseArgs` 职责收窄），但**不动** `createSagaAudit`（`audit-report.ts` 是独立实现，不侵入它）。P2-2 仍留待专项 |
| R150 | `packages/persistence/src/query/index.ts` 注释提到的"施工单 12" | 编号 12 已存在（`PROGRESS.md` 有 §"施工单 11/12" 痕迹），本单不核销该欠账 |
| R151 | **起草期间仓库有并发写入者**：`docs/snapshot-sandbox-scenario-brief.md`（快照场景任务）于 10:58 由另一方创建，它引用的 3 个待建路径使 `verify-docs-paths` 判红 | 与本单**无关**，不代改他人文件。已复跑确认：剔除该文件后本单**零红项**（例外名单 24→32，命中 28→36）。本单在例外名单登记的 8 条待建路径已全部生效 |
| R152 | `verify-docs-paths` 的行号后缀正则只剥 `:123` / `:12-34`，**不剥** `:41,48`（逗号分隔），导致整串被当路径去查 → 对**已存在**的文件误报 | 本单不修（属他人文件的引用写法问题，且改动正则会影响全仓 387 处引用判定的兼容性）。**本单自身的所有路径引用一律用单一行号后缀**，避免踩这个坑 |
| R153 | 复审发现本单初稿 **6 处行号偏差**（详见 §8-0）：`run.ts:442→443`、`chain/index.ts:31→32`、`chain/index.ts:129→130`、`sign.ts:41→28/38`、`sign.ts:47→43`、`sign.ts:36/:57→59/64` | 已全部修正。教训：行号引用必须在写入时用 `grep -n` 实取，不能凭读时印象 |
| R154 | 复审发现初稿 §4 步骤 2 自相矛盾："照抄 `chain/index.ts:188` 的算法，不另写一份"——**照抄就是另写一份**。链算法将来演进时，审计器那份副本不同步 → 审计器自己失真，恰好违反本仓"错误归一化单一真源"的同族纪律 | 裁定改为**复用 `createSagaAudit().verify()` + 异常归一**（§4 步骤 2 重写）。哈希与验签算法保持单一真源；`audit-report` 只保留无分叉风险的纯计数（签名覆盖统计）。负控 #1 相应强化为"改链算法 → 审计器必须跟着变红" |
| R155 | 初稿 §3.1 依赖修改不完整：只写了给 `packages/cli/package.json` 加 `@bah/persistence`，**漏了 `@bah/saga`**（投影重算要 `reduceSaga`）与 `packages/cli/tsconfig.json` 的 `references`（实测现仅 `../host`） | §3.1 / §3.2 已补全。漏 `@bah/saga` 会在 `tsc -b` 类型解析失败 |
| R156 | 初稿 §4 步骤 2 的覆盖率 scope 写成 `'chain/'`——会把 `chain/` 下 4 个**现有**文件（`index.ts` 403 行 / `chain-file.ts` / `sign.ts` / `vault.ts`）全卷进 100% 强制面，而实测 `coverage/coverage-summary.json` 里它们**无数据**（现在就不在统计面）→ 门禁立刻红，范围失控 | 改为单文件 `scope: 'chain/audit-report.ts'`。名单扩容属正常演进，但一次卷入 4 个历史文件不是扩容是翻新 |
| R157 | 初稿对投影重算与锚定比对各有**一个误报口径**：① `projectionDiff` 对"库中无此 saga"返回 diff=1（`loadTransaction` 为 `undefined` 参与比较必然不等），真实目录必现；② 台账无该 period 是"anchor job 从未运行"（`features.b4` 观测面），不是"锚定被篡改" | §2.2 / §2.3 / §4 步骤 3 已钉死三态口径：`runtime-missing` / `ledger-missing` 均不计异常但显式标注；"库有事务、链缺失"反向缺口计异常 |
| R158 | 初稿退出码表缺"工具跑不起来"的归宿（`--dir` 不存在、缺密钥且未 `--no-signature`）——1 被占用、2 只写"用法错误"，IO/环境故障无码可归 | §2.2 已扩义：2 = 用法**或环境**错误，1 严格留给"审计发现问题"。缺密钥归属 2 的依据（`verify()` 密钥先于验链加载）已写进 §0.3 与 §2.2 关键点 2 |
| R159 | **第二轮复审实测发现，本单最危险的一处**：`packages/persistence/src/saga-store/index.ts:170` 的构造函数 `new DatabaseSync(dbPath)` 默认可写，紧接 `PRAGMA journal_mode=WAL` + `migrate(db)`。若按初稿直接调 `createSagaStore`：(a) 库不存在时**凭空建空库** → 全链变 `runtime-missing` 全跳过 → **"全部通过"的假绿**；(b) 库存在也照样**写盘**违反"零写"。实测 `readOnly: true` 可用、且对不存在文件抛 `ERR_SQLITE_ERROR` | §1.1 目标 3 按最强口径重写（跑完目录零新增文件）；§4 步骤 3 禁用 `createSagaStore`，改 `existsSync` 前置 + `readOnly: true` 直连 + 最小 `loadTransaction` 结构化注入；`projectionState` 增 `skipped-no-db`；负控 #8 专盯此分支。**Node 选项是 `readOnly`，写成 better-sqlite3 的 `readonly` 会静默失效** |
| R160 | 第二轮复审发现的逻辑不一致：初稿只有"未验签"一个状态，无法区分"环境没配密钥"与"用户显式 `--no-signature` 降级"——两者一个是未完成、一个是已知取舍，退出码却会撞车 | §2.2 关键点 3 + §2.3 契约：`signatureState` 扩为四态 `verified` / `invalid` / `skipped-no-key` / `skipped-disabled`，分别贡献 0 / 1 / 2 / 0 |
| R161 | 初稿 §4 步骤 5 的门禁第 1 条要求"flag 集合与 `docs/audit.md` 逐字一致"，而 `docs/audit.md` 又是步骤 5 才产出的 → 先上门禁必然红 | §4 步骤 5 明确两者**同批落地**（命令实现 + 文档 + 门禁一次提交），不允许"先上门禁后补文档" |
| R162 | 初稿未提 `bah audit --help` 的常量归属。现有 `HELP` / `USAGE` 是主命令常量（`run.ts` 导出且被 `run.test.ts` 断言），子命令需要自己的 `AUDIT_HELP` / `AUDIT_USAGE`，不能复用主命令那两个 | §3.1 补入导出项。 `run.test.ts` 断言的是主命令常量，新增子命令常量不影响现有断言（这也是 §4 步骤 1 的验收前提之一） |

---

## §7 出口清单（做完这 7 条才算本单完）

- [ ] 步骤 1：子命令路由骨架，`git diff --stat` 证明现有 CLI 测试零修改
- [ ] 步骤 2：链连续性 + 签名核验，`audit-report.ts` 进强制 100% 名单
- [ ] 步骤 3：投影重算 + 锚定比对，**只读验收：临时目录跑完 `git status` 外零新增文件**（R159，含无 `-wal`/`-shm` 残留）
- [ ] 步骤 4：`pnpm audit:selftest` 造链 → 审计 → 清理，端到端跑通
- [ ] 步骤 5：门禁 `verify-audit-cli` 上线（命令 + `docs/audit.md` + 门禁**同批**，R161），`pnpm gate` **24/24**
- [ ] `pnpm test` 全绿、`pnpm typecheck` 0 错、`pnpm lint` 0 错
- [ ] `docs/audit.md` + `PROGRESS.md` 回执（含 §6 偏差编号 R145-R158 的落地状态；例外名单 8 条待建路径全部删除）

**总计**：新增 5 个源文件 + 2 个测试文件 + 1 个门禁 + 2 份文档，修改 5 个既有文件（含 `packages/cli/tsconfig.json`）。

---

## §8 复审修订记录（2026-10-21 11:10，起草后 20 分钟自查）

> 复审方法：对初稿全部"文件：行号"引用逐条 `grep -n` 实取；对每条设计断言找反例。复审**只动了本文档与例外名单**，未改任何生产源码。

### §8-0 行号勘误（6 处，全部实测修正）

| 初稿 | 实测 | 差因 |
|---|---|---|
| `run.ts:442` | `run.ts:443`（`return assertNever(...)`） | 凭读时印象少 1 行 |
| `chain/index.ts:31` | **`31`（原本正确）** | 第一轮误判为"引到注释行"改成 32，**实为引对**：31 就是 `export const SIGNED_TYPES = [`，32 才是数组首元素。第二轮已改回（§9-4） |
| `chain/index.ts:129` | **`129`（原本正确）** | 同上：129 就是 `export function createSagaAudit`，130 是函数体首行。第二轮已改回（§9-4） |
| `sign.ts:41` | `sign.ts:28`（声明）/ `sign.ts:38`（抛错点） | 引到了 throw 参数行 |
| `sign.ts:47` | `sign.ts:43`（Windows 豁免注释） | 同上 |
| `sign.ts:36` / `:57` | `sign.ts:59`（`signRecord`）/ `sign.ts:64`（`verifyRecord`） | **指错函数**——36 是 try 块内赋值、57 是注释 |

第一轮判定为"核对无误"的引用，第二轮**重新逐条 `grep -n`**，实际只有 5 条扛住了：`run.ts:226`（`parseArgs`）、`chain/index.ts:188`（哈希算法行）、`chain/index.ts:196`（`signature-invalid` 消息行）、`chain/index.ts:207-221`（`anchor()`）、`host/boot/plugins/saga.ts:83-87`（注入模式）、`run.test.ts` 565 行。

第一轮"核对无误"清单中以下 3 条**又被第二轮推翻**：`alert/index.ts:303`→实为 `301`（`checkChainHealth` 声明）；`chain/index.ts:355`→实为 `354`（`anchorsPath` 声明）；`sqlite.ts:20`→实为 `18`（§9 新增）。教训见 §9-4：**两轮复审都用"读相邻几行"的方式核对行号，是同一套错误方法**——正确做法是必须 `grep -n` 取**符号声明行**本身。

### §8-1 依赖声明补全（R155）

CLI 的投影重算同时需要 `@bah/persistence`（`projectionDiff` / `PROJECTION_STORE` / `ChainFile` / `createSagaAudit`）与 `@bah/saga`（`reduceSaga`）。初稿只写了 persistence。实测 `packages/cli/package.json` 现依赖仅 core/host/runtime/util/yaml，`packages/cli/tsconfig.json` 的 `references` 现仅 `../host`——两处都要加。

### §8-2 链校验改复用 `verify()`（R154）

初稿"照抄算法不另写一份"自相矛盾。复用后 `audit-report` 的职责收窄为：调 `verify()` + 异常归一（三态）+ 签名覆盖计数 + 锚定比对。**新边界要写清**：`verify()` 内部密钥加载先于验链（`chain/index.ts:183`），缺密钥时链断结论不可得——这正是 §2.2 把"缺密钥且未 `--no-signature`"归入退出码 2 的实现依据。

### §8-3 覆盖率 scope 收窄（R156）

`scope: 'chain/'` → `scope: 'chain/audit-report.ts'`。实测 `chain/` 目录 4 个现有文件不在覆盖率统计面，用目录前缀会一次性强制 5 个文件 100%（含 403 行的 `chain/index.ts`），这不是名单扩容是翻新。

### §8-4 / §8-5 误报口径钉死（R157）

投影：`runtime-missing`（链有库无，跳过）/ 库有链无（**计异常**，比链断裂严重）。锚定：`ledger-missing`（未锚定，跳过）/ `mismatch`（计异常）。两处都来自"读代码时推演调用方真实数据形态"——`projectionDiff` 的 `undefined` 参与比较、`features.b4` 未运行的空台账，都是初稿没有推演到的真实态。

### §8-6 其他修正

- 退出码 2 扩义"用法**或环境**错误"（R158）。
- §3.1 落点表补 `scripts/audit-selftest.ts`（初稿只在步骤 4 出现，与例外名单登记不一致）。
- §7 文件计数修正（初稿 4 源/改 4 → 实际 5 源/改 5）。
- script 命名红线：pnpm 内置 `pnpm audit`（依赖漏洞审计）会截胡裸 `audit` script 名，必须带冒号后缀（R158 同批写入 §4 步骤 4）。

### §8-7 复审结论

初稿的事实底座（§0 取证）与包边界（§3）**经复审全部成立**；错误集中在两类：**行号凭印象**（6 处）与**设计未推演真实数据形态**（4 处口径）。修订后本单可交付施工。

---

## §9 第二轮复审记录（2026-10-21 11:24）

> 复审姿势与 §8 相同，但这一次**重点复查 §8 修订本身引入的新断言**——修订稿也要过一遍实测，不能因为"复审过"就假定它正确。

### §9-0 复核 §8 修订稿引入的引用（3 处，全部成立）

| 新增引用 | 实测结果 |
|---|---|
| `chain/index.ts:183`（`verify()` 密钥先于验链加载） | ✔ 该行确为 `const keys = signedCount > 0 ? signingKeys(...) : undefined`，位于验链 `for` 循环之前 |
| `sign.ts:43`（Windows 权限豁免） / `sign.ts:59` / `sign.ts:64` / `run.ts:443` | ✔ 全部与声明行一致 |
| `sqlite.ts:18`（`loadSqlite`） | ✔ 该行确为 `export function loadSqlite()` |

### §9-1 最重发现：`createSagaStore` 会让审计器写盘并假绿（R159）

§8 修订稿把投影重算定为"用 `createSagaStore({ dbPath })` 注入"，这是**照搬** `packages/host/src/boot/plugins/saga.ts:83-87` 的模式——但那个调用方是**宿主装配**，本单是**只读审计**，两者的写权限要求完全不同。这是"照抄现成模式"时最容易滑过去的一处语义差。

实测三条（Node 内置 `node:sqlite`）：

```
1) new DatabaseSync(不存在路径)          → 创建文件 = true
2) new DatabaseSync(存在路径, {readOnly})→ OK
3) new DatabaseSync(不存在路径, {readOnly}) → 抛 ERR_SQLITE_ERROR
```

推导：audit 若走 `createSagaStore`，库不存在时**凭空建空库** → `listAllSagas()` 空 → 全链 `runtime-missing` → 全跳过 → **退出码 0 的假绿**。对审计工具而言，假绿比崩溃危险得多：它让使用者相信"这条链路是干净的"。同时 `migrate` + `journal_mode=WAL` 让即使库已存在也会写盘，违反 §1.1 目标 3。

修复+三重防线：
1. §1.1 目标 3 按**最强口径**重写——跑完目录零新增文件（含 `-wal` / `-shm`）；
2. §4 步骤 3 禁用 `createSagaStore`，改 `existsSync` 前置 + `readOnly: true` 直连 + 最小结构化 `loadTransaction` 注入后**仍复用 `projectionDiff`**（不重写 diff）；
3. 门禁 `verify-audit-cli` 第 5 条：源码内禁止出现 `createSagaStore` 标识符；负控 #8 专盯此分支。

**易错点已标**：Node 选项是 **`readOnly`**，不是 better-sqlite3 的 `readonly`；写错时 Node 会**忽略未知选项静默以可写方式打开**，防线失效而不报错。

### §9-2 其余三处（R160-R162）

- **R160 签名四态**：初稿"未验签"单一状态无法区分"没配密钥（退出码 2）"与"用户显式 `--no-signature`（退出码 0）"，两者退出码撞车。已扩为 `verified`/`invalid`/`skipped-no-key`/`skipped-disabled`。
- **R161 鸡生蛋**：门禁第 1 条要求 flag 与 `docs/audit.md` 一致，而该文档是同一步骤的产物 → 已明确"命令 + 文档 + 门禁同批落地"。
- **R162 帮助常量**：`bah audit --help` 需要自己的 `AUDIT_HELP`/`AUDIT_USAGE`，不可复用主命令 `HELP`/`USAGE`（后者被 `run.test.ts` 断言，也是 §4 步骤 1"现有测试零修改"的验收前提）。

### §9-3 第二轮复审结论

| 轮次 | 发现类型 | 数量 | 处置 |
|---|---|---|---|
| 第一轮（§8） | 行号凭印象 + 设计未推演真实数据形态 | 6 + 4 | 已修 |
| 第二轮（§9） | **照抄模式时的语义差**（写 vs 只读）+ 状态粒度过粗 + 交付顺序 | 1 重 + 3 轻 | 已修 |

§0 取证底座与 §3 包边界**两轮复审均成立**。§9-1 是本轮唯一会让上线后的 `bah audit` 输出错误安全结论的问题，已用"最强口径目标 + 实现禁用 + 门禁 + 负控"四重封住。

**本文档为终版，可交付施工。**

### §9-4 第二轮推翻第一轮的两处"修正"——复审方法本身的缺陷

第一轮曾把 `SIGNED_TYPES` 从 `31` 改成 `32`、`createSagaAudit` 从 `129` 改成 `130`，理由都是"初稿引到了注释行"。**这两处都是初稿对的、revision 错的。**

根因：两轮用的都是 `sed -n 'START,ENDp'` 读相邻几行，靠数偏移量定位——这是同一套容易出错的方法。第一轮据此把正确的行号改错，第二轮若继续用同样方法，很可能再错一遍。

**正确的校验方式（写入施工纪律）**：所有"文件：行号"引用必须 `grep -n '<符号声明>'` 取返回值，**不许靠读上下文推算**。本轮改用该方法后，一举揪出 5 处：`createSagaAudit` 129、`SIGNED_TYPES` 31、`anchorsPath` 354、`checkChainHealth` 301、`loadSqlite` 18。

### §9-5 终版自检

对本终版的**全部** 15 处行号引用做一次批量实校验 scripts/scripts（逐条 `sed -n` 取该行内容与声称符号比对），结果：

| 引用 | 该行实际内容 | 判定 |
|---|---|---|
| `run.ts:226` | `export function parseArgs(...)` | ✔ |
| `run.ts:443` | `return assertNever(reason, 'turn-end-reason')` | ✔ |
| `chain/index.ts:31` | `export const SIGNED_TYPES = [` | ✔ |
| `chain/index.ts:129` | `export function createSagaAudit(...)` | ✔ |
| `chain/index.ts:188` | `const expected = sha256Hex(prefix)` | ✔ |
| `chain/index.ts:196` | `bah-saga: signature-invalid: ...` | ✔ |
| `chain/index.ts:207-221` | `async function anchor(period)` 起始 | ✔ |
| `chain/index.ts:354` | `function anchorsPath(rootDir)` | ✔ |
| `sign.ts:28` | `export function loadSigningKeys(` | ✔ |
| `sign.ts:43` | Windows 权限豁免注释 | ✔ |
| `projection/index.ts:8` | 零 LLM、零外部调用（A3） | ✔ |
| `projection/index.ts:81` | `export function projectionDiff(` | ✔ |
| `alert/index.ts:301` | `export function checkChainHealth(...)` | ✔ |
| `saga-store/index.ts:170` | `const db = new Database(options.dbPath)` | ✔ |
| `saga-store/sqlite.ts:18` | `export function loadSqlite()` | ✔ |

**15/15 全部命中声明行。**

---

## §10 第三轮复审与施工裁决（2026-10-21，施工前）

> 复审基线实跑：`BAH_ALLOW_NO_SNAPSHOT=1 pnpm gate` **23/23**；`pnpm test` **143 文件 / 1266 用例**；`pnpm typecheck` / `pnpm lint` 0 错。§0 事实底座与 §3 包边界成立；§9-5 的 15 处行号也成立。以下条款**覆盖前文冲突处**，按本节施工。

### §10.1 裁决表（R163–R172）

| 编号 | 复审发现 | 施工裁决 |
|---|---|---|
| R163 | **`readOnly: true` 不是零写**：实测 WAL 库（`sessions/saga.sqlite` 即 WAL）打开后会在源目录生成并保留 `-wal` / `-shm`，R159 的“readOnly=零写”不成立；`immutable=1` 可零 sidecar，但有活动 `-wal` 时只读到已 checkpoint 的旧数据（实测 1 条 vs 2 条） | **干净库**用 `file:` URI + `immutable=1` + `readOnly: true` 打开；**存在非空 `-wal`** 时把 `db` 与 `-wal` 复制到 `%TEMP%` 下的临时目录，打开副本完成查询后删除。源目录**零新增文件**；不得调用 `createSagaStore` |
| R164 | **单次 `verify()` 无法同时产出 `chainOk` 与 `signatureState`**：它在验链前加载密钥（`chain/index.ts:183`），没有跳过验签的入口；`signature-invalid` 抛出后后续链是否断裂未知。§2.3 的 `chainOk: true` + `skipped-no-key` 无法实现 | 在 `chain/index.ts` 新增两个公开方法：`verifyContinuity(sagaId?)`（只验哈希连续性，不读密钥）与 `verifySignatures(sagaId?)`（只验签名，缺密钥抛 `signing-key-missing`）；两者共用私有 `rowHash(prev, row)`。**`verify()` 保持原行为**（密钥先于验链加载、逐行交织），既有测试零修改 |
| R165 | **文件清单漏项**：`run.ts` 分流、persistence barrel 导出、`scripts/coverage-allowlist.ts`、根 `package.json`、`scripts/docs-path-excludes.ts` 均未列入 §3.1；且 `packages/cli/src/cli/**` 已在 100% 覆盖率名单内，新增 CLI 文件自动受约束；新源码必须 `git add` 才能过 `tracked-sources` | 以 §10.2 的文件总表为准；步骤 1–5 每次只 `git add` 本单文件，不碰他人暂存改动；`pnpm test:coverage` 只对本单新增文件核验 100%（当前全仓红是他人 5 个文件的既有缺口，见 R171） |
| R166 | `buildChainAudit(rows, options)` 被称为“纯函数”，但复用 `verify()` 需要 `ChainFile` / `rootDir` / 密钥路径，API 自相矛盾 | 改为端口注入：`buildChainAudit(chain: ChainFile, audit: SagaAuditHandle, sagaId, options)`；`options` 只含 `skipSignature`。函数本身不做 IO，IO 由传入的端口承担，单测可注入假 handle |
| R167 | **锚定口径两个洞**：`anchor()` 对 `<dir>` 下全部链按 period 求 Merkle，`--saga` 子集重算必然 mismatch；`loadAnchors` 对损坏台账静默返回空 Map，损坏被误报成 `ledger-missing` | 锚定**始终按目录下全部链**计算，`--saga` 不改变叶子集；`anchors[].state` 扩为五态：`matches` / `mismatch` / `ledger-missing` / `ledger-invalid` / `orphan-ledger`。`ledger-invalid`（台账存在但 JSON/形状非法）与 `orphan-ledger`（台账有 period、链上无叶子）均计退出码 1 |
| R168 | **退出码优先级未定**；`signedPresent < signedExpected` 无归宿；`chain-line-invalid` 未归类；JSON 契约实际没有被门禁锁住 | 退出码优先级：**确定异常（1）> 未完成检查（2）> 通过（0）**；用法/环境错误（解析失败、`--dir` 不存在、无任何可审计链、DB 存在但 schema 不可读）直接 2。签名覆盖改为**类型内一致性**：某白名单类型只要有一条带 `sig`，该类型全部行都必须带；整类无签名视为写入方配置排除，记入 `unsignedTypes` 信息项、不计异常。`chain-line-invalid` 计 1。JSON 契约由 `verify-audit-cli` 的运行时夹具 + `audit.test.ts` 双重锁定 |
| R169 | **负控 #1 不会自动变红**：链测试与 `verify-audit-chain` 都是同一实现写、同一实现验，改哈希算法两边一起变，测试仍绿 | `audit-report.test.ts` 增加**固定 golden fixture**：预置 `p/r` 的 JSONL（不经过当前写入器），断言 `verifyContinuity` 通过；改 `rowHash` 后该 fixture 必须红。负控 #1 以该 fixture 为准 |
| R170 | §0.4 说生产白名单只有 4 类；实测 `SIGNED_TYPES` 含 `saga/residual-recorded`，生产也在写，实际 **5 类** | §0.4 已改；验收计数按 5 类，不按 4 类 |
| R171 | `pnpm test:coverage` 当前**全仓红**：`bank/tools/governance.ts`、`bank/tools/tier.ts`、`host/boot/plugins/approval.ts`、`host/boot/plugins/sandbox.ts`、`llm/llm/assemble.ts` 是他人未完成改动，与本单无关 | 本单**只负责** `audit-report.ts` 与新增 CLI 文件的 100% 覆盖；最终回执必须给出这些文件的 coverage-summary 数字，并明确记录“全仓 test:coverage 仍红，原因不在本单”。不修他人文件 |
| R172 | R151 的 `docs-paths` 红项已过时；当前实跑为绿（22 文档 / 425 引用 / 例外 32 / 命中 36）；`sessions/saga.sqlite` 存在但 **0 条事务**，§0.2 未提及 | 本条不阻塞施工；`docs/audit.md` 必须写明“本仓生产链为空 + `saga.sqlite` 当前为空库”，避免使用者误判 |

### §10.2 修订后的文件落点总表（以此为准）

| 文件 | 性质 | 归属步骤 |
|---|---|---|
| `packages/cli/src/cli/command.ts` | 新增：`parseCommand` + `Command` 封闭联合 | 1 |
| `packages/cli/src/cli/command.test.ts` | 新增：路由与占位退出码 | 1 |
| `packages/cli/src/cli/audit.ts` | 新增：flag 解析、`AUDIT_HELP` / `AUDIT_USAGE`、编排与输出 | 1（占位）/ 2（主体） |
| `packages/cli/src/cli/audit.test.ts` | 新增：flag/退出码/文本/JSON 契约 | 2 |
| `packages/cli/src/cli/audit-projection.ts` | 新增：immutable / 临时副本 + 投影重算 + 反向缺口 | 3 |
| `packages/cli/src/cli/audit-projection.test.ts` | 新增：WAL/sidecar/零写/反向缺口 | 3 |
| `packages/cli/src/cli/audit-anchors.ts` | 新增：全局 Merkle 比对 + 五态 | 3 |
| `packages/cli/src/cli/audit-anchors.test.ts` | 新增：matches/mismatch/ledger-missing/ledger-invalid/orphan | 3 |
| `packages/persistence/src/chain/audit-report.ts` | 新增：`buildChainAudit`（端口注入） | 2 |
| `packages/persistence/src/chain/audit-report.test.ts` | 新增：golden fixture + 四态签名 + 类型内覆盖 | 2 |
| `packages/persistence/src/chain/chain.test.ts` | 修改：`verifyContinuity` / `verifySignatures` / `verify()` 行为不变 | 2 |
| `packages/persistence/src/chain/index.ts` | 修改：`rowHash` + 两个新公开方法；`verify()` 行为不变 | 2 |
| `packages/persistence/src/index.ts` | 修改：导出 `./chain/audit-report.ts`（不放 `chain/index.ts`，避免循环） | 2 |
| `packages/cli/src/cli/run.ts` | 修改：`runCli` 分流；`parseArgs` 一行不改 | 1 |
| `packages/cli/src/cli/index.ts` | 修改：导出 `parseCommand` / `Command` / `runAudit` / `AUDIT_HELP` / `AUDIT_USAGE` | 1 |
| `packages/cli/package.json` | 修改：`dependencies` 增 `@bah/persistence`、`@bah/saga` | 2 |
| `packages/cli/tsconfig.json` | 修改：`references` 增 `../persistence`、`../saga` | 2 |
| `scripts/coverage-allowlist.ts` | 修改：新增 `scope: 'chain/audit-report.ts'` | 2 |
| root `package.json` | 修改：新增 `audit:selftest` 脚本（带冒号后缀） | 4 |
| `scripts/audit-selftest.ts` | 新增：造链 → 审计 → 清理 | 4 |
| `scripts/verify-audit-cli.ts` | 新增：门禁 | 5 |
| `docs/audit.md` | 新增：命令面文档 | 5 |
| `scripts/docs-path-excludes.ts` | 修改：删除施工单 16 的 8 条待建路径 | 5 |
| `PROGRESS.md` | 修改：追加 §47 回执（**不提交他人已暂存的 §45 内容**；见 §10.4） | 5 |

### §10.3 行为口径补充

**签名四态不变**：`verified` / `invalid` / `skipped-no-key` / `skipped-disabled`。`skipped-no-key` 只在 `signedExpected > 0` 且缺密钥时出现；若链上没有任何“类型内应签”的行，缺密钥不影响结论。

**投影态**在原文四态基础上增加：`skipped-disabled`（用户 `--no-projection`）、`skipped-chain-broken`（链断，投影无意义）、`db-invalid`（库存在但 schema 不可读，退出码 2）。`skipped-no-db` 仍不计异常。

**锚定态**五态见 R167。锚定叶序必须用 `ChainFile.readAll()` 的稳定排序（`recordedAt, s, q`），与 `anchor()` 同口径。

**退出码判定顺序**：
1. 解析/用法/环境失败 → 2；
2. 任一确定异常 → 1；
3. 无确定异常但有 `skipped-no-key` → 2；
4. 否则 → 0。

**JSON 契约**新增 `reverseGaps`、`exitCode`、`db` 字段；`audit.test.ts` 断言字段集合，`verify-audit-cli` 用临时链跑一次真实命令并比对同一集合。

### §10.4 五次提交计划

| # | 提交信息 | 只包含 |
|---|---|---|
| 1 | `feat(cli): 子命令路由骨架（bah audit 占位）` | §10 文档、`command.ts`、`command.test.ts`、`audit.ts` 占位、`run.ts`、`cli/index.ts` |
| 2 | `feat(persistence): 拆分链连续性与验签核验` | `chain/index.ts`、`chain.test.ts`、`audit-report.ts`、`audit-report.test.ts`、CLI audit 主体、依赖/引用/覆盖率名单 |
| 3 | `feat(cli): bah audit 投影与锚定只读审计` | `audit-projection.ts`、`audit-anchors.ts` 及测试 |
| 4 | `test(cli): audit:selftest 造链自证` | `scripts/audit-selftest.ts`、root `package.json` |
| 5 | `feat(gate): verify-audit-cli 与命令文档` | `scripts/verify-audit-cli.ts`、`docs/audit.md`、例外名单清理、`PROGRESS.md` |

**提交纪律**：当前索引里已有他人暂存的 §45 内容。每次只用 `git commit --only <本单路径>`，禁止裸 `git commit`；`PROGRESS.md` 与 `scripts/docs-path-excludes.ts` 若含他人改动，只写工作树、不强行入库，并在回执中说明。新源码在跑 `pnpm gate` 前必须显式 `git add`（`tracked-sources` 要求）。

### §10.5 验收清单（覆盖 §7）

- [ ] `pnpm test` 全绿；`pnpm typecheck` / `pnpm lint` 0 错
- [ ] `pnpm gate` **24/24**（含新增 `verify-audit-cli`）
- [ ] `pnpm test:coverage`：本单新增文件 100%；他人 5 个文件的既有红项在回执中单列
- [ ] `pnpm audit:selftest` 退出 0，输出“造链 42 事件 → 审计通过”
- [ ] 零写验收：临时目录跑完前后条目一致，**无 `-wal` / `-shm` 新增**
- [ ] `git diff HEAD -- packages/cli/src/cli/run.test.ts` 为空
- [ ] `docs/audit.md` 显著位置写明 R145（生产链为空）、R146（私钥不在仓库）、R172（`saga.sqlite` 当前为空库）
- [ ] `PROGRESS.md` §47 回执包含 R163–R172 的落地状态

### §10.6 负控更新（覆盖 §5）

| # | 注入 | 期望 |
|---|---|---|
| 1 | 改 `rowHash`（如去掉 `prev` 拼接） | golden fixture 单测红；证明审计器与链实现共用同一哈希入口 |
| 2 | 退出码恒 0 | 投影 diff≠0 / 链断用例红 |
| 3 | `audit-report.ts` import `@bah/saga` | 门禁第 4 条红 |
| 4 | `docs/audit.md` 多写一个 flag | 门禁第 1 条红 |
| 5 | 删 `assertNever` 收尾 | 门禁第 2 条红 |
| 6 | `parseArgs` 未知参数改成退出码 1 | 现有 CLI 测试红 |
| 7 | 删 `runtime-missing` 分支 | 对应单测红 |
| 8 | 把 `immutable` 改回普通 `readOnly` | 临时库出现 `-wal`/`-shm`，零写用例红（R163） |
| 9 | 有活动 `-wal` 时不走临时副本 | 临时副本用例红；源目录仍不得新增 |
| 10 | 把损坏的 `anchors.json` 当 `ledger-missing` | `ledger-invalid` 用例红 |
| 11 | 用 `--saga` 过滤锚定叶子 | 全局 root 用例红 |

**本文档以 §10 为施工口径；§8/§9 保留为复审历史。**
