# ADR-0018 · 六场景是否引入 skill 层（评估件）

- **状态**：评估完成 · **决策待项目负责人拍板**（Proposed；本文件不引入任何运行时变更）
- **日期**：2026-11-02
- **相关**：`docs/agent-loop.md` §3、`docs/architecture.md` §5、`docs/contracts/scenario-dsl.md`、`docs/tool-catalog.md`、`docs/policy.md`、`design/bah-ds/SKILL.md`

## 1. 背景

赛题六场景（智能转账 / 账单分析 / 理财操作 / 卡片管理 / 订阅代扣 / 跨场景联动）当前没有 skill 这层抽象。外部对标材料里 Agent Skills 是常见说法，评审与答辩会直接问"你们用不用 skill、为什么不用"。所以需要一份书面评估：现状是什么、改造要付什么、以及**什么条件下才值得做**。

## 2. 实测现状（先量再谈）

| 项 | 实测值 | 取值方式 |
|---|---|---|
| 银行工具 | 30 个（14 绿 / 10 黄 / 6 红），上限 31 | `docs/tool-catalog.md`（`pnpm tool-catalog` 生成，`verify-tool-catalog` 逐字比对） |
| 工具规范体量 | 37,233 字节；`description:` 127 段、合计 6,445 字符 | `wc -c packages/bank/src/tools/specs.ts`；`grep -c "description:" 同一文件` |
| 全量工具的上下文开销 | 描述部分 4–6k token 量级（中文≈1 字符 1 token；**不含** JSON schema，估算非 usage 实测） | 上一行字符数换算 |
| 演示主路径是否吃这笔开销 | **不吃**。`profiles/web/patch.yml` 默认 `provider: router`，router 是本地确定性意图路由（读 `call.messages`、不外发、不发工具 schema） | `packages/llm/src/demo/router.ts` 头注与实现 |
| 评测规模 | 91 例场景（七族 Q/T/P/S/D/K/U），断言 kind 封闭 6 个 | `packages/eval/src/scenarios/*/index.ts` 里 `id: '<族>-<序>'` 去重计数 |
| 主循环接缝 | 4 个，文档明写"本设计只加这四个" | `docs/agent-loop.md` §3 |
| 总闸 | `pnpm check` 十四步；`pnpm gate` 53 项 | `facts.md` §1 |

## 3. 三处不变量会先撞

1. **策略面**：策略条目的 `appliesTo` 必须是工具目录里的名字（`docs/policy.md`；权威集合 `BANK_TOOL_NAME_SET` 在 `packages/bank/src/tools/specs.ts`，解释在 `packages/bank/src/tools/governance.ts`）。若"按需裁剪工具"，会出现"目录里有、这一轮没有"的空洞，判定依据不可复现。
2. **评测面**：`tool-sequence` / `tool-denied` / `tool-result` 三类断言直接锚工具名（`packages/eval/src/scenario/spec.ts`）。能力变成"加载才存在"，91 例要先重新定义"未加载"算不算 PASS——这是改 kind 语义级别的事，DSL 冻结文档把它的成本写成"基本等于重做"。
3. **事实面**：`tool/result` 是唯一真相，卡片 / DAG / 审计时间线都是它的投影（`docs/architecture.md` §5）。"技能加载"若要可审计就必须进事件表并过 `runtime:session`；事件键现 38 个，扩容走 ADR-0003 的既定改签路径。

## 4. 三档路线

| 档 | 内容 | 是否动主循环 | 成本（估算，**未实测**） | 需同步的面 |
|---|---|---|---|---|
| 0 | 不加抽象，把现有机制表述为**技能式工具路由**：工具描述自带"何时用 / 何时别用它"、目录自带"场景"列、策略走 `policies/registry.json` 外置 | 否 | 约 0.2 人日（纯口径） | 表述必须限定"不是可安装技能包"，越界即虚述 |
| 1 | **配置层能力包**：新增 bundle 数据行 = 工具白名单 + 说明片段，按 profile 装配，复用 Profile+Patch+Bundle 四层与 fail-loud 校验 | 否 | 约 1–1.5 人日 | `verify-tool-catalog`、`verify-policy-registry`、`facts.md` 台账；全量 `check` |
| 2 | **真 skill 层**：命中意图后注入说明并裁剪 `request.tools`（复用 `agent/request`，或加第五个接缝） | **是** | 约 2–4 人日 | ADR + `docs/architecture.md` + 全量快照 + 91 例回归 + 事件表扩容 + 前端投影；按 AGENTS.md 纪律第 3 条判为破坏性变更 |

## 5. 升级判据（什么时候才动下一档）

- **档 1**：出现真实的多机构差异——能力面不同是**配置差异**而非代码差异时。差异不存在就做档 1 是净负债。
- **档 2**：三条同时成立才做——真模型路径成为主路径、工具数逼近上限 31、usage 实测显示工具 schema 占比可观。当前第一条在演示口径下就不成立。
- 两条都不触发时的默认答案：**维持现状（档 0）**。

## 6. 本文件的边界

不改代码、不改契约、不动已交付材料。`docs/adr/` 不在 `verify-docs-paths.ts`（只扫 `docs/` 顶层 `.md`）也不在 `verify-docs-consistency.ts`（显式白名单）的扫描面内，因此本文件不触发文档门禁。档 1 / 档 2 落地前须另开 ADR 写形状，本文件不预写施工步骤。
