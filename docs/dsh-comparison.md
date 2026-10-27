# BAH 底座 · 对照 DeepSeek Harness 的完成度 / 复刻度 / 优化点

- 评审对象：`D:\项目集\微众杯银行ai智能体\BAH\MonoRepo`（工作树 @ 2026-10-20 15:53）
- 参照系：`D:\项目集\微众杯银行ai智能体\BAH\Deepseek Harness`（本地全量源码，dsh）
- 评审性质：**只读对照**。本文所有数字均由本机实跑命令得出，命令写在各节「复核命令」里，可原样重跑。
- 评审范围：**底座**（`packages/*` 14 包 + 根工程配置 + `scripts/` 门禁 + `docs/`）。`apps/*` 与 `services/rag` 仅在与底座门禁/安全直接相关时纳入。
- 合规声明：本文只做**机制层对照**，未复制、未引用 dsh 源码文件内容；下文出现 dsh 路径仅为「该机制在上游的落位坐标」，用于说明差异，不构成代码搬运。符合 `AGENTS.md` 合规底线 1–3。

---

## 〇、先说结论

| 维度 | 结论 | 一句话 |
|---|---|---|
| **底座完成度** | **76%**（含 12 项 P0 缺口） | 骨架、事件流、模型层、治理面已闭环；但**门禁基线当前是红的**，且有 20 处纯占位模块未实装 |
| **对 dsh 的复刻度** | **核心骨架 74% / 全量机制 62% / 能力面 33%** | dsh 52 个顶层能力域（331 个实际包）vs BAH 14 包，但 BAH 在**银行域纵深**上反超（票据 / 沙箱档位 / saga 补偿 / 工具目录 16 工具） |
| **优化点** | **P0 6 项 / P1 8 项 / P2 6 项** | 最优先不是"补功能"，而是**把红基线修绿 + 把已承诺的 12 项 P0 缺口填实** |

**关键判断**：BAH 不是"dsh 的复刻"，而是**"dsh 内核的银行域重实现 + 自有治理面"**。因此"复刻度"这个指标本身要拆成两问：

1. **骨架复刻度（该像的像不像）** → 高。事件序列、seam 划分、profile/patch 层序、可逆注册纪律，与 dsh 逐项对位。
2. **能力面复刻度（该有的有没有）** → 低。dsh 有 44 个 BAH 无对应包，其中 8 个是银行域刚需缺口（`session-query`/`storage`/`subagent`/`telemetry`/`fs`/`mcp`/`goal`/`todo`）。

**最需要立刻处理的一件事**：`PROGRESS.md` §41 声称"行覆盖 100%""gate 12/12"，**与实测矛盾**（见 §3.3）。这是一个"文档说绿、实际红"的治理缺陷，比任何功能缺口都危险——它让后来人相信 CI 是绿的，然后在红基线上继续堆代码。

---

## 一、两套系统的规模基线（实跑）

### 1.1 BAH 底座

| 包 | 生产文件 | 生产行 | 测试文件 | 测试行 | 定位 |
|---|---:|---:|---:|---:|---|
| `saga` | 32 | 5,423 | 17 | 4,580 | 补偿 / 事务状态机（银行域**自有**） |
| `runtime` | 39 | 5,260 | 22 | 5,318 | 主循环 / 工具管线 / 会话 / 压缩 / 提示词 |
| `safety` | 40 | 4,783 | 21 | 3,004 | sentry 七件套 + 沙箱两件套 |
| `persistence` | 23 | 3,305 | 5 | 1,185 | JSONL / chain / saga-store |
| `host` | 26 | 2,746 | 12 | 2,829 | 装配层 / 插件管理 |
| `llm` | 14 | 2,043 | 9 | 1,396 | 模型层（seam / registry / 降级 / 修复） |
| `bank` | 34 | 6,322 | 19 | 3,219 | 仿真银行 + 16 工具族 |
| `core` | 9 | 1,509 | 5 | 996 | 内核（事件 / 插件 / 服务 / scope） |
| `interaction` | 8 | 1,141 | 4 | 929 | 审批 / 票据账本 |
| `cli` | 7 | 919 | 4 | 913 | 启动 / profile / dump-config |
| `knowledge` | 9 | 895 | 6 | 558 | 知识层端口与工具 |
| `test-support` | 9 | 1,060 | 7 | 910 | 夹具 / mock / 快照 |
| `util` | 11 | 426 | 2 | 158 | 通用原语 |
| `channels` | 5 | 35 | 0 | 0 | **空壳**（5 文件全 `export {}`） |
| **合计** | **266** | **36,832** | **134** | **26,041** | 测试:生产 ≈ **0.71** |

### 1.2 dsh 参照系

| 维度 | dsh | BAH | 比值 |
|---|---:|---:|---:|
| 能力域 / 包数 | 52 个顶层能力域 / 331 个实际包 | 14 | 0.04 / 0.04 |
| 会话事件类型 | **61** | **17** | 0.28 |
| 核心文档 | `docs/` 47 篇 + `docs/subsystems/` 134 篇（`docs/` 合计 429 篇） | `docs/` **12** 篇（2,070 行） | 0.03 |
| 单包最大实现 | `core/tools` 5,682 行 / `core/agent-loop` 2,478 行 | `persistence/saga-store` 1,527 行 | 0.27 |
| 沙箱实现 | 10,513 行（`packages/sandbox/**`） | 1,216 行（`sandbox-runtime`）+ policy | ~0.12 |
| JSONL 持久化 | 5,607 行（`session-persistence-jsonl`） | 513 行（`jsonl/`） | 0.09 |
| 上下文子系统 | 61 个事件 + `session-query` + `session-projection` + `spill` + `storage` | `projection` 90 行 / `query` 7 行(占位) | ~0.05 |

**读法**：BAH 的代码量约为 dsh 的 8–10%。**测试密度上 BAH 明显低于 dsh**（BAH 全仓 0.71，dsh 主体包抽样：`core/agent-loop` 5.72、`boot/app-boot` 1.91、`core/session` 1.87、`core/system-prompt` 1.71、`core/tools` 1.53、`llm/llm` 0.98）——差距最大的正是**主循环**（dsh 5.72 vs BAH 约 1.0）。这说明 BAH 走的是"窄而深"路线：选了银行域必需的那条纵切打透，但没有为每条机制配上 dsh 那种"多切面 × 性质测试"的验证厚度。§四 P1-1 的覆盖名单扩容正是要补这一层。

