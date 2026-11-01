# 性能基线与资源上限（D1）

> 定位：**单机演示**。下面所有数字只用来抓**退化**（同一台机器前后对比），
> 不是吞吐承诺，也不能被引用成"高并发已验证"。
> 复跑：`npx tsx scripts/bench.ts`（可加 `--only=boot|turn|session|sse|log`）。

## 1. 口径

三项"实测"都是**真实代码路径**，两项是代理指标——分开写，避免把代理指标当实测：

| 项 | 是不是真实路径 | 说明 |
|---|---|---|
| `boot` | 真实 | `boot()` 全量装配（headless profile：session / tools / prompt / model(router) / agent / persistence / bank:tools），不含 Node 进程启动 |
| `turn` | 真实 | `agent.send()` + `agent.run()`，模型是离线 router（确定性，不受网络影响） |
| `session` | 真实 | 同一会话连续 100 轮，看 p50/p95 是否随轮次爬升 |
| `sse` | 真实 hub + 桩连接 | 10 条连接 × 200 帧；连接是内存桩，**不含网络与浏览器** |
| `log` | **代理** | 合成 jsonl 的 `readFileSync + split + 逐行 JSON.parse`；不是真实会话回放，只代表"日志变大后启动读取的下限成本" |

机器：Windows 10 x64 · Node **v22.22.2** · 本机磁盘（未区分 SSD/NVMe）。

## 2. 本期实测（2026-10-27）

```text
boot（冷启动）       n=  3  p50=63.26ms  p95=80.43ms  max=80.43ms
turn（首轮）         n=  1  p50=42.61ms  p95=42.61ms  max=42.61ms
session（100 轮）    n= 99  p50=32.87ms  p95=36.07ms  max=38.95ms
  前 10 轮 p50=31.13ms / 后 10 轮 p50=34.06ms · 堆增量 +3.8MB · 事件 1517 条
sse（10 连接）       n=200  p50≈0.00ms  p95≈0.00ms  max=0.05ms（累计写帧 2020）
log（1MB）           n=  5  p50=6.44ms   p95=11.22ms
log（10MB）          n=  5  p50=65.11ms  p95=76.14ms
```

怎么读这三行：

1. **长会话不退化**：100 轮里前 10 轮与后 10 轮的 p50 差 3ms（31.13 → 34.06），
   落在同一台机器的抖动范围内；如果这个差持续扩大，先怀疑 `deriveMessages` 的全量双扫
   （每 step 扫两遍事件）而不是模型。
2. **堆增长 +3.8MB / 100 轮**是线性还是泄漏，本期**没有判据**——只有一次运行，
   不足以区分"事件数组本来就在长"和"真泄漏"。要做结论必须跑 1000 轮并分段取样，
   属赛后（`docs/performance.md` 之后没有更细的采样脚本）。
3. **10MB 日志 ≈ 65ms**：启动时 `readFileSync` 全量读入，所以日志体积是**线性**成本。
   单会话一年也到不了 10MB，但 `sessions/` 下**累积**多会话时不清理会让启动变慢
   （见 §4 保留策略）。

## 3. 已加的资源上限

三个上限都是"防打爆"，不是产品语义；默认值都比演示正常量大 3 倍以上。

| 位置 | 上限 | 触顶行为 | 依据 |
|---|---|---|---|
| `packages/runtime/src/agent-loop/inbox.ts` | 待处理 **64** 条（`DEFAULT_MAX_PENDING`，构造可覆盖） | `BahError('inbox-full')`；Web 侧翻成 **503 `web-inbox-full`** | 两条车道原本是无界数组，`agent.send` 同步入队无背压 |
| `packages/host/src/boot/plugins/web/sse.ts` | 连接 **16** 条 / 单连接缓冲 **1 MiB** | 连接满 → **503 `web-sse-busy`**；缓冲超限 → 断开该连接 | 原本 `res.write` 直写、不处理背压，一个挂住不读的标签页能把内存拖到 OOM |
| `packages/runtime/src/agent-loop/agent.ts` | 单次并行批 **8** 个只读调用（`MAX_PARALLEL_READS`） | 超出的调用留到下一批（**顺序不变**） | 原本 `Promise.allSettled` 无并发上限，模型要 20 个就同时打 20 个 |

三条都有用例：`inbox.test.ts`（inbox-full / 两车道合计计数）、
`web/sse.test.ts`（连接上限 / 慢客户端摘除 / dispose）、
`web/dispatch.test.ts`（inbox 满 → 503）。并行批上限目前只有代码常量，
**没有专门的用例**钉住"第 9 个调用进下一批"——这是已知缺口，见 §5。

## 4. 日志保留策略（文档口径，开关未实现）

现状：`<部署根>/<tenant>/<sessionId>/session.jsonl` 与 `audit.jsonl` **只增不减**，
启动时 `verifyAll()` 会扫全部链。策略定如下，但**启动清理开关本期没做**：

- **保留**：演示与取证会话永久保留（它们是审计证据，删了就不可复核）；
- **归档**：超过 90 天或单会话超过 50MB，整目录移到 `sessions-archive/<yyyy-mm>/`（人工，不自动删）；
- **清理**：只允许删 `sessions-archive/` 下的归档，且必须先确认对应链已外部锚定（当前**没有**外部锚定，所以实际不能删）；
- **红线**：不为了"启动快"删除审计证据；要提速就换"只扫当前会话"（`verifyAll` 的范围可配置），属 D5 的 retention 子项。

## 5. 已知缺口（本设计未做，登记不粉饰）

1. ~~并行批上限无用例~~ **已补**（2026-10-27 15:5x）：`agent.test.ts` 的
   「D1：单批最多 8 个」用 9 个只读调用断言 `maxActive === 8` 且 9 个结果按序落账。
   反向验证过：把 `MAX_PARALLEL_READS` 改成 20，该用例立刻红（`expected 9 to be 8`），
   所以它是真判据，不是"跑过就算"。
2. **retention 开关未实现**：§4 的归档/清理是人工流程，没有代码入口。
3. **bench 不进 CI**：数字随机器抖动，进必过面只会训练人忽略红灯。要防退化得自建
   基线文件 + 阈值（如 p95 超基线 50% 报红），属赛后。
4. **没有真实浏览器的 SSE 压测**：10 条连接是内存桩，真实 HTTP/浏览器下的连接上限行为
   只有单测证据（`web/sse.test.ts`），没有端到端证据。
