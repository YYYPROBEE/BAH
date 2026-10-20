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


def test_green_when_number_and_literal_match() -> None:
    result = verify_answer("赎回费率为1.50%[K1]。", EVIDENCE, ["1.50"])
    assert result.verdict == "GREEN"
    assert result.reason_code is None
    assert result.numbers[0].match is True


def test_numeric_mismatch_is_red() -> None:
    result = verify_answer("赎回费率为15%[K1]。", EVIDENCE, ["1.50"])
    assert result.verdict == "RED"
    assert result.reason_code == "NUMERIC_MISMATCH"


def test_missing_citation_is_red() -> None:
    result = verify_answer("赎回费率为1.50%。", EVIDENCE, ["1.50"])
    assert result.verdict == "RED"
    assert result.reason_code == "MISSING_CITATION"


def test_unresolved_marker_is_red() -> None:
    result = verify_answer("赎回费率为1.50%[K9]。", EVIDENCE, ["1.50"])
    assert result.verdict == "RED"
    assert result.reason_code == "SPAN_UNRESOLVED"


def test_literal_failure_without_numbers_is_amber() -> None:
    result = verify_answer("赎回费率大概在一点五左右[K1]。", EVIDENCE, ["1.50"])
    assert result.verdict == "AMBER_INFERRED"
    assert result.reason_code == "UNSUPPORTED_CLAIM"


def test_extract_numbers_keeps_unit() -> None:
    hits = extract_numbers("起购金额100元，期限90天，费率1.50%。")
    assert [(hit.value_text, hit.unit) for hit in hits] == [
        ("100", "元"),
        ("90", "天"),
        ("1.50", "%"),
    ]


def test_plus_prefixed_token_is_not_a_number() -> None:
    assert extract_numbers("赎回到账时间为T+1。") == []