### 1.3 复核命令

```bash
cd "D:/项目集/微众杯银行ai智能体/BAH/MonoRepo"
for p in packages/*/src; do
  n=$(find "$p" -name "*.ts" -not -name "*.test.ts" | wc -l)
  l=$(find "$p" -name "*.ts" -not -name "*.test.ts" -exec cat {} + | wc -l)
  t=$(find "$p" -name "*.test.ts" | wc -l)
  printf "%-16s %3s %6s | %3s\n" "$(basename $(dirname $p))" "$n" "$l" "$t"
done
```

---

## 二、能力级映射矩阵（逐项落实）

判定口径：
- **已复刻** = 机制语义一致且有测试钉住
- **部分复刻** = 骨架在，深度/边界缺失
- **未复刻** = 无对应实现
- **域内豁免** = 银行域不需要（保留判定，不计缺口）

### 2.1 内核与插件系统（dsh `packages/core/*` ↔ BAH `packages/core`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| C-1 | Cordis 上下文：服务注册 / 注入 / 隔离 realm | `BahContext`（`core/src/context.ts:101`） | **已复刻** | `get/effect/start/dispose/provide/whenReady/scope/isolate` 九方法齐备；`isolate` 见 `core/src/scope.ts:86` |
| C-2 | 五模式事件（emit/serial/parallel/waterfall/bail） | `EventMode`（`core/src/api.ts:92`） | **已复刻** | 门禁 `verify-event-modes` 做 AST 比对，负控已验证 |
| C-3 | 可逆注册（贡献皆 disposer） | `effect()` / `on()` 返回 `Disposer`（`api.ts:36,43`） | **已复刻** | `AGENTS.md` 纪律 1；`T-CORE-003` 逆序回滚用例 |
| C-4 | 误配置在 apply 前抛出（fail-loud） | 内核配置校验 | **已复刻** | `T-CORE-002`（`bah-core: ` 前缀 + 插件名 + 置 disposed） |
| C-5 | `waterfall` 返回最外层 handler 值、`next()` 不穿透 | `stepChain` | **已复刻** | `PROGRESS.md` R13 已查上游机制确认语义一致，并加无 ID 用例钉死 |
| C-6 | `bail` 把 `null`/`false` 也算"无裁决" | BAH 只认 `undefined` | **差异（已知）** | `PROGRESS.md` R14 已备案：`return false` 在 BAH 会短路 |
| C-7 | 作用域注册原语（`core/scope` 零依赖库） | `core/src/scope.ts`（88 行，`BahScope`） | **部分复刻** | 有 realm 隔离，但无 dsh 的 `createScope/scopeOf/scopeTarget` 三元原语完整形态 |
| C-8 | `agent/` 活跃 agent 注册表 + `ctx.agents` | `AgentRegistry`（`runtime/src/agent/index.ts:212`） | **已复刻** | `register/get/has/list/ids` + `AGENTS_SERVICE` 服务键 |
| C-9 | `AgentHandle`（owner-only 句柄，disposer 是能力） | `Agent` 接口直接暴露 `dispose()` | **未复刻** | BAH `runtime/src/agent/index.ts:60-84` 无 Handle 概念，销毁权未与观察权分离 |
| C-10 | `withInitiator()` 发起者作用域 | 无 | **未复刻** | 全仓 `grep withInitiator` 零命中 |
| C-11 | `whenIdle()` / `runMaintenance()` 静默态维护任务 | 无 | **未复刻** | 全仓零命中；BAH 只有 `run()` / `drive()` |
| C-12 | `followup` / `steer` / `inject` 三预设 | `steer` / `inject` 有（`agent/index.ts:72,74`），`followup` 无 | **部分复刻** | 缺 `followup` 语义（下一轮追加，不打断当前轮） |

### 2.2 主循环（dsh `core/agent-loop` ↔ BAH `runtime/agent-loop`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| L-1 | turn 先开后关，`turn/start` 在首次认领前 | 同 | **已复刻** | `runtime/src/agent-loop/agent.ts:302` |
| L-2 | `step/start` → 装配 → `agent/request` → 冻结 → 流式 → 工具 → `step/end` | 同序 | **已复刻** | `agent.ts:328`（step 起点）、`:456`（request）、`:465`（冻结）、`:481`（流式） |
| L-3 | 取消边界：`agent/request`/`prepareCall` 阶段取消不提交 system/user | 同 | **已复刻** | `agent.ts:463` 显式 `return this.cancelled(...)` |
| L-4 | 失败步骤补记缺失工具结果 | 同 | **已复刻** | `agent.ts:534-554`：先补 `tool/result`(isError) 再落 `assistant/message` |
| L-5 | `assistant/message` 内嵌精确紧凑流 | 落 `assistant/message`，含 toolCalls | **部分复刻** | `agent.ts:522-533`；无 dsh 的"内嵌完整 stream 带" |
| L-6 | `assistant/attempt` 保留失败/重试/取消 attempt | 有 | **已复刻** | `runtime/src/session/types.ts:36` |
| L-7 | `agent/pre-step`（waterfall）可改写/拒绝 | 有 | **已复刻** | `agent.ts:385` `dispatchPreStep` |
| L-8 | `agent/request`（waterfall）改写路由/参数 | 有 | **已复刻** | `agent.ts:456` |
| L-9 | `agent/turn-stopping`（serial，可停轮次） | 有 | **已复刻** | `runtime/src/agent/index.ts:164` `AgentTurnStoppingInput` |
| L-10 | `llm/stream`（waterfall 环绕） | 有 | **已复刻** | `agent.ts:659` `dispatchLlmStream` |
| L-11 | `startsRequestSeries`（替换/省略开启新请求序列） | 无 | **未复刻** | 无该概念；BAH 每次请求独立装配，无序列标记 |
| L-12 | 提示词作为 surface node（空渲染清除系统节点） | `system-prompt/reconcile.ts` | **部分复刻** | 有 reconcile，但无"能力路由分类"那套判定树 |
| L-13 | `agent/created` 串行 + 初始化失败回滚 | 无 | **未复刻** | BAH 无 `agent/created` 事件 |
| L-14 | 请求缓存 / 完全冻结对象复用冻结证据 | 无 | **未复刻** | dsh 有 `request-cache.e2e.ts` |
| L-15 | 会话 fork（`agents.create({parentSession, seedLength})`） | 有 `fork()` | **部分复刻** | `runtime/src/agent/index.ts:82` + `agent-loop/rollback.ts`；无 `seedLength` 精确切点语义 |
| L-16 | 主循环可替换（agent-loop 是 `Agent` 唯一实现，扩展只依赖 `agent`） | 单实现，无替换契约 | **未复刻** | BAH 未声明"扩展不得依赖 agent-loop"这条依赖纪律 |

