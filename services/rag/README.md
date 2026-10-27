# banking-rag（BAH 知识平面 sidecar）

单体 Python 服务：ACL 前置过滤 → FTS5 × sqlite-vec 双通道 → RRF → 生成 → 字面/蕴含/数值校验 → 状态机 → 审计/熔断。

## 快速开始

```bash
cd services/rag
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements.txt

# 首次需要 bge-small-zh-v1.5（约 90MB）。fastembed 会缓存到 services/rag/models/；
# 离线包直接携带 models/bge-small-zh-v1.5/（model_optimized.onnx + tokenizer/config）。
# 国内网络：pip 可加 -i https://mirrors.aliyun.com/pypi/simple/；
# 模型下载设 HF_ENDPOINT=https://hf-mirror.com（Xet CAS 401 时改用 snapshot_download(local_dir=...)）。
.venv/Scripts/python.exe -m banking_rag.ingest --db data/knowledge.sqlite

# 证据面板（dist 不入库，需本地构建一次）
cd web/evidence_panel && npm install && npm run build && cd ../..

# 启动（无 DEEPSEEK_API_KEY 时自动降级为抽取式生成）
# 认证是 fail-loud：没有 token 会直接拒启（RuntimeError: 认证未配置）。
# 从仓库根 `pnpm rag:dev` 会自动生成一次性演示 token 并打印；
# 手工启动必须显式注入同一个 token（host 侧也要用）：
BAH_KNOWLEDGE_TOKEN=<token> DEEPSEEK_API_KEY=sk-... \
  PYTHONPATH=src .venv/Scripts/python.exe -m uvicorn banking_rag.main:app --host 127.0.0.1 --port 7801
```

- API 文档关闭；健康检查：`GET /healthz`
- 证据面板：<http://127.0.0.1:7801/panel/>（构建产物在 `web/evidence_panel/dist`）
- 面板开发模式：`cd web/evidence_panel && npm run dev`（Vite 代理 `/v1` 到 7801）

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 空 | 空 = NullLLM，生成走抽取式；可回退 `BAH_RAG_LLM_API_KEY` |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `BAH_RAG_LLM_MODEL` | `deepseek-chat` | 生成与蕴含共用 |
| `BAH_RAG_LLM_TIMEOUT` | `20` | 秒；超时即降级 |
| `BAH_RAG_EMBEDDING` | `on` | `off` = 退化 FTS5 单通道（R-2 降级路径） |
| `BAH_RAG_MODEL_DIR` | `services/rag/models` | 嵌入模型缓存目录 |
| `BAH_RAG_ENTAILMENT` | `on` | `off` = 只跑字面层 |
| `BAH_RAG_TOKEN_SECRET` | 空 | 签名模式密钥（HMAC-SHA256）；与下面的演示 token 至少配一个，否则**拒启** |
| `BAH_RAG_TOKEN` / `BAH_KNOWLEDGE_TOKEN` | 空 | 演示模式静态 token；与 secret 至少配一个，否则**拒启**。`/healthz` 之外全部 `/v1/*` 都要 `Authorization: Bearer <token>` |

## 常用命令

```bash
# 测试（65 条；不联网，LLM 用 scripted fake）
PYTHONPATH=src .venv/Scripts/python.exe -m pytest -q

# 人工复位熔断（唯一解锁路径，写 breaker_log）
PYTHONPATH=src .venv/Scripts/python.exe -m banking_rag.admin reset-breaker --session s-1 --actor console

# 查看熔断事件
PYTHONPATH=src .venv/Scripts/python.exe -m banking_rag.admin show-breaker --session s-1

# 换模型/换语料后全量重建向量
PYTHONPATH=src .venv/Scripts/python.exe -m banking_rag.admin rebuild-embeddings

# 重新导出契约
PYTHONPATH=src .venv/Scripts/python.exe -m banking_rag.export_contract
```

## 代码地图

| 文件 | 职责 |
|---|---|
| `store.py` | DDL/迁移、ACL 可见集、FTS5 与 vec0 双通道、审计、熔断表 |
| `embed.py` | fastembed ONNX 懒加载、L2 归一化、版本指纹 |
| `fuse.py` | RRF（k=60）+ tier 先验，纯函数 |
| `retrieve.py` | 双通道检索编排、cell 取数、通道追踪 |
| `envelope.py` | O6 指令中和（同形/零宽/base64）与证据数据化 |
| `llm.py` | DeepSeek OpenAI 兼容客户端；失败即 `LLMError` |
| `generator.py` | 结构化 claims 解析/渲染；抽取式降级 |
| `entailment.py` | 受限二元判定；数值 claim 不参与；结果缓存 |
| `verify.py` | 字面 span + 蕴含 + 数值对账；引用 span 定位 |
| `engine.py` | 12 步编排、状态机出口、审计与熔断计数 |
| `breaker.py` | SQLite 持久化熔断（连续 RED / 注入窗口 / 人工复位） |
| `main.py` | FastAPI 装配、审计端点、`/panel` 静态挂载 |
| `admin.py` | 离线管理 CLI（复位/查看/重建向量） |

## 已知边界

- FTS5 trigram 对长中文问句召回弱，混合检索实际由向量通道兜底；可选 jieba/2-4 gram 改造。
- 向量通道有绝对距离闸 `VECTOR_MAX_DISTANCE=0.45`（demo 语料实测）；换语料需用黄金集重标。
- 真实 PDF/DOCX/XLSX 解析与 O7 三维哨兵**尚未接入**（已确认"以后干"，见 `docs/knowledge.md` K-6）。
