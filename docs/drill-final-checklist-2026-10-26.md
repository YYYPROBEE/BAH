# 12 点终检清单（W20 · 2026-10-26）

> 用法：交付前逐条跑「复核命令」，**只看命令输出**，不看本文的历史结论。
> 12 条全 ✅ 才算"能交"。本轮实测：**12/12 ✅**，基准提交 `4f95f4b`。
> 全部复核命令都在仓库根执行；`NODE_EXTRA_CA_CERTS=` 前缀是必需的（本机变量指向不存在的证书）。

## 汇总

| # | 检查点 | 判据 | 本轮实测 | 结论 |
|---|---|---|---|---|
| 1 | 工作区干净、提交完整 | `git status --porcelain` 为空 | 0 行；HEAD `4f95f4b` | ✅ |
| 2 | 类型 | `tsc -b` 退出码 0 | exit 0 | ✅ |
| 3 | 主测试面 | `pnpm test` 全绿 | 194 文件 / 1951 例 | ✅ |
| 4 | 门禁 | `pnpm gate` **不带逃生口** 34/34 | `全部通过（34/34）` | ✅ |
| 5 | 覆盖率双口径 | 行 ≥80% 且 包 ≥14/16 | 行 **84.49%**（29163/34517）/ 包 **14/16** | ✅ |
| 6 | 快照面 | 18 例绿、`snapshot-fresh` 无逃生口绿 | 5 文件 / 18 例；门禁 34/34 | ✅ |
| 7 | 演示脚本 | `demo-plan.ts` 断言全过 | 3 幕 / 10 条断言 | ✅ |
| 8 | Web 端到端 | 200 / 401 / 403 / 202 + 审批走完 | 见 §8 表 | ✅ |
| 9 | 评测平面 | eval 60 场景 + 基线比对 + 对抗集 | 49-49 / 5-5 / 6-6；41-44 | ✅ |
| 10 | 数字一致性 | 文档里的数与命令输出一致 | 抽查 4 处一致 | ✅ |
| 11 | 已知限制可当场念 | 7 条 + 偏差可查 | `docs/security-design.md` §4 七条 | ✅ |
| 12 | 交付物齐全 | 代码/契约/ADR/三份材料/演练材料 | 见 §12 | ✅ |

## 逐条

### 1. 工作区干净、提交完整

```bash
git status --porcelain | wc -l     # 期望 0
git log --oneline -1               # 期望看到本轮提交
```

实测：`0`；`4f95f4b fix(gate): snapshot-fresh 关红 + W20 演练材料三件`。

> 本文自身随下一个提交入库，所以 `git log -1` 会看到比 `4f95f4b` 更新的 HEAD——
> 那是文档提交，代码面以 `4f95f4b` 为准。

⚠ 注意：`.tmp-*` 是 `.gitignore` 覆盖的草稿目录（含 W18 录屏草稿）。它们**不进库**，
但也不要当成"已清理"——磁盘上仍在，只是不影响交付。

### 2. 类型

```bash
npx tsc -b tsconfig.host.json tsconfig.client.json
```

实测 exit 0（全仓 `noUncheckedIndexedAccess: true`）。

### 3. 主测试面

```bash
NODE_EXTRA_CA_CERTS= pnpm test
```

实测：`Test Files 194 passed`、`Tests 1951 passed`。

### 4. 门禁（不许带逃生口）

```bash
pnpm gate
```

实测：`全部通过（34/34）`，exit 0。

**这一条是本轮的重点**：修之前必须 `BAH_ALLOW_NO_SNAPSHOT=1` 才绿。现在干净树上直接绿。

### 5. 覆盖率双口径

```bash
pnpm test:coverage:all
```

实测：

```text
行口径      84.49%   （覆盖 29163 行 / 参与统计 34517 行）
包口径      14/16 个包 ≥80%
✔ 达标：行口径 ≥80%（实测 84.49%）、包口径 ≥14/16（实测 14/16）
```

⚠ 报数规则：**两个口径必须一起说**。只说 84.49% 会被问分母；只说 14/16 会被问是哪个口径。
两个未达标包（`memory-store` 72.71% / `eval` 40.73%）是显式放弃，理由在 `docs/testing.md` §3。

### 6. 快照面

```bash
NODE_EXTRA_CA_CERTS= npx vitest run --config vitest.snapshot.config.ts
```

实测：5 文件 / 18 例绿。四个场景（`headless-basic` / `sandbox-compute` / `web-channel` / `plan`）
本轮全部重录过，录制产物与当前装配同源。

### 7. 演示脚本

```bash
NODE_EXTRA_CA_CERTS= npx tsx scripts/demo-plan.ts
NODE_EXTRA_CA_CERTS= npx tsx scripts/demo-plan.ts --pace=220   # 录屏用，9.3 s
NODE_EXTRA_CA_CERTS= npx tsx scripts/demo-plan.ts --only=diamond
```