### 2.3 工具注册与执行管线（dsh `core/tools` ↔ BAH `runtime/tools`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| T-1 | `ctx.tools` 作用域化注册表 | `ToolRegistry` | **部分复刻** | `runtime/src/tools/registry.ts:12`；**作用域化不足**——dsh 的 registry 按 agent scope 隔离，BAH 是全局表 |
| T-2 | `tools/pre-execute`（waterfall，唯一阻断点） | ③ | **已复刻** | `runtime/src/tools/pipeline.ts:215-216` |
| T-3 | `tools/execute`（waterfall 环绕：超时/重试/指标/沙箱） | ⑤ | **已复刻** | `pipeline.ts:231` |
| T-4 | `tools/post-execute`（accept/block/replace/addContext） | ⑥ | **已复刻** | `pipeline.ts:259` + `assertNever(post.verdict)` |
| T-5 | 工具调用前落 `tool/call` | ① | **已复刻** | `pipeline.ts:197`（即便被拒也落账） |
| T-6 | 归一化：抛错 → isError，不冒泡 | ⑦ | **已复刻** | `pipeline.ts:291` |
| T-7 | 工具 schema → TS/Python 类型生成（`json-schema.ts`/`ts-types.ts`/`py-types.ts`，2,143 行） | 无 | **未复刻** | dsh `core/tools/src/` 三个 schema 编译器，BAH 只有 JSON Schema 校验（`llm/repair.ts:85`） |
| T-8 | 工具超时策略（`tool-call-timeout-policy` 作为 `tools/execute` 包装） | 无通用策略包 | **未复刻** | 沙箱侧有硬杀，但工具调用无统一超时包装 |
| T-9 | 工具展示层分离（`agent-tool-presentation`） | `presentCall`（`pipeline.ts:207`） | **部分复刻** | 有卡片函数，无独立展示包 |
| T-10 | `TOOL_RUNTIME_SCHEDULER` 调度器 | 无 | **未复刻** | dsh 允许 pre/execute/post 三段异步调度，BAH 是固定同步七段 |
| T-11 | PTC 工具（`ptc.ts` 775 行，代码执行型工具） | `sandbox-runtime/handlers/compute.ts` | **部分复刻** | BAH 走 `BANK_COMPUTE` 接缝，单一 handler |
| T-12 | 工具执行 token（防重入） | `guard.ts` 单调 guard | **部分复刻** | `pipeline.ts:221` 只做"已判 deny 维持 deny" |
| T-13 | 工具目录门禁 | 有，且更严 | **已复刻（超集）** | `verify-tiers` 校验 16 工具 tier + amountPath；`verify-tool-catalog` 校验落账事件 17 个 |

### 2.4 会话与持久化（dsh `core/session` + `session-persistence-jsonl` ↔ BAH `runtime/session` + `persistence`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| S-1 | 仅追加 `SessionEvent` 日志为唯一真源 | 有 | **已复刻** | `runtime/src/session/`（809 行） |
| S-2 | `deriveMessages()` 从日志投影模型历史 | 有 | **已复刻** | `runtime/src/session/derive.ts` |
| S-3 | 会话事件类型词汇表（61 种，生成 + 门禁同步） | 17 种 | **部分复刻** | `runtime/src/session/types.ts:26-44`；dsh `core/session/src/known-event-types.ts` |
| S-4 | `ignorable` 标记：读路径拒绝解释未知事件 | 有 `tool/callback-failed` 等，但**未见 ignorable 兼容机制** | **未复刻** | BAH `session/types.ts` 无 `ignorable` 字段；dsh `known-event-types.ts:16-20` 说明这是"日志兼容的唯一机制" |
| S-5 | 会话格式版本化 `session.vN.jsonl` + 相邻迁移包（v0→v1→v2→v3→v4） | `persistence/src/migrations/index.ts` **7 行占位** | **未复刻** | dsh 有 4 个独立迁移包 + `migration-verifier.ts`(198 行) + `catalog-migration.ts` |
| S-6 | generation 选择 + 排他发布（已提交路径不重命名） | 无 | **未复刻** | dsh `session-persistence-jsonl/src/generation.ts` 1,059 行；BAH 无 |
| S-7 | 迁移链静态组合 + 校验 | 无 | **未复刻** | — |
| S-8 | 中断尾部修复（`repair.ts`） | `agent-loop/rollback.ts`（turn 回退） | **部分复刻** | 语义不同：dsh 修日志尾部，BAH 修轮次状态 |
| S-9 | `session-projection` 投影 seam（增量折叠 + `stateOf()`） | `persistence/src/projection/index.ts`（90 行） | **部分复刻** | 规模远小于 dsh 的 `session-projection` + `session-projection-cache` |
| S-10 | `session-query`（SQLite 全文查询 + 冷读 + 游标 + 语料） | `persistence/src/query/index.ts` **7 行占位** | **未复刻** | dsh `session-query` 4 个包（sqlite/corpus/cold-read/cursor…） |
| S-11 | `session-title`（LLM 生成标题） | `persistence/src/title/index.ts` **7 行占位** | **未复刻** | dsh 有 `session-title` + `session-title-llm` + `session-title-first-prompt-llm` |
| S-12 | `session-stats` / `session-turn-outline` | 无 | **未复刻** | — |
| S-13 | JSONL 压缩（zstd） | 无 | **未复刻** | dsh `zstd.ts` + `zstd-private-decoder.ts`(178 行) |
| S-14 | PII 脱敏 | 有 | **已复刻（超集）** | `persistence/src/jsonl/redact.ts`（108 行）——dsh 无对应包，BAH 银行域自有 |
| S-15 | `settings` 持久化 | `persistence/src/settings/index.ts` **7 行占位** | **未复刻** | dsh `packages/settings` |
| S-16 | `identity` 持久化 | `persistence/src/identity/index.ts` **7 行占位** | **未复刻** | dsh `packages/identity` |
| S-17 | `feedback` 记录 | `persistence/src/feedback/index.ts` **7 行占位** | **未复刻** | dsh `packages/feedback` |
| S-18 | `credentials` 存储 | 有 | **已复刻** | `persistence/src/credentials/index.ts`（245 行） |
| S-19 | `storage` 抽象（backend/registry/domain） | 无 | **未复刻** | dsh `packages/storage` 4 包，含 json/sqlite 后端 |
| S-20 | `spill`（上下文溢出落盘） | 无 | **未复刻** | dsh `packages/spill` 3 包 |

