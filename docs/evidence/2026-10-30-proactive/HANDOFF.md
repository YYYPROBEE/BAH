# HANDOFF · 跨场景主动能力补全（2026-10-30）

> 分支 `proactive-01`（worktree `BAH/PROACTIVE-WT`），基于 `main@1c369b3`。
> 最近三次提交：`b9582be`（R0–R4）→ `fa0eec4`（R6 门禁）→ `a5fc982`（R5 商户腿）。

## 1 已完成（全部有测试/门禁）

| 阶段 | 交付 | 证据 |
|---|---|---|
| R0 | ADR-0008（票据携带授权来源）、`DECISIONS.md` 六条签认 | `docs/adr/0008-ticket-authorization.md` |
| R1 | `ticket/*` 可选 `authorization`、`ApprovalFrame.confirmText` + 服务端校验 | `interaction/src/approval/authorization.test.ts`、`channels/src/web/adapter.test.ts` |
| R2 | `runtime/src/authorization`（窗口/到期/周期/armed 回放）、`fact`、`notify` | 6 个单测文件（50 例） |
| R3 | `plan_arm/disarm/wake`、`plan:scheduler`（boot 补跑 + `saga/tick`）、`fact:store`、CLI `bah plan` | `host/src/boot/plugins/authorization.test.ts`（10 例，含"重启补跑"） |
| R4 | `plan-card` 帧 + 桌面/移动视图 + `verify-frame-closure`（I-F1..F4） | `project.plan-card.test.ts`、`plan-card.test.js`、门禁自测 7 例 |
| R5 | 商户域最小版：搜索闭包 / 缺货换店 / 不擅自加价 | `merchants.test.ts`、`authorization.test.ts` 商户三例 |
| R6 | `verify-proactive`（I13–I17）、`snapshots/proactive` 三幕 | 门禁自测 6 例；快照 5 例 |

**当前门禁：52/52 全绿**；`pnpm typecheck` 绿；主仓 304 文件 / 3413 例；web 28 / 380。

## 2 关键实现事实（答辩直接用）

1. **重启补跑是真的**：`boot()` 的 `restoreSession` 读 `session.jsonl` → `SessionStore.restore` → armed store replay → scheduler 启动补跑；`persistence` 对既有会话 `open(mode:'write')` 续写。集成测试实测"进程 A arm → 退出 → 进程 B 无人工干预执行"。
2. **授权判决可重算**：`plan_wake` 报告带 `inputs`，`digest = sha256(canonicalJson(inputs))`；门禁 I13 重算并把执行 digest 对到 `ticket/approved.authorization`。
3. **wake 对模型隐身**：`exposure:'internal'` + 装配侧过滤；I14 静态判据。
4. **判定时钟有上界**：`duePlans` 的 `maxSkewMs=5min`，越界一条都不执行（I15 之外的 C1）。
5. **五禁**：`authorization/` + `notify/` 无 Date/random/append/setTimeout（I16）。

## 3 未做（下一会话从这里接）

| # | 事项 | 判据/落点 |
|---|---|---|
| 1 | eval **D-11..D-16**（六条失败剧本） | `packages/eval/src/scenarios/d/`；参考现有 D 组编号 |
| 2 | "部分成功 ⇒ 未用预算回活期"反向转账 | `plan_wake` 的 `executed` 分支 + `transfer_create` 反向单 |
| 3 | 商户价与转账金额联动校验 | 目前只校验"转账节点静态金额 ≤ 预算" |
| 4 | 动态 args 金额不计入预算（K1） | 执行前解析 `plan-args-unresolved` 后再算一次 |
| 5 | `fact` 待确认事实的计划卡可见区（K2） | `PlanCardFrame.conditions` 旁加"待确认事实" |
| 6 | 通知投递（K3） | IM 网关落地后接 `notify:channel` |
| 7 | `pnpm snapshot:reverify` 旧 8 份快照 | 最终提交前跑，日志落 `docs/evidence/2026-10-30-proactive/` |
| 8 | R7 口径归正 + R8 演示包（`docs/demo/{script,shots,qa}.md`、PPT/视频） | 按 00/02 方案 §5 R7/R8 |
| 9 | `merchant` 行进 `profiles/web` / `headless`？ | 目前只在 plan/web-plan/mobile（wake 的执行器只在 plan 域） |

## 4 复跑命令

```bash
cd BAH/PROACTIVE-WT
pnpm typecheck && pnpm gate                 # 52/52
npx vitest run                              # 304 文件 / 3413 例
pnpm test:web                               # 28 文件 / 380 例
npx vitest run --config vitest.snapshot.config.ts snapshots/proactive
npx tsx scripts/verify-proactive.ts
```

## 5 两轮对抗式审查的位置

- `docs/evidence/2026-10-30-proactive/R0-R4-对抗式审查.md`（2 个 P0 自伤已修：`plan_arm` 的 projectContent 冲掉 JSON、`fact_forget` 黄级无审批）
- `docs/evidence/2026-10-30-proactive/R5-R6-对抗式审查.md`（R6 通过；R5 最小版交付与未做清单）
