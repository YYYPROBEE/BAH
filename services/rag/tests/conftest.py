from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from banking_rag.main import create_app
from banking_rag.store import Store


@pytest.fixture()
def store(tmp_path: Any) -> Store:
    return Store(tmp_path / "knowledge.sqlite")


@pytest.fixture()
def client(store: Store) -> TestClient:
    with TestClient(create_app(store)) as test_client:
        yield test_client
