from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from banking_rag.llm import NullLLM
from banking_rag.main import create_app
from banking_rag.store import Store


@pytest.fixture()
def store(tmp_path: Any) -> Store:
    return Store(tmp_path / "knowledge.sqlite")


@pytest.fixture()
def client(store: Store) -> TestClient:
    # 单测不联网：显式注入 NullLLM，生成走抽取式；真实 LLM 由 e2e 脚本覆盖。
    with TestClient(create_app(store, llm=NullLLM())) as test_client:
        yield test_client
