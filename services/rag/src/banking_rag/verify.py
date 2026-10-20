"""答案后置校验：字面支持 + 蕴含判定 + 数值对账（O2/O4 的确定性部分）。

判定顺序（与 O5 状态机的输入契约）：
1. 每个 claim 必须带 `[K#]`，marker 必须解析到 evidence（否则 RED）；
2. 字面层：claim 与所引证据做规范化对齐（子串或相似度 ≥0.55）；
3. 字面失败且无数值 → 蕴含层二元判定（可注入；None=跳过）；
4. 数值：答案中的每个数值必须能在所引 cell 的 value_text（Decimal）或证据正文中
   字符级找到，否则 RED。

蕴含层永远不能救回数值：含数字的 claim 走字面+对账，`Entailer` 直接跳过。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher

from .config import decimal_eq
from .contract import Citation, Evidence, VerifyClaim, VerifyNumber, VerifyResponse
from .entailment import Entailer
from .retrieve import extract_terms, normalize_text

MARKER_RE = re.compile(r"\[(K\d+)\]")
NUMBER_RE = re.compile(r"(?<![A-Za-z+])(\d+(?:\.\d+)?)(%|元|天|年|个月|个)?")
CLAIM_SPLIT = re.compile(r"[。；;!?！？\n]+")
SENTENCE_RE = re.compile(r"[^。；;\n]+[。；;]?")
LITERAL_THRESHOLD = 0.55


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


def _claim_supported(claim: str, evidence_text: str, cell_values: list[str]) -> bool:
    left = normalize_text(MARKER_RE.sub("", claim))
    right = normalize_text(evidence_text)
    if not left:
        return True
    if left in right:
        return True
    if SequenceMatcher(None, left, right).ratio() >= LITERAL_THRESHOLD:
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
        decimal_eq(hit.value_text, value)
        for value in cell_values
        if re.fullmatch(r"-?\d+(?:\.\d+)?", value)
    )
    return matched or normalize_text(hit.raw) in corpus_text


def locate_span(claim: str, evidence_text: str) -> tuple[int, int]:
    """为引用找最贴合的字符区间：先精确子串，再按句子做相似度对齐。"""

    body = MARKER_RE.sub("", claim).strip()
    if not body:
        return 0, len(evidence_text)
    exact = evidence_text.find(body)
    if exact >= 0:
        return exact, exact + len(body)

    normalized = normalize_text(body)
    best: tuple[float, int, int] | None = None
    for match in SENTENCE_RE.finditer(evidence_text):
        sentence = match.group(0)
        ratio = SequenceMatcher(None, normalized, normalize_text(sentence)).ratio()
        if best is None or ratio > best[0]:
            best = (ratio, match.start(), match.end())
    if best is not None and best[0] >= LITERAL_THRESHOLD:
        return best[1], best[2]

    # 取数型答案的标签是合成词（如“赎回费率（持有<7天）”），正文对不上；
    # 退而定位数值所在句子，保证面板高亮的是"数值来源句"而不是整块证据。
    for hit in extract_numbers(body):
        for needle in (hit.raw, hit.value_text):
            index = evidence_text.find(needle)
            if index < 0:
                continue
            start = max(
                evidence_text.rfind("。", 0, index),
                evidence_text.rfind("；", 0, index),
                evidence_text.rfind("\n", 0, index),
            ) + 1
            ends = [
                position
                for position in (
                    evidence_text.find("。", index),
                    evidence_text.find("；", index),
                    evidence_text.find("\n", index),
                )
                if position >= 0
            ]
            end = min(ends) + 1 if ends else len(evidence_text)
            return start, end
    return 0, len(evidence_text)


def _escalate(current: str, candidate: str) -> str:
    order = {"GREEN": 0, "AMBER_INFERRED": 1, "AMBER_DISAMBIGUATION": 1, "RED": 2, "LOCKED": 3}
    return candidate if order.get(candidate, 0) > order.get(current, 0) else current


def verify_answer(
    answer_text: str,
    evidence: list[Evidence],
    cell_values: list[str],
    *,
    require_citations: bool = True,
    trace_id: str | None = None,
    entailer: Entailer | None = None,
) -> VerifyResponse:
    """对答案做字面 + 蕴含 + 数值三层校验；返回 verdict 与逐 claim/数值明细。"""

    by_marker = {item.marker: item for item in evidence}
    all_text = "\n".join(item.text for item in evidence)
    markers = list(dict.fromkeys(extract_markers(answer_text)))

    claims: list[VerifyClaim] = []
    citations: dict[str, Citation] = {}
    reason_code: str | None = None
    verdict = "GREEN"

    if require_citations and not markers:
        verdict = "RED"
        reason_code = "MISSING_CITATION"

    for marker in markers:
        item = by_marker.get(marker)
        if item is None:
            verdict = "RED"
            reason_code = reason_code or "SPAN_UNRESOLVED"

    segments = [segment.strip() for segment in CLAIM_SPLIT.split(answer_text) if segment.strip()]
    for index, segment in enumerate(segments):
        segment_markers = list(dict.fromkeys(extract_markers(segment)))
        resolved = [by_marker[marker] for marker in segment_markers if marker in by_marker]
        cited_text = "\n".join(item.text for item in resolved) if resolved else ""
        claim_text = MARKER_RE.sub("", segment).strip()

        literal = _claim_supported(segment, cited_text, cell_values) if resolved else False
        entailment: str = "skipped"
        support = literal

        if not segment_markers and require_citations:
            verdict = "RED"
            reason_code = reason_code or "MISSING_CLAIM_CITATION"
        elif not literal and resolved:
            result = entailer.judge(claim_text, cited_text) if entailer is not None else None
            if result is True:
                entailment = "pass"
                support = True
                verdict = _escalate(verdict, "AMBER_INFERRED")
                reason_code = reason_code or "UNSUPPORTED_CLAIM"
            elif result is False:
                entailment = "fail"
                support = False
                verdict = "RED"
                reason_code = reason_code or "UNSUPPORTED_CLAIM"
            else:
                entailment = "skipped"
                support = False
                verdict = _escalate(verdict, "AMBER_INFERRED")
                reason_code = reason_code or "UNSUPPORTED_CLAIM"

        claims.append(
            VerifyClaim(
                index=index,
                text=claim_text,
                markers=segment_markers,
                literal="pass" if literal else "fail",
                support="pass" if support else "fail",
                entailment=entailment,  # type: ignore[arg-type]
            )
        )

        for item in resolved:
            if item.marker in citations:
                continue
            start, end = locate_span(claim_text, item.text)
            citations[item.marker] = Citation(
                marker=item.marker,
                doc_id=item.doc_id,
                title=item.title,
                clause_no=item.clause_no,
                char_start=start,
                char_end=end,
            )

    numbers: list[VerifyNumber] = []
    corpus_text = normalize_text(all_text)
    for hit in extract_numbers(answer_text):
        matched = _number_matches(hit, cell_values, corpus_text)
        numbers.append(
            VerifyNumber(
                raw=hit.raw,
                value_text=hit.value_text,
                unit=hit.unit,
                source=markers[0] if markers else "",
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
        citations=list(citations.values()),
    )