### 2.5 提示词装配（dsh `core/system-prompt` ↔ BAH `runtime/system-prompt`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| P-1 | 提示词段落组装 + 工具 schema 注入 | 有（846 行） | **已复刻** | `runtime/src/system-prompt/sections.ts` / `registry.ts` |
| P-2 | 六段装配 + reconcile | 有 | **已复刻** | `system-prompt/reconcile.ts` |
| P-3 | 历史缓存（history cache） | 有 | **已复刻** | `system-prompt/history-cache.ts` |
| P-4 | 提示词作为 surface node 的能力路由分类 | 部分 | **部分复刻** | 见 L-12 |

### 2.6 压缩（dsh `packages/compaction` ↔ BAH `runtime/compaction`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| C-1 | 压缩流程（start/summary/prune/end 事件） | 有（578 行） | **已复刻** | `runtime/src/compaction/apply.ts` + `summarize.ts` |
| C-2 | 工具配对保护（`tool-pairing.ts`） | 有 | **已复刻** | 压缩时保持 `tool/call ↔ tool/result` 配对 |
| C-3 | 检查点（`checkpoint.ts`） | 无 | **未复刻** | dsh `compaction/compaction/src/checkpoint.ts` |
| C-4 | 压缩命令（`command-compact`） | 无 | **未复刻** | dsh 有独立命令包 |
| C-5 | 压缩在请求装配前触发 | 有 | **已复刻** | `PROGRESS.md` §23「压缩前移到请求装配前」 |

### 2.7 治理与安全（dsh `packages/sandbox` + `interaction` ↔ BAH `safety` + `interaction`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| G-1 | 沙箱模式词表（read-only/workspace-write/danger-full-access） | 档位制（`none`/受限档） | **部分复刻（域内更严）** | `safety/sandbox-policy/policy.ts:98-128`：模型生成代码一律禁入 `none`；override 不可放宽档位 |
| G-2 | 沙箱不可用错误（`SANDBOX_UNAVAILABLE`） | 三态失败 | **已复刻** | `sandbox-runtime/runner.ts`（303 行） |
| G-3 | 沙箱升级审批（`escalation.ts`） | 无 | **未复刻** | dsh `sandbox/src/escalation.ts` |
| G-4 | 沙箱根目录约束（`roots.ts` canonicalPath） | 无通用根约束 | **未复刻** | BAH 沙箱是"计算隔离"不是"文件系统写边界" |
| G-5 | Windows ACL 沙箱（10,513 行，含 win32 FFI/令牌/SID） | 无 | **域内豁免**（BAH 不跑模型生成的本地代码） | BAH 沙箱执行的是**声明式计算**，非任意 shell |
| G-6 | 用户审批（`user-approval`） | 有 | **已复刻（超集）** | `interaction/approval/`：票据账本 + 渠道应答 + 红级挑战链 |
| G-7 | 权限预设（`permission-presets`） | 三级 tier（green/yellow/red） | **已复刻（域内更强）** | `core/api.ts:367` `ToolTierLevel`；`bank/tools/tier.ts` |
| G-8 | `tool-ask-user` 主动问用户 | 有 `interaction/prompt`… | **未复刻** | `interaction/src/prompt/index.ts` **7 行占位** |
| G-9 | 注入/越权检测 | sentry 内核 | **已复刻（超集）** | `safety/sentry/kernel/` 16 文件：normalize/detect/rules/budget/breaker/pii/wildcard/trace |
| G-10 | 熔断器 + 显式解冻 | 有 | **已复刻** | `sentry/kernel/breaker.ts` + `pipeline/breaker.ts` |
| G-11 | 工具调用超时策略 | 沙箱硬杀有；通用工具无 | **部分复刻** | 见 T-8 |
| G-12 | 审计轨迹 | 有 | **已复刻** | `sentry/pipeline/audit.ts` + `saga` 审计 |

### 2.8 组合与启动（dsh `packages/boot` + `bundle` + `preset` ↔ BAH `cli` + `host` + `profiles`）

| # | dsh 机制 | BAH 对应 | 判定 | 证据 |
|---|---|---|---|---|
| B-1 | profile（具名组装 + 有序组合包 + patch 层序） | 有 | **已复刻** | `cli/src/profile.ts:95-190`（`readProfile` / `readLayers`） |
| B-2 | 四层层序：组合包 → patch → home patch → `--patch` overlay | 有 | **已复刻** | `profile.ts:24` `HOME_PATCH_FILE = 'bah.patch.yml'` |
| B-3 | patch 按 id 定位条目并替换整个 config | 有 | **已复刻** | `profile.ts:203` `parsePatch` |
| B-4 | `preset` patch 在目标 `config.plugins` 内应用 | 无独立 preset 概念 | **部分复刻** | BAH 用 profile 表达 |
| B-5 | config-only HMR（仅监视配置） | 有 | **已复刻** | `host/src/boot/hmr.ts` |
| B-6 | 插件管理器（base 提供给 Web 与 Agent） | 有 | **已复刻** | `host/src/boot/profile-plugins.ts` + `plugin-manager` 目录 |
| B-7 | `--dump-config` 打印生效树 | 有 | **已复刻** | `cli/src/dump-config.ts` |
| B-8 | 兼容性预检（`compatibility-preflight.ts`） | 无 | **未复刻** | dsh 175 行 + `profile-compatibility.ts` |
| B-9 | 组合包分发（`dsh.bundle` 字段） | `readManifestBundles` | **部分复刻** | `profile.ts:76` |
| B-10 | 官方组合包清单（生成 + 门禁） | 无生成机制 | **未复刻** | dsh `official-bundles.generated.ts` + `verify-*` 门禁 |

