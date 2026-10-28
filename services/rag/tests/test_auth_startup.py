"""A3 启动冒烟：认证必须 fail-loud，且 token 真的能保护 /v1/*。

为什么单独立文件：原有 `test_api.py` 全部用注入的 `Authenticator`（签名模式），
覆盖的是"认证之后"的逻辑；这里覆盖的是"启动时到底有没有认证"——
2026-10-27 复审发现文档把 fail-loud 写成了"设置后才需要"，干净环境按 README 起不来。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from banking_rag.auth import LEGACY_TOKEN_ENV, SECRET_ENV, TOKEN_ENV
from banking_rag.llm import NullLLM
from banking_rag.main import create_app
from banking_rag.store import Store

ANSWER_BODY: dict[str, Any] = {
    "schemaVersion": "knowledge.v1",
    "query": "稳盈90天起购金额是多少？",
}


def _clear_auth_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (SECRET_ENV, TOKEN_ENV, LEGACY_TOKEN_ENV):
        monkeypatch.delenv(name, raising=False)


def test_missing_auth_config_fails_loud(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """没有任何 secret/token 时，create_app 必须拒绝启动而不是匿名放行。"""

    _clear_auth_env(monkeypatch)
    with pytest.raises(RuntimeError, match="认证未配置"):
        create_app(Store(tmp_path / "knowledge.sqlite"), llm=NullLLM())


@pytest.mark.parametrize("env_name", [TOKEN_ENV, LEGACY_TOKEN_ENV])
def test_demo_token_protects_v1_but_not_healthz(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, env_name: str
) -> None:
    """配置演示 token 后：/healthz 200；无 Bearer 401；带同一 token 200。

    两个变量都测：脚本注入的是 legacy `BAH_KNOWLEDGE_TOKEN`（宿主默认），
    而 sidecar 的新变量 `BAH_RAG_TOKEN` 优先级更高；只测一个会漏掉接线漂移。
    """

    _clear_auth_env(monkeypatch)
    monkeypatch.setenv(env_name, "demo-token-for-startup-test")

    with TestClient(
        create_app(Store(tmp_path / "knowledge.sqlite"), llm=NullLLM())
    ) as client:
        assert client.get("/healthz").status_code == 200

        unauthorized = client.post("/v1/answer", json=ANSWER_BODY)
        assert unauthorized.status_code == 401

        authorized = client.post(
            "/v1/answer",
            json=ANSWER_BODY,
            headers={"Authorization": "Bearer demo-token-for-startup-test"},
        )
        assert authorized.status_code == 200, authorized.text
        assert authorized.json()["schemaVersion"] == "knowledge.v1"
