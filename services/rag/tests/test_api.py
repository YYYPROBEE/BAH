from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from helpers import ask


def test_health(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["docs"] == 10
    assert payload["chunks"] == 10
    assert payload["embedding"] == "off"


def test_green_fee_answer_has_citation(client: TestClient) -> None:
    payload = ask(client, "稳盈90天持有不满7天赎回费率是多少？")
    assert payload["kind"] == "answer"
    assert payload["verdict"] == "GREEN"
    assert "1.50" in payload["answer"]
    assert payload["citations"][0]["docId"] == "FEE-2025-v3"
    assert payload["citations"][0]["marker"] == "K1"


def test_vip_product_is_denied_for_standard_audience(client: TestClient) -> None:
    payload = ask(client, "稳盈90天B起购金额是多少？")
    assert payload["kind"] == "refusal"
    assert payload["verdict"] == "RED"
    assert payload["reasonCode"] == "SCOPE_EMPTY"
    assert "权限范围" in payload["answer"]


def test_region_mismatch_is_denied(client: TestClient) -> None:
    payload = ask(client, "深圳地区新客申购费率是多少？")
    assert payload["kind"] == "refusal"
    assert payload["reasonCode"] == "SCOPE_EMPTY"


def test_mobile_channel_can_read_mobile_limit(client: TestClient) -> None:
    payload = ask(client, "手机银行转账单笔限额是多少？", channel="mobile")
    assert payload["kind"] == "answer"
    assert "50000" in payload["answer"]


def test_headless_channel_cannot_read_mobile_rule(client: TestClient) -> None:
    payload = ask(client, "手机银行转账单笔限额是多少？")
    assert payload["kind"] == "refusal"
    assert payload["reasonCode"] in {"SCOPE_EMPTY", "EMPTY_RETRIEVAL"}


def test_two_products_trigger_disambiguation(client: TestClient) -> None:
    payload = ask(client, "稳盈90天和稳盈90天增强版有什么区别？")
    assert payload["kind"] == "disambiguation"
    assert payload["verdict"] == "AMBER_DISAMBIGUATION"
    assert len(payload["candidates"]) == 2


def test_process_question_returns_evidence_answer(client: TestClient) -> None:
    payload = ask(client, "稳盈系列赎回流程是什么？")
    assert payload["kind"] == "answer"
    assert payload["verdict"] == "GREEN"
    assert payload["citations"][0]["docId"] == "FAQ-REDEEM"
    assert "[K1]" in payload["answer"]


def test_audit_trace_is_readable(client: TestClient) -> None:
    payload = ask(client, "稳盈90天起购金额是多少？")
    trace_id = payload["traceId"]
    response = client.get(f"/v1/audit/{trace_id}")
    assert response.status_code == 200
    audit = response.json()
    assert audit["retrieval"]["query_norm"] == "稳盈90天起购金额是多少？"
    assert audit["answer"]["verdict"] == "GREEN"


def test_three_red_refusals_lock_the_session(client: TestClient) -> None:
    session = "s-breaker"
    for _ in range(3):
        payload = ask(client, "稳盈90天B起购金额是多少？", session_id=session)
        assert payload["reasonCode"] == "SCOPE_EMPTY"
    locked = ask(client, "稳盈90天B起购金额是多少？", session_id=session)
    assert locked["kind"] == "refusal"
    assert locked["verdict"] == "LOCKED"
    assert locked["reasonCode"] == "BREAKER_LOCKED"


def test_verify_rejects_numeric_mismatch(client: TestClient) -> None:
    payload = ask(client, "稳盈90天持有不满7天赎回费率是多少？")
    response = client.post(
        "/v1/verify",
        json={
            "schemaVersion": "knowledge.v1",
            "sessionId": "s-test",
            "traceIds": [payload["traceId"]],
            "answerText": "稳盈90天持有不满7天赎回费率为15%[K1]。",
        },
    )
    assert response.status_code == 200
    verified: dict[str, Any] = response.json()
    assert verified["verdict"] == "RED"
    assert verified["reasonCode"] == "NUMERIC_MISMATCH"


def test_verify_rejects_missing_citation(client: TestClient) -> None:
    payload = ask(client, "稳盈90天持有不满7天赎回费率是多少？")
    response = client.post(
        "/v1/verify",
        json={
            "schemaVersion": "knowledge.v1",
            "sessionId": "s-test",
            "traceIds": [payload["traceId"]],
            "answerText": "赎回费率为1.50%。",
        },
    )
    verified = response.json()
    assert verified["verdict"] == "RED"
    assert verified["reasonCode"] == "MISSING_CITATION"
