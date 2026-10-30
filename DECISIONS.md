# DECISIONS · 跨场景主动能力补全（2026-10-30，分支 `proactive-01`）

> 每条都带**撤回条件**。数字一律以实测为准，不抄文档里的引用值。

## 0 基线（本工作树 `PROACTIVE-WT`，`main` = `1c369b3`）

| 事实 | 实测命令 | 值 |
|---|---|---|
| 门禁数 | `ls scripts/verify-*.ts \| wc -l` | 50 |
| 银行工具数 | `grep -c "name: '" packages/bank/src/tools/specs.ts` | 16 |
| 主工作树脏项 | `git status --porcelain \| wc -l`（`MonoRepo`） | **31**（非文档所称 11；含并行线暂存 8 项） |
| 本工作树脏项 | 同上（`PROACTIVE-WT`） | 0 |

`MonoRepo` 工作树有并行线在写（`bank/tools/wealth.ts`、`eval/scenarios/p`、`facts.md` 等），
本线因此**在独立 worktree 施工**（`PROACTIVE-WT` / 分支 `proactive-01`），不碰别人的改动。

## D-A 商户腿走执行器，不进 DAG

- 决定：商户调用不进计划节点、不给模型看见，由唤醒执行器在银行腿成功后串行调用。
- 理由：治理面只认银行工具（`governance.ts:278/344`），扩治理面 = 动安全核心 + 全部策略快照重算。
- 撤回条件：余量 ≥4h 且 `verify-policy-*` 全绿的重算脚本已就绪时，可改为治理面扩展。

## D-B 不新增 web 路由

- 决定：计划卡只消费既有帧通道，不新增 `/api/*` 路由，不动 `ROUTES` 与 17 行权限矩阵。
- 理由：`verify-authz-coverage` 的矩阵是逐行维护的，新增路由 = 新增未覆盖行。
- 撤回条件：需要跨会话查询计划列表时才加一条只读路由，并同批补矩阵行。

## D-C 判定时钟参数化，落账时钟永远真实

- 决定：`duePlans` 的"现在"来自 `RunContext.now`；`plan_wake` 可传 `at`，但 **`at` 只用于到期判定**，
  且必须满足 `at <= now + maxSkewMs`（缺省 5 分钟），越界拒绝 `window-clock-ahead`。
- 撤回条件：无（这条是安全边界，不是工期权宜）。

## D-D 不与场景 5 共签 ADR-0007

- 决定：本线只加**可选载荷字段**（ADR-0008）与 `saga/tick` 的 job 名并集，不占事件键名额、不改银行工具目录。
- 理由：`event-table.md` 的"领域新键"名额已被 ADR-0003 用掉；扩签要 7 份快照重录，11-02 前不划算。
- 撤回条件：ADR-0007 正式通过且把额度改成"每场景一次"时，本线只允许再追加 `plan/armed` 一个键。

## D-E `runtime/src/authorization/` 归本方案，不占 `guard/`

- 决定：授权窗口纯函数落在 `runtime/src/authorization/`；`runtime/src/guard/` 保持空占位不动。
- 理由：`runtime/src/tools/guard.ts` 已占"guard = 单调 guard"语义，同名不同物是给后来人挖坑；
  且 `guard/` 在 00 约定里没有指派给任何施工单。
- 撤回条件：00 约定正式把 `guard/` 指派给授权窗口时，整目录改名即可（无外部引用）。

## D-F `ToolDefinition.exposure` 缺省 `'model'`

- 决定：新增可选字段 `exposure?: 'model' | 'internal'`，缺省 `'model'`；
  `internal` 工具不进模型可见 schema（装配侧过滤），但仍在注册表里可被宿主/CLI 调用。
- 理由：缺省 `'internal'` 会让所有既有工具静默消失（测试立刻红，但迁移面太大）；
  缺省 `'model'` 与当前行为逐字节一致，新工具必须**显式**声明 `internal`。
- 撤回条件：若将来引入"按 profile 声明工具面"的统一机制，`exposure` 可并入该机制。
