"""RAG sidecar 的唯一配置点。

本文件只放"随部署变化"与"全库唯一"的常量：阈值、锚点、版本、默认路径。
业务模块不许各自硬编码阈值（对应仓库 AGENTS.md 第 4 条的同构纪律）。
"""

from __future__ import annotations

import os
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

# 契约版本：TS 侧拒绝未知主版本（与 packages/knowledge/src/contract.ts 对齐）。
SCHEMA_VERSION = "knowledge.v1"

# 默认只检索 tier <= 5 的文档；tier 9 = 未授权来源，不参与默认检索。
MAX_TIER = 5

# 检索/证据上限：整条丢弃，不切 span。
TOP_K = 8
MAX_EVIDENCE_CHARS = 6000

# 双通道候选数（融合前每通道取多少条）。
CHANNEL_CANDIDATES = 24

# 向量通道绝对距离闸：cosine distance > 阈值视为语义漂移，不进入融合。
# 依据 demo 语料实测：相关 0.28-0.42，无关 0.48+；FTS 仍可兜住字面命中。
VECTOR_MAX_DISTANCE = 0.45

# RRF 融合：k=60 为文献默认；tier 权重是"权威先验"，替代独立 rerank。
RRF_K = 60
TIER_WEIGHTS: dict[int, float] = {1: 1.2, 2: 1.1, 3: 1.0, 4: 0.95, 5: 0.9, 9: 0.0}

# 检索级熔断：连续 RED 次数、锁定时长、注入命中窗口与阈值。
BREAKER_THRESHOLD = 3
BREAKER_LOCK_SECONDS = 15 * 60
INJECTION_WINDOW_SECONDS = 10 * 60
INJECTION_THRESHOLD = 2

# 默认数据库位置：services/rag/data/knowledge.sqlite。
DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "knowledge.sqlite"

# 费率/收费的合法区间锚点（入库哨兵的骨架版；完整 O7-v2 见设计稿 §6.3）。
FEE_RATE_RANGE = (0.0, 1.0)
FEE_AMOUNT_RANGE = (0.0, 100.0)

# ── 嵌入（E7：bge-small-zh-v1.5，本地 ONNX 推理，不出网） ─────────────────
EMBED_MODEL = os.environ.get("BAH_RAG_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
EMBED_DIM = 512
EMBED_CACHE_DIR = Path(
    os.environ.get("BAH_RAG_MODEL_DIR", str(Path(__file__).resolve().parents[2] / "models"))
)
EMBED_BATCH = 16
EMBED_VERSION = f"fastembed:{EMBED_MODEL}"


def embedding_enabled() -> bool:
    """显式关闭开关：BAH_RAG_EMBEDDING=off 时退化为 FTS5 单通道（R-2 降级路径）。"""

    return os.environ.get("BAH_RAG_EMBEDDING", "on").lower() not in {"off", "0", "false"}


# ── LLM（DeepSeek；与仓库 packages/llm 的环境变量约定保持一致） ────────────
LLM_API_KEY_ENV = "DEEPSEEK_API_KEY"
LLM_BASE_URL_ENV = "DEEPSEEK_BASE_URL"
LLM_MODEL_ENV = "BAH_RAG_LLM_MODEL"
DEFAULT_LLM_BASE_URL = "https://api.deepseek.com"
DEFAULT_LLM_MODEL = "deepseek-chat"
LLM_TIMEOUT_SECONDS = float(os.environ.get("BAH_RAG_LLM_TIMEOUT", "20"))
LLM_MAX_TOKENS = 600
ENTAILMENT_MAX_TOKENS = 16

# 蕴含层开关：关闭时只跑字面层（设计稿 §4.3.2 的降级路径）。
ENTAILMENT_ENABLED = os.environ.get("BAH_RAG_ENTAILMENT", "on").lower() not in {
    "off",
    "0",
    "false",
}


def decimal_eq(left: str, right: str, *, places: int = 6) -> bool:
    """全库唯一的十进制相等规则（O3/O4 共用）。

    float 不参与精确比较；`Decimal(str(x))` + ROUND_HALF_UP，精度 6 位。
    """

    quantum = Decimal(1).scaleb(-places)
    try:
        a = Decimal(str(left)).quantize(quantum, rounding=ROUND_HALF_UP)
        b = Decimal(str(right)).quantize(quantum, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return False
    return a == b
