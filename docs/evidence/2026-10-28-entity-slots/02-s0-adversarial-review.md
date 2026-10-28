# S0 对抗式复审（ES-00 … ES-04）

> 复审时间：2026-10-28 14:19–14:35 +0800
> 复审对象：S0 工作树（未提交态），基线 HEAD `c7a25ab`
> 复审方式：先按 06 的 A（验收/契约）清单逐条取证，再按 B（对抗/回归）清单**主动尝试证伪**
> 结论：**可提交**（门禁 36/36），但附带 1 条方案缺口与 3 条前向风险，见 §4。

---

## 1. 改动清单（6 文件 + 1 证据目录）

| 文件 | 改动 | 性质 |
|---|---|---|
| `packages/bank/src/forge/index.ts` | `buildDemo` 的 `u-1.name`：王建国 → 张三（加两行说明注释） | 数据面 |
| `packages/bank/src/forge/index.test.ts` | describe/it 标题；`expect(user?.name)` 王建国 → 张三 | 测试 |
| `packages/bank/src/tools/queries.test.ts` | it 标题「demo 王建国」→「demo 张三」 | 测试 |
| `docs/bank.md` | §5 用户行；§7 T-BANK-009 用例名 | 文档 |
| `profiles/headless/patch.yml` | 注释「demo 用户（王建国）」→「（张三）」 | 注释 |
| `snapshots/sandbox-compute/reverified.json` | `sourceDigest` 更新（见 §3） | 派生 |

`git diff --stat`：6 files changed, 11 insertions(+), 9 deletions(-)——无整文件重写、无行尾翻转
（`git ls-files --eol` 仍为 `i/lf`，工作树 CRLF/LF 混杂是 `core.autocrlf=true` 的既有状态）。

---

## 2. A 角度（验收 / 契约）

| # | 判据 | 取证 | 结论 |
|---|---|---|---|
| A1 | 数据集主体 = 张三 | 探针实测 `users[0]: u-1 张三 13800001111` | ✅ |
| A2 | 收款人仍是王建国、仍是白名单 | 探针：`p-1:王建国:whitelist` | ✅ |
| A3 | 流水对手方仍是王建国（演示故事不塌） | 探针：`t-5.counterparty.name = 王建国` | ✅ |
| A4 | 账户与金额未被动到 | 探针：`a-1,a-2,a-3`；余额由既有测试逐字断言 `¥12,345.67` | ✅ |
| A5 | 静态画像全部一致 | `grep -A2 runtimeContext` → web / web-plan / headless(`patch.yml` + 5 个变体) 全为 `张三` | ✅ |
| A6 | `demoUserId` 未被改动 | `grep demoUserId profiles/` → headless/plan/web/web-plan 全为 `u-1` | ✅ |
| A7 | 方案指定的 grep 自检 | `grep -rn "用户.*王建国\|王建国.*用户" docs profiles \| grep -v 收款人` → **0 命中** | ✅ |
| A8 | 数字不变 | 205 文件 / 2115 用例；6 文件 / 23 例；门禁 36/36（均与基线一致） | ✅ |

补充：方案的 ES-03 要求"`profiles/web-plan/patch.yml` 若注释有'王建国 = 用户'才改"。实测该文件
只有 `张三`，**无需改动**——不做无意义 diff。

---

## 3. B 角度（对抗 / 回归）

### B1 快照是否真的对姓名不敏感（核心假设）

```
grep -rl "王建国" snapshots/     → plan / web-channel（scenario.json、scenario.ts、session.jsonl、snapshot.test.ts）
```

逐条看上下文：全部是 **收款人**（`payee.name`、`payeeName`、`payeeId=p-1`、`给王建国转 800 元`）与
`snapshot.test.ts` 的一条**负控**（`expect(planEvents).not.toContain('王建国')`）。
**没有一处是 demo 用户姓名** ⇒ 改名不可能改到快照内容。

实测印证：改名前后 `pnpm test:snapshot` 均 6/23 绿，`git status` 里快照文件零 diff。

### B2 是否有隐藏的"姓名耦合"

- demo 路由脚本 `packages/llm/src/demo/router.ts` 不含任何姓名常量（只按意图/金额/收款人解析），
  改名不影响路由判定；
- 全仓 `git grep 王建国` 的剩余命中逐一分类：`apps/web` 输入框占位符、`docs/*` 转账示例、
  `mock.test.ts` / `governance*.test.ts` / `transfers.test.ts` 等夹具——**全部是收款人语境**；
- 唯一断言数据集用户名的测试只有 `forge/index.test.ts`（已同步）。

### B3 提交形态：方案说"必红"，实测能否绿

方案 PA-13 / §8 断言"S0 单独提交必红"。**实测属实**：

```
$ npx tsx scripts/run-gates.ts      # 已改代码、未提交、未核验
✘ snapshot-fresh
  · packages/bank/src/forge/index.ts: 由场景 sandbox-compute 覆盖，但本次没有重录
```

