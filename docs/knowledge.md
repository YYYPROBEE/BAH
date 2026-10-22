# 知识平面（RAG sidecar）骨架

> 状态：v0 骨架（2026-10-19）｜设计依据：`RAG增强层/微众杯银行AI智能体RAG增强层设计方案（终稿v1.1修复版）.md`
> 对接方案：`RAG增强层/RAG增强层对接BAH-MonoRepo方案.md`（v2：RAG 自答，不改主循环）

## 1. 这版能跑什么

```text
CLI（headless）
  → knowledge_answer（@bah/knowledge）
  → POST /v1/answer（services/rag）
  → ACL 谓词 → FTS5 × sqlite-vec → RRF(tier) → cells
  → LLM 生成（抽取式降级）
  → span 对齐 + 蕴含判定 + 数值对账 + 状态机
  → 已校验答案/拒答/消歧
  → CLI 打印知识卡（答案 + 引用）
```

已实现：

| 能力 | 落点 | 说明 |
|---|---|---|
| ACL 六元组前置过滤 | `store.visible_chunk_ids` | role/audience/channel/region/product/now；缺失即 fail-closed |
| 时效窗 / 状态 / tier | `docs` 表 + 谓词 | 旧版 `superseded`、未生效、tier 9 不参与默认检索 |
| FTS5 中文检索 | `chunks_fts`（trigram） | 词法通道 |
| sqlite-vec 向量通道 | `vec_chunks`（cosine）+ `embed.py` | bge-small-zh-v1.5（fastembed ONNX，本地推理不出网）；绝对距离闸 0.45 |
| RRF 融合 | `fuse.py` | k=60、tier1×1.2、双通道等权、top8；融合排名写入审计 |
| 表格 cell 取数 | `cells` 表 + `retrieve.lookup` | 数值权威是 `value_text` 字符串；取数型答案不经 LLM |
| LLM 生成 | `generator.py` + `llm.py` | DeepSeek（OpenAI 兼容）；结构化 claims+`[K#]`；失败降级抽取式 |
| 引用校验 | `verify.py` | 字面 span 对齐；失败走蕴含层；数值必须命中 cell/正文 |
| 蕴含层 | `entailment.py` | 受限二元判定（仅 claim+证据、温度 0、缓存）；数值 claim 不参与 |
| 多态拒答 | `engine` | SCOPE_EMPTY / EMPTY_RETRIEVAL / NUMERIC_MISMATCH / UNSUPPORTED_CLAIM / BREAKER_LOCKED |
| 检索级熔断 | `breaker.py` | 连续 3 RED 或 10 分钟 2 次注入命中 → 锁定 15 分钟；SQLite 持久化、人工复位 |
| 审计 | `retrieval_log` / `answer_log` | 谓词、双通道排名、RRF、校验明细、生成器、熔断状态；`/v1/audit/{traceId}` 可回放 |
| 证据面板 | `web/evidence_panel`（React+Vite） | `/panel/` 深色回放：六元组→双通道→RRF→span 高亮→逐 claim/数值→终态 |
| 双模式端口 | `@bah/knowledge` | `http`（真实 sidecar）/ `fixture`（快照/单测） |

未实现（按设计稿后续批次，已与需求方确认"以后干"）：

- 真实 PDF / DOCX / XLSX 解析管线与结构感知分块（当前 `demo_corpus.py` 10 篇）；
- 扫描件 OCR 置信度分层（O10）；
- O7-v2 三维入库哨兵（当前只做 tier 隔离 + 数值锚点配置未接线）。

