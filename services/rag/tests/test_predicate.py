from __future__ import annotations

from typing import Any

from banking_rag.contract import Principal
from banking_rag.store import Store

from helpers import principal


def visible_docs(store: Store, **overrides: Any) -> set[str]:
    parsed = Principal(**principal(**overrides))
    conn = store.connect()
    try:
        ids = store.visible_chunk_ids(conn, parsed)
        if not ids:
            return set()
        placeholders = ",".join("?" for _ in ids)
        rows = conn.execute(
            f"SELECT DISTINCT doc_id FROM chunks WHERE chunk_id IN ({placeholders})",
            list(ids),
        ).fetchall()
        return {str(row["doc_id"]) for row in rows}
    finally:
        conn.close()


def test_standard_scope_excludes_vip_region_channel_and_poison(store: Store) -> None:
    docs = visible_docs(store)
    assert "FEE-2025-v3" in docs
    assert "PROD-W-001" in docs
    assert "FAQ-REDEEM" in docs
    assert "FEE-2024-v1" not in docs  # superseded
    assert "PROD-W-002" not in docs  # vip
    assert "FEE-SZ-PROMO" not in docs  # CN-SZ
    assert "RULE-TRANSFER-MOBILE" not in docs  # mobile
    assert "POISON-001" not in docs  # tier 9


def test_vip_scope_can_see_vip_product(store: Store) -> None:
    docs = visible_docs(store, audience="vip")
    assert "PROD-W-002" in docs


def test_mobile_channel_can_see_mobile_rule(store: Store) -> None:
    docs = visible_docs(store, channel="mobile")
    assert "RULE-TRANSFER-MOBILE" in docs


def test_region_scope_can_see_sz_promo(store: Store) -> None:
    docs = visible_docs(store, region="CN-SZ", now="2025-08-01T12:00:00+08:00")
    assert "FEE-SZ-PROMO" in docs


def test_effective_window_excludes_old_and_not_yet_valid(store: Store) -> None:
    docs = visible_docs(store, now="2024-06-01T12:00:00+08:00")
    assert "FEE-2024-v1" not in docs  # superseded
    assert "FEE-2025-v3" not in docs  # valid_from 2025-01-01


def test_missing_dimension_is_fail_closed(store: Store) -> None:
    assert visible_docs(store, role="") == set()
    assert visible_docs(store, region="") == set()
