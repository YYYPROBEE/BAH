"""答案后置校验（骨架版）：字面支持 + 数值对账。

设计稿 O2/O4 的确定性部分：
- 每个 claim 必须带 `[K#]`，marker 必须能解析到 evidence；
- 答案里的数值必须能在引用证据的 cell `value_text` 或证据正文里找到；
- 字面不通过但无数值 → AMBER_INFERRED；数值不一致 → RED。

蕴含层（LLM）不在本文件；RAG 侧不持有第二套 LLM 凭证。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from difflib import SequenceMatcher

from .contract import Citation, Evidence, VerifyClaim, VerifyNumber, VerifyResponse
from .retrieve import extract_terms, normalize_text

MARKER_RE = re.compile(r"\[(K\d+)\]")
NUMBER_RE = re.compile(r"(?<![A-Za-z])(\d+(?:\.\d+)?)(%|元|天|年|个月|个)?")
CLAIM_SPLIT = re.compile(r"[。；;!?！？\n]+")


@dataclass(frozen=True)
class NumberHit:
    raw: str
    value_text: str
    unit: str


def extract_markers(text: str) -> list[str]:
    return MARKER_RE.findall(text)


def extract_numbers(text: str) -> list[NumberHit]:
    stripped = MARKER_RE.sub("", text)
    hits: list[NumberHit] = []
    for match in NUMBER_RE.finditer(stripped):
        value = match.group(1)
        unit = match.group(2) or ""
        hits.append(NumberHit(raw=match.group(0), value_text=value, unit=unit))
    return hits


def _decimal_eq(left: str, right: str) -> bool:
    try:
        return Decimal(left) == Decimal(right)
    except (InvalidOperation, ValueError):
        return False


def _claim_supported(claim: str, evidence_text: str, cell_values: list[str]) -> bool:
    left = normalize_text(MARKER_RE.sub("", claim))
    right = normalize_text(evidence_text)
    if not left:
        return True
    if left in right:
        return True
    if SequenceMatcher(None, left, right).ratio() >= 0.55:
        return True
    # 取数型答案：标签词命中证据 + 全部数值都能在 cell/正文找到，视为支持。
    numbers = extract_numbers(claim)
    if not numbers:
        return False
    label_hit = any(
        term in right
        for term in extract_terms(claim)
        if term and not term.replace(".", "").isdigit()
    )
    numbers_ok = all(_number_matches(hit, cell_values, right) for hit in numbers)
    return label_hit and numbers_ok


def _number_matches(hit: NumberHit, cell_values: list[str], corpus_text: str) -> bool:
    matched = any(
        _decimal_eq(hit.value_text, value)
        for value in cell_values
        if re.fullmatch(r"-?\d+(?:\.\d+)?", value)
    )
    return matched or normalize_text(hit.raw) in corpus_text


def verify_answer(
    answer_text: str,
    evidence: list[Evidence],
    cell_values: list[str],
    *,
    require_citations: bool = True,
    trace_id: str | None = None,
) -> VerifyResponse:
    """对答案做确定性校验；返回 verdict 与逐 claim/数值明细。"""

    by_marker = {item.marker: item for item in evidence}
    all_text = "\n".join(item.text for item in evidence)
    markers = extract_markers(answer_text)

    claims: list[VerifyClaim] = []
    citations: list[Citation] = []
    reason_code: str | None = None
    verdict: str = "GREEN"

    if require_citations and not markers:
        verdict = "RED"
        reason_code = "MISSING_CITATION"

    for marker in markers:
        item = by_marker.get(marker)
        if item is None:
            verdict = "RED"
            reason_code = "SPAN_UNRESOLVED"
            continue
        citations.append(
            Citation(
                marker=marker,
                doc_id=item.doc_id,
                title=item.title,
                clause_no=item.clause_no,
                char_start=item.char_start,
                char_end=item.char_end,
            )
        )

    segments = [segment.strip() for segment in CLAIM_SPLIT.split(answer_text) if segment.strip()]
    for index, segment in enumerate(segments):
        segment_markers = extract_markers(segment)
        supported = (
            _claim_supported(segment, all_text, cell_values) if segment_markers else False
        )
        claim = VerifyClaim(
            index=index,
            text=MARKER_RE.sub("", segment).strip(),
            markers=segment_markers,
            literal="pass" if supported else "fail",
            support="pass" if supported else "fail",
        )
        claims.append(claim)
        if segment_markers and not supported and verdict != "RED":
            verdict = "AMBER_INFERRED"
            reason_code = reason_code or "UNSUPPORTED_CLAIM"

    numbers: list[VerifyNumber] = []
    corpus_text = normalize_text(all_text)
    for hit in extract_numbers(answer_text):
        matched = _number_matches(hit, cell_values, corpus_text)
        source = markers[0] if markers else ""
        numbers.append(
            VerifyNumber(
                raw=hit.raw,
                value_text=hit.value_text,
                unit=hit.unit,
                source=source,
                match=matched,
            )
        )
        if not matched:
            verdict = "RED"
            reason_code = "NUMERIC_MISMATCH"

    return VerifyResponse(
        trace_id=trace_id,
        verdict=verdict,  # type: ignore[arg-type]
        reason_code=reason_code,
        claims=claims,
        numbers=numbers,
        citations=citations,
    )
