# 可观测性与成本（D2）

> 定位：**单机、单进程**。这是"演示与排障时能看见什么"，不是分布式监控，也没有 APM。
> 一句话边界：**有指标端点、有结构化日志、有可配置告警出口、有库内 span 派生与 Chrome / JSON 导出（可选落 `span.jsonl`）；
> 没有 HTTP trace 端点、没有跨实例聚合、没有成本看板 UI。**

## 1. 成本：`costMicroYuan` 怎么才算得出数

`usage/summary` 事件一直有 `cachedInput` 与 `costMicroYuan` 字段，但**没有 profile 配 `pricing`**，
所以成本恒为 0。现在 `core:model` 支持 `pricing`：

```yaml
- id: core:model
  config:
    provider: deepseek
    model: deepseek-v4.1-flash-1017
    pricing:
      inputPerMTok: 2000000        # 微元 / 百万 token = 2 元 / 百万 token
      cachedInputPerMTok: 500000   # 命中缓存 0.5 元
      outputPerMTok: 8000000       # 输出 8 元
```

三条纪律：

1. **单位是微元/百万 token 的整数**（1 元 = 1e6 微元）。金额不碰浮点——宪法 R-5 的同一条理由。
2. **仓库里没有任何官方报价**。`profiles/web/patch.yml` 里那三行是**演示占位价**，
   真实账单必须由部署方按合同核价后改。
3. **本地 provider（`mock` / `router`）写 `pricing` 会直接拒绝装配**：它们没有上游成本，
   记一个假价只会污染成本口径。所以主演示（router）显示 0 元是**正确**的，不是"没配好"。

## 2. `GET /api/metrics`

与业务路由同闸（`Authorization: Bearer`，401 而不是公开）。全部数字**从会话事件现算**，
不另建计数器——重启、回放、fork 之后两个数必然对不上，而"哪个对"没人说得清。

```bash
# 演示 token 由 demo:web 启动时打印（本文件不写死，也不落盘）
curl -s -H "Authorization: Bearer <demo-token>" http://127.0.0.1:7331/api/metrics
```

返回的键（固定，脚本按它取数）：

| 键 | 含义 | 注意 |
|---|---|---|
| `turns` | `turn/end` 条数 | 不是"用户发了几句" |
| `tools.calls` / `tools.errors` | `tool/call` 数与 `tool/result.isError` 数 | `errors` 含审批拒绝、参数非法、沙箱不可用等所有失败 |
| `tools.durationMs.p50` / `p95` | 工具耗时分位 | 样本为 0 时返回 **`null`**，不是 0 |
| `approvals.asked` / `approved` / `rejected` / `other` | 审批分布 | `other` 含 `unavailable`（无人值守默认拒绝）/ `timeout`，**不并进 `rejected`** |
| `usage.input` / `output` / `cachedInput` / `costMicroYuan` | token 与成本 | 跨 turn 累加 |
| `halt` | `null` = 本 profile 没装 HALT；否则 `{status, halted, reason}` | "没装"和"未停机"必须能分开 |
| `sseClients` | 当前 SSE 在线连接数 | 上限 16（见 `docs/performance.md`） |
| `http` | 请求数 / 5xx / 429 / in-flight / 墙钟分位 | `durationMs` 无样本时 `null` |
| `llm` | 请求数 / 错误数 / TTFT 分位 / 逐 turn token | TTFT 暂无样本时 `null` |
| `cost` | `configured` / `currency` / `total` / `byTurn` / `budget` | `budget.*` 未配时为 `null`（不是 0）；`configured=false` ≠ "免费" |
| `plan` | `nodes.{succeeded,failed,blocked,skipped}` | 从 `plan/node-*` 现算 |
| `slo` | saga 八指标；没装 saga 时为 `null` | 无数据 `value:null` + `verdict:"no-data"` |
| `process` | uptime / rss / heap / event-loop p99 / node | 单进程快照 |
| `telemetry` | spans / dropped / treeDepth | 遥测自身水位 |
| `logs` | byLevel / suppressed | 结构化日志计数 |
| `alerts` | byLevel / byResult | 告警扇出结果 |

**不出原文**：prompt、工具结果、账号、姓名一律不进这个端点。它只回答"多少、多慢、多少钱"。

