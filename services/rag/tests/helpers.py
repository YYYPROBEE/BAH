from __future__ import annotations

import time
from typing import Any

from fastapi.testclient import TestClient

from banking_rag.auth import Authenticator, issue_token

SECRET = "test-secret"
# 测试里 retail 被显式授予全量产品策略（保留旧用例的多产品语义）；
# 默认策略（仅通用）由 test_acl/test_auth 用默认 Authenticator 覆盖。
FULL_SCOPE_ROLES = frozenset({"retail"})


def make_authenticator(**overrides: Any) -> Authenticator:
    options: dict[str, Any] = {
        "secret": SECRET,
        "full_scope_roles": FULL_SCOPE_ROLES,
    }
    options.update(overrides)
    return Authenticator(**options)


def principal(**overrides: Any) -> dict[str, Any]:
    data: dict[str, Any] = {
        "role": "retail",
        "audience": "standard",
        "channel": "headless",
        "region": "CN-SH",
        "full_scope": True,
        "now": "2026-10-19T12:00:00+08:00",
    }
    data.update(overrides)
    return data


def auth_token(
    *,
    session_id: str = "s-test",
    sub: str = "u-test",
    role: str = "retail",
    audience: str = "standard",
    channel: str = "headless",
    region: str = "CN-SH",
    product_id: str | None = None,
    exp: int | None = None,
    secret: str = SECRET,
) -> str:
    return issue_token(
        {
            "sub": sub,
            "role": role,
            "audience": audience,
            "channel": channel,
            "region": region,
            "productId": product_id,
            "sessionId": session_id,
            "exp": int(time.time()) + 3600 if exp is None else exp,
        },
        secret,
    )


def auth_headers(**claims: Any) -> dict[str, str]:
    return {"Authorization": f"Bearer {auth_token(**claims)}"}


def ask(
    client: TestClient,
    query: str,
    session_id: str = "s-test",
    extra: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    **claim_overrides: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "schemaVersion": "knowledge.v1",
        "query": query,
    }
    if extra:
        body.update(extra)
    request_headers = auth_headers(session_id=session_id, **claim_overrides)
    if headers:
        request_headers.update(headers)
    response = client.post("/v1/answer", json=body, headers=request_headers)
    assert response.status_code == 200, response.text
    return response.json()
