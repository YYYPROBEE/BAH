from __future__ import annotations

from typing import Any

import pytest
from helpers import principal

from banking_rag.contract import Principal
from banking_rag.retrieve import search
from banking_rag.store import Store


def test_embedding_index_is_populated(store: Store) -> None:
    if not store.embedding_on:
        pytest.skip("fastembed 不可用，已降级为 FTS5 单通道")
    conn = store.connect()
    try:
        rows = conn.execute("SELECT COUNT(*) AS n FROM vec_chunks").fetchone()
        assert int(rows["n"]) == 10
        versions = {
            str(row["embed_version"])
            for row in conn.execute(
                "SELECT DISTINCT embed_version FROM chunks WHERE embed_version IS NOT NULL"
            )
        }
        assert len(versions) == 1
        assert next(iter(versions)).startswith("fastembed:")
    finally:
        conn.close()


def test_vector_channel_recalls_paraphrase(store: Store) -> None:
    if not store.embedding_on:
        pytest.skip("fastembed 不可用，已降级为 FTS5 单通道")
    conn = store.connect()
    try:
        parsed = Principal(**principal())
        visible = store.visible_chunk_ids(conn, parsed)
        result = search(store, conn, visible, "购买理财产品的手续费怎么收")
    finally:
        conn.close()

    assert result.trace.get("vector"), "向量通道应有命中"
    assert result.trace.get("vectorError") is None
    doc_ids = {item.doc_id for item in result.evidence}
    assert doc_ids & {"FEE-2025-v3", "PROD-W-001"}, doc_ids


def test_both_channels_share_visible_scope(store: Store) -> None:
    if not store.embedding_on:
        pytest.skip("fastembed 不可用，已降级为 FTS5 单通道")
    conn = store.connect()
    try:
        parsed = Principal(**principal())
        visible = store.visible_chunk_ids(conn, parsed)
        result = search(store, conn, visible, "赎回费率")
    finally:
        conn.close()

    evidence_ids = {item.chunk_id for item in result.evidence}
    assert evidence_ids <= visible
    fused = result.trace["fused"]
    assert isinstance(fused, list) and fused
    for item in fused:  # type: ignore[union-attr]
        assert int(item["chunkId"]) in visible  # type: ignore[index]


def test_trace_records_channel_ranks(store: Store) -> None:
    if not store.embedding_on:
        pytest.skip("fastembed 不可用，已降级为 FTS5 单通道")
    conn = store.connect()
    try:
        parsed = Principal(**principal())
        visible = store.visible_chunk_ids(conn, parsed)
        result = search(store, conn, visible, "稳盈90天赎回费率")
    finally:
        conn.close()

    trace: dict[str, Any] = result.trace
    assert trace["rrfK"] == 60
    assert trace["fts5"]
    assert trace["fused"]
    first = trace["fused"][0]
    assert "ranks" in first and "tierWeight" in first


def test_scalar_distance_fallback_keeps_acl_scope(store: Store) -> None:
    if not store.embedding_on:
        pytest.skip("fastembed 不可用，已降级为 FTS5 单通道")
    conn = store.connect()
    try:
        parsed = Principal(**principal())
        visible = store.visible_chunk_ids(conn, parsed)
        query_vector = store.embedder.embed_query("赎回费率")
        store._knn_in_supported = False  # 强制走 vec_distance_cosine 标量回退
        rows = store.vector_ranked(conn, visible, query_vector, 5)
    finally:
        conn.close()

    assert rows, "标量回退应有命中"
    assert {chunk_id for chunk_id, _distance in rows} <= visible
