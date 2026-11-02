"""混合检索：FTS5 × sqlite-vec 双通道 → RRF 融合 → 证据。

纪律：两通道共享同一个 `visible_ids`（O1 两段式），受限 chunk 不参与打分；
本文件不生成答案，只返回证据/取数与可回放的通道追踪。
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field

from .config import CHANNEL_CANDIDATES, MAX_EVIDENCE_CHARS, TOP_K
from .contract import Evidence
from .fuse import ChannelHit, FusedHit, as_channel_hits, rrf_fuse
from .store import ChunkRow, Store

QUESTION_WORDS = (
    "是多少",
    # `X是什么？` 是银行问答里最高频的句式之一。只删「什么」会留下一个悬空的系词，
    # 检索词变成「注入测试条款是」，与正文 token「注入测试条款」无法精确命中。
    # 必须作为整体删除；单删「是」会误伤「是否」这类词。
    "是什么",
    "多少",
    "怎么样",
    "什么",
    "请问",
    "帮我",
    "查一下",
    "看一下",
    "的",
    "吗",
    "呢",
    "？",
    "?",
    "，",
    "。",
    "、",
    "！",
    "!",
)

DOMAIN_TERMS = (
    "稳盈90天增强版",
    "稳盈90天b",
    "稳盈90天",
    "赎回费率",
    "申购费率",
    "持有不满7天",
    "持有满7天不满30天",
    "持有满30天",
    "起购金额",
    "风险等级",
    "预期年化收益率",
    "转账限额",
    "单笔限额",
    "日累计限额",
    "赎回流程",
    "费率",
    "限额",
    "期限",
)


def normalize_text(text: str) -> str:
    """引用对齐与数值比较共用的规范化：去空白、统一全半角、小写。"""

    return (
        text.replace("％", "%")
        .replace("．", ".")
        .replace("，", ",")
        .replace("：", ":")
        .replace("（", "(")
        .replace("）", ")")
        .replace(" ", "")
        .replace("\u3000", "")
        .lower()
    )


def extract_terms(query: str) -> list[str]:
    """从自然问句里抽检索词：领域词优先，再按问句停用词切段。"""

    lowered = query.lower()
    terms: list[str] = []
    for term in DOMAIN_TERMS:
        if term in lowered:
            terms.append(term)
    rest = lowered
    for word in QUESTION_WORDS:
        rest = rest.replace(word, " ")
    for part in re.split(r"[\s,;:/|]+", rest):
        part = part.strip()
        if len(part) >= 2:
            terms.append(part)
    seen: set[str] = set()
    result: list[str] = []
    for term in terms:
        if term in seen:
            continue
        seen.add(term)
        result.append(term)
    return result[:8]


@dataclass(frozen=True)
class LookupHit:
    chunk_id: int
    label: str
    header_text: str
    row_key: str
    value_text: str
    unit: str
    cell_id: int


@dataclass
class SearchResult:
    evidence: list[Evidence]
    trace: dict[str, object] = field(default_factory=dict)


def evidence_from_rows(rows: list[tuple[ChunkRow, float]]) -> list[Evidence]:
    """把检索结果变成带 marker 的证据；超出预算时整条丢弃。"""

    evidence: list[Evidence] = []
    used = 0
    for index, (row, _score) in enumerate(rows, start=1):
        if used + len(row.text) > MAX_EVIDENCE_CHARS and evidence:
            break
        used += len(row.text)
        evidence.append(
            Evidence(
                marker=f"K{index}",
                chunk_id=row.chunk_id,
                doc_id=row.doc_id,
                title=row.title,
                clause_no=row.clause_no,
                tier=row.tier,
                char_start=0,
                char_end=len(row.text),
                text=row.text,
            )
        )
    return evidence


def _tiers(conn: sqlite3.Connection, ids: list[int]) -> dict[int, int]:
    if not ids:
        return {}
    placeholders = ",".join("?" for _ in ids)
    rows = conn.execute(
        f"""
        SELECT c.chunk_id, d.tier
        FROM chunks c JOIN docs d ON d.doc_id = c.doc_id
        WHERE c.chunk_id IN ({placeholders})
        """,
        ids,
    ).fetchall()
    return {int(row["chunk_id"]): int(row["tier"]) for row in rows}


def _channel_trace(hits: list[ChannelHit]) -> list[dict[str, object]]:
    return [
        {"chunkId": hit.chunk_id, "rank": hit.rank, "score": round(hit.score, 6)}
        for hit in hits
    ]


def search(
    store: Store,
    conn: sqlite3.Connection,
    visible_ids: set[int],
    query: str,
    top_k: int = TOP_K,
) -> SearchResult:
    """双通道检索 + RRF。向量通道不可用时退化为 FTS5 单通道（R-2）。"""

    terms = extract_terms(query)
    fts_rows = store.fts_ranked(conn, visible_ids, terms, CHANNEL_CANDIDATES)
    vec_rows: list[tuple[int, float]] = []
    vec_error: str | None = None

    if store.embedding_on and visible_ids:
        try:
            query_vector = store.embedder.embed_query(query)
            vec_rows = store.vector_ranked(conn, visible_ids, query_vector, CHANNEL_CANDIDATES)
        except Exception as exc:  # noqa: BLE001 - 向量通道失败不阻断主链路
            vec_error = f"{type(exc).__name__}: {exc}"

    fts_hits = as_channel_hits(fts_rows)
    vec_hits = as_channel_hits(vec_rows)
    channels: dict[str, list[ChannelHit]] = {"fts5": fts_hits}
    if vec_hits or vec_error is None:
        channels["vector"] = vec_hits

    candidates = list({hit.chunk_id for hit in fts_hits + vec_hits})
    tiers = _tiers(conn, candidates)
    fused: list[FusedHit] = rrf_fuse(channels, tiers, top_k=top_k)

    rows = store.chunks_by_ids(conn, [hit.chunk_id for hit in fused])
    ordered: list[tuple[ChunkRow, float]] = []
    for hit in fused:
        row = rows.get(hit.chunk_id)
        if row is not None:
            ordered.append((row, hit.score))

    trace: dict[str, object] = {
        "rrfK": 60,
        "terms": terms,
        "fts5": _channel_trace(fts_hits),
        "vector": _channel_trace(vec_hits),
        "fused": [hit.as_dict() for hit in fused],
        "vectorError": vec_error,
    }
    return SearchResult(evidence=evidence_from_rows(ordered), trace=trace)


# 产品限定词：问句里出现这些词，说明用户已经点名了某个产品变体。
# 三份说明书的 row_key 完全同名（起购金额/风险等级/期限），不按文档归属加减分就会串产品
# ——实测「稳盈90天增强版起购金额」曾被答成 100 元（W-001），正确值 1000 元（W-003）。
PRODUCT_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("增强版", ("增强版",)),
    ("90天b", ("b（vip", "vip")),
    ("vip专享", ("b（vip", "vip")),
)
PRODUCT_WEIGHT = 6.0


def _product_score(query: str, doc_title: str) -> float:
    """点名了产品变体就按文档归属加减分；没点名返回 0（对普通题零影响）。"""

    lowered = query.lower()
    title = doc_title.lower()
    score = 0.0
    hinted = False
    for trigger, title_marks in PRODUCT_HINTS:
        if trigger not in lowered:
            continue
        hinted = True
        if any(mark in title for mark in title_marks):
            score += PRODUCT_WEIGHT
        else:
            score -= PRODUCT_WEIGHT
    if not hinted and ("增强版" in title or "b（vip" in title):
        # 没点名产品时，「稳盈90天」默认指标准版；变体轻微降权，避免靠入库顺序抢先。
        score -= 3.0
    return score


def _cell_score(
    query: str,
    row_key: str,
    header_text: str,
    col_key: str,
    unit: str,
    doc_title: str = "",
) -> float:
    haystack = f"{row_key} {header_text} {col_key} {unit}".lower()
    score = _product_score(query, doc_title) if doc_title else 0.0
    for term in extract_terms(query):
        if term in haystack:
            score += 2.0
    if "不满7天" in query and "持有<7天" in row_key:
        score += 4.0
    if "满7天" in query and "不满30天" in query and "7天≤持有<30天" in row_key:
        score += 4.0
    if "满30天" in query and "持有≥30天" in row_key:
        score += 4.0
    if "起购" in query and "起购" in row_key:
        score += 3.0
    if "申购" in query and "申购" in row_key:
        score += 3.0
    if "赎回" in query and "赎回" in header_text:
        score += 2.0
    if "单笔" in query and "单笔" in row_key:
        score += 3.0
    if "日累计" in query and "日累计" in row_key:
        score += 3.0
    return score


def lookup(
    store: Store,
    conn: sqlite3.Connection,
    visible_ids: set[int],
    query: str,
) -> list[LookupHit]:
    """按查询词在 cells 上打分；返回最多 3 条。"""

    scored: list[tuple[float, LookupHit]] = []
    for cell in store.cells_for(conn, visible_ids):
        row_key = str(cell["row_key"] or "")
        header = str(cell["header_text"] or "")
        col_key = str(cell["col_key"] or "")
        unit = str(cell["unit"] or "")
        # `cells_for` 一定带出 doc_title（已 JOIN docs），这里直接取，不用 keys() 兜底
        # —— sqlite3.Row 的 `in` 走的是值迭代而不是列名，兜底写法反而会误判。
        doc_title = str(cell["doc_title"] or "")
        score = _cell_score(query, row_key, header, col_key, unit, doc_title)
        if score <= 0:
            continue
        label = header if header == row_key else f"{header}（{row_key}）"
        scored.append(
            (
                score,
                LookupHit(
                    chunk_id=int(cell["chunk_id"]),
                    label=label,
                    header_text=header,
                    row_key=row_key,
                    value_text=str(cell["value_text"]),
                    unit=unit,
                    cell_id=int(cell["cell_id"]),
                ),
            )
        )
    scored.sort(key=lambda item: (-item[0], item[1].cell_id))
    return [hit for _score, hit in scored[:3]]


def is_lookup_query(query: str) -> bool:
    return any(
        keyword in query
        for keyword in ("费率", "手续费", "起购", "限额", "期限", "风险等级", "收益率", "年化")
    )
