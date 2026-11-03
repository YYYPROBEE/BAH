"""检索层黄金集：钉住「该选哪份文档」。

与 `test_verdict_golden.py` 的分工：
- verdict 黄金集管**答完之后**判得对不对（数值对账/字面/蕴含/引用标记）；
- 本文件管**答之前**选得对不对（版本更替、相似文档、客群/渠道隔离）。

两者缺一不可：数值对账只能发现「答案里的数字不在证据里」，
发现不了「证据本身取错了文档」——后者会稳定判 GREEN，但业务答案是错的。

用例数据在 `tests/golden/retrieval-cases.json`，字段口径对齐 Bank RAG Benchmark 的
「应命中文档」，但语料全部来自本仓库演示库，不引用外部数据。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from banking_rag.contract import Principal
from banking_rag.retrieve import is_lookup_query, lookup, search
from banking_rag.store import Store

GOLDEN = Path(__file__).parent / "golden" / "retrieval-cases.json"


def load_golden() -> dict[str, Any]:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))


def build_principal(spec: dict[str, Any]) -> Principal:
    return Principal(**spec)


def hits_for(store: Store, principal: Principal, query: str) -> list[dict[str, str]]:
    """跑真实取数路径，返回按优先级排好的 [(docId, 取值)]。

    路由判定直接用引擎自己的 `is_lookup_query`，不在这里重写一份规则，
    否则测试与引擎会各自漂移。
    """

    conn = store.connect()
    try:
        visible = store.visible_chunk_ids(conn, principal)
        if not visible:
            return []
        if is_lookup_query(query):
            rows = lookup(store, conn, visible, query)
            if not rows:
                return []
            ids = [row.chunk_id for row in rows]
            placeholders = ",".join("?" for _ in ids)
            doc_of = {
                int(r["chunk_id"]): str(r["doc_id"])
                for r in conn.execute(
                    f"SELECT chunk_id, doc_id FROM chunks WHERE chunk_id IN ({placeholders})",
                    ids,
                )
            }
            return [
                {
                    "docId": doc_of.get(row.chunk_id, ""),
                    "value": f"{row.value_text}{row.unit}",
                    "label": row.label,
                }
                for row in rows
            ]
        result = search(store, conn, visible, query)
        return [
            {"docId": item.doc_id, "value": "", "label": item.clause_no or item.title}
            for item in result.evidence
        ]
    finally:
        conn.close()


GOLDEN_DATA = load_golden()
CASES = GOLDEN_DATA["cases"]


def test_golden_file_is_wellformed() -> None:
    assert GOLDEN_DATA["schemaVersion"] == "retrieval-golden.v1"
    assert len(CASES) >= 8
    ids = [case["id"] for case in CASES]
    assert len(set(ids)) == len(ids), "用例 id 必须唯一"
    kinds = {case["kind"] for case in CASES}
    assert kinds == {"版本更新", "相似文档", "客群隔离", "渠道隔离"}
    for case in CASES:
        assert case.get("expectDoc") or case.get("expectEmpty"), case["id"]


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_retrieval_case(store: Store, case: dict[str, Any]) -> None:
    spec = {**GOLDEN_DATA["baseProps"], **case.get("principal", {})}
    hits = hits_for(store, build_principal(spec), case["query"])
    docs = [hit["docId"] for hit in hits]

    if case.get("expectEmpty"):
        assert hits == [], f"{case['id']} 应拒答，实际命中 {docs}；{case['note']}"
        return

    assert hits, f"{case['id']} 应命中 {case['expectDoc']}，实际零命中；{case['note']}"
    assert docs[0] == case["expectDoc"], (
        f"{case['id']} 首选文档应为 {case['expectDoc']}，实际 {docs[0]}（全部 {docs}）；{case['note']}"
    )
    expected_value = case.get("expectValue")
    if expected_value is not None:
        assert hits[0]["value"] == expected_value, (
            f"{case['id']} 首选取值应为 {expected_value}，实际 {hits[0]['value']}；{case['note']}"
        )
    for banned in case.get("forbidDocs", []):
        assert banned not in docs, f"{case['id']} 不得出现 {banned}（全部 {docs}）；{case['note']}"