`GET /api/metrics?format=prometheus`（或 `Accept: text/plain`）输出 Prometheus 文本：
36 个 metric family 的登记表见 §7；标签是闭集，工具名只在 16 个值里。

## 3. 结构化日志

`@bah/util` 的 `logJson(level, code, fields)` 是**唯一出口**，打单行 JSON 到 stderr：

```json
{"ts":"2026-10-27T07:18:06.695Z","level":"error","code":"saga-recovery-failed","reason":"..."}
```

- **级别过滤**：`BAH_LOG_LEVEL`（debug/info/warn/error，缺省 info）；低于阈值不序列化，只计 `suppressed`。
- **文件出口**：`BAH_LOG_FILE` 指向路径时同写文件，固定 8 MiB × 3 份轮转。
- **上下文**：`runWithLogContext({sessionId,traceId,turn,spanId,component})` 自动合并进每一行。
- **code 闭集**：全部 code 与出处见 [log-codes.md](log-codes.md)；新增 code 不同批登记会让 `verify-observability` 红。
- **字段丢弃**：`key` / `apiKey` / `token` / `secret` / `password` / `authorization` / `cookie`
  整条丢弃（不是打码——打码也会泄漏长度）。

`console.*` 只剩 **2 个文件 / 3 行**：`util/logging.ts`（唯一出口）与 `cli/main.ts`（CLI 产品输出）。

## 4. 告警出口

`@bah/saga` 的告警汇是**进程内 fanout**，本身**没有默认出口**：
没人 `registerAlertSink` 时告警会静默消失。宿主装配位（`packages/host/src/boot/plugins/saga.ts`）固定补两路：

1. **stderr 单行 JSON**（永远在，`code: saga-alert`）；
2. **可选文件出口**：设 `BAH_ALERT_LOG=/path/to/alerts.jsonl` 后每次告警追加一行
   `{ts, kind:'saga-alert', level, message}`。不自动建目录——路径写错要立刻暴露；
3. **可选 webhook**：`obs:telemetry.alerts.webhook` 或 `BAH_ALERT_WEBHOOK`（http/https）。
   超时 3s、最多 3 次（500ms/1s/2s 退避）、同 `(metric,detail)` 60s 去重、队列上限 100；
   投递失败只计 `bah_alerts_total{result="failed"}`，**绝不 await 主链路**。

## 5. 已知缺口（登记不粉饰）

1. **Web 前端不显示成本**：`/api/metrics` 有数，页面没渲染。做它要改 `apps/web` 的指标卡，
   与 W18 的界面录屏同批更划算。
2. **SLO 八指标只在装了 saga 的 profile 有值**：`slo` 为 `null` 表示"本 profile 没装 saga"，
   不是"八项全是 0"。
3. **成本归因只到 turn**：`bah_llm_cost_micro_yuan_total{model}` 的 `model` 取该 turn 最后一条
   `request/header`；一轮里换过模型时全部成本归到最后一个模型，属归因近似，**不许当精确值讲**。
4. **没有 trace / metrics 的持久保留**：span 默认只在内存环形缓冲（可配 `span.jsonl`），
   指标刷新即重算；`/api/trace` 也只暴露当前会话。跨实例对比无从谈起。
5. **`usage/summary` 的 `calls` 不计缓存命中率**：要算命中率得拿 `cachedInput / input`，指标端点没做这个派生。

## 6. 轨迹（span）与 `sentry/trace` 不是一回事

两者名字里都有 trace，但**数据源、结构、用途**完全不同：

| | `@bah/telemetry` 的 span | `sentry/trace` |
|---|---|---|
| 数据源 | `session.jsonl` 的成对事件派生 + 少量包裹点计时 | sentry 内核的推理轨迹（`trace.sink='session'` 时逐行落领域事件） |
| 结构 | 扁平的 `(spanId, parentSpanId, startMs, endMs)`，可建森林 | 文本化的推理步骤记录 |
| 用途 | 回答"时间花在哪、哪个环慢" | 审计与复盘"当时怎么判的" |
| 是否参与计数 | **否**（计数与金额只从事件现算） | 否 |

纪律：不要把 `sentry/trace` 当 span 的数据源，也不要用 span 算任何业务数字——
一旦采样丢一条，图只是少一个节点，账却会少一笔。`@bah/telemetry` 也不产生任何会话事件。