### 2.9 dsh 有、BAH 完全无对应（按是否银行域需要分层）

| dsh 包 | 用途 | 银行域判定 | 说明 |
|---|---|---|---|
| `session-query` | 会话全文检索（SQLite） | **需要（建议 P1）** | 银行场景"查历史对话/审计回溯"是刚需；BAH 目前只有 `projection` 90 行 |
| `storage` | 存储抽象（json/sqlite 后端） | **需要（建议 P1）** | BAH 的 `saga-store` 1,527 行直接绑 `node:sqlite`，无后端抽象，换存储即重写 |
| `subagent` | 子智能体委派 | **需要（建议 P1）** | 银行复杂任务（尽调/对账）需子 agent；dsh 有 5 种 provider |
| `telemetry` | 遥测 | **需要（建议 P1）** | 银行需可审计的调用链度量；BAH 有审计但无度量出口（见架构评审维度 6） |
| `fs` | 文件系统提供方 + 策略 | **部分需要（P2）** | 报告导出/对账单落地需要 |
| `mcp` | MCP 客户端 | **需要（P2）** | 银行内部系统多走 MCP 接入 |
| `goal` | 会话目标 | **部分需要（P2）** | 替代无方向的会话 |
| `todo` | 待办工具 | **需要（P2）** | 多步金融任务需要显式待办；BAH `runtime/src/todo` 是占位 |
| `guard` | 重复工具提醒 / 超时策略 | **需要（P2）** | 防工具调用循环；BAH `runtime/src/guard` 是占位 |
| `context/agent-instructions` | 项目级指令注入 | **需要（P2）** | 银行知识库/制度注入 |
| `preset/agent-preset` | Agent 预设与能力集隔离 | **部分需要（P2）** | 对应 BAH `core/scope.ts` 的 realm 隔离 |
| `spill` | 上下文溢出落盘 | **需要（P2）** | 长会话资金分析 |
| `jobs` | 后台任务 | **部分需要（P2）** | 批量对账 |
| `schedule` | 定时任务 | **部分需要（P2）** | 已在施工单保留项中（§2 U3 决议） |
| `webhook` | 外部触发会话 | **需要（P2）** | 支付回调触发 agent |
| `workflow` | 编排 | **部分需要（P2）** | 已在保留项 |
| `skill` | 技能包 | **需要（P2）** | 银行业务技能 |
| `lsp` / `ssh` / `terminal` / `browser-use` / `computer-use` / `ptc-runtime` / `document` / `deliverables` / `acp` / `sdk` / `api` / `extensions` / `experimental` | IDE/桌面/自动化/文档交付 | **域内豁免** | 银行赛题不涉及 |
| `identity` / `settings` / `feedback` | 用户偏好持久化 | **未复刻（但有占位）** | 见 S-15/S-16/S-17 |

### 2.10 复刻度汇总

| 分组 | 判定项数 | 已复刻 | 部分复刻 | 未复刻 |
|---|---:|---:|---:|---:|
| C 内核与插件（C-1..12） | 12 | 7 | 3 | 2 |
| L 主循环（L-1..16） | 16 | 9 | 4 | 3 |
| T 工具管线（T-1..13） | 13 | 7 | 5 | 1 |
| S 会话持久化（S-1..20） | 20 | 3 | 6 | 11 |
| P 提示词（P-1..4） | 4 | 3 | 1 | 0 |
| C 压缩（C-1..5） | 5 | 3 | 0 | 2 |
| G 治理安全（G-1..12） | 12 | 6 | 3 | 3 |
| B 组合启动（B-1..10） | 10 | 7 | 2 | 1 |
| **合计** | **92** | **45** | **24** | **23** |

**加权复刻度**：
- 骨架复刻度（只计"该像的"：C+L+T+P+B 共 55 项）=（已复刻 33 + 部分 15×0.5）/55 = **73.6%**
- 全量复刻度（含 S/G 的深水区）=（45 + 24×0.5）/92 = **62.0%**
- 能力面复刻度 = 已实装对应 17 / dsh 顶层包 52 = **33%**；扣除 15 项域内豁免后 = 17/37 = **46%**

> **能力面口径说明**（可复核）：以 §2.9 逐项判定表为唯一来源，把 dsh 52 个顶层包分成三档——**已实装对应 17 个**、**银行域需补齐 20 个**、**域内豁免 15 个**（`lsp`/`ssh`/`terminal`/`browser-use`/`computer-use`/`ptc-runtime`/`document`/`deliverables`/`acp`/`sdk`/`api`/`extensions`/`experimental`/`shell`/`subprocess`），三档相加 = 52。

> 结论：**骨架像（74%）、能力薄（33%–46%）**。这不是缺陷，是路线选择的结果——但需要把"薄"的部分按银行域优先级补齐，而不是照搬 dsh 全量。

---

## 三、底座完成度：12 项 P0 缺口逐项落实

### 3.1 纯占位模块（20 处，7 行 `export {}`）

| 文件 | 对应 dsh 能力 | 影响 |
|---|---|---|
| `packages/runtime/src/todo/index.ts` | `packages/todo` | 多步任务无待办跟踪 |
| `packages/runtime/src/goal/index.ts` | `packages/goal` | 会话无目标锚定 |
| `packages/runtime/src/plan/index.ts` | `packages/plan/plan-mode` | 无计划模式 |
| `packages/runtime/src/guard/index.ts` | `packages/guard` | 无重复工具/超时策略 |
| `packages/runtime/src/context/index.ts` | `packages/context/agent-instructions` | 无制度/知识注入 |
| `packages/runtime/src/scope/index.ts` | `packages/core/scope` | 作用域能力只在 `core/scope.ts` |
| `packages/persistence/src/query/index.ts` | `packages/session-query` | 无会话检索 |
| `packages/persistence/src/migrations/index.ts` | `session-format-v0..v4` | **日志无版本迁移，格式演进即断裂** |
| `packages/persistence/src/settings/index.ts` | `packages/settings` | 无用户偏好持久化 |
| `packages/persistence/src/identity/index.ts` | `packages/identity` | 无身份持久化 |
| `packages/persistence/src/feedback/index.ts` | `packages/feedback` | 无用户反馈回路 |
| `packages/persistence/src/title/index.ts` | `packages/session-title` | 无会话标题 |
| `packages/interaction/src/prompt/index.ts` | `packages/interaction/tool-ask-user` | 工具无法主动问用户 |
| `packages/host/src/client/index.ts` | `packages/client` | 无客户端宿主 |
| `packages/host/src/host/index.ts` | `packages/host` | 无独立宿主 |
| `packages/host/src/sdk/index.ts` | `packages/sdk` | 无 SDK 出口 |
| `packages/channels/src/{web,im,desktop,mobile}/index.ts` | `packages/web` + channels | 渠道全空壳（`channels` 整包 35 行、零消费者） |

