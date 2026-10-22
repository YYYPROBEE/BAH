from __future__ import annotations

import json
from pathlib import Path

from banking_rag.export_contract import build_schema

CONTRACT = Path(__file__).resolve().parents[1] / "contract" / "knowledge.v1.json"


def test_committed_contract_matches_models() -> None:
    assert CONTRACT.exists(), "contract/knowledge.v1.json 未生成：跑 python -m banking_rag.export_contract"
    committed = json.loads(CONTRACT.read_text(encoding="utf-8"))
    assert committed == build_schema()


def test_contract_has_all_public_models() -> None:
    schema = build_schema()
    assert set(schema["definitions"]) == {
        "AnswerRequest",
        "AnswerResponse",
        "QueryRequest",
        "QueryResponse",
        "VerifyRequest",
        "VerifyResponse",
        "HealthResponse",
    }