## 7. 指标登记表（36 个 family）

> 本表由 `npx tsx scripts/metrics-table.ts` 从 `METRIC_SPECS` 生成，**不许手写**。
> counter 必带 `_total`，时长必带 `_seconds`（秒，浮点），字节 `_bytes`，金额 `_micro_yuan`（整数）。

<!-- metrics:begin -->
| 指标 | 类型 | 标签 | 单位 | 口径 |
|---|---|---|---|---|
| `bah_up` | gauge | — | count | 恒 1；进程活着就能被抓到 |
| `bah_build_info` | gauge | `version`, `node` | count | 包版本 + process.version |
| `bah_process_start_time_seconds` | gauge | — | seconds | now - uptime |
| `bah_process_uptime_seconds` | gauge | — | seconds | process.uptime() |
| `bah_nodejs_rss_bytes` | gauge | — | bytes | process.memoryUsage().rss |
| `bah_nodejs_heap_used_bytes` | gauge | — | bytes | process.memoryUsage().heapUsed |
| `bah_nodejs_eventloop_lag_p99_seconds` | gauge | — | seconds | monitorEventLoopDelay 的 p99（每次抓取读一次） |
| `bah_http_requests_total` | counter | `route`, `method`, `status` | count | http.request span 结束 |
| `bah_http_request_duration_seconds` | histogram | `route` | seconds | 同上，桶见 02 §3.3 |
| `bah_http_in_flight` | gauge | — | count | 当前未结束的 http.request span 数 |
| `bah_http_rate_limited_total` | counter | — | count | 429 次数 |
| `bah_sse_clients` | gauge | — | count | hub.size()（复用既有值） |
| `bah_sse_frames_total` | counter | `event` | count | hub.publish / publishFault |
| `bah_turns_total` | counter | — | count | turn/end 条数（=== JSON 的 turns） |
| `bah_turn_duration_seconds` | histogram | — | seconds | turn/start → turn/end |
| `bah_turn_end_total` | counter | `reason` | count | turn/end.reason.kind |
| `bah_steps_total` | counter | — | count | step/end 条数 |
| `bah_llm_requests_total` | counter | `model`, `status` | count | request/header 计 request，assistant/attempt 计 error |
| `bah_llm_ttft_seconds` | histogram | `model` | seconds | llm.call span 的 ttftMs |
| `bah_llm_tokens_total` | counter | `kind` | count | usage/summary 累加 |
| `bah_llm_cost_micro_yuan_total` | counter | `model` | micro_yuan | usage/summary.costMicroYuan 累加（整数） |
| `bah_llm_cost_configured` | gauge | — | count | 1 = 配了 pricing；0 = 未配 |
| `bah_tool_calls_total` | counter | `tool`, `tier` | count | tool/call |
| `bah_tool_errors_total` | counter | `tool`, `codeClass` | count | tool/result.isError；code 按前缀归成 5 类 |
| `bah_tool_duration_seconds` | histogram | `tool` | seconds | tool/result.durationMs（权威值） |
| `bah_approvals_total` | counter | `decision` | count | approval/decided |
| `bah_approval_wait_seconds` | histogram | `name` | seconds | approval/asked → decided 的墙钟 |
| `bah_plan_nodes_total` | counter | `status` | count | plan/node-result + plan/node-blocked |
| `bah_plan_duration_seconds` | histogram | `status` | seconds | plan/completed.durationMs |
| `bah_slo_value` | gauge | `metric`, `verdict` | count | collectSloMetrics 八项；无数据 → NaN |
| `bah_cost_budget_remaining_micro_yuan` | gauge | `scope` | micro_yuan | 预算余额；未配预算 → 不输出该系列 |
| `bah_cost_budget_exhausted_total` | counter | `scope` | count | 触发判停次数 |
| `bah_telemetry_spans` | gauge | — | count | 环形缓冲当前条数 |
| `bah_telemetry_spans_dropped_total` | counter | `reason` | count | 淘汰计数 |
| `bah_log_lines_total` | counter | `level` | count | 每个 level 写出的行数 |
| `bah_alerts_total` | counter | `level`, `result` | count | 告警扇出结果 |
<!-- metrics:end -->
