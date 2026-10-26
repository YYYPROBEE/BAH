# NOTICE

本仓库（BAH, Banking Agent Harness）为独立实现。本工程未包含、未衍生自任何第三方
Harness 项目（包括 DeepSeek Harness / dsh）的源代码；架构与机制层面参考了其公开
文档中描述的设计思想，全部实现由本项目作者完成。

本工程复用了作者自有工程 `sentry-dsh-plugin` 与 `caai-sentry` 的安全内核
（归一化 / 注入签名检测 / 危险规则 / 预算 / 断路器 / 审计），为原创代码。
其中工具名通配匹配（原 `wildcardToRegExp`）曾与 dsh 的同名实现存在语义特异重合，
已于 2026-10-22 改写为 `compileToolGlob`（按 `*` 切段 → 逐段转义 → `.*` 连接）
并同步更名，主仓与 `sentry-dsh-plugin` 两侧均已替换；比对结果见
`审计-2026-10-21/probe-line-overlap.cjs` 的输出（语义特异重合 0 处）。

前端视觉体系 `design/bah-ds/`（BAH DS）为本工程自研设计系统：令牌定义、组件契约与
图标资产均由本项目维护，`apps/web/styles/ds/` 是其逐字节分发副本，由 `verify-web` 门禁校验。

若后续引入第三方 MIT/Apache 组件，在此逐项标注：
（暂无）

## 机制借鉴登记（`plan:dag` 编排原语，2026-10-24）

`packages/runtime/src/plan/` 的编排引擎**没有复制任何第三方代码**：下列九项只借"机制名与
概念形态"（终态名、token 概念、谓词签名），实现全部为本工程独立编写。登记目的是让
"我们参考过谁、参考到什么粒度"可被外部核验，而不是免责声明。

| 借鉴的机制 | 来源项目 | 许可 | 本工程的独立实现差异 |
|---|---|---|---|
| Checkpointer 多方法接口 | `langchain-ai/langgraphjs` | MIT | 只取 4 方法形状（无 `deleteThread`）；快照是**显式节点状态**，不是通道版本向量 |
| `shouldPersist` 谓词 | `mastra-ai/mastra`（`ee/` 除外） | Apache-2.0 | 签名收窄为 `(state) => boolean`，由宿主注入 |
| `blocked` 传递终态 | `apache/airflow`（`upstream_failed`） | Apache-2.0 | 改名为 `blocked`，并区分 `optional → skipped`（`skipped` 算依赖满足） |
| "已完成不重跑" | `dbos-inc/dbos-transact-ts`（`operation_outputs`） | MIT | 按 `nodeId` 的状态判定，不按 `function_id` 序号 |
| 单写者 | `dbos-inc/dbos-transact-ts` / `restatedev/restate` | MIT / BSL-1.1 | `inflight: Set<planId>`，**进程内**，不是跨进程 lease |
| 死信上限 | `dbos-inc/dbos-transact-ts`（`MAX_RECOVERY_ATTEMPTS_EXCEEDED`） | MIT | v1 不重试，`maxAttempts` 恒为 1 |
| 确定性约束 | `temporalio/temporal`（workflow 沙箱） | MIT | **静态门禁**（`verify-plan-determinism` 禁 `Date.now/Math.random/randomUUID`），非运行时沙箱 |
| "step 不保证 exactly-once" 的诚实表述 | `inngest/inngest` | SSPL-1.0 | **只借表述**（写进 `docs/plan.md` 的已知限制），未读其实现 |
| 每次激活一个 token | `camunda/camunda`（`jobLeaseToken`） | Zeebe Community License 1.0 | **v1 未实现**；票据 lease 属治理平面（`interaction:approval` + `@bah/bank`），本插件只是受益方 |

对 BSL / SSPL / Zeebe Community License 三个项目（Restate、Inngest、Camunda）：**只读公开文档，
未阅读其源码后照写**。明确未借鉴：Pregel 超步、Mastra 的 8/11 态状态集、DBOS 的 Postgres
schema、BPMN、K8s CRD。

同一批机制对照的完整依据（stars / commit / license 抓取日期、代码位置 permalink）见
`文档归档/BAH-plan-dag插件最终方案-2026-10-24.md` §2 与 §6.3。
