from __future__ import annotations

from banking_rag.contract import Evidence
from banking_rag.verify import extract_numbers, verify_answer

EVIDENCE = [
    Evidence(
        marker="K1",
        chunk_id=1,
        doc_id="FEE-2025-v3",
        title="稳盈系列费率表（2025版）",
        clause_no="费率表",
        tier=1,
        char_start=0,
        char_end=30,
        text="持有不满7天赎回费率1.50%。",
    )
]

CELLS = {"K1": ["1.50%"]}


def test_green_when_number_and_literal_match() -> None:
    result = verify_answer("赎回费率为1.50%[K1]。", EVIDENCE, CELLS)
    assert result.verdict == "GREEN"
    assert result.reason_code is None
    assert result.numbers[0].match is True


def test_numeric_mismatch_is_red() -> None:
    result = verify_answer("赎回费率为15%[K1]。", EVIDENCE, CELLS)
    assert result.verdict == "RED"
    assert result.reason_code == "NUMERIC_MISMATCH"


def test_missing_citation_is_red() -> None:
    result = verify_answer("赎回费率为1.50%。", EVIDENCE, CELLS)
    assert result.verdict == "RED"
    assert result.reason_code == "MISSING_CITATION"


def test_unresolved_marker_is_red() -> None:
    result = verify_answer("赎回费率为1.50%[K9]。", EVIDENCE, CELLS)
    assert result.verdict == "RED"
    assert result.reason_code == "SPAN_UNRESOLVED"


def test_literal_failure_without_numbers_is_amber() -> None:
    result = verify_answer("赎回费率大概在一点五左右[K1]。", EVIDENCE, CELLS)
    assert result.verdict == "AMBER_INFERRED"
    assert result.reason_code == "UNSUPPORTED_CLAIM"


def test_extract_numbers_keeps_unit() -> None:
    hits = extract_numbers("起购金额100元，期限90天，费率1.50%。")
    assert [(hit.value_text, hit.unit) for hit in hits] == [
        ("100", "元"),
        ("90", "天"),
        ("1.50", "%"),
    ]


def test_t_plus_is_extracted_as_day_unit() -> None:
    hits = extract_numbers("赎回到账时间为T+1。")
    assert [(hit.raw, hit.value_text, hit.unit) for hit in hits] == [("T+1", "1", "天")]


T_PLUS_EVIDENCE = [
    Evidence(
        marker="K2",
        chunk_id=2,
        doc_id="FAQ-REDEEM",
        title="赎回流程 FAQ",
        clause_no=None,
        tier=5,
        char_start=0,
        char_end=40,
        text="赎回到账时间为T+1。",
    )
]


def test_t_plus_mismatch_is_red() -> None:
    result = verify_answer("赎回到账时间为T+9[K2]。", T_PLUS_EVIDENCE, {"K2": []})
    assert result.verdict == "RED"
    assert result.reason_code == "NUMERIC_MISMATCH"


UNIT_EVIDENCE = [
    Evidence(
        marker="K1",
        chunk_id=3,
        doc_id="FEE-PROMO",
        title="活动费率",
        clause_no="活动规则",
        tier=1,
        char_start=0,
        char_end=30,
        text="活动费率为0.8%。",
    )
]


def test_unit_mismatch_is_red() -> None:
    result = verify_answer("活动费率为0.8 元[K1]。", UNIT_EVIDENCE, {"K1": ["0.8%"]})
    assert result.verdict == "RED"
    assert result.reason_code == "NUMERIC_MISMATCH"


CROSS_EVIDENCE = [
    Evidence(
        marker="K1",
        chunk_id=1,
        doc_id="A",
        title="A",
        clause_no=None,
        tier=1,
        char_start=0,
        char_end=20,
        text="A 产品费率为0.8%。",
    ),
    Evidence(
        marker="K2",
        chunk_id=2,
        doc_id="B",
        title="B",
        clause_no=None,
        tier=1,
        char_start=0,
        char_end=20,
        text="B 产品费率为1.50%。",
    ),
]

CROSS_CELLS = {"K1": ["0.8%"], "K2": ["1.50%"]}


def test_number_cannot_borrow_other_evidence() -> None:
    result = verify_answer("B 产品费率为0.8%[K2]。", CROSS_EVIDENCE, CROSS_CELLS)
    assert result.verdict == "RED"
    assert result.reason_code == "NUMERIC_MISMATCH"


def test_require_citations_false_without_marker_is_not_green() -> None:
    result = verify_answer(
        "赎回费率为1.50%。",
        EVIDENCE,
        CELLS,
        require_citations=False,
    )
    assert result.verdict == "AMBER_INFERRED"
    assert result.reason_code == "MISSING_CITATION"


def test_numeric_claim_skips_literal_similarity() -> None:
    # 字面相似度很高（只差 0.01），但数字 claim 必须走对账，不能靠 SequenceMatcher 放行。
    result = verify_answer("持有不满7天赎回费率为1.51%[K1]。", EVIDENCE, CELLS)
    assert result.claims[0].literal == "fail"
    assert result.verdict == "RED"
    assert result.reason_code == "NUMERIC_MISMATCH"
