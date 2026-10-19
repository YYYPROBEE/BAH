from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient


def principal(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "role": "retail",
        "audience": "standard",
        "channel": "headless",
        "region": "CN-SH",
        "now": "2026-10-19T12:00:00+08:00",
    }
    data.update(overrides)
    return data


def ask(
    client: TestClient,
    query: str,
    session_id: str = "s-test",
    **principal_overrides: Any,
) -> dict[str, Any]:
    response = client.post(
        "/v1/answer",
        json={
            "schemaVersion": "knowledge.v1",
            "sessionId": session_id,
            "query": query,
            "principal": principal(**principal_overrides),
        },
    )
    assert response.status_code == 200, response.text
    return response.json()