但方案**漏掉了门禁自己留的等价改动通道**：`scripts/verify-snapshot-fresh.ts` 的 `fresh` 判据除
`session.jsonl` / `llm.jsonl` 外，还接受**本次改动集里的 `reverified.json` 且其摘要与当前源码一致**；
该文件由 `pnpm snapshot:reverify` 生成，前置条件是"回放全绿"，摘要一变即失配。

实测：

```
$ NODE_EXTRA_CA_CERTS= pnpm snapshot:reverify
  Test Files 6 passed / Tests 23 passed
  + sandbox-compute: 已写入核验记录
  = compaction / headless-basic / plan / web-channel: 摘要未变
$ npx tsx scripts/run-gates.ts
  全部通过（36/36）
```

`reverified.json` 的 diff 只有 `sourceDigest` 一行（`4bbb175…` → `1544ac1…`），note 不改写。

### B4 **finding（P2）· 覆盖台账是倒挂的**

| 场景 | datasetTier | 是否执行 `buildDemo` | coveredSources 是否含 `packages/bank/src/forge/` |
|---|---|---|---|
| compaction | demo | **是** | 否 |
| headless-basic | demo | **是** | 否 |
| plan | demo | **是** | 否 |
| web-channel | demo | **是** | 否 |
| sandbox-compute | **stress** | **否**（走 `buildStress`） | **是** |

⇒ 门禁对"改了 `forge/`"要求的证明，落在**唯一不跑这段代码**的场景上。
本次无害（改动对输出无影响，且 4 个 demo 场景回放全等已证明"快照读不到姓名"），
但这意味着 **`reverified.json` 这次只能声明"回放通过"，不能声明"改名被快照验证"**——
真正的背书面是 `forge/index.test.ts` 的断言。

收口要求（交 S4）：`entity-slots` 必须用 **demo 档**（这样才真跑 `buildDemo`），并在它的
`coveredSources` 里声明 `packages/bank/src/forge/`；是否把 forge 从 sandbox-compute 的声明里移走，
由 S4 一并裁决。

### B5 **finding（P2，前向）· 陈旧摘要没有门禁**

`reverified.json` 的摘要覆盖的是整个 `coveredSources`（含 `runtime/system-prompt`、`host/boot` 等）。
S1 一动 runtime，`sandbox-compute` 的摘要立刻过期，而**没有任何门禁检查"摘要是否等于当前源码"**——
只在"该文件本次也有改动"时才校验。⇒ S4 收尾必须重跑一次 `snapshot:reverify`，否则仓库里会留一条
"已核验"的假台账。这条不在本批修，登记为 S4 收口项。

### B6 **finding（P2，前向）· plan profile 没有静态姓名**

`profiles/plan/patch.yml` 有 `demoUserId: u-1`，但**没有** `runtimeContext.user.name`。
S3 的 `slots-user-mismatch` 若按"静态未写姓名 = 不一致"实现，会把这个 profile 判红。
⇒ 正确判定是"静态姓名缺省 → 跳过一致性检查"，S3 施工时必须显式覆盖这条。

### B7 回归面复核

- 全量：205 / 2115 绿（与基线同数，改名不改用例数）；
- 指标测试：`forge` + `queries` 31 例绿；
- 门禁：36/36（含 `verify-assertions`、`verify-docs-consistency`、`verify-snapshot-fresh`）；
- 未跑 `pnpm typecheck`：本次只改字符串字面量、注释与测试标题，无类型面变化（S1 起按方案跑）。

### B8 尝试证伪但未成立的假设

| 假设 | 取证 | 结果 |
|---|---|---|
| "改收款人也跟着变" | `forge/index.ts` 收款人块与 `t-5` 未进 diff | 未成立 |
| "前端夹具会把用户名当收款人渲染" | `apps/web` 命中均为占位符/示例文案 | 未成立 |
| "改名会让 `slots-user-mismatch` 误红" | 8 个 profile 静态名全为张三 | 未成立（反而消除未来误红） |
| "重录会悄悄改写快照" | 快照 6 文件零 diff | 未成立 |

---

## 4. 复审结论

**可提交。** 阻断项 0 条。附带的 4 条 finding：

| # | 级别 | 内容 | 处置 |
|---|---|---|---|
| F1 | P1（方案缺口） | PA-13"S0 单独提交必红"不完整：漏了 `reverified.json` 等价改动通道 | 已在本记录更正；方案 06 的该行需更新口径 |
| F2 | P2 | 覆盖台账倒挂（demo 场景不认 forge，认 forge 的场景跑 stress） | S4 由 entity-slots 收口 |
| F3 | P2 | `reverified.json` 摘要陈旧无门禁 | S4 收尾重跑 `snapshot:reverify` |
| F4 | P2 | `profiles/plan` 无静态姓名，S3 守卫需按"缺省即跳过"实现 | S3 施工项 |

**口径边界（对外不许讲的话）**

1. 不许讲"实体槽位已通电"——S1–S4 未施工，本批只修了主体姓名错位；
2. 不许讲"改名已被快照验证"——本次快照零 diff，验证来自单元测试；
3. 可以讲"演示主体与静态画像已对齐（张三），收款人仍是王建国"。
