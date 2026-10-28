# S6 · A/B 双角度复审（2026-10-28）

范围：S0–S5 全部交付（策略外置），取证以仓库事实与 `s6/` 证据为准。
结论：**行为面 P0/P1 = 0；交付面 P0/P1 = 0**；残余 P2 见文末，不阻塞签收。

## A 角度（验收/契约）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| A1 | 生产 bundle 编译/lock/语料/覆盖 | ✔ | `02-compile.log`、`04-corpus.log`、`05-equivalence.log` |
| A2 | 改规则只改文件，判决改变 | ✔ | demo 1.1.0 单笔 ≥800 元升红；`policy-externalized` 快照（yellow→red） |
| A3 | 生产路径不再直接调用 legacy 升级 | ✔ | `08-gate.log` 的 `policy-hardcode`（26 个银行工具源文件） |
| A4 | `tier/decided` 四字段 | ✔ | 单测 + `snapshots/policy-externalized/session.jsonl` |
| A5 | 链有 `policy/decision`，哈希/签名可验 | ✔ | `audit-decisions.test.ts`（`d = sha256(canonicalJson(data))`）；签名流程见 `s5-key-lifecycle.log` |
| A6 | `policy:explain` 复现历史判决 | ✔（样本 1 条）/ P2 | `12-explain.log`：快照 `call-create` `reproduced yes`；"20 条真实判决"仍只有快照样本，列入 P2 |
| A7 | 两会话命中不同版本，指标按版本分组 | ✔ | `14-canary.log`：`1.1.0` vs `1.0.0` |
| A8 | `policy:rollback` 后回到旧版 | ✔ | `15-rollback.log`：1.0.0 → 1.1.0 → 1.0.0 |
| A9 | gate/typecheck/全量/快照 | ✔ | `08-gate.log` 40/40、`09-vitest.log` 221/2481、`10-snapshot.log` 8/34；typecheck 见 `check` 日志 |
| A10 | 文档口径无提前宣称 | ✔ | `19-docs-grep.log`；"防篡改"只出现在否定句 |

## B 角度（对抗/回归）

| # | 判据 | 结果 | 证据 |
|---|---|---|---|
| B1 | 35 条负控应红即红 | ✔ | `s6/negative-controls.log` |
| B2 | 引擎异常/缺服务/坏输入 → deny | ✔ | `policy.test.ts`（input/engine-error）+ `governance` 单测 |
| B3 | 降级规则编译期拒绝 | ✔ | fixtures `downgrade` / `policy-lower-tier` |
| B4 | 策略 deny 不拦绿级；allow 不降级 | ✔ | `governance` TC-W04-06/07 |
| B5 | 未绑定/锁定/预检顺序不被绕过 | ✔ | `governance` 单测（顺序未改；sentry 在允许路径追加拒绝） |
| B6 | 回放钉版本；归档缺失显式失败 | ✔ | `12-explain.log`（require-chain）+ `s4-explain-round2.log` §4 |
| B7 | 并发重载无撕裂 | ✔ | `17-concurrency.log`：100 判决 × 10 重载，1 种结果指纹 |
| B8 | 快照 diff 只含计划内字段/事件 | ✔ | `11-snapshot-diff.md` |
| B9 | 无第二真相源 | ✔ | `policy-hardcode`：`escalateTransferTier` 只许 tier/policy |
| B10 | 性能预算 | ✔ | `18-bench.log`：compile 2.156 ms（<5）、eval p99 6 µs（<20） |
| B11 | kill switch 演练 | ✔ | `20-kill-switch.log`：legacy turn 正常完成 |
| B12 | evidence 无 PII | ✔ | 证据包逐份抽查：只有枚举/整数分/摘要，无姓名/尾号/备注 |
| B13 | 路径穿越/超大 bundle/超深表达式被拒 | ✔ | fixtures `path-escape` / `too-deep-expr` / `too-many-*`；sentry 长度/字符类/规则数上限单测 |
| B14 | rollout 链断 → 审计红 | ✔ | `negative-controls.log` #29：`断裂@7`，exit=1 |
| B15 | `pnpm check` 14 步（e2e 无 key 记 SKIP） | ✔ | 13 步绿 + e2e SKIP（提交前最后一次跑批） |

## 残余（P2，不阻塞签收）

1. **A6**：`policy:explain` 只对快照样本复现；"20 条真实判决"需要更多真实会话回放（赛后可补）。
2. **sentry bundle 未激活**：`profiles/*` 仍 legacy（R10）；切生产要等线上影子/FP 数据。
3. **覆盖率台账**：`docs/coverage-baseline.json` 仍是 CI 口径（Windows 本机分母失真），
   需 CI 跑批刷新（PE-46）。
4. **semver major 门禁**：只有 1.0.0 生产版本，规则为 no-op；新增 1.1.0 生产版本前必须补。

## 签收

- 0 个 P0/P1 未闭合；
- 行为面：S0–S5 的判决语义、审计、灰度、回滚、负控全部有命令/证据；
- 交付面：`pnpm check` 13 步绿 + e2e SKIP，`gate` 40/40；
- 对外口径：**"S0–S5 完成；S6 复审通过（残余 P2 已登记）"**；
  仍不得说"生产已切 sentry 外置规则""策略文件防篡改（生产未启用签名）""多租户策略隔离"。