## 2. 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/v1/answer` | 知识回答主路径；只返回已校验答案 / 拒答 / 消歧 |
| POST | `/v1/query` | 只返回证据/取数（混合问题、调试） |
| POST | `/v1/verify` | 内部/调试：对给定答案按 traceId 取证据复核 |
| GET | `/healthz` | 健康检查（`corpusVersion` / `docs` / `chunks` / `embedding` / `embedVersion`） |
| GET | `/v1/audit/{traceId}` | 脱敏审计记录（含证据正文、双通道排名、校验明细、熔断状态） |
| GET | `/v1/audit/recent?limit=20` | 最近查询列表（面板左栏） |
| GET | `/v1/breaker/{sessionId}` | 会话熔断状态与事件流 |
| GET | `/panel/` | 证据面板（React 构建产物；未构建时 404，不影响 API） |

鉴权：设置 `BAH_KNOWLEDGE_TOKEN` 后，所有 `/v1/*` 需要 `Authorization: Bearer <token>`；`/healthz` 不鉴权。默认只绑 `127.0.0.1`。

### 示例

```bash
curl -s http://127.0.0.1:7801/v1/answer \
  -H 'content-type: application/json' \
  -d '{
    "schemaVersion": "knowledge.v1",
    "sessionId": "s-demo",
    "query": "稳盈90天持有不满7天赎回费率是多少？",
    "principal": {
      "role": "retail",
      "audience": "standard",
      "channel": "headless",
      "region": "CN-SH",
      "now": "2026-10-19T12:00:00+08:00"
    }
  }'
```

返回：

```json
{
  "schemaVersion": "knowledge.v1",
  "traceId": "tr-...",
  "kind": "answer",
  "answer": "赎回费率（持有<7天）为1.50%[K1]。",
  "citations": [
    {
      "marker": "K1",
      "docId": "FEE-2025-v3",
      "title": "稳盈系列费率表（2025版）",
      "clauseNo": "费率表",
      "charStart": 0,
      "charEnd": 100
    }
  ],
  "verdict": "GREEN",
  "reasonCode": null,
  "evidence": [],
  "candidates": [],
  "latencyMs": { "retrieval": 2, "generation": 0, "verify": 1, "total": 3 }
}
```

## 3. 运行

```bash
# 1) Python 依赖（首次）
cd services/rag
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
# .venv/bin/python -m pip install -r requirements.txt          # Unix

# 1.1) 嵌入模型（首次，约 90MB；国内可走镜像）
#  fastembed 缓存布局：services/rag/models/bge-small-zh-v1.5/model_optimized.onnx
#  离线包直接携带该目录，运行时不再访问网络

# 2) 重建演示语料（可选；首次启动会自动建）
cd ../..
pnpm rag:ingest

# 3) 启动 sidecar（DeepSeek 生成需要 key；无 key 自动降级抽取式）
DEEPSEEK_API_KEY=sk-... pnpm rag:dev
# 浏览器打开 http://127.0.0.1:7801/panel/

# 4) 另一个终端跑 CLI
pnpm bah --profile headless --patch profiles/headless/patch-knowledge.yml \
  --prompt "稳盈90天持有不满7天赎回费率是多少？" --session s-rag-demo --jsonl .tmp-rag

# 或一条命令（自动起停 sidecar）
pnpm demo:rag

# 拒绝演示（VIP 产品对普通客群 → SCOPE_EMPTY）
DEMO_PATCH=profiles/headless/patch-knowledge-refusal.yml DEMO_SESSION=s-rag-refusal pnpm demo:rag
```

预期输出：

```text
bah: 回复 以上为知识库校验后的回答，引用见下方。
bah: 知识卡
赎回费率（持有<7天）为1.50%[K1]。

引用：
[K1] 稳盈系列费率表（2025版） 费率表
```

## 4. 宿主配置

`profiles/headless/patch-knowledge.yml`：

```yaml
- id: bank:knowledge
  use: bank:knowledge
  config:
    mode: http                 # http | fixture
    baseUrl: http://127.0.0.1:7801
    tokenEnv: BAH_KNOWLEDGE_TOKEN
    required: false            # true = 健康检查失败即拒绝启动
    channel: headless
    claims:
      default: { role: retail, audience: standard, region: CN-SH }
      users:
        u-1: { role: retail, audience: standard, region: CN-SH }
```