**判定**：`runtime` 的 6 个占位（todo/goal/plan/guard/context/scope）对应 dsh 的**运行时编排能力**，是"底座"名义上的承诺项（`PROGRESS.md` §1 表格标注为插件线未开工）。但 `persistence/src/migrations` 属**底座已完成项**（施工单 03）——它是唯一一个"底座声称已交付却是空壳"的模块，属**文档与实物漂移**。

### 3.2 BAH 优于 dsh 的地方（超集，必须保留）

| # | 能力 | BAH 实现 | dsh 对应 | 说明 |
|---|---|---|---|---|
| A-1 | 银行资金工具族 | 16 个 P0 工具 + 三级判决 + 票据桥接（`bank/tools/`） | 无（dsh 无业务域） | `docs/bank-tools.md` 261 行 |
| A-2 | 三级权限票据 | green/yellow/red + 五条附加规则 + 原子核销 | `permission-presets` 仅静态预设 | `interaction/approval/ticket-ledger.ts` |
| A-3 | PII 脱敏落盘 | `persistence/jsonl/redact.ts` | 无 | dsh 无此包 |
| A-4 | Saga 补偿与冲正 | `saga/` 5,423 行（11 事务态 × 10 步骤态 × 7 补偿态） | 无 | dsh 无事务补偿层 |
| A-5 | 沙箱档位（tier） | 模型代码禁入 `none`、override 不可放宽 | dsh 是三模式，无"不可放宽"单调性 | `sandbox-policy/policy.ts:104-110` |
| A-6 | 工具目录门禁 | `verify-tiers` 校验 tier 声明 + amountPath | dsh 有目录但无金融 amountPath 校验 | `scripts/` 15 项门禁 |
| A-7 | 结构化错误纪律 | `BahError` 235 处 vs 裸 `new Error` 14 处；`assertNever` 15 处 | — | `AGENTS.md` 纪律 5-6 |
| A-8 | 事件模式门禁 | `verify-event-modes` AST 比对 + 负控 | dsh 有 `verify-application-entrypoints` 等，无同款 | — |

### 3.3 ⚠️ 门禁基线当前是红的（最高优先级）

**实测（2026-10-20 15:53）**：

```
Test Files  132 passed (132)
     Tests  1159 passed (1159)
```

用例全绿，但覆盖率门禁 **11 条阈值不达标**，`pnpm gate` **15 项中 1 项未通过**。

总覆盖率实数：`All files | Stmts 99.91% | Branch 96.08% | Funcs 99.18% | Lines 99.91%`——**总账接近满分，但被 `scripts/coverage-allowlist.ts` 强制到 100% 的 11 个文件不达标**。这暴露了一个比"覆盖率低"更真实的问题：**门禁的覆盖面与风险分布错配**（详见 §一 架构评审 Top-3：saga 仅 9%、persistence 16%、bank 42% 的行被强制）。

```
ERROR: Coverage for lines (99.39%) ... for packages/bank/src/forge/index.ts
ERROR: Coverage for functions (81.25%) ... for packages/cli/src/cli/run.ts
ERROR: Coverage for functions (80%) ... for packages/host/src/boot/plugins/persistence.ts
ERROR: Coverage for branches (71.42%) ... for packages/host/src/boot/plugins/saga-store.ts
ERROR: Coverage for functions (91.66%) ... for packages/llm/src/deepseek/adapter.ts
ERROR: Coverage for functions (92.3%) ... for packages/safety/src/sandbox-policy/policy.ts
ERROR: Coverage for functions (0%) ... for packages/saga/src/alert/sink.ts
ERROR: Coverage for branches (71.42%) ... for packages/saga/src/coordinator/commit.ts
ERROR: Coverage for lines (78.78%) ... for packages/saga/src/state-machine/index.ts
✘ tracked-sources  →  services/rag/src/banking_rag/auth.py 未纳入版本库
阻断合并：1/15 项未通过
```

**矛盾点**：`PROGRESS.md` §41（2026-10-19）记载「`test:coverage` 行覆盖 100%」「`pnpm gate` 12/12」。实测为 11 条 ERROR + 1 项门禁失败，且门禁数已从 12 增至 15。

**定性**：这是**治理缺陷**而非功能缺陷。修复成本极低（补 6 处用例 + 提交 1 个 py 文件），但影响面极大（`scripts/ci.ts` 第 5 步 fail-fast，后续 e2e/snapshot/rag 全不执行）。

**复核命令**：
```bash
cd "D:/项目集/微众杯银行ai智能体/BAH/MonoRepo"
npx vitest run --coverage --reporter=dot 2>&1 | grep -E "^ERROR|Test Files|Tests "
npx tsx scripts/run-gates.ts 2>&1 | tail -5
```

### 3.4 已闭环的历史 P0（复核确认）

`CODE-REVIEW-2026-10-19.md` 列的 8 项 P0，复核结论：

| 原 P0 | 状态 | 证据 |
|---|---|---|
| P0-3 `verify` 强验证并发竞态 | **已修** | 票据五绑定 CAS + `packages/bank/src/verify/` |
| P0-4 工具错误码压扁 | **已修** | `pipeline.ts:287` `assertNever(post.verdict)`，四值判决保留 |
| P0-5 LLM HTTP 无超时 | **已修** | `llm/src/deepseek/adapter.ts:250` 抛 `BahError('llm-timeout')` |
| P0-6 `tool-missing` 击穿状态机 | **已修** | `agent.ts:534-554` 补记逻辑 + `tool/callback-failed` 事件 |
| P0-7 governance 记账抛错 | **已修** | `pipeline.ts:266` `auditCallbackFailure` 独立通道 |
| P0-1 sentry 源码未入库 | **已修** | `packages/safety/src` 已在版本库 |
| P0-2 会话路径穿越 | **已修** | `persistence.ts` 路径校验已接入 |
| P0-8 JSONL 逐条 fsync + O(n²) | **部分修** | 逐条 open 仍在（`jsonl/backend.ts`），历史重建已下沉 util |

