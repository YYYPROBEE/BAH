# 可观测性（D2 + 观测面）

> 定位：**单机、单进程**。这是"演示与排障时能看见什么"，不是分布式监控，也没有 APM。

## 0. 一句话边界

**有指标端点（JSON + Prometheus）、结构化日志、告警出口、轨迹端点与 Chrome Trace 导出、
Web 观测面板与三条 CLI；没有跨实例聚合、没有 APM、没有 TSDB、没有实时推送。**

换句更直白的：轨迹是从会话事件**派生**的视图，不是第二份账；指标每次抓取**现算**，重启即归零。
这里的"观测"服务的是"这笔转账为什么慢 / 谁批的 / 花了多少"，不是"机房有几台机器"。

## 1. 三个平面：事实 / 轨迹 / 数字

| 平面 | 载体 | 回答什么 | 谁写 |
|---|---|---|---|
| 事实 | `session.jsonl`（append-only 事件） | 发生了什么、批没批、多少钱 | 运行时与各领域插件 |
| 轨迹 | 事件成对派生 + 少量包裹得到的 span | 时间花在哪、哪个环慢 | `@bah/telemetry` |
| 数字 | `/api/metrics`（每次请求现算） | 多少、多错、多慢、多少钱 | 指标登记表 |

三条纪律：

1. **两真相分离**：事实是数字的唯一来源，轨迹永不算数（采样丢一条，图少一个节点，账不能少一笔）；
2. **按需派生**：指标与轨迹都从同一份事件快照现算，不维护第二套计数器；
3. **遥测 fail-open**：遥测任何环节抛错都只计数、不改业务结果；审计链仍 fail-closed。

## 2. `GET /api/metrics`

与业务路由同闸（`Authorization: Bearer`，401 而不是公开）。全部数字**从会话事件现算**。
不出原文：prompt、工具结果、账号、姓名一律不进这个端点，它只回答"多少、多慢、多少钱"。

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
| `sseClients` | 当前 SSE 在线连接数 | 单进程内计数 |
| `http` | 请求数 / 5xx / 429 / in-flight / 墙钟分位 | `durationMs` 无样本时 `null` |
| `llm` | 请求数 / 错误数 / TTFT 分位 / 逐 turn token | TTFT 暂无样本时 `null` |
| `cost` | `configured` / `currency` / `total` / `byTurn` / `budget` | `budget.*` 未配时为 `null`（不是 0）；`configured=false` ≠ "免费" |
| `plan` | `nodes.{succeeded,failed,blocked,skipped}` | 从 `plan/node-*` 现算 |
| `slo` | saga 八指标；没装 saga 时为 `null` | 无数据 `value:null` + `verdict:"no-data"` |
| `process` | uptime / rss / heap / event-loop p99 / node | 单进程快照 |
| `telemetry` | spans / dropped / treeDepth | 遥测自身水位 |
| `logs` | byLevel / suppressed | 结构化日志计数 |
| `alerts` | byLevel / byResult | 告警扇出结果 |

### 2.1 Prometheus 协商

`GET /api/metrics?format=prometheus`（或 `Accept: text/plain`）输出 Prometheus 文本：
HELP/TYPE/样本三段式，标签是闭集（工具名只在登记表的值域里）。
全部 family 的登记表见 §9。

可直接粘贴的抓取配置：

```yaml
scrape_configs:
  - job_name: bah
    scrape_interval: 15s
    authorization: { credentials: "<BAH_WEB_TOKEN>" }
    metrics_path: /api/metrics
    params: { format: ["prometheus"] }
    static_configs: [{ targets: ["127.0.0.1:7331"] }]
```

注意：counter 由"事件条数"现算，进程重启后 Prometheus 会看到 counter reset；这不是 bug，
本仓库没有持久化指标（§8 第 2 条）。

## 3. `GET /api/trace`

三种出口（鉴权同 §2，GET 不受 CSRF 管）：

| 请求 | 响应 |
|---|---|
| `GET /api/trace` | JSON 森林：`{ traceId, sessionId, clock, stats, roots }` |
| `GET /api/trace?format=chrome` | Chrome Trace Event Format（裸数组） |
| `GET /api/trace?limit=N` | 只取最近 N 条 span（默认 UI 用 2000） |

`roots` 是**森林不是一棵树**：`POST /api/turn` 只入队就返回 202，turn 在另一条微任务链上跑，
两者没有调用栈关系，强行画成父子就是伪造。父 span 被采样丢掉时提升为根并标 `attributes.orphan`。

`clock` 为 `frozen` 表示快照回放（事件时间戳被冻结），此时时长不可用、只有结构可信。

```bash
# 导出给 Perfetto：打开 https://ui.perfetto.dev → Open trace file
pnpm bah trace --token <demo-token> --format chrome --out trace.json

# 直接看森林
pnpm bah trace --token <demo-token> --format json | head -60
```

单次响应上限 4 MiB，超了返回 503 `trace-too-large`——**不截断返回半棵树**；用 `?limit=N` 收敛。

