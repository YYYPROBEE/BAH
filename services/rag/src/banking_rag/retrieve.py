"""检索与取数的骨架版。

真实实现应：FTS5 + sqlite-vec 双通道 → RRF → tier 权重。本文件先做 FTS5/LIKE +
关键词打分，保证 ACL 先过滤、证据可引用、cell 可取数；向量通道留 TODO。

纪律：本文件不生成答案，只返回证据/取数；生成与校验在 engine.py。
"""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass

from .config import MAX_EVIDENCE_CHARS, TOP_K
from .contract import Evidence
from .store import ChunkRow, Store

QUESTION_WORDS = (
    "是多少",
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


def search(
    store: Store,
    conn: sqlite3.Connection,
    visible_ids: set[int],
    query: str,
    top_k: int = TOP_K,
) -> list[Evidence]:
    rows = store.search_chunks(conn, visible_ids, extract_terms(query), top_k)
    return evidence_from_rows(rows)


def _cell_score(query: str, row_key: str, header_text: str, col_key: str, unit: str) -> float:
    haystack = f"{row_key} {header_text} {col_key} {unit}".lower()
    score = 0.0
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
        score = _cell_score(query, row_key, header, col_key, unit)
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