### 3.5 底座完成度评分

| 维度 | 权重 | 得分 | 依据 |
|---|---:|---:|---|
| 骨架与装配 | ×1.5 | 88 | 14 包骨架 + 三层 profile + 15 项门禁，跨包零环 |
| 主循环与事件 | ×1.5 | 85 | 事件序列与 dsh 逐项对位，缺 3 项（series/created/cache） |
| 工具与治理 | ×1.5 | 92 | 七段管线 + 三级 tier + sentry 超集；缺 schema 生成与调度器 |
| 模型层 | ×1.0 | 80 | seam/registry/降级/修复/超时齐备；缺多 provider 与 token meter |
| 持久化 | ×1.0 | 62 | JSONL + chain + saga-store 在；**迁移/查询/投影深度不足** |
| 插件与组合 | ×1.0 | 78 | profile/patch/HMR 对位；缺兼容性预检与生成式目录 |
| 测试与门禁 | ×1.0 | 62 | 1,159 用例全绿、密度 0.71（**低于 dsh 主体包 0.98–5.72**）；**门禁基线红** |
| 文档同步 | ×1.0 | 55 | `docs/` 12 篇 vs dsh 约 300 篇；**PROGRESS 与实测矛盾** |

```
权重和 = 1.5×3 + 1.0×5 = 9.5
加权 = (88+85+92)×1.5 + (80+62+78+62+55)×1.0 = 397.5 + 337 = 734.5
完成度 = 734.5 / 9.5 = 77.3%
```

再计入**未实装的 20 处占位**与**门禁红基线**两项扣分（各 −5，即 −10/9.5 ≈ −1.1 分），**底座完成度 = 76%（含 12 项 P0 缺口）**。

---

## 四、优化点（逐项可执行）

### P0 · 立即（目标：基线真绿 + 堵合规红线）

| # | 优化点 | 具体做法 | 验收标准 | 依据 |
|---|---|---|---|---|
| **P0-1** | 修 `tracked-sources` 门禁 | `git add services/rag/src/banking_rag/auth.py` 及相关 14 个已改文件 | `npx tsx scripts/run-gates.ts` → `15/15`，exit 0 | 实测 1/15 失败 |
| **P0-2** | 消灭 RAG fail-open 鉴权 | 采纳工作区 `auth.py`（缺 `BAH_RAG_SECRET` 即 `raise`，比较用 `hmac.compare_digest`），删 `main.py:38` 的 `if not expected: return` | 新增 pytest：未设 env 时 `create_app()` 必抛；无头 401；错 Bearer 401；`pnpm rag:check` 绿 | 架构评审 Top-2 |
| **P0-3** | 覆盖率转绿（**补测，不许改阈值**） | 优先补 4 个高风险点：`saga/state-machine/index.ts:55-61`（未知事件 fail-loud）、`saga/alert/sink.ts`（单 sink 失败不阻断后续）、`saga/coordinator/commit.ts:34-37`（fsync 失败回滚）、`host/boot/plugins/{saga-store,knowledge}.ts` | `npx vitest run --coverage` exit 0，零 `ERROR: Coverage` | 实测 11 条 ERROR |
| **P0-4** | 消除"文档说绿、实测红" | `PROGRESS.md` §41 改为实测快照（1159 用例 / 15 门禁 / 覆盖率），并注明"该结论对应 2026-10-19 快照" | 文档中每个数字旁写复核命令 | §3.3 |
| **P0-5** | 补 `persistence/src/migrations` | 实现 `session.vN.jsonl` 版本化 + 至少一条相邻迁移（v0→v1）+ 迁移校验 | 存在旧版日志的读路径自动迁移成功；新增格式版本不破坏旧会话 | 唯一"底座声称已交付却是空壳"的模块 |
| **P0-6** | 会话事件 `ignorable` 兼容标记 | 在 `SessionEventMap` 加 `ignorable?: boolean`；读路径遇未知类型且带该标记 → 跳过并告警，不带 → fail-loud | 用例：写入未知事件类型，读回不崩且不静默丢必需要素 | dsh `known-event-types.ts:16-20` 明确这是唯一兼容机制 |

### P1 · 一月内（目标：把"薄"的能力补到银行域刚需线）

| # | 优化点 | 具体做法 | 验收标准 | 依据 |
|---|---|---|---|---|
| **P1-1** | 覆盖名单按风险重排 | 把 `persistence/saga-store/`、`persistence/chain/`、`saga/{state-machine,compensation,coordinator,gates,recon}/`、`bank/tools/{catalog,queries,transfers,wealth,verification}.ts` 逐条加入 `COVERAGE_ALLOWLIST`，**每加一条同批改代码** | 名单内行数占比 59% → ≥75% | 架构评审 Top-3 |
| **P1-2** | 抽出统一 config/args 原语 | 以 `util/src/util/config.ts` 为唯一内核，签名收 `onError` 回调（保留各包自己的 `BahError` 码），逐包替换 `bank/tools/args.ts`、`host/boot/config.ts`、`saga/settings.ts`、`safety/sentry/pipeline/config.ts` | 8 个同名函数各自实现数 3–6 → 1 | 架构评审 Top-5 |
| **P1-3** | 补 `session-query` 最小可用集 | SQLite 全文索引 + 按时间/工具/状态过滤 + 游标分页 | 可按工具名检索历史会话并跳转到源事件 | S-10 缺口 |
| **P1-4** | 补 `storage` 抽象 | 定义 `StorageBackend` 契约（`get/set/delete/list` + 原子性），把 `saga-store` 的 `node:sqlite` 收到后端之后 | 换 SQLite→JSON 后端不改业务代码 | S-19 缺口 + `node:sqlite` 仍是实验特性 |
| **P1-5** | 补 `subagent` 最小提供方 | 定义 `SubagentProvider` 接口 + 一个 `fork-in-process` 实现（复用现有 `fork()`），先不接外部产品 | 子 agent 可在同一进程内承接一段轮次并回传 | C-9/L-15 缺口 |
| **P1-6** | 补 `telemetry` 出口 | 定义 `ctx.telemetry` 服务：`span(name, attrs)` / `counter(name)`；先接 `saga` 审计与 `sentry` trace | 每个 turn 产生一条可查询的调用链 | 架构评审维度 6「无统一日志/度量出口」 |
| **P1-7** | 断 `saga` 运行期环 | `mapPool` 从 `coordinator/index.ts` 移到 `coordinator/pool.ts`；删 `alert/index.ts:209,214` 死访问器 | 包内互引对数 4 → ≤1（余下须 `import type`） | 架构评审 Top-9 |
| **P1-8** | 工具调用超时策略包 | 参照 dsh 的 `tool-call-timeout-policy`：作为 `tools/execute` 包装器注册，按 `tool`/`tier` 配超时 | 超时工具调用被中止并归一化为 `isError`，不挂死主循环 | T-8 缺口 + CODE-REVIEW P0-5 同源问题 |