实测：三幕 10 条断言全过；`--only` 时收尾只对跑过的断言下结论（3 条），不把没跑的算成通过。

### 8. Web 端到端

起服务（7331 必须空闲；固定 token 便于脚本化）：

```bash
BAH_KNOWLEDGE_KEY=demo-key-not-for-prod BAH_WEB_TOKEN=w20-demo-token \
  npx tsx packages/cli/src/main.ts --profile web --serve \
  --patch .tmp-w20-web-router.yml --jsonl .tmp-w20-web --session s-w20-web
```

| 步骤 | 实测 |
|---|---|
| `GET /` | **200**（同时下发 `bah_csrf` cookie） |
| `POST /api/turn` 无 Bearer | **401** `web-unauthorized` |
| `POST /api/turn` 有 Bearer、无 CSRF | **403** `web-csrf-required` |
| `POST /api/turn` + `Origin` + `x-bah-csrf` | **202** `{"ok":true}` |
| SSE 帧 | `tool` 2 / `approval` 1 / `dag` 1 / `audit` 14 / `message` 2 / `turn` 1 |
| 审批帧六要素 | `¥800.00` / `王建国` / `¥0.00` / `tier=yellow` / `ticketId` / `callId` |
| 批准后 | `{"ok":true}`；会话 59 事件；`ticket/redeemed` 1；回复"已为你在模拟环境完成 800 元转账…" |

收尾（**必须做**）：

```bash
# Windows：按端口反查 PID 再杀；TaskStop 只杀 shell 包装
# 然后确认监听数为 0
```

浏览器里"真点一次批准"的证据在 `PROGRESS.md` §85.4 ②（W18 已实测，本轮用脚本复核同一条链路）。

### 9. 评测平面

```bash
NODE_EXTRA_CA_CERTS= npx tsx scripts/eval.ts
NODE_EXTRA_CA_CERTS= npx tsx scripts/eval.ts --baseline-check
NODE_EXTRA_CA_CERTS= npx tsx scripts/eval.ts --adversarial
```

实测：60 场景 / boot 8 / 49-49 / 5-5 / 6-6 / 1.25 步；基线比对四项全过；
对抗 45 例（分母 44，排除 1 例 `[unverified]` 来源）总拦截 **41/44**，幻觉族 12/15 有 3 例 `rule-gap`。

### 10. 数字一致性（抽查四处）

| 数 | 文档写的 | 命令输出 |
|---|---|---|
| 用例数 | `docs/testing.md` §1 表：194 文件 / 1951 用例 | `pnpm test` 一致 |
| 快照例数 | 同表：5 文件 / 18 用例 | 快照面一致 |
| 覆盖率 | 同文档 §3：行 84.49% / 包 14-16 | `pnpm test:coverage:all` 一致 |
| CI 步数 | 同文档 §1：14 步 | `grep -n "name: '" scripts/ci.ts` 一致 |

⚠ 交接件里那句"`replay.ts --verify` 单跑"是错的（必须配 `--session`），已在
`docs/drill-6-commands-2026-10-26.md` §3 偏差 D1 登记。

### 11. 已知限制可当场念

```bash
sed -n '/^## 4/,/^## 5/p' docs/security-design.md
```

七条：HP-2 RAG 响应信封签名 / HP-4 工具出参运行时契约校验 / 强验证接真实渠道 /
对抗集 H-13~H-15 召回缺口 / plan 内写工具的补偿 / plan 动态 args 跨 `resume` / `incident` 真实触发源。

另有三处本轮新增偏差（`PROGRESS.md` §92.7）：`sandbox-compute` 的 `【未核实】`、
`saga/src/compensation/` 无快照覆盖、`plan` 场景声明多于实证。

### 12. 交付物齐全

```bash
ls docs/contracts docs/adr docs/drill-*-2026-10-26.md
```

| 类 | 位置 |
|---|---|
| 代码 | `packages/`、`apps/`、`snapshots/`、`scripts/` |
| 契约（冻结） | `docs/contracts/event-table.md`、`tool-contract.md`、`scenario-dsl.md` |
| ADR | `docs/adr/` |
| 三份材料 | `docs/architecture.md`、`algorithms.md`、`security-design.md` |
| 演练材料 | `docs/drill-6-commands-2026-10-26.md`、`drill-qa-100-2026-10-26.md`、`drill-rehearsal-2026-10-26.md`、本文 |
| 评测证据 | `.ci-artifacts/eval/summary.md`、`adversarial-summary.md`（报表不进库，可重跑） |

## 交不交的最后一句

12 条全绿**不等于**没有缺口，等于"缺口都写在账上了"。
第 11 条那十处（7 + 3）是唯一的"不许临场编"的地方——照着文档念，不要即兴发挥。