## 4. 成本：`costMicroYuan` 怎么才算得出数

`usage/summary` 事件一直有 `cachedInput` 与 `costMicroYuan` 字段，但**只有配了 `pricing` 的 provider 才有非 0 值**：

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

1. **单位是微元/百万 token 的整数**（1 元 = 1e6 微元）。金额不碰浮点；`toFixed` 只允许出现在 CLI/UI 的显示层。
2. **仓库里没有任何官方报价**。`profiles/web/patch.yml` 里那三行是**演示占位价**，
   真实账单必须由部署方按合同核价后改。
3. **本地 provider（`mock` / `router`）写 `pricing` 会直接拒绝装配**：它们没有上游成本，
   记一个假价只会污染成本口径。所以主演示（router）显示 0 元是**正确**的，不是"没配好"。

预算闸（`agent/pre-step` 查上一轮、`agent/turn-stopping` 查会话累计）触发后按 `guard-stopped` 收尾；
`cost.budget.*` 未配时为 `null`，**不许把"没预算"输出成 0**。

离线看一个会话目录：

```bash
pnpm bah cost --dir sessions/<session-id>
```

没配计价时输出末尾带「（未配计价）」——`0` 不等于"免费"。

## 5. 结构化日志

`@bah/util` 的 `logJson(level, code, fields)` 是**唯一出口**，打单行 JSON 到 stderr：

```json
{"ts":"2026-10-27T07:18:06.695Z","level":"error","code":"saga-recovery-failed","reason":"..."}
```

- **级别过滤**：`BAH_LOG_LEVEL`（debug/info/warn/error，缺省 info）；低于阈值不序列化，只计 `suppressed`。
- **文件出口**：`BAH_LOG_FILE` 指向路径时同写文件，固定 8 MiB × 3 份轮转。
- **上下文**：`runWithLogContext({sessionId,traceId,turn,spanId,component})` 自动合并进每一行。
- **固定字段不可覆盖**：`ts` / `level` / `code` 是保留键，`fields` 里同名键会被丢弃（否则告警级别会写成告警内容）。
- **code 闭集**：全部 code 与出处见 [log-codes.md](log-codes.md)；新增 code 不同批登记会让 `verify-observability` 红。
- **字段丢弃**：`key` / `apiKey` / `token` / `secret` / `password` / `authorization` / `cookie`
  整条丢弃（不是打码——打码也会泄漏长度）。

`console.*` 只剩唯一出口 `util/logging.ts` 与 CLI 产品输出（`cli/main.ts`），两者都在门禁白名单里。

## 6. 告警出口

`@bah/saga` 的告警汇是**进程内 fanout**，本身**没有默认出口**：没人 `registerAlertSink` 时告警会静默消失。
宿主装配位（`packages/host/src/boot/plugins/saga.ts`）固定补三路：

1. **stderr 单行 JSON**（永远在，`code: saga-alert`）；
2. **可选文件出口**：设 `BAH_ALERT_LOG=/path/to/alerts.jsonl` 后每次告警追加一行
   `{ts, kind:'saga-alert', level, message}`。不自动建目录——路径写错要立刻暴露；
3. **可选 webhook**：`obs:telemetry.alerts.webhook` 或 `BAH_ALERT_WEBHOOK`（http/https）。
   超时 3s、最多 3 次（500ms/1s/2s 退避）、同 `(metric,detail)` 60s 去重、队列上限 100；
   投递失败只计 `bah_alerts_total{result="failed"}`，**绝不 await 主链路**。

## 7. SLO 八指标

八项固定顺序（与 `SLO_METRICS` 一致）：`compFailureRate` / `danglingP95` / `posNegMismatchRate` /
`dlqDepth` / `chainBreak` / `rto` / `reconHeartbeat` / `residualDiffRate`。

- **`value === null` 是"无数据"，不是 0**：JSON 给 `null`，Prometheus 给 `NaN`，面板显示「无数据」+ `no-data`；
- **判决由服务端给**（`sloVerdict`）：`ok` / `alert` / `P0` / `no-data`，前端不重算阈值；
- **`slo === null` 表示本 profile 没装 saga**，不是"八项全是 0"；面板整表空态，不渲染 0。

## 8. 已知缺口（登记不粉饰）

1. **不做跨实例聚合**：单进程单会话；多租户/多实例汇聚是 D4 之后的事。
2. **无指标留存**：每次抓取现算，重启即归零——Prometheus 侧表现为 counter reset。
3. **快照回放的时长为 0**：时钟冻结，只有 `durationMs` 类字段是真值，`clock:'frozen'` 时面板明确标注。
4. **成本只归因到轮**：`byTurn` 能看每轮，不按工具/节点摊派；不编数字。
5. **主演示 provider 是本地 router，没有上游账单**：`costMicroYuan` 恒 0 是正确行为，不是"免费"。
6. **告警只到 stderr / 文件 / 单个 webhook**：没有重试队列与值守排班；webhook 失败只计数。

## 9. 指标登记表（生成块）

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
