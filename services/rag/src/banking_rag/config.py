"""RAG sidecar 的唯一配置点。

本文件只放"随部署变化"与"全库唯一"的常量：阈值、锚点、版本、默认路径。
业务模块不许各自硬编码阈值（对应仓库 AGENTS.md 第 4 条的同构纪律）。
"""

from __future__ import annotations

from pathlib import Path

# 契约版本：TS 侧拒绝未知主版本（与 packages/knowledge/src/contract.ts 对齐）。
SCHEMA_VERSION = "knowledge.v1"

# 默认只检索 tier <= 5 的文档；tier 9 = 未授权来源，不参与默认检索。
MAX_TIER = 5

# 检索/证据上限：整条丢弃，不切 span。
TOP_K = 8
MAX_EVIDENCE_CHARS = 6000

# 检索级熔断：连续 RED 次数与锁定时长。
BREAKER_THRESHOLD = 3
BREAKER_LOCK_SECONDS = 15 * 60

# 默认数据库位置：services/rag/data/knowledge.sqlite。
DEFAULT_DB = Path(__file__).resolve().parents[2] / "data" / "knowledge.sqlite"

# 费率/收费的合法区间锚点（入库哨兵的骨架版；完整 O7-v2 见设计稿 §6.3）。
FEE_RATE_RANGE = (0.0, 1.0)
FEE_AMOUNT_RANGE = (0.0, 100.0)
