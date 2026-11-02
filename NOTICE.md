# NOTICE

本仓库（BAH, Banking Agent Harness）为独立实现：架构、机制与全部代码由本项目维护，
未包含、也未衍生自任何第三方 Harness 项目的源代码。

本工程的安全内核（归一化 / 注入签名检测 / 危险规则 / 预算 / 断路器 / 审计）
由本项目自有工程迁移而来，为原创代码。

前端视觉体系 `design/bah-ds/`（BAH DS）为本工程自研设计系统：令牌定义、组件契约与
图标资产均由本项目维护，`apps/web/styles/ds/` 是其逐字节分发副本，由 `verify-web` 门禁校验。

若后续引入第三方 MIT/Apache 组件，在此逐项标注：
（暂无）

## 桌面端分发（Electron / Chromium，2026-10-30）

`apps/desktop` 与便携 zip（`dist-desktop/BAH-desktop-<version>-win-x64.zip`）**分发**
Electron 运行时的未修改二进制，因此随包附带其原始许可文本：

| 组件 | 版本 | 许可 | 许可文本位置 |
|---|---|---|---|
| Electron | 39.8.10 | MIT | zip 内 `LICENSE` |
| Chromium（Electron 内置） | 142.0.7444.265 | BSD-3-Clause 等（含第三方组件） | zip 内 `LICENSES.chromium.html` |
| Node.js（Electron 内置） | 22.22.1 | MIT | 同上 |

边界：本工程**不修改** Electron/Chromium 二进制，只在其上加载自有代码；
`resources/app` 全部为本仓库源码的构建产物。桌面端不含任何远程遥测、自动更新或崩溃上报。

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

表中版本与许可信息按各项目公开仓库抓取；代码位置以各项目官方仓库为准。
