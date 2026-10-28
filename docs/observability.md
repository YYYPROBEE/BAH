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

**不出原文**：prompt、工具结果、账号、姓名一律不进这个端点。它只回答"多少、多慢、多少钱"。

## 3. 结构化日志

`packages/host/src/boot/plugins/log.ts` 的 `logJson(level, code, fields)` 打**单行 JSON** 到 stderr：

```json
{"ts":"2026-10-27T07:18:06.695Z","level":"error","code":"saga-recovery-failed","reason":"..."}
```

已接线的出口（只有这三处，其余仍是拼接式日志，见 §5）：

| code | 何时 | 级别 |
|---|---|---|
| `saga-alert` | 告警汇（DLQ 升级、补偿失败、链断…） | P0 → `error`，其余 `warn` |
| `saga-alert-file-failed` | 可选文件出口写失败 | `warn` |
| `saga-recovery-failed` | 启动恢复失败 | `error` |
| `model-retry` | 上游 429 / 5xx 退避 | `warn` |

`logJson` 会**丢弃** `key` / `apiKey` / `token` / `secret` / `password` / `authorization` / `cookie`
这几类字段（不是打码——打码也会泄漏长度）。

## 4. 告警出口

`@bah/saga` 的告警汇是**进程内 fanout**，本身**没有默认出口**：
没人 `registerAlertSink` 时告警会静默消失。宿主装配位（`packages/host/src/boot/plugins/saga.ts`）固定补两路：

1. **stderr 单行 JSON**（永远在，`code: saga-alert`）；
2. **可选文件出口**：设 `BAH_ALERT_LOG=/path/to/alerts.jsonl` 后每次告警追加一行
   `{ts, kind:'saga-alert', level, message}`。不自动建目录——路径写错要立刻暴露。

> 生产应把这两路替换成 webhook / 邮件 sink（`registerAlertSink` 已就位），**不是赛前范围**。

## 5. 已知缺口（登记不粉饰）

1. **Web 前端不显示成本**：`/api/metrics` 有数，页面没渲染。做它要改 `apps/web` 的指标卡，
   与 W18 的界面录屏同批更划算。
2. **`collectSloMetrics` 仍未接进 `/api/metrics`**：SLO 八指标（补偿失败率、DLQ 深度、链断…）
   走的是 saga 自己的观测注入，与 web 指标端点之间**没有桥**。
3. **结构化日志只覆盖 3 个出口**：其余约 20 处 `console.*` 仍是拼接串（D6 §any/console 分类里登记）。
4. **没有 trace / metrics 的 HTTP 历史保留**：span 默认只在内存环形缓冲（可配 `span.jsonl`），
   指标刷新即重算；跨实例对比无从谈起。HTTP trace 端点与面板尚未提供。
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