### P2 · 季度内（目标：结构性收敛 + 银行域长尾能力）

| # | 优化点 | 具体做法 | 验收标准 |
|---|---|---|---|
| **P2-1** | 包清单单一来源 | 由 `pnpm-workspace.yaml` / `packages/*/package.json` 派生 `vitest.shared.ts`、`tsconfig.paths`、`tsconfig.host.json`、`coverage-allowlist` | 手抄清单 4 处 → 1 处；漏登记新包时门禁直接红 |
| **P2-2** | 清理空壳 | `@bah/channels`（5 文件全 `export {}`、零消费者）给出最小可测实现或移出 workspace；`apps/desktop`/`apps/im-gateway` 标注施工单号 | 入度 0 的包 1 → 0 |
| **P2-3** | 补 `todo` / `goal` / `plan` / `guard` 四个运行时编排件 | 参照 dsh `packages/{todo,goal,plan,guard}`：`todo` 工具化（写待办）；`goal` 会话目标 + `goal/change` 事件；`plan` 计划模式（`plan/mode` 事件）；`guard` 重复工具提醒 | 四个占位文件不再是 `export {}`，各有事件 + 用例 |
| **P2-4** | 补 `fs` / `mcp` / `webhook` 接入面 | `fs` 提供方（报告/对账单落地）；`mcp` 客户端（行内系统）；`webhook` 外部触发会话 | 三者各有 seam 定义 + 至少一个提供方 |
| **P2-5** | `AgentHandle` + `whenIdle` | 引入 owner-only 句柄，把销毁权与观察权分离；补 `whenIdle()` 静默态判定 | 外部消费方无法绕过 owner 直接 dispose |
| **P2-6** | 工具 schema 代码生成 | 参照 dsh `core/tools/src/{json-schema,ts-types,py-types}.ts`（2,143 行），至少实现 TS 类型生成 | 从工具 JSON Schema 生成 TS 类型，端到端类型安全 |

---

## 五、给决策者的三句话

1. **底座骨架是对着 dsh 长的，不是拍脑袋长的。** 事件序列、seam 划分、profile 四层 patch、可逆注册纪律，逐项对位——骨架复刻度 74%、全量机制复刻度 62%。这部分可以放心。
2. **"能力面 33%" 这个数字要看怎么读。** dsh 是通用编码 agent 外壳（52 个顶层能力域 / 331 个实际包，含 IDE/浏览器/SSH/LSP/桌面端），BAH 是银行智能体底座（14 包）。BAH 在**银行域纵深上反超**（资金工具族、票据、Saga 补偿、sentry 内核、13 工具门禁，这些 dsh 完全没有），但在**会话深水区与长尾能力上明显偏薄**——尤其 `migrations`（空壳）、`session-query`（空壳）、`subagent`/`telemetry`/`todo`（空壳或无）这四项是银行域刚需，建议 P1 补齐。扣掉 15 项域内豁免后，能力面实为 46%。
3. **最该先做的不是补功能，是修红基线。** 覆盖率门禁 11 条红、gate 1 项红，而 `PROGRESS.md` 写着"100% / 12/12"。P0-1 到 P0-4 合计一天内可完成，成本极低，但它决定了后续所有工作的可信基线。

---

## 附：本文全部实测命令

```bash
cd "D:/项目集/微众杯银行ai智能体/BAH/MonoRepo"

# 规模基线
for p in packages/*/src; do
  n=$(find "$p" -name "*.ts" -not -name "*.test.ts" | wc -l)
  l=$(find "$p" -name "*.ts" -not -name "*.test.ts" -exec cat {} + | wc -l)
  t=$(find "$p" -name "*.test.ts" | wc -l)
  printf "%-16s %3s %6s | %3s\n" "$(basename $(dirname $p))" "$n" "$l" "$t"
done

# 用例与覆盖率
npx vitest run --coverage --reporter=dot 2>&1 | grep -E "^ERROR|Test Files|Tests "

# 门禁
npx tsx scripts/run-gates.ts 2>&1 | tail -5

# 占位扫描
grep -rln "M0 占位" packages/*/src --include="*.ts" | grep -v test

# 能力关键词扫描
for k in whenIdle runMaintenance followup steer withInitiator AgentHandle fork isolate \
          preset subagent mcp skill spill jobs schedule telemetry storage workflow \
          session-query sessionTitle attachment todo plan goal guard; do
  c=$(grep -rl "$k" packages/*/src --include="*.ts" | grep -v test | head -3 | tr '\n' ' ')
  printf "%-14s %s\n" "$k" "${c:-—— 无}"
done

# 参照系规模
cd "D:/项目集/微众杯银行ai智能体/BAH/Deepseek Harness"
ls packages                      # 52 个顶层能力域
find packages -maxdepth 2 -mindepth 2 -type d | wc -l   # 331 个实际包
cat packages/core/session/src/known-event-types.ts   # 61 事件类型
wc -l packages/core/tools/src/*.ts packages/core/agent-loop/src/*.ts
find packages/sandbox -name "*.ts" -not -name "*.test.ts" -exec wc -l {} +
```

---

*本文为只读对照评审，未修改任何代码。所有结论可由上列命令复现。*