- `mode: fixture` 时必填 `fixturePath`，指向 `packages/knowledge/fixtures/*.json`；不启 Python，用于快照/单测。
- `required: false`：sidecar 不可达时只告警，工具返回 `knowledge-unavailable`；`required: true`：启动即失败。
- `claims` 是演示档的权限映射；生产应由登录凭证绑定，插件只消费 `BANK_IDENTITY` 的 userId。

## 5. 工具契约

| 工具 | 用途 | 参数 |
|---|---|---|
| `knowledge_answer` | 知识问题；RAG 内部完成 12 步并返回已校验答案 | `question` / `productHint?` |
| `knowledge_query` | 混合问题；只返回证据/取数，不生成答案 | `question` / `productHint?` |

**安全边界**：模型可见参数只有 `question` / `productHint`。`role/audience/channel/region` 由宿主按 `sessionId` 组装，模型无法传入；`productHint` 只作提示，RAG 仍做别名匹配与 ACL 过滤。

## 6. 测试与门禁

```bash
pnpm rag:check     # pytest（含契约一致性）
pnpm test          # TS 单测（knowledge 包 + host 插件 + CLI 卡片）
pnpm gate          # 12 项，含 verify-knowledge-contract
pnpm test:coverage # 100% 行覆盖（knowledge 包已进 allowlist）
```

Python 侧的锚点：

- `test_predicate.py`：标准/ VIP / mobile / 地区 / 时效 / 缺维度；
- `test_api.py`：GREEN 引用、VIP 拒答、地区拒答、渠道隔离、消歧、审计、熔断、注入命中、数值不一致、缺引用；
- `test_verify.py`：字面通过 / 数值不一致 / 缺引用 / 未解析 marker / AMBER；
- `test_vector.py`：向量索引落库、语义改写召回、双通道同作用域、RRF 追踪；
- `test_fuse.py`：RRF 一致性、tier 先验、tier9 排除、确定性 tie-break；
- `test_generator.py` / `test_entailment.py`：LLM JSON 解析、降级、蕴含三态、缓存；
- `test_engine_llm.py`：生成→蕴含→状态机的端到端行为；
- `test_breaker.py`：跨连接持久化、到期解锁、人工复位、注入窗口、锁定期重试不延长；
- `test_contract.py`：提交的 `knowledge.v1.json` 与 Pydantic 模型一致。

## 7. 已知缺口（记账）

| ID | 缺口 | 影响 | 状态 |
|---|---|---|---|
| K-1 | ~~只有 FTS5，没有向量/RRF~~ | 同义改写召回弱 | **已关闭**：sqlite-vec + bge-small-zh + RRF |
| K-2 | ~~抽取式生成，不是 LLM~~ | 表达自然度有限 | **已关闭**：DeepSeek 生成（无 key/失败降级抽取式） |
| K-3 | ~~熔断是内存态~~ | 重启即清空 | **已关闭**：SQLite `breaker_state` + `breaker_log` + CLI 复位 |
| K-4 | 没有 `knowledge/answered` 的 schema 门禁 | 事件字段漏写只能靠测试 | 未动（TS 侧） |
| K-5 | ~~证据面板未接~~ | 答辩只能看 JSONL | **已关闭**：`/panel/`（React+Vite） |
| K-6 | 真实语料解析未接 | 只有 10 篇 demo | **记账，确认以后干**：PDF/DOCX/XLSX + 结构分块 + 哨兵 |
| K-7 | FTS5 trigram 对长中文问句召回弱 | 混合检索实际由向量通道兜底 | 可选：jieba 分词或 2-4 gram 展开；当前不影响演示题库 |
| K-8 | 向量绝对距离闸 0.45 为 demo 语料实测值 | 换语料/换模型需重标 | 配置项 `VECTOR_MAX_DISTANCE`，黄金集首跑后校准 |
