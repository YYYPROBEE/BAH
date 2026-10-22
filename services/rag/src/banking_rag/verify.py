"""答案后置校验：字面支持 + 蕴含判定 + 数值对账（O2/O4 的确定性部分）。

判定顺序（与 O5 状态机的输入契约）：
1. 每个 claim 必须带 `[K#]`，marker 必须解析到 evidence（否则 RED）；
2. 字面层：claim 与**所引证据**做规范化对齐（子串或相似度 ≥0.55）；
3. 含数字的 claim 跳过 SequenceMatcher，直接走数值对账（单位必须一致）；
4. 数值只与**本 claim 所引证据**的 cell/正文对账，不允许跨证据或全局 corpus 背书；
5. 字面失败且无数值 → 蕴含层二元判定（可注入；None=跳过）。

蕴含层永远不能救回数值：含数字的 claim **在本层就不咨询 `Entailer`**（不是依赖
`Entailer` 内部的数字守卫来自律），`support` 只能由字面 + 对账给出。

理由码不是"先到先得"：`_REASON_RANK` 显式定义优先级，避免 `or` 短路把更严重的
判决理由压掉（历史缺陷：数字不符被写成 `UNSUPPORTED_CLAIM`）。
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
# T+N 先单独提取（到账时效），其余数字按普通数值处理。
T_PLUS_RE = re.compile(r"(?<![A-Za-z0-9])[Tt]\+(\d+)")
NUMBER_RE = re.compile(r"(?<![A-Za-z0-9+])(\d+(?:\.\d+)?)\s*(%|元|天|年|个月|个)?")
CLAIM_SPLIT = re.compile(r"[。；;!?！？\n]+")
SENTENCE_RE = re.compile(r"[^。；;\n]+[。；;]?")
LITERAL_THRESHOLD = 0.55
T_PLUS_UNIT = "天"


@dataclass(frozen=True)
class NumberHit:
    raw: str
    value_text: str
    unit: str


def extract_markers(text: str) -> list[str]:
    return MARKER_RE.findall(text)


def extract_numbers(text: str) -> list[NumberHit]:
    """提取 T+N 与普通数值；先标记 T+N 的字符区间，避免把 N 再算一次。"""

    stripped = MARKER_RE.sub("", text)
    found: list[tuple[int, int, NumberHit]] = []
    for match in T_PLUS_RE.finditer(stripped):
        found.append(
            (
                match.start(),
                match.end(),
                NumberHit(
                    raw=f"T+{match.group(1)}",
                    value_text=match.group(1),
                    unit=T_PLUS_UNIT,
                ),
            )
        )
    consumed = [(start, end) for start, end, _hit in found]
    for match in NUMBER_RE.finditer(stripped):
        if any(start < match.end() and match.start() < end for start, end in consumed):
            continue
        found.append(
            (
                match.start(),
                match.end(),
                NumberHit(
                    raw=match.group(0).strip(),
                    value_text=match.group(1),
                    unit=match.group(2) or "",
                ),
            )
        )
    found.sort(key=lambda item: item[0])
    return [hit for _start, _end, hit in found]


def _cell_number(text: str) -> tuple[str, str] | None:
    hits = extract_numbers(str(text))
    if not hits:
        return None
    return hits[0].value_text, hits[0].unit


def _number_matches(hit: NumberHit, cell_values: list[str], evidence_text: str) -> bool:
    """数值 + 单位对账；`evidence_text` 必须是本 claim 所引证据的规范化文本。"""

    raw = normalize_text(hit.raw)
    if raw and raw in evidence_text:
        return True
    if not hit.unit:
        # claim 没写单位：按证据上下文限定，只比较数值。
        return any(
            decimal_eq(hit.value_text, value)
            for value in cell_values
            if (parsed := _cell_number(value)) is not None
        ) or normalize_text(hit.value_text) in evidence_text

    expected = normalize_text(f"{hit.value_text}{hit.unit}")
    if expected in evidence_text:
        return True
    for value in cell_values:
        parsed = _cell_number(value)
        if parsed is None:
            continue
        value_text, unit = parsed
        if decimal_eq(hit.value_text, value_text) and unit == hit.unit:
            return True
    return False


def _claim_supported(claim: str, evidence_text: str, cell_values: list[str]) -> bool:
    body = MARKER_RE.sub("", claim)
    left = normalize_text(body)
    if not left:
        return True
    right = normalize_text(evidence_text)

    numbers = extract_numbers(body)
    if numbers:
        # 数字 claim 不允许被"字面很像"放行；必须逐数对账（仍要求标签命中）。
        if left in right:
            return all(_number_matches(hit, cell_values, right) for hit in numbers)
        label_hit = any(
            term in right
            for term in extract_terms(claim)
            if term and not term.replace(".", "").isdigit()
        )
        if not label_hit:
            return False
        return all(_number_matches(hit, cell_values, right) for hit in numbers)

    if left in right:
        return True
    return SequenceMatcher(None, left, right).ratio() >= LITERAL_THRESHOLD


def locate_span(claim: str, evidence_text: str) -> tuple[int, int]:
    """为引用找最贴合的字符区间：先精确子串，再按句子做相似度对齐。

    数值回退（合成标签对不上正文时定位"数值来源句"）只在传入的这条证据内查找，
    调用方逐条证据调用，天然不会跨证据。
    """

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

    # 取数型答案的标签是合成词（如"赎回费率（持有<7天）"），正文对不上；
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


# 判决口径：数字越小越优先。这不是实现细节——顺序本身就是对外口径，
# 改动顺序等于改判决，必须附 golden diff 佐证。
_REASON_RANK: dict[str, int] = {
    "NUMERIC_MISMATCH": 0,
    "MISSING_CITATION": 1,
    "MISSING_CLAIM_CITATION": 2,
    "SPAN_UNRESOLVED": 3,
    "UNSUPPORTED_CLAIM": 4,
    "AMBER_INFERRED": 5,
}
# 未登记的码排最后：新增理由码时若忘了登记 rank，会被已有的码压住而不会静默夺取优先权。
_UNRANKED = 99


def _pick_reason(current: str | None, candidate: str) -> str:
    """按显式 rank 取更严重（更靠前）的理由码，取代 `current or candidate` 的短路。"""

    if current is None:
        return candidate
    if _REASON_RANK.get(current, _UNRANKED) <= _REASON_RANK.get(candidate, _UNRANKED):
        return current
    return candidate


def _cells_for(markers: list[str], cell_values_by_marker: dict[str, list[str]]) -> list[str]:
    values: list[str] = []
    for marker in markers:
        values.extend(cell_values_by_marker.get(marker, []))
    return values


def verify_answer(
    answer_text: str,
    evidence: list[Evidence],
    cell_values_by_marker: dict[str, list[str]],
    *,
    require_citations: bool = True,
    trace_id: str | None = None,
    entailer: Entailer | None = None,
) -> VerifyResponse:
    """对答案做字面 + 蕴含 + 数值三层校验；返回 verdict 与逐 claim/数值明细。

    `cell_values_by_marker` 形如 `{"K1": ["1.50%", "100元"]}`，只允许 claim 自己
    引用的 marker 取值；没有 marker 的数值一律视为无依据。
    """

    by_marker = {item.marker: item for item in evidence}
    markers = list(dict.fromkeys(extract_markers(answer_text)))

    claims: list[VerifyClaim] = []
    citations: dict[str, Citation] = {}
    reason_code: str | None = None
    verdict = "GREEN"

    if not markers:
        if require_citations:
            verdict = "RED"
            reason_code = "MISSING_CITATION"
        else:
            # require_citations=false 也不能把"无引用"洗成 GREEN。
            verdict = _escalate(verdict, "AMBER_INFERRED")
            reason_code = "MISSING_CITATION"

    for marker in markers:
        if marker not in by_marker:
            verdict = "RED"
            reason_code = _pick_reason(reason_code, "SPAN_UNRESOLVED")

    segments = [segment.strip() for segment in CLAIM_SPLIT.split(answer_text) if segment.strip()]
    segment_markers_map: list[list[str]] = []
    for index, segment in enumerate(segments):
        segment_markers = list(dict.fromkeys(extract_markers(segment)))
        segment_markers_map.append(segment_markers)
        resolved = [by_marker[marker] for marker in segment_markers if marker in by_marker]
        cited_text = "\n".join(item.text for item in resolved) if resolved else ""
        claim_text = MARKER_RE.sub("", segment).strip()
        claim_cells = _cells_for(segment_markers, cell_values_by_marker)

        literal = _claim_supported(segment, cited_text, claim_cells) if resolved else False
        entailment: str = "skipped"
        support = literal
        # 分类先于判决：含数字的 claim 走 numeric 路，其余才允许咨询蕴含层。
        numeric_claim = bool(extract_numbers(claim_text))

        if not segment_markers:
            if require_citations:
                verdict = "RED"
                reason_code = _pick_reason(reason_code, "MISSING_CLAIM_CITATION")
            else:
                verdict = _escalate(verdict, "AMBER_INFERRED")
                reason_code = _pick_reason(reason_code, "MISSING_CLAIM_CITATION")
        elif not literal:
            if numeric_claim:
                # numeric 路：**不咨询 entailer**。理由不是"反正它会返回 None"，
                # 而是数值保真不允许任何语义层参与——否则换一个不设数字守卫的
                # entailer 就能把被改写的金额判成 pass。
                # 文本侧是否被支持已由 literal 表达；此处只落到 AMBER + 文本层理由，
                # 若数值对账失败，后面的数值阶段会升到 RED + NUMERIC_MISMATCH。
                entailment = "skipped"
                support = False
                verdict = _escalate(verdict, "AMBER_INFERRED")
                reason_code = _pick_reason(reason_code, "UNSUPPORTED_CLAIM")
            else:
                result = entailer.judge(claim_text, cited_text) if entailer is not None else None
                if result is True:
                    entailment = "pass"
                    support = True
                    verdict = _escalate(verdict, "AMBER_INFERRED")
                    reason_code = _pick_reason(reason_code, "UNSUPPORTED_CLAIM")
                elif result is False:
                    entailment = "fail"
                    support = False
                    verdict = "RED"
                    reason_code = _pick_reason(reason_code, "UNSUPPORTED_CLAIM")
                else:
                    entailment = "skipped"
                    support = False
                    verdict = _escalate(verdict, "AMBER_INFERRED")
                    reason_code = _pick_reason(reason_code, "UNSUPPORTED_CLAIM")

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
    for segment, segment_markers in zip(segments, segment_markers_map):
        resolved = [by_marker[marker] for marker in segment_markers if marker in by_marker]
        evidence_text = normalize_text("\n".join(item.text for item in resolved))
        claim_cells = _cells_for(segment_markers, cell_values_by_marker)
        for hit in extract_numbers(MARKER_RE.sub("", segment)):
            matched = bool(resolved) and _number_matches(hit, claim_cells, evidence_text)
            numbers.append(
                VerifyNumber(
                    raw=hit.raw,
                    value_text=hit.value_text,
                    unit=hit.unit,
                    source=segment_markers[0] if segment_markers else "",
                    match=matched,
                )
            )
            # `matched` 仍是"能否被本 claim 所引证据背书"的诚实结论：无引用即未获背书。
            # 但**无可对账证据不等于数字不符**——那是引用缺失，已由 MISSING_* 表达；
            # 在此凭空判 NUMERIC_MISMATCH 会把"没说是从哪抄的"误报成"抄错了"。
            if resolved and not matched:
                verdict = "RED"
                reason_code = _pick_reason(reason_code, "NUMERIC_MISMATCH")

    return VerifyResponse(
        trace_id=trace_id,
        verdict=verdict,  # type: ignore[arg-type]
        reason_code=reason_code,
        claims=claims,
        numbers=numbers,
        citations=list(citations.values()),
    )
